import test from "node:test";
import assert from "node:assert/strict";
import { systemState } from "../src/control-plane/admin-console.js";

// 服务状态 in the console: what the server's own checks last said
// (health-monitor.js), the models and whether they answer, and nothing that
// anybody said.
test("the system state carries the checks, the models as health finds them, and the policy as written", () => {
  const checks = { level: "critical", checks: [
    { name: "sandbox", label: "定时任务沙箱", level: "critical", summary: "定时任务沙箱不可用，到点的任务都会记为失败（原因见服务端启动日志）。", value: 0, at: 1 },
    { name: "disk", label: "数据盘", level: "ok", summary: "/var/lib/idou 所在的盘还剩 40.0 GB（61%）。", value: 1, at: 1 },
  ] };
  const state = systemState({ checks, release: "0.1.0-20261002.267",
    models: [{ id: "MiniMax-M3", provider: "minimax", isDefault: true }, { id: "GLM-5.3", provider: "litellm" }],
    health: { usable: (id) => id === "MiniMax-M3" },
    visibility: { enabled: true, defaultVisible: "all", rules: [{ kind: "chat", id: "oc_x", models: new Set(["GLM-5.3"]) }] } });
  assert.deepEqual(state.checks.checks.map((check) => check.name), ["sandbox", "disk"]);
  assert.equal("value" in state.checks.checks[0], false, "only what the page shows");
  assert.deepEqual(state.models.map((model) => [model.id, model.usable, model.isDefault]), [["MiniMax-M3", true, true], ["GLM-5.3", false, false]]);
  assert.deepEqual(state.visibility.rules, [{ kind: "chat", id: "oc_x", models: ["GLM-5.3"] }]);
  assert.equal(state.release, "0.1.0-20261002.267");
  assert.deepEqual(systemState({}).checks, null);
  assert.deepEqual(systemState({}).visibility, { enabled: false });
});
