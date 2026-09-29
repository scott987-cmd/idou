import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The real entry point, stopped the way a supervisor stops it. A development
// server with scheduled tasks on used to ignore SIGTERM in effect: its shutdown
// never closed them, and their egress listener kept the process alive. Every
// end-to-end run left one behind, still holding its port and its scheduler.
const entry = fileURLToPath(new URL("../bin/server.js", import.meta.url));

test("a development server with scheduled tasks on exits on SIGTERM", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-server-stop-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // No real key reaches it, and no Docker: PATH holds only the system
  // directories, so the sandbox check fails fast instead of touching a daemon
  // another control plane on this machine may be using.
  const child = spawn(process.execPath, [entry, "--dev"], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), LANG: process.env.LANG ?? "C",
    IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:9", IDOU_LITELLM_API_KEY: "synthetic-litellm-key-fixture",
    IDOU_SCHEDULED_TASKS: "1", IDOU_SCHEDULED_TASKS_DIR: path.join(home, "scheduled"), IDOU_SCHEDULED_TASKS_PORT: "0" } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(child, "close");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } });

  const deadline = Date.now() + 20_000;
  while (!/Client connection file: .+\n/.test(output) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(output, /Scheduled tasks: on/, output);
  const sessionFile = /Client connection file: (.+)\n/.exec(output)?.[1];
  assert.ok(sessionFile && existsSync(sessionFile), "the development session was published");

  child.kill("SIGTERM");
  let timer;
  const stopped = await Promise.race([closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 10_000); })]);
  clearTimeout(timer);
  assert.equal(stopped, true, `still running 10s after SIGTERM:\n${output.slice(-600)}`);
  assert.equal(existsSync(sessionFile), false, "and it took its session file with it");
});

// And the way the server itself runs: `--feishu`, with 文档网站 on as well.
// Its listener was never closed in either mode, so every restart of the
// server waited out systemd's 90 seconds and was then killed (reproduced on
// 2026-09-26 by booting the real server). The process must end promptly, and
// by itself -- not by the deadline that names what was left open.
async function stopsWithSites(t, mode) {
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-server-stop-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const port = 30_000 + Math.floor(Math.random() * 20_000);
  const child = spawn(process.execPath, [entry, mode], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), LANG: process.env.LANG ?? "C",
    IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:9", IDOU_LITELLM_API_KEY: "synthetic-litellm-key-fixture",
    IDOU_SCHEDULED_TASKS: "1", IDOU_SCHEDULED_TASKS_DIR: path.join(home, "scheduled"), IDOU_SCHEDULED_TASKS_PORT: "0",
    IDOU_SITES: "1", IDOU_SITES_URL: `http://127.0.0.1:${port + 1}`, IDOU_SITES_PORT: String(port + 1),
    IDOU_SITES_DIR: path.join(home, "sites"), IDOU_ADMIN_USERS: "ou_boss",
    ...(mode === "--feishu" ? { IDOU_PUBLIC_URL: `http://127.0.0.1:${port}`, IDOU_PORT: String(port),
      FEISHU_APP_ID: "cli_a1b2c3d4e5f60718", FEISHU_APP_SECRET: "synthetic-secret", FEISHU_ALLOWED_TENANTS: "tenant_fixture",
      FEISHU_SOURCE_ACCESS_ENABLED: "1", FEISHU_SESSION_RENEWAL_ENABLED: "1", FEISHU_LONG_SESSION_DAYS: "30" } : {}) } });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(child, "close");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } });

  const ready = mode === "--feishu" ? /Listening on loopback port/ : /Client connection file: .+\n/;
  const deadline = Date.now() + 20_000;
  while (!ready.test(output) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.match(output, ready, output.slice(-1500));
  assert.match(output, /sites-listening/, "文档网站 is listening");
  assert.match(output, /Scheduled tasks: on/, output.slice(-600));

  const signalled = Date.now();
  child.kill("SIGTERM");
  let timer;
  const stopped = await Promise.race([closed.then(() => Date.now()), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 10_000); })]);
  clearTimeout(timer);
  assert.ok(stopped, `still running 10s after SIGTERM:\n${output.slice(-600)}`);
  assert.ok(stopped - signalled < 5_000, `took ${stopped - signalled} ms`);
  assert.equal(child.exitCode, 0);
  assert.doesNotMatch(output, /仍有资源没有释放/, "it ended by itself, not by the deadline");
}

test("the server as it runs, with 文档网站 on, exits promptly on SIGTERM", { timeout: 60_000 }, (t) => stopsWithSites(t, "--feishu"));

test("a development server with 文档网站 on exits promptly on SIGTERM", { timeout: 60_000 }, (t) => stopsWithSites(t, "--dev"));
