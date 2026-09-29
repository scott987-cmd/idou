// Isolated standard MCP fixture. No production imports, credentials or network.
import readline from "node:readline";
import { appendFileSync } from "node:fs";
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  if (request.method === "initialize") return send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "idou-synthetic-mcp", version: "1.0.0" } });
  if (request.method === "tools/list") return send(request.id, { tools: [{ name: "echo", description: "Echo a synthetic test marker", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } }, { name: "not_allowed", description: "Must never be offered", inputSchema: { type: "object" } }] });
  if (request.method === "tools/call" && request.params.name === "echo") {
    if (process.argv[2]) appendFileSync(process.argv[2], "echo-called\n");
    return send(request.id, { content: [{ type: "text", text: `MCP_EXECUTED:${request.params.arguments.text}` }] });
  }
  if (request.method === "ping") return send(request.id, {});
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported fixture method" } })}\n`);
});
