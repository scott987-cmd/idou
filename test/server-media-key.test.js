import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_ROUTES, MEDIA_UNAVAILABLE } from "../src/control-plane/media-service.js";

// The real entry point on the LiteLLM route. loadMediaKey decides which key
// media gets; these pin that bin/server.js acts on the answer: a valid MiniMax
// key mounts the service, a broken one stops startup, none mounts the 503
// stand-in, and media off leaves the routes unclaimed exactly as before.
// Nothing here calls a model: the proxy address is never contacted, and a
// media lease is issued without asking MiniMax anything.
const entry = fileURLToPath(new URL("../bin/server.js", import.meta.url));
const PROXY_KEY = "synthetic-litellm-key-fixture", MEDIA_KEY = "synthetic-minimax-media-key-fixture";

async function start(t, settings = () => ({})) {
  const home = await mkdtemp(path.join(os.tmpdir(), "idou-server-media-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // Its own HOME for the session file, and nothing from this shell but the
  // basics, so no real key in the calling environment can reach it.
  const child = spawn(process.execPath, [entry, "--dev"], { stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), LANG: process.env.LANG ?? "C",
    IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_BASE_URL: "http://127.0.0.1:9", IDOU_LITELLM_API_KEY: PROXY_KEY, ...await settings(home) } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = once(child, "close");
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } });
  const deadline = Date.now() + 15000;
  while (!/Client connection file: .+\n/.test(stdout) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  const url = /Development gateway: (\S+)/.exec(stdout)?.[1];
  const sessionFile = /Client connection file: (.+)\n/.exec(stdout)?.[1];
  const post = async (route, body = { kind: "image" }) => {
    const { token } = JSON.parse(await readFile(sessionFile, "utf8"));
    return fetch(url + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  };
  const stop = async () => { child.kill("SIGTERM"); return (await closed)[0]; };
  return { child, closed, home, url, post, stop, output: () => stdout + stderr, stderr: () => stderr };
}
const minimaxFile = async home => {
  const filename = path.join(home, "mmx.json");
  await writeFile(filename, JSON.stringify({ region: "cn", api_key: MEDIA_KEY }), { mode: 0o600 });
  return filename;
};

test("on LiteLLM with no MiniMax key, the server starts and every media route says 503, not 404", async t => {
  const server = await start(t, () => ({ IDOU_MEDIA_ENABLED: "1" }));
  assert.ok(server.url, server.output());
  for (const route of MEDIA_ROUTES) {
    const response = await server.post(route);
    assert.equal(response.status, 503, route);
    assert.equal((await response.json()).error.code, "media_provider_not_configured", route);
  }
  assert.ok(server.stderr().includes(MEDIA_UNAVAILABLE), "said at startup, not only when someone tries");
  assert.equal(await server.stop(), 0);
  assert.doesNotMatch(server.output(), new RegExp(PROXY_KEY));
});

test("on LiteLLM with a valid MiniMax key, the real media service is mounted with it", async t => {
  const server = await start(t, async home => ({ IDOU_MEDIA_ENABLED: "1", MINIMAX_CONFIG_FILE: await minimaxFile(home) }));
  assert.ok(server.url, server.output());
  const response = await server.post("/auth/media-token");
  assert.equal(response.status, 200, await response.clone().text());
  const lease = await response.json();
  assert.equal(lease.audience, "media-service"); assert.equal(lease.kind, "image");
  assert.equal(await server.stop(), 0);
  assert.doesNotMatch(server.output(), new RegExp(`${MEDIA_KEY}|${PROXY_KEY}`));
  assert.doesNotMatch(server.output(), /图片与视频不可用/, "a configured key is not reported missing");
});

test("on LiteLLM a broken MiniMax key stops startup, naming the setting", async t => {
  const server = await start(t, home => ({ IDOU_MEDIA_ENABLED: "1", MINIMAX_CONFIG_FILE: path.join(home, "missing.json") }));
  // start() returns at the listening line or at exit, whichever comes first.
  assert.equal(server.url, undefined, "never listened");
  assert.equal((await server.closed)[0], 1);
  assert.match(server.stderr(), /MINIMAX_CONFIG_FILE/);
  for (const value of [server.home, PROXY_KEY]) assert.equal(server.output().includes(value), false, "names the setting, not its value");
});

test("with media off the key is never read and the media routes stay unclaimed, as before", async t => {
  const server = await start(t, home => ({ MINIMAX_CONFIG_FILE: path.join(home, "missing.json") }));
  assert.ok(server.url, server.output());
  assert.equal((await server.post("/auth/media-token")).status, 404);
  assert.doesNotMatch(server.stderr(), /图片与视频不可用|MINIMAX_CONFIG_FILE/);
  assert.equal(await server.stop(), 0);
});

// Video on Qwen: the real entry point reads the Token Plan key file only with
// media on, offers HappyHorse for video while images keep MiniMax, and stops at
// a broken file the same way it stops at a broken MiniMax key.
const QWEN_KEY = "sk-sp-synthetic-token-plan-fixture";
const qwenFile = async home => {
  const filename = path.join(home, "qwen-token-plan.key");
  await writeFile(filename, `${QWEN_KEY}\n`, { mode: 0o600 });
  return filename;
};

test("with a Token Plan key file, video is offered on Qwen and images stay on MiniMax", async t => {
  const server = await start(t, async home => ({ IDOU_MEDIA_ENABLED: "1", MINIMAX_CONFIG_FILE: await minimaxFile(home), QWEN_TOKEN_PLAN_KEY_FILE: await qwenFile(home) }));
  assert.ok(server.url, server.output());
  const video = await (await server.post("/auth/media-token", { kind: "video" })).json();
  assert.deepEqual(video.offer, { provider: "qwen", model: "happyhorse-1.1-t2v", seconds: 6, resolution: "1080P", aspectRatio: "16:9" });
  const image = await (await server.post("/auth/media-token", { kind: "image" })).json();
  assert.deepEqual(image.offer, { provider: "minimax", model: "image-01" });
  assert.match(server.stderr(), /视频生成走阿里云百炼 happyhorse-1\.1-t2v/, "said at startup, so the operator can see which source runs");
  assert.equal(await server.stop(), 0);
  assert.doesNotMatch(server.output(), new RegExp(`${QWEN_KEY}|${MEDIA_KEY}|${PROXY_KEY}`));
});

test("a broken Token Plan key file stops startup, naming the setting", async t => {
  const server = await start(t, async home => ({ IDOU_MEDIA_ENABLED: "1", MINIMAX_CONFIG_FILE: await minimaxFile(home), QWEN_TOKEN_PLAN_KEY_FILE: path.join(home, "missing.key") }));
  assert.equal(server.url, undefined, "never listened");
  assert.equal((await server.closed)[0], 1);
  assert.match(server.stderr(), /QWEN_TOKEN_PLAN_KEY_FILE/);
  assert.equal(server.output().includes(server.home), false, "names the setting, not its value");
});

test("with only a Token Plan key, video works and only images are said to be unavailable", async t => {
  const server = await start(t, async home => ({ IDOU_MEDIA_ENABLED: "1", QWEN_TOKEN_PLAN_KEY_FILE: await qwenFile(home) }));
  assert.ok(server.url, server.output());
  const video = await server.post("/auth/media-token", { kind: "video" });
  assert.equal(video.status, 200, await video.clone().text());
  assert.equal((await video.json()).offer.provider, "qwen");
  const image = await server.post("/auth/media-token", { kind: "image" });
  assert.equal(image.status, 503); assert.equal((await image.json()).error.code, "media_provider_not_configured");
  assert.match(server.stderr(), /图片不可用/);
  assert.doesNotMatch(server.stderr(), /图片与视频不可用/, "video is not unavailable");
  assert.equal(await server.stop(), 0);
});

test("with media off the Token Plan key file is never read", async t => {
  const server = await start(t, home => ({ QWEN_TOKEN_PLAN_KEY_FILE: path.join(home, "missing.key") }));
  assert.ok(server.url, server.output());
  assert.doesNotMatch(server.stderr(), /QWEN_TOKEN_PLAN_KEY_FILE|阿里云百炼/);
  assert.equal(await server.stop(), 0);
});
