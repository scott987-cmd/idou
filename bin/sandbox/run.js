#!/usr/bin/env node
// What actually runs inside a scheduled task's container.
//
// It starts the same CLI sidecar the desktop runs -- unchanged, imported from
// the same file -- and hands it a session that is the run token rather than the
// person's own. From lark-cli's point of view nothing is different: it talks to
// a loopback address, which inside this container really is loopback. From the
// account's point of view everything is: what the container holds expires with
// the run and reaches exactly one address.
import "./legacy-env.js";
import { FeishuCliSidecar } from "../../src/providers/feishu/cli-sidecar.js";
import { codexConfig, codexHome } from "./codex-config.js";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const EGRESS = process.env.IDOU_EGRESS;
const RUN = process.env.IDOU_RUN;
const APP_ID = process.env.IDOU_FEISHU_APP_ID;
const API_ORIGIN = process.env.IDOU_FEISHU_API_ORIGIN;
const WORKSPACE = "/workspace";

function required() {
  const missing = ["IDOU_EGRESS", "IDOU_RUN"].filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`沙箱缺少必要的环境变量：${missing.join("、")}`);
  if (/^https?:\/\/(localhost|127\.|\[?::1)/i.test(EGRESS)) throw new Error("出口地址不能是回环地址：容器内的回环就是容器自己");
  // The CLI's own validator refuses anything that is not HTTPS or literal
  // loopback, so a plain-http egress would fail later and less clearly.
  if (!EGRESS.startsWith("https://")) throw new Error("出口地址必须是 HTTPS");
}

// The sidecar checks these two fields and the expiry; everything else about a
// session is its caller's business. The run token is what it will forward.
function sandboxSession() {
  return async () => ({
    token: RUN, serverUrl: EGRESS,
    // Bounded well inside the run's own window: the proxy retires the token on
    // its own schedule, and a sidecar that believed otherwise would keep trying.
    expiresAt: Date.now() + 25 * 60_000,
    identity: { appId: APP_ID, cliBridge: true },
  });
}

// Null when this server has no Feishu login. A task that does not touch Feishu
// still runs; one that does gets the egress proxy's own refusal, from the call
// it actually made. Failing the whole run up front would conflate "cannot reach
// Feishu" with "cannot work", which is a different thing and usually false.
async function startSidecar() {
  if (!APP_ID) return null;
  // The deployment's OpenAPI origin is the only target the CLI's requests may
  // name. Both it and the app id were checked against the deployment by the
  // control plane before this container started, so the id is only held to the
  // shape every deployment's ids share.
  const sidecar = new FeishuCliSidecar({ appId: APP_ID, getSession: sandboxSession(),
    apiOrigin: API_ORIGIN, appIdPattern: /^[A-Za-z0-9_-]{1,128}$/ });
  await sidecar.start();
  return sidecar;
}

function run(command, args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    // The instruction goes in on stdin rather than as an argument: it can be
    // four thousand characters, and an argument that long is a quoting hazard
    // for no benefit.
    if (input !== undefined) { child.stdin.end(input); }
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => resolve({ code: 127, out, err: String(error.message) }));
    child.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

// Proves the chain without touching the person's data: the sidecar is up, the
// CLI accepts its environment, and a request leaves the container. Run by the
// image's default command, so `docker run <image>` says whether the image works.
async function selfTest() {
  required();
  const sidecar = await startSidecar();
  try {
    const env = { ...process.env, ...(sidecar?.environment() ?? {}) };
    if (!sidecar) { process.stdout.write(`沙箱就绪：出口 ${EGRESS}；这台服务端没有飞书登录，飞书调用会被拒绝。\n`); return; }
    const proxy = env.LARKSUITE_CLI_AUTH_PROXY ?? "";
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(proxy)) throw new Error(`沙箱内 CLI 代理地址异常：${proxy}`);
    const version = await run("lark-cli", ["--version"], env);
    if (version.code !== 0) throw new Error(`飞书 CLI 不可用：${version.err.trim() || version.code}`);
    process.stdout.write(`沙箱就绪：${version.out.trim()}，出口 ${EGRESS}，CLI 代理 ${proxy}\n`);
  } finally { await sidecar?.close?.(); }
}

// The task itself. Its instruction arrives as a file in the workspace rather
// than an environment variable: it can be four thousand characters, and an
// environment is the wrong place for something that long and that quotable.
async function task() {
  required();
  let definition;
  try { definition = JSON.parse(await readFile(`${WORKSPACE}/task.json`, "utf8")); }
  catch { throw new Error("工作目录里没有 task.json，无法确定这次要做什么"); }
  if (typeof definition?.prompt !== "string" || definition.prompt.trim().length === 0) throw new Error("task.json 里没有有效的指令");

  const sidecar = await startSidecar();
  try {
    const home = codexHome(WORKSPACE);
    await mkdir(home, { recursive: true });
    await writeFile(`${home}/config.toml`,
      codexConfig({ model: definition.model ?? process.env.IDOU_MODEL ?? "MiniMax-M3", egress: EGRESS, home }), { mode: 0o600 });

    // The Agent gets the Feishu CLI's environment, so it reaches Feishu as the
    // person through the in-container sidecar -- and no credential of its own.
    const env = { ...process.env, ...(sidecar?.environment() ?? {}), CODEX_HOME: home };
    const result = await run("codex", ["exec", "--skip-git-repo-check", "-"], env, definition.prompt);
    // Codex writes its transcript to stdout; the runner keeps the tail of it as
    // the run record a person reads, so a non-zero exit must carry its reason.
    if (result.code !== 0) throw new Error(`任务执行失败（codex 退出码 ${result.code}）：${(result.err || result.out).trim().slice(-600)}`);
    process.stdout.write(`${result.out.trim()}\n`);
  } finally { await sidecar?.close?.(); }
}

try {
  await (process.argv.includes("--self-test") ? selfTest() : task());
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
}
