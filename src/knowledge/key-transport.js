import { WikiCoordinatorClient } from "./coordinator-client.js";

// Shared native-only transport for responses containing package keys. Never
// exposes an upstream error body; clears owned byte buffers after JSON parsing.
export class WikiKeyTransport extends WikiCoordinatorClient {
  constructor({ businessAccess, ...options }) {
    super(options); if (typeof businessAccess !== "function") throw new Error("Native Wiki business authorization is required"); this.businessAccess = businessAccess;
  }
  async keyRequest(session, action, body, signal, namespace = "keys") {
    if (!["keys", "scopes"].includes(namespace)) throw new Error("Invalid Wiki grant namespace");
    const combined = AbortSignal.any([AbortSignal.timeout(namespace === "keys" && action === "acquire" ? 130000 : 15000), ...(signal ? [signal] : [])]);
    let response, reader, cancel, bytes; const chunks = [];
    try {
      combined.throwIfAborted(); this.businessAccess(); await this.unchanged(session);
      response = await this.fetch(`${session.serverUrl}/v1/wiki/${namespace}/${action}`, { method: "POST", redirect: "error", signal: combined,
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      if (response.status !== 200 || response.redirected || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error();
      reader = response.body.getReader(); let size = 0;
      cancel = () => { void reader.cancel().catch(() => {}); }; combined.addEventListener("abort", cancel, { once: true });
      while (true) {
        combined.throwIfAborted(); const part = await reader.read(); combined.throwIfAborted(); if (part.done) break;
        size += part.value.byteLength; if (size > 8192) throw new Error(); chunks.push(Buffer.from(part.value));
      }
      await this.unchanged(session); this.businessAccess(); combined.throwIfAborted();
      bytes = Buffer.concat(chunks); return JSON.parse(bytes.toString("utf8"));
    } catch { throw new Error("知识密钥请求失败或已取消；未自动重试。"); }
    finally {
      for (const chunk of chunks) chunk.fill(0); bytes?.fill(0);
      if (cancel) combined.removeEventListener("abort", cancel);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } else await response?.body?.cancel().catch(() => {});
    }
  }
}
