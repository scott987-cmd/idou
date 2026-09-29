import { DOMParser } from "@xmldom/xmldom";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { successfulUserPayload } from "./document-errors.js";
import { parseSaasDocumentReference, projectDocumentXml } from "./document-format.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const escape = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function sameDocument(a, b) {
  return ["providerId", "resourceId", "sourceUrl", "sourceRevision", "contentHash"].every(key => a[key] === b[key]) && a.identity.principal === b.identity.principal && a.identity.tenantKey === b.identity.tenantKey;
}
export function inlineReplacement(xml, pattern, replacement) {
  if (typeof pattern !== "string" || !pattern.trim() || pattern.length > 2000 || typeof replacement !== "string" || replacement.length > 2000 || pattern === replacement || /[\x00-\x1f\x7f]/.test(pattern + replacement)) throw new Error("仅支持 1–2000 字的行内原文及最多 2000 字的不同替换内容");
  projectDocumentXml(xml); // Strict XML, entity, size and depth validation.
  const root = new DOMParser().parseFromString(`<document>${xml}</document>`, "application/xml").documentElement;
  const all = root.textContent, first = all.indexOf(pattern);
  if (first < 0 || all.indexOf(pattern, first + 1) >= 0) throw new Error("原文必须在完整文档中唯一匹配，请扩大或重新选择片段");
  const safe = new Set(["document", "p", "h1", "h2", "h3", "h4", "h5", "h6", "b", "em", "u", "del", "span"]);
  let found = false; const walk = (node, eligible) => {
    if (node.nodeType === 1) eligible = eligible && safe.has(node.tagName) && !node.hasAttribute("ref");
    if (eligible && node.nodeType === 3 && node.data.includes(pattern)) found = true;
    for (let i = 0; i < (node.childNodes?.length ?? 0); i++) walk(node.childNodes.item(i), eligible);
  }; walk(root, true);
  if (!found) throw new Error("选区跨越结构、样式或引用，当前行内修改不能安全处理");
  return escape(replacement);
}

export class SaasDocumentEdits {
  constructor(provider) { this.provider = provider; }
  async prepare(expected, pattern, replacement) {
    if (expected.partial) throw new Error("请先打开完整文档，局部读取不能授权全文匹配替换");
    const fresh = await this.provider.readDocument(expected.sourceUrl);
    if (!sameDocument(expected, fresh)) throw new Error("飞书文档或身份已变化，请重新读取并生成修改建议");
    const response = await this.provider.invoke(["docs", "+fetch", "--doc", expected.resourceId, "--as", "user", "--doc-format", "xml", "--detail", "full", "--format", "json"], { timeoutMs: 30000, maxOutputBytes: 2 * 1024 * 1024 });
    const document = successfulUserPayload(response).data?.document;
    if (document?.document_id !== expected.resourceId || String(document?.revision_id) !== expected.sourceRevision) throw new Error("编辑结构的资源或版本不一致");
    const content = inlineReplacement(document.content, pattern, replacement);
    const identity = await this.provider.documentIdentity({ fresh: true });
    if (identity.principal !== expected.identity.principal || identity.tenantKey !== expected.identity.tenantKey) throw new Error("读取编辑结构期间身份已变化");
    return { expected, pattern, replacement, content, fullHash: hash(document.content) };
  }
  async apply(draft, beforeDispatch) {
    const fresh = await this.prepare(draft.expected, draft.pattern, draft.replacement);
    if (fresh.fullHash !== draft.fullHash) throw new Error("确认期间文档结构已变化，未写入");
    const directory = await mkdtemp(path.join(os.tmpdir(), "idou-doc-edit-"));
    let dispatched = false;
    try {
      await writeFile(path.join(directory, "replacement.xml"), fresh.content, { mode: 0o600 });
      await beforeDispatch(); dispatched = true;
      const response = await this.provider.invoke(["docs", "+update", "--doc", draft.expected.resourceId, "--command", "str_replace", "--pattern", draft.pattern, "--content", "@replacement.xml", "--revision-id", draft.expected.sourceRevision, "--doc-format", "xml", "--as", "user", "--format", "json"], {
        cwd: directory, timeoutMs: 30000, maxOutputBytes: 262144,
        // Scoped to this one dispatch: the target document, the base revision
        // and digests of the exact confirmed text. No document text leaves here.
        feishuWriteIntent: { action: "document.inline-replace", operationId: randomUUID(), documentId: draft.expected.resourceId,
          revisionId: Number(draft.expected.sourceRevision), patternHash: hash(draft.pattern), contentHash: hash(fresh.content) },
      });
      const data = successfulUserPayload(response).data;
      // The pinned CLI reports the changed-block count only on builds that carry
      // it; a receipt without the field is normal and must not read as failure.
      // Scope is instead proven by the read-back below, which requires the whole
      // projected document to equal the confirmed text with only this one span
      // replaced — a stricter guarantee than a count.
      if (data?.result !== "success" || data.updated_blocks_count !== undefined && data.updated_blocks_count !== 1 ||
          !Number.isSafeInteger(data.document?.revision_id) || data.document.revision_id <= Number(draft.expected.sourceRevision) ||
          !Array.isArray(data.warnings) || data.warnings.length) throw new Error("未收到单块无警告成功回执");
      // A receipt that names a document must name the one that was confirmed.
      if (data.document.url !== undefined && (typeof data.document.url !== "string" || parseSaasDocumentReference(data.document.url).token !== draft.expected.resourceId)) throw new Error("写入回执指向了另一个文档");
      const document = await this.provider.readDocument(draft.expected.sourceUrl);
      const expectedText = draft.expected.text.replace(draft.pattern, () => draft.replacement);
      if (document.resourceId !== draft.expected.resourceId || document.identity.principal !== draft.expected.identity.principal || document.identity.tenantKey !== draft.expected.identity.tenantKey || document.sourceRevision !== String(data.document.revision_id) || document.text !== expectedText) throw new Error("写后读取与确认结果不一致");
      return document;
    } catch (error) {
      if (dispatched) throw new Error("文档写入结果未能确认：可能已修改或部分修改。请在飞书核查后重新读取；不会自动重试或回滚。");
      throw error;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
