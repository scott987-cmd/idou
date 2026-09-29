import test from "node:test";
import assert from "node:assert/strict";
import { SLICE_LIMITS, describeSlice, parseSlice, sliceId, slicePages } from "../src/application/table-slice.js";

const base = { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblXYZ123", fields: ["fldAAA", "fldBBB"], rows: 100, refreshSeconds: 60 };
const sheet = { kind: "sheet", token: "shtcnABCDEFGHIJ", sheetId: "Sheet1", columns: ["A", "B", "C"], headerRow: 1, rows: 50, refreshSeconds: 300 };

test("a slice is the whole permission story, so every part of it is checked", () => {
  const parsed = parseSlice(base);
  assert.deepEqual(parsed.fields, ["fldAAA", "fldBBB"]);
  assert.deepEqual(parsed.writable, [], "nothing is writable unless it is asked for");
  assert.equal(Object.isFrozen(parsed), true);
  assert.deepEqual(parseSlice(sheet).columns, ["A", "B", "C"]);
  for (const [input, why] of [
    [{ ...base, kind: "docx" }, "只支持这两种表格"],
    [{ ...base, token: "no" }, "表格标识"],
    [{ ...base, tableId: "notatable" }, "数据表标识"],
    [{ ...base, viewId: "nope" }, "视图标识"],
    [{ ...base, fields: [] }, "没有字段"],
    [{ ...base, fields: ["fldAAA", "fldAAA"] }, "重复字段"],
    [{ ...base, fields: Array.from({ length: SLICE_LIMITS.fields + 1 }, (_, i) => `fldX${i}`) }, "字段太多"],
    [{ ...base, rows: 0 }, "行数下限"],
    [{ ...base, rows: SLICE_LIMITS.rows + 1 }, "行数上限"],
    [{ ...base, refreshSeconds: 1 }, "刷新太快"],
    [{ ...base, refreshSeconds: SLICE_LIMITS.maxRefreshSeconds + 1 }, "刷新太慢"],
    [{ ...sheet, columns: ["A", "a"] }, "列必须是大写字母"],
    [{ ...sheet, headerRow: 0 }, "表头行"],
  ]) assert.throws(() => parseSlice(input), Error, why);
});

test("writable columns narrow, never widen: a field that is not shown cannot be written", () => {
  assert.deepEqual(parseSlice({ ...base, writable: ["fldAAA"] }).writable, ["fldAAA"]);
  assert.throws(() => parseSlice({ ...base, writable: ["fldZZZ"] }), /必须先在展示字段里/);
  assert.deepEqual(parseSlice({ ...sheet, writable: ["B"] }).writable, ["B"]);
  assert.throws(() => parseSlice({ ...sheet, writable: ["Z"] }), /必须先在展示字段里/);
});

test("parsing a slice that was already parsed means the same thing", () => {
  for (const input of [base, sheet, { ...base, writable: ["fldAAA"] }]) {
    assert.deepEqual(parseSlice(parseSlice(input)), parseSlice(input), JSON.stringify(input));
  }
  assert.deepEqual(parseSlice({ ...base, writable: [] }).writable, [], "an empty list is an explicit no");
  assert.throws(() => parseSlice({ ...base, writable: "fldAAA" }), /可写字段无效/);
});

test("the same data asked for twice is one slice, so two sites share one read", () => {
  assert.equal(sliceId(base), sliceId({ ...base, fields: ["fldAAA", "fldBBB"] }));
  // How often it is read and what may be written are not what is read.
  assert.equal(sliceId(base), sliceId({ ...base, refreshSeconds: 900, writable: ["fldAAA"] }));
  for (const other of [{ ...base, fields: ["fldBBB", "fldAAA"] }, { ...base, rows: 101 }, { ...base, tableId: "tblOTHER" }, { ...base, viewId: "vewONE" }]) {
    assert.notEqual(sliceId(base), sliceId(other), JSON.stringify(other));
  }
  assert.notEqual(sliceId(base), sliceId(sheet));
  assert.match(sliceId(base), /^[0-9a-f]{32}$/);
});

test("a read is bounded in pages, not only in rows", () => {
  assert.equal(slicePages({ ...base, rows: 1 }), 1);
  assert.equal(slicePages({ ...base, rows: SLICE_LIMITS.pageRows }), 1);
  assert.equal(slicePages({ ...base, rows: SLICE_LIMITS.pageRows + 1 }), 2);
  assert.equal(slicePages({ ...base, rows: SLICE_LIMITS.rows }), Math.ceil(SLICE_LIMITS.rows / SLICE_LIMITS.pageRows));
});

test("what the confirmation card says is built from the slice itself", () => {
  const card = describeSlice({ ...base, writable: ["fldAAA"] }, { tableName: "客户", fieldNames: new Map([["fldAAA", "客户名"], ["fldBBB", "金额"]]) });
  assert.deepEqual(card, { source: "多维表格 · 客户", fields: ["客户名", "金额"], rows: 100, refresh: "每 1 分钟", writable: ["客户名"] });
  assert.equal(describeSlice({ ...base, refreshSeconds: 90 }).refresh, "每 90 秒");
  assert.deepEqual(describeSlice(base).fields, ["fldAAA", "fldBBB"], "field ids when no names were read");
});
