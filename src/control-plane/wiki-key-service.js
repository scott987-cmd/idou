import { randomBytes } from "node:crypto";
import { wikiDigest, wikiExact, wikiHash, wikiManifest, wikiOpaque } from "../knowledge/manifest.js";
import { WikiKeyVault } from "./wiki-key-vault.js";
import { WikiKeyCustody } from "./wiki-key-custody.js";
import { readCatalogConfigFile } from "./skill-catalog.js";
import { CountedMap, ExpiryQueue, personOf } from "./limits.js";

const denied = () => { throw new Error("wiki_publisher_key_request_denied"); };
// Key grants held and deliveries being received: what the whole pilot server
// allowed (a hundred, four) is now one person's, and the server's own bounds
// are sized for a hundred thousand people (limits.js). Rate buckets are one per
// session a minute.
export const WIKI_KEY_LIMITS = Object.freeze({ grantsPerPerson: 100, grants: 20_000, receiving: 64, buckets: 200_000 });
export const publisherSessionBinding = token => wikiHash(["wiki-publisher-key-v1", token]);

// Native key transport. The historical class name is retained for publisher
// compatibility; recipient delivery requires a separate, explicit policy.
export class WikiPublisherKeyService {
  #grants = new CountedMap((entry) => entry.person); #byParent = new Map(); #expiry = new ExpiryQueue();
  #busy = new Set(); #buckets = new Map(); #closed = false; #ownedVault; #receiving = 0;
  constructor({ sessions, custody, now = Date.now }) {
    Object.assign(this, { sessions, custody, now });
    // A session's grants, found through their parent rather than by walking
    // every grant each time any session anywhere is revoked.
    this.revoked = id => { for (const token of [...(this.#byParent.get(id) ?? [])]) this.#remove(token); };
    sessions.on("revoked", this.revoked);
    this.timer = setInterval(() => this.#prune(), 5000); this.timer.unref();
  }
  static async fromConfig(filename, { sessions, coordinator, sourceAccess }) {
    let vault;
    try {
      if (!coordinator || !sourceAccess) denied();
      const config = JSON.parse(await readCatalogConfigFile(filename, 1048576));
      wikiExact(config, ["schemaVersion", "databaseFile", "wrappingKeyFile", "tenants"]);
      if (config.schemaVersion !== 1 || !Array.isArray(config.tenants) || !config.tenants.length || config.tenants.length > 100) denied();
      const seen = new Set();
      const tenants = config.tenants.map(row => {
        wikiExact(row, ["appId", "tenantId", "publishers", "processingApproved", "recipients", "trustedSynthesisPublisherNodes", "automaticPublishingApproved", "automaticReceivingApproved"]);
        const recipients = row.recipients ?? [], trusted = row.trustedSynthesisPublisherNodes ?? [];
        const id = wikiHash([row.appId, row.tenantId]);
        if (row.appId !== sourceAccess.appId || !wikiOpaque(row.tenantId) || !Object.hasOwn(sourceAccess.originalOrigins, row.tenantId) || seen.has(id) || row.processingApproved !== true ||
          !Array.isArray(row.publishers) || row.publishers.length > 1000 || !row.publishers.every(wikiOpaque) || new Set(row.publishers).size !== row.publishers.length ||
          !Array.isArray(recipients) || recipients.length > 1000 || !recipients.every(wikiOpaque) || new Set(recipients).size !== recipients.length ||
          !Array.isArray(trusted) || trusted.length > 1000 || !trusted.every(wikiDigest) || new Set(trusted).size !== trusted.length ||
          !row.publishers.length && !recipients.length || recipients.length && sourceAccess.bundleReadsEnabled !== true ||
          row.automaticPublishingApproved !== undefined && typeof row.automaticPublishingApproved !== "boolean" ||
          row.automaticReceivingApproved !== undefined && typeof row.automaticReceivingApproved !== "boolean") denied();
        seen.add(id); return { ...row, publishers: [...row.publishers], recipients: [...recipients], trustedSynthesisPublisherNodes: [...trusted] };
      });
      vault = await WikiKeyVault.fromFiles(config);
      const tenant = subject => tenants.find(row => row.appId === subject.appId && row.tenantId === subject.tenantId);
      const custody = new WikiKeyCustody({ sessions, coordinator, vault, sourceAccess,
        authorizeProcessing: ({ subject, operation }) => (operation === "publish" ? tenant(subject)?.publishers : operation === "verify" ? tenant(subject)?.recipients : [])?.includes(subject.userId) === true,
        authorizeDelivery: ({ subject, publication, verification }) => tenant(subject)?.recipients.includes(subject.userId) === true &&
          (verification.synthesisProvenance === "absent" || verification.synthesisProvenance === "publisher-declared" && tenant(subject).trustedSynthesisPublisherNodes.includes(publication.nodeId)),
        authorizeAutomatic: ({ subject }) => tenant(subject)?.automaticPublishingApproved === true && tenant(subject).publishers.includes(subject.userId),
        discoveryPublishers: ({ subject }) => tenant(subject)?.automaticReceivingApproved === true && tenant(subject).recipients.includes(subject.userId) ? [...tenant(subject).publishers] : null,
      });
      const service = new WikiPublisherKeyService({ sessions, custody }); service.#ownedVault = vault; return service;
    } catch { vault?.close(); throw new Error("Invalid Wiki publisher key configuration; trusted custody and explicit publisher processing grants are required"); }
  }
  #put(token, entry) {
    this.#grants.set(token, entry);
    let tokens = this.#byParent.get(entry.parentId);
    if (!tokens) this.#byParent.set(entry.parentId, tokens = new Set());
    tokens.add(token);
    this.#expiry.add(entry.receipt.expiresAt, token, entry);
  }
  #full(who) { return this.#grants.size >= WIKI_KEY_LIMITS.grants || this.#grants.held(personOf(who)) >= WIKI_KEY_LIMITS.grantsPerPerson; }
  #remove(token) {
    const entry = this.#grants.get(token);
    this.#grants.delete(token);
    if (entry) {
      const tokens = this.#byParent.get(entry.parentId);
      tokens?.delete(token); if (tokens && !tokens.size) this.#byParent.delete(entry.parentId);
    }
    entry?.grant.release();
  }
  // Only what has expired is looked at. Buckets are made a minute apart in the
  // order they expire, so the first live one ends the walk.
  #prune() {
    const now = this.now();
    for (let due; (due = this.#expiry.due(now));) {
      if (this.#grants.get(due.key) !== due.value) continue;
      if (due.value.receipt.expiresAt > now) this.#expiry.add(due.value.receipt.expiresAt, due.key, due.value); else this.#remove(due.key);
    }
    for (const [id, bucket] of this.#buckets) { if (bucket.until > now) break; this.#buckets.delete(id); }
  }
  #subject(token) {
    this.#prune(); const who = this.sessions.verify(token);
    if (this.#closed || !who || who.authProvider !== "feishu" || who.audience !== "codex-model-gateway") denied(); return who;
  }
  async handle(req, res) {
    const route = /^\/v1\/wiki\/(keys|scopes)\/(prepare|resume|current|bind|release|acquire|target|discover)$/.exec(req.url); if (!route) return false;
    const [, namespace, action] = route;
    const controller = new AbortController(), abort = () => { controller.abort(); if (!req.complete) req.destroy(); };
    const disconnected = () => { if (!res.writableFinished) abort(); };
    req.once("aborted", abort); res.once("close", disconnected);
    const deadline = setTimeout(abort, namespace === "keys" && action === "acquire" ? 125000 : 30000); deadline.unref();
    let busyId, created, receiving = false;
    const send = value => {
      controller.signal.throwIfAborted(); if (res.destroyed) denied();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value));
    };
    try {
      if (namespace === "scopes" && !["acquire", "current", "release", "target"].includes(action) || namespace === "keys" && action === "target" || req.method !== "POST" || req.headers.origin || req.headers["content-type"]?.split(";")[0] !== "application/json" || req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") denied();
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "", who = this.#subject(token);
      const current = () => { controller.signal.throwIfAborted(); if (this.#subject(token) !== who) denied(); };
      const bucket = this.#buckets.get(who.id) || { count: 0, until: this.now() + 60000 };
      if (this.#buckets.size >= WIKI_KEY_LIMITS.buckets && !this.#buckets.has(who.id) || ++bucket.count > 120) denied(); this.#buckets.set(who.id, bucket);
      let length = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { current(); length += chunk.length; if (length > (namespace === "scopes" ? 20000 : 4096)) denied(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks)); current();
      if (namespace === "keys" && action === "discover") {
        const page = this.custody.discover(token, body, { signal: controller.signal }); current();
        send({ ...page, sessionBinding: wikiHash(["wiki-discovery-v1", token]) }); return true;
      }
      if (namespace === "scopes" && action === "target") {
        wikiExact(body, []);
        const target = this.custody.automaticTarget(token, { signal: controller.signal }); current();
        send({ ...target, sessionBinding: wikiHash(["wiki-desktop-target-v1", token]) }); return true;
      }
      if (namespace === "scopes" && action === "acquire") {
        if (this.#busy.has(who.id) || this.#full(who)) denied();
        const grant = this.custody.automaticScope(token, body, { signal: controller.signal });
        // One frozen automation scope per parent; another scope requires release.
        if ([...this.#grants.values()].some(entry => entry.parentId === who.id && entry.receipt.purpose === "wiki-publish-scope")) { grant.release(); denied(); }
        const grantId = randomBytes(32).toString("base64url"), receipt = { grantId, purpose: "wiki-publish-scope",
          sessionBinding: wikiHash(["wiki-publication-scope-v1", token]), scopeDigest: grant.scopeDigest, nodeId: grant.nodeId, policyDigest: grant.policyDigest, expiresAt: grant.expiresAt };
        created = grantId; this.#put(grantId, { parentId: who.id, person: personOf(who), receipt, grant });
        await grant.assertCurrent(); current(); send(receipt); created = null; return true;
      }
      if (action === "acquire") {
        wikiExact(body, ["shardKey"]);
        if (this.#busy.has(who.id) || this.#receiving >= WIKI_KEY_LIMITS.receiving || this.#full(who) || this.#busy.size >= WIKI_KEY_LIMITS.grants) denied();
        this.#busy.add(who.id); busyId = who.id; this.#receiving++; receiving = true;
        // Even an identical request is freshly verified. A prior grant is not a
        // cached source permission or evidence of permission for a new session.
        for (const id of [...(this.#byParent.get(who.id) ?? [])]) { const entry = this.#grants.get(id); if (entry?.receipt.mode === "acquire" && entry.receipt.shardKey === body.shardKey) this.#remove(id); }
        const grant = await this.custody.acquire(token, body.shardKey, { signal: controller.signal });
        if (this.#full(who)) { grant.release(); denied(); }
        const publication = grant.publication, manifest = publication.manifest, grantId = randomBytes(32).toString("base64url");
        const receipt = { grantId, mode: "acquire", purpose: "wiki-receive", sessionBinding: wikiHash(["wiki-recipient-key-v1", token]), shardKey: body.shardKey,
          publicationHash: wikiHash(publication), manifestHash: publication.manifestHash, generation: publication.generation, fence: publication.fence, nodeId: publication.nodeId,
          keyId: manifest.keyId, ciphertextSha256: manifest.ciphertextSha256, sourceSetHash: manifest.sourceSetHash, sourceCount: manifest.sourceCount,
          providerId: manifest.providerId, driveTenantKey: manifest.driveTenantKey, folderToken: manifest.folderToken,
          synthesisProvenance: grant.verification.synthesisProvenance, deliveryPolicyAuthorized: true, expiresAt: grant.expiresAt };
        created = grantId; this.#put(grantId, { parentId: who.id, person: personOf(who), receipt, grant, bound: true });
        current(); await grant.assertCurrent(); current(); send({ ...receipt, bound: true, keyBase64: grant.key.toString("base64url") }); created = null; return true;
      }
      if (["prepare", "resume"].includes(action)) {
        wikiExact(body, action === "prepare" ? ["shardKey", "leaseId", "fence"] : ["shardKey", "leaseId", "fence", "manifest"]);
        if (this.#busy.has(who.id)) denied(); this.#busy.add(who.id); busyId = who.id;
        const input = { shardKey: body.shardKey, leaseId: body.leaseId, fence: body.fence };
        const declared = this.custody.coordinator.leaseSources(who, input), { policy } = this.custody.subject(token, body.shardKey, "publish", controller.signal);
        const requestHash = wikiHash([action, input, action === "resume" ? wikiManifest(body.manifest) : null]);
        const old = [...this.#grants.values()].find(entry => entry.parentId === who.id && entry.receipt.leaseId === body.leaseId);
        if (old) {
          if (old.requestHash !== requestHash || action === "prepare" && old.bound) denied();
          await old.grant.assertCurrent(); current();
          send({ ...old.receipt, bound: old.bound, ...(action === "prepare" ? { keyBase64: old.grant.key.toString("base64url") } : {}) }); return true;
        }
        if (this.#full(who)) denied();
        const grant = action === "prepare" ? await this.custody.preparePublication(token, { shardKey: body.shardKey, lease: declared.lease, sources: declared.sources, signal: controller.signal }) :
          await this.custody.resumePublication(token, { shardKey: body.shardKey, lease: declared.lease, manifest: body.manifest, signal: controller.signal });
        if (this.#full(who)) { grant.release(); denied(); }
        const grantId = randomBytes(32).toString("base64url");
        const receipt = { grantId, mode: action, purpose: "wiki-publish", sessionBinding: publisherSessionBinding(token), shardKey: body.shardKey, leaseId: declared.lease.id,
          fence: declared.lease.fence, generation: declared.lease.expectedGeneration + 1, nodeId: declared.lease.nodeId, sourceSetHash: declared.sourceSetHash, sourceCount: declared.sourceCount,
          providerId: policy.providerId, driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken, keyId: action === "prepare" ? grant.keyId : body.manifest.keyId, expiresAt: grant.expiresAt };
        created = grantId; this.#put(grantId, { parentId: who.id, person: personOf(who), requestHash, receipt, grant, bound: action === "resume" });
        current(); await grant.assertCurrent(); current();
        send({ ...receipt, bound: action === "resume", ...(action === "prepare" ? { keyBase64: grant.key.toString("base64url") } : {}) }); created = null; return true;
      }
      wikiExact(body, action === "bind" ? ["grantId", "metadata"] : ["grantId"]);
      if (typeof body.grantId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.grantId)) denied();
      const entry = this.#grants.get(body.grantId);
      if (entry && entry.parentId !== who.id) denied();
      if (entry && (entry.receipt.purpose === "wiki-publish-scope") !== (namespace === "scopes")) denied();
      if (action === "release") { this.#remove(body.grantId); send({ released: true }); return true; }
      if (!entry) denied(); await entry.grant.assertCurrent(); current();
      if (action === "bind") {
        if (entry.receipt.mode !== "prepare") denied();
        await entry.grant.bind(body.metadata); current(); entry.bound = true; entry.grant.key.fill(0);
      }
      send(namespace === "scopes" ? entry.receipt : { ...entry.receipt, bound: entry.bound }); return true;
    } catch {
      if (created) this.#remove(created);
      if (!res.destroyed && !res.headersSent) { res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "wiki_publisher_key_request_denied" })); }
      req.resume(); return true;
    } finally { if (busyId) this.#busy.delete(busyId); if (receiving) this.#receiving--; clearTimeout(deadline); req.off("aborted", abort); res.off("close", disconnected); }
  }
  close() {
    this.#closed = true; clearInterval(this.timer); this.sessions.off("revoked", this.revoked);
    for (const token of this.#grants.keys()) this.#remove(token); this.#buckets.clear(); this.custody.close(); this.#ownedVault?.close();
  }
}
