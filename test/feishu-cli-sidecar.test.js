import assert from "node:assert/strict";
import test from "node:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuCliProxyService } from "../src/control-plane/feishu-cli-proxy.js";
import { FeishuCliSidecar } from "../src/providers/feishu/cli-sidecar.js";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { DriveFileNotIntact } from "../src/providers/feishu/drive-files.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { loadFeishuLoginConfig } from "../src/control-plane/server-config.js";
import { feishuCliWriteCapabilities } from "../src/providers/feishu/cli-write-contract.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { requireBundledCli } from "./helpers/stub-cli.js";
import { ownHeader } from "../src/product-names.js";

test("CLI bridge scopes are explicit server policy and become a verified login capability", async t => {
  const env = { IDOU_PUBLIC_URL: "https://agent.example", FEISHU_APP_ID: "cli_fixture", FEISHU_APP_SECRET: "server-secret", FEISHU_ALLOWED_TENANTS: "tenant_fixture", FEISHU_SOURCE_ACCESS_ENABLED: "1", FEISHU_CLI_BRIDGE_ENABLED: "1", FEISHU_CLI_SCOPES: "fixture:read,fixture.docs:write", FEISHU_CLI_WRITE_ACTIONS: "document.inline-replace" };
  const config = loadFeishuLoginConfig(env);
  assert.deepEqual(config.cliProxyScopes, ["fixture:read", "fixture.docs:write"]);
  assert.deepEqual(config.cliWriteActions, ["document.inline-replace"]);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_CLI_SCOPES: "" }), /explicit/);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_CLI_SCOPES: "fixture:read,fixture:read" }), /explicit/);
  // Writes are opt-in per action and cannot exist without the bridge.
  assert.deepEqual(loadFeishuLoginConfig({ ...env, FEISHU_CLI_WRITE_ACTIONS: undefined }).cliWriteActions, []);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_CLI_WRITE_ACTIONS: "sheet.replace" }), /supports only/);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_CLI_WRITE_ACTIONS: "document.inline-replace,document.inline-replace" }), /supports only/);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_CLI_BRIDGE_ENABLED: undefined, FEISHU_CLI_SCOPES: undefined }), /supports only/);
  const sessions = new SessionRegistry(), sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: config.appId, cliProxyScopes: config.cliProxyScopes, cliWriteActions: config.cliWriteActions }); t.after(() => sourceAccess.close());
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, ...config, sessions, sourceAccess, fetchImpl: async url => url.endsWith("/open-apis/authen/v2/oauth/token")
    ? Response.json({ code: 0, access_token: "server-only-uat", token_type: "Bearer", expires_in: 600, scope: sourceAccess.requiredScopes.join(" ") })
    : Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", name: "Fixture User" } }) });
  const identity = await provider.exchangeCode({ code: "fixture", verifier: "fixture", redirectUri: "https://agent.example/auth/feishu/callback" });
  assert.equal(identity.cliBridge, true);
  assert.equal(identity.cliDocumentWrites, true);
  assert.doesNotMatch(JSON.stringify(identity), /server-only-uat|server-secret/);
});

test("the pinned authsidecar CLI reads and applies exactly one granted replacement without receiving the Feishu token", async t => {
  if (!(await requireBundledCli(t))) return;
  const now = Date.now(), sessions = new SessionRegistry();
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_bridge_fixture", cliProxyScopes: ["fixture:read", "fixture.docs:write"], cliWriteActions: ["document.inline-replace"], fetchImpl: () => assert.fail("source checks are not used") });
  const identity = { authProvider: "feishu", appId: "cli_bridge_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture User", expiresAt: now + 600_000, cliBridge: true, cliDocumentWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_fixture", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const upstream = [], audits = [];
  let revision = 3, content = "<title>安全桥接合成文档</title><p>待修改内容</p>";
  const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
    upstream.push({ url, method: options.method, authorization: options.headers.authorization, body: options.body ? Buffer.from(options.body).toString("utf8") : "" });
    if (url.includes("/open-apis/docs_ai/v1/documents/SyntheticBridgeDoc/fetch")) return Response.json({ code: 0, data: { document: { document_id: "SyntheticBridgeDoc", revision_id: revision, content } } });
    if (url.endsWith("/open-apis/docs_ai/v1/documents/SyntheticBridgeDoc") && options.method === "PUT") {
      const body = JSON.parse(Buffer.from(options.body).toString("utf8"));
      assert.deepEqual(body, { command: "str_replace", content: "已确认内容", format: "xml", pattern: "待修改内容", revision_id: 3 });
      content = content.replace(body.pattern, body.content); revision = 4;
      return Response.json({ code: 0, data: { result: "success", updated_blocks_count: 1, warnings: [], document: { revision_id: revision } } });
    }
    return Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture User" } });
  } });
  const gateway = createModelGateway({ apiKey: "unused-model-key", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  const sidecar = await new FeishuCliSidecar({ appId: identity.appId, getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl,
    identity: { provider: "feishu", appId: identity.appId, tenantId: identity.tenantId, userId: identity.userId, deviceId: "device_fixture", deviceProof: "ed25519-login", cliBridge: true, cliDocumentWrites: true } }) }).start();
  t.after(async () => { await sidecar.close(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });

  const environment = sidecar.environment();
  assert.doesNotMatch(JSON.stringify(environment), /server-only-feishu-user-token|unused-model-key/);
  const provider = new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : environment });
  const current = await provider.documentIdentity();
  assert.equal(current.tenantKey, "tenant_fixture");
  const result = await provider.invoke(["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.data.open_id, "ou_fixture");
  const document = await provider.readDocument("https://fixture.feishu.cn/docx/SyntheticBridgeDoc");
  assert.equal(document.title, "安全桥接合成文档"); assert.equal(document.sourceRevision, "3");

  // The confirmation callback runs once, immediately before the single dispatch.
  const draft = await provider.documentEdits.prepare(document, "待修改内容", "已确认内容");
  let confirmed = 0;
  const edited = await provider.documentEdits.apply(draft, async () => { confirmed++; });
  assert.equal(confirmed, 1);
  assert.equal(edited.sourceRevision, "4"); assert.match(edited.text, /已确认内容/);
  assert.equal(upstream.filter(call => call.method === "PUT").length, 1);
  assert.ok(upstream.length >= 6); // auth verification and auto identity resolution precede every command.
  assert.ok(upstream.every(call => call.authorization === "Bearer server-only-feishu-user-token"));
  assert.ok(upstream.some(call => call.url === "https://open.feishu.cn/open-apis/docs_ai/v1/documents/SyntheticBridgeDoc/fetch" && call.method === "POST"));
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /server-only-feishu-user-token|unused-model-key/);
  // Audit records the decision path but never the confirmed text or a credential.
  assert.deepEqual(audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"]);
  assert.doesNotMatch(JSON.stringify(audits), /待修改内容|已确认内容|SyntheticBridgeDoc|server-only-feishu-user-token/);
  assert.equal(sidecar.writeKeys.size, 0);
});

test("server-side CLI transit is read-only and rejects unbound sessions", async t => {
  const sessions = new SessionRegistry();
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_bridge_fixture", cliProxyScopes: ["fixture:read"] });
  const identity = { authProvider: "feishu", appId: "cli_bridge_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", expiresAt: Date.now() + 60_000, cliBridge: true };
  sourceAccess.remember(identity, "server-token");
  const session = sessions.issue({ ...identity, deviceId: "device", deviceProof: "ed25519-login", ttlMs: 60_000 }); sourceAccess.bind(identity, session);
  const proxy = new FeishuCliProxyService({ sourceAccess, fetchImpl: () => assert.fail("denied requests never reach Feishu") });
  const gateway = createModelGateway({ apiKey: "unused", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { proxy.close(); sourceAccess.close(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const origin = `http://127.0.0.1:${gateway.address().port}`, headers = { authorization: `Bearer ${session.token}`, "x-mydoubao-feishu-target": "https://open.feishu.cn", "x-mydoubao-feishu-path": "/open-apis/docx/v1/documents/fixture" };
  assert.equal((await fetch(`${origin}/v1/feishu/cli-proxy`, { method: "POST", headers })).status, 405);
  const development = sessions.issue({ tenantId: "development", userId: "local", deviceId: "device" });
  assert.equal((await fetch(`${origin}/v1/feishu/cli-proxy`, { headers: { ...headers, authorization: `Bearer ${development.token}` } })).status, 403);
});

const hash = value => createHash("sha256").update(value).digest("hex");
const DOC = "SyntheticGrantedDoc";
const writeBody = (pattern, content, revisionId) => JSON.stringify({ command: "str_replace", content, format: "xml", pattern, revision_id: revisionId });
const intentFor = (documentId, pattern, content, revisionId, operationId = randomUUID()) =>
  ({ action: "document.inline-replace", operationId, documentId, revisionId, patternHash: hash(pattern), contentHash: hash(content) });

async function writeFixture(t, { cliWriteActions = ["document.inline-replace"], documentWrites = true, upstream, clock = { offset: 0 } } = {}) {
  const now = () => Date.now() + clock.offset;
  const sessions = new SessionRegistry({ now });
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_write_fixture", cliProxyScopes: ["fixture:read", "fixture.docs:write"], cliWriteActions, now });
  const capabilities = documentWrites ? Object.fromEntries(feishuCliWriteCapabilities(cliWriteActions).map(name => [name, true])) : {};
  const identity = { authProvider: "feishu", appId: "cli_write_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", expiresAt: now() + 600_000, cliBridge: true, ...capabilities };
  sourceAccess.remember(identity, "server-token");
  const session = sessions.issue({ ...identity, deviceId: "device", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const audits = [], dispatched = [];
  const proxy = new FeishuCliProxyService({ sourceAccess, now, audit: event => audits.push(event), fetchImpl: upstream || (async (url, options) => {
    dispatched.push({ url, method: options.method });
    return Response.json({ code: 0, data: { result: "success", updated_blocks_count: 1, warnings: [], document: { revision_id: 4 } } });
  }) });
  const gateway = createModelGateway({ apiKey: "unused", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  t.after(async () => { proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const grantFor = (intent, token = session.token) => fetch(`${origin}/v1/feishu/cli-write-grants`, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(intent) });
  const put = (body, grant, { documentId = DOC, token = session.token, method = "PUT", path } = {}) => fetch(`${origin}/v1/feishu/cli-proxy`, { method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-mydoubao-feishu-target": "https://open.feishu.cn",
      "x-mydoubao-feishu-path": path || `/open-apis/docs_ai/v1/documents/${documentId}`, ...(grant ? { "x-mydoubao-feishu-write-grant": grant } : {}) }, body });
  const issued = async intent => {
    const response = await grantFor(intent), payload = await response.json().catch(() => ({}));
    assert.equal(response.status, 201, JSON.stringify(payload));
    return payload.grant;
  };
  return { sessions, sourceAccess, session, identity, proxy, origin, audits, dispatched, grantFor, put, issued, clock, now };
}

test("a write reaches Feishu only with a matching one-shot grant, and never by widening a method", async t => {
  const f = await writeFixture(t);
  const intent = intentFor(DOC, "原文", "新文", 3), body = writeBody("原文", "新文", 3);
  // No grant, an unknown grant, and a malformed grant are all refused before dispatch.
  assert.equal((await f.put(body, undefined)).status, 403);
  assert.equal((await f.put(body, "z".repeat(43))).status, 403);
  assert.equal((await f.put(body, "not-a-grant")).status, 403);
  // Methods outside the read policy and this one PUT stay unavailable entirely.
  for (const method of ["PATCH", "DELETE", "POST"]) assert.equal((await f.put(body, undefined, { method })).status, 405);
  assert.deepEqual(f.dispatched, []);
  const grant = await f.issued(intent);
  const response = await f.put(body, grant);
  assert.equal(response.status, 200);
  assert.equal(f.dispatched.length, 1);
  assert.equal(f.dispatched[0].method, "PUT");
  assert.equal(f.dispatched[0].url, `https://open.feishu.cn/open-apis/docs_ai/v1/documents/${DOC}`);
});

// Found live: marking a task complete is a PATCH, and the control plane read a
// request body only for POST and PUT. The sidecar (which reads every body)
// passed the request, the control plane compared an empty body against the
// grant and refused it -- the one PATCH family could never succeed. The grant,
// the forwarded body and the upstream call must all see the same bytes.
test("a PATCH write carries its body through the control plane to Feishu under its grant", async t => {
  const received = [];
  const f = await writeFixture(t, { cliWriteActions: ["cli.write"], upstream: async (url, options) => {
    received.push({ url, method: options.method, body: options.body ? Buffer.from(options.body).toString("utf8") : null, contentType: options.headers["content-type"] });
    return Response.json({ code: 0, data: { task: { guid: "61ef00b1-063b-4cf0-8cb5-e81f4bf73624" } } });
  } });
  const path = "/open-apis/task/v2/tasks/61ef00b1-063b-4cf0-8cb5-e81f4bf73624?user_id_type=open_id";
  const body = JSON.stringify({ task: { completed_at: "1789118404526" }, update_fields: ["completed_at"] });
  const intent = { action: "cli.write", operationId: randomUUID(), requestMethod: "PATCH", requestPath: path,
    bodyHash: hash(JSON.stringify({ task: { completed_at: "1789118404526" }, update_fields: ["completed_at"] })) };
  const grant = await f.issued(intent);
  const response = await f.put(body, grant, { method: "PATCH", path });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(received, [{ url: `https://open.feishu.cn${path}`, method: "PATCH", body, contentType: "application/json" }]);
  assert.deepEqual(f.audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"]);
  // The same grant does not cover a different body, and a PATCH without JSON is refused before any grant is spent.
  const other = await f.issued({ ...intent, operationId: randomUUID() });
  assert.equal((await f.put(JSON.stringify({ task: { completed_at: "0" }, update_fields: ["completed_at"] }), other, { method: "PATCH", path })).status, 403);
  const third = await f.issued({ ...intent, operationId: randomUUID() });
  const plain = await fetch(`${f.origin}/v1/feishu/cli-proxy`, { method: "PATCH", headers: { authorization: `Bearer ${f.session.token}`, "content-type": "text/plain",
    "x-mydoubao-feishu-target": "https://open.feishu.cn", "x-mydoubao-feishu-path": path, "x-mydoubao-feishu-write-grant": third }, body });
  assert.equal(plain.status, 415);
  assert.equal(received.length, 1);
});

// Deletion end to end through the control plane: only under a cli.delete
// grant, as a DELETE with no body, and never smuggled in under cli.write.
test("a deletion reaches Feishu only under a deletion grant, as a bodiless DELETE", async t => {
  const received = [];
  const upstream = async (url, options) => { received.push({ url, method: options.method, body: options.body ?? null }); return Response.json({ code: 0, data: {} }); };
  const f = await writeFixture(t, { cliWriteActions: ["cli.write", "cli.delete"], upstream });
  const path = "/open-apis/task/v2/tasks/61ef00b1-063b-4cf0-8cb5-e81f4bf73624";
  const intent = { action: "cli.delete", operationId: randomUUID(), requestMethod: "DELETE", requestPath: path, bodyHash: hash("null") };
  // Not grantable as an ordinary write at all.
  assert.equal((await f.grantFor({ ...intent, action: "cli.write" })).status, 400);
  const grant = await f.issued(intent);
  // A DELETE that carries a body is refused before its grant is looked at, and the grant survives.
  assert.equal((await f.put("{}", grant, { method: "DELETE", path })).status, 400);
  const response = await f.put(undefined, grant, { method: "DELETE", path });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(received, [{ url: `https://open.feishu.cn${path}`, method: "DELETE", body: null }]);
  assert.equal((await f.put(undefined, grant, { method: "DELETE", path })).status, 403, "single use");
  // A destructive sheet request under a write grant is refused even though its digest matches.
  const sheetPath = "/open-apis/sheet_ai/v2/spreadsheets/shtX/tools/invoke_write";
  const clear = JSON.stringify({ input: JSON.stringify({ clear_type: "contents", excel_id: "shtX", range: "A1:B2", sheet_name: "Sheet1" }), tool_name: "clear_cell_range" });
  const writeGrant = await f.issued({ action: "cli.write", operationId: randomUUID(), requestMethod: "POST", requestPath: sheetPath, bodyHash: hash(JSON.stringify(JSON.parse(clear), Object.keys(JSON.parse(clear)).sort())) });
  const smuggled = await f.put(clear, writeGrant, { method: "POST", path: sheetPath });
  assert.equal(smuggled.status, 403);
  assert.deepEqual(await smuggled.json(), { code: 403, msg: "feishu_cli_write_request_mismatch" });
  assert.equal(received.length, 1);
  assert.ok(f.audits.some(event => event.kind === "grant_rejected" && event.action === "cli.write"));
});

test("a deployment that has not enabled deletion cannot delete, whatever else it allows", async t => {
  const f = await writeFixture(t, { cliWriteActions: ["cli.write"] });
  const path = "/open-apis/task/v2/tasks/61ef00b1-063b-4cf0-8cb5-e81f4bf73624";
  assert.equal((await f.grantFor({ action: "cli.delete", operationId: randomUUID(), requestMethod: "DELETE", requestPath: path, bodyHash: hash("null") })).status, 403);
  assert.equal((await f.put(undefined, undefined, { method: "DELETE", path })).status, 405);
  assert.deepEqual(f.dispatched, []);
});

test("a grant is single use and its confirmed operation cannot be authorized twice", async t => {
  const f = await writeFixture(t);
  const intent = intentFor(DOC, "原文", "新文", 3), body = writeBody("原文", "新文", 3);
  const grant = await f.issued(intent);
  assert.equal((await f.put(body, grant)).status, 200);
  // Replaying the same grant, and re-authorizing the same confirmed operation.
  assert.equal((await f.put(body, grant)).status, 403);
  assert.equal((await f.grantFor(intent)).status, 409);
  assert.equal(f.dispatched.length, 1);
});

test("a grant will not cover a substituted endpoint, revision, text or session", async t => {
  const pattern = "原文", content = "新文";
  for (const [name, mutate] of [
    ["another document", async f => f.put(writeBody(pattern, content, 3), await f.issued(intentFor(DOC, pattern, content, 3)), { documentId: "OtherDocument1" })],
    ["another revision", async f => f.put(writeBody(pattern, content, 9), await f.issued(intentFor(DOC, pattern, content, 3)))],
    ["changed replacement", async f => f.put(writeBody(pattern, "偷换的文字", 3), await f.issued(intentFor(DOC, pattern, content, 3)))],
    ["changed pattern", async f => f.put(writeBody("别的原文", content, 3), await f.issued(intentFor(DOC, pattern, content, 3)))],
    ["a different command", async f => f.put(JSON.stringify({ command: "insert", content, format: "xml", pattern, revision_id: 3 }), await f.issued(intentFor(DOC, pattern, content, 3)))],
    ["an extra body field", async f => f.put(JSON.stringify({ command: "str_replace", content, format: "xml", pattern, revision_id: 3, force: true }), await f.issued(intentFor(DOC, pattern, content, 3)))],
  ]) {
    const f = await writeFixture(t);
    const response = await mutate(f);
    assert.equal(response.status, 403, `${name} must be refused`);
    assert.deepEqual(f.dispatched, [], `${name} must not reach Feishu`);
    assert.ok(f.audits.some(event => event.kind === "grant_rejected"), `${name} must be audited`);
  }
  // A mismatch still spends the grant, so a corrected retry needs a new confirmation.
  const f = await writeFixture(t);
  const intent = intentFor(DOC, pattern, content, 3), grant = await f.issued(intent);
  assert.equal((await f.put(writeBody(pattern, "偷换的文字", 3), grant)).status, 403);
  assert.equal((await f.put(writeBody(pattern, content, 3), grant)).status, 403);
  assert.deepEqual(f.dispatched, []);
});

test("write grants require the configured action and a live write-capable session", async t => {
  const intent = intentFor(DOC, "原文", "新文", 3);
  // The bridge alone is not enough: the action must be configured server-side.
  const disabled = await writeFixture(t, { cliWriteActions: [], documentWrites: false });
  assert.equal((await disabled.grantFor(intent)).status, 403);
  // A session that never advertised the capability cannot obtain one either.
  const unlinked = await writeFixture(t, { documentWrites: false });
  assert.equal((await unlinked.grantFor(intent)).status, 403);
  // Neither can any other credential, including a development session.
  const f = await writeFixture(t);
  const development = f.sessions.issue({ tenantId: "development", userId: "local", deviceId: "device" });
  assert.equal((await f.grantFor(intent, development.token)).status, 403);
  assert.equal((await f.grantFor(intent, "x".repeat(43))).status, 403);
  // Logout between confirmation and dispatch invalidates an already-issued grant.
  const grant = await f.issued(intent);
  f.sessions.revoke(f.session.token);
  assert.equal((await f.put(writeBody("原文", "新文", 3), grant)).status, 403);
  assert.deepEqual(f.dispatched, []);
});

test("a lost upstream acknowledgment stays unknown and cannot be replayed", async t => {
  let attempts = 0;
  const f = await writeFixture(t, { upstream: async () => { attempts++; throw new Error("synthetic lost acknowledgment"); } });
  const intent = intentFor(DOC, "原文", "新文", 3), grant = await f.issued(intent);
  assert.equal((await f.put(writeBody("原文", "新文", 3), grant)).status, 502);
  assert.equal(attempts, 1);
  // The grant was spent before dispatch; nothing retries it automatically.
  assert.equal((await f.put(writeBody("原文", "新文", 3), grant)).status, 403);
  assert.equal(attempts, 1);
  assert.deepEqual(f.audits.map(event => event.kind), ["grant_issued", "dispatch_started", "outcome_unknown"]);
});

test("reads keep their existing policy and cannot carry or become a write", async t => {
  const f = await writeFixture(t);
  const read = (path, extra = {}) => fetch(`${f.origin}/v1/feishu/cli-proxy`, { headers: { authorization: `Bearer ${f.session.token}`,
    "x-mydoubao-feishu-target": "https://open.feishu.cn", "x-mydoubao-feishu-path": path, ...extra } });
  assert.equal((await read("/open-apis/authen/v1/user_info")).status, 200);
  // A grant offered on a read is refused rather than silently ignored.
  const grant = await f.issued(intentFor(DOC, "原文", "新文", 3));
  assert.equal((await read("/open-apis/authen/v1/user_info", { "x-mydoubao-feishu-write-grant": grant })).status, 403);
  assert.equal(f.dispatched.length, 1);
});

test("the reusable Agent read key cannot sign a document write", async t => {
  const f = await writeFixture(t);
  const sidecar = await new FeishuCliSidecar({ appId: "cli_write_fixture", getSession: async () => ({ token: f.session.token, expiresAt: f.session.expiresAt, serverUrl: f.origin,
    identity: { provider: "feishu", appId: "cli_write_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", deviceId: "device", deviceProof: "ed25519-login", cliBridge: true, cliDocumentWrites: true } }) }).start();
  t.after(() => sidecar.close());
  const body = writeBody("原文", "新文", 3), path = `/open-apis/docs_ai/v1/documents/${DOC}`;
  const sign = key => {
    const timestamp = String(Math.floor(Date.now() / 1000)), bodyHash = hash(body);
    const canonical = ["v1", "PUT", "open.feishu.cn", path, bodyHash, timestamp, "user", "Authorization"].join("\n");
    return { "x-lark-proxy-version": "v1", "x-lark-proxy-target": "https://open.feishu.cn", "x-lark-proxy-identity": "user",
      "x-lark-proxy-auth-header": "Authorization", "x-lark-proxy-timestamp": timestamp, "x-lark-body-sha256": bodyHash,
      "x-lark-proxy-signature": createHmac("sha256", key).update(canonical).digest("hex") };
  };
  // The key the Codex task shell holds signs correctly but carries no grant, so
  // the control plane refuses it. Writing needs a fresh per-invocation key.
  const response = await fetch(`${sidecar.address}${path}`, { method: "PUT", headers: { ...sign(sidecar.key), "content-type": "application/json" }, body });
  assert.equal(response.status, 403);
  assert.deepEqual(f.dispatched, []);
  assert.equal(f.audits.filter(event => event.kind === "dispatch_started").length, 0);
});

test("a write-scoped key tolerates the CLI identity preflight but nothing else", async t => {
  const f = await writeFixture(t);
  const sidecar = await new FeishuCliSidecar({ appId: "cli_write_fixture", getSession: async () => ({ token: f.session.token, expiresAt: f.session.expiresAt, serverUrl: f.origin,
    identity: { provider: "feishu", appId: "cli_write_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", deviceId: "device", deviceProof: "ed25519-login", cliBridge: true, cliDocumentWrites: true } }) }).start();
  t.after(() => sidecar.close());
  const intent = intentFor(DOC, "原文", "新文", 3);
  const environment = await sidecar.environment(intent);
  const key = environment.LARKSUITE_CLI_PROXY_KEY;
  assert.notEqual(key, sidecar.key);
  const call = (method, path, body = "") => {
    const timestamp = String(Math.floor(Date.now() / 1000)), bodyHash = hash(body);
    const canonical = ["v1", method, "open.feishu.cn", path, bodyHash, timestamp, "user", "Authorization"].join("\n");
    return fetch(`${sidecar.address}${path}`, { method, headers: { "x-lark-proxy-version": "v1", "x-lark-proxy-target": "https://open.feishu.cn",
      "x-lark-proxy-identity": "user", "x-lark-proxy-auth-header": "Authorization", "x-lark-proxy-timestamp": timestamp, "x-lark-body-sha256": bodyHash,
      "x-lark-proxy-signature": createHmac("sha256", key).update(canonical).digest("hex"), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body } : {}) });
  };
  // The pinned CLI resolves its identity first; that must not spend the grant.
  assert.equal((await call("GET", "/open-apis/authen/v1/user_info")).status, 200);
  assert.equal(sidecar.writeKeys.size, 1);
  // Any other read on the write key retires it without reaching Feishu.
  assert.equal((await call("GET", `/open-apis/docs_ai/v1/documents/${DOC}/fetch`)).status, 403);
  assert.equal(sidecar.writeKeys.size, 0);
  // The preflight was forwarded as an ordinary read; no write ever was.
  assert.deepEqual(f.dispatched.map(row => row.method), ["GET"]);
  assert.equal(f.audits.filter(event => event.kind === "dispatch_started").length, 0);
});

test("a grant expires, will not cross sessions, survives no redirect and cannot be used twice concurrently", async t => {
  const pattern = "原文", content = "新文", body = writeBody(pattern, content, 3);

  // An unspent grant simply expires; a later dispatch is refused.
  const expiring = await writeFixture(t);
  const stale = await expiring.issued(intentFor(DOC, pattern, content, 3));
  expiring.clock.offset += 31_000;
  assert.equal((await expiring.put(body, stale)).status, 403);
  assert.deepEqual(expiring.dispatched, []);

  // A second login of the same user holds a different OAuth grant, so it cannot
  // spend a permit confirmed under the first one.
  const crossed = await writeFixture(t);
  const permit = await crossed.issued(intentFor(DOC, pattern, content, 3));
  const second = { ...crossed.identity, expiresAt: crossed.now() + 600_000 };
  crossed.sourceAccess.remember(second, "server-token");
  const other = crossed.sessions.issue({ ...second, deviceId: "device-two", deviceProof: "ed25519-login", ttlMs: 300_000 });
  crossed.sourceAccess.bind(second, other);
  assert.equal((await crossed.put(body, permit, { token: other.token })).status, 403);
  assert.deepEqual(crossed.dispatched, []);

  // An upstream redirect is never followed and never reported as success.
  const redirected = await writeFixture(t, { upstream: async () => ({ redirected: true, status: 200, headers: new Headers(), body: null }) });
  assert.equal((await redirected.put(body, await redirected.issued(intentFor(DOC, pattern, content, 3)))).status, 502);
  assert.deepEqual(redirected.audits.map(event => event.kind), ["grant_issued", "dispatch_started", "outcome_unknown"]);

  // Two simultaneous dispatches of one grant: exactly one may proceed.
  const raced = await writeFixture(t);
  const shared = await raced.issued(intentFor(DOC, pattern, content, 3));
  const results = await Promise.all([raced.put(body, shared), raced.put(body, shared)]);
  assert.deepEqual(results.map(response => response.status).sort(), [200, 403]);
  assert.equal(raced.dispatched.length, 1);
});

const MESSAGE_ACTIONS = ["message.send", "message.reply"];
const sendBody = (receiveId, content, uuid, msgType = "text") => JSON.stringify({ content, msg_type: msgType, receive_id: receiveId, uuid });
const replyBody = (content, uuid, inThread) => JSON.stringify(inThread
  ? { content, msg_type: "text", reply_in_thread: true, uuid }
  : { content, msg_type: "text", uuid });
const sendIntent = (receiveId, content, uuid, extra = {}) => ({ action: "message.send", operationId: randomUUID(),
  receiveIdType: receiveId.startsWith("oc_") ? "chat_id" : "open_id", receiveId, msgType: "text", contentHash: hash(content), idempotencyKey: uuid, ...extra });
const replyIntent = (messageId, content, uuid, replyInThread = false) => ({ action: "message.reply", operationId: randomUUID(),
  messageId, replyInThread, contentHash: hash(content), idempotencyKey: uuid });

test("the pinned CLI sends and replies through the bridge only under a matching grant", async t => {
  if (!(await requireBundledCli(t))) return;
  const now = Date.now(), sessions = new SessionRegistry();
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_msg_fixture", cliProxyScopes: ["fixture:read", "fixture.im:write"], cliWriteActions: MESSAGE_ACTIONS });
  const identity = { authProvider: "feishu", appId: "cli_msg_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture", expiresAt: now + 600_000, cliBridge: true, cliMessageWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_msg", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const upstream = [], audits = [];
  const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
    const body = options.body ? Buffer.from(options.body).toString("utf8") : "";
    upstream.push({ url, method: options.method, body });
    if (url.includes("/open-apis/im/v1/messages")) return Response.json({ code: 0, data: { message_id: "om_receipt", chat_id: "oc_fixturechat", msg_type: "text", create_time: "1", update_time: "1", deleted: false, updated: false } });
    return Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture" } });
  } });
  const gateway = createModelGateway({ apiKey: "unused-model-key", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  const sidecar = await new FeishuCliSidecar({ appId: identity.appId, getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl,
    identity: { provider: "feishu", appId: identity.appId, tenantId: identity.tenantId, userId: identity.userId, deviceId: "device_msg", deviceProof: "ed25519-login", cliBridge: true, cliMessageWrites: true } }) }).start();
  t.after(async () => { await sidecar.close(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const provider = new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : sidecar.environment() });

  const sendKey = "11111111-2222-4333-8444-555555555561", replyKey = "11111111-2222-4333-8444-555555555562";
  const sendContent = JSON.stringify({ text: "私信正文" }), replyContent = JSON.stringify({ text: "话题内回复" });
  const sent = await provider.invoke(["im", "+messages-send", "--user-id", "ou_target", "--text", "私信正文", "--idempotency-key", sendKey, "--as", "user", "--format", "json"],
    { timeoutMs: 30_000, maxOutputBytes: 256 * 1024, feishuWriteIntent: sendIntent("ou_target", sendContent, sendKey) });
  assert.equal(sent.code, 0, sent.stderr);
  const replied = await provider.invoke(["im", "+messages-reply", "--message-id", "om_original", "--text", "话题内回复", "--reply-in-thread", "--idempotency-key", replyKey, "--as", "user", "--format", "json"],
    { timeoutMs: 30_000, maxOutputBytes: 256 * 1024, feishuWriteIntent: replyIntent("om_original", replyContent, replyKey, true) });
  assert.equal(replied.code, 0, replied.stderr);

  const writes = upstream.filter(call => call.method === "POST");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].url, "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id");
  assert.deepEqual(JSON.parse(writes[0].body), { content: sendContent, msg_type: "text", receive_id: "ou_target", uuid: sendKey });
  assert.equal(writes[1].url, "https://open.feishu.cn/open-apis/im/v1/messages/om_original/reply");
  assert.deepEqual(JSON.parse(writes[1].body), { content: replyContent, msg_type: "text", reply_in_thread: true, uuid: replyKey });
  assert.deepEqual(audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished", "grant_issued", "dispatch_started", "upstream_finished"]);
  assert.doesNotMatch(JSON.stringify(audits), /私信正文|话题内回复|ou_target|om_original|server-only-feishu-user-token/);
  assert.equal(sidecar.writeKeys.size, 0);

  // An ungranted send is refused even though the action is configured.
  const ungranted = await provider.invoke(["im", "+messages-send", "--user-id", "ou_target", "--text", "未授权", "--idempotency-key", "11111111-2222-4333-8444-555555555563", "--as", "user", "--format", "json"],
    { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 });
  assert.notEqual(ungranted.code, 0);
  assert.equal(upstream.filter(call => call.method === "POST").length, 2);
});

test("a message grant binds recipient, placement, idempotency key and payload", async t => {
  const uuidKey = "11111111-2222-4333-8444-555555555571", content = JSON.stringify({ text: "正文" });
  for (const [name, mutate] of [
    ["another recipient", async f => f.put(sendBody("ou_other", content, uuidKey), await f.issued(sendIntent("ou_target", content, uuidKey)), { method: "POST", path: "/open-apis/im/v1/messages?receive_id_type=open_id" })],
    ["another recipient type", async f => f.put(sendBody("ou_target", content, uuidKey), await f.issued(sendIntent("ou_target", content, uuidKey)), { method: "POST", path: "/open-apis/im/v1/messages?receive_id_type=chat_id" })],
    ["a changed idempotency key", async f => f.put(sendBody("ou_target", content, "11111111-2222-4333-8444-555555555572"), await f.issued(sendIntent("ou_target", content, uuidKey)), { method: "POST", path: "/open-apis/im/v1/messages?receive_id_type=open_id" })],
    ["changed text", async f => f.put(sendBody("ou_target", JSON.stringify({ text: "偷换" }), uuidKey), await f.issued(sendIntent("ou_target", content, uuidKey)), { method: "POST", path: "/open-apis/im/v1/messages?receive_id_type=open_id" })],
    ["a promoted thread reply", async f => f.put(replyBody(content, uuidKey, true), await f.issued(replyIntent("om_target", content, uuidKey, false)), { method: "POST", path: "/open-apis/im/v1/messages/om_target/reply" })],
    ["a demoted thread reply", async f => f.put(replyBody(content, uuidKey, false), await f.issued(replyIntent("om_target", content, uuidKey, true)), { method: "POST", path: "/open-apis/im/v1/messages/om_target/reply" })],
    ["another source message", async f => f.put(replyBody(content, uuidKey, false), await f.issued(replyIntent("om_target", content, uuidKey, false)), { method: "POST", path: "/open-apis/im/v1/messages/om_other/reply" })],
  ]) {
    const f = await writeFixture(t, { cliWriteActions: MESSAGE_ACTIONS });
    const response = await mutate(f);
    assert.equal(response.status, 403, `${name} must be refused`);
    assert.deepEqual(f.dispatched, [], `${name} must not reach Feishu`);
  }
  // The exact confirmed request does go through, in both placements.
  const f = await writeFixture(t, { cliWriteActions: MESSAGE_ACTIONS });
  assert.equal((await f.put(sendBody("ou_target", content, uuidKey), await f.issued(sendIntent("ou_target", content, uuidKey)), { method: "POST", path: "/open-apis/im/v1/messages?receive_id_type=open_id" })).status, 200);
  assert.equal((await f.put(replyBody(content, uuidKey, true), await f.issued(replyIntent("om_target", content, uuidKey, true)), { method: "POST", path: "/open-apis/im/v1/messages/om_target/reply" })).status, 200);
  assert.equal(f.dispatched.length, 2);
});

test("enabling one write action does not enable another", async t => {
  const uuidKey = "11111111-2222-4333-8444-555555555581", content = JSON.stringify({ text: "正文" });
  // A document-only deployment refuses the message action and its endpoint.
  const documents = await writeFixture(t);
  assert.equal((await documents.grantFor(sendIntent("ou_target", content, uuidKey))).status, 403);
  assert.equal((await documents.put(sendBody("ou_target", content, uuidKey), undefined, { method: "POST", path: "/open-apis/im/v1/messages?receive_id_type=open_id" })).status, 405);
  // A message-only deployment refuses the document action and its endpoint.
  const messages = await writeFixture(t, { cliWriteActions: MESSAGE_ACTIONS });
  assert.equal((await messages.grantFor(intentFor(DOC, "原文", "新文", 3))).status, 403);
  assert.equal((await messages.put(writeBody("原文", "新文", 3), undefined)).status, 405);
  // Reply-only leaves send unavailable even though both share one capability.
  const replyOnly = await writeFixture(t, { cliWriteActions: ["message.reply"] });
  assert.equal((await replyOnly.grantFor(sendIntent("ou_target", content, uuidKey))).status, 403);
  assert.equal((await replyOnly.grantFor(replyIntent("om_target", content, uuidKey))).status, 201);
  assert.deepEqual([...documents.dispatched, ...messages.dispatched, ...replyOnly.dispatched], []);
});

const FOLDER = "fldcnBridgeFolder1", FILE = "mydoubao-11111111-2222-4333-8444-555555555555.png";
const FOLDER_URL = `https://fixture.feishu.cn/drive/folder/${FOLDER}`;
const multipartBody = (fields, boundary = "----probe0123456789") => {
  const parts = Object.entries(fields).map(([name, value]) =>
    Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${name === "file" ? `; filename="${FILE}"\r\nContent-Type: application/octet-stream` : ""}\r\n\r\n`),
      Buffer.isBuffer(value) ? value : Buffer.from(String(value)), Buffer.from("\r\n")]));
  return { body: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]), contentType: `multipart/form-data; boundary=${boundary}` };
};
const uploadIntent = (payload, extra = {}) => ({ action: "drive.upload", operationId: randomUUID(), folderToken: FOLDER,
  fileName: FILE, byteLength: payload.length, contentHash: hash(payload), ...extra });

test("the pinned CLI resolves, uploads and verifies one confirmed file over the bridge", async t => {
  if (!(await requireBundledCli(t))) return;
  const now = Date.now(), sessions = new SessionRegistry();
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_drive_fixture", cliProxyScopes: ["fixture:read", "fixture.drive:write"], cliWriteActions: ["drive.upload"] });
  const identity = { authProvider: "feishu", appId: "cli_drive_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture", expiresAt: now + 600_000, cliBridge: true, cliDriveWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_drive", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const upstream = [], audits = []; let stored = null, uploadedTitle = "";
  const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
    upstream.push({ url, method: options.method });
    if (url.includes("/drive/v1/metas/batch_query")) {
      const doc = JSON.parse(Buffer.from(options.body).toString("utf8")).request_docs[0];
      // A file only has a title once it exists, which is what verification reads.
      const title = doc.doc_type === "folder" ? "验收文件夹" : uploadedTitle;
      return Response.json({ code: 0, data: { metas: title ? [{ doc_token: doc.doc_token, doc_type: doc.doc_type, title, url: doc.doc_type === "file" ? `https://fixture.feishu.cn/file/${doc.doc_token}` : `https://fixture.feishu.cn/drive/${doc.doc_type}/${doc.doc_token}` }] : [], failed_list: [] } });
    }
    if (url.includes("/drive/v1/files/upload_all")) { stored = Buffer.from(options.body); uploadedTitle = FILE; return Response.json({ code: 0, data: { file_token: "boxcnBridgeFile1" } }); }
    return Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture" } });
  } });
  const gateway = createModelGateway({ apiKey: "unused-model-key", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  const sidecar = await new FeishuCliSidecar({ appId: identity.appId, getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl,
    identity: { provider: "feishu", appId: identity.appId, tenantId: identity.tenantId, userId: identity.userId, deviceId: "device_drive", deviceProof: "ed25519-login", cliBridge: true, cliDriveWrites: true } }) }).start();
  t.after(async () => { await sidecar.close(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const provider = new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : sidecar.environment() });

  const folder = await provider.drive.resolveFolder(FOLDER_URL);
  assert.equal(folder.title, "验收文件夹");
  assert.equal(folder.url, FOLDER_URL, "the caller's canonical link is preserved");
  const payload = Buffer.alloc(4096, 5);
  let dispatched = 0, uploaded = null;
  const receipt = await provider.drive.upload({ bytes: payload, name: FILE, folder, confirmed: true,
    onDispatched: async () => { dispatched++; }, onUploaded: async fileToken => { uploaded = fileToken; } });
  assert.equal(dispatched, 1); assert.equal(uploaded, "boxcnBridgeFile1");
  assert.equal(receipt.fileToken, "boxcnBridgeFile1"); assert.equal(receipt.name, FILE);
  assert.equal(receipt.url, `https://fixture.feishu.cn/file/boxcnBridgeFile1`);
  assert.equal(upstream.filter(call => call.url.includes("upload_all")).length, 1);
  assert.ok(stored.includes(payload), "the confirmed bytes are the bytes that reached Feishu");
  assert.deepEqual(audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"]);
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(`${FOLDER}|${FILE}|server-only-feishu-user-token`));
  assert.equal(sidecar.writeKeys.size, 0);

  // A token the tenant cannot resolve comes back with an empty title, which is
  // the only signal `+inspect` gives, and must not read as verified.
  uploadedTitle = "";
  await assert.rejects(provider.drive.verify({ folder, name: FILE, fileToken: "boxcnBridgeFile1" }), /未在云盘核验到/);
  uploadedTitle = "another-name.png";
  await assert.rejects(provider.drive.verify({ folder, name: FILE, fileToken: "boxcnBridgeFile1" }), /未在云盘核验到/);

  // Past the measured single-shot boundary the upload needs the chunked action,
  // which this deployment does not enable: the grant is refused and nothing
  // reaches Feishu (test/drive-chunked-upload.test.js covers the enabled case).
  await assert.rejects(provider.drive.upload({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1), name: FILE, folder, confirmed: true,
    onDispatched: async () => {}, onUploaded: async () => assert.fail("an upload whose grant was refused must not land") }), /授权/);
  assert.equal(upstream.filter(call => call.url.includes("upload_all")).length, 1);
  assert.equal(upstream.filter(call => call.url.includes("upload_prepare") || call.url.includes("upload_part")).length, 0);

  // Until 1.0.96 the CLI had no raw API resources for Drive, which is why folder
  // and file lookup go through `+inspect`. From 1.0.96 its API catalog is
  // compiled in and it has them, held to exactly the rules `lark-cli api` always
  // was: a write nobody granted is refused before anything reaches Feishu, and
  // the refusal arrives as words -- it used to arrive as "SDK returned an
  // invalid JSON response", because the refusal was not in Feishu's envelope.
  const beforeRaw = upstream.length;
  const refusedWrite = await provider.invoke(["drive", "files", "create_folder", "--data", JSON.stringify({ name: "x", folder_token: FOLDER }), "--as", "user", "--format", "json"],
    { timeoutMs: 30_000, maxOutputBytes: 262144 });
  assert.notEqual(refusedWrite.code, 0);
  // The CLI's identity preflight goes first, as before every command; nothing
  // else may follow it upstream.
  assert.deepEqual(upstream.slice(beforeRaw).map(call => `${call.method} ${call.url}`),
    upstream.slice(beforeRaw).length ? ["GET https://open.feishu.cn/open-apis/authen/v1/user_info"] : [], "an ungranted write never reaches Feishu");
  assert.doesNotMatch(refusedWrite.stderr, /invalid JSON response/, refusedWrite.stderr);
  assert.match(refusedWrite.stderr, /feishu_cli_|写/, `the refusal is said in words: ${refusedWrite.stderr}`);
});

// Since 2026-09-28 a scheduled report goes to its owner's own space (我的空间)
// rather than a folder the tenant shares (schedule-report-archive.js). The root
// has no link to inspect: its token is read from the explorer, as the person,
// and the one-shot grant then binds the upload to that token like any folder.
test("the pinned CLI finds the person's own space and puts a report there, bound to it by the grant", async t => {
  if (!(await requireBundledCli(t))) return;
  const now = Date.now(), sessions = new SessionRegistry(), ROOT_TOKEN = "nodcnOwnRootFolder1";
  const REPORT = "mydoubao-11111111-2222-4333-8444-555555555555.schedule.md";
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_drive_fixture", cliProxyScopes: ["fixture:read", "fixture.drive:write"], cliWriteActions: ["drive.upload"] });
  const identity = { authProvider: "feishu", appId: "cli_drive_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture", expiresAt: now + 600_000, cliBridge: true, cliDriveWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_drive", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const upstream = []; let stored = null, uploadedTitle = "";
  const proxy = new FeishuCliProxyService({ sourceAccess, audit: () => {}, fetchImpl: async (url, options) => {
    upstream.push({ url, method: options.method });
    if (url.includes("/drive/explorer/v2/root_folder/meta")) return Response.json({ code: 0, data: { token: ROOT_TOKEN, id: "7000000000000000001", user_id: "7000000000000000002" } });
    if (url.includes("/drive/v1/metas/batch_query")) {
      const doc = JSON.parse(Buffer.from(options.body).toString("utf8")).request_docs[0];
      const title = doc.doc_type === "folder" ? "我的空间" : uploadedTitle;
      return Response.json({ code: 0, data: { metas: title ? [{ doc_token: doc.doc_token, doc_type: doc.doc_type, title, url: doc.doc_type === "file" ? `https://fixture.feishu.cn/file/${doc.doc_token}` : `https://fixture.feishu.cn/drive/${doc.doc_type}/${doc.doc_token}` }] : [], failed_list: [] } });
    }
    if (url.includes("/drive/v1/files/upload_all")) { stored = Buffer.from(options.body); uploadedTitle = REPORT; return Response.json({ code: 0, data: { file_token: "boxcnOwnReport01" } }); }
    return Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture" } });
  } });
  const gateway = createModelGateway({ apiKey: "unused-model-key", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  const sidecar = await new FeishuCliSidecar({ appId: identity.appId, getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl,
    identity: { provider: "feishu", appId: identity.appId, tenantId: identity.tenantId, userId: identity.userId, deviceId: "device_drive", deviceProof: "ed25519-login", cliBridge: true, cliDriveWrites: true } }) }).start();
  t.after(async () => { await sidecar.close(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const provider = new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : sidecar.environment() });

  const root = await provider.drive.resolveRoot("https://fixture.feishu.cn");
  assert.deepEqual({ token: root.token, root: root.root, title: root.title, url: root.url },
    { token: ROOT_TOKEN, root: true, title: "我的空间", url: `https://fixture.feishu.cn/drive/folder/${ROOT_TOKEN}` });
  const report = Buffer.from("# 日报\n\n只给本人看的摘录。\n");
  const receipt = await provider.drive.upload({ bytes: report, name: REPORT, folder: root, confirmed: true, onDispatched: async () => {}, onUploaded: async () => {} });
  assert.equal(receipt.fileToken, "boxcnOwnReport01");
  const parent = /name="parent_node"\r\n\r\n([^\r]*)\r\n/.exec(stored.toString("latin1"))?.[1];
  assert.equal(parent, ROOT_TOKEN, "into the person's own root, as the grant bound it");
  assert.ok(stored.includes(report));
  assert.equal(upstream.filter(call => call.url.includes("root_folder/meta")).length, 2, "found as the person, and found again right before the upload");
  assert.equal(upstream.filter(call => call.url.includes("upload_all")).length, 1);
  // A grant for the root binds the root: the same bytes aimed at another folder are refused.
  const other = { ...root, token: "fldcnSomeoneShared1", url: "https://fixture.feishu.cn/drive/folder/fldcnSomeoneShared1" };
  await assert.rejects(provider.drive.upload({ bytes: report, name: REPORT, folder: other, confirmed: true, onDispatched: async () => {}, onUploaded: async () => {} }),
    /已变化/, "found again, the person's root is not that folder");
  assert.equal(upstream.filter(call => call.url.includes("upload_all")).length, 1);
});

test("an upload grant binds folder, name, length and bytes, and the chunked endpoints stay closed", async t => {
  const payload = Buffer.alloc(2048, 6);
  const fields = { file_name: FILE, parent_type: "explorer", parent_node: FOLDER, size: String(payload.length), file: payload };
  const post = (f, grant, body, contentType, path = "/open-apis/drive/v1/files/upload_all") =>
    fetch(`${f.origin}/v1/feishu/cli-proxy`, { method: "POST", headers: { authorization: `Bearer ${f.session.token}`, "content-type": contentType,
      "x-mydoubao-feishu-target": "https://open.feishu.cn", "x-mydoubao-feishu-path": path, ...(grant ? { "x-mydoubao-feishu-write-grant": grant } : {}) }, body });

  for (const [name, mutate] of [
    ["another folder", f => ({ ...fields, parent_node: "fldcnOtherFolder9" })],
    ["another name", f => ({ ...fields, file_name: "mydoubao-11111111-2222-4333-8444-555555555556.png" })],
    ["a retargeted parent type", f => ({ ...fields, parent_type: "wiki" })],
    ["a mismatched declared size", f => ({ ...fields, size: String(payload.length - 1) })],
    ["tampered bytes", f => ({ ...fields, file: Buffer.alloc(payload.length, 7) })],
    ["an extra field", f => ({ ...fields, extra: "x" })],
    ["a missing field", f => ({ file_name: FILE, parent_type: "explorer", parent_node: FOLDER, file: payload })],
  ]) {
    const f = await writeFixture(t, { cliWriteActions: ["drive.upload"] });
    const grant = await f.issued(uploadIntent(payload));
    const { body, contentType } = multipartBody(mutate(f));
    assert.equal((await post(f, grant, body, contentType)).status, 403, `${name} must be refused`);
    assert.deepEqual(f.dispatched, [], `${name} must not reach Feishu`);
  }

  const f = await writeFixture(t, { cliWriteActions: ["drive.upload"] });
  // A JSON body on the multipart endpoint, and the chunked endpoints, fail closed.
  assert.equal((await post(f, await f.issued(uploadIntent(payload)), JSON.stringify(fields), "application/json")).status, 415);
  for (const path of ["/open-apis/drive/v1/files/upload_prepare", "/open-apis/drive/v1/files/upload_part", "/open-apis/drive/v1/files/upload_finish"]) {
    assert.equal((await post(f, undefined, JSON.stringify({}), "application/json", path)).status, 405, `${path} must stay closed`);
  }
  // The exact confirmed upload is accepted.
  const { body, contentType } = multipartBody(fields);
  assert.equal((await post(f, await f.issued(uploadIntent(payload)), body, contentType)).status, 200);
  assert.equal(f.dispatched.length, 1);
});

test("the Drive metadata read exists only while the upload action is configured", async t => {
  const metas = f => fetch(`${f.origin}/v1/feishu/cli-proxy`, { method: "POST", headers: { authorization: `Bearer ${f.session.token}`,
    "content-type": "application/json", "x-mydoubao-feishu-target": "https://open.feishu.cn",
    "x-mydoubao-feishu-path": "/open-apis/drive/v1/metas/batch_query" }, body: JSON.stringify({ request_docs: [], with_url: true }) });
  const enabled = await writeFixture(t, { cliWriteActions: ["drive.upload"] });
  assert.equal((await metas(enabled)).status, 200);
  // A document-only deployment keeps the read surface it had before this slice.
  const documentOnly = await writeFixture(t);
  assert.equal((await metas(documentOnly)).status, 405);
  const readOnly = await writeFixture(t, { cliWriteActions: [], documentWrites: false });
  assert.equal((await metas(readOnly)).status, 405);
  // A companion read carries no grant.
  const grant = await enabled.issued(uploadIntent(Buffer.alloc(16, 1)));
  const withGrant = await fetch(`${enabled.origin}/v1/feishu/cli-proxy`, { method: "POST", headers: { authorization: `Bearer ${enabled.session.token}`,
    "content-type": "application/json", "x-mydoubao-feishu-target": "https://open.feishu.cn", "x-mydoubao-feishu-path": "/open-apis/drive/v1/metas/batch_query",
    "x-mydoubao-feishu-write-grant": grant }, body: JSON.stringify({ request_docs: [], with_url: true }) });
  assert.equal(withGrant.status, 403);
});

// Keyword search is a read, so it carries no grant — but it is a POST, and the
// read policy is a list of named operations rather than a method allowance.
// Everything that is not exactly this search at exactly this path stays refused.
const SEARCH_PATH = "/open-apis/search/v2/doc_wiki/search";
const searchBody = (extra = {}) => JSON.stringify({ query: "方案", page_size: 15, doc_filter: { doc_types: ["DOCX"], sort_type: "EDIT_TIME" }, ...extra });

test("keyword document search is an allowed read with a closed body, and nothing else at that path is", async t => {
  const reached = [];
  const f = await writeFixture(t, { upstream: async (url, options) => {
    reached.push({ url, method: options.method, body: options.body ? Buffer.from(options.body).toString("utf8") : "" });
    return Response.json({ code: 0, data: { results: [], has_more: false } });
  } });
  const search = (body, extra = {}) => f.put(body, undefined, { method: "POST", path: SEARCH_PATH, ...extra });

  assert.equal((await search(searchBody())).status, 200);
  assert.equal(reached.length, 1);
  assert.equal(reached[0].url, `https://open.feishu.cn${SEARCH_PATH}`);

  // A read never takes a write grant, and a search shape at a write path is not a write.
  assert.equal((await f.put(searchBody(), "x".repeat(43), { method: "POST", path: SEARCH_PATH })).status, 403);
  assert.equal((await f.put(searchBody(), undefined, { method: "POST", path: "/open-apis/search/v2/message" })).status, 405);
  assert.equal((await f.put(searchBody(), undefined, { method: "PUT", path: SEARCH_PATH })).status, 405);

  for (const body of [
    searchBody({ folder_tokens: ["fld"] }),                                   // unknown field
    searchBody({ query: "方".repeat(31) }),                                    // over the server's query limit
    searchBody({ page_size: 0 }), searchBody({ page_size: 21 }),               // outside the page range
    JSON.stringify({ query: "方案" }),                                          // no page size at all
    searchBody({ doc_filter: { doc_types: ["EVERYTHING"] } }),                 // unknown document type
    searchBody({ doc_filter: { doc_types: ["DOCX"], owner_ids: ["ou_x"] } }),  // unknown filter field
    searchBody({ doc_filter: { doc_types: ["DOCX"], sort_type: "RANDOM" } }),  // unknown sort
    searchBody({ page_token: "" }), "not json", "[]",
  ]) {
    assert.equal((await search(body)).status, 400, `expected refusal for ${body.slice(0, 60)}`);
  }
  assert.equal(reached.length, 1); // nothing refused ever reached Feishu
  assert.equal(f.audits.length, 0); // a read is not a write and is never audited as one
});

// ---- docs +create on 1.0.96: an async creation and the reads that settle it ----

async function creationBridge(t, { upstream, clock = { offset: 0 } }) {
  const now = () => Date.now() + clock.offset;
  const sessions = new SessionRegistry({ now });
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_create_fixture", now,
    cliProxyScopes: ["fixture:read", "fixture.docs:write"], cliWriteActions: ["document.create"] });
  const identity = { authProvider: "feishu", appId: "cli_create_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture",
    expiresAt: now() + 3_600_000, cliBridge: true, cliDocumentWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_create", deviceProof: "ed25519-login", ttlMs: 900_000 });
  sourceAccess.bind(identity, session);
  const calls = [], audits = [];
  const proxy = new FeishuCliProxyService({ sourceAccess, now, audit: event => audits.push(event), fetchImpl: async (url, options) => {
    const call = { method: options.method, path: new URL(url).pathname, body: options.body ? JSON.parse(Buffer.from(options.body).toString("utf8")) : null };
    calls.push(call);
    return upstream(call) ?? Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture" } });
  } });
  // What the sidecar let through, as the control plane saw it: the sidecar's own
  // refusals are the first layer and must hold without the second.
  const arrived = [];
  const gateway = createModelGateway({ apiKey: "unused-model-key", sessions, fetchImpl: () => assert.fail("model gateway is not used"),
    authHandler: (req, res) => { if (req.url === "/v1/feishu/cli-proxy") arrived.push(`${req.method} ${ownHeader(req.headers, "feishu-path")}`); return proxy.handle(req, res); } });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  const sidecar = await new FeishuCliSidecar({ appId: identity.appId, now, getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl,
    identity: { provider: "feishu", appId: identity.appId, tenantId: identity.tenantId, userId: identity.userId, deviceId: "device_create", deviceProof: "ed25519-login", cliBridge: true, cliDocumentWrites: true } }) }).start();
  t.after(async () => { await sidecar.close(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  // A request as the CLI signs it, for the shapes a real CLI would never send.
  const signed = (key, method, apiPath, body = "") => {
    const timestamp = String(Math.floor(now() / 1000)), bodyHash = createHash("sha256").update(body).digest("hex");
    const canonical = ["v1", method, "open.feishu.cn", apiPath, bodyHash, timestamp, "user", "Authorization"].join("\n");
    return fetch(`${sidecar.address}${apiPath}`, { method, body: body || undefined, headers: { "content-type": "application/json",
      "x-lark-proxy-version": "v1", "x-lark-proxy-target": "https://open.feishu.cn", "x-lark-proxy-identity": "user", "x-lark-proxy-auth-header": "Authorization",
      "x-lark-proxy-timestamp": timestamp, "x-lark-body-sha256": bodyHash, "x-lark-proxy-signature": createHmac("sha256", key).update(canonical).digest("hex") } });
  };
  return { sidecar, calls, audits, arrived, signed, clock, provider: new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : sidecar.environment() }) };
}
const created = id => ({ document: { document_id: id, revision_id: 1, url: `https://fixture.feishu.cn/docx/${id}` } });
const task = (id, status, extra = {}) => Response.json({ code: 0, data: { task: { task_id: id, status, poll_after_ms: 100, ...extra } } });

// Measured on 1.0.96 (--dry-run, and the source): the create asks for async
// creation, and when Feishu answers with a task the CLI polls that task until it
// settles. Refusing the polls would leave a created document with no receipt.
test("the pinned CLI creates a document over the bridge, and only its own task is read after the write", async t => {
  if (!(await requireBundledCli(t))) return;
  let polls = 0;
  const f = await creationBridge(t, { upstream: call => {
    if (call.method === "POST" && call.path === "/open-apis/docs_ai/v1/documents") return task("doctaskA1", "processing");
    if (call.method === "GET" && call.path === "/open-apis/docs_ai/v1/async_tasks/doctaskA1") {
      polls += 1;
      return polls === 1 ? task("doctaskA1", "processing")
        : task("doctaskA1", "succeeded", { result: { create_document: JSON.stringify(created("doxcnBridgeCreated1")) } });
    }
    return null;
  } });
  const { SaasDocumentAuthoring } = await import("../src/providers/feishu/document-authoring.js");
  const result = await new SaasDocumentAuthoring(f.provider).create("# 季度纪要\n\n- 结论一\n");
  assert.equal(result.documentId, "doxcnBridgeCreated1");
  assert.equal(result.revision, "1");
  const business = f.calls.filter(call => call.path !== "/open-apis/authen/v1/user_info");
  assert.deepEqual(business.map(call => `${call.method} ${call.path}`), ["POST /open-apis/docs_ai/v1/documents",
    "GET /open-apis/docs_ai/v1/async_tasks/doctaskA1", "GET /open-apis/docs_ai/v1/async_tasks/doctaskA1"]);
  assert.deepEqual(Object.keys(business[0].body).sort(), ["content", "extra_param", "format"], "the confirmed body, as 1.0.96 sends it");
  assert.deepEqual(f.audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"]);
  assert.equal(f.sidecar.writeKeys.size, 0, "a settled task retires the key");
});

test("after a creation the key reads only its own task, never writes again, and not past its window", async t => {
  const answers = new Map();
  const f = await creationBridge(t, { upstream: call => {
    if (call.method === "POST" && call.path === "/open-apis/docs_ai/v1/documents") return answers.get(call.body.content)?.() ?? null;
    if (call.method === "GET" && call.path.startsWith("/open-apis/docs_ai/v1/async_tasks/")) return task(call.path.split("/").pop(), "processing");
    return null;
  } });
  const create = async (content, answer) => {
    answers.set(content, answer);
    const key = (await f.sidecar.environment({ action: "document.create", operationId: randomUUID(), contentHash: createHash("sha256").update(content).digest("hex") })).LARKSUITE_CLI_PROXY_KEY;
    const response = await f.signed(key, "POST", "/open-apis/docs_ai/v1/documents", JSON.stringify({ content, extra_param: "{\"open_create_async\":true}", format: "markdown" }));
    assert.equal(response.status, 200);
    return key;
  };
  const poll = (key, id) => f.signed(key, "GET", `/open-apis/docs_ai/v1/async_tasks/${id}`);
  const reached = () => f.calls.filter(call => call.path.includes("async_tasks")).length;

  // Its own task, as often as the CLI polls it.
  const first = await create("# 一\n", () => task("doctaskB1", "processing"));
  assert.equal((await poll(first, "doctaskB1")).status, 200);
  assert.equal((await poll(first, "doctaskB1")).status, 200);
  // Another task: refused before Feishu, and the key is gone for good.
  const before = reached();
  assert.equal((await poll(first, "doctaskOther")).status, 403);
  assert.equal((await poll(first, "doctaskB1")).status, 403);
  assert.equal(reached(), before, "neither refused read reached Feishu");

  // A spent key never carries the grant again, whatever the body.
  const second = await create("# 二\n", () => task("doctaskB2", "processing"));
  const again = await f.signed(second, "POST", "/open-apis/docs_ai/v1/documents", JSON.stringify({ content: "# 二\n", extra_param: "{\"open_create_async\":true}", format: "markdown" }));
  assert.equal(again.status, 403);
  assert.equal(f.arrived.filter(line => line === "POST /open-apis/docs_ai/v1/documents").length, 2, "the sidecar itself refused the second POST");

  // A direct answer names nothing to follow: the key retires at once.
  const third = await create("# 三\n", () => Response.json({ code: 0, data: created("doxcnDirect3") }));
  assert.equal(f.sidecar.writeKeys.size, 0, "retired on the answer, not left for a later refusal to clear");
  assert.equal((await poll(third, "doctaskB3")).status, 403);

  // And a task still processing is read only inside the window.
  const fourth = await create("# 四\n", () => task("doctaskB4", "processing"));
  assert.equal((await poll(fourth, "doctaskB4")).status, 200);
  f.clock.offset += 12 * 60_000;
  assert.equal((await poll(fourth, "doctaskB4")).status, 403);
  assert.equal(f.sidecar.writeKeys.size, 0);
});

// drive.replace: one scheduled report overwritten in place, for the rotation
// that keeps each task's latest few (schedule-report-archive.js). The grant
// names the file, and nothing but that file -- in that folder, getting that
// name, length and bytes -- is overwritten under it; an upload grant never is.
const REPORT_OLD = "mydoubao-33333333-4444-4555-8666-777777777777.schedule.md";
const REPORT_NEW = "mydoubao-33333333-4444-4555-8666-777777777778.schedule.md";
const KEPT_FILE = "boxcnKeptReport01";
const replaceIntent = (payload, extra = {}) => ({ action: "drive.replace", operationId: randomUUID(), folderToken: FOLDER, fileToken: KEPT_FILE,
  fileName: REPORT_NEW, byteLength: payload.length, contentHash: hash(payload), ...extra });

test("a replace grant overwrites exactly the file it names, and an upload grant cannot overwrite", async t => {
  const payload = Buffer.alloc(1024, 8);
  const fields = { file_name: REPORT_NEW, parent_type: "explorer", parent_node: FOLDER, size: String(payload.length), file_token: KEPT_FILE, file: payload };
  const post = (f, grant, { body, contentType }) => fetch(`${f.origin}/v1/feishu/cli-proxy`, { method: "POST", headers: { authorization: `Bearer ${f.session.token}`,
    "content-type": contentType, "x-mydoubao-feishu-target": "https://open.feishu.cn", "x-mydoubao-feishu-path": "/open-apis/drive/v1/files/upload_all",
    ...(grant ? { "x-mydoubao-feishu-write-grant": grant } : {}) }, body });
  const { file_token: _dropped, ...newUpload } = fields;
  for (const [name, changed] of [
    ["another file", { ...fields, file_token: "boxcnSomeoneElse1" }],
    ["no file named, which is a new upload", newUpload],
    ["another folder", { ...fields, parent_node: "fldcnOtherFolder9" }],
    ["another name", { ...fields, file_name: REPORT_OLD }],
    ["tampered bytes", { ...fields, file: Buffer.alloc(payload.length, 9) }],
    ["an extra field", { ...fields, extra: "x" }],
  ]) {
    const f = await writeFixture(t, { cliWriteActions: ["drive.replace"] });
    assert.equal((await post(f, await f.issued(replaceIntent(payload)), multipartBody(changed))).status, 403, `${name} must be refused`);
    assert.deepEqual(f.dispatched, [], `${name} must not reach Feishu`);
  }
  const f = await writeFixture(t, { cliWriteActions: ["drive.replace"] });
  assert.equal((await post(f, await f.issued(replaceIntent(payload)), multipartBody(fields))).status, 200, "the exact overwrite is accepted");
  assert.equal(f.dispatched.length, 1);
  assert.equal((await f.grantFor(replaceIntent(payload, { fileName: FILE }))).status, 400, "only a scheduled report can be the new content");
  const uploadOnly = await writeFixture(t, { cliWriteActions: ["drive.upload"] });
  assert.notEqual((await uploadOnly.grantFor(replaceIntent(payload))).status, 201, "not enabled, not granted");
  assert.equal((await post(uploadOnly, await uploadOnly.issued(uploadIntent(payload)), multipartBody({ ...fields, file_name: FILE }))).status, 403,
    "an upload grant with a file_token in it is refused");
  assert.deepEqual(uploadOnly.dispatched, []);
});

test("the pinned CLI overwrites one kept report in place over the bridge, and only while it is still that report", async t => {
  if (!(await requireBundledCli(t))) return;
  const now = Date.now(), sessions = new SessionRegistry();
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_drive_fixture", cliProxyScopes: ["fixture:read", "fixture.drive:write"],
    cliWriteActions: ["drive.upload", "drive.replace"] });
  const identity = { authProvider: "feishu", appId: "cli_drive_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture", expiresAt: now + 600_000, cliBridge: true, cliDriveWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_drive", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const previousBytes = Buffer.from("# 上一次的报告\n甲\n"), payload = Buffer.from("# 今天的报告\n甲、乙、丙\n");
  // What Feishu holds for the kept file. `listed` false is the recycle bin:
  // metadata and +inspect still show the file under its title (measured
  // 2026-09-22); only the folder listing leaves it out.
  const upstream = [], audits = []; let stored = null, title = REPORT_OLD, held = previousBytes, listed = true, listingRefused = false;
  const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
    upstream.push({ url, method: options.method });
    if (url.includes("/drive/v1/metas/batch_query")) {
      const doc = JSON.parse(Buffer.from(options.body).toString("utf8")).request_docs[0];
      const shown = doc.doc_type === "folder" ? "验收文件夹" : title;
      return Response.json({ code: 0, data: { metas: shown ? [{ doc_token: doc.doc_token, doc_type: doc.doc_type, title: shown, url: doc.doc_type === "file" ? `https://fixture.feishu.cn/file/${doc.doc_token}` : `https://fixture.feishu.cn/drive/${doc.doc_type}/${doc.doc_token}` }] : [], failed_list: [] } });
    }
    // Overwritten in place: the same token, the new name (measured 2026-09-22).
    if (url.includes("/drive/v1/files/upload_all")) { stored = Buffer.from(options.body); title = REPORT_NEW; held = payload; return Response.json({ code: 0, data: { file_token: KEPT_FILE } }); }
    // The pinned CLI's +download looks the token up and asks whether this user
    // may export it before fetching the bytes (answers as recorded 2026-09-22).
    if (url.includes("/drive/v2/files/query_by_token")) return Response.json({ code: 0, data: { is_wiki_token: false, obj_token: KEPT_FILE, obj_type: "file", status: 0 } });
    if (url.includes(`/drive/v1/permissions/${KEPT_FILE}/members/auth`)) return Response.json({ code: 0, data: { auth_result: true } });
    if (url.includes(`/drive/v1/files/${KEPT_FILE}/download`)) return new Response(held, { headers: { "content-type": "application/octet-stream" } });
    if (url.includes("/drive/v1/files?")) {
      assert.match(url, new RegExp(`folder_token=${FOLDER}`), "only the pre-authorized folder is listed");
      // Feishu's refusals are HTTP 400 with a code, never a 200.
      if (listingRefused) return Response.json({ code: 99991679, msg: "Unauthorized. required one of these privileges under the user identity: [space:document:retrieve, drive:drive:readonly, drive:drive]" }, { status: 400 });
      return Response.json({ code: 0, data: { files: listed ? [{ token: KEPT_FILE, name: title, type: "file", parent_token: FOLDER }] : [], has_more: false } });
    }
    return Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture" } });
  } });
  const gateway = createModelGateway({ apiKey: "unused-model-key", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  const sidecar = await new FeishuCliSidecar({ appId: identity.appId, getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl,
    identity: { provider: "feishu", appId: identity.appId, tenantId: identity.tenantId, userId: identity.userId, deviceId: "device_drive", deviceProof: "ed25519-login", cliBridge: true, cliDriveWrites: true } }) }).start();
  t.after(async () => { await sidecar.close(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const provider = new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : sidecar.environment() });
  const folder = await provider.drive.resolveFolder(FOLDER_URL);
  const kept = { name: REPORT_OLD, fileToken: KEPT_FILE, bytes: previousBytes.length, sha256: hash(previousBytes) };
  const overwrites = () => upstream.filter(call => call.url.includes("upload_all")).length;
  const refused = (pattern) => (error) => { assert.ok(error instanceof DriveFileNotIntact, `${error?.message}`); assert.match(error.message, pattern); return true; };
  const untouched = { onDispatched: async () => assert.fail("nothing is dispatched for a file that is not the kept report"), onUploaded: async () => assert.fail("never") };
  const replace = (callbacks) => provider.drive.replace({ bytes: payload, name: REPORT_NEW, previous: kept, folder, confirmed: true, ...callbacks });

  // Not the kept report any more: each found before anything is sent, and said
  // so in a way the caller can tell apart from a failure that proves nothing.
  listed = false;
  await assert.rejects(replace(untouched), refused(/不在目标文件夹/), "deleted: in the recycle bin, where metadata still shows it");
  listed = true; held = Buffer.from("# 上一次的报告\n甲\n我补了一句\n");
  await assert.rejects(replace(untouched), refused(/内容已被改动/), "edited by a person, so theirs now");
  held = previousBytes; listingRefused = true;
  await assert.rejects(replace(untouched), (error) => !(error instanceof DriveFileNotIntact), "a listing Feishu refused proves nothing about the report");
  listingRefused = false;
  assert.equal(overwrites(), 0);

  let dispatched = 0, uploaded = null;
  const receipt = await replace({ onDispatched: async () => { dispatched++; }, onUploaded: async token => { uploaded = token; } });
  assert.deepEqual([dispatched, uploaded, receipt.fileToken, receipt.name], [1, KEPT_FILE, KEPT_FILE, REPORT_NEW]);
  assert.equal(overwrites(), 1);
  assert.ok(stored.includes(payload), "the confirmed bytes are the bytes that reached Feishu");
  assert.ok(stored.includes(Buffer.from(KEPT_FILE)), "the one file named in the grant is the file overwritten");
  assert.deepEqual(audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"], "the refused attempts never asked for a grant");
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(`${FOLDER}|${KEPT_FILE}|${REPORT_NEW}|server-only-feishu-user-token`));

  // The same receipt again: the file now carries the new report's name.
  await assert.rejects(replace(untouched), refused(/改名或移动/), "a receipt whose file was overwritten is not the kept report any more");
  assert.equal(overwrites(), 1, "no second overwrite");
});

// A scheduled task's result appended to a document its owner chose for it
// (schedule-delivery.js): the pinned CLI's own `docs +update --command append`,
// under a grant bound to that document, the revision read from its metadata and
// these exact bytes. Nothing reads the document whole: a daily log outgrows
// what a fetch returns.
test("the pinned CLI appends a task's result to the end of a chosen document, under a grant bound to it", async t => {
  if (!(await requireBundledCli(t))) return;
  const now = Date.now(), sessions = new SessionRegistry(), DOC = "DoxcnAppendTarget01";
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_append_fixture", cliProxyScopes: ["fixture:read", "fixture.docs:write"], cliWriteActions: ["document.append"] });
  const identity = { authProvider: "feishu", appId: "cli_append_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture", expiresAt: now + 600_000, cliBridge: true, cliDocumentWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_append", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const upstream = [], audits = [], appended = [];
  let revision = 7;
  const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
    const body = options.body ? Buffer.from(options.body).toString("utf8") : "";
    upstream.push({ url, method: options.method, body });
    if (url === `https://open.feishu.cn/open-apis/docx/v1/documents/${DOC}` && options.method === "GET") {
      return Response.json({ code: 0, data: { document: { document_id: DOC, revision_id: revision, title: "周报汇总" } } });
    }
    if (url === `https://open.feishu.cn/open-apis/docs_ai/v1/documents/${DOC}` && options.method === "PUT") {
      appended.push(JSON.parse(body)); revision += 1;
      return Response.json({ code: 0, data: { result: "success", warnings: [], document: { document_id: DOC, revision_id: revision, url: `https://fixture.feishu.cn/docx/${DOC}` } } });
    }
    return Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture" } });
  } });
  const gateway = createModelGateway({ apiKey: "unused-model-key", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  const sidecar = await new FeishuCliSidecar({ appId: identity.appId, getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl,
    identity: { provider: "feishu", appId: identity.appId, tenantId: identity.tenantId, userId: identity.userId, deviceId: "device_append", deviceProof: "ed25519-login", cliBridge: true, cliDocumentWrites: true } }) }).start();
  t.after(async () => { await sidecar.close(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const provider = new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : sidecar.environment() });

  const entry = "## 每天汇总 · 2026-09-28 09:00\n\n# 要点\n\n1. 上线了\n";
  let dispatched = 0;
  const receipt = await provider.documentAuthoring.appendToEnd(DOC, entry, async () => { dispatched += 1; });
  assert.deepEqual(receipt, { documentId: DOC, title: "周报汇总", revision: "8" });
  assert.equal(dispatched, 1, "the caller hears once, right before the one dispatch");
  // Exactly what the contract binds: the end of the document, these bytes, at
  // the revision the metadata said.
  assert.deepEqual(appended, [{ block_id: "-1", command: "block_insert_after", content: entry, format: "markdown", revision_id: 7 }]);
  assert.equal(upstream.filter(call => call.method === "PUT").length, 1);
  assert.equal(upstream.filter(call => call.url.includes("/fetch")).length, 0, "the document is never read whole");
  assert.deepEqual(audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"]);
  assert.doesNotMatch(JSON.stringify(audits), /要点|DoxcnAppendTarget01|server-only-feishu-user-token/);
  // The next day's entry is based on the revision the first one left.
  await provider.documentAuthoring.appendToEnd(DOC, "## 每天汇总 · 2026-09-29 09:00\n\n第二天\n");
  assert.equal(appended[1].revision_id, 8);
  // A document id that is not one never reaches the CLI.
  await assert.rejects(provider.documentAuthoring.appendToEnd("../etc", entry), /文档标识无效/);
  assert.equal(sidecar.writeKeys.size, 0);
});

test("an append is refused by the bridge where the deployment has not enabled it, before Feishu hears of it", async t => {
  const now = Date.now(), sessions = new SessionRegistry(), DOC = "DoxcnAppendTarget02";
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_append_fixture", cliProxyScopes: ["fixture:read", "fixture.docs:write"], cliWriteActions: ["document.inline-replace"] });
  const identity = { authProvider: "feishu", appId: "cli_append_fixture", tenantId: "tenant_fixture", userId: "ou_fixture", displayName: "Fixture", expiresAt: now + 600_000, cliBridge: true, cliDocumentWrites: true };
  sourceAccess.remember(identity, "server-only-feishu-user-token");
  const session = sessions.issue({ ...identity, deviceId: "device_append", deviceProof: "ed25519-login", ttlMs: 300_000 });
  sourceAccess.bind(identity, session);
  const upstream = [];
  const proxy = new FeishuCliProxyService({ sourceAccess, audit: () => {}, fetchImpl: async (url, options) => {
    upstream.push({ url, method: options.method });
    if (url.endsWith(`/open-apis/docx/v1/documents/${DOC}`)) return Response.json({ code: 0, data: { document: { document_id: DOC, revision_id: 3, title: "t" } } });
    return Response.json({ code: 0, data: { open_id: "ou_fixture", tenant_key: "tenant_fixture", user_id: "fixture-user", name: "Fixture" } });
  } });
  const gateway = createModelGateway({ apiKey: "unused-model-key", sessions, authHandler: (req, res) => proxy.handle(req, res), fetchImpl: () => assert.fail("model gateway is not used") });
  await new Promise((resolve, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", resolve); });
  const serverUrl = `http://127.0.0.1:${gateway.address().port}`;
  const sidecar = await new FeishuCliSidecar({ appId: identity.appId, getSession: async () => ({ token: session.token, expiresAt: session.expiresAt, serverUrl,
    identity: { provider: "feishu", appId: identity.appId, tenantId: identity.tenantId, userId: identity.userId, deviceId: "device_append", deviceProof: "ed25519-login", cliBridge: true, cliDocumentWrites: true } }) }).start();
  t.after(async () => { await sidecar.close(); proxy.close(); sourceAccess.close(); sessions.sessions.clear(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const provider = new SaasFeishuCliProvider({ environment: intent => intent ? sidecar.environment(intent) : sidecar.environment() });
  await assert.rejects(provider.documentAuthoring.appendToEnd(DOC, "## x\n\ny\n"));
  assert.equal(upstream.filter(call => call.method === "PUT").length, 0, "no write reached Feishu");
});
