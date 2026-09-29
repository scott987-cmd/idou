import { openWikiBundle, bundleContentDigest } from "../knowledge/bundle.js";
import { wikiDigest, wikiHash } from "../knowledge/manifest.js";

// Server-internal only: these dependencies must independently read the stored
// artifact/originals and obtain a server-owned key. Never adapt request JSON to
// them. No content persistence, key delivery or HTTP route is provided here.
export class WikiPayloadVerifier {
  constructor({ sessions, coordinator, readBundle, readSource, withKey }) {
    if (![readBundle, readSource, withKey].every(value => typeof value === "function")) throw new Error("Trusted Wiki verification readers and key custody are required.");
    Object.assign(this, { sessions, coordinator, readBundle, readSource, withKey }); this.active = false;
  }
  async verify(parentToken, shardKey, { signal } = {}) {
    if (this.active) throw new Error("wiki_payload_verification_busy");
    this.active = true; let bytes;
    const controller = new AbortController(), combined = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
    try {
      const who = this.sessions.verify(parentToken);
      const current = () => {
        combined.throwIfAborted();
        if (!wikiDigest(shardKey) || !who || who.authProvider !== "feishu" || who.audience !== "codex-model-gateway" || this.sessions.verify(parentToken) !== who) throw new Error();
        return this.coordinator.publishedSources(who, shardKey);
      };
      const declaration = structuredClone(current()), publicationHash = wikiHash(declaration.publication);
      const unchanged = () => { if (wikiHash(current()) !== wikiHash(declaration)) throw new Error(); };
      const subject = Object.fromEntries(["appId", "tenantId", "userId", "deviceId"].map(field => [field, who[field]]));
      const loaded = await this.readBundle({ subject: { ...subject }, shardKey, publication: structuredClone(declaration.publication), signal: combined });
      unchanged();
      if (!Buffer.isBuffer(loaded) || loaded.length !== declaration.publication.manifest.bytes || loaded.length > 10485760) throw new Error();
      bytes = Buffer.from(loaded); // Do not retain or mutate the reader's buffer.
      let invoked = false, verified;
      await this.withKey({ subject: { ...subject }, shardKey, publication: structuredClone(declaration.publication), signal: combined }, async key => {
        if (invoked) throw new Error(); invoked = true; unchanged();
        const records = openWikiBundle(bytes, { shardKey, publication: declaration.publication, key });
        // openWikiBundle authenticates all bytes, exact fields, full record count
        // and source digest. publishedSources binds that digest to stored rows.
        for (const record of records) {
          unchanged();
          const source = declaration.sources.find(row => row.tenantId === record.tenantId && row.providerId === record.providerId && row.resourceId === record.resourceId);
          if (!source) throw new Error();
          // Never send a payload-provided URL to a fetcher (including Wiki aliases).
          const fresh = await this.readSource({ subject: { ...subject }, source: structuredClone(source), signal: combined });
          unchanged();
          if (Object.keys(subject).some(field => fresh?.subject?.[field] !== subject[field]) || fresh.document?.tenantId !== record.tenantId || fresh.document?.partial !== false ||
            fresh.document.sourceRevision !== record.revision || ["providerId", "resourceId", "sourceUrl", "contentHash", "title", "text"].some(field => fresh.document[field] !== record[field])) throw new Error();
        }
        unchanged();
        verified = { shardKey, subjectHash: wikiHash(["feishu", subject.appId, subject.tenantId, subject.userId, subject.deviceId]), generation: declaration.publication.generation, publicationHash, manifestHash: declaration.publication.manifestHash,
          ciphertextSha256: declaration.publication.manifest.ciphertextSha256, sourceSetHash: declaration.sourceSetHash, sourceCount: records.length,
          contentDigest: bundleContentDigest(records), payloadMatchesDeclaration: true, originalsMatched: true,
          synthesisProvenance: records.some(record => record.synthesis) ? "publisher-declared" : "absent", keyReleaseAuthorized: false };
      });
      unchanged(); if (!invoked || !verified) throw new Error();
      return verified;
    } catch { throw new Error("wiki_payload_or_originals_not_verified"); }
    finally { controller.abort(); bytes?.fill(0); this.active = false; }
  }
}
