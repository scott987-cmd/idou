// The durable stores a coordinator keeps, in the shared PostgreSQL
// (docs/scaling-plan.md §2.5): model choices, the skill shelf, published sites
// and unattended credentials. What one coordinator writes, another -- on this
// machine or another, starting after it -- reads; nothing leaves the database
// in the clear; and each moves to and from its file-backed twin unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { PostgresStateStore } from "../src/control-plane/state-store.js";
import { ModelPreferences, PostgresModelPreferences } from "../src/control-plane/model-choice.js";
import { PostgresSkillRegistry, SkillRegistry } from "../src/control-plane/skill-registry.js";
import { PostgresSiteStorage, SiteRegistry } from "../src/control-plane/site-registry.js";
import { PostgresUnattendedCredentialStore, UnattendedCredentialStore } from "../src/control-plane/unattended-credential.js";
import { siteCookieKey } from "../src/control-plane/site-server.js";
import { appHash } from "../src/apps/manifest.js";
import { testPostgres } from "./helpers/postgres.js";

async function database(t) {
  const server = await testPostgres(t), config = await server.database(), key = randomBytes(32);
  const pools = [];
  // One coordinator's connection to the shared database.
  const connect = async () => {
    const pool = new pg.Pool({ ...config, max: 4 }); pool.on("error", () => {}); pools.push(pool);
    const state = await PostgresStateStore.open({ pool, key, connect: async () => { const client = new pg.Client(config); await client.connect(); return client; } });
    server.closeFirst(() => state.close());
    return { pool, state, key };
  };
  server.closeFirst(async () => { for (const pool of pools) await pool.end(); });
  const admin = new pg.Client(config); await admin.connect(); server.closeFirst(() => admin.end());
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-durable-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { connect, admin, home };
}
// Every byte the database holds for these stores, whichever of them exist.
const everything = async (admin) => {
  const tables = (await admin.query("SELECT to_regclass('idou_site_files') IS NOT NULL AS sites")).rows[0].sites
    ? "SELECT value AS bytes FROM idou_state UNION ALL SELECT bytes FROM idou_site_files UNION ALL SELECT bytes FROM idou_site_data"
    : "SELECT value AS bytes FROM idou_state";
  return Buffer.concat((await admin.query(tables)).rows.map((row) => row.bytes));
};

test("model choices: one coordinator's are the next one's, one row a person, and they move from the file and back", { timeout: 60_000 }, async (t) => {
  const f = await database(t);
  const a = await PostgresModelPreferences.open({ state: (await f.connect()).state });
  await a.set({ tenantId: "t1", userId: "ou_a" }, "MiniMax-M3", 100);
  await a.set({ tenantId: "t1", userId: "ou_b" }, "GLM-5.3", 200);
  await a.set({ tenantId: "t1", userId: "ou_b" }, null);
  const b = await PostgresModelPreferences.open({ state: (await f.connect()).state });
  assert.equal(b.get({ tenantId: "t1", userId: "ou_a" }), "MiniMax-M3");
  assert.equal(b.get({ tenantId: "t1", userId: "ou_b" }), null);
  assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM idou_state WHERE namespace = 'model-preference'")).rows[0].n, 1);
  const file = await ModelPreferences.open({ file: path.join(f.home, "model-preferences.json") });
  await file.set({ tenantId: "t2", userId: "ou_c" }, "GLM-5.3", 300);
  await b.load(file.entries());
  const c = await PostgresModelPreferences.open({ state: (await f.connect()).state });
  assert.equal(c.get({ tenantId: "t2", userId: "ou_c" }), "GLM-5.3", "moved in from the file");
  const back = await ModelPreferences.open({ file: path.join(f.home, "back.json") });
  await back.load(c.entries());
  assert.deepEqual((await ModelPreferences.open({ file: path.join(f.home, "back.json") })).entries(), c.entries(), "and out again");
});

const bundle = (over = {}) => ({
  id: "enterprise-weekly", version: "1.0.0", title: "周报助手", description: "把一周记录整理成周报", publisher: "平台组",
  requiredTools: [], runtimeVersions: { codex: ["0.147.0"], feishu: [] },
  files: [{ path: "SKILL.md", text: "---\nname: enterprise-weekly\ndescription: 周报\n---\n先读最近一周的记录。" }], ...over });
const ADMIN = { userId: "ou_admin", tenantId: "tenant_a" };

test("the skill shelf: published on one coordinator, served by the next, and never overwritten from a stale copy", { timeout: 60_000 }, async (t) => {
  const f = await database(t);
  const a = await new PostgresSkillRegistry({ state: (await f.connect()).state, administrators: ["ou_admin"] }).load();
  await a.publish(ADMIN, bundle());
  const b = await new PostgresSkillRegistry({ state: (await f.connect()).state, administrators: ["ou_admin"] }).load();
  assert.deepEqual(b.list("tenant_a").map((skill) => skill.id), ["enterprise-weekly"]);
  assert.equal(b.snapshot().revision, a.snapshot().revision);
  await a.publish(ADMIN, bundle({ id: "enterprise-other" }));
  await assert.rejects(b.publish(ADMIN, bundle({ id: "enterprise-third" })), (error) => error.status === 409 && /changed_elsewhere/.test(error.message));
  const c = await new PostgresSkillRegistry({ state: (await f.connect()).state, administrators: ["ou_admin"] }).load();
  assert.deepEqual(c.list("tenant_a").map((skill) => skill.id).sort(), ["enterprise-other", "enterprise-weekly"], "the stale copy wrote nothing");
});

const file = (name, body) => ({ path: name, bytes: Buffer.byteLength(body), sha256: appHash(Buffer.from(body)), body });
const pack = (files) => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: files.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 })) },
  blobs: files.map(({ path: name, body }) => ({ path: name, base64: Buffer.from(body).toString("base64") })),
});
const owner = { ownerId: "ou_owner", tenantId: "t1", name: "客户看板" };

test("published sites: served by the next coordinator from the database, sealed there, old versions swept, and moved from disk and back", { timeout: 90_000 }, async (t) => {
  const f = await database(t);
  const open = async () => { const { pool, state, key } = await f.connect(); return SiteRegistry.open(null, { storage: await PostgresSiteStorage.open({ pool, state, key }) }); };
  const a = await open();
  const published = await a.publish({ ...owner, ...pack([file("index.html", "<h1>SITE-BODY-MARKER</h1>")]), share: { scope: "invited" } });
  for (let round = 1; round <= 4; round += 1) await a.publish({ ...owner, siteId: published.id, ...pack([file("index.html", `<h1>round ${round}</h1>`)]), share: { scope: "invited" } });
  await a.putData(published.id, { snapshot: { digest: "d1", rows: ["DATA-MARKER"] } });
  await a.setShare(published.id, { scope: "tenant" }, { ownerId: "ou_owner" });
  const b = await open();
  assert.equal((await b.file(published.id, "/")).bytes.toString(), "<h1>round 4</h1>");
  assert.deepEqual((await b.data(published.id)).snapshot.rows, ["DATA-MARKER"]);
  assert.equal(b.get(published.id).share.scope, "tenant");
  const versions = (await f.admin.query("SELECT count(DISTINCT version)::int AS n FROM idou_site_files WHERE site = $1", [published.id])).rows[0].n;
  assert.equal(versions, 3, "the three kept, the rest swept");
  const stored = await everything(f.admin);
  for (const marker of ["SITE-BODY-MARKER", "DATA-MARKER", "ou_owner"]) assert.equal(stored.includes(Buffer.from(marker)), false, `${marker} is sealed`);
  // From a disk to the database, and back to another disk.
  const disk = await SiteRegistry.open(path.join(f.home, "sites"));
  const onDisk = await disk.publish({ ...owner, ...pack([file("index.html", "<h1>from disk</h1>")]), share: { scope: "invited" } });
  await disk.putData(onDisk.id, { snapshot: { digest: "d2" } });
  await b.restore(await disk.dump());
  const c = await open();
  assert.equal((await c.file(onDisk.id, "/")).bytes.toString(), "<h1>from disk</h1>");
  assert.equal((await c.data(onDisk.id)).snapshot.digest, "d2");
  const elsewhere = await SiteRegistry.open(path.join(f.home, "back"));
  await elsewhere.restore(await c.dump());
  assert.equal((await (await SiteRegistry.open(path.join(f.home, "back"))).file(published.id, "/")).bytes.toString(), "<h1>round 4</h1>");
  await c.erase(published.id, { ownerId: "ou_owner" });
  assert.equal((await f.admin.query("SELECT count(*)::int AS n FROM idou_site_files WHERE site = $1", [published.id])).rows[0].n, 0, "erased with its files");
});

test("unattended credentials: one pair of keys for every coordinator, records patched without losing a write, and moved from disk with their keys", { timeout: 60_000 }, async (t) => {
  const f = await database(t);
  const [a, b] = await Promise.all([PostgresUnattendedCredentialStore.open({ state: (await f.connect()).state }), PostgresUnattendedCredentialStore.open({ state: (await f.connect()).state })]);
  assert.equal(a.deviceId, b.deviceId, "two coordinators starting at once, one key");
  const record = { sealed: a.seal({ appId: "cli_x", tenantId: "t1", userId: "ou_a", refreshToken: "REFRESH-MARKER", notAfter: Date.now() + 86_400_000 }), state: "active", failures: 0 };
  await a.write("t1", "ou_a", record);
  assert.equal(b.unseal(await b.read("t1", "ou_a")).refreshToken, "REFRESH-MARKER");
  await Promise.all([a.patch("t1", "ou_a", { failures: 1 }), b.patch("t1", "ou_a", { lastUsedAt: 5 })]);
  const patched = await a.read("t1", "ou_a");
  assert.equal(patched.failures, 1); assert.equal(patched.lastUsedAt, 5, "neither write lost");
  assert.equal(await a.count(), 1);
  assert.equal((await everything(f.admin)).includes(Buffer.from("REFRESH-MARKER")), false);
  assert.equal(await b.remove("t1", "ou_a"), true); assert.equal(await a.read("t1", "ou_a"), null);
  // From a coordinator's directory, keys and all: what it sealed opens here.
  const { mkdir, realpath } = await import("node:fs/promises");
  const directory = path.join(await realpath(f.home), "unattended"); await mkdir(directory, { mode: 0o700 });
  const disk = await UnattendedCredentialStore.open({ directory });
  await disk.write("t2", "ou_b", { sealed: disk.seal({ appId: "cli_x", tenantId: "t2", userId: "ou_b", refreshToken: "DISK-REFRESH", notAfter: Date.now() + 86_400_000 }), state: "active" });
  await a.restore(await disk.dump());
  const reopened = await PostgresUnattendedCredentialStore.open({ state: (await f.connect()).state });
  assert.equal(reopened.deviceId, disk.deviceId, "the disk's device key");
  assert.equal(reopened.unseal(await reopened.read("t2", "ou_b")).refreshToken, "DISK-REFRESH");
});

test("the site sign-in key: one for every coordinator, starting at once or later, and the one already on disk is the one kept", { timeout: 60_000 }, async (t) => {
  const f = await database(t);
  const { mkdir, writeFile } = await import("node:fs/promises");
  // Two starting at once with nothing anywhere: one key between them.
  const [a, b] = await Promise.all([siteCookieKey(path.join(f.home, "a"), { state: (await f.connect()).state }), siteCookieKey(path.join(f.home, "b"), { state: (await f.connect()).state })]);
  assert.equal(a.length, 32); assert.deepEqual(a, b);
  assert.equal((await everything(f.admin)).includes(Buffer.from(a.toString("base64url"))), false, "sealed in the database");
  // A coordinator that already had a key on disk, moving to a database that has none yet, keeps it.
  const fresh = await database(t);
  const onDisk = randomBytes(32), root = path.join(fresh.home, "sites");
  await mkdir(root, { recursive: true }); await writeFile(path.join(root, "cookie.key"), onDisk.toString("base64url"));
  assert.deepEqual(await siteCookieKey(root, { state: (await fresh.connect()).state }), onDisk, "visitors stay signed in across the move");
  assert.deepEqual(await siteCookieKey(path.join(fresh.home, "elsewhere"), { state: (await fresh.connect()).state }), onDisk, "and the next coordinator, on another machine, signs with it too");
});
