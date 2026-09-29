import { createHash } from "node:crypto";
import { successfulUserPayload } from "./document-errors.js";
import { readSheetLayout, mergeRelated } from "./sheet-layout.js";
import { hostWithin, SAAS_RESOURCE_HOSTS } from "./saas-deployment.js";

const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const integer = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = () => { throw new Error("飞书表格响应缺少可靠的范围、版本或坐标；未展示可能错位的数据。"); };
export function sheetColumn(index) {
  let text = "";
  while (index > 0) { index--; text = String.fromCharCode(65 + index % 26) + text; index = Math.floor(index / 26); }
  return text;
}
function columnIndex(text) { return [...text].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0); }
export function sheetRange(value) {
  if (typeof value !== "string" || value.length > 30) throw new Error("请选择明确的 A1 单元格范围，例如 A1:F20。");
  const m = /^([A-Z]{1,3})([1-9]\d{0,4})(?::([A-Z]{1,3})([1-9]\d{0,4}))?$/.exec(value);
  if (!m) throw new Error("请选择明确的 A1 单元格范围，例如 A1:F20。");
  const left = columnIndex(m[1]), top = Number(m[2]), right = columnIndex(m[3] || m[1]), bottom = Number(m[4] || m[2]);
  if (right < left || bottom < top || right > 200 || bottom > 50000 || bottom - top >= 200 || (right - left + 1) * (bottom - top + 1) > 2000) throw new Error("单次预览最多 200 行、2000 格；请分范围读取，不能据此判断整表已读全。");
  return { left, top, right, bottom, a1: `${sheetColumn(left)}${top}:${sheetColumn(right)}${bottom}` };
}
export function sheetReference(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\\\x00-\x20]/.test(value)) throw new Error("请输入完整的飞书电子表格链接。");
  let url; try { url = new URL(value); } catch { throw new Error("请输入完整的飞书电子表格链接。"); }
  const match = /^\/(sheets|spreadsheets)\/([A-Za-z0-9_-]{8,128})\/?$/.exec(url.pathname), sheetId = url.searchParams.get("sheet");
  if (!match || url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !hostWithin(url.hostname, SAAS_RESOURCE_HOSTS) ||
      url.searchParams.getAll("sheet").length > 1 || sheetId !== null && !id(sheetId)) throw new Error("当前表格阅读器支持 SaaS HTTPS sheets/spreadsheets 链接；Wiki 表格链接尚待接入。");
  url.search = ""; return { token: match[2], url: url.href, sheetId };
}
function revision(value) {
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value))) invalid();
  return String(value);
}
function warning(value) { if (value === undefined || value === null || value === "") return ""; if (typeof value !== "string" || value.length > 4000) invalid(); return value; }

// The largest rectangle from A1 that fits both the caps a single read allows
// and the sheet's own size. Rows are worth more than columns to a reader: a
// table's meaning is in its rows, and a very wide sheet still answers from its
// first columns.
function coveredRange(sheet, { maxRows, maxCells }) {
  const columns = Math.max(1, Math.min(sheet.columns, Math.floor(maxCells / Math.min(maxRows, sheet.rows))));
  const rows = Math.max(1, Math.min(sheet.rows, maxRows, Math.floor(maxCells / columns)));
  return `A1:${sheetColumn(columns)}${rows}`;
}

// The workbook as this read sees it: its revision, its sheets, and the one being
// read. Shared by a single-range read and a whole-table read so both refuse the
// same malformed metadata.
async function loadWorkbook(call, sheetId, parsed) {
    const book = await call("+workbook-info");
    const bookWarning = warning(book?.warning_message); if (bookWarning || book?.has_more === true || book?.truncated === true || !Array.isArray(book?.sheets) || !book.sheets.length || book.sheets.length > 200) invalid();
    const before = revision(book.revision);
    const seen = new Set();
    const sheets = book.sheets.map(row => {
      const title = row.title ?? row.sheet_name;
      if (!id(row.sheet_id) || seen.has(row.sheet_id) || typeof title !== "string" || !title || title.length > 300 || typeof row.is_hidden !== "boolean" ||
          !["sheet", "bitable", "#UNSUPPORTED_TYPE"].includes(row.resource_type)) invalid();
      seen.add(row.sheet_id);
      if (row.resource_type === "sheet" && (!integer(row.row_count, 50000) || !integer(row.column_count, 200))) invalid();
      return { id: row.sheet_id, title, kind: row.resource_type, hidden: row.is_hidden, ...(row.resource_type === "sheet" ? { rows: row.row_count, columns: row.column_count } : {}) };
    });
    const selectedId = sheetId ?? parsed.sheetId, selected = selectedId ? sheets.find(row => row.id === selectedId) : sheets.find(row => row.kind === "sheet" && !row.hidden);
    if (!selected || selected.kind !== "sheet") throw new Error("未找到可读取的网格工作表；多维表格不能按普通单元格读取。");
  return { before, sheets, selected };
}

// One bounded range, validated coordinate by coordinate against what was asked.
async function readRangePage(call, selected, merges, requested, before) {
    const data = await call("+cells-get", ["--sheet-id", selected.id, "--range", requested.a1, "--include", "value,formula", "--skip-hidden=false", "--max-chars", "80000"]);
    const readWarning = warning(data?.warning_message);
    if (revision(data?.revision) !== before) throw new Error("读取期间表格版本已变化，请重新读取。");
    if (!Array.isArray(data?.ranges) || data.ranges.length !== 1) invalid();
    const values = data.ranges[0]; const rangeWarning = warning(values?.warning_message);
    if (!Array.isArray(values?.row_indices) || !Array.isArray(values.col_indices) || !values.row_indices.length || !values.col_indices.length ||
        values.row_indices.length > 200 || values.row_indices.length * values.col_indices.length > 2000 || !Array.isArray(values.cells) || values.cells.length !== values.row_indices.length) invalid();
    for (let i = 0; i < values.row_indices.length; i++) if (!integer(values.row_indices[i], selected.rows) || values.row_indices[i] < requested.top || values.row_indices[i] > requested.bottom || i && values.row_indices[i] <= values.row_indices[i - 1]) invalid();
    for (let i = 0; i < values.col_indices.length; i++) if (typeof values.col_indices[i] !== "string" || !/^[A-Z]{1,3}$/.test(values.col_indices[i]) || columnIndex(values.col_indices[i]) < requested.left || columnIndex(values.col_indices[i]) > requested.right || i && columnIndex(values.col_indices[i]) <= columnIndex(values.col_indices[i - 1])) invalid();
    // Coordinates are supplied by the upstream response, never inferred from
    // array offsets. Complex cells stay visibly unsupported, not silently blank.
    let complex = false;
    const cells = values.cells.map((row, rowIndex) => {
      if (!Array.isArray(row) || row.length !== values.col_indices.length) invalid();
      return row.map((cell, colIndex) => {
        if (!cell || typeof cell !== "object" || Array.isArray(cell)) invalid();
        const value = cell.value;
        const layout = mergeRelated(merges, values.row_indices[rowIndex], columnIndex(values.col_indices[colIndex])) ? { mergeRelated: true } : {};
        if (value === null || value === undefined && Object.keys(cell).length === 0) return { value: null, ...layout };
        if (typeof value === "string" && value.length <= 8000 || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value))) return { value, ...layout };
        complex = true; return { value: "复杂单元格（未展开）", unsupported: true, ...layout };
      });
    });
    const actualRange = values.actual_range;
    if (typeof actualRange !== "string" || actualRange.length > 300 || /[\x00-\x1f]/.test(actualRange)) invalid();
    const separator = actualRange.lastIndexOf("!");
    if (separator >= 0 && ![selected.id, selected.title, `'${selected.title.replaceAll("'", "''")}'`].includes(actualRange.slice(0, separator))) invalid();
    const actual = sheetRange(actualRange.slice(separator + 1));
    if (actual.left < requested.left || actual.top < requested.top || actual.right > requested.right || actual.bottom > requested.bottom ||
        values.row_indices[0] < actual.top || values.row_indices.at(-1) > actual.bottom || columnIndex(values.col_indices[0]) < actual.left || columnIndex(values.col_indices.at(-1)) > actual.right) invalid();
  // `warning_message` is Feishu's advice to whatever program calls its read tool:
  // check has_more and actual_range first, place cells by row_indices and
  // col_indices, narrow the range to go on after a cut. The checks above are that
  // advice, applied, and it arrives on complete reads too -- it describes the
  // response, not this sheet. So it is a diagnostic and never a warning: a range
  // that was cut short is known from has_more, truncated and the coordinates.
  return { data, values, cells, complex, diagnostics: [readWarning, rangeWarning].filter(Boolean), actualRange };
}

// Everything a whole-table read says about the copy it returns. The knowledge
// copy shows these under every search hit, so each is a sentence about the
// person's sheet; earlier builds also put Feishu's read advice here.
export const tableNotes = Object.freeze({
  cut: ({ rows, columns }, sheet) => `只整理了前 ${rows} 行、${columns} 列；表格共 ${sheet.rows} 行 × ${sheet.columns} 列，其余部分未包含。`,
  merged: "标记为合并关联的格子不能当作独立空白格；完整布局请查看飞书原表。",
  complex: "部分复杂单元格未展开，不能用于完整数据分析。",
});
// Whether a stored warning is one of those, so a stored copy can be told from one
// an earlier build took (src/knowledge/sheet-source.js). The cut note is rebuilt
// from the numbers it carries rather than matched against a second copy of its
// wording: what this accepts is exactly what readTable writes today.
export function isTableNote(text) {
  if (typeof text !== "string") return false;
  const [rows, columns, total, width] = text.match(/\d+/gu) ?? [];
  return Object.values(tableNotes).includes(text) || text === tableNotes.cut({ rows, columns }, { rows: total, columns: width });
}

export class SaasSheetReader {
  constructor(provider) { this.provider = provider; }
  // `coverage` asks for as much of the sheet as one bounded read may carry,
  // chosen after the workbook says how big it is: the knowledge copy wants the
  // table, not the first ten rows the preview shows, and it must still be one
  // read with one revision check around it.
  async read(reference, { sheetId, range, coverage = null, signal } = {}) {
    const parsed = sheetReference(reference);
    if (sheetId !== undefined && !id(sheetId)) throw new Error("工作表标识无效。");
    if (range !== undefined) sheetRange(range);
    if (coverage && (range !== undefined || !integer(coverage.maxRows, 200) || !integer(coverage.maxCells, 2000))) throw new Error("表格整理范围无效。");
    const identity = await this.provider.documentIdentity({ signal });
    if (!identity.tenantKey || !identity.principal) throw new Error("表格读取需要已核验的企业用户身份。");
    const call = async (command, args = []) => {
      signal?.throwIfAborted(); const result = await this.provider.invoke(["sheets", command, "--url", parsed.url, ...args, "--as", "user", "--format", "json"], { signal, timeoutMs: 30000, maxOutputBytes: 512 * 1024 });
      signal?.throwIfAborted(); return successfulUserPayload(result).data;
    };
    const { before, sheets, selected } = await loadWorkbook(call, sheetId, parsed);
    const requested = sheetRange(range ?? (coverage
      ? coveredRange(selected, coverage)
      : `A1:${sheetColumn(selected.columns)}${Math.min(10, selected.rows)}`));
    if (requested.right > selected.columns || requested.bottom > selected.rows) throw new Error("预览范围超出当前工作表网格，请重新选择。");
    const merges = await readSheetLayout(this.provider, parsed.token, selected, signal);
    const { data, values, cells, complex, diagnostics, actualRange } = await readRangePage(call, selected, merges, requested, before);
    const after = revision((await call("+revision-get"))?.revision), current = await this.provider.documentIdentity({ signal }); signal?.throwIfAborted();
    if (before !== after || identity.principal !== current.principal || identity.tenantKey !== current.tenantKey) throw new Error("读取期间表格版本或飞书身份已变化，请重新读取。");
    const warnings = ["仅为指定范围的值／公式快照，不代表整表已读全；样式、图表和权限信息未复制。"];
    if (cells.some(row => row.some(cell => cell.mergeRelated))) warnings.push("标记为合并关联的格子不能当作独立空白格，也不能生成普通单元格修改；边界按保守范围排除，完整布局请查看飞书原表。");
    for (const object of [data, values]) for (const flag of ["has_more", "truncated"]) if (object[flag] !== undefined && typeof object[flag] !== "boolean") invalid();
    const completeCoordinates = values.row_indices.length === requested.bottom - requested.top + 1 && values.col_indices.length === requested.right - requested.left + 1;
    const truncated = !completeCoordinates || data.has_more === true || data.truncated === true || values.has_more === true || values.truncated === true;
    if (truncated) warnings.push("当前范围被截断，请缩小范围后继续读取。");
    if (complex) warnings.push("部分复杂单元格未展开，不能用于完整数据分析。");
    const snapshot = { kind: "feishu-sheet", providerId: this.provider.id, resourceId: parsed.token, sourceUrl: `${parsed.url}?sheet=${selected.id}`, sourceRevision: after,
      title: `飞书电子表格 · ${selected.title}`, sheets, sheetId: selected.id, range: requested.a1, actualRange, rowIndices: values.row_indices, colIndices: values.col_indices, cells, layoutChecked: true, partial: true, truncated, warnings };
    // Feishu's advice is outside the digest: the same cells at the same revision
    // are the same content whatever wording came with them.
    return { ...snapshot, contentHash: hash(snapshot), diagnostics: [...new Set(diagnostics)], identity: current };
  }
  // A whole worksheet for the knowledge copy, page by page under one revision.
  // One range is at most 200 rows and 2,000 cells, so a ledger of a few thousand
  // rows was being stored as its first 200 -- and anything asked about the rest
  // could not be answered, or worse, was answered from the rows that happened to
  // be there. Every page is checked against the revision the workbook reported
  // before the first one, and the revision is read once more at the end: the
  // result is one version of the sheet, not a walk across edits.
  async readTable(reference, { sheetId, coverage, signal } = {}) {
    const parsed = sheetReference(reference);
    if (sheetId !== undefined && !id(sheetId)) throw new Error("工作表标识无效。");
    if (!coverage || !integer(coverage.maxRows, 50000) || !integer(coverage.maxCells, 1_000_000) || !integer(coverage.maxChars, 500_000)) throw new Error("表格整理范围无效。");
    const identity = await this.provider.documentIdentity({ signal });
    if (!identity.tenantKey || !identity.principal) throw new Error("表格读取需要已核验的企业用户身份。");
    const call = async (command, args = []) => {
      signal?.throwIfAborted(); const result = await this.provider.invoke(["sheets", command, "--url", parsed.url, ...args, "--as", "user", "--format", "json"], { signal, timeoutMs: 30000, maxOutputBytes: 512 * 1024 });
      signal?.throwIfAborted(); return successfulUserPayload(result).data;
    };
    const { before, sheets, selected } = await loadWorkbook(call, sheetId, parsed);
    const columns = Math.max(1, Math.min(selected.columns, Math.floor(coverage.maxCells / Math.min(coverage.maxRows, selected.rows))));
    const rows = Math.max(1, Math.min(selected.rows, coverage.maxRows, Math.floor(coverage.maxCells / columns)));
    const pageRows = Math.max(1, Math.min(200, Math.floor(2000 / columns)));
    const merges = await readSheetLayout(this.provider, parsed.token, selected, signal);
    const rowIndices = [], cells = [], diagnostics = new Set();
    let colIndices = null, complex = false, chars = 0, stopped = false;
    for (let top = 1; top <= rows; top += pageRows) {
      const requested = sheetRange(`A${top}:${sheetColumn(columns)}${Math.min(rows, top + pageRows - 1)}`);
      const page = await readRangePage(call, selected, merges, requested, before);
      for (const text of page.diagnostics) diagnostics.add(text);
      const complete = page.values.row_indices.length === requested.bottom - requested.top + 1 && page.values.col_indices.length === requested.right - requested.left + 1
        && page.data.has_more !== true && page.data.truncated !== true && page.values.has_more !== true && page.values.truncated !== true;
      if (colIndices && page.values.col_indices.join() !== colIndices.join()) { stopped = true; break; }
      // What a page would add to the projection: the store holds a page of at
      // most half a million characters, and a table must stop before that rather
      // than be refused whole.
      const size = page.cells.reduce((total, row) => total + 8 + row.reduce((sum, cell) => sum + 3 + Math.min(200, String(cell.value ?? "").length), 0), 0);
      if (chars + size > coverage.maxChars) { stopped = true; break; }
      chars += size;
      colIndices ??= page.values.col_indices;
      rowIndices.push(...page.values.row_indices); cells.push(...page.cells); complex ||= page.complex;
      // A page the upstream cut short is the end of what can be trusted to be
      // contiguous; the rows after it are not guessed at.
      if (!complete) { stopped = true; break; }
    }
    const after = revision((await call("+revision-get"))?.revision), current = await this.provider.documentIdentity({ signal }); signal?.throwIfAborted();
    if (before !== after || identity.principal !== current.principal || identity.tenantKey !== current.tenantKey) throw new Error("读取期间表格版本或飞书身份已变化，请重新读取。");
    const truncated = stopped || rows < selected.rows || columns < selected.columns;
    if (!rowIndices.length) throw new Error("表格的第一页就超出了整理上限，未建立知识副本。");
    // That this is values only, and the bounds it was taken under, is said by the
    // knowledge source that chose the bounds (src/knowledge/sheet-source.js).
    const warnings = [];
    if (truncated) warnings.push(tableNotes.cut({ rows: rowIndices.length, columns: colIndices.length }, selected));
    if (cells.some(row => row.some(cell => cell.mergeRelated))) warnings.push(tableNotes.merged);
    if (complex) warnings.push(tableNotes.complex);
    const last = rowIndices.at(-1);
    const snapshot = { kind: "feishu-sheet", providerId: this.provider.id, resourceId: parsed.token, sourceUrl: `${parsed.url}?sheet=${selected.id}`, sourceRevision: after,
      title: `飞书电子表格 · ${selected.title}`, sheets, sheetId: selected.id, range: `A1:${sheetColumn(colIndices.length)}${last}`, actualRange: `A1:${colIndices.at(-1)}${last}`,
      rowIndices, colIndices, cells, layoutChecked: true, partial: true, truncated, warnings,
      // The bounds are part of what the copy is: the same sheet taken under other
      // bounds is a different copy, and must replace the stored one.
      coverage: { maxRows: coverage.maxRows, maxCells: coverage.maxCells, maxChars: coverage.maxChars } };
    return { ...snapshot, contentHash: hash(snapshot), diagnostics: [...diagnostics].slice(0, 20), identity: current };
  }
  // Whether a spreadsheet is still the version stored, asked as this user: one
  // call and no cells. A call Feishu refuses is a read Feishu refuses.
  async revision(reference, { signal } = {}) {
    const parsed = sheetReference(reference);
    const identity = await this.provider.documentIdentity({ signal });
    if (!identity.tenantKey || !identity.principal) throw new Error("表格读取需要已核验的企业用户身份。");
    signal?.throwIfAborted();
    const result = await this.provider.invoke(["sheets", "+revision-get", "--url", parsed.url, "--as", "user", "--format", "json"], { signal, timeoutMs: 30000, maxOutputBytes: 64 * 1024 });
    signal?.throwIfAborted();
    const value = revision(successfulUserPayload(result).data?.revision);
    const current = await this.provider.documentIdentity({ signal });
    if (identity.principal !== current.principal || identity.tenantKey !== current.tenantKey) throw new Error("读取期间飞书身份已变化，请重新读取。");
    return { revision: value, identity: current };
  }
}
