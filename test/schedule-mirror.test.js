import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ScheduleMirror } from "../src/application/schedule-mirror.js";

const RULE = { id: "s-1", title: "每日Ai消息汇总", prompt: "把昨天的 AI 新闻汇总成十条。" };
const run = (over = {}) => ({ id: randomUUID(), scheduleId: RULE.id, title: RULE.title,
  startedAt: 1_000, finishedAt: 2_000, outcome: "completed", detail: "### 今天的十条…", ...over });

function world({ schedules = [RULE], runs = [], fail = null } = {}) {
  const tasks = new Map();
  const saved = [];
  const state = { created: 0, changed: 0 };
  const mirror = new ScheduleMirror({
    listTasks: () => [...tasks.values()],
    getTask: (id) => tasks.get(id),
    createTask: async ({ mode, cwd, title }) => {
      state.created += 1;
      const task = { schemaVersion: 1, id: randomUUID(), mode, cwd, permission: "reviewed", title,
        status: "idle", createdAt: 1, updatedAt: 1, messages: [], activity: [], codexThreadId: null, error: null };
      tasks.set(task.id, task);
      return task;
    },
    saveTask: async (task) => { saved.push(task.id); state.changed += 1; },
    schedules: {
      list: async () => { if (fail) throw new Error(fail); return { schedules }; },
      runs: async () => ({ runs }),
    },
    folder: async () => "/Users/someone/我的豆包/2026-09-17",
    log: (message) => state.log = message,
  });
  return { mirror, tasks, saved, state };
}

test("a finished run turns into a work task that reads like a conversation", async () => {
  const it = world({ runs: [run()] });
  assert.deepEqual(await it.mirror.sync(), { mirrored: 1 });

  const [task] = [...it.tasks.values()];
  assert.equal(task.mode, "cowork", "it belongs in 工作任务");
  assert.equal(task.title, RULE.title);
  assert.equal(task.status, "completed");
  assert.equal(task.updatedAt, 2_000, "ordered by when the run finished, not when it was mirrored");
  assert.deepEqual(task.messages.map((m) => m.role), ["user", "assistant"]);
  assert.match(task.messages[0].text, /汇总成十条/, "what was asked");
  assert.match(task.messages[1].text, /今天的十条/, "and what came back");
  assert.deepEqual(task.scheduleMirror, { scheduleId: RULE.id, lastFinishedAt: 2_000 });
  assert.equal(it.saved.length, 1);
});

test("the record carries a user turn, which is what makes it visible at all", async () => {
  // 工作任务 hides any task with no role:"user" message. A mirrored run with
  // only the answer would be written, saved, and invisible -- the exact
  // complaint this feature exists to answer.
  const it = world({ runs: [run()] });
  await it.mirror.sync();
  const [task] = [...it.tasks.values()];
  assert.equal(task.messages.some((message) => message.role === "user"), true);
});

test("a daily schedule is one conversation, not one task per morning", async () => {
  const it = world({ runs: [run({ finishedAt: 2_000 }), run({ startedAt: 90_000, finishedAt: 91_000, detail: "第二天" })] });
  assert.deepEqual(await it.mirror.sync(), { mirrored: 2 });

  assert.equal(it.tasks.size, 1, "a month of runs is not a month of rows in the list");
  assert.equal(it.state.created, 1);
  const [task] = [...it.tasks.values()];
  assert.deepEqual(task.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.match(task.messages[3].text, /第二天/);
  assert.equal(task.updatedAt, 91_000);
});

test("runs arrive in the order they happened, whatever order they are listed in", async () => {
  // The control plane returns newest first; a conversation read that way is
  // backwards.
  const it = world({ runs: [run({ finishedAt: 91_000, detail: "后来" }), run({ finishedAt: 2_000, detail: "先前" })] });
  await it.mirror.sync();
  const [task] = [...it.tasks.values()];
  assert.match(task.messages[1].text, /先前/);
  assert.match(task.messages[3].text, /后来/);
});

test("syncing twice does not say the same thing twice", async () => {
  const it = world({ runs: [run()] });
  await it.mirror.sync();
  assert.deepEqual(await it.mirror.sync(), { mirrored: 0 });
  const [task] = [...it.tasks.values()];
  assert.equal(task.messages.length, 2);
});

test("two syncs at once are one sync", async () => {
  const it = world({ runs: [run()] });
  const [a, b] = await Promise.all([it.mirror.sync(), it.mirror.sync()]);
  assert.deepEqual([a, b], [{ mirrored: 1 }, { mirrored: 1 }], "both see the same pass");
  const [task] = [...it.tasks.values()];
  assert.equal(task.messages.length, 2, "and it ran once");
});

test("only a run that finished is mirrored", async () => {
  // A failure and a skipped turn are real history, and the run record keeps
  // them. Neither is work a person would look for in 工作任务.
  const it = world({ runs: [run({ outcome: "failed", detail: "沙箱未能启动" }), run({ outcome: "skipped" }),
    run({ outcome: "completed", finishedAt: null })] });
  assert.deepEqual(await it.mirror.sync(), { mirrored: 0 });
  assert.equal(it.tasks.size, 0);
});

test("a run whose schedule is gone stays in the run record alone", async () => {
  // Its result is still the person's, but there is no prompt left to show as
  // the turn that asked for it, and a conversation with only one side is worse
  // than a run record.
  const it = world({ schedules: [], runs: [run()] });
  assert.deepEqual(await it.mirror.sync(), { mirrored: 0 });
  assert.equal(it.tasks.size, 0);
});

test("a control plane that cannot be reached is logged, never thrown", async () => {
  // The run records are already safe on the server. Failing to mirror them is a
  // missing convenience, and it must not take down whatever asked for the sync.
  const it = world({ fail: "connect ECONNREFUSED" });
  assert.deepEqual(await it.mirror.sync(), { mirrored: 0 });
  assert.match(it.state.log, /定时任务结果同步失败.*ECONNREFUSED/);
});

test("a very long result is trimmed rather than written whole into the record", async () => {
  const it = world({ runs: [run({ detail: "段".repeat(50_000) })] });
  await it.mirror.sync();
  const [task] = [...it.tasks.values()];
  assert.ok(task.messages[1].text.length <= 12_001);
  assert.match(task.messages[1].text, /…$/);
});

test("an empty result still reads as something, not as a blank turn", async () => {
  const it = world({ runs: [run({ detail: "" })] });
  await it.mirror.sync();
  const [task] = [...it.tasks.values()];
  assert.match(task.messages[1].text, /任务已完成/);
});

test("it refuses to be built without the pieces it needs", () => {
  assert.throws(() => new ScheduleMirror({ schedules: {} }), /listTasks/);
  assert.throws(() => new ScheduleMirror({ listTasks: () => [], getTask: () => {}, createTask: () => {}, saveTask: () => {}, folder: () => {} }), /定时任务客户端/);
});
