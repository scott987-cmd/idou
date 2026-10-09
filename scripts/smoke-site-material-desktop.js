import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { appReady } from "./fixtures/app-ready.js";

// 从材料开始 in the actual Electron application (docs/sites-phase1.md §1.3):
// 新建网站 → 一段描述 → a name, and a site whose folder holds the chosen style
// and the scenarios to choose from, with a coding task on it that has been
// given the first message -- answered here by a scripted model, no paid call.
// The task stops at its plan, as every coding task does: 开始做 is the person's.
// A Feishu link that is a table goes the table's own way, through its card.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-material-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
let app, asked = null, requests = 0;
// The page the scripted model writes once 开始做 is pressed: the handbook scenario's shape, in the site's style.
const PAGE = ["<!doctype html>", "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
  "<title>入职指南</title><link rel=\"stylesheet\" href=\"site.css\"></head>",
  "<body><main class=\"wrap\"><header class=\"head\"><p class=\"eyebrow\">入职指南 · 示例</p><h1 id=\"made\">欢迎加入</h1></header>",
  "<section class=\"section\"><h2 class=\"section-title\">报销</h2><p>示例：每月 5 日前在飞书审批里提交。</p></section></main></body></html>"];
const PATCH = `*** Begin Patch\n*** Add File: index.html\n${PAGE.map((line) => `+${line}`).join("\n")}\n*** End Patch\n`;
const call = (name, args) => {
  const item = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name, arguments: JSON.stringify(args), status: "completed" };
  const events = [{ type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async (_url, options) => {
  const body = JSON.parse(options.body); requests += 1;
  asked ??= JSON.stringify(body.input ?? []);
  if (requests === 1) return syntheticResponseStream("PLAN_READY 方案：用「培训手册」的结构，分报销、请假、常用系统三章。");
  // 开始做 sends its own turn: the page is written in it.
  if (requests === 2) return call("exec_command", { cmd: `apply_patch <<'EOF'\n${PATCH}EOF` });
  return syntheticResponseStream("BUILD_DONE 做好了 index.html，一页，内容来自你的描述（标了示例）。");
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });
try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}),
    IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin }, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  await appReady(page);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.idou?.siteFromMaterial), null, { polling: 100 });
  await page.locator('[data-section="sites"]').click();
  await page.locator("#site-new").click();
  const dialog = page.locator(".template-dialog");
  await dialog.locator("#material-list").waitFor();
  assert.deepEqual(await dialog.locator(".material-card strong").allInnerTexts(), ["飞书文档或知识库", "本机文件夹", "一段描述", "多维表格或电子表格"]);
  // 科技 for this one: the style chosen above the templates is the one it gets.
  await dialog.locator('.style-chip[data-style="tech"]').click();
  await dialog.locator('.style-chip[data-style="tech"][aria-pressed="true"]').waitFor();
  await page.screenshot({ path: path.join(evidence, "desktop-site-material-dialog.png"), clip: await dialog.boundingBox() });

  // A link that is not Feishu's is said to be that, before anything is made.
  await dialog.locator('.material-card[data-material="link"]').click();
  await page.locator("#ask-input").fill("https://example.com/handbook");
  await page.locator("#ask-ok").click();
  await page.locator("#error-banner").filter({ hasText: "不是飞书文档、知识库或表格的链接" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.sites())).length, 0, "nothing made for it");

  // 一段描述 → a name → the site, and the coding task with its first message.
  await page.locator("#site-new").click();
  await page.locator('.template-dialog .material-card[data-material="text"]').click();
  await page.locator("#ask-input").fill("给新同事的入职指南，讲报销、请假和常用系统");
  await page.locator("#ask-ok").click();
  await page.locator("#ask-input").fill("入职指南");
  // 1.7: from saying what it is made from to the plan, and on to the page and its preview.
  const timed = { started: Date.now() };
  await page.locator("#ask-ok").click();
  await page.waitForFunction(() => document.querySelector('[data-section="coding"]')?.getAttribute("aria-current") === "page", null, { polling: 100 });
  await page.locator("#messages").filter({ hasText: "PLAN_READY" }).waitFor({ timeout: 60_000 });
  timed.plan = Date.now() - timed.started;
  const sites = await page.evaluate(() => window.idou.sites());
  const site = sites.find((row) => row.name === "入职指南");
  assert.ok(site, JSON.stringify(sites.map((row) => row.name)));
  const task = (await page.evaluate(() => window.idou.snapshot())).tasks.find((row) => row.mode === "coding" && row.cwd === site.path);
  assert.ok(task, "a coding task on the site's own folder");
  assert.equal(task.stage, "planning", "it stops at its plan: 开始做 is the person's");
  assert.equal(task.title, "入职指南", "called what it is making");
  assert.match(path.basename(site.path), /^入职指南-[0-9a-f]{8}$/, "its folder, and so its project, named for it");
  const first = task.messages.find((message) => message.role === "user")?.text ?? "";
  assert.match(first, /^做一个网站，就在当前目录里/);
  assert.match(first, /想要的网站：给新同事的入职指南，讲报销、请假和常用系统/);
  assert.match(first, /「科技」风格/);
  assert.ok(asked?.includes("给新同事的入职指南"), "the scripted model was given the first message");
  // The folder: the style, and the scenarios to choose from -- nothing of which would be published.
  assert.equal(await readFile(path.join(site.path, "site.css"), "utf8"), await readFile(path.resolve("src/application/site-templates/styles/tech.css"), "utf8"));
  assert.deepEqual((await readdir(path.join(site.path, ".idou-templates"))).sort(), ["VOCABULARY.md", "event", "handbook", "landing", "links", "weekly"]);
  await page.screenshot({ path: path.join(evidence, "desktop-site-material-task.png") });

  // 开始做 -- not a card: the person going on from the plan -- and the page is written.
  const building = Date.now();
  await page.locator("#start-building").click();
  await page.locator("#messages").filter({ hasText: "BUILD_DONE" }).waitFor({ timeout: 60_000 });
  assert.match(await readFile(path.join(site.path, "index.html"), "utf8"), /<h1 id="made">欢迎加入<\/h1>/);
  timed.build = Date.now() - building;
  const previewing = Date.now();
  await page.evaluate((id) => window.idou.sitePreview(id), site.id);
  let preview = null;
  for (const until = Date.now() + 15_000; !preview && Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 100))) preview = app.windows().find((one) => /^http:\/\/127\.0\.0\.1:/.test(one.url()));
  assert.ok(preview, "the preview opened");
  await preview.locator("#made").waitFor();
  timed.preview = Date.now() - previewing;
  // What this application adds to the model's own time -- every step here but
  // the person's reading of the plan -- well inside 一般页面 3 分钟 (§1.7); a
  // real model's minutes are measured by smoke-site-material-live.js.
  assert.ok(timed.plan < 30_000 && timed.build < 30_000 && timed.preview < 10_000, JSON.stringify(timed));
  await preview.close();

  // A table link goes to the table's own dialog (and its card), not to a coding task.
  await page.locator('[data-section="sites"]').click();
  await page.locator("#site-new").click();
  await page.locator('.template-dialog .material-card[data-material="link"]').click();
  await page.locator("#ask-input").fill("https://synthetic.feishu.cn/base/SyntheticBaseToken0001?table=tblSyntheticTable1");
  await page.locator("#ask-ok").click();
  // The table dialog asks Feishu for the table's structure -- not reachable
  // here; that it was asked, and not a coding task started, is the point.
  const said = await page.waitForFunction(() => {
    const text = document.querySelector("#error-banner")?.innerText ?? "";
    return text && !text.includes("不是飞书文档") ? text : null;
  }, null, { polling: 100 }).then((handle) => handle.jsonValue());
  assert.doesNotMatch(said, /不是飞书文档/, said);
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.filter((row) => row.mode === "coding").length, 1, "no second coding task");
  assert.equal((await page.evaluate(() => window.idou.sites())).length, 1, `no site made for it (${said})`);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, scriptedModel: true, paidCalls: 0, site: "入职指南", style: "tech", planning: true, built: true, previewed: true, notFeishuRefused: true, tableRoutedAway: true,
    timingMs: { toPlan: timed.plan, build: timed.build, preview: timed.preview } }));
} finally {
  await app?.close();
  server.close(); server.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
