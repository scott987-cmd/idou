import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { MediaProviderError } from "./minimax-media.js";

const DAY = 86400000, HOUR = 3600000;
const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
class MediaRequestError extends Error { constructor(status, code) { super(code); this.status = status; } }
function exact(body, fields) { if (!plain(body) || Object.keys(body).some((key) => !fields.includes(key))) throw new MediaRequestError(400, "invalid_media_request"); }
function inputRequest(body) {
  // 语音合成是同步的、按字数计费的，不带比例参数，另走一条更紧的校验。
  if (body?.kind === "speech") {
    exact(body, ["kind", "prompt", "voice", "speed", "idempotencyKey", "instanceId", "confirmed", "model"]);
    if (!uuid(body.idempotencyKey) || body.confirmed !== true || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 5000) throw new MediaRequestError(400, "invalid_media_request");
    if (typeof body.voice !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.voice)) throw new MediaRequestError(400, "invalid_media_request");
    if (typeof body.speed !== "number" || !Number.isFinite(body.speed) || body.speed < 0.5 || body.speed > 2) throw new MediaRequestError(400, "invalid_media_request");
    return { kind: "speech", prompt: body.prompt, voice: body.voice, speed: body.speed };
  }
  exact(body, ["kind", "prompt", "aspectRatio", "idempotencyKey", "instanceId", "confirmed", "model"]);
  if (!["image", "video"].includes(body.kind) || !uuid(body.idempotencyKey) || body.confirmed !== true || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > (body.kind === "image" ? 1500 : 2000)) throw new MediaRequestError(400, "invalid_media_request");
  const aspectRatio = body.aspectRatio ?? "1:1";
  if ((body.kind === "video" && body.aspectRatio !== undefined) || !["1:1", "16:9", "4:3", "3:2", "2:3", "3:4", "9:16", "21:9"].includes(aspectRatio)) throw new MediaRequestError(400, "invalid_media_request");
  return { kind: body.kind, prompt: body.prompt, ...(body.kind === "image" ? { aspectRatio } : {}) };
}
async function json(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json" || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) throw new MediaRequestError(415, "json_required");
  const chunks = []; let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > 16384) throw new MediaRequestError(413, "media_request_too_large"); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new MediaRequestError(400, "invalid_json"); }
}
function send(res, status, body) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); }

// Every route this service answers. The stand-in below claims exactly these, so
// a route added here cannot fall through to a 404 on a server without a key.
export const MEDIA_ROUTES = Object.freeze(["/auth/media-token", "/v1/media/jobs", "/v1/media/job", "/v1/media/cancel", "/v1/media/lookup"]);

// Image and speech stay on MiniMax whichever chat model runs; video goes to
// Qwen when a Token Plan key is configured (server-config.js loadVideoKey), and
// to MiniMax otherwise. With LiteLLM for chat and no media key at all there is
// nothing to generate with, so the media routes say that plainly -- rather than
// the 404 the desktop reads as "media is not enabled", which it is.
export const MEDIA_UNAVAILABLE = "图片与视频不可用：服务端没有配置 MiniMax 密钥（MINIMAX_CONFIG_FILE 或 MINIMAX_API_KEY）。对话模型不受影响。";
export const unconfiguredMedia = Object.freeze({
  async handle(req, res) {
    if (!MEDIA_ROUTES.includes(req.url)) return false;
    req.resume();
    send(res, 503, { error: { code: "media_provider_not_configured", message: MEDIA_UNAVAILABLE } });
    return true;
  },
  async close() {},
});

// What a client shows when it predates offers: it names these models on its
// confirmation card whatever the server says. Such a client is served only
// while these are what it would get.
const LEGACY_MODELS = Object.freeze({ image: "image-01", video: "MiniMax-Hailuo-2.3", speech: "speech-02-hd" });

export class MediaService {
  // `provider` makes every kind; `providers` names another for a kind (video on
  // Qwen). A kind with neither is answered as not configured.
  // `capacity`: generations under way on the whole server (the pilot's four),
  // and the hourly spend caps for the whole server, which stay the pilot's
  // unless an operator raises them -- they are money, not machine.
  constructor({ sessions, provider = null, providers = {}, allowDevelopment = false, now = Date.now, audit = () => {}, capacity: { running = 4, perHour = 20, speechPerHour = 400 } = {} }) {
    if (![running, perHour, speechPerHour].every((value) => Number.isSafeInteger(value) && value >= 1)) throw new Error("Invalid media capacity");
    this.capacity = Object.freeze({ running, perHour, speechPerHour });
    Object.assign(this, { sessions, allowDevelopment, now, audit });
    this.providers = { image: provider, video: provider, speech: provider, ...providers };
    this.jobs = new Map(); this.pending = new Set(); this.salt = randomBytes(32); this.instanceId = randomUUID(); this.closed = false;
    this.timer = setInterval(() => this.prune(), 60000); this.timer.unref();
  }
  hash(value) { return createHmac("sha256", this.salt).update(JSON.stringify(value)).digest("hex"); }
  providerFor(kind) {
    const provider = this.providers[kind];
    if (!provider) throw new MediaRequestError(503, "media_provider_not_configured");
    return provider;
  }
  owner(session) { return this.hash([session.authProvider, session.tenantId, session.appId, session.userId]); }
  prune() {
    const now = this.now();
    for (const [key, job] of this.jobs) {
      if ((job.state === "running" && now >= job.createdAt + HOUR) || (job.state === "awaiting_acceptance" && now >= job.resultExpiresAt)) {
        job.controller.abort(); job.state = "expired"; delete job.url; delete job.audio;
      }
      if (now >= job.createdAt + DAY) { job.controller.abort(); this.jobs.delete(key); }
    }
  }
  snapshot(job) {
    return { id: job.id, kind: job.kind, model: job.model, state: job.state,
      createdAt: job.createdAt, expiresAt: job.createdAt + DAY, retryAfterMs: job.state === "running" ? Math.max(0, job.nextPollAt - this.now()) : null,
      error: job.error ?? null, persisted: false, providerMayContinue: ["canceled", "submission_unknown", "expired"].includes(job.state),
      // 语音是同步返回的字节，没有可轮询的任务，也没有可下载的地址：
      // 音频随结果一次性带回，控制面不留副本。
      ...(job.state === "awaiting_acceptance"
        ? { result: job.kind === "speech"
            ? { audio: job.audio, encoding: "hex", format: "mp3", bytes: job.audio.length / 2, expiresAt: job.resultExpiresAt }
            : { url: job.url, bytes: job.bytes ?? null, expiresAt: job.resultExpiresAt } }
        : {}) };
  }
  background(job, work, submitting) {
    const promise = (async () => {
      try {
        const { detail, ...value } = await work();
        this.prune();
        if (this.closed || job.state !== "running" || !this.jobs.has(job.id)) return;
        Object.assign(job, value); delete job.error;
        if (value.error) job.error = value.error;
        if (value.state === "awaiting_acceptance") job.resultExpiresAt = this.now() + HOUR;
        // A provider that says the work failed is the one place the reason can
        // be found afterwards, so it is recorded like a failed call is.
        if (value.state === "failed") this.audit({ event: "media-failed", job: job.id, kind: job.kind, code: job.error ?? null, ...(detail ? { providerCode: detail } : {}) });
      } catch (error) {
        if (this.closed || job.state !== "running") return;
        job.error = error instanceof MediaProviderError ? error.code : "media_provider_unavailable";
        if (submitting) job.state = error instanceof MediaProviderError && !error.uncertain ? "failed" : "submission_unknown";
        // The provider said the work is done and what it handed over cannot be
        // used: asking again gets the same answer, so the job ends here rather
        // than being asked about every ten seconds until it expires.
        else if (job.error === "invalid_media_result") job.state = "failed";
        // Only the job, its kind and the codes: nothing of the provider's answer.
        this.audit({ event: submitting ? "media-submit-failed" : "media-poll-failed", job: job.id, kind: job.kind, code: job.error, state: job.state,
          ...(error instanceof MediaProviderError && error.detail ? { providerCode: error.detail } : {}) });
      } finally { job.busy = false; job.nextPollAt = this.now() + 10000; }
    })();
    this.pending.add(promise); void promise.finally(() => this.pending.delete(promise));
  }
  async handle(req, res) {
    if (!MEDIA_ROUTES.includes(req.url)) return false;
    try {
      if (this.closed) throw new MediaRequestError(503, "media_service_closed");
      if (req.headers.origin) throw new MediaRequestError(403, "browser_origin_not_allowed");
      if (req.method !== "POST") throw new MediaRequestError(405, "method_not_allowed");
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      const identity = this.sessions.verify(token);
      if (!identity) throw new MediaRequestError(401, "session_expired_or_invalid");
      if (identity.authProvider !== "feishu" && !this.allowDevelopment) throw new MediaRequestError(403, "verified_login_required");
      const body = await json(req);
      // Revalidate after the body await; revoked credentials cannot enqueue paid work.
      if (!this.sessions.verify(token)) throw new MediaRequestError(401, "session_expired_or_invalid");
      if (req.url === "/auth/media-token") {
        exact(body, ["kind"]);
        if (identity.audience !== "codex-model-gateway" || !["image", "video", "speech"].includes(body.kind)) throw new MediaRequestError(403, "media_scope_required");
        // What would make it, said before anything is made: the card the person
        // confirms is built from this, and the job must name the same model.
        const offer = this.providerFor(body.kind).offer(body.kind);
        const child = this.sessions.issueForMedia(token, body.kind);
        send(res, 200, { token: child.token, expiresAt: child.expiresAt, audience: child.audience, kind: child.kind, instanceId: this.instanceId, offer,
          owner: { authProvider: identity.authProvider, tenantId: identity.tenantId, appId: identity.appId, userId: identity.userId } }); return true;
      }
      if (identity.audience !== "media-service") throw new MediaRequestError(403, "media_scope_required");
      const scope = req.url === "/v1/media/jobs" ? "media:generate" : req.url === "/v1/media/cancel" ? "media:cancel" : "media:read";
      if (!identity.scopes.includes(scope)) throw new MediaRequestError(403, "media_scope_required");
      this.prune(); const owner = this.owner(identity);
      if (req.url === "/v1/media/jobs") {
        const input = inputRequest(body);
        // In-memory deduplication cannot survive restart. Clients retain this epoch
        // with the original submission and must not replace it when retrying.
        if (body.instanceId !== this.instanceId) throw new MediaRequestError(409, "media_server_restarted_review_required");
        if (input.kind !== identity.kind) throw new MediaRequestError(403, "media_kind_not_allowed");
        // The prompt goes to whichever provider the confirmation card named. A
        // job naming another model -- or a client too old to name one, shown
        // MiniMax's while this server would use Qwen's -- was not agreed to.
        const provider = this.providerFor(input.kind), { model } = provider.offer(input.kind);
        if (body.model !== undefined && (typeof body.model !== "string" || body.model.length > 64)) throw new MediaRequestError(400, "invalid_media_request");
        if ((body.model ?? LEGACY_MODELS[input.kind]) !== model) throw new MediaRequestError(409, "media_model_changed");
        const key = this.hash([owner, body.idempotencyKey]), digest = this.hash(input);
        const prior = [...this.jobs.values()].find((job) => job.key === key);
        if (prior) {
          if (prior.digest !== digest) throw new MediaRequestError(409, "media_idempotency_conflict");
          send(res, 200, this.snapshot(prior)); return true;
        }
        const jobs = [...this.jobs.values()], recent = jobs.filter((job) => job.createdAt > this.now() - HOUR);
        // 这些额度是为图片和视频设的：一次生成几毛到几块，跑飞了要出事。
        // 语音是按字数计费的短请求，一段旁白天然就是几十句，用同一个 4 次/小时
        // 的闸门会让正常用法第五句就被拦下。所以按类型分开算。
        const perOwner = input.kind === "speech" ? 200 : 4;
        const perHour = input.kind === "speech" ? this.capacity.speechPerHour : this.capacity.perHour;
        const sameKind = recent.filter((job) => job.kind === input.kind);
        if (jobs.length >= 20_000 || sameKind.length >= perHour || sameKind.filter((job) => job.owner === owner).length >= perOwner
            || jobs.filter((job) => job.state === "running").length >= this.capacity.running
            || jobs.some((job) => job.owner === owner && job.kind === input.kind && job.state === "running")
            || this.pending.size >= this.capacity.running) throw new MediaRequestError(429, "media_budget_limit");
        const job = { id: randomUUID(), key, digest, owner, kind: input.kind, model, createdAt: this.now(), state: "running", nextPollAt: this.now() + 10000, busy: true, controller: new AbortController() };
        this.jobs.set(job.id, job);
        this.background(job, () => provider.submit(input, job.controller.signal), true);
        send(res, 202, this.snapshot(job)); return true;
      }
      let job;
      if (req.url === "/v1/media/lookup") {
        exact(body, ["idempotencyKey", "instanceId"]);
        if (!uuid(body.idempotencyKey) || body.instanceId !== this.instanceId) throw new MediaRequestError(409, "media_server_restarted_review_required");
        const key = this.hash([owner, body.idempotencyKey]); job = [...this.jobs.values()].find((item) => item.key === key);
      } else { exact(body, ["id"]); if (!uuid(body.id)) throw new MediaRequestError(400, "invalid_media_request"); job = this.jobs.get(body.id); }
      if (!job || job.owner !== owner || job.kind !== identity.kind) throw new MediaRequestError(404, "media_job_not_found");
      if (req.url === "/v1/media/cancel") {
        if (["running", "awaiting_acceptance"].includes(job.state)) { job.state = "canceled"; delete job.url; delete job.audio; job.controller.abort(); }
      } else if (job.state === "running" && job.taskId && !job.busy && this.now() >= job.nextPollAt && this.pending.size < 4) {
        job.busy = true; this.background(job, () => this.providerFor(job.kind).poll(job.taskId, job.controller.signal), false);
      }
      send(res, 200, this.snapshot(job)); return true;
    } catch (error) {
      send(res, error instanceof MediaRequestError ? error.status : 502, { error: { code: error instanceof MediaRequestError ? error.message : "media_service_unavailable" } }); req.resume(); return true;
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); for (const job of this.jobs.values()) job.controller.abort(); await Promise.allSettled([...this.pending]); this.jobs.clear(); }
}
