import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { MediaProviderError, MiniMaxMediaProvider } from "../src/control-plane/minimax-media.js";
import { QwenVideoProvider } from "../src/control-plane/qwen-media.js";
import { MediaService } from "../src/control-plane/media-service.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";

const key = "sk-sp-synthetic-token-plan-key";
const TASK = "7aa368f2-e474-40da-9f0d-7fb6118b6eb5";
const PROMPT = "6 秒产品概念短片，合成测试描述";
// The Token Plan's own answers, recorded 2026-09-23 with the real key (the
// signed address shortened, the prompt replaced). Submission's is the one
// agent-media read its task id and status from for the same task.
const SUBMITTED = { request_id: "7b156877-360c-47b9-a743-88ea813f6ebc", output: { task_id: TASK, task_status: "PENDING" } };
const RUNNING = { request_id: "578c5b3b-56b9-4fd5-913e-7104140b0ad6", output: { task_id: TASK, task_status: "RUNNING", submit_time: "2026-09-23 18:07:03.149", scheduled_time: "2026-09-23 18:07:03.216" } };
const SUCCEEDED = { request_id: "4b4aec92-99ab-4fe3-b05d-b3dbadb9bfd9", output: { task_id: TASK, task_status: "SUCCEEDED",
  submit_time: "2026-09-23 18:07:03.149", scheduled_time: "2026-09-23 18:07:03.216", end_time: "2026-09-23 18:08:49.873",
  video_url: `https://dashscope-463f.oss-accelerate.aliyuncs.com/1d/63/20260923/110a434f/37532969-metadata_video_1080p_${TASK}_refiner.mp4?Expires=1790244529&OSSAccessKeyId=LTAI5tSynthetic&Signature=synthetic`,
  orig_prompt: PROMPT }, usage: { video_count: 1, duration: 6, SR: 1080, output_video_duration: 6, input_video_duration: 0, ratio: "16:9" } };
const UNKNOWN = { request_id: "563045c0-a005-4614-ad03-f53b1c9e0b9a", output: { task_id: "00000000-0000-4000-8000-000000000000", task_status: "UNKNOWN" } };
const BAD_KEY = { request_id: "8599d8be-4170-43c9-ad5d-4c8f6764e6e8", code: "InvalidApiKey", message: "Invalid API-key provided. For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#apikey-error" };
// The finished answer came as "application/json; charset=utf-8", the refusal as plain "application/json".
const answer = (value, status = 200, type = "application/json; charset=utf-8") => new Response(JSON.stringify(value), { status, headers: { "content-type": type } });
const provider = (fetchImpl) => new QwenVideoProvider({ apiKey: key, fetchImpl, timeoutMs: 2000 });

test("a video is submitted the way agent-media submits it, and nothing but the task comes back", async () => {
  const calls = [];
  const result = await provider(async (url, init) => { calls.push({ url, init }); return answer(SUBMITTED); }).submit({ kind: "video", prompt: PROMPT });
  assert.deepEqual(result, { state: "running", taskId: TASK });
  assert.equal(calls.length, 1);
  const [{ url, init }] = calls;
  assert.equal(url, "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis");
  assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
  assert.equal(init.headers.authorization, `Bearer ${key}`);
  assert.equal(init.headers["x-dashscope-async"], "enable", "without it the call waits for the whole video");
  assert.deepEqual(JSON.parse(init.body), { model: "happyhorse-1.1-t2v", input: { prompt: PROMPT },
    parameters: { resolution: "1080P", duration: 6, watermark: false, ratio: "16:9" } });
});

test("a finished task hands over its address and nothing of the prompt it repeats back", async () => {
  const urls = [];
  const qwen = provider(async (url) => { urls.push(url); return answer(urls.length === 1 ? RUNNING : SUCCEEDED); });
  assert.deepEqual(await qwen.poll(TASK), { state: "running" });
  const done = await qwen.poll(TASK);
  assert.equal(done.state, "awaiting_acceptance");
  assert.equal(done.url, SUCCEEDED.output.video_url);
  assert.equal(done.bytes, null, "the size is not reported, so it is not claimed");
  assert.doesNotMatch(JSON.stringify(done), new RegExp(PROMPT));
  assert.deepEqual(urls, [`https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/tasks/${TASK}`, `https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/tasks/${TASK}`]);
});

test("a task the provider does not have ends at once, instead of being asked about for an hour", async () => {
  const lost = "00000000-0000-4000-8000-000000000000";
  assert.deepEqual(await provider(async () => answer(UNKNOWN)).poll(lost), { state: "failed", error: "media_task_unknown" });
});

test("a refusal says it is certain and carries the provider's code, never its message", async () => {
  const refused = await provider(async () => answer(BAD_KEY, 401, "application/json")).submit({ kind: "video", prompt: PROMPT }).catch((error) => error);
  assert.ok(refused instanceof MediaProviderError);
  assert.equal(refused.code, "media_provider_rejected");
  assert.equal(refused.uncertain, false, "a 401 created nothing, so nothing is left to look up");
  assert.equal(refused.detail, "InvalidApiKey");
  assert.doesNotMatch(JSON.stringify(refused), /Invalid API-key provided/);
  // A generation the provider itself gave up on names why, for the server log.
  // Not recorded: the shape is the API reference's (output carries code and
  // message, its example code InvalidParameter), 2026-09-23.
  const failed = await provider(async () => answer({ output: { task_id: TASK, task_status: "FAILED", code: "InvalidParameter", message: "synthetic" } })).poll(TASK);
  assert.deepEqual(failed, { state: "failed", error: "media_provider_rejected", detail: "InvalidParameter" });
});

test("an answer that went missing or is not the provider's is never taken as a result", async () => {
  const submit = (fetchImpl) => provider(fetchImpl).submit({ kind: "video", prompt: PROMPT }).catch((error) => error);
  // Whether a lost or broken answer to a submission created a task is unknown.
  for (const fetchImpl of [async () => { throw new TypeError("fetch failed"); }, async () => answer({ message: "busy" }, 503),
    async () => new Response("<html>gateway</html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () => answer({ output: { task_id: "not-a-uuid", task_status: "PENDING" } })]) {
    const error = await submit(fetchImpl);
    assert.ok(error instanceof MediaProviderError, String(error)); assert.equal(error.uncertain, true, error.code);
  }
  const poll = (value, id = TASK) => provider(async () => typeof value === "function" ? value() : answer(value)).poll(id).catch((error) => error.code);
  assert.equal(await poll({ output: { ...SUCCEEDED.output, task_id: "11111111-1111-4111-8111-111111111111" } }), "media_provider_protocol_error");
  assert.equal(await poll({ output: { ...SUCCEEDED.output, video_url: "http://insecure.example.com/a.mp4" } }), "invalid_media_result");
  assert.equal(await poll({ output: { ...SUCCEEDED.output, video_url: `https://cdn.example.com/a.mp4?k=${key}` } }), "invalid_media_result");
  assert.equal(await poll(() => answer({ output: { ...SUCCEEDED.output, orig_prompt: "长".repeat(50_000) } })), "media_provider_response_too_large");
  assert.equal(await poll({ output: { task_id: TASK, task_status: "SOMETHING_NEW" } }), "media_provider_protocol_error");
  assert.equal(await poll(SUCCEEDED, "../tasks"), "invalid_media_task");
});

test("only a Token Plan key is accepted, and only HappyHorse text-to-video settings", () => {
  for (const apiKey of [undefined, "", "sk-0123456789abcdef", "sk-sp-short", "sk-sp-has space inside"]) assert.throws(() => new QwenVideoProvider({ apiKey }), /Token Plan/);
  assert.throws(() => new QwenVideoProvider({ apiKey: key, resolution: "4K" }), /Unsupported/);
  assert.throws(() => new QwenVideoProvider({ apiKey: key, seconds: 20 }), /Unsupported/);
  assert.throws(() => new QwenVideoProvider({ apiKey: key, model: "happyhorse-1.1-i2v" }), /Unsupported/);
  assert.deepEqual(new QwenVideoProvider({ apiKey: key }).offer("video"), { provider: "qwen", model: "happyhorse-1.1-t2v", seconds: 6, resolution: "1080P", aspectRatio: "16:9" });
});

// The service with video on Qwen and images on MiniMax, as the server runs it.
async function service(t, qwenFetch, options = {}) {
  let now = Date.now(); const sessions = new SessionRegistry({ now: () => now });
  const minimaxCalls = [];
  const minimax = new MiniMaxMediaProvider({ apiKey: "synthetic-minimax-key", timeoutMs: 2000, fetchImpl: async (url) => {
    minimaxCalls.push(url); return Response.json({ data: { image_urls: ["https://cdn.example.com/a.png"] }, base_resp: { status_code: 0 } });
  } });
  const media = new MediaService({ sessions, provider: minimax, providers: { video: provider(qwenFetch) }, now: () => now, ...options });
  const server = createModelGateway({ sessions, apiKey: "synthetic", authHandler: (req, res) => media.handle(req, res), fetchImpl: () => assert.fail("No text model calls") });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await media.close(); server.close(); server.closeAllConnections(); });
  const parent = sessions.issue({ tenantId: "tenant", userId: "user", appId: "cli_app", deviceId: "device", authProvider: "feishu", deviceProof: "ed25519-login" });
  const post = async (route, token, body) => {
    const response = await fetch(origin + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const lease = async (kind) => (await post("/auth/media-token", parent.token, { kind })).body;
  const create = (token, extra = {}) => post("/v1/media/jobs", token, { kind: "video", prompt: PROMPT, idempotencyKey: randomUUID(), instanceId: media.instanceId, confirmed: true, ...extra });
  return { media, post, lease, create, minimaxCalls, advance: (ms) => { now += ms; }, settle: () => Promise.all([...media.pending]) };
}

test("with a Token Plan key, video is offered and made on Qwen while images stay on MiniMax", async (t) => {
  const qwenCalls = [];
  const f = await service(t, async (url, init) => { qwenCalls.push(init.method); return answer(init.method === "POST" ? SUBMITTED : SUCCEEDED); });
  const video = await f.lease("video"), image = await f.lease("image");
  assert.deepEqual(video.offer, { provider: "qwen", model: "happyhorse-1.1-t2v", seconds: 6, resolution: "1080P", aspectRatio: "16:9" });
  assert.deepEqual(image.offer, { provider: "minimax", model: "image-01" });
  const made = await f.create(video.token, { model: "happyhorse-1.1-t2v" }); await f.settle();
  assert.equal(made.status, 202, JSON.stringify(made.body));
  assert.equal(made.body.model, "happyhorse-1.1-t2v");
  f.advance(10000); await f.post("/v1/media/job", video.token, { id: made.body.id }); await f.settle();
  const job = (await f.post("/v1/media/job", video.token, { id: made.body.id })).body;
  assert.equal(job.state, "awaiting_acceptance", `${job.state} ${job.error}`);
  assert.equal(job.result.url, SUCCEEDED.output.video_url); assert.equal(job.result.bytes, null);
  assert.deepEqual(qwenCalls, ["POST", "GET"]);
  const picture = await f.post("/v1/media/jobs", image.token, { kind: "image", prompt: "synthetic", idempotencyKey: randomUUID(), instanceId: f.media.instanceId, confirmed: true, model: "image-01" });
  assert.equal(picture.status, 202); await f.settle();
  assert.equal(f.minimaxCalls.length, 1, "the image went to MiniMax"); assert.equal(qwenCalls.length, 2, "and not to Qwen");
});

// A client from before offers shows "MiniMax-Hailuo-2.3 · 6 秒 · 768P" and "发送给
// MiniMax" on its card whatever the server does. Its video would go to Qwen
// under a card that named MiniMax, so it is refused before anything is sent.
test("a video confirmed under another model's name is refused before the prompt leaves", async (t) => {
  const f = await service(t, async () => assert.fail("nothing may be sent to Qwen"));
  const { token } = await f.lease("video");
  for (const extra of [{}, { model: "MiniMax-Hailuo-2.3" }]) {
    const refused = await f.create(token, extra);
    assert.equal(refused.status, 409, JSON.stringify(extra)); assert.equal(refused.body.error.code, "media_model_changed");
  }
  await f.settle();
  assert.equal(f.media.jobs.size, 0);
});

test("why Qwen refused or gave up is in the server log as its code, never its message or the prompt", async (t) => {
  const events = []; let status = 401;
  const f = await service(t, async (url, init) => init.method === "POST"
    ? (status === 401 ? answer(BAD_KEY, 401, "application/json") : answer(SUBMITTED))
    : answer({ request_id: "synthetic", output: { task_id: TASK, task_status: "FAILED", code: "InvalidParameter", message: `could not render: ${PROMPT}` } }), { audit: (event) => events.push(event) });
  const { token } = await f.lease("video");
  const refused = await f.create(token, { model: "happyhorse-1.1-t2v" }); await f.settle();
  status = 200;
  const made = await f.create(token, { model: "happyhorse-1.1-t2v" }); await f.settle();
  f.advance(10000); await f.post("/v1/media/job", token, { id: made.body.id }); await f.settle();
  assert.equal((await f.post("/v1/media/job", token, { id: made.body.id })).body.state, "failed");
  assert.deepEqual(events, [
    { event: "media-submit-failed", job: refused.body.id, kind: "video", code: "media_provider_rejected", state: "failed", providerCode: "InvalidApiKey" },
    { event: "media-failed", job: made.body.id, kind: "video", code: "media_provider_rejected", providerCode: "InvalidParameter" },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /Invalid API-key|could not render|合成测试/);
});
