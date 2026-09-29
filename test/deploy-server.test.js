// The server's own configuration, kept in deploy/server and installed as it is
// (docs/server-deployment.md): what nginx routes on has to be what the
// sessions put there, and the replicas it sends to have to be the ones systemd
// starts.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { WORKER_WITHHELD } from "../src/control-plane/server-config.js";

const run = promisify(execFile);

const read = (name) => readFile(new URL(`../deploy/server/${name}`, import.meta.url), "utf8");
// What systemd's `bash -c "set -a; . file; set +a; ..."` actually gets from a
// file: its variables as bash reads them.
async function sourced(name) {
  const file = fileURLToPath(new URL(`../deploy/server/${name}`, import.meta.url));
  const { stdout } = await run("/bin/bash", ["-c", 'env -0; printf "\\0--sourced--\\0"; set -a; . "$1"; set +a; env -0', "bash", file], { env: {} });
  const [before, after] = stdout.split("\0--sourced--\0").map((part) => new Map(part.split("\0").filter(Boolean).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])));
  // What the file set, and nothing bash sets for itself (bash 5 on Linux
  // exports SHLVL once `set -a` is on; macOS's bash 3.2 does not).
  return Object.fromEntries([...after].filter(([name, value]) => before.get(name) !== value && !["_", "SHLVL", "PWD", "OLDPWD"].includes(name)));
}

test("nginx routes model requests on the first eight characters of the token, which are the person's", async () => {
  const conf = await read("nginx-idou.conf");
  const [, pattern] = /map \$http_authorization \$idou_route \{\s*"~(\^Bearer [^"]+)" \$code;/.exec(conf) ?? [];
  assert.ok(pattern, "the route map is where it was");
  const route = new RegExp(pattern);
  const sessions = new SessionRegistry({ routeKey: randomBytes(32) });
  const root = sessions.issue({ tenantId: "tenant-a", userId: "user-1", deviceId: "device" });
  for (const { token } of [root, sessions.issueForModelTurn(root.token), sessions.issueForSandboxRun(root.token)]) {
    assert.equal(route.exec(`Bearer ${token}`)?.groups.code, root.token.slice(0, 8));
  }
  assert.equal(route.exec("Basic abc"), null);
  assert.equal(route.exec("Bearer short"), null);
  assert.match(conf, /upstream idou_model \{\s*hash \$idou_route consistent;/);
  // Only the model route is spread; everything else is the coordinator's.
  assert.match(conf, /location = \/v1\/responses \{\s*proxy_pass http:\/\/idou_model;/);
  assert.match(conf, /location \/ \{\s*proxy_pass http:\/\/127\.0\.0\.1:3041;/);
});

test("the replicas nginx sends to are the ones systemd starts, each on its own ports", async () => {
  const conf = await read("nginx-idou.conf");
  const upstream = /upstream idou_model \{([^}]*)\}/.exec(conf)[1];
  const routed = [...upstream.matchAll(/server 127\.0\.0\.1:(\d+)/g)].map((match) => Number(match[1]));
  const instances = (await readdir(new URL("../deploy/server/", import.meta.url))).filter((name) => /^api-\d+\.env$/.test(name)).sort();
  const settings = await Promise.all(instances.map(async (name) => Object.fromEntries((await read(name)).trim().split("\n").map((line) => line.split("=")))));
  assert.deepEqual(routed, settings.map((values) => Number(values.IDOU_PORT)));
  const ports = settings.flatMap((values) => [values.IDOU_PORT, values.IDOU_METRICS_PORT]);
  assert.equal(new Set(ports).size, ports.length);
  for (const taken of ["3041", "3042", "8444", "9464"]) assert.equal(ports.includes(taken), false, `${taken} belongs to the coordinator`);
  const unit = await read("idou-api@.service");
  assert.match(unit, /\. \/etc\/idou\/idou\.env; \. \/etc\/idou\/api-%i\.env; set \+a; exec \/usr\/local\/bin\/node bin\/server\.js --feishu --role api"/);
  assert.doesNotMatch(unit, /SupplementaryGroups=docker/, "a model replica runs no containers");
});

test("the workers systemd starts run as the pool's workers, with Docker, on ports of their own", async () => {
  const unit = await read("idou-worker@.service");
  assert.match(unit, /"set -a; \. \/etc\/idou-worker\/worker\.env; \. \/etc\/idou-worker\/worker-%i\.env; set \+a; exec \/usr\/local\/bin\/node bin\/server\.js --feishu --role worker"/);
  assert.match(unit, /SupplementaryGroups=docker/, "a worker runs the containers");
  const names = (await readdir(new URL("../deploy/server/", import.meta.url))).filter((name) => /^(api|worker)-\d+\.env$/.test(name)).sort();
  const settings = await Promise.all(names.map(async (name) => Object.fromEntries((await read(name)).trim().split("\n").map((line) => line.split("=")))));
  const ports = settings.flatMap((values) => [values.IDOU_PORT, values.IDOU_METRICS_PORT].filter(Boolean));
  assert.equal(new Set(ports).size, ports.length, "no two processes on one port");
  for (const taken of ["3041", "3042", "8444", "9464"]) assert.equal(ports.includes(taken), false, `${taken} belongs to the coordinator`);
  const workers = settings.filter((values) => values.IDOU_WORKER_NAME);
  assert.ok(workers.length >= 1);
  assert.equal(new Set(workers.map((values) => values.IDOU_WORKER_NAME)).size, workers.length, "each its own directory");
});

// Found in the security review of 2026-09-27: every process of the service ran
// as one account, in the docker group -- root on that machine -- including the
// model replicas that answer the internet; and the worker, the process that
// runs what a prompt-injected task produced, held every key the service has.
test("only the workers' own account starts containers, and it is given none of the service's keys", async () => {
  const worker = await read("idou-worker@.service"), coordinator = await read("idou-control-plane.service"), api = await read("idou-api@.service");
  const setting = (unit, name) => new RegExp(`^${name}=(.*)$`, "m").exec(unit)?.[1];
  for (const [label, unit] of [["the coordinator", coordinator], ["a model replica", api]]) {
    assert.doesNotMatch(unit, /^SupplementaryGroups=.*docker/m, `${label} runs no containers`);
    assert.notEqual(setting(unit, "User"), setting(worker, "User"), `${label} is not the workers' account`);
  }
  assert.equal(setting(worker, "User"), "idou_worker");
  // Not the service's configuration, nor anything else in the directory that
  // holds its keys: found on the server, the worker's account cannot even
  // enter /etc/idou (0750 root:idou), and should not.
  assert.doesNotMatch(setting(worker, "ExecStart"), /\/etc\/idou\//, "a directory of its own");
  const values = await sourced("worker.env");
  assert.deepEqual(WORKER_WITHHELD.filter((name) => name in values), [], "none of what a worker is not to hold");
  assert.equal(values.IDOU_RUN_QUEUE_KEY_FILE, "/etc/idou-worker/run-queue.key");
  assert.equal(values.IDOU_SANDBOX_MODE, "production");
  assert.match(values.IDOU_SANDBOX_USER, /^\d+:\d+$/);
  // PostgreSQL knows a local connection by its account's name (peer): the
  // role the worker asks for, the account systemd runs it as and the role the
  // grants are for have to be one name.
  assert.equal(new URL(values.IDOU_DATABASE_URL).searchParams.get("user"), setting(worker, "User"));
  const grants = await read("worker-role.sql");
  assert.match(grants, new RegExp(`CREATE ROLE ${setting(worker, "User")} LOGIN`));
  assert.doesNotMatch(grants, /GRANT[^;]*\b(?:idou|mydoubao)_state\b|GRANT ALL|SUPERUSER|CREATEROLE/);
});

// Found deploying .249: worker.env held a database address with an `&` in it,
// and bash -- which is what reads these files, `set -a; . file` -- took the
// `&` as "run in the background": the variable was never set, and the worker
// said it had no database. Every file bash reads here gives it exactly the
// values written in it.
test("every configuration file the units source gives bash exactly what it says", async () => {
  const names = (await readdir(new URL("../deploy/server/", import.meta.url))).filter((name) => name.endsWith(".env"));
  assert.ok(names.includes("worker.env"));
  for (const name of names) {
    const written = Object.fromEntries((await read(name)).trim().split("\n").filter((line) => line && !line.startsWith("#")).map((line) => {
      const key = line.slice(0, line.indexOf("=")), raw = line.slice(line.indexOf("=") + 1);
      return [key, /^"[^"$`\\]*"$/.test(raw) ? raw.slice(1, -1) : raw];
    }));
    assert.deepEqual(await sourced(name), written, name);
  }
});
