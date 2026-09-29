import test from "node:test";
import assert from "node:assert/strict";
import { knowledgeStatus, planSummary, taskTurns } from "../src/desktop/renderer/coding-timeline.js";

test("a steer stays in its original turn and does not replace that question's knowledge", () => {
  const knowledge = { documents: 1, unavailable: 0, sources: [{ sourceUrl: "https://example.test/doc" }] };
  const [turn] = taskTurns({ messages: [
    { id: "u1", role: "user", text: "原问题", knowledge, seq: 1 },
    { id: "a1", role: "assistant", text: "先查", seq: 2 },
    { id: "s1", role: "user", text: "补充条件", steered: true, seq: 3 },
    { id: "a2", role: "assistant", text: "最终回答", seq: 4 },
  ], activity: [] });
  assert.equal(turn.message.id, "u1");
  assert.equal(turn.knowledge, knowledge);
  assert.deepEqual(turn.entries.map((entry) => entry.kind), ["text", "steer", "text"]);
});

test("failed or declined reads are commands with visible output, never successful browsing", () => {
  const turns = taskTurns({ messages: [{ id: "u1", role: "user", text: "查一下", seq: 1 }], activity: [
    { id: "failed", type: "commandExecution", command: "/bin/zsh -lc 'kb-search policy'", status: "failed", exitCode: 2,
      output: "permission denied", actions: [{ type: "search", query: "policy" }], seq: 2 },
    { id: "declined", type: "commandExecution", command: "cat secret", status: "declined", output: "declined",
      actions: [{ type: "read", path: "secret" }], seq: 3 },
  ] });
  assert.deepEqual(turns[0].entries.map((entry) => entry.kind), ["command", "command"]);
  assert.equal(turns[0].entries[0].entry.output, "permission denied");
});

test("unordered old activity stays in a separate legacy turn and repeated ids stay in their own turns", () => {
  const turns = taskTurns({ messages: [
    { id: "u1", role: "user", text: "第一问", seq: 1 },
    { id: "same", role: "assistant", text: "第一答", seq: 2 },
    { id: "u2", role: "user", text: "第二问", seq: 3 },
    { id: "same", role: "assistant", text: "第二答", seq: 5 },
  ], activity: [
    { id: "same-step", type: "commandExecution", command: "first", status: "completed", seq: 4 },
    { id: "old", type: "commandExecution", command: "legacy", status: "completed" },
  ] });
  assert.equal(turns.length, 3);
  // Older than anything numbered, so it comes first (coding-timeline.js).
  const [legacy, ...numbered] = turns;
  assert.deepEqual(numbered.map((turn) => turn.entries.filter((entry) => entry.kind === "text").map((entry) => entry.message.text)), [["第一答"], ["第二答"]]);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.entries[0].command, "legacy");
});

test("plan and knowledge summaries have complete Chinese states", () => {
  assert.deepEqual(planSummary({ steps: [{ step: "先查资料" }, { step: "写总结", status: "completed" }] }), {
    completed: 1,
    total: 2,
    steps: [{ step: "先查资料", status: "pending", mark: "○" }, { step: "写总结", status: "completed", mark: "✓" }],
  });
  assert.equal(knowledgeStatus({ documents: 0, unavailable: 0 }), "没有检索到相关企业知识，本次回答未引用知识库资料。");
  assert.equal(knowledgeStatus({ documents: 0, unavailable: 2 }), "2 篇资料这次无法重新核验，本次回答未使用这些资料。");
  assert.equal(knowledgeStatus({ documents: 2, unavailable: 1 }), "已使用 2 篇资料；另有 1 篇这次无法重新核验，未参与回答。");
  assert.equal(knowledgeStatus({ documents: 0, unavailable: 0, failed: "gateway timeout" }), "企业知识检索失败：gateway timeout。本次回答未使用知识库资料。");
});
