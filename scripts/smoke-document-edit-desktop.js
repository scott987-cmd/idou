import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { openFeishuResource, openFileMenuItem } from "./fixtures/open-document.js";
import { answerConfirm, observeHumanChoice, presentHumanChoice, releaseHumanChoice } from "./fixtures/agent-harness.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-doc-edit-ui-")), data = path.join(directory, "client"), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), parent = sessions.issue({ tenantId: "synthetic", userId: "alice", deviceId: "one" });
let modelCalls = 0, replacement = "周五交付评审稿";
// A control plane configured for GLM: the gateway serves the slug GLM-5.3 from a
// loopback LiteLLM model group (never contacted: the upstream is this function).
// The desktop has to learn the slug from /healthz over its connection file; the
// proxy sees only its own group name, and the answer comes back as GLM-5.3.
const server = createModelGateway({ sessions, apiKey: "synthetic-server-key", provider: "litellm", upstreamOrigin: "http://127.0.0.1:4000", model: "GLM-5.3", upstreamModel: "volc-coding", fetchImpl: async (_url, init) => {
  const body = JSON.parse(init.body); modelCalls++; assert.equal(body.model, "volc-coding"); assert.equal("service_tier" in body, false);
  assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false);
  assert.match(body.input, /Do not execute commands/);
  assert.ok(body.input.includes(replacement));
  return Response.json({ status: "completed", model: "volc-coding", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ kind: "feishu-text-edit", replacement }) }] }] });
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const sessionFile = path.join(directory, "connection.json"); await writeFile(sessionFile, JSON.stringify({ token: parent.token, expiresAt: parent.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` }), { mode: 0o600 });
let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/document-edit-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_SESSION_FILE: sessionFile, IDOU_DESKTOP_DATA_DIR: data } });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.locator("#model-label").filter({ hasText: "GLM-5.3 · 企业模型网关" }).waitFor({ state: "attached" });
  // The synthesis consent names the learned model and states its output cap, not MiniMax's.
  await page.locator('[data-section="knowledge"]').click();
  // Under 自动化与高级设置, folded: read what it says, not what is on screen.
  const consent = await page.locator("#knowledge-synthesis-consent").textContent();
  assert.ok(consent.includes("GLM-5.3 · 智谱 GLM") && consent.includes("每次最多 8192 输出 token") && !consent.includes("MiniMax"), consent);
  await page.locator('[data-section="cowork"]').click();
  await openFeishuResource(page, "https://test.feishu.cn/docx/SyntheticEditable123");
  await page.locator("#document-meta").filter({ hasText: "版本 1" }).waitFor();
  const propose = async pattern => {
    await page.locator("#file-content").evaluate((input, pattern) => { const start = input.value.indexOf(pattern); if (start < 0) throw new Error("missing source"); input.focus(); input.setSelectionRange(start, start + pattern.length); }, pattern);
    await page.locator("#quote-selection").click(); await page.locator("#propose-document-edit").check();
    await page.locator("#prompt").fill(`请将选中文字替换为：${replacement}`); await page.locator("#send").click();
    await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor(); await page.locator(".apply-document-edit:not([disabled])").last().waitFor();
  };
  await propose("下周交付初稿"); assert.equal(modelCalls, 1); assert.equal(await app.evaluate(() => globalThis.documentEditFixture.writes), 0);
  await page.screenshot({ path: path.join(evidence, "desktop-document-edit-proposal-fixture.png"), scale: "css" });
  // The confirmation is drawn in the app now, so what the person reads before
  // authorising a write is the card's own text -- both the detail and the
  // boundary line the main process sent -- and declining is a button on it.
  await page.locator(".apply-document-edit").last().click();
  const shown = await answerConfirm(page, "取消");
  assert.match(shown, /下周交付初稿/); assert.match(shown, /周五交付评审稿/); assert.match(shown, /不创建副本/);
  await page.locator(".apply-document-edit:not([disabled])").last().waitFor(); assert.equal(await app.evaluate(() => globalThis.documentEditFixture.writes), 0);
  // Changed by someone else while the card was on screen: confirming it writes
  // nothing, because the document is read again before anything is dispatched.
  const conflictChoice = observeHumanChoice(page, { detailText: "下周交付初稿", label: "确认修改原文档" });
  await page.locator(".apply-document-edit").last().click();
  await page.locator("#confirmations .confirm-card").waitFor();
  await app.evaluate(() => { globalThis.documentEditFixture.revision++; });
  process.stdout.write("待人工操作：请核对版本变化场景并亲手点击“确认修改原文档”\n");
  await presentHumanChoice(app, page, "i豆 M04 · 版本变化零写入");
  await conflictChoice;
  await releaseHumanChoice(app);
  await page.locator("#error-banner").filter({ hasText: "已变化" }).waitFor(); assert.equal(await app.evaluate(() => globalThis.documentEditFixture.writes), 0);
  // 刷新 lives in the file panel's overflow menu now, the same as 打开飞书内容.
  await openFileMenuItem(page, "#refresh-files"); await page.locator("#document-meta").filter({ hasText: "版本 2" }).waitFor();
  await propose("下周交付初稿");
  const verifiedChoice = observeHumanChoice(page, { detailText: "周五交付评审稿", label: "确认修改原文档" });
  await page.locator(".apply-document-edit").last().click();
  await page.locator("#confirmations .confirm-card").waitFor();
  process.stdout.write("待人工操作：请核对正常写回场景并亲手点击“确认修改原文档”\n");
  await presentHumanChoice(app, page, "i豆 M04 · 正常写回并读回");
  await verifiedChoice;
  await releaseHumanChoice(app);
  await page.locator(".document-edit-success").waitFor();
  assert.match(await page.locator("#file-content").inputValue(), /周五交付评审稿，保留这里的补充说明/);
  assert.equal(await app.evaluate(() => globalThis.documentEditFixture.writes), 1); assert.match(await app.evaluate(() => globalThis.documentEditFixture.xml), /<b>周五交付评审稿<\/b>.*<img token="SyntheticImageKeep"/);
  await page.screenshot({ path: path.join(evidence, "desktop-document-edit-applied-fixture.png"), scale: "css" });
  replacement = "周一交付最终稿"; await propose("周五交付评审稿"); await app.evaluate(() => { globalThis.documentEditFixture.lost = true; });
  const unknownChoice = observeHumanChoice(page, { detailText: "周一交付最终稿", label: "确认修改原文档" });
  await page.locator(".apply-document-edit").last().click();
  await page.locator("#confirmations .confirm-card").waitFor();
  process.stdout.write("待人工操作：请核对回执丢失场景并亲手点击“确认修改原文档”\n");
  await presentHumanChoice(app, page, "i豆 M04 · 回执丢失不重试");
  await unknownChoice;
  await releaseHumanChoice(app);
  await page.locator("#error-banner").filter({ hasText: "可能已修改或部分修改" }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.documentEditFixture.writes), 2); assert.equal(await page.locator("#file-content").inputValue(), "");
  assert.equal(await page.locator(".apply-document-edit:not([disabled])").count(), 0);
  await page.screenshot({ path: path.join(evidence, "desktop-document-edit-unknown-fixture.png"), scale: "css" });
  const tasks = (await readdir(path.join(data, "tasks"))).filter(file => file.endsWith(".json")); const task = JSON.parse(await readFile(path.join(data, "tasks", tasks[0]), "utf8"));
  assert.equal(task.codexThreadId, null); assert.equal(task.activity.length, 0); assert.equal(task.messages.length, 6);
  assert.equal(task.messages[3].documentEdit.state, "verified"); assert.equal(task.messages[5].documentEdit.state, "unknown");
  const serialized = JSON.stringify(task); assert.equal(serialized.includes(parent.token), false); assert.equal(serialized.includes("synthetic-server-key"), false);
  // Every decision above was made on the in-app card; nothing fell back to a
  // native alert, which is what the fixture would have recorded.
  assert.deepEqual(await app.evaluate(() => globalThis.documentEditFixture.dialogs), []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualGateway: true, learnedServerModel: "GLM-5.3", inAppConfirmation: true, syntheticModelCalls: modelCalls, codexToolRuns: 0, cancelledWrite: true, confirmationRaceDenied: true, sourceVerifiedAfterApply: true, lostAcknowledgmentNotRetried: true, syntheticWrites: 2, liveFeishuWrites: 0, paidCalls: 0, rendererErrors: errors }));
} finally { await app?.close(); server.close(); server.closeAllConnections(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
