// The state every replica of the control plane shares (src/control-plane/
// state-store.js). One contract, two implementations: what holds in one
// process must hold across processes, so each case runs against both -- and
// for PostgreSQL, with two stores on one database standing for two replicas.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { MemoryStateStore, PostgresStateStore } from "../src/control-plane/state-store.js";
import { testPostgres } from "./helpers/postgres.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postgresPair(t, server, key = randomBytes(32)) {
  const config = await server.database();
  const pools = [];
  let count = 0;
  const open = async (sealing = key) => {
    const pool = new pg.Pool({ ...config, max: 4 });
    pool.on("error", () => {});
    pools.push(pool);
    // Each store's own connections carry its name, so a test can cut one.
    const name = `store-${count += 1}`;
    const store = await PostgresStateStore.open({ pool, key: sealing, connect: async () => { const client = new pg.Client({ ...config, application_name: name }); await client.connect(); return client; } });
    store.testName = name;
    server.closeFirst(() => store.close());
    return store;
  };
  server.closeFirst(async () => { for (const pool of pools) await pool.end(); });
  const a = await open(), b = await open();
  return { a, b, config, open, server };
}

const kinds = {
  memory: async () => { const store = new MemoryStateStore(); return { a: store, b: store }; },
  postgres: null, // set up per test (needs the test context)
};

for (const kind of Object.keys(kinds)) {
  const pair = async (t) => {
    if (kind === "memory") return kinds.memory();
    return postgresPair(t, await testPostgres(t));
  };

  test(`${kind}: a record is written, read back, versioned, and removed`, { timeout: 60_000 }, async (t) => {
    const { a, b } = await pair(t);
    assert.equal(await a.get("session", "k1"), null);
    assert.deepEqual(await a.put("session", "k1", { user: "u1", scopes: ["models:responses"] }, { parent: "p1", owner: "t1/u1", ttlMs: 60_000 }), { version: 1 });
    const read = await b.get("session", "k1");
    assert.deepEqual(read.value, { user: "u1", scopes: ["models:responses"] });
    assert.equal(read.version, 1); assert.equal(read.parent, "p1"); assert.equal(read.owner, "t1/u1");
    assert.ok(read.expiresAt > Date.now() + 50_000);
    assert.deepEqual(await b.put("session", "k1", { user: "u1", renewed: true }), { version: 2 }, "a rewrite is the next version");
    assert.deepEqual((await a.get("session", "k1")).value, { user: "u1", renewed: true });
    assert.equal(await b.get("grant", "k1"), null, "namespaces are apart");
    assert.equal(await a.delete("session", "k1"), true);
    assert.equal(await b.get("session", "k1"), null);
    assert.equal(await a.delete("session", "k1"), false);
    await assert.rejects(a.put("Bad Namespace", "k", {}), /Invalid state namespace/);
    await assert.rejects(a.put("session", "", {}), /Invalid state key/);
  });

  test(`${kind}: an expired record is gone for every reader, and sweep removes it`, { timeout: 60_000 }, async (t) => {
    const { a, b } = await pair(t);
    await a.put("flow", "short", { n: 1 }, { ttlMs: 150 });
    await a.put("flow", "long", { n: 2 }, { ttlMs: 60_000 });
    assert.ok(await b.get("flow", "short"));
    await wait(400);
    assert.equal(await b.get("flow", "short"), null);
    assert.equal(await b.take("flow", "short"), null, "an expired one-time grant cannot be used either");
    assert.equal(await b.update("flow", "long", 99, {}), null, "a stale version is refused");
    await a.put("flow", "short2", { n: 3 }, { ttlMs: 100 });
    await wait(300);
    assert.ok(await a.sweep() >= 1);
    assert.deepEqual((await a.list("flow")).map((row) => row.value.n), [2]);
  });

  test(`${kind}: a one-time grant is taken once, however many replicas race for it`, { timeout: 60_000 }, async (t) => {
    const { a, b } = await pair(t);
    await a.put("grant", "g1", { write: "docs.update" }, { ttlMs: 60_000 });
    const taken = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).take("grant", "g1")));
    assert.equal(taken.filter(Boolean).length, 1);
    assert.deepEqual(taken.find(Boolean).value, { write: "docs.update" });
  });

  test(`${kind}: an update compares versions, so two replicas cannot both rotate`, { timeout: 60_000 }, async (t) => {
    const { a, b } = await pair(t);
    const { version } = await a.put("renewal", "r1", { refresh: "one" }, { ttlMs: 60_000 });
    const [first, second] = await Promise.all([a.update("renewal", "r1", version, { refresh: "two" }), b.update("renewal", "r1", version, { refresh: "three" })]);
    assert.equal([first, second].filter(Boolean).length, 1, "exactly one rotation wins");
    assert.equal((await a.get("renewal", "r1")).version, version + 1);
  });

  test(`${kind}: asked about a list of keys, it answers with those it still holds`, { timeout: 60_000 }, async (t) => {
    const { a, b } = await pair(t);
    await a.put("session", "k1", { n: 1 }, { ttlMs: 60_000 });
    await a.put("session", "k2", { n: 2 }, { ttlMs: 100 });
    await a.put("grant", "k3", { n: 3 }, { ttlMs: 60_000 });
    await wait(300);
    assert.deepEqual(await b.present("session", ["k1", "k2", "k3", "k4"]), ["k1"], "not the expired, not another namespace's, not the unknown");
    assert.deepEqual(await b.present("session", []), []);
    await assert.rejects(b.present("session", "k1"), /Invalid state keys/);
    await assert.rejects(b.present("session", [""]), /Invalid state keys/);
  });

  test(`${kind}: a list pages through in the order of the key, and counts what is alive`, { timeout: 60_000 }, async (t) => {
    const { a, b } = await pair(t);
    for (const key of ["k3", "k1", "k5", "k2", "k4"]) await a.put("pref", key, { key }, {});
    await a.put("pref", "k0", { gone: true }, { ttlMs: 100 });
    await wait(300);
    const first = await b.list("pref", { limit: 2 });
    assert.deepEqual(first.map((row) => row.key), ["k1", "k2"]);
    assert.deepEqual((await b.list("pref", { limit: 2, after: first.at(-1).key })).map((row) => row.key), ["k3", "k4"]);
    assert.deepEqual((await b.list("pref", { after: "k4" })).map((row) => row.key), ["k5"]);
    assert.equal(await b.count("pref"), 5, "not the expired one");
    assert.equal(await b.count("elsewhere"), 0);
  });

  test(`${kind}: created only if nothing is there, so two replicas creating one key end with one value`, { timeout: 60_000 }, async (t) => {
    const { a, b } = await pair(t);
    const made = await Promise.all(Array.from({ length: 10 }, (_, index) => (index % 2 ? a : b).create("key", "sealing", { key: `value-${index}` })));
    assert.equal(made.filter(Boolean).length, 1, "exactly one of them wrote it");
    const kept = (await a.get("key", "sealing")).value.key;
    assert.equal((await b.get("key", "sealing")).value.key, kept, "and everybody reads that one");
    await a.put("key", "brief", { n: 1 }, { ttlMs: 100 });
    await wait(300);
    assert.deepEqual(await b.create("key", "brief", { n: 2 }), { version: 1 }, "an expired one is as good as none");
  });

  test(`${kind}: a family is removed at once, and lists answer by parent and owner`, { timeout: 60_000 }, async (t) => {
    const { a, b } = await pair(t);
    for (const [key, parent, owner] of [["c1", "root", "t/u1"], ["c2", "root", "t/u1"], ["c3", "other", "t/u2"]]) await a.put("session", key, { key }, { parent, owner, ttlMs: 60_000 });
    assert.deepEqual((await b.list("session", { owner: "t/u1" })).map((row) => row.key).sort(), ["c1", "c2"]);
    assert.deepEqual((await b.deleteChildren("session", "root")).sort(), ["c1", "c2"]);
    assert.deepEqual((await a.list("session")).map((row) => row.key), ["c3"]);
  });
}

test("postgres: a change on one replica reaches the others, and never the one that made it", { timeout: 60_000 }, async (t) => {
  const { a, b } = await postgresPair(t, await testPostgres(t));
  const seenByB = [], seenByA = [];
  b.on("change", (change) => { if (!change.local) seenByB.push(`${change.op} ${change.namespace}/${change.key}`); });
  a.on("change", (change) => { if (!change.local) seenByA.push(`${change.op} ${change.namespace}/${change.key}`); });
  await a.put("session", "s1", { n: 1 }, { parent: "root", ttlMs: 60_000 });
  await a.put("session", "s2", { n: 2 }, { parent: "root", ttlMs: 60_000 });
  await a.take("session", "s1");
  await a.deleteChildren("session", "root");
  for (const until = Date.now() + 3000; seenByB.length < 4 && Date.now() < until;) await wait(20);
  assert.deepEqual(seenByB, ["put session/s1", "put session/s2", "delete session/s1", "delete session/s2"]);
  assert.deepEqual(seenByA, [], "a replica is not told what it did itself");
});

test("postgres: what the database holds is sealed, bound to its slot, and useless without the key", { timeout: 60_000 }, async (t) => {
  const { a, config, open, server } = await postgresPair(t, await testPostgres(t));
  await a.put("renewal", "slot-1", { refreshToken: "u-refresh-token-fixture" }, { ttlMs: 60_000 });
  const client = new pg.Client(config); await client.connect();
  server.closeFirst(() => client.end());
  const { rows } = await client.query("SELECT value FROM idou_state WHERE key = 'slot-1'");
  assert.equal(rows[0].value.includes(Buffer.from("u-refresh-token-fixture")), false, "no plaintext in the database");
  // Moved into another slot, it does not open.
  await client.query("INSERT INTO idou_state (namespace, key, value, version) SELECT namespace, 'slot-2', value, 1 FROM idou_state WHERE key = 'slot-1'");
  await assert.rejects(a.get("renewal", "slot-2"));
  // Another key, and nothing opens.
  const stranger = await open(randomBytes(32));
  await assert.rejects(stranger.get("renewal", "slot-1"));
});

test("postgres: a lock is held by one replica at a time, and freed with its connection", { timeout: 60_000 }, async (t) => {
  const { a, b } = await postgresPair(t, await testPostgres(t));
  const mine = await a.lock("coordinator");
  assert.equal(mine.held, true);
  assert.equal((await b.lock("coordinator")).held, false);
  await mine.release();
  const theirs = await b.lock("coordinator");
  assert.equal(theirs.held, true, "released, another replica takes it");
  assert.equal((await a.lock("coordinator")).held, false);
});

test("postgres: a replica whose notifications were cut off listens again, and is told to check what it holds", { timeout: 60_000 }, async (t) => {
  const server = await testPostgres(t);
  const { a, b, config } = await postgresPair(t, server);
  const heard = [];
  b.on("change", (change) => { if (!change.local) heard.push(change.op === "reset" ? "reset" : `${change.op} ${change.key}`); });
  const admin = new pg.Client(config); await admin.connect();
  server.closeFirst(() => admin.end());
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND query LIKE 'LISTEN%'", [b.testName]);
  for (const until = Date.now() + 10_000; !heard.includes("reset") && Date.now() < until;) await wait(20);
  assert.deepEqual(heard, ["reset"], "told once it listens again, not before");
  await a.put("session", "after", { n: 1 }, { ttlMs: 60_000 });
  for (const until = Date.now() + 3000; heard.length < 2 && Date.now() < until;) await wait(20);
  assert.deepEqual(heard, ["reset", "put after"]);
});

test("postgres: ...and when the database is away for longer than a second, it keeps trying until it is back", { timeout: 90_000 }, async (t) => {
  const server = await testPostgres(t);
  const { a, b } = await postgresPair(t, server);
  const heard = [];
  b.on("change", (change) => { if (!change.local) heard.push(change.op === "reset" ? "reset" : `${change.op} ${change.key}`); });
  await server.restart({ downMs: 2500 });
  for (const until = Date.now() + 30_000; !heard.includes("reset") && Date.now() < until;) await wait(50);
  assert.deepEqual(heard, ["reset"]);
  await a.put("session", "after", { n: 1 }, { ttlMs: 60_000 });
  for (const until = Date.now() + 3000; heard.length < 2 && Date.now() < until;) await wait(20);
  assert.deepEqual(heard, ["reset", "put after"]);
});

test("postgres: replicas starting together on an empty database all start", { timeout: 60_000 }, async (t) => {
  // Measured on the server (9-26): two replicas started by one systemctl
  // command both created the table, and one of them failed on
  // pg_type_typname_nsp_index -- CREATE TABLE IF NOT EXISTS is not safe
  // against itself.
  const server = await testPostgres(t);
  for (let round = 0; round < 3; round += 1) {
    const config = await server.database(), key = randomBytes(32), pools = [];
    server.closeFirst(async () => { for (const pool of pools) await pool.end(); });
    const opened = await Promise.allSettled(Array.from({ length: 8 }, async () => {
      const pool = new pg.Pool({ ...config, max: 2 }); pool.on("error", () => {}); pools.push(pool);
      const store = await PostgresStateStore.open({ pool, key, connect: async () => { const client = new pg.Client(config); await client.connect(); return client; } });
      server.closeFirst(() => store.close());
      return store;
    }));
    assert.deepEqual(opened.filter((result) => result.status === "rejected").map((result) => result.reason.message), [], `round ${round}`);
  }
});

test("sealed bytes open only in their own slot, with the key, and are never a JSON value", async () => {
  const { sealBytes, openBytes, sealValue } = await import("../src/control-plane/state-store.js");
  const key = randomBytes(32), bytes = Buffer.from([0, 1, 2, 250, 255]);
  const sealed = sealBytes(key, "site-file", "s1/v1/a", bytes);
  assert.deepEqual(openBytes(key, "site-file", "s1/v1/a", sealed), bytes);
  assert.throws(() => openBytes(key, "site-file", "s1/v1/b", sealed));
  assert.throws(() => openBytes(randomBytes(32), "site-file", "s1/v1/a", sealed));
  assert.throws(() => openBytes(key, "site-file", "s1/v1/a", sealValue(key, "site-file", "s1/v1/a", { n: 1 })), /Unreadable sealed bytes/);
});
