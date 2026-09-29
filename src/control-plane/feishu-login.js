import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { validateServerUrl } from "./client-session.js";
import { loginProofMessage, loginReturnPort, loginReturnUrl } from "./login-proof.js";
import { openResume, resumeDigest, resumeProofMessage, sealResume } from "./resume-credential.js";
import { EITHER, WRITTEN } from "../product-names.js";

const OAUTH_COOKIE = new RegExp(`^${EITHER}_oauth=(.*)$`, "s");

const random = () => randomBytes(32).toString("base64url");
const digest = (value) => createHash("sha256").update(value).digest("base64url");
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const ROUTES = new Set(["/auth/feishu/begin", "/auth/feishu/launch", "/auth/feishu/callback", "/auth/feishu/complete", "/auth/feishu/cancel", "/auth/session", "/auth/logout", "/auth/session/renew-begin", "/auth/session/renew", "/auth/feishu/resume-challenge", "/auth/feishu/resume",
  "/auth/feishu/web-identity/begin", "/auth/feishu/web-identity/status"]);
// What the callback page says. It is only ever seen by whoever is looking at the
// browser that followed the redirect, and says nothing about who anyone is. A
// sign-in that was authorized has no page here: that browser is sent back to
// the device instead (see begin), which says the same thing.
const CALLBACK_PAGES = Object.freeze({
  verified: [200, "网页账号与应用登录一致，可以关闭这个页面。"],
  conflict: [403, "这个网页里登录的飞书账号，与应用里登录的不是同一个人。"],
  declined: [403, "授权没有完成，请返回应用重试。"],
  probe_failed: [403, "网页账号未能核对，请返回应用重试。"],
  granted: [200, "已为定时任务单独授权，可以关闭这个页面。"],
  no_refresh: [403, "飞书没有签发长效凭据，没有开启。请返回应用查看原因。"],
  grant_failed: [403, "授权没有保存下来，请返回应用重试。"],
});
// A dedicated authorization lives as long as a sign-in does.
const GRANT_MS = 300_000, GRANTS_PER_WINDOW = 5;
// A web-identity probe lives as long as a person might take to click 授权 on a
// page they were just shown, and no longer.
const PROBE_MS = 180_000, PROBE_WINDOW_MS = 600_000, PROBES_PER_WINDOW = 10;
class LoginError extends Error { constructor(status, code) { super(code); this.status = status; } }
function send(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff", ...headers });
  res.end(JSON.stringify(value));
}
// Every login request is small except one: redeeming a durable credential
// carries the sealed blob, which holds a Feishu refresh token and is measured in
// kilobytes. The tight limit stays everywhere else.
const MAX_BODY_BYTES = 2048, MAX_RESUME_BODY_BYTES = 24576;
async function body(req, limit = MAX_BODY_BYTES) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json" || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) throw new LoginError(415, "json_required");
  const chunks = []; let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { bytes += chunk.length; if (bytes > limit) throw new LoginError(413, "login_request_too_large"); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks)); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; }
  catch { throw new LoginError(400, "invalid_login_request"); }
}

// Logins under way (each waits up to five minutes for the person in the
// browser) and resume challenges outstanding, on the whole server: memory
// bounds for two routes anybody can call, sized for a morning when many
// thousands sign in at once. The pilot's hundred, and twenty, turned people
// away (docs/scaling-plan.md). How many may start a minute is the server's
// capacity (IDOU_LOGINS_PER_MINUTE).
export const LOGIN_FLOWS_MAX = 20_000;
export const RESUME_CHALLENGES_MAX = 20_000;

export class FeishuLoginService {
  constructor({ origin, provider, sessions, allowedTenants, now = Date.now, capacity: { perMinute = 1200 } = {} }) {
    this.origin = validateServerUrl(origin); this.redirectUri = `${this.origin}/auth/feishu/callback`;
    if (!Array.isArray(allowedTenants) || !allowedTenants.length || allowedTenants.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new Error("Explicit Feishu tenant allowlist is required");
    this.allowedTenants = new Set(allowedTenants); this.provider = provider; this.sessions = sessions; this.now = now;
    if (!Number.isSafeInteger(perMinute) || perMinute < 1) throw new Error("Invalid login rate");
    this.loginsPerMinute = perMinute;
    this.flows = new Map(); this.starts = []; this.closed = false;
    this.probeStarts = new Map();
    this.grantStarts = new Map();
    // Resume challenges: single use, short lived. A replayed signature is
    // worthless once its nonce is gone.
    this.resumeChallenges = new Map();
    this.pruner = setInterval(() => this.prune(), 30_000); this.pruner.unref();
  }
  discard(identity) { this.provider.sourceAccess?.discard(identity); this.provider.renewal?.discard(identity); }
  prune() {
    for (const [id, flow] of this.flows) if (flow.expiresAt <= this.now()) { flow.controller?.abort(); this.discard(flow.identity); this.flows.delete(id); }
    for (const starts of [this.probeStarts, this.grantStarts]) {
      for (const [family, times] of starts) if (!times.some((time) => time > this.now() - PROBE_WINDOW_MS)) starts.delete(family);
    }
    this.provider.sourceAccess?.prune(); this.provider.renewal?.prune();
  }
  // A sign-in is completed by the device that began it -- the one holding the
  // key -- and, since 2026-09-27, only with a secret the browser that
  // authorized it hands that device. Before, the launch link worked in anyone's
  // browser and the session went to whoever began the sign-in: sending someone
  // the link, and their one click on 授权, gave the sender that person's
  // account. Now the authorized browser is redirected to the loopback port the
  // device named here (RFC 8252 §7.3), so the secret reaches the machine the
  // browser runs on and nobody else's. A desktop that names no port predates
  // this and is told to update: signing in without one is exactly what the
  // attack needs.
  begin(publicKey, returnPort) {
    this.prune(); this.starts = this.starts.filter((time) => time > this.now() - 60_000);
    if (this.closed || this.flows.size >= LOGIN_FLOWS_MAX || this.starts.length >= this.loginsPerMinute) throw new LoginError(429, "login_limit_reached");
    let key;
    try {
      if (typeof publicKey !== "string" || publicKey.length > 200) throw new Error();
      const der = Buffer.from(publicKey, "base64url"); key = createPublicKey({ key: der, format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ed25519" || key.export({ format: "der", type: "spki" }).toString("base64url") !== publicKey) throw new Error();
    } catch { throw new LoginError(400, "ed25519_public_key_required"); }
    if (returnPort === undefined || returnPort === null) throw new LoginError(400, "client_update_required");
    if (!loginReturnPort(returnPort)) throw new LoginError(400, "invalid_login_request");
    const flowId = random(), nonce = random(), state = random(), verifier = random();
    const flow = { kind: "login", flowId, nonce, state, verifier, key, deviceId: digest(publicKey), returnPort, status: "pending", expiresAt: this.now() + 300_000, lastPoll: 0 };
    this.flows.set(flowId, flow); this.starts.push(this.now());
    return { flowId, nonce, expiresAt: flow.expiresAt, launchUrl: `${this.origin}/auth/feishu/launch?flow=${flowId}` };
  }
  getFlow(id) { this.prune(); const flow = this.flows.get(id); if (!flow) throw new LoginError(400, "login_expired_or_invalid"); return flow; }
  // Named with the product's name (product-names.js); a callback carrying it
  // under either spelling is read, as long as it carries exactly one.
  cookie(value, maxAge = 300) { return `${WRITTEN}_oauth=${value}; Path=/auth/feishu/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.origin.startsWith("https:") ? "; Secure" : ""}`; }
  // A flow may be launched more than once, so someone whose browser did not open
  // — or opened the wrong one — can retry with the same link instead of starting
  // over. Each launch mints a fresh cookie and replaces the previous binding, so
  // exactly one browser can ever complete the callback and a stale tab is
  // refused. Once a callback has been accepted the flow is past "launched" and
  // cannot be relaunched at all.
  launch(id) {
    const flow = this.getFlow(id); if (!["pending", "launched"].includes(flow.status)) throw new LoginError(409, "login_already_started");
    const cookie = random(); flow.cookieHash = digest(cookie); flow.status = "launched";
    // A probe asks for less than a login: no offline_access (see probeIdentity).
    const scopes = flow.kind === "web-identity" ? this.provider.probeScopes : undefined;
    return { cookie: this.cookie(cookie), url: this.provider.authorizationUrl({ redirectUri: this.redirectUri, state: flow.state, challenge: digest(flow.verifier), scopes }) };
  }
  // Which Feishu account the desktop's embedded web pages are signed in as,
  // compared with the account this session belongs to. The desktop opens the
  // launch URL inside the same browser partition as those pages; Feishu's
  // authorize page answers for whoever is signed in there, and the code comes
  // back to this server, which alone can redeem it. The answer is a verdict and
  // nothing else: the other account's identifiers are neither kept nor
  // returned, and no session, grant or credential results from a probe.
  beginWebIdentity(session) {
    this.prune();
    // The desktop's own root session only. A turn token is readable by the
    // coding agent, which has no business starting probes -- if only because
    // each one spends the person's allowance.
    if (session.parentKey) throw new LoginError(403, "login_audience_required");
    if (this.closed || session.authProvider !== "feishu" || !this.allowedTenants.has(session.tenantId) || typeof this.provider.probeIdentity !== "function") throw new LoginError(403, "web_identity_unavailable");
    const family = session.familyId ?? session.id;
    const recent = (this.probeStarts.get(family) ?? []).filter((time) => time > this.now() - PROBE_WINDOW_MS);
    if (this.flows.size >= LOGIN_FLOWS_MAX || recent.length >= PROBES_PER_WINDOW) throw new LoginError(429, "web_identity_limit_reached");
    const flowId = random(), expiresAt = this.now() + PROBE_MS;
    this.flows.set(flowId, { kind: "web-identity", flowId, state: random(), verifier: random(), status: "pending", expiresAt,
      subject: { tenantId: session.tenantId, userId: session.userId, family } });
    this.probeStarts.set(family, [...recent, this.now()]);
    return { flowId, expiresAt, launchUrl: `${this.origin}/auth/feishu/launch?flow=${flowId}` };
  }
  // Read once. Only the session family that began a probe can read it, and a
  // finished verdict is removed as it is read.
  webIdentityStatus(session, flowId) {
    this.prune();
    if (session.parentKey) throw new LoginError(403, "login_audience_required");
    const flow = opaque(flowId) ? this.flows.get(flowId) : null;
    const family = session.familyId ?? session.id;
    if (!flow || flow.kind !== "web-identity" || flow.subject.family !== family || flow.subject.tenantId !== session.tenantId || flow.subject.userId !== session.userId) throw new LoginError(404, "web_identity_unknown");
    if (["pending", "launched", "exchanging"].includes(flow.status)) return { status: "pending", launched: flow.status !== "pending", expiresAt: flow.expiresAt };
    this.flows.delete(flow.flowId);
    return { status: flow.status, checkedAt: flow.checkedAt };
  }
  // A second, dedicated Feishu authorization, for a credential the server keeps
  // on the person's behalf (unattended schedules). Its own authorization gives it
  // its own refresh-token chain. The first version copied the refresh token the
  // person's live session held instead -- and a refresh token is spent by the
  // first exchange that uses it, so whichever side refreshed first silently
  // killed the other: the desktop's login after the first scheduled run, or the
  // schedule after the desktop's first refresh.
  //
  // `redeemed` receives the new refresh token, and only after Feishu has said
  // the authorization belongs to this session's own person. It is the only place
  // the token goes; the flow keeps what `redeemed` returns and nothing else.
  beginGrant(session, redeemed) {
    this.prune();
    if (session.parentKey) throw new LoginError(403, "login_audience_required");
    if (this.closed || session.authProvider !== "feishu" || !this.allowedTenants.has(session.tenantId) || typeof redeemed !== "function"
      || typeof this.provider.redeem !== "function" || !this.provider.longSessions) throw new LoginError(403, "grant_unavailable");
    const family = session.familyId ?? session.id;
    const recent = (this.grantStarts.get(family) ?? []).filter((time) => time > this.now() - PROBE_WINDOW_MS);
    if (this.flows.size >= LOGIN_FLOWS_MAX || recent.length >= GRANTS_PER_WINDOW) throw new LoginError(429, "grant_limit_reached");
    const flowId = random(), expiresAt = this.now() + GRANT_MS;
    this.flows.set(flowId, { kind: "grant", flowId, state: random(), verifier: random(), status: "pending", expiresAt, redeemed,
      subject: { tenantId: session.tenantId, userId: session.userId, family } });
    this.grantStarts.set(family, [...recent, this.now()]);
    return { flowId, expiresAt, launchUrl: `${this.origin}/auth/feishu/launch?flow=${flowId}` };
  }
  grantStatus(session, flowId) {
    this.prune();
    if (session.parentKey) throw new LoginError(403, "login_audience_required");
    const flow = opaque(flowId) ? this.flows.get(flowId) : null;
    const family = session.familyId ?? session.id;
    if (!flow || flow.kind !== "grant" || flow.subject.family !== family || flow.subject.tenantId !== session.tenantId || flow.subject.userId !== session.userId) throw new LoginError(404, "grant_unknown");
    if (["pending", "launched", "exchanging"].includes(flow.status)) return { status: "pending", launched: flow.status !== "pending", expiresAt: flow.expiresAt };
    this.flows.delete(flow.flowId);
    return { status: flow.status, ...(flow.result ?? {}) };
  }
  async grantCallback(flow, code, failure) {
    if (failure) { flow.status = "declined"; delete flow.verifier; delete flow.redeemed; return flow.status; }
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(code)) throw new LoginError(400, "invalid_authorization_code");
    flow.status = "exchanging"; flow.controller = new AbortController();
    const timeout = AbortSignal.timeout(30_000), signal = AbortSignal.any([timeout, flow.controller.signal]);
    try {
      let redeemed;
      try { redeemed = await this.provider.redeem({ code, verifier: flow.verifier, redirectUri: this.redirectUri, scopes: this.provider.grantScopes, signal }); }
      catch { flow.status = "grant_failed"; return flow.status; }
      if (this.flows.get(flow.flowId) !== flow || flow.expiresAt <= this.now() || signal.aborted) { flow.status = "grant_failed"; return flow.status; }
      const { token, user } = redeemed;
      if (user.tenant_key !== flow.subject.tenantId || user.open_id !== flow.subject.userId) { flow.status = "conflict"; return flow.status; }
      const refreshToken = typeof token.refresh_token === "string" && token.refresh_token.length <= 16384 ? token.refresh_token : "";
      if (!refreshToken) {
        this.provider.diagnostic?.("飞书这次授权没有签发刷新令牌：确认应用已开通 offline_access，且服务端开启了 FEISHU_SESSION_RENEWAL_ENABLED 与 FEISHU_LONG_SESSION_DAYS。");
        flow.status = "no_refresh"; return flow.status;
      }
      try {
        flow.result = await flow.redeemed({ appId: this.provider.appId, tenantId: user.tenant_key, userId: user.open_id, refreshToken });
        flow.status = "granted";
      } catch { flow.status = "grant_failed"; }
      return flow.status;
    } finally { delete flow.verifier; delete flow.controller; delete flow.redeemed; flow.checkedAt = this.now(); }
  }
  async probeCallback(flow, code, failure) {
    if (failure) { flow.status = "declined"; flow.checkedAt = this.now(); delete flow.verifier; return flow.status; }
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(code)) throw new LoginError(400, "invalid_authorization_code");
    flow.status = "exchanging"; flow.controller = new AbortController();
    try {
      const seen = await this.provider.probeIdentity({ code, verifier: flow.verifier, redirectUri: this.redirectUri, signal: flow.controller.signal });
      if (this.flows.get(flow.flowId) !== flow || flow.expiresAt <= this.now() || flow.controller.signal.aborted) throw new Error("Expired probe");
      flow.status = seen.tenantId === flow.subject.tenantId && seen.userId === flow.subject.userId ? "verified" : "conflict";
    } catch { if (this.flows.get(flow.flowId) === flow) flow.status = "probe_failed"; }
    finally { delete flow.verifier; delete flow.controller; flow.checkedAt = this.now(); }
    return flow.status;
  }
  async callback(url, cookieHeader = "") {
    const state = url.searchParams.get("state");
    if (!opaque(state) || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length > 1 || url.searchParams.getAll("error").length > 1) throw new LoginError(400, "invalid_oauth_callback");
    this.prune(); const flow = [...this.flows.values()].find((entry) => entry.state === state);
    const cookies = cookieHeader.split(";").map((part) => part.trim()).map((part) => OAUTH_COOKIE.exec(part)?.[1]).filter((value) => value !== undefined);
    if (!flow || flow.status !== "launched" || cookies.length !== 1 || digest(cookies[0]) !== flow.cookieHash) throw new LoginError(400, "oauth_state_or_browser_mismatch");
    const code = url.searchParams.get("code"), failure = url.searchParams.get("error");
    if (flow.kind === "web-identity") return { status: await this.probeCallback(flow, code, failure) };
    if (flow.kind === "grant") return { status: await this.grantCallback(flow, code, failure) };
    if (failure) { flow.status = "denied"; delete flow.verifier; return { status: "denied" }; }
    if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(code)) throw new LoginError(400, "invalid_authorization_code");
    flow.status = "exchanging"; flow.controller = new AbortController();
    let identity;
    try {
      identity = await this.provider.exchangeCode({ code, verifier: flow.verifier, redirectUri: this.redirectUri, signal: flow.controller.signal });
      if (this.flows.get(flow.flowId) !== flow || flow.expiresAt <= this.now() || flow.controller.signal.aborted) throw new Error("Expired login");
      // A tenant key is the operator's own organisation identifier, not a
      // credential, and it is the one value they cannot look up without a
      // successful authorization. Name it so the first rejected attempt is
      // enough to finish the configuration.
      if (!this.allowedTenants.has(identity.tenantId)) {
        this.provider.diagnostic?.(`飞书租户 ${identity.tenantId} 不在允许列表中。把它填入 FEISHU_ALLOWED_TENANTS 后重新登录即可。`);
        throw new Error("Tenant not allowed");
      }
      if (!identity.userId || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= this.now()) throw new Error("User not allowed");
      // Kept as a digest; the secret itself goes only into the redirect.
      const secret = random();
      flow.identity = identity; flow.completionHash = digest(secret); flow.status = "authorized";
      return { status: "authorized", location: `${loginReturnUrl(flow.returnPort)}?flow=${flow.flowId}&secret=${secret}` };
    } catch { this.discard(identity); if (this.flows.get(flow.flowId) === flow) flow.status = "failed"; return { status: "failed" }; }
    finally { delete flow.verifier; delete flow.controller; }
  }
  prove(flowId, signature, action) {
    const flow = this.getFlow(flowId);
    // A probe has no device key and must never be completed into a session.
    if (flow.kind !== "login") throw new LoginError(400, "login_expired_or_invalid");
    if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(signature) || !verify(null, loginProofMessage(this.origin, flowId, flow.nonce, action), flow.key, Buffer.from(signature, "base64url"))) throw new LoginError(403, "device_key_proof_required");
    return flow;
  }
  // Pending until the device brings the secret its loopback port received. A
  // wrong one ends the sign-in: there is exactly one, minted when Feishu
  // answered, and nothing legitimate ever sends another.
  complete(flowId, signature, secret) {
    const flow = this.prove(flowId, signature, "complete");
    if (["failed", "denied"].includes(flow.status)) { this.flows.delete(flowId); throw new LoginError(403, "feishu_login_denied_or_failed"); }
    if (secret !== undefined && secret !== null && !(flow.status === "authorized" && opaque(secret) && timingSafeEqual(Buffer.from(digest(secret)), Buffer.from(flow.completionHash)))) {
      flow.controller?.abort(); this.discard(flow.identity); this.flows.delete(flowId);
      throw new LoginError(403, "login_completion_mismatch");
    }
    if (flow.status !== "authorized" || secret === undefined || secret === null) {
      if (flow.lastPoll && this.now() - flow.lastPoll < 1000) throw new LoginError(429, "login_poll_too_frequent");
      flow.lastPoll = this.now(); return { status: "pending" };
    }
    this.flows.delete(flowId); // Single-use delivery; a lost response requires a new login.
    const ttlMs = Math.min(15 * 60_000, Math.floor(flow.identity.expiresAt - this.now()));
    if (ttlMs < 1) { this.discard(flow.identity); throw new LoginError(403, "feishu_login_expired"); }
    let issued;
    try {
      issued = this.sessions.issue({ ...flow.identity, deviceId: flow.deviceId, ttlMs, authProvider: "feishu", deviceProof: "ed25519-login" });
      this.provider.sourceAccess?.bind(flow.identity, issued);
      this.provider.renewal?.bind(flow.identity, issued, flow.key);
    }
    catch { if (issued) this.sessions.revoke(issued.token); throw new LoginError(403, "feishu_source_authorization_failed"); }
    finally { this.discard(flow.identity); }
    // The device key travels with the sealed credential so a later resume can be
    // required to come from this same device.
    return this.authenticated({ ...issued, devicePublicKey: flow.key.export({ type: "spki", format: "pem" }) });
  }
  // A login's tokens go out once their write to the shared store has been
  // tried (sessions.js): the desktop's next request may reach another replica
  // first. Not refused if the store is away -- by then a renewal has already
  // spent Feishu's refresh token, and refusing would sign the person out. The
  // tokens work on this replica and are written when the store is back.
  async shared(result) {
    if (result?.token) {
      await this.sessions.persisted?.(result.token, result.turnToken);
      // And what goes with the session, which that replica reads with it.
      const id = this.sessions.verify(result.token)?.id;
      if (id) await Promise.all([this.provider.sourceAccess?.persisted?.(id), this.provider.renewal?.persisted?.(id)]);
    }
    return result;
  }
  authenticated(issued, resume = this.sealResume(issued)) {
    // The lease the desktop hands the coding agent must not carry the root
    // `token`: the agent can read the lease (its sandbox allows reads
    // everywhere), and the root token mints media/Drive/MCP/skill child tokens,
    // which would bypass the confirmation card. `turnToken` reaches the model
    // gateway but, being a child, cannot mint anything; the desktop writes it to
    // the lease and keeps the root token in memory for the services that mint.
    return { status: "authenticated", token: issued.token, turnToken: this.sessions.issueForModelTurn(issued.token).token,
      expiresAt: issued.expiresAt, serverUrl: this.origin,
      identity: this.identity(issued), ...this.provider.renewal?.metadata(issued), ...(resume ? { resume } : {}) };
  }
  // The durable half of a login. It exists only when the deployment enabled long
  // sessions and Feishu actually granted a refresh token; otherwise the client
  // gets nothing to store and a restart means signing in again, as before.
  sealResume(issued) {
    const key = this.provider.resumeKey, renewal = this.provider.renewal;
    if (!key || !renewal || !issued.devicePublicKey) return null;
    try {
      return renewal.sealRefresh(issued.id, ({ refreshToken, notAfter }) => sealResume(key, {
        appId: issued.appId, tenantId: issued.tenantId, userId: issued.userId,
        deviceId: issued.deviceId, devicePublicKey: issued.devicePublicKey, refreshToken, notAfter }));
    } catch { return null; }
  }
  resumeChallenge() {
    this.pruneResume();
    if (this.closed || !this.provider.resumeKey) throw new LoginError(403, "resume_unavailable");
    if (this.resumeChallenges.size >= RESUME_CHALLENGES_MAX) throw new LoginError(429, "resume_busy");
    const nonce = random(), expiresAt = this.now() + 60_000;
    this.resumeChallenges.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }
  pruneResume() { for (const [nonce, expiresAt] of this.resumeChallenges) if (expiresAt <= this.now()) this.resumeChallenges.delete(nonce); }
  async resume(credential, nonce, signature) {
    this.pruneResume();
    const key = this.provider.resumeKey, renewal = this.provider.renewal;
    if (this.closed || !key || !renewal) throw new LoginError(403, "resume_unavailable");
    // Consumed before anything is checked, so a failed attempt cannot be retried
    // against the same nonce with a different guess.
    if (!opaque(nonce) || !this.resumeChallenges.delete(nonce)) throw new LoginError(403, "resume_challenge_unknown");
    if (typeof signature !== "string" || !signature || signature.length > 512) throw new LoginError(400, "invalid_resume_request");
    let record; try { record = openResume(key, credential); } catch { throw new LoginError(403, "resume_credential_unreadable"); }
    if (record.notAfter <= this.now()) throw new LoginError(403, "resume_expired");
    if (!this.allowedTenants.has(record.tenantId) || record.appId !== this.provider.appId) throw new LoginError(403, "resume_tenant_not_allowed");
    let publicKey;
    try { publicKey = createPublicKey(record.devicePublicKey); } catch { throw new LoginError(403, "resume_device_key_invalid"); }
    if (publicKey.asymmetricKeyType !== "ed25519") throw new LoginError(403, "resume_device_key_invalid");
    // The device that signs must be the device the credential was issued to.
    // Derived the same way begin() does it: from the base64url public key, not
    // from the raw DER, or no real device would ever match.
    if (digest(publicKey.export({ type: "spki", format: "der" }).toString("base64url")) !== record.deviceId) throw new LoginError(403, "resume_device_mismatch");
    const message = resumeProofMessage(this.origin, nonce, resumeDigest(credential));
    let proven = false;
    try { proven = verify(null, message, publicKey, Buffer.from(signature, "base64url")); } catch { proven = false; }
    if (!proven) throw new LoginError(403, "resume_proof_invalid");
    // Only now is the refresh token spent. Feishu decides whether it is still
    // good and who it belongs to; a revoked token or a changed identity ends the
    // durable login here rather than reviving a stale one.
    let identity;
    try { identity = await this.provider.adoptRefreshed({ refreshToken: record.refreshToken }); }
    catch { throw new LoginError(403, "resume_refused_sign_in_again"); }
    try {
      if (identity.tenantId !== record.tenantId || identity.userId !== record.userId || identity.appId !== record.appId) throw new LoginError(403, "resume_identity_changed");
      if (!this.allowedTenants.has(identity.tenantId)) throw new LoginError(403, "resume_identity_changed");
      const ttlMs = Math.min(15 * 60_000, Math.floor(identity.expiresAt - this.now()));
      if (ttlMs < 1) throw new LoginError(403, "resume_expired");
      let issued;
      try {
        issued = this.sessions.issue({ ...identity, deviceId: record.deviceId, ttlMs, authProvider: "feishu", deviceProof: "ed25519-login" });
        this.provider.sourceAccess?.bind(identity, issued);
        renewal.bind(identity, issued, publicKey);
        return this.authenticated({ ...issued, devicePublicKey: record.devicePublicKey });
      } catch (cause) {
        if (issued) this.sessions.revoke(issued.token);
        throw cause instanceof LoginError ? cause : new LoginError(403, "resume_refused_sign_in_again");
      }
    } finally { this.discard(identity); }
  }
  identity(session) { return { provider: session.authProvider, tenantId: session.tenantId, userId: session.userId, appId: session.appId,
    displayName: session.displayName, deviceId: session.deviceId, deviceProof: session.deviceProof, ...(session.cliIdentityChecks === true ? { cliIdentityChecks: true } : {}), ...(session.cliBridge === true ? { cliBridge: true } : {}), ...(session.cliDocumentWrites === true ? { cliDocumentWrites: true } : {}), ...(session.cliMessageWrites === true ? { cliMessageWrites: true } : {}), ...(session.cliDriveWrites === true ? { cliDriveWrites: true } : {}), ...(session.cliDestructiveWrites === true ? { cliDestructiveWrites: true } : {}) }; }
  cancel(flowId, signature) { const flow = this.prove(flowId, signature, "cancel"); flow.controller?.abort(); this.discard(flow.identity); this.flows.delete(flowId); return { status: "cancelled" }; }
  async handle(req, res) {
    const url = new URL(req.url, this.origin); if (!ROUTES.has(url.pathname)) return false;
    try {
      if (req.headers.origin || this.closed) throw new LoginError(403, "native_client_required");
      if (["/auth/feishu/launch", "/auth/feishu/callback", "/auth/session"].includes(url.pathname) ? req.method !== "GET" : req.method !== "POST") throw new LoginError(405, "method_not_allowed");
      if (url.pathname === "/auth/feishu/launch") {
        if (url.searchParams.getAll("flow").length !== 1) throw new LoginError(400, "invalid_login_request");
        const launched = this.launch(url.searchParams.get("flow"));
        send(res, 302, { status: "redirect" }, { location: launched.url, "set-cookie": launched.cookie });
      } else if (url.pathname === "/auth/feishu/callback") {
        const { status, location } = await this.callback(url, req.headers.cookie);
        if (location) send(res, 302, { status: "redirect" }, { location, "set-cookie": this.cookie("", 0) });
        else {
          const [code, message] = CALLBACK_PAGES[status] ?? [403, "登录未完成，请返回应用重新发起。"];
          send(res, code, { status, message }, { "set-cookie": this.cookie("", 0) });
        }
      } else if (["/auth/session", "/auth/logout", "/auth/session/renew-begin", "/auth/session/renew", "/auth/feishu/web-identity/begin", "/auth/feishu/web-identity/status"].includes(url.pathname)) {
        const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
        const session = this.sessions.verify(token); if (!session) throw new LoginError(401, "session_expired_or_invalid");
        if (session.audience !== "codex-model-gateway") throw new LoginError(403, "login_audience_required");
        if (url.pathname.startsWith("/auth/session/renew")) {
          if (!this.provider.renewal || !this.allowedTenants.has(session.tenantId)) throw new LoginError(403, "renewal_unavailable");
          const value = await body(req);
          let result;
          try {
            // A renewal can rotate Feishu's refresh token (it does when the access
            // token is refreshed). Hand back a credential sealed around the token
            // the server now holds; the one from sign-in would resume with a
            // spent token after the next restart.
            const renewed = url.pathname.endsWith("renew-begin") ? null : await this.provider.renewal.renew(this.origin, token, value);
            result = renewed ? this.authenticated({ ...renewed, devicePublicKey: this.provider.renewal.devicePublicKey?.(renewed.id) ?? undefined }) : this.provider.renewal.begin(token);
          } catch { throw new LoginError(403, "renewal_unavailable_sign_in_again"); }
          send(res, 200, await this.shared(result));
          return true;
        }
        if (url.pathname === "/auth/feishu/web-identity/begin") { await body(req); send(res, 200, this.beginWebIdentity(session)); return true; }
        if (url.pathname === "/auth/feishu/web-identity/status") { send(res, 200, this.webIdentityStatus(session, (await body(req)).flowId)); return true; }
        // Awaited: by the time the desktop hears "logged_out", the other
        // replicas have been told too (or, if the store is away, it is being
        // retried and the session ends at its expiry at the latest).
        if (url.pathname === "/auth/logout") await this.sessions.revoke(token);
        send(res, 200, url.pathname === "/auth/logout" ? { status: "logged_out" } : { identity: this.identity(session), expiresAt: session.expiresAt, ...this.provider.renewal?.metadata(session) });
      } else {
        const value = await body(req, url.pathname === "/auth/feishu/resume" ? MAX_RESUME_BODY_BYTES : MAX_BODY_BYTES);
        if (url.pathname === "/auth/feishu/begin") send(res, 200, this.begin(value.publicKey, value.returnPort));
        else if (url.pathname === "/auth/feishu/complete") send(res, 200, await this.shared(this.complete(value.flowId, value.signature, value.secret)));
        else if (url.pathname === "/auth/feishu/resume-challenge") send(res, 200, this.resumeChallenge());
        else if (url.pathname === "/auth/feishu/resume") send(res, 200, await this.shared(await this.resume(value.resume, value.nonce, value.signature)));
        else send(res, 200, this.cancel(value.flowId, value.signature));
      }
    } catch (error) { if (!res.headersSent) send(res, error instanceof LoginError ? error.status : 502, { error: error instanceof LoginError ? error.message : "login_unavailable" }); req.resume(); }
    return true;
  }
  close() { this.closed = true; clearInterval(this.pruner); this.resumeChallenges.clear(); this.probeStarts.clear(); for (const flow of this.flows.values()) { flow.controller?.abort(); this.discard(flow.identity); } this.flows.clear(); this.provider.sourceAccess?.close(); this.provider.renewal?.close(); }
}
