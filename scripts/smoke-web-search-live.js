// @requires live: 真实付费模型调用，并访问公网搜索
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
import { builtinConnectionRow } from "../src/application/builtin-connectors.js";
import { loadConfig } from "../src/config.js";

// The built-in web-fetch connector's web_search, end to end on the real path a
// coding task takes: the real configured chat model, the real pinned Codex, the
// built-in MCP server spawned over stdio, and the per-call approval card. Unlike
// the fixture-echo MCP smoke this reaches a real site (DuckDuckGo), so it is
// --live only. Automation proves that the tool is offered, that calling it
// raises an approval card, and that no search runs before a person acts. M01
// owns the affirmative path where real results return to the model.
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live: this makes real model calls and one real DuckDuckGo search");
const chat = await loadChatModelConfig();
const thinking = chat.provider === "litellm"; // GLM reasons before answering: bigger cap, longer turn
const root = await mkdtemp(path.join(os.tmpdir(), "idou-web-search-live-")), workspace = path.join(root, "workspace");
await mkdir(workspace);
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "web-search-smoke", deviceId: "local" });
const QUERY = "Node.js fs.readFile documentation";
let calls = 0, approvals = 0, approvedQuery = null, toolOutput = null, service, task, timer;
const handled = new Set();

const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  if (calls >= 6) throw new Error("Live web_search test request cap reached");
  calls++; const body = JSON.parse(options.body); body.max_output_tokens = thinking ? 8192 : 2048;
  // Only a function_call_output carrying the tool's own header proves the search
  // result travelled back into the model's context (the prompt never contains it).
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type === "function_call_output" && JSON.stringify(item.output ?? "").includes("的搜索结果")) toolOutput = typeof item.output === "string" ? item.output : JSON.stringify(item.output);
  }
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
  // Exactly what main.js prepends for a coding task once the capability is
  // enabled in 技能中心 -- no task-level binding.
  const builtin = builtinConnectionRow("web-fetch");
  assert.ok(builtin.enabledTools.includes("web_search"), "the built-in row must offer web_search");
  config.mcpConnections = [builtin];

  service = new TaskService({ store: new TaskStore(path.join(root, "tasks")), runtimeFactory: (task) => createTaskRuntime(config, task) });
  await service.init();
  service.on("changed", (snapshot) => {
    for (const approval of snapshot.approvals) {
      if (handled.has(approval.id)) continue;
      handled.add(approval.id);
      let expected = false;
      try {
        const args = JSON.parse(approval.command);
        expected = approval.kind === "mcp" && approval.cwd === "web-fetch" && typeof args.query === "string" && args.query.length > 0 && approvals === 0;
        if (expected) approvedQuery = args.query;
      } catch { /* not a tool-argument card */ }
      if (expected) { approvals++; service.stop(task.id); }
      else service.approve(approval.id, "decline");
    }
  });

  task = await service.create({ mode: "coding", cwd: workspace });
  timer = setTimeout(() => service.stop(task.id), thinking ? 300_000 : 120_000);
  await service.send(task.id, `This is a live integration test of the web_search tool. Call web_search exactly once with the query: ${QUERY}. Do not run any shell commands, do not read or write files, and do not call fetch_url. After you see the search results, reply with exactly WEB_SEARCH_VERIFIED followed by the hostname of the first result.`);
  await service.active.get(task.id)?.done.promise;

  const result = service.get(task.id);
  assert.equal(result.status, "interrupted", "the run must stop at the person's confirmation card");
  assert.equal(approvals, 1, "web_search must raise exactly one per-call approval card");
  assert.equal(approvedQuery, QUERY, "the card must show the query the model actually asked for");
  assert.equal(toolOutput, null, "search must not run before a person confirms");
  assert.equal(result.activity.some((item) => item.type === "commandExecution"), false, "no shell was run");
  assert.equal(result.messages.some((message) => message.role === "assistant" && message.text.includes("WEB_SEARCH_VERIFIED")), false);
  console.log(JSON.stringify({ passed: true, pendingManual: "M01", model: chat.model, providerRequests: calls, approvalCards: approvals, query: approvedQuery,
    stoppedAtConfirmation: true, actualSearches: 0 }));
} finally {
  clearTimeout(timer); await service?.close(); server.close(); server.closeAllConnections(); sessions.revoke(session.token);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
