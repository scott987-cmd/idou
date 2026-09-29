// One read of one slice: the same shape for a Base and for a spreadsheet, so a
// generated page never learns which kind of table it came from.
//
// Read once, shared by everyone. At tenant scale the thing that breaks first is
// not the page but the customer's Feishu cluster: a thousand people opening the
// same dashboard must cost one read, not a thousand. So a read is keyed by the
// slice (table-slice.js), bounded by its row cap, taken page by page, and
// reduced to a digest that later reads compare against -- the probe that decides
// whether anything has to be re-read at all.
//
// A Base has no version a read could be conditioned on: its `rev` is returned
// with a lag (measured live, docs/feishu-base.md), so the digest of what was
// read stands for the version. A spreadsheet does have one, and a write moves
// it by exactly one, so there the revision is the probe and the digest is the
// check (docs/feishu-sheet-reader.md).
import { createHash } from "node:crypto";
import { SLICE_LIMITS, parseSlice, sliceId, slicePages } from "./table-slice.js";

const plain = (value) => value === null || value === undefined ? ""
  : typeof value === "string" ? value
  : typeof value === "number" ? (Number.isFinite(value) ? String(value) : "")
  : typeof value === "boolean" ? String(value) : "";

// What a field means, not what it is called. Feishu names two dozen field
// types; a page only has to tell a few of them apart, and a page that branches
// on the raw name breaks the day somebody adds a field kind.
const KINDS = new Map(Object.entries({
  number: "number", currency: "number", progress: "number", rating: "number", auto_number: "number",
  checkbox: "boolean",
  date: "date", date_time: "date", datetime: "date", created_time: "date", modified_time: "date",
  single_select: "option", select: "option",
  multi_select: "options",
  user: "people", created_user: "modified_user", modified_user: "people", group: "people", person: "people",
  url: "link", link: "link",
}));
KINDS.set("created_user", "people");
export const fieldKind = (type) => KINDS.get(String(type ?? "")) ?? "text";

const first = (value) => Array.isArray(value) ? value[0] : value;
const list = (value) => (Array.isArray(value) ? value : [value]).filter((item) => item !== null && item !== undefined);
const label = (item) => typeof item === "string" ? item
  : typeof item === "number" || typeof item === "boolean" ? String(item)
  : item && typeof item === "object" ? String(item.text ?? item.name ?? item.en_name ?? item.file_name ?? item.value ?? "") : "";

// A cell as every page sees it: the text to show, the kind to show it as, and
// the value behind it where there is one. Uniform on purpose -- a page that has
// to branch on the cell shape is a page that will break on a field somebody
// adds later. The text comes from the deployment's own renderer, because only
// it knows what a person, an attachment or a formula result looks like there;
// without one, only scalars can be rendered and that is said rather than
// silently shown as an empty column.
function cellFor(field, value, render) {
  const kind = fieldKind(field?.type);
  const text = (render ? render(value, field) : plain(value)).trim();
  if (kind === "number") {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : Number(plain(value));
    return { text, kind, value: Number.isFinite(numeric) ? numeric : null, ...(field?.style === "currency" ? { style: "currency" } : {}) };
  }
  if (kind === "boolean") return { text, kind, value: value === true };
  if (kind === "date") {
    const at = typeof value === "number" ? value : Number(plain(value));
    return { text, kind, value: Number.isSafeInteger(at) && at > 0 ? at : null };
  }
  if (kind === "option") return { text, kind, value: label(first(value)) || text };
  if (kind === "options") return { text, kind, items: list(value).map(label).filter(Boolean) };
  if (kind === "people") return { text, kind, items: list(value).map(label).filter(Boolean) };
  if (kind === "link") {
    const item = first(value);
    const href = item && typeof item === "object" ? String(item.link ?? item.url ?? "") : plain(item);
    return { text: text || href, kind, href: /^https?:\/\//i.test(href) ? href : null };
  }
  return { text, kind, value: text };
}

// What later reads compare. Covers the fields, the rows and every shown value:
// any change to what a visitor would see changes it, and nothing else does.
export function snapshotDigest({ fields, rows }) {
  const digest = createHash("sha256");
  digest.update(fields.map((field) => field.id).join("\u0000"));
  for (const row of rows) {
    digest.update(`\u0001${row.id}`);
    for (const field of fields) digest.update(`\u0002${row.values[field.id]?.text ?? ""}`);
  }
  return digest.digest("hex");
}

export const snapshotChanged = (before, after) => (before?.digest ?? null) !== (after?.digest ?? null);

function finish(slice, source, fields, rows, { truncated, readAt, revision = null }) {
  const snapshot = {
    sliceId: sliceId(slice),
    readAt,
    ...(revision === null ? {} : { revision }),
    truncated,
    rowCount: rows.length,
    rows,
  };
  snapshot.digest = snapshotDigest({ fields, rows });
  const size = JSON.stringify(snapshot).length;
  if (size > SLICE_LIMITS.bytes) throw new Error(`这个切片取出来有 ${Math.round(size / 1024)} KB，超过了 ${Math.round(SLICE_LIMITS.bytes / 1024)} KB；请减少字段或行数`);
  const schema = {
    version: 1,
    sliceId: snapshot.sliceId,
    source,
    fields,
    rows: { limit: slice.rows, truncated },
    refreshSeconds: slice.refreshSeconds,
  };
  return { schema, snapshot };
}

// A Base slice, through the deployment's own `baseRecords` part (never the CLI
// directly -- a private deployment ships a different one).
export async function readBaseSlice(input, records, { signal, now = Date.now, title = "", renderCell = null } = {}) {
  const slice = parseSlice(input);
  if (slice.kind !== "base") throw new Error("这个切片不是多维表格");
  const all = await records.fields(slice.token, slice.tableId, signal);
  const byId = new Map(all.map((field) => [field.id, field]));
  const missing = slice.fields.filter((id) => !byId.has(id));
  // A field the slice names and the table no longer has: said plainly, because
  // the alternative is a site that quietly drops a column.
  if (missing.length) throw new Error(`这张表里已经没有这些字段：${missing.join("、")}；请重新选择切片`);
  const fields = slice.fields.map((id) => {
    const field = byId.get(id);
    return { id, name: field.name, type: field.type, kind: fieldKind(field.type),
      ...(field.style ? { style: field.style } : {}), writable: slice.writable.includes(id) };
  });
  const rows = [];
  let truncated = false;
  for (let page = 0; page < slicePages(slice); page += 1) {
    signal?.throwIfAborted();
    const limit = Math.min(SLICE_LIMITS.pageRows, slice.rows - rows.length);
    if (limit < 1) break;
    const answer = await records.list(slice.token, slice.tableId, { offset: rows.length, limit, signal });
    for (const record of answer.records) {
      // Field order differs from one response to the next (seen live), so cells
      // are taken by field id and laid out in the slice's own order.
      rows.push({ id: record.id,
        values: Object.fromEntries(fields.map((field) => [field.id, cellFor(field, record.values[field.id], renderCell)])) });
    }
    if (!answer.more) break;
    if (rows.length >= slice.rows) { truncated = true; break; }
    // A page that came back short with more to come would loop forever.
    if (!answer.records.length) { truncated = true; break; }
  }
  const source = { kind: "base", token: slice.token, tableId: slice.tableId, viewId: slice.viewId, title: String(title ?? "").slice(0, 120) };
  return finish(slice, source, fields, rows, { truncated, readAt: now() });
}

// A spreadsheet slice: the header row names the columns, the rows below are the
// data, and the whole read is taken under one revision by the reader itself.
export async function readSheetSlice(input, sheets, { signal, now = Date.now, reference = null, title = "" } = {}) {
  const slice = parseSlice(input);
  if (slice.kind !== "sheet") throw new Error("这个切片不是电子表格");
  // The spreadsheet reader takes a reference, not a bare token (measured live:
  // a token alone is refused as an incomplete link), and it insists on being
  // told how far to go -- which the slice already knows. It reads whole rows
  // from A1, so the columns are projected afterwards; the bounds only have to
  // cover the header plus the rows the slice asked for.
  const wanted = Math.min(50_000, slice.headerRow + slice.rows);
  const coverage = { maxRows: wanted, maxCells: Math.min(1_000_000, wanted * 200), maxChars: 500_000 };
  const answer = await sheets.readTable(reference ?? slice.token, { sheetId: slice.sheetId, coverage, signal });
  const letters = Array.isArray(answer?.colIndices) ? answer.colIndices.map((_, index) => columnLetter(index + 1)) : [];
  const column = new Map(letters.map((letter, index) => [letter, index]));
  const missing = slice.columns.filter((letter) => !column.has(letter));
  if (missing.length) throw new Error(`这张工作表里没有这些列：${missing.join("、")}；请重新选择切片`);
  const grid = Array.isArray(answer?.cells) ? answer.cells : [];
  const headerAt = slice.headerRow - 1;
  if (!grid[headerAt]) throw new Error(`第 ${slice.headerRow} 行没有读到表头`);
  const fields = slice.columns.map((letter) => ({
    id: letter,
    name: plain(grid[headerAt][column.get(letter)]?.value) || letter,
    type: "text", kind: "text",
    writable: slice.writable.includes(letter),
  }));
  const body = grid.slice(headerAt + 1);
  const rows = body.slice(0, slice.rows).map((line, index) => ({
    id: String(answer.rowIndices?.[headerAt + 1 + index] ?? headerAt + 2 + index),
    values: Object.fromEntries(fields.map((field) => {
      const raw = line[column.get(field.id)]?.value ?? null;
      // A spreadsheet has no declared types, so a number stays a number and
      // everything else is text -- which is what the grid itself shows.
      return [field.id, cellFor({ ...field, type: typeof raw === "number" ? "number" : "text" }, raw, null)];
    })),
  }));
  const truncated = body.length > slice.rows || answer?.truncated === true;
  const source = { kind: "sheet", token: slice.token, sheetId: slice.sheetId, title: String(title ?? "").slice(0, 120) };
  return finish(slice, source, fields, rows, { truncated, readAt: now(), revision: answer?.sourceRevision ?? null });
}

// A1 column letters, the same way the sheet reader writes them.
export function columnLetter(index) {
  let value = "", left = index;
  while (left > 0) { const rest = (left - 1) % 26; value = String.fromCharCode(65 + rest) + value; left = Math.floor((left - 1) / 26); }
  return value;
}
