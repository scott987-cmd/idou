import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MediaWorkspace, mediaOffer } from "../src/application/media-workspace.js";
import { agentMediaActions } from "../src/application/agent-media-actions.js";
import { QwenVideoProvider } from "../src/control-plane/qwen-media.js";
import { MediaDownloader, publicMediaAddress, validateMediaBytes } from "../src/application/media-download.js";
import { MediaPreview } from "../src/desktop/media-preview.js";
import { MediaService } from "../src/control-plane/media-service.js";
import { MediaProviderError, MiniMaxMediaProvider } from "../src/control-plane/minimax-media.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { createServer } from "node:http";

// serverAhead: how far the control plane's clock runs ahead of this one.
// providers: another provider for a kind, as the server runs video on Qwen.
// seen: every request the desktop makes, with its body. legacy: the server
// answers leases as one from before offers did.
async function fixture(t, { serverAhead = 0, provider: given = null, providers = {}, seen = null, legacy = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-media-native-"));
  const sessions = new SessionRegistry({ now: () => Date.now() + serverAhead }); let calls = 0, drop = false;
  // What the provider offers is MiniMax's unless a test says otherwise.
  const minimax = new MiniMaxMediaProvider({ apiKey: "synthetic-offer-only" });
  const provider = { offer: (kind) => minimax.offer(kind), ...(given ?? { submit: async () => { calls++; return { state: "awaiting_acceptance", url: "https://cdn.example.com/private-result.png" }; } }) };
  const service = new MediaService({ sessions, provider, providers, allowDevelopment: true });
  const server = createModelGateway({ sessions, apiKey: "synthetic", authHandler: (req, res) => service.handle(req, res) });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  let current = { ...sessions.issue({ tenantId: "tenant", userId: "user", deviceId: "device" }), serverUrl: origin };
  const taskId = randomUUID(), filename = path.join(directory, "media.json");
  const make = () => new MediaWorkspace({ filename, getTask: () => ({ mode: "cowork" }), getSession: async () => current, fetchImpl: async (url, init) => {
    if (url.endsWith("/v1/media/jobs")) { const journal = JSON.parse(await readFile(filename, "utf8")); assert.ok(journal.rows.some((row) => row.id === JSON.parse(init.body).idempotencyKey)); }
    seen?.push({ route: new URL(url).pathname, body: JSON.parse(init.body) });
    const response = await fetch(url, init);
    if (legacy && url.endsWith("/auth/media-token")) { const { offer, ...before } = await response.json(); return Response.json(before); }
    if (drop && url.endsWith("/v1/media/jobs")) { await response.body.cancel(); throw new Error("synthetic lost response"); }
    return response;
  } });
  t.after(async () => { await service.close(); server.close(); server.closeAllConnections(); await rm(directory, { recursive: true, force: true }); });
  return { client: make(), make, taskId, filename, service, sessions, calls: () => calls, drop: () => { drop = true; }, switch: () => { current = { ...sessions.issue({ tenantId: "tenant", userId: "other-user", deviceId: "device" }), serverUrl: origin }; } };
}
test("native media journal reserves before POST and restores a lost response through read-only lookup", async (t) => {
  const f = await fixture(t); f.drop();
  const draft = await f.client.prepare(f.taskId, { kind: "image", prompt: "Secret synthetic prompt" });
  const row = await f.client.create(draft); assert.equal(row.state, "unresolved"); assert.equal(f.calls(), 1);
  const restored = f.make(), rows = await restored.list(f.taskId); assert.equal(rows.length, 1);
  const result = await restored.refresh(f.taskId, row.id); assert.equal(result.state, "awaiting_acceptance"); assert.equal(f.calls(), 1);
  assert.equal((await restored.result(f.taskId, row.id)).url, "https://cdn.example.com/private-result.png");
  const disk = await readFile(f.filename, "utf8"); assert.doesNotMatch(disk, /Secret synthetic prompt|private-result|token|http/);
  assert.doesNotMatch(JSON.stringify(result), /private-result|token|http/);
  await restored.refresh(f.taskId, row.id, true); assert.equal((await restored.list(f.taskId))[0].state, "canceled");
  await assert.rejects(restored.result(f.taskId, row.id), /尚不可用/);
});
// "hasError" alone left the Agent polling a video for 40 minutes without a
// clue whether anything would ever come (2026-09-23).
test("a job's failure comes with the server's code for it and what that means, nothing of the provider's answer", async (t) => {
  const f = await fixture(t, { provider: { submit: async () => { throw new MediaProviderError("media_provider_rejected"); } } });
  const row = await f.client.create(await f.client.prepare(f.taskId, { kind: "image", prompt: "synthetic" }));
  const result = await f.client.refresh(f.taskId, row.id);
  assert.equal(result.state, "failed");
  assert.equal(result.hasError, true);
  assert.equal(result.error, "media_provider_rejected");
  assert.equal(result.errorMeaning, "生成服务拒绝了这个任务");
});
// A description over the limit is refused as too long, naming the limit; it used
// to read like an invalid one (请输入有效的图片或视频描述), and nothing is asked
// of the server either way.
test("an over-long description is refused as too long, with the limit and its length", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.prepare(f.taskId, { kind: "image", prompt: "字".repeat(1501) }), /图片描述最多 1500 个字符，这次是 1501 个/);
  await assert.rejects(f.client.prepare(f.taskId, { kind: "video", prompt: "字".repeat(2001) }), /视频描述最多 2000 个字符，这次是 2001 个/);
  await assert.rejects(f.client.prepare(f.taskId, { kind: "image", prompt: "   " }), /请输入有效的图片或视频描述/);
  await f.client.prepare(f.taskId, { kind: "image", prompt: "字".repeat(1500) });
  assert.equal(f.calls(), 0);
});
// Since 2026-09-22 the control plane runs on another machine, a few hundred
// milliseconds ahead of this one even with both synchronised. Its media
// authorization expires "five minutes from now" by its own clock; this one
// refused it as too long-lived (媒体授权响应无效) whenever the session had more
// than five minutes left, and no image or video could be generated.
test("a control plane whose clock runs slightly ahead still authorizes media generation", async (t) => {
  const f = await fixture(t, { serverAhead: 400 });
  const draft = await f.client.prepare(f.taskId, { kind: "image", prompt: "Synthetic" });
  assert.match(draft.lease.token, /^[A-Za-z0-9_-]{43}$/);
  await f.client.create(draft); assert.equal(f.calls(), 1);
});
test("account switch after confirmation preparation refuses submission and hides previous owner jobs", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.taskId, { kind: "image", prompt: "Synthetic" });
  const made = await f.client.create(draft); f.switch();
  await assert.rejects(f.client.create(draft), /变化/); assert.equal(f.calls(), 1);
  assert.deepEqual(await f.client.list(f.taskId), []);
  await assert.rejects(f.client.refresh(f.taskId, made.id), /不属于/);
});
test("journal write failure and malformed existing journal never dispatch paid work", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.taskId, { kind: "video", prompt: "Synthetic" });
  f.client.save = async () => { throw new Error("synthetic full disk"); };
  await assert.rejects(f.client.create(draft), /full disk/); assert.equal(f.calls(), 0);
  await writeFile(f.filename, "not JSON", { mode: 0o600 });
  await assert.rejects(f.make().create(draft), /原记录未改动/); assert.equal(f.calls(), 0); assert.equal(await readFile(f.filename, "utf8"), "not JSON");
});
test("server epoch changes do not recreate jobs after client restore", async (t) => {
  const f = await fixture(t), draft = await f.client.prepare(f.taskId, { kind: "image", prompt: "Synthetic" }), row = await f.client.create(draft);
  f.service.instanceId = randomUUID(); f.service.jobs.clear();
  const restored = f.make(), value = await restored.refresh(f.taskId, row.id); assert.equal(value.state, "server_lost"); assert.equal(f.calls(), 1);
});
test("native preview validation excludes private/reserved addresses and active or mismatched content", () => {
  for (const ip of ["127.0.0.1", "10.1.1.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.1.1", "0.0.0.0", "198.18.0.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "example.com"]) assert.equal(publicMediaAddress(ip), false, ip);
  assert.equal(publicMediaAddress("8.8.8.8"), true);
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(8)]);
  assert.equal(validateMediaBytes("image", "image/png", png), "png");
  assert.throws(() => validateMediaBytes("image", "text/html", png), /不匹配/);
  assert.throws(() => validateMediaBytes("image", "image/svg+xml", Buffer.from("<svg onload='x'>unsafe</svg>")), /不匹配/);
  assert.throws(() => validateMediaBytes("video", "video/mp4", png), /不匹配/);
  assert.throws(() => validateMediaBytes("image", "image/png", Buffer.alloc(12582913)), /限制/);
});

test("download pipeline pins public DNS, forwards no credentials and refuses redirects or private answers", async () => {
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(8)]), result = { kind: "image", url: "https://cdn.example.com/private.png?signature=synthetic", expiresAt: Date.now() + 100000 };
  let requests = 0, statusCode = 200, address = "8.8.8.8", payload = png;
  const downloader = new MediaDownloader({ resolve: async () => [address], requestImpl: (url, options, callback) => {
    requests++; assert.equal(url.hostname, "cdn.example.com"); assert.equal(options.headers, undefined); assert.equal(options.agent, false);
    options.lookup(url.hostname, { all: true }, (error, values) => { assert.equal(error, null); assert.deepEqual(values, [{ address: "8.8.8.8", family: 4 }]); });
    const req = new EventEmitter(); req.end = () => {
      const res = new PassThrough(); res.statusCode = statusCode; res.headers = { "content-type": "image/png" };
      callback(res); if (!res.destroyed) res.end(payload);
    }; return req;
  } });
  assert.equal((await downloader.download(result)).extension, "png");
  statusCode = 302; await assert.rejects(downloader.download(result), /拒绝/); assert.equal(requests, 2);
  statusCode = 200; payload = Buffer.alloc(12582913); await assert.rejects(downloader.download(result), /限制/);
  address = "127.0.0.1"; await assert.rejects(downloader.download(result), /非公开/); assert.equal(requests, 3);
  await assert.rejects(downloader.download({ ...result, url: "https://cdn.example.com:444/file" }), /标准端口/);
});

test("预览在应用内只占一个位置：下载期间不接受第二次打开，失败后不留残余", async () => {
  // The result now renders in the panel beside the conversation, so there is one
  // place for it. The invariant that still matters is that a slow download
  // cannot be started twice over, and that a failed one leaves nothing behind.
  const preview = new MediaPreview({ WebContentsView: null, window: null }), rejections = [];
  preview.downloader.download = async () => new Promise((_resolve, reject) => rejections.push(reject));
  const first = preview.open({}, async () => {});
  await assert.rejects(preview.open({}, async () => {}), /请先等待/);
  assert.equal(rejections.length, 1);
  rejections[0](new Error("synthetic download failure"));
  await assert.rejects(first, /synthetic/);
  assert.equal(preview.opening, 0);
  assert.equal(preview.current, null);
  // The slot is free again, so a later attempt is not blocked by the failed one.
  const second = preview.open({}, async () => {});
  // open() tears down any previous view before it downloads, so the request is
  // one turn away rather than synchronous.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rejections.length, 2);
  rejections[1](new Error("synthetic second failure"));
  await assert.rejects(second, /synthetic second/);
  assert.equal(preview.opening, 0);
});

test("a server with no MiniMax key says so instead of a temporary-sounding HTTP 503, and nothing else of its answer is shown", async (t) => {
  // What bin/server.js answers on every media route when chat runs on GLM without a MiniMax key.
  let status = 503, type = "application/json", body = JSON.stringify({ error: { code: "media_provider_not_configured", message: "SERVER-TEXT-NOT-SHOWN" } });
  const server = createServer((req, res) => { req.resume(); res.writeHead(status, { "content-type": type }); res.end(body); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.close(); server.closeAllConnections(); });
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-media-unconfigured-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const session = { token: "a".repeat(43), expiresAt: Date.now() + 60_000, serverUrl: `http://127.0.0.1:${server.address().port}` };
  const client = new MediaWorkspace({ filename: path.join(directory, "media.json"), getTask: () => ({ mode: "cowork" }), getSession: async () => session });
  const taskId = randomUUID(), draft = kind => client.prepare(taskId, { kind, prompt: "Synthetic" });
  for (const kind of ["image", "video"]) {
    await assert.rejects(draft(kind), error => /服务端没有配置 MiniMax 密钥/.test(error.message) && /请联系管理员/.test(error.message) && !/HTTP 503|SERVER-TEXT/.test(error.message));
  }
  // Any other 503, a reason not in the gateway's small JSON, or the same code on another status keeps the plain status.
  for ([status, type, body] of [[503, "application/json", JSON.stringify({ error: { code: "media_service_closed" } })], [503, "text/plain", "media_provider_not_configured"],
    [503, "application/json", JSON.stringify({ error: { code: "media_provider_not_configured" }, padding: "x".repeat(5000) })], [503, "application/json", "{not json"],
    [502, "application/json", JSON.stringify({ error: { code: "media_provider_not_configured" } })]]) {
    await assert.rejects(draft("image"), error => error.message.includes(`HTTP ${status}`) && !/MiniMax 密钥/.test(error.message), `${status} ${type}`);
  }
  // Media not enabled at all is still the 404 it always was.
  [status, type, body] = [404, "application/json", JSON.stringify({ error: { code: "not_found" } })];
  await assert.rejects(draft("image"), /IDOU_MEDIA_ENABLED=1/);
});

// Video moved to Qwen on 2026-09-23. The card said "MiniMax-Hailuo-2.3 · 6 秒 ·
// 768P" and "发送给企业服务端及 MiniMax" from constants in this build, so it
// would have named the wrong model and the wrong recipient of the description.
const QWEN_TASK = "7aa368f2-e474-40da-9f0d-7fb6118b6eb5";
const QWEN_URL = `https://dashscope-463f.oss-accelerate.aliyuncs.com/1d/63/20260923/110a434f/37532969-metadata_video_1080p_${QWEN_TASK}_refiner.mp4?Signature=synthetic`;
const qwenVideo = () => new QwenVideoProvider({ apiKey: "sk-sp-synthetic-token-plan-key", fetchImpl: async (url, init) => Response.json(init.method === "POST"
  ? { request_id: "synthetic", output: { task_id: QWEN_TASK, task_status: "PENDING" } }
  : { request_id: "synthetic", output: { task_id: QWEN_TASK, task_status: "SUCCEEDED", video_url: QWEN_URL, orig_prompt: "synthetic" } }) });
const mediaCreate = (f, cards) => agentMediaActions({ getScope: () => ({ service: { get: () => ({ title: "发布包" }) }, media: f.client }),
  confirm: async (card) => { cards.push(card); return { response: 1 }; }, openPreview: async () => {} })["media-create"];

test("the video card names the model and the provider the server said it would use, and the job carries that model", async (t) => {
  const seen = [], cards = [];
  const f = await fixture(t, { providers: { video: qwenVideo() }, seen });
  const row = await mediaCreate(f, cards)({ kind: "video", prompt: "六秒概念短片" }, f.taskId);
  assert.equal(cards.length, 1);
  assert.match(cards[0].detail, /^任务：发布包\nhappyhorse-1\.1-t2v · 6 秒 · 1080P · 16:9\n/);
  assert.match(cards[0].boundary, /^描述将发送给企业服务端及阿里云百炼，/);
  assert.doesNotMatch(`${cards[0].detail}${cards[0].boundary}`, /MiniMax|Hailuo|768P/);
  assert.equal(seen.find((call) => call.route === "/v1/media/jobs").body.model, "happyhorse-1.1-t2v");
  assert.equal(row.state, "running", row.submitError);
  for (const job of f.service.jobs.values()) job.nextPollAt = 0;
  await f.client.refresh(f.taskId, row.id); await Promise.all([...f.service.pending]);
  const done = await f.client.refresh(f.taskId, row.id);
  assert.equal(done.state, "awaiting_acceptance", done.submitError);
  assert.equal((await f.client.result(f.taskId, row.id)).url, QWEN_URL);
});

test("an image on the same server keeps MiniMax's name on its card", async (t) => {
  const cards = [];
  const f = await fixture(t, { providers: { video: qwenVideo() } });
  await mediaCreate(f, cards)({ kind: "image", prompt: "主视觉", aspect: "16:9" }, f.taskId);
  assert.match(cards[0].detail, /\nimage-01 · 16:9\n/);
  assert.match(cards[0].boundary, /^描述将发送给企业服务端及MiniMax，/);
});

// A server from before offers used only MiniMax, and a job naming a model is
// refused by it outright (its body check allows no extra field).
test("against a server from before offers the card keeps MiniMax's words and the job names no model", async (t) => {
  const seen = [], cards = [];
  const f = await fixture(t, { legacy: true, seen, provider: { submit: async () => ({ state: "running", taskId: "12345" }) } });
  const row = await mediaCreate(f, cards)({ kind: "video", prompt: "六秒概念短片" }, f.taskId);
  assert.match(cards[0].detail, /\nMiniMax-Hailuo-2\.3 · 6 秒 · 768P\n/);
  assert.match(cards[0].boundary, /^描述将发送给企业服务端及MiniMax，/);
  assert.equal("model" in seen.find((call) => call.route === "/v1/media/jobs").body, false);
  assert.equal(row.state, "running", row.submitError);
});

test("an offer is taken only as far as it can be shown truthfully", () => {
  assert.deepEqual(mediaOffer(undefined, "video"), { provider: "minimax", model: "MiniMax-Hailuo-2.3", seconds: 6, resolution: "768P", legacy: true });
  // A field a later server adds is left behind rather than refused or shown.
  assert.deepEqual(mediaOffer({ provider: "qwen", model: "happyhorse-1.1-t2v", seconds: 6, resolution: "1080P", aspectRatio: "16:9", price: "¥1" }, "video"),
    { provider: "qwen", model: "happyhorse-1.1-t2v", seconds: 6, resolution: "1080P", aspectRatio: "16:9" });
  for (const offer of [null, { provider: "unknown", model: "x" }, { provider: "qwen", model: "a b" }, { provider: "qwen", model: "happyhorse-1.1-t2v", seconds: "6", resolution: "1080P" },
    { provider: "qwen", model: "happyhorse-1.1-t2v", seconds: 6, resolution: "<b>" }, { provider: "__proto__", model: "x" }]) {
    assert.throws(() => mediaOffer(offer, "video"), /媒体授权响应无效/, JSON.stringify(offer));
  }
});
