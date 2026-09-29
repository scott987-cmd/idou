import test from "node:test";
import assert from "node:assert/strict";
import { codingTurns, contextLeft, diffStats, displayCommand, elapsedText, exploreLines, exploreSummary, tokenCount } from "../src/desktop/renderer/coding-timeline.js";

test("a command is shown as the Agent wrote it, not as Codex wrapped it", () => {
  assert.equal(displayCommand("/bin/zsh -lc 'npm test'"), "npm test");
  assert.equal(displayCommand("/bin/bash -lc \"echo \\\"hi\\\" && ls\""), "echo \"hi\" && ls");
  assert.equal(displayCommand("bash -c 'grep -rn foo src'"), "grep -rn foo src");
  assert.equal(displayCommand(`/bin/zsh -lc 'echo '"'"'quoted'"'"''`), "echo 'quoted'", "Codex's own quoting of an inner quote");
  assert.equal(displayCommand("npm test"), "npm test", "an unwrapped command as it is");
  assert.equal(displayCommand("/bin/zsh -lc"), "/bin/zsh -lc");
});

test("a diff counts what it adds and removes, not its headers", () => {
  assert.deepEqual(diffStats("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n keep\n"), { added: 2, removed: 1 });
  assert.deepEqual(diffStats(""), { added: 0, removed: 0 });
});

test("a turn reads in the order it happened: words, browsing, a command, a change, the plan, words", () => {
  const task = { messages: [
    { id: "u1", role: "user", text: "改分页", seq: 1, turn: { startedAt: 1_000, finishedAt: 46_000, status: "completed" } },
    { id: "a1", role: "assistant", text: "先看看。", seq: 2 },
    { id: "s1", role: "user", text: "顺便加测试", steered: true, seq: 7 },
    { id: "a2", role: "assistant", text: "改好了。", seq: 9 },
    { id: "u2", role: "user", text: "再跑一次", seq: 10, turn: { startedAt: 50_000 } },
  ], activity: [
    { id: "r1", type: "commandExecution", command: "/bin/zsh -lc 'cat src/page.js'", status: "completed", actions: [{ type: "read", path: "src/page.js" }], seq: 3 },
    { id: "r2", type: "commandExecution", command: "/bin/zsh -lc 'rg paginate'", status: "completed", actions: [{ type: "search", query: "paginate", path: "src" }], seq: 4 },
    { id: "t1", type: "commandExecution", command: "/bin/zsh -lc 'npm test'", status: "failed", exitCode: 1, actions: [{ type: "unknown", command: "npm test" }], seq: 5 },
    { id: "p1", type: "plan", steps: [{ step: "改实现", status: "completed" }], seq: 6 },
    { id: "f1", type: "fileChange", status: "completed", changes: [{ path: "src/page.js", kind: { type: "update" }, diff: "@@\n-a\n+b\n+c\n" },
      { path: "test/page.test.js", kind: { type: "add" }, diff: "x\ny\n" }], seq: 8 },
    { id: "t2", type: "commandExecution", command: "npm test", status: "inProgress", seq: 11 },
  ] };
  const [first, second] = codingTurns(task);
  assert.equal(first.message.id, "u1");
  assert.deepEqual(first.entries.map((entry) => entry.kind), ["text", "explore", "command", "plan", "steer", "change", "text"]);
  assert.equal(first.entries[1].commands.length, 2, "browsing in a row is one group");
  assert.equal(first.entries[2].command, "npm test");
  assert.deepEqual(first.entries[5].files.map((file) => [file.path, file.kind, file.added, file.removed]),
    [["src/page.js", "update", 2, 1], ["test/page.test.js", "add", 2, 0]], "a new file counts its lines");
  assert.deepEqual(first.summary, { elapsed: 45_000, status: "completed", files: 2, added: 4, removed: 1 });
  assert.equal(second.summary, null, "a turn still going has no summary yet");
  assert.deepEqual(second.entries.map((entry) => entry.kind), ["command"]);
});

test("a command that reads and also does something else is a command, not browsing", () => {
  const [turn] = codingTurns({ messages: [{ id: "u", role: "user", text: "跑", seq: 1 }], activity: [
    { id: "c", type: "commandExecution", command: "cat a.js && npm test", status: "completed", actions: [{ type: "read", path: "a.js" }, { type: "unknown", command: "npm test" }], seq: 2 }] });
  assert.deepEqual(turn.entries.map((entry) => entry.kind), ["command"]);
});

test("browsing is said the way Codex lists it", () => {
  const commands = [{ actions: [{ type: "read", path: "a.js" }, { type: "read", path: "a.js" }, { type: "listFiles", path: "src" }] }, { actions: [{ type: "search", query: "foo", path: "src" }] }];
  assert.equal(exploreSummary(commands), "读取 1 个文件 · 列出 1 个目录 · 搜索 1 次");
  assert.deepEqual(exploreLines(commands), ["读取 a.js", "读取 a.js", "列出 src", "搜索 “foo” 在 src"]);
});

test("a record from before there was an order keeps activity visibly unassigned", () => {
  const [only, legacy] = codingTurns({ messages: [{ id: "u", role: "user", text: "改" }, { id: "a", role: "assistant", text: "好" }],
    activity: [{ id: "c", type: "commandExecution", command: "true", status: "completed" }] });
  assert.deepEqual(only.entries.map((entry) => entry.kind), ["text"]);
  assert.equal(legacy.legacy, true);
  assert.deepEqual(legacy.entries.map((entry) => entry.kind), ["command"], "old activity is not falsely assigned to the newest words");
});

test("a conversation carried on from before there was an order ends on its newest turn, not on its old steps", () => {
  // The shape of a 9-17 conversation continued on 9-23: three unnumbered
  // messages, their unnumbered steps, then a numbered turn after them.
  const turns = codingTurns({
    messages: [{ id: "u0", role: "user", text: "总结消息重点" }, { id: "a0", role: "assistant", text: "好" }, { id: "a0b", role: "assistant", text: "要点如下" },
      { id: "u1", role: "user", text: "读一下这份产品说明", seq: 11 }, { id: "a1", role: "assistant", text: "三处要改", seq: 31 }],
    activity: [{ id: "old", type: "commandExecution", command: "true", status: "completed" },
      { id: "new", type: "commandExecution", command: "lark-cli docs +fetch", status: "completed", seq: 13 }],
  });
  assert.deepEqual(turns.map((turn) => turn.legacy ? "legacy" : turn.message.id), ["u0", "legacy", "u1"]);
  assert.deepEqual(turns.at(-1).entries.map((entry) => entry.kind), ["command", "text"], "the answer just given is the last thing drawn");
});

test("how long a turn took, in words", () => {
  assert.equal(elapsedText(400), "1 秒");
  assert.equal(elapsedText(45_000), "45 秒");
  assert.equal(elapsedText(62_000), "1 分 2 秒");
  assert.equal(elapsedText(120_000), "2 分");
});

test("a turn's summary is Codex's net diff of it, not its patches added up", () => {
  const [turn] = codingTurns({ messages: [
    { id: "u", role: "user", text: "改", seq: 1, turn: { startedAt: 0, finishedAt: 65_000, status: "completed", diff: { files: 3, added: 75, removed: 7 } } },
  ], activity: [
    { id: "f1", type: "fileChange", status: "completed", changes: [{ path: "a.js", kind: { type: "update" }, diff: "@@\n-a\n+b\n" }], seq: 2 },
    { id: "f2", type: "fileChange", status: "completed", changes: [{ path: "a.js", kind: { type: "update" }, diff: "@@\n-b\n+c\n" }], seq: 3 },
  ] });
  assert.deepEqual(turn.summary, { elapsed: 65_000, status: "completed", files: 3, added: 75, removed: 7 }, "a file patched twice is not two changes");
});

// Codex's footer (codex-rs/protocol TokenUsage::percent_of_context_window_remaining
// at the pinned commit): the last response's tokens against the window, both
// less the 12,000 tokens that are always there.
test("how much of the context is left, counted the way Codex's footer counts it", () => {
  assert.equal(contextLeft({ tokens: 12_000, window: 212_000 }), 100, "a fresh thread reads 100%");
  assert.equal(contextLeft({ tokens: 500, window: 212_000 }), 100);
  assert.equal(contextLeft({ tokens: 112_000, window: 212_000 }), 50);
  assert.equal(contextLeft({ tokens: 173_000, window: 212_000 }), 20, "rounded to a whole percent");
  assert.equal(contextLeft({ tokens: 212_000, window: 212_000 }), 0);
  assert.equal(contextLeft({ tokens: 400_000, window: 212_000 }), 0, "past the window is none left, not less than none");
  assert.equal(contextLeft({ tokens: 5_000, window: 12_000 }), 0, "a window no bigger than what is always there leaves nothing");
  assert.equal(contextLeft({ tokens: 100, window: null }), null, "a window Codex does not know");
  assert.equal(contextLeft(null), null, "nothing reported yet");
});

test("token counts in short form", () => {
  assert.equal(tokenCount(950), "950");
  assert.equal(tokenCount(1_234), "1.23K");
  assert.equal(tokenCount(12_345), "12.3K");
  assert.equal(tokenCount(10_000), "10K");
  assert.equal(tokenCount(116_000), "116K");
  assert.equal(tokenCount(486_400), "486K");
  assert.equal(tokenCount(999_999), "1M", "a count that rounds up to the next unit says so");
  assert.equal(tokenCount(1_200_000), "1.2M");
});
