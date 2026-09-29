import test from "node:test";
import assert from "node:assert/strict";
import { terminalReference } from "../src/desktop/renderer/task-terminal.js";

test("terminal reference contains only the explicit selected fragment", () => {
  const task = { id: "11111111-1111-4111-8111-111111111111", cwd: "/tmp/demo" };
  assert.deepEqual(terminalReference(task, "selected output", 1720000000000), {
    kind: "terminal", key: `terminal:${task.id}:1720000000000`, title: "终端输出 · demo", excerpt: "selected output",
  });
  assert.throws(() => terminalReference(task, "   "), /选中/);
  assert.equal(terminalReference(task, "x".repeat(9_000), 1).excerpt.length, 8_000);
});
