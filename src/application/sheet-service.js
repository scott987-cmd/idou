import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export class SheetService extends EventEmitter {
  constructor({ provider, getTask, businessAccess = () => {}, now = Date.now }) { super(); Object.assign(this, { provider, getTask, businessAccess, now }); this.opened = new Map(); this.runs = new Map(); this.closed = false; }
  close(taskId) {
    this.runs.get(taskId)?.abort(); this.runs.delete(taskId);
    const entry = this.opened.get(taskId); entry?.controller.abort(); this.opened.delete(taskId); if (entry) this.emit("invalidated", { taskId, handle: entry.handle });
  }
  async open(taskId, reference, options = {}) {
    this.getTask(taskId); this.businessAccess(); if (this.closed) throw new Error("表格阅读器已关闭。"); this.close(taskId);
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["sheetId", "range"].includes(key))) throw new Error("表格读取参数无效。");
    const controller = new AbortController(); this.runs.set(taskId, controller);
    try {
      const sheet = await this.provider.read(reference, { ...options, signal: controller.signal }); this.businessAccess(); controller.signal.throwIfAborted();
      if (this.runs.get(taskId) !== controller) throw new Error("表格已切换。");
      const entry = { handle: randomUUID(), sheet, controller, expiresAt: this.now() + 10 * 60000 }; this.opened.set(taskId, entry);
      // An accepted spreadsheet read, announced the way a document read is, so
      // the local knowledge copy can keep this worksheet as its own source.
      this.emit("read", sheet);
      return { ...sheet, identity: undefined, handle: entry.handle, expiresAt: entry.expiresAt };
    } finally { if (this.runs.get(taskId) === controller) this.runs.delete(taskId); }
  }
  async prepareContext(taskId, input, { signal } = {}) {
    this.getTask(taskId); this.businessAccess(); if (this.closed) throw new Error("表格阅读器已关闭。"); const entry = this.opened.get(taskId);
    if (!entry || input?.handle !== entry.handle || entry.expiresAt <= this.now() || (input.intent && input.intent !== "propose-edit")) { if (entry?.expiresAt <= this.now()) this.close(taskId); throw new Error("表格引用已失效或不支持该操作，请重新读取。"); }
    let fresh;
    const currentSignal = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
    try { fresh = await this.provider.read(entry.sheet.sourceUrl, { sheetId: entry.sheet.sheetId, range: entry.sheet.range, signal: currentSignal }); this.businessAccess(); currentSignal.throwIfAborted(); }
    catch (error) { if (this.opened.get(taskId) === entry) this.close(taskId); throw error; }
    if (this.opened.get(taskId) !== entry || entry.expiresAt <= this.now()) throw new Error("表格已切换或引用到期，未发送旧内容。");
    if (fresh.contentHash !== entry.sheet.contentHash || fresh.sourceRevision !== entry.sheet.sourceRevision || fresh.identity.principal !== entry.sheet.identity.principal || fresh.identity.tenantKey !== entry.sheet.identity.tenantKey) {
      this.close(taskId); throw new Error("飞书表格版本、内容或身份已变化，请刷新后再引用。");
    }
    if (fresh.truncated) throw new Error("当前范围被截断，请缩小范围重新读取后再引用。");
    // Feishu's advice on reading its raw response is already applied in these addressed rows (sheet-reader.js).
    const { sheets, cells, rowIndices, colIndices, identity, diagnostics: _diagnostics, ...metadata } = fresh;
    const rows = rowIndices.map((row, i) => ({ row, cells: colIndices.map((column, j) => ({ address: `${column}${row}`, ...cells[i][j] })) }));
    if (JSON.stringify(rows).length > 24000) throw new Error("表格引用超过 24000 字，请缩小范围后再发送。");
    return { ...metadata, rows, ...(input.intent === "propose-edit" ? { intent: "propose-edit" } : {}), principal: identity.principal, tenantKey: identity.tenantKey, authorizedAt: identity.verifiedAt };
  }
  dispose() { this.closed = true; for (const id of new Set([...this.runs.keys(), ...this.opened.keys()])) this.close(id); this.removeAllListeners(); }
}
