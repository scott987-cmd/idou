import test from "node:test";
import assert from "node:assert/strict";
import { codexConfig, codexHome, CATALOG, AUTH_COMMAND } from "../bin/sandbox/codex-config.js";

const base = { model: "MiniMax-M3", egress: "https://egress.mydoubao.internal:881" };
const line = (config, key) => config.split("\n").find((row) => row.startsWith(`${key} =`));

test("the model is reached through the egress proxy, never through a control plane", () => {
  const config = codexConfig(base);
  assert.equal(line(config, "base_url"), `base_url = "https://egress.mydoubao.internal:881/v1"`);
  assert.ok(config.includes("[model_providers.mydoubao]"));
  assert.equal(line(config, "model"), `model = "MiniMax-M3"`);
  assert.equal(line(config, "model_provider"), `model_provider = "mydoubao"`);
});

test("authentication is the run token, because a sandbox has no session file", () => {
  const config = codexConfig(base);
  assert.ok(config.includes("[model_providers.mydoubao.auth]"));
  assert.equal(line(config, "command"), `command = "node"`);
  assert.ok(config.includes(AUTH_COMMAND), "and it runs the sandbox's own token command");
  // Nothing in the configuration may name a session file or carry a secret:
  // the container is supposed to hold only what expires with the run.
  assert.ok(!/session|\.json"\s*$|token\s*=/im.test(config.replace(AUTH_COMMAND, "").replace(CATALOG, "")),
    "no session file and no inline token");
});

test("nothing stops to ask, because nobody is there to answer", () => {
  const config = codexConfig(base);
  assert.equal(line(config, "approval_policy"), `approval_policy = "never"`);
  // Codex's own sandbox is off on purpose: the container is the boundary, and
  // that layer cannot initialise under `cap-drop ALL` anyway, so leaving it on
  // would fail the run rather than protect it.
  assert.equal(line(config, "sandbox_mode"), `sandbox_mode = "danger-full-access"`);
  assert.equal(line(config, "web_search"), `web_search = "disabled"`);
  assert.ok(config.includes("[analytics]") && config.includes("enabled = false"));
});

test("a retry would be a second unattended call, so there are none", () => {
  const config = codexConfig(base);
  assert.equal(line(config, "request_max_retries"), "request_max_retries = 0");
  assert.equal(line(config, "stream_max_retries"), "stream_max_retries = 0");
});

test("an egress that is not HTTPS, or a model name that is not one, is refused", () => {
  for (const egress of ["http://egress.mydoubao.internal:881", "https://egress.internal/v1", "", "egress.internal"]) {
    assert.throws(() => codexConfig({ ...base, egress }), /HTTPS 出口地址/, `${JSON.stringify(egress)} must be refused`);
  }
  for (const model of ["", "not a model", "../etc/passwd", '"; evil = "']) {
    assert.throws(() => codexConfig({ ...base, model }), /合法的模型名/, `${JSON.stringify(model)} must be refused`);
  }
});

test("Codex writes into the workspace, the one path that is writable and disposable", () => {
  assert.equal(codexHome("/workspace"), "/workspace/.codex");
  // Not a tmpfs it shares with nothing, and not the read-only image.
  assert.ok(codexHome().startsWith("/workspace/"));
});
