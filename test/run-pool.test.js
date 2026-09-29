// The execution pool end to end (docs/scaling-plan.md step 3): the
// coordinator's PoolSandbox puts a job in the run queue, a RunWorker takes it
// and runs it in its sandbox -- here a stand-in that reports what it was
// given -- and the result comes back as a DockerSandbox's would.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { RunQueue } from "../src/control-plane/run-queue.js";
import { PoolSandbox } from "../src/control-plane/sandbox/pool-sandbox.js";
import { RunWorker } from "../src/control-plane/run-worker.js";
import { sandboxJob } from "../src/control-plane/sandbox/job.js";
import { testPostgres } from "./helpers/postgres.js";

const IMAGE = "mydoubao/sandbox:fixture", GATEWAY = "https://egress.mydoubao.internal:8444";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A sandbox that answers with the task it found in its workspace, after
// `holdMs`, or when stopped.
function standIn({ holdMs = 0 } = {}) {
  const seen = [];
  let running = 0, most = 0;
  return {
    seen, get most() { return most; },
    async execute(job, { signal }) {
      running += 1; most = Math.max(most, running);
      try {
        const task = await readFile(path.join(job.workspace, "task.json"), "utf8");
        const ca = await stat(path.join(job.workspace, "egress-ca.pem")).then((info) => (info.mode & 0o777).toString(8), () => null);
        seen.push({ job, task, ca });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, holdMs);
          signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        return { code: 0, stdout: `ran ${task}`, stderr: "", timedOut: false, durationMs: holdMs };
      } finally { running -= 1; }
    },
  };
}

async function pool(t, { sandbox = standIn(), claimTimeoutMs = 5000, workers = 1, concurrency = 2, leaseMs = 1500, worker = {} } = {}) {
  const server = await testPostgres(t), config = await server.database(), key = randomBytes(32);
  const open = async () => {
    const connection = new pg.Pool({ ...config, max: 6 }); connection.on("error", () => {});
    const queue = await RunQueue.open({ pool: connection, key, connect: async () => { const client = new pg.Client(config); await client.connect(); return client; } });
    server.closeFirst(async () => { await queue.close(); await connection.end(); });
    return queue;
  };
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-pool-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const coordinator = new PoolSandbox({ queue: await open(), owner: "coordinator-fixture", claimTimeoutMs, pollMs: 200 });
  const running = [];
  for (let index = 0; index < workers; index += 1) {
    const runner = new RunWorker({ queue: await open(), sandbox, runsDir: path.join(home, `worker-${index}`), image: IMAGE, gateway: GATEWAY,
      concurrency, leaseMs, renewMs: 200, pollMs: 200, ...worker }).start();
    server.closeFirst(() => runner.close({ graceMs: 2000 }));
    running.push(runner);
  }
  // A run prepared as the coordinator's runner prepares it: its directory,
  // with the task and the egress CA in it.
  const prepare = async (text = "hello", extra = {}) => {
    const runId = randomUUID(), workspace = path.join(home, "coordinator", runId);
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(path.join(workspace, "task.json"), JSON.stringify({ prompt: text }), { mode: 0o600 });
    await writeFile(path.join(workspace, "egress-ca.pem"), "-----CA-FIXTURE-----", { mode: 0o644 });
    const job = sandboxJob({ image: IMAGE, command: ["node", "/opt/run.js"], workspace, env: { IDOU_RUN: "run-token-fixture", IDOU_RUN_ID: runId },
      network: { mode: "gateway", gateway: GATEWAY }, limits: { timeoutMs: 60_000 }, ...extra });
    return { runId, job };
  };
  return { coordinator, workers: running, sandbox, prepare, home };
}

test("a run the coordinator queues is run by a worker, in a directory of its own, and its result comes back", { timeout: 60_000 }, async (t) => {
  const f = await pool(t);
  const { runId, job } = await f.prepare("hello");
  const result = await f.coordinator.execute(job, { runId, schedule: "tenant/s1" });
  assert.deepEqual(result, { code: 0, stdout: `ran ${JSON.stringify({ prompt: "hello" })}`, stderr: "", timedOut: false, durationMs: 0 });
  const [seen] = f.sandbox.seen;
  assert.notEqual(seen.job.workspace, job.workspace, "the worker's own directory");
  assert.ok(seen.job.workspace.startsWith(path.join(f.home, "worker-0")));
  assert.equal(seen.ca, "644");
  assert.deepEqual(seen.job.env, job.env); assert.deepEqual(seen.job.limits, job.limits);
  assert.deepEqual(await readdir(path.join(f.home, "worker-0")), [], "and gone once the run is");
});

test("a worker runs only its own image through its own gateway", { timeout: 60_000 }, async (t) => {
  const f = await pool(t);
  for (const [extra, reason] of [[{ image: "attacker/image:latest" }, /镜像与执行节点的配置不符/], [{ network: { mode: "gateway", gateway: "https://elsewhere.example:443" } }, /出口网关与执行节点的配置不符/]]) {
    const { runId, job } = await f.prepare("hello", extra);
    await assert.rejects(f.coordinator.execute(job, { runId, schedule: `tenant/${runId}` }), reason);
  }
  assert.equal(f.sandbox.seen.length, 0, "nothing was run");
});

test("a worker keeps to its slots, and several workers share the queue", { timeout: 60_000 }, async (t) => {
  const f = await pool(t, { sandbox: standIn({ holdMs: 300 }), workers: 2, concurrency: 2 });
  const runs = await Promise.all(Array.from({ length: 8 }, (_, index) => f.prepare(`task-${index}`)));
  const results = await Promise.all(runs.map(({ runId, job }, index) => f.coordinator.execute(job, { runId, schedule: `tenant/s${index}` })));
  assert.equal(results.length, 8);
  assert.ok(results.every((result) => result.code === 0));
  assert.ok(f.sandbox.most <= 4, `at most two each (${f.sandbox.most})`);
  assert.ok(f.workers.every((worker) => worker.completed > 0), "both took some");
});

test("cancelling a run stops its container, and the coordinator hears it as cancelled", { timeout: 60_000 }, async (t) => {
  const f = await pool(t, { sandbox: standIn({ holdMs: 30_000 }) });
  const { runId, job } = await f.prepare();
  const controller = new AbortController();
  const running = f.coordinator.execute(job, { runId, schedule: "tenant/s1", signal: controller.signal });
  for (const until = Date.now() + 5000; f.sandbox.seen.length === 0 && Date.now() < until;) await wait(20);
  const started = Date.now();
  controller.abort(new DOMException("stop", "AbortError"));
  await assert.rejects(running, { name: "AbortError" });
  assert.ok(Date.now() - started < 3000, "stopped at the next renewal, not at the end of the run");
});

test("a run no worker takes is given up, and says so", { timeout: 60_000 }, async (t) => {
  const f = await pool(t, { workers: 0, claimTimeoutMs: 500 });
  const { runId, job } = await f.prepare();
  await assert.rejects(f.coordinator.execute(job, { runId, schedule: "tenant/s1" }), /没有执行节点接手这次运行/);
});

test("a worker that dies mid-run leaves it interrupted; a restarted coordinator gives up what it had queued", { timeout: 60_000 }, async (t) => {
  const f = await pool(t, { sandbox: standIn({ holdMs: 30_000 }), leaseMs: 600 });
  const { runId, job } = await f.prepare();
  const running = f.coordinator.execute(job, { runId, schedule: "tenant/s1" });
  for (const until = Date.now() + 5000; f.sandbox.seen.length === 0 && Date.now() < until;) await wait(20);
  // The worker stops renewing, as a killed process would.
  f.workers[0].queue.renew = async () => undefined;
  await assert.rejects(running, /执行节点中断/);
  const g = await pool(t, { workers: 0, claimTimeoutMs: 60_000 });
  const queued = await g.prepare();
  const pending = g.coordinator.execute(queued.job, { runId: queued.runId, schedule: "tenant/s2" }).catch((error) => error);
  await wait(200);
  assert.equal(await g.coordinator.sweep(), 1);
  assert.match(String((await pending).message), /已取消|没有执行节点/);
});
