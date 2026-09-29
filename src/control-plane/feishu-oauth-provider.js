// Server-only adapter: never import this module from the desktop or token helper.
import { SOURCE_ACCESS_SCOPE } from "../knowledge/source-access-contract.js";
import { SessionRenewal } from "./session-renewal.js";
import { resumeSealingKey } from "./resume-credential.js";
// Where the requests go is the deployment's (`feishu.openApi`). The v1
// authorize page and the v2 token endpoint are the pair that share PKCE state;
// the older passport token endpoint rejects the verifier with "PKCE code
// challenge failed". The pinned CLI targets this same v2 endpoint.

// Feishu issues a refresh token only when this scope is granted; without it a
// login can never outlive the access token it started with.
export const OFFLINE_SCOPE = "offline_access";

export class FeishuOAuthProvider {
  constructor({ feishu, appId, appSecret, fetchImpl = fetch, sourceAccess = null, sessions, sessionRenewalEnabled = false, longSessionDays = 0, now = Date.now, diagnostic = () => {}, renewalCapacity = {}, state = null, log = () => {} }) {
    if (typeof diagnostic !== "function") throw new Error("Invalid login diagnostic sink");
    this.diagnostic = diagnostic;
    if (!feishu?.openApi) throw new Error("飞书登录需要一个说 OpenAPI 的部署定义");
    if (sourceAccess && sourceAccess.feishu !== feishu) throw new Error("飞书登录与源访问必须属于同一个部署");
    if (!feishu.ids.app(appId) || typeof appSecret !== "string" || !appSecret.trim()) throw new Error("Server Feishu app credentials are required");
    this.feishu = feishu; this.appId = appId; this.appSecret = appSecret; this.fetch = fetchImpl; this.sourceAccess = sourceAccess;
    this.scopes = sourceAccess ? [...(sourceAccess.requiredScopes || [SOURCE_ACCESS_SCOPE])] : [];
    if (typeof sessionRenewalEnabled !== "boolean" || sessionRenewalEnabled && !sessions) throw new Error("Invalid session renewal policy");
    this.now = now;
    if (!Number.isSafeInteger(longSessionDays) || longSessionDays < 0 || longSessionDays > 30) throw new Error("Long session length must be 0-30 days");
    this.longSessions = longSessionDays > 0;
    this.longSessionMs = longSessionDays * 86400_000;
    // One list, used by both halves of the exchange. Computed twice, the
    // authorization page and the token request drifted apart -- and the drift is
    // invisible, because the narrower one simply comes back without a refresh
    // token rather than with an error.
    this.grantScopes = Object.freeze(this.longSessions ? [...this.scopes, OFFLINE_SCOPE] : [...this.scopes]);
    // Derived, not stored: the same application secret this control plane already
    // needs produces the same sealing key after a restart, so a durable login
    // survives without any new secret being written anywhere.
    this.resumeKey = this.longSessions ? resumeSealingKey(appSecret, appId) : null;
    this.renewal = sessionRenewalEnabled ? new SessionRenewal({ sessions, now, diagnostic, capacity: renewalCapacity, state, log, longSessionMs: longSessionDays * 86400_000,
      // Exchanging a refresh token is the only way a login outlives its first
      // access token. It returns the new pair; the old refresh token is spent.
      refreshIdentity: async (refreshToken, signal) => {
        const requestedAt = this.now();
        const token = await this.json(this.feishu.openApi.tokenUrl, { method: "POST", signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: this.appId, client_secret: this.appSecret, refresh_token: refreshToken.toString("utf8") }) }, "刷新令牌接口");
        if (token.code !== 0 || typeof token.access_token !== "string" || !token.access_token || token.token_type !== "Bearer" || !Number.isSafeInteger(token.expires_in) || token.expires_in < 1) throw new Error("Feishu refresh failed");
        return { accessToken: token.access_token,
          refreshToken: typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : null,
          expiresAt: requestedAt + Math.min(token.expires_in, 86400) * 1000 };
      },
      checkIdentity: async (token, signal) => {
        // Labelled, so a refusal from Feishu reaches the operator with its code
        // and message instead of ending the working session without a reason.
        const user = await this.json(this.feishu.openApi.userInfoUrl, { method: "GET", signal, headers: { authorization: `Bearer ${token.toString("utf8")}` } }, "续期身份核验");
        if (user.code !== 0 || !user.data) { this.diagnostic(`飞书续期身份核验返回了错误：code=${user.code}`); throw new Error("Feishu identity unavailable"); }
        return { appId: this.appId, tenantId: user.data.tenant_key, userId: user.data.open_id };
      }, transferSource: sourceAccess ? (token, issued) => sourceAccess.transfer(token, issued) : null,
      refreshSource: sourceAccess ? (token, accessToken, expiresAt) => sourceAccess.refreshed(token, accessToken, expiresAt) : null }) : null;
  }
  // `scopes` is the login's list unless a caller asks for less; see
  // probeIdentity for the one caller that does.
  authorizationUrl({ redirectUri, state, challenge, scopes = this.grantScopes }) {
    const url = new URL(this.feishu.openApi.authorizeUrl);
    // No forced prompt. Feishu already knows what this person granted this app,
    // so a second login goes straight through instead of asking them to approve
    // the same permissions again. Feishu still shows the consent page on the
    // first login and whenever the requested scopes change, which is when the
    // approval actually means something.
    url.search = new URLSearchParams({ client_id: this.appId, response_type: "code", redirect_uri: redirectUri,
      state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    // offline_access is what makes a login outlive one Feishu token, so it is
    // requested only when the operator has enabled long sessions.
    // Asked for whenever there is anything to ask for. Gating this on
    // `sourceAccess` meant a deployment with long sessions but no source access
    // sent no `scope` at all, so `offline_access` was never requested, no refresh
    // token was ever issued, and every durable-login feature was inert with
    // nothing anywhere saying why.
    if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
    // Default login is identity-only. Content reads need separately configured
    // original origins; no write, chat, offline_access or contact PII scope.
    return url.href;
  }
  // Feishu reports a rejected exchange in the body of a non-2xx response. Its
  // code and message are diagnostics, not credentials, so they are surfaced to
  // the operator; the body is never returned to the client and the token, when
  // present, is never part of a message.
  async upstreamFailure(response, label) {
    let detail = `HTTP ${response.status}`;
    try {
      if (response.headers.get("content-type")?.startsWith("application/json")) {
        const value = await response.json();
        const code = value?.code ?? value?.error;
        const message = value?.msg ?? value?.error_description;
        if (code !== undefined || message) detail = `code=${code ?? "?"} msg=${String(message ?? "").slice(0, 200)}`;
      } else await response.body?.cancel();
    } catch { /* keep the status-only detail */ }
    this.diagnostic(`飞书${label}拒绝了这次请求：${detail}`);
  }
  async json(url, options, label = null) {
    const response = await this.fetch(url, { ...options, redirect: "error" });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json") || !response.body) {
      if (label) await this.upstreamFailure(response, label); else await response.body?.cancel();
      throw new Error("Feishu authentication unavailable");
    }
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
        if (bytes > 64 * 1024) { await reader.cancel(); throw new Error("Feishu authentication response too large"); } chunks.push(Buffer.from(part.value)); }
      options.signal?.throwIfAborted();
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { reader.releaseLock(); }
  }
  // Redeeming a durable credential ends in the same place a fresh login does:
  // a verified identity with the deployment's capabilities attached, and the new
  // access token handed to the authorities that need it. Identity is re-read
  // from Feishu rather than trusted from the stored credential, so a user whose
  // access was withdrawn cannot resume on yesterday's record.
  async adoptRefreshed({ refreshToken, signal }) {
    // Without renewal there is no `refreshIdentity`, and the unguarded
    // dereference below raised a TypeError naming nothing an operator could act
    // on. The two settings that produce a refresh token are named instead.
    if (!this.renewal) throw new Error("服务端未开启会话续期（FEISHU_SESSION_RENEWAL_ENABLED、FEISHU_LONG_SESSION_DAYS），无法使用长效凭据");
    const timeout = AbortSignal.timeout(30_000), combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const refreshed = await this.renewal.refreshIdentity(Buffer.from(refreshToken, "utf8"), combined);
    const user = await this.json(this.feishu.openApi.userInfoUrl, { method: "GET", signal: combined, headers: { authorization: `Bearer ${refreshed.accessToken}` } }, "用户信息接口");
    if (user.code !== 0 || !user.data || ![user.data.open_id, user.data.tenant_key].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value))) throw new Error("Invalid Feishu identity");
    const identity = { tenantId: user.data.tenant_key, userId: user.data.open_id, appId: this.appId,
      displayName: typeof user.data.name === "string" ? user.data.name.slice(0, 120) : "飞书用户", expiresAt: refreshed.expiresAt };
    if (this.sourceAccess) {
      if (this.sourceAccess.identityChecksEnabled) identity.cliIdentityChecks = true;
      if (this.sourceAccess.cliProxyEnabled) identity.cliBridge = true;
      for (const capability of this.sourceAccess.cliWriteCapabilities || []) identity[capability] = true;
      this.sourceAccess.remember(identity, refreshed.accessToken);
    }
    try { this.renewal.remember(identity, refreshed.accessToken, refreshed.refreshToken ?? refreshToken); }
    catch (error) { this.sourceAccess?.discard(identity); throw error; }
    return identity;
  }
  // The token request and the identity read, shared by a login and a probe.
  async redeem({ code, verifier, redirectUri, scopes, signal }) {
    const requestedAt = this.now();
    // v2 takes a JSON body rather than a form encoding.
    const token = await this.json(this.feishu.openApi.tokenUrl, { method: "POST", signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: this.appId, client_secret: this.appSecret,
        code, code_verifier: verifier, redirect_uri: redirectUri,
        // The same list the authorization page was given, `offline_access`
        // included. `scope` is not a parameter of this request in RFC 6749
        // §4.1.3, so a conformant server ignores it -- but if Feishu honours
        // it, sending the narrower list silently withholds the refresh token
        // and every durable-login feature fails with no error to read.
        ...(scopes.length ? { scope: scopes.join(" ") } : {}) }) }, "令牌接口");
    if (token.code !== 0) {
      this.diagnostic(`飞书令牌接口返回错误：code=${token.code} msg=${String(token.msg ?? "").slice(0, 200)}。常见原因是应用密钥不正确、回调地址与注册值不完全一致，或授权码已被使用。`);
      throw new Error("Invalid Feishu token response");
    }
    if (typeof token.access_token !== "string" || !token.access_token || token.access_token.length > 16384 || token.token_type !== "Bearer" || !Number.isSafeInteger(token.expires_in) || token.expires_in < 1) throw new Error("Invalid Feishu token response");
    const user = await this.json(this.feishu.openApi.userInfoUrl, { method: "GET", signal, headers: { authorization: `Bearer ${token.access_token}` } }, "用户信息接口");
    if (user.code !== 0 || !user.data || ![user.data.open_id, user.data.tenant_key].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value))) throw new Error("Invalid Feishu identity");
    return { token, user: user.data, requestedAt };
  }

  // Which Feishu account a browser context is signed in as, asked of Feishu
  // through this application's own authorization -- to compare, never to keep.
  //
  // The desktop embeds Feishu's web pages, and nothing those pages say about
  // themselves (a name in the header, "you are signed in") is evidence of who
  // is signed in there. An authorization code redeemed here with the
  // application secret is. So the embedded browser is sent through the
  // authorize page and the code comes back here.
  //
  // Nothing is retained: no source-access grant, no renewal, and both tokens go
  // out of scope when this returns. `offline_access` is deliberately not asked
  // for, so no refresh token is minted at all: whether Feishu retires older
  // refresh tokens when a new one is issued is not documented, and the
  // unattended schedules depend on the one the server already holds.
  // `scopes` says what the authorize step asked for. It has to match: a code
  // granted for nothing must not be exchanged while claiming the whole list.
  async probeIdentity({ code, verifier, redirectUri, signal, scopes = this.probeScopes }) {
    const timeout = AbortSignal.timeout(30_000), combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const { user } = await this.redeem({ code, verifier, redirectUri, scopes, signal: combined });
      return { tenantId: user.tenant_key, userId: user.open_id, appId: this.appId };
    } catch {
      this.diagnostic("网页账号核对未完成：飞书没有兑换这次的授权码。");
      throw new Error("Feishu identity probe failed");
    }
  }
  get probeScopes() { return this.scopes; }

  async exchangeCode({ code, verifier, redirectUri, signal }) {
    const timeout = AbortSignal.timeout(30_000), combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const { token, user: data, requestedAt } = await this.redeem({ code, verifier, redirectUri, scopes: this.grantScopes, signal: combined });
      const user = { data };
      const expiresAt = requestedAt + Math.min(token.expires_in, 86400) * 1000;
      // Held only by the server-side renewal authority, and only when long
      // sessions are configured. It is never returned to a client.
      const refreshToken = this.longSessions && typeof token.refresh_token === "string" && token.refresh_token
        && token.refresh_token.length <= 16384 ? token.refresh_token : null;
      const identity = { tenantId: user.data.tenant_key, userId: user.data.open_id, appId: this.appId,
        displayName: typeof user.data.name === "string" ? user.data.name.slice(0, 120) : "飞书用户", expiresAt };
      if (this.sourceAccess) {
        const granted = typeof token.scope === "string" ? token.scope.split(/\s+/) : [];
        const missing = this.scopes.filter(scope => !granted.includes(scope));
        // Scope names are configuration, not credentials, so naming them here is safe.
        if (missing.length) { this.diagnostic(`飞书未授予所需权限：${missing.join(" ")}。请在开放平台为该应用开通对应权限并重新授权。`); throw new Error("source permission scope not granted"); }
        if (this.sourceAccess.identityChecksEnabled) identity.cliIdentityChecks = true;
        if (this.sourceAccess.cliProxyEnabled) identity.cliBridge = true;
        for (const capability of this.sourceAccess.cliWriteCapabilities || []) identity[capability] = true;
        this.sourceAccess.remember(identity, token.access_token);
      }
      try { this.renewal?.remember(identity, token.access_token, refreshToken); }
      catch (error) { this.sourceAccess?.discard(identity); throw error; }
      // Only optional server-owned authorities retain these tokens. Email, phone
      // and avatars are never returned or stored, and no token ever reaches a
      // client.
      return identity;
    } catch (error) {
      if (!/scope not granted/.test(error.message)) this.diagnostic("飞书登录未完成：请确认回调地址已注册、应用密钥正确、租户在允许列表中，然后重新发起授权。");
      throw new Error("Feishu login failed; restart authorization instead of replaying the code");
    }
  }
}
