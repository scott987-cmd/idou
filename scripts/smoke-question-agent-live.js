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
import { loadConfig } from "../src/config.js";

// The Agent asking the person a question, driven by the real model on the path a
// real coding task takes: the configured chat model through the gateway, the
// real pinned Codex with features.default_mode_request_user_input on, and
// TaskService's question card. scripts/smoke-coding-task-desktop.js proves the
// card with a scripted model; this proves a real model uses the tool when told
// the decision is the person's, that its question arrives as a card with the
// options it offered, and that nothing more is asked of the model before the
// run stops. M07 owns the affirmative path where the person chooses an answer
// and the same turn acts on it.
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live: this makes real model calls");
const chat = await loadChatModelConfig();
const thinking = chat.provider === "litellm"; // GLM reasons before answering: bigger cap, longer turn
const root = await mkdtemp(path.join(os.tmpdir(), "idou-question-agent-live-")), workspace = path.join(root, "workspace");
await mkdir(workspace);
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "question-agent-smoke", deviceId: "local" });
const handled = new Set(), cards = [];
let calls = 0, callsWhenAsked = null, toolOutput = null, service, task, timer;

const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  if (calls >= 6) throw new Error("Live question test request cap reached");
  calls++; const body = JSON.parse(options.body); body.max_output_tokens = thinking ? 8192 : 2048;
  for (const item of Array.isArray(body.input) ? body.input : []) {
    const output = typeof item?.output === "string" ? item.output : JSON.stringify(item?.output ?? "");
    if (item?.type === "function_call_output" && output.includes('"answers"')) toolOutput = output;
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

  service = new TaskService({ store: new TaskStore(path.join(root, "tasks")), runtimeFactory: (task) => createTaskRuntime(config, task) });
  await service.init();
  service.on("changed", (snapshot) => {
    for (const approval of snapshot.approvals) {
      if (handled.has(approval.id)) continue; handled.add(approval.id);
      // The run asks for no command, file or tool: any such card is declined and fails the run.
      if (approval.kind !== "question") { cards.push({ kind: approval.kind, reason: approval.reason, declined: true }); service.approve(approval.id, "decline"); continue; }
      cards.push({ kind: "question", questions: approval.questions });
      console.log(JSON.stringify({ stage: "card", questions: approval.questions }));
      callsWhenAsked = calls;
      service.stop(task.id);
    }
  });

  task = await service.create({ mode: "coding", cwd: workspace });
  timer = setTimeout(() => service.stop(task.id), thinking ? 300_000 : 120_000);
  await service.send(task.id, "This is a live integration test of asking the person a question. Before doing anything else, call request_user_input once to ask which database this project should use, offering exactly two options labelled SQLite and Postgres. Do not run any shell commands, do not read or write files, and do not call any other tool. After you receive the answer, reply with exactly QUESTION_VERIFIED followed by the name of the database the person chose.");
  await service.active.get(task.id)?.done.promise;

  const result = service.get(task.id);
  assert.equal(result.status, "interrupted", "the run must stop at the person's question card");
  assert.equal(cards.some((card) => card.declined), false, `a card other than the question was raised: ${JSON.stringify(cards)}`);
  const asked = cards.filter((card) => card.kind === "question");
  assert.equal(asked.length, 1, `exactly one question card expected: ${JSON.stringify(cards)}`);
  const labels = asked[0].questions[0].options.map((option) => option.label);
  assert.ok(labels.some((label) => /sqlite/i.test(label)) && labels.some((label) => /postgres/i.test(label)), `the card should carry the two options the model offered: ${JSON.stringify(labels)}`);
  assert.equal(calls, callsWhenAsked, "the model was asked something more while the question was still open");
  assert.equal(toolOutput, null, "automation must not answer the person's question");
  assert.equal(result.activity.some((item) => item.type === "commandExecution"), false, "no shell was run");
  assert.equal(result.messages.some((message) => message.role === "assistant" && message.text.includes("QUESTION_VERIFIED")), false);
  console.log(JSON.stringify({ passed: true, pendingManual: "M07", model: chat.model, providerRequests: calls, question: asked[0].questions,
    stoppedAtQuestion: true, nothingAskedWhileOpen: true, answerReachedModel: false }));
} finally {
  clearTimeout(timer); await service?.close(); server.close(); server.closeAllConnections(); sessions.revoke(session.token);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
