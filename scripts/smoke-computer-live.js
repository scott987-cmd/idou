// @requires live: 在真实屏幕上移动鼠标、在真实窗口里输入
import "../src/adopt-legacy-env.js";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The computer MCP's writing half, verified against a scratch TextEdit window.
//
// This one genuinely takes over the screen for a few seconds: it activates
// TextEdit, moves the pointer and types. That is why it is --live only and must
// never run unattended or in CI -- everything the unit tests cover is read-only
// for exactly this reason.
//
// What makes it a real check rather than a demo: the typed marker is read back
// out of the document afterwards. If focus were stolen mid-run and the keystrokes
// landed somewhere else, the readback fails instead of quietly "passing", which
// is the failure mode that matters when something is driving a real keyboard.
//
// Cleanup closes the document without saving and quits TextEdit, so nothing is
// left behind on disk or on screen.
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live: this moves the real pointer and types into a real window");

const MARKER = `IDOU_COMPUTER_PROBE_${Date.now().toString(36)}`;
const osa = (script) => new Promise((resolve, reject) => {
  execFile("/usr/bin/osascript", ["-e", script], { timeout: 20_000 }, (error, stdout, stderr) =>
    error ? reject(new Error(String(stderr || error.message).split("\n")[0])) : resolve(stdout.trim()));
});

// Cleanup closes every TextEdit document without saving, which is only harmless
// when this script opened all of them -- so it refuses to start beside the
// person's own TextEdit work rather than risk it.
if (await osa('application "TextEdit" is running') === "true") throw new Error("TextEdit is already running: save your work and quit it first -- this smoke closes every TextEdit document without saving when it ends");

const server = spawn(process.execPath, [fileURLToPath(new URL("../bin/mcp/computer.js", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (let index; (index = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  }
});
const call = (id, name, args = {}) => new Promise((resolve, reject) => {
  pending.set(id, resolve);
  setTimeout(() => { if (pending.delete(id)) reject(new Error(`no reply for ${name}`)); }, 40_000).unref?.();
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
});
const text = (reply) => reply.result?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";

const results = {};
try {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
  await once(server.stdout, "data");

  // A scratch document, so no existing window or file is touched.
  await osa('tell application "TextEdit" to activate');
  await osa('tell application "TextEdit" to make new document');
  await new Promise((resolve) => setTimeout(resolve, 800));

  const apps = await call(1, "computer_apps");
  assert.match(text(apps), /TextEdit/, "TextEdit should be listed once running");
  results.appListed = true;

  const windows = await call(2, "computer_windows", { app: "TextEdit" });
  assert.notEqual(windows.result.isError, true, `computer_windows failed: ${text(windows)}`);
  results.windowListed = !/没有打开的窗口/.test(text(windows));

  // Typing pastes, so it borrows the clipboard. A capability that quietly eats
  // the person's clipboard would be its own bug, so the restore is asserted
  // rather than assumed.
  const CLIPBOARD_BEFORE = `idou-clipboard-${Date.now().toString(36)}`;
  await osa(`set the clipboard to ${JSON.stringify(CLIPBOARD_BEFORE)}`);

  // The decisive step: type through the MCP, then read the document back.
  const typed = await call(3, "computer_type", { app: "TextEdit", text: MARKER });
  assert.notEqual(typed.result.isError, true, `computer_type failed: ${text(typed)}`);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const readBack = await osa('tell application "TextEdit" to get text of document 1');
  assert.ok(readBack.includes(MARKER), `the marker never reached the document (read back: ${JSON.stringify(readBack.slice(0, 120))})`);
  results.typedTextLanded = true;
  const clipboardAfter = await osa("get the clipboard as text").catch(() => "");
  results.clipboardRestored = clipboardAfter === CLIPBOARD_BEFORE;
  assert.equal(clipboardAfter, CLIPBOARD_BEFORE, "computer_type borrows the clipboard and must put it back");

  // A click inside the window, proved by typing again afterwards: if the click
  // had thrown focus away, the second marker would not arrive either.
  //
  // The coordinate is measured, not guessed. A fresh TextEdit window sits at
  // (242,106) with its text area at (242,206) -- so the document body starts
  // 100px below the window's top edge, and everything above that is toolbar and
  // ruler. An earlier run clicked window-relative y=90, landed on the format
  // bar, and the follow-up text went nowhere; y=150 is comfortably inside.
  const clicked = await call(4, "computer_click", { app: "TextEdit", x: 120, y: 150 });
  assert.notEqual(clicked.result.isError, true, `computer_click failed: ${text(clicked)}`);
  results.clickAccepted = true;
  await call(5, "computer_type", { app: "TextEdit", text: "_2" });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = await osa('tell application "TextEdit" to get text of document 1');
  results.stillFocusedAfterClick = after.includes("_2");
  // Asserted, not merely recorded: an earlier version only stored this field, so
  // the run printed "passed: true" while the click had in fact lost focus. A
  // check that reports success on a false property is worse than no check.
  assert.ok(results.stillFocusedAfterClick, "typing after the click did not reach the document -- the click lost focus");

  const shot = await call(6, "computer_screenshot", { app: "TextEdit" });
  const image = shot.result?.content?.find((part) => part.type === "image");
  assert.ok(image, `computer_screenshot returned no image: ${text(shot)}`);
  const bytes = Buffer.from(image.data, "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "not a PNG");
  results.screenshotBytes = bytes.length;

  // The refusal still holds for an application that is not running.
  const refused = await call(7, "computer_click", { app: "NoSuchApp__live", x: 1, y: 1 });
  assert.equal(refused.result.isError, true, "an app that is not running must be refused");
  results.unknownAppRefused = true;

  console.log(JSON.stringify({ passed: true, ...results, marker: MARKER }, null, 2));
} finally {
  server.kill();
  await osa('tell application "TextEdit" to close every document saving no').catch(() => {});
  await osa('tell application "TextEdit" to quit').catch(() => {});
}
