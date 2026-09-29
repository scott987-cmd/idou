import test from "node:test";
import assert from "node:assert/strict";
import { EnterpriseMcpClient } from "../src/application/enterprise-mcp.js";
import { CLOCK_SKEW_MS } from "../src/application/clock-skew.js";
import { normalizeMcpConnection, mcpOverrides, readMcpImport } from "../src/application/mcp-connections.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const identity = { provider: "feishu", tenantId: "tenant", userId: "user", appId: "cli_fixture" };
const row = { id: "demo", title: "Synthetic", transport: "enterprise", policyDigest: "a".repeat(64), enabledTools: ["echo"] };
function setup(changeLease = (lease) => lease) {
  let session = { token: "p".repeat(43), expiresAt: 901000, serverUrl: "https://configured.example", identity }; const requests = [];
  const client = new EnterpriseMcpClient({ now: () => 1000, getSession: async () => session, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, "error"); requests.push({ url, token: options.headers.authorization, body: JSON.parse(options.body) });
    if (url.endsWith("/v1/mcp-connections")) return Response.json({ revision: 1, tenantId: "tenant", userId: "user", appId: "cli_fixture", connections: [row] });
    if (url.endsWith("/auth/mcp-token")) return Response.json(changeLease({ token: "m".repeat(43), expiresAt: 301000, audience: "mcp-broker", connectionId: "demo", policyDigest: row.policyDigest, enabledTools: ["echo"] }));
    return Response.json({ revoked: true });
  } });
  return { client, requests, switchAccount() { session = { ...session, token: "q".repeat(43), identity: { ...identity, userId: "other" } }; } };
}
// A deployment without IDOU_MCP_CONFIG_FILE has no such route. The desktop
// lists nothing then, rather than showing an error, and it can only tell that
// apart from a real failure by the status the error carries.
test("a server that offers no enterprise MCP answers 404, and the error carries it", async () => {
  const { client } = setup(); client.fetch = async () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  await assert.rejects(client.list(), (error) => error.status === 404 && /HTTP 404/.test(error.message));
  client.fetch = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(client.list(), (error) => error.status === 503);
});
test("enterprise MCP descriptors cannot import client keys or endpoints and require native broker authorization", async () => {
  assert.deepEqual(normalizeMcpConnection(row).enabledTools, ["echo"]);
  assert.throws(() => normalizeMcpConnection({ ...row, url: "https://evil.example" }));
  assert.throws(() => mcpOverrides([row], "/tmp"), /短期授权/);
  const lease = { origin: "https://configured.example", connectionId: "demo", policyDigest: row.policyDigest, envName: "IDOU_MCP_BROKER_TOKEN" };
  const override = mcpOverrides([row], "/tmp", { demo: lease }).demo;
  assert.equal(override.url, "https://configured.example/v1/mcp/demo"); assert.equal(override.bearer_token_env_var, lease.envName); assert.equal(override.default_tools_approval_mode, "prompt");
  assert.throws(() => mcpOverrides([row], "/tmp", { demo: { ...lease, origin: "http://evil.example" } }));
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-enterprise-import-test-"));
  try { const filename = path.join(root, "connection.json"); await writeFile(filename, JSON.stringify(row)); await assert.rejects(readMcpImport(filename), /无法导入/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test("a late account change revokes the just-issued token at its original origin", async () => {
  const f = setup((lease) => { f.switchAccount(); return lease; });
  await assert.rejects(f.client.acquire(row), /登录身份已变化/);
  const cleanup = f.requests.at(-1); assert.equal(cleanup.url, "https://configured.example/auth/mcp-revoke"); assert.equal(cleanup.token, `Bearer ${"m".repeat(43)}`);
});
test("wrong resource, expanded tools, wrong audience and excessive lifetime fail lease validation and are revoked", async () => {
  for (const patch of [{ connectionId: "other" }, { enabledTools: ["echo", "extra"] }, { audience: "codex-model-gateway" }, { expiresAt: 1000 + 300000 + CLOCK_SKEW_MS + 1 }, { policyDigest: "b".repeat(64) }]) {
    const f = setup((lease) => ({ ...lease, ...patch })); await assert.rejects(f.client.acquire(row), /短期授权无效/); assert.match(f.requests.at(-1).url, /mcp-revoke$/);
  }
});
test("native lease closure is idempotent and expired authorization needs no further privilege", async () => {
  const f = setup(), lease = await f.client.acquire(row); await lease.close(); await lease.close(); assert.equal(f.requests.filter((request) => request.url.endsWith("mcp-revoke")).length, 1);
  const expired = setup(), oldLease = await expired.client.acquire(row); expired.client.fetch = async () => new Response(null, { status: 401 }); await oldLease.close();
});
