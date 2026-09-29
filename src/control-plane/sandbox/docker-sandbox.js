import { randomUUID } from "node:crypto";
import { runProcess } from "../../providers/process-runner.js";
import { WORKSPACE } from "./job.js";
import { approvedImageFaults, imageFaults, pinnedImage } from "./sandbox-image.js";
import { SPELLINGS, WRITTEN } from "../../product-names.js";

// One container per run, created when a schedule fires and gone when it ends.
// Nothing stays up between runs: on a small machine that is the difference
// between paying for capacity that is idle almost always and paying only while
// a task runs, and it is also the isolation rule -- a sandbox that outlives its
// run is a sandbox the next run inherits.
//
// The isolation itself is the argv. Every flag below is the boundary, so the
// tests assert the argv rather than trusting that a container "is isolated".
//
// `runtime` is the whole forward-compatibility story: gVisor and Kata are Docker
// runtimes, so moving from namespaces to a user-space kernel (`runsc`) or to a
// microVM per task (`io.containerd.kata.v2`) is this one string, with the job,
// the mounts, the limits and the network policy unchanged. A provider that is
// not a Docker runtime at all -- Firecracker on its own, libkrun, Apple's
// container -- implements the same `run(job)` instead, which is why nothing
// Docker-shaped is allowed into the job contract.
// Swapping this is not automatically an upgrade, and the measured record says
// so: through 2026 Kata had four host escapes (one CVSS 10.0) and Cloud
// Hypervisor one through its default I/O path, while gVisor had no published
// host-escape advisory at all. A microVM trades a syscall boundary for a
// hardware one; it does not strictly contain it. Pick by what the host can
// actually run, then by that record -- not by assuming a VM outranks a
// user-space kernel.
export const SANDBOX_RUNTIMES = Object.freeze({
  runc: "namespaces only -- the host kernel's whole syscall surface stays reachable",
  runsc: "gVisor: a user-space kernel, needs Linux 5.6+ and no KVM at all",
  "io.containerd.kata.v2": "Kata: one lightweight VM per task, needs KVM on the host",
});

const GRACE_MS = 5_000;
// How long a production verdict is trusted before Docker is asked again. Short
// enough that a network someone just flipped back to a plain bridge stops runs
// within a minute; long enough that a busy morning does not inspect the same
// network for every task.
const VERDICT_MS = 60_000;

export class DockerSandbox {
  // `gatewayHost` maps the egress proxy's name to an address the container can
  // reach. On a developer machine that is `host-gateway`, and it is a real
  // weakening worth naming: through the host gateway a sandbox can reach any
  // port the host is listening on, not only the proxy. It is accepted here
  // because the compute boundary is unchanged and the machine is the
  // developer's own. In production the proxy belongs in a container of its own
  // on an `--internal` network, where the sandbox can see it and nothing else.
  // `mode` is the difference between "this machine is a developer's" and "this
  // machine runs other people's tasks". In production the isolation the design
  // claims has to actually hold, and a deployment that cannot provide it is
  // refused rather than silently downgraded.
  // `image` and `pins` let the check ask about the image as well: whether it is
  // there at all (nothing pulls it at run time), whether it was built for this
  // lock, and -- in production -- whether it is named by digest.
  // `owner` names the control plane these containers belong to. One Docker host
  // can serve more than one -- a developer's live one and a test run, or two
  // deployments -- and a start-up sweep that removed every sandbox on the host
  // would kill the other's running tasks.
  constructor({ docker = "docker", runtime = "runc", run = runProcess, uid = 65534, gid = 65534, gatewayNetwork = null, gatewayHost = null, mode = "development", image = null, pins = null, release = null, owner = null, now = Date.now } = {}) {
    if (typeof runtime !== "string" || runtime.length === 0) throw new Error("沙箱运行时名称不合法");
    if (!["development", "production"].includes(mode)) throw new Error("沙箱模式只能是 development 或 production");
    // The Docker network a `gateway` job joins. It has to be created outside
    // this process, reaching the egress proxy and nothing else -- a policy the
    // sandbox can rewrite is not a policy, so the enforcement lives at the
    // network's far end, never in a flag the container could influence.
    if (gatewayNetwork !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(gatewayNetwork)) throw new Error("沙箱网关网络名不合法");
    if (gatewayHost !== null && !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(gatewayHost)) throw new Error("沙箱网关主机映射不合法");
    if (owner !== null && !/^[a-f0-9]{8,64}$/.test(owner)) throw new Error("沙箱归属标识不合法");
    // Whoever configured it, a run never starts as root.
    if (![uid, gid].every((id) => Number.isInteger(id) && id > 0 && id < 2 ** 31)) throw new Error("沙箱容器用户不合法：uid 和 gid 必须是正整数，不能以 root 运行");
    Object.assign(this, { docker, runtime, run, uid, gid, gatewayNetwork, gatewayHost, mode, image, pins, release, owner, now });
    this.verdict = null;
  }

  // `gateway` without a configured network would fall through to no network at
  // all: the task would believe it had a way out, reach nothing, and nothing
  // would say why. Refused loudly instead.
  network(job) {
    if (job.network.mode === "open") return "bridge";
    if (job.network.mode !== "gateway") return "none";
    if (!this.gatewayNetwork) throw new Error("沙箱要求 gateway 网络，但本机未配置出口网络");
    return this.gatewayNetwork;
  }

  // Whether this host can run a job at all, and whether the configured runtime
  // is actually registered -- asking Docker rather than assuming, because a
  // missing `runsc` would otherwise silently fall back to plain namespaces and
  // quietly downgrade the boundary.
  async available() {
    try {
      const info = await this.run(this.docker, ["info", "--format", "{{json .Runtimes}}"], { timeoutMs: 10_000, maxOutputBytes: 1 << 20 });
      if (info.code !== 0) return { ok: false, reason: "Docker 未运行或不可访问" };
      const runtimes = Object.keys(JSON.parse(info.stdout || "{}"));
      if (!runtimes.includes(this.runtime)) return { ok: false, reason: `Docker 未注册运行时 ${this.runtime}`, runtimes };
      const network = await this.inspectNetwork();
      const hardened = this.runtime !== "runc";
      // In production every one of these has to hold. A deployment that quietly
      // runs with an outward-facing network is the failure this check exists
      // for -- measured on this machine: the sandbox network was a plain bridge
      // and a container on it opened a TCP connection to the public internet,
      // so the "one address out" the whole egress design rests on was not
      // enforced by anything.
      const faults = [];
      if (!network.exists) faults.push(`出口网络 ${this.gatewayNetwork ?? "(未配置)"} 不存在`);
      else if (!network.internal) faults.push(`出口网络 ${this.gatewayNetwork} 不是 internal，容器可以绕过出口代理直接出网`);
      if (this.gatewayHost && /host-gateway/.test(this.gatewayHost)) faults.push("出口代理经 host-gateway 到达，容器可触达宿主机监听的任何端口");
      if (!hardened) faults.push(`运行时是 ${this.runtime}，宿主内核的整个系统调用面对容器可见`);
      if (this.image) {
        const image = await this.inspectImage();
        // Not a fault to warn about: without the image nothing runs at all, in
        // either mode, and a run would otherwise discover it one task at a time.
        if (!image.exists) return { ok: false, reason: `沙箱镜像 ${this.image} 不在本机，运行时不会自动拉取；请先构建（npm run build:sandbox）`, runtimes, network, mode: this.mode };
        if (this.pins) faults.push(...imageFaults(image, this.pins));
        if (this.release) faults.push(...approvedImageFaults(this.image, image, this.release));
        if (!pinnedImage(this.image)) faults.push(`镜像 ${this.image} 按标签引用，标签可以被改指向别的镜像（生产请用 仓库@sha256:… 固定）`);
      }
      if (this.mode === "production" && faults.length) {
        return { ok: false, reason: `生产模式拒绝执行：${faults.join("；")}`, runtimes, network, faults, mode: this.mode };
      }
      return { ok: true, runtime: this.runtime, runtimes, network, faults, mode: this.mode };
    } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
  }

  // What the egress network actually is, rather than what the flags say it
  // should be. `--internal` is the difference between a container that can only
  // reach the proxy and one that can reach anything; nothing here checked it.
  async inspectNetwork() {
    if (!this.gatewayNetwork) return { exists: false, internal: false, name: null };
    const looked = await this.run(this.docker,
      ["network", "inspect", this.gatewayNetwork, "--format", "{{.Internal}} {{.Driver}}"],
      { timeoutMs: 10_000, maxOutputBytes: 1 << 16 }).catch(() => null);
    if (!looked || looked.code !== 0) return { exists: false, internal: false, name: this.gatewayNetwork };
    const [internal, driver] = `${looked.stdout ?? ""}`.trim().split(/\s+/);
    return { exists: true, internal: internal === "true", driver: driver ?? "", name: this.gatewayNetwork };
  }

  // What Docker has under that name, if anything. A missing image is a normal
  // answer here, not an error.
  async inspectImage() {
    const looked = await this.run(this.docker, ["image", "inspect", this.image, "--format", "{{json .}}"],
      { timeoutMs: 10_000, maxOutputBytes: 1 << 20 }).catch(() => null);
    if (!looked || looked.code !== 0) return { exists: false, reference: this.image };
    try {
      const found = JSON.parse(`${looked.stdout ?? ""}`.trim());
      return { exists: true, reference: this.image, id: found.Id ?? null, os: found.Os ?? "", architecture: found.Architecture ?? "",
        labels: found.Config?.Labels ?? {}, repoDigests: found.RepoDigests ?? [] };
    } catch { return { exists: false, reference: this.image }; }
  }

  // The production verdict, as of at most a minute ago. Development runs are not
  // gated here: their faults are said at every start, and a developer's machine
  // is allowed to be what it is.
  async #permitted() {
    if (this.mode !== "production") return { ok: true };
    if (!this.verdict || this.now() - this.verdict.at >= VERDICT_MS) this.verdict = { at: this.now(), value: await this.available() };
    return this.verdict.value;
  }

  argv(job, name) {
    const memory = `${Math.trunc(job.limits.memoryMb)}m`;
    // Never pulled here. `mydoubao/sandbox` is a Docker Hub namespace this
    // product does not own, so a missing local image would otherwise be fetched
    // from whoever registers it -- and run holding this run's token.
    return ["run", "--pull", "never", "--rm", "--name", name,
      "--runtime", this.runtime,
      // Full egress is a named choice; `gateway` joins the one network that
      // reaches the egress proxy; anything else gets no network at all.
      "--network", this.network(job),
      // Under both names: an image built before the rename reads MYDOUBAO_EGRESS.
      ...(job.network.gateway ? ["--env", `IDOU_EGRESS=${job.network.gateway}`, "--env", `MYDOUBAO_EGRESS=${job.network.gateway}`] : []),
      // Only for a gateway job: the name the proxy is reached by has to resolve
      // to something inside the container's network.
      ...(job.network.mode === "gateway" && this.gatewayHost ? ["--add-host", this.gatewayHost] : []),
      // Nothing outside the workspace survives, and nothing in the image can be
      // rewritten -- a tampered interpreter cannot persist into the next run.
      "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      // Not root inside, so a container escape does not start as uid 0.
      "--user", `${this.uid}:${this.gid}`,
      // memory-swap equal to memory means no swap: the task fails on its own
      // limit instead of dragging the whole machine into swap death.
      "--memory", memory, "--memory-swap", memory,
      "--cpus", String(job.limits.cpus), "--pids-limit", String(job.limits.pids),
      // Reap the agent's children; without an init, PID 1 leaves zombies behind.
      "--init",
      "--mount", `type=bind,source=${job.workspace},target=${WORKSPACE}`,
      "--workdir", WORKSPACE,
      ...Object.entries(job.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      // Labelled with the product's name (product-names.js); swept under either.
      "--label", `${WRITTEN}.sandbox=1`, "--label", `${WRITTEN}.run=${name}`,
      ...(this.owner ? ["--label", `${WRITTEN}.owner=${this.owner}`] : []),
      job.image, ...job.command];
  }

  async run_(args, timeoutMs) { return this.run(this.docker, args, { timeoutMs, maxOutputBytes: 4 << 20 }); }

  // "bind source path does not exist" for a path that plainly does exist is the
  // single most confusing failure this has produced -- four separate times, each
  // costing a run to rediscover. The daemon is inside a VM that mounts only part
  // of the filesystem, so the message is true from where it stands and useless
  // from here. Said once, properly, it stops being a puzzle.
  #why(stderr, job) {
    const said = (stderr || "").trim().slice(0, 500);
    if (!/bind source path does not exist/i.test(said)) return said;
    return `${said}\n（工作目录 ${job.workspace} 在本机存在，但容器守护进程看不到它。macOS 上 colima/Docker Desktop 只挂载部分目录——把工作目录放到 $HOME 下，不要用 /var/folders 或 /tmp。）`;
  }

  // Runs the job to completion and returns what it produced. A timeout is an
  // outcome, not an exception: the schedule records it and goes on to its next
  // turn, the way a failed run does.
  async execute(job, { signal } = {}) {
    // The production refusal has to stop the run, not only be printed at start:
    // a verdict nobody consults is a log line, and the isolation it describes
    // would still not hold.
    const permitted = await this.#permitted();
    if (!permitted.ok) throw new Error(`沙箱未能启动：${permitted.reason}`);
    const name = `${WRITTEN}-${randomUUID()}`;
    const startedAt = Date.now();
    let timedOut = false, interrupted = false;
    try {
      const result = await this.run(this.docker, this.argv(job, name),
        { timeoutMs: job.limits.timeoutMs + GRACE_MS, maxOutputBytes: 4 << 20, signal });
      // `docker run` keeps 125 for its own refusals -- a bind source that is not
      // there, an unregistered runtime, a flag this daemon will not take. The
      // container never started, so this has to be a failure. Returned as an
      // ordinary result it would be recorded as a run that completed with code
      // 125, and an unattended task that never once started would read as fine.
      if (result.code === 125) throw new Error(`沙箱未能启动：${this.#why(result.stderr, job)}`);
      return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: false, durationMs: Date.now() - startedAt, name };
    } catch (error) {
      interrupted = true;
      timedOut = /timed out/i.test(String(error?.message ?? ""));
      if (!timedOut) throw error;
      return { code: 124, stdout: "", stderr: `沙箱超过 ${job.limits.timeoutMs}ms 未结束，已终止`, timedOut: true, durationMs: Date.now() - startedAt, name };
    } finally {
      // `--rm` removes the container when it exits on its own. It does nothing
      // when the client is killed first -- a timeout, an abort, a crashed
      // control plane -- and the container then keeps running, holding the
      // memory this machine does not have. So removal is always attempted, and
      // "no such container" is the normal, healthy answer.
      if (interrupted || signal?.aborted) {
        const removed = await this.run_(["rm", "--force", "--volumes", name], 15_000).catch(() => null);
        if (!removed || (removed.code !== 0 && !/No such container:/i.test(removed.stderr ?? ""))) {
          // A failed docker client is not evidence that its container stopped.
          // Keep the workspace for startup recovery, but revoke the run token.
          const error = new Error("沙箱停止未确认（Docker daemon），运行目录已保留待恢复");
          error.workspaceSafeToRemove = false;
          throw error;
        }
      }
    }
  }

  // Containers this control plane left behind -- killed mid-run, restarted while
  // a task was going. Called at start, so a restart cannot leak a sandbox. Only
  // its own: with an owner, a container another control plane is running is
  // not this one's to remove.
  async sweep() {
    if (!this.owner) throw new Error("清理沙箱必须提供控制面归属标识");
    // Filters of one `ps` must all hold, so each spelling of the labels is its
    // own question: a container started before the rename carries mydoubao.*.
    const ids = [];
    for (const spelling of SPELLINGS) {
      const filters = ["--filter", `label=${spelling}.sandbox=1`, "--filter", `label=${spelling}.owner=${this.owner}`];
      const listed = await this.run_(["ps", "--all", "--quiet", ...filters], 15_000);
      if (listed.code !== 0) throw new Error("沙箱遗留检查失败，未清理运行目录");
      for (const id of (listed?.stdout ?? "").split("\n").map((row) => row.trim()).filter(Boolean)) if (!ids.includes(id)) ids.push(id);
    }
    if (ids.some(id => !/^[a-f0-9]{6,64}$/.test(id))) throw new Error("沙箱遗留检查返回无效容器标识");
    if (ids.length > 0) {
      const removed = await this.run_(["rm", "--force", "--volumes", ...ids], 30_000);
      if (removed.code !== 0) throw new Error("沙箱遗留容器停止未确认，未清理运行目录");
    }
    return ids.length;
  }
}
