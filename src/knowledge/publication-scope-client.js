import { WikiKeyTransport } from "./key-transport.js";
import { publicationScope } from "./publication-scope.js";
import { wikiDigest, wikiExact, wikiHash } from "./manifest.js";

const fail = () => { throw new Error("企业自动发布范围未获授权或已变化；未自动重试。"); };

// Native scheduler adapter. No renderer-selected policy or CLI/OAuth identity
// equivalence is inferred here; callers still enforce the native business gate.
export class WikiPublicationScopeClient {
  #active = new Set(); #closed = false;
  // `feishu` is the deployment whose links the server's answer must use.
  constructor({ feishu, ...options }) {
    if (!feishu?.references) throw new Error("Wiki publication needs the Feishu deployment its links belong to");
    this.feishu = feishu; this.transport = new WikiKeyTransport(options);
  }
  async target({ signal } = {}) {
    try {
      if (this.#closed) fail();
      const session = structuredClone(await this.transport.session());
      const value = await this.transport.keyRequest(session, "target", {}, signal, "scopes");
      wikiExact(value, ["shardKey", "originalOrigin", "folderReference", "policyDigest", "expiresAt", "automaticPublishingApproved", "sessionBinding"]);
      const origin = this.feishu.references.tenantOrigin(value.originalOrigin), folder = this.feishu.references.driveFolder(value.folderReference);
      if (!wikiDigest(value.shardKey) || !wikiDigest(value.policyDigest) || value.automaticPublishingApproved !== true ||
        value.sessionBinding !== wikiHash(["wiki-desktop-target-v1", session.token]) || value.folderReference !== folder.url || folder.url !== this.feishu.links.driveFolder(origin, folder.token) ||
        !Number.isSafeInteger(value.expiresAt) || value.expiresAt !== session.expiresAt || value.expiresAt <= this.transport.now()) fail();
      await this.transport.unchanged(session); this.transport.businessAccess(); signal?.throwIfAborted(); if (this.#closed) fail();
      return { shardKey: value.shardKey, originalOrigin: origin, folderReference: folder.url, policyDigest: value.policyDigest, expiresAt: value.expiresAt };
    } catch { fail(); }
  }
  async authorize(input, { signal } = {}) {
    const scope = publicationScope(input); let dispose;
    try {
      if (this.#closed) fail();
      const session = structuredClone(await this.transport.session()), started = this.transport.now();
      const post = (action, body, abort = signal) => this.transport.keyRequest(session, action, body, abort, "scopes");
      const receipt = await post("acquire", scope);
      const fields = ["grantId", "purpose", "sessionBinding", "scopeDigest", "nodeId", "policyDigest", "expiresAt"];
      wikiExact(receipt, fields);
      if (!/^[A-Za-z0-9_-]{43}$/.test(receipt.grantId) || receipt.purpose !== "wiki-publish-scope" || receipt.sessionBinding !== wikiHash(["wiki-publication-scope-v1", session.token]) ||
        receipt.scopeDigest !== wikiHash(scope) || !wikiDigest(receipt.nodeId) || !wikiDigest(receipt.policyDigest) || !Number.isSafeInteger(receipt.expiresAt) ||
        receipt.expiresAt <= this.transport.now() || receipt.expiresAt > Math.min(session.expiresAt, this.transport.now() + 905000)) fail();
      const expiresAt = Math.min(receipt.expiresAt, session.expiresAt, started + 900000); let released = false, timer;
      dispose = () => { if (released) return; released = true; clearTimeout(timer); signal?.removeEventListener("abort", dispose); this.#active.delete(dispose); };
      this.#active.add(dispose); signal?.addEventListener("abort", dispose, { once: true });
      timer = setTimeout(dispose, Math.max(0, expiresAt - this.transport.now())); timer.unref();
      const current = async () => {
        if (released || this.#closed || this.transport.now() >= expiresAt) fail();
        signal?.throwIfAborted(); this.transport.businessAccess(); await this.transport.unchanged(session); this.transport.businessAccess(); signal?.throwIfAborted();
      };
      const assertCurrent = async () => {
        try { await current(); const value = await post("current", { grantId: receipt.grantId }); await current();
          wikiExact(value, fields); if (fields.some(field => value[field] !== receipt[field])) fail();
        } catch { dispose(); fail(); }
      };
      await current();
      return { scopeDigest: receipt.scopeDigest, expiresAt, assertCurrent,
        release: async () => { dispose(); try { await post("release", { grantId: receipt.grantId }, null); } catch { /* Expiry/logout also clears; no replay. */ } } };
    } catch { dispose?.(); fail(); }
  }
  close() { this.#closed = true; for (const dispose of this.#active) dispose(); }
}
