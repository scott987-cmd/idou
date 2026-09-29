import { sourceAccessInput, SOURCE_ACCESS_SCOPE } from "../knowledge/source-access-contract.js";
import { sourceDeclaration } from "../knowledge/source-declaration.js";
import { wikiDigest, wikiHash, wikiManifest } from "../knowledge/manifest.js";
import { setTimeout as delay } from "node:timers/promises";
import { ACCOUNT_IDENTITY_SCOPE, accountCandidate, accountCandidateHash, tenantUserId } from "../providers/feishu/account-identity.js";
import { FEISHU_CLI_WRITE_ACTIONS, feishuCliWriteCapabilities } from "../providers/feishu/cli-write-contract.js";
import { feishuLoginScopes } from "../providers/feishu/login-scopes.js";
import { docxViewPermissionPath, scopeRefused, permissionPath, viewPermissionPath, wikiNodePath, WIKI_OBJECT_KINDS } from "../providers/feishu/openapi.js";
import { ExpiryQueue, Rates, Shares, personOf } from "./limits.js";
import { SharedRecords } from "./shared-records.js";

class AccessError extends Error { constructor(status, code) { super(code); this.status = status; } }
const denied = () => { throw new AccessError(403, "feishu_source_access_denied"); };
const sameUser = (a, b) => a.appId === b.appId && a.tenantId === b.tenantId && a.userId === b.userId;
// What one person gets (limits.js): what the whole pilot server used to allow.
// The server's own limits are its capacity (loadCapacity): signed-in sessions,
// Feishu reads at once, and Feishu reads a minute.
export const SOURCE_ACCESS_PER_PERSON = Object.freeze({ signedIn: 16, reads: 4, checksPerMinute: 100, scheduleCallsPerMinute: 100,
  identityChecksPerMinute: 120, originalsPerSecond: 2, bundleListsPerSecond: 20, bundleDownloadsPerSecond: 5 });
// Which schedule resource kinds carry a link, which capability each one needs,
// and which link builder writes its canonical address.
const LINKED_KINDS = new Set(["document", "sheet", "base"]);
const SCHEDULE_RESOURCE_CAPABILITIES = Object.freeze({ document: "documents", sheet: "sheets", base: "base" });
const SCHEDULE_RESOURCE_LINKS = Object.freeze({ document: "document", sheet: "sheet", base: "base" });
// Which refusal a Feishu answer is, or null when it is a success. A missing
// scope is the administrator's to fix; anything else Feishu refused is about the
// resource -- measured live, a node that is not there answers 131005 and a file
// that is not there 1063001 -- and sending that person to an administrator sent
// them to the wrong door.
const refusal = ({ ok, body }) => ok && body?.code === 0 ? null
  : scopeRefused(body?.code) ? "schedule_resource_probe_unavailable" : "schedule_resource_unreadable";

// Server-owned OAuth credentials; no token getter, persistence, refresh or
// client-supplied credential import. This checks access, not package provenance.
//
// Every request goes to the deployment's own OpenAPI origin, and every record it
// vouches for must name that deployment: `feishu` is the only place either is
// written down.
export class FeishuSourceAccess {
  #pending = new Map();
  #grants = new Map();
  #expiry = new ExpiryQueue();
  #signedIn;
  #reading;
  #records;
  // `state`: the shared store (state-store.js). Each session's grant is kept
  // there too, sealed, so a replica reading the session after a restart has
  // its Feishu access as well (docs/scaling-plan.md §2.4).
  constructor({ feishu, sessions, appId, fetchImpl = fetch, now = Date.now, originalOrigins = {}, bundleReadsEnabled = false, identityChecksEnabled = false, cliProxyScopes = [], cliWriteActions = [], scheduleResourcesEnabled = false,
    capacity: { signedIn = 200_000, reads = 128, readsPerMinute = 30_000 } = {}, state = null, log = () => {} }) {
    this.#records = state ? new SharedRecords({ state, namespace: "source-grant", log }) : null;
    if (!feishu?.openApi) throw new Error("飞书源访问需要一个说 OpenAPI 的部署定义");
    if (!feishu.ids.app(appId)) throw new Error("飞书源访问的应用 ID 与部署不符");
    this.feishu = feishu;
    if (!originalOrigins || typeof originalOrigins !== "object" || Array.isArray(originalOrigins)) throw new Error("Invalid Wiki original origins");
    // Only a deployment with the Wiki may be given its tenants' origins.
    this.originalOrigins = Object.freeze(Object.keys(originalOrigins).length ? feishu.references.tenantOrigins(originalOrigins) : {});
    if (typeof bundleReadsEnabled !== "boolean" || bundleReadsEnabled && !Object.keys(this.originalOrigins).length) throw new Error("Wiki bundle reads require configured original origins");
    this.bundleReadsEnabled = bundleReadsEnabled;
    if (typeof identityChecksEnabled !== "boolean") throw new Error("Invalid Feishu identity check policy");
    this.identityChecksEnabled = identityChecksEnabled;
    if (!Array.isArray(cliProxyScopes) || cliProxyScopes.length > 64 || cliProxyScopes.some(scope => typeof scope !== "string" || !/^[a-z][a-z0-9_.:-]{2,127}$/.test(scope)) || new Set(cliProxyScopes).size !== cliProxyScopes.length) throw new Error("Invalid Feishu CLI proxy scopes");
    this.cliProxyEnabled = cliProxyScopes.length > 0; this.cliProxyScopes = Object.freeze([...cliProxyScopes]);
    // Writes are a separate administrator decision on top of the bridge, and
    // each action carries its own exact request policy.
    if (!Array.isArray(cliWriteActions) || new Set(cliWriteActions).size !== cliWriteActions.length || cliWriteActions.some(action => !FEISHU_CLI_WRITE_ACTIONS.includes(action)) || cliWriteActions.length && !this.cliProxyEnabled) throw new Error("Invalid Feishu CLI write actions");
    this.cliWriteActions = Object.freeze([...cliWriteActions]); this.cliWriteCapabilities = feishuCliWriteCapabilities(cliWriteActions);
    if (typeof scheduleResourcesEnabled !== "boolean") throw new Error("Invalid schedule resource policy");
    this.scheduleResourcesEnabled = scheduleResourcesEnabled;
    this.requiredScopes = feishuLoginScopes({ originalOrigins: this.originalOrigins, bundleReadsEnabled, identityChecksEnabled, cliProxyScopes, scheduleResourcesEnabled });
    this.sessions = sessions; this.appId = appId; this.fetch = fetchImpl; this.now = now; this.closed = false;
    // Signed-in sessions holding a grant (and logins about to), and Feishu
    // reads under way: for the server and for each person. The rates are
    // public so a test can fill one.
    // A server sized below one person's share gives a person all of it.
    const per = SOURCE_ACCESS_PER_PERSON, perSecond = Math.max(1, Math.ceil(readsPerMinute / 60));
    const share = (max, perPerson, name) => ({ max, perPerson: Math.min(perPerson, max), name });
    this.#signedIn = new Shares(share(signedIn, per.signedIn, "signed-in sessions"));
    this.#reading = new Shares(share(reads, per.reads, "Feishu reads"));
    const rate = (windowMs, max, perPerson) => new Rates({ windowMs, now, ...share(max, perPerson, "Feishu reads") });
    this.rates = {
      checks: rate(60_000, readsPerMinute, per.checksPerMinute),
      schedule: rate(60_000, readsPerMinute, per.scheduleCallsPerMinute),
      identity: rate(60_000, readsPerMinute, per.identityChecksPerMinute),
      originals: rate(1000, perSecond, per.originalsPerSecond),
      bundleLists: rate(1000, perSecond, per.bundleListsPerSecond),
      bundleDownloads: rate(1000, perSecond, per.bundleDownloadsPerSecond),
    };
    this.revoked = id => this.remove(id); sessions.on("revoked", this.revoked);
    this.timer = setInterval(() => { this.prune(); for (const rate of Object.values(this.rates)) rate.sweep(); }, 30000); this.timer.unref();
  }
  // Feishu reads under way on this server; and how many sessions hold a grant.
  get active() { return this.#reading.total; }
  get signedIn() { return this.#signedIn.total; }
  capacity() { return { signedIn: this.#signedIn.total, signedInLimit: this.#signedIn.max, reads: this.#reading.total, readsLimit: this.#reading.max }; }
  // A Feishu read: one of this person's share and of the server's. `busy`
  // keeps one per session.
  #startRead(grant, who, code) {
    if (grant.busy || this.#reading.refusal(personOf(who))) throw new AccessError(429, code);
    grant.busy = true; this.#reading.take(personOf(who));
  }
  #endRead(grant, who) { grant.busy = false; this.#reading.give(personOf(who)); }
  remember(identity, accessToken) {
    this.prune();
    if (this.closed || this.#signedIn.refusal(personOf(identity)) || identity.appId !== this.appId || identity.expiresAt <= this.now()) denied();
    const pending = { token: Buffer.from(accessToken), identity: { ...identity }, expiresAt: Math.min(identity.expiresAt, this.now() + 300000) };
    this.#pending.set(identity, pending); this.#signedIn.take(personOf(identity));
    this.#expiry.add(pending.expiresAt, identity, pending);
  }
  discard(identity) {
    const value = this.#pending.get(identity);
    if (!value) return;
    value.token.fill(0); this.#pending.delete(identity); this.#signedIn.give(personOf(value.identity));
  }
  bind(identity, issued) {
    this.prune(); const pending = this.#pending.get(identity), who = this.sessions.verify(issued.token);
    if (this.closed || !pending || !who || who.authProvider !== "feishu" || who.audience !== "codex-model-gateway" || !sameUser(who, pending.identity)) denied();
    // The login's place becomes the session's: counted once throughout.
    this.#pending.delete(identity);
    this.#keep(who.id, { token: pending.token, identity: pending.identity, expiresAt: Math.min(pending.identity.expiresAt, who.expiresAt), controller: new AbortController(), busy: false });
  }
  #keep(id, grant, { share = true } = {}) {
    this.#grants.set(id, grant); this.#expiry.add(grant.expiresAt, id, grant);
    if (share) this.#save(id, grant);
  }
  // What of a grant is kept: the token and whose it is. The rest is this
  // process's own (an abort controller, whether a read is under way).
  #save(id, grant) { void this.#records?.put(id, { token: grant.token.toString("base64url"), identity: grant.identity, expiresAt: grant.expiresAt }, grant.expiresAt, this.now()); }
  // Revoked or expired: gone from the store too. Closing is neither -- the
  // grant is for whichever replica serves the session next.
  remove(id) {
    const value = this.#grants.get(id);
    if (!value) return;
    value.controller.abort(); value.token.fill(0); this.#grants.delete(id); this.#signedIn.give(personOf(value.identity));
    if (!this.closed) void this.#records?.delete(id);
  }
  // A session read from the shared store (sessions.js): its grant, if one was
  // kept. True when it is here now.
  async load(sessionId) {
    if (!this.#records || this.#grants.has(sessionId)) return this.#grants.has(sessionId);
    const value = await this.#records.get(sessionId);
    if (!value || this.#grants.has(sessionId)) return this.#grants.has(sessionId);
    if (typeof value.token !== "string" || !value.identity || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= this.now()) return false;
    this.#signedIn.take(personOf(value.identity));
    this.#keep(sessionId, { token: Buffer.from(value.token, "base64url"), identity: value.identity, expiresAt: value.expiresAt, controller: new AbortController(), busy: false }, { share: false });
    return true;
  }
  // Whether this session's grant has reached the shared store.
  persisted(sessionId) { return this.#records ? this.#records.settled(sessionId) : Promise.resolve(true); }
  flush() { return this.#records?.flush() ?? Promise.resolve(); }
  // The Feishu access token this session's reads and writes go out with,
  // replaced when the online renewal exchanges it (it lasts about two hours).
  // The grant used to keep the token it was bound with, and that token's
  // expiry: it was pruned at that expiry, and the next renewal found nothing to
  // transfer, refused itself and ended the session -- about two hours after
  // every sign-in, measured on the deployed server (2026-09-23).
  refreshed(parentToken, accessToken, expiresAt) {
    const { who, grant } = this.current(parentToken);
    if (typeof accessToken !== "string" || !accessToken || !Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) denied();
    grant.token.fill(0); grant.token = Buffer.from(accessToken);
    grant.identity = { ...grant.identity, expiresAt };
    grant.expiresAt = Math.min(expiresAt, who.expiresAt);
    this.#save(who.id, grant);
  }
  transfer(parentToken, issued) {
    const { who, grant } = this.current(parentToken), next = this.sessions.verify(issued.token);
    if (!next || next.parentKey || next.familyId !== who.familyId || !sameUser(who, next) || this.#signedIn.refusal(personOf(who))) denied();
    this.#signedIn.take(personOf(who));
    this.#keep(next.id, { token: Buffer.from(grant.token), identity: grant.identity,
      expiresAt: Math.min(grant.identity.expiresAt, next.expiresAt), controller: new AbortController(), busy: false });
  }
  // Only what has expired is looked at. An entry whose time moved later (a
  // refreshed token) goes back in the queue at its new time.
  prune() {
    const now = this.now();
    for (let entry; (entry = this.#expiry.due(now));) {
      const { key, value } = entry, held = this.#grants.get(key) === value || this.#pending.get(key) === value;
      if (!held) continue;
      if (value.expiresAt > now) { this.#expiry.add(value.expiresAt, key, value); continue; }
      if (this.#grants.get(key) === value) this.remove(key); else this.discard(key);
    }
  }
  current(parentToken, expected) {
    this.prune(); const who = this.sessions.verify(parentToken), grant = who && this.#grants.get(who.id);
    if (this.closed || !who || who.authProvider !== "feishu" || who.audience !== "codex-model-gateway" || !grant || !sameUser(who, grant.identity) || expected && expected !== grant || grant.expiresAt <= this.now()) denied();
    return { who, grant };
  }
  async json(url, token, signal, maxBytes = 65536) {
    return (await this.#read(url, token, signal, maxBytes, false)).body;
  }
  // Feishu answers its refusals -- a scope the caller lacks, a Wiki node or a file
  // that is not there -- with HTTP 400 and its usual JSON body (measured live).
  // `json()` reads any non-2xx as the upstream being down, which turned all of
  // them into one "请重新登录" whatever the cause. This also reads a 4xx body,
  // bounded and JSON only, and says whether it came back as a success: the body
  // of a refusal is consulted only to choose which refusal to give, and nothing
  // that did not come back 2xx can be accepted by any caller of this.
  async answer(url, token, signal, maxBytes = 65536) {
    return this.#read(url, token, signal, maxBytes, true);
  }
  async #read(url, token, signal, maxBytes, refusals) {
    const response = await this.fetch(url, { method: "GET", redirect: "error", signal, headers: { authorization: `Bearer ${token.toString("utf8")}` } });
    const readable = response.ok || refusals && response.status >= 400 && response.status < 500;
    if (!readable || !response.body || response.headers.get("content-type")?.split(";")[0] !== "application/json") { await response.body?.cancel(); throw new Error("upstream unavailable"); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maxBytes) { await reader.cancel(); throw new Error("response too large"); } chunks.push(Buffer.from(part.value)); }
      signal.throwIfAborted(); return { ok: response.ok, body: JSON.parse(Buffer.concat(chunks)) };
    } finally { reader.releaseLock(); }
  }
  // Internal reader for WikiPayloadVerifier; never exposed by handle().
  async readPublishedBundle(parentToken, shardKey, { coordinator, signal } = {}) {
    if (!this.bundleReadsEnabled || !wikiDigest(shardKey)) denied();
    const { who, grant } = this.current(parentToken);
    const declaration = structuredClone(coordinator.publishedSources(who, shardKey));
    const manifest = wikiManifest(declaration.publication.manifest), declarationHash = wikiHash(declaration);
    if (!this.feishu.supports("wiki") || !Object.hasOwn(this.originalOrigins, who.tenantId) || manifest.providerId !== this.feishu.id || manifest.driveTenantKey !== who.tenantId || wikiHash(manifest) !== declaration.publication.manifestHash) denied();
    this.#startRead(grant, who, "feishu_bundle_read_busy");
    const combined = AbortSignal.any([grant.controller.signal, AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    const current = () => {
      combined.throwIfAborted(); this.current(parentToken, grant);
      if (wikiHash(coordinator.publishedSources(who, shardKey)) !== declarationHash) denied();
    };
    const reserve = (rate) => {
      if (rate.refusal(personOf(who))) throw new AccessError(429, "feishu_bundle_read_rate_limited");
      rate.hit(personOf(who));
    };
    try {
      current(); const user = await this.json(this.feishu.openApi.userInfoUrl, grant.token, combined); current();
      if (user.code !== 0 || user.data?.tenant_key !== who.tenantId || user.data?.open_id !== who.userId) denied();
      return await this.feishu.openApi.readDriveBundle({ manifest, signal: combined, assertCurrent: current,
        reserveList: () => reserve(this.rates.bundleLists), reserveDownload: () => reserve(this.rates.bundleDownloads),
        json: url => this.json(url, grant.token, combined, 1048576),
        request: url => this.fetch(url, { method: "GET", redirect: "error", signal: combined, headers: { authorization: `Bearer ${grant.token.toString("utf8")}`, "accept-encoding": "identity" } }),
      });
    } catch { throw new AccessError(403, "feishu_bundle_not_verified"); }
    finally { this.#endRead(grant, who); }
  }
  async readOriginal(parentToken, source, { signal, waitForSlot = false } = {}) {
    const row = sourceDeclaration([source]).sources[0], { who, grant } = this.current(parentToken);
    const origin = Object.hasOwn(this.originalOrigins, who.tenantId) && this.originalOrigins[who.tenantId];
    if (!this.feishu.supports("wiki") || !origin || row.tenantId !== who.tenantId || row.providerId !== this.feishu.id) denied();
    const person = personOf(who);
    if (!waitForSlot && this.rates.originals.refusal(person)) throw new AccessError(429, "feishu_original_read_busy");
    this.#startRead(grant, who, "feishu_original_read_busy");
    const combined = AbortSignal.any([grant.controller.signal, AbortSignal.timeout(12000), ...(signal ? [signal] : [])]);
    const current = () => { combined.throwIfAborted(); this.current(parentToken, grant); };
    try {
      // Verification may contain many originals. Wait BEFORE issuing a request,
      // within the same four-operation/deadline bound; do not retry failed reads.
      while (true) {
        current(); const refused = this.rates.originals.refusal(person);
        if (!refused) { this.rates.originals.hit(person); break; }
        await delay(Math.max(1, refused === "person" ? this.rates.originals.nextFor(person) : 100), undefined, { signal: combined });
      }
      current(); const user = await this.json(this.feishu.openApi.userInfoUrl, grant.token, combined); current();
      if (user.code !== 0 || user.data?.tenant_key !== who.tenantId || user.data?.open_id !== who.userId) denied();
      const document = await this.feishu.openApi.readDocument({ resourceId: row.resourceId, origin, assertCurrent: current, get: async endpoint => {
        const result = await this.json(this.feishu.openApi.url(endpoint), grant.token, combined, 2 * 1024 * 1024);
        current(); if (result.code !== 0) denied(); return result.data;
      } });
      current(); return { subject: { appId: who.appId, tenantId: who.tenantId, userId: who.userId, deviceId: who.deviceId }, document: { ...document, tenantId: who.tenantId } };
    } catch { throw new AccessError(403, "feishu_original_not_verified"); }
    finally { this.#endRead(grant, who); }
  }
  async check(parentToken, input, { signal } = {}) {
    const { sources, sourceSetHash } = sourceAccessInput(input), { who, grant } = this.current(parentToken);
    if (grant.busy || this.#reading.refusal(personOf(who))) throw new AccessError(429, "feishu_source_access_busy");
    if (this.rates.checks.refusal(personOf(who), sources.length)) throw new AccessError(429, "feishu_source_access_rate_limited");
    // Reserve the entire batch before even the identity read; failed/partial
    // checks do not refund slots and cannot amplify upstream requests.
    this.rates.checks.hit(personOf(who), sources.length);
    this.#startRead(grant, who, "feishu_source_access_busy");
    const combined = AbortSignal.any([grant.controller.signal, AbortSignal.timeout(12000), ...(signal ? [signal] : [])]);
    const current = () => { combined.throwIfAborted(); this.current(parentToken, grant); };
    try {
      current();
      const user = await this.json(this.feishu.openApi.userInfoUrl, grant.token, combined); current();
      if (user.code !== 0 || user.data?.tenant_key !== who.tenantId || user.data?.open_id !== who.userId) denied();
      for (const source of sources) {
        current();
        const result = await this.json(this.feishu.openApi.url(docxViewPermissionPath(source.resourceId)), grant.token, combined);
        current(); if (result.code !== 0 || result.data?.auth_result !== true) denied();
      }
      current();
      return { authorized: true, pointInTime: true, sourceSetHash, checkedAt: this.now(),
        identity: { appId: who.appId, tenantId: who.tenantId, userId: who.userId, deviceId: who.deviceId } };
    } catch (error) { if (error instanceof AccessError) throw error; throw new AccessError(502, "feishu_source_access_unavailable"); }
    finally { this.#endRead(grant, who); }
  }
  // Turns navigation links into the exact resource a durable schedule may read.
  //
  // Search results and pasted links come from the client; the mapping and the
  // point-in-time permission check use the server-held OAuth credential, as the
  // person. Three things are deliberately not taken from the client: which
  // resource a link names, which kind it is, and whether the person may read it.
  //
  // A Wiki link names a node, and a node is navigation -- it can be re-pointed,
  // and the space decides what sits behind it. It is resolved here, once, and
  // what is stored is the underlying resource: a document, a spreadsheet or a
  // Base, and where the link named one, a single worksheet or table of it. The
  // kind comes from the node's own `obj_type`, so a person who picked 「电子表格」
  // and pasted a node that carries a Base gets a Base, and a node carrying
  // anything this product cannot read is refused rather than stored.
  //
  // Every resolved resource is then proven readable by this person, with the
  // probe that matches its kind. `auth_result: false` is a refusal; a probe that
  // cannot be made at all is also a refusal, and says so separately, because the
  // fix for the two is not the same. No resource body is read or retained.
  // `action: "edit"` proves the person may edit it instead: a document a
  // scheduled task is to write its result into (schedule-deliveries.js).
  async resolveScheduleResources(parentToken, resources, { signal, action = "view" } = {}) {
    if (!["view", "edit"].includes(action)) throw new AccessError(400, "invalid_schedule_resources");
    if (!this.scheduleResourcesEnabled) throw new AccessError(503, "schedule_resource_resolution_unavailable");
    if (!Array.isArray(resources) || resources.length > 32) throw new AccessError(400, "invalid_schedule_resources");
    const references = this.feishu.references;
    const wikiNode = (value) => {
      if (!this.feishu.supports("wiki")) return null;
      try { return references.wikiNode(value); } catch { return null; }
    };
    let parsed;
    try {
      parsed = resources.map(row => {
        if (!LINKED_KINDS.has(row?.kind)) return { row, node: null, direct: null };
        const value = String(row.reference ?? "");
        const node = wikiNode(value);
        if (node) return { row, node, direct: null };
        // Not a node: the kind the person chose decides which parser reads it,
        // and the parser decides whether it is a link to that kind at all.
        if (row.kind === "document") {
          const reference = references.document(value);
          if (reference.partial || reference.kind !== "docx") throw new Error("document");
          return { row, node: null, direct: { kind: "document", token: reference.token, subId: null, origin: new URL(reference.url).origin } };
        }
        if (row.kind === "sheet") {
          const reference = references.sheet(value);
          // The worksheet a link named is part of the authorization; losing it
          // here would hand the task the whole workbook instead.
          return { row, node: null, direct: { kind: "sheet", token: reference.token, subId: reference.sheetId ?? null, origin: new URL(reference.url).origin } };
        }
        const reference = references.base(value);
        // A Base link may be spelled as a Wiki node by the parser that reads
        // both; one that got here is not a node this deployment recognises.
        if (reference.kind && reference.kind !== "base") throw new Error("base");
        return { row, node: null, direct: { kind: "base", token: reference.appToken, subId: reference.tableId ?? null, origin: new URL(reference.url).origin } };
      });
    } catch { throw new AccessError(400, "invalid_schedule_resources"); }
    const { who, grant } = this.current(parentToken);
    // One call to resolve a node, one to prove the person may read what it is.
    const upstreamCalls = parsed.reduce((total, item) => total + (item.node ? 2 : item.direct ? 1 : 0), 0);
    if (grant.busy || this.#reading.refusal(personOf(who)) || this.rates.schedule.refusal(personOf(who), upstreamCalls)) throw new AccessError(429, "schedule_resource_resolution_busy");
    this.rates.schedule.hit(personOf(who), upstreamCalls); this.#startRead(grant, who, "schedule_resource_resolution_busy");
    const combined = AbortSignal.any([grant.controller.signal, AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]);
    const current = () => { combined.throwIfAborted(); this.current(parentToken, grant); };
    try {
      current();
      const user = await this.json(this.feishu.openApi.userInfoUrl, grant.token, combined); current();
      if (user.code !== 0 || user.data?.tenant_key !== who.tenantId || user.data?.open_id !== who.userId) denied();
      const resolved = [];
      for (const item of parsed) {
        current();
        if (!item.node && !item.direct) { resolved.push(structuredClone(item.row)); continue; }
        let { kind, token, subId, origin } = item.direct ?? {};
        let title = item.row.label;
        if (item.node) {
          const answer = await this.answer(this.feishu.openApi.url(wikiNodePath(item.node.token)), grant.token, combined); current();
          const refused = refusal(answer);
          if (refused) throw new AccessError(403, refused);
          const node = answer.body.data?.node;
          kind = node ? WIKI_OBJECT_KINDS[node.obj_type] : undefined;
          if (!node || node.node_token !== item.node.token || !kind || typeof node.obj_token !== "string" ||
              !/^[A-Za-z0-9_-]{8,128}$/.test(node.obj_token)) throw new AccessError(400, "schedule_wiki_resource_unsupported");
          // The deployment must be able to read that kind at all, and to build a
          // link to it that reads back as the same resource.
          if (!this.feishu.supports(SCHEDULE_RESOURCE_CAPABILITIES[kind])) throw new AccessError(400, "schedule_wiki_resource_unsupported");
          token = node.obj_token; origin = new URL(item.node.url).origin;
          // A node address names a whole resource. The link may still have named
          // one worksheet or table inside it, and that narrowing is part of what
          // the person authorized -- keeping it is the difference between one
          // table and the whole Base. The hint is the client's, so it is used
          // only to narrow, and only once the node itself says the kind agrees:
          // a link that claims a worksheet of something that turns out to be a
          // Base is not the resource the person thinks they pasted.
          if (item.node.hint && item.node.hint.kind !== kind) throw new AccessError(400, "schedule_wiki_resource_unsupported");
          subId = item.node.hint ? item.node.hint.subId : null;
          if (typeof node.title === "string" && node.title.trim()) title = node.title.trim().slice(0, 120);
        }
        const reference = this.feishu.links[SCHEDULE_RESOURCE_LINKS[kind]](origin, token, subId);
        const permission = await this.answer(this.feishu.openApi.url(permissionPath(kind, token, action)), grant.token, combined); current();
        // Three outcomes, each with its own fix. Feishu refusing to be asked at
        // all is a scope the application or the login lacks; Feishu refusing
        // because of the resource means the link does not name anything this
        // person can see; and a proven "no" -- measured live, a success with
        // `auth_result: false` -- is a sharing matter for the resource's owner.
        const refused = refusal(permission);
        if (refused) throw new AccessError(403, refused);
        if (permission.body.data?.auth_result !== true) throw new AccessError(403, "schedule_resource_access_denied");
        resolved.push({ kind, reference, ...(title ? { label: title } : {}) });
      }
      current(); return resolved;
    } catch (error) {
      if (error instanceof AccessError) throw error;
      throw new AccessError(502, "schedule_resource_resolution_unavailable");
    } finally { this.#endRead(grant, who); }
  }
  // Compares a candidate supplied by the native CLI reader with this session's
  // freshly resolved tenant user. NOT authentication of client claims, a durable
  // CLI binding, or permission to any resource. Never retain mutable user_id.
  async checkAccount(parentToken, input, { signal } = {}) {
    const candidate = accountCandidate(input), { who, grant } = this.current(parentToken);
    if (!this.identityChecksEnabled || who.cliIdentityChecks !== true || candidate.tenantKey !== who.tenantId) denied();
    if (grant.busy || this.#reading.refusal(personOf(who)) || this.rates.identity.refusal(personOf(who))) throw new AccessError(429, "feishu_identity_check_busy");
    this.rates.identity.hit(personOf(who)); this.#startRead(grant, who, "feishu_identity_check_busy");
    const combined = AbortSignal.any([grant.controller.signal, AbortSignal.timeout(12000), ...(signal ? [signal] : [])]);
    try {
      combined.throwIfAborted();
      const result = await this.json(this.feishu.openApi.userInfoUrl, grant.token, combined);
      combined.throwIfAborted(); this.current(parentToken, grant);
      if (!this.identityChecksEnabled || result.code !== 0 || result.data?.tenant_key !== who.tenantId || result.data?.open_id !== who.userId ||
          !tenantUserId(result.data?.user_id) || result.data.user_id !== candidate.tenantUserId) denied();
      return { matches: true, pointInTime: true, candidateHash: accountCandidateHash(candidate), checkedAt: this.now(),
        identity: { appId: who.appId, tenantId: who.tenantId, userId: who.userId, deviceId: who.deviceId } };
    } catch { throw new AccessError(403, "feishu_identity_not_matched"); }
    finally { this.#endRead(grant, who); }
  }
  async handle(req, res) {
    if (!["/v1/feishu/source-access", "/v1/feishu/account-match"].includes(req.url)) return false;
    const account = req.url === "/v1/feishu/account-match";
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      if (req.method !== "POST") throw new AccessError(405, "method_not_allowed");
      if (req.headers.origin) denied();
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      this.current(token);
      if (req.headers["content-type"]?.split(";")[0] !== "application/json" || req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new AccessError(415, "json_required");
      let length = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > 4096) throw new AccessError(413, "source_access_request_too_large"); chunks.push(chunk); }
      let input; try { input = JSON.parse(Buffer.concat(chunks)); (account ? accountCandidate : sourceAccessInput)(input); } catch { throw new AccessError(400, "invalid_source_access_request"); }
      const controller = new AbortController(), cancel = () => { if (!res.writableEnded) controller.abort(); };
      res.once("close", cancel);
      try { send(200, await (account ? this.checkAccount(token, input, { signal: controller.signal }) : this.check(token, input, { signal: controller.signal }))); }
      finally { res.off("close", cancel); }
    } catch (error) { send(error instanceof AccessError ? error.status : 503, { error: error instanceof AccessError ? error.message : "feishu_source_access_unavailable" }); req.resume(); }
    return true;
  }
  close() {
    this.closed = true; clearInterval(this.timer); this.sessions.off("revoked", this.revoked);
    for (const identity of this.#pending.keys()) this.discard(identity);
    for (const id of this.#grants.keys()) this.remove(id);
  }
}
