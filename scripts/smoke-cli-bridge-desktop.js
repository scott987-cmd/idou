import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { FeishuCliProxyService } from "../src/control-plane/feishu-cli-proxy.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { loginLaunchUrl } from "./fixtures/login-launch.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-cli-bridge-desktop-")), dataRoot = path.join(directory, "app-data"), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), upstream = [];
const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_bridge_desktop", cliProxyScopes: ["fixture:read"] });
const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_bridge_desktop", appSecret: "synthetic-app-secret", sessions, sourceAccess, fetchImpl: async url => url.endsWith("/open-apis/authen/v2/oauth/token")
  ? Response.json({ code: 0, access_token: "synthetic-server-only-uat", token_type: "Bearer", expires_in: 900, scope: sourceAccess.requiredScopes.join(" ") })
  : Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_bridge", name: "桥接测试用户" } }) });
let login, app;
const proxy = new FeishuCliProxyService({ sourceAccess, fetchImpl: async (url, options) => {
  upstream.push({ url, method: options.method, authorization: options.headers.authorization });
  if (url.includes("/open-apis/docs_ai/v1/documents/SyntheticDesktopBridge/fetch")) return Response.json({ code: 0, data: { document: { document_id: "SyntheticDesktopBridge", revision_id: 8, content: "<title>桌面安全桥接验收</title><p>合成只读内容</p>" } } });
  return Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_bridge", user_id: "bridge-user", name: "桥接测试用户" } });
} });
const server = createModelGateway({ sessions, apiKey: "synthetic-model-key", authHandler: async (req, res) => await login.handle(req, res) || await proxy.handle(req, res), fetchImpl: () => assert.fail("no model request expected") });
server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
login = new FeishuLoginService({ origin, provider, sessions, allowedTenants: ["tenant_fixture"] });
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/login-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: dataRoot, IDOU_SERVER_URL: origin }, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000); const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.locator("#settings").click(); await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
  const launchUrl = await loginLaunchUrl(page, app, () => globalThis.loginFixture.launches);
  const launch = await fetch(launchUrl, { redirect: "manual" });
  const authorize = new URL(launch.headers.get("location")), cookie = launch.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${origin}/auth/feishu/callback?state=${authorize.searchParams.get("state")}&code=synthetic`, { headers: { cookie } })).status, 200);
  await page.locator("#login-identity").waitFor();
  assert.equal((await page.evaluate(() => window.idou.authStatus())).pendingIdentity.cliBridge, true);
  await page.locator("#login-confirm").click(); await page.locator("#account-name").filter({ hasText: "桥接测试用户" }).waitFor();
  await page.locator("#settings").click(); await page.locator(".login-boundary").filter({ hasText: "目前只读，不会改动你的飞书内容。" }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /synthetic-server-only-uat|synthetic-app-secret|synthetic-model-key/);
  // Signed in against a server with no MCP broker -- the route does not exist,
  // as on a deployment without IDOU_MCP_CONFIG_FILE: 技能中心 → 连接器 lists
  // no enterprise connectors and warns about nothing.
  assert.deepEqual(await page.evaluate(() => window.idou.listEnterpriseMcp()), []);
  await page.locator('[data-section="skills"]').click(); await page.locator('.sc-tab[data-tab="connectors"]').click();
  await page.locator('.sc-connectors[data-enterprise="ready"]').waitFor();
  assert.doesNotMatch(await page.locator(".sc-connectors").innerText(), /企业连接器/);
  await page.locator("#settings").click(); await page.locator("#check-document-connection").waitFor();
  const connection = await page.evaluate(() => window.idou.documentConnection()); assert.equal(connection.connected, true, connection.message);
  const task = await page.evaluate(() => window.idou.createTask({ mode: "cowork" }));
  const document = await page.evaluate(({ id, url }) => window.idou.openDocument(id, url), { id: task.id, url: "https://fixture.feishu.cn/docx/SyntheticDesktopBridge" });
  assert.equal(document.title, "桌面安全桥接验收"); assert.equal(document.sourceRevision, "8");
  await page.screenshot({ path: path.join(evidence, "desktop-cli-bridge-fixture.png"), scale: "css" });
  assert.ok(upstream.some(call => call.method === "POST" && call.url.includes("/SyntheticDesktopBridge/fetch")));
  assert.ok(upstream.every(call => call.authorization === "Bearer synthetic-server-only-uat")); assert.deepEqual(errors, []);
  await app.close(); app = null;
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualPinnedCli: true, syntheticOAuthAndFeishu: true, singleLoginRead: true, serverOnlyToken: true, liveCalls: 0, modelCalls: 0, rendererErrors: errors }));
} finally {
  if (app) await app.close().catch(() => {}); proxy.close(); login?.close(); server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
