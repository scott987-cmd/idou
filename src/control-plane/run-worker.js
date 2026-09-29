// A worker of the execution pool (docs/scaling-plan.md step 3): takes runs the
// coordinator queued (run-queue.js), runs each in this machine's sandbox, and
// hands back what the container produced. It holds no Feishu authority and no
// schedule: the job carries its egress token, and the egress proxy the
// container talks to checks everything else.
//
// It runs only what it was set up to run -- its own image, through its own
// egress gateway -- whatever a job says, and re-checks every job as the
// coordinator's sandbox would (sandbox/job.js). The queue is sealed with the
// replicas' key, so only they can put a job there; this is the second lock.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sandboxJob } from "./sandbox/job.js";
import { RUN_FILES } from "./sandbox/pool-sandbox.js";
import { newWorkerId } from "./run-queue.js";

const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class RunWorker {
  constructor({ queue, sandbox, runsDir, image, gateway, concurrency = 2, leaseMs = 15_000, renewMs = 3000, pollMs = 2000, id = newWorkerId(), log = () => {} }) {
    if (!queue || typeof sandbox?.execute !== "function" || !path.isAbsolute(runsDir ?? "") || !image || !gateway) throw new Error("A worker needs a queue, a sandbox, a runs directory, an image and a gateway");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || renewMs >= leaseMs) throw new Error("Invalid worker limits");
    Object.assign(this, { queue, sandbox, runsDir, image, gateway, concurrency, leaseMs, renewMs, pollMs, id, log });
    this.running = new Map();
    this.closed = false;
    this.completed = 0; this.refused = 0;
  }

  start() {
    this.heard = (notice) => { if (notice === "queued") void this.#fill(); };
    this.queue.on("notice", this.heard);
    this.timer = setInterval(() => { void this.#fill(); }, this.pollMs);
    this.timer.unref?.();
    void this.#fill();
    return this;
  }

  // Takes runs until its slots are full or the queue is empty. One at a time:
  // two fills at once would both see a free slot.
  #fill() {
    if (this.filling) return this.filling;
    this.filling = (async () => {
      while (!this.closed && this.running.size < this.concurrency) {
        let run;
        try { run = await this.queue.claim(this.id, this.leaseMs); }
        catch (error) { this.log({ component: "run-worker", event: "claim-failed", message: String(error?.message ?? error).slice(0, 200) }); return; }
        if (!run || this.closed) return;
        this.#execute(run);
      }
    })().finally(() => { this.filling = null; });
    return this.filling;
  }

  #execute(run) {
    const controller = new AbortController();
    // Held while it runs: renewed well inside the lease, and stopped the moment
    // the coordinator cancels it or the run is no longer this worker's.
    const heartbeat = setInterval(async () => {
      const held = await this.queue.renew(run.id, this.id, this.leaseMs).catch(() => undefined);
      if (held === null || held?.cancel) controller.abort(new DOMException(held === null ? "The run is no longer this worker's" : "The run was cancelled", "AbortError"));
    }, this.renewMs);
    heartbeat.unref?.();
    const workspace = RUN_ID.test(run.id) ? path.join(this.runsDir, run.id) : null;
    let keep = false, made = false;
    const done = (async () => {
      let result;
      try {
        if (!workspace) throw new Error("运行标识不合法");
        const { job: input, files } = run.payload ?? {};
        if (input?.image !== this.image) throw new Error("镜像与执行节点的配置不符，拒绝执行");
        if (input?.network?.mode !== "gateway" || input.network.gateway !== this.gateway) throw new Error("出口网关与执行节点的配置不符，拒绝执行");
        if (Object.keys(files ?? {}).some((name) => !RUN_FILES.includes(name))) throw new Error("运行目录里有不认识的文件");
        await mkdir(this.runsDir, { recursive: true, mode: 0o700 });
        await mkdir(workspace, { mode: 0o700 }); made = true;
        for (const [name, content] of Object.entries(files ?? {})) {
          await writeFile(path.join(workspace, name), Buffer.from(content, "base64"), { mode: name === "task.json" ? 0o600 : 0o644, flag: "wx" });
        }
        const job = sandboxJob({ ...input, workspace });
        const produced = await this.sandbox.execute(job, { signal: controller.signal });
        result = { code: produced.code, stdout: produced.stdout, stderr: produced.stderr, timedOut: produced.timedOut === true, durationMs: produced.durationMs };
        this.completed += 1;
      } catch (error) {
        keep = error?.workspaceSafeToRemove === false;
        if (controller.signal.aborted) result = { aborted: true };
        else { result = { error: { message: String(error?.message ?? error).slice(0, 2000) } }; this.refused += 1; }
      }
      clearInterval(heartbeat);
      // Cleared before the run is reported done, so done means nothing is left.
      // A container whose stop Docker could not confirm keeps its directory for
      // the next start's sweep, as on the coordinator.
      if (made && !keep) await rm(workspace, { recursive: true, force: true }).catch(() => {});
      await this.queue.complete(run.id, this.id, result).catch((error) =>
        this.log({ component: "run-worker", event: "complete-failed", message: String(error?.message ?? error).slice(0, 200) }));
    })().finally(() => {
      clearInterval(heartbeat);
      this.running.delete(run.id);
      void this.#fill();
    });
    this.running.set(run.id, { done, controller });
  }

  // Takes nothing more, lets what runs finish within `graceMs`, then stops the
  // rest; the coordinator hears them as stopped.
  async close({ graceMs = 60_000 } = {}) {
    this.closed = true;
    clearInterval(this.timer); this.queue.off("notice", this.heard);
    const finished = Promise.allSettled([...this.running.values()].map((run) => run.done));
    let timer;
    const late = await Promise.race([finished.then(() => false), new Promise((resolve) => { timer = setTimeout(() => resolve(true), graceMs); timer.unref?.(); })]);
    clearTimeout(timer);
    if (late) { for (const run of this.running.values()) run.controller.abort(new DOMException("The worker is stopping", "AbortError")); await finished; }
  }
}
