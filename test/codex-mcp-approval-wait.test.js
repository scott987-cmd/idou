import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { createTaskRuntime } from "../src/application/task-runtime.js";
import { runProcess } from "../src/providers/process-runner.js";
import { runTurn } from "../src/application/turn.js";
import { syntheticResponseStream } from "../scripts/fixtures/model-response.js";

// Does Codex give up on an MCP tool call while its approval card waits for a
// person? Every MCP server is given tool_timeout_sec: 60 (mcp-connections.js);
// if that clock ran during the wait, a person who read the card for more than
// a minute would approve a call that had already failed. On 2026-09-23 a
// manual run of smoke-mcp-desktop lost an approved call's result and this was
// the suspicion. It was not that: the whole task took 9 seconds
// (docs/evidence/desktop-mcp-failure.png), so the card was answered within a
// second or two. Nor does the pinned Codex count the wait: a call's clock
// starts once its approval is answered (codex-mcp
// PreparedMcpCall::call_with_preparation), and a pending approval pauses the
// MCP client's clock besides. Asked of the real binary here, as
// codex-background-command.test.js does, so an update that changes it fails
// in this file rather than in front of someone.
//
// A task's own runtime (createTaskRuntime: the same mcp_servers block, approval
// mode and elicitation feature) against a scripted model behind the product's
// gateway, with the server's timeout cut to two seconds so the wait costs
// seconds, not a minute. Only a person may approve, so the wait ends in a
// refusal; the control shows what the timeout does when it does fire.
const binary = process.env.IDOU_CODEX_BIN || "codex";
const available = await runProcess(binary, ["--version"], { maxOutputBytes: 4096 }).then((r) => r.code === 0).catch(() => false);
const skip = available ? false : `找不到可执行的 ${binary}`;
const TIMEOUT_SEC = 2;

// Everything a test starts is stopped, newest first, before its directory goes
// (see codex-background-command.test.js for what happens otherwise).
async function scratch(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "idou-mcp-wait-")), stops = [];
  t.after(async () => {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, stopLater: (stop) => stops.push(stop) };
}

// A stdio MCP server with one tool that answers after `delay` milliseconds and
// notes every call it runs.
const SERVER = `import readline from "node:readline";
import { appendFileSync } from "node:fs";
const [log, delay] = [process.argv[2], Number(process.argv[3])];
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line); if (request.id === undefined) return;
  if (request.method === "initialize") return send(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "approval-wait-contract", version: "1.0.0" } });
  if (request.method === "tools/list") return send(request.id, { tools: [{ name: "echo", description: "Echo a synthetic test marker", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
  if (request.method === "tools/call") { appendFileSync(log, "called\\n"); return setTimeout(() => send(request.id, { content: [{ type: "text", text: "MCP_EXECUTED:" + request.params.arguments.text }] }), delay); }
  send(request.id, {});
});
`;

// One turn in which the model calls the tool once, with `patch` applied to the
// server's settings. `onApproval` gets each approval request Codex raises.
async function mcpTurn(t, { patch, delay = 0, onApproval }) {
  const scope = await scratch(t), workspace = path.join(scope.dir, "workspace"), log = path.join(scope.dir, "calls.txt");
  await mkdir(workspace); await writeFile(log, "");
  await writeFile(path.join(scope.dir, "server.mjs"), SERVER);
  // On the monotonic clock: in a Linux VM the wall clock was stepped back mid-
  // turn, and an event noted last came out timed before the ones it followed.
  const started = performance.now(), timeline = [], note = (event, detail) => timeline.push({ atMs: Math.round(performance.now() - started), event, ...(detail ? { detail } : {}) });
  const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
  let requests = 0, handedBack = null;
  const gateway = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests += 1; note("model request");
    if (requests > 1) {
      handedBack = (body.input ?? []).filter((item) => item.type === "function_call_output").map((item) => JSON.stringify(item.output)).join("\n");
      return syntheticResponseStream("DONE");
    }
    const tool = body.tools?.find((item) => item.description?.endsWith("Echo a synthetic test marker"));
    assert.ok(tool, `the model was not offered the MCP tool; offered ${body.tools?.map((item) => item.name).join(",")}`);
    const call = { type: "function_call", id: "fc_wait", call_id: "call_wait", name: tool.name, arguments: JSON.stringify({ text: "synthetic-marker" }), status: "completed" };
    const events = [{ type: "response.created", response: { id: "resp_wait", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "", status: "in_progress" } },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { id: "resp_wait", status: "completed", output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  } });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  scope.stopLater(async () => { sessions.revoke(session.token); gateway.close(); gateway.closeAllConnections(); });
  const origin = `http://127.0.0.1:${gateway.address().port}`, sessionFile = path.join(scope.dir, "session.json");
  await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });
  const connection = { id: "demo", title: "审批等待契约", transport: "stdio", command: process.execPath, args: [path.join(scope.dir, "server.mjs"), log, String(delay)], enabledTools: ["echo"] };
  const runtime = await createTaskRuntime({ codex: { binary, dataDir: path.join(scope.dir, "codex") }, controlPlane: { sessionFile, baseUrl: origin },
    feishu: { binary: process.execPath }, feishuBusinessLinked: false, mcpConnections: [connection] }, { mode: "cowork", cwd: workspace });
  // What a task really runs with, before the timeout is cut for the test.
  const server = runtime.params.config.mcp_servers.demo;
  assert.equal(server.tool_timeout_sec, 60); assert.equal(server.default_tools_approval_mode, "prompt");
  assert.equal(runtime.params.config["features.tool_call_mcp_elicitation"], true);
  for (const config of [runtime.client.configOverrides, runtime.params.config]) Object.assign(config.mcp_servers.demo, { tool_timeout_sec: TIMEOUT_SEC, ...patch });
  const client = runtime.client;
  scope.stopLater(() => client.stop());
  client.on("notification", (message) => {
    const item = message.params?.item;
    if (item?.type === "mcpToolCall" && message.method === "item/completed") note("call ended", { status: item.status, error: item.error?.message ?? null });
    if (["serverRequest/resolved", "turn/completed"].includes(message.method)) note(message.method);
  });
  client.on("serverRequest", (request) => {
    if (request.method !== "mcpServer/elicitation/request") { client.respondError(request.id, -32601, "This test answers nothing else"); return; }
    note("approval requested"); onApproval?.(request, (answer) => { note("answered", answer.action); client.respond(request.id, answer); });
  });
  await client.start();
  const thread = await client.request("thread/start", runtime.params);
  await runtime.prepare(client, thread.thread.id);
  const turn = await runTurn(client, { threadId: thread.thread.id, input: [{ type: "text", text: "Call the echo tool with synthetic-marker.", text_elements: [] }] });
  return { turn, timeline, requests, handedBack, calls: (await readFile(log, "utf8")).split("\n").filter(Boolean).length };
}

test("an MCP call waits for its approval past the server's tool timeout", { skip, timeout: 60_000 }, async (t) => {
  let answer;
  t.after(() => clearTimeout(answer));
  // Held for twice the timeout, then refused -- the answer the app sends for 拒绝.
  const { turn, timeline, requests, handedBack, calls } = await mcpTurn(t, { patch: {}, onApproval: (request, respond) => {
    answer = setTimeout(() => respond({ action: "decline", content: null, _meta: null }), 2 * TIMEOUT_SEC * 1000);
  } });
  const asked = timeline.find((entry) => entry.event === "approval requested")?.atMs;
  const answered = timeline.find((entry) => entry.event === "answered")?.atMs ?? Infinity;
  assert.ok(asked !== undefined, "Codex never asked for approval");
  // A timeout would end the call, withdraw the request or ask the model again
  // before the answer. Nothing may happen until the person has answered.
  assert.deepEqual(timeline.filter((entry) => entry.atMs > asked && entry.atMs < answered), [], JSON.stringify(timeline));
  assert.ok(answered - asked >= 2 * TIMEOUT_SEC * 1000 - 50, JSON.stringify(timeline));
  assert.equal(turn.status, "completed");
  assert.deepEqual(timeline.find((entry) => entry.event === "call ended")?.detail, { status: "failed", error: "user rejected MCP tool call" });
  assert.equal(requests, 2); assert.match(handedBack, /user rejected MCP tool call/);
  assert.equal(calls, 0, "a refused call never reaches the server");
});

test("the tool timeout is real: a call that runs past it fails", { skip, timeout: 60_000 }, async (t) => {
  // The control. No approval is asked at all ("approve"), so nothing answers
  // for a person; the server takes twice the timeout to answer.
  let asked = false;
  const { turn, timeline, requests, handedBack, calls } = await mcpTurn(t, { patch: { default_tools_approval_mode: "approve" }, delay: 2 * TIMEOUT_SEC * 1000,
    onApproval: (request, respond) => { asked = true; respond({ action: "decline", content: null, _meta: null }); } });
  assert.equal(asked, false);
  assert.equal(turn.status, "completed"); assert.equal(calls, 1);
  const ended = timeline.find((entry) => entry.event === "call ended");
  assert.equal(ended?.detail?.status, "failed"); assert.match(ended.detail.error, /timed out/);
  assert.equal(requests, 2); assert.match(handedBack, /timed out/); assert.doesNotMatch(handedBack, /MCP_EXECUTED/);
});
