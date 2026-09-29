// The Codex configuration a sandboxed run uses. It is the desktop's
// configuration with the two parts that only make sense on a desktop replaced:
// where the model lives, and how to authenticate to it.
//
//   * `base_url` points at the egress proxy rather than the control plane. The
//     container can reach exactly one address, and that is it.
//   * the auth command prints the run token instead of reading a session file.
//     There is no session file in a sandbox, and there must not be one.
export const CATALOG = "/opt/mydoubao/src/providers/codex/model-catalog.json";
export const AUTH_COMMAND = "/opt/mydoubao/bin/sandbox/agent-token.js";

const string = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function codexConfig({ model, egress, home }) {
  if (!/^https:\/\/[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/i.test(egress ?? "")) throw new Error("Codex 配置需要一个 HTTPS 出口地址");
  if (!/^[A-Za-z0-9][\w.:-]{0,63}$/.test(model ?? "")) throw new Error("Codex 配置需要一个合法的模型名");
  return [
    `model = ${string(model)}`,
    `model_provider = "mydoubao"`,
    `model_reasoning_effort = "high"`,
    `web_search = "disabled"`,
    `model_catalog_json = ${string(CATALOG)}`,
    // Nobody is there to approve anything, so nothing may stop to ask. The
    // container is what bounds this run, not an approval prompt.
    `approval_policy = "never"`,
    // Codex's own sandbox is deliberately off. The container already is the
    // boundary -- read-only image, every capability dropped, non-root, and one
    // reachable address -- and Codex's landlock/seccomp layer cannot initialise
    // under `cap-drop ALL` anyway, so leaving it on would fail the run rather
    // than protect it. One boundary, and it is the one that has been verified.
    `sandbox_mode = "danger-full-access"`,
    ``,
    `[model_providers.mydoubao]`,
    `name = "MyDouBao Sandbox Egress"`,
    `base_url = ${string(`${egress}/v1`)}`,
    `wire_api = "responses"`,
    `request_max_retries = 0`,
    `stream_max_retries = 0`,
    ``,
    `[model_providers.mydoubao.auth]`,
    `command = "node"`,
    `args = [${string(AUTH_COMMAND)}]`,
    `timeout_ms = 5000`,
    `refresh_interval_ms = 60000`,
    ``,
    `[analytics]`,
    `enabled = false`,
    ``,
    `[feedback]`,
    `enabled = false`,
    ``,
  ].join("\n");
}

// Codex writes into its home at startup -- it warns and degrades if it cannot.
// The workspace is the one writable path in the container and is destroyed with
// the run, so its home goes there rather than into a tmpfs it would share with
// nothing.
export const codexHome = (workspace = "/workspace") => `${workspace}/.codex`;
