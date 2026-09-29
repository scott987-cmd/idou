import { createHash, randomBytes } from "node:crypto";
import { CountedMap, ExpiryQueue, Rates, personOf } from "./limits.js";
import { feishuCliWriteIntent, feishuCliWriteCapability, feishuCliWriteCompanionRead, feishuCliWriteEndpoint, feishuCliWriteIsMultipart, feishuCliWriteIsSequence, feishuCliWriteMaxBytes, feishuCliWriteResource, feishuCliWriteStepIsMultipart, validateFeishuCliWriteRequest } from "../providers/feishu/cli-write-contract.js";
import { acceptFeishuCliSequencePrepare, acceptFeishuCliSequenceStep, startFeishuCliSequence, validateFeishuCliSequenceStep } from "../providers/feishu/cli-write-sequence.js";
import { feishuCliSemanticRead, validateFeishuCliSemanticRead } from "../providers/feishu/cli-read-contract.js";
import { feishuCliRefusal, openApiPath } from "../providers/feishu/openapi.js";
import { ownHeader } from "../product-names.js";

const PROXY_ROUTE = "/v1/feishu/cli-proxy";
const WRITE_GRANT_ROUTE = "/v1/feishu/cli-write-grants";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_GRANT_BYTES = 4096;
const GRANT_TTL_MS = 30_000;
// A sequence grant (a chunked Drive upload) lives while its steps keep coming:
// each accepted step extends it by this much, never past the overall deadline.
const SEQUENCE_STEP_TTL_MS = 60_000;
const SEQUENCE_MAX_MS = 15 * 60_000;
// A sequence step's upstream answer is read whole, because the next step
// depends on it; it is small JSON.
const MAX_STEP_RESPONSE_BYTES = 65_536;
class ProxyError extends Error { constructor(status, message) { super(message); this.status = status; } }
// Every method a write may use carries its body here. This list once said only
// POST and PUT, so a PATCH arrived with an empty body, was compared against its
// grant, and was refused: the sidecar reads every body and passed it, the
// control plane did not. The two must agree on what a request contains.
const BODY_METHODS = Object.freeze(["POST", "PUT", "PATCH"]);
const digest = value => createHash("sha256").update(value).digest("hex");

function safePath(value) {
  if (!openApiPath(value)) throw new ProxyError(403, "feishu_cli_path_denied");
  return value;
}

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

// Unchanged read policy. A write is never reachable by widening this: it needs
// its own method, its own one-shot grant and an exact request match.
function readOperationAllowed(method, path) {
  return method === "GET" || method === "POST" && (
    /^\/open-apis\/docs_ai\/v1\/documents\/[A-Za-z0-9_-]{1,128}\/fetch(?:\?[^#]*)?$/.test(path) ||
    // Named semantic reads: document, recipient and group lookup. Each is a read
    // endpoint by name, and its body is checked against a closed shape below
    // before anything is forwarded.
    Boolean(feishuCliSemanticRead(method, path)));
}

async function readBody(req, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { bytes += chunk.length; if (bytes > maxBytes) throw new ProxyError(413, "feishu_cli_request_too_large"); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function readUpstream(response, maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maxBytes) throw new ProxyError(502, "feishu_cli_upstream_invalid"); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

const bearer = req => req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
// x-idou-* or, from a client made before the rename, x-mydoubao-* (product-names.js).
const own = (req, suffix) => { try { return ownHeader(req.headers, suffix); } catch { throw new ProxyError(400, "feishu_cli_header_conflict"); } };

// Server data-plane transit only: request and response bodies are streamed and
// never persisted. A write additionally requires a short-lived, single-use grant
// that the native layer may request only after its own confirmation. The audit
// sink receives action, hashed identifiers, decision and upstream outcome
// class -- never a token, request body, document text or response body.
//
// The one upstream it forwards to is the deployment's OpenAPI origin, the same
// one the source access holding the credentials was built for. The CLI names
// the origin it meant; any other is refused, never re-aimed.
// Write grants: each is a confirmation somebody gave, alive for minutes. What
// one person may hold and start a minute is what the whole pilot server could
// (a hundred, sixty); the server's own bounds are memory, sized for a hundred
// thousand people (limits.js).
export const WRITE_GRANTS = Object.freeze({ perPerson: 100, max: 20_000, issuesPerMinutePerPerson: 60, issuesPerMinute: 6000, operationsMax: 200_000 });

export class FeishuCliProxyService {
  #expiry = new ExpiryQueue();
  constructor({ sourceAccess, fetchImpl = fetch, now = Date.now, audit = () => {}, maxConcurrent = 16, maxConcurrentPerUser = maxConcurrent }) {
    if (![maxConcurrent, maxConcurrentPerUser].every((value) => Number.isSafeInteger(value) && value >= 1) || maxConcurrentPerUser > maxConcurrent) throw new Error("Invalid Feishu CLI proxy concurrency");
    if (!sourceAccess?.cliProxyEnabled) throw new Error("Feishu CLI proxy requires enabled server-side OAuth source access");
    if (typeof audit !== "function") throw new Error("Feishu CLI proxy audit sink is invalid");
    if (!sourceAccess.feishu?.openApi) throw new Error("Feishu CLI proxy requires a deployment that speaks OpenAPI");
    this.sourceAccess = sourceAccess; this.upstream = sourceAccess.feishu.openApi; this.fetch = fetchImpl; this.now = now; this.audit = audit;
    this.active = 0; this.closed = false; this.grants = new CountedMap((grant) => grant.person); this.operations = new Map();
    this.issues = new Rates({ windowMs: 60_000, max: WRITE_GRANTS.issuesPerMinute, perPerson: WRITE_GRANTS.issuesPerMinutePerPerson, now, name: "write grants a minute" });
    // Calls in flight for the whole server and for each person, so one busy
    // account cannot hold every slot (loadCapacity in server-config.js).
    this.maxConcurrent = maxConcurrent; this.maxConcurrentPerUser = maxConcurrentPerUser;
    this.holding = new Map(); this.counters = { calls: 0, busy: { server: 0, person: 0 } };
  }
  // The action must be configured server-side and the live session must carry
  // that action's capability. Neither alone is sufficient.
  allowed(who, action) {
    const capability = feishuCliWriteCapability(action);
    return who.cliBridge === true && Boolean(capability) && who[capability] === true && this.sourceAccess.cliWriteActions.includes(action);
  }
  // Only what has expired is looked at (limits.js).
  prune() {
    const now = this.now();
    for (let entry; (entry = this.#expiry.due(now));) {
      if (entry.value === "operation") { if (this.operations.get(entry.key) === entry.expiresAt) this.operations.delete(entry.key); }
      else if (this.grants.get(entry.key) === entry.value) {
        // A sequence step moves its grant's time; it is looked at again then.
        if (entry.value.expiresAt > now) this.#expiry.add(entry.value.expiresAt, entry.key, entry.value);
        else this.grants.delete(entry.key);
      }
    }
  }
  record(kind, who, intent, extra = {}) {
    try {
      this.audit(Object.freeze({ kind, at: this.now(), action: intent.action,
        sessionHash: digest(who.id), tenantHash: digest(who.tenantId), userHash: digest(who.userId),
        resourceHash: digest(feishuCliWriteResource(intent)), operationHash: digest(intent.operationId), ...extra }));
    } catch { /* An audit sink failure must not change the authorization decision. */ }
  }
  issue(parentToken, value) {
    this.prune();
    let intent; try { intent = feishuCliWriteIntent(value); } catch { throw new ProxyError(400, "invalid_feishu_cli_write_intent"); }
    let who, sourceGrant;
    try { ({ who, grant: sourceGrant } = this.sourceAccess.current(parentToken)); } catch { throw new ProxyError(403, "feishu_cli_write_not_allowed"); }
    if (this.closed || !this.allowed(who, intent.action)) throw new ProxyError(403, "feishu_cli_write_not_allowed");
    const person = personOf(who);
    if (this.grants.size >= WRITE_GRANTS.max || this.grants.held(person) >= WRITE_GRANTS.perPerson || this.operations.size >= WRITE_GRANTS.operationsMax || this.issues.refusal(person)) throw new ProxyError(429, "feishu_cli_write_grant_busy");
    // One confirmed operation is authorizable once per login family, so a
    // replayed confirmation cannot mint a second grant.
    const operationKey = digest(`${who.familyId}\n${intent.operationId}`);
    if (this.operations.has(operationKey)) throw new ProxyError(409, "feishu_cli_write_operation_reused");
    const expiresAt = Math.min(who.expiresAt, this.now() + GRANT_TTL_MS);
    if (expiresAt <= this.now()) throw new ProxyError(403, "feishu_cli_write_not_allowed");
    const token = randomBytes(32).toString("base64url");
    this.operations.set(operationKey, who.expiresAt); this.#expiry.add(who.expiresAt, operationKey, "operation");
    const grant = { intent, sessionId: who.id, person, sourceGrant, expiresAt,
      ...(feishuCliWriteIsSequence(intent.action) ? { sequence: startFeishuCliSequence(intent), busy: false, deadline: Math.min(who.expiresAt, this.now() + SEQUENCE_MAX_MS) } : {}) };
    this.grants.set(digest(token), grant); this.#expiry.add(expiresAt, digest(token), grant);
    this.issues.hit(person);
    this.record("grant_issued", who, intent, { expiresAt });
    return { grant: token, expiresAt };
  }
  consume(parentToken, grantToken, method, path, body, contentType) {
    this.prune();
    if (typeof grantToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(grantToken)) throw new ProxyError(403, "feishu_cli_write_grant_required");
    const key = digest(grantToken), saved = this.grants.get(key);
    if (!saved || saved.expiresAt <= this.now()) throw new ProxyError(403, "feishu_cli_write_grant_invalid");
    let who;
    // Recheck the live session and that it still holds the very same OAuth grant
    // object that existed at issue time; a rotated or rebound credential fails.
    try { ({ who } = this.sourceAccess.current(parentToken, saved.sourceGrant)); } catch { throw new ProxyError(403, "feishu_cli_write_grant_invalid"); }
    if (who.id !== saved.sessionId || !this.allowed(who, saved.intent.action)) throw new ProxyError(403, "feishu_cli_write_grant_invalid");
    if (saved.sequence) return this.consumeStep(key, saved, who, method, path, body, contentType);
    this.grants.delete(key); // Consumed before validation and dispatch: mismatch and lost response cannot replay.
    try { validateFeishuCliWriteRequest(saved.intent, method, path, body, contentType); }
    catch { this.record("grant_rejected", who, saved.intent, { reason: "request_mismatch" }); throw new ProxyError(403, "feishu_cli_write_request_mismatch"); }
    this.record("dispatch_started", who, saved.intent);
    return { who, intent: saved.intent };
  }
  // One step of a sequence grant (cli-write-sequence.js). Steps are taken one at
  // a time and in order. A refused step spends the grant, and so does the step
  // that makes the result exist -- upload_finish -- before it is dispatched.
  consumeStep(key, saved, who, method, path, body, contentType) {
    if (saved.busy) throw new ProxyError(409, "feishu_cli_write_sequence_busy");
    let step;
    try { step = validateFeishuCliSequenceStep(saved.sequence, method, path, body, contentType); }
    catch { this.grants.delete(key); this.record("grant_rejected", who, saved.intent, { reason: "request_mismatch" }); throw new ProxyError(403, "feishu_cli_write_request_mismatch"); }
    if (step === "finish") this.grants.delete(key);
    else { saved.busy = true; saved.expiresAt = Math.min(saved.deadline, this.now() + SEQUENCE_STEP_TTL_MS); this.#expiry.add(saved.expiresAt, key, saved); }
    if (step === "prepare") this.record("dispatch_started", who, saved.intent);
    return { who, intent: saved.intent, step, key, saved };
  }
  // What Feishu answered to a step decides whether the sequence goes on.
  settleStep(write, status, bytes) {
    write.saved.busy = false;
    const accepted = status === 200 && (write.step === "prepare" ? acceptFeishuCliSequencePrepare(write.saved.sequence, bytes) : acceptFeishuCliSequenceStep(write.saved.sequence, bytes));
    if (!accepted && write.step !== "finish") { this.grants.delete(write.key); this.record("grant_rejected", write.who, write.intent, { reason: "upstream_refused_step", status }); }
    return accepted;
  }
  async handleGrant(req, res) {
    try {
      if (this.closed || req.headers.origin) throw new ProxyError(403, "native_cli_proxy_required");
      if (req.method !== "POST") throw new ProxyError(405, "method_not_allowed");
      if (req.headers["content-type"]?.split(";")[0] !== "application/json" || req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new ProxyError(415, "feishu_cli_json_required");
      let value;
      try { value = JSON.parse(await readBody(req, MAX_GRANT_BYTES)); }
      catch (error) { if (error instanceof ProxyError) throw error; throw new ProxyError(400, "invalid_feishu_cli_write_intent"); }
      send(res, 201, this.issue(bearer(req), value));
    } catch (error) { req.resume(); send(res, error instanceof ProxyError ? error.status : 502, { error: error instanceof ProxyError ? error.message : "feishu_cli_proxy_unavailable" }); }
    return true;
  }
  async handleProxy(req, res) {
    let write = null;
    try {
      if (this.closed || req.headers.origin) throw new ProxyError(403, "native_cli_proxy_required");
      if (req.method === "GET" && (req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"])) throw new ProxyError(400, "feishu_cli_read_body_denied");
      if (own(req, "feishu-target") !== this.upstream.origin) throw new ProxyError(403, "feishu_cli_target_denied");
      const path = safePath(own(req, "feishu-path"));
      // A companion read exists only while its action is configured, so a
      // read-only deployment keeps exactly the read surface it has today.
      const isRead = readOperationAllowed(req.method, path) ||
        this.sourceAccess.cliWriteActions.some(action => feishuCliWriteCompanionRead(action, req.method, path));
      const grantToken = own(req, "feishu-write-grant");
      if (isRead && grantToken !== undefined) throw new ProxyError(403, "feishu_cli_write_grant_not_applicable");
      // Refuse anything no configured action could ever target, before any
      // grant lookup. A write is reachable only at an enabled action endpoint.
      const writeAction = isRead ? null : this.sourceAccess.cliWriteActions.find(action => feishuCliWriteEndpoint(action, req.method, path));
      if (!isRead && !writeAction) throw new ProxyError(405, "feishu_cli_method_denied");
      // A deletion is its path; a body on one is not a request anyone approved.
      if (req.method === "DELETE" && (req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"])) throw new ProxyError(400, "feishu_cli_delete_body_denied");
      const contentType = req.headers["content-type"] || "";
      const multipart = Boolean(writeAction) && (feishuCliWriteIsMultipart(writeAction) || feishuCliWriteStepIsMultipart(writeAction, path));
      if (BODY_METHODS.includes(req.method) && (multipart ? !contentType.startsWith("multipart/form-data;") : contentType.split(";")[0] !== "application/json")) {
        throw new ProxyError(415, multipart ? "feishu_cli_multipart_required" : "feishu_cli_json_required");
      }
      const token = bearer(req);
      let who, grant; try { ({ who, grant } = this.sourceAccess.current(token)); } catch { throw new ProxyError(403, "feishu_cli_proxy_denied"); }
      if (who.cliBridge !== true) throw new ProxyError(403, "feishu_cli_proxy_denied");
      const person = `${who.tenantId}\n${who.userId}`, held = this.holding.get(person) ?? 0;
      this.counters.calls += 1;
      const busy = this.active >= this.maxConcurrent ? "server" : held >= this.maxConcurrentPerUser ? "person" : null;
      if (busy) { this.counters.busy[busy] += 1; throw new ProxyError(429, "feishu_cli_proxy_busy"); }
      this.active++; this.holding.set(person, held + 1);
      const controller = new AbortController(), cancel = () => controller.abort(); res.once("close", cancel);
      try {
        const body = BODY_METHODS.includes(req.method) ? await readBody(req, writeAction ? feishuCliWriteMaxBytes(writeAction) : MAX_REQUEST_BYTES) : Buffer.alloc(0);
        // A semantic read still has to look like the one operation it names.
        const semantic = feishuCliSemanticRead(req.method, path);
        if (semantic) {
          try { validateFeishuCliSemanticRead(semantic, body); } catch { throw new ProxyError(400, "feishu_cli_search_request_denied"); }
        }
        if (!isRead) write = this.consume(token, grantToken, req.method, path, body, contentType);
        const response = await this.fetch(this.upstream.url(path), { method: req.method, redirect: "error", signal: AbortSignal.any([controller.signal, grant.controller.signal, AbortSignal.timeout(30_000)]),
          headers: { authorization: `Bearer ${grant.token.toString("utf8")}`, "accept-encoding": "identity", ...(req.headers.accept ? { accept: req.headers.accept } : {}), ...(body.length ? { "content-type": contentType } : {}) }, ...(body.length ? { body } : {}) });
        this.sourceAccess.current(token, grant);
        // Only an accepted response is a finished outcome. A redirect or a
        // bodiless reply is rejected first so the audit cannot claim success.
        if (response.redirected || !response.body) throw new ProxyError(502, "feishu_cli_upstream_invalid");
        const headers = { "cache-control": "no-store" }; for (const name of ["content-type", "content-length", "etag", "last-modified", "content-range"]) { const value = response.headers.get(name); if (value) headers[name] = value; }
        // A sequence step's answer is read whole: the next step depends on it.
        if (write?.step) {
          const answer = await readUpstream(response, MAX_STEP_RESPONSE_BYTES), finished = write.step === "finish";
          this.settleStep(write, response.status, answer);
          if (finished) this.record("upstream_finished", write.who, write.intent, { status: response.status });
          write = null;
          headers["content-length"] = String(answer.length);
          res.writeHead(response.status, headers); res.end(answer);
          return true;
        }
        if (write) { this.record("upstream_finished", write.who, write.intent, { status: response.status }); write = null; }
        res.writeHead(response.status, headers);
        for await (const chunk of response.body) { if (!res.write(chunk)) await new Promise(resolve => res.once("drain", resolve)); }
        res.end();
      } finally {
        res.off("close", cancel); controller.abort(); this.active--;
        const left = (this.holding.get(person) ?? 1) - 1;
        if (left > 0) this.holding.set(person, left); else this.holding.delete(person);
      }
    } catch (error) {
      // A dispatched write whose outcome was never observed stays unknown; the
      // grant is already spent, so nothing here can reissue it.
      if (write?.step) { write.saved.busy = false; this.grants.delete(write.key); }
      if (write) this.record("outcome_unknown", write.who, write.intent, { reason: error instanceof ProxyError ? error.message : "upstream_unavailable" });
      const status = error instanceof ProxyError ? error.status : 502;
      req.resume(); if (!res.headersSent) send(res, status, feishuCliRefusal(status, error instanceof ProxyError ? error.message : "feishu_cli_proxy_unavailable")); else res.destroy();
    }
    return true;
  }
  async handle(req, res) {
    if (req.url === WRITE_GRANT_ROUTE) return this.handleGrant(req, res);
    if (req.url === PROXY_ROUTE) return this.handleProxy(req, res);
    return false;
  }
  // For the metrics listener: how full the proxy is and how often it was busy.
  capacity() {
    return { active: this.active, maxConcurrent: this.maxConcurrent, maxConcurrentPerUser: this.maxConcurrentPerUser, people: this.holding.size,
      calls: this.counters.calls, busy: { ...this.counters.busy } };
  }
  close() { this.closed = true; this.grants.clear(); this.operations.clear(); }
}

export const feishuCliProxyContract = Object.freeze({ proxyRoute: PROXY_ROUTE, writeGrantRoute: WRITE_GRANT_ROUTE, maxRequestBytes: MAX_REQUEST_BYTES, maxGrantBytes: MAX_GRANT_BYTES, grantTtlMs: GRANT_TTL_MS });
