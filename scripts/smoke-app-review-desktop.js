// Reviewing an application version manifest, driven through the current UI.
//
// The native alert this used to answer is gone: every confirmation is drawn in
// the app now, as a card with the buttons the main process offered. What has to
// hold is unchanged -- the author and the reviewer never see each other's
// tasks, cancelling posts no decision, the disclosure names the exact version
// and says what the review is not, a decision cannot be overwritten, a new
// version is not approved by the old one, and a version withdrawn while the
// confirmation is outstanding is refused rather than reviewed.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { AppCatalog, AppCatalogService } from "../src/control-plane/app-catalog.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { answerConfirm, waitForHumanConfirm } from "./fixtures/agent-harness.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-review-desktop-"))), workspace = path.join(root, "workspace"), evidence = path.resolve("docs/evidence");
await mkdir(workspace); await mkdir(evidence, { recursive: true });
const source = "<!doctype html><h1>季度经营看板（合成测试）</h1>"; await writeFile(path.join(workspace, "index.html"), source);
const sessions = new SessionRegistry(), issue = userId => sessions.issue({ authProvider: "feishu", appId: "cli_fixture", tenantId: "tenant_fixture", userId, deviceId: "fixture", deviceProof: "ed25519-login" });
const author = issue("alice"), reviewer = issue("reviewer");
const catalog = new AppCatalog({ feishu: SAAS_FEISHU, databaseFile: path.join(root, "catalog.sqlite"), tenants: [{ authProvider: "feishu", appId: "cli_fixture", tenantId: "tenant_fixture", publishers: ["alice"], reviewers: ["reviewer"] }] });
const service = new AppCatalogService({ catalog, sessions }); let decisions = 0;
const server = createModelGateway({ sessions, apiKey: "synthetic-server-only", authHandler: async (req, res) => { if (req.url === "/v1/apps/review") decisions++; return service.handle(req, res); }, fetchImpl: () => assert.fail("No model call") });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const serverUrl = `http://127.0.0.1:${server.address().port}`, errors = []; let app, page;
const launch = async (name, session) => {
  const sessionFile = path.join(root, `${name}.json`); await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl }), { mode: 0o600 });
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/app-review-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: path.join(root, name), APP_REVIEW_FIXTURE_WORKSPACE: workspace } });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
};
const close = async () => { await app.close(); app = null; };
const card = () => page.locator("#confirmations .confirm-card");
// The alert used to say this with defaultId/cancelId. The card says it by
// putting the answer that does nothing first and leaving it holding focus.
const cancelInHand = async () => {
  const first = card().locator(".confirm-actions button").first();
  assert.equal((await first.innerText()).trim(), "取消");
  assert.equal(await first.evaluate(node => node === document.activeElement), true);
};
// The apps panel belongs to a task, and a task is made the way a person makes
// one: choose the section, choose the directory, open the task's own files.
// #welcome-open-* and an IPC-created task are both gone -- the second never
// reached the renderer, and an unnamed task is not in the sidebar to click.
const openCodingTask = async () => {
  await page.locator('[data-section="coding"]').click();
  await page.locator("#pick-workspace").click();
  await page.locator("#open-files").click();
  await page.locator('[data-tab="apps"]').click();
  return (await page.evaluate(() => window.idou.snapshot())).tasks[0].id;
};
// A task nobody has spoken to is only in the sidebar while it is already on
// screen, so a restart cannot reopen it. Writing the message a person would
// have typed is what puts it back in the list; no model is involved.
const usedInConversation = async (name, id) => {
  const file = path.join(root, name, "tasks", `${id}.json`), task = JSON.parse(await readFile(file, "utf8"));
  if (task.messages.some(message => message.role === "user")) return;
  task.messages.push({ id: randomUUID(), role: "user", text: "把季度经营看板整理成可以提交的静态版本。", createdAt: Date.now() });
  await writeFile(file, JSON.stringify(task), { mode: 0o600 });
};
const reopenCodingTask = async () => {
  await page.locator('[data-section="coding"]').click();
  await page.locator("#recent-tasks button").first().click();
  await page.locator('[data-tab="apps"]').click();
};
const reviewPage = async digest => {
  await page.locator('[data-section="coding"]').click(); await page.locator("#welcome-app-reviews").click();
  await page.locator(".app-review-choice").filter({ hasText: digest.slice(0, 16) }).click();
  await page.locator("#app-review-note").waitFor();
};
try {
  await launch("author", author);
  const id = await openCodingTask();
  await page.locator("#app-entry").fill("index.html");
  await page.locator("#submit-app-candidate").click();
  const submitCard = await waitForHumanConfirm(page, "保存并提交清单");
  assert.match(submitCard, /不上传源码/); assert.match(submitCard, /不部署/);
  await page.locator(".app-candidate").waitFor();
  const first = catalog.list(author, { appId: id }).releases[0]; assert.equal(first.review, null);
  await usedInConversation("author", id);
  await close(); await launch("reviewer", reviewer); await reviewPage(first.digest);
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.length, 0);
  assert.match(await page.locator(".app-review-files").textContent(), /index.html/);
  await page.locator("#app-review-note").fill("清单结构符合要求；发布前仍需源码与隔离运行验证。");
  await page.locator("#app-review-approved").click();
  // The confirmation is raised from inside the modal review dialog; it has to
  // be reachable there, not stranded behind it.
  await card().waitFor(); await cancelInHand();
  await page.screenshot({ path: path.join(evidence, "desktop-app-review-fixture.png"), scale: "css" });
  await answerConfirm(page, "取消");
  await page.locator("#app-review-notice").filter({ hasText: "已取消" }).waitFor();
  assert.equal(decisions, 0); assert.equal(catalog.list(author, { appId: id }).releases[0].review, null);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 680));
  await page.locator("#app-review-note").scrollIntoViewIfNeeded();
  const layout = await page.evaluate(() => {
    const note = document.querySelector("#app-review-note").getBoundingClientRect(), footer = document.querySelector("#app-review-footer").getBoundingClientRect();
    return { noteBottom: note.bottom, footerTop: footer.top };
  }); assert.ok(layout.noteBottom <= layout.footerTop, "Sticky actions must not cover the review explanation");
  await page.screenshot({ path: path.join(evidence, "desktop-app-review-narrow-fixture.png"), scale: "css" });
  await page.locator("#app-review-approved").click();
  await card().waitFor(); await cancelInHand();
  const confirmation = await waitForHumanConfirm(page, "确认提交清单结论");
  assert.match(confirmation, new RegExp(first.digest)); assert.match(confirmation, /未读取源码/); assert.match(confirmation, /不部署/);
  await page.locator("#app-review-notice").filter({ hasText: "已有不可覆盖的审核结论" }).waitFor();
  assert.equal(decisions, 1); assert.equal(await page.locator("#app-review-approved").count(), 0);
  await page.locator("#refresh-app-reviews").click(); await page.locator("#app-review-notice").filter({ hasText: "没有待审" }).waitFor();
  await close(); await launch("author", author);
  await reopenCodingTask();
  await page.locator(".app-candidate-state").filter({ hasText: "清单通过 · 未部署" }).waitFor();
  assert.match(await page.locator(".app-review-result").textContent(), /发布前仍需/);
  await page.locator(".app-review-result").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(evidence, "desktop-app-review-author-fixture.png"), scale: "css" });
  await writeFile(path.join(workspace, "index.html"), source + "<p>第二版</p>"); await page.locator("#app-entry").fill("index.html");
  await page.locator("#submit-app-candidate").click(); await waitForHumanConfirm(page, "保存并提交清单");
  await page.waitForFunction(() => document.querySelectorAll(".app-candidate").length === 2);
  const second = catalog.list(author, { appId: id }).releases.find(row => row.digest !== first.digest); assert.equal(second.review, null);
  await close(); await launch("reviewer", reviewer); await reviewPage(second.digest);
  await page.locator("#app-review-note").fill("确认期间撤回应阻止提交");
  await page.locator("#app-review-approved").click();
  // Observe the confirmation actually outstanding, not a status left over from
  // the earlier attempt: nothing has been posted while this card is up.
  await card().waitFor();
  catalog.withdraw(author, { appId: id, digest: second.digest });
  await waitForHumanConfirm(page, "确认提交清单结论");
  await page.locator("#app-review-notice").filter({ hasText: "未确认本次提交" }).waitFor(); assert.equal(decisions, 1);
  await page.locator("#refresh-app-review-version").click(); await page.locator("#app-review-notice").filter({ hasText: "版本已撤回" }).waitFor();
  assert.equal(await page.locator("#app-review-approved").count(), 0);
  // Nothing here went through a system alert: every decision was answered in
  // the window, in the app's own language.
  assert.equal(await app.evaluate(() => globalThis.appReviewFixture.dialogs.length), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualHttpAndSqlite: true, syntheticSessions: true, authorReviewerIsolation: true, inAppConfirmation: true, nativeDialogs: 0, cancelNoDecision: true, immutableReviewVisibleToAuthor: true, newVersionNotApproved: true, withdrawalDuringConfirmationRejected: true, reviewPosts: decisions, modelCalls: 0, liveFeishuCalls: 0, deployment: false, rendererErrors: errors }));
} catch (error) {
  if (page) await page.screenshot({ path: path.join(evidence, "desktop-app-review-failure.png"), timeout: 3000 }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => {});
  server.close(); server.closeAllConnections(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
