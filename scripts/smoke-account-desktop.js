import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { loginLaunchUrl } from "./fixtures/login-launch.js";
import { openFeishuResource } from "./fixtures/open-document.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-account-desktop-")), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), state = { user: "alpha", checks: 0 }; let login, app;
const authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_account_fixture", identityChecksEnabled: true, fetchImpl: async (_url, options) => {
  assert.equal(options.method, "GET"); state.checks++;
  return Response.json({ code: 0, data: { open_id: `ou_app_${state.user}`, user_id: state.user, tenant_key: "tenant_fixture" } });
} });
const server = createServer(async (req, res) => { if (!await login.handle(req, res) && !await authority.handle(req, res)) { res.writeHead(404); res.end(); } });
server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
login = new FeishuLoginService({ origin, sessions, allowedTenants: ["tenant_fixture"], provider: new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_account_fixture", appSecret: "SECRET-fixture", sourceAccess: authority,
  fetchImpl: async url => url.endsWith("/open-apis/authen/v2/oauth/token") ? Response.json({ code: 0, token_type: "Bearer", access_token: "SECRET-user", expires_in: 3600, scope: authority.requiredScopes.join(" ") })
    : Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: `ou_app_${state.user}`, user_id: state.user, name: `企业用户 ${state.user}` } }) }) });
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/account-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory, IDOU_SERVER_URL: origin }, timeout: 30000 });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20000); page.on("pageerror", error => errors.push(error.message));
  const authorize = async () => {
    await page.locator("#settings").click(); await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
    const launch = await fetch(await loginLaunchUrl(page, app, () => globalThis.loginFixture.launches), { redirect: "manual" }), target = new URL(launch.headers.get("location"));
    const callback = await fetch(`${origin}/auth/feishu/callback?state=${target.searchParams.get("state")}&code=SyntheticCode`, { headers: { cookie: launch.headers.get("set-cookie").split(";")[0] } });
    assert.equal(callback.status, 200); await page.locator("#login-confirm").click();
    await page.locator("#account-name").filter({ hasText: state.user }).waitFor();
  };
  await authorize();
  await page.locator('[data-section="cowork"]').click();
  const reference = "https://test.feishu.cn/docx/SyntheticAccountDoc123";
  await openFeishuResource(page, reference);
  await page.locator("#file-title").filter({ hasText: "企业账号联通验收" }).waitFor();
  assert.match(await page.locator("#file-content").inputValue(), /项目原文/);
  const alpha = (await page.evaluate(() => window.idou.snapshot())).tasks[0];
  await page.locator('[data-section="knowledge"]').click(); await page.locator("#knowledge-query").fill("项目"); await page.locator("#search-knowledge").click();
  await page.locator(".knowledge-card").waitFor(); assert.equal(await page.locator(".knowledge-card").count(), 1);
  await page.screenshot({ path: path.join(evidence, "desktop-account-wiki-fixture.png"), scale: "css" });
  const before = await app.evaluate(() => globalThis.accountFixture.reads);
  await app.evaluate(() => { globalThis.accountFixture.tenantUserId = "someone-else"; });
  await assert.rejects(page.evaluate(({ id, reference }) => window.idou.openDocument(id, reference), { id: alpha.id, reference }), /匹配/);
  await assert.rejects(page.evaluate(() => window.idou.searchKnowledge("项目")), /匹配/);
  assert.equal(await app.evaluate(() => globalThis.accountFixture.reads), before);
  await app.evaluate(() => { globalThis.accountFixture.tenantUserId = "alpha"; globalThis.accountFixture.denied = true; });
  await assert.rejects(page.evaluate(({ id, reference }) => window.idou.openDocument(id, reference), { id: alpha.id, reference }), /没有这项权限/);
  await page.locator("#settings").click(); await page.locator("#login-logout").click();
  await page.locator("#error-banner").filter({ hasText: "已退出应用账号" }).waitFor(); assert.equal(sessions.sessions.size, 0);
  state.user = "beta"; await authorize();
  const beta = await page.evaluate(() => window.idou.createTask({ mode: "cowork" }));
  await assert.rejects(page.evaluate(({ id, reference }) => window.idou.openDocument(id, reference), { id: beta.id, reference }), /匹配/);
  await assert.rejects(page.evaluate((id) => window.idou.listFiles(id, ""), alpha.id), /找不到这个任务/);
  await app.evaluate(() => { Object.assign(globalThis.accountFixture, { tenantUserId: "beta", cliOpenId: "ou_cli_beta", denied: false }); });
  const opened = await page.evaluate(({ id, reference }) => window.idou.openDocument(id, reference), { id: beta.id, reference }); assert.equal(opened.title, "企业账号联通验收（合成文档）");
  assert.doesNotMatch(JSON.stringify(await page.evaluate(() => window.idou.authStatus())), /SECRET|access_token/);
  assert.deepEqual(errors, []); await app.close(); app = null; assert.equal(sessions.sessions.size, 0);
  console.log(JSON.stringify({ passed: true, realElectronAndOAuthHttp: true, crossAppOpenIdsMatched: true, documentToWiki: true, accountMismatchStopsDocumentCommands: true, sourcePermissionStillRequired: true,
    logoutAndSecondAccountIsolation: true, serverIdentityReads: state.checks, liveFeishuCalls: 0, modelCalls: 0, feishuWrites: 0, rendererErrors: errors }));
} finally {
  if (app) await app.close().catch(() => {}); login.close(); server.close(); server.closeAllConnections(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
