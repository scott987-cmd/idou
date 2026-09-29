// The database the replicas of the control plane share (control-plane/
// database.js): how it is configured, the key it seals with, and two real
// servers on one database standing for two replicas.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadDatabaseConfig, openSharedState, readStateKey } from "../src/control-plane/database.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { testPostgres } from "./helpers/postgres.js";

const entry = fileURLToPath(new URL("../bin/server.js", import.meta.url));

async function keyFile(t, { mode = 0o600, bytes = 32 } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-state-key-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.key");
  await writeFile(file, `${randomBytes(bytes).toString("base64url")}\n`, { mode });
  await chmod(file, mode);
  return file;
}
const url = (server, database) => `postgresql:///${database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=${server.user}`;

test("no database is the default; one is named by a password-free postgresql URL and an absolute key file", () => {
  assert.equal(loadDatabaseConfig({}), null);
  assert.equal(loadDatabaseConfig({ IDOU_DATABASE_URL: "" }), null);
  assert.throws(() => loadDatabaseConfig({ IDOU_STATE_KEY_FILE: "/etc/mydoubao/state.key" }), /需要同时设置 IDOU_DATABASE_URL/);
  assert.throws(() => loadDatabaseConfig({ IDOU_DATABASE_URL: "not a url" }), /不是合法的地址/);
  assert.throws(() => loadDatabaseConfig({ IDOU_DATABASE_URL: "mysql://localhost/mydoubao", IDOU_STATE_KEY_FILE: "/k" }), /postgresql:\/\//);
  assert.throws(() => loadDatabaseConfig({ IDOU_DATABASE_URL: "postgresql://idou:hunter2@localhost/idou", IDOU_STATE_KEY_FILE: "/k" }), /不能带密码/);
  assert.throws(() => loadDatabaseConfig({ IDOU_DATABASE_URL: "postgresql:///mydoubao?host=/var/run/postgresql&password=hunter2", IDOU_STATE_KEY_FILE: "/k" }), /不能带密码/);
  assert.throws(() => loadDatabaseConfig({ IDOU_DATABASE_URL: "postgresql:///mydoubao?host=/var/run/postgresql" }), /IDOU_STATE_KEY_FILE/);
  assert.throws(() => loadDatabaseConfig({ IDOU_DATABASE_URL: "postgresql:///mydoubao?host=/var/run/postgresql", IDOU_STATE_KEY_FILE: "state.key" }), /绝对路径/);
  const config = loadDatabaseConfig({ IDOU_DATABASE_URL: "postgresql:///mydoubao?host=/var/run/postgresql", IDOU_STATE_KEY_FILE: "/etc/mydoubao/state.key" });
  assert.deepEqual(config, { url: "postgresql:///mydoubao?host=/var/run/postgresql", keyFile: "/etc/mydoubao/state.key" });
  assert.ok(Object.isFrozen(config));
});

test("the sealing key is 32 bytes in a file nobody else can read", async (t) => {
  const good = await keyFile(t);
  assert.equal((await readStateKey(good)).length, 32);
  await assert.rejects(readStateKey(await keyFile(t, { mode: 0o644 })), /0600/);
  await assert.rejects(readStateKey(await keyFile(t, { bytes: 16 })), /32 字节/);
});

test("replicas opened on the same key route one person the same way", { timeout: 60_000 }, async (t) => {
  const server = await testPostgres(t), database = (await server.database()).database, file = await keyFile(t);
  const opened = [await openSharedState({ url: url(server, database), keyFile: file }), await openSharedState({ url: url(server, database), keyFile: file })];
  const registries = opened.map(({ state, routeKey }) => new SessionRegistry({ state, routeKey }));
  server.closeFirst(async () => { for (const [index, sessions] of registries.entries()) { sessions.close(); await sessions.flush(); await opened[index].close(); } });
  const person = { tenantId: "tenant-a", userId: "user-1", deviceId: "device" };
  const [first, second] = registries.map((sessions) => sessions.issue(person));
  assert.equal(first.token.slice(0, 8), second.token.slice(0, 8), "whichever replica issued it, nginx sends it to the same place");
  const other = await openSharedState({ url: url(server, database), keyFile: await keyFile(t) });
  const stranger = new SessionRegistry({ state: other.state, routeKey: other.routeKey });
  server.closeFirst(async () => { stranger.close(); await stranger.flush(); await other.close(); });
  assert.notEqual(stranger.issue(person).token.slice(0, 8), first.token.slice(0, 8), "another deployment's key, another code");
});

test("two real servers on one database: one's token reaches the model at the other, and its revocation reaches it", { timeout: 120_000 }, async (t) => {
  const server = await testPostgres(t), database = (await server.database()).database, file = await keyFile(t);
  // The model upstream both replicas are configured with: answers every question.
  const upstream = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_fixture", object: "response", status: "completed", model: "fixture", output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "fixture reply", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const start = async (name) => {
    const home = await mkdtemp(path.join(os.tmpdir(), `idou-replica-${name}-`));
    t.after(() => rm(home, { recursive: true, force: true }));
    const child = spawn(process.execPath, [entry, "--dev"], { stdio: ["ignore", "pipe", "pipe"], env: {
      PATH: "/usr/bin:/bin", HOME: home, TMPDIR: os.tmpdir(), LANG: "C",
      IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, IDOU_LITELLM_API_KEY: "synthetic-litellm-key-fixture",
      IDOU_DATABASE_URL: url(server, database), IDOU_STATE_KEY_FILE: file } });
    const replica = { output: "", child, closed: once(child, "close") };
    child.stdout.on("data", (chunk) => { replica.output += chunk; });
    child.stderr.on("data", (chunk) => { replica.output += chunk; });
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await replica.closed; } });
    for (const until = Date.now() + 30_000; !/Client connection file: /.test(replica.output) && child.exitCode === null && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(replica.output, /Sessions: shared through PostgreSQL/, replica.output.slice(-1500));
    replica.origin = /Development gateway: (http:\/\/127\.0\.0\.1:\d+)/.exec(replica.output)[1];
    replica.token = JSON.parse(await readFile(/Client connection file: (.+)\n/.exec(replica.output)[1], "utf8")).token;
    return replica;
  };
  const [a, b] = [await start("a"), await start("b")];
  const model = (await (await fetch(`${b.origin}/healthz`)).json()).model;
  const ask = (replica, token) => fetch(`${replica.origin}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ model, input: "fixture question" }) });
  const options = (replica, token) => fetch(`${replica.origin}/v1/models/options`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
  assert.equal((await ask(a, a.token)).status, 200);
  assert.equal((await ask(b, a.token)).status, 200, "b never issued a's token, and serves it the model");
  assert.equal((await ask(a, b.token)).status, 200);
  assert.equal((await ask(b, randomBytes(32).toString("base64url"))).status, 401);
  // A development session has nothing else to go with it (no Feishu access,
  // no renewal, §2.4), so every service at b takes it.
  assert.equal((await options(b, b.token)).status, 200);
  assert.equal((await options(b, a.token)).status, 200);
  const admin = new pg.Client({ host: server.host, port: server.port, user: server.user, database });
  await admin.connect(); server.closeFirst(() => admin.end());
  const stopped = async (replica) => {
    replica.child.kill("SIGTERM");
    let timer;
    const done = await Promise.race([replica.closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 15_000); })]);
    clearTimeout(timer);
    assert.equal(done, true, `still running 15s after SIGTERM:\n${replica.output.slice(-800)}`);
    assert.doesNotMatch(replica.output, /仍有资源没有释放|revocation-not-shared|session-change-not-shared/);
  };
  // A development server revokes its own token when it stops: the other
  // replica hears it.
  await stopped(a);
  let status;
  for (const until = Date.now() + 5000; (status = (await ask(b, a.token)).status) !== 401 && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(status, 401, "a's token ended with a, at b too");
  assert.equal((await ask(b, b.token)).status, 200);
  await stopped(b);
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM idou_state WHERE namespace = 'session'")).rows[0].n, 0, "nothing of either left behind");
});
