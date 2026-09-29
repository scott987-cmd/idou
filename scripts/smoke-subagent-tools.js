import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/providers/codex/app-server-client.js";
import { gatewayRuntimeConfig } from "../src/providers/codex/gateway-config.js";
import { runTurn } from "../src/application/turn.js";
import { loadConfig } from "../src/config.js";

// What does Codex offer once subagents are on, verbatim?
//
// This is how the subagent tools were first measured. The gateway reported every
// tool-wire rejection as `unsupported_tool_type`, which could not say whether
// they were a type it had never allowed or ordinary functions that tripped a
// naming rule. Pointed at a raw recording server instead of the gateway, Codex
// showed one `collaboration` namespace of plain function tools: the namespace
// name was the obstacle, and mcp-tool-wire.js now admits exactly that namespace
// and its six tools. Run it again after a Codex upgrade -- a new or renamed tool
// in the namespace is refused by the gateway until someone reviews it.
//
// The settings are set here as well as in shipped config, so the probe measures
// the same thing whatever the shipped config says.
const MODEL = "MiniMax-M3";
const root = await mkdtemp(path.join(os.tmpdir(), "idou-subagent-tools-"));
const workspace = path.join(root, "workspace");
await mkdir(workspace);

let seen = null, requests = 0;
// A raw server: no validation, no allow-list. It answers one minimal completed
// response so the turn ends instead of hanging.
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    requests += 1;
    try { const parsed = JSON.parse(body); if (!seen && parsed.tools) seen = parsed.tools; } catch { /* not JSON */ }
    const done = { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: response.completed\ndata: ${JSON.stringify(done)}\n\n`);
  });
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

let client;
try {
  const config = await loadConfig();
  config.controlPlane = { ...config.controlPlane, sessionFile: path.join(root, "session.json"), baseUrl: origin };
  await writeFile(config.controlPlane.sessionFile, JSON.stringify({ token: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 600_000, serverUrl: origin }), { mode: 0o600 });
  config.codex.dataDir = path.join(root, "codex");

  // A catalog that declares the v2 subagent protocol for this model.
  const catalog = JSON.parse(await readFile(fileURLToPath(new URL("../src/providers/codex/model-catalog.json", import.meta.url)), "utf8"));
  for (const entry of catalog.models) if (entry.slug === MODEL) entry.multi_agent_version = "v2";
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(catalogPath, JSON.stringify(catalog));

  const runtime = await gatewayRuntimeConfig(config, process.env, { model: MODEL });
  // PROBE_MULTI_AGENT=0 runs this same probe with subagents off, as a control.
  // The two tool lists are only comparable if everything else is identical, so
  // the flags are the only difference between the runs.
  const multiAgent = process.env.PROBE_MULTI_AGENT !== "0";
  const overrides = { ...runtime.overrides, ...(multiAgent ? { model_catalog_json: catalogPath,
    "features.multi_agent": true, "features.multi_agent_v2.max_concurrent_threads_per_session": 2 } : {}) };

  client = new CodexAppServerClient({ binary: config.codex.binary, cwd: workspace, env: runtime.env, configOverrides: overrides });
  await client.start();
  const started = await client.request("thread/start", { cwd: workspace, model: MODEL, modelProvider: "idou",
    sandbox: "read-only", approvalPolicy: "never", serviceName: "idou-subagent-probe", config: overrides });
  await runTurn(client, { threadId: started.thread.id, input: [{ type: "text", text: "Say DONE.", text_elements: [] }] })
    .catch((error) => console.error("turn ended:", String(error?.message ?? error).slice(0, 200)));

  assert.ok(seen, `no request body was recorded (requests seen: ${requests})`);
  const summary = seen.map((tool) => ({ type: tool?.type, name: tool?.name ?? tool?.function?.name }));
  const agentTools = summary.filter((tool) => /agent/i.test(tool.name ?? ""));
  const allowed = new Set(["function", "namespace"]);
  const refused = [...new Set(summary.filter((tool) => !allowed.has(tool.type)).map((tool) => tool.type))];
  // The subagent tools are nested inside a namespace tool, so the top-level
  // names say nothing about them. What matters for the gateway is each inner
  // tool's type and name: flattenMcpTools validates those, and model-gateway
  // reports every failure as the same "unsupported_tool_type".
  const namespaces = seen.filter((tool) => tool?.type === "namespace").map((tool) => ({ name: tool.name,
    count: Array.isArray(tool.tools) ? tool.tools.length : null,
    inner: (tool.tools ?? []).map((fn) => ({ type: fn?.type, name: fn?.name })) }));
  console.log(JSON.stringify({ multiAgent, requests, namespaces, toolCount: summary.length,
    toolNames: summary.map((tool) => tool.name), agentTools,
    typesPresent: [...new Set(summary.map((tool) => tool.type))], typesTheGatewayWouldRefuse: refused }, null, 2));
} finally {
  await client?.stop().catch(() => {});
  server.close(); server.closeAllConnections();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
