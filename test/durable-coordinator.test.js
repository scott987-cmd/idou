// The real coordinator (bin/server.js) with its durable data in the shared
// PostgreSQL (IDOU_DATA_STORE=postgres, docs/scaling-plan.md §2.5). The
// stores have tests of their own; this is the wiring they cannot see -- that
// the server opens them there, and that what one coordinator wrote the next,
// started from another machine's disk, serves.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { testPostgres } from "./helpers/postgres.js";

const entry = fileURLToPath(new URL("../bin/server.js", import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scratch(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function shared(t) {
  const server = await testPostgres(t), config = await server.database();
  const keys = await scratch(t, "idou-durable-key-"), keyFile = path.join(keys, "state.key");
  await writeFile(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600 }); await chmod(keyFile, 0o600);
  const admin = new pg.Client(config); await admin.connect(); server.closeFirst(() => admin.end());
  return { admin, env: {
    IDOU_DATABASE_URL: `postgresql:///${config.database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=${server.user}`,
    IDOU_STATE_KEY_FILE: keyFile, IDOU_DATA_STORE: "postgres",
    IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:9", IDOU_LITELLM_API_KEY: "synthetic-litellm-key-fixture" } };
}

// A coordinator on this machine: its own home, the shared settings.
function start(t, home, env) {
  const child = spawn(process.execPath, [entry, "--dev"], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", TMPDIR: os.tmpdir(), LANG: "C", HOME: home, ...env } });
  const running = { child, output: "", closed: once(child, "close") };
  child.stdout.on("data", (chunk) => { running.output += chunk; });
  child.stderr.on("data", (chunk) => { running.output += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await running.closed; } });
  running.ready = (async () => {
    for (const until = Date.now() + 30_000; !/Client connection file: /.test(running.output) && child.exitCode === null && Date.now() < until;) await wait(25);
    const file = /Client connection file: (.+)\n/.exec(running.output)?.[1];
    if (!file) return null;
    const { token, serverUrl } = JSON.parse(await readFile(file, "utf8"));
    return { token, serverUrl };
  })();
  running.stop = async () => {
    child.kill("SIGTERM");
    let timer;
    const stopped = await Promise.race([running.closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 15_000); })]);
    clearTimeout(timer);
    return stopped;
  };
  return running;
}
const ask = (session, route, body = {}) => fetch(`${session.serverUrl}${route}`, { method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify(body) });

test("a task made on one coordinator is there on the next, from another machine's disk, and on neither disk", { timeout: 120_000 }, async (t) => {
  const db = await shared(t);
  const machine = async (name) => {
    const home = await scratch(t, `mydoubao-${name}-`), scheduled = path.join(home, "scheduled");
    const driveConfig = path.join(home, "drive.json"), ledgerFile = path.join(home, "drive", "budget.sqlite");
    await writeFile(driveConfig, JSON.stringify({ schemaVersion: 1, databaseFile: ledgerFile, tenants: [{ authProvider: "development", tenantId: "development",
      appId: null, providerId: "saas-cli", driveTenantKey: "drive-tenant", folderToken: "SyntheticFolder123", maxBytes: 1000 }] }));
    return { home, scheduled, ledgerFile, env: { ...db.env, IDOU_SCHEDULED_TASKS: "1", IDOU_SCHEDULED_TASKS_DIR: scheduled,
      IDOU_SCHEDULED_TASKS_PORT: "0", IDOU_SCHEDULE_EXECUTION: "pool", IDOU_DRIVE_CONFIG_FILE: driveConfig } };
  };
  const first = await machine("first"), second = await machine("second");

  const a = start(t, first.home, first.env), sessionA = await a.ready;
  assert.ok(sessionA, a.output.slice(-1500));
  assert.match(a.output, /tasks and their runs are kept in the shared database/);
  const created = await ask(sessionA, "/v1/schedules/create", { title: "每天汇总", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork",
    schedule: { frequency: "daily", time: "09:00", timeZone: "Asia/Shanghai" }, resources: [] });
  assert.equal(created.status, 200, await created.clone().text());
  const { schedule } = await created.json();
  assert.equal(await a.stop(), true, a.output.slice(-800));

  const b = start(t, second.home, second.env), sessionB = await b.ready;
  assert.ok(sessionB, b.output.slice(-1500));
  const listed = await (await ask(sessionB, "/v1/schedules")).json();
  assert.deepEqual(listed.schedules.map((row) => [row.id, row.title]), [[schedule.id, "每天汇总"]], "the next coordinator has it");
  assert.equal(await b.stop(), true, b.output.slice(-800));

  for (const { scheduled, ledgerFile } of [first, second]) {
    assert.equal(existsSync(path.join(scheduled, "schedules.db")), false, "no task file on this machine");
    assert.equal(existsSync(ledgerFile), false, "nor a Drive ledger file");
  }
  const tables = (await db.admin.query("SELECT to_regclass('idou_schedules') IS NOT NULL AS schedules, to_regclass('idou_drive_reservations') IS NOT NULL AS drive")).rows[0];
  assert.deepEqual(tables, { schedules: true, drive: true }, "both are in the database");
  assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM idou_schedules")).rows[0].n, 1);
});

test("what has no place in the shared database yet stops the start, by name, rather than staying behind on one disk", { timeout: 60_000 }, async (t) => {
  const db = await shared(t);
  for (const name of ["IDOU_WIKI_CONFIG_FILE", "IDOU_APPS_CONFIG_FILE", "IDOU_WIKI_KEY_CONFIG_FILE"]) {
    const refused = start(t, await scratch(t, "idou-refused-"), { ...db.env, [name]: "/nonexistent/config.json" });
    const [code] = await refused.closed;
    assert.equal(code, 1, refused.output.slice(-800));
    assert.match(refused.output, new RegExp(`IDOU_DATA_STORE=postgres 时还不能开启 ${name}`));
  }
});

// Hot standby (§2.6): the second coordinator started on the same data waits,
// opening nothing and binding nothing, and becomes the coordinator when the
// first one stops.
test("a second coordinator stands by without binding anything, and takes over with the first one's tasks when it stops", { timeout: 120_000 }, async (t) => {
  const db = await shared(t);
  const env = { ...db.env, IDOU_SCHEDULED_TASKS: "1", IDOU_SCHEDULED_TASKS_PORT: "0", IDOU_SCHEDULE_EXECUTION: "pool" };
  const homeA = await scratch(t, "idou-active-"), homeB = await scratch(t, "idou-standby-");
  const a = start(t, homeA, { ...env, IDOU_SCHEDULED_TASKS_DIR: path.join(homeA, "scheduled") }), sessionA = await a.ready;
  assert.ok(sessionA, a.output.slice(-1500));
  assert.match(a.output, /holding the coordinator lease/);
  const created = await (await ask(sessionA, "/v1/schedules/create", { title: "接手之前建的", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork",
    schedule: { frequency: "daily", time: "09:00", timeZone: "Asia/Shanghai" }, resources: [] })).json();

  const b = start(t, homeB, { ...env, IDOU_SCHEDULED_TASKS_DIR: path.join(homeB, "scheduled") });
  for (const until = Date.now() + 20_000; !/standing by/.test(b.output) && b.child.exitCode === null && Date.now() < until;) await wait(25);
  assert.match(b.output, /standing by \(.+ holds the lease\)/, b.output.slice(-1500));
  await wait(1000);
  assert.doesNotMatch(b.output, /Development gateway|Client connection file|Scheduled tasks: on|Sandbox egress/, "nothing opened, nothing bound");
  for (const home of [".idou", ".mydoubao"]) assert.equal(existsSync(path.join(homeB, home, "dev-sessions")), false, home);
  assert.equal(b.child.exitCode, null, "and still there, waiting");

  assert.equal(await a.stop(), true, a.output.slice(-800));
  const sessionB = await b.ready;
  assert.ok(sessionB, b.output.slice(-1500));
  assert.match(b.output, /took over the coordinator lease/);
  const listed = await (await ask(sessionB, "/v1/schedules")).json();
  assert.deepEqual(listed.schedules.map((row) => row.id), [created.schedule.id], "the task made before it took over");
  assert.equal(await b.stop(), true, b.output.slice(-800));
  assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM idou_coordinator")).rows[0].n, 0, "given up on the way out");
});

test("a coordinator whose lease is taken from it stops at once, and a standby stopped while waiting just goes", { timeout: 120_000 }, async (t) => {
  const db = await shared(t);
  const env = { ...db.env, IDOU_COORDINATOR_LEASE_SECONDS: "6" };
  const a = start(t, await scratch(t, "idou-held-"), env);
  assert.ok(await a.ready, a.output.slice(-1500));
  const standby = start(t, await scratch(t, "idou-waiting-"), env);
  for (const until = Date.now() + 20_000; !/standing by/.test(standby.output) && standby.child.exitCode === null && Date.now() < until;) await wait(25);
  assert.match(standby.output, /standing by/);
  assert.equal(await standby.stop(), true);
  assert.match(standby.output, /stopped while standing by/);
  assert.equal(standby.child.exitCode, 0);

  // Somebody else's now: a acts as the coordinator no longer, at its next renewal.
  await db.admin.query("UPDATE idou_coordinator SET holder = 'another-machine' WHERE id = 1");
  const since = Date.now();
  const [code] = await a.closed;
  assert.equal(code, 1);
  assert.ok(Date.now() - since < 4000, `within a third of the lease (${Date.now() - since} ms)`);
  assert.match(a.output, /协调副本租约丢失（另一个协调副本已经接手/);
});

test("a coordinator that fails to start after taking the lease gives it back, so the next start does not wait out its own", { timeout: 60_000 }, async (t) => {
  const db = await shared(t);
  const failing = start(t, await scratch(t, "idou-failing-"), { ...db.env, IDOU_DRIVE_CONFIG_FILE: "/nonexistent/drive.json" });
  const [code] = await failing.closed;
  assert.equal(code, 1, failing.output.slice(-800));
  assert.match(failing.output, /holding the coordinator lease/, "it had taken the lease");
  assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM idou_coordinator")).rows[0].n, 0, "and gave it back");
  const next = start(t, await scratch(t, "idou-next-"), db.env);
  assert.ok(await next.ready, next.output.slice(-1500));
  assert.match(next.output, /holding the coordinator lease/, "taken at once, not after a lease");
  assert.equal(await next.stop(), true);
});
