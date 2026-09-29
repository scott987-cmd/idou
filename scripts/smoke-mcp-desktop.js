import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { answerConfirm, waitForHumanChoice, waitForHumanConfirm } from "./fixtures/agent-harness.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-mcp-desktop-"));
const evidence = path.resolve("docs/evidence"); await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
let app, requests = 0, toolResult = false, lastOutputs = [], approvalWaitMs = null;
let httpCalls = 0;
// IDOU_SMOKE_SLOW_APPROVAL=1: the person holds each 允许这一次 past the
// 60 seconds every MCP server is given per call (tool_timeout_sec,
// mcp-connections.js), and the run fails if the click came sooner. Automation
// can only show that Codex still waits that long (test/codex-mcp-approval-
// wait.test.js refuses once the timeout has passed); that an approved call
// then still reaches the model takes a person's click.
const SLOW_APPROVAL_MS = process.env.IDOU_SMOKE_SLOW_APPROVAL ? 70_000 : 0, approvalWaits = [];
const mcpHttp = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(405).end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk); const request = JSON.parse(Buffer.concat(chunks));
  if (request.id === undefined) { res.writeHead(202).end(); return; }
  let result;
  if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-http-mcp", version: "1.0.0" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "echo", description: "Echo a synthetic test marker", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } }] };
  else if (request.method === "tools/call") { httpCalls++; result = { content: [{ type: "text", text: `MCP_EXECUTED:${request.params.arguments.text}` }] }; }
  else result = {};
  res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
});
mcpHttp.listen(0, "127.0.0.1"); await once(mcpHttp, "listening");
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async (_url, options) => {
  const body = JSON.parse(options.body); requests++;
  if (requests % 2 === 0) { lastOutputs = (body.input ?? []).filter((item) => item.type === "function_call_output").map((item) => String(typeof item.output === "string" ? item.output : JSON.stringify(item.output)).slice(0, 400)); toolResult = JSON.stringify(body.input).includes("MCP_EXECUTED:synthetic-marker"); return syntheticResponseStream(toolResult ? "MCP_RESULT_VERIFIED" : "MCP_CALL_DECLINED"); }
  // The gateway prefixes each MCP tool's description with where it comes from,
  // so match on the server's own text at the end -- an exact match would also
  // make the "never offered" check below pass without checking anything.
  const tool = body.tools?.find((item) => item.name.startsWith("idou_mcp_") && item.description?.endsWith("Echo a synthetic test marker"));
  assert.ok(tool, `Missing MCP tool; offered ${body.tools?.map((item) => item.name).join(",")}`);
  assert.match(tool.description, /^来自 MCP 服务「[a-z0-9_-]+」的工具 echo。/, "the model is told which server and tool this is");
  assert.equal(body.tools.some((item) => item.description?.endsWith("Must never be offered")), false);
  const item = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name: tool.name, arguments: JSON.stringify({ text: "synthetic-marker" }), status: "completed" };
  const events = [{ type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json"), connectionFile = path.join(directory, "connection.json"), callLog = path.join(directory, "mcp-calls.txt");
await writeFile(callLog, "");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });
await writeFile(connectionFile, JSON.stringify({ id: "demo", title: "MCP 合成验收", transport: "stdio", command: process.execPath, args: [path.resolve("scripts/fixtures/mcp-stdio.js"), callLog], enabledTools: ["echo"] }));
try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin }, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  // Only the file picker is stubbed. Every decision this script makes is now
  // taken in the application's own confirmation card, so there is no
  // showMessageBox left to answer -- the script has to read the card and press
  // one of the buttons the main process actually offered.
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, connectionFile);
  // Connections live in 技能中心 → 连接器 (they were at the foot of 设置 until
  // 2026-09-23). A row keeps its less frequent actions in two small menus.
  const openConnectors = async () => {
    await page.locator('[data-section="skills"]').click();
    await page.locator('.sc-tab[data-tab="connectors"]').click(); await page.locator("#import-mcp").waitFor();
  };
  const connectionAction = async (menu, item) => {
    await page.locator(`.mcp-connection .${menu} > summary`).first().click();
    await page.getByRole("menuitem", { name: item, exact: true }).click();
  };
  await openConnectors(); await page.locator("#import-mcp").click();
  // Declining imports nothing: the card names the connection it is asking about
  // and states what importing would allow, and the answer is "取消".
  const importCard = await answerConfirm(page, "取消");
  assert.match(importCard, /MCP 合成验收/); assert.match(importCard, /请确认配置中没有密钥/); assert.match(importCard, /导入本身不会连接或调用模型/);
  await page.waitForFunction(() => !document.querySelector("#import-mcp").disabled); assert.deepEqual(await page.evaluate(() => window.idou.listMcp()), []);
  await page.locator("#import-mcp").click(); await waitForHumanConfirm(page, "确认导入"); await page.locator(".mcp-connection").waitFor();
  await connectionAction("mcp-more-menu", "检查连接");
  assert.match(await waitForHumanConfirm(page, "确认"), /不发送模型请求/);
  await page.getByText(/检查通过：1 个工具/).waitFor(); assert.equal(requests, 0);
  await page.screenshot({ path: path.join(evidence, "desktop-mcp-connections-fixture.png"), scale: "css" });
  const runTask = async (decision) => {
    await connectionAction("mcp-use-menu", "新工作任务");
    // Binding a connection to a new task is its own confirmation, separate from
    // the per-call approval this task is about to raise.
    assert.match(await waitForHumanConfirm(page, "确认"), /调用按任务的权限确认/);
    await page.locator("#task-mcp-label").waitFor();
    await page.locator("#prompt").fill("仅调用已配置的 echo MCP，输入 synthetic-marker。不要执行任何 shell。"); await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelector("#approvals").textContent.includes("确认 MCP 工具调用") || document.querySelector("#task-status").textContent === "执行失败", null, { timeout: 30000 });
    assert.notEqual(await page.locator("#task-status").innerText(), "执行失败", await page.locator("#error-banner").innerText());
    // From the moment the card is on screen: Codex asked a moment before.
    const shownAt = Date.now(), slow = SLOW_APPROVAL_MS && decision !== "拒绝";
    if (slow) process.stdout.write(`待人工操作：这张「允许这一次」先别点，等卡片出现满 ${SLOW_APPROVAL_MS / 1000} 秒再点\n`);
    // A work task folds the call's arguments under 技术详情 (since 2026-09-21,
    // aea0672); a person opens it to read what they are approving, and so does this.
    await page.locator("#approvals .approval-technical > summary").first().click();
    assert.match(await page.locator("#approvals").innerText(), /synthetic-marker/);
    if (decision === "允许这一次" && requests < 5) await page.screenshot({ path: path.join(evidence, "desktop-mcp-approval-fixture.png"), scale: "css" });
    if (requests < 4) assert.equal(await readFile(callLog, "utf8"), "", "No MCP execution before explicit approval");
    const ready = slow ? setTimeout(() => process.stdout.write(`待人工操作：已等满 ${SLOW_APPROVAL_MS / 1000} 秒，现在点「允许这一次」\n`), Math.max(0, SLOW_APPROVAL_MS - (Date.now() - shownAt))) : null;
    try {
      if (decision === "拒绝") await page.getByRole("button", { name: decision, exact: true }).click();
      else await waitForHumanChoice(page.locator("#approvals .approval").first(), decision);
    } finally { clearTimeout(ready); }
    approvalWaitMs = Date.now() - shownAt; approvalWaits.push({ decision, ms: approvalWaitMs });
    if (slow) assert.ok(approvalWaitMs > 60_000, `这次在卡片出现 ${Math.round(approvalWaitMs / 1000)} 秒时就点了；慢批准验收要等过 60 秒`);
    await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor({ timeout: 30000 });
  };
  // An approved call whose result never reached the model says why, rather
  // than only that it did not: how the task recorded the call, what the model
  // was handed back, and how long the approval waited for a person. A call
  // Codex never ran records 0 ms and hands back its refusal ("user rejected MCP
  // tool call"); a call that ran and failed hands back the failure.
  const explainApproved = async (stage) => {
    if (toolResult === true) return;
    const calls = (await page.evaluate(() => window.idou.snapshot())).tasks.flatMap((task) => task.activity.filter((item) => item.type === "mcpToolCall"));
    console.error(JSON.stringify({ stage, approvalWaitMs, calls: calls.map(({ server, tool, status, durationMs }) => ({ server, tool, status, durationMs })), modelGotBack: lastOutputs, callLog: await readFile(callLog, "utf8").catch(() => null), httpCalls }));
  };
  await runTask("拒绝"); assert.equal(toolResult, false); assert.match(await page.locator("#messages").innerText(), /MCP_CALL_DECLINED/);
  assert.equal(await readFile(callLog, "utf8"), "");
  await openConnectors(); await page.locator(".mcp-connection").waitFor(); await runTask("允许这一次");
  await explainApproved("approved stdio call");
  assert.equal(toolResult, true); assert.match(await page.locator("#messages").innerText(), /MCP_RESULT_VERIFIED/);
  assert.equal(await readFile(callLog, "utf8"), "echo-called\n");
  const completed = (await page.evaluate(() => window.idou.snapshot())).tasks[0]; assert.equal(completed.activity.some((item) => item.type === "mcpToolCall" && item.tool === "echo" && item.status === "completed"), true);
  await openConnectors(); await connectionAction("mcp-more-menu", "移除");
  await waitForHumanConfirm(page, "移除连接"); await page.locator(".mcp-connection").waitFor({ state: "detached" });
  await page.locator("#recent-tasks button").first().click(); await page.locator("#prompt").fill("移除后不能调用"); await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: "执行失败" }).waitFor(); assert.equal(requests, 4); assert.match(await page.locator("#error-banner").innerText(), /移除或变化/); assert.deepEqual(errors, []);
  await writeFile(connectionFile, JSON.stringify({ id: "demo", title: "HTTP MCP 合成验收", transport: "http", url: `http://127.0.0.1:${mcpHttp.address().port}/mcp`, enabledTools: ["echo"] }));
  await openConnectors(); await page.locator("#import-mcp").click(); await waitForHumanConfirm(page, "确认导入"); await page.locator(".mcp-connection").waitFor();
  await runTask("允许这一次"); await explainApproved("approved HTTP call");
  assert.equal(httpCalls, 1); assert.equal(toolResult, true); assert.equal(requests, 6);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualCodex: true, actualMcpStdio: true, actualMcpHttp: true, explicitConnectionImport: true, noModelForProbe: true, toolAllowlist: true, deniedCallDidNotExecute: true, approvedToolResultReachedModel: true, removedConnectionRefused: true, slowApproval: Boolean(SLOW_APPROVAL_MS), approvalWaits, fixtureModelRequests: requests, paidCalls: 0, rendererErrors: errors }));
} catch (error) {
  // The banner and the status are often both empty when the application is
  // simply waiting for an answer, so the unanswered confirmation is reported
  // too -- otherwise a stale fixture fails with no reason at all.
  if (app) { const page = await app.firstWindow(); console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0], error: await page.locator("#error-banner").innerText().catch(() => "unavailable"), status: await page.locator("#task-status").innerText().catch(() => "unavailable"), pendingConfirm: await page.locator("#confirmations .confirm-card").innerText().catch(() => "") })); await page.screenshot({ path: path.join(evidence, "desktop-mcp-failure.png") }).catch(() => {}); }
  throw error;
} finally { await app?.close(); sessions.revoke(session.token); server.close(); server.closeAllConnections(); mcpHttp.close(); mcpHttp.closeAllConnections(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
