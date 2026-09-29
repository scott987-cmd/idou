import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskQueue, taskQueueConfigRevision } from "../src/application/task-queue.js";

async function opened(t, clock = { now: 1 }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-queue-")); t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "queue.json"), queue = new TaskQueue(filename, { now: () => ++clock.now }); await queue.init();
  return { root, filename, queue, taskId: randomUUID(), config: "a".repeat(64) };
}
const request = (text = "下一轮") => ({ clientRequestId: randomUUID(), text, options: { references: [] } });

test("queue persists before acknowledging, deduplicates request ids and enforces FIFO and capacity", async t => {
  const f = await opened(t), first = request("第一条"), second = request("第二条");
  const one = await f.queue.enqueue(f.taskId, first, f.config); assert.equal(JSON.parse(await readFile(f.filename, "utf8")).entries[0].id, one.id);
  assert.equal((await f.queue.enqueue(f.taskId, first, f.config)).id, one.id);
  await assert.rejects(f.queue.enqueue(f.taskId, { ...first, text: "偷换内容" }, f.config), /不能改成不同内容/);
  const two = await f.queue.enqueue(f.taskId, second, f.config);
  assert.equal((await f.queue.begin(f.taskId, f.config)).id, one.id); await f.queue.dispatched(f.taskId, one.id, "turn-1");
  assert.equal((await f.queue.begin(f.taskId, f.config)).id, two.id);
  const another = await opened(t); for (let i = 0; i < 10; i++) await another.queue.enqueue(another.taskId, request(String(i)), another.config);
  await assert.rejects(another.queue.enqueue(another.taskId, request("满了"), another.config), /最多 10 条/);
});

test("payload size is measured as UTF-8 bytes", async t => {
  const f = await opened(t);
  await assert.rejects(f.queue.enqueue(f.taskId, request("中".repeat(100_000)), f.config), /内容和引用过多/);
});

test("revision conflicts and remove races keep the latest queued content", async t => {
  const f = await opened(t), row = await f.queue.enqueue(f.taskId, request("原文"), f.config);
  const changed = await f.queue.update(f.taskId, row.id, row.revision, { text: "新文", options: { references: [] } });
  assert.equal(changed.state, "paused"); assert.equal(changed.payload.text, "新文");
  await assert.rejects(f.queue.update(f.taskId, row.id, row.revision, { text: "旧写覆盖" }), /已变化/);
  await assert.rejects(f.queue.remove(f.taskId, row.id, row.revision), /已变化/);
  await f.queue.remove(f.taskId, row.id, changed.revision); assert.equal(f.queue.snapshot(f.taskId).entries.length, 0);
});

test("restart pauses queued work and quarantines an uncertain dispatch without replay", async t => {
  const f = await opened(t), queued = await f.queue.enqueue(f.taskId, request("还没派发"), f.config), uncertain = await f.queue.enqueue(f.taskId, request("已经开始派发"), f.config);
  assert.equal((await f.queue.begin(f.taskId, f.config)).id, queued.id); await f.queue.dispatched(f.taskId, queued.id, "turn-done");
  assert.equal((await f.queue.begin(f.taskId, f.config)).id, uncertain.id);
  const restored = new TaskQueue(f.filename, { now: () => 50 }); await restored.init();
  const state = restored.snapshot(f.taskId), failed = state.entries.find(row => row.id === uncertain.id);
  assert.equal(state.paused, true); assert.equal(failed.state, "failed"); assert.equal(failed.unknown, true); assert.match(failed.reason, /不会自动重试/);
  await restored.resume(f.taskId, f.config); assert.equal(await restored.begin(f.taskId, f.config), null, "unknown dispatch is never made queued again");
});

test("configuration changes pause all later entries until an explicit rebase", async t => {
  const f = await opened(t), row = await f.queue.enqueue(f.taskId, request(), f.config), changed = "b".repeat(64);
  assert.equal(await f.queue.begin(f.taskId, changed), null); assert.equal(f.queue.snapshot(f.taskId).entries[0].state, "paused");
  await f.queue.resume(f.taskId, changed); const dispatch = await f.queue.begin(f.taskId, changed); assert.equal(dispatch.id, row.id); assert.equal(dispatch.capturedConfigRevision, changed);
});

test("future schema remains untouched and read-only", async t => {
  const f = await opened(t); await writeFile(f.filename, JSON.stringify({ schemaVersion: 2, future: true }));
  const queue = new TaskQueue(f.filename); await queue.init(); assert.equal(queue.readOnly, true);
  await assert.rejects(queue.enqueue(f.taskId, request(), f.config), /更新版本/);
  assert.deepEqual(JSON.parse(await readFile(f.filename, "utf8")), { schemaVersion: 2, future: true });
});

test("configuration revision covers permissions, knowledge, bindings and model", () => {
  const task = { mode: "cowork", cwd: "/tmp/work", permission: "standard", knowledgeScope: { mode: "recent" } };
  const base = taskQueueConfigRevision(task, "MiniMax-M3");
  assert.notEqual(taskQueueConfigRevision({ ...task, permission: "full" }, "MiniMax-M3"), base);
  assert.notEqual(taskQueueConfigRevision(task, "GLM-5.3"), base);
});
