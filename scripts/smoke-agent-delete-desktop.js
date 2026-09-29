// End-to-end acceptance for deletion through the Agent's Feishu channel.
//
// A real Codex agent, driven by a synthetic model, runs the real shim twice: a
// Base record deletion through the general CLI route, and a task deletion
// through the application's own command. Each must raise the red deletion card
// with focus on 取消, reach Feishu only after 确认删除 is clicked, travel under
// a cli.delete grant, and -- for the Base command, which the pinned CLI files
// as high-risk -- get through the CLI's own --yes gate only because the
// application added it after the click. A cancelled deletion must write
// nothing. Only Feishu itself and the model are synthetic.
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
import { answerConfirm, bringToPerson } from "./fixtures/agent-harness.js";
import { agentCommand } from "./fixtures/model-response.js";

const BASE = "SyntheticBase7788990011", TABLE = "tblSynthetic01";
const RECORDS_PATH = `/open-apis/base/v3/bases/${BASE}/tables/${TABLE}/records/batch_delete`;
const TASK = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", TASK_PATH = `/open-apis/task/v2/tasks/${TASK}`;
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-agent-delete-")), dataRoot = path.join(directory, "app-data");
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });

const sessions = new SessionRegistry(), upstream = [], audits = [];
let modelRequests = 0, toolCalls = 0, scriptIndex = 0, shellToolName = null;
const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_agent_delete",
  cliProxyScopes: ["fixture:read", "fixture.base:write"], cliWriteActions: ["cli.write", "cli.delete"] });
const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_agent_delete", appSecret: "synthetic-app-secret", sessions, sourceAccess,
  fetchImpl: async url => url.endsWith("/open-apis/authen/v2/oauth/token")
    ? Response.json({ code: 0, access_token: "synthetic-server-only-uat", token_type: "Bearer", expires_in: 900, scope: sourceAccess.requiredScopes.join(" ") })
    : Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_agent", name: "删除验收用户" } }) });

let login, app;
const proxy = new FeishuCliProxyService({ sourceAccess, audit: event => audits.push(event), fetchImpl: async (url, options) => {
  const body = options.body ? Buffer.from(options.body).toString("utf8") : null;
  upstream.push({ url, method: options.method, body, authorization: options.headers.authorization });
  if (url.endsWith(RECORDS_PATH) && options.method === "POST") {
    assert.deepEqual(JSON.parse(body), { record_id_list: ["recSyntheticA1", "recSyntheticB2"] });
    return Response.json({ code: 0, data: { deleted: 2 } });
  }
  if (url.endsWith(TASK_PATH) && options.method === "DELETE") { assert.equal(body, null, "a DELETE carries no body"); return Response.json({ code: 0, data: {} }); }
  if (url.includes(TASK_PATH) && options.method === "GET") return Response.json({ code: 0, data: { task: { guid: TASK, summary: "合成验收任务（待删除）", completed_at: "0", members: [] } } });
  return Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_agent", user_id: "agent-user", name: "删除验收用户" } });
} });

// Turn 1 deletes two Base records and the person confirms. Turn 2 deletes the
// same records again and the person cancels. Turn 3 deletes a task and the
// person confirms. Turn 4 reads back and ends.
// Run the way the application tells the Agent to (agentCommand): the agent
// tool by its launcher, as a command of its own.
const SCRIPTS = [
  (tool) => `${tool} run -- base +record-delete --base-token ${BASE} --table-id ${TABLE} --record-id recSyntheticA1 --record-id recSyntheticB2`,
  (tool) => `${tool} run -- base +record-delete --base-token ${BASE} --table-id ${TABLE} --record-id recSyntheticA1 --record-id recSyntheticB2`,
  (tool) => `${tool} task-delete --task-id ${TASK}`,
];
const latestToolOutput = body => {
  const row = [...(body.input ?? [])].reverse().find(item => /output/.test(item?.type ?? "") && Object.hasOwn(item, "output"));
  return typeof row?.output === "string" ? row.output : row ? JSON.stringify(row.output) : "";
};
const runningSession = output => {
  const match = String(output).match(/(?:"session_id"\s*:\s*|session[_ ]id\D+)(\d+)/i);
  return match ? Number(match[1]) : null;
};
const server = createModelGateway({ sessions, apiKey: "synthetic-model-key",
  authHandler: async (req, res) => await login.handle(req, res) || await proxy.handle(req, res),
  fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); modelRequests++;
    const stream = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const output = latestToolOutput(body), sessionId = runningSession(output);
    let name, args;
    if (sessionId !== null) {
      const poll = body.tools?.find(item => item.name === "write_stdin");
      assert.ok(poll, "write_stdin is required to keep a confirmation-bound command attached");
      name = poll.name; args = { session_id: sessionId, chars: "", yield_time_ms: 30_000, max_output_tokens: 4000 };
    } else if (output) {
      scriptIndex += 1;
    }
    if (!name && scriptIndex >= SCRIPTS.length) {
      return stream([{ type: "response.created", response: { id: "resp_final", status: "in_progress", output: [] } },
        { type: "response.completed", response: { id: "resp_final", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "AGENT_DELETE_DONE" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
    }
    if (!name) {
      const tool = body.tools?.find(item => /^(shell|local_shell|exec_command)$/.test(item.name ?? item.type));
      assert.ok(tool, "no shell tool offered");
      shellToolName = tool.name ?? tool.type; name = shellToolName;
      args = { cmd: SCRIPTS[scriptIndex](agentCommand(body)), yield_time_ms: 30_000, max_output_tokens: 4000 };
    }
    toolCalls += 1;
    const item = { type: "function_call", id: `fc_${toolCalls}`, call_id: `call_${toolCalls}`, name,
      arguments: JSON.stringify(args), status: "completed" };
    return stream([{ type: "response.created", response: { id: `resp_${modelRequests}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${modelRequests}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
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
  const launchUrl = (await page.evaluate(() => window.idou.authStatus())).launchUrl;
  const launch = await fetch(launchUrl, { redirect: "manual" });
  const authorize = new URL(launch.headers.get("location")), cookie = launch.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${origin}/auth/feishu/callback?state=${authorize.searchParams.get("state")}&code=synthetic`, { headers: { cookie } })).status, 200);
  await page.locator("#login-identity").waitFor();
  assert.equal((await page.evaluate(() => window.idou.authStatus())).pendingIdentity.cliDestructiveWrites, true, "the login advertises the deletion capability");
  await page.locator("#login-confirm").click(); await page.locator("#account-name").filter({ hasText: "删除验收用户" }).waitFor();

  // Send through the visible composer. Besides matching the person's path, this
  // makes the newly created task current before its task-scoped confirmation is
  // raised; creating through the main-process API alone would correctly leave
  // that card hidden because no task had been opened in the renderer.
  await page.locator('[data-section="cowork"]').click();
  await page.locator("#prompt").fill("删掉那两条重复的记录，再删掉那个任务。");
  await page.locator("#send").click();
  const task = await page.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const snapshot = await window.idou.snapshot();
      if (snapshot.tasks.length) return snapshot.tasks.at(-1);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("the deletion task was not created");
  });
  const card = page.locator("#confirmations .confirm-card");
  const deletionCard = async (text, previousId = null) => {
    const found = await page.waitForFunction(({ text: value, previousId }) => {
      const node = document.querySelector("#confirmations .confirm-card"), detail = node?.querySelector("pre")?.textContent ?? "";
      if (!detail.includes(value) || (previousId && node.dataset.confirmId === previousId)) return false;
      return { id: node.dataset.confirmId, danger: node.classList.contains("danger"), title: node.querySelector("strong")?.textContent ?? "",
        buttons: [...node.querySelectorAll(".confirm-actions button")].map(button => ({ label: button.textContent, className: button.className })),
        focused: document.activeElement?.textContent ?? "", detail, boundary: node.querySelector(".confirm-boundary")?.textContent ?? "" };
    }, { text, previousId }, { timeout: 180_000 });
    return found.jsonValue();
  };
  // Observe rather than poll the positive button. A person can click as soon as
  // the card paints; Playwright polling may otherwise miss the short interval
  // between that paint and the click and wait forever for an already completed
  // choice. The observer never dispatches an event and is scoped to one card's
  // detail text and id.
  const observeHumanChoice = (detailText, label) => page.evaluate(({ detailText, label }) => new Promise((resolve, reject) => {
    let confirmationId = null, cardText = "";
    const host = document.querySelector("#confirmations");
    const inspect = () => {
      const node = host?.querySelector(".confirm-card"), detail = node?.querySelector("pre")?.textContent ?? "";
      const button = [...(node?.querySelectorAll(".confirm-actions button") ?? [])].find(item => item.textContent === label);
      if (!confirmationId && detail.includes(detailText) && button) { confirmationId = node.dataset.confirmId; cardText = node.innerText; }
      if (confirmationId && (node?.dataset.confirmId !== confirmationId || !button)) { clearTimeout(timer); observer.disconnect(); resolve(cardText); }
    };
    const observer = new MutationObserver(inspect), timer = setTimeout(() => { observer.disconnect(); reject(new Error(`human choice timed out: ${label}`)); }, 300_000);
    observer.observe(host, { subtree: true, childList: true, attributes: true }); inspect();
  }), { detailText, label });

  // 1. Base records: red card, 取消 focused, nothing sent before the click.
  const firstChoice = observeHumanChoice("recSyntheticA1", "确认删除");
  process.stdout.write("待人工操作：请在应用中核对第一张卡片并亲手点击“确认删除”\n");
  const first = await deletionCard("recSyntheticA1");
  assert.equal(first.danger, true, "a deletion is drawn as one");
  assert.equal(first.title, "确认删除多维表格记录");
  assert.deepEqual(first.buttons, [{ label: "取消", className: "" }, { label: "确认删除", className: "danger" }]);
  assert.equal(first.focused, "取消", "a stray Enter cancels");
  assert.match(first.detail, /删除 2 条记录：recSyntheticA1、recSyntheticB2/);
  assert.match(first.detail, /记录删除后无法在这里恢复/);
  assert.match(first.boundary, /只能用于它的一次性删除许可/);
  assert.equal(upstream.filter(call => call.url.endsWith(RECORDS_PATH)).length, 0, "no deletion before the click");
  await page.screenshot({ path: path.join(evidence, "desktop-agent-delete-confirm.png"), scale: "css" });
  await bringToPerson(page, "确认删除（多维表格记录）");
  await firstChoice;

  // 2. The same deletion, cancelled: nothing is sent and no grant is issued.
  await deletionCard("recSyntheticA1", first.id);
  const grantsBeforeCancel = audits.filter(event => event.kind === "grant_issued").length;
  const thirdChoice = observeHumanChoice("合成验收任务（待删除）", "确认删除");
  await answerConfirm(page, "取消");

  // 3. A task, by the application's own command: the card names the task it read.
  process.stdout.write("中间卡片已由脚本取消；第三张卡片出现后请亲手点击“确认删除”\n");
  const third = await deletionCard("合成验收任务（待删除）");
  assert.equal(third.danger, true); assert.equal(third.title, "确认删除任务");
  assert.match(third.detail, new RegExp(`DELETE ${TASK_PATH}`));
  assert.equal(audits.filter(event => event.kind === "grant_issued").length, grantsBeforeCancel, "a cancelled deletion is never granted");
  await bringToPerson(page, "确认删除（任务）");
  await thirdChoice;

  const finished = await page.evaluate(async id => {
    for (let attempt = 0; attempt < 900; attempt++) {
      const snapshot = await window.idou.snapshot(), current = snapshot.tasks.find(row => row.id === id);
      if (current && !["running", "awaiting_approval", "stopping"].includes(current.status)) return current;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("the agent turn did not finish");
  }, task.id);
  assert.equal(finished.status, "completed", finished.error);

  const recordDeletes = upstream.filter(call => call.url.endsWith(RECORDS_PATH));
  assert.equal(recordDeletes.length, 1, "exactly one record deletion reaches Feishu (the cancelled one never does)");
  const taskDeletes = upstream.filter(call => call.url.endsWith(TASK_PATH) && call.method === "DELETE");
  assert.equal(taskDeletes.length, 1, "exactly one task deletion reaches Feishu");
  assert.ok(upstream.every(call => call.authorization === "Bearer synthetic-server-only-uat"));
  const writes = audits.filter(event => event.kind === "grant_issued");
  assert.deepEqual(writes.map(event => event.action), ["cli.delete", "cli.delete"], "every deletion travelled under a deletion grant");
  assert.deepEqual(audits.map(event => event.kind), ["grant_issued", "dispatch_started", "upstream_finished", "grant_issued", "dispatch_started", "upstream_finished"]);
  assert.doesNotMatch(JSON.stringify(audits), /recSynthetic|合成验收任务|synthetic-server-only-uat/, "the audit carries no content or token");
  assert.deepEqual(errors, []);
  await app.close(); app = null;
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualCodexAgent: true, actualPinnedCli: true, shellTool: shellToolName,
    redCard: true, cancelFocused: true, cancelledDeletionWritesNothing: true, cliDeleteGrantsOnly: true, cliYesGateAnsweredByApp: true,
    syntheticDeletions: recordDeletes.length + taskDeletes.length, liveFeishuWrites: 0, syntheticModelCalls: modelRequests, paidCalls: 0 }));
} finally {
  await app?.close().catch(() => {});
  server.close(); await Promise.resolve(proxy.close?.()).catch(() => {});
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
