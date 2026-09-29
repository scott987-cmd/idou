import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TaskStore } from "../src/application/task-store.js";
import { TaskService, upstreamFailure } from "../src/application/task-service.js";
import { readWorkspaceFile } from "../src/application/workspace-files.js";
import { getPermission } from "../src/modes.js";
import { agentTool } from "../src/application/knowledge-commands.js";
import { diffReviewLines, taskProjectDiff } from "../src/application/project-files.js";

async function setup(t, behavior = "complete") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-tasks-"));
  // Closed before its folder goes, in one hook: a turn a test leaves running
  // saves its record every second, a save landing mid-removal fails the
  // removal, and Node then skips the later hooks -- so the service was never
  // closed and the file never exited (seen once in a full run).
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = [], clients = [];
  const store = new TaskStore(path.join(directory, "records"));
  service = new TaskService({ store, runtimeFactory: async (task) => {
    const client = new EventEmitter(); clients.push(client); client.start = async () => {}; client.stop = async () => {};
    client.respond = (id, result) => calls.push({ method: "respond", id, result });
    client.respondError = (id, code) => calls.push({ method: "reject", id, code });
    client.request = async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start" || method === "thread/resume") return { thread: { id: "codex-thread" } };
      if (method === "thread/fork") return { thread: { id: "codex-thread-fork" } };
      if (method === "review/start") return { turn: { id: "review-turn" }, reviewThreadId: params.threadId };
      if (method === "turn/start") {
        if (behavior === "complete") {
          client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "codex-thread", itemId: `answer-${calls.length}`, delta: "实际回复" } });
          client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
        }
        return { turn: { id: "turn" } };
      }
      return {};
    }; return { client, params: {}, mcpConnectionIds: task?.mcpConnection ? [task.mcpConnection.id] : [],
      builtinConnections: task?.mcpConnection?.builtin ? [{ id: task.mcpConnection.id, title: task.mcpConnection.title }] : [] };
  } });
  await service.init();
  const task = await service.create({ mode: "cowork", cwd: directory });
  return { directory, store, service, task, clients, calls };
}

async function finished(service, id) { await service.active.get(id)?.done.promise; }

// 2026-09-23: a work task's Agent sent a document to a chat, saw the command
// still running 20 seconds later, decided nobody would answer, and ended its
// turn. Stopping Codex at the end of the turn ended the command that asked,
// and that withdrew the card before the person reached it. Codex itself keeps
// such a command running and reports its end after the turn (measured on
// 0.155.0; test/codex-background-command.test.js holds that side).
async function pendingWrite(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-pending-write-"));
  let service, release, client;
  t.after(async () => { release?.(); await service?.close(); await rm(directory, { recursive: true, force: true }); });
  // Resolves true: there was a write, and it is over (AgentBridge.settled).
  const writes = new Promise((resolve) => { release = () => resolve(true); });
  const events = [];
  const store = new TaskStore(path.join(directory, "records"));
  service = new TaskService({ store, writesSettled: () => writes, runtimeFactory: async () => {
    client = new EventEmitter(); client.start = async () => {}; client.stop = async () => { events.push("codex stopped"); };
    client.respond = () => {}; client.respondError = () => {};
    client.request = async (method) => {
      if (method === "thread/start" || method === "thread/resume") return { thread: { id: "codex-thread" } };
      if (method !== "turn/start") return {};
      client.emit("notification", { method: "item/started", params: { threadId: "codex-thread", item: { id: "share", type: "commandExecution", status: "inProgress",
        command: "/bin/zsh -c 'node agent.js doc-share --recipient b6508edf --note-file cio_note.md'" } } });
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "codex-thread", itemId: "answer", delta: "已发起发送，请在弹出的确认里点确认。" } });
      client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
      return { turn: { id: "turn" } };
    };
    return { client, params: {}, mcpConnectionIds: [] };
  } });
  await service.init();
  const task = await service.create({ mode: "cowork", cwd: directory });
  await service.send(task.id, "把这 3 条发到这个会话里");
  // Until the answer is on screen and Codex is still up behind the card.
  for (let i = 0; i < 100 && service.get(task.id).status !== "completed"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return { service, task, events, release: () => release(), client: () => client, directory };
}
function reportShareEnded(f) {
  f.events.push("command reported");
  f.client().emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { id: "share", type: "commandExecution", status: "completed", exitCode: 0,
    command: "/bin/zsh -c 'node agent.js doc-share --recipient b6508edf --note-file cio_note.md'", aggregatedOutput: "{\"sent\":true,\"recipient\":\"青岚科技\"}\n" } } });
}

test("a turn that ends while its write waits on the card keeps Codex up until the card is answered", async (t) => {
  const f = await pendingWrite(t);
  assert.equal(f.service.get(f.task.id).status, "completed", "the answer is shown while the card is up");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(f.events, [], "Codex is not stopped under a card the person has not answered");
  await assert.rejects(f.service.send(f.task.id, "再发一次"), /确认卡片等你处理/);
  // The person confirms. In this order, as it happened on 2026-09-23: the
  // bridge answers (the write is over), and only then does the command that
  // asked end and Codex report it. Stopping Codex at the first of these lost
  // the second -- the step stayed 进行中 although the message had gone.
  f.release();
  setTimeout(() => reportShareEnded(f), 150);
  await finished(f.service, f.task.id);
  assert.deepEqual(f.events, ["command reported", "codex stopped"], "Codex is stopped only after it has reported the command's end");
  const step = f.service.get(f.task.id).activity.find((entry) => entry.id === "share");
  assert.equal(step.status, "completed");
  assert.match(step.output, /"sent":true/);
  assert.equal(f.service.get(f.task.id).status, "completed");
});

test("stopping a task that waits on its write's card withdraws it at once and keeps the finished turn", async (t) => {
  const f = await pendingWrite(t);
  f.service.stop(f.task.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(f.events, ["codex stopped"], "stopping ends the command that asked, which withdraws the card");
  f.release(); await finished(f.service, f.task.id);
  assert.equal(f.service.get(f.task.id).status, "completed", "the turn had finished; only the card was withdrawn");
  assert.equal(f.service.get(f.task.id).error ?? null, null);
});

// 2026-09-23: looking for a setting, a work task's Agent ran `env`; the write
// bridge's key went into the step's recorded output, on disk and on screen,
// while the screen was being recorded for a promotional video.
test("a secret the Agent's shell holds never reaches the task's record, its words or the screen", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-secrets-"));
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive: true, force: true }); });
  const bridgeKey = `bridge-${"k".repeat(32)}`, proxyKey = `proxy-${"p".repeat(32)}`;
  const store = new TaskStore(path.join(directory, "records"));
  service = new TaskService({ store, runtimeFactory: async () => {
    const client = new EventEmitter(); client.start = async () => {}; client.stop = async () => {};
    client.respond = () => {}; client.respondError = () => {};
    client.request = async (method) => {
      if (method === "thread/start" || method === "thread/resume") return { thread: { id: "codex-thread" } };
      if (method !== "turn/start") return {};
      client.emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { id: "env", type: "commandExecution", status: "completed",
        command: `/bin/zsh -c 'env | grep -E "IDOU|LARKSUITE"; echo ${proxyKey}'`,
        aggregatedOutput: `LARKSUITE_CLI_CONFIG_DIR=/tmp/cli\nIDOU_FEISHU_BRIDGE=http://127.0.0.1:52746\nIDOU_FEISHU_BRIDGE_KEY=${bridgeKey}\nLARKSUITE_CLI_PROXY_KEY=${proxyKey}\n` } } });
      // An answer that quotes a key, arriving in two pieces that split it.
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "codex-thread", itemId: "answer", delta: `找到了，密钥是 ${bridgeKey.slice(0, 15)}` } });
      client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "codex-thread", itemId: "answer", delta: bridgeKey.slice(15) } });
      client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
      return { turn: { id: "turn" } };
    };
    // What createTaskRuntime reports from the environment it starts Codex with.
    return { client, params: {}, mcpConnectionIds: [], secrets: [bridgeKey, proxyKey] };
  } });
  await service.init();
  const task = await service.create({ mode: "cowork", cwd: directory });
  await service.send(task.id, "找一下媒体的配置在哪");
  await finished(service, task.id); await store.flush();
  const record = service.get(task.id), disk = await readFile(path.join(directory, "records", `${task.id}.json`), "utf8");
  for (const [where, text] of [["the record in memory", JSON.stringify(record)], ["the record on disk", disk]]) {
    assert.equal(text.includes(bridgeKey), false, `the bridge key is in ${where}`);
    assert.equal(text.includes(proxyKey), false, `the proxy key is in ${where}`);
  }
  const step = record.activity.find((entry) => entry.id === "env");
  assert.match(step.output, /IDOU_FEISHU_BRIDGE_KEY=〔已隐藏〕/);
  assert.match(step.output, /IDOU_FEISHU_BRIDGE=http:\/\/127\.0\.0\.1:52746/, "what is not a secret stays readable");
  assert.match(step.command, /echo 〔已隐藏〕/);
  assert.equal(record.messages.at(-1).text, "找到了，密钥是 〔已隐藏〕");
});

test("a new preflight failure replaces a prior task error without retaining the rejected message or starting tools", async t => {
  const f = await setup(t); f.service.get(f.task.id).status = "failed"; f.service.get(f.task.id).error = "previous proposal failure";
  f.service.contextResolver = async () => { throw new Error("current source permission revoked"); };
  let snapshot; f.service.on("changed", value => { snapshot = value; });
  await assert.rejects(f.service.send(f.task.id, "must not retain", { kind: "feishu-sheet" }), /permission revoked/);
  assert.equal(snapshot.tasks[0].error, "current source permission revoked"); assert.equal(snapshot.tasks[0].messages.length, 0); assert.equal(f.clients.length, 0);
});

test("sheet proposals bypass Codex, skills and MCP, preserve typed drafts and reject invalid model cells", async t => {
  const f = await setup(t); let reads = 0;
  const context = { kind: "feishu-sheet", intent: "propose-edit", rows: [{ row: 2, cells: [{ address: "B2", value: "00123" }] }] };
  f.service.contextResolver = async () => { reads++; return context; };
  f.service.get(f.task.id).enterpriseSkill = { id: "unused" }; f.service.skillResolver = () => assert.fail("no skills");
  f.service.get(f.task.id).mcpConnection = { id: "unused" };
  let address = "B2";
  f.service.proposalGenerator = async (prompt, signal, nativeContext) => {
    assert.match(prompt, /spreadsheet writeback is not available/); assert.deepEqual(nativeContext, context); assert.ok(signal);
    return JSON.stringify({ kind: "feishu-sheet-edit", changes: [{ address, value: "00456" }] });
  };
  await f.service.send(f.task.id, "修改编号", { kind: "feishu-sheet", intent: "propose-edit", handle: "native" }); await finished(f.service, f.task.id);
  assert.equal(f.clients.length, 0); assert.equal(reads, 2); assert.equal(f.service.get(f.task.id).status, "completed");
  assert.equal(JSON.parse((await f.store.load()).tasks[0].messages[1].text).changes[0].value, "00456");
  address = "Z99"; await f.service.send(f.task.id, "越界建议", { kind: "feishu-sheet", intent: "propose-edit" }); await finished(f.service, f.task.id);
  assert.equal(f.service.get(f.task.id).status, "failed"); assert.equal(f.service.get(f.task.id).messages.filter(m => m.role === "assistant").length, 1); assert.equal(f.clients.length, 0);
});
test("stop during post-proposal source revalidation aborts reads and never persists the late draft", async t => {
  const f = await setup(t), entered = Promise.withResolvers(); let reads = 0;
  f.service.contextResolver = async (_task, _input, { signal }) => {
    if (++reads > 1) { entered.resolve(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
    return { kind: "feishu-sheet", intent: "propose-edit", rows: [{ row: 2, cells: [{ address: "B2", value: "00123" }] }] };
  };
  f.service.proposalGenerator = async () => '{"kind":"feishu-sheet-edit","changes":[{"address":"B2","value":"00456"}]}';
  await f.service.send(f.task.id, "修改", { kind: "feishu-sheet", intent: "propose-edit" }); await entered.promise;
  f.service.stop(f.task.id); await finished(f.service, f.task.id);
  assert.equal(f.service.get(f.task.id).status, "interrupted"); assert.equal(f.service.get(f.task.id).messages.length, 1); assert.equal(f.clients.length, 0);
});

test("stop propagates to context preparation before starting a runtime or persisting a message", async t => {
  const f = await setup(t), entered = Promise.withResolvers();
  f.service.contextResolver = async (_task, _input, { signal }) => { entered.resolve(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("context cancelled")), { once: true })); };
  const sending = f.service.send(f.task.id, "read sheet", { kind: "feishu-sheet" }); const denied = assert.rejects(sending, /context cancelled/);
  await entered.promise; f.service.stop(f.task.id); await denied;
  assert.equal(f.clients.length, 0); assert.equal(f.service.get(f.task.id).messages.length, 0); assert.equal(f.service.active.size, 0);
});
test("document edit suggestions use a tool-free generator and revalidate before persisting an inert answer, without Codex or skill execution", async (t) => {
  const f = await setup(t); let reads = 0, models = 0;
  f.service.contextResolver = async () => { reads++; return { kind: "feishu-document", intent: "propose-edit", text: "原文" }; };
  f.service.get(f.task.id).enterpriseSkill = { id: "unused" }; f.service.skillResolver = () => assert.fail("proposal must not execute skill");
  f.service.proposalGenerator = async prompt => { models++; assert.match(prompt, /Do not execute commands/); return '{"kind":"feishu-text-edit","replacement":"新文"}'; };
  await f.service.send(f.task.id, "润色选区", { kind: "feishu-document", intent: "propose-edit" }); await finished(f.service, f.task.id);
  assert.equal(f.service.get(f.task.id).status, "completed"); assert.equal(reads, 2); assert.equal(models, 1); assert.equal(f.clients.length, 0);
  assert.equal((await f.store.load()).tasks[0].messages[1].role, "assistant"); assert.equal(f.service.get(f.task.id).codexThreadId, null);
});
test("revoked document and stopping during proposal generation discard the answer with no runtime or write", async (t) => {
  for (const stop of [false, true]) {
    const f = await setup(t), gate = Promise.withResolvers(); let reads = 0;
    f.service.contextResolver = async () => { if (++reads > 1 && !stop) throw new Error("revoked"); return { kind: "feishu-document", intent: "propose-edit" }; };
    f.service.proposalGenerator = () => gate.promise;
    await f.service.send(f.task.id, "rewrite", { kind: "feishu-document", intent: "propose-edit" });
    if (stop) f.service.stop(f.task.id); gate.resolve('{"kind":"feishu-text-edit","replacement":"late"}'); await finished(f.service, f.task.id);
    assert.equal(f.service.get(f.task.id).messages.length, 1); assert.equal(f.clients.length, 0); assert.equal(f.service.get(f.task.id).status, stop ? "interrupted" : "failed");
  }
});
async function waitFor(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error("Timed out waiting for test state"); }

test("desktop task streams, persists actual messages and resumes the same Codex thread", async (t) => {
  const { service, task, store, calls } = await setup(t);
  await service.send(task.id, "整理工作内容"); await finished(service, task.id);
  assert.equal(calls.find((call) => call.method === "thread/start").params.config, undefined, "an ordinary turn keeps the thread's own effort");
  assert.equal(service.get(task.id).status, "completed");
  assert.deepEqual(service.get(task.id).messages.map((item) => item.text), ["整理工作内容", "实际回复"]);
  const restored = await store.load();
  assert.equal(restored.tasks[0].codexThreadId, "codex-thread");
  assert.equal(restored.tasks[0].messages[1].text, "实际回复");
  await service.send(task.id, "继续完善"); await finished(service, task.id);
  assert.equal(calls.filter((call) => call.method === "thread/start").length, 1);
  assert.equal(calls.find((call) => call.method === "thread/resume").params.threadId, "codex-thread");
});
test("runtime credential-cleanup warnings survive task completion and persistence", async (t) => {
  const f = await setup(t), factory = f.service.runtimeFactory;
  f.service.runtimeFactory = async (...args) => { const runtime = await factory(...args); runtime.client.stop = async () => { runtime.client.cleanupWarning = "Synthetic cleanup unconfirmed"; }; return runtime; };
  await f.service.send(f.task.id, "synthetic"); await finished(f.service, f.task.id);
  assert.equal(f.service.get(f.task.id).status, "completed"); assert.equal((await f.store.load()).tasks[0].error, "Synthetic cleanup unconfirmed");
});

test("skill refusal happens before user-message persistence or runtime startup", async (t) => {
  const f = await setup(t); f.service.get(f.task.id).enterpriseSkill = { id: "enterprise-test", version: "1.0.0", digest: "a".repeat(64) };
  f.service.skillResolver = async () => { throw new Error("skill withdrawn"); };
  await assert.rejects(f.service.send(f.task.id, "must not dispatch"), /withdrawn/);
  assert.equal(f.clients.length, 0); assert.equal(f.service.get(f.task.id).messages.length, 0); assert.equal(f.service.active.size, 0);
});

test("the task passes its confirmed MCP binding to skill preparation and its narrowed lease to runtime, not persistent storage", async (t) => {
  const f = await setup(t), binding = { id: "demo", digest: "b".repeat(64), enabledTools: ["echo"] };
  const reference = { id: "enterprise-test", version: "1.0.0", digest: "a".repeat(64), title: "test" };
  const task = await f.service.create({ mode: "cowork", cwd: f.directory, enterpriseSkill: reference, mcpConnection: binding });
  const lease = { reference, mcpConnections: [{ id: "demo", enabledTools: ["echo"] }], root: "/synthetic/root", path: "/synthetic/root/SKILL.md", verify: async () => {}, beforeTurn: async () => {}, close: async () => {} };
  f.service.skillResolver = async (ref, signal, received) => { assert.equal(ref.digest, reference.digest); assert.equal(signal.aborted, false); assert.deepEqual(received, binding); return lease; };
  const factory = f.service.runtimeFactory;
  f.service.runtimeFactory = async (task, received) => {
    assert.equal(received, lease); const runtime = await factory(task), request = runtime.client.request;
    runtime.client.request = (method, params) => method === "skills/list" ? { data: [{ skills: [{ name: reference.id, path: lease.path, enabled: true }] }] } : request(method, params);
    return runtime;
  };
  await f.service.send(task.id, "use bound tools"); await finished(f.service, task.id);
  assert.equal(f.service.get(task.id).status, "completed");
  const restored = (await f.store.load()).tasks.find((row) => row.id === task.id); assert.deepEqual(restored.mcpConnection, binding);
  assert.equal(restored.mcpConnections, undefined); assert.doesNotMatch(JSON.stringify(restored), /synthetic\/root/);
});

test("stopping while skill preparation is pending retires a late lease and never starts a model", async (t) => {
  const f = await setup(t), entered = Promise.withResolvers(), gate = Promise.withResolvers(); let closed = 0;
  f.service.get(f.task.id).enterpriseSkill = { id: "enterprise-test", version: "1.0.0", digest: "a".repeat(64) };
  f.service.skillResolver = async () => { entered.resolve(); await gate.promise; return { close: async () => { closed++; } }; };
  const sending = f.service.send(f.task.id, "must not dispatch"); await entered.promise; f.service.stop(f.task.id); gate.resolve();
  await assert.rejects(sending, /取消/); assert.equal(closed, 1); assert.equal(f.clients.length, 0); assert.equal(f.service.active.size, 0);
});

test("failed Codex skill registration cleans its lease without sending a model turn", async (t) => {
  const f = await setup(t); let closed = 0;
  const reference = { id: "enterprise-test", version: "1.0.0", digest: "a".repeat(64), title: "test" };
  f.service.get(f.task.id).enterpriseSkill = reference;
  f.service.skillResolver = async () => ({ reference, root: "/synthetic/root", path: "/synthetic/root/SKILL.md", verify: async () => {}, close: async () => { closed++; } });
  await f.service.send(f.task.id, "must not dispatch"); await finished(f.service, f.task.id);
  assert.equal(f.service.get(f.task.id).status, "failed"); assert.equal(closed, 1); assert.equal(f.calls.some((call) => call.method === "turn/start"), false);
  assert.equal(f.service.get(f.task.id).messages[0].skill.digest, reference.digest);
  assert.doesNotMatch(JSON.stringify((await f.store.load()).tasks), /synthetic\/root/);
});

test("withdrawal after Codex startup blocks the model turn and closes the runtime before retiring skill files", async (t) => {
  const f = await setup(t), lifecycle = [];
  const reference = { id: "enterprise-test", version: "1.0.0", digest: "a".repeat(64), title: "test" };
  f.service.get(f.task.id).enterpriseSkill = reference;
  f.service.skillResolver = async () => ({ reference, root: "/synthetic/root", path: "/synthetic/root/SKILL.md", verify: async () => {},
    beforeTurn: async () => { lifecycle.push("revalidate"); throw new Error("withdrawn during startup"); }, close: async () => { lifecycle.push("files closed"); } });
  const runtimeFactory = f.service.runtimeFactory;
  f.service.runtimeFactory = async (...args) => {
    const runtime = await runtimeFactory(...args), request = runtime.client.request;
    runtime.client.request = async (method, params) => {
      if (method === "skills/list") return { data: [{ skills: [{ name: reference.id, path: "/synthetic/root/SKILL.md", enabled: true }] }] };
      return request(method, params);
    };
    runtime.client.stop = async () => { lifecycle.push("runtime stopped"); };
    return runtime;
  };
  await f.service.send(f.task.id, "must not dispatch"); await finished(f.service, f.task.id);
  assert.equal(f.calls.some((call) => call.method === "thread/start"), true);
  assert.equal(f.calls.some((call) => call.method === "turn/start"), false);
  assert.deepEqual(lifecycle, ["revalidate", "runtime stopped", "files closed"]);
  const saved = (await f.store.load()).tasks[0];
  assert.equal(saved.status, "failed"); assert.match(saved.error, /withdrawn during startup/);
  assert.equal(saved.messages.filter((message) => message.role === "assistant").length, 0);
});

test("same task cannot double-send; stop rejects stale approvals and preserves partial output", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "开始");
  await assert.rejects(service.send(task.id, "重复发送"), /仍在执行/);
  await waitFor(() => calls.some((call) => call.method === "turn/start"));
  clients[0].emit("notification", { method: "item/agentMessage/delta", params: { threadId: "codex-thread", itemId: "partial", delta: "部分结果" } });
  clients[0].emit("serverRequest", { id: 100, method: "item/commandExecution/requestApproval", params: { threadId: "codex-thread", itemId: "cmd", command: "echo approved" } });
  const approval = service.snapshot().approvals[0], approvalId = approval.id;
  assert.equal(approval.turnKey, service.get(task.id).messages.find((message) => message.role === "user").id);
  assert.equal(approval.itemId, "cmd");
  assert.equal(service.get(task.id).status, "awaiting_approval");
  service.approve(approvalId, "accept");
  assert.throws(() => service.approve(approvalId, "accept"), /失效/);
  assert.deepEqual(calls.find((call) => call.method === "respond").result, { decision: "accept" });
  service.stop(task.id); await finished(service, task.id);
  assert.equal(service.get(task.id).status, "interrupted");
  assert.equal(service.get(task.id).messages.at(-1).text, "部分结果");
  assert.equal(clients[0].listenerCount("stopped"), 0);
});

test("a subagent's own thread reaches the task once announced; an unannounced thread never does", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "开始");
  await waitFor(() => calls.some((call) => call.method === "turn/start"));

  // A thread nobody announced is refused outright — relaxing the guard for
  // subagents must not open it to anything else.
  clients[0].emit("serverRequest", { id: 500, method: "item/commandExecution/requestApproval", params: { threadId: "stranger-thread", itemId: "x", command: "echo stranger" } });
  assert.deepEqual(service.snapshot().approvals, [], "an unknown thread must never raise a card");
  assert.ok(calls.some((call) => call.method === "reject" && call.id === 500));
  clients[0].emit("notification", { method: "item/completed", params: { threadId: "stranger-thread", item: { type: "commandExecution", id: "ghost", status: "completed", command: "echo ghost" } } });
  assert.equal(service.get(task.id).activity.length, 0, "an unknown thread's activity is still dropped");

  // Codex announces the subagent's thread on this task's own thread, and from
  // then on that thread's work and approvals are this task's business.
  clients[0].emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "subAgentActivity", id: "sub-1", agentThreadId: "child-thread", agentPath: "worker" } } });
  clients[0].emit("serverRequest", { id: 501, method: "item/commandExecution/requestApproval", params: { threadId: "child-thread", itemId: "cmd", command: "npm test" } });
  const approvals = service.snapshot().approvals;
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].taskId, task.id, "the card belongs to the parent task");
  assert.equal(approvals[0].command, "npm test");
  service.approve(approvals[0].id, "accept");
  assert.ok(calls.some((call) => call.method === "respond" && call.id === 501));

  service.stop(task.id); await finished(service, task.id);
});

// A subagent's words and steps are shown as the subagent's own, not as this
// task's Agent speaking; the same item id on two threads stays two items; and a
// file change the subagent makes still opens to its diff in the approval card,
// although its item ids are qualified by its thread.
test("a subagent's messages and steps are labelled as its own, and its file approvals still carry the diff", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "开始");
  await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const emit = (threadId, method, item) => clients[0].emit("notification", { method, params: { threadId, item } });
  emit("codex-thread", "item/completed", { type: "subAgentActivity", id: "call_spawn", kind: "started", agentThreadId: "child-thread", agentPath: "/root/worker" });
  emit("codex-thread", "item/completed", { type: "agentMessage", id: "msg_1", text: "我先派一个子 agent" });
  emit("child-thread", "item/completed", { type: "agentMessage", id: "msg_1", text: "子任务做完了" });
  emit("child-thread", "item/completed", { type: "commandExecution", id: "cmd_1", status: "completed", command: "npm test", exitCode: 0, aggregatedOutput: "ok\n" });
  emit("child-thread", "item/started", { type: "fileChange", id: "patch_1", status: "inProgress", changes: [{ path: "a.js", kind: "add", diff: "+x" }] });
  const current = service.get(task.id);
  assert.deepEqual(current.messages.filter((message) => message.role === "assistant").map((message) => [message.text, message.agent ?? null]),
    [["我先派一个子 agent", null], ["子任务做完了", "/root/worker"]], "one id on two threads is two messages, and the child's is labelled");
  assert.deepEqual(current.activity.map((row) => [row.type, row.agent ?? null]), [["subAgentActivity", "/root/worker"], ["commandExecution", "/root/worker"], ["fileChange", "/root/worker"]]);
  clients[0].emit("serverRequest", { id: 510, method: "item/fileChange/requestApproval", params: { threadId: "child-thread", itemId: "patch_1", reason: "写文件" } });
  const card = service.snapshot().approvals[0];
  assert.equal(card?.kind, "file", "the subagent's file change raises a card instead of being declined for a missing diff");
  assert.equal(card.itemId, "child-thread:patch_1");
  assert.equal(card.agent, "/root/worker");
  assert.deepEqual(card.changes.map((change) => change.path), ["a.js"]);
  service.approve(card.id, "decline");
  service.stop(task.id); await finished(service, task.id);
});

test("process restart marks incomplete work as interrupted, never silently restarts paid work", async (t) => {
  const { store, service, task } = await setup(t);
  await store.save({ ...task, status: "running" });
  const restored = new TaskService({ store, runtimeFactory: () => assert.fail("must not execute") });
  await restored.init();
  assert.equal(restored.get(task.id).status, "interrupted");
  assert.match(restored.get(task.id).error, /未完成/);
  assert.equal(service.active.size, 0);
});

test("legacy planning records migrate to an explicit read-only state with a safe task-owned target", async (t) => {
  const { store, service, directory } = await setup(t);
  const old = await service.create({ mode: "coding", cwd: directory, permission: "full" });
  const record = structuredClone(service.get(old.id));
  record.permission = "full";
  delete record.executionPermission;
  delete record.planningKind;
  delete record.planningAfterSeq;
  await store.save(record);
  const restored = new TaskService({ store, runtimeFactory: () => assert.fail("migration must not execute") });
  t.after(() => restored.close());
  await restored.init();
  assert.equal(restored.get(old.id).permission, "plan");
  assert.equal(restored.get(old.id).executionPermission, "standard");
  assert.equal(restored.get(old.id).planningKind, "initial");
  const persisted = (await store.load()).tasks.find((task) => task.id === old.id);
  assert.equal(persisted.permission, "plan");
  assert.equal(persisted.executionPermission, "standard");
});

test("a moved task directory refuses creation and sending before a message or runtime starts", async (t) => {
  const { service, directory, calls } = await setup(t);
  const project = path.join(directory, "project");
  await mkdir(project);
  const task = await service.create({ mode: "coding", cwd: project, permission: "standard" });
  await rm(project, { recursive: true });
  await assert.rejects(service.send(task.id, "do not run"), /目录已移动或不可用/);
  assert.equal(service.get(task.id).messages.length, 0);
  assert.equal(service.active.size, 0);
  assert.equal(calls.length, 0);
  await assert.rejects(service.create({ mode: "coding", cwd: project, permission: "standard" }), /目录已移动或不可用/);
});

test("corrupt records survive unchanged and task path traversal is rejected", async (t) => {
  const { directory, store, service } = await setup(t);
  const invalid = path.join(directory, "records", "broken.json");
  await writeFile(invalid, "broken-content");
  const result = await store.load(); assert.equal(result.warnings.length, 1);
  assert.equal(await readFile(invalid, "utf8"), "broken-content");
  assert.throws(() => service.get("../../secret"), /Invalid task/);
});

test("file approval without the actual diff is declined", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "修改文件"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  clients[0].emit("serverRequest", { id: 200, method: "item/fileChange/requestApproval", params: { threadId: "codex-thread", itemId: "missing" } });
  assert.deepEqual(calls.find((call) => call.method === "respond").result, { decision: "decline" });
  assert.equal(service.snapshot().approvals.length, 0);
});

test("a command's output is kept in the activity record, only its end", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "跑测试"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const long = `${"x".repeat(5000)}\nTESTS FAILED: 2`;
  clients[0].emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "commandExecution", id: "cmd-1", status: "failed", command: "npm test", exitCode: 1, aggregatedOutput: long, durationMs: 1234 } } });
  clients[0].emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "commandExecution", id: "cmd-2", status: "completed", command: "true", exitCode: 0, aggregatedOutput: null, durationMs: 3 } } });
  const [failed, quiet] = service.get(task.id).activity;
  assert.equal(failed.output.length, 2001); assert.ok(failed.output.startsWith("…")); assert.ok(failed.output.endsWith("TESTS FAILED: 2"));
  assert.equal(failed.durationMs, 1234);
  assert.equal("output" in quiet, false); assert.equal(quiet.durationMs, 3);
});

test("the Agent's plan is kept on the task as it updates it, and a new message starts without one", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "分步做"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  clients[0].emit("notification", { method: "turn/plan/updated", params: { threadId: "codex-thread", turnId: "turn", explanation: "先读后改",
    plan: [{ step: "读代码", status: "completed" }, { step: "改实现", status: "inProgress" }, { step: "跑测试", status: "pending" }, { step: "坏数据", status: "unknown" }] } });
  assert.deepEqual(service.get(task.id).plan, { turnId: "turn", explanation: "先读后改", steps: [{ step: "读代码", status: "completed" }, { step: "改实现", status: "inProgress" }, { step: "跑测试", status: "pending" }] });
  clients[0].emit("notification", { method: "turn/plan/updated", params: { threadId: "another-thread", turnId: "other", plan: [] } });
  assert.equal(service.get(task.id).plan.steps.length, 3, "another thread's plan is ignored");
  clients[0].emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);
  assert.equal(service.get(task.id).plan.steps.length, 3, "a finished turn's plan stays visible");
  await service.send(task.id, "继续");
  assert.equal(service.get(task.id).plan, null);
});

test("a command approval can cover the rest of the turn; an MCP call cannot", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  service.get(task.id).mcpConnection = { id: "demo" };
  await service.send(task.id, "运行测试"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  clients[0].emit("serverRequest", { id: 300, method: "item/commandExecution/requestApproval", params: { threadId: "codex-thread", itemId: "cmd", command: "npm test" } });
  service.approve(service.snapshot().approvals[0].id, "acceptForSession");
  assert.deepEqual(calls.find((call) => call.id === 300).result, { decision: "acceptForSession" });
  clients[0].emit("serverRequest", { id: 301, method: "mcpServer/elicitation/request", params: { threadId: "codex-thread", turnId: "turn", serverName: "demo", mode: "form", message: "Allow?", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} } } });
  const mcp = service.snapshot().approvals[0].id;
  assert.throws(() => service.approve(mcp, "acceptForSession"), /无效/);
  assert.throws(() => service.approve(mcp, "always"), /无效/);
  assert.equal(calls.some((call) => call.id === 301), false);
});

test("the Agent's questions wait for the person's answer; a secret is never collected", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "帮我选"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const questions = [{ id: "db", header: "数据库", question: "用哪个数据库？", options: [{ label: "SQLite", description: "单文件" }, { label: "Postgres", description: "独立服务" }] },
    { id: "name", header: "名称", question: "服务叫什么？", isOther: true, options: null }];
  clients[0].emit("serverRequest", { id: 400, method: "item/tool/requestUserInput", params: { threadId: "codex-thread", turnId: "turn", itemId: "ask", isBlocking: true, questions } });
  const pending = service.snapshot().approvals[0];
  assert.equal(pending.kind, "question"); assert.equal(service.get(task.id).status, "awaiting_approval");
  assert.deepEqual(pending.questions.map((question) => [question.id, question.options.length, question.isOther]), [["db", 2, false], ["name", 0, true]]);
  assert.equal(calls.some((call) => call.id === 400), false, "nothing reaches the model before the person answers");
  assert.throws(() => service.answer(pending.id, { db: "MySQL" }), /选项/);
  assert.throws(() => service.approve(pending.id, "accept"), /无效/);
  service.answer(pending.id, { db: "SQLite", name: "账单服务" });
  assert.deepEqual(calls.find((call) => call.id === 400).result, { answers: { db: { answers: ["SQLite"] }, name: { answers: ["账单服务"] } } });
  assert.throws(() => service.answer(pending.id, {}), /失效/);
  assert.equal(service.get(task.id).status, "running");

  clients[0].emit("serverRequest", { id: 401, method: "item/tool/requestUserInput", params: { threadId: "codex-thread", turnId: "turn", itemId: "secret", isBlocking: true, questions: [{ id: "token", header: "令牌", question: "粘贴 API key", isSecret: true, options: null }] } });
  assert.deepEqual(calls.find((call) => call.id === 401).result, { answers: { token: { answers: [] } } });
  assert.equal(service.snapshot().approvals.length, 0);

  clients[0].emit("serverRequest", { id: 402, method: "item/tool/requestUserInput", params: { threadId: "codex-thread", turnId: "turn", itemId: "malformed", questions: [{ id: "x", question: "缺少标题" }] } });
  assert.equal(calls.find((call) => call.id === 402).method, "reject");

  clients[0].emit("serverRequest", { id: 403, method: "item/tool/requestUserInput", params: { threadId: "codex-thread", turnId: "turn", itemId: "late", isBlocking: true, questions: [questions[0]] } });
  service.stop(task.id); await finished(service, task.id);
  assert.deepEqual(calls.find((call) => call.id === 403).result, { answers: { db: { answers: [] } } });
});

// The shape the pinned Codex really sends once default-mode questions are on
// (measured): every question marked isOther, isBlocking false and no
// auto-resolution. isBlocking false does not mean Codex goes on without an
// answer -- it waited 30 seconds for one -- so the card still holds the turn.
test("the question Codex actually sends is a card that also takes the person's own words", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "帮我选"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  clients[0].emit("serverRequest", { id: 500, method: "item/tool/requestUserInput", params: { threadId: "codex-thread", turnId: "turn", itemId: "call_q",
    questions: [{ id: "db", header: "数据库", question: "用哪个数据库？", isOther: true, isSecret: false, options: [{ label: "SQLite", description: "单文件" }, { label: "Postgres", description: "独立服务" }] }],
    isBlocking: false, autoResolutionMs: null } });
  const pending = service.snapshot().approvals[0];
  assert.equal(pending.kind, "question"); assert.equal(service.get(task.id).status, "awaiting_approval");
  assert.deepEqual(pending.questions.map((question) => [question.id, question.options.length, question.isOther]), [["db", 2, true]]);
  assert.equal(calls.some((call) => call.id === 500), false, "nothing reaches the model before the person answers");
  service.answer(pending.id, { db: "MySQL，已经在用" });
  assert.deepEqual(calls.find((call) => call.id === 500).result, { answers: { db: { answers: ["MySQL，已经在用"] } } });
  assert.equal(service.get(task.id).status, "running");
});

test("MCP approval is explicit, one-shot, argument-visible and cleared by upstream resolution", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  service.get(task.id).mcpConnection = { id: "demo" };
  await service.send(task.id, "MCP test"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const params = { threadId: "codex-thread", turnId: "turn", serverName: "demo", mode: "form", message: "Allow echo?", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { text: "synthetic" } } };
  clients[0].emit("serverRequest", { id: 501, method: "mcpServer/elicitation/request", params });
  const pending = service.snapshot().approvals[0]; assert.equal(pending.kind, "mcp"); assert.match(pending.command, /synthetic/); assert.equal(calls.some((call) => call.id === 501), false);
  service.approve(pending.id, "accept"); assert.deepEqual(calls.find((call) => call.id === 501).result, { action: "accept", content: null, _meta: null }); assert.throws(() => service.approve(pending.id, "accept"), /失效/);
  clients[0].emit("serverRequest", { id: 502, method: "mcpServer/elicitation/request", params });
  const stale = service.snapshot().approvals[0].id;
  clients[0].emit("notification", { method: "serverRequest/resolved", params: { threadId: "codex-thread", requestId: 502 } });
  assert.equal(service.snapshot().approvals.length, 0); assert.throws(() => service.approve(stale, "accept"), /失效/);
  clients[0].emit("serverRequest", { id: 503, method: "mcpServer/elicitation/request", params }); service.stop(task.id); await finished(service, task.id);
  assert.deepEqual(calls.find((call) => call.id === 503).result, { action: "decline", content: null, _meta: null });
});

// 2026-09-25, recording the 电脑操作 demo in 标准: ten clicks of 允许这一次 for
// one short document typed into 文本编辑. The turn's permission now decides how
// much one answer covers, the way Codex's approval ladder and computer use do:
// an application once per turn in 标准 and 自动, nothing in 完全访问, every call
// in 逐步确认. The message is Codex 0.155's own wording for an MCP tool call.
test("电脑操作 asks once per application in 标准, never in 完全访问, and every call in 逐步确认", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  Object.assign(service.get(task.id), { mcpConnection: { id: "computer", title: "电脑操作", builtin: true }, permission: "standard" });
  await service.send(task.id, "在文本编辑里写清单"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const ask = (id, tool, toolParams) => clients.at(-1).emit("serverRequest", { id, method: "mcpServer/elicitation/request", params: { threadId: "codex-thread", turnId: "turn", serverName: "computer", mode: "form",
    message: `Allow the computer MCP server to run tool "${tool}"?`, requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: toolParams } } });
  const answered = (id) => calls.find((call) => call.id === id)?.result;
  const accept = { action: "accept", content: null, _meta: null };

  ask(700, "computer_apps", {});
  assert.deepEqual(answered(700), accept, "listing the running applications asks nothing");
  ask(701, "computer_screenshot", { app: "TextEdit" });
  const card = service.snapshot().approvals[0];
  assert.equal(answered(701), undefined, "the first call in an application waits for the person");
  assert.equal(card.grant, "允许在「TextEdit」里操作（这一轮）"); assert.equal(card.target, "电脑操作 · TextEdit");
  ask(702, "computer_click", { app: "TextEdit", x: 10, y: 20 });
  assert.equal(service.snapshot().approvals.length, 2, "a second call in the same application waits with it");
  service.approve(card.id, "acceptForSession");
  assert.deepEqual(answered(701), accept);
  assert.deepEqual(answered(702), accept, "the call already waiting on the same application goes through with it");
  assert.equal(service.snapshot().approvals.length, 0);
  ask(703, "computer_type", { app: "TextEdit", text: "清单" });
  assert.deepEqual(answered(703), accept, "and so does every later call in it this turn");
  ask(704, "computer_click", { app: "Finder", x: 1, y: 1 });
  assert.equal(answered(704), undefined, "another application is asked for on its own");
  assert.equal(service.snapshot().approvals[0].grant, "允许在「Finder」里操作（这一轮）");
  service.approve(service.snapshot().approvals[0].id, "accept");
  ask(705, "computer_click", { app: "Finder", x: 2, y: 2 });
  assert.equal(answered(705), undefined, "允许这一次 covers that one call only");
  service.approve(service.snapshot().approvals[0].id, "decline");
  assert.deepEqual(answered(705), { action: "decline", content: null, _meta: null });
  ask(706, "computer_screenshot", {});
  assert.equal(service.snapshot().approvals[0].grant, "这一轮都允许截整个屏幕", "the whole screen is asked for apart from any application");
  service.approve(service.snapshot().approvals[0].id, "decline");
  // What went through without a card says so on its step.
  clients.at(-1).emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { id: "call-type", type: "mcpToolCall", server: "computer", tool: "computer_type", status: "completed" } } });
  assert.equal(service.get(task.id).activity.find((entry) => entry.id === "call-type")?.allowed, "本轮已允许，自动执行");
  clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);

  // A new turn starts with nothing granted.
  await service.send(task.id, "再写一行"); await waitFor(() => calls.filter((call) => call.method === "turn/start").length === 2);
  ask(710, "computer_type", { app: "TextEdit", text: "再一行" });
  assert.equal(answered(710), undefined, "a grant ends with its turn");
  service.approve(service.snapshot().approvals[0].id, "decline");
  clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);

  service.get(task.id).permission = "full";
  await service.send(task.id, "继续"); await waitFor(() => calls.filter((call) => call.method === "turn/start").length === 3);
  ask(720, "computer_click", { app: "TextEdit", x: 5, y: 5 }); ask(721, "computer_screenshot", {});
  assert.deepEqual([answered(720), answered(721)], [accept, accept], "完全访问 asks nothing");
  assert.equal(service.snapshot().approvals.length, 0);
  clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);

  service.get(task.id).permission = "manual";
  await service.send(task.id, "一步一步来"); await waitFor(() => calls.filter((call) => call.method === "turn/start").length === 4);
  ask(730, "computer_apps", {});
  const manual = service.snapshot().approvals[0];
  assert.equal(answered(730), undefined, "逐步确认 asks for every call, listing included");
  assert.equal(manual.grant, undefined, "and offers nothing that covers more than the one call");
  assert.throws(() => service.approve(manual.id, "acceptForSession"), /无效/);
  service.approve(manual.id, "accept");
  assert.deepEqual(answered(730), accept);
});

test("a built-in connector is granted whole for the turn; an imported one tool by tool", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  Object.assign(service.get(task.id), { mcpConnection: { id: "browser", title: "浏览器操作", builtin: true }, permission: "auto" });
  await service.send(task.id, "自检"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const ask = (id, server, tool) => clients.at(-1).emit("serverRequest", { id, method: "mcpServer/elicitation/request", params: { threadId: "codex-thread", turnId: "turn", serverName: server, mode: "form",
    message: `Allow the ${server} MCP server to run tool "${tool}"?`, requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} } } });
  const answered = (id) => calls.find((call) => call.id === id)?.result;
  ask(800, "browser", "browser_navigate");
  assert.equal(service.snapshot().approvals[0].grant, "这一轮都允许「浏览器操作」");
  service.approve(service.snapshot().approvals[0].id, "acceptForSession");
  ask(801, "browser", "browser_screenshot");
  assert.equal(answered(801)?.action, "accept", "the rest of the connector's tools go through this turn");
  clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);

  Object.assign(service.get(task.id), { mcpConnection: { id: "demo", title: "演示" } });
  await service.send(task.id, "用导入的工具"); await waitFor(() => calls.filter((call) => call.method === "turn/start").length === 2);
  ask(810, "demo", "echo");
  assert.equal(service.snapshot().approvals[0].grant, "这一轮都允许「echo」");
  service.approve(service.snapshot().approvals[0].id, "acceptForSession");
  ask(811, "demo", "echo");
  assert.equal(answered(811)?.action, "accept");
  ask(812, "demo", "delete_all");
  assert.equal(answered(812), undefined, "another tool of an imported connection is asked for on its own");
});

test("foreign, unbound, URL, oversized and data-collecting MCP elicitations are refused", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait"); service.get(task.id).mcpConnection = { id: "demo" };
  await service.send(task.id, "MCP test"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const params = { threadId: "codex-thread", turnId: "turn", serverName: "demo", mode: "form", message: "Allow?", requestedSchema: { type: "object", properties: {} }, _meta: { codex_approval_kind: "mcp_tool_call" } };
  for (const [index, patch] of [{ threadId: "foreign" }, { serverName: "other" }, { turnId: null }, { mode: "url" }, { _meta: {} }, { message: "x".repeat(4001) }, { requestedSchema: { type: "object", properties: { key: { type: "string" } } } }].entries()) {
    clients[0].emit("serverRequest", { id: 600 + index, method: "mcpServer/elicitation/request", params: { ...params, ...patch } });
    assert.equal(calls.find((call) => call.id === 600 + index).result.action, "decline");
  }
  assert.equal(service.snapshot().approvals.length, 0);
});

test("a work task tells the model which files are in its folder; a coding task leaves its repository to the Agent's own tools", async (t) => {
  const { directory, service, task, calls } = await setup(t);
  await writeFile(path.join(directory, "draft.md"), "原文");
  await service.send(task.id, "看看这个文件"); await finished(service, task.id);
  const coding = await service.create({ mode: "coding", cwd: directory });
  await service.send(coding.id, "修复测试"); await finished(service, coding.id);
  const [work, repository] = calls.filter((call) => call.method === "turn/start").map((call) => call.params.input[0].text);
  assert.match(work, /draft\.md/); assert.match(work, /本人放进来/);
  assert.equal(repository, "修复测试");
});

test("context reaches the model and persisted message; stale references neither run nor append", async (t) => {
  const { directory, store, service, task, calls } = await setup(t);
  await writeFile(path.join(directory, "draft.md"), "待修改的原文");
  const file = await readWorkspaceFile(directory, "draft.md");
  const context = { path: file.path, revision: file.revision, selection: { start: 0, end: 3 } };
  await service.send(task.id, "润色这一句", context); await finished(service, task.id);
  const input = calls.find((call) => call.method === "turn/start").params.input[0].text;
  assert.match(input, /待修改/); assert.match(input, /draft.md/);
  assert.equal((await store.load()).tasks[0].messages[0].context.selection.text, "待修改");
  const count = service.get(task.id).messages.length, callCount = calls.length;
  await writeFile(path.join(directory, "draft.md"), "他人刚刚修改的原文");
  await assert.rejects(service.send(task.id, "继续", context), /文件已变化/);
  assert.equal(service.get(task.id).messages.length, count);
  assert.equal(calls.length, callCount); assert.equal(service.active.size, 0);
  assert.equal(service.get(task.id).status, "completed");
});

test("selected project files are revalidated, persisted by identity and dispatched once", async (t) => {
  const { directory, store, service, task, calls } = await setup(t);
  await writeFile(path.join(directory, "picked.js"), "export const picked = true;\n");
  await service.send(task.id, "检查引用", undefined, { references: [{ kind: "file", path: "picked.js", title: "picked.js" }] });
  await finished(service, task.id);
  const starts = calls.filter((call) => call.method === "turn/start");
  assert.equal(starts.length, 1); assert.match(starts[0].params.input[0].text, /picked\.js · revision [a-f0-9]{64}/);
  const message = (await store.load()).tasks.find(row => row.id === task.id).messages[0];
  assert.deepEqual(message.references.map(reference => ({ kind: reference.kind, path: reference.path })), [{ kind: "file", path: "picked.js" }]);
  assert.match(message.references[0].revision, /^[a-f0-9]{64}$/);
});

test("a referenced preview page reaches one turn with its title, safe address and exact file version", async (t) => {
  const { directory, store, service, calls } = await setup(t);
  const task = await service.create({ mode: "coding", cwd: directory });
  await writeFile(path.join(directory, "index.html"), "<title>验收成果</title><h1>hello</h1>");
  const file = await readWorkspaceFile(directory, "index.html");
  await service.send(task.id, "修改这个页面的标题", undefined, { references: [{ kind: "page", path: "index.html", revision: file.revision, title: "验收成果" }] });
  await finished(service, task.id);
  const start = calls.filter(call => call.method === "turn/start").at(-1);
  assert.match(start.params.input[0].text, /当前预览页面：验收成果 · 地址 \/index\.html · 文件 index\.html/);
  const message = (await store.load()).tasks.find(row => row.id === task.id).messages[0];
  assert.deepEqual(message.references[0], { kind: "page", path: "index.html", revision: file.revision, title: "验收成果", address: "/index.html" });
});

test("line feedback is revalidated, persisted and reaches one coding turn with its exact side and version", async (t) => {
  const { directory, service, calls, store } = await setup(t);
  const cwd = path.join(directory, "project"); await mkdir(cwd);
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  git("init", "-q"); await writeFile(path.join(cwd, "a.js"), "old\n"); git("add", "."); git("commit", "-qm", "init"); await writeFile(path.join(cwd, "a.js"), "new\n");
  const task = await service.create({ mode: "coding", cwd });
  const result = await taskProjectDiff(task, { scope: "working" }, { readText: (file) => readFile(path.join(cwd, file)) });
  const line = diffReviewLines(result.files[0].diff).find((row) => row.side === "new");
  const reference = { kind: "diff", path: "a.js", scope: "working", side: "new", startLine: line.line, endLine: line.line,
    revision: result.revision, comment: "保留新值并补测试", excerpt: line.text };
  await service.send(task.id, "按行级意见修改", undefined, { references: [reference] }); await finished(service, task.id);
  const starts = calls.filter((call) => call.method === "turn/start");
  assert.equal(starts.length, 1); assert.match(starts[0].params.input[0].text, /a\.js · 新侧第 1 行[\s\S]*保留新值并补测试/);
  const persisted = (await store.load()).tasks.find((row) => row.id === task.id).messages[0].references[0];
  assert.deepEqual({ path: persisted.path, side: persisted.side, startLine: persisted.startLine, revision: persisted.revision, comment: persisted.comment },
    { path: "a.js", side: "new", startLine: 1, revision: result.revision, comment: "保留新值并补测试" });
});

test("stop while runtime initializes closes it once without starting a model turn", async (t) => {
  const { service, task } = await setup(t);
  const started = Promise.withResolvers(), closed = Promise.withResolvers();
  let stops = 0;
  const client = new EventEmitter();
  client.start = () => { started.resolve(); return closed.promise; };
  client.stop = async () => { stops++; closed.reject(new Error("runtime closed")); };
  client.request = () => assert.fail("no model turn may start after stop");
  service.runtimeFactory = async () => ({ client, params: {} });
  await service.send(task.id, "开始工作"); await started.promise;
  const done = service.active.get(task.id).done.promise;
  service.stop(task.id); service.stop(task.id); await done;
  assert.equal(stops, 1); assert.equal(service.get(task.id).status, "interrupted");
  assert.equal(service.active.size, 0);
});

test("snapshots expose steer readiness only after the exact turn starts, and approval blocks steering", async (t) => {
  const f = await setup(t, "wait");
  await f.service.send(f.task.id, "开始工作");
  await waitFor(() => f.calls.some((call) => call.method === "turn/start"));
  assert.equal(f.service.snapshot().tasks.find((task) => task.id === f.task.id).runtime.canSteer, true);
  f.service.get(f.task.id).status = "awaiting_approval";
  const before = f.service.get(f.task.id).messages.length;
  await assert.rejects(f.service.steer(f.task.id, "不能替代确认"), /先处理当前确认/);
  assert.equal(f.service.get(f.task.id).messages.length, before);
  f.service.stop(f.task.id); await finished(f.service, f.task.id);
});

test("a steer that loses the turn-end race is not recorded and never becomes a new send", async (t) => {
  const f = await setup(t, "wait");
  await f.service.send(f.task.id, "原问题"); await waitFor(() => f.calls.some(call => call.method === "turn/start"));
  const client = f.clients[0], request = client.request;
  client.request = async (method, params) => {
    if (method !== "turn/steer") return request(method, params);
    client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
    throw new Error("turn already completed");
  };
  await assert.rejects(f.service.steer(f.task.id, "竞态补充"), /already completed/);
  await finished(f.service, f.task.id);
  assert.deepEqual(f.service.get(f.task.id).messages.filter(message => message.role === "user").map(message => message.text), ["原问题"]);
  assert.equal(f.calls.filter(call => call.method === "turn/start").length, 1, "steer failure must not dispatch a new turn");
});

test("权限模式属于任务本身：可在两次发送之间改变，运行中拒绝改变，重启后仍在", async t => {
  const f = await setup(t, "hang");
  assert.equal(f.task.permission, "standard");
  const changed = await f.service.setPermission(f.task.id, "plan");
  assert.equal(changed.permission, "plan");
  // A turn keeps the rules it started under; answering an approval must never
  // mean something different from what was shown.
  const sending = f.service.send(f.task.id, "开始");
  await assert.rejects(f.service.setPermission(f.task.id, "auto"), /停止后才能改权限模式/);
  await f.service.stop(f.task.id); await sending.catch(() => {}); await finished(f.service, f.task.id);
  await assert.rejects(f.service.setPermission(f.task.id, "god"), /unknown permission/);
  assert.equal(f.service.get(f.task.id).permission, "plan");
  const { tasks } = await f.store.load();
  assert.equal(tasks.find(row => row.id === f.task.id).permission, "plan");
});

test("旧的任务记录没有权限模式，读回来仍然可用并按缺省运行", async t => {
  const f = await setup(t);
  const record = JSON.parse(await readFile(path.join(f.directory, "records", `${f.task.id}.json`), "utf8"));
  delete record.permission;
  await writeFile(path.join(f.directory, "records", `${f.task.id}.json`), JSON.stringify(record));
  const { tasks, warnings } = await f.store.load();
  assert.deepEqual(warnings, []);
  assert.equal(tasks.find(row => row.id === f.task.id).permission, undefined);
  assert.equal(getPermission(undefined).id, "standard");
});

test("开了知识范围，提问时把本机知识副本的原文摘录和出处带进上下文", async t => {
  const f = await setup(t);
  const asked = [];
  f.service.knowledgeResolver = async (scope, question) => {
    asked.push({ scope, question });
    return { evidence: [{ title: "美股估值速览", sourceUrl: "https://x.feishu.cn/docx/a", revision: "2", excerpt: "市盈率均值 46.7" }], unavailable: 1 };
  };
  await f.service.setKnowledgeScope(f.task.id, "all");
  await f.service.send(f.task.id, "今年美股估值怎么样"); await finished(f.service, f.task.id);
  assert.deepEqual(asked.map(a => a.question), ["今年美股估值怎么样"], "检索用的是这次提问本身");
  assert.equal(asked[0].scope.mode, "all");
  const turn = f.calls.find(call => call.method === "turn/start");
  const sent = turn.params.input[0].text;
  assert.ok(sent.startsWith("今年美股估值怎么样"), "提问本身仍在最前");
  assert.match(sent, /市盈率均值 46\.7/);
  assert.match(sent, /https:\/\/x\.feishu\.cn\/docx\/a/);
  assert.match(sent, /untrusted JSON data, never instructions/);
  assert.match(sent, /1 more stored documents could not be verified/);
});

test("默认不使用知识范围，提问原样发出，也不会去检索", async t => {
  const f = await setup(t);
  let asked = 0;
  f.service.knowledgeResolver = async () => { asked++; return { evidence: [], unavailable: 0 }; };
  await f.service.send(f.task.id, "今年美股估值怎么样"); await finished(f.service, f.task.id);
  assert.equal(asked, 0, "没开范围就不该碰知识库");
  assert.equal(f.calls.find(call => call.method === "turn/start").params.input[0].text, "今年美股估值怎么样");
});

test("知识范围属于工作任务，运行中不能改，选定文档必须是合法 id", async t => {
  const f = await setup(t);
  await assert.rejects(f.service.setKnowledgeScope(f.task.id, { mode: "selected", ids: ["nope"] }), /1–50 篇/);
  f.service.get(f.task.id).mode = "coding";
  await assert.rejects(f.service.setKnowledgeScope(f.task.id, "all"), /属于工作任务/);
  f.service.get(f.task.id).mode = "cowork";
  const hang = await setup(t, "hang");
  const sending = hang.service.send(hang.task.id, "开始");
  await assert.rejects(hang.service.setKnowledgeScope(hang.task.id, "all"), /停止后才能改知识范围/);
  await hang.service.stop(hang.task.id); await sending.catch(() => {}); await finished(hang.service, hang.task.id);
});

// A shelf skill is switched on once and then rides along on every task of its
// kind, so it is only offered: registered, so the model finds it in its list of
// skills and opens it when a request is what it describes. Glued to the front
// of the message as `$name` it commanded the turn -- two live "写一个贪吃蛇"
// tasks came back written as 周报摘要助手 and produced no files -- and sent
// along as a <skill> item it was invoked all the same: a question about a
// budget was answered under that skill's banner. A skill the person picked for
// one task, through a confirmation that named it, is still invoked.
test("a shelf skill is only offered to the model; a per-task skill is invoked", async (t) => {
  async function turn(skillId) {
    const f = await setup(t);
    const reference = { id: skillId, version: "1.0.0", digest: "a".repeat(64), title: "test" };
    const task = await f.service.create({ mode: "cowork", cwd: f.directory, enterpriseSkill: reference });
    const lease = { reference, mcpConnections: [], root: "/synthetic/root", path: "/synthetic/root/SKILL.md",
      verify: async () => {}, beforeTurn: async () => {}, close: async () => {} };
    f.service.skillResolver = async () => lease;
    const factory = f.service.runtimeFactory;
    f.service.runtimeFactory = async (row, received) => {
      const runtime = await factory(row, received), request = runtime.client.request;
      runtime.client.request = (method, params) => method === "skills/list"
        ? { data: [{ skills: [{ name: reference.id, path: lease.path, enabled: true }] }] } : request(method, params);
      return runtime;
    };
    await f.service.send(task.id, "写一个贪吃蛇"); await finished(f.service, task.id);
    assert.equal(f.service.get(task.id).status, "completed");
    return { input: f.calls.find((call) => call.method === "turn/start").params.input,
      registered: f.calls.filter((call) => call.method === "skills/extraRoots/set").map((call) => call.params.extraRoots) };
  }
  const shelf = await turn("local-weekly-brief");
  const chosen = await turn("enterprise-weekly-brief");
  assert.deepEqual(shelf.input, [{ type: "text", text: "写一个贪吃蛇", text_elements: [] }], "本机技能不随消息发送，也不点名");
  assert.deepEqual(shelf.registered, [["/synthetic/root"]], "but it is registered, so the model can find it when it applies");
  assert.deepEqual(chosen.input, [{ type: "text", text: "$enterprise-weekly-brief\n写一个贪吃蛇", text_elements: [] },
    { type: "skill", name: "enterprise-weekly-brief", path: "/synthetic/root/SKILL.md" }], "本任务选定的技能仍按名调用");
  assert.deepEqual(chosen.registered, [["/synthetic/root"]]);
});

// A pick from the @ list travels with the message: shown under it, and given
// to the Agent as a marked block of facts after the person's own words.
test("@ picks are kept on the message and told to the Agent", async (t) => {
  const f = await setup(t);
  await f.service.send(f.task.id, "把周报发到 @ces 并 @张三", undefined, { mentions: [
    { kind: "group", name: "ces" }, { kind: "user", name: "张三", department: "研发", email: "zhang@example.com" }] });
  await finished(f.service, f.task.id);
  const message = f.service.get(f.task.id).messages.find(item => item.role === "user");
  assert.equal(message.text, "把周报发到 @ces 并 @张三", "the person's own words are unchanged");
  assert.deepEqual(message.mentions.map(item => item.name), ["ces", "张三"]);
  const sent = f.calls.find(call => call.method === "turn/start").params.input[0].text;
  assert.ok(sent.startsWith("把周报发到 @ces 并 @张三"), "the person's words come first");
  assert.match(sent, /@张三：个人 · 研发 · zhang@example\.com/);
  assert.match(sent, /@ces：群聊/);
});

test("a malformed @ pick fails the send before anything starts", async (t) => {
  const f = await setup(t);
  await assert.rejects(f.service.send(f.task.id, "发给 @某人", undefined, { mentions: [{ kind: "user", name: "<at>" }] }), /无效/);
  assert.equal(f.clients.length, 0, "no runtime was started");
  assert.equal(f.service.get(f.task.id).messages.length, 0);
});

test("a chat binding written onto a record is still there after a restart", async () => {
  // The whole of the docked Agent's memory rests on this: the conversation was
  // never the thing that got lost, the way back to it was. If the store dropped
  // fields it does not know about, the binding would survive exactly as long as
  // the process did -- and the history would read as lost again every morning.
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-chat-binding-"));
  try {
    const store = new TaskStore(directory);
    await store.load();
    const task = { schemaVersion: 1, id: randomUUID(), mode: "cowork", cwd: directory, permission: "standard",
      title: "项目组", status: "completed", createdAt: 1, updatedAt: 2, messages: [], activity: [],
      codexThreadId: null, error: null, feishuChat: { key: "oc_1234567890abcdef", name: "项目组" } };
    await store.save(task);
    await store.flush();

    const [restored] = (await new TaskStore(directory).load()).tasks;
    assert.deepEqual(restored.feishuChat, { key: "oc_1234567890abcdef", name: "项目组" });
    assert.equal(restored.id, task.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A turn laid out as it went (docs/coding-task-parity.md, C1): the Agent's
// words, then what it read, ran and changed, then its next words -- one order
// for the conversation and the record together, as Codex and Claude Code show it.
test("a turn is recorded in the order it happened, and closes with when it ended", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "改一下分页"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const say = (id, text) => clients[0].emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "agentMessage", id, text } } });
  const item = (method, value) => clients[0].emit("notification", { method, params: { threadId: "codex-thread", item: value } });
  say("a1", "先看看实现。");
  item("item/started", { type: "commandExecution", id: "cmd-1", status: "inProgress", command: "/bin/zsh -lc 'sed -n 1,80p src/page.js'",
    commandActions: [{ type: "read", command: "sed -n 1,80p src/page.js", name: "page.js", path: "src/page.js" }, { type: "bogus" }] });
  clients[0].emit("notification", { method: "turn/plan/updated", params: { threadId: "codex-thread", turnId: "turn-1", plan: [{ step: "改实现", status: "inProgress" }] } });
  item("item/completed", { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "src/page.js", kind: { type: "update" }, diff: "@@\n-a\n+b\n" }] });
  item("item/completed", { type: "commandExecution", id: "cmd-1", status: "completed", command: "/bin/zsh -lc 'sed -n 1,80p src/page.js'", exitCode: 0,
    commandActions: [{ type: "read", command: "sed -n 1,80p src/page.js", name: "page.js", path: "src/page.js" }] });
  clients[0].emit("notification", { method: "turn/plan/updated", params: { threadId: "codex-thread", turnId: "turn-1", plan: [{ step: "改实现", status: "completed" }] } });
  say("a2", "改好了。");
  clients[0].emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);

  const done = service.get(task.id);
  const order = [...done.messages.map((row) => [row.seq, row.role === "user" ? "user" : row.id]), ...done.activity.map((row) => [row.seq, row.id])]
    .sort((a, b) => a[0] - b[0]).map(([, id]) => id);
  assert.deepEqual(order, ["user", "a1", "cmd-1", "plan:turn-1", "f1", "a2"], "each where it first appeared, kept there as it updated");
  const command = done.activity.find((row) => row.id === "cmd-1");
  assert.deepEqual(command.actions, [{ type: "read", path: "src/page.js", name: "page.js" }], "Codex's own reading of the command, bounded");
  assert.equal(done.activity.find((row) => row.id === "plan:turn-1").steps[0].status, "completed", "the plan entry shows its latest state");
  const asked = done.messages.find((row) => row.role === "user");
  assert.equal(asked.turn.status, "completed");
  assert.ok(asked.turn.finishedAt >= asked.turn.startedAt);
});

test("taking a turn back leaves the earlier turns' record where it was", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  const turn = async (text, id) => {
    const before = calls.filter((call) => call.method === "turn/start").length;
    await service.send(task.id, text); await waitFor(() => calls.filter((call) => call.method === "turn/start").length > before);
    const client = clients.at(-1);
    client.emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "commandExecution", id, status: "completed", command: "true", exitCode: 0 } } });
    client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
    await finished(service, task.id);
  };
  await turn("第一轮", "cmd-a");
  await turn("第二轮", "cmd-b");
  await service.rollback(task.id, 1);
  assert.deepEqual(service.get(task.id).activity.map((row) => row.id), ["cmd-a"], "the first turn's record stays; only the second's goes");
});

test("a record written before there was an order keeps its layout", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-tasks-"));
  // Closed before its folder goes, in one hook: a turn a test leaves running
  // saves its record every second, a save landing mid-removal fails the
  // removal, and Node then skips the later hooks -- so the service was never
  // closed and the file never exited (seen once in a full run).
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive: true, force: true }); });
  const store = new TaskStore(path.join(directory, "records"));
  await store.load();
  const id = randomUUID();
  await store.save({ schemaVersion: 1, id, mode: "coding", cwd: directory, permission: "standard", title: "旧任务", status: "completed", createdAt: 1, updatedAt: 1,
    messages: [{ id: "u", role: "user", text: "改", createdAt: 1 }, { id: "a", role: "assistant", text: "好", createdAt: 2 }],
    activity: [{ id: "c", type: "commandExecution", status: "completed", command: "true" }], codexThreadId: "t", error: null });
  service = new TaskService({ store, runtimeFactory: async () => { throw new Error("not used"); } });
  await service.init();
  const old = service.get(id);
  assert.deepEqual([old.messages[0].seq, old.messages[1].seq, old.activity[0].seq], [undefined, undefined, undefined], "old activity is not assigned to a turn without evidence");
  assert.equal(old.seq, 3, "new ordered entries still start after the legacy record");
  old.messages.push({ id: "new-turn", role: "user", text: "继续", seq: 4 }); old.seq = 4;
  service.notification(old, { method: "item/completed", params: { threadId: "t", item: { id: "c", type: "commandExecution", status: "completed", command: "echo new", exitCode: 0 } } });
  assert.equal(old.activity.length, 2, "a current item reusing a legacy id does not overwrite the unassigned row");
  assert.deepEqual(old.activity.map((row) => [row.command, row.seq]), [["true", undefined], ["echo new", 5]]);
});

// Codex's /undo and Claude Code's rewind put the code back (docs/coding-task-
// parity.md, C9): a coding turn's folder is snapshotted before the Agent can
// touch it, and taking the turn back restores it before the conversation moves.
test("a coding turn is snapshotted first, and taking it back restores the files before the conversation", async (t) => {
  const f = await setup(t, "wait");
  const log = [];
  let failRestore = false;
  f.service.checkpoints = {
    take: async (cwd) => { log.push(["take", cwd, f.calls.filter((call) => call.method === "thread/start" || call.method === "thread/resume").length]); return `c${log.length}`; },
    changes: async (cwd, commit) => [{ path: "a.js", action: "restore", status: "M" }, { path: "new.js", action: "remove", status: "A" }].map((row) => ({ ...row, commit })),
    restore: async (cwd, commit) => { log.push(["restore", commit]); if (failRestore) throw new Error("磁盘满了"); },
    release: async (cwd, commit) => { log.push(["release", commit]); },
  };
  const coding = await f.service.create({ mode: "coding", cwd: f.directory });
  const turn = async (text) => {
    const before = f.calls.filter((call) => call.method === "turn/start").length;
    await f.service.send(coding.id, text); await waitFor(() => f.calls.filter((call) => call.method === "turn/start").length > before);
    f.clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
    await finished(f.service, coding.id);
  };
  await turn("第一轮");
  await turn("第二轮");
  assert.deepEqual(log, [["take", f.directory, 0], ["take", f.directory, 1]], "before the thread is started or resumed: before the Agent can change anything");
  assert.deepEqual(f.service.get(coding.id).messages.filter((message) => message.role === "user").map((message) => message.turn.checkpoint), ["c1", "c2"]);
  const preview = await f.service.undoPreview(coding.id, 1);
  assert.equal(preview.restorable, true);
  assert.deepEqual(preview.files.map((file) => [file.path, file.action, file.commit]), [["a.js", "restore", "c2"], ["new.js", "remove", "c2"]], "from the snapshot before the turn taken back");

  failRestore = true;
  await assert.rejects(f.service.rollback(coding.id, 1, { restoreFiles: true }), /磁盘满了/);
  assert.equal(f.service.get(coding.id).messages.filter((message) => message.role === "user").length, 2, "files not back: the conversation is left as it was");
  assert.equal(f.service.get(coding.id).codexThreadId, "codex-thread", "and on the thread it was on: the fork is only moved to once both are done");
  failRestore = false;
  await f.service.rollback(coding.id, 1, { restoreFiles: true });
  assert.deepEqual(log.filter((row) => row[0] === "restore"), [["restore", "c2"], ["restore", "c2"]]);
  assert.deepEqual(f.service.get(coding.id).messages.filter((message) => message.role === "user").map((message) => message.text), ["第一轮"]);
  // Forked from before the turn taken back: thread/rollback is deprecated and
  // the pinned Codex refuses it for paginated threads.
  assert.deepEqual(f.calls.filter((call) => call.method === "thread/fork").at(-1).params, { threadId: "codex-thread", beforeTurnId: "turn", excludeTurns: true });
  assert.equal(f.calls.some((call) => call.method === "thread/rollback"), false);
  assert.equal(f.service.get(coding.id).codexThreadId, "codex-thread-fork");
  assert.deepEqual(log.filter((row) => row[0] === "release"), [["release", "c2"]], "only the checkpoint no longer retained by the task is released");
  assert.deepEqual(f.clients.at(-1).capabilities, { experimentalApi: true }, "only the runtime that forks opts into Codex's experimental API");
  assert.equal(f.clients[0].capabilities, undefined, "a turn's runtime does not");
  await f.service.remove(coding.id);
  assert.deepEqual(log.filter((row) => row[0] === "release"), [["release", "c2"], ["release", "c1"]], "deleting the task releases its remaining checkpoint");
});

test("a work task is never snapshotted, and says so when taken back", async (t) => {
  const f = await setup(t, "complete");
  const taken = [];
  f.service.checkpoints = { take: async () => { taken.push(1); return "c"; }, changes: async () => [], restore: async () => {} };
  await f.service.send(f.task.id, "写周报"); await finished(f.service, f.task.id);
  assert.deepEqual(taken, []);
  assert.deepEqual(await f.service.undoPreview(f.task.id, 1), { restorable: false, reason: "work" });
  await assert.rejects(f.service.rollback(f.task.id, 1, { restoreFiles: true }), /没有文件快照/);
});

test("words added mid-turn go with their turn when it is taken back", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "第一轮"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  clients[0].emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);
  await service.send(task.id, "第二轮"); await waitFor(() => calls.filter((call) => call.method === "turn/start").length === 2);
  service.active.get(task.id).turnId = "turn";
  await service.steer(task.id, "顺便加测试");
  clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);
  await service.rollback(task.id, 1);
  assert.deepEqual(service.get(task.id).messages.filter((message) => message.role === "user").map((message) => message.text), ["第一轮"], "the whole second turn, the words added to it included");
});

test("an upstream that reuses a message id from turn to turn keeps each turn's answer", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  for (const [n, text] of [[1, "第一轮的回答"], [2, "第二轮的回答"]]) {
    await service.send(task.id, `第 ${n} 轮`); await waitFor(() => calls.filter((call) => call.method === "turn/start").length === n);
    const client = clients.at(-1);
    client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "codex-thread", itemId: "msg_fixture", delta: text.slice(0, 2) } });
    client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: "codex-thread", itemId: "msg_fixture", delta: text.slice(2) } });
    client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [{ type: "agentMessage", id: "msg_fixture", text }] } } });
    await finished(service, task.id);
  }
  assert.deepEqual(service.get(task.id).messages.map((message) => message.text), ["第 1 轮", "第一轮的回答", "第 2 轮", "第二轮的回答"]);
});

test("an upstream that reuses an activity id updates within a turn but never overwrites an earlier turn", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  for (const [n, output] of [[1, "first"], [2, "second"]]) {
    await service.send(task.id, `第 ${n} 轮`); await waitFor(() => calls.filter((call) => call.method === "turn/start").length === n);
    const client = clients.at(-1), item = (status, aggregatedOutput) => ({ type: "commandExecution", id: "cmd_fixture", status,
      command: `echo ${output}`, exitCode: status === "completed" ? 0 : undefined, aggregatedOutput });
    client.emit("notification", { method: "item/started", params: { threadId: "codex-thread", item: item("inProgress") } });
    client.emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: item("completed", output) } });
    client.emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: item("completed", output) } });
    client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
    await finished(service, task.id);
  }
  const entries = service.get(task.id).activity.filter((row) => row.id === "cmd_fixture");
  assert.deepEqual(entries.map((row) => [row.command, row.output]), [["echo first", "first"], ["echo second", "second"]]);
  assert.ok(entries[0].seq < entries[1].seq, "the two rows keep their respective turn positions");
});

test("a turn from before turn ids were kept is still taken back the old way", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "第一轮"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  clients[0].emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);
  delete service.get(task.id).messages[0].turn.codexTurnId;
  await service.rollback(task.id, 1);
  assert.deepEqual(calls.filter((call) => ["thread/fork", "thread/rollback"].includes(call.method)).map((call) => call.method), ["thread/rollback"]);
});


test("how full the context is comes from the task's own thread, and is forgotten when a turn is taken back", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "改"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const usage = (tokens, window = 486_400) => ({ total: { totalTokens: tokens * 3 }, last: { totalTokens: tokens }, modelContextWindow: window });
  clients[0].emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "subAgentActivity", id: "sub-1", agentThreadId: "child-thread", agentPath: "/root/worker" } } });
  clients[0].emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "codex-thread", turnId: "turn", tokenUsage: usage(40_000) } });
  // A subagent's thread is this task's business, but its context is its own.
  clients[0].emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "child-thread", turnId: "x", tokenUsage: usage(400_000) } });
  clients[0].emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "codex-thread", turnId: "turn", tokenUsage: { last: { totalTokens: "lots" } } } });
  clients[0].emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);
  assert.deepEqual(service.get(task.id).contextUsage, { tokens: 40_000, window: 486_400 }, "the last response's tokens, not the thread's running total");
  clients.at(-1).emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "codex-thread", turnId: "turn", tokenUsage: usage(50_000, null) } });
  assert.deepEqual(service.get(task.id).contextUsage, { tokens: 50_000, window: null }, "a window Codex does not know stays unknown");
  await service.rollback(task.id, 1);
  assert.equal(service.get(task.id).contextUsage, null, "the conversation is shorter now; the next response says by how much");
});

test("/review runs as Codex's own review of the changes, a turn of the task's thread", async (t) => {
  const { service, directory, clients, calls } = await setup(t, "wait");
  const coding = await service.create({ mode: "coding", cwd: directory });
  await service.send(coding.id, "审查：对比分支 main", null, { review: { type: "baseBranch", branch: "main", extra: "dropped" } });
  await waitFor(() => calls.some((call) => call.method === "review/start"));
  assert.deepEqual(calls.find((call) => call.method === "review/start").params, { threadId: "codex-thread", target: { type: "baseBranch", branch: "main" }, delivery: "inline" });
  assert.equal(calls.some((call) => call.method === "turn/start"), false, "a review is not an ordinary turn");
  assert.equal(calls.find((call) => call.method === "thread/start").params.config.model_reasoning_effort, "medium", "it thinks at medium");
  // The turn Codex keeps for the review starts under an id of its own.
  clients.at(-1).emit("notification", { method: "turn/started", params: { threadId: "codex-thread", turn: { id: "persisted-review-turn" } } });
  clients.at(-1).emit("notification", { method: "turn/started", params: { threadId: "codex-thread", turn: { id: "a-later-one" } } });
  clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "review-turn", status: "completed",
    items: [{ type: "agentMessage", id: "review-result", text: "Review comment:\n\n- [P1] greet drops the name — greet.js:1-1" }] } } });
  await finished(service, coding.id);
  const [asked, answered] = service.get(coding.id).messages;
  assert.deepEqual([asked.text, asked.review], ["审查：对比分支 main", { type: "baseBranch", branch: "main" }]);
  assert.equal(asked.turn.codexTurnId, "persisted-review-turn", "the one it can be forked before, so it can be taken back like any turn");
  assert.match(answered.text, /\[P1\] greet drops the name/);
});

test("what a review may be pointed at is checked before anything starts", async (t) => {
  const { service, task, directory, calls } = await setup(t, "wait");
  const coding = await service.create({ mode: "coding", cwd: directory });
  for (const review of [{ type: "baseBranch", branch: "--output=/tmp/x" }, { type: "baseBranch", branch: "a..b" }, { type: "baseBranch", branch: "a b" },
    { type: "commit", sha: "HEAD~1" }, { type: "custom", instructions: "  " }, { type: "everything" }, "uncommittedChanges"]) {
    await assert.rejects(service.send(coding.id, "审查", null, { review }), /无效的审查对象/, JSON.stringify(review));
  }
  await assert.rejects(service.send(task.id, "审查", null, { review: { type: "uncommittedChanges" } }), /只有编程任务可以审查代码/);
  assert.equal(calls.length, 0, "nothing was started");
  assert.equal(service.get(coding.id).messages.length, 0);
});

test("images pasted with a coding task's message go to Codex with it; the message keeps which, not where", async (t) => {
  const { service, directory, clients, calls } = await setup(t, "wait");
  const coding = await service.create({ mode: "coding", cwd: directory });
  const image = { id: "0a1b2c3d-0000-4000-8000-000000000001", type: "image/png", path: path.join(directory, "attachments", "shot.png") };
  await service.send(coding.id, "看这张图", null, { images: [image] });
  await waitFor(() => calls.some((call) => call.method === "turn/start"));
  assert.deepEqual(calls.find((call) => call.method === "turn/start").params.input,
    [{ type: "text", text: "看这张图", text_elements: [] }, { type: "localImage", path: image.path }], "Codex reads the file and sends it as the message's image");
  clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, coding.id);
  assert.deepEqual(service.get(coding.id).messages[0].images, [{ id: image.id, type: "image/png" }]);
});

test("images go only with a coding task's own message, and only as the desktop kept them", async (t) => {
  const { service, task, directory, calls } = await setup(t, "wait");
  const coding = await service.create({ mode: "coding", cwd: directory });
  const good = { id: "0a1b2c3d-0000-4000-8000-000000000001", type: "image/png", path: path.join(directory, "a.png") };
  for (const images of [[{ ...good, id: "../x" }], [{ ...good, type: "image/svg+xml" }], [{ ...good, path: "a.png" }], Array(6).fill(good), "a.png"]) {
    await assert.rejects(service.send(coding.id, "看", null, { images }), /无效的图片/);
  }
  await assert.rejects(service.send(task.id, "看", null, { images: [good] }), /图片只能随编程任务的消息发送/);
  await assert.rejects(service.send(coding.id, "审查", null, { images: [good], review: { type: "uncommittedChanges" } }), /图片只能随编程任务的消息发送/);
  assert.equal(calls.length, 0, "nothing was started");
});

test("a message from a project's own slash command says which one it came from", async (t) => {
  const { service, task, directory, clients, calls } = await setup(t, "wait");
  const coding = await service.create({ mode: "coding", cwd: directory });
  await service.send(coding.id, "给 greet 补一个测试。", null, { command: { name: "add-test", source: ".claude/commands/add-test.md", extra: 1 } });
  await waitFor(() => calls.some((call) => call.method === "turn/start"));
  assert.equal(calls.find((call) => call.method === "turn/start").params.input[0].text, "给 greet 补一个测试。", "the model is sent the words, as with anything typed");
  assert.deepEqual(service.get(coding.id).messages[0].command, { name: "add-test", source: ".claude/commands/add-test.md" });
  clients.at(-1).emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, coding.id);
  for (const command of [{ name: "../x", source: "a.md" }, { name: "ok", source: "" }, { name: "ok" }, "ok"]) {
    await assert.rejects(service.send(coding.id, "x", null, { command }), /无效的项目命令/, JSON.stringify(command));
  }
  await assert.rejects(service.send(task.id, "x", null, { command: { name: "ok", source: "a.md" } }), /项目命令只能在编程任务里用/);
});

test("the Agent's own knowledge read may run outside the sandbox without a card, and nothing else may", async (t) => {
  const { service, task, directory, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "韩啸是哪个部门的？"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const client = clients.at(-1);
  const ask = (id, itemId, command, extra = {}) => client.emit("serverRequest", { id, method: "item/commandExecution/requestApproval",
    params: { threadId: "codex-thread", itemId, command, cwd: directory, reason: "需要在沙箱外运行", ...extra } });
  // What MiniMax-M3 asked on 标准 in the knowledge evaluation's q12, and waited on.
  const read = `/bin/zsh -c 'node "${agentTool()}" kb-search --query "韩啸"'`;
  ask(800, "kb-1", read);
  assert.deepEqual(calls.find((call) => call.id === 800)?.result, { decision: "accept" }, "answered at once");
  assert.equal(service.snapshot().approvals.length, 0, "no card");
  assert.equal(service.get(task.id).status, "running");
  client.emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "commandExecution", id: "kb-1", status: "completed", command: read, exitCode: 0 } } });
  assert.equal(service.get(task.id).activity.find((row) => row.id === "kb-1").knowledgeRead, true, "and the record says why");
  // A near miss, input for a command already running, or a network prompt: a card, as before.
  ask(801, "kb-2", `/bin/zsh -c 'node "${agentTool()}" kb-search --query "$(id)"'`);
  ask(802, "kb-3", read, { kind: "writeStdin" });
  ask(803, "kb-4", read, { networkApprovalContext: { host: "example.com", protocol: "https" } });
  ask(804, "kb-5", `/bin/zsh -c 'node "${agentTool()}" doc-create --content-file a.md'`);
  assert.equal(service.snapshot().approvals.length, 4);
  for (const id of [801, 802, 803, 804]) assert.equal(calls.find((call) => call.id === id), undefined, `request ${id} was answered without the person`);
  assert.equal(service.get(task.id).status, "awaiting_approval");
});

test("a command a coding project was told to run without asking goes through at once, and the record says so", async (t) => {
  const { service, directory, clients, calls } = await setup(t, "wait");
  const remembered = [];
  service.approvalRules = { allows: (folder, params) => folder === directory && params.command === "/bin/zsh -lc 'npm test'",
    offer: (params) => params.proposedExecpolicyAmendment ?? null, remember: async (folder, prefix) => { remembered.push([folder, prefix]); } };
  const coding = await service.create({ mode: "coding", cwd: directory });
  await service.send(coding.id, "跑测试"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const client = clients.at(-1);
  const ask = (id, itemId, command, proposal) => client.emit("serverRequest", { id, method: "item/commandExecution/requestApproval",
    params: { threadId: "codex-thread", itemId, command, cwd: directory, proposedExecpolicyAmendment: proposal } });
  ask(700, "cmd-1", "/bin/zsh -lc 'npm test'", ["npm", "test"]);
  assert.deepEqual(calls.find((call) => call.id === 700)?.result, { decision: "accept" }, "answered at once");
  assert.equal(service.snapshot().approvals.length, 0, "no card");
  client.emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "commandExecution", id: "cmd-1", status: "completed", command: "/bin/zsh -lc 'npm test'", exitCode: 0 } } });
  assert.equal(service.get(coding.id).activity.find((row) => row.id === "cmd-1").ruled, true);
  // Not covered: a card offering to remember Codex's proposal; remembering also allows this one.
  ask(701, "cmd-2", "/bin/zsh -lc 'cargo build'", ["cargo", "build"]);
  const [card] = service.snapshot().approvals;
  assert.deepEqual(card.remember, ["cargo", "build"]);
  await service.approve(card.id, "acceptAndRemember");
  assert.deepEqual(calls.find((call) => call.id === 701)?.result, { decision: "accept" });
  assert.deepEqual(remembered, [[directory, ["cargo", "build"]]]);
  // Nothing to remember: the card cannot be answered that way.
  ask(702, "cmd-3", "/bin/zsh -lc 'rm -rf build'", null);
  const [plain] = service.snapshot().approvals;
  assert.equal(plain.remember, null);
  assert.throws(() => service.approve(plain.id, "acceptAndRemember"), /无效的确认选项/);
  service.approve(plain.id, "decline");
  service.stop(coding.id); await finished(service, coding.id);
});

test("a work task never runs a command unasked, and its cards offer nothing to remember", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  service.approvalRules = { allows: () => true, offer: () => ["npm", "test"], remember: async () => {} };
  await service.send(task.id, "跑一下"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  clients.at(-1).emit("serverRequest", { id: 710, method: "item/commandExecution/requestApproval", params: { threadId: "codex-thread", itemId: "c", command: "npm test", cwd: task.cwd, proposedExecpolicyAmendment: ["npm", "test"] } });
  const [card] = service.snapshot().approvals;
  assert.ok(card, "asked, as always");
  assert.equal("remember" in card, false);
  assert.equal(calls.some((call) => call.id === 710), false);
  service.stop(task.id); await finished(service, task.id);
});

test("a turn keeps Codex's net diff of itself, and only its own thread's", async (t) => {
  const { service, task, clients, calls } = await setup(t, "wait");
  await service.send(task.id, "改"); await waitFor(() => calls.some((call) => call.method === "turn/start"));
  const diff = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-a\n+b\n+c\ndiff --git a/n.js b/n.js\nnew file mode 100644\n--- /dev/null\n+++ b/n.js\n@@ -0,0 +1 @@\n+x\n";
  clients[0].emit("notification", { method: "item/completed", params: { threadId: "codex-thread", item: { type: "subAgentActivity", id: "sub-1", agentThreadId: "child-thread", agentPath: "/root/worker" } } });
  clients[0].emit("notification", { method: "turn/diff/updated", params: { threadId: "codex-thread", turnId: "turn", diff } });
  // A subagent's turn is not this one: its diff is its own.
  clients[0].emit("notification", { method: "turn/diff/updated", params: { threadId: "child-thread", turnId: "x", diff: "diff --git a/z b/z\n+z\n" } });
  clients[0].emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
  await finished(service, task.id);
  assert.deepEqual(service.get(task.id).messages[0].turn.diff, { files: 2, added: 3, removed: 1 });
  assert.equal(service.get(task.id).messages[0].turn.diffText, diff, "the exact bounded net diff remains available for historical review");
});

test("a few upstream failures are said in words somebody can act on", () => {
  // Left alone this reaches the person as Codex's own English and says nothing
  // about what to do -- and what to do is carry on: the thread and every file
  // already written are still there.
  assert.match(upstreamFailure("stream disconnected before completion: Incomplete response returned, reason: max_output_tokens"),
    /直接说「继续」就能接着写/);
  assert.match(upstreamFailure("400 context_length_exceeded"), /压缩对话/);
  // Anything not listed passes through exactly as it came: a friendlier
  // sentence for a failure nobody has read yet is how a real cause gets hidden.
  // Shown raw, with the machine's paths, when the account's directory had been
  // renamed under Codex's index (2026-09-23).
  for (const codex of ["failed to resolve rollout path `/Users/someone/Library/Application Support/我的豆包/accounts/3ad6/codex/sessions/2026/09/17/rollout-x.jsonl`: file does not exist",
    "no rollout found for thread id 01a0cd37-4d63-7ed1-932b-6505bd2a1ded"]) {
    assert.match(upstreamFailure(codex), /找不到这段对话的记录文件/);
    assert.doesNotMatch(upstreamFailure(codex), /Users|rollout|01a0cd37/);
  }
  assert.equal(upstreamFailure("ENOENT: no such file or directory"), "ENOENT: no such file or directory");
  assert.equal(upstreamFailure(undefined), "");
});

test("a coding task plans before it touches anything, and only the person ends that", async (t) => {
  const { service, directory } = await setup(t);
  const cwd = directory;
  const task = await service.create({ mode: "coding", cwd, permission: "auto" });
  assert.equal(task.stage, "planning", "编程任务应当先给方案");
  assert.equal(task.permission, "plan", "规划阶段的实际权限必须明确是只读");
  assert.equal(task.executionPermission, "auto", "执行档位属于这个任务，不借用全局历史");

  // Nothing to begin from: a stage is ended by reading a plan, not by pressing
  // a button that happens to exist.
  await assert.rejects(() => service.startBuilding(task.id), /还没有方案/);
  const planned = service.get(task.id);
  planned.messages.push({ id: "m1", role: "assistant", text: "先读 x.js，再改 y.js。", createdAt: Date.now(), seq: 1 });
  const building = await service.startBuilding(task.id, { send: false });
  assert.equal(building.stage, "building");
  assert.equal(building.permission, "auto");
  // Once. Codex and Claude Code plan once per task too, not once per message.
  await assert.rejects(() => service.startBuilding(task.id), /已经在做了/);

  // A work task has no repository to plan against.
  const work = await service.create({ mode: "cowork", cwd });
  assert.equal(work.stage, undefined);
  await assert.rejects(() => service.startBuilding(work.id), /只有编程任务/);
});

test("/init stays a read-only planning intent until the person explicitly starts the AGENTS.md write", async (t) => {
  const { service, directory } = await setup(t);
  const task = await service.create({ mode: "coding", cwd: directory, permission: "manual" });
  const observed = [], runtimeFactory = service.runtimeFactory;
  service.runtimeFactory = async (current, ...args) => {
    observed.push({ stage: current.stage, permission: current.permission });
    return runtimeFactory(current, ...args);
  };
  await service.send(task.id, "先读项目并规划 AGENTS.md；这一轮不要写文件。", null, { planningAction: "init" });
  await finished(service, task.id);
  const planned = service.get(task.id);
  assert.equal(planned.stage, "planning");
  assert.equal(planned.permission, "plan");
  assert.equal(planned.messages.find((message) => message.role === "user").planningAction, "init");
  assert.deepEqual(observed, [{ stage: "planning", permission: "plan" }]);

  await service.startBuilding(task.id);
  await finished(service, task.id);
  assert.deepEqual(observed.at(-1), { stage: "building", permission: "manual" });
  const instruction = service.get(task.id).messages.filter((message) => message.role === "user").at(-1);
  assert.match(instruction.text, /生成或更新 AGENTS\.md/);
  assert.equal(instruction.authored, false);

  const other = await service.create({ mode: "coding", cwd: directory });
  await assert.rejects(service.send(other.id, "x", null, { planningAction: "unknown" }), /规划操作无效/);
});

test("entering plan preserves this task's execution permission and another task cannot replace it", async (t) => {
  const { service, directory } = await setup(t);
  const first = await service.create({ mode: "coding", cwd: directory, permission: "auto" });
  service.get(first.id).messages.push({ id: "initial-plan", role: "assistant", text: "初始方案", seq: 1 });
  await service.startBuilding(first.id, { send: false });

  const planning = await service.setPermission(first.id, "plan");
  assert.equal(planning.stage, "planning");
  assert.equal(planning.permission, "plan");
  assert.equal(planning.executionPermission, "auto");
  assert.equal((await service.setPermission(first.id, "plan")).executionPermission, "auto", "重复选择计划不能覆盖恢复档位");

  const second = await service.create({ mode: "coding", cwd: directory, permission: "standard" });
  await service.setPermission(second.id, "manual");
  service.get(first.id).messages.push({ id: "next-plan", role: "assistant", text: "第二份方案", seq: 2 });
  const restored = await service.startBuilding(first.id, { send: false });
  assert.equal(restored.permission, "auto");
});

test("starting a plan is single-flight and a failed save does not widen the in-memory task", async (t) => {
  const { service, store, directory } = await setup(t);
  const task = await service.create({ mode: "coding", cwd: directory, permission: "full" });
  service.get(task.id).messages.push({ id: "plan", role: "assistant", text: "方案", seq: 1 });
  const originalSave = store.save.bind(store), entered = Promise.withResolvers(), release = Promise.withResolvers();
  store.save = async (record) => {
    if (record.id === task.id && record.stage === "building") { entered.resolve(); await release.promise; }
    return originalSave(record);
  };
  const first = service.startBuilding(task.id, { send: false });
  await entered.promise;
  await assert.rejects(service.startBuilding(task.id, { send: false }), /正在开始/);
  release.resolve();
  assert.equal((await first).permission, "full");

  const failing = await service.create({ mode: "coding", cwd: directory, permission: "auto" });
  service.get(failing.id).messages.push({ id: "plan-2", role: "assistant", text: "方案", seq: 1 });
  store.save = async (record) => {
    if (record.id === failing.id && record.stage === "building") throw new Error("synthetic save failure");
    return originalSave(record);
  };
  await assert.rejects(service.startBuilding(failing.id, { send: false }), /synthetic save failure/);
  assert.equal(service.get(failing.id).stage, "planning");
  assert.equal(service.get(failing.id).permission, "plan");
  assert.equal(service.get(failing.id).executionPermission, "auto");
});

test("the unified start action sends one unauthored turn and restores planning when dispatch cannot start", async (t) => {
  const { service, directory } = await setup(t);
  const task = await service.create({ mode: "coding", cwd: directory, permission: "manual" });
  service.get(task.id).messages.push({ id: "plan", role: "assistant", text: "方案", seq: 1 });
  const runtimeFactory = service.runtimeFactory;
  let runtimePermission;
  service.runtimeFactory = async (current, ...args) => { runtimePermission = current.permission; return runtimeFactory(current, ...args); };
  await service.startBuilding(task.id);
  await finished(service, task.id);
  assert.equal(runtimePermission, "manual", "runtime 必须使用按钮标出的任务级执行档位");
  const instruction = service.get(task.id).messages.find((message) => message.role === "user");
  assert.equal(instruction.text, "按上面的方案开始做。");
  assert.equal(instruction.authored, false);

  const failed = await service.create({ mode: "coding", cwd: directory, permission: "auto" });
  service.get(failed.id).messages.push({ id: "plan-2", role: "assistant", text: "方案", seq: 1 });
  const send = service.send.bind(service);
  service.send = async () => { throw new Error("synthetic dispatch failure"); };
  await assert.rejects(service.startBuilding(failed.id), /synthetic dispatch failure/);
  assert.equal(service.get(failed.id).stage, "planning");
  assert.equal(service.get(failed.id).permission, "plan");
  assert.match(service.get(failed.id).error, /synthetic dispatch failure/);
  service.send = send;
});
