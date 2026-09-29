// @requires live: 真实付费模型调用，并在真实屏幕上移动鼠标、输入
import "../src/adopt-legacy-env.js";
import { execFile } from "node:child_process";
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
import { loadConfig } from "../src/config.js";

// Computer control driven by the real model, on the path a real coding task
// takes: the real configured chat model, the real pinned Codex, the computer
// connector spawned over stdio, and the per-call approval card.
// scripts/smoke-computer-live.js exercises every tool with no model; this proves
// the agent half -- the tool is offered, its call raises a card carrying the
// exact arguments, and an approved call lands in a real window.
//
// It touches one scratch document and nothing else. The run refuses to start
// while TextEdit is open, so no document of the person's can be typed into or
// closed. Automation now stops at the expected card and verifies that the
// document is still untouched. M01 covers the person's affirmative path.
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live: this makes real model calls, and the model types into a real TextEdit window");
if (process.platform !== "darwin") throw new Error("Computer control is macOS-only");
const osa = (script) => new Promise((resolve, reject) => {
  execFile("/usr/bin/osascript", ["-e", script], { timeout: 20_000 }, (error, stdout, stderr) =>
    error ? reject(new Error(String(stderr || error.message).split("\n")[0])) : resolve(stdout.trim()));
});
if (await osa('application "TextEdit" is running') === "true") throw new Error("TextEdit is already running: save your work and quit it first -- this smoke closes every TextEdit document without saving when it ends");

const chat = await loadChatModelConfig();
const thinking = chat.provider === "litellm"; // GLM reasons before answering: bigger cap, longer turn
const root = await mkdtemp(path.join(os.tmpdir(), "idou-computer-agent-live-")), workspace = path.join(root, "workspace");
await mkdir(workspace);
const MARKER = `IDOU_AGENT_TYPED_${randomBytes(5).toString("hex")}`;
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "computer-agent-smoke", deviceId: "local" });
const handled = new Set(), cards = [];
let calls = 0, openedTextEdit = false, service, task, timer;

const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  if (calls >= 8) throw new Error("Live computer-control test request cap reached");
  calls++; const body = JSON.parse(options.body); body.max_output_tokens = thinking ? 8192 : 2048;
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
  // Exactly what main.js prepends for a coding task once 电脑操作 is enabled.
  config.mcpConnections = [builtinConnectionRow("computer")];

  service = new TaskService({ store: new TaskStore(path.join(root, "tasks")), runtimeFactory: (task) => createTaskRuntime(config, task) });
  await service.init();
  service.on("changed", (snapshot) => {
    for (const approval of snapshot.approvals) {
      if (handled.has(approval.id)) continue; handled.add(approval.id);
      let args = null; try { args = JSON.parse(approval.command); } catch { /* not a tool-argument card */ }
      const tool = String(approval.reason ?? "").match(/computer_[a-z]+/)?.[0] ?? null;
      const keys = args !== null && typeof args === "object" ? Object.keys(args).sort().join(",") : null;
      // Only computer_type takes a text field, so typing is recognised by its
      // arguments even if the card's wording never names the tool.
      const typing = keys === "app,text" && args.app === "TextEdit" && args.text === MARKER && (tool === null || tool === "computer_type");
      const looking = tool === "computer_windows" && keys === "app" && args.app === "TextEdit";
      const accept = approval.kind === "mcp" && approval.cwd === "computer" && (typing || looking);
      cards.push({ server: approval.cwd, tool, reason: approval.reason, args, accept, typing });
      console.log(JSON.stringify({ stage: "card", tool, reason: approval.reason, args, decision: accept ? "wait-for-person" : "decline" }));
      if (accept) service.stop(task.id); else service.approve(approval.id, "decline");
    }
  });

  // The scratch document, in a TextEdit this run launched.
  openedTextEdit = true;
  await osa('tell application "TextEdit" to activate');
  await osa('tell application "TextEdit" to make new document');
  await new Promise((resolve) => setTimeout(resolve, 800));

  task = await service.create({ mode: "coding", cwd: workspace });
  timer = setTimeout(() => service.stop(task.id), thinking ? 300_000 : 120_000);
  await service.send(task.id, `This is a live integration test of computer control. A new, empty TextEdit document is already open. Call computer_type exactly once with app "TextEdit" and text "${MARKER}". Do not call any other tool, do not run any shell commands, and do not read or write files. After the tool reports success, reply with exactly COMPUTER_VERIFIED.`);
  await service.active.get(task.id)?.done.promise;

  const result = service.get(task.id);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const readBack = await osa('tell application "TextEdit" to get text of document 1');
  assert.equal(result.status, "interrupted", "the run must stop at the person's confirmation card");
  assert.deepEqual(cards.filter((card) => !card.accept), [], "a card outside the policy was raised");
  assert.equal(cards.filter((card) => card.typing).length, 1, "computer_type must raise exactly one approval card");
  assert.equal(result.activity.some((item) => item.type === "mcpToolCall" && item.tool === "computer_type" && item.status === "completed"), false, "computer_type must not run before a person confirms");
  assert.equal(readBack.includes(MARKER), false, `automation typed into the document before confirmation: ${JSON.stringify(readBack.slice(0, 120))}`);
  assert.equal(result.activity.some((item) => item.type === "commandExecution"), false, "no shell was run");
  assert.equal(result.messages.some((message) => message.role === "assistant" && message.text.includes("COMPUTER_VERIFIED")), false);
  console.log(JSON.stringify({ passed: true, model: chat.model, providerRequests: calls, approvalCards: cards.length, cards, marker: MARKER,
    pendingManual: "M01", stoppedAtConfirmation: true, typedIntoRealWindow: false }));
} finally {
  clearTimeout(timer); await service?.close(); server.close(); server.closeAllConnections(); sessions.revoke(session.token);
  if (openedTextEdit) {
    await osa('tell application "TextEdit" to close every document saving no').catch(() => {});
    await osa('tell application "TextEdit" to quit').catch(() => {});
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
