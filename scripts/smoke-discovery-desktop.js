import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { storedBytes } from "./fixtures/wiki-store.js";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { answerConfirm, waitForHumanConfirm } from "./fixtures/agent-harness.js";
// 飞书消息 is Feishu's own embedded page now: the chat list and its
// 自动整理此会话文档 button are gone, but choosing a conversation and putting it
// into the background scope are still this application's own operations, driven
// here over the preload bridge against real main-process code. The scope
// consent that used to be a native dialog is the in-app confirmation card.
// Progress, stopping and the encrypted Wiki stay where they were: 企业知识库.
// 企业知识库 keeps its synthesis and discovery controls under 自动化与高级设置,
// folded; they are reached as a person reaches them, by opening it.
const openKnowledge = async (page) => {
  await page.locator('[data-section="knowledge"]').click();
  const advanced = page.locator("details.knowledge-advanced");
  await advanced.waitFor({ state: "attached" });
  if (!(await advanced.evaluate((node) => node.open))) await advanced.locator(":scope > summary").click();
};
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-discovery-ui-")), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app, page; const errors = [];
// The control plane the connection file names. It enforces MiniMax-M3 and says
// so on /healthz; nothing else of it is used (synthesis is the fixture's). While
// `slow`, every answer comes 3.5 s late, past the desktop's 3 s limit: the
// reviewers' reproduction of a first answer that used to pin the default for
// the scope's whole life and have every label and consent name it as fact.
let slow = true, glm = null; const healthz = [];
const control = createServer((req, res) => {
  if (req.url !== "/healthz" || req.method !== "GET") { res.writeHead(404); res.end(); return; }
  healthz.push(Date.now());
  setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok", provider: "minimax", model: "MiniMax-M3" })); } }, slow ? 3500 : 0);
});
control.listen(0, "127.0.0.1"); await once(control, "listening");
const issued = new SessionRegistry().issue({ tenantId: "synthetic", userId: "alice", deviceId: "one" }), sessionFile = path.join(directory, "connection.json");
await writeFile(sessionFile, JSON.stringify({ token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${control.address().port}` }), { mode: 0o600 });
// Reading a conversation is what makes it selectable: the scope is confirmed
// against the page just read, never against a raw chat id.
async function selectChat() {
  return page.evaluate(async () => {
    const list = await window.idou.listChats();
    const chat = list.chats.find(row => row.id === "oc_delivery");
    await window.idou.readChat(chat.handle);
    return chat.handle;
  });
}
const watch = handle => page.evaluate(value => window.idou.watchKnowledgeChat(value), handle);
const docsCalls = () => app.evaluate(() => globalThis.chatFixture.calls.filter(args => args[0] === "docs").length);
// The card's own buttons say which answer is the default: the one marked
// primary is the offered action, and a cancelling default is marked on nothing.
const cardButtons = () => page.evaluate(() => {
  const card = document.querySelector("#confirmations .confirm-card");
  return { labels: [...card.querySelectorAll(".confirm-actions button")].map(node => node.textContent), primary: card.querySelectorAll("button.primary").length };
});
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/discovery-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: directory } });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  // The server has not answered in time, so nothing is named: not the default either.
  await page.locator("#model-label").filter({ hasText: "模型未确认 · 企业模型网关" }).waitFor({ state: "attached" });
  let running = watch(await selectChat());
  await page.locator("#confirmations .confirm-card").waitFor();
  const offered = await cardButtons();
  assert.deepEqual(offered.labels, ["取消", "开启自动整理"]);
  assert.equal(offered.primary, 0, "cancel must stay the default answer");
  // The scope consent says the model is unconfirmed instead of offering to send content to one.
  const unconfirmed = await answerConfirm(page, "取消");
  assert.ok(unconfirmed.includes("模型未确认") && unconfirmed.includes("不会发送给任何模型"), unconfirmed); assert.doesNotMatch(unconfirmed, /MiniMax/);
  assert.equal(await running, null);
  assert.equal(await docsCalls(), 0);
  // Nor can synthesis be switched on, from the page or past it.
  await openKnowledge(page);
  await page.locator("#knowledge-synthesis-consent").filter({ hasText: "模型未确认" }).waitFor();
  assert.doesNotMatch(await page.locator("#knowledge-synthesis-consent").innerText(), /MiniMax/);
  assert.equal(await page.locator("#toggle-knowledge-synthesis").isDisabled(), true);
  await assert.rejects(page.evaluate(() => window.idou.setKnowledgeSynthesis(true, "MiniMax-M3")), /尚未确认/);
  await assert.rejects(page.evaluate(() => window.idou.setKnowledgeSynthesis(true)), /Invalid synthesis setting/);
  // Left alone, the page reads the connection again ~10 s after each unconfirmed
  // answer, and each read has the server asked again once the 10 s backoff is
  // over: two more questions inside 28 s, where the 30 s poll alone asks once.
  const asked = healthz.length;
  for (const started = Date.now(); healthz.length < asked + 2; await page.waitForTimeout(250)) assert.ok(Date.now() - started < 28_000, `asked ${healthz.length - asked} more time(s) in 28 s`);
  // The server answers in time again: the same scope learns its model without a
  // restart or a new connection, having asked no more than once per 10 s.
  slow = false;
  await page.locator("#model-label").filter({ hasText: "MiniMax-M3 · 企业模型网关" }).waitFor({ state: "attached", timeout: 25_000 });
  assert.ok(healthz.length >= 2, "asked again"); assert.ok(healthz.slice(1).every((at, index) => at - healthz[index] >= 9_000), JSON.stringify(healthz.map(at => at - healthz[0])));
  await page.locator("#toggle-knowledge-synthesis:not([disabled])").waitFor();
  // Now the consent names the model, and states that model's output cap.
  const consent = await page.locator("#knowledge-synthesis-consent").innerText();
  assert.ok(consent.includes("MiniMax-M3 · MiniMax") && consent.includes("每次最多 2400 输出 token"), consent);
  await page.locator("#toggle-knowledge-synthesis").click();
  await page.locator("#toggle-knowledge-synthesis").filter({ hasText: "关闭" }).waitFor();
  // Started from a section that is not 企业知识库, so the worker has to survive
  // the navigation to it -- section changes never stop discovery.
  await page.locator('[data-section="cowork"]').click();
  running = watch(await selectChat());
  const scope = await waitForHumanConfirm(page, "开启自动整理");
  assert.ok(await running, "confirming must return the running scope");
  // The consent names the model synthesis would use, label and vendor.
  for (const text of ["oc_delivery", "24 小时", "MiniMax-M3 · MiniMax"]) assert.ok(scope.includes(text), text);
  await openKnowledge(page);
  await page.locator("#discovery-status").filter({ hasText: "保留或更新 1 篇" }).waitFor();
  assert.equal(await page.locator("#recent-tasks button").count(), 0, "discovery must not require or create a work task");
  const first = await page.evaluate(() => window.idou.searchKnowledge("采购")); assert.equal(first.hits.length, 1); assert.ok(first.hits[0].synthesis);
  assert.equal(await app.evaluate(() => globalThis.discoveryFixture.models), 1);
  const initial = await app.evaluate(() => globalThis.discoveryFixture.schedules.length);
  // A new incoming synthetic message appears while the UI remains in knowledge.
  await app.evaluate(() => { globalThis.chatFixture.rows.unshift({ message_id: "om_new", msg_type: "text", deleted: false, create_time: "2026-09-09 12:00", sender: { name: "新同事", id: "ou_new" }, content: "新增文档 https://test.feishu.cn/docx/SyntheticNewDocument123" }); });
  await page.locator("#discovery-status").filter({ hasText: "保留或更新 2 篇" }).waitFor();
  const second = await page.evaluate(() => window.idou.searchKnowledge("采购")); assert.equal(second.hits.length, 2);
  assert.equal(await app.evaluate(() => globalThis.discoveryFixture.models), 2);
  assert.ok(await app.evaluate((_electron, previous) => globalThis.discoveryFixture.schedules.length > previous, initial));
  await page.screenshot({ path: path.join(evidence, "desktop-message-discovery-fixture.png"), scale: "css" });
  await page.locator("#discovery-stop").click(); await page.locator("#discovery-status").filter({ hasText: "已停止" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.discoveryStatus())).busy, false);
  const wiki = await storedBytes(path.join(directory, "knowledge", "local-wiki.enc")); assert.equal(wiki.includes(Buffer.from("采购")), false);
  assert.equal((await readdir(path.join(directory, "tasks"))).filter(name => name.endsWith(".json")).length, 0);
  // A cancelable native document read is held; stopping must cancel and drain it.
  await app.evaluate(() => { globalThis.discoveryFixture.holdDocument = true; });
  await page.locator('[data-section="cowork"]').click();
  running = watch(await selectChat());
  await waitForHumanConfirm(page, "开启自动整理");
  assert.ok(await running);
  await openKnowledge(page);
  for (let i = 0; i < 100 && !await app.evaluate(() => globalThis.discoveryFixture.held); i++) await page.waitForTimeout(20);
  assert.equal(await app.evaluate(() => globalThis.discoveryFixture.held), true);
  await page.locator("#discovery-stop").click(); await page.locator("#discovery-stop").waitFor({ state: "hidden" });
  assert.equal(await app.evaluate(() => globalThis.discoveryFixture.aborted), true);
  await app.evaluate(() => { globalThis.discoveryFixture.holdDocument = false; });
  await page.locator('[data-section="cowork"]').click();
  running = watch(await selectChat());
  await waitForHumanConfirm(page, "开启自动整理");
  assert.ok(await running);
  await app.evaluate(() => { globalThis.chatFixture.user = "ou_changed"; });
  await openKnowledge(page);
  await page.locator("#discovery-status").filter({ hasText: "已暂停" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.discoveryStatus())).enabled, false);
  await page.reload(); await page.locator('[data-section="feishu"]').waitFor();
  assert.equal((await page.evaluate(() => window.idou.discoveryStatus())).enabled, false);
  // Another connection file names another server, one on GLM-5.3, and the scope
  // asks it at once. The consent still on screen names MiniMax-M3, so switching
  // on from it is refused rather than sending content to a model nobody read;
  // the page then looks again, and the next consent names GLM-5.3 and its cap.
  glm = createServer((req, res) => { if (req.url !== "/healthz") { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: "ok", provider: "litellm", model: "GLM-5.3" })); });
  glm.listen(0, "127.0.0.1"); await once(glm, "listening");
  const glmFile = path.join(directory, "connection-glm.json");
  await writeFile(glmFile, JSON.stringify({ token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${glm.address().port}` }), { mode: 0o600 });
  await openKnowledge(page);
  // Whatever synthesis was left as above, it is off here and the consent offers MiniMax-M3.
  if (await page.locator("#toggle-knowledge-synthesis").filter({ hasText: "关闭" }).count()) await page.locator("#toggle-knowledge-synthesis").click();
  await page.locator("#toggle-knowledge-synthesis").filter({ hasText: "本次会话开启" }).waitFor();
  await page.locator("#knowledge-synthesis-consent").filter({ hasText: "MiniMax-M3 · MiniMax" }).waitFor();
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, glmFile);
  assert.equal((await page.evaluate(() => window.idou.connect())).modelLabel, "GLM-5.3");
  await page.locator("#toggle-knowledge-synthesis").click();
  await page.locator("#error-banner").filter({ hasText: "服务端所用模型已变化" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.knowledgeStatus())).synthesis.enabled, false);
  const moved = await page.locator("#knowledge-synthesis-consent").innerText();
  assert.ok(moved.includes("GLM-5.3 · 智谱 GLM") && moved.includes("每次最多 8192 输出 token") && !moved.includes("MiniMax"), moved);
  await page.locator("#model-label").filter({ hasText: "GLM-5.3 · 企业模型网关" }).waitFor({ state: "attached" });
  await page.locator("#toggle-knowledge-synthesis").click(); await page.locator("#toggle-knowledge-synthesis").filter({ hasText: "关闭" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.knowledgeStatus())).synthesis.model, "GLM-5.3");
  assert.deepEqual(errors, []);
  const calls = await app.evaluate(() => globalThis.chatFixture.calls);
  assert.ok(calls.every(args => args[0] === "auth" || args[0] === "skills" || ["+fetch", "+chat-list", "+chat-messages-list", "+messages-mget"].includes(args[1])));
  console.log(JSON.stringify({ passed: true, actualElectron: true, syntheticUpstreamsAndCipher: true, slowHealthzLeftModelUnconfirmed: true, modelLearnedWithoutRestart: true, staleConsentRefusedAfterServerMoved: true, healthzAskedAtMs: healthz.map(at => at - healthz[0]), timerAcceleratedOnlyInFixture: true, inAppScopedConsent: true, automaticNewDocumentDiscovery: true, backgroundAcrossNavigation: true, encryptedSourceOnlyWiki: true, synthesisDeduplicated: true, stopCancelsRead: true, identityChangePauses: true, noTaskRequired: true, noRestartAutoEnable: true, liveWrites: 0, paidCalls: 0, rendererErrors: errors }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, "desktop-discovery-failure.png"), scale: "css" }); throw error;
} finally { await app?.close(); for (const server of [control, glm]) { server?.close(); server?.closeAllConnections(); } await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
