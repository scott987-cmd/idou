import { BASE_FIELD_ID, BASE_RECORD_ID } from "./base-records.js";

// Reviewed values written into a Feishu Base table, and taken back out. As with a
// spreadsheet (sheet-edits.js), the records are read just before the one write and
// read back after it, typed, through the pinned CLI's `base` shortcuts, and the
// write itself is the CLI's own dry-run plan travelling under a one-shot grant.
//
// Unlike a spreadsheet, a Base offers nothing to detect another writer with: its
// `rev` is read with a lag, and the batch update answers only with the fields it
// ignored (both measured live). So the check before the write narrows the window
// and the read-back proves the outcome, but a change someone makes to the same
// field in the moment between them is overwritten without a trace. The
// confirmation card says so.
//
// Nor is a read right after a write proof of anything: Feishu served a read-back
// taken straight after a confirmed batch update with every old value, and the same
// fields read correctly under a minute later (measured live). A field still
// holding its value from before the write is therefore read again, a few times,
// and if it still does, the outcome is recorded as not yet known -- for the
// person to have read again later -- rather than as a mismatch.

// Waits between read-backs while a field still holds its old value.
const SETTLE_MS = Object.freeze([1_000, 2_000, 3_000, 4_000, 5_000]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => (a ?? null) === (b ?? null);
const shown = value => value === null || value === undefined ? "空" : JSON.stringify(value);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const acceptable = value => value === null || (typeof value === "string" && value.length <= 2000) || (typeof value === "number" && Number.isFinite(value));

// The `update_records` map for these changes: record id to field name to value,
// the shape the pinned CLI takes (recorded with --dry-run).
export function baseEditUpdate(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 20) throw new Error("多维表格写入只支持 1–20 处修改");
  const update = {}, seen = new Set();
  for (const change of changes) {
    const key = JSON.stringify([change?.record, change?.fieldId]);
    if (typeof change?.record !== "string" || !BASE_RECORD_ID.test(change.record) || typeof change.fieldId !== "string" || !BASE_FIELD_ID.test(change.fieldId) ||
        typeof change.field !== "string" || !change.field || change.field.length > 300 || seen.has(key) || Object.hasOwn(update[change.record] ?? {}, change.field)) {
      throw new Error("多维表格写入的记录或字段无效");
    }
    if (!acceptable(change.before) || !acceptable(change.after)) throw new Error("多维表格写入的值无效");
    seen.add(key);
    (update[change.record] ??= {})[change.field] = change.after;
  }
  if (Object.keys(update).length > 10) throw new Error("一次最多修改 10 条记录");
  return update;
}

// Each changed field that does not hold its confirmed value, as read: `stale`
// when it still holds the value from before the write, `missing` when the record
// is gone.
function compare(changes, read) {
  const differences = [];
  for (const change of changes) {
    const values = read.records.get(change.record), actual = values ? values[change.fieldId] ?? null : null;
    if (values && same(actual, change.after)) continue;
    differences.push({ record: change.record, field: change.field, fieldId: change.fieldId, expected: change.after, actual,
      ...(!values ? { missing: true } : same(actual, change.before) ? { stale: true } : {}) });
  }
  return differences;
}
const outcome = (differences, ignored = []) => differences.some(item => item.stale) ? "unknown" : differences.length || ignored.length ? "mismatch" : "verified";

export class SaasBaseEdits {
  constructor(provider, { settle = SETTLE_MS, wait = pause } = {}) { Object.assign(this, { provider, settle, wait }); }

  // Plans the one write. The grant is later bound to exactly the request the dry
  // run declares, so a plan that is not these records, fields and values is
  // refused here, before anyone is asked to confirm it.
  async prepare(source, changes) {
    const update = baseEditUpdate(changes);
    const plan = await this.provider.cliWriter.plan(["base", "+record-batch-update", "--base-token", source.baseToken, "--table-id", source.tableId, "--json", JSON.stringify({ update_records: update })]);
    const path = `/open-apis/base/v3/bases/${source.baseToken}/tables/${source.tableId}/records/batch_update`;
    if (plan.family?.id !== "base.records" || plan.destructive || plan.method !== "POST" || plan.path !== path || !plan.body || Object.keys(plan.body).join() !== "update_records" ||
        JSON.stringify(canonical(plan.body.update_records)) !== JSON.stringify(canonical(update))) {
      throw new Error("飞书 CLI 预演出的写入请求与确认内容不一致，未写入");
    }
    return Object.freeze({ source: Object.freeze({ sourceUrl: source.sourceUrl, baseToken: source.baseToken, tableId: source.tableId, principal: source.principal, tenantKey: source.tenantKey }),
      changes: Object.freeze(changes.map(change => Object.freeze({ ...change }))), plan });
  }

  // The changed records as Feishu holds them now, only the changed fields.
  async read(prepared, signal) {
    const { source, changes } = prepared;
    const page = await this.provider.baseRecords.get(source.baseToken, source.tableId, [...new Set(changes.map(change => change.record))],
      { fieldIds: [...new Set(changes.map(change => change.fieldId))], signal });
    return { records: new Map(page.records.map(record => [record.id, record.values])), names: page.names };
  }

  // The changed fields read back, and read again after a wait while any of them
  // still holds its value from before the write.
  async readBack(source, changes, signal) {
    let differences = compare(changes, await this.read({ source, changes }, signal));
    for (const ms of this.settle) {
      if (!differences.some(item => item.stale)) break;
      await this.wait(ms);
      differences = compare(changes, await this.read({ source, changes }, signal));
    }
    return differences;
  }

  // The same fields read once more, when the person asks, for a write whose
  // read-back did not settle it. Nothing is written.
  async recheck(source, changes, { ignored = [], signal } = {}) {
    const identity = await this.provider.documentIdentity({ signal, fresh: true });
    if (identity.principal !== source.principal || identity.tenantKey !== source.tenantKey) throw new Error("飞书身份已变化，未核对");
    const differences = compare(changes, await this.read({ source, changes }, signal));
    return { state: outcome(differences, ignored), differences };
  }

  async apply(prepared, beforeDispatch, { signal } = {}) {
    const { source, changes, plan } = prepared;
    const identity = await this.provider.documentIdentity({ signal, fresh: true });
    if (identity.principal !== source.principal || identity.tenantKey !== source.tenantKey) throw new Error("飞书身份已变化，未写入");
    const before = await this.read(prepared, signal);
    for (const change of changes) {
      const values = before.records.get(change.record);
      if (!values) throw new Error(`记录 ${change.record} 已经不在这张表里，未写入`);
      if (before.names[change.fieldId] !== change.field) throw new Error(`字段「${change.field}」已被改名或删除，未写入`);
      if (!same(values[change.fieldId], change.before)) throw new Error(`记录 ${change.record} 的「${change.field}」在确认之后被改过（现在是 ${shown(values[change.fieldId])}），未写入`);
    }
    let dispatched = false, receipt;
    try {
      receipt = await this.provider.cliWriter.run(plan, async () => { await beforeDispatch(); dispatched = true; });
    } catch (error) {
      if (!dispatched) throw error;
      throw Object.assign(new Error(`写入结果不确定：可能已写入、部分写入或未写入，请到飞书核查多维表格；不会自动重试。（${String(error?.message ?? error).slice(0, 200)}）`), { unknown: true, cause: error });
    }
    const ignored = Array.isArray(receipt?.ignored_fields) ? receipt.ignored_fields.map(item => String(typeof item === "object" ? item?.field ?? item?.name ?? JSON.stringify(item) : item).slice(0, 100)).slice(0, 20) : [];
    let differences;
    try { differences = await this.readBack(source, changes, signal); }
    catch (error) {
      throw Object.assign(new Error("飞书已回执写入，但写后读回没有完成，无法逐条核对；请到飞书核查多维表格，不会自动重试。"), { unknown: true, cause: error });
    }
    return { state: outcome(differences, ignored), differences, ignored };
  }
}
