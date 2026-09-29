import { normalizeMcpConnection } from "./mcp-connections.js";
import { validateServerUrl } from "../control-plane/client-session.js";
import { CLOCK_SKEW_MS } from "./clock-skew.js";

export class EnterpriseMcpClient {
  constructor({ getSession, fetchImpl = fetch, now = Date.now }) { Object.assign(this, { getSession, fetch: fetchImpl, now }); this.revision = 0; }
  async request(origin, route, token, body) {
    const response = await this.fetch(`${origin}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    if (route === "/auth/mcp-revoke" && response.status === 401) { await response.body?.cancel(); return { revoked: true }; }
    if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("application/json")) { await response.body?.cancel(); throw Object.assign(new Error(`企业 MCP 服务不可用（HTTP ${response.status}），未沿用旧授权。`), { status: response.status }); }
    let size = 0; const chunks = [], reader = response.body.getReader();
    try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new Error("企业 MCP 响应超限"); } chunks.push(Buffer.from(value)); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new Error("企业 MCP 响应无效"); }
  }
  async session() {
    const value = await this.getSession();
    if (value.identity?.provider !== "feishu" || value.expiresAt <= this.now()) throw new Error("请先完成飞书登录并确认账号，再获取企业 MCP");
    return { ...value, serverUrl: validateServerUrl(value.serverUrl) };
  }
  async unchanged(session) {
    const current = await this.session();
    if (current.token !== session.token || current.serverUrl !== session.serverUrl || ["tenantId", "userId", "appId"].some((key) => current.identity[key] !== session.identity[key])) throw new Error("登录身份已变化，未使用旧企业 MCP 授权");
  }
  async listFor(session) {
    const result = await this.request(session.serverUrl, "/v1/mcp-connections", session.token, {});
    if (["tenantId", "userId", "appId"].some((key) => result[key] !== session.identity[key]) || !Number.isSafeInteger(result.revision) || result.revision < Math.max(1, this.revision) || !Array.isArray(result.connections) || result.connections.length > 100) throw new Error("企业 MCP 身份、版本或目录无效");
    const connections = result.connections.map(normalizeMcpConnection);
    if (connections.some((row) => row.transport !== "enterprise") || new Set(connections.map((row) => row.id)).size !== connections.length) throw new Error("企业 MCP 目录无效");
    await this.unchanged(session); this.revision = result.revision; return connections;
  }
  async list() { return this.listFor(await this.session()); }
  async read(reference) {
    const rows = await this.list(), row = rows.find((row) => row.id === reference?.id);
    if (!row || row.policyDigest !== reference.policyDigest) throw new Error("企业 MCP 已撤回或策略变化，请刷新并重新确认");
    return row;
  }
  async acquire(connection) {
    const row = normalizeMcpConnection(connection), session = await this.session();
    const current = (await this.listFor(session)).find((item) => item.id === row.id);
    if (row.transport !== "enterprise" || !current || current.policyDigest !== row.policyDigest || row.enabledTools.some((tool) => !current.enabledTools.includes(tool))) throw new Error("企业 MCP 已撤回或工具授权变化");
    const lease = await this.request(session.serverUrl, "/auth/mcp-token", session.token, { id: row.id, policyDigest: row.policyDigest, enabledTools: row.enabledTools });
    const validToken = typeof lease.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(lease.token);
    let closed = false;
    const close = async () => { if (closed) return; if (validToken) await this.request(session.serverUrl, "/auth/mcp-revoke", lease.token, {}); closed = true; };
    try {
      if (!validToken || lease.audience !== "mcp-broker" || lease.connectionId !== row.id || lease.policyDigest !== row.policyDigest || JSON.stringify(lease.enabledTools) !== JSON.stringify(row.enabledTools) || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= this.now() || lease.expiresAt > Math.min(session.expiresAt, this.now() + 300000 + CLOCK_SKEW_MS)) throw new Error("企业 MCP 短期授权无效");
      await this.unchanged(session);
      return { token: lease.token, expiresAt: lease.expiresAt, origin: session.serverUrl, connectionId: row.id, policyDigest: row.policyDigest, envName: "IDOU_MCP_BROKER_TOKEN", close };
    } catch (error) { await close().catch(() => {}); throw error; }
  }
}
