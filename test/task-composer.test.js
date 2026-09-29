import test from "node:test";
import assert from "node:assert/strict";
import { composerState, dispatchError, draftReferenceKey, referenceContext } from "../src/desktop/renderer/task-composer.js";

test("composer state distinguishes send, steer, queue, waiting approval and stopping", () => {
  assert.deepEqual(composerState({ text: "做一下" }), { action: "send", label: "发送 ↑", disabled: false, reason: "", queueVisible: false, queueDisabled: true });
  assert.equal(composerState({ task: { status: "running", runtime: { canSteer: false }, queue: {} }, text: "下一轮" }).action, "queue");
  assert.deepEqual(composerState({ task: { status: "running", runtime: { canSteer: true }, queue: {} }, text: "补充" }), {
    action: "steer", label: "补充 ↑", disabled: false, reason: "把这句补充给正在执行的这一轮", queueVisible: true, queueDisabled: false,
  });
  assert.match(composerState({ task: { status: "awaiting_approval", queue: {} }, text: "不要替代确认" }).reason, /确认不会被替代/);
  assert.deepEqual(composerState({ task: { status: "stopping" }, text: "保留" }), {
    action: "blocked", label: "停止中…", disabled: true, reason: "任务正在停止；可以继续编辑草稿", queueVisible: false, queueDisabled: true,
  });
});

// 2026-09-23, while recording: a 停止 button beside 发送 was the one hit by
// mistake. As in WorkBuddy there is one button where 发送 is: it stops a running
// turn only when nothing is typed, and with a sentence typed it sends it.
test("while a turn runs, the send button stops it only when nothing is typed", () => {
  const running = { status: "running", runtime: { canSteer: true }, queue: {} };
  assert.deepEqual(composerState({ task: running, text: "" }), { action: "stop", label: "停止", disabled: false, reason: "停止这一轮；也可以连按两下 Esc", queueVisible: false, queueDisabled: true });
  assert.equal(composerState({ task: running, text: "   " }).action, "stop", "blank is nothing typed");
  assert.equal(composerState({ task: { status: "awaiting_approval", queue: {} }, text: "" }).action, "stop");
  assert.equal(composerState({ task: { status: "running", runtime: { canSteer: false }, queue: {} }, text: "" }).action, "stop");
  assert.equal(composerState({ task: running, text: "", stopPending: true }).disabled, true, "a stop already asked for is not asked again");
  const typed = composerState({ task: running, text: "补一句" });
  assert.equal(typed.action, "steer"); assert.equal("stopVisible" in typed, false, "no stop button beside it");
  assert.equal(composerState({ task: running, text: "", imageCount: 1 }).action, "queue", "a pasted image is something to send");
  assert.equal(composerState({ text: "" }).action, "send", "and with nothing running there is nothing to stop");
});

test("composer blocks unsupported image paths without discarding the draft", () => {
  const steer = composerState({ task: { status: "running", runtime: { canSteer: true }, queue: {} }, text: "看图", imageCount: 1 });
  assert.equal(steer.action, "queue"); assert.equal(steer.disabled, false);
  const send = composerState({ text: "看图", imageCount: 1, imageModel: { sees: false, label: "文本模型" } });
  assert.equal(send.disabled, true); assert.match(dispatchError({ action: send.action, imageCount: 1, imageModel: { sees: false, label: "文本模型" } }), /更换模型/);
});

test("selection references keep their original identity and version", () => {
  const reference = { kind: "selection", resourceKind: "workspace-file", resourceKey: "workspace:a.js", path: "a.js", revision: "a".repeat(64), state: "current", selection: { start: 2, end: 8 } };
  assert.equal(draftReferenceKey(reference), `selection:workspace:a.js:${"a".repeat(64)}:2:8`);
  assert.deepEqual(referenceContext(reference), { path: "a.js", revision: "a".repeat(64), selection: { start: 2, end: 8 } });
  assert.equal(referenceContext({ ...reference, state: "changed" }), null);
});

test("terminal selections retain only their draft reference identity", () => {
  const reference = { kind: "terminal", key: "terminal:11111111-1111-4111-8111-111111111111:1720000000000", title: "终端输出", excerpt: "selected" };
  assert.equal(draftReferenceKey(reference), reference.key);
  assert.equal(referenceContext(reference), null);
});
