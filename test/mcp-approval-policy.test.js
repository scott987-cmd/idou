import test from "node:test";
import assert from "node:assert/strict";
import { mcpApprovalPolicy, mcpGrant, mcpToolName } from "../src/application/mcp-approval-policy.js";

test("the tool is read from Codex's own approval message, and nothing else", () => {
  assert.equal(mcpToolName('Allow the computer MCP server to run tool "computer_click"?'), "computer_click");
  for (const message of ["Allow?", "", null, 'to run tool ""', `to run tool "${"x".repeat(81)}"`]) assert.equal(mcpToolName(message), null, String(message));
});

test("the permission decides how much one answer covers", () => {
  assert.deepEqual(["plan", "manual", "standard", "auto", "full", undefined].map(mcpApprovalPolicy), ["every", "every", "grant", "grant", "never", "every"]);
});

test("电脑操作 is granted by application; the other built-ins whole; an imported connection by tool", () => {
  const computer = (tool, params) => mcpGrant({ server: "computer", tool, params, builtin: true, title: "电脑操作" });
  assert.equal(computer("computer_apps", {}).free, true);
  assert.equal(computer("computer_click", { app: " TextEdit " }).key, "computer\napp\nTextEdit");
  assert.equal(computer("computer_type", { app: "TextEdit", text: "x" }).key, computer("computer_screenshot", { app: "TextEdit" }).key, "every tool in the same application shares its grant");
  assert.equal(computer("computer_screenshot", {}).key, "computer\nscreen");
  assert.notEqual(computer("computer_click", { app: "Finder" }).key, computer("computer_click", { app: "TextEdit" }).key);
  assert.match(computer("computer_click", { app: "a".repeat(60) }).label, /…/, "a long name is clipped on the card");
  assert.equal(mcpGrant({ server: "browser", tool: "browser_click", params: {}, builtin: true, title: "浏览器操作" }).key, "browser\nserver");
  assert.equal(mcpGrant({ server: "computer", tool: "computer_click", params: { app: "TextEdit" }, builtin: false }).key, "computer\ntool\ncomputer_click", "an imported connection named computer gets no per-application grant");
  assert.equal(mcpGrant({ server: "demo", tool: "", params: {} }), null);
});
