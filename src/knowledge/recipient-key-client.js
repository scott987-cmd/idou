import { WikiKeyTransport } from "./key-transport.js";
import { wikiDigest, wikiExact, wikiHash, wikiManifest } from "./manifest.js";

const fail = () => { throw new Error("企业知识接收授权未通过或已变化；未使用知识包密钥。"); };

export class WikiRecipientKeyClient {
  #active = new Set(); #closed = false;
  constructor(options) { this.transport = new WikiKeyTransport(options); }
  async acquire({ shardKey, publication, identity, signal }) {
    let key, disposeGrant;
    try {
      if (this.#closed) fail(); signal?.throwIfAborted(); this.transport.businessAccess();
      if (!wikiDigest(shardKey) || !wikiDigest(identity?.principal)) fail();
      this.transport.publication(publication); if (publication.state !== "published") fail();
      const manifest = wikiManifest(publication.manifest); if (manifest.driveTenantKey !== identity.tenantKey) fail();
      const session = structuredClone(await this.transport.session());
      const result = await this.transport.keyRequest(session, "acquire", { shardKey }, signal);
      const fields = ["grantId", "mode", "purpose", "sessionBinding", "shardKey", "publicationHash", "manifestHash", "generation", "fence", "nodeId", "keyId", "ciphertextSha256",
        "sourceSetHash", "sourceCount", "providerId", "driveTenantKey", "folderToken", "synthesisProvenance", "deliveryPolicyAuthorized", "expiresAt", "bound", "keyBase64"];
      wikiExact(result, fields);
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.grantId) || result.mode !== "acquire" || result.purpose !== "wiki-receive" || result.sessionBinding !== wikiHash(["wiki-recipient-key-v1", session.token]) ||
        result.shardKey !== shardKey || result.publicationHash !== wikiHash(publication) || ["manifestHash", "generation", "fence", "nodeId"].some(field => result[field] !== publication[field]) ||
        ["keyId", "ciphertextSha256", "sourceSetHash", "sourceCount", "providerId", "driveTenantKey", "folderToken"].some(field => result[field] !== manifest[field]) ||
        result.deliveryPolicyAuthorized !== true || result.bound !== true || !["absent", "publisher-declared"].includes(result.synthesisProvenance) ||
        !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= this.transport.now() || result.expiresAt > Math.min(session.expiresAt, this.transport.now() + 65000) ||
        typeof result.keyBase64 !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.keyBase64)) fail();
      key = Buffer.from(result.keyBase64, "base64url"); if (key.length !== 32 || key.toString("base64url") !== result.keyBase64) fail(); delete result.keyBase64;
      const receipt = result, expiresAt = Math.min(result.expiresAt, session.expiresAt, this.transport.now() + 60000); let released = false, timer;
      const dispose = () => { if (released) return; released = true; key.fill(0); clearTimeout(timer); signal?.removeEventListener("abort", dispose); this.#active.delete(dispose); };
      disposeGrant = dispose; this.#active.add(dispose); signal?.addEventListener("abort", dispose, { once: true });
      timer = setTimeout(dispose, Math.max(0, expiresAt - this.transport.now())); timer.unref(); if (signal?.aborted || this.#closed) dispose();
      const current = async () => {
        if (released || this.#closed || this.transport.now() >= expiresAt) fail();
        signal?.throwIfAborted(); this.transport.businessAccess(); await this.transport.unchanged(session); this.transport.businessAccess(); signal?.throwIfAborted();
      };
      const assertCurrent = async () => {
        try {
          await current(); const value = await this.transport.keyRequest(session, "current", { grantId: receipt.grantId }, signal); await current();
          wikiExact(value, Object.keys(receipt)); if (Object.keys(receipt).some(field => value[field] !== receipt[field])) fail();
        } catch { dispose(); fail(); }
      };
      await current();
      return { key, expiresAt, assertCurrent, synthesisProvenance: receipt.synthesisProvenance,
        release: async () => { dispose(); try { await this.transport.keyRequest(session, "release", { grantId: receipt.grantId }); } catch { /* No retries; server logout/expiry also releases. */ } },
      };
    } catch { disposeGrant?.(); key?.fill(0); fail(); }
  }
  close() { this.#closed = true; for (const dispose of this.#active) dispose(); }
}
