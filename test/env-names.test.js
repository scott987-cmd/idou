import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { adoptLegacyNames, currentName, withLegacyNames } from "../src/env-names.js";
import { readDeploymentFile } from "../src/application/deployment.js";
import { sandboxJob } from "../src/control-plane/sandbox/job.js";

// Settings were MYDOUBAO_* before the product was renamed i豆 (idou) on
// 2026-09-29; they are IDOU_* now. What was written before still means the same.
const root = path.resolve(import.meta.dirname, "..");
const run = promisify(execFile);

test("a setting under its old name is read under its new one, and a new one set always wins", () => {
  const env = { MYDOUBAO_SERVER_URL: "https://old.example", MYDOUBAO_PORT: "3041", IDOU_PORT: "4000", FEISHU_APP_ID: "cli_x" };
  assert.deepEqual(adoptLegacyNames(env).sort(), ["MYDOUBAO_PORT", "MYDOUBAO_SERVER_URL"]);
  assert.equal(env.IDOU_SERVER_URL, "https://old.example");
  assert.equal(env.IDOU_PORT, "4000", "the new name, set, is not overwritten");
  assert.equal(env.FEISHU_APP_ID, "cli_x");
  assert.equal(currentName("MYDOUBAO_DATA_STORE"), "IDOU_DATA_STORE");
  assert.equal(currentName("FEISHU_APP_ID"), "FEISHU_APP_ID");
});

test("the guard against paid calls holds under the old name: a smoke run the old way stays offline", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(path.join(root, "src", "adopt-legacy-env.js"))}); process.stdout.write(String(process.env.IDOU_SMOKE_NO_LIVE))`],
  { env: { PATH: process.env.PATH, MYDOUBAO_SMOKE_NO_LIVE: "1" } });
  assert.equal(stdout, "1");
});

test("a deployment file written before the rename reads the same, and naming a setting twice is still refused", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-env-names-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "deployment.env");
  await writeFile(file, "MYDOUBAO_PUBLIC_URL=http://127.0.0.1:3041\nIDOU_PORT=3041\nFEISHU_APP_ID=cli_fixture\n", { mode: 0o600 });
  await chmod(file, 0o600);
  assert.deepEqual(await readDeploymentFile(file), { IDOU_PUBLIC_URL: "http://127.0.0.1:3041", IDOU_PORT: "3041", FEISHU_APP_ID: "cli_fixture" });
  await writeFile(file, "MYDOUBAO_PORT=3041\nIDOU_PORT=3042\n", { mode: 0o600 });
  await assert.rejects(readDeploymentFile(file), /重复设置了 IDOU_PORT/);
  await writeFile(file, "MYDOUBAO_NOT_A_SETTING=1\n", { mode: 0o600 });
  await assert.rejects(readDeploymentFile(file), /不是可识别的设置项：MYDOUBAO_NOT_A_SETTING/, "said as it was written");
});

test("a sandbox built before the rename gets every setting under its old name, within its limits, and a bridge credential under neither", () => {
  const env = withLegacyNames({ IDOU_RUN: "r".repeat(43), IDOU_EGRESS: "https://egress.idou.internal:8443", IDOU_RUN_ID: "run", IDOU_SCHEDULE_TITLE: "t",
    IDOU_TASK_MODE: "cowork", IDOU_MODEL: "MiniMax-M3", IDOU_FEISHU_APP_ID: "cli_x", IDOU_FEISHU_API_ORIGIN: "https://open.feishu.cn", TZ: "Asia/Shanghai",
    NODE_EXTRA_CA_CERTS: "/ca.pem", SSL_CERT_FILE: "/ca.pem" });
  assert.equal(env.MYDOUBAO_RUN, env.IDOU_RUN);
  assert.equal(env.MYDOUBAO_EGRESS, env.IDOU_EGRESS);
  assert.equal(env.TZ, "Asia/Shanghai");
  assert.equal(Object.hasOwn(env, "MYDOUBAO_TZ"), false);
  const job = { image: "idou/sandbox:test", command: ["node", "run.js"], workspace: "/srv/runs/abc" };
  assert.doesNotThrow(() => sandboxJob({ ...job, env }), "both names fit the sandbox's limits");
  for (const secret of ["IDOU_FEISHU_BRIDGE_KEY", "MYDOUBAO_FEISHU_BRIDGE_KEY", "MYDOUBAO_FEISHU_BRIDGE"]) {
    assert.throws(() => sandboxJob({ ...job, env: { [secret]: "x".repeat(40) } }), /凭据不能进入沙箱/, secret);
  }
});

test("the sandbox's own entry reads old names the same way", async () => {
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(path.join(root, "bin", "sandbox", "legacy-env.js"))}); process.stdout.write([process.env.IDOU_RUN, process.env.IDOU_MODEL].join(","))`],
  { env: { PATH: process.env.PATH, MYDOUBAO_RUN: "token", MYDOUBAO_MODEL: "old", IDOU_MODEL: "new" } });
  assert.equal(stdout, "token,new");
});

// Every process this repository starts reads its settings only after the old
// names are adopted: the adopting module is its first import. A new entry point
// that forgets it would read an old deployment as unset -- including the
// setting that keeps a smoke from making paid calls.
test("every entry point adopts the old names before anything else is loaded", async () => {
  const entries = [];
  for (const directory of ["bin", "bin/mcp", "scripts"]) {
    for (const name of await readdir(path.join(root, directory))) if (/\.m?js$/.test(name)) entries.push(path.join(directory, name));
  }
  for (const name of await readdir(path.join(root, "scripts", "fixtures"))) if (name.endsWith("-entry.js")) entries.push(path.join("scripts", "fixtures", name));
  entries.push("src/desktop/main.js");
  const missing = [];
  for (const entry of entries) {
    const text = await readFile(path.join(root, entry), "utf8");
    const isEntry = entry.startsWith("bin") || entry === "src/desktop/main.js" || entry.endsWith("-entry.js") || /\bIDOU_[A-Z]/.test(text);
    if (!isEntry) continue;
    const first = text.split("\n").find((line) => line.startsWith("import "));
    if (!first || !first.includes("adopt-legacy-env.js")) missing.push(entry);
  }
  assert.deepEqual(missing, [], "entry points whose first import is not src/adopt-legacy-env.js");
  for (const entry of ["run.js", "feishu.js", "agent-token.js"]) {
    const text = await readFile(path.join(root, "bin", "sandbox", entry), "utf8");
    assert.equal(text.split("\n").find((line) => line.startsWith("import ")), 'import "./legacy-env.js";', `bin/sandbox/${entry}`);
  }
});
