import { createHash } from "node:crypto";
import { successfulUserPayload } from "./document-errors.js";
import { baseCellText, baseReference } from "./base-reader.js";

// A Feishu Base (多维表格) table as a person reviews it and as a write to it is
// checked: typed values keyed by field id, through the pinned CLI's own `base`
// shortcuts. The knowledge copy keeps its text projection (base-reader.js); this
// is the typed side.
//
// Recorded live from a test Base: a field list names each field's type as a
// string, with its style. A record list, and records read by id, come back as
// columns -- `fields`, `field_id_list` and `field_type_list` beside
// `record_id_list` and `data` -- one row per record in the order of that
// response's own field list, which is not the field list's order. Text arrives
// as a string and a number as a number. Records by id are a POST (`batch_get`),
// admitted by name on the control plane (cli-read-contract.js); the rest are GETs.

const TABLE_ID = /^tbl[A-Za-z0-9]{1,64}$/;
export const BASE_FIELD_ID = /^fld[A-Za-z0-9]{1,64}$/;
export const BASE_RECORD_ID = /^rec[A-Za-z0-9]{1,64}$/;
// The CLI's own range for --limit.
const PAGE_LIMIT = 200;
export const BASE_PREVIEW = Object.freeze({ records: 20, fields: 30 });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = () => { throw new Error("飞书多维表格响应缺少可靠的字段、记录或标识；未展示可能错位的数据。"); };

// Which fields a reviewed edit may change: plain text, and plain or currency
// numbers. Every other field is shown, and marked, but not offered for editing
// until its value shape has been recorded.
export function baseFieldWritable(field) {
  const style = field?.style ?? "plain";
  return field?.type === "text" && style === "plain" || field?.type === "number" && ["plain", "currency"].includes(style);
}

function columns(data) {
  const { fields, field_id_list: fieldIds, field_type_list: types, record_id_list: recordIds, data: rows, has_more: more } = data ?? {};
  if (![fields, fieldIds, types, recordIds, rows].every(Array.isArray) || typeof more !== "boolean") invalid();
  if (fields.length !== fieldIds.length || types.length !== fieldIds.length || rows.length !== recordIds.length || recordIds.length > PAGE_LIMIT) invalid();
  if (fieldIds.some(id => typeof id !== "string" || !BASE_FIELD_ID.test(id)) || new Set(fieldIds).size !== fieldIds.length) invalid();
  if (recordIds.some(id => typeof id !== "string" || !BASE_RECORD_ID.test(id)) || new Set(recordIds).size !== recordIds.length) invalid();
  if (fields.some(name => typeof name !== "string" || !name) || types.some(type => typeof type !== "string")) invalid();
  const records = recordIds.map((id, i) => {
    if (!Array.isArray(rows[i]) || rows[i].length !== fieldIds.length) invalid();
    return { id, values: Object.fromEntries(fieldIds.map((fieldId, j) => [fieldId, rows[i][j] ?? null])) };
  });
  // Each field's name as this response gives it, so a write can tell a field renamed since it was confirmed.
  return { records, fieldIds, names: Object.fromEntries(fieldIds.map((id, i) => [id, fields[i]])), more };
}

// A cell as shown and as compared: its text for the grid, its typed value where
// the field is one an edit may change, and a mark where it is not.
function cell(field, value) {
  const typed = field.type === "text" ? value === null || typeof value === "string"
    : field.type === "number" ? value === null || typeof value === "number" && Number.isFinite(value) : false;
  return { fieldId: field.id, text: baseCellText(value), ...(typed && baseFieldWritable(field) ? { value } : { unsupported: true }) };
}

export class SaasBaseRecords {
  constructor(provider) { this.provider = provider; }

  async call(args, signal) {
    signal?.throwIfAborted();
    const result = await this.provider.invoke(["base", ...args, "--as", "user", "--format", "json"], { signal, timeoutMs: 30_000, maxOutputBytes: 1_048_576 });
    signal?.throwIfAborted();
    return successfulUserPayload(result).data;
  }

  async tables(baseToken, signal) {
    const data = await this.call(["+table-list", "--base-token", baseToken], signal);
    if (!Array.isArray(data?.tables) || !data.tables.length || data.tables.length > 100) invalid();
    const seen = new Set();
    return data.tables.map(table => {
      if (typeof table?.id !== "string" || !TABLE_ID.test(table.id) || seen.has(table.id) || typeof table.name !== "string" || !table.name || table.name.length > 300) invalid();
      seen.add(table.id);
      return { id: table.id, name: table.name };
    });
  }

  async fields(baseToken, tableId, signal) {
    const data = await this.call(["+field-list", "--base-token", baseToken, "--table-id", tableId, "--limit", String(PAGE_LIMIT)], signal);
    if (!Array.isArray(data?.fields) || !data.fields.length || data.fields.length > PAGE_LIMIT) invalid();
    const seen = new Set();
    return data.fields.map(field => {
      if (typeof field?.id !== "string" || !BASE_FIELD_ID.test(field.id) || seen.has(field.id) || typeof field.name !== "string" || !field.name || field.name.length > 300 ||
          typeof field.type !== "string" || !/^[a-z_]{1,40}$/.test(field.type)) invalid();
      seen.add(field.id);
      const style = typeof field.style?.type === "string" && /^[a-z_]{1,40}$/.test(field.style.type) ? field.style.type : null;
      return { id: field.id, name: field.name, type: field.type, ...(style ? { style } : {}) };
    });
  }

  async list(baseToken, tableId, { offset = 0, limit = BASE_PREVIEW.records, signal } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new Error("多维表格读取范围无效。");
    return columns(await this.call(["+record-list", "--base-token", baseToken, "--table-id", tableId, "--offset", String(offset), "--limit", String(limit)], signal));
  }

  // Records by id, optionally only some of their fields. Only records that were
  // asked for may come back; one that no longer exists is simply absent.
  async get(baseToken, tableId, recordIds, { fieldIds, signal } = {}) {
    if (!Array.isArray(recordIds) || !recordIds.length || recordIds.length > 100 || new Set(recordIds).size !== recordIds.length ||
        recordIds.some(id => typeof id !== "string" || !BASE_RECORD_ID.test(id))) throw new Error("多维表格记录标识无效。");
    if (fieldIds !== undefined && (!Array.isArray(fieldIds) || !fieldIds.length || fieldIds.length > 50 || fieldIds.some(id => typeof id !== "string" || !BASE_FIELD_ID.test(id)))) {
      throw new Error("多维表格字段标识无效。");
    }
    const page = columns(await this.call(["+record-get", "--base-token", baseToken, "--table-id", tableId,
      ...recordIds.flatMap(id => ["--record-id", id]), ...(fieldIds ?? []).flatMap(id => ["--field-id", id])], signal));
    if (page.records.some(record => !recordIds.includes(record.id)) || fieldIds?.some(id => !page.fieldIds.includes(id))) invalid();
    return page;
  }

  // One page of one table, typed, between two identity checks. A Base has no
  // version a write could be conditioned on (its `rev` is read with a lag), so the
  // page's digest stands for its content: any change to what was read changes it.
  async snapshot(reference, { tableId, offset = 0, limit = BASE_PREVIEW.records, signal } = {}) {
    if (typeof reference === "string" && /^https:\/\/[^/]+\/wiki\//u.test(reference)) throw new Error("知识库里的多维表格链接暂不支持，请打开多维表格本身的链接。");
    const parsed = baseReference(reference);
    if (tableId !== undefined && (typeof tableId !== "string" || !TABLE_ID.test(tableId))) throw new Error("多维表格数据表标识无效。");
    const identity = await this.provider.documentIdentity({ signal });
    if (!identity.tenantKey || !identity.principal) throw new Error("多维表格读取需要已核验的企业用户身份。");
    const tables = await this.tables(parsed.appToken, signal);
    const wanted = tableId ?? parsed.tableId;
    const table = wanted ? tables.find(item => item.id === wanted) : tables[0];
    if (!table) throw new Error("未找到这张数据表。");
    const fields = await this.fields(parsed.appToken, table.id, signal);
    const page = await this.list(parsed.appToken, table.id, { offset, limit, signal });
    const current = await this.provider.documentIdentity({ signal });
    if (current.principal !== identity.principal || current.tenantKey !== identity.tenantKey) throw new Error("读取期间飞书身份已变化，请重新读取。");
    const byId = new Map(fields.map(field => [field.id, field]));
    if (page.fieldIds.some(id => !byId.has(id))) invalid();
    // Columns in the order the records came in: Feishu's field list does not keep one order from one call to the next (seen live).
    const shown = page.fieldIds.map(id => byId.get(id)).slice(0, BASE_PREVIEW.fields);
    const records = page.records.map(record => ({ id: record.id, cells: shown.map(field => cell(field, record.values[field.id])) }));
    const snapshot = { kind: "feishu-base", providerId: this.provider.id, baseToken: parsed.appToken, tableId: table.id, resourceId: `${parsed.appToken}:${table.id}`,
      sourceUrl: `${parsed.url.split("?")[0]}?table=${table.id}`, title: `飞书多维表格 · ${table.name}`, tables,
      fields: shown.map(field => ({ ...field, writable: baseFieldWritable(field) })), records, offset, limit, more: page.more,
      truncated: shown.length < page.fieldIds.length };
    // The digest leaves column order out, since Feishu does not hold it steady; records keep theirs, which is what the page is.
    const byColumn = (a, b) => ((a.id ?? a.fieldId) < (b.id ?? b.fieldId) ? -1 : 1);
    const digest = hash({ ...snapshot, fields: [...snapshot.fields].sort(byColumn), records: records.map(record => ({ id: record.id, cells: [...record.cells].sort(byColumn) })) });
    return { ...snapshot, sourceRevision: digest.slice(0, 16), contentHash: digest, identity: current };
  }
}
