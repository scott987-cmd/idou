import { createHash } from "node:crypto";

// The identity an unattended run acts as, and the only place the control plane
// holds one.
//
// It exists because of a real gap rather than for symmetry: the session registry
// keeps token digests, never tokens, and the raw token lives in the desktop's
// memory. That is the right arrangement -- a server hoarding live credentials is
// a worse thing to breach -- but it leaves a scheduled task with no identity at
// the moment it must act, because the person is by definition not there.
//
// So the person hands one over, explicitly, while signed in. What is stored is
// exactly one token per (tenant, user), it cannot outlive the session it came
// from, and it can be taken back at any moment. Closing the desktop lets it
// lapse on its own, which is what makes "a schedule runs only inside your own
// login" true rather than merely intended.
const digest = (value) => createHash("sha256").update(value).digest("hex");

export class ScheduleConsent {
  constructor({ sessions, now = Date.now, audit = () => {}, allowDevelopment = false }) {
    if (!sessions) throw new Error("Schedule consent requires a session registry");
    Object.assign(this, { sessions, now, audit, allowDevelopment });
    this.granted = new Map();
  }

  #key(tenantId, userId) { return `${tenantId}\n${userId}`; }

  // Recorded against the session it came from, so a token that outlived its
  // session -- or came from a different person -- is never usable.
  grant(token) {
    const who = this.sessions.verify(token);
    if (!who) throw new Error("需要一个有效的登录才能授权定时任务");
    // A development server issues development logins and nothing else, so on one
    // the choice is between letting a development login authorize its own
    // schedules and never being able to run one at all. Production is
    // unchanged: only a verified Feishu login.
    if (who.authProvider !== "feishu" && !this.allowDevelopment) throw new Error("只有飞书登录可以授权定时任务");
    if (who.parentKey) throw new Error("定时任务授权必须来自主登录，而不是派生令牌");
    const key = this.#key(who.tenantId, who.userId);
    this.granted.set(key, { token, sessionId: who.id, expiresAt: who.expiresAt });
    this.audit(Object.freeze({ kind: "schedule_consent_granted", at: this.now(),
      tenantHash: digest(who.tenantId), userHash: digest(who.userId), expiresAt: who.expiresAt }));
    return { expiresAt: who.expiresAt };
  }

  revoke(who) {
    const key = this.#key(who.tenantId, who.userId);
    const had = this.granted.delete(key);
    if (had) this.audit(Object.freeze({ kind: "schedule_consent_revoked", at: this.now(),
      tenantHash: digest(who.tenantId), userHash: digest(who.userId) }));
    return had;
  }

  // Re-verified on every read rather than trusted from when it was granted: a
  // session that was revoked, rotated or simply expired must stop a run at the
  // next turn, not at the next restart.
  live(tenantId, userId) {
    const key = this.#key(tenantId, userId);
    const held = this.granted.get(key);
    if (!held) return null;
    const who = this.sessions.verify(held.token);
    if (!who || who.id !== held.sessionId || who.tenantId !== tenantId || who.userId !== userId) {
      this.granted.delete(key);
      return null;
    }
    return { token: held.token, expiresAt: who.expiresAt };
  }

  status(who) {
    const held = this.live(who.tenantId, who.userId);
    return { authorized: Boolean(held), expiresAt: held?.expiresAt ?? null };
  }

  // Rotation replaces the token without changing the person, so a desktop that
  // stays open keeps its schedules running by re-granting; nothing here extends
  // a lifetime on its own.
  prune() {
    for (const [key, held] of this.granted) {
      const who = this.sessions.verify(held.token);
      if (!who || who.id !== held.sessionId) this.granted.delete(key);
    }
  }

  clear() { this.granted.clear(); }
}
