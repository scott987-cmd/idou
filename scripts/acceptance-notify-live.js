// Live acceptance for 测试通知 (G9): the button in 设置 → 通知 → 飞书消息,
// pressed in the operator's own signed-in application, against the real control
// plane and the real Feishu.
//
//   node scripts/acceptance-notify-live.js --send
//
// Sends one real message -- the fixed test line -- to the signed-in person, and
// to nobody else: the server takes the recipient from the session. Run it once
// the application's bot has been granted im:message:send_as_bot, to see a
// result arrive the way a finished task's will. It then reads the control
// plane's own audit for the event, so what the page said and what the server
// did are checked against each other.
//
// Needs: the control plane at IDOU_SERVER_URL (default http://127.0.0.1:3041),
// its log at IDOU_CONTROL_PLANE_LOG (default /tmp/idou-control-plane.log,
// where the launchd agent writes), the desktop signed in to Feishu, and the
// application NOT running (it is launched here on its own data directory).
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { desktopProfileDir } from "../src/install-names.js";

if (!process.argv.includes("--send")) {
  console.error("This sends a real Feishu message to the signed-in person. Re-run with --send to proceed.");
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = process.env.IDOU_DESKTOP_DATA_DIR || desktopProfileDir();
const SERVER = process.env.IDOU_SERVER_URL || "http://127.0.0.1:3041";
const LOG = process.env.IDOU_CONTROL_PLANE_LOG || "/tmp/idou-control-plane.log";
const say = (line) => process.stdout.write(`  · ${line}\n`);

try { execFileSync("pgrep", ["-f", "/Applications/i豆.app/Contents/MacOS/(idou|MyDouBao)$"]); console.error("Quit i豆 first: it is launched here on its own data directory."); process.exit(2); }
catch { /* not running: go on */ }

// The control plane's audit lines for test notifications, after a moment.
const audited = (after) => readFileSync(LOG, "utf8").split("\n")
  .map((line) => line.slice(line.indexOf("{")))
  .filter((line) => line.includes("\"schedule_notify_test\""))
  .map((line) => { try { return JSON.parse(line); } catch { return null; } })
  .filter((event) => event && event.at >= after);

let app, ok = false;
try {
  say("launching the operator's own application …");
  app = await electron.launch({ executablePath: electronBinary, args: [ROOT, `--user-data-dir=${DATA}`], timeout: 60_000,
    env: { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: DATA, IDOU_SERVER_URL: SERVER } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.locator("#new-task").waitFor();
  // A resumed login spends a single-use refresh token in the background; closing
  // before it lands can lose the login. Wait for it, whatever else happens.
  let status = null;
  for (let i = 0; i < 90 && !status?.connected; i += 1) {
    status = await page.evaluate(() => window.idou.authStatus()).catch(() => null);
    if (!status?.connected) await page.waitForTimeout(1000);
  }
  if (!status?.connected) throw new Error(`the application did not reconnect to Feishu (stage ${status?.stage ?? "unknown"}); sign in and re-run`);
  say("signed in");

  await page.locator("#settings").click();
  const button = page.locator("#test-feishu-notification");
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (!(box && box.width > 0 && box.height > 0)) throw new Error("测试通知 has no box on screen");
  const pressedAt = Date.now();
  await button.click();
  const note = page.locator(".notification-feishu-note");
  await page.waitForFunction(() => /测试通知发送(成功|失败)/.test(document.querySelector(".notification-feishu-note")?.textContent ?? ""), null, { timeout: 60_000 });
  const said = (await note.innerText()).trim();
  say(`the page said: ${said}`);
  // The 通知 section only: this is the operator's real account, and the page
  // below it shows their open_id and tenant_key.
  await page.locator(".notification-settings").screenshot({ path: path.join(ROOT, "docs/evidence/desktop-test-notify-live.png") });

  let events = [];
  for (let i = 0; i < 20 && !events.length; i += 1) { events = audited(pressedAt - 1000); if (!events.length) await page.waitForTimeout(500); }
  const event = events.at(-1);
  say(`the control plane audited: ${event ? JSON.stringify({ kind: event.kind, as: event.as, sent: event.sent, ...(event.reason ? { reason: event.reason } : {}) }) : "(nothing)"}`);

  const checks = [
    ["the page says it was sent, by the bot", /^测试通知发送成功！由应用机器人发送/.test(said)],
    ["the control plane recorded exactly one test", events.length === 1],
    ["and recorded it as sent by the bot", event?.sent === true && event?.as === "bot"],
  ];
  for (const [what, passed] of checks) process.stdout.write(`${passed ? "OK  " : "FAIL"}  ${what}\n`);
  ok = checks.every(([, passed]) => passed);
  process.stdout.write(`      pressed at ${new Date(pressedAt).toISOString()}\n`);
} finally {
  await app?.close().catch(() => {});
}
process.exit(ok ? 0 : 1);
