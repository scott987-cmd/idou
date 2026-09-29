import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-file-preview-")), workspace = path.join(directory, "workspace"), evidence = path.resolve("docs/evidence/task-ui");
await mkdir(workspace); await mkdir(evidence, { recursive: true }); let app;
const taskRow = (page, title) => page.locator("#recent-tasks .recent-row", { hasText: title }).locator("button").first();
const fileButton = (page, name) => page.locator("#file-list button", { hasText: name }).first();
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/file-preview-desktop-entry.js")], env: { ...clientEnvironment(),
    ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_FILE_PREVIEW_WORKSPACE: workspace } });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(25_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor(); await page.reload(); await page.locator("#new-task").waitFor();
  await page.locator('[data-section="coding"]').click(); await page.locator("#section-title", { hasText: "编程任务" }).waitFor();
  await taskRow(page, "文件与预览验收").click(); await page.locator("#workbench-files").click();
  // C06: text has line numbers, a raster stays an image, and Office gets a
  // system handler plus its optional text projection instead of a decode error.
  await fileButton(page, "notes.txt").click(); assert.equal(await page.locator("#file-line-numbers").innerText(), "1\n2\n3\n4"); assert.match(await page.locator("#file-content").inputValue(), /第二行/);
  await fileButton(page, "picture.png").click(); await page.locator("#file-image").waitFor(); assert.match(await page.locator("#file-image").getAttribute("src"), /^data:image\/png;base64,/);
  await fileButton(page, "report.docx").click(); await page.locator("#file-card", { hasText: "DOCX 文件不会当成文本打开" }).waitFor();
  await page.locator("#open-system-file").click(); assert.equal(path.basename((await app.evaluate(() => globalThis.filePreviewFixture.opened)).at(-1)), "report.docx");
  await page.screenshot({ path: path.join(evidence, "u08-file-types.png"), scale: "css" });
  await page.locator("#open-readable-copy").click(); assert.match(await page.locator("#file-content").inputValue(), /报告文字版/);
  // C08/C09: the preview exposes a safe address, refreshes without a model
  // turn, and a page reference survives only in its owning task draft.
  await fileButton(page, "index.html").click(); await page.locator("#open-preview").click();
  await page.locator("#preview-title", { hasText: "首页成果" }).waitFor(); assert.equal(await page.locator("#preview-address").innerText(), "/index.html");
  await page.locator("#reference-preview-page").click(); await page.locator("#mention-row", { hasText: "页面 · 首页成果 · /index.html" }).waitFor();
  await taskRow(page, "另一个编程任务").click(); assert.equal(await page.locator("#mention-row").isHidden(), true);
  await taskRow(page, "文件与预览验收").click(); await page.locator("#preview-title", { hasText: "首页成果" }).waitFor(); await page.locator("#mention-row", { hasText: "页面 · 首页成果 · /index.html" }).waitFor();
  await page.locator("#refresh-preview").click(); await page.locator("#preview-title", { hasText: "首页成果" }).waitFor();
  await page.locator("#prompt").fill("把当前页面的标题写得更清楚"); await page.locator("#send").click();
  for (let attempt = 0; attempt < 100 && (await app.evaluate(() => globalThis.filePreviewFixture.inputs.length)) === 0; attempt++) await page.waitForTimeout(50);
  await page.locator("#task-status", { hasText: "已完成" }).waitFor();
  const inputs = await app.evaluate(() => globalThis.filePreviewFixture.inputs); assert.equal(inputs.length, 1); assert.match(inputs[0].text, /当前预览页面：首页成果 · 地址 \/index\.html/);
  await page.screenshot({ path: path.join(evidence, "u08-browser-page-reference.png"), scale: "css" });
  await page.locator("#close-preview").click(); await page.locator("#files").waitFor();
  await app.evaluate(() => globalThis.filePreviewFixture.removeNotes()); await fileButton(page, "notes.txt").click();
  await page.locator("#file-card", { hasText: "文件已不在原位置" }).waitFor(); assert.equal(await page.locator("#reveal-task-file").isHidden(), true);
  assert.deepEqual(errors, []); console.log("file and browser preview desktop smoke passed");
} finally { await app?.close().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
