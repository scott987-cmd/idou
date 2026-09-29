import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, chmod, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EnterpriseSkillCatalog } from "../src/control-plane/skill-catalog.js";
import { EnterpriseSkillsClient } from "../src/application/enterprise-skills.js";
import { normalizeSkill, signingMessage, verifyCatalog, publicSigningKey } from "../src/skills/catalog-format.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { skillFixture } from "../scripts/fixtures/skill-catalog.js";

// The runtime this checkout pins -- what the app reports -- and so what the
// fixture skill, declared the same way, is compatible with.
const LOCK = JSON.parse((await import("node:fs")).readFileSync(new URL("../upstreams.lock.json", import.meta.url), "utf8"));
const PINNED = { codex: LOCK.codex.version, feishu: LOCK.feishu.version };
const signingKeys = () => { const keys = generateKeyPairSync("ed25519"); return { privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }), publicKey: keys.publicKey.export({ format: "pem", type: "spki" }) }; };
const identity = { tenantId: "tenant_a", userId: "ou_a", deviceId: "device", authProvider: "feishu", appId: "cli_fixture", deviceProof: "ed25519-login" };
// serverAhead: how far the control plane's clock runs ahead of this one.
async function setup(t, { serverAhead = 0 } = {}) {
  const keys = signingKeys(), sessions = new SessionRegistry({ now: () => Date.now() + serverAhead }), parent = sessions.issue(identity);
  let service;
  const server = createModelGateway({ apiKey: "synthetic-model-secret", sessions, authHandler: (req, res) => service.handle(req, res), fetchImpl: async () => Response.json({ output_text: "fixture" }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  service = new EnterpriseSkillCatalog({ origin, sessions, privateKey: keys.privateKey, catalog: { schemaVersion: 1, revision: 1, tenants: [
    { tenantId: "tenant_a", skills: [skillFixture()] }, { tenantId: "tenant_b", skills: [{ ...skillFixture(), id: "enterprise-other-team", title: "Other tenant confidential skill" }] }] } });
  t.after(() => { server.close(); server.closeAllConnections(); });
  const state = { session: { ...parent, serverUrl: origin, identity: { ...identity, provider: "feishu" } } };
  const client = new EnterpriseSkillsClient({ getSession: async () => state.session, publicKey: keys.publicKey, runtimeVersions: PINNED });
  const post = (route, token, body = {}, extra = {}) => fetch(`${origin}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  return { keys, sessions, parent, service, origin, state, client, post };
}

// The control plane runs on another machine since 2026-09-22, a few hundred
// milliseconds ahead of this one; the shelf's credential expires five minutes
// from now by its clock and was refused here as too long-lived.
test("a control plane whose clock runs slightly ahead still hands out a usable shelf credential", async (t) => {
  const f = await setup(t, { serverAhead: 400 }), result = await f.client.list();
  assert.equal(result.skills.length, 1);
});
test("HTTP catalog uses tenant-scoped derivative audience; list is metadata, preview revalidates exact content", async (t) => {
  const f = await setup(t), result = await f.client.list();
  assert.equal(result.skills.length, 1); assert.equal(result.skills[0].id, skillFixture().id); assert.equal(result.skills[0].compatible, true);
  assert.equal(result.skills[0].files, undefined); assert.doesNotMatch(JSON.stringify(result), /Other tenant|synthetic-model-secret|PRIVATE KEY/);
  const detail = await f.client.read(result.skills[0]); assert.equal(detail.files.length, 2); assert.match(detail.files[0].text, /<script>/);
  const derivative = await (await f.post("/auth/skills-token", f.parent.token)).json(); assert.equal(derivative.audience, "skill-center");
  assert.deepEqual(f.sessions.verify(derivative.token).scopes, ["skills:read"]);
  assert.equal((await f.post("/v1/responses", derivative.token, { model: "MiniMax-M3", input: "test" })).status, 403);
  assert.equal((await f.post("/v1/skills/catalog", f.parent.token, { nonce: "a".repeat(43) })).status, 403);
  assert.equal((await f.post("/auth/skills-token", derivative.token)).status, 403);
  f.sessions.revoke(f.parent.token); assert.equal(f.sessions.verify(derivative.token), null); await assert.rejects(f.client.read(result.skills[0]), /401/);
});

test("unauthorized, development, cross-tenant selectors and browser requests cannot read or enumerate catalogs", async (t) => {
  const f = await setup(t), unknown = f.sessions.issue({ ...identity, tenantId: "unknown" }), dev = f.sessions.issue({ tenantId: "tenant_a", userId: "local", deviceId: "dev" });
  assert.equal((await f.post("/auth/skills-token", "invalid")).status, 401);
  assert.equal((await f.post("/auth/skills-token", dev.token)).status, 401);
  assert.equal((await f.post("/auth/skills-token", unknown.token)).status, 403);
  assert.equal((await f.post("/auth/skills-token", f.parent.token, {}, { origin: "https://evil.example" })).status, 403);
  const child = await (await f.post("/auth/skills-token", f.parent.token)).json();
  assert.equal((await f.post("/v1/skills/catalog", child.token, { nonce: "a".repeat(43), tenantId: "tenant_b" })).status, 400);
  assert.equal((await f.post("/v1/skills/catalog", child.token, { nonce: "a".repeat(2000) })).status, 413);
  assert.equal((await f.post("/v1/skills/catalog", child.token, { nonce: "a".repeat(43) }, { "content-encoding": "gzip" })).status, 415);
});

test("signature verification rejects tampering, foreign keys, replayed nonce, expiry and cross-origin/tenant/application payloads", async (t) => {
  const f = await setup(t), child = f.sessions.issueForSkills(f.parent.token), nonce = "n".repeat(43);
  const envelope = f.service.signedCatalog(child, nonce), options = { publicKey: f.keys.publicKey, serverUrl: f.origin, tenantId: "tenant_a", appId: "cli_fixture", nonce };
  assert.equal(verifyCatalog(envelope, options).skills.length, 1);
  assert.throws(() => verifyCatalog({ ...envelope, signature: "a".repeat(86) }, options));
  assert.throws(() => verifyCatalog(envelope, { ...options, publicKey: signingKeys().publicKey }));
  assert.throws(() => verifyCatalog(envelope, { ...options, nonce: "other" }));
  assert.throws(() => verifyCatalog(envelope, { ...options, now: Date.now() + 120000 }));
  for (const [key, value] of [["serverUrl", "https://other.example"], ["tenantId", "tenant_b"], ["appId", "cli_other"]]) assert.throws(() => verifyCatalog(envelope, { ...options, [key]: value }));
  const payload = JSON.parse(Buffer.from(envelope.payload, "base64url")); payload.skills[0].files[0].text = "tampered";
  assert.throws(() => verifyCatalog({ ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64url") }, options));
  payload.skills[0].files[0].path = "../SKILL.md";
  const bytes = Buffer.from(JSON.stringify(payload)), signedBad = { ...envelope, payload: bytes.toString("base64url"), signature: sign(null, signingMessage(bytes), f.keys.privateKey).toString("base64url") };
  assert.throws(() => verifyCatalog(signedBad, options), /path/);
});

test("fresh preview rejects withdrawals, content/version changes and lower catalog revisions instead of using the prior snapshot", async (t) => {
  const f = await setup(t), initial = (await f.client.list()).skills[0];
  f.service.catalog.tenants.get("tenant_a")[0].files[0].text = "changed";
  await assert.rejects(f.client.read(initial), /版本已变化/);
  f.service.catalog.tenants.set("tenant_a", []); f.service.catalog.revision = 2;
  await assert.rejects(f.client.read(initial), /下架/);
  f.service.catalog.revision = 1; await assert.rejects(f.client.list(), /回退/);
});

test("changing login during a fetch and concurrent catalog requests cannot accept stale results", async (t) => {
  const f = await setup(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.client.fetch = async (...args) => { const result = await fetch(...args); if (args[0].endsWith("/v1/skills/catalog")) { entered.resolve(); await gate.promise; } return result; };
  const pending = f.client.list(); await entered.promise; await assert.rejects(f.client.list(), /正在核验/);
  f.state.session = { ...f.state.session, token: "different" }; gate.resolve(); await assert.rejects(pending, /登录已变化/);
});

test("invalid bundle files, disguised IDs, missing entry points and private verification keys are rejected", () => {
  for (const filename of ["../SKILL.md", "/tmp/SKILL.md", "a\\SKILL.md", "https://evil.example/SKILL.md"]) assert.throws(() => normalizeSkill({ ...skillFixture(), files: [{ path: filename, text: "x" }] }));
  assert.throws(() => normalizeSkill({ ...skillFixture(), id: ["enterprise-array"] }));
  assert.throws(() => normalizeSkill({ ...skillFixture(), files: [{ path: "readme.md", text: "x" }] }));
  assert.throws(() => normalizeSkill({ ...skillFixture(), files: [{ path: "SKILL.md", text: "x".repeat(65537) }] }));
  assert.throws(() => normalizeSkill({ ...skillFixture(), files: [{ path: "SKILL.md", text: "x" }, { path: "skill.md", text: "y" }] }));
  assert.throws(() => publicSigningKey(signingKeys().privateKey), /public/);
});

test("derivative lifetimes cannot exceed parent expiry and revocation/reissue do not leave usable old derivatives", () => {
  let now = 1000; const registry = new SessionRegistry({ now: () => now }), parent = registry.issue({ ...identity, ttlMs: 5000 });
  const first = registry.issueForSkills(parent.token), second = registry.issueForSkills(parent.token);
  assert.equal(first.expiresAt, parent.expiresAt); assert.equal(registry.verify(first.token), null); assert.ok(registry.verify(second.token));
  assert.throws(() => registry.issueForSkills(second.token)); now += 5001; assert.equal(registry.verify(second.token), null);
});

test("server catalog config requires bounded regular files, private signing-key permissions and explicit tenant schema", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "idou-skill-config-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const key = path.join(dir, "signing.pem"), catalog = path.join(dir, "catalog.json");
  await writeFile(key, signingKeys().privateKey, { mode: 0o600 }); await writeFile(catalog, JSON.stringify({ schemaVersion: 1, revision: 1, tenants: [{ tenantId: "tenant_a", skills: [skillFixture()] }] }));
  const config = { origin: "https://enterprise.example", sessions: new SessionRegistry(), env: { IDOU_SKILL_CATALOG_FILE: catalog, IDOU_SKILL_SIGNING_KEY_FILE: key } };
  assert.ok(await EnterpriseSkillCatalog.fromConfig(config));
  const link = path.join(dir, "linked.json"); await symlink(catalog, link);
  await assert.rejects(EnterpriseSkillCatalog.fromConfig({ ...config, env: { ...config.env, IDOU_SKILL_CATALOG_FILE: link } }));
  if (process.platform !== "win32") { await chmod(key, 0o644); await assert.rejects(EnterpriseSkillCatalog.fromConfig(config)); }
  assert.equal(await EnterpriseSkillCatalog.fromConfig({ ...config, env: {} }), null);
});

test("client fails closed on missing trust, malformed/oversized responses and upstream errors without echoing content or retrying", async (t) => {
  const f = await setup(t);
  f.client.publicKey = null; await assert.rejects(f.client.list(), /验签公钥/); f.client.publicKey = f.keys.publicKey;
  let calls = 0;
  f.client.fetch = async () => { calls++; return new Response("SYNTHETIC_PRIVATE_DATA", { status: 503 }); };
  await assert.rejects(f.client.list(), (error) => /HTTP 503/.test(error.message) && !error.message.includes("PRIVATE_DATA")); assert.equal(calls, 1);
  f.client.fetch = async () => new Response("not json", { headers: { "content-type": "application/json" } });
  await assert.rejects(f.client.list(), /格式无效/);
  f.client.fetch = async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } });
  await assert.rejects(f.client.list(), /大小限制/);
  f.client.fetch = async () => Response.json({ audience: "codex-model-gateway", token: "a".repeat(43), expiresAt: Date.now() + 1000 });
  await assert.rejects(f.client.list(), /凭证无效/);
});

test("token exchange is rate limited per root and does not accumulate unlimited derivative sessions", async (t) => {
  const f = await setup(t);
  for (let index = 0; index < 60; index++) assert.equal((await f.post("/auth/skills-token", f.parent.token)).status, 200);
  assert.equal((await f.post("/auth/skills-token", f.parent.token)).status, 429); assert.equal(f.sessions.sessions.size, 2);
});
