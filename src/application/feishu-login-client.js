import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { validateServerUrl } from "../control-plane/client-session.js";
import { loginProofMessage, loginReturnUrl, renewalProofMessage, MAX_SESSION_WINDOW_MS } from "../control-plane/login-proof.js";
import { resumeDigest, resumeProofMessage } from "../control-plane/resume-credential.js";
import { CLOCK_SKEW_MS } from "./clock-skew.js";
import { openLoginReturn } from "./login-return.js";

// Native-only distinction: terminal authorization failures need a fresh flow;
// network failures, throttling and server unavailability allow manual checking.
export class LoginRestartRequired extends Error {}

// What a session carries that the desktop has built on: which account and
// device it is, and what it may write. A renewal, or a sign-in with the stored
// credential that replaces a session in place, must hand back the same.
export const SESSION_IDENTITY_FIELDS = Object.freeze(["provider", "appId", "tenantId", "userId", "deviceId", "deviceProof", "cliIdentityChecks",
  "cliBridge", "cliDocumentWrites", "cliMessageWrites", "cliDriveWrites", "cliDestructiveWrites"]);

// How far this machine's clock and the control plane's may disagree. Every
// expiry checked below was written by the server's clock and is read against
// this one's. A control plane on this machine shares its clock; one on a server
// does not: two NTP-synchronised machines were 0.1 s apart when this was added,
// which put a 300 s sign-in flow at 300.1 s and refused every sign-in to the
// remote deployment. A minute covers a clock that drifted or a machine just
// back from sleep, and still refuses a server that hands out hours. Only the
// upper bounds need it: whether something has actually expired is the
// server's to decide, on its own clock.
export { CLOCK_SKEW_MS };

export function validateRenewal(session, now = Date.now()) {
  const value = session.renewal;
  if (value === undefined) return;
  if (!value || !Number.isSafeInteger(value.renewAfter) || value.renewAfter !== session.expiresAt - 120000 ||
      !Number.isSafeInteger(value.notAfter) || value.notAfter <= session.expiresAt || value.notAfter > now + MAX_SESSION_WINDOW_MS + CLOCK_SKEW_MS)
    throw new LoginRestartRequired("续期策略无效，请重新登录");
}

export class FeishuLoginClient {
  // `onReturn` is told when the browser that authorized a sign-in has come back
  // to this device (login-return.js), so the sign-in can be finished at once.
  constructor({ fetchImpl = fetch, now = Date.now, getDeviceKey = () => generateKeyPairSync("ed25519").privateKey, openReturn = openLoginReturn, onReturn = () => {} } = {}) {
    this.fetch = fetchImpl; this.now = now; this.getDeviceKey = getDeviceKey; this.openReturn = openReturn; this.onReturn = onReturn; this.attempt = null; this.generation = 0;
  }
  async request(origin, route, value, token) {
    const response = await this.fetch(`${origin}${route}`, { method: value ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { ...(value ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(value ? { body: JSON.stringify(value) } : {}) });
    if (!response.ok) {
      // The control plane names the exact check that refused. Carrying that name
      // back turns "HTTP 403" into something an operator can act on; these are
      // fixed identifiers from our own server, never tokens or user data.
      let code = null;
      try {
        if (response.headers.get("content-type")?.startsWith("application/json")) {
          const text = await response.text();
          if (text.length <= 512) { const value = JSON.parse(text)?.error; if (typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value)) code = value; }
        } else await response.body?.cancel();
      } catch { /* the status alone still has to be reported */ }
      const reason = code ? `：${code}` : "";
      const error = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)
        ? new LoginRestartRequired(`飞书授权已失效或未获准（HTTP ${response.status}${reason}），请重新发起登录。`)
        : new Error(`飞书登录请求暂未完成（HTTP ${response.status}${reason}），请稍后手动检查。`);
      // Also apart from the sentence, so a caller can tell "the server no longer
      // knows this session" from a refusal of the login itself.
      throw Object.assign(error, { status: response.status, code });
    }
    if (!response.headers.get("content-type")?.startsWith("application/json") || !response.body) { await response.body?.cancel(); throw new LoginRestartRequired("登录服务响应无效，请重新发起登录"); }
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 16384) { await reader.cancel(); throw new LoginRestartRequired("登录响应过大，请重新发起登录"); } chunks.push(Buffer.from(part.value)); } }
    finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new LoginRestartRequired("登录服务响应无效，请重新发起登录"); }
  }
  async begin(serverUrl) {
    if (this.attempt) throw new Error("请先完成或取消当前登录");
    const origin = validateServerUrl(serverUrl), generation = ++this.generation;
    // Reserve locally before the first await to reject concurrent starts.
    const attempt = { origin, generation }; this.attempt = attempt;
    try {
      const privateKey = await this.getDeviceKey(origin);
      if (this.attempt !== attempt) throw new Error("登录已取消");
      if (privateKey?.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("设备签名密钥无效");
      attempt.keys = { privateKey, publicKey: createPublicKey(privateKey) };
      const publicKey = attempt.keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
      attempt.deviceId = createHash("sha256").update(publicKey).digest("base64url");
      // Listening before the sign-in exists: the control plane is told where
      // the authorizing browser is to bring the secret that completes it.
      attempt.loopback = await this.openReturn({ onReturn: () => { if (this.attempt === attempt) this.onReturn(); } });
      if (this.attempt !== attempt) throw new Error("登录已取消");
      const result = await this.request(origin, "/auth/feishu/begin", { publicKey, returnPort: attempt.loopback.port });
      if (![result.flowId, result.nonce].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)) || !Number.isFinite(result.expiresAt) || result.expiresAt <= this.now() || result.expiresAt > this.now() + 300_000 + CLOCK_SKEW_MS || result.launchUrl !== `${origin}/auth/feishu/launch?flow=${result.flowId}`) throw new Error("登录服务返回了无效的授权入口");
      if (this.attempt !== attempt) {
        try { await this.request(origin, "/auth/feishu/cancel", this.proof({ ...attempt, ...result }, "cancel")); } catch {}
        throw new Error("登录已取消");
      }
      attempt.loopback.expect(result.flowId);
      Object.assign(attempt, result); return { launchUrl: result.launchUrl, expiresAt: result.expiresAt };
    } catch (error) { attempt.loopback?.close(); if (this.attempt === attempt) this.attempt = null; throw error; }
  }
  // The address the authorizing browser comes back to, while a sign-in waits.
  returnUrl() { const port = this.attempt?.flowId && this.attempt.loopback?.port; return port ? loginReturnUrl(port) : null; }
  proof(attempt, action) { return { flowId: attempt.flowId, signature: sign(null, loginProofMessage(attempt.origin, attempt.flowId, attempt.nonce, action), attempt.keys.privateKey).toString("base64url") }; }
  async complete() {
    const attempt = this.attempt;
    if (!attempt?.flowId || attempt.expiresAt <= this.now()) { await this.cancel(); throw new LoginRestartRequired("登录尚未开始或已过期，请重新发起登录"); }
    if (attempt.polling) throw new Error("正在检查登录结果"); attempt.polling = true;
    try {
      // Without the secret the answer is "pending", however far the browser got.
      const secret = attempt.loopback?.secret();
      const result = await this.request(attempt.origin, "/auth/feishu/complete", { ...this.proof(attempt, "complete"), ...(secret ? { secret } : {}) });
      if (this.attempt !== attempt) {
        if (result.status === "authenticated" && /^[A-Za-z0-9_-]{43}$/.test(result.token) && result.serverUrl === attempt.origin) {
          try { await this.request(attempt.origin, "/auth/logout", {}, result.token); } catch {}
        }
        throw new Error("登录已切换，未使用旧会话");
      }
      if (result?.status === "pending") return result;
      if (result?.status !== "authenticated" || !/^[A-Za-z0-9_-]{43}$/.test(result.token) || result.serverUrl !== attempt.origin || !Number.isFinite(result.expiresAt) || result.expiresAt <= this.now() || result.expiresAt > this.now() + 900_000 + CLOCK_SKEW_MS || result.identity?.provider !== "feishu") {
        if (result?.status === "authenticated" && /^[A-Za-z0-9_-]{43}$/.test(result.token) && result.serverUrl === attempt.origin) {
          try { await this.request(attempt.origin, "/auth/logout", {}, result.token); } catch {}
        }
        throw new LoginRestartRequired("登录凭证响应无效，请重新发起登录");
      }
      if (result.identity.deviceProof !== "ed25519-login" || result.identity.deviceId !== attempt.deviceId) {
        this.attempt = null;
        try { await this.request(attempt.origin, "/auth/logout", {}, result.token); } catch { /* Never adopt a substituted device identity. */ }
        throw new LoginRestartRequired("登录设备身份与本机签名密钥不匹配，请重新发起登录");
      }
      try { validateRenewal(result, this.now()); }
      catch (error) { try { await this.request(attempt.origin, "/auth/logout", {}, result.token); } catch {} throw error; }
      // The model-turn credential goes into the agent's lease; a malformed one is
      // rejected here rather than written out.
      if (result.turnToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(result.turnToken)) {
        try { await this.request(attempt.origin, "/auth/logout", {}, result.token); } catch {}
        throw new LoginRestartRequired("登录凭证响应无效，请重新发起登录");
      }
      this.attempt = null; return result;
    } catch (error) {
      if (error instanceof LoginRestartRequired && this.attempt === attempt) await this.cancel();
      throw error;
    } finally { attempt.polling = false; if (this.attempt !== attempt) attempt.loopback?.close(); }
  }
  // Coming back without a browser. The stored credential is opaque here — this
  // side only proves, with the device key, that it is presenting it from the
  // machine it was issued to. Anything unexpected is terminal: the credential is
  // discarded by the caller and the person signs in again.
  async resume(serverUrl, credential) {
    const origin = validateServerUrl(serverUrl);
    if (typeof credential !== "string" || !credential) throw new LoginRestartRequired("没有可用的本机登录凭据");
    if (this.attempt) throw new Error("请先完成或取消当前登录");
    const key = await this.getDeviceKey(origin);
    if (key?.asymmetricKeyType !== "ed25519") throw new LoginRestartRequired("本机设备密钥不可用，请重新登录");
    // The device identity is the hash of the base64url public key exactly as the
    // login exchange sends it, not of the raw DER; hashing the bytes instead
    // produces a different id that never matches the session.
    const publicKey = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64url");
    const deviceId = createHash("sha256").update(publicKey).digest("base64url");
    const challenge = await this.request(origin, "/auth/feishu/resume-challenge", {});
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge?.nonce ?? "") || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= this.now() || challenge.expiresAt > this.now() + 120_000 + CLOCK_SKEW_MS) {
      throw new LoginRestartRequired("续用登录的挑战无效，请重新登录");
    }
    const signature = sign(null, resumeProofMessage(origin, challenge.nonce, resumeDigest(credential)), key).toString("base64url");
    const result = await this.request(origin, "/auth/feishu/resume", { resume: credential, nonce: challenge.nonce, signature });
    const bad = async (message) => {
      if (result?.status === "authenticated" && /^[A-Za-z0-9_-]{43}$/.test(result.token ?? "") && result.serverUrl === origin) {
        try { await this.request(origin, "/auth/logout", {}, result.token); } catch { /* best effort */ }
      }
      throw new LoginRestartRequired(message);
    };
    if (result?.status !== "authenticated" || !/^[A-Za-z0-9_-]{43}$/.test(result.token ?? "") || result.serverUrl !== origin ||
        !Number.isFinite(result.expiresAt) || result.expiresAt <= this.now() || result.expiresAt > this.now() + 900_000 + CLOCK_SKEW_MS ||
        result.identity?.provider !== "feishu") await bad("续用登录的响应无效，请重新登录");
    // The same device check a fresh login makes: never adopt a session minted
    // for some other machine's key.
    if (result.identity.deviceProof !== "ed25519-login" || result.identity.deviceId !== deviceId) await bad("续用登录的设备身份不匹配，请重新登录");
    try { validateRenewal(result, this.now()); } catch (error) { await bad(error.message); }
    if (result.turnToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(result.turnToken)) await bad("续用登录的响应无效，请重新登录");
    return result;
  }
  async cancel() {
    const attempt = this.attempt; this.attempt = null; this.generation++;
    attempt?.loopback?.close();
    if (attempt?.flowId) { try { await this.request(attempt.origin, "/auth/feishu/cancel", this.proof(attempt, "cancel")); } catch {} }
  }
  async renew(session) {
    const origin = validateServerUrl(session.serverUrl); validateRenewal(session, this.now());
    if (!session.renewal || this.now() < session.renewal.renewAfter || this.now() >= session.expiresAt) throw new LoginRestartRequired("不在在线续期窗口，请重新登录");
    const key = await this.getDeviceKey(origin);
    const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url");
    if (key?.asymmetricKeyType !== "ed25519" || createHash("sha256").update(publicKey).digest("base64url") !== session.identity.deviceId) throw new LoginRestartRequired("续期设备身份不匹配");
    const challenge = await this.request(origin, "/auth/session/renew-begin", {}, session.token);
    if (![challenge.challengeId, challenge.nonce].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)) ||
        typeof challenge.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(challenge.sessionId) || !Number.isFinite(challenge.expiresAt) ||
        challenge.expiresAt <= this.now() || challenge.expiresAt > Math.min(session.expiresAt, this.now() + 60000 + CLOCK_SKEW_MS)) throw new LoginRestartRequired("续期挑战无效");
    const signature = sign(null, renewalProofMessage(origin, challenge.sessionId, challenge.challengeId, challenge.nonce), key).toString("base64url");
    const result = await this.request(origin, "/auth/session/renew", { challengeId: challenge.challengeId, signature }, session.token);
    try {
      if (result.status !== "authenticated" || typeof result.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.token) || result.token === session.token ||
          result.serverUrl !== origin || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Math.max(session.expiresAt, this.now()) ||
          result.expiresAt > Math.min(this.now() + 900000 + CLOCK_SKEW_MS, session.renewal.notAfter) ||
          SESSION_IDENTITY_FIELDS.some(field => result.identity?.[field] !== session.identity[field])) throw new Error();
      validateRenewal(result, this.now());
      if (result.renewal && result.renewal.notAfter !== session.renewal.notAfter) throw new Error();
      if (result.turnToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(result.turnToken)) throw new Error();
      return result;
    } catch {
      // The old token identifies the same family without trusting response data.
      try { await this.request(origin, "/auth/logout", {}, session.token); } catch {}
      throw new LoginRestartRequired("续期响应身份或有效期不匹配，请重新登录");
    }
  }
}
