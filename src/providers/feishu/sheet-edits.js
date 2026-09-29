import { sheetColumn, sheetReference } from "./sheet-reader.js";

// Reviewed cell values written back into a Feishu spreadsheet. The pinned CLI's
// `+cells-set` has no expected-revision parameter (docs/feishu-sheet-reader.md),
// so the write cannot be conditional the way a document write is. What stands in
// for it was measured against a live tenant:
//
//   * every write call moves the sheet's revision by exactly one, however many
//     cells it sets, and the receipt carries the new revision;
//   * a `{}` cell inside the written rectangle is left exactly as it was, and a
//     cell written as "" reads back empty.
//
// So one call writes the smallest rectangle holding every change, with `{}` for
// the cells in between. Just before it, that rectangle is read -- the revision R
// and every cell's typed value -- and each changed cell must still hold the value
// the person saw. After it, the receipt must say R+1 (anything else means someone
// else wrote in between) and the rectangle is read back: the changed cells must
// hold exactly the confirmed values and every other cell what it held before.

const ADDRESS = /^([A-Z]{1,2})([1-9][0-9]{0,4})$/;
// One bounded read before the write and one after it (sheet-reader.js limits).
const MAX_RECTANGLE_CELLS = 2000;
const MAX_RECTANGLE_ROWS = 200;
// Everything the pinned CLI puts in a single-range `set_cell_range` input.
const INPUT_KEYS = new Set(["cells", "excel_id", "range", "sheet_id", "allow_overwrite"]);

const columnIndex = letters => [...letters].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
const scalarOrNull = value => value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
// Typed equality: "00123" and 123 are different values, and so are "" and null.
const same = (a, b) => typeof a === typeof b && Object.is(a, b);
const shown = value => value === null ? "空单元格" : JSON.stringify(value);

// The smallest rectangle holding every change, as the cells matrix `+cells-set`
// takes: a changed cell carries its value, every other cell `{}`.
export function sheetEditRectangle(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > 20) throw new Error("表格写入只支持 1–20 处修改");
  const parsed = changes.map(change => {
    const match = ADDRESS.exec(change?.address ?? "");
    if (!match || !scalarOrNull(change.before) || !scalarOrNull(change.after)) throw new Error("表格写入的格子或值无效");
    return { address: change.address, before: change.before, after: change.after, column: columnIndex(match[1]), row: Number(match[2]) };
  });
  if (new Set(parsed.map(item => item.address)).size !== parsed.length) throw new Error("同一个格子不能在一次写入里出现两次");
  const top = Math.min(...parsed.map(item => item.row)), bottom = Math.max(...parsed.map(item => item.row));
  const left = Math.min(...parsed.map(item => item.column)), right = Math.max(...parsed.map(item => item.column));
  if (bottom - top + 1 > MAX_RECTANGLE_ROWS || (bottom - top + 1) * (right - left + 1) > MAX_RECTANGLE_CELLS) throw new Error("这些修改分布太散，超出一次核对的范围；请缩小范围后重新生成建议");
  const byAddress = new Map(parsed.map(item => [item.address, item])), cells = [];
  for (let row = top; row <= bottom; row += 1) {
    const line = [];
    for (let column = left; column <= right; column += 1) {
      const change = byAddress.get(`${sheetColumn(column)}${row}`);
      line.push(change ? { value: change.after === null ? "" : change.after } : {});
    }
    cells.push(line);
  }
  const a1 = top === bottom && left === right ? `${sheetColumn(left)}${top}` : `${sheetColumn(left)}${top}:${sheetColumn(right)}${bottom}`;
  return Object.freeze({ a1, top, bottom, left, right, cells, changes: Object.freeze(parsed) });
}

export class SaasSheetEdits {
  constructor(provider) { this.provider = provider; }

  // Plans the one write for these changes. The CLI's own dry run declares the
  // request, and the grant is later bound to exactly that request; a plan that
  // is not the rectangle asked for is refused here.
  async prepare(source, changes) {
    const rectangle = sheetEditRectangle(changes), reference = sheetReference(source.sourceUrl);
    const argv = ["sheets", "+cells-set", "--url", reference.url, "--sheet-id", source.sheetId, "--range", rectangle.a1, "--cells", JSON.stringify(rectangle.cells)];
    const plan = await this.provider.cliWriter.plan(argv);
    let input = null; try { input = JSON.parse(plan.body?.input); } catch { input = null; }
    // Exactly the one rectangle: no copy-to-range, no second sheet, nothing the card does not show.
    if (plan.family?.id !== "sheet.write" || plan.destructive || Object.keys(plan.body ?? {}).sort().join() !== "input,tool_name" || plan.body.tool_name !== "set_cell_range" ||
        !input || typeof input !== "object" || Object.keys(input).some(key => !INPUT_KEYS.has(key)) || (input.allow_overwrite !== undefined && input.allow_overwrite !== true) ||
        input.excel_id !== reference.token || input.sheet_id !== source.sheetId || input.range !== rectangle.a1 || JSON.stringify(input.cells) !== JSON.stringify(rectangle.cells)) {
      throw new Error("飞书 CLI 预演出的写入请求与确认内容不一致，未写入");
    }
    return Object.freeze({ source: Object.freeze({ sourceUrl: source.sourceUrl, sheetId: source.sheetId, principal: source.principal, tenantKey: source.tenantKey }), rectangle, plan });
  }

  // The rectangle as Feishu holds it now: its revision and every cell, addressed
  // by the coordinates Feishu returned rather than by position.
  async read(prepared, signal) {
    const { source, rectangle } = prepared;
    const snapshot = await this.provider.sheets.read(source.sourceUrl, { sheetId: source.sheetId, range: rectangle.a1, signal });
    if (snapshot.sheetId !== source.sheetId || snapshot.identity?.principal !== source.principal || snapshot.identity?.tenantKey !== source.tenantKey) throw new Error("表格、工作表或飞书身份已变化，未写入");
    if (snapshot.truncated) throw new Error("核对范围没有读全，未写入");
    const cells = new Map();
    snapshot.rowIndices.forEach((row, i) => snapshot.colIndices.forEach((column, j) => cells.set(`${column}${row}`, snapshot.cells[i][j])));
    for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
      for (let column = rectangle.left; column <= rectangle.right; column += 1) if (!cells.has(`${sheetColumn(column)}${row}`)) throw new Error("核对范围缺少格子，未写入");
    }
    return { revision: snapshot.sourceRevision, cells };
  }

  async apply(prepared, beforeDispatch, { signal } = {}) {
    const { source, rectangle, plan } = prepared;
    // Written as the person is now, not as a read a few seconds ago saw them.
    const identity = await this.provider.documentIdentity({ signal, fresh: true });
    if (identity.principal !== source.principal || identity.tenantKey !== source.tenantKey) throw new Error("飞书身份已变化，未写入");
    const before = await this.read(prepared, signal);
    for (const change of rectangle.changes) {
      const cell = before.cells.get(change.address);
      if (cell.unsupported || cell.mergeRelated) throw new Error(`${change.address} 现在是合并关联或复杂单元格，未写入`);
      if (!same(cell.value, change.before)) throw new Error(`${change.address} 在确认之后被改过（现在是 ${shown(cell.value)}），未写入`);
    }
    let dispatched = false, receipt;
    try {
      receipt = await this.provider.cliWriter.run(plan, async () => { await beforeDispatch({ baseRevision: before.revision }); dispatched = true; });
    } catch (error) {
      if (!dispatched) throw error;
      throw Object.assign(new Error(`写入结果不确定：可能已写入、部分写入或未写入，请到飞书核查原表；不会自动重试。（${String(error?.message ?? error).slice(0, 200)}）`), { unknown: true, cause: error });
    }
    const receiptRevision = receipt?.revision === undefined || receipt?.revision === null ? null : String(receipt.revision);
    let after;
    try { after = await this.read(prepared, signal); }
    catch (error) {
      throw Object.assign(new Error(`飞书已回执写入${receiptRevision ? `（版本 ${receiptRevision}）` : ""}，但写后读回没有完成，无法逐格核对；请到飞书核查原表，不会自动重试。`), { unknown: true, revision: receiptRevision, cause: error });
    }
    const differences = [];
    for (let row = rectangle.top; row <= rectangle.bottom; row += 1) {
      for (let column = rectangle.left; column <= rectangle.right; column += 1) {
        const address = `${sheetColumn(column)}${row}`, change = rectangle.changes.find(item => item.address === address);
        const expected = change ? change.after : before.cells.get(address).value, actual = after.cells.get(address).value;
        if (!same(actual, expected)) differences.push({ address, expected, actual, changed: Boolean(change) });
      }
    }
    // One write moves the revision by exactly one; more means someone else wrote too. So does a read-back
    // past the receipt that finds different cells: whose value that is cannot be told apart.
    const revision = receiptRevision ?? after.revision;
    const concurrent = revision !== String(Number(before.revision) + 1) || (differences.length > 0 && after.revision !== revision);
    return { state: concurrent ? "conflict" : differences.length ? "mismatch" : "verified", baseRevision: before.revision, revision, readBackRevision: after.revision, differences };
  }
}
