import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, readdir, stat, rm } from "node:fs/promises";
import { storedBytes } from "./fixtures/wiki-store.js";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-bundle-ui-")), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app, page; const errors = [];
async function launch() {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/wiki-bundle-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory } });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator('[data-section="knowledge"]').click(); await page.locator("#knowledge-query").waitFor();
}
async function search() { await page.locator("#knowledge-query").fill("交付"); await page.locator("#search-knowledge").click(); await page.locator("#search-knowledge:not([disabled])").waitFor(); }
try {
  await launch();
  assert.deepEqual(await app.evaluate(() => globalThis.bundleFixture.receive()), { retained: 1, requested: 1 });
  await search(); await page.locator(".knowledge-synthesis").waitFor();
  assert.equal(await page.locator(".knowledge-card").count(), 1);
  assert.match(await page.locator(".knowledge-synthesis").innerText(), /同步归纳（发布者声明）/);
  assert.match(await page.locator(".knowledge-synthesis").innerText(), /来源包标注模型：GLM-5.3/);
  assert.equal(await page.locator(".knowledge-synthesis script").count(), 0);
  assert.equal(await page.evaluate(() => typeof window.__bundlePwned), "undefined");
  await page.locator(".synthesis-fact summary").click();
  assert.equal(await page.locator(".synthesis-fact blockquote").innerText(), "核对文档阅读与消息来源");
  const result = await page.evaluate(() => window.idou.searchKnowledge("交付"));
  assert.equal(result.hits[0].synthesis.origin.kind, "wiki-bundle");
  await page.locator(".knowledge-card").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, "desktop-wiki-bundle-fixture.png"), scale: "css" });
  assert.deepEqual(await app.evaluate(() => ({ downloads: globalThis.bundleFixture.downloads, releases: globalThis.bundleFixture.releases })), { downloads: 1, releases: 1 });
  const saved = await storedBytes(path.join(directory, "knowledge", "local-wiki.enc"));
  assert.equal(saved.includes(Buffer.from("核对文档")), false);
  await app.close(); app = null;

  // Actual desktop restart; imports stay queryable without another transfer.
  await launch(); await search(); await page.locator(".knowledge-synthesis").waitFor();
  assert.match(await page.locator(".knowledge-synthesis").innerText(), /同步归纳（发布者声明）/);
  assert.match(await page.locator(".knowledge-synthesis").innerText(), /来源包标注模型：GLM-5.3/, "a GLM synthesis is kept, not dropped, on restart");
  assert.equal(await app.evaluate(() => globalThis.bundleFixture.downloads), 0);
  await page.locator(".knowledge-open").click();
  await page.locator("#file-title").filter({ hasText: "交付计划" }).waitFor();
  assert.match(await page.locator("#file-content").inputValue(), /核对文档阅读与消息来源/);
  assert.equal(await page.locator("#prompt").isVisible(), true);
  await app.evaluate(() => { globalThis.chatFixture.documentDenied = true; });
  await page.locator('[data-section="knowledge"]').click(); await search();
  await page.locator("#knowledge-status").filter({ hasText: "已核验 0" }).waitFor();
  assert.equal(await page.locator(".knowledge-card").count(), 0);

  // The person can finally see what is stored and take it back out. The listing
  // makes no Feishu call at all -- a revoked source still appears here, because
  // this says what is on this machine, not what may be answered from.
  const beforeList = (await app.evaluate(() => globalThis.chatFixture.calls)).length;
  await page.locator("#knowledge-refresh-list").click();
  await page.locator("#knowledge-inventory table").waitFor();
  assert.equal(await page.locator("#knowledge-inventory tbody tr").count(), 1);
  // The list is filterable, because a store of a thousand documents is a wall
  // otherwise; a filter that matches nothing says so instead of showing an
  // empty table.
  await page.locator("#knowledge-filter").fill("交付");
  assert.equal(await page.locator("#knowledge-inventory tbody tr").count(), 1);
  await page.locator("#knowledge-filter").fill("不存在的标题");
  await page.locator("#knowledge-inventory .empty").waitFor();
  await page.locator("#knowledge-filter").fill("");
  await page.locator("#knowledge-inventory table").waitFor();
  assert.match(await page.locator("#knowledge-inventory").innerText(), /本机知识副本：1 篇/);
  assert.match(await page.locator("#knowledge-inventory tbody tr").innerText(), /交付计划/);
  // Scoping the list to the signed-in account costs an identity check; reading
  // a document does not happen, because a listing is not an answer.
  const duringList = (await app.evaluate(() => globalThis.chatFixture.calls)).slice(beforeList);
  assert.ok(duringList.every(args => args[0] === "auth"), `listing may only re-check identity, saw ${JSON.stringify(duringList)}`);
  // 同一份文档存了两个链接：清单要说有几份、正在用哪一份，搜索只送一份。
  await app.evaluate(() => { globalThis.chatFixture.documentDenied = false; });
  await page.evaluate(() => window.idou.addKnowledge("https://test.feishu.cn/docx/SyntheticCopy456"));
  await page.locator("#knowledge-refresh-list").click();
  await page.locator("#knowledge-inventory tbody tr:nth-child(2)").waitFor();
  const listed = await page.locator("#knowledge-inventory").innerText();
  assert.match(listed, /2 份近似副本/); assert.match(listed, /组近似重复 1/);
  assert.equal((listed.match(/回答时用这一份代表这组/gu) ?? []).length, 1, "只能有一份被标成代表");
  await page.screenshot({ path: path.join(evidence, "desktop-knowledge-duplicates-fixture.png"), scale: "css" });
  await search();
  assert.equal(await page.locator(".knowledge-card").count(), 1, "两份近似副本只送一份进答案");
  assert.match(await page.locator(".knowledge-card").innerText(), /库里有 2 份几乎相同的副本/);
  await page.locator('[data-section="knowledge"]').click();
  await page.locator("#knowledge-refresh-list").click();
  await page.locator("#knowledge-inventory tbody tr:nth-child(2)").waitFor();
  await page.locator(".knowledge-remove").first().click();
  await page.locator("#knowledge-inventory tbody tr").first().waitFor();
  await page.locator(".knowledge-remove").first().click();
  await page.locator("#knowledge-inventory .empty").waitFor();
  assert.equal(await page.evaluate(async () => (await window.idou.knowledgeList()).sources.length), 0);
  const emptied = await storedBytes(path.join(directory, "knowledge", "local-wiki.enc"));
  assert.equal(emptied.includes(Buffer.from("交付计划")), false, "removing takes the local copy off this disk, not just out of the listing");
  assert.deepEqual(await readdir(path.join(directory, "knowledge", "local-wiki.enc.d")), [], "每篇文档一个文件，移除后一个都不该剩下");
  // The term lists a search leaves behind describe the same documents, so they
  // go when the documents go -- otherwise removing a source would leave its
  // words on this disk.
  await assert.rejects(stat(path.join(directory, "knowledge", "local-wiki.enc.profiles")), (error) => error.code === "ENOENT",
    "removing the last source must take its saved term lists with it");
  // A source that leaves without the person removing it -- here, three reads in
  // a row that Feishu refuses -- is announced in the list, with its title and
  // why, even though the list is now empty. Silence here was indistinguishable
  // from the document never having said anything.
  await app.evaluate(() => { globalThis.chatFixture.documentDenied = false; });
  await page.evaluate(() => window.idou.addKnowledge("https://test.feishu.cn/docx/SyntheticGone789"));
  await app.evaluate(() => { globalThis.chatFixture.documentDenied = true; });
  for (let attempt = 0; attempt < 3; attempt += 1) await page.evaluate(() => window.idou.searchKnowledge("交付").catch(() => null));
  await page.locator("#knowledge-refresh-list").click();
  await page.locator("#knowledge-gone").waitFor();
  const departed = await page.locator("#knowledge-gone").innerText();
  assert.match(departed, /最近有 1 篇来源被清理出本机副本/);
  assert.match(departed, /交付计划/);
  assert.match(departed, /连续 3 次无法从飞书重新读取/);
  await page.locator("#knowledge-inventory .empty").waitFor();
  await page.screenshot({ path: path.join(evidence, "desktop-knowledge-gone-fixture.png"), scale: "css" });
  await app.evaluate(() => { globalThis.chatFixture.documentDenied = false; });
  assert.deepEqual(errors, []);
  const calls = await app.evaluate(() => globalThis.chatFixture.calls);
  assert.ok(calls.every(args => ["auth", "skills", "--version"].includes(args[0]) || (args[0] === "docs" && args[1] === "+fetch")));
  console.log(JSON.stringify({ passed: true, actualElectronAndNativeWiki: true, syntheticDriveKeyAuthorityAndFeishu: true, actualBundleCrypto: true,
    importedSynthesisMarkedAsPublisherClaim: true, publisherModelKept: "GLM-5.3", citationRendered: true, scriptTextInert: true, encryptedRestart: true, originalDocumentOpened: true,
    revokedSourceHidden: true, inventoryListedWithoutFeishuCalls: true, duplicateCopiesShownAndCollapsed: true, removedLocalCopyOnly: true, departuresAnnounced: true, liveWrites: 0, paidCalls: 0, rendererErrors: errors }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, "desktop-wiki-bundle-failure.png"), scale: "css" }); throw error;
} finally { await app?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
