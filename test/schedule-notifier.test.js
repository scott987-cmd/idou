import test from "node:test";
import assert from "node:assert/strict";
import { ScheduleNotifier, scheduleNotice } from "../src/application/schedule-notifier.js";

// A control plane's run list, as ScheduleClient.runs answers it, and a record
// of what the person was shown.
function harness({ runs = [], owner = "account-a", enabled = true } = {}) {
  const state = { runs, owner, enabled, shown: [], finished: [], asked: 0, fail: null };
  const notifier = new ScheduleNotifier({
    runs: async (limit) => { state.asked += 1; if (state.fail) throw state.fail; assert.equal(limit, 20); return { runs: structuredClone(state.runs) }; },
    identity: async () => state.owner,
    enabled: () => state.enabled,
    notify: (notice) => state.shown.push(notice),
    onFinished: (batch) => state.finished.push(batch.map((run) => run.id)),
  });
  return { state, notifier };
}
const run = (id, finishedAt, extra = {}) => ({ id, scheduleId: "s1", title: "每日 AI 早报", startedAt: finishedAt - 60_000, finishedAt, outcome: "completed", detail: "报告已保存", artifact: null, ...extra });

test("history is not news: the first look only sets the mark", async () => {
  const { state, notifier } = harness({ runs: [run("r1", 1000), run("r2", 2000)] });
  await notifier.poll();
  assert.deepEqual(state.shown, []);
  // Nothing new since: still nothing.
  await notifier.poll();
  assert.deepEqual(state.shown, []);
});

test("a run that finishes after the mark is told once, oldest first, and handed on", async () => {
  const { state, notifier } = harness({ runs: [run("r1", 1000)] });
  await notifier.poll();
  state.runs.unshift(run("r3", 3000), run("r2", 2000, { outcome: "failed", detail: "飞书读取失败\n第二行不显示" }));
  await notifier.poll();
  assert.deepEqual(state.shown.map((notice) => notice.runId), ["r2", "r3"]);
  assert.deepEqual(state.shown[0], { title: "定时任务执行失败", body: "「每日 AI 早报」：飞书读取失败", runId: "r2" });
  assert.deepEqual(state.finished, [["r2", "r3"]], "so 工作任务 can pick the result up at once");
  await notifier.poll();
  assert.equal(state.shown.length, 2, "and never again");
});

test("a run still going is not finished, and is told when it is", async () => {
  const { state, notifier } = harness({ runs: [] });
  await notifier.poll();
  state.runs.push({ ...run("r1", 5000), finishedAt: null, outcome: null });
  await notifier.poll();
  assert.equal(state.shown.length, 0);
  state.runs[0] = run("r1", 5000);
  await notifier.poll();
  assert.deepEqual(state.shown.map((notice) => notice.runId), ["r1"]);
});

test("two runs finishing in the same millisecond are both told, whichever arrives first", async () => {
  const { state, notifier } = harness({ runs: [run("r0", 1000)] });
  await notifier.poll();
  state.runs.unshift(run("a", 2000));
  await notifier.poll();
  state.runs.unshift(run("b", 2000));
  await notifier.poll();
  assert.deepEqual(state.shown.map((notice) => notice.runId), ["a", "b"]);
});

test("switched off, nothing is read or shown; switched back on, it starts from a fresh look", async () => {
  const { state, notifier } = harness({ runs: [run("r1", 1000)], enabled: false });
  await notifier.poll();
  assert.equal(state.asked, 0, "a switch that is off does not even ask");
  state.runs.unshift(run("r2", 2000));
  state.enabled = true;
  await notifier.poll();
  assert.deepEqual(state.shown, [], "what finished while it was off is history, not a burst");
  state.runs.unshift(run("r3", 3000));
  await notifier.poll();
  assert.deepEqual(state.shown.map((notice) => notice.runId), ["r3"]);
});

test("another account's runs are never told as this one's", async () => {
  const { state, notifier } = harness({ runs: [run("a1", 1000)] });
  await notifier.poll();
  state.owner = "account-b";
  state.runs = [run("b1", 500), run("b2", 4000)];
  await notifier.poll();
  assert.deepEqual(state.shown, [], "a new account starts from its own mark");
  state.runs.unshift(run("b3", 5000));
  await notifier.poll();
  assert.deepEqual(state.shown.map((notice) => notice.runId), ["b3"]);
});

test("signed out, offline or refused: silent, and the next look carries on", async () => {
  const { state, notifier } = harness({ runs: [run("r1", 1000)] });
  await notifier.poll();
  state.fail = new Error("与服务端的连接中断");
  assert.deepEqual(await notifier.poll(), { notified: 0 });
  state.fail = null;
  state.runs.unshift(run("r2", 2000));
  await notifier.poll();
  assert.deepEqual(state.shown.map((notice) => notice.runId), ["r2"]);
  state.owner = null;
  assert.deepEqual(await notifier.poll(), { notified: 0 });
});

test("a timer and a request at the same moment make one look", async () => {
  const { state, notifier } = harness({ runs: [] });
  await Promise.all([notifier.poll(), notifier.poll(), notifier.poll()]);
  assert.equal(state.asked, 1);
});

test("what a notice says: the name and how it ended, never the report", () => {
  assert.deepEqual(scheduleNotice(run("r1", 1, { artifact: { state: "verified" }, detail: "报告已保存到飞书云盘：https://x.feishu.cn/file/A" })),
    { title: "定时任务已完成", body: "「每日 AI 早报」已完成，报告已保存到飞书云盘。", runId: "r1" });
  assert.equal(scheduleNotice(run("r2", 1, { outcome: "skipped", detail: "无人值守授权已到期，任务已暂停。" })).title, "定时任务没有执行");
  assert.equal(scheduleNotice(run("r3", 1, { outcome: "failed", detail: "" })).body, "「每日 AI 早报」：请看运行记录");
  assert.equal(scheduleNotice(run("r4", 1, { title: null })).body, "「定时任务」已完成。");
  assert.match(scheduleNotice(run("r5", 1, { outcome: "failed", detail: "x".repeat(200) })).body, /x{80}…$/);
});
