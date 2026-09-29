import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { loginLaunchUrl } from "./fixtures/login-launch.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-renewal-desktop-"));
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error("Desktop renewal condition timed out"); await delay(50); }
}
const sessions = new SessionRegistry(), originalIssue = sessions.issue.bind(sessions);
// Test-only shortened initial lifetime. Renewal itself, timers, file replacement,
// HTTP, signature verification and the real helper executable are unmodified.
sessions.issue = value => originalIssue({ ...value, ttlMs: Math.min(value.ttlMs, 130000) });
let login, app, identityReads = 0;
const server = createServer((req, res) => void login.handle(req, res));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
login = new FeishuLoginService({ origin, sessions, allowedTenants: ["tenant_fixture"],
  provider: new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_renewal_fixture", appSecret: "synthetic-secret", sessions, sessionRenewalEnabled: true,
    fetchImpl: async url => {
      if (url.endsWith("/open-apis/authen/v2/oauth/token")) return Response.json({ code: 0, access_token: "synthetic-feishu-secret", token_type: "Bearer", expires_in: 3600 });
      identityReads++; return Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_fixture", name: "在线续期（隔离测试）" } });
    } }) });
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/login-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "app-data"), IDOU_SERVER_URL: origin }, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.locator("#settings").click(); await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
  const launchUrl = await loginLaunchUrl(page, app, () => globalThis.loginFixture.launches);
  const launch = await fetch(launchUrl, { redirect: "manual" }), target = new URL(launch.headers.get("location"));
  assert.equal(target.searchParams.has("scope"), false);
  const callback = await fetch(`${origin}/auth/feishu/callback?state=${target.searchParams.get("state")}&code=synthetic`, { headers: { cookie: launch.headers.get("set-cookie").split(";")[0] } });
  assert.equal(callback.status, 200);
  await page.locator("#login-confirm").click();
  await page.locator("#account-name").filter({ hasText: "在线续期" }).waitFor();
  const filename = await app.evaluate(() => globalThis.loginFixture.leases.at(-1));
  const before = JSON.parse(await readFile(filename, "utf8"));
  const task = await page.evaluate(() => window.idou.createTask({ mode: "cowork" }));
  // A held task blocks scope switching but must not block credential rotation.
  await app.evaluate(() => { globalThis.loginFixture.holdRuntime = true; });
  await page.evaluate(id => window.idou.send(id, "Synthetic held task; no model or document access"), task.id);
  await until(async () => (await page.evaluate(() => window.idou.snapshot())).tasks.find(value => value.id === task.id)?.status === "running");
  // Explicit expiry comparison only; no token enters renderer state.
  await until(async () => (await page.evaluate(() => window.idou.authStatus())).expiresAt > before.expiresAt);
  const after = JSON.parse(await readFile(filename, "utf8"));
  assert.ok(after.token !== before.token, "Credential must rotate"); assert.equal(identityReads, 2);
  assert.equal((await app.evaluate(() => globalThis.loginFixture.leases)).length, 1, "Renewal must not activate a second scope");
  const helper = await promisify(execFile)(process.execPath, [path.resolve("bin/agent-token.js"), filename, origin], { env: clientEnvironment() });
  assert.ok(helper.stdout === after.token, "Real native auth helper reads rotated credential at the same path");
  const snapshot = await page.evaluate(() => window.idou.snapshot());
  assert.equal(snapshot.tasks.find(value => value.id === task.id).cwd, task.cwd);
  assert.equal(snapshot.tasks.find(value => value.id === task.id).status, "running");
  await app.evaluate(() => { globalThis.loginFixture.releaseRuntime?.(); });
  await until(async () => (await page.evaluate(() => window.idou.snapshot())).tasks.find(value => value.id === task.id)?.status === "failed");
  await page.locator("#settings").click(); await page.locator("#login-renewal").filter({ hasText: "已启用在线续期" }).waitFor();
  const status = await page.evaluate(() => window.idou.authStatus());
  assert.equal(status.connected, true); assert.doesNotMatch(JSON.stringify(status), new RegExp(`${before.token}|${after.token}|synthetic-feishu-secret`));
  assert.doesNotMatch(await page.content(), new RegExp(`${before.token}|${after.token}|synthetic-feishu-secret`));
  await mkdir(path.resolve("docs/evidence"), { recursive: true });
  await page.screenshot({ path: path.resolve("docs/evidence/desktop-online-renewal-fixture.png"), scale: "css" });
  await page.locator("#login-logout").click();
  // A sign-out that does not land says why on the page; read it rather than
  // guess from a timeout (it failed only inside the full acceptance run).
  try { await page.locator("#account-name").filter({ hasText: "未登录" }).waitFor(); }
  catch (error) {
    const status = await page.evaluate(() => window.idou.authStatus()).catch((cause) => ({ unreadable: String(cause) }));
    console.error(JSON.stringify({ stage: "logout", banner: await page.locator("#error-banner").textContent().catch(() => null),
      account: await page.locator("#account-name").textContent().catch(() => null), renewalState: status.renewalState, connected: status.connected, renewalFailure: status.renewalFailure }));
    throw error;
  }
  assert.equal(sessions.verify(before.token), null); assert.equal(sessions.verify(after.token), null);
  await assert.rejects(readFile(filename), { code: "ENOENT" }); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, automaticRenewal: true, identityReads, taskPreserved: true, helperReadNewToken: true, logoutRevokedFamily: true, realFeishuCalls: 0, modelCalls: 0 }));
} finally { await app?.evaluate(() => globalThis.loginFixture.releaseRuntime?.()).catch(() => {}); await app?.close(); login.close(); server.close(); server.closeAllConnections(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
