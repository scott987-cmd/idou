import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";

// The built-in connector rows in 技能中心 -> 连接器, in the actual Electron app,
// against a synthetic session and gateway -- no login, no paid call.
//
// What it guards is what a person sees, not whether a click registers. The rows
// once measured 1775px wide inside a 974px list: .sc-rows was a grid with no
// column template, its implicit auto track grew to the whole unwrapped
// description, and every row's toggle -- and the 检查权限 button -- sat off the
// right edge of the window. A driver still "passed", because a DOM click()
// succeeds on an element nobody can see. So this measures each control's box
// against the window, and pins the window to a laptop width first: on a wide
// monitor the same bug simply stops showing, and the check would pass for the
// wrong reason.
//
// It also clicks 检查权限, which runs the permission IPC end to end. On macOS that
// asks for Accessibility, so a system prompt may appear; it can be dismissed.
const WIDTH = 1100, HEIGHT = 800;
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-builtin-connectors-desktop-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async () => syntheticResponseStream("OK") });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });

let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], timeout: 30_000,
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin } });
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width: WIDTH, height: HEIGHT });

  // DOM clicks, not coordinates: this app layers WebContentsViews over the window.
  const click = (selector) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, selector);
  assert.ok(await click('[data-section="skills"]'), "the skills section entry is missing");
  await page.locator('.sc-tab[data-tab="connectors"]').waitFor();
  assert.ok(await click('.sc-tab[data-tab="connectors"]'), "the connectors tab is missing");
  const permissionButton = '[data-focus="btn:computer-permissions:检查权限"]';
  await page.locator(permissionButton).waitFor();

  const layout = await page.evaluate(() => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const list = document.querySelector(".sc-row.mcp-card")?.parentElement;
    return { windowWidth: window.innerWidth, list: box(list),
      rows: [...(list?.querySelectorAll(":scope > .sc-row.mcp-card") ?? [])].map((row) => ({
        title: row.querySelector("strong")?.textContent, row: box(row),
        toggle: box(row.querySelector(".sc-switch")), permissionButton: box(row.querySelector('[data-focus^="btn:computer-permissions"]')) })) };
  });
  assert.ok(layout.windowWidth <= WIDTH, `the window was not pinned to ${WIDTH}px (got ${layout.windowWidth}), so the check would prove nothing`);
  assert.ok(layout.rows.length >= 3, "expected the built-in connector rows");
  for (const row of layout.rows) {
    // The cause, asserted directly: a row wider than its list.
    assert.ok(row.row.right <= layout.list.right + 1, `「${row.title}」 is ${Math.round(row.row.width)}px wide, overflowing its ${Math.round(layout.list.width)}px list`);
    // The symptom a person meets: a control they cannot reach.
    assert.ok(row.toggle && row.toggle.right <= layout.windowWidth, `「${row.title}」's toggle is off-screen (right ${Math.round(row.toggle?.right)} > window ${layout.windowWidth})`);
  }
  const computer = layout.rows.find((row) => row.permissionButton);
  assert.ok(computer, "the 电脑操作 row should carry the 检查权限 button");
  assert.ok(computer.permissionButton.right <= layout.windowWidth, `检查权限 is off-screen (right ${Math.round(computer.permissionButton.right)} > window ${layout.windowWidth})`);
  // The button must only be on the row that needs macOS permissions.
  assert.equal(layout.rows.filter((row) => row.permissionButton).length, 1, "only 电脑操作 should offer 检查权限");

  assert.ok(await click(permissionButton), "the 检查权限 button is missing");
  await page.locator(".sc-notice").waitFor();
  const notice = await page.locator(".sc-notice").innerText();
  if (process.platform === "darwin") assert.match(notice, /辅助功能/, "the notice should report the permissions it checked");
  else assert.match(notice, /只有 macOS 需要/);
  await page.screenshot({ path: path.join(evidence, "desktop-builtin-connectors.png"), scale: "css" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, windowWidth: layout.windowWidth, rows: layout.rows.length,
    controlsOnScreen: true, permissionNotice: notice, paidCalls: 0 }));
} catch (error) {
  const page = app?.windows()[0];
  if (page) console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0], screen: (await page.evaluate(() => document.body.innerText).catch(() => "")).slice(0, 600) }));
  throw error;
} finally {
  await app?.close(); sessions.revoke(session.token); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
