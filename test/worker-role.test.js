// A worker of the execution pool as it runs on a server: `bin/server.js --role
// worker`, a real process on a PostgreSQL of the test's own, with a stand-in
// for the docker command that answers what the sandbox asks of it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp, createServer as createTcp } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { RunQueue } from "../src/control-plane/run-queue.js";
import { loadWorkerDatabaseConfig, readRunQueueKey, runQueueKey } from "../src/control-plane/database.js";
import { PostgresStateStore } from "../src/control-plane/state-store.js";
import { egressGateway } from "../src/control-plane/scheduled-tasks.js";
import { loadScheduleExecution, loadWorkerName, WORKER_WITHHELD } from "../src/control-plane/server-config.js";
import { testPostgres } from "./helpers/postgres.js";

const entry = fileURLToPath(new URL("../bin/server.js", import.meta.url));
const queueKeyTool = fileURLToPath(new URL("../bin/run-queue-key.js", import.meta.url));
const workerRole = fileURLToPath(new URL("../deploy/server/worker-role.sql", import.meta.url));
const IMAGE = "mydoubao/sandbox:fixture";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `docker` as the sandbox uses it: a daemon with runc, an internal network,
// the image present, nothing left over, and a `run` that says where it ran.
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$(dirname "$0")/calls"
case "$1" in
  info) [ -f "$(dirname "$0")/down" ] && exit 1; echo '{"runc":{}}' ;;
  network) echo 'true bridge' ;;
  image) echo '{"Id":"sha256:fixture","Os":"linux","Architecture":"amd64","Config":{"Labels":{}},"RepoDigests":[]}' ;;
  run) echo "ran in the pool" ;;
  *) ;;
esac
`;

async function setup(t, { down = false } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-worker-role-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  await writeFile(path.join(bin, "docker"), FAKE_DOCKER); await chmod(path.join(bin, "docker"), 0o755);
  if (down) await writeFile(path.join(bin, "down"), "");
  const keyFile = path.join(home, "state.key");
  await writeFile(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600 }); await chmod(keyFile, 0o600);
  return { home, bin, keyFile };
}

function start(t, env, mode = "--dev") {
  const child = spawn(process.execPath, [entry, mode, "--role", "worker"], { stdio: ["ignore", "pipe", "pipe"], env });
  const running = { child, output: "", closed: once(child, "close") };
  child.stdout.on("data", (chunk) => { running.output += chunk; });
  child.stderr.on("data", (chunk) => { running.output += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await running.closed; } });
  return running;
}

test("a worker will not start without the shared database, nor without a sandbox it can run, nor before there is a queue", { timeout: 60_000 }, async (t) => {
  const f = await setup(t, { down: true });
  const alone = start(t, { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, LANG: "C" });
  assert.equal((await alone.closed)[0], 1);
  assert.match(alone.output, /执行节点需要共享数据库/);
  const server = await testPostgres(t), database = (await server.database()).database;
  const url = `postgresql:///${database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=${server.user}`;
  const blind = start(t, { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, LANG: "C", IDOU_DATABASE_URL: url, IDOU_STATE_KEY_FILE: f.keyFile, IDOU_SANDBOX_IMAGE: IMAGE });
  assert.equal((await blind.closed)[0], 1);
  assert.match(blind.output, /沙箱不可用（Docker 未运行或不可访问）/);
  const early = await setup(t);
  const unmade = start(t, { PATH: `${early.bin}:/usr/bin:/bin`, HOME: early.home, LANG: "C", IDOU_DATABASE_URL: url, IDOU_STATE_KEY_FILE: early.keyFile, IDOU_SANDBOX_IMAGE: IMAGE,
    IDOU_SCHEDULED_TASKS_DIR: path.join(early.home, "scheduled") });
  assert.equal((await unmade.closed)[0], 1);
  assert.match(unmade.output, /执行池的队列表还不存在/, "the coordinator makes it; a worker says it is not there yet");
});

test("a worker takes a run from the queue, runs it in its sandbox, and hands back what it produced", { timeout: 90_000 }, async (t) => {
  const f = await setup(t);
  const server = await testPostgres(t), config = await server.database();
  const url = `postgresql:///${config.database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=${server.user}`;
  // What the coordinator's PoolSandbox would put in the queue. The queue is
  // the coordinator's to make; a worker only attaches to it.
  const pool = new pg.Pool({ ...config, max: 4 }); pool.on("error", () => {});
  // As the coordinator seals it: with the queue's own key.
  const key = runQueueKey(Buffer.from((await readFile(f.keyFile, "utf8")).trim(), "base64url"));
  const queue = await RunQueue.open({ pool, key, connect: async () => { const client = new pg.Client(config); await client.connect(); return client; } });
  server.closeFirst(async () => { await queue.close(); await pool.end(); });
  const worker = start(t, { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, LANG: "C", IDOU_DATABASE_URL: url, IDOU_STATE_KEY_FILE: f.keyFile,
    IDOU_SANDBOX_IMAGE: IMAGE, IDOU_SCHEDULED_TASKS_DIR: path.join(f.home, "scheduled"), IDOU_WORKER_NAME: "worker-1", IDOU_SCHEDULE_MAX_CONCURRENT: "3" });
  for (const until = Date.now() + 30_000; !/Run worker worker-1/.test(worker.output) && worker.child.exitCode === null && Date.now() < until;) await wait(25);
  assert.match(worker.output, /Run worker worker-1: 3 at a time, image mydoubao\/sandbox:fixture/, worker.output.slice(-1500));
  const job = { image: IMAGE, command: ["node", "/opt/idou/run.js"], env: { IDOU_RUN: "r".repeat(43) },
    network: { mode: "gateway", gateway: egressGateway() }, limits: { memoryMb: 512, cpus: 1, pids: 256, timeoutMs: 60_000 } };
  await queue.enqueue({ id: "run-fixture-1", schedule: "tenant/s1", owner: "coordinator-fixture", payload: { job, files: { "task.json": Buffer.from('{"prompt":"hi"}').toString("base64") } } });
  const result = await queue.wait("run-fixture-1", { pollMs: 500 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "ran in the pool");
  const calls = await readFile(path.join(f.bin, "calls"), "utf8");
  assert.match(calls, new RegExp(`run .*${path.join(f.home, "scheduled", "pool", "worker-1", "run-fixture-1").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`), "in its own directory");

  worker.child.kill("SIGTERM");
  let timer;
  const stopped = await Promise.race([worker.closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 15_000); })]);
  clearTimeout(timer);
  assert.equal(stopped, true, worker.output.slice(-800));
  assert.doesNotMatch(worker.output, /仍有资源没有释放/);
});

test("where runs execute is this machine unless the pool is asked for, and the pool needs the database", () => {
  assert.equal(loadScheduleExecution({}), "local");
  assert.equal(loadScheduleExecution({ IDOU_SCHEDULE_EXECUTION: "local" }), "local");
  assert.throws(() => loadScheduleExecution({ IDOU_SCHEDULE_EXECUTION: "pool" }), /需要 IDOU_DATABASE_URL/);
  assert.equal(loadScheduleExecution({ IDOU_SCHEDULE_EXECUTION: "pool", IDOU_DATABASE_URL: "postgresql:///x" }), "pool");
  assert.throws(() => loadScheduleExecution({ IDOU_SCHEDULE_EXECUTION: "remote" }), /只能是 local 或 pool/);
  assert.equal(loadWorkerName({}), "worker");
  assert.equal(loadWorkerName({ IDOU_WORKER_NAME: "worker-2" }), "worker-2");
  assert.throws(() => loadWorkerName({ IDOU_WORKER_NAME: "../etc" }), /IDOU_WORKER_NAME/);
});

test("a coordinator that hands runs to the pool starts without Docker, and says where runs go", { timeout: 90_000 }, async (t) => {
  const f = await setup(t, { down: true });
  const server = await testPostgres(t), config = await server.database();
  const url = `postgresql:///${config.database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=${server.user}`;
  const coordinator = spawn(process.execPath, [entry, "--dev"], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, LANG: "C",
    IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:9", IDOU_LITELLM_API_KEY: "synthetic-litellm-key-fixture",
    IDOU_DATABASE_URL: url, IDOU_STATE_KEY_FILE: f.keyFile, IDOU_SCHEDULED_TASKS: "1", IDOU_SCHEDULED_TASKS_DIR: path.join(f.home, "scheduled"),
    IDOU_SCHEDULED_TASKS_PORT: "0", IDOU_SCHEDULE_EXECUTION: "pool" } });
  let output = "";
  coordinator.stdout.on("data", (chunk) => { output += chunk; }); coordinator.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(coordinator, "close");
  t.after(async () => { if (coordinator.exitCode === null && coordinator.signalCode === null) { coordinator.kill("SIGKILL"); await closed; } });
  for (const until = Date.now() + 30_000; !/Client connection file: /.test(output) && coordinator.exitCode === null && Date.now() < until;) await wait(25);
  assert.match(output, /executed by the workers of the execution pool/, output.slice(-1500));
  assert.match(output, /Scheduled tasks: on/);
  assert.doesNotMatch(output, /沙箱不可用/, "Docker is the workers' business, not the coordinator's");
  coordinator.kill("SIGTERM");
  let timer;
  const stopped = await Promise.race([closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 15_000); })]);
  clearTimeout(timer);
  assert.equal(stopped, true, output.slice(-800));
});

test("a worker on another machine relays its containers' egress to the coordinator, and stops relaying when it stops", { timeout: 90_000 }, async (t) => {
  const f = await setup(t);
  const server = await testPostgres(t), config = await server.database();
  const url = `postgresql:///${config.database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=${server.user}`;
  // The coordinator's queue, which the worker attaches to.
  const pool = new pg.Pool({ ...config, max: 2 }); pool.on("error", () => {});
  const made = await RunQueue.open({ pool, key: randomBytes(32), connect: async () => { const client = new pg.Client(config); await client.connect(); return client; } });
  server.closeFirst(async () => { await made.close(); await pool.end(); });
  // The coordinator's remote egress, as far as a relay can tell: bytes in, bytes back.
  const coordinator = createTcp((socket) => socket.pipe(socket));
  coordinator.listen(0, "127.0.0.1"); await once(coordinator, "listening");
  t.after(() => coordinator.close());
  const probe = createTcp(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const egressPort = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const worker = start(t, { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, LANG: "C", IDOU_DATABASE_URL: url, IDOU_STATE_KEY_FILE: f.keyFile,
    IDOU_SANDBOX_IMAGE: IMAGE, IDOU_SCHEDULED_TASKS_DIR: path.join(f.home, "scheduled"), IDOU_SCHEDULED_TASKS_PORT: String(egressPort),
    IDOU_EGRESS_UPSTREAM: `127.0.0.1:${coordinator.address().port}` });
  for (const until = Date.now() + 30_000; !/relayed from/.test(worker.output) && worker.child.exitCode === null && Date.now() < until;) await wait(25);
  // Without IDOU_SANDBOX_GATEWAY (a development machine) it listens everywhere.
  assert.match(worker.output, new RegExp(`sandbox egress relayed from 0\\.0\\.0\\.0:${egressPort} to 127\\.0\\.0\\.1:${coordinator.address().port}`), worker.output.slice(-1500));
  const echoed = await new Promise((resolve, reject) => {
    const socket = connectTcp(egressPort, "127.0.0.1", () => socket.write("ciphertext-fixture"));
    socket.once("data", (chunk) => { resolve(chunk.toString()); socket.destroy(); });
    socket.once("error", reject);
  });
  assert.equal(echoed, "ciphertext-fixture");
  worker.child.kill("SIGTERM");
  // Promptly, not at the minute's backstop: a relay left open would hold the process.
  let timer;
  const stopped = await Promise.race([worker.closed.then(([code]) => code), new Promise((resolve) => { timer = setTimeout(() => resolve("still running"), 15_000); })]);
  clearTimeout(timer);
  assert.equal(stopped, 0, worker.output.slice(-800));
  assert.doesNotMatch(worker.output, /仍有资源没有释放/);
  await assert.rejects(new Promise((resolve, reject) => { const socket = connectTcp(egressPort, "127.0.0.1", resolve); socket.once("error", reject); }), "the relay went with it");
});

// Found in the security review of 2026-09-27: the worker -- the process that
// runs what a prompt-injected task produced, and the one that goes to other
// machines -- held the sealing key, a database role that reaches everything,
// the Feishu application secret and the model keys. It now holds the queue's
// key and a role that reaches the queue, exactly as deploy/server gives them.
test("a worker runs with the queue's key alone, as a database role that reaches the queue and nothing else", { timeout: 90_000 }, async (t) => {
  const f = await setup(t);
  const server = await testPostgres(t), config = await server.database();
  const pool = new pg.Pool({ ...config, max: 4 }); pool.on("error", () => {});
  const connect = async () => { const client = new pg.Client(config); await client.connect(); return client; };
  const stateKey = Buffer.from((await readFile(f.keyFile, "utf8")).trim(), "base64url");
  // The coordinator's side: the queue, and the sessions and grants it seals
  // with the sealing key in the same database.
  const queue = await RunQueue.open({ pool, connect, key: runQueueKey(stateKey) });
  const state = await PostgresStateStore.open({ pool, connect, key: stateKey });
  server.closeFirst(async () => { await queue.close(); await state.close(); await pool.end(); });
  await state.put("session", "fixture-session", { token: "fixture" });
  await pool.query(await readFile(workerRole, "utf8"));
  // The worker's key, made as the deployment makes it.
  const queueKeyFile = path.join(f.home, "run-queue.key");
  const made = spawn(process.execPath, [queueKeyTool, f.keyFile, queueKeyFile], { stdio: ["ignore", "pipe", "pipe"] });
  assert.equal((await once(made, "close"))[0], 0);
  const url = `postgresql:///${config.database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=idou_worker`;
  const worker = start(t, { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, LANG: "C", IDOU_DATABASE_URL: url, IDOU_RUN_QUEUE_KEY_FILE: queueKeyFile,
    IDOU_SANDBOX_IMAGE: IMAGE, IDOU_SCHEDULED_TASKS_DIR: path.join(f.home, "scheduled"), IDOU_WORKER_NAME: "worker-1" });
  for (const until = Date.now() + 30_000; !/Run worker worker-1/.test(worker.output) && worker.child.exitCode === null && Date.now() < until;) await wait(25);
  assert.match(worker.output, /Run worker worker-1/, worker.output.slice(-1500));
  const job = { image: IMAGE, command: ["node", "/opt/idou/run.js"], env: { IDOU_RUN: "r".repeat(43) },
    network: { mode: "gateway", gateway: egressGateway() }, limits: { memoryMb: 512, cpus: 1, pids: 256, timeoutMs: 60_000 } };
  await queue.enqueue({ id: "run-least-1", schedule: "tenant/s1", owner: "coordinator-fixture", payload: { job, files: {} } });
  const result = await queue.wait("run-least-1", { pollMs: 500 });
  assert.equal(result.stdout.trim(), "ran in the pool", "taken, run and handed back");

  // What that role cannot do.
  const as = new pg.Client({ ...config, user: "idou_worker" }); as.on("error", () => {}); await as.connect();
  server.closeFirst(() => as.end());
  const refused = async (sql, label) => { await assert.rejects(as.query(sql), (error) => error.code === "42501", label); };
  await refused("SELECT value FROM idou_state", "the sessions and grants");
  await refused("SELECT result FROM idou_run_queue", "what earlier runs produced");
  await refused("SELECT owner FROM idou_run_queue", "whose runs they are");
  await refused("INSERT INTO idou_run_queue (id, schedule, owner, state, payload) VALUES ('x', 'x', 'x', 'queued', '')", "queue a run of its own");
  await refused("DELETE FROM idou_run_queue", "remove runs");
  await refused("UPDATE idou_run_queue SET payload = ''", "rewrite what a run carries");
  await refused("CREATE TABLE mine (id int)", "make tables");
  worker.child.kill("SIGTERM"); await worker.closed;
});

test("the queue's key comes from the sealing key one way, and the worker's file is never overwritten", async (t) => {
  const f = await setup(t);
  const stateKey = Buffer.from((await readFile(f.keyFile, "utf8")).trim(), "base64url");
  const key = runQueueKey(stateKey);
  assert.equal(key.length, 32); assert.notDeepEqual(key, stateKey);
  assert.deepEqual(runQueueKey(stateKey), key, "the coordinator and the tool make the same one");
  const out = path.join(f.home, "queue.key");
  const make = async () => { const child = spawn(process.execPath, [queueKeyTool, f.keyFile, out], { stdio: ["ignore", "pipe", "pipe"] });
    let text = ""; child.stdout.on("data", (chunk) => { text += chunk; }); child.stderr.on("data", (chunk) => { text += chunk; });
    return { code: (await once(child, "close"))[0], text }; };
  assert.equal((await make()).code, 0);
  assert.deepEqual(await readRunQueueKey({ queueKeyFile: out }), key);
  assert.equal((await import("node:fs/promises").then(({ stat }) => stat(out))).mode & 0o777, 0o600);
  const again = await make();
  assert.equal(again.code, 1); assert.match(again.text, /已存在，不覆盖/);
  assert.deepEqual(await readRunQueueKey({ stateKeyFile: f.keyFile }), key, "a development worker given the sealing key makes it too");
  const url = "postgresql:///mydoubao?host=/var/run/postgresql";
  assert.deepEqual(loadWorkerDatabaseConfig({ IDOU_DATABASE_URL: url, IDOU_RUN_QUEUE_KEY_FILE: "/k", IDOU_STATE_KEY_FILE: "/s" }), { url, queueKeyFile: "/k" }, "its own key first");
  assert.equal(loadWorkerDatabaseConfig({}), null);
  assert.throws(() => loadWorkerDatabaseConfig({ IDOU_DATABASE_URL: url }), /IDOU_RUN_QUEUE_KEY_FILE/);
  assert.throws(() => loadWorkerDatabaseConfig({ IDOU_DATABASE_URL: url, IDOU_RUN_QUEUE_KEY_FILE: "relative" }), /绝对路径/);
  assert.throws(() => loadWorkerDatabaseConfig({ IDOU_DATABASE_URL: "postgresql://u:secret@h/d", IDOU_RUN_QUEUE_KEY_FILE: "/k" }), /不能带密码/);
});

test("a production worker will not start holding what it is not to hold, nor outside production isolation", { timeout: 60_000 }, async (t) => {
  const f = await setup(t);
  const base = { PATH: `${f.bin}:/usr/bin:/bin`, HOME: f.home, LANG: "C", IDOU_DATABASE_URL: "postgresql:///x?host=/nowhere", IDOU_RUN_QUEUE_KEY_FILE: path.join(f.home, "q.key") };
  for (const [name, value] of [["FEISHU_APP_SECRET", "fixture-app-secret"], ["IDOU_STATE_KEY_FILE", f.keyFile], ["MINIMAX_API_KEY", "fixture-model-key"]]) {
    const refused = start(t, { ...base, IDOU_SANDBOX_MODE: "production", [name]: value }, "--feishu");
    assert.equal((await refused.closed)[0], 1, name);
    assert.match(refused.output, new RegExp(`执行节点不该拿到这些：${name}`), refused.output);
    assert.doesNotMatch(refused.output, /fixture-app-secret|fixture-model-key/, "names it, never says it");
  }
  const development = start(t, base, "--feishu");
  assert.equal((await development.closed)[0], 1);
  assert.match(development.output, /要按生产隔离运行：设 IDOU_SANDBOX_MODE=production/);
  assert.ok(WORKER_WITHHELD.includes("IDOU_STATE_KEY_FILE"));
});

// The rule the list above keeps, over every setting the code reads rather than
// the ones in it today: a setting that holds a key or a secret, or names a
// file that does, is withheld from a worker -- unless it is the worker's own.
test("every key or secret the service reads is one a worker is not given, or the worker's own", async () => {
  const { readdir } = await import("node:fs/promises");
  const root = new URL("../", import.meta.url);
  const files = [];
  for (const directory of ["src/control-plane", "src/providers", "src/application", "bin"]) {
    for (const name of await readdir(new URL(directory, root), { recursive: true })) if (name.endsWith(".js")) files.push(new URL(`${directory}/${name}`, root));
  }
  const read = new Set();
  for (const file of files) for (const [, name] of (await readFile(file, "utf8")).matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) read.add(name);
  const secret = [...read].filter((name) => /SECRET|PASSWORD|TOKEN|_KEY$|_KEY_FILE$|API_KEY|CONFIG_FILE$/.test(name));
  const workersOwn = new Set(["IDOU_RUN_QUEUE_KEY_FILE", "IDOU_SKILL_PUBLIC_KEY_FILE"]);
  assert.ok(secret.length >= 10, `found ${secret.join(", ")}`);
  assert.deepEqual(secret.filter((name) => !WORKER_WITHHELD.includes(name) && !workersOwn.has(name)), []);
});
