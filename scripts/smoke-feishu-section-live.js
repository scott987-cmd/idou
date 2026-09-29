// 飞书消息 in the real Electron app, against Feishu's own public site (its
// sign-in page, no account): nothing here needs a login, but the page is live,
// so this is not in the automatic acceptance set. Run it by name:
//   IDOU_DESKTOP_BACKGROUND=1 node scripts/smoke-feishu-section-live.js
//
// Two things found on 2026-09-23 that no check covered. The 消息文档自动整理
// row fell out of the two-column grid the section had become and showed as a
// sliver along the bottom; it has to sit under the page, whole, with the native
// page measured above it, open or closed. And the docked composer's draft was
// refused on every keystroke once the renderer had lost count of its revision.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const ROOT = process.cwd();
const OUT = path.resolve("docs/evidence");
await mkdir(OUT, { recursive: true });
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-feishu-section-"));
const data = path.join(directory, "data");
await mkdir(data, { recursive: true });
// No control plane: the scope is the data root itself. A generic Feishu origin,
// not the person's tenant; the view shows Feishu's sign-in page, no account.
await writeFile(path.join(data, "last-feishu-origin.json"), JSON.stringify({ origin: "https://www.feishu.cn" }));
const env = { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: data, IDOU_DESKTOP_BACKGROUND: "1" };
delete env.IDOU_SERVER_URL;
let app;
const result = {};
try {
  app = await electron.launch({ executablePath: electronBinary, args: [ROOT], env, cwd: directory, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();

  // A cowork draft saved a few times, so its stored revision is past 0.
  await page.locator("#prompt").fill("先存一份工作任务草稿");
  await page.waitForTimeout(900);
  await page.locator("#prompt").fill("先存一份工作任务草稿，第二版");
  await page.waitForTimeout(900);

  await page.locator('[data-section="feishu"]').click();
  await page.locator("#feishu-chat-area").waitFor();
  await page.locator(".feishu-extras").waitFor();
  const nativeBounds = () => app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win.contentView.children.find((child) => /feishu\.cn/.test(child.webContents?.getURL() ?? ""));
    return view ? { ...view.getBounds(), visible: view.getVisible?.() ?? null } : null;
  });
  const boxes = () => page.evaluate(() => Object.fromEntries(["#library", "#feishu-chat-area", ".feishu-extras", "#feishu-agent-dock"].map((selector) => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return [selector, rect && { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), bottom: Math.round(rect.bottom) }];
  })));
  let bounds = null;
  for (let attempt = 0; attempt < 80 && !(bounds?.height > 100); attempt++) { await page.waitForTimeout(100); bounds = await nativeBounds(); }
  await page.waitForTimeout(400); bounds = await nativeBounds();
  const closed = await boxes();
  result.closed = { dom: closed, native: bounds };
  await page.screenshot({ path: path.join(OUT, "desktop-feishu-section.png"), scale: "css" });
  const library = closed["#library"], area = closed["#feishu-chat-area"], extras = closed[".feishu-extras"], dock = closed["#feishu-agent-dock"];
  assert.ok(extras.y >= area.bottom - 1, "the extras row is under the page");
  assert.ok(extras.bottom <= library.bottom + 1 && extras.bottom >= library.bottom - 1, "and ends where the section ends: inside it, no gap");
  assert.ok(extras.height >= 20, "and shown whole");
  assert.equal(extras.x, area.x, "in the page's column");
  assert.ok(dock.height >= library.height - 1, "the Agent column runs the full height");
  assert.ok(Math.abs(bounds.height - area.height) <= 1 && Math.abs(bounds.y - area.y) <= 1, "the native page covers exactly its area");
  assert.ok(bounds.y + bounds.height <= extras.y + 1, "and never the row under it");
  await page.screenshot({ path: path.join(OUT, "desktop-feishu-section.png"), scale: "css" });

  await page.locator(".feishu-extras > summary").click();
  await page.waitForTimeout(600);
  const opened = await boxes(); const openedBounds = await nativeBounds();
  result.opened = { dom: opened, native: openedBounds };
  assert.ok(opened[".feishu-extras"].height > extras.height, "opening it takes more room");
  assert.ok(Math.abs(openedBounds.height - opened["#feishu-chat-area"].height) <= 1, "and the native page shrinks with its area");
  assert.ok(openedBounds.y + openedBounds.height <= opened[".feishu-extras"].y + 1);
  await page.screenshot({ path: path.join(OUT, "desktop-feishu-section-open.png"), scale: "css" });
  await page.locator(".feishu-extras > summary").click();
  await page.waitForTimeout(300);

  // What the start-up resume sends: every draft record dropped while this
  // section is open. The docked composer must still save.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("idou:auth-changed", false));
  await page.waitForTimeout(800);
  await page.locator("#prompt").fill("在飞书消息里续写的草稿");
  await page.waitForTimeout(1200);
  const bannerAfterReset = await page.locator("#error-banner").textContent();
  result.bannerAfterReset = bannerAfterReset;
  assert.ok(!bannerAfterReset.startsWith("草稿尚未保存"), `the docked composer saves after the reset: ${bannerAfterReset}`);

  // The store moves on behind this window's back; its next save recounts.
  await page.evaluate(async () => {
    const stored = await window.idou.taskUiState("draft:cowork");
    await window.idou.saveTaskUiState("draft:cowork", { ...stored, draft: { ...stored.draft, text: "别处写入的一版" } }, stored.revision);
  });
  await page.locator("#prompt").fill("在飞书消息里续写的草稿，再改一次");
  await page.waitForTimeout(1500);
  const bannerAfterStale = await page.locator("#error-banner").textContent();
  result.bannerAfterStale = bannerAfterStale;
  assert.ok(!bannerAfterStale.startsWith("草稿尚未保存"), `a stale revision recounts once instead of refusing: ${bannerAfterStale}`);
  const saved = await page.evaluate(() => window.idou.taskUiState("draft:cowork"));
  result.savedText = saved?.draft?.text;
  assert.equal(saved?.draft?.text, "在飞书消息里续写的草稿，再改一次");
  assert.deepEqual(errors, []);
  result.passed = true;
} catch (error) {
  result.passed = false; result.error = String(error?.message ?? error).split("\n").slice(0, 3).join(" | ");
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 1));
  if (!result.passed) process.exitCode = 1;
}
