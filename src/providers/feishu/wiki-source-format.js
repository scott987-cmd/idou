import { createHash } from "node:crypto";
import { SAAS_PROVIDER_ID, SAAS_TENANT_HOST } from "./saas-deployment.js";

export const WIKI_SOURCE_SCOPE = "docx:document:readonly";
export const WIKI_SOURCE_FORMAT = "feishu-docx-plain-v1";
export function wikiDocumentOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.port || !SAAS_TENANT_HOST.test(url.hostname)) throw new Error("Invalid enterprise Feishu document origin");
  return url.origin;
}
export function wikiOriginalOrigins(value, tenantOrigin = wikiDocumentOrigin) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100) throw new Error("Invalid Wiki original origins");
  const entries = Object.entries(value);
  if (entries.some(([tenant]) => !/^[A-Za-z0-9_-]{1,256}$/.test(tenant))) throw new Error("Invalid Wiki original origins");
  return Object.fromEntries(entries.map(([tenant, origin]) => [tenant, tenantOrigin(origin)]));
}

// Both CLI and server HTTP readers use this exact representation. A document's
// plain-text projection is not its images, embedded sheets or a lossless editor.
// A deployment that speaks the same OpenAPI names itself and says which origins
// are its tenants'; the SaaS values are the defaults only for the SaaS reader.
const saasDocumentLink = (origin, resourceId) => `${origin}/docx/${resourceId}`;
export async function readWikiDocx({ resourceId, origin, get, assertCurrent, providerId = SAAS_PROVIDER_ID, tenantOrigin = wikiDocumentOrigin, documentLink = saasDocumentLink }) {
  if (typeof resourceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(resourceId) || typeof get !== "function" || typeof assertCurrent !== "function" ||
    typeof providerId !== "string" || !/^[a-z][a-z0-9-]{1,39}$/.test(providerId) || typeof tenantOrigin !== "function" || typeof documentLink !== "function") throw new Error("Invalid Wiki source reader");
  const sourceUrl = documentLink(tenantOrigin(origin), resourceId), base = `/open-apis/docx/v1/documents/${resourceId}`;
  const metadata = data => {
    const doc = data?.document;
    if (doc?.document_id !== resourceId || !Number.isSafeInteger(doc.revision_id) || doc.revision_id < 1 || typeof doc.title !== "string" || !doc.title.trim() || doc.title.length > 4096 || doc.title.includes("\0")) throw new Error("Invalid Wiki source metadata");
    return { revision: String(doc.revision_id), title: doc.title };
  };
  await assertCurrent();
  const before = metadata(await get(base)); await assertCurrent();
  const raw = await get(`${base}/raw_content?lang=0`); await assertCurrent();
  if (typeof raw?.content !== "string" || !raw.content.trim() || raw.content.length > 500000 || raw.content.includes("\0")) throw new Error("Invalid Wiki source text");
  const after = metadata(await get(base)); await assertCurrent();
  if (before.revision !== after.revision || before.title !== after.title) throw new Error("Wiki source changed while reading");
  const text = raw.content, contentHash = createHash("sha256").update(JSON.stringify([WIKI_SOURCE_FORMAT, resourceId, before.revision, before.title, text])).digest("hex");
  return { kind: "feishu-document", providerId, resourceId, sourceUrl, sourceRevision: before.revision, contentHash, title: before.title, text, partial: false,
    warnings: ["此知识来源为飞书纯文本投影；图片、附件、嵌入表格及其他非文本资源未展开。"] };
}
