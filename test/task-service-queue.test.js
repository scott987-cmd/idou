import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskQueue } from "../src/application/task-queue.js";
import { TaskService } from "../src/application/task-service.js";
import { TaskStore } from "../src/application/task-store.js";

async function waitFor(check, message = "timed out") {
  for (let index = 0; index < 200; index += 1) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(message);
}

async function setup(t, { canDispatchQueued = () => true, queueConfigRevision } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-service-queue-")); let service;
  t.after(async () => { await service?.close(); await rm(root, { recursive: true, force: true }); });
  const clients = [], starts = [];
  service = new TaskService({ store: new TaskStore(path.join(root, "tasks")), queue: new TaskQueue(path.join(root, "queue.json")), canDispatchQueued,
    ...(queueConfigRevision ? { queueConfigRevision } : {}),
    runtimeFactory: async () => {
      const client = new EventEmitter(); clients.push(client); client.start = async () => {}; client.stop = async () => {};
      client.respond = () => {}; client.respondError = () => {};
      client.request = async (method, params) => {
        if (["thread/start", "thread/resume"].includes(method)) return { thread: { id: "thread-queue" } };
        if (method === "turn/start") { const id = `turn-${starts.length + 1}`; starts.push({ client, id, params }); return { turn: { id } }; }
        return {};
      };
      return { client, params: {} };
    } });
  await service.init(); const task = await service.create({ mode: "cowork", cwd: root });
  return { root, service, task, clients, starts };
}
const complete = ({ client, id }) => client.emit("notification", { method: "turn/completed", params: { threadId: "thread-queue", turn: { id, status: "completed", items: [] } } });

test("completion and enqueue races dispatch FIFO at most once", async t => {
  const f = await setup(t); await f.service.send(f.task.id, "当前轮"); await waitFor(() => f.starts.length === 1);
  const requestId = randomUUID(); const queued = await f.service.enqueue(f.task.id, { clientRequestId: requestId, text: "下一轮" });
  assert.equal((await f.service.enqueue(f.task.id, { clientRequestId: requestId, text: "下一轮" })).id, queued.id, "IPC retry is deduplicated");
  complete(f.starts[0]); complete(f.starts[0]);
  await waitFor(() => f.starts.length === 2, "queued turn did not start");
  assert.deepEqual(f.service.get(f.task.id).messages.filter(row => row.role === "user").map(row => row.text), ["当前轮", "下一轮"]);
  assert.equal(f.service.snapshot().tasks[0].queue.entries.length, 0, "dispatched entry is no longer presented as queued");
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.starts.length, 2, "duplicate completion must not start another turn");
  complete(f.starts[1]); await waitFor(() => !f.service.active.has(f.task.id));
});

test("stop pauses later work; explicit resume is required", async t => {
  const f = await setup(t); await f.service.send(f.task.id, "当前轮"); await waitFor(() => f.starts.length === 1);
  await f.service.enqueue(f.task.id, { clientRequestId: randomUUID(), text: "停止后不能自己跑" });
  await f.service.stop(f.task.id); await waitFor(() => !f.service.active.has(f.task.id));
  assert.equal(f.service.snapshot().tasks[0].queue.paused, true); assert.equal(f.starts.length, 1);
  await f.service.setQueuePaused(f.task.id, false); await waitFor(() => f.starts.length === 2);
  complete(f.starts[1]); await waitFor(() => !f.service.active.has(f.task.id));
});

test("stopping a task without queued work does not create an empty paused queue", async t => {
  const f = await setup(t); await f.service.stop(f.task.id);
  const queue = f.service.snapshot().tasks[0].queue;
  assert.equal(queue.paused, false); assert.deepEqual(queue.entries, []);
});

test("permission changes during completion pause old queue until explicit config review", async t => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const f = await setup(t, { canDispatchQueued: async () => { entered.resolve(); return gate.promise; } });
  await f.service.send(f.task.id, "当前轮"); await waitFor(() => f.starts.length === 1);
  await f.service.enqueue(f.task.id, { clientRequestId: randomUUID(), text: "旧权限下排队" }); complete(f.starts[0]); await entered.promise;
  await f.service.setPermission(f.task.id, "full"); gate.resolve(true); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.starts.length, 1); assert.equal(f.service.snapshot().tasks[0].queue.paused, true); assert.match(f.service.snapshot().tasks[0].queue.reason, /权限/);
  f.service.canDispatchQueued = () => true; await f.service.setQueuePaused(f.task.id, false); await waitFor(() => f.starts.length === 2);
  complete(f.starts[1]); await waitFor(() => !f.service.active.has(f.task.id));
});

test("configuration cannot change once a queued dispatch has entered its commit gate", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const f = await setup(t, { queueConfigRevision: async task => {
    calls += 1;
    if (calls > 1) { entered.resolve(); await release.promise; }
    return "a".repeat(64);
  } });
  await f.service.send(f.task.id, "当前轮"); await waitFor(() => f.starts.length === 1);
  await f.service.enqueue(f.task.id, { clientRequestId: randomUUID(), text: "下一轮" });
  complete(f.starts[0]); await entered.promise;
  await assert.rejects(f.service.setPermission(f.task.id, "full"), /正在执行|正在派发/);
  release.resolve(); await waitFor(() => f.starts.length === 2);
  complete(f.starts[1]); await waitFor(() => !f.service.active.has(f.task.id));
});

test("uncertain write results keep the next turn paused", async t => {
  const f = await setup(t); await f.service.send(f.task.id, "当前轮"); await waitFor(() => f.starts.length === 1);
  await f.service.enqueue(f.task.id, { clientRequestId: randomUUID(), text: "不能越过不确定写入" });
  const task = f.service.get(f.task.id), opened = task.messages.findLast(row => row.role === "user");
  task.messages.push({ id: randomUUID(), role: "assistant", text: "写入结果未知", sheetEdit: { state: "unknown" }, seq: opened.seq + 1, createdAt: Date.now() });
  complete(f.starts[0]); await waitFor(() => f.service.snapshot().tasks[0].queue.paused);
  assert.equal(f.starts.length, 1); assert.match(f.service.snapshot().tasks[0].queue.reason, /写入结果待核对/);
});
