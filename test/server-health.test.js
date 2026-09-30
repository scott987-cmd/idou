import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The server's own checks, as the real entry point wires them (bin/server.js,
// health-monitor.js): run at start, on the metrics listener as numbers and as
// GET /health, which answers 503 while anything is critical. Found in the
// long-running review (2026-09-29): nothing but /healthz existed, and it said
// "ok" for as long as the process answered.
const entry = fileURLToPath(new URL("../bin/server.js", import.meta.url));

async function boot(t, extra = {}, mode = "--feishu") {
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-server-health-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  // No Docker on PATH: the sandbox cannot start, which is what makes one check
  // critical here. No real key or Feishu reaches it.
  const child = spawn(process.execPath, [entry, mode], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), LANG: process.env.LANG ?? "C",
    IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:9", IDOU_LITELLM_API_KEY: "synthetic-litellm-key-fixture",
    IDOU_SCHEDULED_TASKS: "1", IDOU_SCHEDULED_TASKS_DIR: path.join(home, "scheduled"), IDOU_SCHEDULED_TASKS_PORT: "0",
    IDOU_PUBLIC_URL: `http://127.0.0.1:${port}`, IDOU_PORT: String(port), IDOU_METRICS_PORT: String(port + 2),
    FEISHU_APP_ID: "cli_a1b2c3d4e5f60718", FEISHU_APP_SECRET: "synthetic-secret", FEISHU_ALLOWED_TENANTS: "tenant_fixture",
    FEISHU_SOURCE_ACCESS_ENABLED: "1", FEISHU_SESSION_RENEWAL_ENABLED: "1", FEISHU_LONG_SESSION_DAYS: "30", ...extra } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(child, "close");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } });
  return { child, closed, port, output: () => output };
}

test("the checks run at start, and /health and /metrics on this machine say what they found", async (t) => {
  const server = await boot(t);
  const deadline = Date.now() + 30_000;
  let health = null;
  while (Date.now() < deadline && server.child.exitCode === null) {
    const answer = await fetch(`http://127.0.0.1:${server.port + 2}/health`).catch(() => null);
    if (answer) {
      const body = await answer.json();
      if (body.checks.length) { health = { status: answer.status, body }; break; }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(health, server.output().slice(-1500));
  assert.match(server.output(), /Health checks: \d+, every 5 minutes\./, "without IDOU_ADMIN_ALERTS nobody is messaged");
  const byName = Object.fromEntries(health.body.checks.map((check) => [check.name, check]));
  assert.equal(byName.sandbox.level, "critical", "no Docker here, so no sandbox");
  assert.equal(health.status, 503, "and a critical check makes /health 503");
  assert.equal(health.body.level, "critical");
  assert.equal(byName.egress_certificate.level, "ok", "a certificate issued moments ago");
  assert.ok(["ok", "warning", "critical"].includes(byName.disk.level));
  for (const name of ["scheduled_runs", "result_push", "schedule_suspensions", "model_upstream"]) assert.equal(byName[name]?.level, "ok", name);
  const metrics = await (await fetch(`http://127.0.0.1:${server.port + 2}/metrics`)).text();
  assert.match(metrics, /^idou_health_check\{check="sandbox"\} 2$/m);
  assert.match(metrics, /^idou_health_check_value\{check="egress_certificate"\} \d+$/m);
});

test("asking for alerts without anybody to send them to, or without a Feishu application, stops the start", async (t) => {
  const nobody = await boot(t, { IDOU_ADMIN_ALERTS: "1" });
  await nobody.closed;
  assert.match(nobody.output(), /IDOU_ADMIN_ALERTS=1 需要知道发给谁：设 IDOU_ADMIN_USERS 或 IDOU_ADMIN_CHAT/);
  assert.notEqual(nobody.child.exitCode, 0);
  const noApplication = await boot(t, { IDOU_ADMIN_ALERTS: "1", IDOU_ADMIN_USERS: "ou_boss" }, "--dev");
  await noApplication.closed;
  assert.match(noApplication.output(), /IDOU_ADMIN_ALERTS=1 需要飞书应用（FEISHU_APP_ID、FEISHU_APP_SECRET）：告警由应用机器人发出/);
  assert.notEqual(noApplication.child.exitCode, 0);
});
