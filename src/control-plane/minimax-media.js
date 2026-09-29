// Provider protocol boundary. No media bytes, prompts or credentials are written to disk.
// `detail` is the provider's own short code for a refusal (MiniMax's numeric
// status, Qwen's InvalidApiKey), for the server log: which of "no quota left",
// "bad key" and "content refused" it was is otherwise lost behind one code.
export class MediaProviderError extends Error {
  constructor(code, uncertain = false, detail = null) { super(code); this.code = code; this.uncertain = uncertain; this.detail = detail; }
}

const identifier = (value) => typeof value === "string" && /^[0-9]{1,40}$/.test(value);
export function mediaResultUrl(value) {
  let url; try { url = new URL(value); } catch { throw new MediaProviderError("invalid_media_result"); }
  // This is an output reference, never a credential-bearing server fetch target.
  if (typeof value !== "string" || value.length > 8192 || url.protocol !== "https:" || url.username || url.password || url.hash || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname) || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) throw new MediaProviderError("invalid_media_result");
  return url.href;
}

export class MiniMaxMediaProvider {
  constructor({ apiKey, upstreamOrigin = "https://api.minimaxi.com", fetchImpl = fetch, timeoutMs = 180000 }) {
    if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("Server media credential required");
    if (!["https://api.minimaxi.com", "https://api.minimax.cn"].includes(upstreamOrigin)) throw new Error("Only domestic MiniMax media origins allowed");
    Object.assign(this, { apiKey, upstreamOrigin, fetch: fetchImpl, timeoutMs });
  }
  // What the person is shown and asked to confirm before anything is made.
  offer(kind) {
    if (kind === "image") return { provider: "minimax", model: "image-01" };
    if (kind === "speech") return { provider: "minimax", model: "speech-02-hd" };
    return { provider: "minimax", model: "MiniMax-Hailuo-2.3", seconds: 6, resolution: "768P" };
  }
  async request(route, body, signal) {
    const submitting = body !== undefined;
    try {
      const response = await this.fetch(`${this.upstreamOrigin}${route}`, {
        method: submitting ? "POST" : "GET", redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "application/json" },
        ...(submitting ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
        await response.body?.cancel(); throw new MediaProviderError("media_provider_unavailable", submitting);
      }
      // 图片和视频的响应只有几个链接，128 KB 绰绰有余；语音是把音频本身
      // 用十六进制放在 JSON 里回来的，体积是音频的两倍，另给一个上限。
      const limit = route === "/v1/t2a_v2" ? 2 * 20 * 1024 * 1024 + 4096 : 128 * 1024;
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          length += value.length;
          if (length > limit) { await reader.cancel(); throw new MediaProviderError("media_provider_response_too_large", submitting); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.includes(this.apiKey)) throw new MediaProviderError("invalid_media_result", submitting);
      const result = JSON.parse(raw);
      if (!Number.isInteger(result?.base_resp?.status_code)) throw new MediaProviderError("media_provider_protocol_error", submitting);
      if (result.base_resp.status_code !== 0) throw new MediaProviderError("media_provider_rejected", false, String(result.base_resp.status_code));
      return result;
    } catch (error) {
      if (error instanceof MediaProviderError) throw error;
      // A lost POST response does not prove the provider did not charge/create a job.
      throw new MediaProviderError("media_provider_unavailable", submitting);
    }
  }
  async submit(input, signal) {
    if (input.kind === "speech") {
      // Text-to-audio comes back inline as hex-encoded mp3 rather than as a URL,
      // so unlike an image or a video there is nothing to poll and nothing to
      // fetch afterwards. The bytes pass straight through to the caller; the
      // control plane keeps none of them.
      const value = await this.request("/v1/t2a_v2", { model: "speech-02-hd", text: input.prompt, stream: false,
        voice_setting: { voice_id: input.voice, speed: input.speed, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 } }, signal);
      const audio = value?.data?.audio;
      if (typeof audio !== "string" || !/^[0-9a-fA-F]+$/.test(audio) || audio.length < 2 || audio.length % 2 ||
          audio.length > 2 * 20 * 1024 * 1024) throw new MediaProviderError("invalid_media_result");
      return { state: "awaiting_acceptance", audio: audio.toLowerCase() };
    }
    if (input.kind === "image") {
      const value = await this.request("/v1/image_generation", { model: "image-01", prompt: input.prompt, aspect_ratio: input.aspectRatio,
        n: 1, response_format: "url", prompt_optimizer: false, aigc_watermark: true }, signal);
      try {
        if (!Array.isArray(value.data?.image_urls) || value.data.image_urls.length !== 1) throw new Error();
        return { state: "awaiting_acceptance", url: mediaResultUrl(value.data.image_urls[0]) };
      } catch { throw new MediaProviderError("invalid_media_result", true); }
    }
    const value = await this.request("/v1/video_generation", { model: "MiniMax-Hailuo-2.3", prompt: input.prompt,
      duration: 6, resolution: "768P", prompt_optimizer: false }, signal);
    if (!identifier(value.task_id)) throw new MediaProviderError("media_provider_protocol_error", true);
    return { state: "running", taskId: value.task_id };
  }
  async poll(taskId, signal) {
    if (!identifier(taskId)) throw new MediaProviderError("invalid_media_task");
    const value = await this.request(`/v1/query/video_generation?task_id=${taskId}`, undefined, signal);
    if (value.task_id !== taskId) throw new MediaProviderError("media_provider_protocol_error");
    if (["Preparing", "Queueing", "Processing"].includes(value.status)) return { state: "running" };
    if (value.status === "Fail") return { state: "failed", error: "media_provider_rejected" };
    if (value.status !== "Success" || !identifier(value.file_id)) throw new MediaProviderError("media_provider_protocol_error");
    const result = await this.request(`/v1/files/retrieve?file_id=${value.file_id}`, undefined, signal), file = result.file;
    // MiniMax gives a finished video's size as 0 -- every video file on the
    // account, 2026-09-23 -- with the file id as a number. Requiring a size of
    // at least one byte turned every finished video into invalid_media_result,
    // on every poll, until the job expired an hour later; the tests had only
    // ever seen made-up answers with a size. Zero is "not known": the desktop
    // checks the bytes themselves when it fetches the file (media-download.js).
    if (String(file?.file_id) !== value.file_id || file?.purpose !== "video_generation" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 100 * 1024 * 1024) throw new MediaProviderError("invalid_media_result");
    return { state: "awaiting_acceptance", url: mediaResultUrl(file.download_url), bytes: file.bytes > 0 ? file.bytes : null };
  }
}
