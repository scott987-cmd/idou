import { sheetEditProposal } from "./sheet-proposal.js";

const RUNNING = new Set(["running", "awaiting_approval", "stopping"]);
const SOURCE_KEYS = ["providerId", "resourceId", "sourceUrl", "sheetId", "sourceRevision", "contentHash"];

// A write can be undone when what Feishu holds is fully known: `verified`, or a
// `mismatch` Feishu made of this write alone -- the revision moved by exactly one,
// nothing was written before the read-back, and only the cells it wrote differ (a
// text-formatted cell keeps a number as text, measured live). Undo then expects
// the values the read-back found, and still stops if anyone has changed them since.
export const undoableSheetEdit = record => record?.state === "verified" || (record?.state === "mismatch" && record.revision !== undefined &&
  record.readBackRevision === record.revision && Array.isArray(record.differences) && record.differences.length > 0 && record.differences.every(item => item.changed === true));

// Reviewed cell values written into the Feishu spreadsheet they were proposed
// for, and taken back out again. The lifecycle is the document edit's
// (document-edit.js): a draft usable once, one write per task and per sheet at a
// time, the intent saved before the CLI runs, and an outcome that is read back or
// recorded as unknown -- never retried. A sheet adds undo, which is the same
// write in reverse under the same checks, and two outcomes a conditional
// document write cannot have: `conflict`, when the revision moved by more than
// this one write, and `mismatch`, when Feishu holds a value other than the one
// confirmed (a number for "00456", say). Both are reported, not repaired.
export class SheetEdits {
  constructor({ sheets, getTask, provider, businessAccess = () => {}, saveTask = async () => {} }) {
    Object.assign(this, { sheets, getTask, provider, businessAccess, saveTask });
    this.drafts = new WeakMap(); this.active = new Set(); this.resources = new Set();
  }
  entry(taskId, context) {
    this.businessAccess();
    const task = this.getTask(taskId), entry = this.sheets.opened.get(taskId), sheet = entry?.sheet;
    if (RUNNING.has(task.status)) throw new Error("请等待当前任务结束后再写入表格");
    if (!entry || entry.expiresAt <= this.sheets.now() || SOURCE_KEYS.some(key => sheet[key] !== context[key]) ||
        sheet.identity?.principal !== context.principal || sheet.identity?.tenantKey !== context.tenantKey) {
      throw new Error("修改建议对应的表格、版本或身份已失效，请重新读取表格并生成建议");
    }
    return entry;
  }
  located(taskId, messageId) {
    const task = this.getTask(taskId), index = task.messages.findIndex(item => item.id === messageId && item.role === "assistant");
    if (index < 0) throw new Error("找不到当前任务的表格修改建议");
    const context = task.messages.slice(0, index).findLast(item => item.role === "user")?.context;
    if (context?.kind !== "feishu-sheet" || context.intent !== "propose-edit") throw new Error("这条回复不是针对所读表格范围的修改建议");
    return { message: task.messages[index], context };
  }
  source(context) { return { sourceUrl: context.sourceUrl, sheetId: context.sheetId, principal: context.principal, tenantKey: context.tenantKey }; }
  draft(saved) {
    const { context, prepared, kind, changes, message } = saved;
    const draft = Object.freeze({ kind, title: context.title, sourceUrl: context.sourceUrl, sheetId: context.sheetId, range: prepared.rectangle.a1,
      revision: kind === "apply" ? context.sourceRevision : message.sheetEdit.revision,
      changes: Object.freeze(changes.map(change => Object.freeze({ ...change }))) });
    this.drafts.set(draft, saved);
    return draft;
  }
  async prepare(taskId, messageId) {
    if (this.active.has(taskId)) throw new Error("表格写入仍在执行，请先核查结果");
    const { message, context } = this.located(taskId, messageId);
    if (message.sheetEdit) throw new Error("这条建议已有写入记录，请核查原结果，不会重复提交");
    const entry = this.entry(taskId, context), proposal = sheetEditProposal(message.text, context);
    const originals = new Map(context.rows.flatMap(row => row.cells.map(cell => [cell.address, cell.value])));
    const changes = proposal.changes.map(change => ({ address: change.address, before: originals.get(change.address), after: change.value }));
    const prepared = await this.provider.prepare(this.source(context), changes);
    if (this.entry(taskId, context) !== entry) throw new Error("准备期间表格已切换，未写入");
    return this.draft({ taskId, context, entry, prepared, message, kind: "apply", changes });
  }
  // Undo writes the confirmed values' originals back. It does not need the sheet
  // to be open: the check before the write reads the cells fresh and refuses if
  // any of them no longer holds the value that was written.
  async prepareUndo(taskId, messageId) {
    if (this.active.has(taskId)) throw new Error("表格写入仍在执行，请先核查结果");
    this.businessAccess();
    if (RUNNING.has(this.getTask(taskId).status)) throw new Error("请等待当前任务结束后再撤销表格写入");
    const { message, context } = this.located(taskId, messageId), record = message.sheetEdit;
    if (!undoableSheetEdit(record)) throw new Error("这次写入不能在这里撤销：只有读回结果完整、期间没有他人改动的写入才可以撤销，请到飞书核查原表");
    if (record.undo) throw new Error("这次写入已有撤销记录，请核查原结果，不会重复提交");
    // The cells hold what the read-back found, which for a mismatch is Feishu's value rather than the confirmed one.
    const found = new Map((record.differences ?? []).map(item => [item.address, item.actual]));
    const changes = record.changes.map(change => ({ address: change.address, before: found.has(change.address) ? found.get(change.address) : change.after, after: change.before }));
    const prepared = await this.provider.prepare(this.source(context), changes);
    return this.draft({ taskId, context, entry: null, prepared, message, kind: "undo", changes });
  }
  async apply(draft) {
    const saved = this.drafts.get(draft); this.drafts.delete(draft);
    if (!saved) throw new Error("写入确认已使用或失效");
    const { taskId, context, entry, prepared, message, kind, changes } = saved;
    if (kind === "apply" ? message.sheetEdit : message.sheetEdit?.undo) throw new Error("已有写入记录，不会重复提交");
    const key = JSON.stringify([context.providerId, context.principal, context.resourceId, context.sheetId]);
    if (this.active.has(taskId) || this.resources.has(key)) throw new Error("这张表已有写入正在执行，未重复提交");
    this.active.add(taskId); this.resources.add(key);
    const record = () => kind === "apply" ? message.sheetEdit : message.sheetEdit.undo;
    const store = value => { if (kind === "apply") message.sheetEdit = value; else message.sheetEdit.undo = value; };
    try {
      const result = await this.provider.apply(prepared, async ({ baseRevision }) => {
        // A rollback between the card and the write would leave the record nowhere.
        if (!this.getTask(taskId).messages.includes(message)) throw new Error("这条建议已不在当前任务里，未写入");
        if (kind === "apply" && this.entry(taskId, context) !== entry) throw new Error("确认期间表格已切换，未写入");
        if (kind === "undo" && RUNNING.has(this.getTask(taskId).status)) throw new Error("请等待当前任务结束后再撤销表格写入");
        this.businessAccess();
        store({ state: "dispatching", range: prepared.rectangle.a1, baseRevision, changes: changes.map(change => ({ ...change })), at: Date.now() });
        // The snapshot on screen stops being the sheet the moment the write goes out.
        const open = this.sheets.opened.get(taskId)?.sheet;
        if (open?.resourceId === context.resourceId && open.sheetId === context.sheetId) this.sheets.close(taskId);
        await this.saveTask(this.getTask(taskId)); // Persist the one-shot intent before the CLI writes.
      });
      store({ ...record(), state: result.state, revision: result.revision, readBackRevision: result.readBackRevision, differences: result.differences });
      try { await this.saveTask(this.getTask(taskId)); }
      catch { throw new Error("飞书写入已读回核对，但本机记录保存未确认；请核查原表，不要重试。"); }
      return { kind, state: result.state, sourceUrl: context.sourceUrl, sheetId: context.sheetId, range: prepared.rectangle.a1, revision: result.revision, differences: result.differences };
    } catch (error) {
      if (record()?.state === "dispatching") {
        // A receipt that arrived before the read-back failed still says which revision the write made.
        Object.assign(record(), { state: "unknown", ...(error?.revision ? { revision: error.revision } : {}) });
        await this.saveTask(this.getTask(taskId)).catch(() => {});
      }
      throw error;
    } finally { this.active.delete(taskId); this.resources.delete(key); }
  }
}
