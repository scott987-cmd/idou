import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, readdir, rmdir, writeFile, rm } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment, gatewayRuntimeConfig } from "../src/providers/codex/gateway-config.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { EnterpriseSkillCatalog } from "../src/control-plane/skill-catalog.js";
import { skillFixture } from "./fixtures/skill-catalog.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { loginLaunchUrl } from "./fixtures/login-launch.js";
import { answerConfirm, waitForHumanConfirm } from "./fixtures/agent-harness.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { taskFolderRoot } from "../src/install-names.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-login-desktop-"));
const dataRoot = path.join(directory, "app-data"), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const state = { user: "ou_alpha", tenant: "tenant_fixture", modelCalls: 0, tokens: [] };
const sessions = new SessionRegistry(); let login, app, skills;
// Work tasks now write into the person's own ~/i豆 (or ~/我的豆包), so this run takes its
// own folders back out again rather than leaving one behind per task.
const workFolders = [];
const signingKeys = generateKeyPairSync("ed25519"), publicKeyFile = path.join(directory, "skill-public.pem");
await writeFile(publicKeyFile, signingKeys.publicKey.export({ format: "pem", type: "spki" }));
const issue = sessions.issue.bind(sessions);
sessions.issue = (value) => { const result = issue(value); state.tokens.push(result.token); return result; };
const server = createModelGateway({ sessions, apiKey: "synthetic-model-key", authHandler: async (req, res) => await login.handle(req, res) || await skills.handle(req, res),
  fetchImpl: async (_url, options) => {
    state.modelCalls++; const body = JSON.parse(options.body);
    if (body.stream) { state.skillInjected = JSON.stringify(body.input).includes("只根据用户提供的资料整理事实"); return syntheticResponseStream("LOGIN_GATEWAY_FIXTURE_OK"); }
    return Response.json({ output_text: "LOGIN_GATEWAY_FIXTURE_OK" });
  } });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
skills = new EnterpriseSkillCatalog({ origin, sessions, privateKey: signingKeys.privateKey.export({ format: "pem", type: "pkcs8" }),
  catalog: { schemaVersion: 1, revision: 1, tenants: [{ tenantId: "tenant_fixture", skills: [skillFixture()] }, { tenantId: "unrelated_tenant", skills: [{ ...skillFixture(), id: "enterprise-hidden", title: "Hidden tenant skill" }] }] } });
login = new FeishuLoginService({ origin, sessions, allowedTenants: ["tenant_fixture"],
  provider: new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_login_fixture", appSecret: "synthetic-app-secret", fetchImpl: async (url) => url.endsWith("/open-apis/authen/v2/oauth/token")
    ? Response.json({ code: 0, access_token: "synthetic-feishu-token", token_type: "Bearer", expires_in: 3600 })
    : Response.json({ code: 0, data: { tenant_key: state.tenant, open_id: state.user, name: state.user === "ou_alpha" ? "陈默（合成测试账号）" : "林溪（合成测试账号）" } }) }) });
// `page` only exists inside the run below, so it is passed in rather than closed over.
const launches = (page) => loginLaunchUrl(page, app, () => globalThis.loginFixture.launches).then(url => [url]);
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/login-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: dataRoot, IDOU_SERVER_URL: origin, IDOU_SKILL_PUBLIC_KEY_FILE: publicKeyFile }, timeout: 30000 });
  // 30s, the same as the other desktop smokes. 15 was the shortest in the
  // suite, and it was the one that failed when the whole suite ran back to back
  // -- 41 Electron launches on one machine -- while passing every time on its
  // own. A wait that only holds on an idle machine is a wait that reports load
  // as a defect.
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#settings").click(); await page.locator("#login-begin").waitFor();
  assert.equal(await page.locator("#login-begin").isEnabled(), true);
  await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
  await page.locator("#login-cancel").click(); await page.locator("#login-begin").waitFor();
  assert.equal(login.flows.size, 0); assert.equal(sessions.sessions.size, 0);
  for (const reason of ["expired", "denied"]) {
    await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
    const launchUrl = (await launches(page)).at(-1);
    if (reason === "expired") login.flows.get(new URL(launchUrl).searchParams.get("flow")).expiresAt = Date.now() - 1;
    else {
      const launched = await fetch(launchUrl, { redirect: "manual" });
      const url = new URL(launched.headers.get("location")), cookie = launched.headers.get("set-cookie").split(";")[0];
      const denied = await fetch(`${origin}/auth/feishu/callback?state=${url.searchParams.get("state")}&error=access_denied`, { headers: { cookie } });
      assert.equal(denied.status, 403);
    }
    await page.locator("#login-poll").click();
    await page.locator("#error-banner").filter({ hasText: "请重新发起登录" }).waitFor();
    await page.locator("#login-begin").waitFor(); assert.equal(await page.locator("#login-begin").isEnabled(), true);
    assert.equal(await page.locator("#login-poll").count(), 0); assert.equal(sessions.sessions.size, 0);
  }
  await page.screenshot({ path: path.join(evidence, "desktop-login-recovery-fixture.png"), scale: "css" });
  // The browser that authorizes is sent back to this machine's loopback
  // address with the secret that completes the sign-in, and the app finishes
  // it by itself from there. `elsewhere` first shows the other case, a browser
  // that never comes back here -- the link opened on someone else's machine.
  const authorize = async ({ elsewhere = false } = {}) => {
    await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
    const launchUrl = (await launches(page)).at(-1);
    const launch = await fetch(launchUrl, { redirect: "manual" }); assert.equal(launch.status, 302);
    const url = new URL(launch.headers.get("location")), cookie = launch.headers.get("set-cookie").split(";")[0];
    const callback = await fetch(`${origin}/auth/feishu/callback?state=${url.searchParams.get("state")}&code=synthetic-code`, { headers: { cookie }, redirect: "manual" });
    assert.equal(callback.status, 302);
    const back = callback.headers.get("location");
    assert.match(back, /^http:\/\/127\.0\.0\.1:\d+\/(?:idou|mydoubao)\/login-complete\?/);
    if (elsewhere) {
      // Past one of the app's own checks (every two seconds): Feishu has said
      // who authorized it, and still nothing here is signed in.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      assert.equal(login.flows.get(new URL(launchUrl).searchParams.get("flow"))?.status, "authorized");
      assert.equal((await page.evaluate(() => window.idou.authStatus())).stage, "waiting", "authorized elsewhere is not signed in here");
      assert.equal(await page.locator("#login-identity").count(), 0);
    }
    assert.equal((await fetch(back)).status, 200);
    await page.locator("#login-identity").waitFor();
  };
  await authorize({ elsewhere: true });
  assert.equal((await page.evaluate(() => window.idou.connection())).connected, false, "Awaiting confirmation must not activate token");
  const pendingStatus = await page.evaluate(() => window.idou.authStatus());
  assert.equal(pendingStatus.pendingIdentity.userId, "ou_alpha"); assert.doesNotMatch(JSON.stringify(pendingStatus), new RegExp(state.tokens.at(-1)));
  await page.screenshot({ path: path.join(evidence, "desktop-login-confirmation-fixture.png"), scale: "css" });
  await page.locator("#login-confirm").click();
  await page.locator("#account-name").filter({ hasText: "陈默" }).waitFor();
  await page.locator('[data-section="skills"]').click(); await page.locator("#refresh-enterprise-skills").click();
  await page.locator(".enterprise-skill-card").filter({ hasText: "项目进展整理" }).waitFor();
  assert.equal(await page.locator(".enterprise-skill-card").count(), 1);
  assert.doesNotMatch(await page.locator("#enterprise-skill-list").innerText(), /Hidden tenant/);
  await page.screenshot({ path: path.join(evidence, "desktop-enterprise-skills-fixture.png"), scale: "css" });
  // Opening a card verifies the entry and shows every file it ships, SKILL.md
  // rendered as a document. The <script> in the fixture must come out as text.
  await page.locator(".enterprise-skill-card").filter({ hasText: "项目进展整理" }).click(); await page.locator("#skill-detail[open]").waitFor();
  await page.locator("#skill-detail-body").filter({ hasText: "references/checklist.md" }).waitFor();
  assert.match(await page.locator("#skill-detail-body").innerText(), /<script>/);
  assert.equal(await page.locator("#skill-detail-body script").count(), 0, "skill text must never become markup");
  assert.equal(await page.evaluate(() => window.__skillExecuted), undefined);
  await page.screenshot({ path: path.join(evidence, "desktop-enterprise-skill-preview-fixture.png"), scale: "css" });
  // The use buttons live in that dialog, so it stays open for the binding flow.
  // Binding a skill to a new task is confirmed inside the application now, not
  // by a system dialog, so the card is read and answered by its own buttons.
  const idle = (mode) => page.waitForFunction((value) => !document.querySelector(`.use-enterprise-skill[data-mode="${value}"]`).disabled, mode);
  await page.locator('.use-enterprise-skill[data-mode="cowork"]').click();
  await page.locator("#confirmations .confirm-card").waitFor();
  // A stray Enter cannot confirm it. An ordinary card leaves the person's focus
  // where it was; only a destructive one moves it to 取消 (c894d6b, 2026-09-22).
  assert.equal(await page.evaluate(() => { const at = document.activeElement; return Boolean(at?.closest("#confirmations .confirm-card") && at.textContent !== "取消"); }), false, "focus must not rest on a confirming answer");
  assert.equal(await page.locator("#confirmations .confirm-card button.primary").count(), 0);
  const confirmation = await answerConfirm(page, "取消"); assert.match(confirmation, /沙箱/);
  await idle("cowork");
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.length, 0);
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async (_window, options) => { globalThis.loginFixture.workspacePicker = options; return { canceled: true, filePaths: [] }; }; });
  await page.locator('.use-enterprise-skill[data-mode="coding"]').click();
  await waitForHumanConfirm(page, "确认用于新任务");
  await idle("coding");
  assert.deepEqual((await app.evaluate(() => globalThis.loginFixture.workspacePicker)).properties, ["openDirectory"]);
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.length, 0);
  assert.equal(state.modelCalls, 0, "Cancelling either confirmation must not dispatch a model request");
  await page.locator('.use-enterprise-skill[data-mode="cowork"]').click();
  await waitForHumanConfirm(page, "确认用于新任务");
  await page.locator("#task-skill-label").filter({ hasText: "项目进展整理" }).waitFor();
  const skillTask = (await page.evaluate(() => window.idou.snapshot())).tasks[0]; workFolders.push(skillTask.cwd);
  assert.equal(skillTask.enterpriseSkill.version, "1.0.0");
  await page.locator("#prompt").fill("请按绑定技能组织一行工作说明。不要读取其他资料。"); await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText());
  assert.equal(state.skillInjected, true); assert.match(await page.locator("#messages").innerText(), /LOGIN_GATEWAY_FIXTURE_OK/);
  await page.screenshot({ path: path.join(evidence, "desktop-task-skill-fixture.png"), scale: "css" });
  // The cards already listed stay on screen while a re-check runs, so wait for
  // the re-check itself to finish (its button is disabled until then) before
  // changing the shelf underneath it.
  await page.locator('[data-section="skills"]').click(); await page.locator("#refresh-enterprise-skills").click();
  await page.locator("#refresh-enterprise-skills:not([disabled])").waitFor(); await page.locator(".enterprise-skill-card").waitFor();
  skills.catalog.tenants.set("tenant_fixture", []); skills.catalog.revision++;
  // Withdrawn after it was listed: opening it is refused, and it is never shown
  // as something that could still be used.
  await page.locator(".enterprise-skill-card").click(); await page.locator("#error-banner").filter({ hasText: "已下架" }).waitFor();
  assert.equal(await page.locator("#skill-detail").getAttribute("open"), null);
  await page.locator("#refresh-enterprise-skills").click(); await page.locator(".enterprise-skill-status").filter({ hasText: "0 项技能" }).waitFor();
  await page.locator("#recent-tasks button").first().click(); const priorRequests = state.modelCalls;
  await page.locator("#prompt").fill("撤回后不应发送"); await page.locator("#send").click(); await page.locator("#error-banner").filter({ hasText: "已下架" }).waitFor();
  assert.equal(state.modelCalls, priorRequests); assert.equal(await page.locator(".message.user").count(), 1); assert.equal(await page.locator("#prompt").inputValue(), "撤回后不应发送");
  const alpha = await page.evaluate(() => window.idou.createTask({ mode: "cowork" })); workFolders.push(alpha.cwd);
  // A work task's folder belongs to the person now -- `~/i豆 (or ~/我的豆包)/<日期>` -- and
  // is no longer a hidden directory inside the account. Still one fresh folder
  // per task; that two accounts cannot reach each other is proved below by what
  // each account can open, not by where its folder sits.
  assert.equal(path.dirname(alpha.cwd), taskFolderRoot());
  assert.deepEqual(await readdir(alpha.cwd), [], "a new work task must start in a folder of its own");
  await assert.rejects(page.evaluate((id) => window.idou.openDocument(id, "https://example.feishu.cn/docx/SyntheticDocument"), alpha.id), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate((id) => window.idou.searchDocumentRecipients(id, "unlinked", "张三"), alpha.id), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate((id) => window.idou.prepareDocumentDelivery(id, "unlinked", "untrusted", ""), alpha.id), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate((id) => window.idou.searchDocumentRecipients(id, "unlinked", "评审", "group"), alpha.id), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate((id) => window.idou.documentRecipientMembers(id, "unlinked", "untrusted"), alpha.id), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate(() => window.idou.listChats()), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate(() => window.idou.readChat("unlinked")), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate(() => window.idou.resolveChatDocument("unlinked")), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate(() => window.idou.replyChatMessage("unlinked", "不得发送", false)), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate(() => window.idou.watchKnowledgeChat("unlinked")), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate(() => window.idou.discoveryStatus()), /CLI 业务访问能力/);
  await assert.rejects(page.evaluate(() => window.idou.searchKnowledge("")), /CLI 业务访问能力/);

  // Exercise the real auth helper used by Codex, then real HTTP gateway access.
  // No token is read from renderer IPC; inspect the process-owned lease in test only.
  const leasePath = await app.evaluate(() => globalThis.loginFixture.leases.at(-1));
  assert.ok(leasePath, "Confirmed login must create a runtime-readable scoped lease");
  const runtime = await gatewayRuntimeConfig({ controlPlane: { sessionFile: leasePath, baseUrl: origin }, codex: { dataDir: path.join(directory, "runtime-check") } });
  const helper = runtime.overrides["model_providers.idou"].auth;
  const { stdout: token } = await promisify(execFile)(helper.command, helper.args);
  // The lease carries the mint-incapable turn token, not the root: a child of the
  // session that reaches the gateway (below) but cannot mint media/Drive tokens,
  // so a read of the lease cannot bypass the confirmation card.
  assert.notEqual(token, state.tokens.at(-1), "the lease must not carry the root session token");
  assert.ok(sessions.verify(token)?.parentKey, "the lease token is a child (turn) token");
  assert.throws(() => sessions.issueForMedia(token, "image"), /required/, "a read of the lease cannot mint child tokens");
  const response = await fetch(`${origin}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "MiniMax-M3", input: "synthetic" }) });
  assert.equal(response.status, 200); assert.equal((await response.json()).output_text, "LOGIN_GATEWAY_FIXTURE_OK");
  await page.locator("#settings").click(); await page.locator("#login-logout").waitFor();
  // A newly redeemed but revoked candidate must not displace the current account.
  await authorize(); const rejectedToken = state.tokens.at(-1); sessions.revoke(rejectedToken);
  await page.locator("#login-confirm").click();
  await page.locator("#error-banner").filter({ hasText: "请重新发起登录" }).waitFor();
  await page.locator("#login-begin").waitFor(); assert.equal(await page.locator("#login-confirm").count(), 0);
  const preserved = await page.evaluate(() => window.idou.authStatus());
  assert.equal(preserved.identity.userId, "ou_alpha"); assert.equal(preserved.connected, true); assert.equal(preserved.pendingIdentity, null);
  assert.ok(sessions.verify(token)); assert.equal(sessions.verify(rejectedToken), null);
  assert.ok((await page.evaluate(() => window.idou.snapshot())).tasks.some(task => task.id === alpha.id));
  await readFile(leasePath); assert.equal(state.modelCalls, priorRequests + 1, "Login recovery must not replay a task");
  await page.screenshot({ path: path.join(evidence, "desktop-login-active-fixture.png"), scale: "css" });
  await page.locator("#login-logout").click(); await page.locator("#error-banner").filter({ hasText: "已退出应用账号" }).waitFor();
  assert.equal(sessions.verify(token), null); await assert.rejects(readFile(leasePath), { code: "ENOENT" });
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.some((task) => task.id === alpha.id), false);
  await assert.rejects(page.evaluate((id) => window.idou.listFiles(id, ""), alpha.id), /找不到这个任务/);

  state.user = "ou_beta";
  await page.locator("#settings").click(); await page.locator("#login-begin").waitFor(); await authorize();
  await page.locator("#login-confirm").click(); await page.locator("#account-name").filter({ hasText: "林溪" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.length, 0);
  const beta = await page.evaluate(() => window.idou.createTask({ mode: "cowork" })); workFolders.push(beta.cwd);
  assert.notEqual(beta.cwd, alpha.cwd, "the second account must not be handed the first account's folder");
  assert.deepEqual(await readdir(beta.cwd), []);
  await assert.rejects(page.evaluate((id) => window.idou.listFiles(id, ""), alpha.id), /找不到这个任务/);
  // Switch directly back to A, proving restoration by identity, not last login.
  await app.evaluate(() => { globalThis.loginFixture.holdRuntime = true; });
  await page.evaluate((id) => window.idou.send(id, "合成测试：运行中的任务必须阻止账号切换"), beta.id);
  state.user = "ou_alpha";
  await page.locator("#settings").click(); await page.locator("#login-begin").waitFor(); await authorize();
  await page.locator("#login-confirm").click(); await page.locator("#error-banner").filter({ hasText: "请先停止任务" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.authStatus())).identity.userId, "ou_beta");
  await page.evaluate((id) => window.idou.stop(id), beta.id);
  await app.evaluate(() => { globalThis.loginFixture.holdRuntime = false; globalThis.loginFixture.releaseRuntime(); });
  await page.waitForFunction(async (id) => (await window.idou.snapshot()).tasks.find((task) => task.id === id)?.status === "interrupted", beta.id);
  await page.locator("#login-confirm").click(); await page.locator("#account-name").filter({ hasText: "陈默" }).waitFor();
  const restored = await page.evaluate(() => window.idou.snapshot()); assert.deepEqual(new Set(restored.tasks.map((task) => task.id)), new Set([alpha.id, skillTask.id]));
  assert.equal(sessions.sessions.size, 2, "the one active login: its root + model-turn pair"); assert.deepEqual(errors, []);
  await app.close(); app = null; assert.equal(sessions.sessions.size, 0);
  console.log(JSON.stringify({ passed: true, source: "real Electron and HTTP OAuth/gateway; synthetic Feishu and model upstreams; no live authorization", identityConfirmation: true, accountIsolation: true,
    restoredOwnTasks: true, runningTaskBlocksSwitch: true, unlinkedBusinessAccessRejected: true, signedTenantSkillCatalog: true, skillPreviewDoesNotExecuteHtml: true, withdrawnSkillRejected: true,
    confirmedTaskSkill: true, cancelledSkillWorkspaceCreatesNoTask: true, actualCodexSkillInjection: state.skillInjected, withdrawnSkillTurnRejected: true,
    nativeAuthHelper: true, terminalLoginRecovery: true, rejectedConfirmationPreservesAccount: true,
    revokedOnLogoutAndExit: true, fixtureModelCalls: state.modelCalls, paidModelCalls: 0, rendererErrors: errors }));
} catch (error) {
  if (app) {
    await app.evaluate(() => globalThis.loginFixture.releaseRuntime?.()).catch(() => {});
    const failedPage = await app.firstWindow();
    console.error(JSON.stringify({ url: failedPage.url(), error: await failedPage.locator("#error-banner").innerText({ timeout: 1000 }).catch(() => "unavailable"), reason: error?.stack ?? String(error) }));
    await failedPage.screenshot({ path: path.join(evidence, "desktop-login-failure.png"), timeout: 3000 }).catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  login.close(); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  // Only ever the empty folders this run made: rmdir refuses a non-empty one.
  for (const folder of workFolders) {
    if (path.dirname(folder) === taskFolderRoot()) await rmdir(folder).catch(() => {});
  }
}
