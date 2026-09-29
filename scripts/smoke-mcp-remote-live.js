// @requires live: 真实付费模型调用，并访问公网 MCP 服务
// A real remote MCP server, reached the way a person's own HTTP connection is:
// the pinned Codex runtime, the server's configured chat model (MiniMax or GLM)
// through the real gateway, and DeepWiki's public MCP endpoint (free, no
// sign-in, public GitHub repositories only). The model is asked to call one
// read-only tool once. Automation proves that the in-app approval sees exactly
// that call and that no remote tool execution happens before a person acts.
// M01 owns the affirmative path where the answer travels back to the model.
// Nothing about the person or their tenant is sent: the only argument is a
// public repository name.
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { TaskService } from "../src/application/task-service.js";
import { TaskStore } from "../src/application/task-store.js";
import { createTaskRuntime } from "../src/application/task-runtime.js";
import { mcpReference, normalizeMcpConnection } from "../src/application/mcp-connections.js";
import { loadConfig } from "../src/config.js";

if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live: a bounded paid request to the server's configured chat model (MiniMax or GLM) plus one call to DeepWiki's public MCP server");
const REPO = "modelcontextprotocol/servers";
const chat = await loadChatModelConfig();
// GLM-5.3 reasons before every answer: a 1024-token cap would end its turn as
// response.incomplete, and its turn needs more time. MiniMax keeps the bounds it
// was verified with.
const thinking = chat.provider === "litellm";
const root = await mkdtemp(path.join(os.tmpdir(), "idou-mcp-remote-")), workspace = path.join(root, "workspace");
await mkdir(workspace);
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "mcp-remote-smoke", deviceId: "local" });
let calls = 0, approvals = 0, toolResultSeen = false, toolOffered = false, service, task, timer;
const handled = new Set();
const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  if (calls >= 5) throw new Error("Remote MCP test request cap reached");
  calls++; const body = JSON.parse(options.body); body.max_output_tokens = thinking ? 8192 : 1024;
  // Whether Codex reached the server and offered its tool at all -- the
  // difference between "the remote server was unreachable" and "the model chose
  // not to call it", which look the same from the task alone.
  if (JSON.stringify(body.tools ?? []).includes("read_wiki_structure")) toolOffered = true;
  // The tool's answer is a function_call_output item in the model's input on
  // the turn after the call -- not merely the repository name from the prompt.
  const outputs = Array.isArray(body.input) ? body.input.filter(item => item?.type === "function_call_output") : [];
  if (outputs.some(item => JSON.stringify(item.output ?? "").length > 200)) toolResultSeen = true;
  const response = await fetch(url, { ...options, body: JSON.stringify(body) });
  console.log(JSON.stringify({ stage: "provider", request: calls, status: response.status })); return response;
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
try {
  const config = await loadConfig(), pins = JSON.parse(await readFile("upstreams.lock.json", "utf8"));
  config.controlPlane = { sessionFile: path.join(root, "session.json"), baseUrl: `http://127.0.0.1:${server.address().port}` };
  await writeFile(config.controlPlane.sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: config.controlPlane.baseUrl }), { mode: 0o600 });
  config.codex.dataDir = path.join(root, "codex"); config.codex.expectedVersion = pins.codex.version; config.feishuBusinessLinked = false;
  config.chatModel = chat.model;
  const connection = normalizeMcpConnection({ id: "deepwiki", title: "DeepWiki（公开，免费）", transport: "http", url: "https://mcp.deepwiki.com/mcp", enabledTools: ["read_wiki_structure"] });
  config.mcpConnections = [connection];
  service = new TaskService({ store: new TaskStore(path.join(root, "tasks")), runtimeFactory: task => createTaskRuntime(config, task) });
  await service.init();
  service.on("changed", snapshot => {
    for (const approval of snapshot.approvals) {
      if (handled.has(approval.id)) continue;
      handled.add(approval.id);
      let expected = false;
      try { const args = JSON.parse(approval.command); expected = approval.kind === "mcp" && approval.cwd === "deepwiki" && args.repoName === REPO && Object.keys(args).length === 1 && approvals === 0; } catch {}
      if (expected) { approvals++; service.stop(task.id); }
      else service.approve(approval.id, "decline");
    }
  });
  task = await service.create({ mode: "cowork", cwd: workspace, mcpConnection: mcpReference(connection) });
  timer = setTimeout(() => service.stop(task.id), thinking ? 300_000 : 150000);
  await service.send(task.id, `This is an MCP integration test against a public server. Call the deepwiki read_wiki_structure tool exactly once with repoName "${REPO}". Do not run shell commands, read files or use any other tool. Then reply with the line MCP_REMOTE_VERIFIED followed by the titles of the first three topics the tool returned.`);
  await service.active.get(task.id)?.done.promise;
  const result = service.get(task.id);
  const said = result.messages.filter(message => message.role === "assistant").map(message => message.text).join("\n");
  if (approvals !== 1) console.error(JSON.stringify({ diagnostic: true, toolOffered, providerRequests: calls, status: result.status, reply: said.slice(0, 600) }));
  assert.equal(toolOffered, true, "Codex never offered the DeepWiki tool: the public MCP server was not reachable from this run");
  assert.equal(result.status, "interrupted", `the run must stop at the person's confirmation card: ${result.error ?? ""}`);
  assert.equal(approvals, 1, "exactly one approval for exactly the requested call");
  const reply = result.messages.filter(message => message.role === "assistant").map(message => message.text).join("\n");
  assert.doesNotMatch(reply, /MCP_REMOTE_VERIFIED/);
  assert.equal(toolResultSeen, false, "the remote tool must not run before a person confirms");
  assert.equal(result.activity.some(item => item.type === "commandExecution"), false, "no shell command ran");
  console.log(JSON.stringify({ passed: true, server: "https://mcp.deepwiki.com/mcp", tool: "read_wiki_structure", model: chat.model, providerRequests: calls,
    approvals, pendingManual: "M01", stoppedAtConfirmation: true, actualToolCalls: 0, reply: reply.split("\n").filter(Boolean).slice(0, 4) }));
} finally { clearTimeout(timer); await service?.close(); server.close(); server.closeAllConnections(); sessions.revoke(session.token); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
