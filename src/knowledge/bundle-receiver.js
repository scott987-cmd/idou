import { openWikiBundle } from "./bundle.js";
import { wikiHash, wikiManifest } from "./manifest.js";
import { ownFileName } from "../product-names.js";

// Deliberately has no default key provider, renderer entry point or plaintext
// fallback. Key authority must independently authorize every source in a bundle.
export class WikiBundleReceiver {
  constructor({ coordinator, drive, wiki, keyAuthority, sourceRegistry, businessAccess = () => {} }) { Object.assign(this, { coordinator, drive, wiki, keyAuthority, sourceRegistry, businessAccess }); this.active = false; }
  async receive(shardKey, folderReference, { signal, expectedPublicationHash, assertCurrent } = {}) {
    if (this.active) throw new Error("已有知识包正在取回。");
    if (typeof this.keyAuthority?.acquire !== "function") throw new Error("企业知识密钥授权尚未接入；未下载或导入知识包。");
    this.active = true; let secret, grant;
    try {
      this.businessAccess(); signal?.throwIfAborted();
      await assertCurrent?.(); this.businessAccess(); signal?.throwIfAborted();
      const head = await this.coordinator.head(shardKey), publication = head.publication;
      if (!publication || publication.state !== "published" || expectedPublicationHash !== undefined && wikiHash(publication) !== expectedPublicationHash) throw new Error("unpublished or changed");
      const manifest = wikiManifest(publication.manifest), folder = await this.drive.resolveFolder(folderReference);
      if (folder.providerId !== manifest.providerId || folder.identity.tenantKey !== manifest.driveTenantKey || folder.token !== manifest.folderToken) throw new Error("folder mismatch");
      const headHash = wikiHash(publication);
      const current = async () => {
        this.businessAccess(); signal?.throwIfAborted();
        await assertCurrent?.();
        await this.drive.unchanged(folder.identity);
        const latest = await this.coordinator.head(shardKey);
        if (wikiHash(latest.publication) !== headHash) throw new Error("publication changed");
        if (grant) await grant.assertCurrent();
        // The native session may be revoked while either remote check awaits.
        this.businessAccess(); signal?.throwIfAborted();
      };
      await current();
      if (this.sourceRegistry) {
        const checked = await this.sourceRegistry.checkPublished(shardKey, { signal });
        if (checked?.shardKey !== shardKey || checked.generation !== publication.generation || checked.manifestHash !== publication.manifestHash ||
          checked.sourceSetHash !== manifest.sourceSetHash || checked.sourceCount !== manifest.sourceCount || checked.declaredSourcesReadable !== true ||
          checked.pointInTime !== true || checked.provenance !== "publisher-declared" || checked.contentVerified !== false) throw new Error("source registry mismatch");
        await current();
      }
      // This optional metadata preflight is NOT a key-release authorization.
      // The authority still needs independent payload/source and recipient proof.
      grant = await this.keyAuthority.acquire({ shardKey, publication: structuredClone(publication), identity: structuredClone(folder.identity), signal });
      if (!Buffer.isBuffer(grant?.key) || grant.key.length !== 32 || typeof grant.assertCurrent !== "function" || typeof grant.release !== "function") throw new Error("invalid key authority");
      secret = Buffer.from(grant.key); await current();
      const bytes = await this.drive.download({ folder, name: ownFileName(`${manifest.reservationId}.wiki.bundle`), fileToken: manifest.fileToken, maxBytes: manifest.bytes });
      await current();
      const records = openWikiBundle(bytes, { shardKey, publication, key: secret });
      return await this.wiki.importEvidence(records, { kind: "wiki-bundle", ciphertextSha256: manifest.ciphertextSha256, nodeId: publication.nodeId, generation: publication.generation },
        { signal, expectedIdentity: folder.identity, assertCurrent: current });
    } catch { throw new Error("知识包取回失败或权限已变化；未返回包内正文，不会使用旧缓存或自动重试。"); }
    finally { secret?.fill(0); try { await grant?.release?.(); } catch { /* Never expose key-provider errors or replay a committed import. */ } finally { this.active = false; } }
  }
}
