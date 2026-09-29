import { validateServerUrl } from "../../control-plane/client-session.js";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, chatModelLabel, chatModelSeesImages, chatModelVendor, isChatModel } from "./chat-models.js";

const json = response => response.headers.get("content-type")?.split(";")[0].trim() === "application/json" && Boolean(response.body);
async function smallJson(response, limit = 4096) {
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > limit) { await reader.cancel(); throw new Error(); } chunks.push(Buffer.from(value)); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// A slug the server names reaches the screen only in this shape, so a /healthz
// answer can never put arbitrary text in front of the person.
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UNREACHABLE = Object.freeze({ unreachable: true });

// The control plane enforces exactly one chat model and names it on /healthz,
// which needs no session. Only a plain, bounded JSON answer from that exact
// origin counts, and it says one of three things: { model } is a model this
// product ships; { unknown: slug } is a well-formed slug this build does not
// know, which a newer app cures and another connection does not; { unreachable }
// is everything else (no answer in time, an error status, a redirect, a body
// that is not small JSON naming a slug) and says nothing about the model at all.
// Never an error: the caller decides what an unanswered question means.
export async function probeServerModel(serverUrl, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  let origin; try { origin = validateServerUrl(serverUrl); } catch { return UNREACHABLE; }
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${origin}/healthz`, { method: "GET", redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok || !json(response)) { await response.body?.cancel(); return UNREACHABLE; }
    const data = await smallJson(response);
    const model = data?.model;
    if (!isChatModel(model)) return typeof model === "string" && SLUG.test(model) ? Object.freeze({ unknown: model }) : UNREACHABLE;
    // The set the server offers, narrowed to models this build ships (an unknown
    // slug in the list is simply not selectable). The default stays first.
    const offered = Array.isArray(data?.models) ? [...new Set(data.models.filter((slug) => isChatModel(slug)))] : [];
    const models = offered.length ? [...new Set([model, ...offered])] : [model];
    return Object.freeze({ model, models: Object.freeze(models) });
  } catch { return UNREACHABLE; } finally { clearTimeout(timer); }
}
// Only a model this product ships, or null: for a caller that has nothing to
// say about the other two answers and keeps its default (the CLI chat).
export async function fetchServerModel(serverUrl, options) { return (await probeServerModel(serverUrl, options)).model ?? null; }

// What one scope knows of its server's model. The first answer used to be the
// last: a /healthz slower than the 3 s limit pinned the default for the scope's
// whole life, so every label and consent named MiniMax-M3 as fact while the
// gateway refused each call with model_not_allowed (live finding: a loopback
// /healthz that delayed its first answer by 3.5 s). Now only a model the server
// named is kept, and every answer replaces the last, "no answer" included.
// Without a model, current() asks again at most once per retryMs; learn() asks
// at once and supersedes any earlier question (the connection changed);
// refused() is the gateway turning down the model in use, so the server is
// asked at once rather than after the backoff.
// Why the server passes a model over, in the person's words (model-health.js).
const UNAVAILABLE_REASONS = Object.freeze({ subscription: "上游订阅无效或已过期", billing: "上游账户余额或额度不足", auth: "上游不再接受服务端的密钥" });
// The server's answer about this person's model (model-choice.js), kept only
// when every model in it is a well-formed slug.
function remoteAnswer(value) {
  if (!value || !Array.isArray(value.available) || !value.available.every((slug) => SLUG.test(slug))) return null;
  if (!SLUG.test(value.default ?? "") || !SLUG.test(value.current ?? "") || (value.choice !== null && !SLUG.test(value.choice ?? ""))) return null;
  const unavailable = Array.isArray(value.unavailable) ? value.unavailable.filter((row) => SLUG.test(row?.model ?? "")) : [];
  return Object.freeze({ available: [...value.available], default: value.default, choice: value.choice, current: value.current,
    unavailable: unavailable.map((row) => Object.freeze({ model: row.model, reason: typeof row.reason === "string" ? row.reason : "", since: Number(row.since) || null })) });
}

export class ServerModel {
  #serverUrl; #probe; #now; #retryMs; #choice; #persist;
  #known = UNREACHABLE; #pending = Promise.resolve(); #asking = false; #askedAt = -Infinity;
  // `remote` is the server's own record of this person's model ({ options(),
  // choose(model|null) }, each answering null when the server is older than
  // it). When it answers, it decides: the local `choice` is then only what an
  // older server falls back to. Asked when the connection is learned and again
  // at most every `remoteTtlMs`, always in the background: current() is on the
  // path of every label and status, and waiting there on a slow server slowed
  // all of them (and held 退出此账号). Only a turn about to be sent, or the
  // picker, waits -- at most `remoteWaitMs`, and only before the first answer.
  #remote; #remoteKnown = null; #remoteAt = -Infinity; #remoteAsking = null; #remoteTtlMs; #remoteWaitMs; #remoteGeneration = 0;
  constructor({ serverUrl, probe = probeServerModel, now = Date.now, retryMs = 10_000, choice = null, persist = null, remote = null, remoteTtlMs = 30_000, remoteWaitMs = 1_500 }) {
    this.#serverUrl = serverUrl; this.#probe = probe; this.#now = now; this.#retryMs = retryMs; this.#choice = choice; this.#persist = persist;
    this.#remote = remote; this.#remoteTtlMs = remoteTtlMs; this.#remoteWaitMs = remoteWaitMs;
  }
  // Starts a question when the last answer is stale; never waits for it.
  // An answer for a connection since replaced (learn() again) is dropped.
  #refreshRemote() {
    if (!this.#remote || this.#remoteAsking || this.#now() - this.#remoteAt < this.#remoteTtlMs) return;
    const generation = this.#remoteGeneration;
    const asking = (async () => {
      let answer = this.#remoteKnown;
      try { answer = remoteAnswer(await this.#remote.options()); } catch { /* keep the last answer */ }
      if (generation !== this.#remoteGeneration) return;
      this.#remoteKnown = answer; this.#remoteAt = this.#now(); this.#remoteAsking = null;
    })();
    this.#remoteAsking = asking;
  }
  // For a caller that needs the person's model rather than a label: before the
  // first answer, waits for it -- briefly -- and after that never. `fresh` asks
  // again now and waits for that answer (briefly): the picker, which must show
  // a model the server passed over a moment ago, not one cached before it did.
  async settled({ fresh = false } = {}) {
    if (fresh && !this.#remoteAsking) this.#remoteAt = -Infinity;
    this.#refreshRemote();
    if (!this.#remoteAsking || (!fresh && this.#remoteAt !== -Infinity)) return;
    let timer;
    await Promise.race([this.#remoteAsking, new Promise((resolve) => { timer = setTimeout(resolve, this.#remoteWaitMs); })]).finally(() => clearTimeout(timer));
  }
  learn() {
    this.#remoteGeneration += 1; this.#remoteKnown = null; this.#remoteAt = -Infinity; this.#remoteAsking = null;
    this.#askedAt = this.#now(); this.#asking = true;
    const attempt = (async () => {
      try { const url = await this.#serverUrl(); return url ? await this.#probe(url) : UNREACHABLE; } catch { return UNREACHABLE; }
    })().then(answer => { if (this.#pending === attempt) { this.#known = answer; this.#asking = false; } });
    this.#pending = attempt;
    // The person's model is asked for at once, so a turn rarely has to wait.
    this.#refreshRemote();
    return attempt;
  }
  // The answer for the connection as it is now, never for a superseded one.
  async current() {
    for (let retried = false; ;) {
      const pending = this.#pending; await pending;
      if (pending !== this.#pending) continue;
      if (this.#known.model || retried || this.#now() - this.#askedAt < this.#retryMs) { this.#refreshRemote(); return this.#known; }
      retried = true; this.learn();
    }
  }
  // A question already on its way is the answer to this refusal too.
  refused() { this.#remoteAt = -Infinity; if (!this.#asking) this.learn(); }
  // Every model request a scope makes itself goes through this fetch, so the
  // gateway's model_not_allowed has the server asked again however the caller
  // words its own error, and before the caller sees the answer. Only the
  // gateway's code is read, from a bounded copy of the body.
  watching(fetchImpl = (url, init) => fetch(url, init)) {
    return async (url, init) => {
      const response = await fetchImpl(url, init);
      if (response.status === 403 && await modelRefused(response.clone())) this.refused();
      return response;
    };
  }
  // A Codex turn reports the same refusal as a notification.
  watchTurns(client) { client.on("notification", message => { if (turnRefused(message)) this.refused(); }); return client; }
  // What a Codex turn or a proposal asks the gateway for. Unconfirmed it is
  // still the default: the gateway refuses any other model before an upstream
  // call, and that refusal has the server asked again at once. A model the
  // server named but this build does not ship is not asked for when content
  // would go; a connection check sends none, so it is no reason to refuse one.
  async requestModel({ sending = true } = {}) {
    const known = await this.current();
    await this.settled();
    if (known.unknown && sending) throw new Error(`${modelProblem(known)}；本次未发送。`);
    // The server's own answer for this person first: their pick while it is
    // offered and answering, else the first model that is. The gateway routes a
    // lapsed model onward anyway; asking for the right one saves the detour.
    if (this.#remoteKnown && isChatModel(this.#remoteKnown.current)) return this.#remoteKnown.current;
    // An older server: the client's chosen model, but only while the server
    // still offers it; otherwise the default the server named.
    if (this.#choice && known.models?.includes(this.#choice)) return this.#choice;
    return known.model ?? DEFAULT_CHAT_MODEL;
  }
  #available() { return this.#known.models ? [...this.#known.models] : (this.#known.model ? [this.#known.model] : []); }
  // For the picker: the models this connection offers (labelled), the current
  // effective choice, and the server's default. Call after current() so the set
  // is loaded.
  options() {
    const remote = this.#remoteKnown;
    if (remote) {
      const shipped = remote.available.filter((slug) => isChatModel(slug));
      return { available: shipped.map((slug) => ({ slug, label: chatModelLabel(slug), vendor: chatModelVendor(slug), images: chatModelSeesImages(slug) })),
        current: isChatModel(remote.current) ? remote.current : null, default: remote.default, choice: remote.choice, kept: "server",
        unavailable: remote.unavailable.filter((row) => isChatModel(row.model)).map((row) => ({ slug: row.model, label: chatModelLabel(row.model),
          reason: UNAVAILABLE_REASONS[row.reason] ?? "上游暂时不可用", since: row.since })) };
    }
    const available = this.#available();
    const current = this.#choice && available.includes(this.#choice) ? this.#choice : (this.#known.model ?? null);
    return { available: available.map((slug) => ({ slug, label: chatModelLabel(slug), vendor: chatModelVendor(slug), images: chatModelSeesImages(slug) })), current, default: this.#known.model ?? null,
      choice: this.#choice && available.includes(this.#choice) ? this.#choice : null, kept: "local", unavailable: [] };
  }
  // Choose a model for this person, or null to follow the server's default.
  // Kept by the server when it keeps choices; an older server's choice is kept
  // here instead, through the optional callback, and refuses null.
  async choose(model) {
    if (this.#remote) {
      const answer = remoteAnswer(await this.#remote.choose(model));
      if (answer) { this.#remoteGeneration += 1; this.#remoteAsking = null; this.#remoteKnown = answer; this.#remoteAt = this.#now(); return this.options(); }
    }
    if (model === null) throw new Error("服务端版本较旧，不能改回跟随默认");
    const known = await this.current();
    const available = known.models ? [...known.models] : (known.model ? [known.model] : []);
    if (!available.includes(model)) throw new Error("该模型当前不可选");
    this.#choice = model;
    if (this.#persist) { try { await this.#persist(model); } catch { /* a convenience; the in-memory choice still holds */ } }
    return this.options();
  }
}

// Said instead of a model name while the server has confirmed none. Never the
// default's name: that is what the live finding above was about.
export const MODEL_UNCONFIRMED = "模型未确认";
const unsupported = known => typeof known?.unknown === "string" && SLUG.test(known.unknown);
export const modelProblem = known => unsupported(known)
  ? `服务端使用的模型 ${known.unknown} 本版本不支持，请更新应用`
  : "服务端尚未确认所用模型，稍后会自动重试";
// What the renderer shows. The label, vendor and synthesis output cap travel
// with the slug so it never needs the model table (the consent states the cap,
// and GLM's is not MiniMax's); without a model the server confirmed there is
// no name at all, only the reason.
export const modelFields = known => isChatModel(known?.model)
  ? { model: known.model, modelLabel: chatModelLabel(known.model), modelVendor: chatModelVendor(known.model), modelConfirmed: true, modelSynthesisTokens: CHAT_MODELS[known.model].sideCalls.synthesis.maxOutputTokens }
  : { model: null, modelLabel: MODEL_UNCONFIRMED, modelVendor: "", modelConfirmed: false, modelNotice: modelProblem(known), modelUnsupported: unsupported(known) };

// The gateway's answer when a request names a model other than the one it
// enforces: this machine could not learn it, or the server changed model since.
// Only our own gateway's error code is read, from a bounded body, and nothing
// of it is shown; the cure is to connect again.
export const MODEL_MISMATCH = "服务端要求的模型与本机不一致，请重新连接";
export async function modelRefused(response) {
  if (response.status !== 403 || !json(response)) return false;
  try { return (await smallJson(response))?.error?.code === "model_not_allowed"; } catch { return false; }
}
// The same refusal as Codex reports a turn's failure, in its own words with the
// gateway's code inside. Only whether the code is there is read; a false match
// costs one more /healthz and nothing else.
export function turnRefused(message) {
  return turnErrorNames(message, "model_not_allowed");
}
// A turn the gateway refused because it no longer knows the session behind the
// token -- after the server restarted, it knows none. Codex may also have held
// on to a token a renewal has since replaced, so this is only a reason to ask
// the server, never proof by itself.
export function turnSessionUnknown(message) {
  return turnErrorNames(message, "session_expired_or_invalid");
}
function turnErrorNames(message, code) {
  const error = message?.method === "error" ? message.params?.error : message?.method === "turn/completed" ? message.params?.turn?.error : null;
  return [error?.message, error?.additionalDetails].some(text => typeof text === "string" && new RegExp(`\\b${code}\\b`).test(text.slice(0, 8192)));
}
