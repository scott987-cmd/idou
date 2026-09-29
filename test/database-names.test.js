import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import pg from "pg";
import { testPostgres } from "./helpers/postgres.js";
import { PostgresStateStore } from "../src/control-plane/state-store.js";
import { RunQueue } from "../src/control-plane/run-queue.js";
import { PostgresScheduleStore } from "../src/control-plane/schedule-store-postgres.js";
import { PostgresModelUsage } from "../src/control-plane/model-usage.js";
import { PostgresSiteStorage } from "../src/control-plane/site-registry.js";
import { CoordinatorLease } from "../src/control-plane/coordinator-lease.js";

// The product was renamed from 我的豆包 (mydoubao) to i豆 (idou). Its tables
// are made as idou_* now; a database made before then holds mydoubao_* tables
// and has to go on being used as it is -- by a server of either version, at
// the same time during a rolling restart: the same rows, the same locks, the
// same notification channels (database-names.js).
async function opened(t, { legacy }) {
  const server = await testPostgres(t), config = await server.database();
  const pool = new pg.Pool({ ...config, max: 6 }); pool.on("error", () => {});
  const clients = [];
  const connect = async () => { const client = new pg.Client(config); client.on("error", () => {}); await client.connect(); clients.push(client); return client; };
  const admin = new pg.Client(config); await admin.connect();
  // A database from before the rename: what the previous release made first.
  if (legacy) await admin.query("CREATE TABLE mydoubao_state (namespace text NOT NULL, key text NOT NULL, parent text, owner text, value bytea NOT NULL, version bigint NOT NULL, expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (namespace, key))");
  const key = randomBytes(32);
  const stores = [];
  server.closeFirst(async () => {
    for (const store of stores.reverse()) await store.close?.();
    for (const client of clients) await client.end().catch(() => {});
    await admin.end(); await pool.end();
  });
  const open = async (make) => { const store = await make(); stores.push(store); return store; };
  const state = await open(() => PostgresStateStore.open({ pool, connect, key }));
  await open(() => RunQueue.open({ pool, connect, key: randomBytes(32) }));
  await open(() => PostgresScheduleStore.open({ pool, key }));
  await open(() => PostgresModelUsage.open({ pool, flushMs: 60_000 }));
  await open(() => PostgresSiteStorage.open({ pool, state, key }));
  const lease = await open(() => CoordinatorLease.open({ pool, holder: "machine-a" }));
  const tables = (await admin.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema() ORDER BY 1")).rows.map((row) => row.tablename);
  return { server, config, pool, connect, admin, key, state, lease, tables, open };
}

test("a new database is made with the product's new name", async (t) => {
  const { tables } = await opened(t, { legacy: false });
  assert.ok(tables.length >= 7, tables.join(" "));
  assert.deepEqual(tables.filter((name) => !name.startsWith("idou_")), [], "every table is idou_*");
});

test("a database from before the rename keeps its tables, and nothing new is made beside them", async (t) => {
  const { tables, state, admin, lease, pool } = await opened(t, { legacy: true });
  assert.deepEqual(tables.filter((name) => !name.startsWith("mydoubao_")), [], "every table is still mydoubao_*");
  await state.put("session", "s1", { token: "fixture" });
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM mydoubao_state WHERE key = 's1'")).rows[0].n, 1, "written where the earlier release reads");
  assert.equal(await lease.take(), true);
  assert.equal((await CoordinatorLease.current(pool))?.holder, "machine-a", "read back through the pool as the server holds it");
});

test("in a database from before the rename, the locks and the channel are the ones the earlier release uses", async (t) => {
  const { server, state, config, open, key, pool, connect } = await opened(t, { legacy: true });
  // A named lock, as the earlier release computed its id.
  const held = await state.lock("coordinator");
  assert.equal(held.held, true);
  const earlier = new pg.Client(config); await earlier.connect(); server.closeFirst(() => earlier.end());
  const id = createHash("sha256").update("mydoubao:coordinator").digest().readBigInt64BE(0).toString();
  assert.equal((await earlier.query("SELECT pg_try_advisory_lock($1) AS held", [id])).rows[0].held, false, "an earlier server finds it taken");
  await held.release();
  // A change announced by one replica reaches another, and reaches a replica of
  // the earlier release, which listens on mydoubao_state.
  await earlier.query("LISTEN mydoubao_state");
  const other = await open(() => PostgresStateStore.open({ pool, connect, key }));
  const heard = once(other, "change"), told = once(earlier, "notification");
  await state.put("session", "s2", { token: "fixture" });
  assert.equal((await heard)[0].key, "s2");
  assert.equal((await told)[0].channel, "mydoubao_state");
});

// The worker's role (deploy/server/worker-role.sql) is granted the queue under
// the name the database has: on a database from before the rename, that is
// mydoubao_run_queue, and still nothing else.
test("the worker's role reaches the queue of a database from before the rename, and nothing else", async (t) => {
  const { server, config, admin } = await opened(t, { legacy: true });
  const { readFile } = await import("node:fs/promises");
  await admin.query(await readFile(new URL("../deploy/server/worker-role.sql", import.meta.url), "utf8"));
  const worker = new pg.Client({ ...config, user: "idou_worker" }); worker.on("error", () => {}); await worker.connect();
  server.closeFirst(() => worker.end());
  await worker.query("SELECT id, schedule, state, payload, cancel FROM mydoubao_run_queue LIMIT 0");
  await assert.rejects(worker.query("SELECT value FROM mydoubao_state"), (error) => error.code === "42501");
  await assert.rejects(worker.query("SELECT result FROM mydoubao_run_queue"), (error) => error.code === "42501");
});
