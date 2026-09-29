import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { EnterpriseSkillCatalog } from "../src/control-plane/skill-catalog.js";
import { skillFixture } from "./fixtures/skill-catalog.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { McpBroker } from "../src/control-plane/mcp-broker.js";
import { syntheticMcpHttp } from "./fixtures/mcp-http.js";
import { loginLaunchUrl } from "./fixtures/login-launch.js";
import { answerConfirm, waitForHumanChoice, waitForHumanConfirm, untilCard } from "./fixtures/agent-harness.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-skill-mcp-desktop-")), evidence = path.resolve("docs/evidence");
const enterpriseMode = process.argv.includes("--enterprise"), upstreamCredential = "synthetic-upstream-mcp-secret";
const upstream = enterpriseMode ? await syntheticMcpHttp({ credential: upstreamCredential }) : null;
await mkdir(evidence, { recursive: true });
const keys = generateKeyPairSync("ed25519"), publicKeyFile = path.join(directory, "public.pem"), connectionFile = path.join(directory, "connection.json"), callLog = path.join(directory, "calls.txt");
await writeFile(publicKeyFile, keys.publicKey.export({ format: "pem", type: "spki" })); await writeFile(callLog, "");
const toolLog = async () => enterpriseMode ? upstream.state.calls.map(() => "echo-called\n").join("") : readFile(callLog, "utf8");
const row = { id: "demo", title: "技能工具连接（合成测试）", transport: "stdio", command: process.execPath, args: [path.resolve("scripts/fixtures/mcp-stdio.js"), callLog], enabledTools: ["echo", "not_allowed"] };
await writeFile(connectionFile, JSON.stringify(row));
const bundle = { ...skillFixture(), title: "工具协作技能（合成测试）", requiredTools: ["mcp:demo:echo"] };
bundle.files = [{ path: "SKILL.md", text: "---\nname: enterprise-project-brief\ndescription: Synthetic tool integration skill.\n---\nUse the demo MCP echo tool with text SKILL_MCP_ONLY_MARKER. Never run shell tools or read files. Return the echo result." }];
const sessions = new SessionRegistry(); let login, skills, app, broker, requests = 0, injected = false, toolResult = false;
const mcpTokens = [], issueMcp = sessions.issueForMcp.bind(sessions);
sessions.issueForMcp = (...args) => { const lease = issueMcp(...args); mcpTokens.push(lease.token); return lease; };
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions,
  authHandler: async (req, res) => await login.handle(req, res) || await skills.handle(req, res) || Boolean(broker && await broker.handle(req, res)),
  fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    if (requests % 2 === 0) { toolResult = JSON.stringify(body.input).includes("MCP_EXECUTED:SKILL_MCP_ONLY_MARKER"); return syntheticResponseStream(toolResult ? "SKILL_MCP_RESULT_VERIFIED" : "SKILL_MCP_DECLINED"); }
    injected = JSON.stringify(body.input).includes("Use the demo MCP echo tool with text SKILL_MCP_ONLY_MARKER"); assert.equal(injected, true);
    // Descriptions carry the gateway's origin prefix; match the server's text at the end.
    assert.equal(body.tools.some((tool) => tool.description?.endsWith("Must never be offered")), false, "The skill must narrow a wider reviewed allowlist");
    const tool = body.tools.find((tool) => tool.description?.endsWith("Echo a synthetic test marker")); assert.ok(tool);
    const item = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name: tool.name, arguments: JSON.stringify({ text: "SKILL_MCP_ONLY_MARKER" }), status: "completed" };
    const events = [{ type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
if (enterpriseMode) broker = new McpBroker({ feishu: SAAS_FEISHU, origin, sessions, env: { MCP_TEST_KEY: upstreamCredential }, config: { schemaVersion: 1, revision: 1, connections: [{ id: "demo", title: "企业代理连接（合成测试）", url: upstream.url, tokenEnv: "MCP_TEST_KEY", grants: [{ tenantId: "tenant_fixture", appId: "cli_skill_mcp_fixture", userIds: ["ou_fixture"], enabledTools: ["echo", "not_allowed"] }] }] } });
skills = new EnterpriseSkillCatalog({ origin, sessions, privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }), catalog: { schemaVersion: 1, revision: 1, tenants: [{ tenantId: "tenant_fixture", skills: [bundle] }] } });
login = new FeishuLoginService({ origin, sessions, allowedTenants: ["tenant_fixture"], provider: new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_skill_mcp_fixture", appSecret: "synthetic-app-secret", fetchImpl: async (url) => url.endsWith("/open-apis/authen/v2/oauth/token")
  ? Response.json({ code: 0, access_token: "synthetic-feishu-token", token_type: "Bearer", expires_in: 3600 })
  : Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: "ou_fixture", name: "陈默（合成测试账号）" } }) }) });
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/login-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SERVER_URL: origin, IDOU_SKILL_PUBLIC_KEY_FILE: publicKeyFile }, timeout: 30000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000); const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  // Importing is a confirmed operation, so it is two halves: the call, and the
  // answer to the card it raises.
  const importConnection = async () => {
    const imported = page.evaluate(async (enterprise) => enterprise ? window.idou.importEnterpriseMcp((await window.idou.listEnterpriseMcp())[0]) : window.idou.importMcp(), enterpriseMode);
    await waitForHumanConfirm(page, "确认导入");
    return imported;
  };
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
  // Where this account's reviewed connections are kept. Used once, to make a
  // connection disappear while a confirmation card is waiting for an answer.
  const storedConnections = async () => {
    const root = path.join(directory, "data");
    const found = (await readdir(root, { recursive: true })).find((name) => name.endsWith("mcp-connections.json"));
    assert.ok(found, "the account must keep its reviewed connections in a file");
    return path.join(root, found);
  };
  await page.locator("#settings").click(); await page.locator("#login-begin").click(); await page.locator("#login-poll").waitFor();
  const launch = await fetch(await loginLaunchUrl(page, app, () => globalThis.loginFixture.launches), { redirect: "manual" }); assert.equal(launch.status, 302);
  const oauth = new URL(launch.headers.get("location")), cookie = launch.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${origin}/auth/feishu/callback?state=${oauth.searchParams.get("state")}&code=synthetic`, { headers: { cookie } })).status, 200);
  await page.locator("#login-confirm").click(); await page.locator("#account-name").filter({ hasText: "陈默" }).waitFor();
  // The connection picker and the use buttons live in the skill's detail
  // dialog, which opening the card verifies and shows.
  const openSkills = async () => {
    await page.locator('[data-section="skills"]').click(); await page.locator("#refresh-enterprise-skills").click();
    await page.locator("#refresh-enterprise-skills:not([disabled])").waitFor(); await page.locator(".enterprise-skill-card").waitFor();
    await page.locator(".enterprise-skill-card").click(); await page.locator("#skill-detail[open]").waitFor();
  };
  await openSkills(); await page.locator(".check-skill-mcp").click(); await page.getByText(/没有匹配连接/).waitFor();
  assert.equal(await page.locator('.use-enterprise-skill[data-mode="cowork"]').isDisabled(), true);
  const ref = (await page.evaluate(() => window.idou.listEnterpriseSkills())).skills[0];
  await assert.rejects(page.evaluate((ref) => window.idou.useEnterpriseSkill(ref, "cowork"), ref), /先选择/);
  // Only the file picker is still a native dialog. Every decision this script
  // makes is taken in the application's own confirmation card, so there is no
  // showMessageBox left to stub: the script reads the card the main process
  // actually drew and presses one of the buttons it actually offered.
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }); }, connectionFile);
  await page.locator("#close-skill-detail").click();
  await openConnectors();
  if (enterpriseMode) {
    // Listed on arrival: what the administrator opened to this account. The
    // person presses 添加 on its row, then answers the card that raises. A card
    // once answered keeps no buttons, so the script waits for the card to be
    // raised rather than for 添加 to go -- that only happens after the answer.
    await page.locator("#enterprise-connectors .add-enterprise-connection").waitFor();
    assert.doesNotMatch(await page.locator("#library").innerText(), new RegExp(upstreamCredential));
    await untilCard(page, "企业连接器「添加」");
    process.stdout.write("待人工操作：请在「企业连接器」里核对这一行并亲手点击“添加”\n");
    await page.locator("#confirmations .confirm-card").getByRole("button", { name: "确认导入", exact: true }).waitFor({ timeout: 1_800_000 });
    // The card lives outside the settings page, so it is checked separately:
    // the service credential stays on the server in every surface shown here.
    const imported = await waitForHumanConfirm(page, "确认导入");
    assert.doesNotMatch(imported, new RegExp(upstreamCredential)); assert.match(imported, /策略指纹/);
  } else {
    await page.locator("#import-mcp").click();
    const imported = await waitForHumanConfirm(page, "确认导入");
    assert.match(imported, /技能工具连接（合成测试）/); assert.match(imported, /请确认配置中没有密钥/);
  }
  await page.locator(".mcp-connection").waitFor();
  if (enterpriseMode) {
    const saved = await page.evaluate(() => window.idou.listMcp()); assert.equal(saved[0].transport, "enterprise"); assert.doesNotMatch(JSON.stringify(saved), /token|url|credential/);
    await connectionAction("mcp-more-menu", "检查连接");
    assert.match(await waitForHumanConfirm(page, "确认"), /不发送模型请求/);
    await page.getByText(/检查通过：2 个工具/).waitFor();
    assert.equal(requests, 0); assert.equal(broker.entries.size, 0); assert.equal([...sessions.sessions.values()].filter((row) => row.audience === "mcp-broker").length, 0);
    await page.locator(".mcp-connection").evaluate((card) => card.scrollIntoView({ block: "center" }));
    await page.screenshot({ path: path.join(evidence, "desktop-enterprise-mcp-fixture.png"), scale: "css" });
  }
  await openSkills(); await page.locator(".check-skill-mcp").click(); await page.locator('.skill-mcp-select option[value="demo"]').waitFor({ state: "attached" });
  assert.equal(await page.locator('.use-enterprise-skill[data-mode="cowork"]').isDisabled(), true, "Discovery must not auto-select a grant");
  await page.locator(".skill-mcp-select").selectOption("demo");
  await page.locator(".skill-dependencies").evaluate((block) => block.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: path.join(evidence, enterpriseMode ? "desktop-enterprise-mcp-binding-fixture.png" : "desktop-skill-mcp-binding-fixture.png"), scale: "css" });
  // Binding a connection to a task is answered in the window. Nothing is
  // pre-accepted: the cancelling answer is the focused one and no button is
  // marked as the default, so the card cannot be dismissed into consent.
  const confirmation = page.locator("#confirmations .confirm-card");
  await page.locator('.use-enterprise-skill[data-mode="cowork"]').click(); await confirmation.waitFor();
  const detail = await confirmation.innerText();
  assert.deepEqual(await confirmation.locator(".confirm-actions button").allInnerTexts(), ["取消", "确认用于新任务"]);
  assert.equal(await confirmation.locator("button.primary").count(), 0, "同意不能是默认答案");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "取消");
  assert.match(detail, /本任务仅开放：echo/); assert.match(detail, /连接指纹/); assert.match(detail, /不受任务文件沙箱隔离/);
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.use-enterprise-skill[data-mode="cowork"]').disabled);
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.length, 0); assert.equal(requests, 0); assert.equal(await toolLog(), "");
  // A connection that changed while the confirmation was open must not be used.
  // Confirmations are in-app and only one can be outstanding, so the change can
  // no longer arrive as a second dialog -- the application refuses to raise one,
  // which is asserted here -- and the connection instead disappears the way it
  // still can while a card waits: this account's stored connections change
  // underneath it. What is under test is the re-check after the answer.
  await page.locator('.use-enterprise-skill[data-mode="cowork"]').click(); await confirmation.waitFor();
  const binding = (await page.evaluate(() => window.idou.listMcp()))[0];
  await assert.rejects(page.evaluate((row) => window.idou.removeMcp(row), binding), /请先回应当前的确认/);
  await writeFile(await storedConnections(), "[]");
  await waitForHumanChoice(confirmation, "确认用于新任务");
  await page.locator("#error-banner").filter({ hasText: "移除或变化" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.snapshot())).tasks.length, 0); assert.equal(requests, 0);
  await importConnection();
  const create = async () => { await page.locator('.use-enterprise-skill[data-mode="cowork"]').click(); await waitForHumanConfirm(page, "确认用于新任务"); await page.locator("#task-skill-label").waitFor(); await page.locator("#task-mcp-label").waitFor(); };
  const run = async (decision) => {
    await page.locator("#prompt").fill("执行绑定的技能。只使用声明的工具。"); await page.locator("#send").click();
    await page.waitForFunction(() => document.querySelector("#approvals").textContent.includes("确认 MCP 工具调用") || document.querySelector("#task-status").textContent === "执行失败", null, { timeout: 40000 });
    assert.notEqual(await page.locator("#task-status").innerText(), "执行失败", await page.locator("#error-banner").innerText());
    // A work task folds the call's arguments under 技术详情 (since 2026-09-21,
    // aea0672); a person opens it to read what they are approving, and so does this.
    await page.locator("#approvals .approval-technical > summary").first().click();
    assert.match(await page.locator("#approvals").innerText(), /SKILL_MCP_ONLY_MARKER/);
    assert.equal(await toolLog(), "");
    if (decision === "允许这一次") await page.screenshot({ path: path.join(evidence, enterpriseMode ? "desktop-enterprise-mcp-approval-fixture.png" : "desktop-skill-mcp-approval-fixture.png"), scale: "css" });
    if (decision === "拒绝") await page.getByRole("button", { name: decision, exact: true }).click();
    else await waitForHumanChoice(page.locator("#approvals .approval").first(), decision);
    await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor({ timeout: 40000 });
  };
  await create(); await run("拒绝"); assert.equal(toolResult, false); assert.equal(await toolLog(), "");
  await openSkills(); await page.locator(".check-skill-mcp").click(); await page.locator('.skill-mcp-select option[value="demo"]').waitFor({ state: "attached" }); await page.locator(".skill-mcp-select").selectOption("demo");
  await create(); await run("允许这一次"); assert.equal(toolResult, true); assert.equal(await toolLog(), "echo-called\n");
  assert.match(await page.locator("#messages").innerText(), /SKILL_MCP_RESULT_VERIFIED/);
  const task = (await page.evaluate(() => window.idou.snapshot())).tasks[0]; assert.deepEqual(task.mcpConnection.enabledTools, ["echo"]); assert.ok(task.enterpriseSkill.digest);
  await openConnectors(); await connectionAction("mcp-more-menu", "移除");
  assert.match(await waitForHumanConfirm(page, "移除连接"), /绑定此连接的任务将不能继续发送/);
  await page.locator(".mcp-connection").waitFor({ state: "detached" });
  await page.locator("#recent-tasks button").first().click(); await page.locator("#prompt").fill("移除连接后不得发送"); await page.locator("#send").click(); await page.locator("#error-banner").filter({ hasText: "移除或变化" }).waitFor();
  assert.equal(requests, 4); assert.equal(await page.locator(".message.user").count(), 1); assert.equal(await page.locator("#prompt").inputValue(), "移除连接后不得发送");
  await openConnectors(); await importConnection();
  skills.catalog.tenants.set("tenant_fixture", []); skills.catalog.revision++;
  await page.locator("#recent-tasks button").first().click(); await page.locator("#prompt").fill("技能撤回后不得发送"); await page.locator("#send").click(); await page.locator("#error-banner").filter({ hasText: "已下架" }).waitFor();
  assert.equal(requests, 4); assert.equal(await page.locator(".message.user").count(), 1); assert.equal(await toolLog(), "echo-called\n"); assert.deepEqual(errors, []);
  if (enterpriseMode) {
    assert.equal(broker.entries.size, 0); assert.equal([...sessions.sessions.values()].filter((row) => row.audience === "mcp-broker").length, 0); assert.ok(upstream.state.authMatches.every(Boolean));
    const snapshot = JSON.stringify(await page.evaluate(() => window.idou.snapshot()));
    for (const secret of [upstreamCredential, ...mcpTokens]) assert.equal(snapshot.includes(secret), false, "Renderer state must not contain broker credentials");
    // Isolated fixture user-data only: ensure neither provider keys nor scoped MCP
    // tokens were written to task records, Codex config/history or other app files.
    for (const file of await readdir(path.join(directory, "data"), { recursive: true, withFileTypes: true })) if (file.isFile()) {
      const bytes = await readFile(path.join(file.parentPath, file.name));
      for (const secret of [upstreamCredential, ...mcpTokens]) assert.equal(bytes.includes(Buffer.from(secret)), false, `Credential persisted in ${file.name}`);
    }
  }
  console.log(JSON.stringify({ passed: true, enterpriseBroker: enterpriseMode, actualCodex: true, signedCatalog: true, actualMcp: true, narrowedAllowlist: true, explicitBinding: true, inAppConfirmation: true, cancellationRefused: true, secondConfirmationRefused: true, changedDuringConfirmationRefused: true, deniedCallNotExecuted: true, skillInjected: injected, toolResultReachedModel: toolResult, removedConnectionRefusedBeforePersistence: true, withdrawnSkillRefused: true, fixtureModelRequests: requests, paidCalls: 0, rendererErrors: errors }));
} catch (error) {
  if (app) { const page = await app.firstWindow(); console.error(JSON.stringify({ error: await page.locator("#error-banner").innerText().catch(() => "unavailable"), upstreamAuthMatches: upstream?.state.authMatches })); await page.screenshot({ path: path.join(evidence, "desktop-skill-mcp-failure.png") }).catch(() => {}); }
  throw error;
} finally { await app?.close(); await broker?.close(); await upstream?.close(); login.close(); server.close(); server.closeAllConnections(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
