import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateServerUrl } from "../../control-plane/client-session.js";
import { feishuCliWriteCapability, feishuCliWriteCompanionRead, feishuCliWriteFollowUp, feishuCliWriteIntent, feishuCliWriteIsSequence, isIdentityPreflight, validateFeishuCliWriteRequest, MAX_IDENTITY_PREFLIGHTS } from "./cli-write-contract.js";
import { acceptFeishuCliSequencePrepare, acceptFeishuCliSequenceStep, startFeishuCliSequence, validateFeishuCliSequenceStep } from "./cli-write-sequence.js";
import { feishuCliRefusal, openApiPath } from "./openapi.js";
import { SAAS_API_ORIGIN, SAAS_APP_ID } from "./saas-deployment.js";
import { ownHeaderName } from "../../product-names.js";

const HEADERS = Object.freeze({
  version: "x-lark-proxy-version",
  target: "x-lark-proxy-target",
  identity: "x-lark-proxy-identity",
  signature: "x-lark-proxy-signature",
  timestamp: "x-lark-proxy-timestamp",
  bodyHash: "x-lark-body-sha256",
  authHeader: "x-lark-proxy-auth-header",
});
const PROXY_ROUTE = "/v1/feishu/cli-proxy";
const WRITE_GRANT_ROUTE = "/v1/feishu/cli-write-grants";
// Must exceed the largest granted write, which is the single-shot Drive upload.
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_WRITES = 8;
// A sequence key (a chunked Drive upload) is extended by each step it admits,
// never past its deadline, and after the last step it stays usable for the
// action's companion read only, briefly.
const SEQUENCE_STEP_TTL_MS = 60_000;
const SEQUENCE_MAX_MS = 15 * 60_000;
const SEQUENCE_GRACE_MS = 10_000;
const MAX_STEP_RESPONSE_BYTES = 65_536;

// Only the CLI reads what this answers, so a refusal is said the way its SDK
// can parse (see feishuCliRefusal); plain text arrived as an SDK parse error.
function fail(res, status, message) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(feishuCliRefusal(status, message)));
}

// The CLI names the API origin it would have called. Only the deployment's own
// is accepted; anything else is a CLI configured for somewhere this bridge does
// not speak for.
function safeTarget(value, apiOrigin) {
  if (typeof value !== "string") throw new Error("invalid proxy target");
  let url;
  try { url = new URL(value); } catch { throw new Error("invalid proxy target"); }
  if (url.origin !== apiOrigin || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("proxy target is not allowed");
  return url.origin;
}

function safePath(value) {
  if (!openApiPath(value)) throw new Error("proxy path is not allowed");
  return value;
}

// Exactly one candidate key may match. Every candidate is compared so a wrong
// key cannot be distinguished by timing, and an ambiguous match fails closed.
function verifyRequest(req, body, candidates, now, apiOrigin) {
  const version = req.headers[HEADERS.version], target = safeTarget(req.headers[HEADERS.target], apiOrigin);
  const identity = req.headers[HEADERS.identity], authHeader = req.headers[HEADERS.authHeader];
  const timestamp = req.headers[HEADERS.timestamp], signature = req.headers[HEADERS.signature], claimed = req.headers[HEADERS.bodyHash];
  if (version !== "v1" || identity !== "user" || authHeader !== "Authorization" || typeof timestamp !== "string" || !/^-?\d+$/.test(timestamp) || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) || typeof claimed !== "string" || !/^[a-f0-9]{64}$/.test(claimed)) throw new Error("invalid sidecar signature metadata");
  const seconds = Number(timestamp); if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now() / 1000) - seconds) > 60) throw new Error("expired sidecar request");
  const actualBody = createHash("sha256").update(body).digest("hex");
  if (actualBody !== claimed) throw new Error("sidecar body hash mismatch");
  const path = safePath(req.url);
  const canonical = [version, req.method, new URL(target).host, path, claimed, timestamp, identity, authHeader].join("\n");
  const supplied = Buffer.from(signature, "hex");
  const matches = candidates.filter(candidate => {
    const expected = createHmac("sha256", candidate.key).update(canonical).digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (matches.length !== 1) throw new Error("sidecar HMAC mismatch");
  return { target, path, write: matches[0].write };
}

async function readBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("sidecar request is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readAnswer(response, maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maxBytes) throw new Error("Feishu CLI bridge returned an oversized step answer"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

// Native-process bridge for the upstream lark-cli `authsidecar` build. The
// CLI receives only this loopback address and an HMAC key. The Feishu OAuth
// token remains in the control plane and never enters the CLI, Agent
// environment, renderer, or this server.
//
// Reads use one process-lifetime key that the Agent's shell also holds. A write
// instead gets a fresh per-invocation key bound to a server-issued one-shot
// grant, so the reusable read key can never carry a mutation.
export class FeishuCliSidecar {
  constructor({ appId, getSession, fetchImpl = fetch, now = Date.now, apiOrigin = SAAS_API_ORIGIN, appIdPattern = SAAS_APP_ID }) {
    if (!(appIdPattern instanceof RegExp) || typeof appId !== "string" || !appIdPattern.test(appId) || typeof getSession !== "function") throw new Error("Invalid Feishu CLI sidecar configuration");
    let origin = null; try { origin = new URL(apiOrigin).origin; } catch { /* refused below */ }
    if (origin !== apiOrigin || !apiOrigin.startsWith("https://")) throw new Error("Invalid Feishu CLI sidecar configuration");
    this.appId = appId; this.getSession = getSession; this.fetch = fetchImpl; this.now = now; this.apiOrigin = apiOrigin;
    this.key = randomBytes(32).toString("base64url"); this.controllers = new Set(); this.writeKeys = new Map(); this.closed = false;
  }
  async start() {
    if (this.closed || this.server) throw new Error("Feishu CLI sidecar cannot be started");
    this.configDirectory = await mkdtemp(path.join(os.tmpdir(), "idou-lark-cli-"));
    this.server = createServer((req, res) => { void this.handle(req, res); });
    try { await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); }); }
    catch (error) { await rm(this.configDirectory, { recursive: true, force: true }); this.configDirectory = null; throw error; }
    this.address = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  baseEnvironment(key = this.key) {
    if (!this.address || this.closed) throw new Error("Feishu CLI sidecar is not active");
    return {
      LARKSUITE_CLI_AUTH_PROXY: this.address,
      LARKSUITE_CLI_PROXY_KEY: key,
      LARKSUITE_CLI_APP_ID: this.appId,
      LARKSUITE_CLI_BRAND: "feishu",
      LARKSUITE_CLI_DEFAULT_AS: "user",
      LARKSUITE_CLI_STRICT_MODE: "user",
      // Read by CLIs before 1.0.96, which could overlay a downloaded API catalog.
      // From 1.0.96 the catalog is compiled in and there is nothing to turn off.
      LARKSUITE_CLI_REMOTE_META: "off",
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
      LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      LARKSUITE_CLI_CONFIG_DIR: this.configDirectory,
    };
  }
  // Reads stay synchronous so the Codex task runtime keeps its existing
  // environment contract. Only a native write intent takes the async path.
  environment(writeIntent) {
    if (writeIntent === undefined || writeIntent === null) return this.baseEnvironment();
    return this.writeEnvironment(writeIntent);
  }
  session(value) {
    if (!value || value.identity?.appId !== this.appId || value.identity?.cliBridge !== true || value.expiresAt <= this.now()) throw new Error("Feishu CLI bridge session is unavailable");
    return value;
  }
  // Which application session the CLI's next request will travel under, as a
  // digest. The control plane binds a session to one Feishu user, and renewal
  // replaces the token without changing the user, so a user check made under one
  // digest holds for as long as the digest does. Only the digest leaves this
  // object, never the token.
  async sessionFingerprint() {
    const session = this.session(await this.getSession());
    return createHash("sha256").update(JSON.stringify([this.appId, session.serverUrl, session.token, session.expiresAt])).digest("hex");
  }
  prune() { for (const [id, row] of this.writeKeys) if (row.expiresAt <= this.now()) this.writeKeys.delete(id); }
  async grantJson(response) {
    if (response.status !== 201 || response.redirected || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") { await response.body?.cancel(); throw new Error("飞书写入授权被服务端拒绝"); }
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 8192) { await reader.cancel(); throw new Error("飞书写入授权响应过大"); } chunks.push(Buffer.from(part.value)); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { throw new Error("飞书写入授权响应无效"); }
    finally { reader.releaseLock(); }
  }
  async writeEnvironment(value) {
    const intent = feishuCliWriteIntent(value);
    this.prune();
    if (this.closed || this.writeKeys.size >= MAX_PENDING_WRITES) throw new Error("飞书写入授权繁忙，请稍后重试");
    const session = this.session(await this.getSession());
    // Each action has its own capability; holding one never implies another.
    const capability = feishuCliWriteCapability(intent.action);
    if (!capability || session.identity[capability] !== true) throw new Error("当前企业策略未启用登录桥接下的这类飞书写入");
    const origin = validateServerUrl(session.serverUrl);
    const response = await this.fetch(`${origin}${WRITE_GRANT_ROUTE}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(intent) });
    const issued = await this.grantJson(response);
    if (typeof issued.grant !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(issued.grant) || !Number.isSafeInteger(issued.expiresAt) ||
        issued.expiresAt <= this.now() || issued.expiresAt > Math.min(session.expiresAt, this.now() + 60_000)) throw new Error("飞书写入授权响应无效");
    const id = randomBytes(16).toString("hex"), key = randomBytes(32).toString("base64url");
    this.writeKeys.set(id, { id, key, grant: issued.grant, intent, expiresAt: issued.expiresAt, preflights: 0,
      ...(feishuCliWriteIsSequence(intent.action) ? { sequence: startFeishuCliSequence(intent), busy: false, step: null, deadline: Math.min(session.expiresAt, this.now() + SEQUENCE_MAX_MS) } : {}) });
    return this.baseEnvironment(key);
  }
  // A write-scoped key admits at most MAX_IDENTITY_PREFLIGHTS identity reads and
  // then exactly one request matching its grant. The preflight must not spend
  // the grant, and any other shape retires the key without reaching Feishu.
  // An action with a follow-up keeps the key after its write, spent, for the
  // reads its own answer names and nothing else -- see settleWrite.
  classify(write, method, path, body, contentType) {
    if (isIdentityPreflight(method, path)) {
      if (++write.preflights > MAX_IDENTITY_PREFLIGHTS) { this.writeKeys.delete(write.id); throw new Error("写入授权前的身份检查次数异常"); }
      return null;
    }
    if (write.spent) {
      const read = write.followUpId ? write.followUp.read(write.followUpId) : null;
      if (read && method === read.method && path === read.path && body.length === 0 && ++write.followUpReads <= write.followUp.maxReads) return null;
      this.writeKeys.delete(write.id); throw new Error("写入之后只能查询这次写入自己的处理进度");
    }
    if (write.sequence) return this.classifyStep(write, method, path, body, contentType);
    this.writeKeys.delete(write.id); // One shot: consumed before validation, so a mismatch cannot be retried.
    validateFeishuCliWriteRequest(write.intent, method, path, body, contentType);
    const followUp = feishuCliWriteFollowUp(write.intent.action);
    // Re-admitted, spent: it can never carry the grant again, and until the
    // write's answer names a follow-up it admits nothing at all.
    if (followUp) Object.assign(write, { spent: true, followUp, followUpId: null, followUpReads: 0 }), this.writeKeys.set(write.id, write);
    return write.grant;
  }
  // Reads the answer of a write that may be followed up, or of one of its
  // follow-up reads, and decides whether the key lives on: only while the
  // answer names work still settling, within the action's window.
  settleWrite(write, status, bytes) {
    let answer = null; try { answer = JSON.parse(bytes.toString("utf8")); } catch { /* not a JSON answer: nothing to follow */ }
    if (write.followUpId === null) {
      const id = status === 200 ? write.followUp.id(answer) : null;
      if (!id || write.followUp.settled(answer)) { this.writeKeys.delete(write.id); return; }
      write.followUpId = id;
      write.expiresAt = this.now() + write.followUp.windowMs;
      // Put back if the wait for the answer outlasted the grant's own expiry.
      if (!this.closed) this.writeKeys.set(write.id, write);
      return;
    }
    // A refused or failed read is left to the CLI, which retries the ones worth
    // retrying; the count and the window bound it either way. An answer about
    // another task, or one that has settled, ends it.
    if (status === 200 && (write.followUp.id(answer) !== write.followUpId || write.followUp.settled(answer))) this.writeKeys.delete(write.id);
  }
  // A sequence key admits the recorded steps in order, each checked here before
  // it leaves and again by the control plane, one at a time. After the last
  // step it admits only the action's companion read, which carries no grant.
  // A refused step retires the key.
  classifyStep(write, method, path, body, contentType) {
    if (write.sequence.stage === "done") {
      if (feishuCliWriteCompanionRead(write.intent.action, method, path)) { write.step = null; return null; }
      this.writeKeys.delete(write.id); throw new Error("写入序列已经结束");
    }
    if (write.busy) { this.writeKeys.delete(write.id); throw new Error("写入序列的步骤不能并发"); }
    try { write.step = validateFeishuCliSequenceStep(write.sequence, method, path, body, contentType); }
    catch (error) { this.writeKeys.delete(write.id); throw error; }
    write.busy = true;
    write.expiresAt = Math.min(write.deadline, this.now() + SEQUENCE_STEP_TTL_MS);
    return write.grant;
  }
  settleStep(write, status, bytes) {
    write.busy = false;
    const accepted = status === 200 && (write.step === "prepare" ? acceptFeishuCliSequencePrepare(write.sequence, bytes) : acceptFeishuCliSequenceStep(write.sequence, bytes));
    if (!accepted) this.writeKeys.delete(write.id);
    else if (write.step === "finish") write.expiresAt = Math.min(write.deadline, this.now() + SEQUENCE_GRACE_MS);
  }
  async handle(req, res) {
    const controller = new AbortController(); this.controllers.add(controller);
    let stepWrite = null, settling = null;
    const cancel = () => controller.abort(); res.once("close", cancel);
    try {
      if (this.closed || req.headers.origin) throw new Error("native sidecar request required");
      const body = await readBody(req);
      this.prune();
      const verified = verifyRequest(req, body, [{ key: this.key, write: null }, ...[...this.writeKeys.values()].map(write => ({ key: write.key, write }))], this.now, this.apiOrigin);
      const grant = verified.write ? this.classify(verified.write, req.method, verified.path, body, req.headers["content-type"] || "") : null;
      if (verified.write?.sequence && verified.write.step) stepWrite = verified.write;
      // The write of a followed-up action, or one of its follow-up reads: its
      // answer decides whether the key lives on, so it is read whole. An
      // identity preflight in between says nothing about the write.
      if (verified.write?.spent && (grant || verified.write.followUpId) && !isIdentityPreflight(req.method, verified.path)) settling = verified.write;
      const session = this.session(await this.getSession());
      const origin = validateServerUrl(session.serverUrl);
      const response = await this.fetch(`${origin}${PROXY_ROUTE}`, { method: req.method, redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${session.token}`, [ownHeaderName("feishu-target")]: verified.target, [ownHeaderName("feishu-path")]: verified.path,
          ...(grant ? { [ownHeaderName("feishu-write-grant")]: grant } : {}),
          ...(req.headers.accept ? { accept: req.headers.accept } : {}), ...(req.headers["content-type"] ? { "content-type": req.headers["content-type"] } : {}) },
        ...(body.length ? { body } : {}) });
      if (response.redirected || !response.body) throw new Error("Feishu CLI bridge returned an invalid response");
      const headers = {}; for (const name of ["content-type", "content-length", "etag", "last-modified", "content-range"]) { const value = response.headers.get(name); if (value) headers[name] = value; }
      // A sequence step's answer is read whole: whether the sequence goes on, and
      // the block size every later part follows, come from it.
      if (verified.write?.sequence && verified.write.step) {
        const answer = await readAnswer(response, MAX_STEP_RESPONSE_BYTES);
        this.settleStep(verified.write, response.status, answer);
        headers["content-length"] = String(answer.length);
        res.writeHead(response.status, headers); res.end(answer);
        return;
      }
      if (settling) {
        const answer = await readAnswer(response, MAX_STEP_RESPONSE_BYTES);
        this.settleWrite(settling, response.status, answer);
        headers["content-length"] = String(answer.length);
        res.writeHead(response.status, headers); res.end(answer);
        return;
      }
      res.writeHead(response.status, headers);
      for await (const chunk of response.body) { if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve)); }
      res.end();
    } catch (error) {
      // A step that failed in flight ends its sequence; nothing resumes it. A
      // followed-up write whose answer never arrived names nothing to follow.
      if (stepWrite) this.writeKeys.delete(stepWrite.id);
      if (settling && settling.followUpId === null) this.writeKeys.delete(settling.id);
      if (!res.headersSent) fail(res, error.name === "AbortError" ? 499 : 403, error.message); else res.destroy();
    }
    finally { res.off("close", cancel); this.controllers.delete(controller); }
  }
  async close() {
    if (this.closed) return; this.closed = true; this.key = "";
    this.writeKeys.clear();
    for (const controller of this.controllers) controller.abort();
    if (this.server) await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections(); });
    if (this.configDirectory) await rm(this.configDirectory, { recursive: true, force: true });
  }
}

export const feishuCliSidecarContract = Object.freeze({ route: PROXY_ROUTE, writeGrantRoute: WRITE_GRANT_ROUTE, maxRequestBytes: MAX_REQUEST_BYTES });
