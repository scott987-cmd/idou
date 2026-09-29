// The execution pool's queue (docs/scaling-plan.md step 3): scheduled runs
// the coordinator has prepared, waiting for a worker to run them in a sandbox
// and hand back what the container produced. A table in the PostgreSQL the
// replicas share.
//
//   - One run per schedule at a time, whatever process asks: a unique index on
//     the schedule over rows still queued or running. The scheduler's own check
//     is per process; this one holds across all of them.
//   - A worker takes a run with FOR UPDATE SKIP LOCKED, so two workers never
//     take the same one, and holds it on a lease it renews while the container
//     runs. A worker that dies stops renewing; its run is given up as
//     interrupted rather than started again -- a run may already have written
//     to Feishu, and doing it twice is worse than saying it stopped.
//   - Cancelling is a flag the worker reads when it renews its lease.
//   - What a run carries (its sandbox job, with the run's egress token) and what
//     it produced are sealed with the queue's own key, bound to the run: made
//     from the key the replicas share (database.js runQueueKey), and all a
//     worker is given of it.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { openValue, sealValue } from "./state-store.js";
import { namedDatabase } from "./database-names.js";

// As the source names it; a database from before the rename calls it
// mydoubao_run_queue (database-names.js).
const CHANNEL = "idou_run_queue";
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS idou_run_queue (
    id text PRIMARY KEY, schedule text NOT NULL, owner text NOT NULL, state text NOT NULL,
    payload bytea NOT NULL, result bytea, worker text, lease_until timestamptz,
    cancel boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX IF NOT EXISTS idou_run_queue_active ON idou_run_queue (schedule) WHERE state IN ('queued', 'running');
  CREATE INDEX IF NOT EXISTS idou_run_queue_waiting ON idou_run_queue (created_at) WHERE state = 'queued';`;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SLOT = (id, part) => `run:${id}:${part}`;

export class RunQueueBusy extends Error {}
// A run nobody finished: its worker stopped renewing, or it was given up.
export class RunInterrupted extends Error {}

export class RunQueue extends EventEmitter {
  // `pool` a pg.Pool; `connect` a dedicated client for LISTEN; `key` the
  // queue's 32-byte key. The coordinator's side: it makes the table.
  static async open({ pool, connect, key, now = Date.now }) {
    if (!pool?.query || typeof connect !== "function") throw new Error("The run queue needs a pool and a way to connect");
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("The run queue needs a 32-byte sealing key");
    let channel;
    ({ pool, connect, channel } = await RunQueue.#named({ pool, connect }));
    const client = await pool.connect();
    try {
      // Made under a lock: replicas start together (state-store.js).
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('idou:schema:run-queue'))");
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
    const queue = new RunQueue({ pool, connect, key, now, channel });
    await queue.#listen();
    return queue;
  }

  // A worker's side. Its database role reaches this table and nothing else
  // (deploy/server/worker-role.sql), so it makes nothing: the table is the
  // coordinator's, and a worker that finds none, or cannot read it, says which.
  static async attach({ pool, connect, key, now = Date.now }) {
    if (!pool?.query || typeof connect !== "function") throw new Error("The run queue needs a pool and a way to connect");
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("The run queue needs a 32-byte sealing key");
    let channel;
    ({ pool, connect, channel } = await RunQueue.#named({ pool, connect }));
    try { await pool.query("SELECT id, schedule, state, payload, cancel FROM idou_run_queue LIMIT 0"); }
    catch (error) {
      if (error?.code === "42P01") throw new Error("执行池的队列表还不存在：协调副本第一次按执行池方式启动时会建它");
      if (error?.code === "42501") throw new Error("这个数据库角色读不了执行池的队列表：按 deploy/server/worker-role.sql 授权");
      throw error;
    }
    const queue = new RunQueue({ pool, connect, key, now, channel });
    await queue.#listen();
    return queue;
  }

  static async #named({ pool, connect }) {
    const named = await namedDatabase({ pool, connect });
    return { pool: named.pool, connect: named.connect, channel: named.name(CHANNEL) };
  }

  constructor({ pool, connect, key, now, channel = CHANNEL }) {
    super();
    Object.assign(this, { pool, connect, key, now, channel });
    this.closed = false; this.listener = null;
    this.setMaxListeners(0);
  }

  // "queued" when there is something to take; "done <id>" when a run ended.
  async #listen() {
    const client = await this.connect();
    client.on("notification", (message) => { if (message.channel === this.channel) this.emit("notice", message.payload); });
    const lost = () => {
      if (this.closed || this.listener !== client) return;
      this.listener = null;
      void client.end().catch(() => {});
      const again = (delay) => setTimeout(() => {
        if (this.closed) return;
        this.#listen().then(() => this.emit("notice", "queued"), () => again(Math.min(delay * 2, 30_000)));
      }, delay).unref?.();
      again(1000);
    };
    client.on("error", lost); client.on("end", lost);
    await client.query(`LISTEN ${CHANNEL}`);
    this.listener = client;
  }

  #seal(id, part, value) { return sealValue(this.key, "run-queue", SLOT(id, part), value); }
  #open(id, part, sealed) { return openValue(this.key, "run-queue", SLOT(id, part), sealed); }

  // A run for a worker to take. Refused while the same schedule has one queued
  // or running, by any process.
  async enqueue({ id, schedule, owner, payload }) {
    if (!ID.test(id) || typeof schedule !== "string" || !schedule || typeof owner !== "string" || !owner) throw new Error("Invalid run");
    try {
      await this.pool.query(`WITH queued AS (INSERT INTO idou_run_queue (id, schedule, owner, state, payload) VALUES ($1, $2, $3, 'queued', $4) RETURNING id)
        SELECT pg_notify('${CHANNEL}', 'queued') FROM queued`, [id, schedule, owner, this.#seal(id, "payload", payload)]);
    } catch (error) {
      if (error?.code === "23505") throw new RunQueueBusy("这个任务上一次运行还没结束");
      throw error;
    }
  }

  // The oldest run nobody has, now this worker's until `leaseMs` from now.
  async claim(worker, leaseMs) {
    const { rows } = await this.pool.query(`
      UPDATE idou_run_queue SET state = 'running', worker = $1, lease_until = now() + ($2::bigint * interval '1 millisecond'), updated_at = now()
      WHERE id = (SELECT id FROM idou_run_queue WHERE state = 'queued' AND NOT cancel ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, schedule, payload`, [worker, leaseMs]);
    const row = rows[0];
    return row ? { id: row.id, schedule: row.schedule, payload: this.#open(row.id, "payload", row.payload) } : null;
  }

  // Held for another `leaseMs`. Answers whether it was cancelled, or null if
  // it is no longer this worker's (given up, or taken back).
  async renew(id, worker, leaseMs) {
    const { rows } = await this.pool.query(`UPDATE idou_run_queue SET lease_until = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
      WHERE id = $1 AND worker = $2 AND state = 'running' RETURNING cancel`, [id, worker, leaseMs]);
    return rows[0] ? { cancel: rows[0].cancel } : null;
  }

  // What the container produced. Only the worker holding the run can say.
  async complete(id, worker, result) {
    const { rowCount } = await this.pool.query(`WITH done AS (UPDATE idou_run_queue SET state = 'done', result = $3, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND worker = $2 AND state = 'running' RETURNING id)
      SELECT pg_notify('${CHANNEL}', 'done ' || id) FROM done`, [id, worker, this.#seal(id, "result", result)]);
    return rowCount > 0;
  }

  // Asked to stop. One still queued is given up at once; one running is
  // stopped by its worker at its next renewal.
  async cancel(id) {
    await this.pool.query(`WITH changed AS (UPDATE idou_run_queue SET cancel = true,
        state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END, updated_at = now() WHERE id = $1 RETURNING id, state)
      SELECT pg_notify('${CHANNEL}', 'done ' || id) FROM changed WHERE state = 'cancelled'`, [id]);
  }

  // Runs whose worker stopped renewing: given up, and said so to whoever waits.
  async reap() {
    const { rows } = await this.pool.query(`WITH gone AS (UPDATE idou_run_queue SET state = 'interrupted', updated_at = now()
        WHERE state = 'running' AND lease_until < now() RETURNING id)
      SELECT id, pg_notify('${CHANNEL}', 'done ' || id) FROM gone`);
    return rows.map((row) => row.id);
  }

  // Everything an owner (a coordinator) still has queued or running, cancelled:
  // what a coordinator that restarted can no longer finish.
  async cancelOwned(owner) {
    const { rows } = await this.pool.query(`UPDATE idou_run_queue SET cancel = true,
        state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END, updated_at = now()
      WHERE owner = $1 AND state IN ('queued', 'running') RETURNING id`, [owner]);
    return rows.length;
  }

  async #state(id) {
    const { rows } = await this.pool.query("SELECT state, result FROM idou_run_queue WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
  async stateOf(id) { return (await this.#state(id))?.state ?? null; }

  // What the run produced, once it has ended. Heard through the queue's
  // notifications, and looked up every `pollMs` besides, since a notification
  // can be missed while the listening connection is being re-established.
  async wait(id, { signal, pollMs = 2000 } = {}) {
    for (;;) {
      signal?.throwIfAborted();
      const row = await this.#state(id);
      if (!row) throw new RunInterrupted("运行记录不存在");
      if (row.state === "done") return this.#open(id, "result", row.result);
      if (row.state === "cancelled") throw new RunInterrupted("运行已取消");
      if (row.state === "interrupted") throw new RunInterrupted("执行节点中断，运行没有完成");
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); this.off("notice", heard); signal?.removeEventListener("abort", finish); resolve(); };
        const heard = (notice) => { if (notice === `done ${id}`) finish(); };
        const timer = setTimeout(finish, pollMs);
        this.on("notice", heard);
        signal?.addEventListener("abort", finish, { once: true });
      });
      await this.reap().catch(() => {});
    }
  }

  // Ended runs are kept a day, for whoever asks what happened, then removed.
  async prune(maxAgeMs = 86_400_000) {
    const { rowCount } = await this.pool.query(`DELETE FROM idou_run_queue WHERE state NOT IN ('queued', 'running')
      AND updated_at < now() - ($1::bigint * interval '1 millisecond')`, [maxAgeMs]);
    return rowCount;
  }

  async counts() {
    const { rows } = await this.pool.query("SELECT state, count(*)::int AS n FROM idou_run_queue WHERE state IN ('queued', 'running') GROUP BY state");
    return Object.fromEntries(rows.map((row) => [row.state, row.n]));
  }

  async close() {
    this.closed = true;
    const listener = this.listener; this.listener = null;
    await listener?.end().catch(() => {});
    this.removeAllListeners();
  }
}

export const newWorkerId = () => `worker-${randomUUID()}`;
