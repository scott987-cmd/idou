import test from "node:test";
import assert from "node:assert/strict";
import { adminPage, adminState } from "../src/control-plane/admin-console.js";

// 服务状态 on the console: what the server's own checks last said
// (health-monitor.js), worst first, in the administrator's words.
test("the console shows what the server's checks found, and says when there is nothing yet", () => {
  const checks = { level: "critical", checks: [
    { name: "sandbox", label: "定时任务沙箱", level: "critical", summary: "定时任务沙箱不可用，到点的任务都会记为失败（原因见服务端启动日志）。", value: 0, at: 1 },
    { name: "disk", label: "数据盘", level: "ok", summary: "/var/lib/idou 所在的盘还剩 40.0 GB（61%）。", value: 1, at: 1 },
    { name: "public_certificate_x", label: "<x> 的 HTTPS 证书", level: "warning", summary: "证书还剩 12 天。", value: 1, at: 1 },
  ] };
  const state = adminState({ checks });
  assert.deepEqual(state.checks.checks.map((check) => check.name), ["sandbox", "disk", "public_certificate_x"]);
  const page = adminPage(state);
  assert.match(page, /<h2>服务状态<\/h2>/);
  assert.match(page, /定时任务沙箱<\/td><td><b class="bad">严重<\/b><\/td><td>定时任务沙箱不可用/);
  assert.match(page, /数据盘<\/td><td>正常<\/td>/);
  assert.match(page, /&lt;x&gt; 的 HTTPS 证书<\/td><td><b class="bad">告警<\/b>/, "escaped");
  assert.match(adminPage(adminState({})), /还没有自检结果/);
});
