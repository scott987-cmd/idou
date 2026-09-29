import { randomUUID, createHash } from "node:crypto";
import { personOf } from "./limits.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { normalizeMcpConnection } from "../application/mcp-connections.js";
import { readCatalogConfigFile } from "./skill-catalog.js";
import { validateServerUrl } from "./client-session.js";

const LIMIT = 1024 * 1024;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
class BrokerError extends Error { constructor(status, code) { super(code); this.status = status; } }
// `feishu` is the deployment whose application a grant names.
function configuration(value, env, feishu) {
  if (!exact(value, ["schemaVersion", "revision", "connections"]) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.connections) || value.connections.length > 100) throw new Error("Invalid MCP broker configuration");
  const ids = new Set();
  return { revision: value.revision, connections: value.connections.map((row) => {
    if (!exact(row, ["id", "title", "url", "tokenEnv", "grants"]) || typeof row.tokenEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,99}$/.test(row.tokenEnv) || !Array.isArray(row.grants) || !row.grants.length || row.grants.length > 100) throw new Error("Invalid MCP broker connection");
    const endpoint = normalizeMcpConnection({ id: row.id, title: row.title, transport: "http", url: row.url, enabledTools: ["placeholder"] });
    if (ids.has(row.id)) throw new Error("Duplicate MCP connection"); ids.add(row.id);
    const credential = env[row.tokenEnv];
    if (typeof credential !== "string" || !/^[\x21-\x7e]{16,8192}$/.test(credential)) throw new Error("Server MCP credential missing or invalid");
    const grants = row.grants.map((grant) => {
      if (!exact(grant, ["tenantId", "appId", "userIds", "enabledTools"]) || !identifier(grant.tenantId) || !identifier(grant.appId) || !feishu.ids.app(grant.appId) || !Array.isArray(grant.userIds) || !grant.userIds.length || grant.userIds.length > 1000 || new Set(grant.userIds).size !== grant.userIds.length || grant.userIds.some((user) => !identifier(user) && user !== "*") || (grant.userIds.includes("*") && grant.userIds.length !== 1)) throw new Error("Invalid MCP grant");
      const tools = normalizeMcpConnection({ ...endpoint, enabledTools: grant.enabledTools }).enabledTools;
      return { ...grant, userIds: [...grant.userIds], enabledTools: tools };
    });
    if (new Set(grants.map((grant) => JSON.stringify([grant.tenantId, grant.appId]))).size !== grants.length) throw new Error("Duplicate MCP tenant/app grant");
    return { ...endpoint, grants, credential };
  }) };
}
async function readBody(req, limit) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json" || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) throw new BrokerError(415, "json_required");
  let length = 0; const chunks = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > limit) throw new BrokerError(413, "request_too_large"); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new BrokerError(400, "invalid_json"); }
}
function send(res, status, value) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value));
}

// A terminating tools broker, not transparent OAuth token passthrough. Upstream
// credentials and endpoints are administrator-configured; no caller-selected URL.
export class McpBroker {
  // Live MCP connections: four per session and eight per person, as before for
  // one person; the server's own bound is its capacity (IDOU_MCP_SESSIONS_MAX),
  // which was 32 for the whole pilot server.
  constructor({ origin, sessions, config, feishu, env = process.env, fetchImpl = fetch, now = Date.now, timeoutMs = 60000, capacity: { sessions: maxSessions = 1024 } = {} }) {
    if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) throw new Error("Invalid MCP capacity");
    this.maxSessions = maxSessions;
    Object.assign(this, { origin: validateServerUrl(origin), sessions, fetch: fetchImpl, now, timeoutMs });
    if (!feishu?.ids) throw new Error("The MCP broker needs the Feishu deployment its grants name");
    this.config = configuration(config, env, feishu); this.entries = new Map(); this.buckets = new Map(); this.retiring = new Set(); this.closed = false;
    this.onRevoke = (id) => { for (const entry of this.entries.values()) if (entry.identity.id === id) this.retire(entry); };
    sessions.on("revoked", this.onRevoke);
  }
  static async fromConfig({ origin, sessions, feishu, env = process.env, capacity }) {
    if (!env.IDOU_MCP_CONFIG_FILE) return null;
    try { return new McpBroker({ origin, sessions, feishu, env, capacity, config: JSON.parse(await readCatalogConfigFile(env.IDOU_MCP_CONFIG_FILE, LIMIT)) }); }
    catch { throw new Error("Invalid server MCP configuration or credential environment"); }
  }
  policy(identity, id) {
    const row = this.config.connections.find((row) => row.id === id), grant = row?.grants.find((grant) => grant.tenantId === identity.tenantId && grant.appId === identity.appId && (grant.userIds.includes("*") || grant.userIds.includes(identity.userId)));
    if (!grant) throw new BrokerError(403, "mcp_connection_not_allowed");
    const policyDigest = hash([this.config.revision, row.id, row.title, row.url, grant]);
    return { row, descriptor: { id: row.id, title: row.title, transport: "enterprise", policyDigest, enabledTools: [...grant.enabledTools] } };
  }
  check(token, identity) {
    if (this.closed || this.sessions.verify(token) !== identity) throw new BrokerError(401, "mcp_session_expired_or_invalid");
    const policy = this.policy(identity, identity.connectionId);
    if (policy.descriptor.policyDigest !== identity.policyDigest || identity.tools.some((tool) => !policy.descriptor.enabledTools.includes(tool))) throw new BrokerError(403, "mcp_policy_changed");
    return policy;
  }
  retire(entry) {
    if (entry.closing) return entry.closing;
    this.entries.delete(entry.id); clearTimeout(entry.timer); entry.controller.abort();
    entry.closing = (async () => {
      try { await entry.upstream.terminateSession(); } catch {}
      await Promise.allSettled([entry.client.close(), entry.server.close()]);
    })();
    this.retiring.add(entry.closing); void entry.closing.finally(() => this.retiring.delete(entry.closing)); return entry.closing;
  }
  async entry(token, identity, sessionId) {
    if (sessionId !== undefined) {
      const existing = this.entries.get(sessionId);
      if (!existing || existing.identity.id !== identity.id) throw new BrokerError(404, "mcp_session_not_found");
      await existing.ready; this.check(token, identity); return existing;
    }
    const mine = [...this.entries.values()].filter((entry) => personOf(entry.identity) === personOf(identity));
    if (this.entries.size >= this.maxSessions || mine.length >= 8 || mine.filter((entry) => entry.identity.id === identity.id).length >= 4) throw new BrokerError(429, "mcp_capacity_reached");
    const { row } = this.check(token, identity), controller = new AbortController();
    const client = new Client({ name: "idou-broker", version: "0.1.0" }, { capabilities: {} });
    const upstream = new StreamableHTTPClientTransport(new URL(row.url), { reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
      fetch: async (url, init = {}) => {
        if (String(url) !== row.url) throw new Error("Endpoint change rejected");
        if (init.method !== "DELETE") this.check(token, identity);
        const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), ...(init.method === "DELETE" ? [] : [controller.signal]), AbortSignal.timeout(init.method === "DELETE" ? 3000 : this.timeoutMs)]);
        const headers = new Headers(init.headers); headers.set("authorization", `Bearer ${row.credential}`);
        const response = await this.fetch(row.url, { ...init, headers, redirect: "error", signal });
        if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
        // Bound every upstream stream including unsolicited GET streams and errors.
        let bytes = 0;
        const body = response.body?.pipeThrough(new TransformStream({ transform(chunk, target) { bytes += chunk.byteLength; if (bytes > 4 * LIMIT) throw new Error("MCP response limit"); target.enqueue(chunk); } }));
        return new Response(body, { status: response.status, headers: response.headers });
      } });
    const server = new Server({ name: "idou-enterprise-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id, onsessionclosed: () => { this.retire(entry); } });
    const entry = { id, identity, client, server, upstream, transport, controller, calls: 0 };
    this.entries.set(id, entry);
    entry.timer = setTimeout(() => this.sessions.revoke(token), Math.max(1, identity.expiresAt - this.now())); entry.timer.unref();
    const guardResult = (value) => { this.check(token, identity); const text = JSON.stringify(value); if (Buffer.byteLength(text) > LIMIT || text.includes(row.credential) || text.includes(token)) throw new Error("Unsafe MCP response"); return value; };
    const failure = () => new McpError(ErrorCode.InternalError, "Enterprise MCP request failed; no automatic retry. Completion may be unknown.");
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      try {
        this.check(token, identity); const tools = [], seen = new Set(); let cursor;
        for (let page = 0; page < 10; page++) {
          const result = guardResult(await client.listTools(cursor ? { cursor } : {}, { signal: AbortSignal.any([extra.signal, controller.signal]), timeout: this.timeoutMs }));
          for (const tool of result.tools) { if (seen.has(tool.name) || seen.size >= 1000) throw new Error(); seen.add(tool.name); if (identity.tools.includes(tool.name)) tools.push(tool); }
          if (!result.nextCursor) { if (identity.tools.some((name) => !tools.some((tool) => tool.name === name))) throw new Error(); return guardResult({ tools }); }
          cursor = result.nextCursor;
        }
        throw new Error();
      } catch { throw failure(); }
    });
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      this.check(token, identity);
      if (!identity.tools.includes(request.params.name)) throw new McpError(ErrorCode.InvalidParams, "Tool not allowed");
      if (entry.calls >= 2) throw new McpError(ErrorCode.InvalidRequest, "MCP concurrency limit"); entry.calls++;
      try { return guardResult(await client.callTool({ name: request.params.name, arguments: request.params.arguments || {} }, undefined, { signal: AbortSignal.any([extra.signal, controller.signal]), timeout: this.timeoutMs })); }
      catch { throw failure(); } finally { entry.calls--; }
    });
    client.onerror = () => {}; server.onerror = () => {};
    entry.ready = (async () => {
      try { await client.connect(upstream, { signal: controller.signal, timeout: Math.min(this.timeoutMs, 15000) }); this.check(token, identity); await server.connect(transport); return entry; }
      catch { this.retire(entry); throw new BrokerError(502, "mcp_upstream_unavailable"); }
    })();
    return entry.ready;
  }
  async handle(req, res) {
    const route = req.url, match = /^\/v1\/mcp\/([a-z][a-z0-9_-]{0,39})$/.exec(route);
    const catalog = route === "/v1/mcp-connections", issue = route === "/auth/mcp-token", revoke = route === "/auth/mcp-revoke";
    if (!match && !catalog && !issue && !revoke) return false;
    try {
      if (this.closed) throw new BrokerError(503, "mcp_broker_closed");
      if (req.headers.origin) throw new BrokerError(403, "native_client_required");
      if (!(match ? ["POST", "GET", "DELETE"] : ["POST"]).includes(req.method)) throw new BrokerError(405, "method_not_allowed");
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "", identity = this.sessions.verify(token);
      if (!identity || identity.authProvider !== "feishu") throw new BrokerError(401, "feishu_session_required");
      if (identity.audience !== (match || revoke ? "mcp-broker" : "codex-model-gateway")) throw new BrokerError(403, "mcp_audience_required");
      const now = this.now(); for (const [key, bucket] of this.buckets) if (bucket.until <= now) this.buckets.delete(key);
      const bucketKey = identity.parentKey || identity.id, bucket = this.buckets.get(bucketKey) || { count: 0, until: now + 60000 };
      if (++bucket.count > 120) throw new BrokerError(429, "mcp_request_limit"); this.buckets.set(bucketKey, bucket);
      const body = req.method === "POST" ? await readBody(req, match ? LIMIT : 8192) : undefined;
      if (this.sessions.verify(token) !== identity) throw new BrokerError(401, "session_expired_or_invalid");
      if (revoke) { if (!exact(body, [])) throw new BrokerError(400, "invalid_request"); this.sessions.revoke(token); send(res, 200, { revoked: true }); }
      else if (catalog) {
        if (!exact(body, [])) throw new BrokerError(400, "invalid_request");
        const connections = this.config.connections.flatMap((row) => { try { return [this.policy(identity, row.id).descriptor]; } catch { return []; } });
        send(res, 200, { revision: this.config.revision, tenantId: identity.tenantId, userId: identity.userId, appId: identity.appId, connections });
      } else if (issue) {
        if (!exact(body, ["id", "policyDigest", "enabledTools"])) throw new BrokerError(400, "invalid_request");
        const { descriptor } = this.policy(identity, body.id);
        if (descriptor.policyDigest !== body.policyDigest || !Array.isArray(body.enabledTools) || !body.enabledTools.length || body.enabledTools.some((tool) => !descriptor.enabledTools.includes(tool))) throw new BrokerError(403, "mcp_policy_mismatch");
        let child; try { child = this.sessions.issueForMcp(token, { connectionId: body.id, policyDigest: body.policyDigest, tools: body.enabledTools }); } catch { throw new BrokerError(429, "mcp_lease_limit"); }
        send(res, 200, { token: child.token, expiresAt: child.expiresAt, audience: child.audience, connectionId: child.connectionId, policyDigest: child.policyDigest, enabledTools: child.tools });
      } else {
        if (identity.connectionId !== match[1] || !identity.scopes.includes("mcp:tools")) throw new BrokerError(403, "mcp_connection_scope_required");
        this.check(token, identity);
        const sessionId = req.headers["mcp-session-id"];
        if (!sessionId && (req.method !== "POST" || body?.method !== "initialize")) throw new BrokerError(400, "mcp_initialize_required");
        if (req.method === "POST" && (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || !["initialize", "notifications/initialized", "notifications/cancelled", "ping", "tools/list", "tools/call"].includes(body.method))) throw new BrokerError(400, "mcp_method_not_supported");
        const entry = await this.entry(token, identity, sessionId); this.check(token, identity);
        res.setHeader("cache-control", "no-store"); res.setHeader("x-accel-buffering", "no");
        await entry.transport.handleRequest(req, res, body);
      }
    } catch (error) { send(res, error instanceof BrokerError ? error.status : 502, { error: error instanceof BrokerError ? error.message : "mcp_broker_unavailable" }); req.resume(); }
    return true;
  }
  async close() { this.closed = true; this.sessions.off("revoked", this.onRevoke); for (const entry of this.entries.values()) this.retire(entry); await Promise.all([...this.retiring]); }
}
