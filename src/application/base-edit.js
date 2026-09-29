import { baseEditProposal } from "./base-proposal.js";

const RUNNING = new Set(["running", "awaiting_approval", "stopping"]);
const RECHECKABLE = new Set(["unknown", "mismatch"]);
const SOURCE_KEYS = ["providerId", "resourceId", "sourceUrl", "sourceRevision", "contentHash"];

// A Base write can be undone when what its fields hold is known: a verified
// write, or a mismatch in which Feishu kept each confirmed value in another form
// (a number stored as text). Any other difference may be someone else's value,
// and a Base has no version to tell the two apart, so it is left to Feishu.
export const undoableBaseEdit = record => record?.state === "verified" || (record?.state === "mismatch" && !record.ignored?.length &&
  Array.isArray(record.differences) && record.differences.length > 0 &&
  record.differences.every(item => !item.missing && item.actual !== null && item.expected !== null && String(item.actual) === String(item.expected)));

// A line a person recognises a record by: its first text value.
const recordLabel = row => {
  const cell = row?.cells?.find(item => typeof item.value === "string" && item.value.trim());
  return cell ? `${cell.field}：${cell.value.trim().slice(0, 40)}` : null;
};

// Reviewed Base values written into the table they were proposed for, and taken
// back out, with the spreadsheet write's lifecycle (sheet-edit.js): a draft usable
// once, one write per task and per table at a time, the intent saved before the
// CLI runs, and an outcome read back or recorded as unknown -- never retried.
export class BaseEdits {
  constructor({ bases, getTask, provider, businessAccess = () => {}, saveTask = async () => {} }) {
    Object.assign(this, { bases, getTask, provider, businessAccess, saveTask });
    this.drafts = new WeakMap(); this.active = new Set(); this.resources = new Set();
  }
  entry(taskId, context) {
    this.businessAccess();
    const task = this.getTask(taskId), entry = this.bases.opened.get(taskId), base = entry?.base;
    if (RUNNING.has(task.status)) throw new Error("请等待当前任务结束后再写入多维表格");
    if (!entry || entry.expiresAt <= this.bases.now() || SOURCE_KEYS.some(key => base[key] !== context[key]) ||
        base.identity?.principal !== context.principal || base.identity?.tenantKey !== context.tenantKey) {
      throw new Error("修改建议对应的多维表格、内容或身份已失效，请重新读取并生成建议");
    }
    return entry;
  }
  located(taskId, messageId) {
    const task = this.getTask(taskId), index = task.messages.findIndex(item => item.id === messageId && item.role === "assistant");
    if (index < 0) throw new Error("找不到当前任务的多维表格修改建议");
    const context = task.messages.slice(0, index).findLast(item => item.role === "user")?.context;
    if (context?.kind !== "feishu-base" || context.intent !== "propose-edit") throw new Error("这条回复不是针对所读多维表格的修改建议");
    return { message: task.messages[index], context };
  }
  source(context) { return { sourceUrl: context.sourceUrl, baseToken: context.baseToken, tableId: context.tableId, principal: context.principal, tenantKey: context.tenantKey }; }
  draft(saved) {
    const { context, kind, changes } = saved;
    const draft = Object.freeze({ kind, title: context.title, sourceUrl: context.sourceUrl, tableId: context.tableId, changes: Object.freeze(changes.map(change => Object.freeze({ ...change }))) });
    this.drafts.set(draft, saved);
    return draft;
  }
  async prepare(taskId, messageId) {
    if (this.active.has(taskId)) throw new Error("多维表格写入仍在执行，请先核查结果");
    const { message, context } = this.located(taskId, messageId);
    if (message.baseEdit) throw new Error("这条建议已有写入记录，请核查原结果，不会重复提交");
    const entry = this.entry(taskId, context), proposal = baseEditProposal(message.text, context);
    const fields = new Map(context.fields.map(field => [field.name, field])), rows = new Map(context.rows.map(row => [row.record, row]));
    const changes = proposal.changes.map(change => {
      const field = fields.get(change.field), row = rows.get(change.record), cell = row.cells.find(item => item.fieldId === field.id);
      return { record: change.record, label: recordLabel(row), field: field.name, fieldId: field.id, before: cell.value, after: change.value };
    });
    const prepared = await this.provider.prepare(this.source(context), changes);
    if (this.entry(taskId, context) !== entry) throw new Error("准备期间多维表格已切换，未写入");
    return this.draft({ taskId, context, entry, prepared, message, kind: "apply", changes });
  }
  // Undo writes the originals back. It does not need the table to be open: the
  // check before the write reads the records fresh and stops if any field no
  // longer holds what the read-back found.
  async prepareUndo(taskId, messageId) {
    if (this.active.has(taskId)) throw new Error("多维表格写入仍在执行，请先核查结果");
    this.businessAccess();
    if (RUNNING.has(this.getTask(taskId).status)) throw new Error("请等待当前任务结束后再撤销多维表格写入");
    const { message, context } = this.located(taskId, messageId), record = message.baseEdit;
    if (!undoableBaseEdit(record)) throw new Error("这次写入不能在这里撤销：只有逐条读回核对过、结果完整可知的写入才可以撤销，请到飞书核查多维表格");
    if (record.undo) throw new Error("这次写入已有撤销记录，请核查原结果，不会重复提交");
    const found = new Map((record.differences ?? []).map(item => [JSON.stringify([item.record, item.fieldId]), item.actual]));
    const changes = record.changes.map(change => {
      const key = JSON.stringify([change.record, change.fieldId]);
      return { ...change, before: found.has(key) ? found.get(key) : change.after, after: change.before };
    });
    const prepared = await this.provider.prepare(this.source(context), changes);
    return this.draft({ taskId, context, entry: null, prepared, message, kind: "undo", changes });
  }
  // A write whose read-back did not settle it -- Feishu still serving the old
  // values, another value, or no read-back at all -- is read again when the person
  // asks, and recorded as what that read finds. Only the latest attempt; nothing
  // is written.
  async recheck(taskId, messageId) {
    if (this.active.has(taskId)) throw new Error("多维表格写入仍在执行，请先等待结果");
    this.businessAccess();
    if (RUNNING.has(this.getTask(taskId).status)) throw new Error("请等待当前任务结束后再核对多维表格写入");
    const { message, context } = this.located(taskId, messageId), target = message.baseEdit?.undo ?? message.baseEdit;
    if (!RECHECKABLE.has(target?.state)) throw new Error("这次写入没有需要重新核对的结果");
    this.active.add(taskId);
    try {
      const result = await this.provider.recheck(this.source(context), target.changes, { ignored: target.ignored });
      if (!this.getTask(taskId).messages.includes(message) || (message.baseEdit?.undo ?? message.baseEdit) !== target) throw new Error("核对期间写入记录已变化，请重新核对");
      Object.assign(target, { state: result.state, differences: result.differences, checkedAt: Date.now() });
      await this.saveTask(this.getTask(taskId));
      return { kind: "recheck", state: result.state, sourceUrl: context.sourceUrl, tableId: context.tableId, differences: result.differences };
    } finally { this.active.delete(taskId); }
  }
  async apply(draft) {
    const saved = this.drafts.get(draft); this.drafts.delete(draft);
    if (!saved) throw new Error("写入确认已使用或失效");
    const { taskId, context, entry, prepared, message, kind, changes } = saved;
    if (kind === "apply" ? message.baseEdit : message.baseEdit?.undo) throw new Error("已有写入记录，不会重复提交");
    const key = JSON.stringify([context.providerId, context.principal, context.resourceId]);
    if (this.active.has(taskId) || this.resources.has(key)) throw new Error("这张多维表格已有写入正在执行，未重复提交");
    this.active.add(taskId); this.resources.add(key);
    const record = () => kind === "apply" ? message.baseEdit : message.baseEdit.undo;
    const store = value => { if (kind === "apply") message.baseEdit = value; else message.baseEdit.undo = value; };
    try {
      const result = await this.provider.apply(prepared, async () => {
        // A rollback between the card and the write would leave the record nowhere.
        if (!this.getTask(taskId).messages.includes(message)) throw new Error("这条建议已不在当前任务里，未写入");
        if (kind === "apply" && this.entry(taskId, context) !== entry) throw new Error("确认期间多维表格已切换，未写入");
        if (kind === "undo" && RUNNING.has(this.getTask(taskId).status)) throw new Error("请等待当前任务结束后再撤销多维表格写入");
        this.businessAccess();
        store({ state: "dispatching", changes: changes.map(change => ({ ...change })), at: Date.now() });
        // The page on screen stops being the table the moment the write goes out.
        if (this.bases.opened.get(taskId)?.base?.resourceId === context.resourceId) this.bases.close(taskId);
        await this.saveTask(this.getTask(taskId)); // Persist the one-shot intent before the CLI writes.
      });
      store({ ...record(), state: result.state, differences: result.differences, ...(result.ignored.length ? { ignored: result.ignored } : {}) });
      try { await this.saveTask(this.getTask(taskId)); }
      catch { throw new Error("飞书写入已读回核对，但本机记录保存未确认；请核查多维表格，不要重试。"); }
      return { kind, state: result.state, sourceUrl: context.sourceUrl, tableId: context.tableId, differences: result.differences };
    } catch (error) {
      if (record()?.state === "dispatching") {
        record().state = "unknown";
        await this.saveTask(this.getTask(taskId)).catch(() => {});
      }
      throw error;
    } finally { this.active.delete(taskId); this.resources.delete(key); }
  }
}
