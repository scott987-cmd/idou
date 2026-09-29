import { randomBytes, createHash } from "node:crypto";
import { scheduleFeishuRequestAllowed } from "./schedule-capability.js";
import { feishuCliRefusal } from "../providers/feishu/openapi.js";
import { ownHeader, ownHeaderName } from "../product-names.js";

// The one address a sandboxed scheduled task can reach, and the reason it can
// hold no credential of its own. The container asks; this attaches the identity
// and answers. What a compromised sandbox then has is the ability to ask during
// its own run -- not the credential to ask with, and nothing after the run ends.
//
// Two properties make that worth anything, and both come from where this runs
// rather than from what it checks:
//
//   * It is outside the sandbox. A policy the sandbox could rewrite would not be
//     a policy, so the container gets a network with exactly this on it and the
//     decisions happen here.
//   * The run token is not a session token. It is minted per run, dies with the
//     run, and maps to a person only through this table -- so it cannot be
//     replayed afterwards and cannot be presented anywhere else.
//
// This version is read-only on purpose. Writing to Feishu needs a confirmed,
// single-use grant, and the person who would confirm it is by definition not
// there. Until that is designed, a scheduled task reads and reports.
const digest = (value) => createHash("sha256").update(value).digest("hex");

class EgressError extends Error { constructor(status, message) { super(message); this.status = status; } }
// x-idou-* or, from an image built before the rename, x-mydoubao-* (product-names.js).
const own = (req, suffix) => { try { return ownHeader(req.headers, suffix); } catch { throw new EgressError(400, "sandbox_egress_header_conflict"); } };

const bearerToken = (req) => {
  const header = req.headers.authorization;
  return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : undefined;
};

// Named like the other control-plane routes it sits beside in the same handler
// chain (`/v1/feishu/cli-proxy`, `/v1/feishu/cli-write-grants`).
export const EGRESS_ROUTE = "/v1/sandbox/egress";
// The two routes a sandbox needs to be a real agent rather than a data fetcher.
// Deliberately the same paths their upstreams use, because the things calling
// them -- the CLI sidecar and Codex -- already speak exactly that wire format;
// one protocol to reason about rather than a translation layer per client.
export const CLI_PROXY_ROUTE = "/v1/feishu/cli-proxy";
export const MODEL_ROUTE = "/v1/responses";
// Counted per route, not per service: one runaway task must not be able to
// starve the other things a sandbox legitimately does at the same time.
const LIMITS = Object.freeze({ [EGRESS_ROUTE]: 8, [CLI_PROXY_ROUTE]: 8, [MODEL_ROUTE]: 4 });
// Model calls a run may make when its grant names no limit of its own.
const DEFAULT_MODEL_BUDGET = 120;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// How often a run is asked about again while an answer is streaming to it.
const STREAM_RECHECK_MS = 1000;

// Reads a forwarded request body under a cap. Written here rather than reused
// from the CLI proxy because that one is not exported -- and because a body this
// service relays has to be bounded before it is buffered: a sandbox is exactly
// the thing that might send a body large enough to matter.
async function readBody(req, maxBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new EgressError(413, "sandbox_egress_request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Read paths only, and only the families a scheduled task actually needs. A
// write reaches Feishu through a confirmed single-use grant or not at all, and
// there is nobody present to confirm one, so nothing here can carry it.
const READABLE = [
  /^\/open-apis\/im\/v1\/(chats|messages)(\?|$)/,
  /^\/open-apis\/im\/v1\/messages\/[A-Za-z0-9_-]{1,64}(\?|$)/,
  /^\/open-apis\/docx\/v1\/documents\/[A-Za-z0-9_-]{1,128}(\/(raw_content|blocks))?(\?|$)/,
  /^\/open-apis\/wiki\/v2\/spaces(\/[A-Za-z0-9_-]{1,64}(\/nodes)?)?(\?|$)/,
  /^\/open-apis\/drive\/v1\/files(\?|$)/,
  /^\/open-apis\/sheets\/v3\/spreadsheets\/[A-Za-z0-9_-]{1,128}(\/sheets)?(\?|$)/,
  /^\/open-apis\/authen\/v1\/user_info$/,
];

const safePath = (value) => {
  // Anchored, no traversal, no scheme, no host: this decides what is fetched, so
  // a path that could be read two ways is refused rather than normalised.
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("..") || /[\s\\]|%2e%2e/i.test(value)) return null;
  return value;
};

export class SandboxEgressService {
  constructor({ sourceAccess, schedules, sessions = null, controlPlaneOrigin = null, fetchImpl = fetch, now = Date.now, audit = () => {} }) {
    // Started without Feishu source access it refuses every call, rather than
    // refusing to start. A component that vanishes on a control plane without
    // login is the hardest state to diagnose; one that is present and says why
    // it cannot act is not.
    if (sourceAccess === undefined) throw new Error("Sandbox egress needs to be told whether Feishu source access exists");
    // Reads go to the deployment the credentials belong to, and nowhere else.
    if (sourceAccess && !sourceAccess.feishu?.openApi) throw new Error("Sandbox egress needs a Feishu deployment that speaks OpenAPI");
    Object.assign(this, { sourceAccess, schedules, sessions, controlPlaneOrigin, fetch: fetchImpl, now, audit });
    this.runs = new Map(); this.closed = false;
    // Counted per route rather than per service, so one runaway task cannot
    // starve the other things a sandbox legitimately does at the same time.
    this.active = new Map();
  }

  #enter(route) {
    const running = this.active.get(route) ?? 0;
    if (running >= LIMITS[route]) throw new EgressError(429, "sandbox_egress_busy");
    this.active.set(route, running + 1);
  }
  #leave(route) { this.active.set(route, Math.max(0, (this.active.get(route) ?? 1) - 1)); }

  // Minted when a run starts, revoked when it ends. `parentToken` is the live
  // session the run borrows for its lifetime; holding the token here rather than
  // in the container is the whole point.
  // Whether this run is still authorized, asked again on every single call.
  //
  // The run entry holds a snapshot of the schedule it was opened for, which is
  // right for deciding what it is -- and wrong for deciding whether it may still
  // act. Deleting a schedule mid-run left the container reading the person's
  // documents until it finished, and suspending one did the same: the store that
  // knows both was injected into this service and then never consulted. A
  // dependency that is wired and never called is the shape this product has been
  // caught by before.
  //
  // The store may be the shared database (schedule-store-postgres.js), so this
  // is awaited; one that cannot be reached right now refuses the call as
  // unavailable -- never lets it through unasked.
  async #authorized(run) {
    if (!this.schedules) return;
    const who = { tenantId: run.schedule.tenant, userId: run.schedule.owner };
    let current = null;
    try { current = await this.schedules.get(who, run.schedule.id); }
    catch { throw new EgressError(503, "sandbox_egress_schedule_unavailable"); }
    if (!current) throw new EgressError(403, "sandbox_egress_schedule_revoked");
    if (current.suspendedAt) throw new EgressError(403, "sandbox_egress_schedule_suspended");
    if ((current.cancellationRevision ?? 0) !== (run.schedule.cancellationRevision ?? 0)) {
      throw new EgressError(403, "sandbox_egress_schedule_cancelled");
    }
    // Tiny injected stores used by transport-level tests predate capability
    // fields. A real ScheduleStore always returns the field (null for migrated
    // legacy rows), so only literal `undefined` is the compatibility seam.
    if (current.capability !== undefined || run.schedule.capability !== undefined) {
      if (!current.capability || current.capabilityDigest !== run.schedule.capabilityDigest ||
          current.capabilityRevision !== run.schedule.capabilityRevision) {
        throw new EgressError(403, "sandbox_egress_capability_changed");
      }
      if (current.capability.providerId !== run.schedule.capability?.providerId ||
          current.capability.tenantId !== run.schedule.tenant || current.capability.ownerId !== run.schedule.owner) {
        throw new EgressError(403, "sandbox_egress_capability_mismatch");
      }
      if (current.capability.validUntil !== null && current.capability.validUntil <= this.now()) {
        throw new EgressError(403, "sandbox_egress_capability_expired");
      }
    }
    // When it was last found still allowed: what a streaming answer asks from.
    run.checkedAt = this.now();
  }

  #allowFeishu(run, method, path, body = null) {
    // Tests that instantiate egress without a store exercise token transport in
    // isolation. Production always supplies the schedule store; only that path
    // may authorize a Feishu resource.
    if (!this.schedules || run.schedule.capability === undefined) return;
    if (!this.sourceAccess || run.schedule.capability?.providerId !== this.sourceAccess.feishu.id) {
      throw new EgressError(403, "sandbox_egress_provider_mismatch");
    }
    if (!scheduleFeishuRequestAllowed(run.schedule.capability, method, path, body)) {
      throw new EgressError(403, "sandbox_egress_resource_denied");
    }
  }

  open({ parentToken, schedule, runId, ttlMs }) {
    if (this.closed) throw new Error("沙箱出口已关闭");
    if (this.runs.size >= 64) throw new Error("同时运行的沙箱过多");
    const token = randomBytes(32).toString("base64url");
    // The model credential is minted once per run rather than per request: it is
    // a leaf that cannot mint anything further, and issuing one per call would
    // spend the per-parent lease cap on a single task.
    const model = this.sessions ? this.sessions.issueForSandboxRun(parentToken).token : null;
    const key = digest(token);
    // The map key is kept on the entry itself so a run can be retired from a
    // path that holds the entry but not the token it arrived under. Without it
    // the "login gone, drop this run" step deleted nothing at all.
    this.runs.set(key, { key, parentToken, schedule, runId, calls: 0, modelCalls: 0, model,
      expiresAt: this.now() + Math.min(Math.max(Number(ttlMs) || 0, 60_000), 30 * 60_000) });
    return token;
  }
  close(token) { if (token) this.runs.delete(digest(token)); }
  // How much of its model budget a run used, read by the runner before it closes
  // the token: a run that ran out of model calls exits like any other failure,
  // and the history should say which failure it was. Counts only, never content.
  usage(token) {
    const run = typeof token === "string" ? this.runs.get(digest(token)) : undefined;
    if (!run) return null;
    return { modelCalls: run.modelCalls ?? 0, modelBudget: run.schedule.capability?.limits?.modelCalls ?? DEFAULT_MODEL_BUDGET,
      modelBudgetSpent: run.modelBudgetSpent === true };
  }
  closeAll() { this.closed = true; this.runs.clear(); }

  prune() { const at = this.now(); for (const [key, run] of this.runs) if (run.expiresAt <= at) this.runs.delete(key); }

  #run(token) {
    this.prune();
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new EgressError(403, "sandbox_run_token_required");
    // Looked up by digest, never compared against the token itself. That is what
    // makes a timing comparison unnecessary here rather than merely skipped: the
    // map is keyed by SHA-256 of the token, so what a caller could time is the
    // lookup of a hash they cannot invert, and no byte of any live token is
    // examined. An earlier line here called timingSafeEqual on the key against
    // itself -- always true, therefore no check at all, and worse than none
    // because it read as one.
    const key = digest(token), run = this.runs.get(key);
    if (!run) throw new EgressError(403, "sandbox_run_token_invalid");
    if (run.expiresAt <= this.now()) { this.runs.delete(key); throw new EgressError(403, "sandbox_run_finished"); }
    return run;
  }

  // Forwards a sandbox's request to a control-plane route that is not ours,
  // swapping the run token for the credential that route actually expects. The
  // swap is the whole service: what arrives is a token that dies with the run,
  // what leaves is an identity the sandbox never sees.
  async #forward(req, res, { route, run, bearer, upstream, maxBytes, body: suppliedBody = undefined }) {
    this.#enter(route);
    const controller = new AbortController(), cancel = () => controller.abort();
    res.once("close", cancel);
    try {
      const body = suppliedBody !== undefined ? suppliedBody : req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, maxBytes);
      await this.#authorized(run);
      const headers = { authorization: `Bearer ${bearer}` };
      // Only the headers the upstream route needs to do its job. Anything the
      // sandbox invented is dropped rather than relayed -- including a second
      // authorization header, which is the obvious way to try to smuggle one.
      // Our own headers go on under one spelling, with the value read here
      // (and, for the path, checked here): never both, which could say two things.
      for (const suffix of ["feishu-target", "feishu-path", "feishu-write-grant"]) {
        const value = own(req, suffix);
        if (typeof value === "string") headers[ownHeaderName(suffix)] = value;
      }
      for (const name of ["content-type", "accept",
        "x-lark-proxy-version", "x-lark-proxy-target", "x-lark-proxy-identity", "x-lark-proxy-signature",
        "x-lark-proxy-timestamp", "x-lark-body-sha256", "x-lark-proxy-auth-header"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const response = await this.fetch(`${upstream}${route}`, { method: req.method, redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]), headers, ...(body?.length ? { body } : {}) });
      if (response.redirected) throw new EgressError(502, "sandbox_egress_upstream_invalid");
      await this.#authorized(run);
      const out = { "cache-control": "no-store" };
      for (const name of ["content-type", "content-length"]) { const value = response.headers.get(name); if (value) out[name] = value; }
      res.writeHead(response.status, out);
      // Streamed rather than buffered: a model answer arrives as server-sent
      // events and a task that had to wait for the last token would look hung.
      // Asked again while the answer streams, at most once a second: a task
      // deleted or paused mid-answer is cut off within that, without a store
      // read for every chunk of every answer.
      if (response.body) for await (const chunk of response.body) {
        if (this.now() - (run.checkedAt ?? 0) >= STREAM_RECHECK_MS) await this.#authorized(run);
        if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
      }
      res.end();
      this.#record(run, route, response.status, Number(response.headers.get("content-length")) || 0);
    } finally { res.off("close", cancel); controller.abort(); this.#leave(route); }
  }

  async handle(req, res) {
    if (req.url === CLI_PROXY_ROUTE) return this.#handleCli(req, res);
    if (req.url === MODEL_ROUTE) return this.#handleModel(req, res);
    if (req.url !== EGRESS_ROUTE) return false;
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      // A browser can never be the caller: this is reached from a container on a
      // private network, and an Origin header means something else is asking.
      if (this.closed || req.headers.origin) throw new EgressError(403, "sandbox_egress_denied");
      if (req.method !== "GET") throw new EgressError(405, "sandbox_egress_read_only");
      if (req.headers["content-length"] && req.headers["content-length"] !== "0" || req.headers["transfer-encoding"]) throw new EgressError(400, "sandbox_egress_body_denied");

      const runToken = own(req, "run");
      const run = this.#run(runToken);
      const path = safePath(own(req, "feishu-path"));
      if (!path) throw new EgressError(400, "sandbox_egress_path_invalid");
      if (!READABLE.some((shape) => shape.test(path))) throw new EgressError(405, "sandbox_egress_read_only");
      await this.#authorized(run);
      this.#allowFeishu(run, "GET", path);
      const limit = run.schedule.capability?.limits?.feishuCalls ?? 200;
      if (run.calls >= limit) throw new EgressError(429, "sandbox_egress_call_limit");

      // The credential is fetched per call and never held by the run: if the
      // person's login lapsed mid-run, the next call stops here.
      let who, grant;
      try { ({ who, grant } = this.sourceAccess.current(run.parentToken)); }
      catch { this.runs.delete(digest(runToken)); throw new EgressError(403, "sandbox_egress_login_gone"); }
      if (who.tenantId !== run.schedule.tenant || who.userId !== run.schedule.owner) throw new EgressError(403, "sandbox_egress_login_mismatch");

      run.calls += 1; this.#enter(EGRESS_ROUTE);
      const controller = new AbortController(), cancel = () => controller.abort();
      res.once("close", cancel);
      try {
        const response = await this.fetch(this.sourceAccess.feishu.openApi.url(path), { method: "GET", redirect: "error",
          signal: AbortSignal.any([controller.signal, grant.controller.signal, AbortSignal.timeout(30_000)]),
          headers: { authorization: `Bearer ${grant.token.toString("utf8")}`, "accept-encoding": "identity" } });
        // Re-checked after the call with the very same grant object: a login that
        // rotated or was revoked mid-flight does not get to return a body.
        this.sourceAccess.current(run.parentToken, grant);
        if (response.redirected || !response.body) throw new EgressError(502, "sandbox_egress_upstream_invalid");
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length > MAX_RESPONSE_BYTES) throw new EgressError(502, "sandbox_egress_response_too_large");
        await this.#authorized(run);
        this.#record(run, path, response.status, body.length);
        res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json",
          "content-length": String(body.length), "cache-control": "no-store" });
        res.end(body);
      } finally { res.off("close", cancel); controller.abort(); this.#leave(EGRESS_ROUTE); }
    } catch (error) {
      req.resume();
      if (!res.headersSent) send(error instanceof EgressError ? error.status : 502, { error: error instanceof EgressError ? error.message : "sandbox_egress_unavailable" });
      else res.destroy();
    }
    return true;
  }

  // The in-container CLI sidecar, forwarding under the person's own session so
  // the existing Feishu proxy applies its usual rules -- including that a write
  // still needs a confirmed single-use grant, which an unattended task has no
  // way to obtain. Nothing here relaxes that; it only carries the request.
  async #handleCli(req, res) {
    try {
      if (this.closed || req.headers.origin) throw new EgressError(403, "sandbox_egress_denied");
      if (!this.controlPlaneOrigin) throw new EgressError(503, "sandbox_egress_not_configured");
      // The sidecar sends its token as a Bearer, because that is how it talks to
      // the control plane's own CLI proxy. Accepting it here is what lets that
      // client be reused inside the sandbox without editing a line of it.
      const run = this.#run(own(req, "run") ?? bearerToken(req));
      const { who } = this.#identity(run);
      if (who.tenantId !== run.schedule.tenant || who.userId !== run.schedule.owner) throw new EgressError(403, "sandbox_egress_login_mismatch");
      await this.#authorized(run);
      const path = safePath(own(req, "feishu-path"));
      if (!path) throw new EgressError(400, "sandbox_egress_path_invalid");
      const body = req.method === "GET" || req.method === "HEAD" ? Buffer.alloc(0) : await readBody(req, 4 * 1024 * 1024);
      this.#allowFeishu(run, req.method, path, body);
      const limit = run.schedule.capability?.limits?.feishuCalls ?? 400;
      if (run.calls >= limit) throw new EgressError(429, "sandbox_egress_call_limit");
      run.calls += 1;
      await this.#forward(req, res, { route: CLI_PROXY_ROUTE, run, bearer: run.parentToken,
        upstream: this.controlPlaneOrigin, maxBytes: 4 * 1024 * 1024, body });
    } catch (error) { this.#fail(req, res, error, feishuCliRefusal); }
    return true;
  }

  // Codex inside the sandbox, reaching the model under the run's own credential
  // rather than the desktop's -- a separate session id, so a task that runs away
  // cannot push the person's own conversation into the gateway's rate limit.
  async #handleModel(req, res) {
    try {
      if (this.closed || req.headers.origin) throw new EgressError(403, "sandbox_egress_denied");
      if (!this.controlPlaneOrigin) throw new EgressError(503, "sandbox_egress_not_configured");
      if (req.method !== "POST") throw new EgressError(405, "method_not_allowed");
      // Codex sends the run token as a Bearer, because that is how its auth
      // command feeds it -- the same reason the CLI route accepts one. Both
      // clients here are reused unchanged, so both spellings are read.
      const run = this.#run(own(req, "run") ?? bearerToken(req));
      if (!run.model) throw new EgressError(403, "sandbox_model_not_available");
      // A run whose login lapsed must lose the model as well as Feishu, or it
      // could keep burning quota after its owner is gone. Where there is no
      // Feishu source access there is nothing of that kind to consult -- and
      // nothing to consult it about: the model credential is minted from the
      // session and dies with it, and the run token dies with the run. Asking
      // anyway is what made every model call on such a server fail, which is the
      // same mistake as treating "cannot reach Feishu" as "cannot work".
      if (this.sourceAccess) this.#identity(run);
      await this.#authorized(run);
      // Its own budget. Concurrency was capped and the count was not, so a task
      // caught in a loop could spend without limit on a route where every call
      // is a paid one. Counted separately from the read routes because these are
      // not the same kind of spend.
      run.modelCalls = (run.modelCalls ?? 0) + 1;
      if (run.modelCalls > (run.schedule.capability?.limits?.modelCalls ?? DEFAULT_MODEL_BUDGET)) {
        // Recorded, unlike other refusals: it is the one that ends a run, and an
        // audit that shows only the calls that went through reads as a run that
        // stopped for no reason.
        run.modelBudgetSpent = true;
        this.#record(run, MODEL_ROUTE, 429, 0);
        throw new EgressError(429, "sandbox_egress_model_budget");
      }
      await this.#forward(req, res, { route: MODEL_ROUTE, run, bearer: run.model,
        upstream: this.controlPlaneOrigin, maxBytes: 1024 * 1024 });
    } catch (error) { this.#fail(req, res, error); }
    return true;
  }

  // A run whose login has lapsed is retired on the spot rather than left to
  // expire: it has nothing left to act as, and every later call would fail the
  // same way while the token stayed usable-looking.
  #identity(run) {
    if (!this.sourceAccess) throw new EgressError(503, "sandbox_egress_no_login");
    try { return this.sourceAccess.current(run.parentToken); }
    catch { this.runs.delete(run.key); throw new EgressError(403, "sandbox_egress_login_gone"); }
  }

  // The CLI route answers in Feishu's own error envelope, because the CLI's
  // SDK reads it: "outside what this task was granted" is exactly what a run
  // needs to be told, and a bare {"error": ...} reached it as "SDK returned an
  // invalid JSON response". The model route keeps its shape for Codex.
  #fail(req, res, error, shape = (status, reason) => ({ error: reason })) {
    req.resume();
    if (!res.headersSent) {
      const status = error instanceof EgressError ? error.status : 502;
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(shape(status, error instanceof EgressError ? error.message : "sandbox_egress_unavailable")));
    } else res.destroy();
  }

  // What a scheduled task reached, without what it read: the path family and the
  // size, never the body, the token or the document's text.
  #record(run, path, status, bytes) {
    try {
      this.audit(Object.freeze({ kind: "sandbox_egress", at: this.now(), runId: run.runId,
        scheduleHash: digest(`${run.schedule.tenant}\n${run.schedule.id}`), path: path.split("?")[0], status, bytes, calls: run.calls,
        modelCalls: run.modelCalls ?? 0 }));
    } catch { /* An audit sink failure must not change what was already allowed. */ }
  }
}
