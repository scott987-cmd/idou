// 立即运行 pressed again while the first press is still out is not a second
// run. On 2026-09-25 the server got two run-now requests for one press, eleven
// seconds apart, and ran the paid task twice; what sent the second was never
// pinned down, but a second press while the first was out is the one way the
// page itself could do it -- and the list row's button did not even know its
// work was under way, because its handler dropped the promise.
//
// The real schedules page, in a real Electron page, against an api whose
// run-now takes a while.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import electronBinary from "electron";

const MAIN = `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(process.env.PAGE);
});
`;

const page = (schedulesUrl) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><main id="root"></main>
<script type="module">
  import { schedulesUi } from ${JSON.stringify(schedulesUrl)};
  window.calls = 0;
  const item = window.item = { id: "s1", title: "每日产品简报", state: "active", spec: { frequency: "daily", time: "09:00" }, nextAt: Date.now() + 3600e3, prompt: "总结", capability: "c1", updatedAt: 1 };
  const api = {
    scheduleConsent: async () => ({ authorized: true, expiresAt: Date.now() + 3600e3 }),
    scheduleUnattended: async () => ({ available: false }),
    listSchedules: async () => ({ schedules: [item], rules: ["daily"] }),
    scheduleRuns: async () => ({ runs: [] }),
    runScheduleNow: async () => { window.calls += 1; await new Promise((resolve) => setTimeout(resolve, 1200)); return { run: { runId: "r1" } }; },
  };
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const action = async (fn) => { try { return await fn(); } catch (error) { window.lastError = String(error?.message ?? error); } };
  const readableError = (error) => String(error?.message ?? error);
  window.ui = schedulesUi({ api, root: document.getElementById("root"), element, action, readableError });
  await window.ui.render();
  window.ready = true;
</script></body></html>`;

test("立即运行 cannot be pressed again while its run is being started", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-run-now-"));
  const html = path.join(directory, "index.html"), main = path.join(directory, "main.cjs");
  await writeFile(html, page(pathToFileURL(path.resolve("src/desktop/renderer/schedules.js")).href));
  await writeFile(main, MAIN);
  const app = await electron.launch({ executablePath: electronBinary, args: [main], env: { ...process.env, PAGE: html } });
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => app.close().catch(() => {}));
  const screen = await app.firstWindow();
  await screen.waitForFunction(() => window.ready === true && document.querySelector(".schedule-run-now"));

  // Pressed twice, 80 ms apart, while the first run is still being started.
  await screen.evaluate(async () => {
    const press = () => document.querySelector(".schedule-run-now").click();
    press(); await new Promise((resolve) => setTimeout(resolve, 80)); press();
  });
  await screen.waitForTimeout(1600);
  assert.equal(await screen.evaluate(() => window.calls), 1, "one press, one run");
  assert.equal(await screen.evaluate(() => window.lastError ?? null), null);
  // Once it has answered, it can be pressed again: a person may mean it.
  await screen.evaluate(() => document.querySelector(".schedule-run-now").click());
  await screen.waitForFunction(() => window.calls === 2);
});

// Every load() redraws the page -- after 立即运行, a filter, a background
// refresh -- and a task's page was rebuilt from what the server held: a name
// half changed and not yet saved was silently lost (the UI rules' 重绘丢状态,
// 2026-09-25). Kept across a redraw of the same task at the same revision; once
// the task changed elsewhere, the server's version is the one shown.
test("unsaved edits on a task's page survive its redraw, until the task changes elsewhere", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-schedule-edits-"));
  const html = path.join(directory, "index.html"), main = path.join(directory, "main.cjs");
  await writeFile(html, page(pathToFileURL(path.resolve("src/desktop/renderer/schedules.js")).href));
  await writeFile(main, MAIN);
  const app = await electron.launch({ executablePath: electronBinary, args: [main], env: { ...process.env, PAGE: html } });
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => app.close().catch(() => {}));
  const screen = await app.firstWindow();
  await screen.waitForFunction(() => window.ready === true && document.querySelector(".schedule-title"));
  await screen.locator(".schedule-title").first().click();
  const name = screen.locator(".schedule-detail-form input:not([type]), .schedule-detail-form input[type=text]").first();
  await name.waitFor();
  assert.equal(await name.inputValue(), "每日产品简报");
  await name.fill("每日产品简报（改了一半");
  await screen.evaluate(() => window.ui.render());
  await screen.locator(".schedule-detail-page").waitFor();
  assert.equal(await name.inputValue(), "每日产品简报（改了一半", "a redraw keeps what the person typed");
  await screen.evaluate(() => { window.item.title = "别处改过的名字"; window.item.updatedAt = 2; return window.ui.render(); });
  await screen.locator(".schedule-detail-page").waitFor();
  assert.equal(await name.inputValue(), "别处改过的名字", "changed elsewhere, the server's version is shown");
});
