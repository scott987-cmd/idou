import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { flattenMcpTools, mcpResponseTransform } from "./mcp-tool-wire.js";
import { functionCallRepairTransform } from "./response-stream-repair.js";
import { messageCoalesceTransform } from "./message-coalesce.js";
import { responseNormalizeTransform } from "./response-normalize.js";
import { lastingFailure } from "./model-health.js";
import { MODEL_TURN } from "./sessions.js";
import { applyPatchCallTransform, patchCallRewriteApplies } from "./apply-patch-call.js";

const MINIMAX_UPSTREAMS = new Set(["https://api.minimaxi.com", "https://api.minimax.cn"]);
const REQUEST_FIELDS = new Set(["model", "input", "instructions", "max_output_tokens", "temperature", "top_p",
  "stream", "tools", "tool_choice", "reasoning", "text", "store", "service_tier", "parallel_tool_calls",
  "include", "prompt_cache_key", "truncation", "client_metadata"]);

// The only place a LiteLLM proxy may be: this machine's own loopback address,
// spelled as an IP with an explicit port. A host name can be re-pointed (even
// "localhost" is whatever the resolver says), and anything reachable over the
// network would receive the proxy key with every request. Returns the origin
// the gateway calls, or null.
export function loopbackOrigin(value) {
  const match = typeof value === "string" ? /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/.exec(value) : null;
  return match && Number(match[2]) <= 65535 ? `http://${match[1]}:${match[2]}` : null;
}

class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function sendError(res, status, code, requestId) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-request-id": requestId });
  res.end(JSON.stringify({ error: { code, message: code, request_id: requestId } }));
}

// A bounded prefix of a failed upstream answer, read only to classify it (see
// model-health.js) and then dropped: it may echo the prompt or the key.
async function boundedText(response, limit = 16 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (size < limit) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); size += value.length; }
  } catch { /* an unreadable body classifies as nothing */ } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

async function readJson(req, maxBytes) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new RequestError(415, "json_required");
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new RequestError(415, "compressed_body_not_supported");
  const chunks = [];
  let length = 0;
  // Do not let a failed async iterator destroy the request before the 413 reply.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBytes) throw new RequestError(413, "request_too_large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RequestError(400, "invalid_json"); }
}

function prepareRequest(body, { provider, model, upstreamModel }, session, maxOutputTokens) {
  if (!body || Array.isArray(body) || typeof body !== "object") throw new RequestError(400, "invalid_request");
  if (Object.keys(body).some((key) => !REQUEST_FIELDS.has(key))) throw new RequestError(400, "unsupported_request_field");
  if (body.model !== model) throw new RequestError(403, "model_not_allowed");
  if (typeof body.input !== "string" && !Array.isArray(body.input)) throw new RequestError(400, "input_required");
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw new RequestError(400, "invalid_stream");
  if (body.store !== undefined && body.store !== false) throw new RequestError(400, "response_storage_disabled");
  if (body.service_tier !== undefined && body.service_tier !== "standard") throw new RequestError(403, "service_tier_not_allowed");
  if (body.truncation !== undefined && body.truncation !== "disabled") throw new RequestError(400, "truncation_not_supported");
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((tool) => !tool || !["function", "namespace"].includes(tool.type)))) {
    throw new RequestError(400, "unsupported_tool_type");
  }
  const maxTokens = body.max_output_tokens ?? maxOutputTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > maxOutputTokens) throw new RequestError(400, "output_limit_exceeded");
  // Tenant-scoped cache routing: never forward a user-controlled cross-tenant key.
  const cacheKey = createHash("sha256").update(JSON.stringify([session.tenantId, session.userId, body.prompt_cache_key ?? session.id])).digest("hex");
  // Codex-local telemetry is not model context and is never sent upstream.
  const { client_metadata, ...request } = body;
  // The client names the product slug; the upstream is asked for the model it
  // actually serves under that slug. For MiniMax the two are the same name.
  const prepared = { ...request, model: upstreamModel, max_output_tokens: maxTokens, store: false, service_tier: "standard", prompt_cache_key: cacheKey };
  // "standard" is MiniMax's tier name. LiteLLM would hand it on to a provider
  // that has no such tier, so it is left out there; what a client may ask for
  // is still checked above either way.
  if (provider === "litellm") delete prepared.service_tier;
  return prepared;
}

// The events after which a Responses stream has nothing more to say.
const END_EVENTS = ["response.completed", "response.incomplete", "response.failed"];

// The last stage of a stream. It passes every byte on as it came and calls
// `onEnd` once a whole frame carrying the answer's terminal event has gone
// through: a client that hangs up after that point already has the answer.
// `onEnd` is handed the terminal event itself, so a caller that wants what it
// carries -- the usage this answer cost -- reads it here rather than parsing
// the stream a second time. It changes nothing on the way through.
// The same question for a reply that is not a stream: one JSON document, so it
// is accumulated and read at the end. Bounded by maxBodyBytes upstream, and it
// never changes a byte -- every chunk goes on as it arrived.
export function jsonUsageWatch(onDone) {
  const decoder = new StringDecoder("utf8");
  let whole = "", over = false;
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!over) {
        whole += decoder.write(chunk);
        // A reply this large is not one this needs to read; stop holding it.
        if (whole.length > 4_000_000) { over = true; whole = ""; }
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (!over) { try { onDone(JSON.parse(whole + decoder.end())); } catch { onDone(null); } }
      else onDone(null);
      callback();
    },
  });
}

export function responseEndWatch(onEnd) {
  const decoder = new StringDecoder("utf8");
  let pending = "", scanned = 0, ended = false;
  const terminal = frame => {
    if (!END_EVENTS.some(type => frame.includes(type))) return null; // Parse only a frame that names one.
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    try { const event = JSON.parse(data); return END_EVENTS.includes(event?.type) ? event : null; } catch { return null; }
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      if (!ended) {
        pending += decoder.write(chunk);
        // Resume three characters back so a "\r\n\r\n" split across chunks is still seen.
        const separator = /\r?\n\r?\n/g; separator.lastIndex = Math.max(0, scanned - 3);
        let start = 0, event = null;
        for (let match; !ended && (match = separator.exec(pending)); start = separator.lastIndex) {
          event = terminal(pending.slice(start, match.index));
          ended = Boolean(event);
        }
        pending = ended ? "" : pending.slice(start); scanned = pending.length;
        if (ended) onEnd(event);
      }
      callback(null, chunk);
    },
  });
}

// A session can now hold up to three agents at once -- the task's own and two
// subagents (gateway-config.js) -- and neither Codex nor the gateway retries, so a
// request over the limit fails that agent's turn outright. The per-session budget
// is therefore three times the single agent's old 30 a minute, and the overall
// ceiling leaves room for another task beside one busy task's three agents.
// Measured on GLM-5.3: one delegation took 4 requests with 2 at once, and steps
// came roughly 2.6 seconds apart.
export function createModelGateway({ models, apiKey, sessions, provider = "minimax", upstreamOrigin = "https://api.minimaxi.com",
  model = "MiniMax-M3", upstreamModel = model, fetchImpl = fetch, maxBodyBytes = 8 * 1024 * 1024,
  maxOutputTokens = 16384, maxConcurrent = 8, maxConcurrentPerUser = maxConcurrent, requestsPerMinute = 90, timeoutMs = 180_000, visibility = null, usage = null,
  audit = () => {}, authHandler = null, health = null }) {
  for (const [name, value] of [["maxConcurrent", maxConcurrent], ["maxConcurrentPerUser", maxConcurrentPerUser], ["requestsPerMinute", requestsPerMinute]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid model gateway ${name}`);
  }
  if (maxConcurrentPerUser > maxConcurrent) throw new Error("A person's share of the model gateway cannot exceed the whole");
  // One gateway can serve several chat models, each routed to its own upstream by
  // the slug the client asks for. A single flat config is still accepted (one
  // entry) so existing callers are unchanged; each entry keeps its own key.
  const entries = Array.isArray(models) && models.length ? models : [{ provider, upstreamOrigin, model, upstreamModel, apiKey, maxOutputTokens }];
  const routes = new Map();
  for (const raw of entries) {
    const entry = { provider: raw.provider ?? "minimax", upstreamOrigin: raw.upstreamOrigin ?? "https://api.minimaxi.com",
      model: raw.model, upstreamModel: raw.upstreamModel ?? raw.model, apiKey: raw.apiKey, maxOutputTokens: raw.maxOutputTokens ?? 16384 };
    if (typeof entry.apiKey !== "string" || !entry.apiKey.trim()) throw new Error("A server-held model API key is required");
    // Checked before anything can be sent: the key goes wherever this points.
    const approved = entry.provider === "minimax" ? MINIMAX_UPSTREAMS.has(entry.upstreamOrigin)
      : entry.provider === "litellm" && loopbackOrigin(entry.upstreamOrigin) === entry.upstreamOrigin;
    if (!approved) throw new Error("Only approved upstreams are allowed: domestic MiniMax, or a LiteLLM proxy on this machine's loopback");
    if (typeof entry.model !== "string" || !entry.model || typeof entry.upstreamModel !== "string" || !entry.upstreamModel) throw new Error("A model name is required");
    if (routes.has(entry.model)) throw new Error("Duplicate chat model");
    routes.set(entry.model, entry);
  }
  if (!sessions?.verify) throw new Error("Session verification is required");
  const defaultModel = entries[0].model;
  const buckets = new Map();
  // Requests in flight, for the whole server and for each person (tenant and
  // user, whichever of their sessions asked -- a scheduled run counts toward its
  // owner). A person's share is what keeps one busy account from holding every
  // slot the server has.
  let active = 0;
  const holding = new Map();
  const counters = { requests: 0, rejected: { perMinute: 0, server: 0, person: 0 } };
  // Expired rate buckets are dropped at most once a second. Dropping them on
  // every request walked every session's bucket each time.
  let swept = 0;
  const server = createServer(async (req, res) => {
    const requestId = randomUUID();
    const controller = new AbortController();
    // The client closing the connection cancels with its own reason. A provider or
    // stage failure also ends in "close" once the pipeline has torn the response
    // down, so only this reason says the client hung up first.
    const hangUp = new DOMException("The client closed the connection", "AbortError");
    let answered = false;
    const disconnect = () => { if (!res.writableFinished) controller.abort(hangUp); };
    res.on("close", disconnect);
    let timer;
    let acquired = false;
    let status = 500;
    let identity, served = null, asked = null, spent = null;
    try {
      // Every route on this server authenticates here or in authHandler. With
      // several replicas, a token this one did not issue is read from the shared
      // store first (sessions.js); every verify() after it stays local.
      const bearer = req.headers.authorization;
      if (sessions.ensure && typeof bearer === "string" && bearer.startsWith("Bearer ")) await sessions.ensure(bearer.slice(7));
      if (authHandler && await authHandler(req, res)) { status = res.statusCode; return; }
      // No browser-origin entry points: this service is called by the native client.
      if (req.headers.origin) throw new RequestError(403, "browser_origin_not_allowed");
      if (req.method === "GET" && req.url === "/healthz") {
        status = 200;
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        // The slug the desktop configures Codex with. Where the proxy is and which
        // of its model groups serves the slug stay on the server.
        res.end(JSON.stringify({ status: "ok", provider: routes.get(defaultModel).provider === "litellm" ? "litellm-loopback" : "minimax-cn", model: defaultModel, models: [...routes.keys()] }));
        return;
      }
      if (req.url !== "/v1/responses") throw new RequestError(404, "not_found");
      if (req.method !== "POST") throw new RequestError(405, "method_not_allowed");
      const auth = req.headers.authorization;
      // The session is all this route needs, so one read from the shared store
      // will do (sessions.js).
      identity = sessions.verify(typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : "", { shared: true });
      if (!identity) throw new RequestError(401, "session_expired_or_invalid");
      // A scheduled task's sandbox reaches the model under its own audience, not
      // the desktop's. Same scope, separate session id -- which is what keeps the
      // per-session rate limit below from letting an unattended task crowd out
      // the person's own conversation.
      if (!["codex-model-gateway", MODEL_TURN, "sandbox-run"].includes(identity.audience) || !identity.scopes.includes("models:responses")) throw new RequestError(403, "scope_required");
      const now = Date.now();
      if (now - swept >= 1000) { swept = now; for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key); }
      const existing = buckets.get(identity.id);
      const bucket = existing && existing.until > now ? existing : { count: 0, until: now + 60_000 };
      const person = `${identity.tenantId}\n${identity.userId}`, held = holding.get(person) ?? 0;
      counters.requests += 1;
      const refusal = bucket.count >= requestsPerMinute ? "perMinute" : active >= maxConcurrent ? "server" : held >= maxConcurrentPerUser ? "person" : null;
      if (refusal) { counters.rejected[refusal] += 1; throw new RequestError(429, "request_limit_reached"); }
      bucket.count += 1;
      buckets.set(identity.id, bucket);
      active += 1;
      holding.set(person, held + 1);
      acquired = person;
      timer = setTimeout(() => { controller.abort(); sendError(res, 504, "upstream_timeout", requestId); req.resume(); }, timeoutMs);
      const requestBody = await readJson(req, maxBodyBytes);
      // Route by the slug the client asked for; an unconfigured model is refused.
      asked = requestBody?.model;
      if (!routes.has(asked)) throw new RequestError(403, "model_not_allowed");
      // Which models this person may use. `model` above is a field the client
      // sends -- an agent in a sandbox can put anything in it -- so filtering
      // the list somebody is offered (model-choice.js) is only the visible half
      // of this. Refused with the same code as a model that is not configured:
      // an error should not teach anybody which models exist but are withheld.
      const allowed = visibility ? await visibility.visible(identity) : null;
      const permits = (model) => !allowed || allowed.includes(model);
      if (!permits(asked)) throw new RequestError(403, "model_not_allowed");
      // A model the upstream has stopped serving is passed over for the next in
      // the server's order (model-health.js); one that fails that way here is
      // marked and the request tried once on each other model that can answer.
      // Safe to repeat: nothing has been written to the client yet.
      const tried = new Set();
      let route, wire, body, response;
      // Falling over to another model when one stops answering must not fall
      // *into* a model this person may not use: model-health picks by health
      // alone, so each candidate is checked again here. Without this the
      // refusal above is only true while everything is working.
      let first = health ? health.route(asked) : asked;
      if (!permits(first)) first = allowed.find((model) => routes.has(model) && (!health || health.usable(model))) ?? null;
      if (!first) throw new RequestError(403, "model_not_allowed");
      for (let candidate = first; ;) {
        route = routes.get(candidate);
        tried.add(candidate);
        const prepared = prepareRequest({ ...requestBody, model: candidate }, { provider: route.provider, model: route.model, upstreamModel: route.upstreamModel }, identity, route.maxOutputTokens);
        try { wire = flattenMcpTools(prepared); } catch { throw new RequestError(400, "unsupported_tool_type"); }
        body = wire.body;
        controller.signal.throwIfAborted();
        response = await fetchImpl(`${route.upstreamOrigin}/v1/responses`, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${route.apiKey}`, "content-type": "application/json", accept: body.stream ? "text/event-stream" : "application/json" },
          body: JSON.stringify(body),
        });
        if (response.ok) { health?.succeed(candidate); served = candidate; break; }
        // Do not reflect provider errors, headers, keys, or echoed prompts to clients/logs.
        const lasting = health ? lastingFailure(response.status, await boundedText(response)) : null;
        if (!health) await response.body?.cancel();
        if (!lasting) throw new RequestError(response.status === 429 ? 429 : 502, response.status === 429 ? "provider_rate_limited" : "provider_request_failed");
        health.fail(candidate, lasting);
        candidate = health.next(tried);
        // Skip, rather than stop at, one this person may not use: another that
        // they may could still be behind it.
        while (candidate && !permits(candidate)) { tried.add(candidate); candidate = health.next(tried); }
        if (!candidate) throw new RequestError(502, "provider_request_failed");
      }
      const contentType = response.headers.get("content-type")?.split(";")[0];
      const expected = body.stream ? "text/event-stream" : "application/json";
      if (contentType !== expected || !response.body) {
        await response.body?.cancel();
        throw new RequestError(502, "provider_protocol_error");
      }
      status = 200;
      res.writeHead(200, { "content-type": expected, "cache-control": "no-store", "x-request-id": requestId, "x-accel-buffering": "no",
        "x-idou-model": served, ...(served !== asked ? { "x-idou-model-requested": asked } : {}) });
      // The repair sees the provider's own stream first; LiteLLM's answers are then
      // put back in the client's terms; MCP names are restored last. The MiniMax
      // route has nothing to normalise and stays exactly as it was. The end watch
      // changes nothing and comes after them all, so it sees what the client is sent.
      // An answer the provider splits into many messages is joined back into one
      // (message-coalesce.js); Codex takes each message as an answer of its own.
      const transforms = [...(body.stream ? [functionCallRepairTransform(), messageCoalesceTransform()] : []),
        ...(route.provider === "litellm" ? [responseNormalizeTransform({ model: route.model, streaming: Boolean(body.stream) })] : []),
        // A patch called for as a tool the request did not offer becomes the
        // exec_command Codex takes as a patch (apply-patch-call.js).
        ...(body.stream && patchCallRewriteApplies(requestBody.tools) ? [applyPatchCallTransform()] : []),
        ...(wire.aliases.size ? [mcpResponseTransform(wire.aliases, body.stream)] : []),
        // What this answer cost, taken from the terminal event on the way past.
        // Nothing is refused or downgraded on it in this release -- the numbers
        // are new, and a limit enforced from numbers nobody has checked stops
        // the wrong people (docs/server-administration.md §6.3).
        ...(body.stream
          ? [responseEndWatch((event) => { answered = true; spent = event?.response?.usage ?? null; })]
          : [jsonUsageWatch((document) => { spent = document?.usage ?? document?.response?.usage ?? null; })])];
      await pipeline(Readable.fromWeb(response.body), ...transforms, res, { signal: controller.signal });
    } catch (error) {
      // Codex hangs up as soon as it has read the terminal event, which can be
      // before the provider's closing "[DONE]" and end of body. When that hang-up
      // is what failed the stream, the client had the whole answer: a success,
      // though the upstream is still cancelled.
      if (answered && error?.cause === hangUp) {
        status = 200;
      } else {
        status = error instanceof RequestError ? error.status : (controller.signal.aborted ? 504 : 502);
        sendError(res, status, error instanceof RequestError ? error.code : (controller.signal.aborted ? "request_cancelled" : "provider_unavailable"), requestId);
      }
      req.resume();
    } finally {
      clearTimeout(timer);
      res.off("close", disconnect);
      if (acquired) {
        active -= 1;
        const left = (holding.get(acquired) ?? 1) - 1;
        if (left > 0) holding.set(acquired, left); else holding.delete(acquired);
      }
      // Metadata only. Audit failures must not cause unhandled HTTP rejections.
      try { await audit({ requestId, sessionId: identity?.id, status, ...(served ? { model: served } : {}), ...(served && served !== asked ? { requested: asked } : {}) }); } catch {}
      // Counted only when a provider actually answered: a refused request cost
      // nothing, and counting it would overstate everybody.
      if (usage && served && status === 200 && identity?.tenantId && identity?.userId) {
        try { usage.record({ who: identity, model: served, usage: spent, downgraded: served !== asked }); }
        catch (error) { process.stderr.write(`${JSON.stringify({ component: "model-usage", event: "record-failed", message: String(error?.message ?? error).slice(0, 200) })}\n`); }
      }
    }
  });
  server.requestTimeout = Math.min(timeoutMs, 60_000);
  server.headersTimeout = Math.min(timeoutMs, 15_000);
  // What the metrics listener reports (bin/server.js): how full the gateway is
  // and how often it said no, and why.
  server.capacity = () => ({ active, maxConcurrent, maxConcurrentPerUser, requestsPerMinute, people: holding.size, sessions: buckets.size,
    requests: counters.requests, rejected: { ...counters.rejected } });
  return server;
}
