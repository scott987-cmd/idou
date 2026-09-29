// The real server, actually started.
//
// Everything else that touches the site listener builds its parts and wires
// them the way bin/server.js does -- which is exactly why a mistake *in*
// bin/server.js survived a full gate: 1,896 unit tests, 41 smokes and the
// packaged-application test all passed while the control plane could not start
// at all (`Cannot access 'auditTail' before initialization`, 2026-09-21). The
// wiring had no test because every test wrote its own.
//
// So this one runs `node bin/server.js` as a process, with 文档网站 switched on
// and an administrator configured, and asks the listener for the things that
// block only exists to serve. It is cheap and it fails in seconds.
import "../src/adopt-legacy-env.js";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-server-boot-"));
let child = null;
try {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // A model policy, read at startup against the models this server offers.
  const policyFile = path.join(directory, "models.json");
  await writeFile(policyFile, JSON.stringify([{ who: { kind: "everyone" }, models: ["MiniMax-M3"] }]));
  // Media on, with a Token Plan key for video, as on the real server. Nothing is
  // generated here; the key only has to be the shape the server accepts.
  const videoKeyFile = path.join(directory, "qwen-token-plan.key");
  await writeFile(videoKeyFile, "sk-sp-synthetic-not-a-real-key\n", { mode: 0o600 });
  child = spawn(process.execPath, [path.resolve("bin/server.js"), "--dev"], {
    stdio: ["ignore", "pipe", "pipe"],
    // Only what this needs. A development bootstrap has no Feishu application,
    // so the administrator group cannot be read and the configured list is the
    // one that applies -- which is the case an operator hits on day one too.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? "/tmp",
      MINIMAX_API_KEY: "synthetic-no-paid-key",
      IDOU_SITES: "1", IDOU_SITES_URL: origin, IDOU_SITES_PORT: String(port),
      IDOU_SITES_DIR: path.join(directory, "sites"),
      IDOU_SITES_ALLOW: "10.0.0.0/8",
      IDOU_ADMIN_USERS: "ou_boss",
      IDOU_MODEL_POLICY_FILE: policyFile,
      IDOU_MEDIA_ENABLED: "1", QWEN_TOKEN_PLAN_KEY_FILE: videoKeyFile,
      IDOU_DESKTOP_DATA_DIR: path.join(directory, "data") },
  });
  let said = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { said += chunk; });
  child.on("exit", (code) => { said += `\n[exited ${code}]`; });

  // Listening, or dead. Both are answers; waiting for a timeout is not.
  const until = Date.now() + 40_000;
  let ready = false;
  while (Date.now() < until && !ready) {
    if (said.includes("[exited")) break;
    ready = await fetch(`${origin}/demo/`, { redirect: "manual" }).then(() => true, () => false);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `控制面没有起来：\n${said.slice(-1200)}`);

  // The block this is here to cover. Each of these is a different piece of the
  // wiring, and any of them throwing at startup would have stopped the server.
  assert.match(said, /sites-listening/, "站点监听器应当报告自己起来了");
  assert.match(said, /服务端管理台在 .*\/admin/, "管理台应当在启动时说清它在哪");
  assert.match(said, /另有 1 个写在配置里的管理员/);
  assert.match(said, /模型可见性已开启（1 条规则/, "模型策略应当在启动时被读到并说出来");
  // Where pictures and video are made, as configured. With a Token Plan key,
  // video is Qwen's -- and for a day the startup line went on saying "image and
  // video stay on MiniMax" (read in the server's log, 2026-09-24).
  assert.match(said, /; images on MiniMax, video on Qwen\./, `启动时说的图片、视频去向应当和配置一致：\n${said.slice(-800)}`);

  // A development bootstrap has no Feishu login and http, so anonymous access
  // is refused at configuration time: both of these ask for a sign-in that this
  // deployment cannot offer. 401 rather than 404 is the whole point -- it says
  // the route is wired and reached its own decision, which is what a mistake in
  // the wiring would have taken away.
  const demos = await fetch(`${origin}/demo/`, { redirect: "manual" });
  assert.equal(demos.status, 401, "样例的路由应当接上并自己做判断");
  const gallery = await demos.text();
  assert.match(gallery, /登录/);
  assert.equal((await fetch(`${origin}/demo/kanban-tech/`, { redirect: "manual" })).status, 401);
  const admin = await fetch(`${origin}/admin`, { redirect: "manual" });
  assert.equal(admin.status, 401, "管理台的路由应当接上并自己做判断");
  assert.match(await admin.text(), /请先登录/);
  // Not wired would look like this, and does not:
  assert.equal((await fetch(`${origin}/nothing-here`)).status, 404);

  // Loopback is in the allowlist however it is written, which is what makes
  // this test able to reach the server at all.
  assert.equal((await fetch(`${origin}/s/00000000-0000-4000-8000-000000000000/`)).status, 404);

  // A policy naming a model this server does not offer is a policy whose author
  // believes something untrue. It stops the server rather than surfacing later,
  // one request at a time, as a refusal nobody can explain.
  await writeFile(policyFile, JSON.stringify([{ who: { kind: "everyone" }, models: ["No-Such-Model"] }]));
  const second = await freePort();
  const bad = spawn(process.execPath, [path.resolve("bin/server.js"), "--dev"], { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MINIMAX_API_KEY: "synthetic-no-paid-key", IDOU_MODEL_POLICY_FILE: policyFile,
      IDOU_SITES: "1", IDOU_SITES_URL: `http://127.0.0.1:${second}`, IDOU_SITES_PORT: String(second),
      IDOU_SITES_DIR: path.join(directory, "sites2"), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data2") } });
  let complained = "";
  for (const stream of [bad.stdout, bad.stderr]) stream.on("data", (chunk) => { complained += chunk; });
  const exit = await new Promise((resolve) => { bad.on("exit", resolve); setTimeout(() => { bad.kill("SIGKILL"); resolve("timeout"); }, 20_000); });
  assert.notEqual(exit, "timeout", "策略写错了，服务端不该照样起来");
  assert.notEqual(exit, 0);
  assert.match(complained, /不是这个服务端提供的模型/, complained.slice(-400));

  console.log(JSON.stringify({ passed: true, bootedRealServer: true, port,
    demoGallery: true, consoleWired: true, allowlistLoopback: true, mediaRoutesStated: true,
    modelPolicyRead: true, badPolicyStopsTheServer: true, paidCalls: 0 }));
} finally {
  child?.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  child?.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
