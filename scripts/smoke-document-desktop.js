import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { storedBytes } from "./fixtures/wiki-store.js";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { openFeishuResource, openFileMenuItem } from "./fixtures/open-document.js";

// Synthetic CLI-envelope fixture only. Never sends corporate content to a model.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-document-ui-"));
const evidence = path.resolve("docs/evidence"); await mkdir(evidence, { recursive: true });
// Synthesis is offered only under a model the server confirmed, so the restart
// below connects to the product's own gateway on loopback, whose /healthz names
// MiniMax-M3. It is never asked for a model call: the fixture's synthesizer answers.
const sessions = new SessionRegistry(), issued = sessions.issue({ tenantId: "synthetic", userId: "alice", deviceId: "one" });
const control = createModelGateway({ sessions, apiKey: "synthetic-server-key", fetchImpl: async () => { throw new Error("no model call in this smoke"); } });
control.listen(0, "127.0.0.1"); await once(control, "listening");
const sessionFile = path.join(directory, "connection.json");
let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/document-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory } });
  let page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.evaluate(() => { window.__documentInvalidations = []; window.idou.onDocumentInvalidated((value) => window.__documentInvalidations.push(value)); });
  await openFeishuResource(page, "https://test.feishu.cn/docx/SyntheticDocument123");
  await page.locator("#file-title").filter({ hasText: "飞书文档联调样本" }).waitFor();
  assert.equal(await page.locator("#prompt").isVisible(), true);
  assert.match(await page.locator("#file-content").inputValue(), /不来自企业文档/);
  assert.match(await page.locator("#document-meta").innerText(), /版本 1/);
  assert.equal(await page.locator("#file-content script").count(), 0);
  assert.equal(await page.evaluate(() => typeof window.__docPwned), "undefined");
  await page.locator("#file-content").evaluate((input) => { const start = input.value.indexOf("本轮计划"); input.focus(); input.setSelectionRange(start, start + 4); });
  await page.locator("#quote-selection").click();
  assert.match(await page.locator("#context-label").innerText(), /已选 4 字/);
  await page.screenshot({ path: path.join(evidence, "desktop-feishu-document-fixture.png"), scale: "css" });
  await openFileMenuItem(page, "#show-local-files");
  assert.equal(await page.locator("#file-content").inputValue(), "");
  assert.equal(await page.locator("#document-meta").isVisible(), false);
  await openFeishuResource(page, "https://test.feishu.cn/docx/SyntheticDocument123");
  await page.locator("#document-meta").filter({ hasText: /版本 1/ }).waitFor();
  await page.locator('#mention-row button[aria-label^="移除引用"]').click();
  await page.evaluate(() => { window.__documentInvalidations = []; });
  await app.evaluate(() => { globalThis.documentFixture.revision = 2; });
  await page.locator("#prompt").fill("请解释引用的内容"); await page.locator("#send").click();
  await page.locator("#error-banner").filter({ hasText: /已变化/ }).waitFor();
  await page.waitForFunction(() => window.__documentInvalidations.length > 0);
  assert.equal(await page.locator("#file-content").inputValue(), "", JSON.stringify(await page.evaluate(() => window.__documentInvalidations)));
  assert.equal(await page.locator(".message.user").count(), 0);
  assert.equal(await page.locator("#file-content").inputValue(), "");
  assert.equal(await page.locator("#prompt").inputValue(), "请解释引用的内容");
  await openFeishuResource(page, "https://test.feishu.cn/docx/SyntheticDocument123");
  await page.locator("#document-meta").filter({ hasText: /版本 2/ }).waitFor();
  await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: "执行失败" }).waitFor(); // no model session, no paid call
  const records = (await readdir(path.join(directory, "tasks"))).filter((entry) => entry.endsWith(".json"));
  const saved = JSON.parse(await readFile(path.join(directory, "tasks", records[0]), "utf8"));
  assert.equal(saved.messages.length, 1); assert.equal(saved.messages[0].context.sourceRevision, "2");
  assert.match(saved.messages[0].context.text, /版本 2/); assert.equal(saved.messages[0].context.tenantKey, "synthetic-tenant");
  await app.evaluate(() => { globalThis.documentFixture.denied = true; });
  await page.locator("#prompt").fill("权限撤销后不应继续引用"); await page.locator("#send").click();
  // The refusal must say a permission is missing without claiming the operation
  // was a document read — the same message reaches spreadsheet and Base calls.
  await page.locator("#error-banner").filter({ hasText: /没有这项权限/ }).waitFor();
  assert.equal(await page.locator("#file-content").inputValue(), "");
  assert.equal(await page.locator(".message.user").count(), 1);
  await page.locator('[data-section="coding"]').click();
  assert.equal(await page.locator("#document-url").inputValue(), "");
  assert.equal(await page.locator("#file-content").inputValue(), "");

  // Automatic knowledge ingestion, authoritative query, removal on revocation,
  // navigation back to a real task, and encrypted restore across app restart.
  await page.locator('[data-section="knowledge"]').click();
  await page.locator(".knowledge-primary").waitFor();
  assert.equal(await page.locator(".knowledge-primary").isVisible(), true, "search and add-source actions must lead the knowledge page");
  assert.equal(await page.locator(".knowledge-advanced").evaluate(node => node.open), false, "automation controls must not bury the primary workflow");
  assert.equal((await page.locator("#build-knowledge-graph").textContent()).trim(), "重新核验并生成关系图");
  assert.equal(await page.evaluate(() => Boolean(document.querySelector("#knowledge-query").compareDocumentPosition(document.querySelector(".knowledge-advanced")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  await page.locator("#knowledge-query").fill("项目"); await page.locator("#search-knowledge").click();
  await page.locator("#knowledge-status").filter({ hasText: "已核验 0" }).waitFor();
  assert.equal(await page.locator(".knowledge-card").count(), 0);
  await app.evaluate(() => { globalThis.documentFixture.denied = false; });
  await page.locator('[data-section="cowork"]').click();
  await openFeishuResource(page, "https://test.feishu.cn/docx/SyntheticDocument123");
  await page.locator("#document-meta").filter({ hasText: /版本 2/ }).waitFor();
  await page.locator('[data-section="knowledge"]').click();
  await page.locator("#knowledge-query").fill("项目"); await page.locator("#search-knowledge").click();
  await page.locator(".knowledge-card").waitFor();
  assert.equal(await page.locator(".knowledge-card").count(), 1);
  assert.match(await page.locator(".knowledge-card").innerText(), /原文摘录 · 版本 2/);
  assert.equal(await page.evaluate(() => typeof window.__docPwned), "undefined");
  await page.screenshot({ path: path.join(evidence, "desktop-knowledge-fixture.png"), scale: "css" });
  await page.locator(".knowledge-open").click();
  await page.locator("#document-meta").filter({ hasText: /版本 2/ }).waitFor();
  assert.equal(await page.locator("#prompt").isVisible(), true);
  const calls = await app.evaluate(() => globalThis.documentFixture.calls);
  await app.close(); app = null;
  // 一篇文档一个加密文件：明文不能出现在副本目录下的任何一个文件里。
  const wikiBytes = await storedBytes(path.join(directory, "knowledge", "local-wiki.enc"));
  assert.equal(wikiBytes.includes(Buffer.from("项目安排")), false);
  await writeFile(sessionFile, JSON.stringify({ token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${control.address().port}` }), { mode: 0o600 });
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/document-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: directory } });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#model-label").filter({ hasText: "MiniMax-M3 · 企业模型网关" }).waitFor({ state: "attached" });
  await app.evaluate(() => { globalThis.documentFixture.revision = 3; });
  await page.locator('[data-section="knowledge"]').click();
  await page.locator("#knowledge-query").fill("项目"); await page.locator("#search-knowledge").click();
  await page.locator(".knowledge-card").waitFor();
  assert.match(await page.locator(".knowledge-card").innerText(), /原文摘录 · 版本 3/);
  assert.match(await page.locator(".knowledge-card").innerText(), /版本 3 的内容/);
  assert.equal(await page.locator(".knowledge-card").count(), 1);
  await page.locator(".knowledge-advanced > summary").click();
  await page.locator("#toggle-knowledge-synthesis").click();
  await page.locator("#toggle-knowledge-synthesis").filter({ hasText: "关闭并取消归纳" }).waitFor();
  await page.locator(".knowledge-open").click();
  await page.locator("#document-meta").filter({ hasText: /版本 3/ }).waitFor();
  await page.locator('[data-section="knowledge"]').click();
  await page.locator("#knowledge-query").fill("项目"); await page.locator("#search-knowledge").click();
  await page.locator(".knowledge-synthesis").waitFor();
  assert.match(await page.locator(".knowledge-synthesis").innerText(), /本轮测试聚焦/);
  await page.locator(".synthesis-fact summary").click();
  assert.match(await page.locator(".synthesis-fact blockquote").innerText(), /本轮计划：读取文档、引用段落、核对来源/);
  assert.equal(await app.evaluate(() => globalThis.documentFixture.synthesisCalls), 1);
  await page.screenshot({ path: path.join(evidence, "desktop-knowledge-synthesis-fixture.png"), scale: "css" });
  await page.locator(".knowledge-advanced > summary").click();
  await page.locator("#toggle-knowledge-synthesis").click();
  await page.locator("#toggle-knowledge-synthesis").filter({ hasText: "本次会话开启" }).waitFor();
  await app.evaluate(() => { globalThis.documentFixture.denied = true; });
  await page.locator("#search-knowledge").click();
  await page.locator("#knowledge-status").filter({ hasText: "已核验 0" }).waitFor();
  assert.equal(await page.locator(".knowledge-card").count(), 0);
  calls.push(...await app.evaluate(() => globalThis.documentFixture.calls));
  assert.ok(calls.every((args) => !args.includes("+update") && !args.includes("login") && !args.includes("--yes")));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, source: "synthetic CLI, model and AES fixtures; NOT live Feishu, MiniMax or OS Keychain", staleDocumentRejected: true, revokedPermissionRejected: true, persistedReference: true, automaticWiki: true, encryptedWikiRestored: true, wikiRevalidatedAfterRestart: true, automaticCitedSynthesis: true, modelCalls: 0, fixtureModelCalls: 1, feishuWrites: 0, rendererErrors: errors }));
} catch (error) {
  console.error(error);
  const page = app?.windows().find((window) => !window.isClosed());
  if (page) await page.screenshot({ path: path.join(evidence, "desktop-feishu-document-failure.png"), scale: "css" });
  throw error;
} finally { if (app) await app.close(); control.close(); control.closeAllConnections(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
