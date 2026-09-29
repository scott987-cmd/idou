import test from "node:test";
import assert from "node:assert/strict";
import { diffReference, reviewFiles } from "../src/desktop/renderer/task-review.js";

const result = { scope: "turn", turnKey: "turn-1", basis: "Codex 本轮净差异 codex-1", revision: "a".repeat(64), files: [
  { path: "src/a.js", status: "modified", added: 1, removed: 1, diff: "@@ -1 +1 @@\n-old\n+new" },
] };

test("review files expose selectable old and new lines without losing the basis", () => {
  const [file] = reviewFiles(result);
  assert.deepEqual(file.lines.filter(row => row.side).map(row => [row.side, row.line, row.text]), [["old", 1, "-old"], ["new", 1, "+new"]]);
  assert.equal(file.revision, result.revision);
});

test("line feedback becomes a versioned draft reference", () => {
  const line = reviewFiles(result)[0].lines.find(row => row.side === "new");
  assert.deepEqual(diffReference(result, result.files[0], line, "这里应保留校验"), {
    kind: "diff", key: `diff:turn:turn-1:src/a.js:new:1:${"a".repeat(64)}:missing`, title: "src/a.js · 新侧第 1 行", path: "src/a.js", scope: "turn", turnKey: "turn-1", side: "new", startLine: 1, endLine: 1,
    revision: "a".repeat(64), fileRevision: "missing", comment: "这里应保留校验", excerpt: "+new", state: "current",
  });
});
