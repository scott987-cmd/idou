// Whose Feishu the embedded pages are, and what the docked Agent may do about
// the conversation they show -- in the real Electron app, against a real
// control plane over HTTP.
//
// The pages' Feishu is synthetic (scripts/fixtures/web-identity-desktop-entry.js
// answers every https request from their partition), so the identity probe
// really navigates -- control plane launch URL, Feishu's authorize page, the
// control plane's callback -- without reaching Feishu. Everything else is the
// shipped code: the login service, the probe route, the verdict, the docked
// chat decisions, the context composed at send time, the logout.
//
//   node scripts/smoke-web-identity-desktop.js
//
// The scenarios are the plan's (R2): pages signed in as someone else than the
// application, two chats with the same name, the pages signing in again, a
// consent page that needs a person, a page event that has gone stale, and the
// pages' own sign-in going away with the account.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, rmdir } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { ScheduleService } from "../src/control-plane/schedule-service.js";
import { ScheduleStore } from "../src/control-plane/schedule-store.js";
import { ScheduleConsent } from "../src/control-plane/schedule-consent.js";
import { UnattendedCredentialStore } from "../src/control-plane/unattended-credential.js";
import { UnattendedConsent } from "../src/control-plane/unattended-consent.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { loginLaunchUrl } from "./fixtures/login-launch.js";
import { waitForHumanChoice, waitForHumanConfirm } from "./fixtures/agent-harness.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { taskFolderRoot } from "../src/install-names.js";

// The real path: the credential store refuses a directory reached through a
// symbolic link, and macOS's temporary directory is one.
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-web-identity-"))), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry();
const state = { appUser: "alpha", exchanges: [], modelInputs: [], refreshes: 0 };
let login, app, page;
// Work tasks write into the person's own ~/i豆 (or ~/我的豆包); this run takes the empty
// folders it made back out again.
const workFolders = new Set();

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, accept, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)?.slice(0, 300)}`);
}

// The server's own identity reads, for matching the CLI to the login.
const authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_webid_fixture", identityChecksEnabled: true,
  fetchImpl: async () => Response.json({ code: 0, data: { open_id: `ou_app_${state.appUser}`, user_id: state.appUser, tenant_key: "tenant_fixture" } }) });
// Feishu's consent page, for the case where Feishu wants a person: the fixture
// redirects the probe here, and the only way on is the link a person clicks.
const html = (value) => String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]);
const consentPage = (req, res) => {
  const next = new URL(req.url, origin).searchParams.get("next") ?? "";
  if (!next.startsWith(`${origin}/auth/feishu/callback?`)) { res.writeHead(400); res.end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>授权 - 飞书（合成）</title><p>合成应用请求读取你的身份</p><a id="approve" href="${html(next)}">授权</a>`);
};
const server = createModelGateway({ sessions, apiKey: "synthetic-model-key",
  authHandler: async (req, res) => {
    if (req.url.startsWith("/fixture/consent?")) { consentPage(req, res); return true; }
    return await login.handle(req, res) || await authority.handle(req, res) || await schedules.handle(req, res);
  },
  fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    state.modelInputs.push(JSON.stringify(body.input ?? ""));
    return body.stream ? syntheticResponseStream("WEB_IDENTITY_OK") : Response.json({ output_text: "WEB_IDENTITY_OK" });
  } });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
// A login's code names the application user; a probe's names whoever the pages
// are signed in as (`web-<user>`, from the fixture's authorize page).
// Long sessions on, as on the real server: a refresh token is issued whenever
// offline_access is asked for, each one distinct, so what the unattended store
// keeps can be told apart from what the login holds.
const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_webid_fixture", appSecret: "SECRET-app", sourceAccess: authority, sessions,
  sessionRenewalEnabled: true, longSessionDays: 30,
  fetchImpl: async (url, options) => {
    if (url.endsWith("/open-apis/authen/v2/oauth/token")) {
      const body = JSON.parse(options.body);
      state.exchanges.push({ code: body.code, scope: body.scope ?? "" });
      const user = body.code.startsWith("web-") ? body.code.slice(4) : state.appUser;
      const refresh = /offline_access/.test(body.scope ?? "") ? { refresh_token: `refresh-${body.code}-${++state.refreshes}` } : {};
      return Response.json({ code: 0, token_type: "Bearer", access_token: `SECRET-${user}`, expires_in: 3600, scope: authority.requiredScopes.join(" "), ...refresh });
    }
    const user = String(options.headers.authorization).replace("Bearer SECRET-", "");
    return Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: `ou_app_${user}`, user_id: user, name: `企业用户 ${user}` } });
  } });
login = new FeishuLoginService({ origin, sessions, allowedTenants: ["tenant_fixture"], provider });
// The schedule routes as the server wires them: its own dedicated authorization
// for the unattended credential, sealed into a real credential store.
await mkdir(path.join(directory, "control-plane"), { recursive: true, mode: 0o700 });
const unattendedStore = await UnattendedCredentialStore.open({ directory: path.join(directory, "control-plane", "unattended") });
const scheduleStore = new ScheduleStore({ databaseFile: path.join(directory, "control-plane", "schedules.db") });
const schedules = new ScheduleService({ sessions, store: scheduleStore, consent: new ScheduleConsent({ sessions }),
  unattended: new UnattendedConsent({ store: unattendedStore, sessions, provider, windowDays: 30, allowedTenants: ["tenant_fixture"] }),
  grants: { begin: (who, redeemed) => login.beginGrant(who, redeemed), status: (who, flowId) => login.grantStatus(who, flowId) } });
const sealedRefresh = async () => {
  const record = await unattendedStore.read("tenant_fixture", "ou_app_alpha");
  return record ? unattendedStore.unseal(record).refreshToken : null;
};

try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/web-identity-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory, IDOU_SERVER_URL: origin }, timeout: 30_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  const fixture = (patch) => app.evaluate((_electron, value) => Object.assign(globalThis.webIdentityFixture, value), patch);
  const read = (key) => app.evaluate((_electron, name) => globalThis.webIdentityFixture[name], key);
  const web = () => page.evaluate(() => window.idou.webIdentity());
  const docked = () => page.evaluate(() => window.idou.dockedChat());
  const note = () => page.locator("#feishu-dock-note").innerText();
  const setHeader = (text) => app.evaluate(async ({ webContents }, value) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.getURL().includes("/messenger")) continue;
      await contents.executeJavaScript(value === null ? "document.getElementById('header')?.remove()" : `document.getElementById('header').textContent = ${JSON.stringify(value)}`);
    }
  }, text);
  // The pages signing in again, as Electron sees it: their `session` cookie
  // changing value.
  const signInAgain = (value) => app.evaluate(async (_electron, cookie) => {
    const session = globalThis.webIdentityFixture.pageSessions.at(-1);
    await session.cookies.set({ url: "https://fixture.feishu.cn/", domain: ".feishu.cn", name: "session", value: cookie, secure: true });
  }, value);
  const lastUserText = async () => {
    const snapshot = await page.evaluate(() => window.idou.snapshot());
    for (const task of snapshot.tasks) workFolders.add(task.cwd);
    const task = snapshot.tasks.filter((entry) => entry.feishuChat).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return task?.messages.filter((message) => message.role === "user").at(-1)?.text ?? "";
  };
  const send = async (text) => {
    const before = state.modelInputs.length;
    await page.locator("#prompt").fill(text);
    await page.locator("#send").click();
    await until(async () => ({ calls: state.modelInputs.length, text: await lastUserText(),
      running: (await page.evaluate(() => window.idou.snapshot())).tasks.some((task) => ["running", "awaiting_approval"].includes(task.status)) }),
    (value) => value.calls > before && value.text.startsWith(text) && !value.running, `the turn for「${text}」`, 60_000);
    return lastUserText();
  };

  // Signed in as alpha.
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

  // Leave while a real native view's navigation is pending. The old renderer
  // had not assigned feishuView yet, so leaving did not hide anything and the
  // late main-process completion covered Settings with the abandoned document.
  await page.evaluate(() => { window.pendingSlowDocument = window.idou.openFeishuView({ kind: "document",
    url: "https://fixture.feishu.cn/docx/SyntheticSlowDoc12345" }); });
  await until(() => read("slowDocumentStarted"), Boolean, "a pending native document navigation");
  await page.locator("#settings").click();
  await app.evaluate(() => globalThis.webIdentityFixture.releaseSlowDocument());
  const abandoned = await page.evaluate(() => window.pendingSlowDocument);
  const visibleChildren = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win.contentView.children.filter(view => view.webContents !== win.webContents && view.getVisible()).length;
  });
  check("late document load cannot cover Settings after leaving", abandoned.cancelled === true && visibleChildren === 0,
    `cancelled=${abandoned.cancelled}, visible native children=${visibleChildren}`);

  console.log("网页账号与应用账号一致：");
  // The pages signed in to Feishu too -- their `session` cookie. A signed-out
  // page is waited for rather than checked (cdb352d), and this run never signed
  // them in, so it waited for good.
  await signInAgain("alpha-session");
  await sleep(3500);
  await page.locator('[data-section="feishu"]').click();
  const verified = await until(web, (value) => value.state === "verified", "a verdict for the pages");
  check("the pages are verified as the signed-in person, without anyone being asked", verified.state === "verified" && !verified.needsAttention);
  const asked = await read("authorizations");
  check("the probe asked Feishu for no offline access", asked.length === 1 && !/offline_access/.test(asked[0].scope ?? ""), asked[0]?.scope);
  check("the probe's exchange asked for none either", state.exchanges.some((entry) => entry.code === "web-alpha" && !/offline_access/.test(entry.scope)));
  const candidate = await until(docked, (value) => value.binding === "candidate", "a candidate for 项目组");
  check("a name matching one chat is a candidate, with that chat's conversation", candidate.name === "项目组" && candidate.key === "oc_projectgroup0001" && candidate.remembers === true);
  await page.locator("#feishu-dock-actions").getByText("确认是这个会话").waitFor();
  await page.screenshot({ path: path.join(evidence, "desktop-web-identity-candidate.png"), scale: "css" });
  const unconfirmed = await send("先看看这个群最近在讨论什么");
  check("before confirming, the Agent gets no chat id and is told to ask", !/oc_projectgroup0001/.test(unconfirmed) && /先请用户在侧边栏确认/.test(unconfirmed), unconfirmed.slice(-60));

  await waitForHumanChoice(page.locator("#feishu-dock-actions"), "确认是这个会话");
  await until(note, (text) => /（已确认）/.test(text), "the confirmed note");
  const confirmed = await send("总结一下");
  check("once confirmed, the Agent gets the chat id", /chat_id oc_projectgroup0001/.test(confirmed), confirmed.slice(-60));
  const accounts = path.join(directory, "accounts");
  const namespace = (await readdir(accounts)).find((name) => /^[0-9a-f]{64}$/.test(name));
  const stored = () => readFile(path.join(accounts, namespace, "feishu-chat-confirmations.json"), "utf8").then(JSON.parse);
  const confirmations = await stored();
  check("the confirmation is remembered, versioned, for that chat only", confirmations.version === 1 && Object.keys(confirmations.chats).join() === "oc_projectgroup0001");
  await page.screenshot({ path: path.join(evidence, "desktop-web-identity-confirmed.png"), scale: "css" });

  console.log("\n同名不同 ID：");
  await setHeader("周会");
  const ambiguous = await until(docked, (value) => value.name === "周会" && value.binding === "ambiguous", "an ambiguous name");
  check("two chats with the name are ambiguous, and the shared conversation is used", ambiguous.options?.length === 2 && ambiguous.key === "unbound");
  await page.locator("#feishu-dock-actions").getByText("选择是哪一个").click();
  await page.locator("#feishu-dock-select").selectOption("oc_weeklymeeting002");
  await page.locator("#feishu-dock-picker").getByText("用这个会话").click();
  const picked = await until(docked, (value) => value.binding === "bound", "the picked chat");
  check("the person's pick binds that one", picked.chat?.id === "oc_weeklymeeting002" && picked.by === "picked");
  const unchanged = await stored();
  check("and is not remembered as what the name means", Object.keys(unchanged.chats).join() === "oc_projectgroup0001");

  console.log("\n网页换成了另一个人：");
  await fixture({ webUser: "beta" });
  await signInAgain("beta-session");
  const conflict = await until(web, (value) => value.state === "conflict", "a conflict verdict", 30_000);
  check("the pages signing in as someone else is a conflict", conflict.state === "conflict");
  check("the exchange was for the other person, and nothing about them came back", state.exchanges.some((entry) => entry.code === "web-beta") && !JSON.stringify(conflict).includes("beta"));
  await setHeader("项目组");
  const refused = await until(docked, (value) => value.name === "项目组" && value.reason === "web_conflict", "the conflict decision");
  check("a remembered confirmation does not apply to someone else's pages", refused.binding === "unbound" && refused.key === "unbound");
  await page.locator("#feishu-dock-web").filter({ hasText: "不是你当前登录的账号" }).waitFor();
  await until(note, (text) => /网页账号不一致/.test(text), "the conflict note");
  await page.screenshot({ path: path.join(evidence, "desktop-web-identity-conflict.png"), scale: "css" });
  const guarded = await send("这个群里谁负责");
  check("the Agent is told the pages belong to someone else, with no chat id", /不是当前账号/.test(guarded) && !/oc_projectgroup0001/.test(guarded), guarded.slice(-60));

  console.log("\n需要人确认的授权页：");
  await fixture({ webUser: "alpha", consent: true });
  await signInAgain("alpha-session-2");
  await until(web, (value) => value.needsAttention === true, "a consent page shown to the person", 30_000);
  await page.locator("#feishu-dock-web").filter({ hasText: "左侧是飞书的授权页" }).waitFor();
  const consentAt = `${origin}/fixture/consent`;
  const shown = await app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(prefix)), consentAt);
  check("the consent page is on screen for the person, and nothing clicks it for them", shown);
  await page.screenshot({ path: path.join(evidence, "desktop-web-identity-consent.png"), scale: "css" });
  await app.evaluate(async ({ webContents }, prefix) => {
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getURL().startsWith(prefix)) await contents.executeJavaScript("document.getElementById('approve').click()");
    }
  }, consentAt);
  await until(web, (value) => value.state === "verified", "the verdict after consent", 30_000);
  const back = await until(docked, (value) => value.binding === "bound", "the remembered confirmation again");
  check("verified again, the remembered confirmation applies again", back.chat?.id === "oc_projectgroup0001" && back.by === "confirmed");
  const gone = await app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(prefix)), consentAt);
  check("and the consent page is gone", !gone);

  console.log("\n失效的页面事件：");
  await setHeader(null);
  const stale = await until(docked, (value) => value.binding === "none", "the name to expire", 30_000);
  check("a name the page stopped reporting is no longer used", stale.name === "" && stale.key === "unbound");
  await until(note, (text) => /在左侧打开一个会话/.test(text), "the empty note");

  console.log("\n无人值守运行的专用授权：");
  await fixture({ webUser: "alpha", consent: false });
  await page.locator('[data-section="schedules"]').click();
  const allow = page.locator(".schedule-banner button", { hasText: "允许无人值守运行" });
  await allow.click();
  const card = await waitForHumanConfirm(page, "允许");
  check("the person confirms first, and is told revoking here does not revoke in Feishu", /撤销不会取消你在飞书里对本应用的授权/.test(card));
  await page.locator(".schedule-banner").filter({ hasText: "无人值守运行已开启" }).waitFor({ timeout: 30_000 });
  const silent = await sealedRefresh();
  const loginRefresh = state.exchanges.find((entry) => entry.code === "SyntheticCode");
  check("its credential is the dedicated authorization's own refresh token", /^refresh-web-alpha-\d+$/.test(silent ?? ""), silent);
  check("the dedicated authorization asked for offline access, the probes never did",
    state.exchanges.filter((entry) => /offline_access/.test(entry.scope)).length === 2 && /offline_access/.test(loginRefresh?.scope ?? ""));

  await page.locator(".schedule-banner button", { hasText: "撤销" }).click();
  await waitForHumanConfirm(page, "撤销");
  await allow.waitFor();
  check("revoking deletes it", (await sealedRefresh()) === null);

  // Someone else signed in to the pages: the authorization is theirs, and is not kept.
  await fixture({ webUser: "beta" });
  await allow.click();
  await waitForHumanConfirm(page, "允许");
  await page.locator("#error-banner").filter({ hasText: "不是当前应用登录的账号" }).waitFor({ timeout: 30_000 });
  check("an authorization by another person is refused and nothing is kept", (await sealedRefresh()) === null);

  // Feishu wants a person: the same link goes to the system browser.
  await fixture({ webUser: "alpha", consent: true });
  const launchesBefore = (await app.evaluate(() => globalThis.loginFixture.launches.length));
  await allow.click();
  await waitForHumanConfirm(page, "允许");
  await page.locator(".schedule-note").filter({ hasText: "已在浏览器里打开授权页" }).waitFor({ timeout: 30_000 });
  const handed = (await app.evaluate(() => globalThis.loginFixture.launches)).slice(launchesBefore);
  check("the link is handed to the system browser, once", handed.length === 1 && /\/auth\/feishu\/launch\?flow=/.test(handed[0]));
  const lingering = await app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(prefix)), consentAt);
  check("and the hidden attempt is closed", !lingering);
  // The person finishes it in their browser.
  const browser = await fetch(handed[0], { redirect: "manual" });
  const authorize = new URL(browser.headers.get("location"));
  const finished = await fetch(`${origin}/auth/feishu/callback?state=${authorize.searchParams.get("state")}&code=browser-alpha`, { headers: { cookie: browser.headers.get("set-cookie").split(";")[0] } });
  check("the browser's callback is accepted", finished.status === 200);
  await page.locator(".schedule-banner").filter({ hasText: "无人值守运行已开启" }).waitFor({ timeout: 30_000 });
  check("and its own refresh token is what is kept", /^refresh-browser-alpha-\d+$/.test((await sealedRefresh()) ?? ""));
  await page.screenshot({ path: path.join(evidence, "desktop-unattended-dedicated.png"), scale: "css" });

  console.log("\n退出账号：");
  const before = await app.evaluate(async () => (await globalThis.webIdentityFixture.pageSessions.at(-1).cookies.get({})).length);
  await page.locator("#settings").click(); await page.locator("#login-logout").click();
  await page.locator("#error-banner").filter({ hasText: "已退出应用账号" }).waitFor();
  const after = await app.evaluate(async () => (await globalThis.webIdentityFixture.pageSessions.at(-1).cookies.get({})).length);
  check("the pages' own Feishu sign-in went with the account", before > 0 && after === 0, `${before} → ${after} cookies`);

  check("no renderer errors", errors.length === 0, errors.join(" | "));
  check("the chat list was read, never the real Feishu", (await read("chatLists")) > 0);
} catch (error) {
  failures += 1;
  console.log(`  FAIL  ${error.stack ?? error}`);
  // What was on screen and where each probe had got to, for whoever reads this.
  const pages = await app?.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.getURL())).catch(() => []);
  console.log(`  pages: ${JSON.stringify(pages)}`);
  console.log(`  flows: ${JSON.stringify([...login.flows.values()].map((flow) => ({ kind: flow.kind, status: flow.status })))}`);
  console.log(`  exchanges: ${JSON.stringify(state.exchanges.map((entry) => entry.code))}`);
  const probePage = await app?.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find((entry) => /accounts\.feishu\.cn|fixture\/consent/.test(entry.getURL()));
    if (!contents) return null;
    return { html: await contents.executeJavaScript("document.documentElement.outerHTML").catch((error) => `error ${error.message}`),
      loading: contents.isLoading(), crashed: contents.isCrashed() };
  }).catch((error) => `error ${error.message}`);
  console.log(`  probe page: ${JSON.stringify(probePage)?.slice(0, 800)}`);
  const trace = await app?.evaluate(() => globalThis.webIdentityFixture.trace).catch(() => []);
  for (const line of trace ?? []) console.log(`  trace: ${line}`);
  // The docked chat says only that its list could not be read (list_unavailable);
  // the reader says why. On 2026-09-24 that was a release not re-signed after a
  // source change, and nothing else in this output could have said so.
  const chatList = await page?.evaluate(() => window.idou.listChats().then((value) => `${value.chats.length} chats`, (error) => error.message)).catch((error) => `error ${error.message}`);
  console.log(`  chat list: ${chatList}`);
} finally {
  if (app) await app.close().catch(() => {});
  login.close(); scheduleStore.close(); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  // Only ever the empty folders this run made: rmdir refuses a non-empty one.
  for (const folder of workFolders) {
    if (path.dirname(folder) === taskFolderRoot()) await rmdir(folder).catch(() => {});
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
