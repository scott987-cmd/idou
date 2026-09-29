// Keeping a checkable version of a coding result: submit a manifest, archive the
// exact package, retrieve it, preview it in isolation, withdraw it.
//
// The native alert is gone -- every one of those steps is confirmed in the app
// now, on a card with the buttons the main process offered. What has to hold is
// unchanged: cancelling costs nothing and posts nothing, a workspace that
// changes while the confirmation is up is refused, the archived bytes are the
// confirmed ones rather than later work, a corrupt download never falls back to
// the local cache, and the preview is a sealed snapshot with no network, no
// popups, no workers and no bridge.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { answerConfirm, waitForHumanChoice, waitForHumanConfirm } from "./fixtures/agent-harness.js";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { AppCatalog, AppCatalogService } from "../src/control-plane/app-catalog.js";
import { DriveBudget, DriveBudgetService } from "../src/control-plane/drive-budget.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-apps-ui-"))), workspace = path.join(directory, "workspace"), data = path.join(directory, "native");
await mkdir(workspace);
const source = '<!doctype html><meta charset="utf-8"><title>合成应用</title><style>body{font:22px system-ui;background:#f1f1e9;padding:30px}button{padding:18px}</style><h1>交互式应用成果</h1><button id="count" onclick="this.textContent=Number(this.textContent)+1">0</button>';
await writeFile(path.join(workspace, "index.html"), source);
const sessions = new SessionRegistry(), parent = sessions.issue({ tenantId: "synthetic", userId: "alice", deviceId: "device" }), tokens = [], issueApps = sessions.issueForApps.bind(sessions);
sessions.issueForApps = (...args) => { const token = issueApps(...args); tokens.push(token.token); return token; };
const issueDrive = sessions.issueForDrive.bind(sessions); sessions.issueForDrive = (...args) => { const token = issueDrive(...args); tokens.push(token.token); return token; };
const catalogOptions = { databaseFile: path.join(directory, "server.sqlite"), tenants: [{ authProvider: "development", tenantId: "synthetic", appId: null, publishers: ["alice"] }], feishu: SAAS_FEISHU };
let catalog = new AppCatalog(catalogOptions); const service = new AppCatalogService({ sessions, catalog, allowDevelopment: true }); let posts = 0;
const budgetOptions = { databaseFile: path.join(directory, "budget.sqlite"), policies: [{ authProvider: "development", tenantId: "synthetic", appId: null, providerId: "saas-cli", driveTenantKey: "synthetic-tenant", folderToken: "SyntheticFolder123", maxBytes: 1048576 }], feishu: SAAS_FEISHU };
let ledger = new DriveBudget(budgetOptions); const budgetService = new DriveBudgetService({ sessions, ledger, allowDevelopment: true });
const driveFile = path.join(directory, "synthetic-drive.json");
const server = createModelGateway({ sessions, apiKey: "synthetic-server-provider-key", authHandler: async (req, res) => { if (req.url === "/v1/apps/submit") posts++; return (await service.handle(req, res)) || budgetService.handle(req, res); }, fetchImpl: () => assert.fail("No model call expected") });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const sessionFile = path.join(directory, "connection.json"); await writeFile(sessionFile, JSON.stringify({ token: parent.token, expiresAt: parent.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` }), { mode: 0o600 });
const launch = () => electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/apps-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: data, APPS_FIXTURE_WORKSPACE: workspace, APPS_FIXTURE_DRIVE: driveFile } });
let app; const errors = []; const evidence = path.resolve("docs/evidence"); await mkdir(evidence, { recursive: true });
try {
  app = await launch(); let page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", (error) => errors.push(error.message));
  const card = () => page.locator("#confirmations .confirm-card");
  // A task is made the way a person makes one: choose the section, choose the
  // directory, open the task's own files. Made over IPC it never reaches the
  // renderer, and a task nobody has spoken to is not in the sidebar to click.
  // 任务文件 is also where the file list now lives; the files tab is gone.
  await page.locator('[data-section="coding"]').click();
  await page.locator("#pick-workspace").click();
  await page.locator("#open-files").click();
  const id = (await page.evaluate(() => window.idou.snapshot())).tasks[0].id;
  await page.locator("#file-list button").filter({ hasText: "index.html" }).click(); await page.locator("#open-preview").click();
  await page.locator('#preview-area[data-preview-state="ready"]').waitFor();
  const counter = await app.evaluate(async ({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "i豆"); const view = win.contentView.children.find((v) => v.webContents); return view.webContents.executeJavaScript("document.querySelector('#count').click(); document.querySelector('#count').textContent"); });
  assert.equal(counter, "1");

  // The door between the two halves. A page written in a coding task used to
  // have nowhere to go: you could build it and preview it here, and then find
  // nothing anywhere to publish it or change it, because 文档网站 only ever held
  // sites started from 新建网站. Now the preview offers it, and what arrives in
  // that list is this task's own folder -- not a copy, which the next turn of
  // this task would leave behind.
  const listed = page.locator("#site-from-task");
  assert.equal(await listed.isVisible(), true, "预览里没有「发布到文档网站」");
  await listed.click();
  // The first press adds it and stays here: the page is still being worked on,
  // and a task with no name yet is not in the sidebar to come back to.
  await listed.filter({ hasText: "去文档网站" }).waitFor();
  const sites = await page.evaluate(() => window.idou.sites());
  assert.equal(sites.length, 1, "没有收进文档网站");
  assert.equal(sites[0].kind, "files");
  // It points at the task's own directory, so 用编程任务修改 comes back to the
  // same place and a later turn edits exactly what would be published.
  assert.equal(sites[0].path, await realpath(workspace));
  // The second press is an ordinary switchSection to that list, which closes
  // the open task -- so it is not pressed here; the rest of this smoke needs
  // the task. What matters is that the door exists and what came through it.

  await page.locator('[data-tab="apps"]').click(); await page.locator("#apps-notice").filter({ hasText: "暂无" }).waitFor(); assert.equal(await page.locator("#app-entry").inputValue(), "index.html");
  await page.locator("#submit-app-candidate").click(); await answerConfirm(page, "取消");
  await page.locator("#submit-app-candidate:not([disabled])").waitFor(); assert.equal(posts, 0);
  // Changed while the confirmation is on screen: what was disclosed is no
  // longer what would be saved, so nothing is submitted.
  await page.locator("#submit-app-candidate").click(); await card().waitFor();
  await appendFile(path.join(workspace, "index.html"), "<p>Changed during confirmation</p>");
  await waitForHumanChoice(card(), "保存并提交清单");
  await page.locator("#error-banner").filter({ hasText: "已变化" }).waitFor(); assert.equal(posts, 0);
  await page.locator("#submit-app-candidate").click();
  const detail = await waitForHumanConfirm(page, "保存并提交清单");
  await page.locator(".app-candidate").waitFor();
  assert.equal(posts, 1); assert.match(await page.locator(".app-candidate-state").textContent(), /待审 · 未部署/);
  assert.match(detail, /不部署/); assert.match(detail, /不上传源码/);
  const rows = catalog.list(parent, { appId: id }).releases, savedDigest = rows[0].digest;
  const before = await readFile(path.join(data, "application-candidates", `${savedDigest}.json`), "utf8");
  assert.match(Buffer.from(JSON.parse(before).blobs[0].base64, "base64").toString(), /Changed during confirmation/);
  await page.screenshot({ path: path.join(evidence, "desktop-app-candidates-fixture.png"), scale: "css" });
  await writeFile(path.join(workspace, "index.html"), source + "<p>Newer work not in archive</p>");
  await page.locator("#app-archive-folder").fill("https://synthetic.feishu.cn/drive/folder/SyntheticFolder123");
  await page.locator(".archive-app-candidate").click(); await answerConfirm(page, "取消");
  await page.locator(".archive-app-candidate:not([disabled])").waitFor();
  assert.equal(ledger.snapshot(parent).chargedBytes, 0); assert.equal(catalog.list(parent, { appId: id }).releases[0].archive, null);
  await page.locator(".archive-app-candidate").click();
  const archiveDetail = await waitForHumanConfirm(page, "确认上传版本包");
  await page.locator(".app-archive-state").filter({ hasText: "客户端已核验目录" }).waitFor();
  const drive = JSON.parse(await readFile(driveFile)); assert.equal(drive.uploads, 1); assert.equal(Buffer.from(drive.bytes, "base64").toString(), before);
  assert.equal(ledger.snapshot(parent).chargedBytes, Buffer.byteLength(before));
  assert.match(archiveDetail, /全部源码与资源/); assert.match(archiveDetail, /尚不校验远端内容哈希/);
  await page.locator(".verify-app-archive").scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, "desktop-app-archive-fixture.png"), scale: "css" });
  await app.close(); app = null; catalog.close(); ledger.close(); catalog = new AppCatalog(catalogOptions); service.catalog = catalog; ledger = new DriveBudget(budgetOptions); budgetService.ledger = ledger;
  await rm(path.join(data, "application-candidates", `${savedDigest}.json`));
  // A task nobody has spoken to is only in the sidebar while it is already on
  // screen, so a restart cannot reopen it. Writing the message a person would
  // have typed is what puts it back in the list; no model is involved.
  const record = path.join(data, "tasks", `${id}.json`), saved = JSON.parse(await readFile(record, "utf8"));
  saved.messages.push({ id: randomUUID(), role: "user", text: "把这个静态成果整理成可以提交的版本。", createdAt: Date.now() });
  await writeFile(record, JSON.stringify(saved), { mode: 0o600 });
  app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", (error) => errors.push(error.message));
  await page.locator('[data-section="coding"]').click();
  await page.locator("#recent-tasks button").first().click(); await page.locator('[data-tab="apps"]').click(); await page.locator(".app-candidate").waitFor();
  assert.equal(posts, 1);
  await page.locator(".retrieve-app-archive").click(); await page.locator(".app-retrieval-state").filter({ hasText: "本次取回内容校验通过" }).waitFor();
  assert.equal(await readFile(path.join(data, "application-candidates", `${savedDigest}.json`), "utf8"), before);
  assert.equal(JSON.parse(await readFile(driveFile)).downloads, 1);
  await page.locator(".app-retrieval-state").scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, "desktop-app-retrieval-fixture.png"), scale: "css" });
  await app.evaluate(() => { globalThis.appsFixture.corruptDownload = true; });
  await page.locator(".retrieve-app-archive").click(); await page.locator(".app-retrieval-state").filter({ hasText: "未完成本次取回校验" }).waitFor();
  assert.equal(await readFile(path.join(data, "application-candidates", `${savedDigest}.json`), "utf8"), before);
  assert.equal(JSON.parse(await readFile(driveFile)).downloads, 2);
  await page.screenshot({ path: path.join(evidence, "desktop-app-retrieval-denied-fixture.png"), scale: "css" });
  await app.evaluate(() => { globalThis.appsFixture.corruptDownload = false; });
  const guest = async (code) => app.evaluate(async ({ BrowserWindow }, code) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.getTitle() === "i豆");
    const view = win.contentView.children.find((v) => v.webContents); if (!view) return null;
    return view.webContents.executeJavaScript(code);
  }, code);
  const guestCount = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === "i豆").contentView.children.filter((v) => v.webContents).length);
  await page.locator(".preview-app-archive").click(); await page.locator('#preview-area[data-preview-state="ready"]').waitFor();
  assert.match(await guest("document.body.textContent"), /Changed during confirmation/);
  assert.doesNotMatch(await guest("document.body.textContent"), /Newer work/);
  assert.equal(await guest("document.querySelector('#count').click(); document.querySelector('#count').textContent"), "1");
  assert.equal(await guest("typeof require + ':' + typeof process + ':' + typeof window.idou"), "undefined:undefined:undefined");
  assert.equal(await page.locator("#context-row").isVisible(), false);
  assert.match(await page.locator("#agent-heading span").textContent(), /不自动引用或修改归档版本/);
  assert.match(await page.locator("#preview-title").textContent(), /不代表工作目录/);
  assert.equal(await guest(`fetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}/preview-egress-probe`)}).then(()=>"allowed",()=>"denied")`), "denied");
  assert.equal(await guest("window.open('https://example.invalid') === null"), true);
  assert.equal(await guest("new Promise(resolve => { try { const worker = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], {type:'text/javascript'}))); const timer = setTimeout(() => { worker.terminate(); resolve('timeout'); }, 2000); worker.onmessage = () => { clearTimeout(timer); worker.terminate(); resolve('allowed'); }; worker.onerror = event => { event.preventDefault(); clearTimeout(timer); worker.terminate(); resolve('denied'); }; } catch { resolve('denied'); } })"), "denied");
  await guest("window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; }); true");
  const oldUrl = await guest("location.href");
  const oldGuestId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'i豆').contentView.children.find(v => v.webContents).webContents.id);
  const capturedGuest = await app.evaluate(async ({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'i豆').contentView.children.find(v => v.webContents);
    const bounds = view.getBounds(); if (bounds.width < 200 || bounds.height < 200) throw new Error('Preview is not visibly mounted');
    return (await view.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path.join(evidence, "desktop-app-archive-preview-content-fixture.png"), Buffer.from(capturedGuest, "base64"));
  const captured = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows().find(w => w.getTitle() === 'i豆').capturePage()).toPNG().toString('base64'));
  await writeFile(path.join(evidence, "desktop-app-archive-preview-fixture.png"), Buffer.from(captured, "base64"));
  await page.locator("#refresh-preview").click(); await page.locator('#preview-area[data-preview-state="ready"]').waitFor();
  assert.equal(await guest("document.querySelector('#count').textContent"), "0");
  await assert.rejects(fetch(oldUrl)); assert.notEqual(await guest("location.href"), oldUrl);
  assert.equal(await app.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), oldGuestId), false);
  assert.equal(JSON.parse(await readFile(driveFile)).downloads, 4);
  await app.evaluate(() => { globalThis.appsFixture.corruptDownload = true; });
  await page.locator("#refresh-preview").click(); await page.locator('#preview-area[data-preview-state="error"]').waitFor();
  assert.equal(await guestCount(), 0); assert.equal(JSON.parse(await readFile(driveFile)).downloads, 5);
  await page.locator("#close-preview").click(); await page.locator(".preview-app-archive").waitFor();
  await app.evaluate(() => { globalThis.appsFixture.corruptDownload = false; globalThis.appsFixture.previewLifetime = 1500; });
  await page.locator(".preview-app-archive").click(); await page.locator('#preview-area[data-preview-state="ready"]').waitFor();
  const expiringUrl = await guest("location.href");
  await page.locator('#preview-area[data-preview-state="expired"]').waitFor(); assert.equal(await guestCount(), 0); await assert.rejects(fetch(expiringUrl));
  await page.screenshot({ path: path.join(evidence, "desktop-app-archive-preview-expired-fixture.png"), scale: "css" });
  await app.evaluate(() => { globalThis.appsFixture.previewLifetime = null; });
  await page.locator("#refresh-preview").click(); await page.locator('#preview-area[data-preview-state="ready"]').waitFor();
  assert.equal(JSON.parse(await readFile(driveFile)).downloads, 7);
  const reloadUrl = await guest("location.href");
  await page.reload(); await page.locator("#recent-tasks button").first().waitFor(); assert.equal(await guestCount(), 0); await assert.rejects(fetch(reloadUrl));
  await page.locator("#recent-tasks button").first().click(); await page.locator('[data-tab="apps"]').click(); await page.locator(".preview-app-archive").waitFor();
  await app.evaluate(() => { globalThis.appsFixture.deferDownload = true; });
  await page.evaluate(({ id, digest }) => { window.pendingArchivePreview = window.idou.previewAppArchive(id, digest).then(() => "mounted", () => "cancelled"); }, { id, digest: savedDigest });
  for (let attempt = 0; attempt < 100 && !(await app.evaluate(() => Boolean(globalThis.appsFixture.releaseDownload))); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await app.evaluate(() => Boolean(globalThis.appsFixture.releaseDownload)), true);
  await page.locator('[data-tab="chat"]').click();
  await app.evaluate(() => { globalThis.appsFixture.deferDownload = false; globalThis.appsFixture.releaseDownload(); });
  assert.equal(await page.evaluate(() => window.pendingArchivePreview), "cancelled"); assert.equal(await guestCount(), 0);
  await page.locator('[data-tab="apps"]').click(); await page.locator(".verify-app-archive").waitFor();
  assert.equal(await readFile(path.join(workspace, "index.html"), "utf8"), source + "<p>Newer work not in archive</p>");
  await page.locator(".verify-app-archive").click(); await page.locator(".verify-app-archive:not([disabled])").waitFor();
  assert.equal(JSON.parse(await readFile(driveFile)).uploads, 1); assert.equal(ledger.snapshot(parent).chargedBytes, Buffer.byteLength(before));
  await page.locator(".withdraw-app-candidate").click(); await waitForHumanConfirm(page, "确认撤回");
  await page.locator(".app-candidate-state").filter({ hasText: "已撤回" }).waitFor();
  assert.equal(catalog.list(parent, { appId: id }).releases[0].state, "withdrawn");
  const scan = async (root) => { for (const entry of await readdir(root, { withFileTypes: true })) { const file = path.join(root, entry.name); if (entry.isDirectory()) await scan(file); else if (entry.isFile()) { const bytes = await readFile(file); for (const secret of [parent.token, ...tokens, "synthetic-server-provider-key"]) assert.equal(bytes.includes(Buffer.from(secret)), false, file); } } }; await scan(data);
  assert.equal(JSON.stringify(catalog.db.prepare("SELECT * FROM application_candidates").all()).includes("Changed during confirmation"), false);
  assert.deepEqual(errors, []);
  // Every decision here was answered in the window, not in a system alert.
  assert.equal(await app.evaluate(() => globalThis.appsFixture.dialogs.length), 0);
  assert.equal(JSON.stringify(catalog.db.prepare("SELECT * FROM application_archives").all()).includes("Changed during confirmation"), false);
  console.log(JSON.stringify({ passed: true, actualElectron: true, interactivePreview: true, inAppConfirmation: true, nativeDialogs: 0, changedDuringConfirmationDenied: true, frozenPackageArchived: true, metadataOnlyServer: true, archiveCancelZeroCharge: true, catalogAndBudgetReopened: true, clientRestartReadOnlyVerification: true, missingPackageRetrieved: true, corruptRemoteDoesNotFallbackToCache: true, archivedBytesPreviewed: true, freshDownloadOnRefresh: true, failedRefreshClosesView: true, externalFetchAndPopupAndWorkerDenied: true, unloadHandlerCannotPreventDestruction: true, previewExpires: true, latePreviewCannotMount: true, syntheticDownloads: JSON.parse(await readFile(driveFile)).downloads, withdrawn: true, submissions: posts, syntheticUploads: drive.uploads, chargedBytes: ledger.snapshot(parent).chargedBytes, deployments: 0, liveFeishuWrites: 0, paidCalls: 0, rendererErrors: errors }));
} catch (failure) {
  const page = app ? app.windows()[0] : null;
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(evidence, "desktop-apps-failure.png"), scale: "css", timeout: 3000 }).catch(() => {});
    process.stderr.write(`apps panel: ${await page.locator("#apps-panel").innerText().catch(() => "?")}\n错误：${await page.locator("#error-banner").innerText().catch(() => "?")}\n`);
  }
  throw failure;
} finally { await app?.close(); server.close(); server.closeAllConnections(); catalog.close(); ledger.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
