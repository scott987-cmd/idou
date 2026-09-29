import { createPublicKey, randomBytes, verify } from "node:crypto";
import { renewalProofMessage, MAX_SESSION_WINDOW_MS } from "./login-proof.js";
import { ExpiryQueue, Shares, personOf } from "./limits.js";
import { SharedRecords } from "./shared-records.js";

const random = () => randomBytes(32).toString("base64url");
const same = (a, b) => a.appId === b.appId && a.tenantId === b.tenantId && a.userId === b.userId;
const denied = () => { throw new Error("Online session renewal unavailable; sign in again"); };

// What one person gets (limits.js): the whole pilot server's old numbers.
// The server's own are its capacity: signed-in sessions, renewals at once.
export const RENEWAL_PER_PERSON = Object.freeze({ signedIn: 16, renewals: 4 });

// Optional server-only, bounded in-memory authority. No refresh token, disk
// storage, credential getter or client credential import. Each parent has one
// challenge and one redemption attempt; uncertain delivery requires login.
export class SessionRenewal {
  #pending = new Map();
  #grants = new Map();
  #expiry = new ExpiryQueue();
  #held;
  #renewing;
  #records;
  // `state`: the shared store. Each session's grant is kept there too, sealed
  // -- the refresh token with it -- so that the replica reading the session
  // after a restart can renew it (docs/scaling-plan.md §2.4).
  constructor({ sessions, checkIdentity, transferSource, refreshSource = null, refreshIdentity = null, longSessionMs = 0, now = Date.now, diagnostic = () => {},
    capacity: { signedIn = 200_000, renewals = 128 } = {}, state = null, log = () => {} }) {
    this.#records = state ? new SharedRecords({ state, namespace: "renewal-grant", log }) : null;
    if (typeof diagnostic !== "function") throw new Error("Invalid session renewal diagnostic sink");
    if (!Number.isSafeInteger(longSessionMs) || longSessionMs < 0 || longSessionMs > MAX_SESSION_WINDOW_MS) throw new Error("Invalid long session length");
    if (longSessionMs && typeof refreshIdentity !== "function") throw new Error("A long session needs a refresh exchange");
    Object.assign(this, { sessions, checkIdentity, transferSource, refreshSource, refreshIdentity, longSessionMs, now, diagnostic });
    this.closed = false;
    // A server sized below one person's share gives a person all of it.
    this.#held = new Shares({ max: signedIn, perPerson: Math.min(RENEWAL_PER_PERSON.signedIn, signedIn), name: "signed-in sessions" });
    this.#renewing = new Shares({ max: renewals, perPerson: Math.min(RENEWAL_PER_PERSON.renewals, renewals), name: "renewals" });
    this.revoked = id => this.remove(id); sessions.on("revoked", this.revoked);
  }
  // Renewals under way on this server; and how many sessions hold a grant.
  get active() { return this.#renewing.total; }
  get signedIn() { return this.#held.total; }
  capacity() { return { renewals: this.#renewing.total, renewalsLimit: this.#renewing.max }; }
  // A refused renewal ends the operator's working session, so the reason has to
  // reach the operator. Reasons name policy and upstream conditions only: no
  // token, session id, user id or tenant id is ever part of one.
  #deny(reason) { this.diagnostic(`在线续期被拒绝：${reason}`); denied(); }
  // A refresh token is what lets a login outlive its access token. It is held
  // only here, never returned to a client, and a long session is offered only
  // when one was actually granted.
  remember(identity, token, refreshToken = null) {
    this.prune();
    const refused = this.closed ? "closed" : this.#held.refusal(personOf(identity));
    if (refused) this.#deny(refused === "closed" ? "续期服务已关闭" : refused === "person" ? "这个账号同时登录的设备过多" : "服务器同时登录的会话已达上限");
    const pending = { token: Buffer.from(token), identity: { ...identity },
      refresh: this.longSessionMs && refreshToken ? Buffer.from(refreshToken) : null,
      expiresAt: Math.min(identity.expiresAt, this.now() + 300000) };
    this.#pending.set(identity, pending); this.#held.take(personOf(identity));
    this.#expiry.add(pending.expiresAt, identity, pending);
  }
  discard(identity) {
    const row = this.#pending.get(identity);
    if (!row) return;
    row.token.fill(0); row.refresh?.fill(0); this.#pending.delete(identity); this.#held.give(personOf(row.identity));
  }
  bind(identity, issued, key) {
    this.prune(); const pending = this.#pending.get(identity), who = this.sessions.verify(issued.token);
    if (this.closed || !pending || !who || !same(who, identity) || key?.asymmetricKeyType !== "ed25519") this.#deny("登录时无法绑定续期凭据");
    // The login's place becomes the session's: counted once throughout.
    this.#pending.delete(identity);
    // Without a refresh token a login can never outlive the access token, so the
    // ceiling stays the original four hours. With one it is the configured
    // window, and the access token is exchanged along the way.
    const ceiling = pending.refresh ? this.now() + this.longSessionMs : Math.min(identity.expiresAt, this.now() + 14400000);
    this.#keep(who.id, { ...pending, key, notAfter: ceiling,
      expiresAt: who.expiresAt, controller: new AbortController(), spent: false });
  }
  #keep(id, grant, { share = true } = {}) {
    this.#grants.set(id, grant); this.#expiry.add(grant.expiresAt, id, grant);
    if (share) this.#save(id, grant);
  }
  // What of a grant is kept. A pending challenge is not: a restart between
  // asking for one and answering it ends in signing back in, as a lost answer
  // always has.
  #save(id, grant) {
    void this.#records?.put(id, { token: grant.token.toString("base64url"), identity: grant.identity, refresh: grant.refresh ? grant.refresh.toString("base64url") : null,
      key: grant.key.export({ type: "spki", format: "der" }).toString("base64url"), notAfter: grant.notAfter, expiresAt: grant.expiresAt, spent: grant.spent === true },
    grant.expiresAt, this.now());
  }
  // Revoked or expired: gone from the store too. Closing is neither.
  remove(id) {
    const grant = this.#grants.get(id);
    if (!grant) return;
    grant.controller.abort(); grant.token.fill(0); grant.refresh?.fill(0); this.#grants.delete(id); this.#held.give(personOf(grant.identity));
    if (!this.closed) void this.#records?.delete(id);
  }
  // A session read from the shared store (sessions.js): its grant, if one was
  // kept. True when it is here now.
  async load(sessionId) {
    if (!this.#records || this.#grants.has(sessionId)) return this.#grants.has(sessionId);
    const value = await this.#records.get(sessionId);
    if (!value || this.#grants.has(sessionId)) return this.#grants.has(sessionId);
    let key;
    try { key = createPublicKey({ key: Buffer.from(value.key, "base64url"), format: "der", type: "spki" }); } catch { return false; }
    if (key.asymmetricKeyType !== "ed25519" || typeof value.token !== "string" || !value.identity || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now() || !Number.isSafeInteger(value.notAfter)) return false;
    this.#held.take(personOf(value.identity));
    this.#keep(sessionId, { token: Buffer.from(value.token, "base64url"), identity: value.identity, refresh: value.refresh ? Buffer.from(value.refresh, "base64url") : null,
      key, notAfter: value.notAfter, expiresAt: value.expiresAt, controller: new AbortController(), spent: value.spent === true }, { share: false });
    return true;
  }
  persisted(sessionId) { return this.#records ? this.#records.settled(sessionId) : Promise.resolve(true); }
  flush() { return this.#records?.flush() ?? Promise.resolve(); }
  // Only what has expired is looked at (limits.js).
  prune() {
    const now = this.now();
    for (let entry; (entry = this.#expiry.due(now));) {
      const { key, value } = entry;
      if (this.#grants.get(key) === value) { if (value.expiresAt > now) this.#expiry.add(value.expiresAt, key, value); else this.remove(key); }
      else if (this.#pending.get(key) === value) { if (value.expiresAt > now) this.#expiry.add(value.expiresAt, key, value); else this.discard(key); }
    }
  }
  // The refresh token stays inside this class. A caller that needs a durable
  // credential hands in a sealing function and gets back only the sealed result,
  // so the token itself never becomes a value anyone else holds.
  // The device key a renewal was proven with, for re-sealing the durable
  // credential around a refresh token this renewal may just have rotated.
  devicePublicKey(sessionId) {
    const grant = this.#grants.get(sessionId);
    return !this.closed && grant?.key ? grant.key.export({ type: "spki", format: "pem" }) : null;
  }
  sealRefresh(sessionId, seal) {
    const grant = this.#grants.get(sessionId);
    if (this.closed || !grant || !grant.refresh || typeof seal !== "function") return null;
    return seal({ refreshToken: grant.refresh.toString("utf8"), notAfter: grant.notAfter });
  }
  // The same, for a refresh that has happened but whose session does not exist
  // yet. An unattended caller has to persist the token Feishu just rotated
  // *before* `bind`, because everything between the exchange and the grant can
  // still fail -- `remember` denies at the pending ceiling, `bind` refuses a
  // wrong key, the process can be killed -- and by then the old token is already
  // spent. Sealing afterwards would leave the stored copy holding a token that
  // no longer works, with nobody present to notice. The ceiling computed here is
  // the one `bind` is about to set, so nothing is overstated.
  sealPending(identity, seal) {
    const pending = this.#pending.get(identity);
    if (this.closed || !pending || !pending.refresh || typeof seal !== "function") return null;
    return seal({ refreshToken: pending.refresh.toString("utf8"), notAfter: this.now() + this.longSessionMs });
  }
  metadata(who) {
    const grant = this.#grants.get(who.id);
    return !this.closed && grant && !grant.spent && grant.notAfter > who.expiresAt ?
      { renewal: { renewAfter: who.expiresAt - 120000, notAfter: grant.notAfter } } : {};
  }
  current(token, expected) {
    this.prune(); const who = this.sessions.verify(token), grant = who && this.#grants.get(who.id);
    if (this.closed || !who || who.parentKey || !grant || expected && grant !== expected || grant.notAfter <= this.now()) {
      this.#deny(this.closed ? "续期服务已关闭" : !who ? "当前会话已失效" : !grant ? "这个会话没有续期授权" : grant.notAfter <= this.now() ? "已超过续期总时限，请重新登录" : "续期授权与会话不匹配");
    }
    return { who, grant };
  }
  begin(token) {
    const { who, grant } = this.current(token);
    if (grant.spent || grant.challenge || grant.notAfter <= who.expiresAt || this.now() < who.expiresAt - 120000) {
      this.#deny(grant.spent ? "这次续期授权已被使用" : grant.challenge ? "已有一次续期挑战在进行" : grant.notAfter <= who.expiresAt ? "已超过续期总时限，请重新登录" : `尚未进入续期窗口（还差 ${Math.ceil((who.expiresAt - 120000 - this.now()) / 1000)} 秒）`);
    }
    grant.challenge = { sessionId: who.id, challengeId: random(), nonce: random(), expiresAt: Math.min(who.expiresAt, this.now() + 60000) };
    return { ...grant.challenge };
  }
  async renew(origin, token, proof) {
    const { who, grant } = this.current(token), challenge = grant.challenge;
    if (grant.spent || !challenge || challenge.expiresAt <= this.now() || proof.challengeId !== challenge.challengeId ||
        typeof proof.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature) ||
        !verify(null, renewalProofMessage(origin, who.id, challenge.challengeId, challenge.nonce), grant.key, Buffer.from(proof.signature, "base64url"))) this.#deny("续期挑战已过期或设备签名不匹配");
    grant.spent = true;
    // Spent everywhere, not just here: a replica reading this grant after a
    // restart must not take it for unused.
    this.#save(who.id, grant);
    const person = personOf(who);
    if (this.#renewing.refusal(person)) this.#deny("同时进行的续期过多");
    this.#renewing.take(person); let issued;
    try {
      const signal = AbortSignal.any([grant.controller.signal, AbortSignal.timeout(10000)]);
      // The access token expires long before a long session does, so exchange
      // the refresh token first when it is close to the end. A refused exchange
      // ends the session rather than leaving an unverifiable one alive.
      if (grant.refresh && grant.identity.expiresAt <= this.now() + 300000) {
        const next = await this.refreshIdentity(grant.refresh, signal); signal.throwIfAborted();
        this.current(token, grant);
        grant.token.fill(0); grant.token = Buffer.from(next.accessToken);
        if (next.refreshToken) { grant.refresh.fill(0); grant.refresh = Buffer.from(next.refreshToken); }
        grant.identity = { ...grant.identity, expiresAt: next.expiresAt };
        // The session's source access holds its own copy of the access token;
        // it goes on with the new one, or it lapses with the old (see
        // FeishuSourceAccess.refreshed) and the transfer below finds nothing.
        this.refreshSource?.(token, next.accessToken, next.expiresAt);
      }
      const identity = await this.checkIdentity(grant.token, signal); signal.throwIfAborted();
      this.current(token, grant);
      if (!same(who, identity)) this.#deny("飞书返回的身份与当前会话不一致");
      const ttl = Math.min(900000, Math.floor(grant.notAfter - this.now()));
      const held = this.#held.refusal(person);
      if (ttl < 1 || held) this.#deny(ttl < 1 ? "已超过续期总时限，请重新登录" : held === "person" ? "这个账号同时登录的设备过多" : "服务器同时登录的会话已达上限");
      issued = this.sessions.rotate(token, ttl);
      this.transferSource?.(token, issued);
      this.#held.take(person);
      this.#keep(issued.id, { token: Buffer.from(grant.token), identity: grant.identity, key: grant.key,
        refresh: grant.refresh ? Buffer.from(grant.refresh) : null,
        notAfter: grant.notAfter, expiresAt: issued.expiresAt, controller: new AbortController(), spent: false });
      return issued;
    } catch (error) {
      // Failed live verification/rotation cannot preserve unverifiable authority.
      this.sessions.revoke(issued?.token || token);
      this.#deny(`在线身份核验或会话轮换失败：${String(error?.message ?? error).slice(0, 200)}`);
    } finally { this.#renewing.give(person); }
  }
  close() {
    this.closed = true; this.sessions.off("revoked", this.revoked);
    for (const identity of this.#pending.keys()) this.discard(identity);
    for (const id of this.#grants.keys()) this.remove(id);
  }
}
