import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export class DocumentService extends EventEmitter {
  constructor({ provider, getTask, now = Date.now }) {
    super(); this.provider = provider; this.getTask = getTask; this.now = now; this.opened = new Map(); this.generations = new Map();
  }
  close(taskId) {
    this.generations.set(taskId, (this.generations.get(taskId) || 0) + 1);
    const previous = this.opened.get(taskId); this.opened.delete(taskId);
    if (previous) this.emit("invalidated", { taskId, handle: previous.handle });
  }
  // Picking a document by name instead of by link. Read-only and stateless: it
  // opens nothing and changes no task, so a search can never replace the
  // explicit open that establishes a document reference.
  async search(taskId, query, kind, pageToken = null) {
    this.getTask(taskId);
    return this.provider.searchDocuments({ query, kind, pageToken });
  }
  async open(taskId, reference) {
    this.getTask(taskId); this.close(taskId);
    const generation = this.generations.get(taskId);
    const document = await this.provider.readDocument(reference);
    if (this.generations.get(taskId) !== generation) throw new Error("文档已切换，请重新打开");
    const entry = { handle: randomUUID(), document, expiresAt: this.now() + 10 * 60_000 };
    this.opened.set(taskId, entry);
    this.emit("read", document);
    return { ...document, identity: undefined, handle: entry.handle, expiresAt: entry.expiresAt };
  }
  async prepareContext(taskId, input) {
    this.getTask(taskId);
    const entry = this.opened.get(taskId);
    if (!entry || input.handle !== entry.handle || entry.expiresAt <= this.now()) {
      if (entry && entry.expiresAt <= this.now()) this.close(taskId);
      throw new Error("文档引用已失效，请重新打开文档");
    }
    let fresh;
    try { fresh = await this.provider.readDocument(entry.document.sourceUrl); }
    catch (error) { if (this.opened.get(taskId) === entry) this.close(taskId); throw error; }
    if (this.opened.get(taskId) !== entry) throw new Error("文档已切换，未发送旧引用");
    if (fresh.identity.principal !== entry.document.identity.principal || fresh.resourceId !== entry.document.resourceId ||
        fresh.sourceRevision !== entry.document.sourceRevision || fresh.contentHash !== entry.document.contentHash) {
      this.close(taskId); throw new Error("飞书文档版本、链接目标或身份已变化，请重新打开后引用");
    }
    let selection, text = fresh.text;
    if (input.selection) {
      const { start, end } = input.selection;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length || end - start > 8000) throw new Error("文档选区无效或超过 8000 字，请重新选择");
      selection = { start, end, text: text.slice(start, end), startLine: text.slice(0, start).split("\n").length, endLine: text.slice(0, end - 1).split("\n").length };
      text = selection.text;
    } else if (text.length > 24_000) throw new Error("文档较长，请先选中需要引用的段落（最多 8000 字）");
    if (input.intent === "propose-edit" && (!selection || text.length > 2000 || /[\x00-\x1f\x7f]/.test(text) || fresh.partial)) throw new Error("请打开完整文档并选择不跨行的 1–2000 字，再生成修改建议");
    this.emit("read", fresh);
    return { kind: "feishu-document", providerId: fresh.providerId, resourceId: fresh.resourceId, title: fresh.title,
      sourceUrl: fresh.sourceUrl, sourceRevision: fresh.sourceRevision, contentHash: fresh.contentHash,
      principal: fresh.identity.principal, tenantKey: fresh.identity.tenantKey, authorizedAt: fresh.identity.verifiedAt,
      partial: fresh.partial || Boolean(selection), warnings: fresh.warnings, text, ...(selection ? { selection } : {}), ...(input.intent === "propose-edit" ? { intent: "propose-edit" } : {}) };
  }
}
