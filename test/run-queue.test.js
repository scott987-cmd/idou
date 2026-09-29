// The execution pool's queue (src/control-plane/run-queue.js), on a PostgreSQL
// of the test's own. Several queues on one database stand for the coordinator
// and its workers.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { RunInterrupted, RunQueue, RunQueueBusy } from "../src/control-plane/run-queue.js";
import { testPostgres } from "./helpers/postgres.js";

async function queues(t, count = 2) {
  const server = await testPostgres(t), config = await server.database(), key = randomBytes(32);
  const opened = [];
  for (let index = 0; index < count; index += 1) {
    const pool = new pg.Pool({ ...config, max: 8 }); pool.on("error", () => {});
    const queue = await RunQueue.open({ pool, key, connect: async () => { const client = new pg.Client(config); await client.connect(); return client; } });
    server.closeFirst(async () => { await queue.close(); await pool.end(); });
    opened.push(queue);
  }
  const admin = new pg.Client(config); await admin.connect(); server.closeFirst(() => admin.end());
  return { queues: opened, admin };
}
const job = (marker = "secret-run-token-fixture") => ({ job: { image: "sandbox:fixture", env: { IDOU_RUN: marker } }, files: { "task.json": "e30" } });

test("a run goes in, a worker takes it, and whoever waits gets what it produced; the database holds it sealed", { timeout: 60_000 }, async (t) => {
  const { queues: [coordinator, worker], admin } = await queues(t);
  await coordinator.enqueue({ id: "run-1", schedule: "tenant/s1", owner: "c1", payload: job() });
  const waiting = coordinator.wait("run-1", { pollMs: 5000 });
  const taken = await worker.claim("w1", 10_000);
  assert.equal(taken.id, "run-1"); assert.deepEqual(taken.payload, job());
  assert.equal(await worker.claim("w1", 10_000), null, "nothing else to take");
  assert.deepEqual(await worker.renew("run-1", "w1", 10_000), { cancel: false });
  assert.equal(await worker.complete("run-1", "w2", { code: 1 }), false, "only the worker holding it can finish it");
  assert.equal(await worker.complete("run-1", "w1", { code: 0, stdout: "report-fixture" }), true);
  const started = Date.now();
  assert.deepEqual(await waiting, { code: 0, stdout: "report-fixture" });
  assert.ok(Date.now() - started < 4000, "heard, not polled");
  for (const { payload, result } of (await admin.query("SELECT payload, result FROM idou_run_queue")).rows) {
    assert.equal(payload.includes(Buffer.from("secret-run-token-fixture")), false);
    assert.equal(result.includes(Buffer.from("report-fixture")), false);
  }
});

test("one run per schedule at a time, whichever process asks", { timeout: 60_000 }, async (t) => {
  const { queues: [a, b] } = await queues(t);
  await a.enqueue({ id: "run-1", schedule: "tenant/s1", owner: "c1", payload: job() });
  await assert.rejects(b.enqueue({ id: "run-2", schedule: "tenant/s1", owner: "c2", payload: job() }), RunQueueBusy);
  await b.enqueue({ id: "run-3", schedule: "tenant/s2", owner: "c2", payload: job() });
  const taken = await b.claim("w1", 10_000);
  await assert.rejects(a.enqueue({ id: "run-4", schedule: taken.schedule, owner: "c1", payload: job() }), RunQueueBusy, "nor while it runs");
  await b.complete(taken.id, "w1", { code: 0 });
  await a.enqueue({ id: "run-5", schedule: taken.schedule, owner: "c1", payload: job() });
});

test("workers taking runs at the same moment take each one exactly once", { timeout: 60_000 }, async (t) => {
  const { queues: [coordinator, ...workers] } = await queues(t, 4);
  for (let index = 0; index < 30; index += 1) await coordinator.enqueue({ id: `run-${index}`, schedule: `tenant/s${index}`, owner: "c1", payload: job() });
  const taken = (await Promise.all(Array.from({ length: 45 }, (_, index) => workers[index % 3].claim(`w${index % 3}`, 10_000)))).filter(Boolean);
  assert.equal(taken.length, 30);
  assert.equal(new Set(taken.map((run) => run.id)).size, 30);
});

test("a worker is not held up by a run another is in the middle of taking", { timeout: 60_000 }, async (t) => {
  const { queues: [coordinator, worker], admin } = await queues(t);
  for (const id of ["run-a", "run-b"]) await coordinator.enqueue({ id, schedule: `tenant/${id}`, owner: "c1", payload: job() });
  // Another worker's transaction holding the oldest one.
  await admin.query("BEGIN");
  await admin.query("SELECT id FROM idou_run_queue WHERE id = 'run-a' FOR UPDATE");
  const started = Date.now();
  const taken = await Promise.race([worker.claim("w1", 10_000), new Promise((resolve) => setTimeout(() => resolve("held up"), 3000))]);
  await admin.query("ROLLBACK");
  assert.equal(taken?.id, "run-b", "it took the next one instead of waiting");
  assert.ok(Date.now() - started < 2000);
});

test("a worker that stops renewing leaves its run interrupted, not started again", { timeout: 60_000 }, async (t) => {
  const { queues: [coordinator, worker] } = await queues(t);
  await coordinator.enqueue({ id: "run-1", schedule: "tenant/s1", owner: "c1", payload: job() });
  await worker.claim("w1", 200);
  await assert.rejects(coordinator.wait("run-1", { pollMs: 150 }), (error) => error instanceof RunInterrupted && /执行节点中断/.test(error.message));
  assert.equal(await worker.renew("run-1", "w1", 10_000), null, "no longer the worker's");
  assert.equal(await worker.claim("w2", 10_000), null, "and nobody takes it up again");
  await coordinator.enqueue({ id: "run-2", schedule: "tenant/s1", owner: "c1", payload: job() });
});

test("cancelling: a queued run is never taken; a running one is told at its next renewal", { timeout: 60_000 }, async (t) => {
  const { queues: [coordinator, worker] } = await queues(t);
  await coordinator.enqueue({ id: "run-1", schedule: "tenant/s1", owner: "c1", payload: job() });
  await coordinator.cancel("run-1");
  assert.equal(await worker.claim("w1", 10_000), null);
  await assert.rejects(coordinator.wait("run-1"), /已取消/);
  await coordinator.enqueue({ id: "run-2", schedule: "tenant/s1", owner: "c1", payload: job() });
  await worker.claim("w1", 10_000);
  await coordinator.cancel("run-2");
  assert.deepEqual(await worker.renew("run-2", "w1", 10_000), { cancel: true });
  const controller = new AbortController(), waiting = coordinator.wait("run-2", { signal: controller.signal, pollMs: 100 });
  controller.abort();
  await assert.rejects(waiting, { name: "AbortError" });
});

test("a coordinator that restarted gives up only its own runs; ended runs are pruned", { timeout: 60_000 }, async (t) => {
  const { queues: [coordinator, worker], admin } = await queues(t);
  await coordinator.enqueue({ id: "mine-running", schedule: "tenant/s1", owner: "c1", payload: job() });
  assert.equal((await worker.claim("w1", 10_000)).id, "mine-running");
  await coordinator.enqueue({ id: "mine-queued", schedule: "tenant/s2", owner: "c1", payload: job() });
  await coordinator.enqueue({ id: "theirs", schedule: "tenant/s3", owner: "c2", payload: job() });
  assert.equal(await coordinator.cancelOwned("c1"), 2);
  const states = Object.fromEntries((await admin.query("SELECT id, state, cancel FROM idou_run_queue")).rows.map((row) => [row.id, `${row.state}${row.cancel ? "+cancel" : ""}`]));
  assert.deepEqual(states, { "mine-running": "running+cancel", "mine-queued": "cancelled+cancel", theirs: "queued" });
  assert.deepEqual(await worker.renew("mine-running", "w1", 10_000), { cancel: true }, "its worker is told to stop");
  await admin.query("UPDATE idou_run_queue SET updated_at = now() - interval '2 days' WHERE state = 'cancelled'");
  assert.equal(await coordinator.prune(), 1);
  assert.deepEqual(await coordinator.counts(), { queued: 1, running: 1 });
});
