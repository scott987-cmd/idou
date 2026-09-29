import { successfulUserPayload } from "./document-errors.js";

// The public v3 sheet endpoint documents zero-based merge coordinates. It does
// not explicitly define end inclusion; use the union of both interpretations
// for edit exclusion, never invent rowSpan/colSpan from an unverified convention.
export async function readSheetLayout(provider, token, selected, signal) {
  signal?.throwIfAborted();
  const result = await provider.invoke(["api", "GET", `/open-apis/sheets/v3/spreadsheets/${token}/sheets/${selected.id}`, "--as", "user", "--format", "json"], { signal, timeoutMs: 30000, maxOutputBytes: 512 * 1024 });
  signal?.throwIfAborted();
  const data = successfulUserPayload(result).data, sheet = data?.sheet;
  const invalid = () => { throw new Error("工作表布局未通过核验，无法可靠区分普通格与合并区域，请重新读取。"); };
  if (!sheet || sheet.sheet_id !== selected.id || sheet.title !== selected.title || sheet.resource_type !== "sheet" || sheet.hidden !== selected.hidden ||
      sheet.grid_properties?.row_count !== selected.rows || sheet.grid_properties?.column_count !== selected.columns ||
      (sheet.merges !== undefined && !Array.isArray(sheet.merges)) || (sheet.merges?.length ?? 0) > 10000 || data.has_more || data.truncated || data.warning_message) invalid();
  const seen = new Set();
  const merges = (sheet.merges || []).map(merge => {
    if (!merge || typeof merge !== "object" || Array.isArray(merge)) invalid();
    const fields = ["start_row_index", "end_row_index", "start_column_index", "end_column_index"];
    if (fields.some(key => !Number.isSafeInteger(merge[key]) || merge[key] < 0)) invalid();
    const [top, bottom, left, right] = fields.map(key => merge[key]);
    if (bottom < top || right < left || top >= selected.rows || left >= selected.columns || bottom > selected.rows || right > selected.columns) invalid();
    const key = JSON.stringify([top, bottom, left, right]); if (seen.has(key)) invalid(); seen.add(key);
    return { startRowIndex: top, endRowIndex: bottom, startColumnIndex: left, endColumnIndex: right };
  });
  return merges.sort((a, b) => a.startRowIndex - b.startRowIndex || a.startColumnIndex - b.startColumnIndex || a.endRowIndex - b.endRowIndex || a.endColumnIndex - b.endColumnIndex);
}

export function mergeRelated(merges, row, column) {
  return merges.some(merge => row - 1 >= merge.startRowIndex && row - 1 <= merge.endRowIndex && column - 1 >= merge.startColumnIndex && column - 1 <= merge.endColumnIndex);
}
