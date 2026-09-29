import { WikiKeyTransport } from "./key-transport.js";
import { wikiDigest, wikiExact, wikiHash } from "./manifest.js";

// `feishu` is the deployment whose links the server's answer must use.
export class WikiDiscoveryClient {
  constructor({ feishu, ...options }) {
    if (!feishu?.references) throw new Error("Wiki discovery needs the Feishu deployment its links belong to");
    this.feishu = feishu; this.transport = new WikiKeyTransport(options);
  }
  async page(after = null, { signal } = {}) {
    try {
      if (after !== null && !wikiDigest(after)) throw new Error();
      const session = structuredClone(await this.transport.session());
      const value = await this.transport.keyRequest(session, "discover", { after }, signal);
      wikiExact(value, ["targets", "after", "nextAfter", "originalOrigin", "folderReference", "catalogDigest", "policyDigest", "expiresAt", "automaticReceivingApproved", "permissionsChecked", "sessionBinding"]);
      const origin = this.feishu.references.tenantOrigin(value.originalOrigin), folder = this.feishu.references.driveFolder(value.folderReference);
      if (value.automaticReceivingApproved !== true || value.permissionsChecked !== false || value.sessionBinding !== wikiHash(["wiki-discovery-v1", session.token]) ||
          value.after !== after || value.nextAfter !== null && (!wikiDigest(value.nextAfter) || after !== null && value.nextAfter <= after) ||
          value.folderReference !== this.feishu.links.driveFolder(origin, folder.token) || !wikiDigest(value.catalogDigest) || !wikiDigest(value.policyDigest) ||
          value.expiresAt !== session.expiresAt || value.expiresAt <= this.transport.now() || !Array.isArray(value.targets) || value.targets.length > 5) throw new Error();
      let previous = after;
      for (const target of value.targets) {
        wikiExact(target, ["shardKey", "publicationHash", "generation"]);
        if (!wikiDigest(target.shardKey) || !wikiDigest(target.publicationHash) || !Number.isSafeInteger(target.generation) || target.generation < 1 ||
            previous !== null && target.shardKey <= previous || value.nextAfter !== null && target.shardKey > value.nextAfter) throw new Error();
        previous = target.shardKey;
      }
      await this.transport.unchanged(session); this.transport.businessAccess(); signal?.throwIfAborted();
      const { sessionBinding: _binding, ...page } = value; return page;
    } catch { throw new Error("企业知识接收目录不可用或权限已变化，未自动重试。"); }
  }
  async assertCandidate(page, target, options) {
    const current = await this.page(page.after, options);
    if (["catalogDigest", "policyDigest", "folderReference", "originalOrigin", "expiresAt"].some(key => current[key] !== page[key]) ||
        !current.targets.some(row => wikiHash(row) === wikiHash(target))) throw new Error("知识接收目标或企业策略已变化。");
  }
}
