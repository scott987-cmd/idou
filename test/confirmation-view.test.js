import test from "node:test";
import assert from "node:assert/strict";
import { approvalPlacement, approvalPresentation, confirmationVisibleForTask } from "../src/desktop/renderer/confirmation-view.js";

test("an approval only attaches to the exact task, turn and qualified item", () => {
  const approval = { id: "approval-1", taskId: "task-a", turnKey: "message-1", itemId: "child-thread:cmd-1", kind: "command" };
  assert.equal(approvalPlacement(approval, { taskId: "task-a", turnKey: "message-1", itemId: "child-thread:cmd-1" }), "step");
  assert.equal(approvalPlacement(approval, { taskId: "task-a", turnKey: "message-2", itemId: "child-thread:cmd-1" }), "task");
  assert.equal(approvalPlacement(approval, { taskId: "task-b", turnKey: "message-1", itemId: "child-thread:cmd-1" }), "other-task");
  assert.equal(approvalPlacement({ ...approval, itemId: null }, { taskId: "task-a", turnKey: "message-1", itemId: "cmd-1" }), "task");
});

test("work approvals lead with the business action and keep the command as detail", () => {
  const create = approvalPresentation({ kind: "command", command: `/bin/zsh -c 'node "/Applications/i豆.app/agent.js" doc-create --content-file "/tmp/report.md"'`, reason: "需要写入" }, "cowork");
  assert.equal(create.title, "确认创建飞书文档");
  assert.equal(create.target, "report.md");
  assert.match(create.detail, /doc-create/);
  assert.doesNotMatch(create.title, /zsh|agent\.js/);

  const unknown = approvalPresentation({ kind: "command", command: `/bin/zsh -lc 'custom-tool --secret-path /tmp/internal'` }, "cowork");
  assert.equal(unknown.title, "确认处理任务");
  assert.equal(unknown.target, "");
  assert.match(unknown.detail, /custom-tool/);
});

// 2026-10-08: an MCP card was headed 「确认 MCP 工具调用」 and showed its server's
// id, `browser`, as a line of its own by 允许这一次. It is headed the way its
// step is (使用工具, cowork-timeline.js), names the connector only by title,
// and a command still shows the folder it runs in.
test("an MCP card is headed in the person's words and never shows the server's id", () => {
  const card = approvalPresentation({ kind: "mcp", reason: "「浏览器操作」想运行「browser_preview」", command: '{\n  "path": "index.html"\n}', cwd: "browser", tool: "browser_preview", target: "浏览器操作" }, "coding");
  assert.deepEqual([card.title, card.target, card.note], ["确认使用工具", "浏览器操作", ""]);
  assert.match(card.detail, /index\.html/);
  assert.equal(approvalPresentation({ kind: "mcp", cwd: "browser" }, "coding").target, "", "no title, no server id in its place");
  assert.equal(approvalPresentation({ kind: "command", command: "npm test", cwd: "/repo" }, "coding").note, "/repo");
});

test("task-bound application confirmations are hidden from every other task", () => {
  assert.equal(confirmationVisibleForTask({ taskId: "task-a", status: "pending" }, "task-a"), true);
  assert.equal(confirmationVisibleForTask({ taskId: "task-a", status: "pending" }, "task-b"), false);
  assert.equal(confirmationVisibleForTask({ taskId: null, status: "pending" }, "task-b"), true);
  assert.equal(confirmationVisibleForTask(null, "task-a"), false);
});
