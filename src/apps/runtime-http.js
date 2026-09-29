import { validateServerUrl } from "../control-plane/client-session.js";

export async function runtimeRequest(serverUrl, token, route, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${validateServerUrl(serverUrl)}${route}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") { await response.body?.cancel(); throw new Error(`Runtime authorization unavailable (HTTP ${response.status}); no automatic retry`); }
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 65536) { await reader.cancel(); throw new Error("Runtime authorization response too large"); } chunks.push(Buffer.from(value)); } }
  finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks));
}
