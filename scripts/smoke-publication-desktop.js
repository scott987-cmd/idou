import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { CHAT_MODELS } from "../src/providers/codex/chat-models.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { WikiCoordinator, WikiCoordinatorService } from "../src/control-plane/wiki-coordinator.js";
import { DriveBudget, DriveBudgetService } from "../src/control-plane/drive-budget.js";
import { WikiSourceRegistryService } from "../src/control-plane/wiki-source-registry.js";
import { WikiPublisherKeyService } from "../src/control-plane/wiki-key-service.js";
import { loginLaunchUrl } from "./fixtures/login-launch.js";
import { openFeishuResource } from "./fixtures/open-document.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-publication-desktop-"))), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), artifacts = new Map(), state = { user: "alpha", checks: 0, uploads: 0, downloads: 0, originals: 0, models: 0 };
const renewalMode = process.argv.includes("--renewal");
// The fixture server enforces GLM, not the default MiniMax: the desktop has to
// learn that from /healthz when the account signs in, and every synthesis
// request and consent must name it.
const CHAT_MODEL = "GLM-5.3";
if (renewalMode) { const issue = sessions.issue.bind(sessions); sessions.issue = value => issue({ ...value, ttlMs: Math.min(value.ttlMs, 180000) }); }
async function until(predicate, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("Publication renewal condition timed out"); await delay(100); }
}
let sourceText = "项目原文保留在飞书，引用按当前用户重新核验。", sourceRevision = 1;
const source = "https://test.feishu.cn/docx/SyntheticAccountDoc123";
const sourceTitle = "企业账号联通验收（合成文档）";
const policy = { authProvider: "feishu", appId: "cli_account_fixture", tenantId: "tenant_fixture", providerId: "saas-cli", driveTenantKey: "tenant_fixture", folderToken: "SyntheticFolder123", maxBytes: 1048576 };
const files = () => ({ files: [...artifacts].map(([token, item]) => ({ token, name: item.name, type: "file", parent_token: policy.folderToken, url: `https://test.feishu.cn/file/${token}` })), has_more: false });
const original = url => { state.originals++; return url.includes("/raw_content") ? { content: sourceText } : { document: { document_id: "SyntheticAccountDoc123", revision_id: sourceRevision, title: sourceTitle } }; };
const authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: policy.appId, identityChecksEnabled: true, originalOrigins: { tenant_fixture: "https://test.feishu.cn" }, bundleReadsEnabled: true,
  fetchImpl: async (url, options) => {
    assert.equal(options.method, "GET");
    if (url.endsWith("/user_info")) { state.checks++; return Response.json({ code: 0, data: { open_id: `ou_app_${state.user}`, user_id: state.user, tenant_key: policy.tenantId } }); }
    if (url.includes("/docx/v1/documents/")) return Response.json({ code: 0, data: original(url) });
    if (url.endsWith("/download")) return new Response(artifacts.get(new URL(url).pathname.split("/").at(-2)).bytes);
    if (url.includes("/drive/v1/files")) return Response.json({ code: 0, data: files() });
    return Response.json({ code: 0, data: { auth_result: true } });
  } });
const ledger = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(directory, "budget.sqlite"), policies: [policy] });
const coordinator = new WikiCoordinator({ databaseFile: path.join(directory, "coordinator.sqlite"), tenants: [{ appId: policy.appId, authProvider: "feishu", tenantId: policy.tenantId, members: ["ou_app_alpha", "ou_app_beta"] }], budget: ledger });
const budgetService = new DriveBudgetService({ sessions, ledger }), coordination = new WikiCoordinatorService({ sessions, coordinator });
const registry = new WikiSourceRegistryService({ sessions, coordinator, sourceAccess: authority });
const wrappingKeyFile = path.join(directory, "fixture-root.key"), keyConfig = path.join(directory, "keys.json");
await writeFile(wrappingKeyFile, randomBytes(32), { mode: 0o600 });
await writeFile(keyConfig, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(directory, "keys.sqlite"), wrappingKeyFile,
  tenants: [{ appId: policy.appId, tenantId: policy.tenantId, publishers: ["ou_app_alpha"], recipients: ["ou_app_beta"], processingApproved: true, automaticPublishingApproved: true, automaticReceivingApproved: true }] }), { mode: 0o600 });
const keys = await WikiPublisherKeyService.fromConfig(keyConfig, { sessions, coordinator, sourceAccess: authority });
let login, app;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.on("finish", () => { if (res.statusCode !== 200 && url.pathname.startsWith("/v1/")) console.error(JSON.stringify({ fixtureRoute: url.pathname, status: res.statusCode })); });
  const json = value => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  try {
    // Test-only artifact service replaces the CLI process's remote endpoint.
    // These routes do not exist in production or the control plane.
    if (url.pathname === "/fixture/upload") {
      assert.equal(req.method, "POST"); const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks);
      assert.ok(bytes.length < 1048576); assert.equal(bytes.includes(Buffer.from(sourceText)), false);
      assert.equal(ledger.db.prepare("SELECT COUNT(*) AS n FROM drive_reservations WHERE state='dispatched'").get().n, 1);
      state.uploads++; const token = `SyntheticBundle${state.uploads}123`; artifacts.set(token, { name: url.searchParams.get("name"), bytes }); return json({ file_token: token });
    }
    if (url.pathname === "/fixture/download") { state.downloads++; res.writeHead(200); res.end(artifacts.get(url.searchParams.get("token")).bytes); return; }
    if (url.pathname === "/fixture/files") return json(files());
    if (url.pathname.startsWith("/fixture/open-apis/docx/")) return json(original(url.pathname));
    if (url.pathname === "/healthz" && req.method === "GET") return json({ status: "ok", provider: "litellm-loopback", model: CHAT_MODEL });
    if (url.pathname === "/v1/responses") {
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "", who = sessions.verify(token);
      assert.equal(who?.audience, "codex-model-gateway"); assert.equal(req.method, "POST");
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks));
      assert.equal(body.model, CHAT_MODEL); assert.equal(body.store, false); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.max_output_tokens, CHAT_MODELS[CHAT_MODEL].sideCalls.synthesis.maxOutputTokens);
      const input = JSON.parse(body.input), quote = input.chunks[0].text.slice(0, Math.min(60, input.chunks[0].text.length)); assert.ok(quote.length >= 2);
      state.models++; return json({ object: "response", model: CHAT_MODEL, status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text",
        text: JSON.stringify({ facts: [{ text: `第 ${state.models} 次合成归纳仅用于续期测试。`, evidence: [{ chunkId: input.chunks[0].id, quote }] }] }) }] }] });
    }
    if (!await login.handle(req, res) && !await authority.handle(req, res) && !await coordination.handle(req, res) && !await budgetService.handle(req, res) && !await registry.handle(req, res) && !await keys.handle(req, res)) { res.writeHead(404); res.end(); }
  } catch { res.writeHead(500); res.end("fixture failure"); }
});
server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
login = new FeishuLoginService({ origin, sessions, allowedTenants: [policy.tenantId], provider: new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: policy.appId, appSecret: "SECRET-fixture", sourceAccess: authority, sessions, sessionRenewalEnabled: renewalMode,
  fetchImpl: async url => url.endsWith("/open-apis/authen/v2/oauth/token") ? Response.json({ code: 0, token_type: "Bearer", access_token: "SECRET-user", expires_in: 3600, scope: authority.requiredScopes.join(" ") })
    : Response.json({ code: 0, data: { tenant_key: policy.tenantId, open_id: `ou_app_${state.user}`, user_id: state.user, name: "同步验收用户" } }) }) });
try {
  let page; const errors = [];
  const launchApp = async (profile = "desktop") => {
    app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/publication-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, profile), IDOU_SERVER_URL: origin }, timeout: 30000 });
    page = await app.firstWindow(); page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate((_electron, user) => { globalThis.accountFixture.tenantUserId = user; globalThis.accountFixture.cliOpenId = `ou_cli_${user}`; }, state.user);
  };
  const authorize = async () => {
  await page.locator("#settings").click(); await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
  const launch = await fetch(await loginLaunchUrl(page, app, () => globalThis.loginFixture.launches), { redirect: "manual" }), target = new URL(launch.headers.get("location"));
  const callback = await fetch(`${origin}/auth/feishu/callback?state=${target.searchParams.get("state")}&code=SyntheticCode`, { headers: { cookie: launch.headers.get("set-cookie").split(";")[0] } });
  assert.equal(callback.status, 200); await page.locator("#login-confirm").click();
  await page.locator("#account-name").filter({ hasText: "同步验收用户" }).waitFor();
  };
  await launchApp(); await authorize();
  await page.locator("#model-label").filter({ hasText: `${CHAT_MODEL} · 企业模型网关` }).waitFor({ state: "attached" });
  const initialDevice = (await page.evaluate(() => window.idou.authStatus())).identity.deviceId;
  const renewalBefore = renewalMode ? await page.evaluate(() => window.idou.authStatus()) : null;
  if (renewalMode) {
    await page.locator('[data-section="knowledge"]').click(); await page.locator(".knowledge-advanced > summary").click(); await page.locator("#toggle-knowledge-synthesis").click();
    await page.locator("#toggle-knowledge-synthesis").filter({ hasText: "关闭并取消归纳" }).waitFor();
    assert.equal((await page.evaluate(() => window.idou.knowledgeStatus())).synthesis.remaining, 6);
    assert.equal((await page.evaluate(() => window.idou.knowledgeStatus())).synthesis.model, CHAT_MODEL);
    await app.evaluate(() => {
      const f = globalThis.publicationFixture; f.gate = Promise.withResolvers();
      f.heldWork = f.desktop.worker.cloudWork.run(async () => { f.holding = true; await f.gate.promise; });
    });
    await until(() => app.evaluate(() => globalThis.publicationFixture.holding === true), 10000);
    console.error(JSON.stringify({ fixtureStage: "cloud-slot-held", renewalInMs: renewalBefore.expiresAt - 120000 - Date.now() }));
  }
  assert.equal((await page.evaluate(() => window.idou.knowledgePublicationStatus())).enabled, true);
  await page.locator('[data-section="cowork"]').click(); await openFeishuResource(page, source);
  await page.locator("#file-title").filter({ hasText: sourceTitle }).waitFor();
  // Explicitly advance the native cadence after its observed-document queue.
  // No production IPC, publisher, HTTP or permission check is replaced.
  if (renewalMode) {
    await app.evaluate(() => {
      const f = globalThis.publicationFixture;
      f.firstPublication = (async () => { await f.desktop.wiki.queue; await f.desktop.worker.tick(); })();
    });
    await until(async () => (await page.evaluate(() => window.idou.authStatus())).renewalState === "renewing");
    assert.equal((await page.evaluate(() => window.idou.authStatus())).expiresAt, renewalBefore.expiresAt);
    console.error(JSON.stringify({ fixtureStage: "renewal-queued", uploads: state.uploads }));
    await app.evaluate(async () => { const f = globalThis.publicationFixture; f.gate.resolve(); await f.heldWork; await f.firstPublication; });
  } else await app.evaluate(async () => { const desktop = globalThis.publicationFixture.desktop; await desktop.wiki.queue; await desktop.worker.tick(); });
  const status = await page.evaluate(() => window.idou.knowledgePublicationStatus());
  assert.equal(status.counts.published, 1, JSON.stringify({ status, state, journal: await app.evaluate(async () => (await globalThis.publicationFixture.desktop.publisher.journal.load()).map(row => ({ state: row.state, hasToken: Boolean(row.fileToken) }))) })); assert.equal(state.uploads, 1); assert.ok(state.downloads > 0);
  if (renewalMode) assert.equal(state.models, 1);
  await page.locator('[data-section="knowledge"]').click(); await page.locator(".knowledge-advanced > summary").click(); await page.locator("#publication-status").filter({ hasText: "本次已发布 1 个版本" }).waitFor();
  assert.match(await page.locator("#publication-detail").textContent(), /SyntheticFolder123/);
  await page.screenshot({ path: path.join(evidence, "desktop-publication-fixture.png"), scale: "css" });
  if (renewalMode) {
    await until(async () => (await page.evaluate(() => window.idou.knowledgePublicationStatus())).expiresAt > renewalBefore.expiresAt, 20000);
    const renewed = await page.evaluate(() => window.idou.authStatus());
    assert.equal(renewed.identity.deviceId, initialDevice); assert.ok(renewed.expiresAt > renewalBefore.expiresAt);
    console.error(JSON.stringify({ fixtureStage: "renewed-after-first-publication", uploads: state.uploads }));
    assert.equal((await app.evaluate(() => globalThis.loginFixture.leases)).length, 1);
    const afterRenewalSynthesis = await page.evaluate(() => window.idou.knowledgeStatus());
    assert.equal(afterRenewalSynthesis.synthesis.enabled, true); assert.equal(afterRenewalSynthesis.synthesis.remaining, 5);
    await app.evaluate(() => globalThis.publicationFixture.desktop.worker.tick());
    assert.equal(state.uploads, 1); assert.equal((await page.evaluate(() => window.idou.knowledgePublicationStatus())).last.outcome, "unchanged");
    sourceText = "项目原文第二版：自动续期后继续核验，旧版本不会重复上传。"; sourceRevision = 2;
    const task = (await page.evaluate(() => window.idou.snapshot())).tasks[0];
    await page.evaluate(({ id, url }) => window.idou.openDocument(id, url), { id: task.id, url: source });
    await app.evaluate(async () => { const desktop = globalThis.publicationFixture.desktop; await desktop.wiki.queue; await desktop.worker.tick(); });
    const continued = await page.evaluate(() => window.idou.knowledgePublicationStatus());
    assert.equal(continued.counts.published, 2, JSON.stringify(continued)); assert.equal(continued.last.generation, 2); assert.equal(state.uploads, 2);
    const synthesis = await page.evaluate(() => window.idou.knowledgeStatus()); assert.equal(state.models, 2); assert.equal(synthesis.synthesis.remaining, 4);
    assert.match(synthesis.message, /带原文引用/);
    await page.locator('[data-section="knowledge"]').click(); await page.locator(".knowledge-advanced > summary").click(); await page.locator("#publication-status").filter({ hasText: "本次已发布 2 个版本" }).waitFor();
    await page.screenshot({ path: path.join(evidence, "desktop-publication-renewal-fixture.png"), scale: "css" });
    assert.deepEqual(errors, []); await app.close(); app = null; assert.equal(sessions.sessions.size, 0);
    console.log(JSON.stringify({ passed: true, automaticRenewalWaitedForWikiAndCloudWork: true, synthesisConsentRebound: true, synthesisBudgetPreserved: true, oneAccountActivation: true, unchangedNotReuploaded: true, publishedSecondGeneration: true, actualEncryptedBytes: true, state, liveFeishuCalls: 0, paidModelCalls: 0 }));
  } else {
  await page.locator("#publication-stop").click(); await page.locator("#publication-status").filter({ hasText: "已停止" }).waitFor();
  await app.evaluate(() => globalThis.publicationFixture.desktop.worker.tick()); assert.equal(state.uploads, 1);
  await page.locator("#publication-start").click(); await page.locator("#publication-status").filter({ hasText: "后台运行" }).waitFor();
  await page.locator("#settings").click(); await page.locator("#login-logout").click();
  await page.locator("#error-banner").filter({ hasText: "已退出应用账号" }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.publicationFixture.desktop.closed), true); assert.equal(sessions.sessions.size, 0); assert.equal(state.uploads, 1);
  await app.close(); app = null;
  // A real process restart, fresh OAuth flow and a new bearer session. Neither
  // the journal owner check nor coordinator/key authorization is replaced.
  await launchApp(); await authorize();
  assert.equal((await page.evaluate(() => window.idou.authStatus())).identity.deviceId, initialDevice);
  await app.evaluate(() => globalThis.publicationFixture.desktop.worker.tick());
  const unchanged = await page.evaluate(() => window.idou.knowledgePublicationStatus());
  assert.equal(unchanged.last.outcome, "unchanged", JSON.stringify(unchanged)); assert.equal(state.uploads, 1);
  sourceText = "项目原文第二版：同机重登后继续核验，不重复上传旧版本。"; sourceRevision = 2;
  const task = (await page.evaluate(() => window.idou.snapshot())).tasks[0];
  await page.evaluate(({ id, url }) => window.idou.openDocument(id, url), { id: task.id, url: source });
  await app.evaluate(async () => { const desktop = globalThis.publicationFixture.desktop; await desktop.wiki.queue; await desktop.worker.tick(); });
  const continued = await page.evaluate(() => window.idou.knowledgePublicationStatus());
  assert.equal(continued.last.outcome, "published", JSON.stringify(continued)); assert.equal(continued.last.generation, 2); assert.equal(state.uploads, 2);
  const head = await app.evaluate(async () => { const desktop = globalThis.publicationFixture.desktop; return (await desktop.coordinator.head(desktop.target.shardKey)).publication; });
  assert.equal(head.generation, 2);
  await page.locator('[data-section="knowledge"]').click(); await page.locator(".knowledge-advanced > summary").click(); await page.locator("#publication-status").filter({ hasText: "本次已发布 1 个版本" }).waitFor();
  await page.screenshot({ path: path.join(evidence, "desktop-publication-relogin-fixture.png"), scale: "css" });
  assert.deepEqual(errors, []); await app.close(); app = null; assert.equal(sessions.sessions.size, 0);
  // A second account in an independent desktop data directory discovers the
  // publication without receiving a hand-entered shard ID or source list.
  state.user = "beta"; await launchApp("recipient-desktop"); await authorize();
  await app.evaluate(() => globalThis.publicationFixture.reception.tick());
  const received = await page.evaluate(() => window.idou.knowledgeReceptionStatus());
  assert.equal(received.counts.received, 1, JSON.stringify(received)); assert.equal(state.uploads, 2);
  const incoming = await page.evaluate(() => window.idou.searchKnowledge("第二版")); assert.equal(incoming.hits.length, 1); assert.equal(incoming.hits[0].revision, "2");
  assert.deepEqual(await app.evaluate(async () => (await globalThis.publicationFixture.reception.wiki.publicationCandidates()).sourceIds), []);
  const downloads = state.downloads; await app.evaluate(() => globalThis.publicationFixture.reception.tick()); assert.equal(state.downloads, downloads);
  await page.locator('[data-section="knowledge"]').click(); await page.locator(".knowledge-advanced > summary").click(); await page.locator("#reception-status").filter({ hasText: "本次已取回 1 个版本" }).waitFor();
  await page.locator("#knowledge-reception").scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(evidence, "desktop-reception-fixture.png"), scale: "css" });
  await page.locator("#reception-stop").click(); await page.locator("#reception-status").filter({ hasText: "已停止" }).waitFor();
  assert.deepEqual(errors, []); await app.close(); app = null; assert.equal(sessions.sessions.size, 0);
  console.log(JSON.stringify({ passed: true, actualElectronAndHttpServices: true, actualEncryptedUploadAndDownload: true, cliBoundary: "synthetic", defaultAutomaticStart: true, stopRestartLogout: true,
    stableDeviceAfterProcessRestart: true, reauthorizedUnchangedWithoutReupload: true, nextGenerationAfterRelogin: true, secondAccountAutomaticReception: true, importedOnlyDoesNotPublish: true, state, rendererErrors: errors, liveFeishuCalls: 0, modelCalls: 0 }));
  }
} finally {
  await app?.evaluate(() => globalThis.publicationFixture.gate?.resolve()).catch(() => {});
  if (app) await app.close().catch(() => {}); login.close(); keys.close(); authority.close(); server.close(); server.closeAllConnections(); coordinator.close(); ledger.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
