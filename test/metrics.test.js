// The metrics an operator reads to size the server (src/control-plane/metrics.js),
// and, through them, that the capacity settings reach the three places they
// govern: a limit read from the deployment file and never handed to the model
// gateway, the Feishu proxy or the scheduler would change nothing and look
// configured. So the real server is started with limits set, and asked.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectMetrics, renderMetrics } from "../src/control-plane/metrics.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { readReleaseManifest } from "../src/providers/release-manifest.js";

const entry = fileURLToPath(new URL("../bin/server.js", import.meta.url));
const free = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

test("the exposition is counts and limits, never who", () => {
  const sessions = new SessionRegistry();
  sessions.issue({ tenantId: "tenant_secret_fixture", userId: "ou_secret_fixture", deviceId: "device-secret" });
  const gateway = createModelGateway({ apiKey: "k", sessions, maxConcurrent: 12, maxConcurrentPerUser: 3 });
  const text = renderMetrics(collectMetrics({ release: "0.1.0-fixture.1", startedAt: Date.now() - 5000, sessions, gateway }));
  assert.match(text, /^# TYPE idou_model_requests_limit gauge$/m);
  assert.match(text, /^idou_model_requests_limit 12$/m);
  assert.match(text, /^idou_model_requests_limit_per_user 3$/m);
  assert.match(text, /^idou_model_requests_rejected_total\{reason="person"\} 0$/m);
  assert.match(text, /^idou_sessions\{audience="codex-model-gateway"\} 1$/m);
  assert.match(text, /^idou_release_info\{release="0.1.0-fixture.1"\} 1$/m);
  assert.doesNotMatch(text, /secret|tenant_|\bou_|device/, "nobody's identity appears");
  // A value that is not a number is reported as 0 rather than breaking the format.
  assert.match(renderMetrics([{ name: "x_total", help: "h", type: "counter", values: [{ value: Number.NaN }] }]), /^x_total 0$/m);
  assert.throws(() => renderMetrics([{ name: "bad-name", help: "h", type: "gauge", values: [] }]), /Invalid metric/);
  assert.equal(renderMetrics([{ name: "q", help: "h", type: "gauge", values: [{ labels: { reason: "a\"b\n" }, value: 1 }] }]).split("\n")[2], 'q{reason="a\\"b\\n"} 1');
});

test("the real server reports the limits it was configured with, on this machine only, and closes that listener on SIGTERM", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-server-metrics-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const [port, metricsPort] = [await free(), await free()];
  const child = spawn(process.execPath, [entry, "--feishu"], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), LANG: process.env.LANG ?? "C",
    IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:9", IDOU_LITELLM_API_KEY: "synthetic-litellm-key-fixture",
    IDOU_SCHEDULED_TASKS: "1", IDOU_SCHEDULED_TASKS_DIR: path.join(home, "scheduled"), IDOU_SCHEDULED_TASKS_PORT: "0",
    IDOU_PUBLIC_URL: `http://127.0.0.1:${port}`, IDOU_PORT: String(port),
    FEISHU_APP_ID: "cli_a1b2c3d4e5f60718", FEISHU_APP_SECRET: "synthetic-secret", FEISHU_ALLOWED_TENANTS: "tenant_fixture",
    FEISHU_SOURCE_ACCESS_ENABLED: "1", FEISHU_CLI_BRIDGE_ENABLED: "1", FEISHU_CLI_SCOPES: "docx:document:readonly",
    IDOU_METRICS_PORT: String(metricsPort),
    IDOU_MODEL_MAX_CONCURRENT: "48", IDOU_MODEL_MAX_CONCURRENT_PER_USER: "5", IDOU_MODEL_REQUESTS_PER_MINUTE: "120",
    IDOU_FEISHU_CLI_MAX_CONCURRENT: "96", IDOU_FEISHU_CLI_MAX_CONCURRENT_PER_USER: "7", IDOU_SCHEDULE_MAX_CONCURRENT: "6",
    // Held to the release as strictly as this run is (npm run check:release).
    ...(process.env.IDOU_RELEASE_VERIFICATION ? { IDOU_RELEASE_VERIFICATION: process.env.IDOU_RELEASE_VERIFICATION } : {}) } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(child, "close");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } });
  for (const until = Date.now() + 20_000; !/Listening on loopback port/.test(output) && child.exitCode === null && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(output, /Metrics: http:\/\/127\.0\.0\.1:\d+\/metrics/, output.slice(-1500));

  const text = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
  for (const [name, value] of [["idou_model_requests_limit", 48], ["idou_model_requests_limit_per_user", 5], ["idou_model_requests_per_minute_limit", 120],
    ["idou_feishu_cli_calls_limit", 96], ["idou_feishu_cli_calls_limit_per_user", 7], ["idou_schedule_runs_limit", 6]]) {
    assert.match(text, new RegExp(`^${name} ${value}$`, "m"), `${name} is the configured ${value}:\n${text}`);
  }
  // What it runs as: the signed release, or in a checkout that has moved on
  // since, that release under development (release-manifest.js).
  const { releaseId } = await readReleaseManifest();
  assert.match(releaseId, /^0\.1\.0-\d{8}\.\d+(\+dev)?$/);
  assert.ok(text.split("\n").includes(`idou_release_info{release="${releaseId}"} 1`), `the release it runs, ${releaseId}:\n${text}`);
  // The pilot's constants, now the server's capacity: a hundred thousand people, not a hundred.
  for (const [name, value] of [["idou_signed_in_limit", 200000], ["idou_feishu_reads_limit", 128], ["idou_signed_in_sessions", 0]]) {
    assert.match(text, new RegExp(`^${name} ${value}$`, "m"), `${name} is ${value}:\n${text}`);
  }
  assert.match(text, /^idou_event_loop_delay_seconds\{quantile="0.99"\} [\d.e-]+$/m);
  assert.equal((await fetch(`http://127.0.0.1:${metricsPort}/other`)).status, 404);

  child.kill("SIGTERM");
  let timer;
  const stopped = await Promise.race([closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 10_000); })]);
  clearTimeout(timer);
  assert.equal(stopped, true, `still running 10s after SIGTERM:\n${output.slice(-600)}`);
  assert.doesNotMatch(output, /仍有资源没有释放/);
});
