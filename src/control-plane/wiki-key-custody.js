import { wikiHash, wikiManifest, wikiDigest, wikiExact, wikiOpaque } from "../knowledge/manifest.js";
import { sourceDeclaration } from "../knowledge/source-declaration.js";
import { sourceAccessInput } from "../knowledge/source-access-contract.js";
import { WikiPayloadVerifier } from "./wiki-payload-verifier.js";
import { publicationScope } from "../knowledge/publication-scope.js";

const denied = () => { throw new Error("wiki_key_authorization_not_verified"); };

// Server-internal composition. Processing consent is an explicit trusted server
// policy callback, never a client flag. This does not expose an HTTP key endpoint
// or claim that a CLI identity is linked to this application's OAuth open_id.
export class WikiKeyCustody {
  #grants = new Set(); #closed = false;
  constructor({ sessions, coordinator, vault, sourceAccess, authorizeProcessing, authorizeDelivery, authorizeAutomatic, discoveryPublishers, now = Date.now }) {
    if (!vault || !sourceAccess?.feishu || typeof authorizeProcessing !== "function") throw new Error("Server key custody and explicit Wiki processing policy are required");
    Object.assign(this, { sessions, coordinator, vault, sourceAccess, authorizeProcessing, authorizeDelivery, authorizeAutomatic, discoveryPublishers, now });
  }
  subject(parentToken, shardKey, operation, signal) {
    signal?.throwIfAborted(); const who = this.sessions.verify(parentToken);
    if (this.#closed || !who || who.authProvider !== "feishu" || who.audience !== "codex-model-gateway") denied();
    const policy = this.coordinator.authorize(who);
    // The tenant's registered deployment must be this server's, and one with a Wiki.
    const feishu = this.sourceAccess.feishu;
    if (!feishu.supports("wiki") || policy.providerId !== feishu.id || policy.driveTenantKey !== who.tenantId || this.authorizeProcessing({ subject: who, shardKey, operation, policy }) !== true) denied();
    return { who, policy };
  }
  #lifetime(who, signal, key, duration = 60000) {
    const expiresAt = Math.min(who.expiresAt, this.now() + duration); let released = false, timer;
    const release = () => {
      if (released) return; released = true; key?.fill(0); clearTimeout(timer);
      this.sessions.off("revoked", revoked); signal?.removeEventListener("abort", release); this.#grants.delete(release);
    };
    const revoked = id => { if (id === who.id) release(); };
    this.sessions.on("revoked", revoked); signal?.addEventListener("abort", release, { once: true }); this.#grants.add(release);
    timer = setTimeout(release, Math.max(0, expiresAt - this.now())); timer.unref(); if (signal?.aborted) release();
    return { expiresAt, release, assertLive: () => { if (released || this.now() >= expiresAt) { release(); denied(); } } };
  }
  context(who, shardKey, publication, policy, declaration) {
    return { tenant: wikiHash([who.authProvider, who.tenantId, who.appId]), shardKey, generation: publication.generation, fence: publication.fence,
      nodeId: publication.nodeId, providerId: policy.providerId, driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken,
      sourceSetHash: declaration.sourceSetHash, sourceCount: declaration.sourceCount };
  }
  publicationContext(parentToken, shardKey, signal) {
    const { who, policy } = this.subject(parentToken, shardKey, "verify", signal), declaration = this.coordinator.publishedSources(who, shardKey);
    return { who, declaration, context: this.context(who, shardKey, declaration.publication, policy, declaration) };
  }
  automaticTarget(parentToken, { signal } = {}) {
    const parent = this.sessions.verify(parentToken);
    if (!parent || parent.cliIdentityChecks !== true || this.sourceAccess.identityChecksEnabled !== true) denied();
    // A stable per-user target avoids creating another shard on every login.
    // Different devices still need leases; a foreign/unproven head is not adopted.
    const shardKey = wikiHash(["wiki-user-local-reads-v1", parent.appId, parent.tenantId, parent.userId]);
    const { who, policy } = this.subject(parentToken, shardKey, "publish", signal);
    const originalOrigin = this.sourceAccess.originalOrigins[who.tenantId];
    if (!originalOrigin || typeof this.authorizeAutomatic !== "function" || this.authorizeAutomatic({ subject: who, scope: null, policy }) !== true) denied();
    return { shardKey, originalOrigin, folderReference: this.sourceAccess.feishu.links.driveFolder(originalOrigin, policy.folderToken),
      policyDigest: policy.policyDigest, expiresAt: who.expiresAt, automaticPublishingApproved: true };
  }
  discover(parentToken, input, { signal } = {}) {
    wikiExact(input, ["after"]);
    if (input.after !== null && !wikiDigest(input.after)) denied();
    const { who, policy } = this.subject(parentToken, wikiHash("discovery"), "verify", signal);
    if (who.cliIdentityChecks !== true || this.sourceAccess.identityChecksEnabled !== true || this.sourceAccess.bundleReadsEnabled !== true) denied();
    const publishers = this.discoveryPublishers?.({ subject: who });
    if (!Array.isArray(publishers) || publishers.length > 1000 || !publishers.every(wikiOpaque) || new Set(publishers).size !== publishers.length) denied();
    const originalOrigin = this.sourceAccess.originalOrigins[who.tenantId]; if (!originalOrigin) denied();
    const shards = publishers.map(userId => wikiHash(["wiki-user-local-reads-v1", who.appId, who.tenantId, userId])).sort();
    const remaining = shards.filter(shard => input.after === null || shard > input.after), page = remaining.slice(0, 5), nodeId = this.coordinator.status(who, {}).nodeId;
    const targets = [];
    for (const shardKey of page) {
      const publication = this.coordinator.head(who, { shardKey }).publication;
      if (publication?.state === "published" && publication.nodeId !== nodeId && publication.manifest.providerId === policy.providerId && publication.manifest.folderToken === policy.folderToken && publication.manifest.driveTenantKey === policy.driveTenantKey)
        targets.push({ shardKey, publicationHash: wikiHash(publication), generation: publication.generation });
    }
    return { targets, after: input.after, nextAfter: remaining.length > page.length ? page.at(-1) : null, originalOrigin,
      folderReference: this.sourceAccess.feishu.links.driveFolder(originalOrigin, policy.folderToken), catalogDigest: wikiHash([shards, originalOrigin, policy.policyDigest]), policyDigest: policy.policyDigest,
      expiresAt: who.expiresAt, automaticReceivingApproved: true, permissionsChecked: false };
  }
  automaticScope(parentToken, input, { signal } = {}) {
    const scope = publicationScope(input), initial = this.subject(parentToken, scope.shardKey, "publish", signal);
    const check = () => {
      const { who, policy } = this.subject(parentToken, scope.shardKey, "publish", signal);
      if (who !== initial.who || policy.policyDigest !== initial.policy.policyDigest ||
        !this.sourceAccess.originalOrigins[who.tenantId] || scope.folderReference !== this.sourceAccess.feishu.links.driveFolder(this.sourceAccess.originalOrigins[who.tenantId], policy.folderToken) ||
        typeof this.authorizeAutomatic !== "function" || this.authorizeAutomatic({ subject: who, scope: structuredClone(scope), policy }) !== true) denied();
    };
    check();
    const nodeId = this.coordinator.status(initial.who, {}).nodeId;
    const lifetime = this.#lifetime(initial.who, signal, undefined, 15 * 60000);
    const assertCurrent = async () => { try { lifetime.assertLive(); check(); } catch { lifetime.release(); denied(); } };
    // This approves repeated publication attempts within a frozen scope, not
    // source visibility or a key. Each publication still registers/checks sources.
    return { scopeDigest: wikiHash(scope), nodeId, policyDigest: initial.policy.policyDigest, expiresAt: lifetime.expiresAt, assertCurrent, release: lifetime.release };
  }
  async preparePublication(parentToken, { shardKey, lease, sources, signal }) {
    const input = { shardKey, leaseId: lease?.id, fence: lease?.fence };
    // The native publisher also includes a sourceUrl. It is deliberately not a
    // lookup target or permission claim, and is never persisted by key custody.
    const requested = sourceDeclaration(sources.map(({ sourceUrl, ...source }) => source));
    const initial = this.subject(parentToken, shardKey, "publish", signal), who = initial.who;
    const resolve = () => {
      const latest = this.subject(parentToken, shardKey, "publish", signal); if (latest.who !== who) denied();
      const declaration = this.coordinator.leaseSources(who, input);
      if (declaration.sourceSetHash !== requested.sourceSetHash) denied();
      return { context: this.context(who, shardKey, { generation: declaration.lease.expectedGeneration + 1, ...declaration.lease }, latest.policy, declaration), declaration };
    };
    const context = resolve().context, fingerprint = wikiHash(context);
    const current = () => { if (wikiHash(resolve().context) !== fingerprint) denied(); };
    for (let offset = 0; offset < requested.sources.length; offset += 20) {
      current(); const body = { sources: requested.sources.slice(offset, offset + 20).map(row => ({ resourceType: "docx", resourceId: row.resourceId })) };
      const checked = await this.sourceAccess.check(parentToken, body, { signal }); current();
      if (checked.authorized !== true || checked.pointInTime !== true || checked.sourceSetHash !== sourceAccessInput(body).sourceSetHash ||
        ["appId", "tenantId", "userId", "deviceId"].some(field => checked.identity?.[field] !== who[field])) denied();
    }
    let key, keyId;
    try {
      await this.vault.prepare(context, (value, id) => { current(); key = Buffer.from(value); keyId = id; }); current();
      const lifetime = this.#lifetime(who, signal, key);
      const assertCurrent = async () => { try { lifetime.assertLive(); current(); this.vault.assertAvailable(context, keyId); } catch { lifetime.release(); denied(); } };
      return { key, keyId, expiresAt: lifetime.expiresAt, assertCurrent,
        bind: async metadata => { await assertCurrent(); this.vault.bind(context, keyId, metadata); await assertCurrent(); },
        release: lifetime.release,
      };
    } catch { key?.fill(0); denied(); }
  }
  async resumePublication(parentToken, { shardKey, lease, manifest, signal }) {
    const { fileToken, ...metadata } = wikiManifest(manifest), initial = this.subject(parentToken, shardKey, "publish", signal);
    const lifetime = this.#lifetime(initial.who, signal);
    const assertCurrent = async () => {
      try {
        lifetime.assertLive(); const { who, policy } = this.subject(parentToken, shardKey, "publish", signal); if (who !== initial.who) denied();
        const declaration = this.coordinator.leaseSources(who, { shardKey, leaseId: lease.id, fence: lease.fence });
        const context = this.context(who, shardKey, { generation: declaration.lease.expectedGeneration + 1, ...declaration.lease }, policy, declaration);
        this.vault.assertBound(context, manifest.keyId, metadata);
      } catch { lifetime.release(); denied(); }
    };
    await assertCurrent(); return { expiresAt: lifetime.expiresAt, assertCurrent, release: lifetime.release }; // No resumed plaintext key.
  }
  async verifyPublication(parentToken, shardKey, { signal } = {}) {
    const initial = this.publicationContext(parentToken, shardKey, signal), fingerprint = wikiHash(initial);
    const current = () => {
      const latest = this.publicationContext(parentToken, shardKey, signal);
      if (latest.who !== initial.who || wikiHash(latest) !== fingerprint) denied(); return latest;
    };
    let downloaded;
    const verifier = new WikiPayloadVerifier({ sessions: this.sessions, coordinator: this.coordinator,
      readBundle: async ({ signal }) => { current(); downloaded = await this.sourceAccess.readPublishedBundle(parentToken, shardKey, { coordinator: this.coordinator, signal }); current(); return downloaded; },
      readSource: async ({ source, signal }) => { current(); const result = await this.sourceAccess.readOriginal(parentToken, source, { signal, waitForSlot: true }); current(); return result; },
      withKey: async ({ publication }, use) => {
        const latest = current(); if (wikiHash(publication) !== wikiHash(latest.declaration.publication)) denied();
        return this.vault.withKey(latest.context, publication.manifest, async key => { current(); const result = await use(key); current(); return result; });
      },
    });
    try { const result = await verifier.verify(parentToken, shardKey, { signal }); current(); return result; }
    finally { downloaded?.fill(0); }
  }
  async acquire(parentToken, shardKey, { signal } = {}) {
    if (typeof this.authorizeDelivery !== "function") denied();
    const initial = this.publicationContext(parentToken, shardKey, signal), fingerprint = wikiHash(initial);
    const current = () => {
      const latest = this.publicationContext(parentToken, shardKey, signal);
      if (latest.who !== initial.who || wikiHash(latest) !== fingerprint) denied(); return latest;
    };
    // No client report or cached permission receipt enters this path. Every new
    // acquisition independently downloads/authenticates the package and sources.
    const verified = await this.verifyPublication(parentToken, shardKey, { signal }); current();
    if (verified.payloadMatchesDeclaration !== true || verified.originalsMatched !== true || verified.keyReleaseAuthorized !== false ||
      verified.manifestHash !== initial.declaration.publication.manifestHash || verified.subjectHash !== wikiHash(["feishu", initial.who.appId, initial.who.tenantId, initial.who.userId, initial.who.deviceId])) denied();
    const authorize = () => {
      const latest = current();
      if (this.authorizeDelivery({ subject: latest.who, publication: structuredClone(latest.declaration.publication), verification: structuredClone(verified) }) !== true) denied();
    };
    let key, lifetime;
    try {
      authorize();
      await this.vault.withKey(initial.context, initial.declaration.publication.manifest, value => { authorize(); key = Buffer.from(value); }); authorize();
      lifetime = this.#lifetime(initial.who, signal, key);
      const assertCurrent = async () => {
        try { lifetime.assertLive(); authorize(); this.vault.assertAvailable(initial.context, initial.declaration.publication.manifest.keyId); }
        catch { lifetime.release(); denied(); }
      };
      await assertCurrent();
      return { key, publication: structuredClone(initial.declaration.publication), verification: verified, expiresAt: lifetime.expiresAt, assertCurrent, release: lifetime.release };
    } catch { lifetime?.release(); key?.fill(0); denied(); }
  }
  close() { this.#closed = true; for (const release of this.#grants) release(); }
}
