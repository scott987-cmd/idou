import test from "node:test";
import assert from "node:assert/strict";
import { relativeTime, scheduleStatus, runLabel, dateGroup } from "../src/desktop/renderer/schedules.js";

// The words the 定时任务 page uses for time and state, in WorkBuddy's own
// phrasing (automation.time.*, automation.row.*, automation.result.*,
// automation.dateGroup.*), checked against the moments they describe.
const NOW = new Date(2026, 8, 19, 10, 0).getTime();
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

test("when a task runs next is said the way the reference rows say it", () => {
  assert.equal(relativeTime(NOW - 1, NOW), "即将");
  assert.equal(relativeTime(NOW, NOW), "即将");
  assert.equal(relativeTime(NOW + 20_000, NOW), "1分钟后", "never 0 minutes");
  assert.equal(relativeTime(NOW + 59 * MINUTE, NOW), "59分钟后");
  assert.equal(relativeTime(NOW + 3 * HOUR + 5 * MINUTE, NOW), "3小时后");
  assert.equal(relativeTime(NOW + 2 * DAY + HOUR, NOW), "2天后");
});

test("a task row says what is true of it now, the most pressing first", () => {
  const active = { state: "active", suspended: false, endAt: null, nextAt: NOW + 3 * HOUR, lastRun: null };
  assert.deepEqual(scheduleStatus(active, NOW), { text: "3小时后执行", tone: "next" });
  assert.deepEqual(scheduleStatus({ ...active, lastRun: { finishedAt: null } }, NOW), { text: "运行中", tone: "running" }, "a run going outranks everything");
  assert.deepEqual(scheduleStatus({ ...active, state: "paused", lastRun: { finishedAt: NOW } }, NOW), { text: "已暂停", tone: "quiet" });
  assert.deepEqual(scheduleStatus({ ...active, suspended: true }, NOW), { text: "等待重新授权", tone: "attention" });
  assert.deepEqual(scheduleStatus({ ...active, endAt: NOW - 1 }, NOW), { text: "已过期，不再执行", tone: "quiet" });
  assert.deepEqual(scheduleStatus({ ...active, nextAt: null }, NOW), { text: "暂无后续执行", tone: "quiet" });
});

test("a run is named by how it ran and how it ended", () => {
  const run = (extra) => ({ finishedAt: NOW, outcome: "completed", kind: "scheduled", ...extra });
  assert.deepEqual(runLabel(run({ finishedAt: null, outcome: null })), { text: "运行中", tone: "running" });
  assert.equal(runLabel(run({})).text, "成功");
  assert.equal(runLabel(run({ outcome: "failed" })).text, "失败");
  assert.equal(runLabel(run({ kind: "manual" })).text, "测试运行完成", "立即运行 is WorkBuddy's 测试运行");
  assert.equal(runLabel(run({ kind: "manual", outcome: "failed" })).text, "失败");
  assert.equal(runLabel(run({ kind: "catch-up" })).text, "补跑完成");
  assert.equal(runLabel(run({ kind: "catch-up", outcome: "failed" })).text, "补跑失败");
  assert.equal(runLabel(run({ outcome: "skipped" })).text, "已跳过");
});

test("runs fall under 今天, 昨天, or their month and day", () => {
  const now = new Date(2026, 8, 19, 0, 30);
  assert.equal(dateGroup(new Date(2026, 8, 19, 0, 5).getTime(), now), "今天");
  assert.equal(dateGroup(new Date(2026, 8, 18, 23, 59).getTime(), now), "昨天", "by the calendar day, not 24 hours");
  assert.equal(dateGroup(new Date(2026, 8, 17, 9, 0).getTime(), now), "9/17");
  assert.equal(dateGroup(new Date(2026, 0, 3, 9, 0).getTime(), now), "1/3");
});

test("a resource is called by the name it was picked by, never by Feishu's id", async () => {
  const { resourceName } = await import("../src/desktop/renderer/schedules.js");
  assert.equal(resourceName({ kind: "chat", id: "oc_17cca541078b39785d0d02beff0c39a7", label: "产品周会群" }), "产品周会群");
  // Typed in by its ID, the ID stood in as its label (the server keeps it so).
  assert.equal(resourceName({ kind: "chat", id: "oc_17cca541078b39785d0d02beff0c39a7", label: "oc_17cca541078b39785d0d02beff0c39a7" }), "（没有名称 · …39a7）");
  assert.equal(resourceName({ kind: "chat", id: "oc_17cca541078b39785d0d02beff0c39a7", label: "" }), "（没有名称 · …39a7）");
  assert.equal(resourceName({ kind: "chat", id: "oc_17cca541078b39785d0d02beff0c39a7", label: "ou_46d524fd9f471a9b" }), "（没有名称 · …39a7）", "another id is not a name either");
  assert.equal(resourceName({ kind: "document", reference: "https://x.feishu.cn/docx/Abc", label: "周报" }), "周报");
  assert.equal(resourceName({ kind: "document", reference: "https://x.feishu.cn/docx/Abc", label: "" }), "https://x.feishu.cn/docx/Abc");
  for (const text of ["（没有名称 · …39a7）", "产品周会群"]) assert.doesNotMatch(text, /\b(?:ou|on|oc|cli)_[0-9a-z_]{6,}/i);
});
