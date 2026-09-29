import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, realpath, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { WikiCoordinator, WikiCoordinatorService } from "../src/control-plane/wiki-coordinator.js";
import { DriveBudget, drivePolicies } from "../src/control-plane/drive-budget.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { WikiCoordinatorClient } from "../src/knowledge/coordinator-client.js";
import { wikiHash } from "../src/knowledge/manifest.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const policy = { authProvider: "feishu", tenantId: "tenant", appId: "cli_test", providerId: "saas-cli", driveTenantKey: "cli-tenant", folderToken: "TestFolder123", maxBytes: 1000 };
const grant = { authProvider: "feishu", tenantId: "tenant", appId: "cli_test", members: ["alice", "bob"] };
const baseIdentity = { authProvider: "feishu", tenantId: "tenant", appId: "cli_test", userId: "alice", deviceId: "device1", deviceProof: "ed25519-login" };
const shardKey = wikiHash("synthetic-source-identity");
const claim = (expectedGeneration = 0) => ({ shardKey, expectedGeneration, requestId: randomUUID() });
const key = lease => ({ shardKey: lease.shardKey, leaseId: lease.id, fence: lease.fence });
const publication = (lease, manifest) => ({ ...key(lease), expectedGeneration: lease.expectedGeneration, manifest });
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-wiki-coord-")));
  const budgetFile = path.join(directory, "budget.sqlite"), filename = path.join(directory, "wiki.sqlite");
  const budget = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: budgetFile, policies: [policy] }), state = { now: Date.now() }, connections = [];
  const who = { ...baseIdentity, expiresAt: state.now + 900000 };
  const make = () => { const item = new WikiCoordinator({ databaseFile: filename, tenants: [grant], budget, now: () => state.now }); connections.push(item); return item; };
  const coordinator = make();
  t.after(async () => { for (const item of connections) { try { item.close(); } catch {} } budget.close(); await rm(directory, { recursive: true, force: true }); });
  const bundle = (owner = who) => {
    const input = { id: randomUUID(), policyDigest: budget.snapshot(owner).policyDigest, providerId: policy.providerId, driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken, bytes: 100, sha256: wikiHash(randomUUID()) };
    budget.reserve(owner, input); budget.change(owner, { id: input.id, policyDigest: input.policyDigest }, true); budget.change(owner, { id: input.id, fileToken: "TestFile123" }, false);
    return { format: "wiki-aes256gcm-v1", providerId: input.providerId, driveTenantKey: input.driveTenantKey, folderToken: input.folderToken, fileToken: "TestFile123", reservationId: input.id, ciphertextSha256: input.sha256, bytes: input.bytes, keyId: wikiHash("key-reference-only"), sourceSetHash: wikiHash("source-set"), sourceCount: 1 };
  };
  return { directory, budgetFile, filename, budget, coordinator, make, who, state, bundle };
}

test("two independent clients contend, renew and publish only their fenced generation", async t => {
  const f = await fixture(t), second = f.make(), bob = { ...f.who, userId: "bob", deviceId: "device2" }, request = claim();
  const a = f.coordinator.acquire(f.who, request); assert.equal(a.fence, 1);
  assert.deepEqual(second.acquire(f.who, request), a, "lost claim response reuses the same lease");
  assert.throws(() => second.acquire(bob, claim()), /busy/);
  assert.throws(() => second.renew(bob, key(a)), /mismatch/);
  f.state.now += 30000; const renewed = f.coordinator.renew(f.who, key(a)); assert.ok(renewed.expiresAt > a.expiresAt);
  const manifest = f.bundle(), result = f.coordinator.publish(f.who, publication(a, manifest));
  assert.equal(result.generation, 1); assert.equal(result.clientReported, true);
  assert.deepEqual(second.head(bob, { shardKey }).publication, result);
  assert.deepEqual(f.make().publish(f.who, publication(a, manifest)), result);
  assert.equal(f.budget.snapshot(f.who).chargedBytes, 100);
});

test("expired writer cannot publish after takeover; source tombstone cannot be undone by late completion", async t => {
  const f = await fixture(t), aRequest = claim(), a = f.coordinator.acquire(f.who, aRequest), bob = { ...f.who, userId: "bob", deviceId: "device2" };
  f.state.now += 120001;
  assert.equal(f.coordinator.acquire(f.who, aRequest).state, "expired");
  const b = f.make().acquire(bob, claim()); assert.equal(b.fence, 2);
  assert.throws(() => f.coordinator.publish(f.who, publication(a, f.bundle())), /expired_or_superseded/);
  const live = f.coordinator.publish(bob, publication(b, f.bundle(bob)));
  const c = f.coordinator.acquire(f.who, claim(1)), tombstone = f.coordinator.publish(f.who, publication(c, null));
  assert.equal(tombstone.state, "tombstone"); assert.equal(tombstone.generation, 2);
  assert.deepEqual(f.coordinator.publish(bob, publication(b, live.manifest)), live, "replaying old receipt reads immutable old generation");
  assert.deepEqual(f.coordinator.head(bob, { shardKey }).publication, tombstone, "old receipt must not move current head backwards");
});

test("publication requires exact reported accounting owner, ciphertext size/hash and destination", async t => {
  for (const mutation of ["owner", "hash", "bytes", "file", "folder", "unreported"]) {
    const f = await fixture(t), lease = f.coordinator.acquire(f.who, claim());
    const manifest = f.bundle(mutation === "owner" ? { ...f.who, userId: "bob" } : f.who);
    if (mutation === "hash") manifest.ciphertextSha256 = wikiHash("wrong");
    if (mutation === "bytes") manifest.bytes++;
    if (mutation === "file") manifest.fileToken = "WrongFile123";
    if (mutation === "folder") manifest.folderToken = "WrongFolder123";
    if (mutation === "unreported") manifest.reservationId = randomUUID();
    assert.throws(() => f.coordinator.publish(f.who, publication(lease, manifest)), /drive_/);
    assert.equal(f.coordinator.head(f.who, { shardKey }).publication, null);
  }
});

test("identity, tenant, request and policy boundaries survive independent connections", async t => {
  const f = await fixture(t), input = claim(), lease = f.coordinator.acquire(f.who, input);
  for (const who of [{ ...f.who, tenantId: "other" }, { ...f.who, userId: "outsider" }, { ...f.who, appId: "cli_other" }]) assert.throws(() => f.coordinator.head(who, { shardKey }), /membership/);
  assert.throws(() => f.coordinator.acquire({ ...f.who, deviceId: "other" }, input), /conflict/);
  assert.throws(() => f.coordinator.acquire(f.who, { ...input, shardKey: wikiHash("other") }), /conflict/);
  f.budget.policies = drivePolicies([{ ...policy, maxBytes: 500 }], SAAS_FEISHU);
  assert.throws(() => f.coordinator.acquire(f.who, input), /policy_changed/);
  assert.throws(() => f.coordinator.renew(f.who, key(lease)), /policy_changed/);
  assert.throws(() => f.coordinator.publish(f.who, publication(lease, null)), /policy_changed/);
  assert.throws(() => f.coordinator.acquire(f.who, claim(1)), /generation_changed/);
});

test("strict metadata excludes document bodies, keys, prompts and malformed manifests", async t => {
  const f = await fixture(t), lease = f.coordinator.acquire(f.who, claim()), manifest = f.bundle();
  for (const keyName of ["text", "title", "prompt", "embeddings", "encryptionKey", "bytesBase64"]) {
    assert.throws(() => f.coordinator.publish(f.who, publication(lease, { ...manifest, [keyName]: "SECRET_BODY" })), /invalid/);
    assert.throws(() => f.coordinator.acquire(f.who, { ...claim(), [keyName]: "SECRET_BODY" }), /invalid/);
  }
  for (const bad of [{ ...manifest, bytes: 10485761 }, { ...manifest, keyId: "raw-key" }, { ...manifest, format: "plaintext" }, { ...manifest, sourceCount: 0 }, []]) assert.throws(() => f.coordinator.publish(f.who, publication(lease, bad)), /invalid/);
  assert.equal(f.coordinator.head(f.who, { shardKey }).publication, null);
  assert.equal((await readFile(f.filename)).includes(Buffer.from("SECRET_BODY")), false);
});

test("a committed manifest is immutable and parent-bounded lease cannot be renewed after expiry", async t => {
  const f = await fixture(t), short = { ...f.who, expiresAt: f.state.now + 1000 }, lease = f.coordinator.acquire(short, claim());
  assert.equal(lease.expiresAt, short.expiresAt);
  const manifest = f.bundle(); f.coordinator.publish(short, publication(lease, manifest));
  assert.throws(() => f.coordinator.publish(short, publication(lease, null)), /immutable/);
  assert.throws(() => f.coordinator.renew(short, key(lease)), /superseded/);
  f.state.now += 1001; assert.throws(() => f.coordinator.renew(short, key(lease)), /expired/);
});

test("actual competing coordinator processes issue one lease and retain it after winner exit", async t => {
  const f = await fixture(t), coordinatorUrl = new URL("../src/control-plane/wiki-coordinator.js", import.meta.url).href, budgetUrl = new URL("../src/control-plane/drive-budget.js", import.meta.url).href, saasUrl = new URL("../src/providers/feishu/saas-definition.js", import.meta.url).href;
  const code = `import {WikiCoordinator} from ${JSON.stringify(coordinatorUrl)}; import {DriveBudget} from ${JSON.stringify(budgetUrl)}; import {SAAS_FEISHU} from ${JSON.stringify(saasUrl)}; const p=JSON.parse(process.argv[1]); const budget=new DriveBudget({databaseFile:p.budgetFile,policies:p.policies,feishu:SAAS_FEISHU}); const c=new WikiCoordinator({databaseFile:p.filename,tenants:p.tenants,budget}); try { console.log(JSON.stringify(c.acquire(p.who,p.input))); } catch(e) { console.log(e.message); } finally { c.close(); budget.close(); }`;
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({ filename: f.filename, budgetFile: f.budgetFile, policies: [policy], tenants: [grant], who: { ...f.who, deviceId: `device${index}` }, input: claim() })])));
  assert.equal(results.filter(row => row.stdout.includes('"state":"active"')).length, 1);
  assert.equal(results.filter(row => row.stdout.trim() === "wiki_shard_busy").length, 5);
  assert.throws(() => f.make().acquire(f.who, claim()), /busy/);
});

test("private config and corrupted databases fail without reset", async t => {
  const f = await fixture(t), config = path.join(f.directory, "config.json"), db = path.join(f.directory, "private", "coordinator.sqlite");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, databaseFile: db, tenants: [grant] }));
  const c = await WikiCoordinator.fromConfig(config, f.budget); const lease = c.acquire(f.who, claim()); c.publish(f.who, publication(lease, null)); c.close();
  const restored = await WikiCoordinator.fromConfig(config, f.budget); assert.equal(restored.head(f.who, { shardKey }).publication.state, "tombstone"); restored.close();
  const bad = path.join(f.directory, "bad.sqlite"); await writeFile(bad, "corrupt-do-not-replace");
  assert.throws(() => new WikiCoordinator({ databaseFile: bad, tenants: [grant], budget: f.budget }));
  assert.equal(await readFile(bad, "utf8"), "corrupt-do-not-replace");
  await mkdir(path.join(f.directory, "public"), { mode: 0o755 });
  await writeFile(config, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(f.directory, "public", "db"), tenants: [grant] }));
  if (process.platform !== "win32") await assert.rejects(WikiCoordinator.fromConfig(config, f.budget), /private/);
});

async function httpFixture(t) {
  const f = await fixture(t), sessions = new SessionRegistry(), parent = sessions.issue(baseIdentity);
  const service = new WikiCoordinatorService({ sessions, coordinator: f.coordinator });
  const server = createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });
  const post = (route, token, body, headers = {}) => fetch(`${origin}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { ...f, sessions, parent, origin, post, server };
}

test("HTTP enforces Wiki-specific scope, membership, bounded metadata and parent revocation", async t => {
  const f = await httpFixture(t), lease = await (await f.post("/auth/wiki-token", f.parent.token, {})).json();
  assert.equal(lease.audience, "wiki-coordinator");
  assert.equal((await f.post("/v1/wiki/status", f.parent.token, {})).status, 403);
  assert.equal((await f.post("/v1/wiki/status", f.sessions.issueForDrive(f.parent.token).token, {})).status, 403);
  assert.equal((await f.post("/v1/wiki/status", lease.token, {}, { origin: "https://example.com" })).status, 403);
  assert.equal((await f.post("/v1/wiki/status", lease.token, { text: "private" })).status, 400);
  assert.equal((await f.post("/v1/wiki/status", lease.token, { text: "x".repeat(5000) })).status, 413);
  const outsider = f.sessions.issue({ ...baseIdentity, userId: "outsider" });
  assert.equal((await f.post("/auth/wiki-token", outsider.token, {})).status, 403);
  assert.equal((await f.post("/v1/wiki/status", lease.token, {})).status, 200);
  f.sessions.revoke(f.parent.token); assert.equal((await f.post("/v1/wiki/status", lease.token, {})).status, 401);
});

test("native clients use real HTTP, recover lost publish response without advancing head and isolate server changes", async t => {
  const f = await httpFixture(t); let drop = false, sends = 0, session = { ...f.parent, serverUrl: f.origin };
  const client = new WikiCoordinatorClient({ getSession: async () => session, fetchImpl: async (url, options) => {
    const response = await fetch(url, options); if (url.endsWith("/publish")) { sends++; if (drop) { await response.body.cancel(); throw new Error("lost"); } } return response;
  } });
  const status = await client.status(); assert.equal(status.nodeId, f.coordinator.status(f.who, {}).nodeId);
  const input = claim(), lease = await client.acquire(input); assert.equal(lease.state, "active");
  drop = true; await assert.rejects(client.publish(publication(lease, f.bundle())), /未自动重试/); assert.equal(sends, 1);
  const head = await client.head(shardKey); assert.equal(head.publication.generation, 1);
  drop = false; assert.deepEqual(await client.publish(publication(lease, head.publication.manifest)), head.publication);
  assert.equal((await client.head(shardKey)).publication.generation, 1);
  const other = f.sessions.issue({ ...baseIdentity, userId: "bob", deviceId: "another" }); session = { ...other, serverUrl: f.origin };
  assert.notEqual((await client.status()).nodeId, status.nodeId);
  await assert.rejects(client.renew(key(lease)), /HTTP 409/);
});

test("publication survives abrupt process termination without reissuing an old generation", async t => {
  const f = await fixture(t), coordinatorUrl = new URL("../src/control-plane/wiki-coordinator.js", import.meta.url).href, budgetUrl = new URL("../src/control-plane/drive-budget.js", import.meta.url).href, saasUrl = new URL("../src/providers/feishu/saas-definition.js", import.meta.url).href;
  const code = `import {WikiCoordinator} from ${JSON.stringify(coordinatorUrl)}; import {DriveBudget} from ${JSON.stringify(budgetUrl)}; import {SAAS_FEISHU} from ${JSON.stringify(saasUrl)}; const p=JSON.parse(process.argv[1]); const budget=new DriveBudget({databaseFile:p.budgetFile,policies:p.policies,feishu:SAAS_FEISHU}); const c=new WikiCoordinator({databaseFile:p.filename,tenants:p.tenants,budget}); const lease=c.acquire(p.who,p.input); c.publish(p.who,{shardKey:lease.shardKey,leaseId:lease.id,fence:lease.fence,expectedGeneration:0,manifest:null}); console.log('committed'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({ filename: f.filename, budgetFile: f.budgetFile, policies: [policy], tenants: [grant], who: f.who, input: claim() })], { stdio: ["ignore", "pipe", "ignore"] });
  const closed = once(child, "close"); t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await once(child.stdout, "data"); child.kill("SIGKILL"); await closed;
  const restored = f.make(); assert.equal(restored.head(f.who, { shardKey }).publication.state, "tombstone");
  assert.throws(() => restored.acquire(f.who, claim()), /generation_changed/);
  assert.equal(restored.acquire(f.who, claim(1)).fence, 2);
});

test("revoking a parent during HTTP body reception prevents a lease mutation", async t => {
  const f = await httpFixture(t), token = f.sessions.issueForWiki(f.parent.token).token;
  const seen = once(f.server, "request"); let finish;
  const complete = new Promise(resolve => { finish = resolve; });
  const req = httpRequest(`${f.origin}/v1/wiki/acquire`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }, response => { response.resume(); response.on("end", () => finish(response.statusCode)); });
  req.flushHeaders(); await seen; f.sessions.revoke(f.parent.token); req.end(JSON.stringify(claim()));
  assert.equal(await complete, 401); assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 0);
});

test("native client refuses content-bearing input before contacting the control plane", async t => {
  let calls = 0;
  const client = new WikiCoordinatorClient({ getSession: () => assert.fail("must validate before session access"), fetchImpl: () => { calls++; assert.fail(); } });
  await assert.rejects(client.acquire({ ...claim(), text: "private source" }), /invalid_wiki_metadata/);
  await assert.rejects(client.publish({ shardKey, leaseId: randomUUID(), fence: 1, expectedGeneration: 0, manifest: { text: "private source" } }), /invalid_wiki_metadata/);
  assert.equal(calls, 0);
});

test("source limit refuses a new shard without deleting existing leases or heads", async t => {
  const f = await fixture(t), lease = f.coordinator.acquire(f.who, claim());
  const tenant = f.coordinator.db.prepare("SELECT tenant FROM wiki_heads LIMIT 1").get().tenant;
  f.coordinator.db.prepare("WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<9999) INSERT INTO wiki_heads SELECT ?,printf('%064d',n),0,0,NULL,NULL FROM seq").run(tenant);
  assert.throws(() => f.coordinator.acquire(f.who, { ...claim(), shardKey: wikiHash("new-source") }), /capacity/);
  assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_heads").get().n, 10000);
  assert.equal(f.coordinator.renew(f.who, key(lease)).id, lease.id);
});
