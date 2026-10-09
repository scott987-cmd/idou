// @requires live: 真实付费模型调用（一个编程任务，最多 30 次请求）
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

// 一般页面 3 分钟内 (docs/sites-phase1.md §1.7), with the real configured chat
// model: 新建网站 → 从材料开始 · 一段描述 → the plan → 开始做 → the page
// written → its preview. smoke-site-material-desktop.js runs the same path with
// a scripted model and so times only this application's part; this times what
// a person would wait for. 开始做 is pressed as soon as the plan is there (it is
// the person going on, not a card); any card the task raises stops the run
// unanswered -- cards are the person's.
if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live: this makes real model calls");
const LIMIT_MS = 180_000, CAP = 30;
const chat = await loadChatModelConfig();
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-material-live-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "site-material-live", deviceId: "local" });
let calls = 0, app;
const launched = Date.now();
const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  if (calls >= CAP) throw new Error(`Live site-material request cap (${CAP}) reached`);
  calls += 1;
  // The deployment's own output cap, not a smaller one of this smoke's: a page
  // is long, and a cap the product does not have cut one off mid-file.
  const body = JSON.parse(options.body);
  // Where the time goes: when each request was made, and what the model did just before it.
  const last = (Array.isArray(body.input) ? body.input : []).filter((item) => item?.type === "function_call" || item?.type === "custom_tool_call").at(-1);
  const did = last ? `${last.name}: ${String(last.arguments ?? last.input ?? "").replace(/\s+/g, " ").slice(0, 120)}` : "(first)";
  const asked = Date.now();
  const response = await fetch(url, { ...options, body: JSON.stringify(body) });
  console.log(JSON.stringify({ stage: "provider", request: calls, status: response.status, atS: Math.round((asked - launched) / 1000), after: did }));
  return response;
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });
const card = async (page) => (await page.locator("#approvals").innerText().catch(() => "")).trim();
try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}),
    IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin }, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  await page.waitForFunction(() => Boolean(window.idou?.siteFromMaterial), null, { polling: 100 });
  await page.locator('[data-section="sites"]').click();
  await page.locator("#site-new").click();
  await page.locator('.template-dialog .material-card[data-material="text"]').click();
  await page.locator("#ask-input").fill("给新同事的入职指南：报销怎么报、请假怎么请、常用系统有哪些，各一部分");
  await page.locator("#ask-ok").click();
  await page.locator("#ask-input").fill("入职指南");
  const started = Date.now();
  await page.locator("#ask-ok").click();

  // The plan, then 开始做 straight away.
  // Shown as soon as planning starts, and only pressable once the plan is written.
  await page.waitForFunction(() => {
    const begin = document.querySelector("#start-building");
    return begin?.offsetParent && !begin.disabled || document.querySelector("#approvals")?.textContent.trim()
      || document.querySelector("#task-status")?.textContent === "执行失败";
  }, null, { polling: 500, timeout: LIMIT_MS });
  assert.equal(await card(page), "", `stopped at a card, unanswered: ${await card(page)}`);
  const planned = Date.now() - started;
  await page.locator("#start-building").click();

  // Built: the turn over, and a page in the site's folder.
  await page.waitForFunction(() => ["已完成", "执行失败"].includes(document.querySelector("#task-status")?.textContent) && !document.querySelector("#start-building")?.offsetParent
    || document.querySelector("#approvals")?.textContent.trim(), null, { polling: 500, timeout: LIMIT_MS });
  assert.equal(await card(page), "", `stopped at a card, unanswered: ${await card(page)}`);
  assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText().catch(() => ""));
  const site = (await page.evaluate(() => window.idou.sites())).find((row) => row.name === "入职指南");
  const html = await readFile(path.join(site.path, "index.html"), "utf8");
  assert.match(html, /site\.css/, "the page wears the site's style");
  assert.match(html, /报销/);
  await page.evaluate((id) => window.idou.sitePreview(id), site.id);
  let preview = null;
  for (const until = Date.now() + 15_000; !preview && Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 100))) preview = app.windows().find((one) => /^http:\/\/127\.0\.0\.1:/.test(one.url()));
  assert.ok(preview, "the preview opened");
  await preview.waitForLoadState("load");
  const total = Date.now() - started;
  await preview.screenshot({ path: path.join(evidence, "desktop-site-material-live.png"), fullPage: true });
  console.log(JSON.stringify({ passed: total < LIMIT_MS, model: chat.model, calls, toPlanMs: planned, totalMs: total, limitMs: LIMIT_MS }));
  assert.ok(total < LIMIT_MS, `一般页面 took ${Math.round(total / 1000)} s, over ${LIMIT_MS / 1000} s`);
} finally {
  await app?.close();
  server.close(); server.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
