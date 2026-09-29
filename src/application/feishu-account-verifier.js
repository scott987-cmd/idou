import { WikiCoordinatorClient } from "../knowledge/coordinator-client.js";
import { accountCandidate, accountCandidateHash, accountOpaque } from "../providers/feishu/account-identity.js";
import { FeishuRuntimeRefused } from "../providers/feishu/bundled-runtime.js";
import { setTimeout as delay } from "node:timers/promises";

// A reason the operator can act on, raised by this process about its own state.
// It is re-thrown unchanged so a blanket catch cannot bury it behind a message
// about CLI identity matching, which would send the reader down the wrong path.
// The application refusing to run its own Feishu CLI is such a reason too.
export class AccountCheckBlocked extends Error {}
const ownState = error => error instanceof AccountCheckBlocked || error instanceof FeishuRuntimeRefused;

// Main-process only. A match is consumed by this invocation, never cached as a
// login or sent to the renderer as a reusable authorization capability.
export class FeishuAccountVerifier {
  constructor({ requestIntervalMs = 0, wait = (ms, signal) => delay(ms, undefined, { signal }), ...options }) {
    if (!Number.isSafeInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 1000) throw new Error("Invalid account check interval");
    this.transport = new WikiCoordinatorClient(options); this.requestIntervalMs = requestIntervalMs; this.wait = wait; this.tail = Promise.resolve(); this.nextAt = 0;
  }
  async verify(readCliUser, { signal } = {}) {
    const combined = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
    if (!this.requestIntervalMs) return this.check(readCliUser, combined);
    // Desktop backpressure, not an identity cache. Serialize the whole check so
    // its own background/UI requests cannot race the server's per-grant lock.
    const pending = this.tail.then(async () => {
      combined.throwIfAborted();
      const ms = Math.max(0, this.nextAt - this.transport.now()); if (ms) await this.wait(ms, combined);
      combined.throwIfAborted(); this.nextAt = this.transport.now() + this.requestIntervalMs;
      return this.check(readCliUser, combined);
    });
    this.tail = pending.catch(() => {});
    try { return await pending; }
    catch (error) {
      if (ownState(error)) throw error;
      throw new Error("飞书 CLI 尚未与此登录身份匹配；核验已取消或暂不可用。未使用旧验证结果。");
    }
  }
  async check(readCliUser, combined) {
    let response, reader, cancel;
    try {
      combined.throwIfAborted();
      const session = structuredClone(await this.transport.session()), identity = session.identity;
      if (identity?.provider !== "feishu" || identity.deviceProof !== "ed25519-login" || identity.cliIdentityChecks !== true ||
          ![identity.appId, identity.tenantId, identity.userId, identity.deviceId].every(accountOpaque)) throw new Error();
      const user = await readCliUser({ signal: combined }); combined.throwIfAborted();
      const candidate = accountCandidate({ tenantKey: user.tenantKey, tenantUserId: user.tenantUserId });
      if (!accountOpaque(user.openId) || candidate.tenantKey !== identity.tenantId) throw new Error();
      await this.transport.unchanged(session); combined.throwIfAborted();
      response = await this.transport.fetch(`${session.serverUrl}/v1/feishu/account-match`, { method: "POST", redirect: "error", signal: combined,
        headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(candidate) });
      if (response.status !== 200 || response.redirected || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error();
      reader = response.body.getReader(); cancel = () => { void reader.cancel().catch(() => {}); }; combined.addEventListener("abort", cancel, { once: true });
      const chunks = []; let size = 0;
      while (true) {
        combined.throwIfAborted(); const part = await reader.read(); combined.throwIfAborted(); if (part.done) break;
        size += part.value.byteLength; if (size > 4096) throw new Error(); chunks.push(Buffer.from(part.value));
      }
      const result = JSON.parse(Buffer.concat(chunks));
      await this.transport.unchanged(session); combined.throwIfAborted();
      if (result?.matches !== true || result.pointInTime !== true || result.candidateHash !== accountCandidateHash(candidate) ||
          !Number.isSafeInteger(result.checkedAt) || result.checkedAt < 0 ||
          !["appId", "tenantId", "userId", "deviceId"].every(key => result.identity?.[key] === identity[key])) throw new Error();
      return { openId: user.openId, tenantKey: candidate.tenantKey };
    } catch (error) {
      if (ownState(error)) throw error;
      throw new Error("飞书 CLI 尚未与此登录身份匹配；请检查同企业账号、用户 ID 权限和服务端配置。未使用旧验证结果。");
    }
    finally {
      if (cancel) combined.removeEventListener("abort", cancel);
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } else await response?.body?.cancel().catch(() => {});
    }
  }
}
