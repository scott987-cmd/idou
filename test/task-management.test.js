import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TaskStore } from "../src/application/task-store.js";
import { TaskService, taskTitle } from "../src/application/task-service.js";

// Same shape as the runtime the application builds, reduced to the calls these
// operations actually make, so what is asserted is the protocol traffic.
async function setup(t, { compactCompletes = true, usage = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-manage-"));
  // Closed before its folder goes, in one hook: a turn a test leaves running
  // saves its record every second, a save landing mid-removal fails the
  // removal, and Node then skips the later hooks -- so the service was never
  // closed and the file never exited (seen once in a full run).
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = [];
  const store = new TaskStore(path.join(directory, "records"));
  service = new TaskService({ store, runtimeFactory: async () => {
    const client = new EventEmitter();
    client.start = async () => {}; client.stop = async () => { calls.push({ method: "stop" }); };
    client.request = async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start" || method === "thread/resume") return { thread: { id: "codex-thread" } };
      if (method === "thread/fork") return { thread: { id: "codex-thread-fork" } };
      if (method === "turn/start") {
        if (usage) client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "codex-thread", turnId: "t", tokenUsage: { total: { totalTokens: usage }, last: { totalTokens: usage }, modelContextWindow: 190_000 } } });
        client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: `turn-${calls.length}`, status: "completed", items: [] } } });
        return { turn: { id: `turn-${calls.length}` } };
      }
      if (method === "thread/compact/start") {
        if (compactCompletes) queueMicrotask(() => client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "compact", status: "completed" } } }));
        return {};
      }
      return {};
    };
    return { client, params: { cwd: directory } };
  } });
  await service.init();
  const task = await service.create({ mode: "cowork", cwd: directory });
  return { directory, store, service, task, calls };
}
const finished = async (service, id) => { await service.active.get(id)?.done.promise; };

test("任务名取自第一句话，之后不再被后续消息改写", async (t) => {
  const f = await setup(t);
  assert.equal(f.task.title, "新工作任务");
  await f.service.send(f.task.id, "帮我看下这个季度的销售表，哪个产品最高");
  await finished(f.service, f.task.id);
  assert.equal(f.service.get(f.task.id).title, "帮我看下这个季度的销售表");
  await f.service.send(f.task.id, "再算一下环比");
  await finished(f.service, f.task.id);
  assert.equal(f.service.get(f.task.id).title, "帮我看下这个季度的销售表", "后面的消息不该改掉已经取好的名字");
});

test("取名在标点处断句，没有标点时截断并标明", () => {
  assert.equal(taskTitle("把销售表整理成三页 PPT，第一页封面"), "把销售表整理成三页 PPT");
  assert.equal(taskTitle("  多行\n输入  "), "多行 输入");
  assert.equal(taskTitle("短句"), "短句");
  assert.equal(taskTitle(""), "新任务");
  assert.equal(taskTitle("这是一个没有任何标点的很长很长很长很长很长很长很长的句子"), "这是一个没有任何标点的很长很长很长很长很长很长很…");
  // 太靠前的标点不该把名字砍成一两个字：这里的逗号在第 2 个字，要跳过。
  assert.equal(taskTitle("好，帮我把这份季度销售数据整理成一页纸的结论"), "好，帮我把这份季度销售数据整理成一页纸的结论");
});

test("改名只改名字，改完能落盘并在重启后保留", async (t) => {
  const f = await setup(t);
  await f.service.rename(f.task.id, "  季度  复盘  ");
  assert.equal(f.service.get(f.task.id).title, "季度 复盘");
  for (const bad of ["", "   ", "字".repeat(61)]) await assert.rejects(() => f.service.rename(f.task.id, bad), Error);
  const revived = new TaskService({ store: f.store, runtimeFactory: async () => { throw new Error("不该启动运行时"); } });
  await revived.init();
  assert.equal(revived.get(f.task.id).title, "季度 复盘");
});

test("删除只删对话记录，工作目录和里面的文件都留着", async (t) => {
  const f = await setup(t);
  await writeFile(path.join(f.directory, "产出.md"), "已经做出来的东西");
  await f.service.send(f.task.id, "第一句");
  await finished(f.service, f.task.id);
  const removed = await f.service.remove(f.task.id);
  assert.equal(removed.cwd, f.directory);
  assert.throws(() => f.service.get(f.task.id), /找不到这个任务/);
  assert.equal((await readdir(path.join(f.directory, "records"))).filter((name) => name.endsWith(".json")).length, 0);
  assert.ok((await readdir(f.directory)).includes("产出.md"), "工作目录里的文件不该被删");
  // 删掉之后不该还能从快照里看到它。
  assert.equal(f.service.snapshot().tasks.some((row) => row.id === f.task.id), false);
});

test("压缩走 Codex 自己的压缩，屏幕上的记录不被改写", async (t) => {
  const f = await setup(t, { usage: 150_000 });
  await f.service.send(f.task.id, "第一句");
  await finished(f.service, f.task.id);
  assert.deepEqual(f.service.get(f.task.id).contextUsage, { tokens: 150_000, window: 190_000 });
  const before = f.service.get(f.task.id).messages.length;
  await f.service.compact(f.task.id);
  const methods = f.calls.map((call) => call.method);
  assert.ok(methods.includes("thread/compact/start"), "应当调用 Codex 的压缩");
  assert.equal(methods.filter((method) => method === "turn/start").length, 1, "压缩本身就是一轮，不该再多起一轮");
  assert.ok(methods.lastIndexOf("thread/resume") < methods.lastIndexOf("thread/compact/start"), "压缩前必须先把会话载入");
  assert.equal(methods.at(-1), "stop", "临时运行时必须关掉");
  const task = f.service.get(f.task.id);
  assert.equal(task.messages.length, before, "压缩不该改动已经显示的对话");
  assert.ok(task.compactedAt > 0);
  assert.equal(task.contextUsage, null, "压缩后上下文变小了，等下一次回复再报");
});

test("压缩没完成时如实报错，不会假装压过", async (t) => {
  const f = await setup(t, { compactCompletes: false });
  await f.service.send(f.task.id, "第一句");
  await finished(f.service, f.task.id);
  const client = { emit: null };
  // 让运行时中途退出：压缩必须失败，而不是永远挂着或悄悄标记成功。
  const factory = f.service.runtimeFactory;
  f.service.runtimeFactory = async (...args) => {
    const runtime = await factory(...args);
    const request = runtime.client.request;
    runtime.client.request = async (method, params) => {
      const result = await request(method, params);
      if (method === "thread/compact/start") queueMicrotask(() => runtime.client.emit("stopped", new Error("运行时退出")));
      return result;
    };
    client.emit = runtime.client;
    return runtime;
  };
  await assert.rejects(() => f.service.compact(f.task.id), /压缩未完成/);
  assert.equal(f.service.get(f.task.id).compactedAt, undefined);
});

test("回退同时退掉 Codex 的上下文和这里的记录，两边不会各说各话", async (t) => {
  const f = await setup(t);
  for (const text of ["第一句", "第二句", "第三句"]) { await f.service.send(f.task.id, text); await finished(f.service, f.task.id); }
  const asked = f.service.get(f.task.id).messages.filter((message) => message.role === "user");
  assert.equal(asked.length, 3);
  await f.service.rollback(f.task.id, 2);
  // Codex 那边：从第二句那一轮之前分叉出新的会话线。thread/rollback 已被标为
  // 废弃，锁定的 Codex 对分页会话直接拒绝它（实测）。
  const fork = f.calls.find((call) => call.method === "thread/fork");
  assert.deepEqual(fork.params, { threadId: "codex-thread", beforeTurnId: asked[1].turn.codexTurnId, excludeTurns: true });
  assert.equal(typeof asked[1].turn.codexTurnId, "string");
  assert.equal(f.calls.some((call) => call.method === "thread/rollback"), false);
  assert.equal(f.service.get(f.task.id).codexThreadId, "codex-thread-fork");
  const remaining = f.service.get(f.task.id).messages;
  assert.deepEqual(remaining.filter((message) => message.role === "user").map((message) => message.text), ["第一句"]);
  assert.equal(remaining.some((message) => message.text === "第二句"), false);
});

test("回退轮数不合法、超过实际轮数、以及没开始对话都被拒绝", async (t) => {
  const f = await setup(t);
  await assert.rejects(() => f.service.rollback(f.task.id, 1), /还没有那么多轮/);
  await f.service.send(f.task.id, "只有一句");
  await finished(f.service, f.task.id);
  for (const turns of [0, -1, 1.5, 51, "2", null]) await assert.rejects(() => f.service.rollback(f.task.id, turns), /回退轮数/);
  await assert.rejects(() => f.service.rollback(f.task.id, 2), /还没有那么多轮/);
});

test("运行中追加的指令走 Codex 的 steer，而不是打断重来", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-steer-"));
  // Closed before its folder goes, in one hook: a turn a test leaves running
  // saves its record every second, a save landing mid-removal fails the
  // removal, and Node then skips the later hooks -- so the service was never
  // closed and the file never exited (seen once in a full run).
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive: true, force: true }); });
  const calls = [];
  let release;
  const store = new TaskStore(path.join(directory, "records"));
  service = new TaskService({ store, runtimeFactory: async () => {
    const client = new EventEmitter();
    client.start = async () => {}; client.stop = async () => {};
    client.request = async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "codex-thread" } };
      if (method === "turn/start") {
        // 这一轮先挂着，模拟正在执行，直到测试放行为止。
        release = () => client.emit("notification", { method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "turn", status: "completed", items: [] } } });
        // 真实的 Codex 要过一会儿才回这一轮的编号；在那之前任务已经是「执行中」。
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { turn: { id: "turn" } };
      }
      // 真实的 app-server 会校验参数：少了 expectedTurnId 整条追加会被丢弃。
      // 之前这个替身什么都收，于是测试通过而线上功能是坏的。
      if (method === "turn/steer") {
        if (typeof params?.expectedTurnId !== "string" || !params.expectedTurnId) throw new Error("Invalid request: missing field `expectedTurnId`");
        if (!Array.isArray(params.input) || !params.input.length) throw new Error("Invalid request: missing field `input`");
      }
      return {};
    };
    return { client, params: {} };
  } });
  await service.init();
  const task = await service.create({ mode: "cowork", cwd: directory });
  await service.send(task.id, "先做这个");
  // 追加要指名正在跑的那一轮，所以等 Codex 回了这一轮的编号再追加。以前这里
  // 固定等 20 毫秒：机器一忙，这一轮还没开始，追加就被拒绝（在 CI 式的整套
  // 运行里撞到过）。
  for (const until = Date.now() + 5000; !service.active.get(task.id)?.turnId;) {
    assert.ok(Date.now() < until, "这一轮一直没开始");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(service.get(task.id).status, "running");

  await service.steer(task.id, "顺便也看看第二页");
  const steer = calls.find((call) => call.method === "turn/steer");
  assert.deepEqual(steer.params.threadId, "codex-thread");
  // 必须指名正在跑的那一轮，否则补充的话会被丢给下一轮或者直接丢掉。
  assert.equal(steer.params.expectedTurnId, "turn");
  assert.equal(steer.params.input[0].text, "顺便也看看第二页");
  assert.equal(calls.filter((call) => call.method === "turn/interrupt").length, 0, "追加指令不该打断这一轮");
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 1, "追加指令不该另起一轮");
  // 追加的内容要出现在对话里，并标明它是中途插入的。
  const last = service.get(task.id).messages.at(-1);
  assert.deepEqual([last.role, last.text, last.steered], ["user", "顺便也看看第二页", true]);
  release();
  await finished(service, task.id);
});

test("没有在执行的任务不能被追加指令，空内容也不接受", async (t) => {
  const f = await setup(t);
  await assert.rejects(() => f.service.steer(f.task.id, "补充"), /没有正在执行/);
  await assert.rejects(() => f.service.steer(f.task.id, "   "), /请输入/);
});

test("正在执行的任务不能被删除、压缩或回退", async (t) => {
  const f = await setup(t);
  await f.service.send(f.task.id, "第一句");
  await finished(f.service, f.task.id);
  f.service.active.set(f.task.id, { done: { promise: Promise.resolve() } });
  for (const [what, run] of [["删除", () => f.service.remove(f.task.id)], ["压缩", () => f.service.compact(f.task.id)], ["回退", () => f.service.rollback(f.task.id, 1)]]) {
    await assert.rejects(run, /正在执行/, `${what}应当被拒绝`);
  }
  f.service.active.delete(f.task.id);
});
