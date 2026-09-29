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

// What does a Codex feature actually put on the wire, and would this product's
// gateway accept it?
//
// Reading the binary's strings and `codex doctor` says which flags exist, not
// what a real turn sends -- and the gateway reports every tool-wire rejection
// as the same misleading `unsupported_tool_type`. So this points Codex at a raw
// recording server (no validation at all) and prints the tools verbatim:
// top-level names, any namespace and its inner tools, and which types the
// gateway would refuse.
//
// Usage:
//   PROBE_FEATURES=computer_use,browser_use node scripts/smoke-codex-tools.js
//   PROBE_FEATURES= node scripts/smoke-codex-tools.js            # control
//   PROBE_CATALOG='{"multi_agent_version":"v2"}' PROBE_FEATURES=multi_agent ...
//
// Flags are set here and never in shipped config: turning one on can break
// every coding turn, which is exactly what this is for finding out.
const MODEL = process.env.PROBE_MODEL || "MiniMax-M3";
const features = (process.env.PROBE_FEATURES ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const catalogFields = process.env.PROBE_CATALOG ? JSON.parse(process.env.PROBE_CATALOG) : null;

const root = await mkdtemp(path.join(os.tmpdir(), "idou-codex-tools-"));
const workspace = path.join(root, "workspace");
await mkdir(workspace);

let seen = null, requests = 0;
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

  const runtime = await gatewayRuntimeConfig(config, process.env, { model: MODEL });
  // Some capabilities need real configuration, not just their feature flag --
  // computer use in 0.154.0 has a whole per-app access schema. Without a way to
  // set it, "flag on and no tools appeared" would prove nothing.
  const extraConfig = process.env.PROBE_CONFIG ? JSON.parse(process.env.PROBE_CONFIG) : null;
  const overrides = { ...runtime.overrides, ...Object.fromEntries(features.map((name) => [`features.${name}`, true])),
    ...(extraConfig ?? {}) };
  if (catalogFields) {
    const catalog = JSON.parse(await readFile(fileURLToPath(new URL("../src/providers/codex/model-catalog.json", import.meta.url)), "utf8"));
    for (const entry of catalog.models) if (entry.slug === MODEL) Object.assign(entry, catalogFields);
    const catalogPath = path.join(root, "catalog.json");
    await writeFile(catalogPath, JSON.stringify(catalog));
    overrides.model_catalog_json = catalogPath;
  }

  client = new CodexAppServerClient({ binary: config.codex.binary, cwd: workspace, env: runtime.env, configOverrides: overrides });
  // Codex prints the real reason it refused a config on stderr. Without this the
  // probe reports only "exited with code 1", which says nothing about what was
  // wrong -- and a swallowed error is exactly how a bad guess at a config key
  // turns into a false "this capability does not exist".
  client.on("stderr", (text) => process.stderr.write(`[codex] ${text}`));
  await client.start();
  // A tool that drives a screen or a browser may simply not be offered to a
  // read-only turn, so the sandbox has to be a variable rather than always the
  // safest value — otherwise "not offered" and "not offered *here*" look alike.
  const sandbox = process.env.PROBE_SANDBOX || "read-only";
  const approvalPolicy = process.env.PROBE_APPROVAL || "never";
  const started = await client.request("thread/start", { cwd: workspace, model: MODEL, modelProvider: "idou",
    sandbox, approvalPolicy, serviceName: "idou-tool-probe", config: overrides });
  await runTurn(client, { threadId: started.thread.id, input: [{ type: "text", text: "Say DONE.", text_elements: [] }] })
    .catch((error) => console.error("turn ended:", String(error?.message ?? error).slice(0, 200)));

  assert.ok(seen, `no request body was recorded (requests seen: ${requests})`);
  // The gateway takes only `function` and `namespace`, and a namespace only when
  // its name matches mcp__… (src/control-plane/mcp-tool-wire.js). Both are
  // reported, because a tool can be refused for either reason.
  const namespaces = seen.filter((tool) => tool?.type === "namespace").map((tool) => ({ name: tool.name,
    // What the wire validator actually admits today: an mcp__ namespace, and
    // Codex's own `collaboration` one since subagents were turned on. This read
    // "mcp__ only" for a while after that, so the report called every subagent
    // run refused while the product was happily running them.
    acceptedByGateway: /^mcp__[a-z][a-z0-9_-]{0,39}$/.test(tool.name ?? "") || tool.name === "collaboration",
    inner: (tool.tools ?? []).map((fn) => ({ type: fn?.type, name: fn?.name })) }));
  const types = [...new Set(seen.map((tool) => tool?.type))];
  console.log(JSON.stringify({ features, extraConfig, model: MODEL, sandbox, approvalPolicy, requests,
    toolNames: seen.map((tool) => tool?.name), typesPresent: types,
    typesTheGatewayWouldRefuse: types.filter((type) => !["function", "namespace"].includes(type)),
    namespaces, namespacesTheGatewayWouldRefuse: namespaces.filter((entry) => !entry.acceptedByGateway).map((entry) => entry.name) }, null, 2));
} finally {
  await client?.stop().catch(() => {});
  server.close(); server.closeAllConnections();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
