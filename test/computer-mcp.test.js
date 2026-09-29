import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { COMPUTER_TOOLS, KEY_CODES } from "../bin/mcp/computer.js";

test("advertises the computer tools", () => {
  assert.deepEqual(COMPUTER_TOOLS.map((tool) => tool.name),
    ["computer_apps", "computer_windows", "computer_screenshot", "computer_click", "computer_type", "computer_key"]);
});

// The safety property, not a detail: nothing here acts on "the screen". Every
// tool that clicks, types or presses a key must name the application it acts on,
// so the approval card shows a target the person can actually judge -- and so a
// click can be resolved against that window instead of blind global coordinates,
// which macOS blocks anyway.
test("every acting tool requires an explicit application", () => {
  for (const name of ["computer_click", "computer_type", "computer_key"]) {
    const tool = COMPUTER_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool.inputSchema.required.includes("app"), `${name} must require an app`);
    assert.equal(tool.inputSchema.additionalProperties, false, `${name} must not take extra properties`);
  }
  // Coordinates are window-relative, so a click needs both of them.
  const click = COMPUTER_TOOLS.find((tool) => tool.name === "computer_click");
  assert.deepEqual(click.inputSchema.required, ["app", "x", "y"]);
});

test("the key set is closed, with no raw key-code escape hatch", () => {
  assert.deepEqual(Object.keys(KEY_CODES).sort(),
    ["delete", "down", "enter", "escape", "left", "return", "right", "space", "tab", "up"]);
  for (const code of Object.values(KEY_CODES)) assert.ok(Number.isInteger(code) && code >= 0 && code < 200);
});

test("speaks MCP over stdio and refuses an application that is not running", async () => {
  const server = spawn(process.execPath, [fileURLToPath(new URL("../bin/mcp/computer.js", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = [];
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) replies.push(JSON.parse(line)); }
  });
  const request = (obj) => server.stdin.write(`${JSON.stringify(obj)}\n`);
  try {
    request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    // An application nobody is running: this is refused while resolving the
    // name, so no window is activated and no input is ever synthesized.
    request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "computer_windows", arguments: { app: "NoSuchApp__test" } } });
    request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "computer_key", arguments: { app: "NoSuchApp__test", key: "return" } } });
    const deadline = Date.now() + 30_000;
    while (replies.length < 4 && Date.now() < deadline) await once(server.stdout, "data").catch(() => {});
    const byId = Object.fromEntries(replies.map((reply) => [reply.id, reply]));
    assert.equal(byId[1].result.serverInfo.name, "idou-computer");
    assert.equal(byId[2].result.tools.length, 6);
    // Either the app is refused by name, or this platform has no osascript at
    // all; both must fail closed rather than act.
    assert.equal(byId[3].result.isError, true);
    assert.match(byId[3].result.content[0].text, /没有在运行|失败/);
    assert.equal(byId[4].result.isError, true);
  } finally { server.kill(); }
});

// Which window "the app's window" is. It used to be System Events' `first
// window`, and for 文本编辑 that was a 66×20 sliver: the screenshot the Agent
// judged by, and the frame every click's coordinates were counted from, were
// not the document it was typing into (the 操作电脑 demo, 2026-09-25). Now it
// is the main window, else the largest ordinary one; never a sliver, a
// minimised window or one that is off every screen.
test("the window acted on is the application's main window, never a sliver", async () => {
  const { chooseWindow, parseWindowRows } = await import("../bin/mcp/computer.js");
  const row = (x, y, width, height, main = false, minimized = false, subrole = "AXStandardWindow") => ({ x, y, width, height, main, minimized, subrole });
  const cases = [
    ["a sliver listed first, the document second", [row(700, 400, 66, 20, false, false, "AXUnknown"), row(120, 80, 900, 700, true)], [120, 80, 900, 700]],
    ["no main window: the largest ordinary one", [row(0, 0, 300, 200), row(40, 40, 1000, 760), row(10, 10, 120, 90, false, false, "AXFloatingWindow")], [40, 40, 1000, 760]],
    ["a minimised main window is not on screen", [row(0, 0, 900, 700, true, true), row(50, 60, 640, 480)], [50, 60, 640, 480]],
    ["a dialog sheet is not the window", [row(200, 150, 420, 180, false, false, "AXDialog"), row(100, 100, 800, 600, true)], [100, 100, 800, 600]],
    ["only slivers: nothing to act on", [row(700, 400, 66, 20), row(0, 0, 40, 30)], null],
    ["no windows at all", [], null],
  ];
  for (const [name, rows, expected] of cases) {
    const chosen = chooseWindow(rows);
    assert.deepEqual(chosen && [chosen.left, chosen.top, chosen.width, chosen.height], expected, name);
  }
  // What the AppleScript prints: one tab-separated line per window.
  assert.deepEqual(parseWindowRows("700\t400\t66\t20\tfalse\tfalse\tAXUnknown\n120\t80\t900\t700\ttrue\tfalse\tAXStandardWindow\n"),
    [row(700, 400, 66, 20, false, false, "AXUnknown"), row(120, 80, 900, 700, true)]);
  assert.deepEqual(parseWindowRows("garbage\n\n"), []);
});

// Found 2026-09-27: allowed into i豆 itself, the agent could raise a card and
// press 确认 on its own; allowed into a terminal, it had a shell outside every
// sandbox. Some apps are refused however the person answers.
import { parseAppRows, refusal } from "../bin/mcp/computer.js";

test("the running apps are read with their process and bundle, as System Events says them", () => {
  const rows = parseAppRows("文本编辑\t311\tcom.apple.TextEdit\nMyDouBao\t812\tcom.mydoubao.desktop\nSomething\t9\tmissing value\n\n");
  assert.deepEqual(rows, [
    { name: "文本编辑", pid: 311, bundleId: "com.apple.TextEdit" },
    { name: "MyDouBao", pid: 812, bundleId: "com.mydoubao.desktop" },
    { name: "Something", pid: 9, bundleId: null },
  ]);
});

test("i豆 itself, shells and scripting tools, other agents, settings and password stores are never acted in", () => {
  const app = (name, bundleId, pid = 1000) => ({ name, pid, bundleId });
  // i豆 by its process -- a development build is "Electron" -- and by its bundle.
  assert.match(refusal(app("Electron", "com.github.Electron", 4242), new Set([4242])) ?? "", /i豆 自己/, "a development build, by its process");
  assert.match(refusal(app("MyDouBao", "com.mydoubao.desktop")) ?? "", /i豆 自己/, "the installed app, by its bundle");
  assert.match(refusal(app("idou", "io.github.scott987-cmd.idou")) ?? "", /i豆 自己/, "and by the identifier it has since the rename");
  for (const [name, bundleId] of [["终端", "com.apple.Terminal"], ["iTerm2", "com.googlecode.iterm2"], ["Warp", "dev.warp.Warp-Stable"],
    ["Ghostty", "com.mitchellh.ghostty"], ["脚本编辑器", "com.apple.ScriptEditor2"], ["快捷指令", "com.apple.shortcuts"],
    ["ChatGPT", "com.openai.codex"], ["Claude", "com.anthropic.claudefordesktop"], ["豆包工作", "com.work.pc.doubao"],
    ["系统设置", "com.apple.systempreferences"], ["钥匙串访问", "com.apple.keychainaccess"], ["密码", "com.apple.Passwords"],
    ["1Password", "com.1password.1password"], ["1Password 7", "com.agilebits.onepassword7"]]) {
    assert.match(refusal(app(name, bundleId)) ?? "", /不能控制/, `${name} (${bundleId})`);
  }
  // What the connector is for stays open.
  for (const [name, bundleId] of [["文本编辑", "com.apple.TextEdit"], ["Feishu", "com.electron.lark"], ["Google Chrome", "com.google.Chrome"],
    ["访达", "com.apple.finder"], ["Something", null]]) {
    assert.equal(refusal(app(name, bundleId)), null, `${name} (${bundleId})`);
  }
});
