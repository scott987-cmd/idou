import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { DriveBudget, DriveBudgetService, PostgresDriveBudget, drivePolicies } from "../src/control-plane/drive-budget.js";
import pg from "pg";
import { testPostgres } from "./helpers/postgres.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { DriveBudgetClient } from "../src/application/drive-budget-client.js";
import { createServer } from "node:net";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const policy = { authProvider: "feishu", tenantId: "tenant", appId: "cli_synthetic", providerId: "saas-cli", driveTenantKey: "drive-tenant", folderToken: "SyntheticFolder123", maxBytes: 100 };
const identity = { authProvider: "feishu", tenantId: "tenant", appId: "cli_synthetic", userId: "alice", deviceId: "device", deviceProof: "ed25519-login" };
const request = (ledger, id = randomUUID(), bytes = 60) => ({ id, policyDigest: ledger.snapshot(identity).policyDigest, providerId: policy.providerId, driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken, bytes, sha256: "a".repeat(64) });
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-budget-test-"))), filename = path.join(directory, "ledger.sqlite");
  const connections = [], make = () => { const db = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: filename, policies: [policy] }); connections.push(db); return db; };
  t.after(async () => { for (const db of connections) { try { db.close(); } catch {} } await rm(directory, { recursive: true, force: true }); });
  return { directory, filename, make, ledger: make() };
}
test("tenant budget aggregates different users and devices, persists and never double-counts an id", async (t) => {
  const f = await fixture(t), input = request(f.ledger);
  assert.equal(f.ledger.reserve(identity, input).chargedBytes, 60);
  assert.equal(f.ledger.reserve({ ...identity, deviceId: "second-device" }, input).chargedBytes, 60);
  const restored = f.make();
  assert.throws(() => restored.reserve({ ...identity, userId: "bob" }, request(restored)), /budget_exceeded/);
  assert.throws(() => restored.reserve({ ...identity, userId: "bob" }, input), /conflict/);
  assert.throws(() => restored.reserve(identity, { ...input, bytes: 1 }), /conflict/);
  assert.equal(restored.snapshot(identity).remainingBytes, 40);
});
test("one-shot dispatch, reported receipt and ambiguous reservations never release charged bytes", async (t) => {
  const f = await fixture(t), input = request(f.ledger);
  f.ledger.reserve(identity, input);
  assert.throws(() => f.ledger.change(identity, { id: input.id, fileToken: "file" }, false), /receipt_conflict/);
  assert.equal(f.ledger.change(identity, { id: input.id, policyDigest: input.policyDigest }, true).granted, true);
  const restored = f.make();
  assert.throws(() => restored.change(identity, { id: input.id, policyDigest: input.policyDigest }, true), /already_claimed/);
  assert.equal(restored.change(identity, { id: input.id, fileToken: "SyntheticFile123" }, false).chargedBytes, 60);
  assert.equal(restored.change(identity, { id: input.id, fileToken: "SyntheticFile123" }, false).chargedBytes, 60);
  assert.throws(() => restored.change(identity, { id: input.id, fileToken: "DifferentFile123" }, false), /receipt_conflict/);
  assert.throws(() => restored.change({ ...identity, userId: "bob" }, { id: input.id, fileToken: "SyntheticFile123" }, false), /not_found/);
});
test("policy/target changes and content payloads fail closed before reservation", async (t) => {
  const f = await fixture(t), input = request(f.ledger);
  for (const change of [{ policyDigest: "b".repeat(64) }, { driveTenantKey: "other" }, { folderToken: "other" }, { providerId: "other" }]) assert.throws(() => f.ledger.reserve(identity, { ...input, ...change }), /policy_changed/);
  for (const change of [{ content: "secret text" }, { bytes: -1 }, { bytes: 1.5 }, { bytes: 104857601 }]) assert.throws(() => f.ledger.reserve(identity, { ...input, ...change }), /invalid/);
  assert.equal(f.ledger.snapshot(identity).chargedBytes, 0);
  f.ledger.reserve(identity, input);
  f.ledger.policies = drivePolicies([{ ...policy, maxBytes: 50 }], SAAS_FEISHU);
  assert.equal(f.ledger.snapshot(identity).remainingBytes, 0);
  assert.throws(() => f.ledger.change(identity, { id: input.id, policyDigest: f.ledger.snapshot(identity).policyDigest }, true), /policy_changed/);
  assert.throws(() => f.ledger.snapshot({ ...identity, appId: "cli_other" }), /not_configured/);
});
test("SQLite coordinates actual competing server processes without exceeding the tenant budget", async (t) => {
  const f = await fixture(t), url = new URL("../src/control-plane/drive-budget.js", import.meta.url).href, saasUrl = new URL("../src/providers/feishu/saas-definition.js", import.meta.url).href;
  const code = `import {DriveBudget} from ${JSON.stringify(url)}; import {SAAS_FEISHU} from ${JSON.stringify(saasUrl)}; const db=new DriveBudget({databaseFile:process.argv[1],policies:JSON.parse(process.argv[2]),feishu:SAAS_FEISHU}); try { db.reserve(JSON.parse(process.argv[3]),JSON.parse(process.argv[4])); console.log('reserved'); } catch(e) { console.log(e.message); } finally { db.close(); }`;
  const results = await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, f.filename, JSON.stringify([policy]), JSON.stringify(identity), JSON.stringify(request(f.ledger, randomUUID(), 20))])));
  assert.equal(results.filter((row) => row.stdout.trim() === "reserved").length, 5);
  assert.equal(results.filter((row) => row.stdout.trim() === "drive_budget_exceeded").length, 3);
  assert.equal(f.make().snapshot(identity).chargedBytes, 100);
});
test("a process killed after dispatch cannot reissue its upload permit on restart", async (t) => {
  const f = await fixture(t), input = request(f.ledger), url = new URL("../src/control-plane/drive-budget.js", import.meta.url).href, saasUrl = new URL("../src/providers/feishu/saas-definition.js", import.meta.url).href;
  const code = `import {DriveBudget} from ${JSON.stringify(url)}; import {SAAS_FEISHU} from ${JSON.stringify(saasUrl)}; const db=new DriveBudget({databaseFile:process.argv[1],policies:JSON.parse(process.argv[2]),feishu:SAAS_FEISHU}); const who=JSON.parse(process.argv[3]), input=JSON.parse(process.argv[4]); db.reserve(who,input); db.change(who,{id:input.id,policyDigest:input.policyDigest},true); console.log('durable'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.filename, JSON.stringify([policy]), JSON.stringify(identity), JSON.stringify(input)], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const closed = once(child, "close"); await once(child.stdout, "data"); child.kill("SIGKILL"); await closed;
  const restored = f.make();
  assert.equal(restored.snapshot(identity).chargedBytes, 60);
  assert.throws(() => restored.change(identity, { id: input.id, policyDigest: input.policyDigest }, true), /already_claimed/);
});
test("server config persists only in a private directory; malformed policy or DB never silently resets", async (t) => {
  const f = await fixture(t), configFile = path.join(f.directory, "policy.json"), databaseFile = path.join(f.directory, "private", "budget.sqlite");
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, databaseFile, tenants: [policy] }));
  const ledger = await DriveBudget.fromConfig(configFile, SAAS_FEISHU); ledger.reserve(identity, request(ledger)); ledger.close();
  const restored = await DriveBudget.fromConfig(configFile, SAAS_FEISHU); assert.equal(restored.snapshot(identity).chargedBytes, 60); restored.close();
  await mkdir(path.join(f.directory, "public"), { mode: 0o755 });
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(f.directory, "public", "db"), tenants: [policy] }));
  if (process.platform !== "win32") await assert.rejects(DriveBudget.fromConfig(configFile, SAAS_FEISHU), /private/);
  await writeFile(path.join(f.directory, "bad.sqlite"), "not a database");
  assert.throws(() => new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(f.directory, "bad.sqlite"), policies: [policy] }));
  assert.equal(await readFile(path.join(f.directory, "bad.sqlite"), "utf8"), "not a database");
});
// serverAhead: how far the control plane's clock runs ahead of this one.
// `ledger`: another ledger to serve than the fixture's own file.
async function httpFixture(t, { serverAhead = 0, ledger = null } = {}) {
  const f = await fixture(t), sessions = new SessionRegistry({ now: () => Date.now() + serverAhead }), parent = sessions.issue(identity);
  const service = new DriveBudgetService({ sessions, ledger: ledger ?? f.ledger });
  const server = createModelGateway({ sessions, apiKey: "synthetic-provider-secret", authHandler: (req, res) => service.handle(req, res), fetchImpl: () => assert.fail("No model calls") });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.close(); server.closeAllConnections(); });
  const post = (route, token, body, headers = {}) => fetch(`${origin}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { ...f, sessions, parent, post, origin };
}
test("HTTP separates Drive leases from media/model, rejects foreign identity and revokes with parent", async (t) => {
  const f = await httpFixture(t);
  assert.equal((await f.post("/v1/drive/policy", f.parent.token, {})).status, 403);
  const lease = await (await f.post("/auth/drive-token", f.parent.token, {})).json();
  assert.equal(lease.audience, "drive-budget");
  const media = f.sessions.issueForMedia(f.parent.token, "image");
  assert.equal((await f.post("/v1/drive/policy", media.token, {})).status, 403);
  assert.equal((await f.post("/v1/responses", lease.token, { model: "MiniMax-M3", input: "test" })).status, 403);
  assert.equal((await f.post("/v1/drive/policy", lease.token, {}, { origin: "https://example.com" })).status, 403);
  assert.equal((await f.post("/v1/drive/policy", lease.token, { document: "secret" })).status, 400);
  assert.equal((await f.post("/v1/drive/policy", lease.token, { document: "x".repeat(5000) })).status, 413);
  const foreign = f.sessions.issue({ ...identity, tenantId: "other" });
  assert.equal((await f.post("/auth/drive-token", foreign.token, {})).status, 403);
  f.sessions.revoke(f.parent.token); assert.equal((await f.post("/v1/drive/policy", lease.token, {})).status, 401);
});
// Since 2026-09-28 a scheduled task's report goes to its owner's own space,
// not the tenant's folder (schedule-report-archive.js). The ledger takes that
// destination from inside the server only: a desktop still saves nowhere but
// the folder its administrator named.
test("a destination other than the policy's folder is taken from inside the server, and never over HTTP", async (t) => {
  const f = await fixture(t), own = { ...request(f.ledger), folderToken: "OwnRootFolder123" };
  assert.throws(() => f.ledger.reserve(identity, own), /target_mismatch/, "not as an ordinary request");
  assert.equal(f.ledger.reserve(identity, own, { own: true }).state, "reserved");
  assert.equal(f.ledger.snapshot(identity).chargedBytes, 60, "charged to the tenant as any upload is");
  assert.equal(f.ledger.reservation(identity, own, { own: true }).state, "reserved");
  assert.throws(() => f.ledger.reservation(identity, { ...own, folderToken: policy.folderToken }, { own: true }), /not_found/, "bound to where it goes");
  assert.throws(() => f.ledger.reserve(identity, { ...request(f.ledger), folderToken: "" }, { own: true }), /target_mismatch/, "a destination, not an empty one");
  assert.equal(f.ledger.unresolved(identity, own.id), false);
  f.ledger.change(identity, { id: own.id, policyDigest: own.policyDigest }, true);
  assert.equal(f.ledger.unresolved(identity, own.id), true, "sent, and not heard back from");
  assert.equal(f.ledger.unresolved({ ...identity, userId: "bob" }, own.id), false, "and only for its owner");
  const http = await httpFixture(t);
  const lease = await (await http.post("/auth/drive-token", http.parent.token, {})).json();
  const refused = await http.post("/v1/drive/reserve", lease.token, { ...request(http.ledger), folderToken: "OwnRootFolder123", own: true });
  assert.equal(refused.status, 400, "a desktop cannot ask for it");
  assert.equal((await http.post("/v1/drive/reserve", lease.token, { ...request(http.ledger), folderToken: "OwnRootFolder123" })).status, 409);
});
// Saving to Drive asks for a budget credential first; with the control plane's
// clock a few hundred milliseconds ahead (another machine since 2026-09-22)
// it was refused here as too long-lived, and nothing could be saved.
test("a control plane whose clock runs slightly ahead still grants a usable Drive budget credential", async (t) => {
  const f = await httpFixture(t, { serverAhead: 400 }), session = { ...f.parent, serverUrl: f.origin };
  const media = { unchanged: async () => {}, request: async (_session, route, token, body) => {
    const response = await f.post(route, token, body), value = await response.json();
    if (!response.ok) { const error = new Error(value.error.code); error.status = response.status; throw error; } return value;
  } };
  const folder = { providerId: policy.providerId, token: policy.folderToken, identity: { tenantKey: policy.driveTenantKey } };
  assert.equal((await new DriveBudgetClient(media).policy(session, folder, 60)).remainingBytes, policy.maxBytes);
});
test("native client talks to actual budget HTTP, retains uncertain dispatch and never retries it", async (t) => {
  const f = await httpFixture(t), session = { ...f.parent, serverUrl: f.origin }; let drop = false, dispatches = 0;
  const media = { unchanged: async () => {}, request: async (_session, route, token, body) => {
    const response = await f.post(route, token, body), value = await response.json();
    if (route.endsWith("/dispatch")) { dispatches++; if (drop) throw new Error("lost response"); }
    if (!response.ok) { const error = new Error(value.error.code); error.status = response.status; throw error; } return value;
  } };
  const client = new DriveBudgetClient(media), folder = { providerId: policy.providerId, token: policy.folderToken, identity: { tenantKey: policy.driveTenantKey } };
  const snapshot = await client.policy(session, folder, 60), id = randomUUID();
  await client.reserve(session, id, { folder, bytes: 60, sha256: "a".repeat(64) }, snapshot.policyDigest);
  drop = true; await assert.rejects(client.dispatch(session, id, snapshot.policyDigest), /许可结果可能未知/); assert.equal(dispatches, 1);
  assert.equal(f.make().snapshot(identity).chargedBytes, 60);
  drop = false; await assert.rejects(client.dispatch(session, id, snapshot.policyDigest), /HTTP 409/);
  await assert.rejects(client.policy(session, folder, 60), /预算不足/);
  await client.report(session, id, "SyntheticFile123"); assert.equal(f.ledger.snapshot(identity).chargedBytes, 60);
  const raw = await readFile(f.filename); assert.equal(raw.includes(Buffer.from(f.parent.token)), false); assert.equal(raw.includes(Buffer.from("synthetic-provider-secret")), false);
});
test("real server entry loads budget and application catalogs, denies anonymous access and shuts down cleanly", async (t) => {
  const f = await fixture(t), configFile = path.join(f.directory, "entry-policy.json"), databaseFile = path.join(f.directory, "server", "budget.sqlite");
  await writeFile(configFile, JSON.stringify({ schemaVersion: 1, databaseFile, tenants: [policy] }));
  const appConfig = path.join(f.directory, "application-policy.json");
  await writeFile(appConfig, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(f.directory, "server-apps", "apps.sqlite"), tenants: [{ authProvider: policy.authProvider, tenantId: policy.tenantId, appId: policy.appId, publishers: [identity.userId] }] }));
  const wikiConfig = path.join(f.directory, "wiki-policy.json");
  await writeFile(wikiConfig, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(f.directory, "server-wiki", "wiki.sqlite"), tenants: [{ authProvider: policy.authProvider, tenantId: policy.tenantId, appId: policy.appId, members: [identity.userId] }] }));
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening"); const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["bin/server.js", "--feishu"], { env: { ...clientEnvironment(), MINIMAX_API_KEY: "synthetic-not-a-live-key", FEISHU_APP_ID: policy.appId, FEISHU_APP_SECRET: "synthetic-not-a-live-secret", FEISHU_ALLOWED_TENANTS: policy.tenantId, IDOU_PORT: String(port), IDOU_PUBLIC_URL: origin, IDOU_DRIVE_CONFIG_FILE: configFile, IDOU_APPS_CONFIG_FILE: appConfig, IDOU_WIKI_CONFIG_FILE: wikiConfig }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close"); let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill("SIGKILL"); await closed; } });
  const deadline = Date.now() + 10000;
  while (!stdout.includes("Listening on loopback") && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(stdout, /Listening on loopback/);
  const response = await fetch(`${origin}/v1/drive/policy`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "session_expired_or_invalid");
  assert.equal((await fetch(`${origin}/v1/apps/list`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${origin}/v1/wiki/status`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  child.kill("SIGTERM"); assert.equal((await closed)[0], 0);
  assert.doesNotMatch(stdout + stderr, /synthetic-not-a-live/);
  const reopened = await DriveBudget.fromConfig(configFile, SAAS_FEISHU); assert.equal(reopened.snapshot(identity).chargedBytes, 0); reopened.close();
});

// ---- The same ledger in the shared PostgreSQL (docs/scaling-plan.md §2.5) ----

// Each kind: `ledger`, and `make()` for another ledger on the same data -- a
// coordinator after a restart, or on another machine.
async function ledgers(t, kind) {
  if (kind === "sqlite") { const f = await fixture(t); return { ledger: f.ledger, make: async () => f.make() }; }
  const server = await testPostgres(t), database = await server.database(), pools = [];
  server.closeFirst(async () => { for (const pool of pools) await pool.end(); });
  const make = async () => { const pool = new pg.Pool({ ...database, max: 4 }); pool.on("error", () => {}); pools.push(pool); return PostgresDriveBudget.open({ pool, policies: [policy], feishu: SAAS_FEISHU }); };
  return { ledger: await make(), make, pools };
}
const requestOf = async (ledger, id = randomUUID(), bytes = 60) => ({ id, policyDigest: (await ledger.snapshot(identity)).policyDigest, providerId: policy.providerId,
  driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken, bytes, sha256: "a".repeat(64) });

for (const kind of ["sqlite", "postgres"]) {
  test(`${kind}: a tenant's budget counts every person and device, lasts past a restart, and never counts an id twice`, { timeout: 60_000 }, async (t) => {
    const f = await ledgers(t, kind), input = await requestOf(f.ledger);
    assert.equal((await f.ledger.reserve(identity, input)).chargedBytes, 60);
    assert.equal((await f.ledger.reserve({ ...identity, deviceId: "second-device" }, input)).chargedBytes, 60);
    const restored = await f.make();
    await assert.rejects(async () => restored.reserve({ ...identity, userId: "bob" }, await requestOf(restored)), /budget_exceeded/);
    await assert.rejects(async () => restored.reserve({ ...identity, userId: "bob" }, input), /conflict/);
    await assert.rejects(async () => restored.reserve(identity, { ...input, bytes: 1 }), /conflict/);
    assert.equal((await restored.snapshot(identity)).remainingBytes, 40);
  });

  test(`${kind}: a dispatch is granted once, a receipt is kept, and nothing charged is ever released`, { timeout: 60_000 }, async (t) => {
    const f = await ledgers(t, kind), input = await requestOf(f.ledger);
    await f.ledger.reserve(identity, input);
    await assert.rejects(async () => f.ledger.change(identity, { id: input.id, fileToken: "file" }, false), /receipt_conflict/);
    assert.equal((await f.ledger.change(identity, { id: input.id, policyDigest: input.policyDigest }, true)).granted, true);
    const restored = await f.make();
    await assert.rejects(async () => restored.change(identity, { id: input.id, policyDigest: input.policyDigest }, true), /already_claimed/);
    assert.equal((await restored.change(identity, { id: input.id, fileToken: "SyntheticFile123" }, false)).chargedBytes, 60);
    assert.equal((await restored.change(identity, { id: input.id, fileToken: "SyntheticFile123" }, false)).chargedBytes, 60);
    await assert.rejects(async () => restored.change(identity, { id: input.id, fileToken: "DifferentFile123" }, false), /receipt_conflict/);
    await assert.rejects(async () => restored.change({ ...identity, userId: "bob" }, { id: input.id, fileToken: "SyntheticFile123" }, false), /not_found/);
    assert.deepEqual(await restored.reservation(identity, input), { id: input.id, state: "reported", fileToken: "SyntheticFile123" });
    assert.equal(await restored.assertReported(identity, { id: input.id, providerId: policy.providerId, driveTenantKey: policy.driveTenantKey,
      folderToken: policy.folderToken, sha256: input.sha256, bytes: input.bytes, fileToken: "SyntheticFile123" }), true);
  });

  test(`${kind}: a changed policy or target, or a request carrying content, is refused before anything is reserved`, { timeout: 60_000 }, async (t) => {
    const f = await ledgers(t, kind), input = await requestOf(f.ledger);
    for (const change of [{ policyDigest: "b".repeat(64) }, { driveTenantKey: "other" }, { folderToken: "other" }, { providerId: "other" }]) await assert.rejects(async () => f.ledger.reserve(identity, { ...input, ...change }), /policy_changed/);
    for (const change of [{ content: "secret text" }, { bytes: -1 }, { bytes: 1.5 }, { bytes: 104857601 }]) await assert.rejects(async () => f.ledger.reserve(identity, { ...input, ...change }), /invalid/);
    assert.equal((await f.ledger.snapshot(identity)).chargedBytes, 0);
    await f.ledger.reserve(identity, input);
    f.ledger.policies = drivePolicies([{ ...policy, maxBytes: 50 }], SAAS_FEISHU);
    assert.equal((await f.ledger.snapshot(identity)).remainingBytes, 0);
    await assert.rejects(async () => f.ledger.change(identity, { id: input.id, policyDigest: (await f.ledger.snapshot(identity)).policyDigest }, true), /policy_changed/);
    await assert.rejects(async () => f.ledger.snapshot({ ...identity, appId: "cli_other" }), /not_configured/);
  });
}

// What BEGIN IMMEDIATE did across processes, the ledger's own lock does across
// coordinators: eight asking at once for 20 of a 100-byte budget, five get it.
test("postgres: reservations from separate coordinators at once never exceed the tenant's budget", { timeout: 60_000 }, async (t) => {
  const f = await ledgers(t, "postgres");
  const coordinators = await Promise.all(Array.from({ length: 8 }, () => f.make()));
  const inputs = await Promise.all(coordinators.map((ledger) => requestOf(ledger, randomUUID(), 20)));
  const results = await Promise.allSettled(coordinators.map((ledger, index) => ledger.reserve(identity, inputs[index])));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => result.reason.message === "drive_budget_exceeded"));
  assert.equal((await f.ledger.snapshot(identity)).chargedBytes, 100);
});

test("the reservations move from the file to the database and back as they are", { timeout: 60_000 }, async (t) => {
  const file = await ledgers(t, "sqlite"), shared = await ledgers(t, "postgres");
  const reserved = await requestOf(file.ledger, randomUUID(), 10), dispatched = await requestOf(file.ledger, randomUUID(), 20), reported = await requestOf(file.ledger, randomUUID(), 30);
  for (const input of [reserved, dispatched, reported]) file.ledger.reserve(identity, input);
  file.ledger.change(identity, { id: dispatched.id, policyDigest: dispatched.policyDigest }, true);
  file.ledger.change(identity, { id: reported.id, policyDigest: reported.policyDigest }, true);
  file.ledger.change(identity, { id: reported.id, fileToken: "SyntheticFile123" }, false);
  const rows = file.ledger.rows();
  assert.equal(rows.length, 3);
  await shared.ledger.load(rows); await shared.ledger.load(rows);
  assert.deepEqual(await shared.ledger.rows(), rows, "loaded twice, the same rows once");
  assert.deepEqual(await shared.ledger.snapshot(identity), file.ledger.snapshot(identity));
  const back = await ledgers(t, "sqlite");
  back.ledger.load(await shared.ledger.rows());
  assert.deepEqual(back.ledger.rows(), rows);
});

test("the HTTP service reserves, dispatches and reports against the shared ledger", { timeout: 60_000 }, async (t) => {
  const shared = await ledgers(t, "postgres");
  const f = await httpFixture(t, { ledger: shared.ledger }), session = { ...f.parent, serverUrl: f.origin };
  const media = { unchanged: async () => {}, request: async (_session, route, token, body) => {
    const response = await f.post(route, token, body), value = await response.json();
    if (!response.ok) { const error = new Error(value.error.code); error.status = response.status; throw error; } return value;
  } };
  const client = new DriveBudgetClient(media), folder = { providerId: policy.providerId, token: policy.folderToken, identity: { tenantKey: policy.driveTenantKey } };
  const snapshot = await client.policy(session, folder, 60), id = randomUUID();
  await client.reserve(session, id, { folder, bytes: 60, sha256: "a".repeat(64) }, snapshot.policyDigest);
  await client.dispatch(session, id, snapshot.policyDigest);
  await client.report(session, id, "SyntheticFile123");
  const other = await shared.make();
  assert.equal((await other.snapshot(identity)).chargedBytes, 60, "counted where every coordinator reads it");
  assert.deepEqual((await other.rows()).map((row) => [row.state, row.file_token]), [["reported", "SyntheticFile123"]]);
});
