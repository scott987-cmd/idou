import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalNotices, approvalNoticeText, confirmationNoticeText, shouldAnnounceConfirmation } from "../src/desktop/confirmation-notice.js";

// 2026-09-23: a work task's video card sat its five minutes and lapsed, twice,
// while i豆 was behind another app -- the card was drawn in the window and
// nothing else said it was there.
test("a card is announced whenever the window is not the one the person is looking at", () => {
  assert.equal(shouldAnnounceConfirmation({ focused: true, minimized: false, visible: true }), false, "in front of them: no noise");
  assert.equal(shouldAnnounceConfirmation({ focused: false, minimized: false, visible: true }), true, "behind another app");
  assert.equal(shouldAnnounceConfirmation({ focused: true, minimized: true, visible: true }), true, "minimised");
  assert.equal(shouldAnnounceConfirmation({ focused: true, minimized: false, visible: false }), true, "hidden");
});

test("the announcement names the kind of decision and how long it lasts, never its details", () => {
  const text = confirmationNoticeText("确认生成视频", 5 * 60_000);
  assert.deepEqual(text, { title: "i豆 需要你确认", body: "确认生成视频：回到 i豆 点确认或取消，5 分钟内有效。" });
  assert.equal(confirmationNoticeText("确认发送飞书私信", 1000).body, "确认发送飞书私信：回到 i豆 点确认或取消，1 秒内有效。");
  assert.equal(confirmationNoticeText("", NaN).body, "有一项操作：回到 i豆 点确认或取消。");
  assert.equal(confirmationNoticeText("很长".repeat(50), 60_000).body.length < 80, true, "a title is cut short rather than filling a notification");
});

// 2026-09-23: in a real coding task a command card waited seven minutes behind
// another app. A task's own cards were never announced, only the application's.
test("a task's card says what kind of card it is, never the command", () => {
  assert.deepEqual(approvalNoticeText("command"), { title: "i豆 需要你确认", body: "任务要运行一条命令：回到 i豆 点允许或拒绝。" });
  assert.equal(approvalNoticeText("file").body, "任务要修改文件：回到 i豆 点允许或拒绝。");
  assert.equal(approvalNoticeText("mcp").body, "任务要使用一个连接器：回到 i豆 点允许或拒绝。");
  assert.deepEqual(approvalNoticeText("question"), { title: "i豆 在等你回答", body: "任务向你提了一个问题：回到 i豆 回答它。" });
  assert.equal(approvalNoticeText("something new").body, "任务有一项操作：回到 i豆 点允许或拒绝。");
});

test("each task card is announced once when it appears and withdrawn when it goes", () => {
  const shown = [], closed = [];
  let inFront = false;
  const notices = new ApprovalNotices((text) => {
    if (inFront) return null;
    const handle = { text, close: () => closed.push(text.body) };
    shown.push(text.body);
    return handle;
  });
  const command = { id: "a", kind: "command", command: "rm -rf /secret" };
  notices.update([command]);
  notices.update([command]);
  notices.update([{ ...command }]);
  assert.deepEqual(shown, ["任务要运行一条命令：回到 i豆 点允许或拒绝。"], "a repaint of the same card is not a new card");
  assert.equal(JSON.stringify(shown).includes("secret"), false);
  notices.update([command, { id: "b", kind: "question" }]);
  assert.equal(shown.length, 2, "a second card is announced on its own");
  notices.update([{ id: "b", kind: "question" }]);
  assert.deepEqual(closed, ["任务要运行一条命令：回到 i豆 点允许或拒绝。"], "the answered card's notice goes, the other stays");
  // Seen in front of the person: not announced, then or later.
  inFront = true; notices.update([{ id: "b", kind: "question" }, { id: "c", kind: "file" }]);
  inFront = false; notices.update([{ id: "b", kind: "question" }, { id: "c", kind: "file" }]);
  assert.equal(shown.length, 2);
  notices.clear();
  assert.deepEqual(closed, ["任务要运行一条命令：回到 i豆 点允许或拒绝。", "任务向你提了一个问题：回到 i豆 回答它。"], "an account switch takes every notice with it");
  // An announcement that fails leaves the card to the window, and the rest go on.
  const failing = new ApprovalNotices(() => { throw new Error("no notifications here"); });
  assert.doesNotThrow(() => failing.update([{ id: "x", kind: "command" }]));
  assert.doesNotThrow(() => failing.update(undefined));
});

// A notice leads to its card: it carries the task the card waits in, so a
// click can open that task (main.js announceConfirmation). It used to carry
// only its words, and a click only brought the window forward.
test("a task card's notice knows which task it is from", () => {
  const seen = [];
  const notices = new ApprovalNotices((text, item) => { seen.push({ text, taskId: item?.taskId }); return { close() {} }; });
  notices.update([{ id: "a1", kind: "command", taskId: "task-a" }, { id: "b1", kind: "mcp", taskId: "task-b" }]);
  assert.deepEqual(seen.map((row) => row.taskId), ["task-a", "task-b"]);
});
