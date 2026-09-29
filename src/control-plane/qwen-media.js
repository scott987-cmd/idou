// Video generation on Alibaba Cloud Model Studio's Token Plan: Qwen's
// HappyHorse text-to-video. Same contract as MiniMaxMediaProvider -- submit()
// answers { state: "running", taskId }, poll() answers running, failed, or the
// finished video's address -- so the media service treats the two alike.
//
// Nothing of a request or an answer is kept: no prompt, no bytes, no key. The
// finished task's answer repeats the whole prompt back (orig_prompt); it is
// parsed for its status and its address and dropped with the rest.
//
// The Token Plan is for interactive use, not a background or batch queue. That
// holds here because every video is submitted only after the person clicked a
// confirmation card for it, and the service caps how many run at once.
import { MediaProviderError, mediaResultUrl } from "./minimax-media.js";

const ORIGIN = "https://token-plan.cn-beijing.maas.aliyuncs.com";
const SUBMIT = "/api/v1/services/aigc/video-generation/video-synthesis";
// Task ids are UUIDs (7aa368f2-e474-40da-9f0d-7fb6118b6eb5, 2026-09-23).
const TASK = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The provider's own short error code -- InvalidApiKey, Throttling -- which is
// safe to log. Its message is not: it can quote the request back.
const providerCode = (value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value) ? value : null;

export class QwenVideoProvider {
  constructor({ apiKey, fetchImpl = fetch, timeoutMs = 60000, model = "happyhorse-1.1-t2v", seconds = 6, resolution = "1080P", aspectRatio = "16:9" }) {
    // A Token Plan key and nothing else: a pay-as-you-go DashScope key (sk-…)
    // is refused by this endpoint, and would bill a different account.
    if (typeof apiKey !== "string" || !/^sk-sp-[\x21-\x7e]{8,4000}$/.test(apiKey)) throw new Error("Qwen Token Plan key required (sk-sp-…)");
    if (!/^happyhorse-[0-9.]+-t2v$/.test(model) || !Number.isInteger(seconds) || seconds < 3 || seconds > 15
        || !["480P", "720P", "1080P"].includes(resolution) || !["16:9", "9:16", "1:1", "4:3", "3:4"].includes(aspectRatio)) throw new Error("Unsupported HappyHorse video settings");
    Object.assign(this, { apiKey, fetch: fetchImpl, timeoutMs, model, seconds, resolution, aspectRatio });
  }
  // What the person is shown and asked to confirm before a video is made.
  offer(kind) {
    if (kind !== "video") return null;
    return { provider: "qwen", model: this.model, seconds: this.seconds, resolution: this.resolution, aspectRatio: this.aspectRatio };
  }
  async request(route, body, signal) {
    const submitting = body !== undefined;
    let response;
    try {
      response = await this.fetch(`${ORIGIN}${route}`, {
        method: submitting ? "POST" : "GET", redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json",
          ...(submitting ? { "content-type": "application/json", "x-dashscope-async": "enable" } : {}) },
        ...(submitting ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // A lost POST response does not prove the provider did not create the task.
      throw new MediaProviderError("media_provider_unavailable", submitting);
    }
    let value;
    try {
      if (!response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new MediaProviderError("media_provider_unavailable", submitting);
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        while (true) {
          const { value: chunk, done } = await reader.read(); if (done) break;
          length += chunk.length;
          if (length > 128 * 1024) { await reader.cancel(); throw new MediaProviderError("media_provider_response_too_large", submitting); }
          chunks.push(Buffer.from(chunk));
        }
      } finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.includes(this.apiKey)) throw new MediaProviderError("invalid_media_result", submitting);
      value = JSON.parse(raw);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      if (error instanceof MediaProviderError) throw error;
      throw new MediaProviderError("media_provider_protocol_error", submitting);
    }
    const code = providerCode(value?.code);
    // A 4xx with the provider's own code is a refusal before anything was made
    // (401 InvalidApiKey, 400 InvalidParameter, 429 Throttling): certain, and
    // not worth asking again. Anything else from a failed response is not known.
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && code) throw new MediaProviderError("media_provider_rejected", false, code);
      throw new MediaProviderError("media_provider_unavailable", submitting, code);
    }
    if (code && !value.output) throw new MediaProviderError("media_provider_rejected", false, code);
    if (!value || typeof value.output !== "object" || value.output === null) throw new MediaProviderError("media_provider_protocol_error", submitting);
    return value.output;
  }
  // Two things the API reference says that this relies on (2026-09-23): the
  // watermark is on unless asked off -- videos have never carried a visible
  // mark here -- and a description past 2,500 Chinese characters is cut short
  // without a word. The service's 2,000-character cap keeps it whole; raising
  // that cap means checking this again.
  async submit(input, signal) {
    if (input.kind !== "video") throw new MediaProviderError("media_provider_protocol_error");
    const output = await this.request(SUBMIT, { model: this.model, input: { prompt: input.prompt },
      parameters: { resolution: this.resolution, duration: this.seconds, watermark: false, ratio: this.aspectRatio } }, signal);
    if (!TASK.test(output.task_id) || !["PENDING", "RUNNING"].includes(output.task_status)) throw new MediaProviderError("media_provider_protocol_error", true);
    return { state: "running", taskId: output.task_id };
  }
  async poll(taskId, signal) {
    if (!TASK.test(taskId)) throw new MediaProviderError("invalid_media_task");
    const output = await this.request(`/api/v1/tasks/${taskId}`, undefined, signal);
    if (output.task_id !== taskId) throw new MediaProviderError("media_provider_protocol_error");
    if (["PENDING", "RUNNING"].includes(output.task_status)) return { state: "running" };
    // The size is not reported; the desktop checks the bytes when it fetches them.
    if (output.task_status === "SUCCEEDED") return { state: "awaiting_acceptance", url: mediaResultUrl(output.video_url), bytes: null };
    if (["FAILED", "CANCELED"].includes(output.task_status)) return { state: "failed", error: "media_provider_rejected", detail: providerCode(output.code) };
    // What the provider says for a task it does not have: a wrong id, or one
    // past its 24 hours. Asking again cannot change that answer.
    if (output.task_status === "UNKNOWN") return { state: "failed", error: "media_task_unknown" };
    throw new MediaProviderError("media_provider_protocol_error");
  }
}
