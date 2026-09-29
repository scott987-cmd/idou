import { PublicationJournal } from "./publication-journal.js";
import { sealWikiBundle, portablePage, bundleDigest, bundleSourceSetHash, bundleContentDigest } from "./bundle.js";
import { wikiDigest, wikiUuid, wikiHash, wikiExact, wikiManifest } from "./manifest.js";
import { ownFileName } from "../product-names.js";

const running = new Set();
const sameIdentity = (a, b) => a?.principal === b?.principal && a?.tenantKey === b?.tenantKey;
const owner = (session, nodeId, identity) => wikiHash([session.serverUrl, nodeId, identity.principal, identity.tenantKey]);
const leaseInput = row => ({ shardKey: row.shardKey, leaseId: row.lease.id, fence: row.lease.fence });
const manifest = row => wikiManifest({ ...row.package, fileToken: row.fileToken });
const summary = row => ({ id: row.id, state: row.state, generation: row.expectedGeneration + 1 });

// No renderer entry, default key provider or implicit startup scheduling. The
// caller must supply explicit native authorization and a stable operation UUID.
export class WikiBundlePublisher {
  constructor({ coordinator, budget, drive, wiki, keyAuthority, sourceRegistry, businessAccess, filename, cipher, renewalMs = 30000 }) {
    if (typeof businessAccess !== "function" || !Number.isSafeInteger(renewalMs) || renewalMs < 1 || renewalMs > 30000) throw new Error("Invalid Wiki publisher configuration");
    Object.assign(this, { coordinator, budget, drive, wiki, keyAuthority, sourceRegistry, businessAccess, renewalMs });
    this.journal = new PublicationJournal({ filename, cipher });
  }
  async run(operation, failureMessage = "知识发布未确认完成；请使用原操作编号核查。上传或预算许可可能已发生，未自动重传或释放额度。", assertCurrent) {
    if (assertCurrent !== undefined && typeof assertCurrent !== "function") throw new Error("Invalid publication authorization guard");
    if (running.has(this.journal.filename)) throw new Error("已有知识发布正在处理。");
    running.add(this.journal.filename); this.operationGuard = assertCurrent;
    try { return await operation(); }
    catch { throw new Error(failureMessage); }
    finally { this.operationGuard = null; running.delete(this.journal.filename); }
  }
  async authorized(signal) {
    this.businessAccess(); signal?.throwIfAborted(); await this.operationGuard?.();
    this.businessAccess(); signal?.throwIfAborted();
  }
  async context(row, session, grant, signal) {
    await this.authorized(signal);
    await this.coordinator.unchanged(session); await this.drive.unchanged(row.folder.identity);
    if (grant) await grant.assertCurrent();
    await this.authorized(signal);
  }
  async sources(row, signal) {
    await this.authorized(signal);
    const value = await this.wiki.exportEvidence(row.sourceIds, { signal });
    await this.authorized(signal);
    if (!sameIdentity(value.identity, row.folder.identity)) throw new Error("source identity mismatch");
    const records = value.pages.map(portablePage);
    if (row.package && bundleSourceSetHash(records) !== row.package.sourceSetHash) throw new Error("sources changed");
    return records;
  }
  async inspect(input, signal) {
    wikiExact(input, ["shardKey", "sourceIds", "folderReference"]);
    if (!wikiDigest(input.shardKey) || !Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 200 || !input.sourceIds.every(wikiDigest) || new Set(input.sourceIds).size !== input.sourceIds.length) throw new Error("invalid planning input");
    this.businessAccess(); signal?.throwIfAborted();
    const session = structuredClone(await this.coordinator.session()), status = await this.coordinator.status();
    const folder = await this.drive.resolveFolder(input.folderReference), entries = await this.journal.load();
    if (folder.providerId !== status.policy.providerId || folder.identity.tenantKey !== status.policy.driveTenantKey || folder.token !== status.policy.folderToken) throw new Error("destination policy mismatch");
    const scopeOwner = owner(session, status.nodeId, folder.identity), head = await this.coordinator.head(input.shardKey);
    const records = await this.sources({ sourceIds: input.sourceIds, folder }, signal), contentDigest = bundleContentDigest(records);
    await this.context({ folder }, session, null, signal);
    const latest = await this.coordinator.head(input.shardKey);
    if (wikiHash(latest.publication) !== wikiHash(head.publication)) throw new Error("head changed during inspection");
    await this.context({ folder }, session, null, signal);
    const rows = entries.filter(row => row.owner === scopeOwner && row.shardKey === input.shardKey);
    const pending = rows.find(row => row.state !== "published");
    const generation = head.publication?.generation ?? 0;
    let decision;
    if (pending) decision = { state: "review-required", operationId: pending.id, generation, reason: "unresolved-operation" };
    else if (head.publication?.state === "tombstone") decision = { state: "review-required", generation, reason: "withdrawn-head" };
    else if (head.publication) {
      const previous = rows.find(row => row.fileToken && row.package && wikiHash(manifest(row)) === head.publication.manifestHash && row.lease?.nodeId === head.publication.nodeId && row.expectedGeneration + 1 === generation && row.lease.fence === head.publication.fence);
      if (!previous) decision = { state: "remote-head", generation, reason: "no-local-version-proof" };
      else if (!previous.contentDigest) decision = { state: "review-required", operationId: previous.id, generation, reason: "legacy-version-proof" };
      else if (previous.folder.providerId !== folder.providerId || previous.folder.token !== folder.token) decision = { state: "review-required", operationId: previous.id, generation, reason: "destination-changed" };
      else if (previous.contentDigest === contentDigest) decision = { state: "unchanged", operationId: previous.id, generation, remoteBytesVerified: false };
      else decision = { state: "ready", generation };
    } else decision = rows.length ? { state: "review-required", generation, reason: "missing-previous-head" } : { state: "ready", generation };
    return { decision, session, status, folder, entries, scopeOwner };
  }
  async plan(input, { signal, assertCurrent } = {}) {
    const snapshot = structuredClone(input);
    return this.run(async () => { await this.authorized(signal); return (await this.inspect(snapshot, signal)).decision; }, "知识发布检查未完成；未创建租约、上传任务或预算许可。", assertCurrent);
  }
  keeper(row, session, getGrant, signal) {
    let stopped = false, failure, timer, pending = Promise.resolve();
    const check = async () => { if (failure) throw failure; await this.context(row, session, getGrant(), signal); if (failure) throw failure; };
    const renew = async () => { await check(); const value = await this.coordinator.renew(leaseInput(row)); await check(); return value; };
    const schedule = () => { timer = setTimeout(() => {
      pending = renew().catch(error => { failure = error; }).finally(() => { if (!stopped && !failure) schedule(); });
    }, this.renewalMs); timer.unref?.(); };
    schedule();
    return { check, renew, stop: async () => { stopped = true; clearTimeout(timer); await pending; } };
  }
  async publish(input, { signal, assertCurrent } = {}) {
    return this.run(async () => {
      input = structuredClone(input);
      wikiExact(input, ["id", "shardKey", "sourceIds", "folderReference", "confirmed"]);
      if (!wikiUuid(input.id) || !wikiDigest(input.shardKey) || input.confirmed !== true || !Array.isArray(input.sourceIds) || !input.sourceIds.length || input.sourceIds.length > 200 || !input.sourceIds.every(wikiDigest) || new Set(input.sourceIds).size !== input.sourceIds.length) throw new Error("invalid request");
      await this.authorized(signal);
      const { decision, session, status, folder, entries, scopeOwner } = await this.inspect({ shardKey: input.shardKey, sourceIds: input.sourceIds, folderReference: input.folderReference }, signal);
      if (entries.some(row => row.id === input.id)) throw new Error("existing operation");
      if (decision.state === "unchanged") return decision;
      if (decision.state !== "ready") throw new Error("prior publication requires inspection");
      if (entries.length >= 1000 || typeof this.keyAuthority?.preparePublication !== "function") throw new Error("journal full or key authorization unavailable");
      const row = { id: input.id, owner: scopeOwner, shardKey: input.shardKey,
        expectedGeneration: decision.generation, sourceIds: [...input.sourceIds], folder: structuredClone(folder),
        lease: null, package: null, policyDigest: null, fileToken: null, state: "created" };
      entries.push(row); await this.context(row, session, null, signal); await this.journal.save(entries);
      await this.authorized(signal);
      const lease = await this.coordinator.acquire({ shardKey: row.shardKey, requestId: row.id, expectedGeneration: row.expectedGeneration });
      if (lease.state !== "active" || lease.nodeId !== status.nodeId) throw new Error("inactive lease");
      row.lease = { id: lease.id, fence: lease.fence, nodeId: lease.nodeId }; await this.journal.save(entries);
      let grant, key, keeper;
      try {
        keeper = this.keeper(row, session, () => grant, signal); await keeper.renew();
        // Metadata approval is a separate trust boundary: never give raw source
        // bodies to a future server key provider through this interface.
        const records = await this.sources(row, signal);
        row.contentDigest = bundleContentDigest(records);
        if (this.sourceRegistry) {
          const registered = await this.sourceRegistry.register({ ...leaseInput(row), sources: records.map(({ tenantId, providerId, resourceId, revision, contentHash, text }) =>
            ({ tenantId, providerId, resourceId, revision, contentHash, textSha256: bundleDigest(Buffer.from(text)) })) }, { signal });
          if (registered.sourceSetHash !== bundleSourceSetHash(records) || registered.generation !== row.expectedGeneration + 1 || registered.contentVerified !== false) throw new Error("source declaration mismatch");
          await keeper.check();
        }
        const keyLease = await keeper.renew();
        grant = await this.keyAuthority.preparePublication({ shardKey: row.shardKey, lease: structuredClone(keyLease), identity: structuredClone(folder.identity),
          sources: records.map(({ tenantId, providerId, resourceId, sourceUrl, revision, contentHash, text }) => ({ tenantId, providerId, resourceId, sourceUrl, revision, contentHash, textSha256: bundleDigest(Buffer.from(text)) })), signal });
        if (!Buffer.isBuffer(grant?.key) || grant.key.length !== 32 || !wikiDigest(grant.keyId) || typeof grant.assertCurrent !== "function" || typeof grant.bind !== "function" || typeof grant.release !== "function") throw new Error("invalid key grant");
        key = Buffer.from(grant.key); await keeper.renew();
        const sealed = sealWikiBundle(records, { shardKey: row.shardKey, generation: row.expectedGeneration + 1, fence: lease.fence, nodeId: lease.nodeId,
          keyId: grant.keyId, providerId: folder.providerId, driveTenantKey: folder.identity.tenantKey, folderToken: folder.token }, key);
        row.package = { format: sealed.metadata.format, providerId: folder.providerId, driveTenantKey: folder.identity.tenantKey, folderToken: folder.token,
          reservationId: row.id, ciphertextSha256: sealed.metadata.ciphertextSha256, bytes: sealed.bytes.length, keyId: grant.keyId,
          sourceSetHash: sealed.metadata.sourceSetHash, sourceCount: sealed.metadata.sourceCount };
        const policy = await this.budget.policy(session, folder, sealed.bytes.length); row.policyDigest = policy.policyDigest;
        await grant.bind(structuredClone(row.package)); await keeper.check();
        row.state = "prepared"; await this.journal.save(entries);
        await this.drive.upload({ bytes: sealed.bytes, name: ownFileName(`${row.id}.wiki.bundle`), folder: structuredClone(folder), confirmed: true,
          onDispatched: async () => {
            await this.sources(row, signal); await keeper.renew();
            await this.budget.reserve(session, row.id, { folder, bytes: row.package.bytes, sha256: row.package.ciphertextSha256 }, row.policyDigest);
            row.state = "dispatching"; await this.journal.save(entries); await keeper.check();
            await this.budget.dispatch(session, row.id, row.policyDigest); await keeper.check();
          },
          onUploaded: async fileToken => {
            if (row.state !== "dispatching" || row.fileToken !== null) throw new Error("unexpected receipt");
            row.fileToken = fileToken; row.state = "recorded"; await this.journal.save(entries);
          },
        });
        return await this.finish(row, entries, session, keeper, signal);
      } finally { await keeper?.stop(); key?.fill(0); try { await grant?.release?.(); } catch { /* never expose provider secrets */ } }
    }, undefined, assertCurrent);
  }
  async finish(row, entries, session, keeper, signal) {
    if (!row.fileToken || !["recorded", "publishing"].includes(row.state)) throw new Error("missing upload receipt");
    await keeper.renew();
    const bytes = await this.drive.download({ folder: row.folder, name: ownFileName(`${row.id}.wiki.bundle`), fileToken: row.fileToken, maxBytes: row.package.bytes });
    if (!Buffer.isBuffer(bytes) || bytes.length !== row.package.bytes || bundleDigest(bytes) !== row.package.ciphertextSha256) throw new Error("remote byte mismatch");
    await keeper.check();
    await this.sources(row, signal); await keeper.renew();
    await this.budget.report(session, row.id, row.fileToken); await keeper.check();
    row.state = "publishing"; await this.journal.save(entries); await keeper.renew();
    // Stop and drain renewals before committing: renewing a committed lease is
    // invalid and must not turn a successful publication into a false failure.
    await keeper.stop(); await keeper.check();
    const value = await this.coordinator.publish({ ...leaseInput(row), expectedGeneration: row.expectedGeneration, manifest: manifest(row) });
    this.checkReceipt(row, value); row.state = "published"; await this.journal.save(entries); return summary(row);
  }
  checkReceipt(row, value) {
    if (value?.state !== "published" || value.nodeId !== row.lease.nodeId || value.fence !== row.lease.fence || value.generation !== row.expectedGeneration + 1 || value.manifestHash !== wikiHash(manifest(row))) throw new Error("publication receipt mismatch");
  }
  async recover(id, { signal } = {}) {
    return this.run(async () => {
      if (!wikiUuid(id)) throw new Error("invalid operation"); this.businessAccess(); signal?.throwIfAborted();
      const session = structuredClone(await this.coordinator.session()), status = await this.coordinator.status(), entries = await this.journal.load(), row = entries.find(item => item.id === id);
      if (!row || row.owner !== owner(session, status.nodeId, row.folder.identity)) throw new Error("unknown owner");
      await this.context(row, session, null, signal);
      if (!row.fileToken || !row.package || !row.lease) throw new Error("unknown upload; never redispatch");
      const lease = await this.coordinator.acquire({ shardKey: row.shardKey, requestId: row.id, expectedGeneration: row.expectedGeneration });
      if (lease.state === "committed") {
        this.checkReceipt(row, lease.publication); row.state = "published"; await this.journal.save(entries);
        return { ...summary(row), historicalReceipt: true }; // Does not move a newer head backwards.
      }
      if (lease.state !== "active" || lease.id !== row.lease.id || lease.fence !== row.lease.fence || lease.nodeId !== row.lease.nodeId || typeof this.keyAuthority?.resumePublication !== "function") throw new Error("lease/key unavailable");
      let grant, keeper;
      try {
        keeper = this.keeper(row, session, () => grant, signal); await keeper.renew();
        await this.sources(row, signal);
        const keyLease = await keeper.renew();
        grant = await this.keyAuthority.resumePublication({ shardKey: row.shardKey, lease: structuredClone(keyLease), manifest: manifest(row), identity: structuredClone(row.folder.identity), signal });
        if (typeof grant?.assertCurrent !== "function" || typeof grant.release !== "function") throw new Error("invalid resumed grant");
        return await this.finish(row, entries, session, keeper, signal);
      } finally { await keeper?.stop(); try { await grant?.release?.(); } catch { /* never replay or leak */ } }
    });
  }
}
