import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// What differs between the page that was opened and the same page read again, named
// by record id and field name only -- never a value -- so the person, and whoever
// looks into it, can tell a real edit from a reordering or an identity change.
export function describeBaseChange(before, after) {
  if (before.identity?.principal !== after.identity?.principal || before.identity?.tenantKey !== after.identity?.tenantKey) return "的读取身份已变化";
  if (before.contentHash === after.contentHash) return null;
  // Compared by id throughout: column order is not content (Feishu does not keep it steady).
  const byId = items => new Map(items.map(item => [item.id, item]));
  const beforeFields = byId(before.fields), afterFields = byId(after.fields);
  if (beforeFields.size !== afterFields.size || [...afterFields.keys()].some(id => !beforeFields.has(id))) return "的字段有增减";
  if ([...afterFields].some(([id, field]) => JSON.stringify(field) !== JSON.stringify(beforeFields.get(id)))) return "的字段名称或类型变了";
  const ids = items => items.map(item => item.id);
  if (ids(before.records).join() !== ids(after.records).join()) return [...ids(before.records)].sort().join() === [...ids(after.records)].sort().join() ? "的记录顺序变了" : "的记录有增减";
  const earlier = byId(before.records);
  for (const record of after.records) {
    const old = new Map(earlier.get(record.id).cells.map(cell => [cell.fieldId, cell]));
    const cell = record.cells.find(item => JSON.stringify(item) !== JSON.stringify(old.get(item.fieldId)));
    if (cell) return `里记录 ${record.id} 的「${afterFields.get(cell.fieldId)?.name ?? cell.fieldId}」变了`;
  }
  const labels = { tables: "数据表列表", title: "标题", sourceUrl: "链接", more: "分页状态", truncated: "字段完整性", offset: "起始位置", limit: "每页条数" };
  for (const [key, label] of Object.entries(labels)) if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) return `的${label}变了`;
  return "的内容已变化";
}

// One page of one Base table per task, beside the conversation, with the
// spreadsheet's lifecycle (sheet-service.js): a ten-minute handle, reads aborted
// when the task moves on, and a reference read again and compared before it is
// sent. A Base has no version to compare, so the page's content digest is.
export class BaseService extends EventEmitter {
  constructor({ provider, getTask, businessAccess = () => {}, now = Date.now }) {
    super(); Object.assign(this, { provider, getTask, businessAccess, now });
    this.opened = new Map(); this.runs = new Map(); this.closed = false;
  }
  close(taskId) {
    this.runs.get(taskId)?.abort(); this.runs.delete(taskId);
    const entry = this.opened.get(taskId); entry?.controller.abort(); this.opened.delete(taskId);
    if (entry) this.emit("invalidated", { taskId, handle: entry.handle });
  }
  async open(taskId, reference, options = {}) {
    this.getTask(taskId); this.businessAccess(); if (this.closed) throw new Error("多维表格阅读器已关闭。"); this.close(taskId);
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["tableId", "offset"].includes(key))) throw new Error("多维表格读取参数无效。");
    const controller = new AbortController(); this.runs.set(taskId, controller);
    try {
      const base = await this.provider.snapshot(reference, { ...options, signal: controller.signal }); this.businessAccess(); controller.signal.throwIfAborted();
      if (this.runs.get(taskId) !== controller) throw new Error("多维表格已切换。");
      const entry = { handle: randomUUID(), base, controller, expiresAt: this.now() + 10 * 60000 }; this.opened.set(taskId, entry);
      return { ...base, identity: undefined, handle: entry.handle, expiresAt: entry.expiresAt };
    } finally { if (this.runs.get(taskId) === controller) this.runs.delete(taskId); }
  }
  async prepareContext(taskId, input, { signal } = {}) {
    this.getTask(taskId); this.businessAccess(); if (this.closed) throw new Error("多维表格阅读器已关闭。");
    const entry = this.opened.get(taskId);
    if (!entry || input?.handle !== entry.handle || entry.expiresAt <= this.now() || (input.intent && input.intent !== "propose-edit")) {
      if (entry?.expiresAt <= this.now()) this.close(taskId);
      throw new Error("多维表格引用已失效或不支持该操作，请重新读取。");
    }
    let fresh;
    const currentSignal = signal ? AbortSignal.any([signal, entry.controller.signal]) : entry.controller.signal;
    try {
      fresh = await this.provider.snapshot(entry.base.sourceUrl, { tableId: entry.base.tableId, offset: entry.base.offset, limit: entry.base.limit, signal: currentSignal });
      this.businessAccess(); currentSignal.throwIfAborted();
    } catch (error) { if (this.opened.get(taskId) === entry) this.close(taskId); throw error; }
    if (this.opened.get(taskId) !== entry || entry.expiresAt <= this.now()) throw new Error("多维表格已切换或引用到期，未发送旧内容。");
    const change = describeBaseChange(entry.base, fresh);
    if (change) { this.close(taskId); throw new Error(`飞书多维表格${change}，请刷新后再引用。`); }
    if (input.intent === "propose-edit" && fresh.truncated) throw new Error("这一页的字段没有读全，不能据此生成修改建议。");
    const { tables: _tables, identity, records, fields, ...metadata } = fresh;
    const names = new Map(fields.map(field => [field.id, field.name]));
    // Records keyed by id and cells by field id as well as name: the model names a
    // field by what a person reads, the write binds to what Feishu stores.
    const rows = records.map(record => ({ record: record.id, cells: record.cells.map(cell => ({ field: names.get(cell.fieldId), ...cell })) }));
    const context = { ...metadata, fields, rows, ...(input.intent === "propose-edit" ? { intent: "propose-edit" } : {}),
      principal: identity.principal, tenantKey: identity.tenantKey, authorizedAt: identity.verifiedAt };
    if (JSON.stringify(context).length > 24000) throw new Error("多维表格引用超过 24000 字，请减少记录后再发送。");
    return context;
  }
  dispose() { this.closed = true; for (const id of new Set([...this.runs.keys(), ...this.opened.keys()])) this.close(id); this.removeAllListeners(); }
}
