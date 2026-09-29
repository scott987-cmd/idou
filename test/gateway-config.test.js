import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clientEnvironment, gatewayRuntimeConfig } from "../src/providers/codex/gateway-config.js";
import { readClientSession, validateServerUrl } from "../src/control-plane/client-session.js";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL } from "../src/providers/codex/chat-models.js";
import { createTaskRuntime } from "../src/application/task-runtime.js";
import { builtinConnectionRow } from "../src/application/builtin-connectors.js";
import { AGENT_SHELL_DIRECTORY } from "../src/providers/codex/agent-shell.js";
import { spawnSync } from "node:child_process";

test("client environment excludes server keys, ambient auth, injected Node flags and old Codex home", () => {
  assert.deepEqual(clientEnvironment({ PATH: "/bin", HOME: "/home/user", MINIMAX_API_KEY: "secret", OPENAI_API_KEY: "secret", NODE_OPTIONS: "--import=evil", CODEX_HOME: "/old" }), { PATH: "/bin", HOME: "/home/user" });
});

test("server URL rejects non-TLS remote destinations, credentials and query strings", () => {
  for (const value of ["http://example.com", "http://localhost:5000", "https://user:password@example.com", "https://example.com/?token=x", "file:///tmp/x"]) assert.throws(() => validateServerUrl(value));
  assert.equal(validateServerUrl("http://127.0.0.1:5000"), "http://127.0.0.1:5000");
});

test("runtime config uses separate home and auth helper without embedding a token", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-session-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.json");
  const token = "a".repeat(43);
  await writeFile(sessionFile, JSON.stringify({ token, expiresAt: Date.now() + 60_000, serverUrl: "http://127.0.0.1:5000" }), { mode: 0o600 });
  const config = { codex: { dataDir: path.join(directory, "runtime") }, controlPlane: { sessionFile } };
  const runtime = await gatewayRuntimeConfig(config, { MINIMAX_API_KEY: "do-not-inherit", PATH: "/bin" });
  assert.equal(runtime.env.CODEX_HOME, config.codex.dataDir);
  assert.equal(runtime.env.MINIMAX_API_KEY, undefined);
  assert.equal(runtime.overrides.model_provider, "idou");
  // Without it Codex answers the Agent's questions itself outside Plan mode, and the person never sees them.
  assert.equal(runtime.overrides["features.default_mode_request_user_input"], true);
  assert.equal(JSON.stringify(runtime).includes(token), false);
  await assert.rejects(readClientSession(sessionFile, "https://other.example"), /另一个服务端/);
  await assert.rejects(readClientSession(sessionFile, undefined, Date.now() + 120_000), /已过期/);
  await writeFile(sessionFile, `${token} malformed JSON`);
  await assert.rejects(readClientSession(sessionFile), (error) => error.message === "会话文件格式无效" && !error.message.includes(token));
  if (process.platform !== "win32") {
    await chmod(sessionFile, 0o644);
    await assert.rejects(readClientSession(sessionFile), /0600/);
  }
});

async function sessionConfig(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-model-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({ token: "a".repeat(43), expiresAt: Date.now() + 60_000, serverUrl: "http://127.0.0.1:5000" }), { mode: 0o600 });
  // A task's folder of its own, beside the Codex home rather than around it: a
  // sandboxed task may never be able to write the rules its tools run under.
  const work = path.join(directory, "work"); await (await import("node:fs/promises")).mkdir(work);
  return { directory, work, config: { codex: { dataDir: path.join(directory, "runtime"), binary: "/nonexistent/codex", toolsDirectory: path.join(directory, "tools") }, controlPlane: { sessionFile } } };
}

test("runtime config asks the product gateway for the chosen chat model and ships its catalog entry", async (t) => {
  const { config } = await sessionConfig(t);
  const byDefault = await gatewayRuntimeConfig(config, { PATH: "/bin" });
  assert.equal(byDefault.model, DEFAULT_CHAT_MODEL); assert.equal(byDefault.overrides.model, "MiniMax-M3");
  for (const model of Object.keys(CHAT_MODELS)) {
    const runtime = await gatewayRuntimeConfig(config, { PATH: "/bin" }, { model });
    assert.equal(runtime.model, model); assert.equal(runtime.overrides.model, model);
    // Whatever serves the model upstream, Codex only ever talks to the product gateway, once.
    const provider = runtime.overrides["model_providers.idou"];
    assert.equal(provider.base_url, "http://127.0.0.1:5000/v1"); assert.equal(provider.request_max_retries, 0); assert.equal(provider.stream_max_retries, 0);
    assert.equal(provider.auth.args.at(-1), "http://127.0.0.1:5000"); assert.match(provider.auth.args[0], /bin[\\/]agent-token\.js$/);
    assert.match(runtime.overrides.model_catalog_json, /model-catalog\.json$/);
    const catalog = JSON.parse(await readFile(runtime.overrides.model_catalog_json, "utf8"));
    assert.equal(catalog.models.filter((entry) => entry.slug === model).length, 1, `${model} must have exactly one catalog entry`);
  }
});

test("runtime config refuses a model the product does not ship", async (t) => {
  const { config } = await sessionConfig(t);
  for (const model of ["gpt-5", "", null, 3, "__proto__", "toString", "glm-5.3", "volc-coding"]) {
    await assert.rejects(gatewayRuntimeConfig(config, { PATH: "/bin" }, { model }), /Unsupported chat model/, String(model));
  }
});

test("server-side LiteLLM settings and keys never reach Codex or its shell", async (t) => {
  const { config } = await sessionConfig(t);
  const sourceEnv = { PATH: "/bin", HOME: "/home/user", IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_API_KEY: "litellm-secret-fixture",
    IDOU_LITELLM_KEY_FILE: "/secret/litellm.env", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:4000", IDOU_LITELLM_MODEL: "volc-coding", LITELLM_MASTER_KEY: "master-secret-fixture" };
  const runtime = await gatewayRuntimeConfig(config, sourceEnv, { model: "GLM-5.3" });
  const serialized = JSON.stringify(runtime);
  for (const leaked of ["LITELLM", "litellm-secret-fixture", "master-secret-fixture", "/secret/litellm.env", "127.0.0.1:4000", "volc-coding"]) assert.equal(serialized.includes(leaked), false, leaked);
  assert.deepEqual(runtime.overrides["shell_environment_policy.set"], { PATH: "/bin", HOME: "/home/user" });
});

test("task runtime runs the model the desktop learned, and the default when it learned none", async (t) => {
  const { directory, config, work } = await sessionConfig(t);
  const task = { mode: "coding", cwd: work };
  const base = { ...config, feishu: { binary: process.execPath }, feishuBusinessLinked: false };
  assert.equal((await createTaskRuntime(base, task)).params.model, "MiniMax-M3");
  assert.equal((await createTaskRuntime({ ...base, chatModel: null }, task)).params.model, "MiniMax-M3");
  const glm = await createTaskRuntime({ ...base, chatModel: "GLM-5.3" }, task);
  assert.equal(glm.params.model, "GLM-5.3"); assert.equal(glm.params.config.model, "GLM-5.3"); assert.equal(glm.params.modelProvider, "idou");
  await assert.rejects(createTaskRuntime({ ...base, chatModel: "unknown-model" }, task), /Unsupported chat model/);
});

test("a coding task carries the product's coding instructions as its base instructions; a work task keeps the catalog's", async (t) => {
  const { directory, config, work } = await sessionConfig(t);
  const base = { ...config, feishu: { binary: process.execPath }, feishuBusinessLinked: false, chatModel: "GLM-5.3" };
  const coding = (await createTaskRuntime(base, { mode: "coding", cwd: work })).params.baseInstructions;
  for (const expected of [/apply_patch <<'EOF'\n\*\*\* Begin Patch/, /\*\*\* End Patch\nEOF/, /AGENTS\.md/, /update_plan/, /workdir/, /request_user_input/]) assert.match(coding, expected);
  // What MiniMax-M3 got wrong on 2026-09-19, checked against Codex 0.155.0: a
  // hunk cannot change its own `@@` line, and one with only context changes
  // nothing yet still answers Success.
  assert.match(coding, /that line itself is never changed.*bare `@@`/s);
  assert.match(coding, /changes nothing, even though the output still says `Success`/);
  assert.equal("baseInstructions" in (await createTaskRuntime(base, { mode: "cowork", cwd: work })).params, false);
});

test("built-in MCP connectors are wired into a coding task's Codex config with elicitation", async (t) => {
  const { directory, config, work } = await sessionConfig(t);
  const base = { ...config, feishu: { binary: process.execPath }, feishuBusinessLinked: false, chatModel: "GLM-5.3", mcpConnections: [builtinConnectionRow("web-fetch")] };
  const runtime = await createTaskRuntime(base, { mode: "coding", cwd: work });
  const servers = runtime.params.config.mcp_servers;
  assert.ok(servers && servers["web-fetch"], "the built-in connector becomes a Codex mcp_server");
  assert.deepEqual(servers["web-fetch"].enabled_tools, ["fetch_url", "web_search"]);
  assert.equal(servers["web-fetch"].default_tools_approval_mode, "prompt", "every call is prompted");
  assert.equal(runtime.params.config["features.tool_call_mcp_elicitation"], true);
  assert.deepEqual(runtime.mcpConnectionIds, ["web-fetch"]);
  assert.equal(typeof runtime.prepare, "function");
  // No connectors means no mcp_servers block and no elicitation.
  const bare = await createTaskRuntime({ ...base, mcpConnections: [] }, { mode: "coding", cwd: work });
  assert.equal(bare.params.config.mcp_servers, undefined);
  assert.equal(bare.params.config["features.tool_call_mcp_elicitation"], undefined);
  assert.deepEqual(bare.mcpConnectionIds, []);
});

test("a coding task's developer message drops the cowork document and Feishu tooling but keeps the permission", async (t) => {
  const { directory, config, work } = await sessionConfig(t);
  const base = { ...config, feishu: { binary: process.execPath }, feishuBusinessLinked: false, chatModel: "GLM-5.3" };
  const coding = (await createTaskRuntime(base, { mode: "coding", cwd: work })).params.developerInstructions;
  const cowork = (await createTaskRuntime(base, { mode: "cowork", cwd: work })).params.developerInstructions;
  for (const coworkOnly of [/doc-tool\.js/, /Word document/, /not linked to the local Feishu CLI/]) {
    assert.doesNotMatch(coding, coworkOnly, "a coding task must not carry cowork tooling instructions");
    assert.match(cowork, coworkOnly);
  }
  // Both still carry the permission's own sandbox rules.
  assert.match(coding, /read and write inside the working directory/);
  assert.match(cowork, /read and write inside the working directory/);
});

test("a coding task on a site's folder is told what publishing will take, before it adds anything", async (t) => {
  // 2026-09-23: asked to put a video on the product page, a coding task copied an
  // .mp4 and wrote a faq.md into the site; 发布 refused the whole version at the end.
  const { directory, config, work } = await sessionConfig(t);
  const base = { ...config, feishu: { binary: process.execPath }, feishuBusinessLinked: false, chatModel: "GLM-5.3" };
  const onSite = (await createTaskRuntime({ ...base, site: { name: "i豆 产品发布页" } }, { mode: "coding", cwd: work })).params.developerInstructions;
  assert.match(onSite, /folder of "i豆 产品发布页"/);
  assert.match(onSite, /only html, css, js, mjs, json, png, jpg, jpeg, webp, svg, woff2, mp4, webm files/);
  assert.match(onSite, /at most 8 MiB for an mp4 or webm video and 2 MiB for any other file, 128 files and 10 MiB in all/);
  assert.match(onSite, /Audio, Markdown, plain text, GIF, mov/);
  assert.match(onSite, /compressed to fit/);
  assert.match(onSite, /read and write inside the working directory/, "and it still carries the permission");
  // Anywhere else, and in a work task, nothing is said about sites.
  const elsewhere = (await createTaskRuntime(base, { mode: "coding", cwd: work })).params.developerInstructions;
  const cowork = (await createTaskRuntime({ ...base, site: { name: "i豆 产品发布页" } }, { mode: "cowork", cwd: work })).params.developerInstructions;
  assert.doesNotMatch(elsewhere, /publishes as a static website/);
  assert.doesNotMatch(cowork, /publishes as a static website/);
});

test("a work task is told to wait out a confirmation rather than end its turn under it", async (t) => {
  // On 2026-09-23 a turn waited about a minute and a half on a send the person
  // had not reached yet, decided nobody would answer, and ended -- which
  // withdrew the card before it could be clicked.
  const { directory, config, work } = await sessionConfig(t);
  const bridge = { IDOU_FEISHU_BRIDGE: "http://127.0.0.1:9", IDOU_FEISHU_BRIDGE_KEY: "k".repeat(43), IDOU_FEISHU_BRIDGE_TASK: "task" };
  const base = { ...config, feishu: { binary: process.execPath }, agentFeishuEnvironment: () => bridge, chatModel: "GLM-5.3" };
  const cowork = (await createTaskRuntime(base, { id: "11111111-1111-4111-8111-111111111111", mode: "cowork", cwd: work })).params.developerInstructions;
  assert.match(cowork, /does not return until the user has answered/);
  assert.match(cowork, /do not end your turn before it does/);
});

test("every credential handed to the Agent's shell is named as a secret for the task's record to hide", async (t) => {
  // The bridge key reached a task's record through `env` on 2026-09-23
  // (task-service.test.js holds the record's side of this).
  const { directory, config, work } = await sessionConfig(t);
  const bridge = { IDOU_FEISHU_BRIDGE: "http://127.0.0.1:52746", IDOU_FEISHU_BRIDGE_KEY: "k".repeat(43), IDOU_FEISHU_BRIDGE_TASK: "11111111-1111-4111-8111-111111111111" };
  const sidecar = { LARKSUITE_CLI_PROXY_KEY: "p".repeat(43), LARKSUITE_CLI_AUTH_PROXY: "http://127.0.0.1:52747" };
  const base = { ...config, feishu: { binary: process.execPath, environment: () => sidecar }, agentFeishuEnvironment: () => bridge, chatModel: "GLM-5.3" };
  const runtime = await createTaskRuntime(base, { id: bridge.IDOU_FEISHU_BRIDGE_TASK, mode: "cowork", cwd: work });
  const shell = runtime.params.config["shell_environment_policy.set"];
  assert.equal(shell.IDOU_FEISHU_BRIDGE_KEY, bridge.IDOU_FEISHU_BRIDGE_KEY, "the Agent's shell does hold the key");
  assert.equal(shell.LARKSUITE_CLI_PROXY_KEY, sidecar.LARKSUITE_CLI_PROXY_KEY);
  assert.ok(runtime.secrets.includes(bridge.IDOU_FEISHU_BRIDGE_KEY));
  assert.ok(runtime.secrets.includes(sidecar.LARKSUITE_CLI_PROXY_KEY));
  for (const plain of [bridge.IDOU_FEISHU_BRIDGE, bridge.IDOU_FEISHU_BRIDGE_TASK, sidecar.LARKSUITE_CLI_AUTH_PROXY, directory]) {
    assert.equal(runtime.secrets.includes(plain), false, `${plain} is not a secret and stays readable`);
  }
});

test("every shipped chat model tells Codex its context window, so a long task is compacted before it overflows", async () => {
  const catalog = JSON.parse(await readFile(new URL("../src/providers/codex/model-catalog.json", import.meta.url), "utf8"));
  for (const entry of catalog.models) {
    assert.ok(Number.isInteger(entry.context_window) && entry.context_window >= 100_000, `${entry.slug} context_window`);
    assert.ok(entry.effective_context_window_percent > 0 && entry.effective_context_window_percent <= 100, `${entry.slug} effective_context_window_percent`);
    assert.equal(entry.truncation_policy?.mode, "tokens", `${entry.slug} truncates tool output by tokens`);
  }
});

// Subagents are on, two at a time, and cannot switch models (the server may
// offer only one); the deprecated flag that only raised a warning is gone; and
// every shipped model declares the v2 protocol, whose tools run locally in Codex
// instead of needing a provider feature.
test("subagents run on Codex's local v2 tools, two at a time, on the task's own model", async (t) => {
  const { config } = await sessionConfig(t);
  const { overrides } = await gatewayRuntimeConfig(config, { PATH: "/bin" });
  assert.equal(overrides["features.multi_agent"], true);
  assert.equal(overrides["features.multi_agent_v2.max_concurrent_threads_per_session"], 2);
  assert.equal(overrides["features.multi_agent_v2.expose_spawn_agent_model_overrides"], false);
  assert.equal("features.collab" in overrides, false);
  const catalog = JSON.parse(await readFile(new URL("../src/providers/codex/model-catalog.json", import.meta.url), "utf8"));
  for (const entry of catalog.models) assert.equal(entry.multi_agent_version, "v2", `${entry.slug} must declare the local subagent tools`);
});

test("the Agent's shell finds an apply_patch that applies nothing and says to send the patch on its own", async (t) => {
  const { directory, config, work } = await sessionConfig(t);
  const base = { ...config, feishu: { binary: process.execPath }, feishuBusinessLinked: false, chatModel: "GLM-5.3" };
  const runtime = await createTaskRuntime(base, { mode: "coding", cwd: work });
  assert.equal(runtime.params.config["shell_environment_policy.set"].PATH.split(path.delimiter).at(-1), AGENT_SHELL_DIRECTORY);
  const result = spawnSync(path.join(AGENT_SHELL_DIRECTORY, "apply_patch"), [], { input: "*** Begin Patch\n*** End Patch\n", encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /was not applied/); assert.match(result.stderr, /separate call/);
  assert.match(runtime.params.baseInstructions, /Nothing may come before or after it/);
});

// A packaged app is meant to run where Node was never installed, and the product's
// own tools are run as `node <tool>`. The Agent's shell therefore has a node that
// runs the application's own runtime, last on its PATH so a real node wins.
test("the Agent's shell has a node where the person has none: the application's own runtime", async (t) => {
  const { directory, config, work } = await sessionConfig(t);
  const base = { ...config, feishu: { binary: process.execPath }, feishuBusinessLinked: false, chatModel: "GLM-5.3" };
  const shell = (await createTaskRuntime(base, { mode: "coding", cwd: work })).params.config["shell_environment_policy.set"];
  assert.equal(shell.IDOU_NODE_RUNTIME, process.execPath, "the Agent's commands learn which runtime is the application's");
  const node = path.join(AGENT_SHELL_DIRECTORY, "node");
  const ran = spawnSync(node, ["-e", "process.stdout.write(`${process.env.ELECTRON_RUN_AS_NODE}:${process.argv.slice(1).join('|')}`)", "a b", "c"],
    { env: { PATH: "/usr/bin:/bin", IDOU_NODE_RUNTIME: process.execPath }, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, "1:a b|c", "it runs the runtime as Node and passes the arguments through untouched");
  const missing = spawnSync(node, ["-e", "0"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /node: command not found/);
});

test("a planning turn is read-only whatever the task's own permission says", async (t) => {
  const { directory, config, work } = await sessionConfig(t);
  const base = { ...config, feishu: { binary: process.execPath }, feishuBusinessLinked: false };
  // 自动 is the widest ordinary setting: workspace-write, no approvals. While
  // the task is still planning it must not apply -- the person has not yet
  // read a plan, and the first thing they should see is not files changing.
  const planning = await createTaskRuntime(base, { mode: "coding", cwd: work, permission: "auto", stage: "planning" });
  assert.equal(planning.params.sandbox, "read-only");
  assert.match(planning.params.developerInstructions, /Read-only turn/);
  // And their choice is what runs the moment they say 开始做.
  const building = await createTaskRuntime(base, { mode: "coding", cwd: work, permission: "auto", stage: "building" });
  assert.equal(building.params.sandbox, "workspace-write");
  assert.equal(building.params.approvalPolicy, "never");
  // A task recorded before this existed has no stage, and behaves as it did.
  const older = await createTaskRuntime(base, { mode: "coding", cwd: work, permission: "auto" });
  assert.equal(older.params.sandbox, "workspace-write");
});

// 标准 has no network for commands, and the application's own tools reach it by
// a rule each (tool-rules.js), which rests on no sandboxed task being able to
// rewrite them or the rules.
test("a sandboxed task is refused a folder that holds the application's own tools or rules, and told the exact commands otherwise", async (t) => {
  const { directory, work, config } = await sessionConfig(t);
  const base = { ...config, feishu: { binary: process.execPath }, chatModel: "GLM-5.3", agentFeishuEnvironment: () => ({}) };
  await assert.rejects(createTaskRuntime(base, { id: "t1", mode: "cowork", cwd: directory, permission: "standard" }), /包含 i豆 自己的程序或数据/);
  await assert.rejects(createTaskRuntime(base, { id: "t1", mode: "cowork", cwd: directory, permission: "auto" }), /包含 i豆 自己的程序或数据/);
  // Full access has no sandbox to keep, and a read-only one cannot write.
  await createTaskRuntime(base, { id: "t1", mode: "cowork", cwd: directory, permission: "full" });
  await createTaskRuntime(base, { id: "t1", mode: "cowork", cwd: directory, permission: "manual" });

  const runtime = await createTaskRuntime(base, { id: "t1", mode: "cowork", cwd: work, permission: "standard" });
  const said = runtime.params.developerInstructions;
  const launcher = path.join(config.codex.toolsDirectory, "idou-agent");
  assert.ok(said.includes(`run \`${launcher} --help\``), "the agent tool by its launcher, unquoted");
  assert.ok(said.includes(`Use the bundled Feishu executable ${process.execPath} for every Feishu operation`), "the Feishu CLI by its own path, unquoted");
  assert.match(said, /unquoted, at the start of a command of its own/);
  assert.match(said, /Commands have no network access/);
  const rules = await readFile(path.join(config.codex.dataDir, "rules", "idou.rules"), "utf8");
  assert.ok(rules.includes(JSON.stringify(process.execPath)) && rules.includes(JSON.stringify(launcher)));
  assert.equal(runtime.params.config["sandbox_workspace_write.network_access"], false);
});
