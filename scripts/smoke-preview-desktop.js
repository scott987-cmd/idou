import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { waitForHumanChoice, waitForHumanConfirm } from "./fixtures/agent-harness.js";

// The desktop's half of browser_preview, in the actual Electron app with the
// actual Codex, against a scripted model -- no paid call. main.js starts one
// artifact server per coding task and hands its base URL to that task's browser
// connector on argv; only the running app exercises that wiring, and before
// this script nothing did.
//
// 浏览器操作 is switched on in 技能中心, and a coding task's scripted model calls
// browser_preview. While its card waits, the browser connector Codex spawned for
// this app is found by process ancestry and its --preview-base read back: it
// must serve this task's folder, and only behind the secret path. The card is
// then allowed -- a synthetic data directory, as in smoke-mcp-desktop.js -- so
// the page's text reaches the model, which must receive it with the secret
// scrubbed out. Deleting the conversation must stop the server.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-preview-desktop-"));
const workspace = path.join(directory, "workspace"), evidence = path.resolve("docs/evidence");
await mkdir(workspace); await mkdir(evidence, { recursive: true });
const MARKER = `DESKTOP_PREVIEW_${randomBytes(6).toString("hex").toUpperCase()}`;
await writeFile(path.join(workspace, "index.html"), `<!doctype html><meta charset="utf-8"><title>desktop preview</title><h1>${MARKER}</h1>`);
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
let app, requests = 0, offered = false, toolOutput = null;

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
  // A coding task plans first, read-only, so the tool call belongs to the turn
  // after 开始做. The tool still has to be offered in the planning turn: an
  // Agent that cannot see it while planning cannot plan to use it.
  if (requests === 1) {
    // The gateway prefixes each MCP tool's description with the server and tool it stands for.
    offered = Boolean(body.tools?.find((item) => item.name.startsWith("idou_mcp_") && item.description?.startsWith("来自 MCP 服务「browser」的工具 browser_preview。")));
    return syntheticResponseStream(offered ? "PREVIEW_PLAN_DONE 我会打开 index.html 自测。" : "PREVIEW_TOOL_NOT_OFFERED");
  }
  if (requests === 2) {
    const tool = body.tools?.find((item) => item.name.startsWith("idou_mcp_") && item.description?.startsWith("来自 MCP 服务「browser」的工具 browser_preview。"));
    return tool ? call(tool.name, { path: "index.html" }) : syntheticResponseStream("PREVIEW_TOOL_NOT_OFFERED");
  }
  const output = body.input?.find((item) => item.call_id === "call_2" && /output/.test(item.type ?? ""))?.output;
  toolOutput = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return syntheticResponseStream("DESKTOP_PREVIEW_DONE");
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });

// Every process on the machine, so this app's connector is told apart from any
// other i豆 running here by ancestry rather than by name.
const processTable = () => new Promise((resolve, reject) => execFile("/bin/ps", ["-axww", "-o", "pid=,ppid=,command="], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => error ? reject(error)
  : resolve(stdout.split("\n").map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command })))));
const descendantsOf = (table, root) => {
  const family = new Set([root]);
  for (let grew = true; grew;) { grew = false; for (const row of table) if (!family.has(row.pid) && family.has(row.ppid)) { family.add(row.pid); grew = true; } }
  return table.filter((row) => row.pid !== root && family.has(row.pid));
};

try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], timeout: 30_000,
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin } });
  const page = await app.firstWindow(); page.setDefaultTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();

  // 浏览器操作 on, the way a person switches it: 技能中心 -> 连接器. DOM clicks,
  // not coordinates: this app layers WebContentsViews over the window.
  const click = (selector) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true; }, selector);
  assert.ok(await click('[data-section="skills"]'), "the skills section entry is missing");
  await page.locator('.sc-tab[data-tab="connectors"]').waitFor();
  assert.ok(await click('.sc-tab[data-tab="connectors"]'), "the connectors tab is missing");
  const browserSwitch = '[data-focus="builtin:browser"]';
  await page.locator(browserSwitch).waitFor();
  assert.equal(await page.locator(browserSwitch).getAttribute("aria-checked"), "false", "浏览器操作 should start switched off");
  assert.ok(await click(browserSwitch));
  await page.waitForFunction((s) => document.querySelector(s)?.getAttribute("aria-checked") === "true", browserSwitch);

  assert.ok(await click('[data-section="coding"]'), "the coding section entry is missing");
  await app.evaluate(({ dialog }, cwd) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] }); }, workspace);
  await page.locator("#pick-workspace").click();
  await page.locator("#project-path").filter({ hasText: workspace }).waitFor();
  await page.locator("#prompt").fill("打开本任务的 index.html 自测一下。"); await page.locator("#send").click();
  await page.locator("#messages").filter({ hasText: /PREVIEW_PLAN_DONE|PREVIEW_TOOL_NOT_OFFERED/ }).waitFor({ timeout: 90_000 });
  assert.equal(offered, true, "a coding task with 浏览器操作 on must be offered browser_preview");
  await page.locator("#start-building").click();
  // The plan turn's 已完成 is still on screen for a moment, and the wait below
  // would take it for this turn's.
  await page.waitForFunction(() => !["已完成", "执行失败"].includes(document.querySelector("#task-status").textContent), null, { polling: 100 });
  await page.waitForFunction(() => document.querySelector("#approvals").textContent.includes("确认 MCP 工具调用") || ["已完成", "执行失败"].includes(document.querySelector("#task-status").textContent), null, { timeout: 90_000, polling: 200 });
  assert.equal(offered, true, "a coding task with 浏览器操作 on must be offered browser_preview");
  const card = await page.locator("#approvals").innerText();
  assert.match(card, /确认 MCP 工具调用/, `no approval card (status: ${await page.locator("#task-status").innerText()}, error: ${await page.locator("#error-banner").innerText()})`);
  assert.match(card, /index\.html/, "the card must show the file the model asked for");

  // While the card waits: the connector this app's Codex spawned, and the base
  // it was handed. The script must be the process's own first argument: Codex's
  // command line -- the node launcher's and the native binary's alike -- carries
  // the same path inside the MCP configuration it was given, and a plain
  // substring match found all three processes.
  const family = descendantsOf(await processTable(), app.process().pid);
  const mentioning = family.filter((row) => row.command.includes(path.join("bin", "mcp", "browser.js")));
  const connectors = mentioning.filter((row) => row.command.split(/\s+/)[1]?.endsWith(path.join("bin", "mcp", "browser.js")));
  const shape = (row) => row.command.replace(/(127\.0\.0\.1:\d+\/)[A-Za-z0-9_-]{16,}/g, "$1<secret>").slice(0, 160);
  console.log(JSON.stringify({ stage: "connectors", mentioningScript: mentioning.map(shape), connectorProcesses: connectors.length }));
  assert.ok(connectors.length >= 1, "no browser connector process under this app");
  // One server per task: however many connector processes Codex runs, they all carry the same base.
  const bases = new Set(connectors.map((row) => row.command.match(/--preview-base (\S+)/)?.[1]));
  assert.equal(bases.size, 1, "every browser connector of this task must carry the same preview base");
  const [base] = bases;
  assert.ok(base, "the browser connector was started without the task's preview base");
  const secretPath = new URL(base).pathname.split("/").find(Boolean);
  assert.equal(new URL(base).hostname, "127.0.0.1", "the preview server must listen on loopback only");
  assert.match(await (await fetch(`${base}index.html`)).text(), new RegExp(MARKER), "the preview base must serve this task's own folder");
  assert.equal((await fetch(`${new URL(base).origin}/index.html`)).status, 404, "the folder must not be served without the secret path");
  await page.screenshot({ path: path.join(evidence, "desktop-preview-approval.png"), scale: "css" });

  await waitForHumanChoice(page.locator("#approvals .approval").first(), "允许这一次");
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor({ timeout: 120_000 });
  assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText());
  // One for the plan, then the tool call and its answer.
  assert.equal(requests, 3);
  assert.match(toolOutput ?? "", new RegExp(MARKER), "the page's text must reach the model");
  assert.equal((toolOutput ?? "").includes(secretPath), false, "the preview server's secret path reached the model");
  assert.match(toolOutput, /本任务成果\/index\.html/, "the model should still be told which page it saw");
  assert.match(await page.locator("#messages").innerText(), /DESKTOP_PREVIEW_DONE/);
  assert.match(await (await fetch(`${base}index.html`)).text(), new RegExp(MARKER), "the preview server outlives the turn, for the task's next one");

  // Deleting the conversation stops its preview server, and leaves the folder alone.
  const taskId = (await page.evaluate(() => window.idou.snapshot())).tasks[0].id;
  const deleting = page.evaluate((id) => window.idou.deleteTask(id), taskId);
  assert.match(await waitForHumanConfirm(page, "删除对话"), /不会被删除/);
  await deleting;
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(fetch(`${base}index.html`), "deleting the conversation must stop its preview server");
  assert.match(await readFile(path.join(workspace, "index.html"), "utf8"), new RegExp(MARKER), "the task's folder must survive the deletion");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualCodex: true, actualChromium: true, switchedOnInSkillCenter: true,
    previewBaseOnArgv: true, servesThisTaskFolder: true, secretPathRequired: true, pageTextReachedModel: true, secretScrubbedBeforeModel: true,
    serverOutlivesTurn: true, deleteStopsServer: true, modelRequests: requests, paidCalls: 0 }));
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0], requests, offered,
      status: await page.locator("#task-status").innerText().catch(() => "unavailable"), error: await page.locator("#error-banner").innerText().catch(() => "unavailable"),
      approvals: await page.locator("#approvals").innerText().catch(() => "unavailable"), pendingConfirm: await page.locator("#confirmations .confirm-card").innerText().catch(() => "") }));
  }
  throw error;
} finally {
  await app?.close(); sessions.revoke(session.token); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
