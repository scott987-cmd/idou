import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { readClientSession } from "../../control-plane/client-session.js";
import { DEFAULT_CHAT_MODEL, isChatModel } from "./chat-models.js";
import { dataHome } from "../../install-names.js";
import { nodeRuntime } from "../node-runtime.js";

export function clientEnvironment(source = process.env) {
  // Do not inherit provider keys, cloud credentials, NODE_OPTIONS or unrelated
  // Codex configuration. The product never reads the user's Codex auth file.
  const allowed = ["HOME", "USERPROFILE", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TMP", "TEMP", "SHELL", "SystemRoot", "COMSPEC"];
  return Object.fromEntries(allowed.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

// The product keeps its own Codex home, separate from the person's own
// `~/.codex`. Everything installed through 技能中心 lands here and nowhere else,
// so managing extensions can never disturb their personal Codex setup — and it
// needs no session, unlike a model turn.
export async function codexRuntimeHome(config, sourceEnv = process.env) {
  const runtimeHome = path.resolve(config.codex.dataDir || path.join(dataHome(), "codex"));
  await mkdir(runtimeHome, { recursive: true, mode: 0o700 });
  // What Codex runs of the application's -- the token helper below -- runs on
  // the application's Node, and inherits what that Node needs from here.
  return { home: runtimeHome, env: { ...clientEnvironment(sourceEnv), CODEX_HOME: runtimeHome, ...nodeRuntime().env } };
}

// The name Codex knows the product's gateway by. It was "mydoubao" before the
// rename; a conversation recorded under that name continues under this one
// (test/codex-background-command.test.js asks the real binary).
export const MODEL_PROVIDER = "idou";

// `model` is the one the control plane enforces (the desktop learns it from the
// server). Codex asks the product gateway for exactly that slug and takes its
// metadata from the catalog shipped here; which provider serves it, and with
// which key, is the server's business and never reaches this process.
export async function gatewayRuntimeConfig(config, sourceEnv = process.env, { model = DEFAULT_CHAT_MODEL } = {}) {
  if (!isChatModel(model)) throw new Error("Unsupported chat model");
  const sessionFile = config.controlPlane.sessionFile;
  const { serverUrl } = await readClientSession(sessionFile, config.controlPlane.baseUrl);
  const { home: runtimeHome } = await codexRuntimeHome(config, sourceEnv);
  const overrides = {
    model, model_provider: MODEL_PROVIDER, model_reasoning_effort: "high", web_search: "disabled",
    model_catalog_json: fileURLToPath(new URL("./model-catalog.json", import.meta.url)),
    [`model_providers.${MODEL_PROVIDER}`]: {
      name: "i豆 model gateway", base_url: `${serverUrl}/v1`, wire_api: "responses",
      request_max_retries: 0, stream_max_retries: 0,
      auth: { command: nodeRuntime().command, args: [fileURLToPath(new URL("../../../bin/agent-token.js", import.meta.url)), sessionFile, serverUrl], timeout_ms: 5000, refresh_interval_ms: 60_000 },
    },
    "analytics.enabled": false, "feedback.enabled": false,
    // Subagents are on. Codex offers them as one `collaboration` namespace of six
    // tools, which mcp-tool-wire.js admits by exact name and list and passes on
    // under their own names; a child's final answer comes back as an
    // agent_message item, which LiteLLM drops without a word, so the gateway
    // hands it on as a framed user message. At most two children run at once,
    // and a child cannot pick another model: the server may offer only one, and a
    // model it does not offer fails the child at the gateway. (`features.collab`
    // is the deprecated name of multi_agent and only raised a warning.)
    "features.multi_agent": true,
    "features.multi_agent_v2.max_concurrent_threads_per_session": 2,
    "features.multi_agent_v2.expose_spawn_agent_model_overrides": false,
    // The Agent's questions reach the person. Without this Codex offers
    // request_user_input but answers it itself outside Plan mode ("unavailable in
    // Default mode"), and no task here runs in Plan mode. With it the pinned
    // 0.147.0 -- and 0.154.0 alike -- forwards item/tool/requestUserInput to the
    // client and waits for the answer: with the answer held back 30 seconds, the
    // model's next request came only after it. Upstream still marks the flag as
    // under development, so scripts/smoke-coding-task-desktop.js fails if a Codex
    // update stops forwarding.
    "features.default_mode_request_user_input": true,
    // The plan beside the conversation is update_plan's, and the coding
    // instructions ask for it by name. From 0.152 Codex offers the tool only
    // when asked (#41744); without this line a 0.155 turn had no plan to show,
    // and a model following its instructions would call a tool that was not
    // there. scripts/smoke-coding-task-desktop.js checks the plan appears.
    "tools.update_plan.enabled": true,
    "shell_environment_policy.inherit": "none", "shell_environment_policy.set": clientEnvironment(sourceEnv),
    allow_login_shell: false,
  };
  return { model, overrides, env: { ...clientEnvironment(sourceEnv), CODEX_HOME: runtimeHome, ...nodeRuntime().env } };
}

// Values only, never keys/secrets; TOML inline tables preserve nested config.
export function tomlValue(value) {
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`).join(", ")} }`;
  throw new Error("Unsupported Codex config value");
}
