import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { waitForHumanChoice } from "./fixtures/agent-harness.js";

// A coding project told to run a command without asking again, in the actual
// Electron app with the actual Codex against a scripted model (no paid call) --
// Claude Code's "Yes, and don't ask again … in this project"
// (src/application/approval-rules.js).
//
// The Agent asks three times to run a command outside the sandbox. The first
// time the card offers to remember Codex's own proposal for it, and the person
// takes that. The second time the same command goes through with no card and
// the step says why. The third time the command carries a second one after
// `&&` -- for which Codex proposes just the first, so trusting the proposal
// would run the rest unasked -- and the card is back. 设置 lists the rule, and
// forgetting it there empties the list.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-coding-approvals-"));
const workspace = path.join(directory, "workspace");
await mkdir(workspace);
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
const COMMANDS = ["npm --version", "npm --version", "npm --version && echo injected"];
let app, requests = 0;

const escalated = (cmd) => {
  const item = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name: "exec_command", status: "completed",
    arguments: JSON.stringify({ cmd, sandbox_permissions: "require_escalated", justification: "需要在沙箱外面跑" }) };
  const events = [{ type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
// Every coding task plans first and that turn is read-only, so it proposes and
// stops; the commands -- and therefore the approvals this smoke is about --
// belong to the turns after 开始做. Then each turn: the command, then an answer
// once its output is back.
let planned = false;
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async () => {
  requests += 1;
  if (!planned) { planned = true; return syntheticResponseStream("PLAN_DONE 我会跑 npm --version 看看版本。"); }
  const turn = Math.ceil((requests - 1) / 2);
  return (requests - 1) % 2 ? escalated(COMMANDS[turn - 1]) : syntheticResponseStream(`TURN_${turn}_DONE`);
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });

try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin }, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator('[data-section="coding"]').click();
  await app.evaluate(({ dialog }, cwd) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] }); }, workspace);
  await page.locator("#pick-workspace").click();
  await page.locator("#project-path").filter({ hasText: workspace }).waitFor();
  const finished = (turn) => page.locator("#messages").filter({ hasText: `TURN_${turn}_DONE` }).waitFor();
  // Command approvals are attached to the command step they belong to. Only
  // unplaced cards fall back to the legacy #approvals tray.
  const card = page.locator("#conversation .approval").first();

  // 1. Asked, and remembered for this project -- Codex's proposal, word for word.
  await page.locator("#prompt").fill("看看 npm 的版本"); await page.locator("#send").click();
  // The plan first, read-only: nothing it proposes can ask for an approval,
  // which is exactly why the commands come after 开始做.
  await page.locator("#messages").filter({ hasText: "PLAN_DONE" }).waitFor();
  assert.equal(await card.isVisible(), false, "只读的方案那一轮不该弹出审批");
  await page.locator("#start-building").click();
  await card.waitFor();
  const remember = card.getByRole("button", { name: "以后这个项目里都允许「npm --version」" });
  assert.equal(await remember.isVisible(), true, await card.innerText());
  await waitForHumanChoice(card, "以后这个项目里都允许「npm --version」");
  await finished(1);

  // 2. The same command: through at once, and the step says why.
  let asked = false;
  await page.locator("#prompt").fill("再看一次"); await page.locator("#send").click();
  const watch = setInterval(() => { card.isVisible().then((visible) => { asked ||= visible; }, () => {}); }, 100);
  await finished(2); clearInterval(watch);
  assert.equal(asked, false, "no card for a command the project remembers");
  // The newest turn: the plan is turn 0 here, so a fixed index moved.
  assert.match(await page.locator("#messages .coding-turn").last().innerText(), /按记住的规则允许/);

  // 3. A second command riding on the first: asked about again.
  await page.locator("#prompt").fill("再看一次，顺便打个招呼"); await page.locator("#send").click();
  await card.waitFor();
  assert.match(await card.innerText(), /npm --version && echo injected/);
  await card.getByRole("button", { name: "拒绝", exact: true }).click();
  await finished(3);

  // 设置 lists it, and forgetting it there takes it away.
  await page.locator("#settings").click();
  const rules = page.locator("#approval-rules");
  await rules.filter({ hasText: "npm --version" }).waitFor();
  assert.match(await rules.innerText(), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await rules.getByRole("button", { name: "撤销" }).click();
  await rules.filter({ hasText: "还没有" }).waitFor();
  // One for the plan, then two per command turn.
  assert.equal(requests, 7);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualCodex: true, rememberedFromCard: true, remembered: "npm --version", askedAgain: false, compoundAsked: true, forgotten: true, modelRequests: requests, paidCalls: 0 }));
} catch (error) {
  if (app) { const page = await app.firstWindow(); console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0], requests, status: await page.locator("#task-status").innerText().catch(() => ""), error: await page.locator("#error-banner").innerText().catch(() => ""), approvals: await page.locator("#conversation .approval").allInnerTexts().catch(() => []) })); }
  throw error;
} finally {
  await app?.close(); sessions.revoke(session.token); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
