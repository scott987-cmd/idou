// End-to-end acceptance for the Agent's Feishu write channel.
//
// A real Codex agent, driven by a synthetic model, runs the real shim as a child
// process. The shim reaches the real loopback bridge, which asks for the real
// in-app confirmation; the smoke clicks the rendered button. On approval the
// real provider runs the real pinned lark-cli through the real sidecar, which
// obtains a real one-shot grant from a real control plane and is validated
// against the real write contract. Only Feishu itself and the model are
// synthetic, so no live tenant is touched and nothing is billed.
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
import { observeHumanChoice, bringToPerson } from "./fixtures/agent-harness.js";
import { agentCommand } from "./fixtures/model-response.js";

const TITLE = "季度调研纪要（合成验收）";
const SHEET = "SyntheticBook7788990011";
const SHEET_PATH = `/open-apis/sheet_ai/v2/spreadsheets/${SHEET}/tools/invoke_write`;
const MARKDOWN = `# ${TITLE}\n\n本文由 Agent 写入通道创建。\n\n- 结论一\n- 结论二\n`;
const CREATED = "AgentAuthoredDoc7788990011";
const CREATE_TASK = "doctaskAgent7788990011";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-agent-feishu-")), dataRoot = path.join(directory, "app-data");
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });

const sessions = new SessionRegistry(), upstream = [], audits = [];
let modelRequests = 0, toolCalls = 0, scriptIndex = 0, shellToolName = null, shimOutput = "", offered = [], instructed = false;

const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_agent_write",
  cliProxyScopes: ["fixture:read", "fixture.docs:write"], cliWriteActions: ["document.create", "cli.write"] });
const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_agent_write", appSecret: "synthetic-app-secret", sessions, sourceAccess,
  fetchImpl: async url => url.endsWith("/open-apis/authen/v2/oauth/token")
    ? Response.json({ code: 0, access_token: "synthetic-server-only-uat", token_type: "Bearer", expires_in: 900, scope: sourceAccess.requiredScopes.join(" ") })
    : Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_agent", name: "写入通道用户" } }) });

let login, app;
const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
  upstream.push({ url, method: options.method, authorization: options.headers.authorization });
  if (url.endsWith("/open-apis/docs_ai/v1/documents") && options.method === "POST") {
    const body = JSON.parse(Buffer.from(options.body).toString("utf8"));
    // The grant already bound this, but assert it here too so a contract change
    // that loosened the binding cannot pass silently.
    assert.equal(body.format, "markdown");
    assert.equal(body.content, MARKDOWN, "the created document must be exactly the confirmed Markdown");
    // Answered the way an async creation is (1.0.96 asks for one): a task, which
    // the CLI must be let through to poll, and then read as settled.
    return Response.json({ code: 0, data: { task: { task_id: CREATE_TASK, status: "processing", poll_after_ms: 100 } } });
  }
  if (url.endsWith(`/open-apis/docs_ai/v1/async_tasks/${CREATE_TASK}`) && options.method === "GET") {
    return Response.json({ code: 0, data: { task: { task_id: CREATE_TASK, status: "succeeded",
      result: { create_document: JSON.stringify({ document: { document_id: CREATED, revision_id: 1, url: `https://fixture.feishu.cn/docx/${CREATED}` } }) } } } });
  }
  if (url.endsWith(SHEET_PATH) && options.method === "POST") {
    const body = JSON.parse(Buffer.from(options.body).toString("utf8"));
    assert.equal(body.tool_name, "set_cell_range");
    assert.deepEqual(JSON.parse(body.input).cells, [[{ value: "甲" }, { value: "乙" }]]);
    return Response.json({ code: 0, data: { revision: 2, updated_cells_count: 2 } });
  }
  return Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_agent", user_id: "agent-user", name: "写入通道用户" } });
} });

// Run the way the application tells the Agent to (agentCommand): the agent
// tool by its launcher, as a command of its own, after the file it reads was
// written by one before it.
const SCRIPTS = [
  () => `cat > draft.md <<'MD'\n${MARKDOWN}MD`,
  (tool) => `${tool} doc-create --content-file draft.md`,
  (tool) => `${tool} run -- sheets +cells-set --spreadsheet-token ${SHEET} --sheet-name Sheet1 --range A1:B1 --cells '[[{"value":"甲"},{"value":"乙"}]]'`,
];
const latestToolOutput = body => {
  const row = [...(body.input ?? [])].reverse().find(item => /output/.test(item?.type ?? "") && Object.hasOwn(item, "output"));
  return typeof row?.output === "string" ? row.output : row ? JSON.stringify(row.output) : "";
};
const runningSession = output => {
  const match = String(output).match(/(?:"session_id"\s*:\s*|session[_ ]id\D+)(\d+)/i);
  return match ? Number(match[1]) : null;
};

// Each confirmed CLI write can keep exec_command attached in the background.
// Follow that session until it really finishes before issuing the next write.
const server = createModelGateway({ sessions, apiKey: "synthetic-model-key",
  authHandler: async (req, res) => await login.handle(req, res) || await proxy.handle(req, res),
  fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); modelRequests++;
    const stream = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const output = latestToolOutput(body), sessionId = runningSession(output);
    if (output) shimOutput += output;
    let name, args;
    if (sessionId !== null) {
      const poll = body.tools?.find(item => item.name === "write_stdin");
      assert.ok(poll, "write_stdin is required to keep a confirmation-bound command attached");
      name = poll.name;
      args = { session_id: sessionId, chars: "", yield_time_ms: 30_000, max_output_tokens: 4000 };
    } else if (output) {
      scriptIndex += 1;
    }
    if (!name && scriptIndex >= SCRIPTS.length) {
      return stream([{ type: "response.created", response: { id: "resp_final", status: "in_progress", output: [] } },
        { type: "response.completed", response: { id: "resp_final", status: "completed",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "AGENT_WRITE_DONE" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
    }
    offered = body.tools?.map(item => item.name ?? item.type) ?? [];
    instructed = /idou-agent|agent\.js/.test(JSON.stringify(body.instructions ?? "") + JSON.stringify(body.input ?? ""));
    assert.ok(instructed, "the Agent must be told how to request a Feishu write");
    if (!name) {
      const tool = body.tools?.find(item => /^(shell|local_shell|exec_command)$/.test(item.name ?? item.type));
      assert.ok(tool, `no shell tool offered; got ${JSON.stringify(offered)}`);
      shellToolName = tool.name ?? tool.type;
      name = shellToolName;
      args = { cmd: SCRIPTS[scriptIndex](agentCommand(body)), yield_time_ms: 30_000, max_output_tokens: 4000 };
    }
    toolCalls += 1;
    const item = { type: "function_call", id: `fc_${toolCalls}`, call_id: `call_${toolCalls}`, name,
      arguments: JSON.stringify(args), status: "completed" };
    const responseId = `resp_${modelRequests}`;
    const events = [{ type: "response.created", response: { id: responseId, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: responseId, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return stream(events);
  } });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
login = new FeishuLoginService({ origin, provider, sessions, allowedTenants: ["tenant_fixture"] });

try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/agent-feishu-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: dataRoot, IDOU_SERVER_URL: origin }, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));

  await page.locator("#settings").click(); await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
  // Sign-in opens inside the app rather than the system browser, so the smoke
  // takes the launch URL from auth status and completes the callback itself.
  const launchUrl = (await page.evaluate(() => window.idou.authStatus())).launchUrl;
  assert.ok(launchUrl, "sign-in must produce a launch URL");
  const launch = await fetch(launchUrl, { redirect: "manual" });
  const authorize = new URL(launch.headers.get("location")), cookie = launch.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${origin}/auth/feishu/callback?state=${authorize.searchParams.get("state")}&code=synthetic`, { headers: { cookie } })).status, 200);
  await page.locator("#login-identity").waitFor();
  assert.equal((await page.evaluate(() => window.idou.authStatus())).pendingIdentity.cliDocumentWrites, true);
  await page.locator("#login-confirm").click(); await page.locator("#account-name").filter({ hasText: "写入通道用户" }).waitFor();

  const firstChoice = observeHumanChoice(page, { detailText: TITLE, label: "确认新建" });
  const sheetChoice = observeHumanChoice(page, { detailText: "set_cell_range", label: "确认执行" });
  await page.locator('[data-section="cowork"]').click();
  await page.locator("#prompt").fill("把这次调研写成一篇飞书文档，再把摘要写进指定电子表格。");
  await page.locator("#send").click();
  const task = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await window.idou.snapshot();
      if (snapshot.tasks.length) return snapshot.tasks.at(-1);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("the Feishu write task was not created");
  });

  // The confirmation is the whole point: nothing may reach Feishu before it.
  const card = page.locator("#confirmations .confirm-card");
  try { await card.waitFor({ timeout: 120_000 }); }
  catch (error) {
    const current = await page.evaluate(async id => (await window.idou.snapshot()).tasks.find(row => row.id === id), task.id);
    console.error(JSON.stringify({ diagnostic: true, modelRequests, shellToolName, offered, instructed, toolEcho: shimOutput.slice(0, 900), status: current?.status, error: current?.error,
      messages: current?.messages?.map(message => ({ role: message.role, text: String(message.text ?? "").slice(0, 700) })) }, null, 2));
    throw error;
  }
  const detail = await card.locator("pre").innerText();
  assert.match(detail, new RegExp(TITLE), "the prompt must name the document being created");
  assert.match(detail, /结论一/, "the prompt must show the content, not a summary of it");
  assert.equal(upstream.filter(call => call.method === "POST" && call.url.endsWith("/documents")).length, 0, "no write may occur before the confirmation");
  await page.screenshot({ path: path.join(evidence, "desktop-agent-feishu-confirm.png"), scale: "css" });
  process.stdout.write("待人工操作：请核对文档内容并亲手点击“确认新建”\n");
  await bringToPerson(page, "确认新建（飞书文档）");
  await firstChoice;

  // Second turn: a spreadsheet write the product never encoded a shape for. The
  // prompt must still show the actual change, and nothing may reach the
  // spreadsheet before it is approved.
  await page.waitForFunction(() => document.querySelector("#confirmations .confirm-card pre")?.textContent?.includes("set_cell_range") ?? false, undefined, { timeout: 180_000 });
  const sheetDetail = await card.locator("pre").innerText();
  assert.match(sheetDetail, /写入电子表格|set_cell_range/);
  assert.match(sheetDetail, /甲/, "the prompt must show the values being written");
  assert.match(sheetDetail, new RegExp(SHEET), "the prompt must name the spreadsheet");
  assert.equal(upstream.filter(call => call.url.endsWith(SHEET_PATH)).length, 0, "no spreadsheet write may occur before the confirmation");
  await page.screenshot({ path: path.join(evidence, "desktop-agent-feishu-sheet-confirm.png"), scale: "css" });
  process.stdout.write("待人工操作：请核对电子表格目标和值并亲手点击“确认执行”\n");
  await bringToPerson(page, "确认执行（电子表格）");
  await sheetChoice;

  const finished = await page.evaluate(async id => {
    for (let attempt = 0; attempt < 900; attempt++) {
      const snapshot = await window.idou.snapshot(), current = snapshot.tasks.find(row => row.id === id);
      if (current && !["running", "awaiting_approval", "stopping"].includes(current.status)) return current;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("the agent turn did not finish");
  }, task.id);
  assert.equal(finished.status, "completed", finished.error);

  // Exactly one write, carrying the server-only token, and the shim handed the
  // Agent back the new document rather than a transient identifier.
  const writes = upstream.filter(call => call.method === "POST" && call.url.endsWith("/documents"));
  assert.equal(writes.length, 1, "exactly one document write reaches Feishu");
  assert.equal(upstream.filter(call => call.url.endsWith(`/async_tasks/${CREATE_TASK}`)).length, 1, "and its task is polled until it settles");
  const sheetWrites = upstream.filter(call => call.url.endsWith(SHEET_PATH));
  assert.equal(sheetWrites.length, 1, "exactly one spreadsheet write reaches Feishu");
  // The dry run must not have touched the network: planning is offline, so the
  // only spreadsheet request is the confirmed one.
  assert.equal(upstream.filter(call => call.url.includes("/sheet_ai/")).length, 1, "planning must not reach Feishu");
  assert.ok(upstream.every(call => call.authorization === "Bearer synthetic-server-only-uat"));
  assert.match(shimOutput, new RegExp(CREATED), "the Agent must receive the created document reference");
  assert.deepEqual(audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished", "grant_issued", "dispatch_started", "upstream_finished"]);
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(`${TITLE}|结论一|${CREATED}|synthetic-server-only-uat`), "the audit carries no content, resource or token");
  assert.doesNotMatch(await page.locator("body").innerText(), /synthetic-server-only-uat|synthetic-app-secret|synthetic-model-key/);

  // The Feishu document section borrows the one Agent panel rather than growing
  // a second conversation, so the risk is that leaving the section destroys it.
  // Dock it, come back, and check the same conversation still sends.
  await page.evaluate(() => window.idou.openFeishuView({ kind: "document", url: "https://fixture.feishu.cn/docx/OriginSeed11223344", bounds: { x: 0, y: 0, width: 10, height: 10 } })).catch(() => {});
  await page.locator("nav [data-section=feishu-docs]").click();
  const docked = await page.waitForFunction(() => {
    const dock = document.getElementById("feishu-agent-dock");
    return dock?.contains(document.getElementById("agent-panel")) ? { note: document.getElementById("feishu-dock-note")?.textContent ?? "", composer: !document.getElementById("composer").hidden } : null;
  }, undefined, { timeout: 30_000 }).then(handle => handle.jsonValue()).catch(() => null);
  assert.ok(docked, "the Agent panel must dock beside the Feishu document page");
  assert.equal(docked.composer, true, "the composer must be usable while docked");
  await page.screenshot({ path: path.join(evidence, "desktop-agent-feishu-dock.png"), scale: "css" });

  await page.locator("nav [data-section=cowork]").click();
  await page.waitForFunction(() => document.getElementById("agent-panel")?.parentElement?.id === "work-area", undefined, { timeout: 20_000 });
  await page.evaluate(id => window.idou.send(id, "还能继续对话吗？"), task.id);
  const resumed = await page.evaluate(async id => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const snapshot = await window.idou.snapshot(), current = snapshot.tasks.find(row => row.id === id);
      if (current && !["running", "awaiting_approval", "stopping"].includes(current.status)) return current;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("the resumed turn did not finish");
  }, task.id);
  assert.equal(resumed.status, "completed", resumed.error);
  assert.ok(resumed.messages.some(message => message.text?.includes("还能继续对话吗？")), "the conversation must survive docking");

  assert.deepEqual(errors, []);

  await app.close(); app = null;
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualCodexAgent: true, actualPinnedCli: true,
    shellTool: shellToolName, confirmedBeforeWrite: true, agentPanelDocksAndReturns: true, oneShotGrantConsumed: true, bodyFreeAudit: true,
    syntheticWrites: writes.length + sheetWrites.length, generalCliWriteVerified: true, liveFeishuWrites: 0, syntheticModelCalls: modelRequests, paidCalls: 0, rendererErrors: errors }));
} finally {
  await app?.close().catch(() => {});
  server.close(); await Promise.resolve(proxy.close?.()).catch(() => {});
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
