// One coordinator at a time on the shared data (src/control-plane/coordinator-lease.js,
// docs/scaling-plan.md §2.6), on a PostgreSQL of the test's own. Leases here
// last 1.5 seconds, so what takes half a minute on a server happens while the
// test watches.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { CoordinatorLease } from "../src/control-plane/coordinator-lease.js";
import { loadCoordinatorLease } from "../src/control-plane/server-config.js";
import { testPostgres } from "./helpers/postgres.js";

const TTL = 1500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function database(t) {
  const server = await testPostgres(t), config = await server.database(), pools = [];
  server.closeFirst(async () => { for (const pool of pools) await pool.end(); });
  // A coordinator's own connection to the database, which a test may cut:
  // `broken` refuses every query, `hung` answers none.
  const connect = () => {
    const pool = new pg.Pool({ ...config, max: 2 }); pool.on("error", () => {}); pools.push(pool);
    const state = { broken: false, hung: false };
    const wrapped = { connect: () => pool.connect(), query: (...args) => state.hung ? new Promise(() => {})
      : state.broken ? Promise.reject(new Error("connection terminated")) : pool.query(...args) };
    return { pool: wrapped, state };
  };
  return { connect };
}
const open = (connection, holder) => CoordinatorLease.open({ pool: connection.pool, holder, ttlMs: TTL });

test("one coordinator holds the lease; another stands by, and takes over the moment it is given up", { timeout: 30_000 }, async (t) => {
  const db = await database(t);
  const a = await open(db.connect(), "machine-a"), b = await open(db.connect(), "machine-b");
  assert.equal(await a.take(), true);
  assert.equal(await b.take(), false, "held, so not taken");
  const current = await CoordinatorLease.current(db.connect().pool);
  assert.deepEqual([current.holder, current.live], ["machine-a", true]);
  a.hold({ onLost: () => assert.fail("a keeps it while it renews") });
  await wait(TTL * 1.5);
  assert.equal(await b.take(), false, "renewed, so still held well past one lease");
  let waited = false;
  const standing = b.wait({ everyMs: 50, onWaiting: (holder) => { waited = holder?.holder === "machine-a"; } });
  await wait(100);
  assert.equal(await a.release(), true);
  const since = performance.now();
  await standing;
  assert.equal(waited, true, "told who it was waiting for");
  assert.ok(performance.now() - since < TTL / 2, "taken over at the next look, not when the lease would have run out");
  assert.equal((await CoordinatorLease.current(db.connect().pool)).holder, "machine-b");
  await b.release();
});

test("a lease that lapsed while its holder was frozen is taken over, and the holder stops as soon as it runs again", { timeout: 30_000 }, async (t) => {
  const db = await database(t);
  const a = await open(db.connect(), "machine-a"), b = await open(db.connect(), "machine-b");
  assert.equal(await a.take(), true);
  // a renews nothing -- a process that froze -- and the lease runs out.
  await wait(TTL + 200);
  assert.equal(await b.take(), true, "lapsed, so taken");
  const lost = new Promise((resolve) => a.hold({ onLost: resolve }));
  assert.match(await lost, /进程停顿过|已经接手/);
  assert.equal((await CoordinatorLease.current(db.connect().pool)).holder, "machine-b", "and b still holds it");
  assert.equal(await a.release(), false, "a lost lease is not a's to give up");
  assert.equal((await CoordinatorLease.current(db.connect().pool)).holder, "machine-b");
});

test("a lease taken from its holder is noticed at the next renewal, and not taken back", { timeout: 30_000 }, async (t) => {
  const db = await database(t), own = db.connect();
  const a = await open(own, "machine-a");
  assert.equal(await a.take(), true);
  const lost = new Promise((resolve) => a.hold({ onLost: resolve }));
  // However it happened -- an operator's hand, a restored database -- the row
  // names somebody else now.
  const admin = db.connect().pool;
  await admin.query("UPDATE idou_coordinator SET holder = 'machine-b' WHERE id = 1");
  const since = performance.now();
  assert.match(await lost, /另一个协调副本已经接手/);
  assert.ok(performance.now() - since <= TTL / 3 + 250, "at the next renewal, a third of the lease away at most");
  assert.equal((await CoordinatorLease.current(admin)).holder, "machine-b");
});

// The property the lease exists for: however the holder loses the database,
// it has stopped before anybody else can start.
for (const [cut, how] of [["broken", "refuses it"], ["hung", "never answers"]]) {
  test(`a holder whose database ${how} stops itself before its lease lapses, and only then can another take over`, { timeout: 30_000 }, async (t) => {
    const db = await database(t);
    const own = db.connect(), a = await open(own, "machine-a"), b = await open(db.connect(), "machine-b");
    const takenAt = performance.now();
    assert.equal(await a.take(), true);
    let lostAt = null;
    a.hold({ onLost: () => { lostAt = performance.now(); } });
    own.state[cut] = true;
    let takenOverAt = null;
    for (const until = performance.now() + TTL * 3; takenOverAt === null && performance.now() < until;) {
      if (await b.take()) takenOverAt = performance.now();
      else await wait(25);
    }
    assert.ok(lostAt !== null, "it stopped");
    assert.ok(lostAt - takenAt < TTL, `before its lease could lapse (${Math.round(lostAt - takenAt)} ms of ${TTL})`);
    assert.ok(takenOverAt !== null && takenOverAt > lostAt, "and the next one started after it stopped, never while it was still acting");
    await b.release();
  });
}

test("standing by ends when the process is asked to stop", { timeout: 30_000 }, async (t) => {
  const db = await database(t);
  const a = await open(db.connect(), "machine-a"), b = await open(db.connect(), "machine-b");
  await a.take();
  const stopping = new AbortController();
  const standing = b.wait({ everyMs: 50, signal: stopping.signal });
  await wait(120);
  stopping.abort(new Error("SIGTERM"));
  await assert.rejects(standing, /SIGTERM/);
  assert.equal((await CoordinatorLease.current(db.connect().pool)).holder, "machine-a");
  await a.release();
});

test("the lease length is said in whole seconds, within sense, or refused by name", () => {
  assert.equal(loadCoordinatorLease({}), 30_000);
  assert.equal(loadCoordinatorLease({ IDOU_COORDINATOR_LEASE_SECONDS: "6" }), 6000);
  for (const bad of ["5", "301", "1.5", "30s", "-30", "0"]) {
    assert.throws(() => loadCoordinatorLease({ IDOU_COORDINATOR_LEASE_SECONDS: bad }), /IDOU_COORDINATOR_LEASE_SECONDS/, bad);
  }
});
