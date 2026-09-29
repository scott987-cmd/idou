// @requires live: 真实付费模型调用
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
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
import { PreviewServers } from "../src/application/preview-servers.js";
import { loadConfig } from "../src/config.js";

// browser_preview driven by the real model, on the path a real coding task
// takes: the real configured chat model, the real pinned Codex, the browser
// connector spawned over stdio with this task's preview base on argv -- from the
// same PreviewServers the desktop uses -- and the per-call approval card.
// scripts/smoke-preview-browser-live.js proves the browser boundary with no
// model; this proves the agent half: the tool is offered, calling it raises one
// card naming the file, then stops before the tool runs. M01 owns the
// affirmative path proving that the page text reaches the model while the
// preview server's secret path never does.
//
// The page's marker exists only in the file, never in the prompt. The automatic
// half also fails if any shell command ran or if the marker reached the model
// before confirmation.
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live: this makes real model calls");
const chat = await loadChatModelConfig();
const thinking = chat.provider === "litellm"; // GLM reasons before answering: bigger cap, longer turn
const root = await mkdtemp(path.join(os.tmpdir(), "idou-preview-agent-live-")), workspace = path.join(root, "workspace");
await mkdir(workspace);
const MARKER = `PREVIEW_PAGE_${randomBytes(6).toString("hex").toUpperCase()}`;
await writeFile(path.join(workspace, "index.html"), `<!doctype html><meta charset="utf-8"><title>Preview check</title><h1>${MARKER}</h1>`);
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "preview-agent-smoke", deviceId: "local" });
const previews = new PreviewServers();
const handled = new Set(), cards = [];
let calls = 0, secret = null, requestBeforePreview = false, secretSentToModel = false, toolOutput = null, service, task, timer;

const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  if (calls >= 6) throw new Error("Live browser_preview test request cap reached");
  calls++; const body = JSON.parse(options.body); body.max_output_tokens = thinking ? 8192 : 2048;
  // Everything the model is sent, on every request: the secret path must be in none of it.
  if (!secret) requestBeforePreview = true;
  else if (options.body.includes(secret)) secretSentToModel = true;
  for (const item of Array.isArray(body.input) ? body.input : []) {
    const output = typeof item?.output === "string" ? item.output : JSON.stringify(item?.output ?? "");
    if (item?.type === "function_call_output" && output.includes(MARKER)) toolOutput = output;
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

  // What main.js builds for a coding task once 浏览器操作 is enabled: the
  // built-in browser row, carrying this task's own preview base.
  service = new TaskService({ store: new TaskStore(path.join(root, "tasks")), runtimeFactory: async (task) => {
    const previewBase = await previews.baseFor(task);
    assert.ok(previewBase, "a coding task with a folder must get a preview server");
    secret = new URL(previewBase).pathname.split("/").find(Boolean);
    return createTaskRuntime({ ...config, mcpConnections: [builtinConnectionRow("browser", { previewBase })] }, task);
  } });
  await service.init();
  service.on("changed", (snapshot) => {
    for (const approval of snapshot.approvals) {
      if (handled.has(approval.id)) continue; handled.add(approval.id);
      let args = null; try { args = JSON.parse(approval.command); } catch { /* not a tool-argument card */ }
      // One file, named relative to the folder. Anything else is declined, and fails the run below.
      const accept = approval.kind === "mcp" && approval.cwd === "browser" && args !== null && typeof args === "object"
        && Object.keys(args).every((key) => key === "path") && (args.path === undefined || args.path === "index.html");
      cards.push({ server: approval.cwd, reason: approval.reason, args, accept });
      console.log(JSON.stringify({ stage: "card", reason: approval.reason, args, decision: accept ? "wait-for-person" : "decline" }));
      if (accept) service.stop(task.id); else service.approve(approval.id, "decline");
    }
  });

  task = await service.create({ mode: "coding", cwd: workspace });
  timer = setTimeout(() => service.stop(task.id), thinking ? 300_000 : 120_000);
  await service.send(task.id, "This is a live integration test of the browser_preview tool. Call browser_preview exactly once with path index.html. Do not run any shell commands, do not read or write files, and do not call any other tool. After you see the page, reply with exactly PREVIEW_VERIFIED followed by the page's main heading text.");
  await service.active.get(task.id)?.done.promise;

  const result = service.get(task.id);
  assert.equal(result.status, "interrupted", "the run must stop at the person's confirmation card");
  assert.equal(cards.length, 1, `browser_preview must raise exactly one approval card (cards: ${JSON.stringify(cards)})`);
  assert.equal(cards[0].accept, true, `the card was not the expected browser_preview call: ${JSON.stringify(cards[0])}`);
  assert.equal(result.activity.some((item) => item.type === "mcpToolCall" && item.tool === "browser_preview" && item.status === "completed"), false, "browser_preview must not run before a person confirms");
  assert.equal(toolOutput, null, "page content must not reach the model before confirmation");
  assert.equal(requestBeforePreview, false, "a model request went out before the task's preview server existed, so the secret check could not cover it");
  assert.equal(secretSentToModel, false, "the preview server's secret path reached the model");
  assert.equal(result.activity.some((item) => item.type === "commandExecution"), false, "no shell was run");
  assert.equal(result.messages.some((message) => message.role === "assistant" && message.text.includes("PREVIEW_VERIFIED") && message.text.includes(MARKER)), false);
  console.log(JSON.stringify({ passed: true, model: chat.model, providerRequests: calls, approvalCards: cards.length, card: cards[0], marker: MARKER,
    pendingManual: "M01", stoppedAtConfirmation: true, pageTextReachedModel: false, secretNeverSentToModel: true }));
} finally {
  clearTimeout(timer); await service?.close(); previews.closeAll(); server.close(); server.closeAllConnections(); sessions.revoke(session.token);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
