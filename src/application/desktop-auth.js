import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, unlink, rmdir, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FeishuLoginClient, LoginRestartRequired, SESSION_IDENTITY_FIELDS, validateRenewal } from "./feishu-login-client.js";
import { validateServerUrl } from "../control-plane/client-session.js";
import { dataHome } from "../install-names.js";

// What every control-plane service answers for a session it does not know. Its
// sessions live only in its memory, so after it restarts -- every deploy -- it
// says this about every session there is.
export const SESSION_UNKNOWN = "session_expired_or_invalid";
const sessionUnknown = (error) => error?.status === 401 && error?.code === SESSION_UNKNOWN;
// How long a sign-in with the stored credential that could not reach the server
// waits before trying again: doubling from half a minute, then every five.
const RECONNECT_DELAYS_MS = Object.freeze([30_000, 60_000, 120_000, 300_000]);

function feishuIdentity(session) {
  const identity = session.identity;
  if (identity?.provider !== "feishu" || identity.deviceProof !== "ed25519-login" ||
      ![identity.appId, identity.tenantId, identity.userId].every((value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value))) throw new Error("飞书登录身份无效");
  return identity;
}

// Whose data an account directory holds: a person, in a tenant, of one Feishu
// application. It used to include the control plane's address as well, so
// moving a deployment -- 127.0.0.1 to a domain, a new port, a new machine --
// left every account's tasks and knowledge copy under a name the application no
// longer looked for. Deployments are already told apart by their Feishu
// application, and the address is still checked where it matters: the session
// lease and the stored resume credential both carry it.
export function accountNamespace(session) {
  const identity = feishuIdentity(session);
  return createHash("sha256").update(JSON.stringify([identity.appId, identity.tenantId, identity.userId])).digest("hex");
}

// The name the same account had while the address was part of it. Used only to
// find and rename an account's data once (src/desktop/account-migration.js).
export function legacyAccountNamespace(session) {
  const identity = feishuIdentity(session);
  return createHash("sha256").update(JSON.stringify([validateServerUrl(session.serverUrl), identity.appId, identity.tenantId, identity.userId])).digest("hex");
}

// Short-lived bearer credentials, never a model/app key. No renderer receives the
// token or file path. This process-owned 0700/0600 lease is removed on logout/exit;
// it is not persistent OS credential storage or per-request device attestation.
//
// It lives under the home directory, not `os.tmpdir()`: the coding agent's
// `workspace-write` sandbox makes the temp base a writable root, so a lease there
// could be replaced or deleted by the agent. `~/.idou/run` is not a sandbox
// root, which closes that tamper. (The sandbox still allows reads everywhere, so
// this does not by itself stop the agent from reading the token; keeping the
// token out of reach of a read is a separate, larger change.)
const LEASE_ROOT = path.join(dataHome(), "run");
export async function createSessionLease(session) {
  await mkdir(LEASE_ROOT, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(LEASE_ROOT, "agent-session-"));
  const filename = path.join(directory, "session.json");
  const staging = path.join(directory, "next.json");
  let closed = false, queue = Promise.resolve();
  const serialize = operation => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  // The lease carries the model-turn token when the server issued one (a Feishu
  // login), not the root token: the coding agent can read the lease, and a turn
  // token cannot mint media/Drive/MCP/skill children, so a read of it cannot
  // bypass the confirmation card. A dev connection has no turn token and falls
  // back to its own token. The desktop keeps the root token in memory (see
  // `operatorSession`) for the services that mint.
  const encode = value => JSON.stringify({ token: value.turnToken ?? value.token, expiresAt: value.expiresAt, serverUrl: value.serverUrl });
  const close = () => { closed = true; return serialize(async () => {
    await unlink(staging).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await unlink(filename).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }); };
  const replace = value => serialize(async () => {
    if (closed || value.serverUrl !== session.serverUrl || accountNamespace(value) !== accountNamespace(session) || value.identity.deviceId !== session.identity.deviceId) throw new Error("会话租约已关闭或身份变化");
    try {
      await writeFile(staging, encode(value), { mode: 0o600, flag: "wx" });
      if (closed) throw new Error("会话租约已关闭");
      await rename(staging, filename); // Atomic reader-visible switch at same path.
    } finally { await unlink(staging).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  });
  try {
    await writeFile(filename, encode(session), { mode: 0o600, flag: "wx" });
    return { filename, close, replace };
  } catch (error) { await close(); throw error; }
}

export class DesktopAuth {
  constructor({ serverUrl, openBrowser, activate, deactivate, client = new FeishuLoginClient(), leaseFactory = createSessionLease, resumeStore = null, now = Date.now, withRenewal = operation => operation(),
    renewalRetryMs = 5_000 }) {
    Object.assign(this, { serverUrl, openBrowser, activate, deactivate, client, leaseFactory, resumeStore, now, withRenewal, renewalRetryMs });
    this.stage = "idle"; this.generation = 0; this.active = null; this.pending = null; this.busy = false; this.closed = false; this.renewing = null; this.renewalState = "disabled"; this.renewalFailure = null; this.launchUrl = null; this.resumeFailure = null;
  }
  status() {
    const session = this.active?.session;
    return { configured: Boolean(this.serverUrl), serverUrl: this.serverUrl || null, stage: this.stage,
      connected: Boolean(session && session.expiresAt > this.now() && !["failed", "reconnecting"].includes(this.renewalState)), expiresAt: session?.expiresAt,
      identity: session ? structuredClone(session.identity) : null,
      pendingIdentity: this.pending ? structuredClone(this.pending.identity) : null,
      pendingExpiresAt: this.pending?.expiresAt, expired: Boolean(session && session.expiresAt <= this.now()),
      launchUrl: this.stage === "waiting" ? this.launchUrl ?? null : null,
      renewalState: this.renewalState, renewalNotAfter: session?.renewal?.notAfter,
      // A refused renewal ends the working session. The reason is the operator's
      // only clue, so it is kept and shown; these are fixed local messages and
      // upstream status codes, never a token or an identifier.
      renewalFailure: ["failed", "reconnecting"].includes(this.renewalState) ? this.renewalFailure : null,
      // Why a stored login could not be reused. Fixed local messages and upstream
      // status codes only — never a token, a credential or an identifier.
      resumeFailure: this.resumeFailure ?? null };
  }
  // The root session token, held only in memory. The lease on disk carries the
  // mint-incapable turn token, so the desktop's own services that mint
  // media/Drive/MCP/skill tokens must read the root from here, never from the
  // lease. Null when signed out or expired; callers then fall back to the lease
  // (a dev connection, whose own token mints).
  operatorSession() {
    const session = this.active?.session;
    if (!session || session.expiresAt <= this.now()) return null;
    return { token: session.token, serverUrl: session.serverUrl, expiresAt: session.expiresAt };
  }
  async revoke(session) {
    if (!session) return true;
    try { await this.client.request(session.serverUrl, "/auth/logout", {}, session.token); return true; } catch { return false; }
  }
  async retire(entry) {
    if (!entry) return { revoked: true, localCredentialRemoved: true };
    entry.retired = true;
    const [local, remote] = await Promise.allSettled([entry.lease.close(), this.revoke(entry.session)]);
    return { localCredentialRemoved: local.status === "fulfilled", revoked: remote.status === "fulfilled" && remote.value };
  }
  async begin() {
    if (this.closed || this.busy || this.renewing || this.stage !== "idle") throw new Error("请先完成或取消当前登录");
    const origin = validateServerUrl(this.serverUrl), generation = ++this.generation;
    this.stage = "starting";
    try {
      const result = await this.client.begin(origin);
      if (generation !== this.generation) throw new Error("登录已取消");
      this.stage = "waiting";
      // Kept so the operator has a way in when the system browser does not open,
      // or when authorization has to happen in a different browser. It is the
      // same loopback entry this process just opened, it is bound to this
      // device's key, and it stops being offered the moment the flow ends.
      this.launchUrl = result.launchUrl;
      await this.openBrowser(result.launchUrl);
      if (generation !== this.generation) throw new Error("登录已取消");
      return this.status();
    } catch (error) {
      if (generation === this.generation) { await this.client.cancel(); this.stage = "idle"; this.launchUrl = null; }
      throw error;
    }
  }
  // Where the browser that authorizes this sign-in comes back to on this
  // machine; an embedded authorization view has to be let through to it.
  loginReturnUrl() { return this.stage === "waiting" ? this.client.returnUrl?.() ?? null : null; }
  async poll() {
    if (this.stage !== "waiting" || this.busy) throw new Error("当前没有可检查的登录");
    const generation = this.generation;
    this.busy = true;
    try {
      const result = await this.client.complete();
      if (generation !== this.generation) { if (result.status === "authenticated") await this.revoke(result); throw new Error("登录已取消"); }
      if (result.status === "authenticated") {
        try { accountNamespace(result); }
        catch { await this.revoke(result); throw new LoginRestartRequired("飞书登录身份无效，请重新发起登录"); }
        this.pending = result; this.stage = "confirm";
      }
      return this.status();
    } catch (error) {
      if (error instanceof LoginRestartRequired && generation === this.generation) this.stage = "idle";
      throw error;
    } finally { this.busy = false; }
  }
  async cancel() {
    if (this.stage === "activating") throw new Error("正在切换账号，请稍后退出");
    ++this.generation; const pending = this.pending; this.pending = null; this.stage = "idle"; this.launchUrl = null;
    await Promise.all([this.client.cancel(), this.revoke(pending)]);
    return this.status();
  }
  async confirm() {
    if (this.closed || this.busy || this.renewing || this.stage !== "confirm") throw new Error("请先完成飞书授权并核对身份");
    const session = this.pending; this.busy = true; this.stage = "activating";
    let lease;
    try {
      if (session.expiresAt <= this.now()) throw new LoginRestartRequired("登录已过期，请重新登录");
      const current = await this.client.request(session.serverUrl, "/auth/session", undefined, session.token);
      let matches = false;
      try { matches = accountNamespace({ ...session, identity: current.identity }) === accountNamespace(session) && current.expiresAt === session.expiresAt && current.identity.deviceId === session.identity.deviceId; } catch {}
      if (!matches) throw new LoginRestartRequired("服务端身份已变化，请重新登录");
      validateRenewal(session, this.now());
      if (JSON.stringify(current.renewal) !== JSON.stringify(session.renewal)) throw new LoginRestartRequired("服务端续期策略已变化，请重新登录");
      if (session.expiresAt <= this.now()) throw new LoginRestartRequired("登录已过期，请重新登录");
      lease = await this.leaseFactory(session);
      if (session.expiresAt <= this.now()) throw new LoginRestartRequired("登录已过期，请重新登录");
      await this.activate({ namespace: accountNamespace(session), sessionFile: lease.filename, serverUrl: session.serverUrl, identity: structuredClone(session.identity) });
      await this.keepResume(session);
      const old = this.active;
      this.active = { session, lease }; this.pending = null; this.stage = "idle";
      this.schedule();
      const cleanup = await this.retire(old);
      return { ...this.status(), ...cleanup };
    } catch (error) {
      if (this.pending === session) {
        if (error instanceof LoginRestartRequired) {
          this.pending = null; this.stage = "idle";
          await this.revoke(session);
        } else this.stage = "confirm";
      }
      if (this.active?.lease !== lease) await lease?.close();
      throw error;
    } finally { this.busy = false; }
  }
  // The server hands back a sealed credential only when the deployment allows a
  // long session and Feishu granted a refresh token. Storing it is best effort:
  // failing to keep it costs one sign-in later, never this login.
  async keepResume(session) {
    if (!this.resumeStore) return;
    try {
      const namespace = accountNamespace(session);
      if (session.resume) await this.resumeStore.write(namespace, session.serverUrl, session.resume);
      else await this.resumeStore.clear(namespace);
    } catch { /* a convenience, never a failure of the login itself */ }
  }
  // Coming back after a restart. Every failure is terminal and silent: the
  // credential is dropped and the person sees the ordinary sign-in button, which
  // is exactly what they saw before this existed.
  async resume(namespace) {
    if (this.closed || !this.resumeStore || !this.serverUrl || this.busy || this.stage !== "idle" || this.active) return this.status();
    let origin; try { origin = validateServerUrl(this.serverUrl); } catch { return this.status(); }
    const credential = await this.resumeStore.read(namespace, origin).catch(() => null);
    if (!credential) { this.resumeFailure = this.resumeStore.lastError ?? "本机没有可用的登录凭据"; return this.status(); }
    const generation = ++this.generation;
    this.busy = true; this.stage = "resuming";
    let lease, session, settle;
    // Close waits for this: see close().
    this.resuming = new Promise((resolve) => { settle = resolve; });
    try {
      session = await this.client.resume(origin, credential);
      // By now the server has spent the stored credential and sealed a new one
      // into this answer. Arriving after the application began closing, or after
      // another sign-in started, the session is not used -- but the credential
      // is kept. Dropping it with the session meant the next start presented the
      // spent one, Feishu refused it ("a refresh token can only be used once"),
      // and the person was signed out for good; measured, by closing the
      // application seconds after it opened.
      if (this.closed || generation !== this.generation) { await this.keepResume(session); throw new Error("登录已切换"); }
      // The pointer may still hold the name the account had before names stopped
      // carrying the address; that is the same account, activated under its
      // current name, and its data moves there on the way (activate).
      const current = accountNamespace(session);
      if (current !== namespace && legacyAccountNamespace(session) !== namespace) throw new LoginRestartRequired("续用登录的账号与本机记录不一致");
      lease = await this.leaseFactory(session);
      await this.activate({ namespace: current, ...(current !== namespace ? { previous: namespace } : {}), sessionFile: lease.filename, serverUrl: session.serverUrl, identity: structuredClone(session.identity) });
      this.active = { session, lease }; this.pending = null; this.stage = "idle";
      this.schedule();
      await this.keepResume(session);
      if (current !== namespace) await this.resumeStore.clear(namespace).catch(() => {});
      return this.status();
    } catch (error) {
      this.stage = "idle";
      if (this.active?.lease !== lease) await lease?.close().catch(() => {});
      if (session?.token && !this.active) await this.revoke(session);
      // Only a refusal discards the credential. A control plane that was not up
      // yet, or a network that was not ready, must not cost the person their
      // stored login — that failure is retried on the next start.
      if (error instanceof LoginRestartRequired) await this.resumeStore.clear(namespace).catch(() => {});
      this.resumeFailure = String(error?.message ?? error).slice(0, 200);
      return this.status();
    } finally { this.busy = false; settle(); }
  }
  schedule() {
    clearTimeout(this.expiryTimer); clearTimeout(this.renewalTimer); clearTimeout(this.reconnectTimer);
    const entry = this.active; if (!entry) return;
    this.expiryTimer = setTimeout(() => { if (this.active === entry) void this.expire(entry); }, Math.max(0, entry.session.expiresAt - this.now()));
    this.expiryTimer.unref?.();
    this.renewalState = entry.session.renewal ? "scheduled" : "disabled"; this.renewalFailure = null;
    if (entry.session.renewal) {
      const attempt = () => {
        if (this.closed || this.active !== entry) return;
        // setTimeout may fire a fraction of a millisecond early, and the client
        // refuses any renewal before renewAfter. Re-arm for the remainder rather
        // than spending the session on a timer-rounding artifact: that refusal
        // is local, so no server authority is in doubt and nothing is retried.
        const remaining = entry.session.renewal.renewAfter - this.now();
        if (remaining > 0) { this.renewalTimer = setTimeout(attempt, remaining + 1); this.renewalTimer.unref?.(); return; }
        // Busy with a sign-in step: not now, but soon. It used to stop here for
        // good -- nothing asked again, the session ran out, and the account
        // signed back in with its stored credential, leaving a gap in which a
        // turn failed with "Development session expired" (2026-09-23, a work
        // task sent while renewal had paused at its time).
        if (this.busy || this.stage !== "idle") {
          this.renewalState = "paused";
          if (entry.session.expiresAt - this.now() > this.renewalRetryMs) { this.renewalTimer = setTimeout(attempt, this.renewalRetryMs); this.renewalTimer.unref?.(); }
          return;
        }
        void this.renew().catch(() => {});
      };
      this.renewalTimer = setTimeout(attempt, Math.max(0, entry.session.renewal.renewAfter - this.now()));
      this.renewalTimer.unref?.();
    }
  }
  async renew() {
    if (this.renewing) return this.renewing;
    if (this.closed || this.busy || this.stage !== "idle" || !this.active?.session.renewal) throw new Error("当前无法续期");
    clearTimeout(this.renewalTimer);
    this.renewing = this.renewActive();
    try { return await this.renewing; } finally { this.renewing = null; }
  }
  async renewActive() {
    const entry = this.active, dead = entry.session, generation = this.generation; this.renewalState = "renewing";
    const current = () => {
      if (this.closed || this.active !== entry || generation !== this.generation || entry.session !== dead || entry.session.expiresAt <= this.now()) throw new Error("续期已取消或过期");
    };
    try {
      return await this.withRenewal(async () => {
        current(); const next = await this.client.renew(entry.session); current();
        await entry.lease.replace(next); current();
        entry.session = next; this.schedule();
        // A renewal can spend and replace Feishu's refresh token (it rotates when
        // the access token is refreshed, about every two hours), and the server
        // hands back a credential re-sealed around the new one. Keep it -- but
        // only a credential actually handed back: a renewal without one must
        // leave the stored credential alone, never clear it (that version wiped
        // the credential at the first renewal, thirteen minutes in).
        if (typeof next.resume === "string" && next.resume) await this.keepResume(next);
        return this.status();
      });
    } catch (error) {
      // Replaced while this renewal was on its way, by a sign-in with the stored
      // credential (after a sleep, the expiry and the renewal fall due together):
      // this renewal's outcome no longer concerns the account.
      if (!this.closed && this.active === entry && entry.session !== dead) return this.status();
      // However the renewal failed, sign back in with the stored credential
      // rather than stop (lapse): the server no longer knows the session (it
      // restarted), refused the renewal (on 2026-09-23 a server fault refused
      // every one two hours in), gave no answer, or the session lapsed before
      // this ran (the machine slept). No answer was the costly one to leave
      // out: a renewal that fell into a server restart's ninety seconds got a
      // 502 and ended the session for good. A sign-in that cannot reach the
      // server either keeps the session and tries again; the credential it
      // spends comes back resealed, so nothing is lost by trying.
      if (!this.closed && this.active === entry) {
        if (await this.lapse(entry, dead)) return this.status();
      }
      // No automatic retry/replay. Also revoke a possibly issued but undelivered
      // successor using the still-current parent in its family.
      if (this.active === entry) { this.renewalState = "failed"; this.renewalFailure ??= String(error?.message ?? error).slice(0, 300); clearTimeout(this.expiryTimer); }
      await this.retire(entry);
      throw error;
    }
  }
  // A working session the server no longer knows, or one that lapsed while the
  // machine slept, is signed back in with the stored credential: what a restart
  // of the application does (resume), but in place, the way a renewal replaces
  // a session -- same account, same device, same lease, so every service picks
  // the new token up on its next request and the coding agent within its token
  // refresh. The control plane moving to a server made this the common case:
  // its sessions live only in its memory, so every deploy drops them all, and
  // until now each person saw session_expired_or_invalid until they restarted
  // the application (2026-09-22, on the 定时任务 page).
  //
  // `token` is the one a request was refused with: once the session has been
  // replaced since, there is nothing to do but ask again. Any number of callers
  // share one attempt. True when the account is connected again.
  async recover(token) {
    const entry = this.active;
    if (this.closed || !entry) return false;
    const dead = entry.session;
    if (typeof token === "string" && token !== dead.token) return this.status().connected;
    await this.renewing?.catch(() => {});
    await this.lapse(entry, dead);
    return this.active === entry && this.status().connected;
  }
  // True when the account is connected again or a later attempt is on its way;
  // false leaves the caller to end the session as it did before.
  lapse(entry, dead) {
    if (this.closed || this.active !== entry || entry.retired) return Promise.resolve(false);
    if (entry.session !== dead) return Promise.resolve(true);
    entry.lapsing ??= this.reconnect(entry, dead).finally(() => { entry.lapsing = null; });
    return entry.lapsing;
  }
  async reconnect(entry, dead) {
    if (!this.resumeStore || this.busy || this.stage !== "idle") return false;
    let origin; try { origin = validateServerUrl(dead.serverUrl); } catch { return false; }
    const namespace = accountNamespace(dead);
    const credential = await this.resumeStore.read(namespace, origin).catch(() => null);
    if (!credential || this.closed || this.active !== entry || entry.session !== dead) return false;
    clearTimeout(this.renewalTimer); clearTimeout(this.expiryTimer); clearTimeout(this.reconnectTimer);
    this.renewalState = "recovering"; this.renewalFailure = null;
    const generation = this.generation;
    let policyChanged = false;
    try {
      await this.withRenewal(async () => {
        // Closing waits for this answer, as for a resume at start (see close).
        let settle, next; this.resuming = new Promise((resolve) => { settle = resolve; });
        try {
          next = await this.client.resume(origin, credential);
          // The server has spent the stored credential and sealed a new one into
          // this answer: keep it whatever happens next, or the next start presents
          // a spent one (see resume) -- unless the person signed out meanwhile,
          // which must leave no way back in (logout waits for this).
          if (accountNamespace(next) === namespace && (this.closed || this.active)) await this.keepResume(next);
        } finally { this.resuming = null; settle(); }
        if (this.closed || this.active !== entry || entry.session !== dead || generation !== this.generation) { await this.revoke(next); throw new Error("登录已切换"); }
        if (accountNamespace(next) !== namespace) { await this.revoke(next); throw new LoginRestartRequired("续用登录的账号与本机记录不一致"); }
        // What the desktop built on for this account must not change under it;
        // a changed policy is taken up by a restart, which the credential serves.
        if (SESSION_IDENTITY_FIELDS.some((field) => next.identity?.[field] !== dead.identity[field])) { policyChanged = true; await this.revoke(next); throw new Error("服务端的登录策略有变化"); }
        await entry.lease.replace(next);
        entry.session = next; entry.reconnects = 0; this.schedule();
      });
      return true;
    } catch (error) {
      if (this.closed || this.active !== entry) return true;
      // Replaced, and only a component's own refresh afterwards failed.
      if (entry.session !== dead) return true;
      if (policyChanged) {
        this.renewalFailure = "服务端的登录策略有变化。按 ⌘Q 退出 i豆 再打开，会用本机凭据按新策略登录。";
        return false;
      }
      if (error instanceof LoginRestartRequired) {
        await this.resumeStore.clear(namespace).catch(() => {});
        this.renewalFailure = `服务端不认这次登录了，用本机凭据重新登录也被拒绝：${String(error.message).slice(0, 200)}`;
        return false;
      }
      // Not reached, or not up yet: nothing was refused, so the credential is
      // kept and the lease stays for the next attempt.
      entry.reconnects = (entry.reconnects ?? 0) + 1;
      this.renewalState = "reconnecting"; this.renewalFailure = String(error?.message ?? error).slice(0, 200);
      const delay = RECONNECT_DELAYS_MS[Math.min(entry.reconnects, RECONNECT_DELAYS_MS.length) - 1];
      this.reconnectTimer = setTimeout(() => { void this.lapse(entry, dead).then((again) => { if (!again) return this.end(entry, dead); }); }, delay);
      this.reconnectTimer.unref?.();
      return true;
    }
  }
  // The end of a session nothing renewed -- most often a machine that slept
  // through it. Signed back in when that works; otherwise it ends as it always
  // did, and its lease with it.
  async expire(entry) {
    const dead = entry.session;
    if (!await this.lapse(entry, dead)) await this.end(entry, dead);
  }
  async end(entry, dead) {
    if (this.closed || this.active !== entry || entry.session !== dead || entry.retired) return;
    // Over for good: with its lease closed, no sign-in can be put into it, and
    // one that tried would spend the credential again each time it failed.
    entry.retired = true;
    clearTimeout(this.reconnectTimer);
    this.renewalState = this.renewalFailure ? "failed" : "expired";
    await entry.lease.close().catch(() => {});
  }
  async logout() {
    if (this.busy) throw new Error("正在处理登录，请稍后退出");
    this.busy = true;
    try {
      await this.cancel();
      await this.deactivate();
      const old = this.active; this.active = null; clearTimeout(this.expiryTimer); clearTimeout(this.renewalTimer); clearTimeout(this.reconnectTimer); this.renewalState = "disabled"; this.renewalFailure = null;
      // A sign-in with the stored credential already on its way finishes first,
      // so the credential it brings back is not written after the one cleared here.
      await old?.lapsing?.catch(() => {});
      // Leaving the durable credential behind would let the next start silently
      // sign back in to the account the person just left.
      if (old && this.resumeStore) { try { await this.resumeStore.clear(accountNamespace(old.session)); } catch { /* best effort */ } }
      await this.renewing?.catch(() => {});
      return { ...this.status(), ...await this.retire(old) };
    } finally { this.busy = false; }
  }
  async close() {
    this.closed = true; ++this.generation; clearTimeout(this.expiryTimer); clearTimeout(this.renewalTimer); clearTimeout(this.reconnectTimer);
    // A resume already sent has already spent the stored credential; give its
    // answer a bounded moment to arrive so the new one can be kept.
    if (this.resuming) await Promise.race([this.resuming, new Promise((resolve) => { const timer = setTimeout(resolve, 15_000); timer.unref?.(); })]);
    // Desktop shutdown waits for in-flight auth IPC before invoking close.
    const old = this.active, pending = this.pending; this.active = null; this.pending = null;
    await this.client.cancel();
    await Promise.all([this.retire(old), this.revoke(pending)]);
    await this.renewing?.catch(() => {});
  }
}
