import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { successfulUserPayload } from "./document-errors.js";
import { parseSaasDocumentReference } from "./document-format.js";
import { cliApiGet } from "./openapi.js";

const hash = value => createHash("sha256").update(value).digest("hex");
// The confirmed digest must cover exactly the bytes the CLI puts on the wire.
// Recorded against the pinned binary: with `--content @file` and no `--title`,
// the request content is the file verbatim. Passing `--title` instead makes the
// CLI XML-escape it and prepend a <title> element, which would put the product
// in the business of reproducing that escaping. The title is taken from the
// Markdown's own first heading instead, so nothing has to be predicted.
export const MAX_AUTHORED_BYTES = 64 * 1024;

export function authoredMarkdown(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("文档内容不能为空");
  if (Buffer.byteLength(value, "utf8") > MAX_AUTHORED_BYTES) throw new Error(`文档内容超过 ${MAX_AUTHORED_BYTES / 1024} KB，请分次写入`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("文档内容含控制字符");
  return value;
}

// Display-only: names the document in the confirmation prompt. It is never sent.
export function authoredTitle(markdown) {
  const heading = /^[ \t]*#[ \t]+(.+?)[ \t]*$/m.exec(markdown);
  return (heading?.[1] ?? markdown.trim().split("\n", 1)[0]).slice(0, 80).trim() || "未命名文档";
}

export class SaasDocumentAuthoring {
  constructor(provider) { this.provider = provider; }
  async #dispatch(file, args, intent, beforeDispatch, content) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "idou-doc-authoring-"));
    try {
      await writeFile(path.join(directory, file), content, { mode: 0o600 });
      await beforeDispatch();
      return successfulUserPayload(await this.provider.invoke(args, {
        cwd: directory, timeoutMs: 60_000, maxOutputBytes: 262144,
        feishuWriteIntent: { ...intent, operationId: randomUUID() },
      })).data;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  // Creates one new document owned by the signed-in user. There is no prior
  // resource to pin, so the grant is bound to the confirmed content itself.
  async create(markdown, beforeDispatch = async () => {}) {
    const content = authoredMarkdown(markdown);
    const data = await this.#dispatch("draft.md",
      ["docs", "+create", "--doc-format", "markdown", "--content", "@./draft.md", "--as", "user", "--format", "json"],
      { action: "document.create", contentHash: hash(content) }, beforeDispatch, content);
    const document = data?.document;
    if (!document || typeof document.url !== "string" || !Number.isSafeInteger(document.revision_id)) throw new Error("未收到可核验的新建文档回执");
    const reference = parseSaasDocumentReference(document.url);
    if (reference.token !== document.document_id) throw new Error("新建回执里的链接与文档标识不一致");
    if (Array.isArray(data.warnings) && data.warnings.length) throw new Error(`飞书对新建文档返回了警告：${String(data.warnings[0]).slice(0, 120)}`);
    return { documentId: document.document_id, sourceUrl: document.url, revision: String(document.revision_id), title: authoredTitle(content) };
  }
  // Appends to the end of an existing document. The base revision travels in the
  // request and is part of the grant, but Feishu does not treat it as a
  // precondition: measured on a live tenant, a PUT carrying a stale revision_id
  // is accepted and applied. So the protection against "the document changed
  // between confirmation and dispatch" is the re-read below, not the revision.
  async append(expected, markdown, beforeDispatch = async () => {}) {
    const content = authoredMarkdown(markdown);
    const revisionId = Number(expected.sourceRevision);
    if (!Number.isSafeInteger(revisionId) || revisionId < 0) throw new Error("文档基准版本无效");
    const fresh = await this.provider.readDocument(expected.sourceUrl);
    if (fresh.resourceId !== expected.resourceId || fresh.sourceRevision !== expected.sourceRevision) throw new Error("飞书文档已被改动，请重新读取后再追加");
    const data = await this.#dispatch("append.md",
      ["docs", "+update", "--doc", expected.resourceId, "--command", "append", "--content", "@./append.md",
        "--doc-format", "markdown", "--revision-id", String(revisionId), "--as", "user", "--format", "json"],
      { action: "document.append", documentId: expected.resourceId, revisionId, contentHash: hash(content) }, beforeDispatch, content);
    if (data?.result !== "success" || !Number.isSafeInteger(data.document?.revision_id) || data.document.revision_id <= revisionId ||
        !Array.isArray(data.warnings) || data.warnings.length) throw new Error("未收到无警告的追加成功回执");
    if (data.document.url !== undefined && (typeof data.document.url !== "string" || parseSaasDocumentReference(data.document.url).token !== expected.resourceId)) throw new Error("追加回执指向了另一个文档");
    const after = await this.provider.readDocument(expected.sourceUrl);
    return { documentId: expected.resourceId, sourceUrl: after.sourceUrl, revision: after.sourceRevision };
  }
  // Appending to a document that only grows: a scheduled task's running log
  // (schedule-delivery.js). Reading it whole before and after, as append() does,
  // stops working once it passes what docs +fetch returns (1 MB of XML, 20,000
  // nodes), which a daily log reaches in months. An append at the end changes
  // nothing already there, so it needs only the revision it is based on -- read
  // from the document's own metadata -- and its receipt, which must say the
  // revision moved on, with no warning.
  async appendToEnd(documentId, markdown, beforeDispatch = async () => {}) {
    if (typeof documentId !== "string" || !/^[A-Za-z0-9]{8,64}$/.test(documentId)) throw new Error("文档标识无效");
    const content = authoredMarkdown(markdown);
    const meta = successfulUserPayload(await this.provider.invoke([...cliApiGet(`/open-apis/docx/v1/documents/${documentId}`), "--as", "user", "--format", "json"],
      { timeoutMs: 30_000, maxOutputBytes: 65536 })).data?.document;
    const revisionId = Number(meta?.revision_id);
    if (meta?.document_id !== documentId || !Number.isSafeInteger(revisionId) || revisionId < 1) throw new Error("读不到这份文档的当前版本");
    const data = await this.#dispatch("append.md",
      ["docs", "+update", "--doc", documentId, "--command", "append", "--content", "@./append.md",
        "--doc-format", "markdown", "--revision-id", String(revisionId), "--as", "user", "--format", "json"],
      { action: "document.append", documentId, revisionId, contentHash: hash(content) }, beforeDispatch, content);
    if (data?.result !== "success" || !Number.isSafeInteger(data.document?.revision_id) || data.document.revision_id <= revisionId ||
        !Array.isArray(data.warnings) || data.warnings.length) throw new Error("未收到无警告的追加成功回执");
    if (data.document.url !== undefined && (typeof data.document.url !== "string" || parseSaasDocumentReference(data.document.url).token !== documentId)) throw new Error("追加回执指向了另一个文档");
    return { documentId, title: typeof meta.title === "string" ? meta.title.slice(0, 120) : null, revision: String(data.document.revision_id) };
  }
}
