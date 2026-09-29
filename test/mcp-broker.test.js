import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { McpBroker } from "../src/control-plane/mcp-broker.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { EnterpriseMcpClient } from "../src/application/enterprise-mcp.js";
import { syntheticMcpHttp } from "../scripts/fixtures/mcp-http.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const credential = "synthetic-upstream-mcp-secret";
const identity = { provider: "feishu", tenantId: "tenant_fixture", userId: "ou_fixture", appId: "cli_fixture" };
const config = (url) => ({ schemaVersion: 1, revision: 1, connections: [{ id: "demo", title: "Synthetic enterprise MCP", url, tokenEnv: "MCP_FIXTURE_KEY", grants: [{ tenantId: identity.tenantId, appId: identity.appId, userIds: [identity.userId], enabledTools: ["echo"] }] }] });
async function setup(t, json = false) {
  const upstream = await syntheticMcpHttp({ credential, json }), sessions = new SessionRegistry();
  let broker; const server = createModelGateway({ sessions, apiKey: "synthetic-model-secret", authHandler: (req, res) => broker.handle(req, res), fetchImpl: () => assert.fail("No model call expected") });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  broker = new McpBroker({ feishu: SAAS_FEISHU, origin, sessions, config: config(upstream.url), env: { MCP_FIXTURE_KEY: credential }, timeoutMs: 3000 });
  const parent = sessions.issue({ ...identity, deviceId: "device", authProvider: "feishu", deviceProof: "ed25519-login" });
  const current = { ...parent, serverUrl: origin, identity };
  const enterprise = new EnterpriseMcpClient({ getSession: async () => current });
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map((client) => client.close())); await broker.close(); server.close(); server.closeAllConnections(); await upstream.close(); });
  const post = (route, token, body = {}, headers = {}) => fetch(`${origin}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  const connect = async (lease) => { const client = new Client({ name: "synthetic-test", version: "1.0.0" }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/v1/mcp/demo`), { requestInit: { headers: { authorization: `Bearer ${lease.token}` } }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })); return client; };
  return { upstream, sessions, broker, parent, current, enterprise, origin, post, connect };
}

test("MCP leases are independent of skill tokens, bounded, resource scoped and revoked with parent", () => {
  let now = 1000; const sessions = new SessionRegistry({ now: () => now });
  const parent = sessions.issue({ ...identity, deviceId: "device", authProvider: "feishu", deviceProof: "ed25519-login" });
  const binding = { connectionId: "demo", policyDigest: "a".repeat(64), tools: ["echo"] };
  const child = sessions.issueForMcp(parent.token, binding); assert.equal(child.expiresAt, now + 300000);
  sessions.issueForSkills(parent.token); sessions.issueForSkills(parent.token); assert.ok(sessions.verify(child.token));
  assert.throws(() => sessions.issueForMcp(child.token, binding), /parent/);
  for (let i = 0; i < 5; i++) sessions.issueForMcp(parent.token, binding);
  assert.throws(() => sessions.issueForMcp(parent.token, binding), /limit/);
  const removed = []; sessions.on("revoked", (id) => removed.push(id)); sessions.revoke(parent.token);
  assert.equal(sessions.verify(child.token), null); assert.ok(removed.includes(child.id)); assert.equal(sessions.sessions.size, 0);
});
test("server validates MCP configuration and never accepts client-selected endpoints or development identity", async (t) => {
  const f = await setup(t);
  const rows = await f.enterprise.list(); assert.equal(rows.length, 1); assert.equal(rows[0].transport, "enterprise"); assert.doesNotMatch(JSON.stringify(rows), /secret|127\.0\.0\.1|tokenEnv/);
  const development = f.sessions.issue({ tenantId: identity.tenantId, userId: identity.userId, deviceId: "dev" });
  assert.equal((await f.post("/v1/mcp-connections", development.token)).status, 401);
  for (const change of [{ tenantId: "other" }, { userId: "other" }, { appId: "cli_other" }]) {
    const other = f.sessions.issue({ ...identity, ...change, deviceId: "device", authProvider: "feishu", deviceProof: "ed25519-login" });
    assert.deepEqual((await (await f.post("/v1/mcp-connections", other.token)).json()).connections, []);
    assert.equal((await f.post("/auth/mcp-token", other.token, { id: "demo", policyDigest: rows[0].policyDigest, enabledTools: ["echo"] })).status, 403);
  }
  assert.equal((await f.post("/auth/mcp-token", f.parent.token, { id: "demo", policyDigest: rows[0].policyDigest, enabledTools: ["echo"], url: "http://127.0.0.1/secret" })).status, 400);
  assert.equal((await f.post("/auth/mcp-token", f.parent.token, { id: "demo", policyDigest: rows[0].policyDigest, enabledTools: ["not_allowed"] })).status, 403);
  assert.equal((await f.post("/v1/mcp-connections", f.parent.token, {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.post("/v1/mcp/demo", f.parent.token, {})).status, 403);
  assert.equal(f.upstream.state.calls.length, 0);
  assert.throws(() => new McpBroker({ feishu: SAAS_FEISHU, origin: f.origin, sessions: f.sessions, config: config(f.upstream.url), env: {} }), /credential/);
});
for (const json of [false, true]) test(`actual authenticated MCP tools round trip with ${json ? "JSON" : "SSE"} upstream, scoped tools and no credential passthrough`, async (t) => {
  const f = await setup(t, json), row = (await f.enterprise.list())[0], lease = await f.enterprise.acquire(row), client = await f.connect(lease);
  assert.equal((await f.post("/v1/responses", lease.token, { model: "MiniMax-M3", input: "synthetic" })).status, 403);
  assert.equal((await f.post("/v1/mcp/other", lease.token, {})).status, 403);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["echo"]);
  await assert.rejects(client.callTool({ name: "not_allowed", arguments: { text: "synthetic" } }), /not allowed/); assert.equal(f.upstream.state.calls.length, 0);
  const output = await client.callTool({ name: "echo", arguments: { text: "synthetic" } }); assert.equal(output.content[0].text, "MCP_EXECUTED:synthetic");
  assert.equal(f.upstream.state.calls.length, 1); assert.ok(f.upstream.state.authMatches.every(Boolean));
  await lease.close(); assert.equal(f.sessions.verify(lease.token), null); assert.equal(f.broker.entries.size, 0);
});
test("upstream errors and exact credential echoes are not returned; there are no automatic tool retries", async (t) => {
  const f = await setup(t), lease = await f.enterprise.acquire((await f.enterprise.list())[0]), client = await f.connect(lease);
  await client.listTools();
  for (const mode of ["error", "credential"]) { f.upstream.state.mode = mode; await assert.rejects(client.callTool({ name: "echo", arguments: { text: "synthetic" } }), (error) => { assert.doesNotMatch(error.message, new RegExp(credential)); assert.match(error.message, /no automatic retry/); return true; }); }
  assert.equal(f.upstream.state.calls.length, 2);
});
test("one scoped lease supports separate runtime and discovery MCP sessions without cross-session access", async (t) => {
  const f = await setup(t), lease = await f.enterprise.acquire((await f.enterprise.list())[0]);
  const runtime = await f.connect(lease), discovery = await f.connect(lease);
  assert.deepEqual((await discovery.listTools()).tools.map((tool) => tool.name), ["echo"]);
  assert.equal((await runtime.callTool({ name: "echo", arguments: { text: "runtime" } })).content[0].text, "MCP_EXECUTED:runtime");
  const foreignLease = await f.enterprise.acquire((await f.enterprise.list())[0]), sessionId = [...f.broker.entries.keys()][0];
  assert.equal((await f.post("/v1/mcp/demo", foreignLease.token, { jsonrpc: "2.0", id: 101, method: "tools/list", params: {} }, { "mcp-session-id": sessionId })).status, 404);
  await f.connect(lease); await f.connect(lease);
  await assert.rejects(f.connect(lease), (error) => { assert.equal(error.code, 429); assert.match(error.message, /mcp_capacity_reached/); return true; });
  await lease.close(); assert.equal(f.broker.entries.size, 0);
});
test("malformed, oversized and unsupported MCP traffic cannot reach the upstream tools", async (t) => {
  const f = await setup(t), lease = await f.enterprise.acquire((await f.enterprise.list())[0]);
  assert.equal((await f.post("/v1/mcp/demo", lease.token, { method: "initialize" })).status, 400);
  assert.equal((await f.post("/v1/mcp/demo", lease.token, { jsonrpc: "2.0", id: 1, method: "initialize", padding: "x".repeat(1024 * 1024) })).status, 413);
  const client = await f.connect(lease), sid = [...f.broker.entries.keys()][0];
  for (const method of ["resources/read", "prompts/get", "sampling/createMessage", "tasks/get"]) assert.equal((await f.post("/v1/mcp/demo", lease.token, { jsonrpc: "2.0", id: 2, method, params: {} }, { "mcp-session-id": sid })).status, 400);
  await client.listTools(); assert.equal(f.upstream.state.calls.length, 0);
});
test("logout aborts an in-flight broker call and does not deliver a late result", async (t) => {
  const f = await setup(t), lease = await f.enterprise.acquire((await f.enterprise.list())[0]), client = await f.connect(lease);
  await client.listTools(); f.upstream.state.mode = "wait";
  const call = client.callTool({ name: "echo", arguments: { text: "synthetic" } }, undefined, { timeout: 3000 }); const rejected = assert.rejects(call);
  await f.upstream.state.entered.promise; f.sessions.revoke(f.parent.token); f.upstream.state.release.resolve(); await rejected;
  assert.equal(f.broker.entries.size, 0); assert.equal(f.sessions.verify(lease.token), null); assert.equal(f.upstream.state.calls.length, 1);
});
test("client detects policy withdrawal and account changes without using stale enterprise authority", async (t) => {
  const f = await setup(t), row = (await f.enterprise.list())[0];
  f.broker.config.revision++;
  await assert.rejects(f.enterprise.acquire(row), /撤回/);
  const changed = await f.enterprise.read((await f.enterprise.list())[0]);
  f.current.identity = { ...identity, userId: "other" }; await assert.rejects(f.enterprise.acquire(changed), /身份/);
});
