import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-diff-review-")), workspace = path.join(directory, "workspace"), evidence = path.resolve("docs/evidence/task-ui");
await mkdir(workspace); await mkdir(evidence, { recursive: true }); let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/diff-review-desktop-entry.js")], env: { ...clientEnvironment(),
    ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_DIFF_REVIEW_WORKSPACE: workspace } });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor(); await page.locator('[data-section="coding"]').click();
  await page.locator("#recent-tasks .recent-row", { hasText: "差异审阅验收" }).locator("button").first().click();
  // C01/C02: opening the first turn reads its stored net diff, not today's file.
  await page.locator(".turn-diff-open").first().click();
  await page.locator(".diff-scope-basis", { hasText: "本轮改动" }).waitFor();
  assert.match(await page.locator(".diff-scope-basis").innerText(), /codex-one/);
  const historical = await page.locator("#changes-content .activity-diff").innerText();
  assert.match(historical, /\+first/); assert.doesNotMatch(historical, /manual later/);
  // C03: select the new-side line and add an opinion to the composer.
  await page.locator("#changes-content .diff-review-line.diff-add").click();
  await page.locator(".diff-feedback textarea").fill("这一行需要保留兼容逻辑"); await page.locator(".diff-feedback button", { hasText: "添加到对话" }).click();
  await page.locator("#mention-row", { hasText: "行级意见 · a.js · 新侧 1 行" }).waitFor();
  assert.equal(await page.locator("#prompt").inputValue(), "这一行需要保留兼容逻辑");
  await page.locator("#send").click();
  for (let attempt = 0; attempt < 100 && (await app.evaluate(() => globalThis.diffReviewFixture.inputs.length)) !== 1; attempt += 1) await page.waitForTimeout(20);
  await page.locator("#task-status", { hasText: "已完成" }).waitFor();
  assert.equal((await app.evaluate(() => globalThis.diffReviewFixture.inputs)).length, 1);
  assert.match(await page.locator("#messages .message.user").last().innerText(), /a\.js · 新侧第 1 行 · [a-f0-9]{8} · 这一行需要保留兼容逻辑/);
  // The top-level diff entry always returns to the working tree and names its HEAD basis.
  await page.locator("#workbench-diff").click(); await page.locator(".diff-scope-basis", { hasText: "工作目录改动" }).waitFor();
  assert.match(await page.locator(".diff-scope-basis").innerText(), /HEAD [a-f0-9]{40}/);
  assert.match(await page.locator("#changes-content .activity-diff").innerText(), /\+manual later/);
  // C04: a file change after selection keeps the opinion but blocks dispatch.
  await page.locator("#changes-content .diff-review-line.diff-add").click(); await page.locator(".diff-feedback textarea").fill("这个意见不能漂到新版本");
  await page.locator(".diff-feedback button", { hasText: "添加到对话" }).click(); await app.evaluate(() => globalThis.diffReviewFixture.change());
  await page.locator("#send").click(); await page.locator("#error-banner", { hasText: "差异已变化" }).waitFor();
  assert.equal((await app.evaluate(() => globalThis.diffReviewFixture.inputs)).length, 1, "stale feedback must not start another turn");
  assert.equal(await page.locator("#prompt").inputValue(), "这个意见不能漂到新版本");
  assert.match(await page.locator("#mention-row").innerText(), /意见需核对/);
  await page.screenshot({ path: path.join(evidence, "u07-diff-review.png"), scale: "css" });
  assert.deepEqual(errors, []);
  console.log("diff review desktop smoke passed");
} finally { await app?.close().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
