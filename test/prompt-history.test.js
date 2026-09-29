import test from "node:test";
import assert from "node:assert/strict";
import { recallPrompt, sentPrompts } from "../src/desktop/renderer/prompt-history.js";

const tasks = [
  { id: "old", mode: "coding", cwd: "/p", updatedAt: 1, messages: [{ role: "user", text: "旧任务的话" }, { role: "assistant", text: "好" }] },
  { id: "open", mode: "coding", cwd: "/p", updatedAt: 2, messages: [
    { role: "user", text: "第一句" }, { role: "assistant", text: "好" }, { role: "user", text: "顺便加测试", steered: true }, { role: "user", text: " 第二句 " }] },
  { id: "newer", mode: "coding", cwd: "/p", updatedAt: 3, messages: [{ role: "user", text: "第一句" }, { role: "user", text: "别的任务" }] },
  { id: "elsewhere", mode: "coding", cwd: "/q", updatedAt: 9, messages: [{ role: "user", text: "另一个目录" }] },
  { id: "work", mode: "cowork", cwd: "/p", updatedAt: 9, messages: [{ role: "user", text: "工作任务" }] },
];

test("what was sent before: the open task's newest first, then the same folder's other tasks, no repeats", () => {
  assert.deepEqual(sentPrompts(tasks, { taskId: "open", cwd: "/p" }), ["第二句", "顺便加测试", "第一句", "别的任务", "旧任务的话"]);
  assert.deepEqual(sentPrompts(tasks, { cwd: "/p" }), ["别的任务", "第一句", "第二句", "顺便加测试", "旧任务的话"], "no task open: the folder's, most recently active first");
  assert.deepEqual(sentPrompts(tasks, { taskId: "open", cwd: "/p", limit: 2 }), ["第二句", "顺便加测试"]);
  assert.deepEqual(sentPrompts(tasks, { taskId: "work", mode: "cowork" }), ["工作任务"]);
  assert.deepEqual(sentPrompts(undefined), []);
});

const at = (value, caret = value.length) => ({ value, selectionStart: caret, selectionEnd: caret });
const entries = ["第二句", "第一句"];

test("↑ from an empty box goes back one at a time, and stays at the oldest", () => {
  let shown = recallPrompt({ ...at(""), entries, index: -1 }, 1);
  assert.deepEqual(shown, { value: "第二句", index: 0 });
  shown = recallPrompt({ ...at(shown.value), entries, index: shown.index }, 1);
  assert.deepEqual(shown, { value: "第一句", index: 1 });
  assert.deepEqual(recallPrompt({ ...at("第一句"), entries, index: 1 }, 1), { value: "第一句", index: 1 });
});

test("↓ comes forward, and past the newest is the empty box again", () => {
  assert.deepEqual(recallPrompt({ ...at("第一句"), entries, index: 1 }, -1), { value: "第二句", index: 0 });
  assert.deepEqual(recallPrompt({ ...at("第二句"), entries, index: 0 }, -1), { value: "", index: -1 });
});

test("a draft of the person's own is never replaced, and the caret still moves inside longer text", () => {
  assert.equal(recallPrompt({ ...at("我正在写"), entries, index: -1 }, 1), null, "their own words");
  assert.equal(recallPrompt({ ...at("第二句 改了"), entries, index: 0 }, 1), null, "a brought-back prompt, once edited, is theirs");
  const two = "第一行\n第二行";
  assert.equal(recallPrompt({ ...at(two), entries: [two], index: 0 }, 1), null, "↑ on the second line moves the caret up");
  assert.deepEqual(recallPrompt({ ...at(two, 2), entries: [two, "更早"], index: 0 }, 1), { value: "更早", index: 1 }, "↑ on the first line goes back");
  assert.equal(recallPrompt({ ...at(two, 2), entries: [two], index: 0 }, -1), null, "↓ above the last line moves the caret down");
});
