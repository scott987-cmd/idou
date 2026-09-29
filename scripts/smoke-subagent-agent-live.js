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

// Subagents driven by the real model, on the path a real coding task takes and
// under the gateway's production limits (4 concurrent requests, 30 a minute per
// session, no retries): the configured chat model, the real pinned Codex with
// subagents on, the product gateway -- which admits the collaboration tools and
// frames agent_message items -- and TaskService's attribution.
//
// It proves the model delegates when asked, that the child's task reaches the
// child and its answer reaches the parent (LiteLLM drops the raw item type, so
// without the gateway's framing the child gets no task and the parent waits for
// nothing), and it measures what one delegation costs against those limits:
// requests, peak concurrency, and the busiest minute.
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live: this makes real model calls");
const chat = await loadChatModelConfig();
const thinking = chat.provider === "litellm"; // GLM reasons before answering: bigger cap, longer turn
const root = await mkdtemp(path.join(os.tmpdir(), "idou-subagent-agent-live-")), workspace = path.join(root, "workspace");
await mkdir(workspace);
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "subagent-agent-smoke", deviceId: "local" });
const starts = [], handled = new Set(), cards = [];
let calls = 0, active = 0, peak = 0, childRequests = 0, rawAgentMessages = 0, taskReachedChild = false, answerReachedParent = false, service, timer;
const started = Date.now();

// Concurrency is counted until each provider stream has been read to its end.
const tracked = (response) => {
  let open = true;
  const close = () => { if (open) { open = false; active -= 1; } };
  if (!response.body) { close(); return response; }
  const body = response.body.pipeThrough(new TransformStream({ flush() { close(); } }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  if (calls >= 24) throw new Error("Live subagent test request cap reached");
  // Numbered on the way in: two agents' requests can be waiting on the provider at once.
  calls += 1; const number = calls; starts.push(Date.now()); active += 1; peak = Math.max(peak, active);
  const body = JSON.parse(options.body); body.max_output_tokens = thinking ? 8192 : 2048;
  const input = Array.isArray(body.input) ? body.input : [], text = JSON.stringify(input);
  rawAgentMessages += input.filter((item) => item?.type === "agent_message").length;
  // A child is told it is "an agent in a team"; the parent that it is the primary one.
  const child = text.includes("You are an agent in a team of agents");
  if (child) { childRequests += 1; if (/agent \/root 发给 \/root\/[A-Za-z0-9_.-]+ 的消息/.test(text)) taskReachedChild = true; }
  else if (/agent \/root\/[A-Za-z0-9_.-]+ 发给 \/root 的消息/.test(text)) answerReachedParent = true;
  try {
    const response = await fetch(url, { ...options, body: JSON.stringify(body) });
    console.log(JSON.stringify({ stage: "provider", request: number, child, status: response.status, atMs: Date.now() - started }));
    return tracked(response);
  } catch (error) { active -= 1; throw error; }
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
      cards.push({ kind: approval.kind, reason: approval.reason, command: approval.command });
      // Nothing here needs a person's approval.  Refuse executable actions;
      // an unexpected question cannot be answered by automation, so stop the
      // run and let the card in the report explain the failure.
      if (approval.kind === "question") service.stop(task.id); else service.approve(approval.id, "decline");
    }
  });

  const task = await service.create({ mode: "coding", cwd: workspace });
  timer = setTimeout(() => service.stop(task.id), thinking ? 600_000 : 300_000);
  await service.send(task.id, "这是子 agent 功能的联机测试。请用 spawn_agent 派生恰好一个子 agent：task_name 用 counter，fork_turns 用 none，交给它的任务是「数一数单词 Kubernetes 有几个字母，只回复数字」。然后用 wait_agent 等它完成。你自己不要运行 shell 命令，也不要读写文件。收到它的结果后，只回复 SUBAGENT_VERIFIED 加上它报告的数字。");
  await service.active.get(task.id)?.done.promise;

  const result = service.get(task.id);
  const minute = Math.max(0, ...starts.map((at) => starts.filter((other) => other >= at && other < at + 60_000).length));
  const report = { model: chat.model, providerRequests: calls, childRequests, peakConcurrency: peak, busiestMinuteRequests: minute, elapsedMs: Date.now() - started,
    spawned: result.activity.filter((row) => row.type === "subAgentActivity").map((row) => row.agent), shellRuns: result.activity.filter((row) => row.type === "commandExecution").map((row) => [row.agent ?? "/root", row.command]),
    childMessages: result.messages.filter((message) => message.agent).map((message) => [message.agent, String(message.text).slice(0, 80)]), cards };
  console.log(JSON.stringify({ stage: "report", ...report }));
  assert.equal(result.status, "completed", `the live subagent task did not complete: ${result.error ?? ""}`);
  assert.ok(report.spawned.length >= 1, "the model never spawned a subagent");
  assert.ok(childRequests >= 1, "no request came from a child thread");
  assert.equal(taskReachedChild, true, "the child's task never reached it framed");
  assert.equal(answerReachedParent, true, "the child's answer never reached the parent");
  assert.equal(rawAgentMessages, 0, "an agent_message item reached the provider unframed");
  assert.ok(report.childMessages.length >= 1, "the child's words should be recorded as the child's");
  const final = result.messages.filter((message) => message.role === "assistant" && !message.agent).at(-1)?.text ?? "";
  assert.match(final, /SUBAGENT_VERIFIED/); assert.match(final, /10/);
  console.log(JSON.stringify({ passed: true, ...report, finalExcerpt: final.slice(0, 120), actualCodex: true, productionLimits: { maxConcurrent: 4, requestsPerMinute: 30 } }));
} finally {
  clearTimeout(timer); await service?.close(); server.close(); server.closeAllConnections(); sessions.revoke(session.token);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
