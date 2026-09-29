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
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { observeHumanChoice, presentHumanChoice, releaseHumanChoice } from "./fixtures/agent-harness.js";
import { openFeishuResource } from "./fixtures/open-document.js";

const DOC = "SyntheticBridgeWrite", PATTERN = "下周交付初稿", REPLACEMENT = "周五交付评审稿";
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-cli-bridge-write-")), dataRoot = path.join(directory, "app-data");
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });

const sessions = new SessionRegistry(), upstream = [], audits = [];
let revision = 8, modelCalls = 0;
let content = `<title>桥接写入验收（合成）</title><p>请团队确认以下安排。</p><p><b>${PATTERN}</b>，保留这里的补充说明。</p><img token="SyntheticImageKeep"/>`;
const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_bridge_write", cliProxyScopes: ["fixture:read", "fixture.docs:write"], cliWriteActions: ["document.inline-replace"] });
const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_bridge_write", appSecret: "synthetic-app-secret", sessions, sourceAccess, fetchImpl: async url => url.endsWith("/open-apis/authen/v2/oauth/token")
  ? Response.json({ code: 0, access_token: "synthetic-server-only-uat", token_type: "Bearer", expires_in: 900, scope: sourceAccess.requiredScopes.join(" ") })
  : Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_bridge", name: "桥接写入用户" } }) });
let login, app;
const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
  upstream.push({ url, method: options.method, authorization: options.headers.authorization });
  if (url.includes(`/open-apis/docs_ai/v1/documents/${DOC}/fetch`)) return Response.json({ code: 0, data: { document: { document_id: DOC, revision_id: revision, content } } });
  if (url.endsWith(`/open-apis/docs_ai/v1/documents/${DOC}`) && options.method === "PUT") {
    const body = JSON.parse(Buffer.from(options.body).toString("utf8"));
    assert.equal(body.command, "str_replace"); assert.equal(body.format, "xml");
    assert.equal(body.revision_id, 8); assert.equal(body.pattern, PATTERN); assert.equal(body.content, REPLACEMENT);
    content = content.replace(body.pattern, body.content); revision = 9;
    return Response.json({ code: 0, data: { result: "success", updated_blocks_count: 1, warnings: [], document: { revision_id: revision } } });
  }
  return Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_bridge", user_id: "bridge-user", name: "桥接写入用户" } });
} });
const server = createModelGateway({ sessions, apiKey: "synthetic-model-key", authHandler: async (req, res) => await login.handle(req, res) || await proxy.handle(req, res),
  fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); modelCalls++;
    assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false);
    assert.ok(body.input.includes(PATTERN));
    return Response.json({ status: "completed", model: "MiniMax-M3", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ kind: "feishu-text-edit", replacement: REPLACEMENT }) }] }] });
  } });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
login = new FeishuLoginService({ origin, provider, sessions, allowedTenants: ["tenant_fixture"] });
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/cli-bridge-write-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: dataRoot, IDOU_SERVER_URL: origin }, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));

  await page.locator("#settings").click(); await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
  // Sign-in opens inside the app rather than the system browser, so the launch
  // URL comes from auth status and the smoke completes the callback itself.
  const launchUrl = (await page.evaluate(() => window.idou.authStatus())).launchUrl;
  assert.ok(launchUrl, "sign-in must produce a launch URL");
  const launch = await fetch(launchUrl, { redirect: "manual" });
  const authorize = new URL(launch.headers.get("location")), cookie = launch.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${origin}/auth/feishu/callback?state=${authorize.searchParams.get("state")}&code=synthetic`, { headers: { cookie } })).status, 200);
  await page.locator("#login-identity").waitFor();
  const pending = await page.evaluate(() => window.idou.authStatus());
  assert.equal(pending.pendingIdentity.cliBridge, true);
  assert.equal(pending.pendingIdentity.cliDocumentWrites, true, "the login must advertise the configured write capability");
  await page.locator("#login-confirm").click(); await page.locator("#account-name").filter({ hasText: "桥接写入用户" }).waitFor();
  await page.locator("#settings").click(); await page.locator(".login-boundary").filter({ hasText: "修改文档之前，默认都先请你确认，你点了才执行；把某个任务设成「完全访问」，它就直接做完。发送消息、上传到云盘暂未开放。" }).waitFor();

  // Use the same visible task and file-panel path as a person. Creating a task
  // only through the main-process API leaves its task-scoped card correctly
  // hidden until that task is opened in the renderer.
  await page.locator('[data-section="cowork"]').click();
  await openFeishuResource(page, `https://fixture.feishu.cn/docx/${DOC}`);
  await page.locator("#document-meta").filter({ hasText: "版本 8" }).waitFor();
  const task = await page.evaluate(async () => (await window.idou.snapshot()).tasks.at(-1));
  await page.locator("#file-content").evaluate((input, pattern) => {
    const start = input.value.indexOf(pattern);
    if (start < 0) throw new Error("the fixture document must contain the selected span");
    input.focus(); input.setSelectionRange(start, start + pattern.length);
  }, PATTERN);
  await page.locator("#quote-selection").click();
  await page.locator("#propose-document-edit").check();
  await page.locator("#prompt").fill(`请将选中文字替换为：${REPLACEMENT}`);
  await page.locator("#send").click();
  const proposal = await page.evaluate(async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await window.idou.snapshot(), current = snapshot.tasks.find(row => row.id === id);
      if (current && current.status !== "running" && current.messages.some(message => message.role === "assistant")) return current;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("proposal did not complete");
  }, task.id);
  assert.equal(proposal.status, "completed", proposal.error);
  assert.equal(modelCalls, 1);
  assert.equal(upstream.filter(call => call.method === "PUT").length, 0, "no write may occur before the confirmation");

  // The confirmation is in-app now, so the write stays pending until the button
  // is clicked. Start it, check what the person is shown, then approve.
  const confirmed = observeHumanChoice(page, { detailText: PATTERN, label: "确认修改原文档" });
  await page.locator(".apply-document-edit").last().click();
  const card = page.locator("#confirmations .confirm-card");
  await card.waitFor({ timeout: 60_000 });
  const shown = await card.innerText();
  assert.equal(upstream.filter(call => call.method === "PUT").length, 0, "no write may occur before the confirmation");
  process.stdout.write("待人工操作：请核对原文与替换内容并亲手点击“确认修改原文档”\n");
  await presentHumanChoice(app, page, "i豆 M04 · 原文档写入确认");
  await confirmed;
  await releaseHumanChoice(app);
  await page.locator(".document-edit-success").filter({ hasText: "版本 9" }).waitFor({ timeout: 60_000 });

  // This deployment enabled only the document action. The desktop must refuse
  // the message paths outright rather than relying on server-side denial.
  const messageDenials = await page.evaluate(async id => {
    const attempt = async run => { try { await run(); return "allowed"; } catch (error) { return error.message; } };
    return {
      reply: await attempt(() => window.idou.replyChatMessage("synthetic-handle", "不应发送", false)),
      delivery: await attempt(() => window.idou.prepareDocumentDelivery(id, "synthetic-handle", "synthetic-recipient", "", [])),
      drive: await attempt(() => window.idou.saveMediaDrive(id, "synthetic-media", "https://fixture.feishu.cn/drive/folder/SyntheticFolder123")),
    };
  }, task.id);
  assert.match(messageDenials.reply, /尚未启用登录桥接下的飞书消息发送/, "reply must be refused by the message gate");
  assert.match(messageDenials.delivery, /尚未启用登录桥接下的飞书消息发送/, "delivery must be refused by the message gate");
  assert.match(messageDenials.drive, /尚未启用登录桥接下的飞书云盘上传/, "drive must be refused by the drive gate");

  assert.match(shown, new RegExp(PATTERN)); assert.match(shown, new RegExp(REPLACEMENT));
  assert.match(shown, /一次性写入许可/);
  assert.match(content, new RegExp(`<b>${REPLACEMENT}</b>`)); assert.match(content, /<img token="SyntheticImageKeep"/);
  assert.equal(upstream.filter(call => call.method === "PUT").length, 1, "exactly one write reaches Feishu");
  assert.ok(upstream.every(call => call.authorization === "Bearer synthetic-server-only-uat"));
  assert.deepEqual(audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished"]);
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(`${PATTERN}|${REPLACEMENT}|${DOC}|synthetic-server-only-uat`));
  assert.doesNotMatch(await page.locator("body").innerText(), /synthetic-server-only-uat|synthetic-app-secret|synthetic-model-key/);
  await page.screenshot({ path: path.join(evidence, "desktop-cli-bridge-write-fixture.png"), scale: "css" });
  assert.deepEqual(errors, []);
  await app.close(); app = null;
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualPinnedCli: true, syntheticOAuthAndFeishu: true,
    singleLoginWrite: true, serverOnlyToken: true, oneShotGrantConsumed: true, bodyFreeAudit: true, messageWritesRefused: true, driveWritesRefused: true,
    syntheticWrites: 1, liveFeishuWrites: 0, syntheticModelCalls: modelCalls, paidCalls: 0, rendererErrors: errors }));
} finally {
  if (app) await app.close().catch(() => {});
  proxy.close(); login?.close(); sourceAccess.close();
  server.closeAllConnections(); server.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
