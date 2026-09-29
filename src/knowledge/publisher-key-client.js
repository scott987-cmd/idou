import { WikiKeyTransport } from "./key-transport.js";
import { sourceDeclaration } from "./source-declaration.js";
import { wikiDigest, wikiExact, wikiHash, wikiManifest, wikiOpaque, wikiUuid } from "./manifest.js";

const fail = () => { throw new Error("知识发布密钥授权失败或已过期；未自动重试。"); };

// Native process only: never attach grants/key buffers to renderer state, agent
// tools, journals, logs or environment variables. No recipient key operation.
export class WikiPublisherKeyClient {
  #active = new Set(); #closed = false;
  // `feishu` is the deployment the server's grant must name.
  constructor({ businessAccess, feishu, ...options }) {
    if (typeof businessAccess !== "function") throw new Error("Native Wiki business authorization is required");
    if (typeof feishu?.id !== "string") throw new Error("Wiki publisher keys need the Feishu deployment they belong to");
    this.businessAccess = businessAccess; this.feishu = feishu; this.transport = new WikiKeyTransport({ businessAccess, ...options });
  }
  async #post(session, action, body, signal) {
    try { return await this.transport.keyRequest(session, action, body, signal); } catch { fail(); }
  }
  async #grant(mode, input) {
    const { shardKey, lease, identity, signal } = input; let key, disposeGrant;
    try {
      if (this.#closed) fail(); this.businessAccess(); signal?.throwIfAborted();
      if (!wikiDigest(shardKey) || !wikiUuid(lease?.id) || !wikiDigest(lease.nodeId) || !wikiOpaque(identity?.tenantKey) || !wikiDigest(identity?.principal) ||
        !Number.isSafeInteger(lease.fence) || lease.fence < 1 || !Number.isSafeInteger(lease.expectedGeneration) || lease.expectedGeneration < 0) fail();
      const sources = mode === "prepare" ? sourceDeclaration(input.sources.map(({ sourceUrl, ...source }) => source)) : wikiManifest(input.manifest);
      const session = structuredClone(await this.transport.session()), started = this.transport.now();
      const result = await this.#post(session, mode, { shardKey, leaseId: lease.id, fence: lease.fence, ...(mode === "resume" ? { manifest: input.manifest } : {}) }, signal);
      const fields = ["grantId", "mode", "purpose", "sessionBinding", "shardKey", "leaseId", "fence", "generation", "nodeId", "sourceSetHash", "sourceCount", "providerId", "driveTenantKey", "folderToken", "keyId", "expiresAt", "bound"];
      wikiExact(result, mode === "prepare" ? [...fields, "keyBase64"] : fields);
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.grantId) || result.mode !== mode || result.purpose !== "wiki-publish" || result.sessionBinding !== wikiHash(["wiki-publisher-key-v1", session.token]) ||
        result.shardKey !== shardKey || result.leaseId !== lease.id || result.fence !== lease.fence || result.generation !== lease.expectedGeneration + 1 || result.nodeId !== lease.nodeId ||
        result.sourceSetHash !== sources.sourceSetHash || result.sourceCount !== sources.sourceCount || result.providerId !== this.feishu.id || result.driveTenantKey !== identity.tenantKey ||
        !wikiOpaque(result.folderToken) || !wikiDigest(result.keyId) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= this.transport.now() ||
        result.expiresAt > Math.min(session.expiresAt, this.transport.now() + 65000) || result.bound !== (mode === "resume")) fail();
      if (mode === "resume" && ["providerId", "driveTenantKey", "folderToken", "keyId"].some(field => result[field] !== input.manifest[field])) fail();
      if (mode === "prepare") {
        if (typeof result.keyBase64 !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.keyBase64)) fail();
        key = Buffer.from(result.keyBase64, "base64url"); if (key.length !== 32 || key.toString("base64url") !== result.keyBase64) fail(); delete result.keyBase64;
      }
      const { bound: initialBound, ...receipt } = result; let bound = initialBound, released = false;
      const expiresAt = Math.min(receipt.expiresAt, session.expiresAt, started + 60000);
      let timer;
      const dispose = () => { if (released) return; released = true; key?.fill(0); clearTimeout(timer); signal?.removeEventListener("abort", dispose); this.#active.delete(dispose); };
      disposeGrant = dispose;
      this.#active.add(dispose); signal?.addEventListener("abort", dispose, { once: true });
      timer = setTimeout(dispose, Math.max(0, expiresAt - this.transport.now())); timer.unref(); if (signal?.aborted || this.#closed) dispose();
      const current = async () => {
        if (released || this.#closed || this.transport.now() >= expiresAt) fail();
        this.businessAccess(); signal?.throwIfAborted(); await this.transport.unchanged(session); this.businessAccess(); signal?.throwIfAborted();
      };
      const checked = async (action, body) => {
        try {
          await current(); const value = await this.#post(session, action, { grantId: receipt.grantId, ...body }, signal); await current();
          wikiExact(value, [...Object.keys(receipt), "bound"]);
          if (Object.keys(receipt).some(field => value[field] !== receipt[field]) || typeof value.bound !== "boolean" || bound && !value.bound) fail();
          bound = value.bound; return value;
        } catch { dispose(); fail(); }
      };
      await current();
      return { ...(key ? { key, keyId: receipt.keyId } : {}), expiresAt,
        assertCurrent: () => checked("current", {}),
        ...(mode === "prepare" ? { bind: async metadata => {
          try {
            const { fileToken, ...normalized } = wikiManifest({ ...metadata, fileToken: "pending" });
            wikiExact(metadata, Object.keys(normalized));
            if (["providerId", "driveTenantKey", "folderToken", "sourceSetHash", "sourceCount", "keyId"].some(field => normalized[field] !== receipt[field])) fail();
            if (!(await checked("bind", { metadata: normalized })).bound) fail(); key.fill(0);
          } catch { dispose(); fail(); }
        } } : {}),
        release: async () => { dispose(); try { await this.#post(session, "release", { grantId: receipt.grantId }); } catch { /* Expiry/logout is also server cleanup; never retry. */ } },
      };
    } catch { disposeGrant?.(); key?.fill(0); fail(); }
  }
  preparePublication(input) { return this.#grant("prepare", input); }
  resumePublication(input) { return this.#grant("resume", input); }
  close() { this.#closed = true; for (const dispose of this.#active) dispose(); }
}
