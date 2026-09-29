import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { MiniMaxMediaProvider } from "../src/control-plane/minimax-media.js";
import { MediaService } from "../src/control-plane/media-service.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";

const key = "synthetic-media-provider-secret";
const ok = (value) => Response.json({ ...value, base_resp: { status_code: 0 } });
async function fixture(t, fetchImpl, options = {}) {
  let now = Date.now(); const sessions = new SessionRegistry({ now: () => now });
  const media = new MediaService({ sessions, provider: new MiniMaxMediaProvider({ apiKey: key, fetchImpl, timeoutMs: 2000 }), now: () => now, ...options });
  const server = createModelGateway({ sessions, apiKey: key, authHandler: (req, res) => media.handle(req, res), fetchImpl: () => assert.fail("No text model calls") });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await media.close(); server.close(); server.closeAllConnections(); });
  const login = (extra = {}) => sessions.issue({ tenantId: "tenant", userId: "user", appId: "cli_app", deviceId: "device", authProvider: "feishu", deviceProof: "ed25519-login", ...extra });
  const parent = login();
  const post = async (route, token, body, headers = {}) => {
    const response = await fetch(origin + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const lease = async (kind = "image", owner = parent) => (await post("/auth/media-token", owner.token, { kind })).body.token;
  const create = (token, extra = {}) => post("/v1/media/jobs", token, { kind: "image", prompt: "Synthetic image", idempotencyKey: randomUUID(), instanceId: media.instanceId, confirmed: true, ...extra });
  return { media, sessions, parent, login, post, lease, create, origin, advance: (ms) => { now += ms; }, settle: () => Promise.all([...media.pending]) };
}

test("image job is idempotent, key stays server-only and accepted output is explicitly not durable", async (t) => {
  const calls = []; const f = await fixture(t, async (url, init) => {
    calls.push({ url, init }); return ok({ data: { image_urls: ["https://cdn.example.com/synthetic.png"] } });
  });
  const token = await f.lease(), idempotencyKey = randomUUID();
  const results = await Promise.all([f.create(token, { idempotencyKey }), f.create(token, { idempotencyKey })]); await f.settle();
  assert.equal(results[0].body.id, results[1].body.id); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.minimaxi.com/v1/image_generation");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${key}`); assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "image-01", prompt: "Synthetic image", aspect_ratio: "1:1", n: 1, response_format: "url", prompt_optimizer: false, aigc_watermark: true });
  const job = (await f.post("/v1/media/job", token, { id: results[0].body.id })).body;
  assert.equal(job.state, "awaiting_acceptance"); assert.equal(job.persisted, false); assert.equal(job.result.url, "https://cdn.example.com/synthetic.png");
  assert.doesNotMatch(JSON.stringify(job), /synthetic-media-provider-secret|Synthetic image/);
  assert.doesNotMatch(JSON.stringify([...f.media.jobs.values()]), /Synthetic image/);
  assert.equal((await f.create(token, { idempotencyKey, prompt: "different" })).status, 409);
  assert.equal(calls.length, 1);
});

test("media leases have separate audience/kind, expire with parent and cannot cross owner boundaries", async (t) => {
  const f = await fixture(t, async () => ok({ data: { image_urls: ["https://cdn.example.com/a.png"] } }));
  const token = await f.lease(), made = await f.create(token); await f.settle();
  assert.equal((await f.create(f.parent.token)).status, 403);
  assert.equal((await f.create(token, { kind: "video" })).status, 403);
  assert.equal((await f.post("/v1/responses", token, { model: "MiniMax-M3", input: "x" })).status, 403);
  assert.equal((await f.post("/auth/media-token", token, { kind: "image" })).status, 403);
  for (const extra of [{ tenantId: "other" }, { userId: "other" }, { appId: "cli_other" }]) {
    const foreign = await f.lease("image", f.login(extra));
    assert.equal((await f.post("/v1/media/job", foreign, { id: made.body.id })).status, 404);
    assert.equal((await f.post("/v1/media/cancel", foreign, { id: made.body.id })).status, 404);
  }
  const renewed = await f.lease("image", f.login({ deviceId: "new-device" }));
  assert.equal((await f.post("/v1/media/job", renewed, { id: made.body.id })).body.state, "awaiting_acceptance");
  f.sessions.issueForSkills(f.parent.token); assert.ok(f.sessions.verify(token));
  f.sessions.revoke(f.parent.token); assert.equal((await f.create(token)).status, 401);
  const development = f.login({ authProvider: "development", appId: null, deviceProof: null });
  assert.equal((await f.post("/auth/media-token", development.token, { kind: "image" })).status, 403);
  f.advance(300001); assert.equal((await f.post("/v1/media/job", renewed, { id: made.body.id })).status, 401);
});

test("video polling uses the owned provider task, waits between polls and does not resubmit", async (t) => {
  const calls = []; let ready = false;
  const f = await fixture(t, async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.endsWith("/video_generation") && init.method === "POST") return ok({ task_id: "12345" });
    if (url.includes("/query/")) return ok({ task_id: "12345", status: ready ? "Success" : "Processing", ...(ready ? { file_id: "23456" } : {}) });
    assert.ok(url.endsWith("/v1/files/retrieve?file_id=23456")); return ok({ file: { file_id: "23456", purpose: "video_generation", bytes: 5000, download_url: "https://cdn.example.com/a.mp4" } });
  });
  const token = await f.lease("video"), made = await f.create(token, { kind: "video" }); await f.settle();
  const poll = () => f.post("/v1/media/job", token, { id: made.body.id });
  await poll(); assert.equal(calls.length, 1);
  f.advance(10000); await Promise.all([poll(), poll()]); await f.settle(); assert.equal(calls.length, 2);
  ready = true; f.advance(10000); await poll(); await f.settle();
  const result = (await poll()).body; assert.equal(result.state, "awaiting_acceptance"); assert.equal(result.result.bytes, 5000);
  assert.equal(calls.filter((row) => row.method === "POST").length, 1);
  assert.equal(JSON.parse(calls[0].body).model, "MiniMax-Hailuo-2.3");
  assert.ok(calls[1].url.endsWith("/query/video_generation?task_id=12345"));
});

// MiniMax's own answers for a finished video, recorded 2026-09-23 on the
// production key (file 444795417354723; the signed address shortened). The
// test above only ever saw answers made up with a size and a string file id,
// and a real video sat "running" with an error for an hour.
const FINISHED_QUERY = { task_id: "12345", status: "Success", file_id: "444795417354723", video_width: 1366, video_height: 768 };
const FINISHED_FILE = { file: { file_id: 444795417354723, bytes: 0, created_at: 1790145841, filename: "output_aigc.mp4", purpose: "video_generation",
  download_url: "https://public-cdn-video-data-algeng.oss-cn-wulanchabu.aliyuncs.com/inference_output/video/2026-09-23/output_aigc.mp4?Expires=1790167441&OSSAccessKeyId=LTAI5tSynthetic&Signature=synthetic" } };

test("a finished video as MiniMax really reports it -- no size, a numeric file id -- is ready at the next poll", async (t) => {
  const calls = [];
  const f = await fixture(t, async (url, init) => {
    calls.push(url);
    if (init.method === "POST") return ok({ task_id: "12345" });
    if (url.includes("/query/")) return ok(FINISHED_QUERY);
    return ok(FINISHED_FILE);
  });
  const token = await f.lease("video"), made = await f.create(token, { kind: "video" }); await f.settle();
  f.advance(10000); await f.post("/v1/media/job", token, { id: made.body.id }); await f.settle();
  const job = (await f.post("/v1/media/job", token, { id: made.body.id })).body;
  assert.equal(job.state, "awaiting_acceptance", `stuck at ${job.state} with ${job.error}`);
  assert.equal(job.error, null);
  assert.equal(job.result.bytes, null, "an unknown size is said to be unknown, not zero");
  assert.match(job.result.url, /^https:\/\/public-cdn-video-data-algeng\.oss-cn-wulanchabu\.aliyuncs\.com\//);
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ["/v1/video_generation", "/v1/query/video_generation", "/v1/files/retrieve"]);
});

test("a finished video whose file cannot be used fails at once instead of being asked about until it expires", async (t) => {
  let polls = 0;
  const f = await fixture(t, async (url, init) => {
    if (init.method === "POST") return ok({ task_id: "12345" });
    if (url.includes("/query/")) { polls++; return ok(FINISHED_QUERY); }
    return ok({ file: { ...FINISHED_FILE.file, download_url: "http://insecure.example.com/output.mp4" } });
  });
  const token = await f.lease("video"), made = await f.create(token, { kind: "video" }); await f.settle();
  f.advance(10000); await f.post("/v1/media/job", token, { id: made.body.id }); await f.settle();
  const job = (await f.post("/v1/media/job", token, { id: made.body.id })).body;
  assert.equal(job.state, "failed");
  assert.equal(job.error, "invalid_media_result");
  f.advance(60000); await f.post("/v1/media/job", token, { id: made.body.id }); await f.settle();
  assert.equal(polls, 1, "a job that has failed is not asked about again");
});

test("a failed check on a job is recorded with its code only, never the provider's answer", async (t) => {
  const events = [];
  const f = await fixture(t, async (url, init) => {
    if (init.method === "POST") return ok({ task_id: "12345" });
    return Response.json({ task_id: "12345", status: "", base_resp: { status_code: 1004, status_msg: "authorization failed for account 3000123" } });
  }, { audit: (event) => events.push(event) });
  const token = await f.lease("video"), made = await f.create(token, { kind: "video" }); await f.settle();
  f.advance(10000); await f.post("/v1/media/job", token, { id: made.body.id }); await f.settle();
  // MiniMax's own status code is kept: 1004 is a bad key, 1008 an empty balance.
  assert.deepEqual(events, [{ event: "media-poll-failed", job: made.body.id, kind: "video", code: "media_provider_rejected", state: "running", providerCode: "1004" }]);
  assert.doesNotMatch(JSON.stringify(events), /authorization failed|3000123/);
});

test("lost submission response is uncertain and cannot be retried under the same key", async (t) => {
  let calls = 0; const f = await fixture(t, async () => { calls++; throw new Error(key); });
  const token = await f.lease(), idempotencyKey = randomUUID(), made = await f.create(token, { idempotencyKey }); await f.settle();
  const result = await f.create(token, { idempotencyKey });
  assert.equal(result.body.id, made.body.id); assert.equal(result.body.state, "submission_unknown"); assert.equal(result.body.providerMayContinue, true);
  assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
});

test("cancel beats late success, keeps idempotency tombstone and never claims upstream cancellation", async (t) => {
  let release; const f = await fixture(t, () => new Promise((resolve) => { release = resolve; }));
  const token = await f.lease(), idempotencyKey = randomUUID(), made = await f.create(token, { idempotencyKey });
  const canceled = await f.post("/v1/media/cancel", token, { id: made.body.id });
  assert.equal(canceled.body.state, "canceled"); assert.equal(canceled.body.providerMayContinue, true);
  release(ok({ data: { image_urls: ["https://cdn.example.com/late.png"] } })); await f.settle();
  const retried = (await f.create(token, { idempotencyKey })).body; assert.equal(retried.state, "canceled"); assert.equal(retried.result, undefined);
});

test("strict input, cost confirmation, browser origin and bounded body fail before provider dispatch", async (t) => {
  const f = await fixture(t, () => assert.fail("Unexpected paid dispatch")), token = await f.lease();
  for (const extra of [{ confirmed: false }, { model: 42 }, { model: "m".repeat(65) }, { callback_url: "https://evil.example" }, { kind: "audio" }, { prompt: "" }, { prompt: "a".repeat(1501) }, { idempotencyKey: "abc" }, { aspectRatio: "12:1" }, { tenantId: "other" }]) assert.equal((await f.create(token, extra)).status, 400);
  // A client names the model it showed the person; it cannot pick one.
  const chosen = await f.create(token, { model: "arbitrary" });
  assert.equal(chosen.status, 409); assert.equal(chosen.body.error.code, "media_model_changed");
  assert.equal((await f.post("/v1/media/jobs", token, {}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.create(token, { prompt: "a".repeat(20000) })).status, 413);
  assert.equal((await f.post("/v1/media/job", token, { id: randomUUID(), taskId: "123" })).status, 400);
});

test("budget follows owner across tokens/devices and temporary results expire without re-generation", async (t) => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return ok({ data: { image_urls: ["https://cdn.example.com/a.png"] } }); });
  const token = await f.lease(); let first;
  for (let i = 0; i < 4; i++) { const value = await f.create(token); first ??= value.body.id; assert.equal(value.status, 202); await f.settle(); }
  assert.equal((await f.create(await f.lease("image", f.login({ deviceId: "new-device" })))).status, 429); assert.equal(calls, 4);
  f.advance(3600001); const renewed = await f.lease("image", f.login());
  const job = (await f.post("/v1/media/job", renewed, { id: first })).body;
  assert.equal(job.state, "expired"); assert.equal(job.result, undefined); assert.equal(calls, 4);
});

test("provider rejects redirects, unsafe URLs, mismatched resources, oversized and credential-echo responses", async () => {
  assert.throws(() => new MiniMaxMediaProvider({ apiKey: key, upstreamOrigin: "https://evil.example" }), /domestic/);
  for (const response of [() => new Response(null, { status: 302 }), () => new Response("x".repeat(140000), { headers: { "content-type": "application/json" } }), () => ok({ data: { image_urls: [`https://cdn.example.com/${key}`] } }), () => ok({ data: { image_urls: ["http://127.0.0.1/x"] } }), () => ok({ data: { image_urls: ["https://user:pass@cdn.example.com/x"] } }), () => ok({ data: { image_urls: [] } })]) {
    let calls = 0; const provider = new MiniMaxMediaProvider({ apiKey: key, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(provider.submit({ kind: "image", prompt: "x", aspectRatio: "1:1" }), (error) => { assert.equal(error.uncertain, true); assert.doesNotMatch(error.message, new RegExp(key)); return true; }); assert.equal(calls, 1);
  }
  const provider = new MiniMaxMediaProvider({ apiKey: key, fetchImpl: async () => ok({ task_id: "999", status: "Success", file_id: "123" }) });
  await assert.rejects(provider.poll("123"), /protocol/);
});

test("stale server epoch requires explicit review and does not silently recreate a lost job", async (t) => {
  const f = await fixture(t, () => assert.fail("Must not re-create paid job after restart")), token = await f.lease();
  assert.equal((await f.create(token, { instanceId: randomUUID() })).status, 409);
  assert.equal((await f.create(token, { instanceId: undefined })).status, 409);
});

test("transient video query failure preserves task identity and retries only reads after backoff", async (t) => {
  let submissions = 0, polls = 0;
  const f = await fixture(t, async (url, init) => {
    if (init.method === "POST") { submissions++; return ok({ task_id: "123" }); }
    assert.ok(url.endsWith("task_id=123")); polls++;
    if (polls === 1) throw new Error(key);
    return ok({ task_id: "123", status: "Fail" });
  });
  const token = await f.lease("video"), made = await f.create(token, { kind: "video" }); await f.settle();
  const query = () => f.post("/v1/media/job", token, { id: made.body.id });
  f.advance(10000); await query(); await f.settle();
  let job = (await query()).body; assert.equal(job.state, "running"); assert.equal(job.error, "media_provider_unavailable"); assert.equal(polls, 1);
  f.advance(10000); await query(); await f.settle();
  job = (await query()).body; assert.equal(job.state, "failed"); assert.equal(job.error, "media_provider_rejected"); assert.equal(submissions, 1); assert.equal(polls, 2);
});

test("one active job per owner blocks concurrent billing and shutdown aborts dispatched work", async (t) => {
  let calls = 0, aborted = 0;
  const f = await fixture(t, async (_url, init) => {
    calls++;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); }, { once: true }));
  });
  const token = await f.lease(); assert.equal((await f.create(token)).status, 202);
  assert.equal((await f.create(await f.lease("image", f.login({ deviceId: "device-2" })))).status, 429);
  assert.equal(calls, 1); await f.media.close(); assert.equal(aborted, 1); assert.equal(f.media.jobs.size, 0); assert.equal(f.media.pending.size, 0);
});

test("provider timeout remains ambiguous, never auto-retries and strips provider diagnostic bodies", async () => {
  let calls = 0;
  const provider = new MiniMaxMediaProvider({ apiKey: key, timeoutMs: 10, fetchImpl: async (_url, init) => {
    calls++; return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(key)), { once: true }));
  } });
  const hold = setTimeout(() => {}, 1000);
  try { await assert.rejects(provider.submit({ kind: "video", prompt: "Synthetic" }), (error) => error.uncertain && !error.message.includes(key)); }
  finally { clearTimeout(hold); }
  assert.equal(calls, 1);
  const rejected = new MiniMaxMediaProvider({ apiKey: key, fetchImpl: async () => Response.json({ base_resp: { status_code: 1008, status_msg: "private provider diagnostics" } }) });
  await assert.rejects(rejected.submit({ kind: "video", prompt: "Synthetic" }), (error) => error.code === "media_provider_rejected" && !error.uncertain && !error.message.includes("private"));
});

test("revocation while reading a slow request body prevents paid dispatch", async (t) => {
  const f = await fixture(t, () => assert.fail("Revoked request must not dispatch")), token = await f.lease();
  let verified; const entered = new Promise((resolve) => { verified = resolve; });
  const original = f.sessions.verify.bind(f.sessions);
  f.sessions.verify = (value) => { const result = original(value); if (value === token) verified(); return result; };
  const body = JSON.stringify({ kind: "image", prompt: "Synthetic", confirmed: true, idempotencyKey: randomUUID(), instanceId: f.media.instanceId });
  const req = httpRequest(f.origin + "/v1/media/jobs", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
  const response = once(req, "response"); req.write(body.slice(0, 10));
  await entered; f.sessions.revoke(f.parent.token); req.end(body.slice(10));
  const [res] = await response; const chunks = []; for await (const chunk of res) chunks.push(chunk);
  assert.equal(res.statusCode, 401); assert.equal(JSON.parse(Buffer.concat(chunks)).error.code, "session_expired_or_invalid"); assert.equal(f.media.jobs.size, 0);
});

test("development media is opt-in and its token still cannot call the text-model route", async (t) => {
  const f = await fixture(t, async () => ok({ data: { image_urls: ["https://cdn.example.com/a.png"] } }), { allowDevelopment: true });
  const parent = f.login({ authProvider: "development", appId: null, deviceProof: null }), token = await f.lease("image", parent);
  assert.equal((await f.create(token)).status, 202); await f.settle();
  assert.equal((await f.post("/v1/responses", token, { model: "MiniMax-M3", input: "x" })).status, 403);
});

test("lost-response lookup is read-only, owner/kind scoped and rejects an old server epoch", async (t) => {
  let calls = 0; const f = await fixture(t, async () => { calls++; return ok({ data: { image_urls: ["https://cdn.example.com/a.png"] } }); });
  const token = await f.lease(), idempotencyKey = randomUUID(), made = await f.create(token, { idempotencyKey }); await f.settle();
  const body = { idempotencyKey, instanceId: f.media.instanceId };
  assert.equal((await f.post("/v1/media/lookup", token, body)).body.id, made.body.id);
  const foreign = await f.lease("image", f.login({ userId: "foreign" })), video = await f.lease("video");
  assert.equal((await f.post("/v1/media/lookup", foreign, body)).status, 404);
  assert.equal((await f.post("/v1/media/lookup", video, body)).status, 404);
  assert.equal((await f.post("/v1/media/lookup", token, { ...body, instanceId: randomUUID() })).status, 409);
  assert.equal((await f.post("/v1/media/lookup", token, { ...body, idempotencyKey: randomUUID() })).status, 404);
  assert.equal(calls, 1);
});

// A server whose chat runs on LiteLLM and holds no MiniMax key mounts this
// stand-in. A 404 there reads on the desktop as "this control plane has no
// media service", which is wrong: media is on and needs a key.
test("without a MiniMax key every media route answers 503 with the reason, and nothing else is claimed", async (t) => {
  const { MEDIA_ROUTES, MEDIA_UNAVAILABLE, unconfiguredMedia } = await import("../src/control-plane/media-service.js");
  const sessions = new SessionRegistry();
  const server = createModelGateway({ sessions, apiKey: key, authHandler: (req, res) => unconfiguredMedia.handle(req, res), fetchImpl: () => assert.fail("No text model calls") });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.close(); server.closeAllConnections(); });
  const origin = `http://127.0.0.1:${server.address().port}`, token = sessions.issue({ tenantId: "tenant", userId: "user", deviceId: "device" }).token;
  assert.equal(MEDIA_ROUTES.length, 5);
  for (const route of MEDIA_ROUTES) {
    const response = await fetch(origin + route, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ kind: "image" }) });
    assert.equal(response.status, 503, route);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: { code: "media_provider_not_configured", message: MEDIA_UNAVAILABLE } });
  }
  assert.match(MEDIA_UNAVAILABLE, /MINIMAX_CONFIG_FILE.*MINIMAX_API_KEY/u, "names the settings that would fix it");
  // Everything else still reaches the gateway.
  assert.equal((await fetch(`${origin}/healthz`)).status, 200);
  assert.equal((await fetch(`${origin}/v1/media/other`, { method: "POST" })).status, 404);
});

test("the real media service answers every route the stand-in claims", async (t) => {
  const { MEDIA_ROUTES } = await import("../src/control-plane/media-service.js");
  const f = await fixture(t, () => assert.fail("No paid dispatch"));
  for (const route of MEDIA_ROUTES) assert.equal((await fetch(f.origin + route, { method: "POST" })).status, 401, route);
  assert.equal((await fetch(`${f.origin}/v1/media/other`, { method: "POST" })).status, 404);
});
