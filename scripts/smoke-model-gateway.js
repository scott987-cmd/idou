// @requires live: 真实付费模型调用
import "../src/adopt-legacy-env.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { gatewayRuntimeConfig } from "../src/providers/codex/gateway-config.js";
import { CodexAppServerClient } from "../src/providers/codex/app-server-client.js";
import { runTurn } from "../src/application/turn.js";

// Explicit opt-in: never make paid calls from npm test or read an ambient key in
// the client. Run against an empty, disposable workspace with no Feishu content.
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live to authorize a small real Codex smoke test against the server's configured chat model (MiniMax or GLM)");
// The server's own chat-model settings, so this exercises whichever provider the
// deployment file selects.
const chat = await loadChatModelConfig();
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-live-smoke-"));
const workspace = path.join(directory, "workspace");
await mkdir(workspace);
const sessions = new SessionRegistry();
const session = sessions.issue({ tenantId: "development", userId: "smoke-test", deviceId: "local-smoke" });
let providerRequests = 0;
const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions,
  fetchImpl: async (url, options) => {
    providerRequests += 1;
    const request = JSON.parse(options.body);
    process.stdout.write(`${JSON.stringify({ stage: "provider_request", fields: Object.keys(request), tools: request.tools?.map((tool) => ({ type: tool.type, name: tool.name })) })}\n`);
    const response = await fetch(url, options);
    process.stdout.write(`${JSON.stringify({ stage: "provider_response", status: response.status })}\n`);
    return response;
  }, audit: (event) => process.stdout.write(`${JSON.stringify({ stage: "gateway", status: event.status })}\n`) });
server.on("request", (request) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks));
      process.stdout.write(`${JSON.stringify({ stage: "codex_request_shape", fields: Object.keys(body), tools: body.tools?.map((tool) => ({ type: tool.type, name: tool.name })) })}\n`);
    } catch {}
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` }), { mode: 0o600 });
const runtime = await gatewayRuntimeConfig({ controlPlane: { sessionFile }, codex: { dataDir: path.join(directory, "codex") } }, process.env, { model: chat.model });
const client = new CodexAppServerClient({ binary: process.env.IDOU_CODEX_BIN || "codex", cwd: workspace, env: runtime.env, configOverrides: runtime.overrides });
let commands = 0;
client.on("notification", (message) => {
  if (message.method === "item/completed" && message.params.item.type === "commandExecution") commands += 1;
});
client.on("serverRequest", (request) => client.respondError(request.id, -32601, "Smoke test does not approve external access"));
try {
  await client.start();
  process.stdout.write("Codex initialized\n");
  const started = await client.request("thread/start", { cwd: workspace, model: runtime.model, modelProvider: "idou", sandbox: "read-only", approvalPolicy: "never", config: runtime.overrides });
  process.stdout.write("Codex thread started\n");
  // GLM-5.3 reasons before every answer, so its turn gets more time; MiniMax
  // keeps the bound it was verified with.
  const turn = await runTurn(client, { threadId: started.thread.id, timeoutMs: chat.provider === "litellm" ? 300_000 : 120_000, input: [{ type: "text", text: "Run pwd with the shell tool, then reply with exactly GATEWAY_OK. Do not inspect other files or use network tools.", text_elements: [] }] });
  const reply = turn.items.filter((item) => item.type === "agentMessage").map((item) => item.text).join("\n");
  const passed = turn.status === "completed" && reply.includes("GATEWAY_OK") && commands > 0 && providerRequests >= 2;
  process.stdout.write(`${JSON.stringify({ passed, model: runtime.model, turnStatus: turn.status, commands, providerRequests, replyMatches: reply.includes("GATEWAY_OK"), error: turn.error?.message })}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  await client.stop();
  server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
