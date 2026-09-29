import test from "node:test";
import assert from "node:assert/strict";
import { joinSplitAnswers } from "../src/application/split-answers.js";
import { codingTurns } from "../src/desktop/renderer/coding-timeline.js";

// The shape of a real record (knowledge evaluation q11, 2026-09-21): a step the
// Agent narrated, a search, then the answer in pieces cut mid-word -- 「云」 in one
// message, 「岫教育」 in the next -- with nothing between them.
const record = () => ({
  messages: [
    { id: "u1", role: "user", text: "唐雨桐这趟最多能报多少？", seq: 1 },
    { id: "a1", role: "assistant", text: "我先查一下出差标准。", seq: 2 },
    { id: "a2", role: "assistant", text: "行程：去成都，在云", seq: 4 },
    { id: "a3", role: "assistant", text: "岫教育现场支持，4 天 3 晚。", seq: 5 },
    { id: "a4", role: "assistant", text: "合计最多可报 **1,750 元**。", seq: 6 },
  ],
  activity: [{ id: "c1", type: "commandExecution", command: "kb-search 出差 住宿", status: "completed", seq: 3 }],
});

test("an answer sent in pieces is one answer; a step before it stays a step", () => {
  const shown = joinSplitAnswers(record().messages, record().activity);
  assert.deepEqual(shown.map((message) => [message.id, message.text]), [
    ["u1", "唐雨桐这趟最多能报多少？"],
    ["a1", "我先查一下出差标准。"],
    ["a2", "行程：去成都，在云岫教育现场支持，4 天 3 晚。合计最多可报 **1,750 元**。"],
  ], "the search between a1 and a2 keeps them apart; nothing between the pieces does");
  assert.deepEqual(shown[2].pieces, ["a2", "a3", "a4"]);
});

test("the record itself is never rewritten", () => {
  const task = record();
  const before = JSON.stringify(task);
  joinSplitAnswers(task.messages, task.activity);
  assert.equal(JSON.stringify(task), before);
});

test("what is applied from a message by its id is left as it is", () => {
  const edits = [
    { id: "u1", role: "user", text: "改一下第二段", seq: 1, context: { kind: "feishu-document", intent: "propose-edit" } },
    { id: "a1", role: "assistant", text: "{\"kind\":\"feishu-", seq: 2 },
    { id: "a2", role: "assistant", text: "text-edit\"}", seq: 3 },
  ];
  assert.equal(joinSplitAnswers(edits, []).length, 3, "an edit proposal is read back by id, so its pieces are not joined for show");
  const written = [
    { id: "u1", role: "user", text: "写进表格", seq: 1 },
    { id: "a1", role: "assistant", text: "已写入。", seq: 2, sheetEdit: { state: "applied" } },
    { id: "a2", role: "assistant", text: "还有别的吗？", seq: 3 },
  ];
  assert.equal(joinSplitAnswers(written, []).length, 3, "a write record stays its own message");
});

test("different speakers, turns and records without an order are not joined", () => {
  const messages = [
    { id: "u1", role: "user", text: "开始", seq: 1 },
    { id: "a1", role: "assistant", text: "主 agent。", seq: 2 },
    { id: "s1", role: "assistant", text: "子 agent。", seq: 3, agent: "/root/worker" },
    { id: "s2", role: "user", text: "顺便加测试", seq: 4, steered: true },
    { id: "a2", role: "assistant", text: "好的。", seq: 5 },
    { id: "a3", role: "assistant", text: "旧记录没有序号。" },
  ];
  assert.deepEqual(joinSplitAnswers(messages, []).map((message) => message.id), ["u1", "a1", "s1", "s2", "a2", "a3"]);
});

test("a coding turn reads the pieces as one block of words", () => {
  const [turn] = codingTurns(record());
  assert.deepEqual(turn.entries.map((entry) => entry.kind), ["text", "command", "text"], "words, the search, then the answer once");
  const words = turn.entries.filter((entry) => entry.kind === "text").map((entry) => entry.message.text);
  assert.deepEqual(words, ["我先查一下出差标准。", "行程：去成都，在云岫教育现场支持，4 天 3 晚。合计最多可报 **1,750 元**。"]);
});
