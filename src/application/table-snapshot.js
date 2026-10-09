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
import { SLICE_LIMITS, parseSlice, sliceId } from "./table-slice.js";

const plain = (value) => value === null || value === undefined ? ""
  : typeof value === "string" ? value
  : typeof value === "number" ? (Number.isFinite(value) ? String(value) : "")
  : typeof value === "boolean" ? String(value) : "";

// What a field means, not what it is called. Feishu names two dozen field
// types; a page only has to tell a few of them apart, and a page that branches
// on the raw name breaks the day somebody adds a field kind.
//
// The names `base +field-list` gives are recorded live, one field of each, in
// test/fixtures/base-field-shapes.json. Until 10-06 several were missing or
// meant something else here: a created or updated time was text (its raw ISO
// string on the page), a creator was text, an auto number was a number (with
// no value, an empty column in every total), a select taking several options
// showed only its first, and a Base `link` -- a link to records in another
// table, given only as their ids -- was taken for a web address.
const KINDS = new Map(Object.entries({
  number: "number", currency: "number", progress: "number", rating: "number",
  checkbox: "boolean",
  date: "date", date_time: "date", datetime: "date", created_time: "date", modified_time: "date", created_at: "date", updated_at: "date",
  single_select: "option", select: "option",
  multi_select: "options",
  user: "people", created_user: "people", modified_user: "people", group: "people", person: "people",
  created_by: "people", updated_by: "people", group_chat: "people",
  url: "link",
  link: "options", duplex_link: "options",
}));
export const fieldKind = (type, field = null) => {
  const kind = KINDS.get(String(type ?? "")) ?? "text";
  if (kind === "option" && field?.multiple === true) return "options";
  // A text field shown as a web address (its style says so) is one.
  if (kind === "text" && field?.style === "url") return "link";
  return kind;
};
const RELATION = new Set(["link", "duplex_link"]);
// The records a link points to, by id. Recorded live: `[{ "id": "rec…" }]`.
const linkedIds = (value) => list(value).map((item) => typeof item === "string" ? item : item?.id ?? item?.record_id)
  .filter((id) => typeof id === "string" && /^rec[A-Za-z0-9]{1,64}$/.test(id));
// How many linked records are named, at most, in one read: a hundred per call.
const LINK_NAMES = 2000;
// What this reader makes of a table. A refresh compares what it read with what
// the read before it made (site-refresh.js); a read by a reader that makes
// something else of the same table is not the table moving.
export const READER = 2;

const first = (value) => Array.isArray(value) ? value[0] : value;
const list = (value) => (Array.isArray(value) ? value : [value]).filter((item) => item !== null && item !== undefined);
const label = (item) => typeof item === "string" ? item
  : typeof item === "number" || typeof item === "boolean" ? String(item)
  : item && typeof item === "object" ? String(item.text ?? item.name ?? item.en_name ?? item.file_name ?? item.value ?? "") : "";

// A date as milliseconds. The open API sends milliseconds; `base +record-list`
// sends an ISO 8601 string with its offset -- "2026-11-17T08:00:00.000+08:00"
// for a field shown yyyy/MM/dd (measured live, test/fixtures/base-record-shapes.json).
// Until 10-06 only the first was read, and every date column of a real table
// was empty on its site. A string in any other shape is no date rather than a
// guess: one without an offset would be read in this computer's time zone.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
function dateValue(value) {
  const raw = first(value);
  const said = plain(raw).trim();
  const at = typeof raw === "number" ? raw : /^\d{1,16}$/.test(said) ? Number(said) : ISO_DATE.test(said) ? Date.parse(said) : NaN;
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

// A cell as every page sees it: the text to show, the kind to show it as, and
// the value behind it where there is one. Uniform on purpose -- a page that has
// to branch on the cell shape is a page that will break on a field somebody
// adds later. The text comes from the deployment's own renderer, because only
// it knows what a person, an attachment or a formula result looks like there;
// without one, only scalars can be rendered and that is said rather than
// silently shown as an empty column.
//
// `names`: for a link to records, their names by id (readBaseSlice).
function cellFor(field, value, render, names = null) {
  const kind = fieldKind(field?.type, field);
  if (RELATION.has(field?.type)) {
    const ids = linkedIds(value);
    const items = ids.map((id) => names?.get(id)).filter(Boolean);
    // Named by the deployment where it gives names; otherwise counted, never "（未展开内容）".
    if (!ids.length) items.push(...list(value).map(label).filter(Boolean));
    const unnamed = ids.length - items.length;
    if (unnamed > 0) items.push(items.length ? `另 ${unnamed} 条` : `${unnamed} 条记录`);
    return { text: items.join("、"), kind: "options", items };
  }
  const text = (render ? render(value, field) : plain(value)).trim();
  if (kind === "number") {
    // An empty cell is no number: read as 0 it was counted in every total.
    const said = plain(first(value)).trim();
    const numeric = typeof value === "number" ? value : said === "" ? NaN : Number(said);
    const style = field?.style === "currency" ? "currency" : field?.percent === true ? "percent" : null;
    return { text, kind, value: Number.isFinite(numeric) ? numeric : null, ...(style ? { style } : {}) };
  }
  if (kind === "boolean") return { text, kind, value: value === true };
  if (kind === "date") return { text, kind, value: dateValue(value), ...(field?.time === true ? { style: "datetime" } : {}) };
  if (kind === "option") {
    // Several options where the field did not say it takes several: all of them.
    const all = list(value).map(label).filter(Boolean);
    if (all.length > 1) return { text, kind: "options", items: all };
    return { text, kind, value: all[0] || text };
  }
  if (kind === "options") return { text, kind, items: list(value).map(label).filter(Boolean) };
  if (kind === "people") return { text, kind, items: list(value).map(label).filter(Boolean) };
  if (kind === "link") {
    const item = first(value);
    let href = item && typeof item === "object" ? String(item.link ?? item.url ?? "") : plain(item).trim();
    let shown = text;
    // A Base address field holds Markdown: "[北极星官网](https://…)", a bare
    // address as "[https://…](https://…)" (recorded live).
    const markdown = /^\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/i.exec(href);
    if (markdown) { href = markdown[2]; shown = markdown[1].trim() || href; }
    return { text: shown || href, kind, href: /^https?:\/\//i.test(href) ? href : null };
  }
  return { text, kind, value: text };
}

// What later reads compare. Covers the fields, the rows and every shown value:
// any change to what a visitor would see changes it, and nothing else does.
// A field's name and kind are seen too -- as the column's heading and in how
// its cells are drawn. Until docs/sites-phase1.md §1.7 only its id was taken,
// and a renamed column was no change at all; harmless while every refresh sent
// everything, not once a refresh sends only what changed.
export function snapshotDigest({ fields, rows }) {
  const digest = createHash("sha256");
  digest.update(fields.map((field) => `${field.id}\u0003${field.name ?? ""}\u0003${field.kind ?? ""}`).join("\u0000"));
  for (const row of rows) {
    digest.update(`\u0001${row.id}`);
    for (const field of fields) digest.update(`\u0002${row.values[field.id]?.text ?? ""}`);
  }
  return digest.digest("hex");
}

export const snapshotChanged = (before, after) => (before?.digest ?? null) !== (after?.digest ?? null);

// What one contract hands a page: its schema -- the site's title, the columns
// -- and the snapshot's digest. Whether the server has to be sent it again is
// decided on this, not the digest alone: the site renamed changes the title a
// page shows and no value in any row.
//
// Nor the digest's text alone: a page draws a date, an amount and a link from
// what is behind the text, and that can change while the text does not -- a
// link given a new address, or this reader learning to read a shape it used
// to leave empty (Feishu's ISO dates, 10-06): every published site then kept
// its empty dates, because nothing it was given had changed by its text. So
// every cell counts here. The digest itself stays on the text: an hourly read
// that finds it changed while the table says it did not move marks the site
// as never to be skipped (site-refresh.js), and a reader learning something
// is not the table moving.
const sha = (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex").slice(0, 32);
export const contractKey = (schema, snapshot) =>
  `${sha(schema)}:${snapshot?.digest ?? ""}:${sha([snapshot?.truncated ?? null, snapshot?.rows ?? null])}`;

const megabytes = (bytes) => bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

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
  // In bytes as written and sent: counted in characters, a table in Chinese
  // passed here at three times the size the server then refused.
  const size = Buffer.byteLength(JSON.stringify(snapshot));
  if (size > SLICE_LIMITS.bytes) throw new Error(`这个切片取出来有 ${megabytes(size)}，超过了 ${megabytes(SLICE_LIMITS.bytes)}；请减少字段或行数`);
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
  // Laid out as the table lays them out, whatever order the slice was picked
  // in -- which, until 10-06, was whatever order the field list came in.
  const fields = (await fieldOrder(slice, records, signal)).map((id) => {
    const field = byId.get(id);
    return { id, name: field.name, type: field.type, kind: fieldKind(field.type, field),
      ...(field.style ? { style: field.style } : {}), writable: slice.writable.includes(id) };
  });
  // How each cell is made: the field as the page sees it, and what the
  // deployment said of it besides (a percentage, a time, several options).
  const readAs = new Map(fields.map((field) => {
    const { multiple, percent, time } = byId.get(field.id);
    return [field.id, { ...field, multiple, percent, time }];
  }));
  // The tables a link in the slice points into, by field.
  const targets = new Map(slice.fields.map((id) => [id, byId.get(id)]).filter(([, field]) => RELATION.has(field.type) && field.linkTable).map(([id, field]) => [id, field.linkTable]));
  // Taken before the records, so a change made while they are read leaves the
  // next probe looking at a different table and that read is made again. With
  // it, the tables this one shows from: a link's names live in another table,
  // and a formula may read any (docs/feishu-base.md).
  const others = slice.fields.some((id) => ["formula", "lookup"].includes(byId.get(id).type)) ? "all" : targets.size ? [...new Set(targets.values())] : null;
  const state = await tableState(slice, records, signal, others);
  const probe = probeOf(state);
  const rows = [];
  // A row added or removed above while the pages are read moves every row
  // after it by one: the same row at the end of one page and the start of the
  // next is kept once. (The probe taken first makes the next refresh read it
  // all again.)
  const seen = new Set();
  let truncated = false;
  // The first page alone -- most tables end inside it -- then a few at a time.
  let offset = 0, width = 1;
  for (let ended = false; !ended;) {
    signal?.throwIfAborted();
    const wave = [];
    // No page past the end the table gave, beyond the one that says so: it
    // may have grown since, and that page's `more` is what is believed.
    for (let at = offset; wave.length < width && at < slice.rows && (!wave.length || state?.count === null || state?.count === undefined || at < state.count); at += SLICE_LIMITS.pageRows) {
      const limit = Math.min(SLICE_LIMITS.pageRows, slice.rows - at);
      wave.push({ at, limit, answer: records.list(slice.token, slice.tableId, { offset: at, limit, signal }) });
    }
    if (!wave.length) break;
    // Every page of the wave settles before one failure is reported, so none is left unheard.
    const settled = await Promise.allSettled(wave.map((page) => page.answer));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    width = SLICE_LIMITS.pagesAtOnce;
    ended = true;
    for (const [index, { at, limit }] of wave.entries()) {
      const answer = settled[index].value;
      for (const record of answer.records) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        // Field order differs from one response to the next (seen live), so cells
        // are taken by field id and laid out in the slice's own order.
        // A link's cell is made once its records are named, below.
        rows.push({ id: record.id,
          values: Object.fromEntries(fields.map((field) => [field.id, targets.has(field.id) ? record.values[field.id] ?? null : cellFor(readAs.get(field.id), record.values[field.id], renderCell)])) });
      }
      if (!answer.more) break;
      // A page that came back empty with more to come would loop forever.
      if (!answer.records.length) { truncated = true; break; }
      offset = at + answer.records.length;
      // Short with more to come: the pages asked for after it started from the
      // wrong place, so they are dropped and reading goes on one at a time.
      if (answer.records.length < limit) { width = 1; ended = false; break; }
      if (offset >= slice.rows) { truncated = true; break; }
      if (index === wave.length - 1) ended = false;
    }
  }
  if (targets.size) {
    const names = await linkNames(slice, records, targets, rows, { signal, renderCell });
    for (const row of rows) for (const [id, table] of targets) row.values[id] = cellFor(readAs.get(id), row.values[id], renderCell, names.get(table));
  }
  const source = { kind: "base", token: slice.token, tableId: slice.tableId, viewId: slice.viewId, title: String(title ?? "").slice(0, 120) };
  return { ...finish(slice, source, fields, rows, { truncated, readAt: now() }), probe };
}

// The slice's fields in the table's own order (the deployment's `fieldOrder`),
// any it does not place after them as the slice has them. Without an order, or
// when it cannot be read, the slice's.
async function fieldOrder(slice, records, signal) {
  if (typeof records?.fieldOrder !== "function") return slice.fields;
  let order;
  try { order = await records.fieldOrder(slice.token, slice.tableId, signal); }
  catch (error) { if (signal?.aborted) throw error; return slice.fields; }
  const rank = new Map((Array.isArray(order) ? order : []).map((id, index) => [id, index]));
  const at = (id) => rank.get(id) ?? rank.size + slice.fields.indexOf(id);
  return [...slice.fields].sort((a, b) => at(a) - at(b));
}

// The names of the records the slice's links point to: each target table's
// primary field, read by id a hundred at a time (`base +record-get`, a read
// the control plane admits by name), the first LINK_NAMES of them. A table the
// person cannot read, or a deployment that cannot say, leaves them counted.
async function linkNames(slice, records, targets, rows, { signal, renderCell }) {
  const named = new Map();
  if (typeof records?.primaryField !== "function" || typeof records?.get !== "function") return named;
  let budget = LINK_NAMES;
  for (const table of new Set(targets.values())) {
    const ids = new Set();
    for (const row of rows) for (const [id, target] of targets) if (target === table) for (const linked of linkedIds(row.values[id])) ids.add(linked);
    const wanted = [...ids].slice(0, budget);
    budget -= wanted.length;
    const names = new Map();
    named.set(table, names);
    if (!wanted.length) continue;
    try {
      const primary = await records.primaryField(slice.token, table, signal);
      for (let at = 0; at < wanted.length; at += 100 * SLICE_LIMITS.pagesAtOnce) {
        const batches = [];
        for (let from = at; from < Math.min(wanted.length, at + 100 * SLICE_LIMITS.pagesAtOnce); from += 100) {
          batches.push(records.get(slice.token, table, wanted.slice(from, from + 100), { fieldIds: [primary], signal }));
        }
        for (const page of await Promise.all(batches)) {
          for (const record of page.records) {
            const name = (renderCell ? renderCell(record.values[primary]) : plain(record.values[primary])).trim();
            if (name) names.set(record.id, name);
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      names.clear();
    }
  }
  return named;
}

// Whether a Base table could have changed, without reading it: its revision
// and its row count, in one call. Null where the deployment's part cannot say,
// or says something that is not a number -- then every refresh reads in full,
// which is what happened before there was a probe.
//
// Not proof of no change: a formula or a lookup into another table can move
// with neither (the refresh still reads in full now and then for that), and
// the revision is returned a couple of seconds late (measured live, see the
// header) -- which is why it is taken before a read, never after.
//
// `probe`: the one the last read took. The other tables it named are asked
// about again, so the two say the same when nothing moved.
export async function probeBaseSlice(input, records, { signal, probe = null } = {}) {
  const slice = parseSlice(input);
  if (slice.kind !== "base") return null;
  const others = probeTables(probe);
  return probeOf(await tableState(slice, records, signal, others.length ? others : null));
}
async function tableState(slice, records, signal, others = null) {
  if (typeof records?.tableState !== "function") return null;
  const state = await records.tableState(slice.token, slice.tableId, { signal, ...(others ? { others } : {}) });
  const number = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { rev: number(state?.rev), count: number(state?.count),
    ...(others ? { others: Object.fromEntries(Object.entries(state?.others ?? {}).map(([id, rev]) => [id, number(rev)])), asked: others } : {}) };
}
// "rev:count", then "|table:rev" for each other table, in order. Nothing to
// compare -- no probe -- where any of them cannot be said.
function probeOf(state) {
  if (state?.rev === null || state?.rev === undefined || state?.count === null || state?.count === undefined) return null;
  if (!state.asked) return `${state.rev}:${state.count}`;
  if (Array.isArray(state.asked) && state.asked.some((id) => state.others[id] === null || state.others[id] === undefined)) return null;
  const others = Object.entries(state.others).sort(([a], [b]) => (a < b ? -1 : 1));
  if (others.some(([, rev]) => rev === null)) return null;
  return `${state.rev}:${state.count}${others.map(([id, rev]) => `|${id}:${rev}`).join("")}`;
}
const probeTables = (probe) => typeof probe === "string" ? [...probe.matchAll(/\|(tbl[A-Za-z0-9]{1,64}):/g)].map((match) => match[1]) : [];

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
