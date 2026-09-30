import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeMcpConnection, mcpReference, McpConnections, readMcpImport, mcpOverrides, inspectTaskMcp } from "../src/application/mcp-connections.js";

const fixture = () => ({ id: "demo", title: "Synthetic MCP", transport: "http", url: "https://mcp.example.test/mcp", enabledTools: ["echo"] });
test("MCP import admits explicit bounded tools/transports, never auth fields or unsafe URLs", () => {
  assert.equal(normalizeMcpConnection(fixture()).transport, "http");
  const { url, ...base } = fixture();
  assert.equal(normalizeMcpConnection({ ...base, transport: "stdio", command: process.execPath, args: [] }).command, process.execPath);
  for (const patch of [{ env: { SECRET: "no" } }, { http_headers: {} }, { bearer_token_env_var: "KEY" }, { id: undefined }, { id: "codex_apps" }, { enabledTools: [] }, { enabledTools: ["*"] }, { url: "https://user:secret@example.test/mcp" }, { url: "https://example.test/?key=secret" }, { url: "http://192.168.1.1/mcp" }, { url: "file:///tmp/mcp" }]) assert.throws(() => normalizeMcpConnection({ ...fixture(), ...patch }));
  assert.equal(normalizeMcpConnection({ ...fixture(), url: "http://127.0.0.1:1234/mcp" }).transport, "http");
});
test("account-local MCP records persist atomically, reject stale references and preserve corrupt files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-mcp-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, "a", "connections.json"), a = new McpConnections(filename), b = new McpConnections(path.join(root, "b.json"));
  await a.put(fixture()); const reference = mcpReference(fixture()); assert.equal((await a.resolve(reference)).length, 1); assert.deepEqual(await b.list(), []);
  await a.put({ ...fixture(), enabledTools: ["other"] }); await assert.rejects(a.resolve(reference), /变化/); await assert.rejects(a.remove(reference), /变化/);
  await a.remove(mcpReference((await a.list())[0])); assert.deepEqual(await a.list(), []);
  await writeFile(filename, "corrupt"); await assert.rejects(a.put(fixture()), /损坏/); assert.equal(await readFile(filename, "utf8"), "corrupt");
  await writeFile(filename, JSON.stringify(fixture())); assert.equal((await readMcpImport(filename)).id, "demo");
  await writeFile(filename, "x".repeat(32769)); await assert.rejects(readMcpImport(filename), /32 KiB/);
});
test("MCP adapter forces per-call prompts and validates actual runtime tools without resource reads", async () => {
  const overrides = mcpOverrides([fixture()], "/tmp"); assert.equal(overrides.demo.default_tools_approval_mode, "prompt"); assert.equal(overrides.demo.required, true); assert.deepEqual(overrides.demo.enabled_tools, ["echo"]);
  let params;
  const client = { request: async (method, value) => { assert.equal(method, "mcpServerStatus/list"); params = value; return { data: [{ name: "demo", runtimeStatus: "connected", tools: { echo: { name: "echo" } } }] }; } };
  assert.equal((await inspectTaskMcp(client, "thread", [fixture()]))[0].status, "connected"); assert.equal(params.detail, "toolsAndAuthOnly");
  const pinned = { name: "demo", serverInfo: { name: "idou-synthetic-mcp", version: "1.0.0" }, tools: { echo: { name: "echo" } }, authStatus: "unsupported" };
  assert.equal((await inspectTaskMcp({ request: async () => ({ data: [pinned] }) }, "thread", [fixture()]))[0].status, "connected");
  await assert.rejects(inspectTaskMcp({ request: async () => ({ data: [{ ...pinned, serverInfo: null }] }) }, "thread", [fixture()]), /未连接/);
  for (const status of ["starting", "failed", "authenticationRequired"]) await assert.rejects(inspectTaskMcp({ request: async () => ({ data: [{ name: "demo", runtimeStatus: status, tools: {} }] }) }, "thread", [fixture()]), /未连接/);
});

// A built-in connector runs on the application's Node (node-runtime.js), and
// Codex passes an MCP server none of its environment: what that Node needs is
// said with the server. In development under Electron that is the Electron
// binary told to act as Node -- 2026-09-23, when the packaged app still ran
// Electron as Node, every built-in connector failed its handshake without it
// ("connection closed"). A packaged app runs them on the Node it carries,
// which needs nothing; neither does plain Node.
test("a connector run on the application's Node is given what that Node needs, and only that one", async () => {
  const { builtinConnectionRow } = await import("../src/application/builtin-connectors.js");
  const electron = "/Users/someone/idou/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
  const development = { command: electron, env: { ELECTRON_RUN_AS_NODE: "1" } };
  for (const key of ["web-fetch", "browser", "computer"]) {
    const row = builtinConnectionRow(key, { execPath: electron });
    assert.deepEqual(mcpOverrides([row], "/tmp", {}, development)[row.id].env, { ELECTRON_RUN_AS_NODE: "1" }, key);
  }
  // A person's own server gets nothing it did not ask for.
  const own = { id: "own", title: "Own", transport: "stdio", command: "/usr/local/bin/own-mcp", args: [], enabledTools: ["echo"] };
  assert.equal(mcpOverrides([own], "/tmp", {}, development).own.env, undefined);
  // Packaged: the Node the application carries, told nothing.
  const bundled = "/Applications/i豆.app/Contents/Resources/node/bin/node";
  const packaged = builtinConnectionRow("browser", { execPath: bundled });
  assert.equal(packaged.command, bundled);
  assert.equal(mcpOverrides([packaged], "/tmp", {}, { command: bundled, env: {} })[packaged.id].env, undefined);
  // Under plain Node the runtime is Node already.
  const row = builtinConnectionRow("browser", { execPath: process.execPath });
  assert.equal(mcpOverrides([row], "/tmp", {}, { command: process.execPath, env: {} })[row.id].env, undefined);
});
