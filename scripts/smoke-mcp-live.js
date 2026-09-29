// @requires live: 真实付费模型调用
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { TaskService } from "../src/application/task-service.js";
import { TaskStore } from "../src/application/task-store.js";
import { createTaskRuntime } from "../src/application/task-runtime.js";
import { mcpReference } from "../src/application/mcp-connections.js";
import { loadConfig } from "../src/config.js";

if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live for a bounded paid MCP test against the server's configured chat model (MiniMax or GLM) using only synthetic echo data");
const chat = await loadChatModelConfig();
// GLM-5.3 reasons before every answer: a 1024-token cap would end its turn as
// response.incomplete, and its turn needs more time. MiniMax keeps the bounds it
// was verified with.
const thinking = chat.provider === "litellm";
const root = await mkdtemp(path.join(os.tmpdir(), "idou-mcp-live-")), workspace = path.join(root, "workspace"), callLog = path.join(root, "calls.txt");
await mkdir(workspace); await writeFile(callLog, "");
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "mcp-smoke", deviceId: "local" });
let calls = 0, approvals = 0, sawResult = false, service, task, timer;
const handled = new Set();
const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  if (calls >= 4) throw new Error("Synthetic MCP test request cap reached");
  calls++; const body = JSON.parse(options.body); body.max_output_tokens = thinking ? 8192 : 1024;
  // The tool's answer, not the prompt: the prompt itself names the marker, so
  // only a function_call_output item carrying it shows the result came back.
  const outputs = Array.isArray(body.input) ? body.input.filter((item) => item?.type === "function_call_output") : [];
  if (outputs.some((item) => JSON.stringify(item.output ?? "").includes("MCP_EXECUTED:synthetic-marker"))) sawResult = true;
  const response = await fetch(url, { ...options, body: JSON.stringify(body) });
  console.log(JSON.stringify({ stage: "provider", request: calls, status: response.status })); return response;
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
try {
  const config = await loadConfig(), pins = JSON.parse(await readFile("upstreams.lock.json", "utf8"));
  config.controlPlane = { sessionFile: path.join(root, "session.json"), baseUrl: `http://127.0.0.1:${server.address().port}` };
  await writeFile(config.controlPlane.sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: config.controlPlane.baseUrl }), { mode: 0o600 });
  config.codex.dataDir = path.join(root, "codex"); config.codex.expectedVersion = pins.codex.version; config.feishuBusinessLinked = false;
  config.chatModel = chat.model;
  const connection = { id: "demo", title: "Synthetic echo only", transport: "stdio", command: process.execPath, args: [path.resolve("scripts/fixtures/mcp-stdio.js"), callLog], enabledTools: ["echo"] };
  config.mcpConnections = [connection];
  service = new TaskService({ store: new TaskStore(path.join(root, "tasks")), runtimeFactory: (task) => createTaskRuntime(config, task) });
  await service.init();
  service.on("changed", (snapshot) => {
    for (const approval of snapshot.approvals) {
      if (handled.has(approval.id)) continue;
      handled.add(approval.id);
      let expected = false;
      try { const args = JSON.parse(approval.command); expected = approval.kind === "mcp" && approval.cwd === "demo" && Object.keys(args).length === 1 && args.text === "synthetic-marker" && approvals === 0; } catch {}
      if (expected) { approvals++; service.stop(task.id); }
      else service.approve(approval.id, "decline");
    }
  });
  task = await service.create({ mode: "cowork", cwd: workspace, mcpConnection: mcpReference(connection) });
  timer = setTimeout(() => service.stop(task.id), thinking ? 300_000 : 90000);
  await service.send(task.id, "This is a synthetic MCP integration test. Call the configured demo MCP echo tool exactly once with text synthetic-marker. Do not run shell commands, inspect files or use any other tools. After seeing MCP_EXECUTED:synthetic-marker in the tool result, reply exactly MCP_RESULT_VERIFIED.");
  await service.active.get(task.id)?.done.promise;
  const result = service.get(task.id);
  assert.equal(result.status, "interrupted", "the run must stop at the person's confirmation card"); assert.equal(approvals, 1); assert.equal(await readFile(callLog, "utf8"), ""); assert.equal(sawResult, false);
  assert.equal(result.messages.some((message) => message.role === "assistant" && message.text.includes("MCP_RESULT_VERIFIED")), false);
  assert.equal(result.activity.some((item) => item.type === "commandExecution"), false);
  console.log(JSON.stringify({ passed: true, pendingManual: "M01", model: chat.model, providerRequests: calls, actualMcpCalls: 0, stoppedAtConfirmation: true, syntheticDataOnly: true }));
} finally { clearTimeout(timer); await service?.close(); server.close(); server.closeAllConnections(); sessions.revoke(session.token); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
