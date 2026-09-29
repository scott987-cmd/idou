// Inert draft data only. This module grants no write authority and emits no CLI payload.
// A reviewed Base edit: new values for plain text and number fields of records on
// the page that was read, named by record id and by the field name a person sees.
export function baseEditProposal(text, context) {
  const invalid = () => { throw new Error("多维表格建议无效：仅支持当前这一页里最多 10 条记录、20 处纯文本或数字字段的值替换；不支持其他字段类型、清空、新增或删除记录。"); };
  if (typeof text !== "string" || text.length > 16000 || context?.kind !== "feishu-base" || context.intent !== "propose-edit" || context.truncated ||
      !Array.isArray(context.rows) || !Array.isArray(context.fields)) return invalid();
  let proposal; try { proposal = JSON.parse(text); } catch { return invalid(); }
  if (!proposal || Array.isArray(proposal) || Object.keys(proposal).sort().join(",") !== "changes,kind" || proposal.kind !== "feishu-base-edit" ||
      !Array.isArray(proposal.changes) || !proposal.changes.length || proposal.changes.length > 20) return invalid();
  const fields = new Map(context.fields.map(field => [field.name, field])), rows = new Map(context.rows.map(row => [row.record, row]));
  const seen = new Set(), records = new Set();
  const changes = proposal.changes.map(change => {
    if (!change || Array.isArray(change) || Object.keys(change).sort().join(",") !== "field,record,value" || typeof change.record !== "string" || typeof change.field !== "string") return invalid();
    const field = fields.get(change.field), row = rows.get(change.record), key = JSON.stringify([change.record, change.field]);
    if (!field?.writable || !row || seen.has(key)) return invalid();
    const cell = row.cells.find(item => item.fieldId === field.id);
    if (!cell || cell.unsupported || !Object.hasOwn(cell, "value")) return invalid();
    const typed = field.type === "text" ? typeof change.value === "string" && change.value.length > 0 && change.value.length <= 2000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(change.value)
      : field.type === "number" ? typeof change.value === "number" && Number.isFinite(change.value) && (!Number.isInteger(change.value) || Number.isSafeInteger(change.value)) : false;
    if (!typed || Object.is(cell.value, change.value)) return invalid();
    seen.add(key); records.add(change.record);
    return { record: change.record, field: field.name, value: change.value };
  });
  if (records.size > 10) return invalid();
  return { kind: "feishu-base-edit", changes };
}
