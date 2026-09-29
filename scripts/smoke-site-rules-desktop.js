import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";

// A coding task opened on a site with 用编程任务修改 is told, before it adds
// anything, what publishing that site's folder will take -- in the actual
// Electron app, with the actual Codex and the product's own gateway, against a
// scripted model: no login, no paid call.
//
// 2026-09-23: asked to put a video on the product page, a coding task copied an
// .mp4 and wrote a faq.md into the site's folder, and 发布 refused the whole
// version at the end. The rules were only ever said by that refusal.
//
//   node scripts/smoke-site-rules-desktop.js
const RULES = "which i豆 publishes as a static website for other people to open";
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-rules-desktop-"));
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
const seen = { requests: 0, told: 0 };
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async (_url, options) => {
  seen.requests += 1;
  if (String(options.body).includes(RULES)) seen.told += 1;
  return syntheticResponseStream("好的，先看一下这个网站的文件。");
} });
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

  // A site made of files only, as 文档网站 makes one: its own folder in the account's data.
  const site = await page.evaluate(() => window.idou.siteCreate({ name: "规则样本站" }));
  // What sank the publish on 2026-09-23 was an .mp4 and a faq.md. A video may be
  // published since (as mp4 or webm); a .mov or a Markdown page still cannot, and
  // the list names them before anyone presses 发布.
  await writeFile(path.join(site.folder, "intro.mp4"), "synthetic video");
  await writeFile(path.join(site.folder, "intro.mov"), "synthetic quicktime");
  await writeFile(path.join(site.folder, "faq.md"), "# 常见问题");
  await page.locator('[data-section="sites"]').click();
  const warning = page.locator(`.site-row[data-site="${site.id}"] .site-problems`);
  await warning.waitFor();
  const said = await warning.innerText();
  assert.match(said, /faq\.md（不能发布这种文件）/, said);
  assert.match(said, /intro\.mov（不能发布这种文件）/, said);
  assert.doesNotMatch(said, /intro\.mp4/, `a video is publishable: ${said}`);
  await page.screenshot({ path: path.resolve("docs/evidence/desktop-site-publish-problems.png"), scale: "css" });
  await page.locator(`.site-row[data-site="${site.id}"] .site-edit`).click();
  await page.locator("#prompt").fill("在首页加一段介绍视频。");
  await page.locator("#send").click();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && seen.requests === 0) await new Promise((resolve) => setTimeout(resolve, 250));
  const state = async () => JSON.stringify({ banner: await page.locator("#error-banner").textContent().catch(() => null),
    tasks: (await page.evaluate(async () => (await window.idou.snapshot()).tasks)).map((row) => ({ mode: row.mode, status: row.status, error: row.error, stage: row.stage })) });
  assert.ok(seen.requests > 0, `the coding task reached the model: ${await state()}`);
  assert.ok(seen.told > 0, `the coding task on the site's folder was told what publishing takes (${seen.told} of ${seen.requests} requests)`);
  const task = await page.evaluate(async () => (await window.idou.snapshot()).tasks.find((row) => row.mode === "coding"));
  assert.equal(task?.cwd, site.folder, "and it was working in that folder");
  assert.deepEqual(errors, []);
  console.log("site rules desktop smoke passed");
} finally {
  await app?.close().catch(() => {});
  server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
