import test from "node:test";
import assert from "node:assert/strict";
import { DockerSandbox } from "../src/control-plane/sandbox/docker-sandbox.js";
import { sandboxJob } from "../src/control-plane/sandbox/job.js";
import { expectedImageLabels, IMAGE_LABELS } from "../src/control-plane/sandbox/sandbox-image.js";
import { readPins } from "../src/providers/runtime-artifacts.js";
import { readReleaseManifest } from "../src/providers/release-manifest.js";
import { WRITTEN } from "../src/product-names.js";

const job = sandboxJob({ image: "mydoubao/agent:1.0.0", command: ["node", "run.js"], workspace: "/srv/runs/abc" });

// The isolation IS the argv, so the double records it and the tests read it.
function docker({ outcome = () => ({ code: 0, stdout: "", stderr: "" }) } = {}) {
  const calls = [];
  const run = async (binary, args, options) => { calls.push({ binary, args, options }); return outcome(args); };
  return { calls, run, of: (verb) => calls.filter((call) => call.args[0] === verb) };
}
const flag = (args, name) => args[args.indexOf(name) + 1];

test("every boundary a container run has is actually asked for", () => {
  const args = new DockerSandbox({ run: docker().run }).argv(job, "mydoubao-1");
  assert.equal(flag(args, "--network"), "none", "no network unless the job asked for it");
  assert.ok(args.includes("--read-only"), "the image cannot be rewritten");
  assert.equal(flag(args, "--cap-drop"), "ALL");
  assert.equal(flag(args, "--security-opt"), "no-new-privileges");
  assert.equal(flag(args, "--user"), "65534:65534", "not root inside");
  assert.equal(flag(args, "--memory"), "512m");
  assert.equal(flag(args, "--memory-swap"), "512m", "equal to memory, so the task fails instead of swapping the host to death");
  assert.equal(flag(args, "--pids-limit"), "128");
  assert.ok(args.includes("--init"), "the agent's children get reaped");
  assert.ok(args.includes("--rm"), "the sandbox does not outlive its run");
  assert.equal(flag(args, "--mount"), "type=bind,source=/srv/runs/abc,target=/workspace");
  assert.equal(flag(args, "--workdir"), "/workspace");
  assert.deepEqual(args.slice(-3), ["mydoubao/agent:1.0.0", "node", "run.js"], "the image and command come last, as arguments");
});

test("switching to gVisor or a microVM is the runtime name and nothing else", () => {
  const plain = new DockerSandbox({ run: docker().run }).argv(job, "n");
  const gvisor = new DockerSandbox({ run: docker().run, runtime: "runsc" }).argv(job, "n");
  const kata = new DockerSandbox({ run: docker().run, runtime: "io.containerd.kata.v2" }).argv(job, "n");
  assert.equal(flag(plain, "--runtime"), "runc");
  assert.equal(flag(gvisor, "--runtime"), "runsc");
  assert.equal(flag(kata, "--runtime"), "io.containerd.kata.v2");
  // Everything else about the job has to be untouched, or "swap the runtime"
  // would quietly mean "and re-check all the other flags too".
  const without = (args) => args.filter((part, index) => part !== "--runtime" && args[index - 1] !== "--runtime");
  assert.deepEqual(without(gvisor), without(plain));
  assert.deepEqual(without(kata), without(plain));
});

test("open egress is a named choice, never a default", () => {
  const open = sandboxJob({ image: "a:1", command: ["true"], workspace: "/w", network: { mode: "open" } });
  assert.equal(flag(new DockerSandbox({ run: docker().run }).argv(open, "n"), "--network"), "bridge");
  assert.equal(flag(new DockerSandbox({ run: docker().run }).argv(job, "n"), "--network"), "none");
});

test("a gateway job joins the egress network, and never silently falls back to no network", () => {
  const viaGateway = sandboxJob({ image: "a:1", command: ["true"], workspace: "/w",
    network: { mode: "gateway", gateway: "http://egress.mydoubao.internal:881" } });
  const args = new DockerSandbox({ run: docker().run, gatewayNetwork: "mydoubao-egress" }).argv(viaGateway, "n");
  assert.equal(flag(args, "--network"), "mydoubao-egress");
  assert.ok(args.includes("IDOU_EGRESS=http://egress.mydoubao.internal:881"), "and is told where to send its traffic");
  assert.equal(flag(args, "--network") === "bridge", false, "it is not full egress either");

  // Without a configured network this used to fall through to `none`: the task
  // would believe it had a way out, reach nothing, and nothing would say why.
  assert.throws(() => new DockerSandbox({ run: docker().run }).argv(viaGateway, "n"), /未配置出口网络/);
  assert.throws(() => new DockerSandbox({ run: docker().run, gatewayNetwork: "bad name" }), /网络名不合法/);
  // A job with no gateway must not pick up the variable from the provider.
  assert.ok(!new DockerSandbox({ run: docker().run, gatewayNetwork: "mydoubao-egress" }).argv(job, "n").some((part) => String(part).startsWith("IDOU_EGRESS")));
});

test("a missing runtime is reported, not silently downgraded to namespaces", async () => {
  const withRunsc = docker({ outcome: () => ({ code: 0, stdout: JSON.stringify({ runc: {}, runsc: {} }), stderr: "" }) });
  assert.deepEqual((await new DockerSandbox({ run: withRunsc.run, runtime: "runsc" }).available()).ok, true);
  const withoutRunsc = docker({ outcome: () => ({ code: 0, stdout: JSON.stringify({ runc: {} }), stderr: "" }) });
  const missing = await new DockerSandbox({ run: withoutRunsc.run, runtime: "runsc" }).available();
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /runsc/, "it says which runtime is missing rather than running with a weaker one");
  const noDocker = docker({ outcome: () => { throw new Error("docker not found"); } });
  assert.equal((await new DockerSandbox({ run: noDocker.run }).available()).ok, false);
});

test("a finished run returns what it produced", async () => {
  const fake = docker({ outcome: () => ({ code: 0, stdout: "done", stderr: "" }) });
  const result = await new DockerSandbox({ run: fake.run }).execute(job);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "done");
  assert.equal(result.timedOut, false);
  assert.equal(fake.of("rm").length, 0, "a container that exited on its own needs no forced removal");
});

test("a task that overruns is an outcome, and its container does not survive it", async () => {
  // --rm removes a container that exits by itself. It does nothing when the
  // client is killed first, and the container then keeps the memory this
  // machine does not have.
  const fake = docker({ outcome: (args) => { if (args[0] === "run") throw new Error("docker timed out after 605000ms"); return { code: 0, stdout: "", stderr: "" }; } });
  const result = await new DockerSandbox({ run: fake.run }).execute(job);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
  const [removal] = fake.of("rm");
  assert.ok(removal, "the container is force-removed");
  assert.deepEqual(removal.args.slice(0, 3), ["rm", "--force", "--volumes"]);
  assert.equal(removal.args.at(-1), result.name, "and it is this run's container, not everything");
});

test("a container that never started is a failure, not a run that exited 125", async () => {
  // Measured against the real daemon: a bind source the Docker VM cannot see
  // answers with exit 125 and nothing on stdout. Handed back as an ordinary
  // result it becomes a "completed" run, so a scheduled task that never once
  // started would look like it had been working all along.
  const fake = docker({ outcome: args => args[0] === "rm" ? { code: 0 } : ({ code: 125, stdout: "", stderr: "docker: Error response from daemon: invalid mount config for type \"bind\"" }) });
  await assert.rejects(() => new DockerSandbox({ run: fake.run }).execute(job), /沙箱未能启动[\s\S]*invalid mount config/);
});

test("an unseeable bind source says why, because the daemon's own words mislead", async () => {
  // The daemon says the path does not exist while it plainly does exist on this
  // machine -- true from inside its VM, useless from outside it. Four separate
  // runs were spent rediscovering that, so the answer travels with the error.
  const fake = docker({ outcome: args => args[0] === "rm" ? { code: 0 } : ({ code: 125, stdout: "",
    stderr: `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${job.workspace}` }) });
  await assert.rejects(() => new DockerSandbox({ run: fake.run }).execute(job),
    (error) => /在本机存在，但容器守护进程看不到它/.test(error.message) && error.message.includes(job.workspace));
});

test("a refusal that is not about mounts is passed through as the daemon said it", async () => {
  // The explanation above is only right for one failure. Attached to every exit
  // 125 it would send the next reader after a mount that was never the problem.
  const fake = docker({ outcome: args => args[0] === "rm" ? { code: 0 } : ({ code: 125, stdout: "", stderr: "docker: Error response from daemon: unknown runtime specified runsc" }) });
  await assert.rejects(() => new DockerSandbox({ run: fake.run }).execute(job),
    (error) => /unknown runtime/.test(error.message) && !/守护进程看不到它/.test(error.message));
});

test("a failure that is not a timeout is raised, not disguised as one", async () => {
  const fake = docker({ outcome: () => { throw new Error("Cannot connect to the Docker daemon"); } });
  await assert.rejects(() => new DockerSandbox({ run: fake.run }).execute(job), /Docker daemon/);
});

test("a control plane that was killed mid-run cleans up its sandboxes at start", async () => {
  const fake = docker({ outcome: (args) => ({ code: 0, stdout: args[0] === "ps" ? "abc123\ndef456\n" : "", stderr: "" }) });
  const swept = await new DockerSandbox({ run: fake.run, owner: "0123456789abcdef" }).sweep();
  assert.equal(swept, 2);
  // One question per spelling of the product's name; the same container named
  // by both is removed once.
  const asked = fake.of("ps").map((call) => call.args);
  assert.equal(asked.length, 2);
  assert.ok(asked.some((args) => args.includes("label=idou.sandbox=1")) && asked.some((args) => args.includes("label=mydoubao.sandbox=1")),
    "only this product's own containers are considered, under either spelling");
  assert.deepEqual(fake.of("rm")[0].args, ["rm", "--force", "--volumes", "abc123", "def456"]);
  const none = docker({ outcome: () => ({ code: 0, stdout: "\n", stderr: "" }) });
  assert.equal(await new DockerSandbox({ run: none.run, owner: "0123456789abcdef" }).sweep(), 0);
  assert.equal(none.of("rm").length, 0, "nothing to sweep means no removal call at all");
});

test("failed container removal cannot authorize workspace destruction", async () => {
  const fake = docker({ outcome: args => {
    if (args[0] === "run") throw new Error("timed out");
    return { code: 1, stderr: "daemon unavailable" };
  } });
  await assert.rejects(new DockerSandbox({ run: fake.run }).execute(job), error => error.workspaceSafeToRemove === false);
});

test("recovery refuses unknown ownership, failed listing, and failed removal", async () => {
  await assert.rejects(new DockerSandbox({ run: docker().run }).sweep(), /归属/);
  const owner = "0123456789abcdef";
  await assert.rejects(new DockerSandbox({ owner, run: docker({ outcome: () => ({ code: 1, stdout: "" }) }).run }).sweep(), /检查失败/);
  const fake = docker({ outcome: args => args[0] === "ps" ? { code: 0, stdout: "abc123" } : { code: 1 } });
  await assert.rejects(new DockerSandbox({ owner, run: fake.run }).sweep(), /停止未确认/);
});

// R4: what the network actually is, not what the flags say it should be.
// `image` is what `docker image inspect` finds: null for nothing at all.
const host = ({ runtimes = ["runc"], internal = null, image = null } = {}) => docker({ outcome: (args) => {
  if (args[0] === "info") return { code: 0, stdout: JSON.stringify(Object.fromEntries(runtimes.map((name) => [name, {}]))), stderr: "" };
  if (args[0] === "network") return internal === null ? { code: 1, stdout: "", stderr: "No such network" }
    : { code: 0, stdout: `${internal} bridge\n`, stderr: "" };
  if (args[0] === "image") return image === null ? { code: 1, stdout: "", stderr: "No such image" }
    : { code: 0, stdout: `${JSON.stringify({ Id: image.id ?? `sha256:${"b".repeat(64)}`, Os: "linux", Architecture: "arm64", Config: image.labels ? { Labels: image.labels } : {}, RepoDigests: [] })}\n`, stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
} });

test("a sandbox network that is not internal is reported, because it means no boundary at all", async () => {
  // Measured on the machine this was written on: the egress network was a plain
  // bridge, and a container on it opened a TCP connection to 1.1.1.1:443. The
  // whole "one address out" design rests on a flag nothing was checking.
  const seen = await new DockerSandbox({ run: host({ internal: false }).run, gatewayNetwork: "mydoubao-egress" }).available();
  assert.equal(seen.ok, true, "a developer machine still runs");
  assert.equal(seen.network.internal, false);
  assert.ok(seen.faults.some((fault) => /不是 internal/.test(fault)), `it should say so: ${JSON.stringify(seen.faults)}`);
});

test("production refuses every way the isolation can be short of what it claims", async () => {
  const cases = [
    ["a network that is not internal", { internal: false, runtimes: ["runsc"] }, {}, /不是 internal/],
    ["a network that is not there", { internal: null, runtimes: ["runsc"] }, {}, /不存在/],
    ["reaching the proxy through the host", { internal: true, runtimes: ["runsc"] }, { gatewayHost: "egress.mydoubao.internal:host-gateway" }, /host-gateway/],
    ["plain namespaces", { internal: true, runtimes: ["runc"] }, { runtime: "runc" }, /系统调用面/],
  ];
  for (const [what, world, extra, expected] of cases) {
    const seen = await new DockerSandbox({ run: host(world).run, gatewayNetwork: "mydoubao-egress",
      runtime: extra.runtime ?? "runsc", gatewayHost: extra.gatewayHost ?? null, mode: "production" }).available();
    assert.equal(seen.ok, false, `production accepted ${what}`);
    assert.match(seen.reason, expected, what);
  }
});

test("production accepts a deployment that actually holds", async () => {
  const seen = await new DockerSandbox({ run: host({ internal: true, runtimes: ["runsc"] }).run,
    gatewayNetwork: "mydoubao-egress", runtime: "runsc", gatewayHost: "egress.mydoubao.internal:172.22.0.1", mode: "production" }).available();
  assert.equal(seen.ok, true, seen.reason);
  assert.deepEqual(seen.faults, []);
});

test("a development machine says what it is giving up rather than staying quiet", async () => {
  // The point is not to stop a developer. It is that "runs here" must never be
  // mistaken for "is isolated here".
  const seen = await new DockerSandbox({ run: host({ internal: false, runtimes: ["runc"] }).run,
    gatewayNetwork: "mydoubao-egress", gatewayHost: "egress.mydoubao.internal:host-gateway" }).available();
  assert.equal(seen.ok, true);
  assert.equal(seen.mode, "development");
  assert.equal(seen.faults.length, 3, `all three should be named: ${JSON.stringify(seen.faults)}`);
});

test("the mode itself is checked, so a typo cannot mean development", async () => {
  assert.throws(() => new DockerSandbox({ mode: "prod" }), /development 或 production/);
  assert.throws(() => new DockerSandbox({ mode: "" }), /development 或 production/);
});

// R7: the image, and whether the verdict about all of it is actually obeyed.
const pins = await readPins();
const release = await readReleaseManifest();
const LABELS = expectedImageLabels(pins, "linux-arm64");
const TAG = "mydoubao/sandbox:0.147.0-1.0.78";
const PINNED = `mydoubao/sandbox@sha256:${"c".repeat(64)}`;
const HOLDS = { internal: true, runtimes: ["runsc"] };
const holding = (extra = {}) => ({ gatewayNetwork: "mydoubao-egress", runtime: "runsc", gatewayHost: "egress.mydoubao.internal:172.22.0.1", pins, ...extra });

// `mydoubao/sandbox` is a Docker Hub namespace this product does not own. A
// run that pulled on a miss would run whatever its registrant published.
test("a run never pulls an image", () => {
  const args = new DockerSandbox({ run: docker().run }).argv(job, "n");
  assert.deepEqual(args.slice(0, 3), ["run", "--pull", "never"]);
});

test("containers carry the control plane they belong to, and a sweep removes only those", async () => {
  const owner = "0123456789abcdef";
  const args = new DockerSandbox({ run: docker().run, owner }).argv(job, "n");
  assert.ok(args.includes(`${WRITTEN}.owner=${owner}`), "the owner is on the container");
  const fake = docker({ outcome: (call) => ({ code: 0, stdout: call[0] === "ps" ? "abc123\n" : "", stderr: "" }) });
  await new DockerSandbox({ run: fake.run, owner }).sweep();
  for (const spelling of ["idou", "mydoubao"]) {
    const listed = fake.of("ps").map((call) => call.args).find((call) => call.includes(`label=${spelling}.sandbox=1`));
    assert.ok(listed?.includes(`label=${spelling}.owner=${owner}`), `${spelling}: ${listed?.join(" ")}`);
  }
  assert.throws(() => new DockerSandbox({ owner: "../../x" }), /归属标识不合法/);
  assert.ok(!new DockerSandbox({ run: docker().run }).argv(job, "n").some((part) => /^(idou|mydoubao)\.owner=/.test(part)), "no owner, no label");
});

test("without its image the sandbox is unavailable, in either mode, and says it will not pull", async () => {
  for (const mode of ["development", "production"]) {
    const seen = await new DockerSandbox({ run: host({ ...HOLDS, image: null }).run, ...holding({ image: PINNED, mode }) }).available();
    assert.equal(seen.ok, false, mode);
    assert.match(seen.reason, /不在本机，运行时不会自动拉取/);
  }
});

test("an image is named when it cannot be shown to match the lock", async () => {
  const check = async (labels) => (await new DockerSandbox({ run: host({ ...HOLDS, image: { labels } }).run, ...holding({ image: PINNED }) }).available()).faults;
  assert.deepEqual(await check(LABELS), [], "a matching image by digest raises nothing");
  assert.match((await check(null)).join(), /没有版本标签/);
  assert.match((await check({ ...LABELS, [IMAGE_LABELS.larkCli]: "1.0.70" })).join(), /com\.mydoubao\.lark-cli 是 1\.0\.70/);
});

test("production accepts an image only by digest", async () => {
  const byTag = await new DockerSandbox({ run: host({ ...HOLDS, image: { labels: LABELS } }).run, ...holding({ image: TAG, mode: "production" }) }).available();
  assert.equal(byTag.ok, false);
  assert.match(byTag.reason, /按标签引用/);
  const byDigest = await new DockerSandbox({ run: host({ ...HOLDS, image: { labels: LABELS } }).run, ...holding({ image: PINNED, mode: "production" }) }).available();
  assert.equal(byDigest.ok, true, byDigest.reason);
  const stale = await new DockerSandbox({ run: host({ ...HOLDS, image: { labels: { ...LABELS, [IMAGE_LABELS.codex]: "0.1.0" } } }).run, ...holding({ image: PINNED, mode: "production" }) }).available();
  assert.equal(stale.ok, false, "a pinned image built for another lock is still refused");
});

test("production accepts only the digest approved by the signed cross-component release", async () => {
  const approved = release.sandboxImages["linux-arm64"];
  const labels = expectedImageLabels(pins, "linux-arm64", release.upstreamsSha256);
  const good = await new DockerSandbox({ run: host({ ...HOLDS, image: { labels, id: approved.id } }).run,
    ...holding({ image: approved.reference, mode: "production" }), release }).available();
  assert.equal(good.ok, true, good.reason);
  const changed = await new DockerSandbox({ run: host({ ...HOLDS, image: { labels, id: approved.id } }).run,
    ...holding({ image: PINNED, mode: "production" }), release }).available();
  assert.equal(changed.ok, false);
  assert.match(changed.reason, /不是签名发布/);
});

// A server with Docker's classic image store loads the approved image instead of
// pulling it, and knows it only by its ID. Production accepts that ID when the
// signed release approved it, through the same verdict as a digest.
test("production accepts the approved image by its classic-store ID", async () => {
  const ID = `sha256:${"e".repeat(64)}`;
  const labels = expectedImageLabels(pins, "linux-arm64", release.upstreamsSha256);
  const signed = { ...release, sandboxImages: { "linux-arm64": { ...release.sandboxImages["linux-arm64"], classicId: ID } } };
  const loaded = await new DockerSandbox({ run: host({ ...HOLDS, image: { labels, id: ID } }).run, ...holding({ image: ID, mode: "production" }), release: signed }).available();
  assert.equal(loaded.ok, true, loaded.reason);
  const unapproved = await new DockerSandbox({ run: host({ ...HOLDS, image: { labels, id: ID } }).run, ...holding({ image: ID, mode: "production" }), release }).available();
  assert.equal(unapproved.ok, false, "a release that approved no classic ID accepts none");
  assert.match(unapproved.reason, /不是签名发布/);
});

// On a Linux host the run's workspace keeps its owner and 0700, so the
// container runs as that owner; unset, it stays nobody.
test("the container runs as the configured user, never as root", () => {
  assert.equal(flag(new DockerSandbox({ run: docker().run, uid: 999, gid: 988 }).argv(job, "n"), "--user"), "999:988");
  assert.equal(flag(new DockerSandbox({ run: docker().run }).argv(job, "n"), "--user"), "65534:65534");
  for (const [uid, gid] of [[0, 0], [999, 0], [0, 999], [-1, 5], [1.5, 5], ["999", 988]]) {
    assert.throws(() => new DockerSandbox({ uid, gid }), /不能以 root 运行/, `${uid}:${gid}`);
  }
});

// The R4 refusal was only ever printed at start. A verdict nobody consults is a
// log line; the run it describes went ahead anyway.
test("in production a deployment that does not hold stops the run before any container starts", async () => {
  const fake = host({ internal: false, runtimes: ["runc"], image: { labels: LABELS } });
  const box = new DockerSandbox({ run: fake.run, gatewayNetwork: "mydoubao-egress", image: PINNED, pins, mode: "production" });
  await assert.rejects(() => box.execute(job), /沙箱未能启动：生产模式拒绝执行[\s\S]*不是 internal/);
  assert.equal(fake.of("run").length, 0, "docker run was never called");
});

test("in production the verdict is asked again after a minute, not before every run", async () => {
  let now = 1_000_000;
  const fake = host({ ...HOLDS, image: { labels: LABELS } });
  const box = new DockerSandbox({ run: fake.run, ...holding({ image: PINNED, mode: "production" }), now: () => now });
  await box.execute(job);
  await box.execute(job);
  assert.equal(fake.of("info").length, 1, "one inspection for two runs inside the minute");
  assert.equal(fake.of("run").length, 2);
  now += 60_000;
  await box.execute(job);
  assert.equal(fake.of("info").length, 2, "asked again once the minute is up");
});

test("a verdict that turns bad stops the next run once the minute is up", async () => {
  let now = 0, internal = true;
  const fake = docker({ outcome: (args) => host({ internal, runtimes: ["runsc"], image: { labels: LABELS } }).run("docker", args) });
  const box = new DockerSandbox({ run: fake.run, ...holding({ image: PINNED, mode: "production" }), now: () => now });
  await box.execute(job);
  internal = false;
  now += 60_000;
  await assert.rejects(() => box.execute(job), /不是 internal/);
  assert.equal(fake.of("run").length, 1, "only the run before the change started a container");
});

test("a development run is not gated: its faults are said at start instead", async () => {
  const fake = host({ internal: null, runtimes: ["runc"], image: null });
  const result = await new DockerSandbox({ run: fake.run, gatewayNetwork: "mydoubao-egress", image: TAG, pins }).execute(job);
  assert.equal(result.code, 0);
  assert.equal(fake.of("info").length, 0, "nothing was inspected on the way to the run");
  assert.equal(fake.of("run").length, 1);
});
