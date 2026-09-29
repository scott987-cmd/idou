import test from "node:test";
import assert from "node:assert/strict";
import { coworkTurns, workStepView } from "../src/desktop/renderer/cowork-timeline.js";

test("work steps stay with their own turn and legacy activity is never counted as a new result", () => {
  const source = { documents: 1, unavailable: 0, sources: [{ title: "员工手册", sourceUrl: "https://example.test/docx/a" }] };
  const turns = coworkTurns({ messages: [
    { id: "u1", role: "user", text: "查住宿标准", knowledge: source, seq: 1, turn: { startedAt: 1_000, finishedAt: 7_000, status: "completed" } },
    { id: "a1", role: "assistant", text: "我先核对制度。", seq: 2 },
    { id: "a2", role: "assistant", text: "住宿上限是 500 元。", seq: 5 },
    { id: "u2", role: "user", text: "生成报告", seq: 6, turn: { startedAt: 10_000, finishedAt: 13_000, status: "completed" } },
    { id: "s2", role: "user", text: "文件名用中文", steered: true, seq: 8 },
    { id: "a3", role: "assistant", text: "报告已经生成。", seq: 9 },
  ], activity: [
    { id: "search-1", type: "commandExecution", command: "/bin/zsh -c 'node /app/agent.js kb-search --query \"住宿费上限\"'", status: "completed", knowledgeRead: true, seq: 3 },
    { id: "read-1", type: "commandExecution", command: "node /app/agent.js kb-read --doc aaaaa", status: "completed", knowledgeRead: true, seq: 4 },
    { id: "file-2", type: "fileChange", status: "completed", changes: [{ path: "/tasks/demo/季度差旅报告.docx", kind: { type: "add" }, diff: "binary" }], seq: 7 },
    { id: "old", type: "commandExecution", command: "legacy --raw", status: "completed" },
  ] });

  assert.equal(turns.length, 3);
  const [legacy, first, second] = turns;
  assert.equal(legacy.legacy, true, "steps from before steps were numbered come before the first numbered turn");
  assert.deepEqual([first, second].map((turn) => turn.message.id), ["u1", "u2"]);
  assert.deepEqual(first.entries.map((entry) => entry.kind), ["text", "command", "command", "text"]);
  assert.equal(first.knowledge, source, "the final answer keeps the original question's evidence after later messages");
  assert.deepEqual(first.result, { files: [], verifiedWrites: 0, uncertainWrites: 0, deliverables: [] });
  assert.deepEqual(second.result, { files: ["/tasks/demo/季度差旅报告.docx"], verifiedWrites: 0, uncertainWrites: 0,
    deliverables: [{ kind: "local", state: "available", title: "季度差旅报告.docx", detail: "/tasks/demo/季度差旅报告.docx" }] });
  assert.equal(second.entries.some((entry) => entry.kind === "steer" && entry.message.text === "文件名用中文"), true);
  assert.deepEqual(first.summary, { elapsed: 6_000, status: "completed", files: 0, added: 0, removed: 0 });
  assert.deepEqual(legacy.result, { files: [], verifiedWrites: 0, uncertainWrites: 0, deliverables: [] }, "unassigned history is not a result of the newest turn");
});

test("work summaries use business language while exact commands stay only in technical details", () => {
  const search = workStepView({ kind: "command", command: "node /app/agent.js kb-search --query \"住宿费 上限\"", entry: {
    id: "one", type: "commandExecution", status: "completed", knowledgeRead: true, output: "synthetic result",
  } });
  assert.deepEqual({ title: search.title, target: search.target, state: search.state, automatic: search.automatic },
    { title: "检索知识库", target: "住宿费 上限", state: "已完成", automatic: true });
  assert.equal(search.details.command, "node /app/agent.js kb-search --query \"住宿费 上限\"");
  assert.equal(search.details.output, "synthetic result");

  const unknown = workStepView({ kind: "command", command: "/bin/zsh -c 'node /private/path/worker.js --opaque'", entry: {
    id: "two", type: "commandExecution", status: "completed", output: "done",
  } });
  assert.equal(unknown.title, "处理任务");
  assert.equal(unknown.target, "");
  assert.equal(unknown.state, "已完成");
  assert.equal(unknown.title.includes("worker.js"), false);
  assert.match(unknown.details.command, /private\/path\/worker\.js/);

  const failed = workStepView({ kind: "command", command: "opaque", entry: { id: "three", type: "commandExecution", status: "failed", exitCode: 2 } });
  assert.equal(failed.state, "失败");
  assert.equal(failed.open, true, "failure details remain visible by default");
});

test("only trusted file changes and write receipts become work results", () => {
  const [turn] = coworkTurns({ messages: [
    { id: "u", role: "user", text: "整理", seq: 1, turn: { startedAt: 0, finishedAt: 1_000, status: "failed" } },
    { id: "a1", role: "assistant", text: "我生成了 99 个文件。", seq: 3 },
    { id: "a2", role: "assistant", text: "写回待核对。", seq: 4, documentEdit: { state: "unknown" } },
    { id: "a3", role: "assistant", text: "表格已核验。", seq: 5, sheetEdit: { state: "verified" } },
  ], activity: [
    { id: "bad-file", type: "fileChange", status: "failed", changes: [{ path: "失败.docx", kind: { type: "add" }, diff: "x" }], seq: 2 },
  ] });
  assert.deepEqual(turn.result, { files: [], verifiedWrites: 1, uncertainWrites: 1, deliverables: [
    { kind: "feishu", state: "needs-check", title: "飞书文档", detail: "写入结果待核对 · 不会自动重写" },
    { kind: "feishu", state: "verified", title: "飞书电子表格", detail: "已写入并读回核验" },
  ] });
  assert.equal(turn.summary.status, "failed");
});
