import { createHash } from "node:crypto";

// The identity an unattended run acts as when nobody is signed in.
//
// `ScheduleConsent` beside this one holds a live session token and is correct
// for what it promises: a schedule runs only inside your own login, and closing
// the desktop lets it lapse. The trouble is that a login is at most fifteen
// minutes long and rotates to a new session every thirteen, so that promise also
// meant 每天 / 每周 / 每月 never ran at all -- the only schedules it could keep
// were ones due within minutes of the click.
//
// So this is the other bargain, taken deliberately and separately: the person
// says "run these while I am away, for N days", and the control plane holds a
// sealed Feishu refresh credential for exactly that long. It is a real
// enlargement of what a breach of this server is worth -- see the header of
// unattended-credential.js, which says so plainly -- and it is why this is its
// own consent with its own words rather than a quiet extension of the old one.
//
// Two properties do the work here:
//   - A refresh token is spent by the exchange that uses it, so the rotated one
//     is persisted BEFORE anything else can fail. Everything between the
//     exchange and the session -- a pending ceiling, a refused bind, a killed
//     process -- would otherwise leave the stored copy holding a spent token,
//     with nobody present to notice.
//   - Two schedules due in the same minute must not each spend the same token.
//     The second exchange would be refused by Feishu and the chain would be dead
//     on the first busy morning, so mints are collapsed per person.
const digest = (value) => createHash("sha256").update(value).digest("hex");
const DAY_MS = 86400_000;

// Long enough for a run and the message about it: a session handed to a job that
// outlives it fails halfway, which is worse than minting a new one.
const MIN_REMAINING_MS = 11 * 60_000;

// How long one failed attempt to reach Feishu stands for everyone who asks after
// it. Long enough to cover a tick's worth of schedules and a few impatient
// clicks; short enough that the next real occasion asks again.
const UNREACHABLE_MS = 10 * 60_000;

export class UnattendedConsent {
  constructor({ store, sessions, provider, allowedTenants = null, windowDays,
    minRemainingMs = MIN_REMAINING_MS, now = Date.now, audit = () => {} }) {
    if (!store || !sessions || !provider) throw new Error("无人值守授权需要凭据存储、会话注册表和登录提供方");
    if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > 30) throw new Error("无人值守授权的有效期必须是 1-30 天");
    Object.assign(this, { store, sessions, provider, windowDays, minRemainingMs, now, audit });
    this.allowedTenants = allowedTenants ? new Set(allowedTenants) : null;
    this.live = new Map();
    this.minting = new Map();
    this.unreachable = new Map();
  }

  #key(tenantId, userId) { return `${tenantId}\n${userId}`; }

  #record({ kind, tenantId, userId, ...rest }) {
    this.audit(Object.freeze({ kind, at: this.now(), tenantHash: digest(tenantId), userHash: digest(userId), ...rest }));
  }

  // The credential comes from its own Feishu authorization (see
  // FeishuLoginService.beginGrant), redeemed by this server; nothing crosses the
  // wire from the desktop to create it. It must be its own: the first version
  // sealed a copy of the refresh token the person's live session held, and a
  // refresh token is spent by the first exchange that uses it -- so the first
  // scheduled run signed the desktop out, or the desktop's first refresh left
  // this copy dead, whichever came first.
  async grantRedeemed({ appId, tenantId, userId, refreshToken }) {
    if (!this.provider.renewal || !this.provider.longSessions) throw new Error("服务端未开启长效登录（FEISHU_SESSION_RENEWAL_ENABLED、FEISHU_LONG_SESSION_DAYS），无法授权无人值守运行");
    if (appId !== this.provider.appId) throw new Error("授权来自另一个应用");
    if (this.allowedTenants && !this.allowedTenants.has(tenantId)) throw new Error("这个租户不在允许范围内");
    if (typeof refreshToken !== "string" || !refreshToken) throw new Error("这次授权没有拿到飞书的长效凭据");
    const notAfter = this.now() + this.provider.longSessionMs;
    const sealed = this.store.seal({ appId, tenantId, userId, refreshToken, notAfter });
    // Absolute, and stored in the clear beside the seal. The sealed `notAfter` is
    // re-anchored to now + window on every bind, so a task running daily would
    // renew its own window forever -- showing that as the expiry would be a lie.
    const expiresAt = Math.min(this.now() + this.windowDays * DAY_MS, notAfter);
    await this.store.write(tenantId, userId, { sealed, state: "active", reason: null, failures: 0,
      grantedAt: this.now(), expiresAt, notAfter, lastUsedAt: null });
    this.#forget(tenantId, userId);
    this.#record({ kind: "unattended_consent_granted", tenantId, userId, expiresAt });
    return { expiresAt };
  }

  async revoke(who) {
    const had = await this.store.remove(who.tenantId, who.userId);
    // A run in flight dies with it: its sandbox token is a child of this session
    // and the whole family goes. Taking consent back has to stop what it started.
    this.#forget(who.tenantId, who.userId, { revokeSession: true });
    if (had) this.#record({ kind: "unattended_consent_revoked", tenantId: who.tenantId, userId: who.userId });
    return had;
  }

  #forget(tenantId, userId, { revokeSession = false } = {}) {
    const key = this.#key(tenantId, userId);
    const held = this.live.get(key);
    if (held && revokeSession) { try { this.sessions.revoke(held.token); } catch { /* already gone */ } }
    this.live.delete(key);
    this.unreachable.delete(key);
  }

  // Reads the clear metadata only: no seal opened, no network call, so the
  // desktop can ask for this as often as it likes.
  async status(who) {
    // `windowDays` travels even when nothing is granted: the confirmation card
    // has to name the date this would actually run until, and a card that
    // guesses one is worse than a card that does not mention it.
    const base = { available: true, windowDays: this.windowDays };
    const record = await this.store.read(who.tenantId, who.userId);
    if (!record) return { ...base, authorized: false, expiresAt: null, state: null, reason: null, lastUsedAt: null };
    return { ...base, authorized: record.state === "active" && record.expiresAt > this.now(),
      expiresAt: record.expiresAt, state: record.state, reason: record.reason, lastUsedAt: record.lastUsedAt };
  }

  // What the scheduler falls back to. Returns `{ok:true, token}` or a refusal
  // carrying `retry`: true means "this was a bad moment, keep the schedule
  // active"; false means the credential is finished and the schedule suspends.
  async identity(tenantId, userId) {
    const key = this.#key(tenantId, userId);
    const held = this.live.get(key);
    if (held && held.expiresAt - this.now() >= this.minRemainingMs && this.sessions.verify(held.token)) {
      return { ok: true, token: held.token, expiresAt: held.expiresAt };
    }
    this.live.delete(key);
    // One bad moment is one failure. Due schedules are authorized one after
    // another, not at once, so without this each retried the exchange: three due
    // at 09:00 during a blip were three strikes, and the credential was finished
    // within a second -- with a reason saying Feishu had refused.
    const unreachable = this.unreachable.get(key);
    if (unreachable && unreachable.until > this.now()) return unreachable.answer;
    this.unreachable.delete(key);
    // Collapsed, not merely deduplicated: two schedules due in the same tick
    // would otherwise both exchange the same refresh token, and the second
    // exchange spends a token the first already spent.
    const existing = this.minting.get(key);
    if (existing) return existing;
    const minting = this.#mint(tenantId, userId, key).finally(() => { this.minting.delete(key); });
    this.minting.set(key, minting);
    return minting;
  }

  async #terminal(tenantId, userId, reason, { remove = false } = {}) {
    if (remove) await this.store.remove(tenantId, userId).catch(() => {});
    else await this.store.patch(tenantId, userId, { state: "needs_reauthorization", reason }).catch(() => {});
    this.#forget(tenantId, userId);
    this.#record({ kind: "unattended_refused", tenantId, userId, terminal: true });
    return { ok: false, retry: false, reason };
  }

  async #mint(tenantId, userId, key) {
    const record = await this.store.read(tenantId, userId);
    if (!record) return { ok: false, retry: false, reason: "没有开启无人值守运行，这个任务只能在你登录时执行，已暂停。到「定时任务」里开启后会自动恢复。" };
    // Marked records answer from disk: the second schedule due in the same tick
    // must not produce a second refusal from Feishu.
    if (record.state !== "active") return { ok: false, retry: false, reason: record.reason ?? "无人值守授权已失效，任务已暂停，请重新授权。" };
    if (record.expiresAt <= this.now()) return this.#terminal(tenantId, userId, "无人值守授权已到期，任务已暂停。重新授权后自动恢复。");

    let opened;
    try { opened = this.store.unseal(record); }
    catch { return this.#terminal(tenantId, userId, "服务端保存的授权无法读取（服务端可能重装或更换了密钥），任务已暂停，请重新授权。", { remove: true }); }

    // Every check that can be made before the token is spent, is.
    if (opened.notAfter <= this.now()) return this.#terminal(tenantId, userId, "无人值守授权已过期，任务已暂停，请重新授权。", { remove: true });
    if (opened.appId !== this.provider.appId) return this.#terminal(tenantId, userId, "服务端的飞书应用已更换，任务已暂停，请重新授权。", { remove: true });
    if (this.allowedTenants && !this.allowedTenants.has(opened.tenantId)) return this.#terminal(tenantId, userId, "你的租户已不在允许列表中，任务已暂停。");
    if (opened.tenantId !== tenantId || opened.userId !== userId) return this.#terminal(tenantId, userId, "保存的授权与这个任务的归属不一致，任务已暂停。", { remove: true });

    let identity;
    try { identity = await this.provider.adoptRefreshed({ refreshToken: opened.refreshToken }); }
    catch (error) { return this.#afterFailedExchange(tenantId, userId, record, error); }

    try {
      if (identity.tenantId !== opened.tenantId || identity.userId !== opened.userId || identity.appId !== opened.appId) {
        throw new Error("identity_changed");
      }
      // Before anything else can fail. The token Feishu just handed back is the
      // only one that still works, and right now it exists nowhere but memory.
      const resealed = this.provider.renewal.sealPending(identity, (pending) =>
        this.store.seal({ appId: identity.appId, tenantId, userId, refreshToken: pending.refreshToken, notAfter: pending.notAfter }));
      if (resealed) {
        // A write that fails is logged by its own rejection, not fatal: Feishu
        // does not always rotate, so the stored copy may well still work, and
        // today's run is not worth discarding over tomorrow's uncertainty.
        await this.store.write(tenantId, userId, { ...record, sealed: resealed, lastUsedAt: this.now(), failures: 0 })
          .catch(() => this.store.patch(tenantId, userId, { state: "needs_reauthorization", reason: "服务端未能保存续期后的凭据，请重新授权。" }).catch(() => {}));
      }

      const ttlMs = Math.min(15 * 60_000, Math.floor(identity.expiresAt - this.now()));
      if (ttlMs < 1) throw new Error("expired");
      let issued = null;
      try {
        // Spread, so the login's capabilities travel with it. Without them the
        // run's own Feishu calls and its result push are refused by the CLI
        // proxy, in words that point nowhere near this line.
        issued = this.sessions.issue({ ...identity, deviceId: this.store.deviceId, ttlMs,
          authProvider: "feishu", deviceProof: "ed25519-login" });
        this.provider.sourceAccess?.bind(identity, issued);
        this.provider.renewal.bind(identity, issued, this.store.publicKey);
      } catch (error) { if (issued) this.sessions.revoke(issued.token); throw error; }

      this.live.set(key, { token: issued.token, expiresAt: issued.expiresAt });
      this.#record({ kind: "unattended_identity_minted", tenantId, userId, expiresAt: issued.expiresAt });
      return { ok: true, token: issued.token, expiresAt: issued.expiresAt };
    } catch {
      return { ok: false, retry: true, reason: "服务端未能为这次运行建立身份，这次跳过，下次仍会尝试。" };
    } finally {
      // Both registries, exactly as a login does it. After a successful bind
      // each is a no-op; after a failure it is what stops a token sitting in
      // memory until the five-minute prune.
      this.provider.sourceAccess?.discard(identity);
      this.provider.renewal?.discard(identity);
    }
  }

  // A refused exchange is usually final -- the person revoked the app in Feishu,
  // or the token aged out -- but not always. A five-minute outage at 3am should
  // not silently stop someone's task until they happen to look, so a transport
  // failure keeps the schedule and counts instead.
  async #afterFailedExchange(tenantId, userId, record, error) {
    const message = String(error?.message ?? error);
    const transport = /fetch|aborted|abort|timeout|network|ECONN|ENOTFOUND|EAI_AGAIN|socket/i.test(message);
    const failures = (record.failures ?? 0) + 1;
    if (transport && failures < 3) {
      await this.store.patch(tenantId, userId, { failures }).catch(() => {});
      this.#record({ kind: "unattended_refused", tenantId, userId, terminal: false });
      const answer = { ok: false, retry: true, reason: `暂时无法与飞书续期（${message.slice(0, 120)}），这次跳过，下次仍会尝试。` };
      this.unreachable.set(this.#key(tenantId, userId), { until: this.now() + UNREACHABLE_MS, answer });
      return answer;
    }
    // Said as what happened. After three occasions of not reaching Feishu at all,
    // "Feishu refused" would send the person looking for a revocation that never
    // took place.
    if (transport) return this.#terminal(tenantId, userId,
      "连续多次无法连上飞书完成续期，已停用无人值守运行，任务已暂停。网络恢复后请重新授权。");
    return this.#terminal(tenantId, userId,
      "飞书拒绝了这次续期（可能是你在飞书里撤销了本应用的授权，或长期未使用）。任务已暂停，重新登录并重新授权后恢复。");
  }

  // The minted sessions are left to the registry, which is cleared on shutdown
  // anyway; revoking them here would abort runs that are still finishing.
  close() { this.live.clear(); this.minting.clear(); this.unreachable.clear(); }
}
