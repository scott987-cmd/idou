// Sessions the replicas of the control plane share (sessions.js given a state
// store, docs/scaling-plan.md §2.2). Registries on one PostgreSQL stand for
// replicas; small stand-in stores make the races that matter happen on cue.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { PostgresStateStore } from "../src/control-plane/state-store.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { testPostgres } from "./helpers/postgres.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(20)) if (await check()) return true;
  return false;
}
const digest = (token) => createHash("sha256").update(token).digest("hex");
const FORMAT = /^[A-Za-z0-9_-]{43}$/;
// What the model gateway asks: the session alone, wherever it was issued.
const SHARED = { shared: true };
const login = (sessions, who = {}) => sessions.issue({ tenantId: "tenant-a", userId: "user-1", appId: "cli_app", deviceId: "device",
  authProvider: "feishu", deviceProof: "ed25519-login", ...who });

async function replicas(t, count = 2) {
  const server = await testPostgres(t);
  const config = await server.database();
  const key = randomBytes(32), routeKey = randomBytes(32);
  const made = [];
  for (let index = 0; index < count; index += 1) {
    const name = `replica-${index}`;
    const pool = new pg.Pool({ ...config, max: 4, application_name: name });
    pool.on("error", () => {});
    const state = await PostgresStateStore.open({ pool, key, connect: async () => {
      const client = new pg.Client({ ...config, application_name: `${name}-listen` }); await client.connect(); return client;
    } });
    const logs = [];
    const sessions = new SessionRegistry({ state, routeKey, log: (line) => logs.push(line) });
    server.closeFirst(async () => { sessions.close(); await sessions.flush(); await state.close(); await pool.end(); });
    made.push({ name, sessions, state, pool, logs });
  }
  const admin = new pg.Client(config); await admin.connect();
  server.closeFirst(() => admin.end());
  return { server, admin, replicas: made };
}

// A store that does what it is told, when it is told. Operations are recorded
// in the order they reach it.
class StandInStore extends EventEmitter {
  constructor() { super(); this.records = new Map(); this.ops = []; this.gate = null; this.failPuts = 0; this.reads = 0; }
  async put(namespace, key, value) {
    this.ops.push(`put ${key.slice(0, 6)}`);
    await this.gate?.promise;
    if (this.failPuts > 0) { this.failPuts -= 1; throw new Error("connection refused"); }
    this.records.set(key, { value: structuredClone(value) });
    return { version: 1 };
  }
  async get(namespace, key) { this.reads += 1; await this.gate?.promise; return this.records.get(key) ?? null; }
  async take(namespace, key) { this.ops.push(`take ${key.slice(0, 6)}`); const found = this.records.get(key) ?? null; this.records.delete(key); return found; }
  async delete(namespace, key) { return Boolean(await this.take(namespace, key)); }
  async deleteChildren(namespace, parent) {
    this.ops.push("family");
    const gone = [...this.records].filter(([, record]) => record.value.familyId === parent).map(([key]) => key);
    for (const key of gone) this.records.delete(key);
    return gone;
  }
  async present(namespace, keys) { return keys.filter((key) => this.records.has(key)); }
}

test("without a shared store, a token is 43 random characters and there is nothing to read or wait for", async () => {
  const sessions = new SessionRegistry();
  const first = login(sessions), second = login(sessions);
  assert.match(first.token, FORMAT);
  assert.notEqual(first.token.slice(0, 8), second.token.slice(0, 8), "no shared prefix without a route key");
  assert.equal(await sessions.ensure(first.token), undefined);
  assert.equal(await sessions.persisted(first.token), true);
  assert.equal(await sessions.revoke(first.token), true);
  assert.equal(sessions.verify(first.token), null);
});

test("with a route key, every token one person holds begins with the same eight characters, and nobody else's does", () => {
  const routeKey = randomBytes(32), sessions = new SessionRegistry({ routeKey });
  const root = login(sessions);
  const tokens = [root.token, sessions.issueForModelTurn(root.token).token, sessions.issueForSandboxRun(root.token).token,
    sessions.issueForMedia(root.token, "image").token, sessions.issueForDrive(root.token).token, sessions.issueForSkills(root.token).token,
    sessions.issueForWiki(root.token).token, sessions.rotate(root.token, 60_000).token, login(sessions).token];
  for (const token of tokens) assert.match(token, FORMAT, "the shape every client checks for");
  assert.equal(new Set(tokens.map((token) => token.slice(0, 8))).size, 1);
  assert.equal(new Set(tokens.map((token) => token.slice(8))).size, tokens.length, "the rest is random");
  assert.notEqual(login(sessions, { userId: "user-2" }).token.slice(0, 8), root.token.slice(0, 8));
  assert.notEqual(login(sessions, { tenantId: "tenant-b" }).token.slice(0, 8), root.token.slice(0, 8));
  // Keyed: the same person under another deployment's key has another code,
  // so the code names nobody to whoever does not hold the key.
  assert.notEqual(login(new SessionRegistry({ routeKey: randomBytes(32) })).token.slice(0, 8), root.token.slice(0, 8));
  assert.throws(() => new SessionRegistry({ routeKey: randomBytes(16) }), /32 bytes/);
});

test("expiry is taken from the front: each expired session is dropped and announced once, a revoked one never again", () => {
  let now = 1000;
  const sessions = new SessionRegistry({ now: () => now }), told = [];
  sessions.on("revoked", (id) => told.push(id));
  const issue = (ttlMs) => sessions.issue({ tenantId: "t", userId: "u", deviceId: "d", ttlMs });
  const short = issue(100), long = issue(10_000), middle = issue(1000);
  sessions.revoke(middle.token);
  assert.deepEqual(told, [middle.id]);
  now = 1500; sessions.prune();
  assert.deepEqual(told, [middle.id, short.id]);
  assert.equal(sessions.sessions.size, 1);
  now = 2500; sessions.prune();
  assert.deepEqual(told, [middle.id, short.id], "revoked before its time, it is not announced again when the time comes");
  now = 12_000; sessions.prune();
  assert.deepEqual(told, [middle.id, short.id, long.id]);
  assert.equal(sessions.sessions.size, 0);
});

test("a token issued on one replica is taken on another, with the root it hangs from; the database holds no token", { timeout: 60_000 }, async (t) => {
  const { admin, replicas: [a, b] } = await replicas(t);
  const root = login(a.sessions), turn = a.sessions.issueForModelTurn(root.token);
  assert.equal(await a.sessions.persisted(root.token, turn.token), true);
  assert.equal(b.sessions.verify(turn.token, SHARED), null, "nothing is read without ensure()");
  await b.sessions.ensure(turn.token);
  const seen = b.sessions.verify(turn.token, SHARED);
  assert.equal(seen.id, turn.id); assert.equal(seen.tenantId, "tenant-a"); assert.equal(seen.userId, "user-1");
  assert.equal(seen.parentKey, digest(root.token));
  assert.ok(Object.isFrozen(seen) && Object.isFrozen(seen.scopes), "as immutable as one issued here");
  assert.equal(b.sessions.verify(root.token, SHARED)?.id, root.id, "the root came with it");
  const { rows } = await admin.query("SELECT key, value FROM idou_state");
  assert.deepEqual(rows.map((row) => row.key).sort(), [digest(root.token), digest(turn.token)].sort());
  for (const row of rows) for (const token of [root.token, turn.token]) assert.equal(row.value.includes(Buffer.from(token)), false);
});

test("a session read without what goes with it serves the model gateway only; the rest answer as for a session they do not know", { timeout: 60_000 }, async (t) => {
  const { replicas: [a, b] } = await replicas(t);
  // b's Feishu access finds no grant for it (signed in before grants were kept).
  const asked = [];
  b.sessions.addLoader(async (root) => { asked.push(root.id); return false; });
  const root = login(a.sessions), turn = a.sessions.issueForModelTurn(root.token);
  await a.sessions.persisted(root.token, turn.token);
  await b.sessions.ensure(root.token);
  assert.deepEqual(asked, [root.id], "asked about the root it read");
  assert.equal(b.sessions.verify(root.token), null, "renewal, Feishu access and leases keep their state where the session was issued");
  assert.throws(() => b.sessions.issueForMedia(root.token, "image"), /required/, "nor can it mint here");
  assert.equal(b.sessions.verify(root.token, SHARED)?.id, root.id, "and it is still here for the model gateway");
  assert.equal(a.sessions.verify(root.token)?.id, root.id, "where it was issued, it is taken everywhere");
  await b.sessions.ensure(turn.token);
  assert.equal(b.sessions.verify(turn.token), null, "nor is a child of it");
  assert.ok(b.sessions.verify(turn.token, SHARED));
});

test("a loader that cannot read answers as one that found nothing", { timeout: 60_000 }, async (t) => {
  const { replicas: [a, b] } = await replicas(t);
  b.sessions.addLoader(async () => { throw new Error("store unreachable"); });
  const root = login(a.sessions);
  await a.sessions.persisted(root.token);
  await b.sessions.ensure(root.token);
  assert.equal(b.sessions.verify(root.token), null);
  assert.ok(b.logs.some((line) => line.event === "session-state-unreadable"));
});

test("a token the store does not have is refused, and asked about again only after a second", { timeout: 60_000 }, async (t) => {
  const { replicas: [, b] } = await replicas(t);
  let reads = 0;
  const get = b.state.get.bind(b.state);
  b.state.get = async (...args) => { reads += 1; return get(...args); };
  const stranger = randomBytes(32).toString("base64url");
  await b.sessions.ensure(stranger); await b.sessions.ensure(stranger);
  assert.equal(reads, 1);
  assert.equal(b.sessions.verify(stranger), null);
  await wait(1100);
  await b.sessions.ensure(stranger);
  assert.equal(reads, 2);
  const another = randomBytes(32).toString("base64url");
  await Promise.all([b.sessions.ensure(another), b.sessions.ensure(another), b.sessions.ensure(another)]);
  assert.equal(reads, 3, "several requests with one token share one read");
  await b.sessions.ensure("not a token"); await b.sessions.ensure(undefined);
  assert.equal(reads, 3, "a malformed token costs nothing");
});

test("a revoked login is dropped on every replica, and what held state for it there is told", { timeout: 60_000 }, async (t) => {
  const { replicas: [a, b, c] } = await replicas(t, 3);
  const root = login(a.sessions), turn = a.sessions.issueForModelTurn(root.token), media = a.sessions.issueForMedia(root.token, "image");
  await a.sessions.persisted(root.token, turn.token, media.token);
  for (const token of [turn.token, media.token]) await b.sessions.ensure(token);
  const told = [];
  b.sessions.on("revoked", (id) => told.push(id));
  assert.equal(await a.sessions.revoke(root.token), true);
  assert.ok(await until(() => told.length === 3), `heard ${told.length} of 3`);
  assert.deepEqual(told.sort(), [root.id, turn.id, media.id].sort());
  for (const token of [root.token, turn.token, media.token]) assert.equal(b.sessions.verify(token, SHARED), null);
  await c.sessions.ensure(turn.token);
  assert.equal(c.sessions.verify(turn.token, SHARED), null, "and a replica that never held it does not find it");
});

test("a lease replaced on one replica stops working on the others", { timeout: 60_000 }, async (t) => {
  const { replicas: [a, b] } = await replicas(t);
  const root = login(a.sessions), first = a.sessions.issueForMedia(root.token, "image");
  await a.sessions.persisted(first.token);
  await b.sessions.ensure(first.token);
  assert.ok(b.sessions.verify(first.token, SHARED));
  const second = a.sessions.issueForMedia(root.token, "image");
  await a.sessions.persisted(second.token);
  assert.ok(await until(() => b.sessions.verify(first.token, SHARED) === null));
  await b.sessions.ensure(second.token);
  assert.ok(b.sessions.verify(second.token, SHARED));
});

test("a login is revoked from a replica that never held it, every rotation of it included", { timeout: 60_000 }, async (t) => {
  const { replicas: [a, b] } = await replicas(t);
  const root = login(b.sessions), turn = b.sessions.issueForModelTurn(root.token), rotated = b.sessions.rotate(root.token, 60_000);
  await b.sessions.persisted(root.token, turn.token, rotated.token);
  assert.equal(await a.sessions.revoke(root.token), true);
  assert.ok(await until(() => [root, turn, rotated].every(({ token }) => b.sessions.verify(token, SHARED) === null)));
  for (const { token } of [turn, rotated]) {
    await a.sessions.ensure(token);
    assert.equal(a.sessions.verify(token, SHARED), null, "nor can it be read back anywhere");
  }
});

test("a replica cut off from notifications drops what was revoked meanwhile, once it hears again", { timeout: 60_000 }, async (t) => {
  const { admin, replicas: [a, b] } = await replicas(t);
  const root = login(a.sessions), turn = a.sessions.issueForModelTurn(root.token), kept = login(a.sessions, { userId: "user-2" });
  await a.sessions.persisted(root.token, turn.token, kept.token);
  for (const token of [turn.token, kept.token]) await b.sessions.ensure(token);
  await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [`${b.name}-listen`]);
  assert.ok(await until(() => b.state.listener === null), "the cut was noticed");
  await a.sessions.revoke(root.token);
  assert.ok(b.sessions.verify(turn.token, SHARED), "not heard while cut off");
  assert.ok(await until(() => b.sessions.verify(turn.token, SHARED) === null, 10_000), "checked once it listens again");
  assert.ok(b.sessions.verify(kept.token, SHARED), "what the store still has stays");
});

test("a revocation that arrives while a session is being read keeps it out; a reset meanwhile reads it again", async () => {
  const store = new StandInStore(), issuer = new SessionRegistry();
  const root = issuer.issue({ tenantId: "t", userId: "u", deviceId: "d" }), other = issuer.issue({ tenantId: "t", userId: "u2", deviceId: "d" });
  for (const token of [root.token, other.token]) store.records.set(digest(token), { value: { ...issuer.sessions.get(digest(token)) } });
  const sessions = new SessionRegistry({ state: store });
  store.gate = Promise.withResolvers();
  const reading = sessions.ensure(root.token);
  store.emit("change", { namespace: "session", key: digest(root.token), op: "delete", local: false });
  store.gate.resolve(); await reading;
  assert.equal(sessions.verify(root.token, SHARED), null, "revoked while it was read: not taken");
  store.gate = Promise.withResolvers();
  const before = store.reads, again = sessions.ensure(other.token);
  store.emit("change", { op: "reset", local: false });
  store.gate.resolve(); await again;
  assert.ok(sessions.verify(other.token, SHARED), "read again after the reset, and taken");
  assert.equal(store.reads - before, 2);
  sessions.close();
});

test("an issue's write is tried again until the store takes it, and never after its revocation", { timeout: 30_000 }, async () => {
  const store = new StandInStore(), logs = [];
  const sessions = new SessionRegistry({ state: store, log: (line) => logs.push(line) });
  store.failPuts = 1;
  const kept = sessions.issue({ tenantId: "t", userId: "u", deviceId: "d" });
  assert.equal(await sessions.persisted(kept.token), false, "the first write failed, and the caller hears it");
  assert.ok(sessions.verify(kept.token), "the token still works here");
  assert.ok(await until(() => store.records.has(digest(kept.token)), 3000), "and is written once the store takes it");
  // Revoked while its write is on the way: the revocation reaches the store
  // after the write, never before it, so the write cannot bring it back.
  store.ops.length = 0; store.gate = Promise.withResolvers();
  const slow = sessions.issue({ tenantId: "t", userId: "u", deviceId: "d" }), short = digest(slow.token).slice(0, 6);
  assert.ok(await until(() => store.ops.length === 1), "the write is under way");
  const revoking = sessions.revoke(slow.token);
  await wait(50);
  assert.deepEqual(store.ops, [`put ${short}`], "the revocation waits for it");
  store.gate.resolve(); store.gate = null;
  assert.equal(await revoking, true);
  assert.deepEqual(store.ops, [`put ${short}`, `take ${short}`, "family"]);
  assert.equal(store.records.has(digest(slow.token)), false);
  // Revoked before its write even started: nothing is written at all.
  store.ops.length = 0;
  const brief = sessions.issue({ tenantId: "t", userId: "u", deviceId: "d" });
  await sessions.revoke(brief.token);
  assert.deepEqual(store.ops, [`take ${digest(brief.token).slice(0, 6)}`, "family"]);
  assert.equal(store.records.has(digest(brief.token)), false);
  // A write that keeps failing stops being tried once the session is revoked.
  store.ops.length = 0; store.failPuts = Infinity;
  const doomed = sessions.issue({ tenantId: "t", userId: "u", deviceId: "d" });
  assert.equal(await sessions.persisted(doomed.token), false);
  await sessions.revoke(doomed.token);
  await wait(1300);
  assert.deepEqual(store.ops.filter((op) => op.startsWith("put")), [`put ${digest(doomed.token).slice(0, 6)}`], "not written again after the revocation");
  sessions.close(); await sessions.flush();
});

test("the model gateway on one replica serves a token issued on another, and stops when it is revoked there", { timeout: 60_000 }, async (t) => {
  const { replicas: [a, b] } = await replicas(t);
  let calls = 0;
  const gateway = createModelGateway({ apiKey: "provider-secret-fixture", sessions: b.sessions,
    fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ output_text: "fixture reply" }), { headers: { "content-type": "application/json" } }); } });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  t.after(() => { gateway.close(); gateway.closeAllConnections(); });
  const url = `http://127.0.0.1:${gateway.address().port}/v1/responses`;
  const root = login(a.sessions), turn = a.sessions.issueForModelTurn(root.token);
  await a.sessions.persisted(root.token, turn.token);
  const ask = () => fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${turn.token}` },
    body: JSON.stringify({ model: "MiniMax-M3", input: "fixture question" }) });
  const answered = await ask();
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).output_text, "fixture reply");
  await a.sessions.revoke(root.token);
  assert.ok(await until(() => b.sessions.verify(turn.token, SHARED) === null));
  assert.equal((await ask()).status, 401);
  assert.equal(calls, 1);
});
