// A model replica (`bin/server.js --role api`, docs/scaling-plan.md §2.3): the
// real server, started as the coordinator and as a replica on one database.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { testPostgres } from "./helpers/postgres.js";

const entry = fileURLToPath(new URL("../bin/server.js", import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const free = () => new Promise((resolve, reject) => {
  const probe = createServer(); probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

async function scratch(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// One process of the real server; `ready` is the line it prints once it serves.
function start(t, args, env, ready) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", TMPDIR: os.tmpdir(), LANG: "C", ...env } });
  const running = { child, output: "", closed: once(child, "close") };
  child.stdout.on("data", (chunk) => { running.output += chunk; });
  child.stderr.on("data", (chunk) => { running.output += chunk; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await running.closed; } });
  running.ready = (async () => {
    for (const until = Date.now() + 30_000; !ready.test(running.output) && child.exitCode === null && Date.now() < until;) await wait(25);
    return ready.test(running.output);
  })();
  return running;
}

test("a model replica does not start without the shared store, nor as a role there is not", { timeout: 60_000 }, async (t) => {
  const home = await scratch(t, "idou-api-alone-");
  for (const [args, message] of [[["--dev", "--role", "api"], /API 副本需要共享会话/], [["--dev", "--role", "janitor"], /optionally followed by --role api or --role worker/], [["--dev", "--role"], /optionally followed by --role api or --role worker/]]) {
    const refused = start(t, args, { HOME: home }, /never/);
    const [code] = await refused.closed;
    assert.equal(code, 1, refused.output);
    assert.match(refused.output, message);
  }
});

test("a model replica serves the coordinator's tokens the model and nothing else, and lets its answers finish when it is stopped", { timeout: 120_000 }, async (t) => {
  const server = await testPostgres(t), database = (await server.database()).database;
  const keys = await scratch(t, "idou-api-key-"), keyFile = path.join(keys, "state.key");
  await writeFile(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600 }); await chmod(keyFile, 0o600);
  // The model: answers every question, as late as it is told to.
  const upstream = { delay: 0, received: 0 };
  const model = createServer((req, res) => {
    upstream.received += 1; req.resume();
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_fixture", object: "response", status: "completed", model: "fixture", output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "fixture reply", annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
    }, upstream.delay);
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  t.after(() => { model.close(); model.closeAllConnections(); });
  const shared = { IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: `http://127.0.0.1:${model.address().port}`, IDOU_LITELLM_API_KEY: "synthetic-litellm-key-fixture",
    IDOU_DATABASE_URL: `postgresql:///${database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=${server.user}`, IDOU_STATE_KEY_FILE: keyFile,
    // The ledger in the shared database: what a replica on any machine counts lands in one place.
    IDOU_DATA_STORE: "postgres" };
  const coordinator = start(t, ["--dev"], { HOME: await scratch(t, "idou-coordinator-"), ...shared }, /Client connection file: /);
  assert.equal(await coordinator.ready, true, coordinator.output.slice(-1500));
  const token = JSON.parse(await readFile(/Client connection file: (.+)\n/.exec(coordinator.output)[1], "utf8")).token;
  const metricsPort = await free();
  const replica = start(t, ["--dev", "--role", "api"], { HOME: await scratch(t, "idou-replica-"), ...shared, IDOU_METRICS_PORT: String(metricsPort) }, /Model replica: /);
  assert.equal(await replica.ready, true, replica.output.slice(-1500));
  const origin = /Model replica: (http:\/\/127\.0\.0\.1:\d+)\/v1\/responses/.exec(replica.output)[1];
  const slug = (await (await fetch(`${origin}/healthz`)).json()).model;
  const ask = () => fetch(`${origin}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: slug, input: "fixture question" }) });

  assert.equal((await ask()).status, 200, "a token the coordinator issued");
  for (const route of ["/v1/models/options", "/auth/session", "/v1/schedules", "/v1/sites/publish"]) {
    const response = await fetch(`${origin}${route}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: "{}" });
    assert.equal(response.status, 404, `${route} is the coordinator's`);
  }
  assert.doesNotMatch(replica.output, /Development gateway|Client connection file|定时任务|文档网站/, "it issues nothing and runs nothing else");
  const metrics = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
  assert.match(metrics, /^idou_role_info\{role="api"\} 1$/m);

  // Stopped while an answer is on its way: the answer arrives whole, and
  // nothing new is taken meanwhile.
  upstream.delay = 1500;
  const before = upstream.received, answering = ask();
  for (const until = Date.now() + 5000; upstream.received === before && Date.now() < until;) await wait(10);
  replica.child.kill("SIGTERM");
  await wait(200);
  await assert.rejects(fetch(`${origin}/healthz`), "no new connection once it is stopping");
  const answered = await answering;
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).output?.[0]?.content?.[0]?.text, "fixture reply");
  let timer;
  const exited = await Promise.race([replica.closed.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 15_000); })]);
  clearTimeout(timer);
  assert.equal(exited, true, `still running 15s after SIGTERM:\n${replica.output.slice(-800)}`);
  assert.doesNotMatch(replica.output, /仍有资源没有释放|not-shared/);
  // Its answers were counted in the shared ledger, the last second written as it stopped.
  const admin = new pg.Client({ host: server.host, port: server.port, user: server.user, database });
  await admin.connect(); server.closeFirst(() => admin.end());
  const counted = Number((await admin.query("SELECT COALESCE(SUM(requests), 0) AS n FROM idou_model_usage")).rows[0].n);
  assert.ok(counted >= 2, `the replica's two answers are in the ledger (${counted})`);
  // Its stopping revoked nothing: the coordinator's token still works there.
  const still = await fetch(`${/Development gateway: (http:\/\/127\.0\.0\.1:\d+)/.exec(coordinator.output)[1]}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ model: slug, input: "fixture question" }) });
  assert.equal(still.status, 200);
});
