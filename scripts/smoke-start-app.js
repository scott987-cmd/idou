#!/usr/bin/env node
// Boots the real launcher against a synthetic deployment file and checks that
// the control plane comes up and serves the login protocol. No Feishu call, no
// model call, and no real credential: the app secret here is a fixture string.
// The LiteLLM variant boots with IDOU_MODEL_PROVIDER=litellm against a fake
// proxy this script runs on 127.0.0.1, with a synthetic key file and no MiniMax
// key at all; no real LiteLLM is contacted.
import "../src/adopt-legacy-env.js";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, createPublicKey } from "node:crypto";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-start-"));
const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const model = path.join(directory, "mmx.json"), deployment = path.join(directory, "idou.env");
await writeFile(model, JSON.stringify({ region: "cn", api_key: "synthetic-model-key" }), { mode: 0o600 });
// drive.upload is among the write actions below, and since the Drive budget
// (docs/drive-budget.md) a server that may upload refuses to start without
// saying where and how much. Synthetic identities; nothing is uploaded here.
const drive = path.join(directory, "drive-budget.json"), ledger = path.join(await realpath(directory), "ledger");
await mkdir(ledger, { mode: 0o700 }); // the ledger wants a private directory, reached without a symlink (/var is one)
await writeFile(drive, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(ledger, "drive-budget.sqlite"), tenants: [{
  authProvider: "feishu", tenantId: "tenant_fixture", appId: "cli_startfixture", providerId: "saas-cli",
  driveTenantKey: "tenant_fixture", folderToken: "SyntheticManagedFolder", maxBytes: 1048576 }] }), { mode: 0o600 });
await writeFile(deployment, [
  `IDOU_PUBLIC_URL=http://127.0.0.1:${port}`, `IDOU_PORT=${port}`,
  "FEISHU_APP_ID=cli_startfixture", "FEISHU_APP_SECRET=synthetic-app-secret",
  "FEISHU_ALLOWED_TENANTS=tenant_fixture", "FEISHU_SOURCE_ACCESS_ENABLED=1",
  "FEISHU_CLI_BRIDGE_ENABLED=1", "FEISHU_CLI_SCOPES=docx:document:readonly",
  "FEISHU_CLI_WRITE_ACTIONS=document.inline-replace,message.send,message.reply,drive.upload",
  `MINIMAX_CONFIG_FILE=${model}`, `IDOU_DRIVE_CONFIG_FILE=${drive}`,
].join("\n"), { mode: 0o600 });

const localDeployment = path.join(directory, "local.env");
await writeFile(localDeployment, `MINIMAX_CONFIG_FILE=${model}\n`, { mode: 0o600 });

// A stand-in for the LiteLLM proxy: it answers as LiteLLM does, under its own
// model group name and with output items missing the fields Codex requires.
const proxied = [], probes = [];
const proxy = createHttpServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health/liveliness") { probes.push(req.headers.authorization ?? null); res.end("I'm alive!"); return; }
  let text = ""; for await (const chunk of req) text += chunk;
  const body = JSON.parse(text); proxied.push({ url: req.url, authorization: req.headers.authorization, body });
  if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "resp_fake", object: "response", model: "volc-coding", output: [] })); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { id: "resp_fake", model: "volc-coding", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg", role: "assistant" } },
    { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "合成回复" },
    { type: "response.completed", response: { id: "resp_fake", model: "volc-coding", output: [] } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
const litellmKey = path.join(directory, "litellm.env"), litellmDeployment = path.join(directory, "litellm-deployment.env");
await writeFile(litellmKey, "# synthetic LiteLLM settings\nexport LITELLM_MASTER_KEY=\"synthetic-litellm-key\"\n", { mode: 0o600 });
await writeFile(litellmDeployment, ["IDOU_MODEL_PROVIDER=litellm", `IDOU_LITELLM_BASE_URL=http://127.0.0.1:${proxy.address().port}`,
  "IDOU_LITELLM_MODEL=volc-coding", `IDOU_LITELLM_KEY_FILE=${litellmKey}`, "IDOU_MEDIA_ENABLED=1"].join("\n"), { mode: 0o600 });

async function boot(file, marker) {
  let output = "";
  const child = spawn(process.execPath, [path.resolve("scripts/start-app.js"), file, "--server-only"],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"] });
  const collect = bytes => { output += bytes; };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`启动超时：\n${output}`)), 30_000);
    const done = () => { if (output.includes(marker)) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", done); child.stderr.on("data", done);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`启动进程提前退出 ${code}：\n${output}`)); });
  });
  return { child, output: () => output };
}

async function halt(child) {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM");
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]); child.kill("SIGKILL");
  }
}

let child, litellmRun, output = "";
try {
  // Local mode: usable with nothing but a model key, and Feishu stays absent.
  const localRun = await boot(localDeployment, "控制面已就绪");
  const localOutput = localRun.output();
  const sessionFile = localOutput.match(/Client connection file: (\S+)/)?.[1];
  assert.ok(sessionFile, localOutput);
  const localSession = JSON.parse(await readFile(sessionFile, "utf8"));
  assert.match(localSession.serverUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600);
  assert.equal((await fetch(`${localSession.serverUrl}/healthz`)).status, 200);
  assert.match(localOutput, /本机模式/);
  assert.doesNotMatch(localOutput, /synthetic-model-key/);
  await halt(localRun.child);
  // The short-lived session file does not outlive the server that issued it.
  await assert.rejects(stat(sessionFile), { code: "ENOENT" });

  // LiteLLM for chat, with no MiniMax key anywhere: the control plane still
  // starts, enforces GLM-5.3, speaks to the proxy only from the server, and
  // media says it has no key instead of pretending to be switched off.
  litellmRun = await boot(litellmDeployment, "控制面已就绪");
  const litellmOutput = litellmRun.output();
  const litellmSession = JSON.parse(await readFile(litellmOutput.match(/Client connection file: (\S+)/)[1], "utf8"));
  const health = await (await fetch(`${litellmSession.serverUrl}/healthz`)).text();
  // Since the multi-model gateway (db8bf88) the health answer also lists every
  // model a client may pick; with one provider it is just the default.
  assert.deepEqual(JSON.parse(health), { status: "ok", provider: "litellm-loopback", model: "GLM-5.3", models: ["GLM-5.3"] });
  const call = body => fetch(`${litellmSession.serverUrl}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${litellmSession.token}` }, body: JSON.stringify(body) });
  const answered = await call({ model: "GLM-5.3", input: "synthetic", service_tier: "standard" });
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).model, "GLM-5.3");
  const streamed = await (await call({ model: "GLM-5.3", input: "synthetic", stream: true })).text();
  assert.doesNotMatch(streamed, /volc-coding/);
  assert.match(streamed, /"content":\[\]/);
  assert.match(streamed, /合成回复/);
  assert.equal((await call({ model: "volc-coding", input: "synthetic" })).status, 403);
  assert.equal(proxied.length, 2);
  for (const request of proxied) {
    assert.equal(request.url, "/v1/responses");
    assert.equal(request.authorization, "Bearer synthetic-litellm-key");
    assert.equal(request.body.model, "volc-coding");
    assert.equal("service_tier" in request.body, false);
  }
  assert.ok(probes.length >= 1 && probes.every(value => value === null), "preflight's liveness probe carries no key");
  const media = await fetch(`${litellmSession.serverUrl}/auth/media-token`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${litellmSession.token}` }, body: JSON.stringify({ kind: "image" }) });
  assert.equal(media.status, 503);
  assert.equal((await media.json()).error.code, "media_provider_not_configured");
  assert.match(litellmOutput, /Chat models offered: GLM-5\.3 \(default GLM-5\.3\)/);
  assert.match(litellmOutput, /图片与视频不可用/);
  assert.doesNotMatch(litellmOutput + health + streamed, /synthetic-litellm-key/);
  await halt(litellmRun.child);

  child = spawn(process.execPath, [path.resolve("scripts/start-app.js"), deployment, "--server-only"],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`控制面启动超时：\n${output}`)), 30_000);
    const done = () => { if (output.includes("控制面已就绪")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", done); child.stderr.on("data", done);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`启动进程提前退出 ${code}：\n${output}`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  // The login protocol is live and device-bound, and the preflight guidance the
  // operator needs was printed.
  const publicKey = createPublicKey(generateKeyPairSync("ed25519").privateKey).export({ format: "der", type: "spki" }).toString("base64url");
  // A client from before sign-ins came back to their device is told to update.
  const bare = await fetch(`${origin}/auth/feishu/begin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey }) });
  assert.equal(bare.status, 400); assert.equal((await bare.json()).error, "client_update_required");
  const begun = await fetch(`${origin}/auth/feishu/begin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey, returnPort: 50_000 }) });
  assert.equal(begun.status, 200);
  const flow = await begun.json();
  assert.ok(flow.launchUrl.startsWith(`${origin}/auth/feishu/launch?flow=`), flow.launchUrl);
  assert.equal((await fetch(`${origin}/auth/feishu/begin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publicKey: "nope", returnPort: 50_000 }) })).status, 400);
  assert.match(output, new RegExp(`回调地址 ${origin}/auth/feishu/callback`));
  assert.match(output, /申请授权范围 docs:permission\.member:auth docx:document:readonly/);
  assert.match(output, /已启用写入动作/);
  assert.doesNotMatch(output, /synthetic-app-secret|synthetic-model-key/);
  console.log(JSON.stringify({ passed: true, localModeUsable: true, litellmModeBooted: true, litellmKeyStayedOnServer: true, mediaReportedUnconfigured: true,
    feishuModeBooted: true, loginProtocolLive: true, registrationGuidancePrinted: true, secretsNeverPrinted: true, sessionFileRemovedOnExit: true,
    liveFeishuCalls: 0, modelCalls: 0, fakeLoopbackProxyCalls: proxied.length }));
} finally {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]); child.kill("SIGKILL"); }
  await halt(litellmRun?.child);
  proxy.close(); proxy.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
