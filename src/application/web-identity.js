// Which Feishu account the embedded web pages are signed in as, compared with
// the account signed in to the application.
//
// Nothing a Feishu page says about itself is evidence of that: a name in its
// header, an avatar, the fact that it is "logged in". So the answer is asked of
// Feishu, through this application's own authorization: the embedded browser
// (same partition as the pages, so same Feishu session) is sent through the
// control plane's launch URL, Feishu's authorize page answers for whoever is
// signed in there, and the control plane -- the only party holding the
// application secret -- redeems the code and compares. What comes back here is
// a verdict: the other account's identifiers never leave the server.
//
// When Feishu redirects straight through, the check is silent. When it shows a
// page instead -- a consent screen, or a sign-in because the pages are signed
// out -- the check asks the person to look at it. It never clicks anything.
//
// The Electron side is injected (`open`), so everything that decides what the
// verdict means is tested without a window.
export const WEB_IDENTITY = Object.freeze({
  UNVERIFIED: "unverified",
  CHECKING: "checking",
  VERIFIED: "verified",
  CONFLICT: "conflict",
});

const REASONS = Object.freeze({
  declined: "飞书页面上的授权没有完成",
  probe_failed: "飞书没有完成这次核对",
  expired: "核对超时",
  unavailable: "服务端没有开启网页账号核对",
  failed: "核对没有完成",
  reset: "网页登录状态变了，需要重新核对",
  // Nothing to check: the pages are not signed in to Feishu at all. The check
  // waits for the sign-in instead of laying a sign-in page of its own over the
  // one the person should be scanning.
  signed_out: "左侧的飞书还没有登录",
});

const FLOW_ID = /^[A-Za-z0-9_-]{43}$/;

// A verdict is kept across restarts, bound to the pages' Feishu session it was
// reached with (a digest of their `session` cookie, never the cookie). Feishu
// asks the person to look at its page on every probe, so without this every
// restart put that page in front of them again. A different session -- someone
// signed in to the pages, or signed out and back in -- is a different digest and
// is checked afresh; the same one is checked again after a week regardless.
export const REMEMBERED_VERDICT_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST = /^[0-9a-f]{64}$/;
export function rememberedVerdict(stored, { session, now }) {
  if (!stored || stored.version !== 1 || stored.state !== WEB_IDENTITY.VERIFIED) return null;
  if (!DIGEST.test(stored.session ?? "") || !DIGEST.test(session ?? "") || stored.session !== session) return null;
  const age = now - stored.checkedAt;
  return Number.isFinite(stored.checkedAt) && age >= 0 && age <= REMEMBERED_VERDICT_MS ? stored.checkedAt : null;
}
export const verdictRecord = (session, checkedAt) => ({ version: 1, state: WEB_IDENTITY.VERIFIED, session, checkedAt });

export class WebIdentityCheck {
  // begin()       -> { flowId, launchUrl, expiresAt }       (the server's begin route)
  // status(id)    -> { status, launched?, checkedAt? }      (the server's status route)
  // open(url)     -> { reveal(), close() }                  (loads url in the pages' partition)
  // launchPrefix  the only launch URL this will open: `${serverUrl}/auth/feishu/launch?flow=`
  constructor({ begin, status, open, launchPrefix, now = Date.now, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs = 1500, attentionAfterMs = 6000, onChange = () => {} }) {
    if (typeof begin !== "function" || typeof status !== "function" || typeof open !== "function") throw new Error("网页账号核对缺少依赖");
    if (typeof launchPrefix !== "string" || !/^https?:\/\/[^/]+\/auth\/feishu\/launch\?flow=$/.test(launchPrefix)) throw new Error("网页账号核对的入口地址不合法");
    Object.assign(this, { begin, status, open, launchPrefix, now, wait, pollMs, attentionAfterMs, onChange });
    this.current = { state: WEB_IDENTITY.UNVERIFIED, reason: null, cause: null, checkedAt: null, needsAttention: false };
    this.generation = 0;
    this.running = null;
  }

  snapshot() { return { ...this.current }; }

  // `cause` is the machine-readable half of `reason`, for callers that decide
  // what to do next (an automatic retry after "declined" would be nagging).
  #set(next) {
    this.current = { state: WEB_IDENTITY.UNVERIFIED, reason: null, cause: null, checkedAt: null, needsAttention: false, ...next };
    if (next.cause) this.current.reason = REASONS[next.cause] ?? REASONS.failed;
    this.onChange(this.snapshot());
  }
  get busy() { return Boolean(this.running); }

  // The pages signed in or out, the application signed out, the account
  // changed: whatever was concluded no longer describes anything. A probe still
  // running is abandoned and its answer, when it comes, is ignored.
  reset(reason = "reset") {
    this.generation += 1;
    this.#set({ state: WEB_IDENTITY.UNVERIFIED, cause: REASONS[reason] ? reason : "reset" });
  }

  // A verdict kept from an earlier run for this very session (the caller has
  // compared it: rememberedVerdict). Taken only while nothing has been concluded
  // since and no probe is running.
  restore(checkedAt) {
    if (this.running || this.current.state !== WEB_IDENTITY.UNVERIFIED || !Number.isFinite(checkedAt)) return false;
    this.#set({ state: WEB_IDENTITY.VERIFIED, checkedAt });
    return true;
  }

  // One probe at a time; a second caller shares the first one's answer.
  check() {
    if (!this.running) {
      this.running = this.#probe(this.generation).finally(() => { this.running = null; });
    }
    return this.running;
  }

  async #probe(generation) {
    const stale = () => generation !== this.generation;
    this.#set({ state: WEB_IDENTITY.CHECKING });
    let view = null;
    try {
      let begun;
      try { begun = await this.begin(); }
      catch (error) {
        if (stale()) return this.snapshot();
        this.#set({ state: WEB_IDENTITY.UNVERIFIED, cause: /web_identity_unavailable|HTTP 404/.test(String(error?.message)) ? "unavailable" : "failed" });
        return this.snapshot();
      }
      // Only ever the control plane's own launch URL for the flow it just made:
      // this browser carries the person's Feishu session.
      if (!FLOW_ID.test(begun?.flowId ?? "") || begun.launchUrl !== `${this.launchPrefix}${begun.flowId}` || !Number.isFinite(begun.expiresAt)) {
        throw new Error("服务端返回了无效的核对入口");
      }
      if (stale()) return this.snapshot();
      view = await this.open(begun.launchUrl);
      const startedAt = this.now();
      let revealed = false;
      while (!stale()) {
        if (this.now() >= begun.expiresAt) { this.#set({ state: WEB_IDENTITY.UNVERIFIED, cause: "expired" }); break; }
        let seen;
        try { seen = await this.status(begun.flowId); }
        catch (error) {
          // Expired and pruned on the server, or the session changed under it.
          if (stale()) break;
          this.#set({ state: WEB_IDENTITY.UNVERIFIED, cause: /HTTP 404/.test(String(error?.message)) ? "expired" : "failed" });
          break;
        }
        if (stale()) break;
        if (seen?.status === "verified") { this.#set({ state: WEB_IDENTITY.VERIFIED, checkedAt: seen.checkedAt ?? this.now() }); break; }
        if (seen?.status === "conflict") { this.#set({ state: WEB_IDENTITY.CONFLICT, checkedAt: seen.checkedAt ?? this.now() }); break; }
        if (seen?.status !== "pending") { this.#set({ state: WEB_IDENTITY.UNVERIFIED, cause: REASONS[seen?.status] ? seen.status : "failed" }); break; }
        // Still on Feishu's side after a few seconds: it is showing a page that
        // wants a person. Show it to them, and say why.
        if (!revealed && this.now() - startedAt >= this.attentionAfterMs) {
          revealed = true;
          view.reveal();
          this.#set({ state: WEB_IDENTITY.CHECKING, needsAttention: true });
        }
        await this.wait(this.pollMs);
      }
    } catch (error) {
      if (!stale()) this.#set({ state: WEB_IDENTITY.UNVERIFIED, cause: "failed" });
    } finally {
      view?.close();
    }
    return this.snapshot();
  }
}
