// A signed-in application with a synthetic Feishu behind its embedded pages, for
// smokes about the Feishu sections themselves.
//
// The control plane is real (login service, the web-account routes) and runs on
// a loopback port; the pages' Feishu is scripts/fixtures/web-identity-desktop-entry.js,
// which answers every https request from their partition. Nothing reaches Feishu.
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../../src/providers/codex/gateway-config.js";
import { FeishuSourceAccess } from "../../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../../src/control-plane/sessions.js";
import { createModelGateway } from "../../src/control-plane/model-gateway.js";
import { loginLaunchUrl } from "./login-launch.js";
import { SAAS_FEISHU } from "../../src/providers/feishu/saas-definition.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(read, accept, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)?.slice(0, 300)}`);
}

// `route(req, res)` answers anything the script serves itself (return true when
// it did); `state.slowStatusMs` slows the web-account status route.
export async function startFeishuSection({ route = () => false, prefix = "idou-feishu-section-" } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const sessions = new SessionRegistry();
  const state = { slowStatusMs: 0 };
  const authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_webid_fixture", identityChecksEnabled: true,
    fetchImpl: async () => Response.json({ code: 0, data: { open_id: "ou_app_alpha", user_id: "alpha", tenant_key: "tenant_fixture" } }) });
  let login;
  const server = createModelGateway({ sessions, apiKey: "synthetic-model-key",
    authHandler: async (req, res) => {
      if (await route(req, res)) return true;
      if (req.url.startsWith("/auth/feishu/web-identity/status") && state.slowStatusMs) await sleep(state.slowStatusMs);
      return await login.handle(req, res) || await authority.handle(req, res);
    },
    fetchImpl: async () => { throw new Error("no model call in this smoke"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  // Long sessions on, as on the real server, so a restarted application resumes
  // its login the way it does in use.
  let refreshes = 0;
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_webid_fixture", appSecret: "SECRET-app", sourceAccess: authority, sessions,
    sessionRenewalEnabled: true, longSessionDays: 30,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/open-apis/authen/v2/oauth/token")) {
        const body = JSON.parse(options.body);
        const user = body.code?.startsWith("web-") ? body.code.slice(4) : "alpha";
        const refresh = /offline_access/.test(body.scope ?? "") || body.grant_type === "refresh_token" ? { refresh_token: `refresh-${++refreshes}` } : {};
        return Response.json({ code: 0, token_type: "Bearer", access_token: `SECRET-${user}`, expires_in: 3600, scope: authority.requiredScopes.join(" "), ...refresh });
      }
      const user = String(options.headers.authorization).replace("Bearer SECRET-", "");
      return Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: `ou_app_${user}`, user_id: user, name: `企业用户 ${user}` } });
    } });
  login = new FeishuLoginService({ origin, sessions, allowedTenants: ["tenant_fixture"], provider });

  const errors = [];
  const launch = async () => {
    const app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/web-identity-desktop-entry.js")],
      env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory, IDOU_SERVER_URL: origin }, timeout: 30_000 });
    const page = await app.firstWindow(); page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => errors.push(error.message));
    return { app, page };
  };
  const first = await launch();
  const harness = {
    app: first.app, page: first.page, origin, state, errors, directory,
    fixture: (patch) => harness.app.evaluate((_electron, value) => Object.assign(globalThis.webIdentityFixture, value), patch),
    read: (key) => harness.app.evaluate((_electron, name) => globalThis.webIdentityFixture[name], key),
    web: () => harness.page.evaluate(() => window.idou.webIdentity()),
    // Quit and start again on the same data, as a person restarting the app.
    async relaunch() {
      await harness.app.close();
      Object.assign(harness, await launch());
      await harness.page.locator("#account-name").filter({ hasText: "alpha" }).waitFor({ timeout: 30_000 });
    },
    // Every native view the person can see: its page and where it is.
    onScreen: () => harness.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win.contentView.children.filter((view) => view.webContents !== win.webContents && view.getVisible()
        && view.getBounds().width > 0 && view.getBounds().height > 0).map((view) => ({ url: view.webContents.getURL(), bounds: view.getBounds() }));
    }),
    // Signed in as alpha, with the pages signed in to Feishu too (their
    // `session` cookie), which is what makes the application check whose they are.
    async signIn() {
      const { app, page } = harness;
      await page.locator("#settings").click(); await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
      const launch = await fetch(await loginLaunchUrl(page, app, () => globalThis.loginFixture.launches), { redirect: "manual" });
      const target = new URL(launch.headers.get("location"));
      const callback = await fetch(`${origin}/auth/feishu/callback?state=${target.searchParams.get("state")}&code=SyntheticCode`, { headers: { cookie: launch.headers.get("set-cookie").split(";")[0] } });
      assert.equal(callback.status, 200);
      await page.locator("#login-confirm").click();
      await page.locator("#account-name").filter({ hasText: "alpha" }).waitFor();
      // The tenant's Feishu domain is learned from a document, as in use.
      await page.evaluate(() => window.idou.openFeishuView({ kind: "document", url: "https://fixture.feishu.cn/docx/SyntheticWebDoc12345" }));
      await page.evaluate(() => window.idou.hideFeishuView());
      await app.evaluate(async () => {
        const session = globalThis.webIdentityFixture.pageSessions.at(-1);
        // Persistent, like Feishu's own: it outlives a restart.
        await session.cookies.set({ url: "https://fixture.feishu.cn/", domain: ".feishu.cn", name: "session", value: "alpha-session", secure: true, expirationDate: Date.now() / 1000 + 30 * 86400 });
      });
      await sleep(3500);
    },
    async close() {
      await harness.app.close().catch(() => {});
      server.close(); server.closeAllConnections();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  return harness;
}
