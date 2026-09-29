// A scheduled run through the execution pool, with the real scheduler, runner
// and egress on the coordinator's side (startScheduledTasks with the pool's
// sandbox) and a worker taking it from the queue. The worker's sandbox is a
// stand-in that answers with the task it was handed: this is about where the
// run goes and what comes back, not about Docker.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { startScheduledTasks, egressGateway } from "../src/control-plane/scheduled-tasks.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { RunQueue } from "../src/control-plane/run-queue.js";
import { PoolSandbox } from "../src/control-plane/sandbox/pool-sandbox.js";
import { RunWorker } from "../src/control-plane/run-worker.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { testPostgres } from "./helpers/postgres.js";

const WHO = { tenantId: "tenant-a", userId: "person-a", familyId: "login-a" };
const daily = { title: "每天汇总", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork", schedule: { frequency: "daily", time: "09:00", timeZone: "Asia/Shanghai" } };

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("a scheduled run is made ready here, run at a worker, and recorded here", { timeout: 90_000 }, async (t) => {
  const server = await testPostgres(t), config = await server.database(), key = randomBytes(32);
  const open = async () => {
    const connection = new pg.Pool({ ...config, max: 6 }); connection.on("error", () => {});
    const queue = await RunQueue.open({ pool: connection, key, connect: async () => { const client = new pg.Client(config); await client.connect(); return client; } });
    server.closeFirst(async () => { await queue.close(); await connection.end(); });
    return queue;
  };
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "idou-scheduled-pool-"));
  const sessions = new SessionRegistry();
  const owner = sessions.issue({ tenantId: WHO.tenantId, userId: WHO.userId, deviceId: "device-a" });
  const egressPort = await freePort(), logs = [];
  const tasks = await startScheduledTasks({ feishu: SAAS_FEISHU, sessions, sourceAccess: null, dataDir, controlPlaneOrigin: "http://127.0.0.1:1",
    egressPort, docker: "false", log: (line) => logs.push(line), liveSession: () => ({ token: owner.token }),
    execution: { sandbox: new PoolSandbox({ queue: await open(), owner: "coordinator-fixture", pollMs: 200 }) } });
  // close before rm, as in scheduled-tasks-startup.test.js.
  t.after(async () => { await tasks.close(); await rm(dataDir, { recursive: true, force: true }); });

  const seen = [];
  const worker = new RunWorker({ queue: await open(), runsDir: path.join(dataDir, "pool", "worker-1"), image: tasks.runner.image, gateway: egressGateway(egressPort),
    renewMs: 200, pollMs: 200, sandbox: { async execute(job) {
      seen.push({ env: job.env, task: JSON.parse(await readFile(path.join(job.workspace, "task.json"), "utf8")) });
      return { code: 0, stdout: "三条要点：一、二、三。", stderr: "", timedOut: false, durationMs: 5 };
    } } }).start();
  server.closeFirst(() => worker.close({ graceMs: 1000 }));

  const created = tasks.store.create(WHO, daily);
  assert.equal((await tasks.scheduler.runNow(created)).started, true);
  await Promise.allSettled([...tasks.scheduler.running.values()]);
  assert.equal(seen.length, 1, "the worker ran it");
  assert.equal(seen[0].task.prompt.endsWith(daily.prompt), true, "with the task the runner wrote");
  assert.match(seen[0].env.IDOU_RUN, /^[A-Za-z0-9_-]{43}$/, "and the run's egress token");
  const [run] = tasks.store.runs(WHO, created.id, 1);
  // The container produced a report, and archiving it is the coordinator's:
  // this server has no Drive archive configured, so that is where it stopped.
  assert.equal(run.outcome, "failed");
  assert.match(run.detail, /报告未保存/);
  assert.equal(tasks.egress.runs.size, 0, "its egress token is closed");
});
