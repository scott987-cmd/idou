// Synthetic, loopback-only MCP upstream. Never imported by production entry points.
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function syntheticMcpHttp({ credential = "synthetic-upstream-mcp-secret", json = false } = {}) {
  const state = { calls: [], authMatches: [], mode: "echo", entered: Promise.withResolvers(), release: Promise.withResolvers() }, transports = new Map(), servers = [];
  const server = createServer(async (req, res) => {
    try {
      state.authMatches.push(req.headers.authorization === `Bearer ${credential}`);
      if (req.headers.authorization !== `Bearer ${credential}`) { res.writeHead(401).end(); return; }
      let body;
      if (req.method === "POST") { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks)); }
      let transport = transports.get(req.headers["mcp-session-id"]);
      if (!transport && body?.method === "initialize") {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: json, onsessioninitialized: (id) => transports.set(id, transport), onsessionclosed: (id) => transports.delete(id) });
        const mcp = new Server({ name: "synthetic-enterprise-upstream", version: "1.0.0" }, { capabilities: { tools: {} } }); servers.push(mcp);
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["echo", "not_allowed"].map((name) => ({ name, description: name === "echo" ? "Echo a synthetic test marker" : "Must never be offered", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } })) }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
          state.calls.push(request.params); state.entered.resolve();
          if (state.mode === "wait") await state.release.promise;
          if (state.mode === "error") throw new Error(`Do not leak ${credential}`);
          return { content: [{ type: "text", text: state.mode === "credential" ? credential : `MCP_EXECUTED:${request.params.arguments.text}` }] };
        }); await mcp.connect(transport);
      }
      if (!transport) { res.writeHead(404).end(); return; }
      await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(500).end(); else res.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, state, async close() { state.release.resolve(); await Promise.all(servers.map((server) => server.close())); server.close(); server.closeAllConnections(); } };
}
