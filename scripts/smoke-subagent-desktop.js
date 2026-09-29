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

// A coding task that delegates to a subagent, in the actual Electron app with the
// actual Codex and the product's own gateway, against a scripted model -- no paid
// call. It checks what broke without a word before, and what the person sees:
// - the gateway passes Codex's collaboration tools and restores their namespace,
//   so spawn_agent and wait_agent run at all;
// - both directions of agent_message -- the parent's task for the child and the
//   child's final answer for the parent -- reach the model framed, instead of
//   being dropped the way LiteLLM drops that item type;
// - in the conversation and the execution record the child's words and steps are
//   labelled as the child's, never as the task's own Agent speaking.
//
// The scripted model tells parent from child by what Codex tells each of them:
// a child is "an agent in a team of agents", the parent "the primary agent"
// (measured). The person's prompt is no guide -- the desktop may carry it into
// what a child receives too.
const PROMPT = "派一个子 agent 去数一数 Kubernetes 有几个字母。";
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-subagent-desktop-"));
const workspace = path.join(directory, "workspace"), evidence = path.resolve("docs/evidence");
await mkdir(workspace); await mkdir(evidence, { recursive: true });
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
const seen = { parent: 0, child: 0, rawAgentMessages: 0, taskReachedChild: false, answerReachedParent: false };
// One line per request, printed if the run fails: who asked, and what the tools answered.
const trail = [];
let app, sequence = 0;

const call = (name, args, callId = `call_${sequence}`) => {
  const item = { type: "function_call", id: `fc_${sequence}`, call_id: callId, name, arguments: JSON.stringify(args), status: "completed" };
  const events = [{ type: "response.created", response: { id: `resp_${sequence}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${sequence}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async (_url, options) => {
  sequence += 1;
  const body = JSON.parse(options.body), input = Array.isArray(body.input) ? body.input : [], text = JSON.stringify(input);
  seen.rawAgentMessages += input.filter((item) => item?.type === "agent_message").length;
  const child = text.includes("You are an agent in a team of agents");
  trail.push({ n: sequence, child, primary: text.includes("the primary agent"), prompt: text.includes(PROMPT),
    agentTools: (body.tools ?? []).map((tool) => tool.name).filter((name) => /agent|task/.test(name ?? "")),
    outputs: input.filter((item) => item?.type === "function_call_output").map((item) => `${item.call_id}: ${String(typeof item.output === "string" ? item.output : JSON.stringify(item.output)).slice(0, 160)}`) });
  if (child) {
    // The child. Its task arrives as the parent's agent_message, handed on framed.
    seen.child += 1;
    if (text.includes("agent /root 发给 /root/counter 的消息") && text.includes("COUNT_TASK")) seen.taskReachedChild = true;
    if (seen.child === 1) return call("exec_command", { cmd: "printf 'CHILD_COMMAND_OUTPUT\\n'" });
    return syntheticResponseStream("COUNTED 10");
  }
  seen.parent += 1;
  if (text.includes("agent /root/counter 发给 /root 的消息") && text.includes("COUNTED 10")) seen.answerReachedParent = true;
  if (seen.answerReachedParent || seen.parent > 8) return syntheticResponseStream("SUBAGENT_DESKTOP_DONE 子 agent 数出来是 10。");
  if (!input.some((item) => item?.type === "function_call_output" && item.call_id === "call_spawn")) {
    return call("spawn_agent", { task_name: "counter", message: "COUNT_TASK: 数一数 Kubernetes 有几个字母，只回复数字。", fork_turns: "none" }, "call_spawn");
  }
  return call("wait_agent", { timeout_ms: 30000 });
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });

try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], timeout: 30_000,
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin } });
  const page = await app.firstWindow(); page.setDefaultTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator('[data-section="coding"]').click();
  await app.evaluate(({ dialog }, cwd) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] }); }, workspace);
  await page.locator("#pick-workspace").click();
  await page.locator("#project-path").filter({ hasText: workspace }).waitFor();
  await page.locator("#prompt").fill(PROMPT); await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor({ timeout: 180_000 });
  assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText());

  assert.ok(seen.child >= 2, `the child should have made its own requests (saw ${seen.child})`);
  assert.equal(seen.taskReachedChild, true, "the parent's task never reached the child");
  assert.equal(seen.answerReachedParent, true, "the child's final answer never reached the parent");
  assert.equal(seen.rawAgentMessages, 0, "an agent_message item reached the provider unframed");

  // The conversation: the child's words under the child's name, never the
  // Agent's, in the turn where they came -- and the delegation itself and the
  // child's command there too, under its name.
  const bySpeaker = await page.evaluate(() => [...document.querySelectorAll("#messages .coding-text")].map((node) => ({ subagent: node.classList.contains("subagent"), text: node.innerText })));
  assert.ok(bySpeaker.some((entry) => entry.subagent && /子 agent · counter/.test(entry.text) && /COUNTED 10/.test(entry.text)), `the child's answer should be labelled as the child's: ${JSON.stringify(bySpeaker)}`);
  assert.equal(bySpeaker.some((entry) => !entry.subagent && /COUNTED 10/.test(entry.text)), false, "the child's answer must not appear as the Agent's own words");
  assert.ok(bySpeaker.some((entry) => !entry.subagent && /SUBAGENT_DESKTOP_DONE/.test(entry.text)));
  const steps = await page.locator("#messages .coding-turn").first().innerText();
  assert.match(steps, /派生子 agent\s*counter/);
  // One step: the command's line holds its parts on separate lines of innerText.
  assert.match(steps, /CHILD_COMMAND_OUTPUT[^\n]*\n(?:[^\n]*\n){0,3}子 agent counter/);
  await page.screenshot({ path: path.join(evidence, "desktop-subagent.png"), scale: "css" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, actualCodex: true, actualGateway: true, parentRequests: seen.parent, childRequests: seen.child,
    taskReachedChildFramed: true, answerReachedParentFramed: true, rawAgentMessagesForwarded: 0, childLabelledInConversation: true, childLabelledInRecord: true, paidCalls: 0 }));
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0], seen, trail,
      status: await page.locator("#task-status").innerText().catch(() => "unavailable"), error: await page.locator("#error-banner").innerText().catch(() => "unavailable"),
      approvals: await page.locator("#approvals").innerText().catch(() => "unavailable") }));
  }
  throw error;
} finally {
  await app?.close(); sessions.revoke(session.token); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
