import { parseSaasDocumentReference } from "./document-format.js";
import { cliApiGet } from "./openapi.js";
import { successfulUserPayload } from "./document-errors.js";
import { readWikiDocx, wikiDocumentOrigin } from "./wiki-source-format.js";

export class SaasWikiSourceReader {
  constructor(provider, { origin }) { this.provider = provider; this.origin = wikiDocumentOrigin(origin); }
  documentIdentity(options) { return this.provider.documentIdentity(options); }
  async normalizeObservedDocument(document, options = {}) {
    if (document.partial !== false) throw new Error("局部阅读不建立全文知识副本");
    const fresh = await this.readDocument(document.sourceUrl, options);
    if (fresh.resourceId !== document.resourceId || fresh.identity.principal !== document.identity?.principal || fresh.identity.tenantKey !== document.identity?.tenantKey) throw new Error("知识来源身份已变化");
    return fresh;
  }
  async readDocument(reference, { signal } = {}) {
    const parsed = parseSaasDocumentReference(reference);
    if (parsed.partial || new URL(parsed.url).origin !== this.origin) throw new Error("知识来源必须是已配置企业域名的完整文档");
    const identity = await this.provider.documentIdentity({ signal });
    const current = async () => {
      signal?.throwIfAborted(); const fresh = await this.provider.documentIdentity({ signal }); signal?.throwIfAborted();
      if (fresh.principal !== identity.principal || fresh.tenantKey !== identity.tenantKey) throw new Error("知识读取期间账号已变化");
    };
    let resourceId = parsed.token;
    if (parsed.kind === "wiki") {
      const resolved = await this.provider.readDocument(parsed.url, { signal }); await current();
      if (resolved.partial !== false || resolved.providerId !== this.provider.id || resolved.identity.principal !== identity.principal || resolved.identity.tenantKey !== identity.tenantKey) throw new Error("知识库文档映射未核验");
      resourceId = resolved.resourceId;
    }
    const document = await readWikiDocx({ resourceId, origin: this.origin, assertCurrent: current, get: async endpoint => {
      const args = [...cliApiGet(endpoint), "--as", "user", "--format", "json"];
      const response = successfulUserPayload(await this.provider.invoke(args, { signal, timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024 }));
      return response.data;
    } });
    await current(); return { ...document, identity: { ...identity, verifiedAt: Date.now() } };
  }
}
