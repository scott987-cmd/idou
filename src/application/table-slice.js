// What part of a Feishu table a site is allowed to show: the slice.
//
// A site never says "this Base"; it says "these fields, of this table, at most
// this many rows, refreshed no faster than this". Everything downstream -- the
// read, the cache key, the change probe, the permission check, the write cap --
// is derived from this one object, so there is a single place that decides how
// much of somebody's table can leave the control plane.
//
// The limits are set for a large tenant, not for one person's demo: hundreds of
// sites, each polled on its own schedule against one Feishu cluster. A slice
// that would read more than `rows` rows is truncated rather than allowed to
// grow without bound, one upstream page is the CLI's own maximum, and the
// refresh floor keeps a careless site from turning into a load generator. None
// of these are per-viewer: a slice is read once and shared (see table-snapshot).
import { createHash } from "node:crypto";

export const SLICE_LIMITS = Object.freeze({
  fields: 60,
  rows: 5000,
  // One upstream page. `base +record-list --limit` accepts at most this.
  pageRows: 200,
  // A snapshot bigger than this is refused rather than written or served.
  bytes: 4 * 1024 * 1024,
  minRefreshSeconds: 15,
  maxRefreshSeconds: 24 * 60 * 60,
});

const BASE_TOKEN = /^[A-Za-z0-9]{10,64}$/;
const TABLE_ID = /^tbl[A-Za-z0-9]{1,64}$/;
const VIEW_ID = /^vew[A-Za-z0-9]{1,64}$/;
const FIELD_ID = /^fld[A-Za-z0-9]{1,64}$/;
const SHEET_ID = /^[A-Za-z0-9_-]{1,64}$/;
// A spreadsheet column is named by its header text, not by an id, so the slice
// carries the column letters it read and the schema carries the headers.
const COLUMN = /^[A-Z]{1,3}$/;

const fail = (message) => { throw new Error(message); };
const uniqueStrings = (value, pattern, cap, what) => {
  if (!Array.isArray(value) || !value.length || value.length > cap) fail(what);
  if (value.some((item) => typeof item !== "string" || !pattern.test(item))) fail(what);
  if (new Set(value).size !== value.length) fail(what);
  return [...value];
};

// A slice as it is stored and as everything else reads it. Throws with a
// message a person can act on; never returns a partly valid object.
export function parseSlice(input) {
  const kind = input?.kind;
  if (kind !== "base" && kind !== "sheet") fail("数据切片需要指明是多维表格还是电子表格");
  const token = input?.token;
  if (typeof token !== "string" || !BASE_TOKEN.test(token)) fail("表格标识无效");
  const rows = Number(input?.rows ?? SLICE_LIMITS.rows);
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > SLICE_LIMITS.rows) fail(`行数上限要在 1 到 ${SLICE_LIMITS.rows} 之间`);
  const refreshSeconds = Number(input?.refreshSeconds ?? 60);
  if (!Number.isSafeInteger(refreshSeconds) || refreshSeconds < SLICE_LIMITS.minRefreshSeconds || refreshSeconds > SLICE_LIMITS.maxRefreshSeconds) {
    fail(`刷新间隔要在 ${SLICE_LIMITS.minRefreshSeconds} 到 ${SLICE_LIMITS.maxRefreshSeconds} 秒之间`);
  }
  const common = { kind, token, rows, refreshSeconds };
  const slice = kind === "base" ? baseSlice(input, common) : sheetSlice(input, common);
  // Writable columns are a cap the site declares, never a grant: a field that
  // is not shown cannot be written either, and Feishu still decides whether
  // this visitor may write at all (docs/table-driven-sites.md, 2.6).
  // An empty list is an explicit "nothing may be written", and re-parsing an
  // already parsed slice has to mean the same thing as parsing the input did.
  const writable = !input?.writable?.length ? []
    : uniqueStrings(input.writable, kind === "base" ? FIELD_ID : COLUMN, SLICE_LIMITS.fields, "可写字段无效");
  const shown = new Set(kind === "base" ? slice.fields : slice.columns);
  if (writable.some((id) => !shown.has(id))) fail("可写字段必须先在展示字段里");
  return Object.freeze({ ...slice, writable: Object.freeze(writable) });
}

function baseSlice(input, common) {
  const tableId = input?.tableId;
  if (typeof tableId !== "string" || !TABLE_ID.test(tableId)) fail("数据表标识无效");
  const viewId = input?.viewId ?? null;
  if (viewId !== null && (typeof viewId !== "string" || !VIEW_ID.test(viewId))) fail("视图标识无效");
  const fields = uniqueStrings(input?.fields, FIELD_ID, SLICE_LIMITS.fields, `展示字段要有 1 到 ${SLICE_LIMITS.fields} 个，且不重复`);
  return { ...common, tableId, viewId, fields: Object.freeze(fields) };
}

function sheetSlice(input, common) {
  // A spreadsheet is read by link, not by token (the reader takes a reference),
  // so the slice keeps the origin it was pasted from. It is not part of the
  // slice's identity: the same table reached through another mirror of the same
  // deployment is the same table.
  const origin = input?.origin ?? null;
  if (origin !== null && !/^https:\/\/[A-Za-z0-9.-]{1,255}(?::\d{1,5})?$/.test(String(origin))) fail("表格来源地址无效");
  const sheetId = input?.sheetId;
  if (typeof sheetId !== "string" || !SHEET_ID.test(sheetId)) fail("工作表标识无效");
  const headerRow = Number(input?.headerRow ?? 1);
  if (!Number.isSafeInteger(headerRow) || headerRow < 1 || headerRow > 1000) fail("表头所在行要在 1 到 1000 之间");
  const columns = uniqueStrings(input?.columns, COLUMN, SLICE_LIMITS.fields, `展示列要有 1 到 ${SLICE_LIMITS.fields} 列，且不重复`);
  return { ...common, sheetId, headerRow, origin, columns: Object.freeze(columns) };
}

// The slice's identity: same definition, same id, on any machine and after any
// restart. Cache entries, probes and site records are keyed by it, so two sites
// that ask for exactly the same data share one read instead of two.
export function sliceId(slice) {
  const parsed = parseSlice(slice);
  const canonical = parsed.kind === "base"
    ? [parsed.kind, parsed.token, parsed.tableId, parsed.viewId ?? "", parsed.fields.join(","), parsed.rows]
    : [parsed.kind, parsed.token, parsed.sheetId, parsed.headerRow, parsed.columns.join(","), parsed.rows];
  // The refresh interval and the writable cap are not part of the identity:
  // they change how often it is read and what may be written, not what is read.
  return createHash("sha256").update(canonical.join("\u0000")).digest("hex").slice(0, 32);
}

// How many upstream pages one read of this slice may take, so a table that
// keeps growing cannot turn one site into an unbounded scan.
export const slicePages = (slice) => Math.ceil(parseSlice(slice).rows / SLICE_LIMITS.pageRows);

// What the person is agreeing to, in words, for the confirmation card. Built
// here rather than in the renderer so the card and the enforcement cannot drift.
export function describeSlice(slice, { tableName = "", fieldNames = new Map() } = {}) {
  const parsed = parseSlice(slice);
  const names = parsed.kind === "base" ? parsed.fields.map((id) => fieldNames.get?.(id) ?? id) : parsed.columns;
  const every = parsed.refreshSeconds % 60 === 0 ? `${parsed.refreshSeconds / 60} 分钟` : `${parsed.refreshSeconds} 秒`;
  return {
    source: parsed.kind === "base" ? `多维表格${tableName ? ` · ${tableName}` : ""}` : `电子表格${tableName ? ` · ${tableName}` : ""}`,
    fields: names,
    rows: parsed.rows,
    refresh: `每 ${every}`,
    writable: parsed.writable.length ? parsed.writable.map((id) => fieldNames.get?.(id) ?? id) : [],
  };
}
