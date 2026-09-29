import test from "node:test";
import assert from "node:assert/strict";
import { SLICE_LIMITS } from "../src/application/table-slice.js";
import { columnLetter, readBaseSlice, readSheetSlice, snapshotChanged, snapshotDigest } from "../src/application/table-snapshot.js";

const slice = { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblXYZ123", fields: ["fldName", "fldAmount"], rows: 500, refreshSeconds: 60 };
const FIELDS = [{ id: "fldName", name: "客户名", type: "text", style: "plain" }, { id: "fldAmount", name: "金额", type: "number", style: "currency" },
  { id: "fldNote", name: "备注", type: "text" }];

// A reader shaped like the deployment's own `baseRecords` part.
function baseRecords(total, { fields = FIELDS, value = (row, field) => `${field}-${row}` } = {}) {
  const calls = [];
  return {
    calls,
    async fields() { return fields; },
    async list(token, tableId, { offset, limit }) {
      calls.push({ offset, limit });
      const records = [];
      for (let at = offset; at < Math.min(total, offset + limit); at += 1) {
        records.push({ id: `rec${String(at).padStart(4, "0")}`, values: { fldName: value(at, "name"), fldAmount: at, fldNote: "内部" } });
      }
      return { records, more: offset + limit < total };
    },
  };
}

test("a Base slice comes back in the slice's own field order, with uniform cells", async () => {
  const { schema, snapshot } = await readBaseSlice(slice, baseRecords(3), { now: () => 1_700_000_000_000 });
  assert.deepEqual(schema.fields.map((field) => [field.id, field.name, field.type, field.writable]),
    [["fldName", "客户名", "text", false], ["fldAmount", "金额", "number", false]]);
  assert.equal(schema.fields.length, 2, "a field the slice did not ask for never leaves the machine");
  assert.equal(snapshot.rowCount, 3);
  // A cell carries what it means, not only how it prints: the page needs the kind
  // to draw money right-aligned and a date as a date instead of a timestamp.
  assert.deepEqual(snapshot.rows[0], { id: "rec0000", values: {
    fldName: { text: "name-0", value: "name-0", kind: "text" },
    fldAmount: { text: "0", value: 0, kind: "number", style: "currency" } } });
  assert.equal(JSON.stringify(snapshot).includes("内部"), false, "a field outside the slice is not in the payload either");
  assert.equal(snapshot.readAt, 1_700_000_000_000);
  assert.equal(snapshot.truncated, false);
  assert.equal(schema.refreshSeconds, 60);
  assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
});

test("reading is paged and stops at the slice's row cap", async () => {
  const records = baseRecords(1000);
  const { snapshot, schema } = await readBaseSlice({ ...slice, rows: 450 }, records);
  assert.equal(snapshot.rowCount, 450);
  assert.equal(snapshot.truncated, true);
  assert.equal(schema.rows.truncated, true);
  assert.deepEqual(records.calls, [{ offset: 0, limit: SLICE_LIMITS.pageRows }, { offset: 200, limit: SLICE_LIMITS.pageRows }, { offset: 400, limit: 50 }]);
  const exact = await readBaseSlice({ ...slice, rows: 200 }, baseRecords(200));
  assert.equal(exact.snapshot.truncated, false, "a table that ends exactly at the cap is not truncated");
});

test("a page that says there is more but returns nothing does not loop", async () => {
  const stuck = { async fields() { return FIELDS; }, async list() { return { records: [], more: true }; } };
  const { snapshot } = await readBaseSlice(slice, stuck);
  assert.equal(snapshot.rowCount, 0);
  assert.equal(snapshot.truncated, true);
});

test("the digest is what a visitor would see, and nothing else", async () => {
  const first = await readBaseSlice(slice, baseRecords(5), { now: () => 1 });
  const again = await readBaseSlice(slice, baseRecords(5), { now: () => 999 });
  assert.equal(snapshotChanged(first.snapshot, again.snapshot), false, "the same rows read later are not a change");
  const edited = await readBaseSlice(slice, baseRecords(5, { value: (row, field) => row === 3 ? "改过了" : `${field}-${row}` }), { now: () => 1 });
  assert.equal(snapshotChanged(first.snapshot, edited.snapshot), true);
  // The upstream hands fields back in whatever order it likes; that is not a change.
  const shuffled = await readBaseSlice(slice, baseRecords(5, { fields: [...FIELDS].reverse() }), { now: () => 1 });
  assert.equal(snapshotChanged(first.snapshot, shuffled.snapshot), false);
  const fewer = await readBaseSlice(slice, baseRecords(4), { now: () => 1 });
  assert.equal(snapshotChanged(first.snapshot, fewer.snapshot), true, "a deleted row is a change");
  assert.equal(snapshotDigest({ fields: [], rows: [] }).length, 64);
});

test("a field the table no longer has is said plainly, not dropped", async () => {
  await assert.rejects(() => readBaseSlice(slice, baseRecords(1, { fields: [FIELDS[0]] })), /已经没有这些字段：fldAmount/);
});

test("a slice that would produce an oversized payload is refused, not written", async () => {
  const big = baseRecords(SLICE_LIMITS.rows, { value: () => "x".repeat(2000) });
  await assert.rejects(() => readBaseSlice({ ...slice, rows: SLICE_LIMITS.rows }, big), /请减少字段或行数/);
});

test("a spreadsheet slice takes its column names from the header row", async () => {
  const sheets = {
    async readTable(token, { sheetId }) {
      assert.equal(sheetId, "Sheet1");
      return {
        sourceRevision: 42,
        rowIndices: [1, 2, 3, 4],
        colIndices: [1, 2, 3],
        truncated: false,
        cells: [
          [{ value: "客户名" }, { value: "金额" }, { value: "备注" }],
          [{ value: "甲" }, { value: 10 }, { value: "内部" }],
          [{ value: "乙" }, { value: 20 }, { value: "内部" }],
          [{ value: "丙" }, { value: 30 }, { value: "内部" }],
        ],
      };
    },
  };
  const wanted = { kind: "sheet", token: "shtcnABCDEFGHIJ", sheetId: "Sheet1", columns: ["A", "B"], headerRow: 1, rows: 2, refreshSeconds: 300 };
  const { schema, snapshot } = await readSheetSlice(wanted, sheets, { now: () => 5 });
  assert.deepEqual(schema.fields.map((field) => [field.id, field.name]), [["A", "客户名"], ["B", "金额"]]);
  assert.equal(snapshot.revision, 42);
  assert.equal(snapshot.rowCount, 2);
  assert.equal(snapshot.truncated, true, "a third data row exists but the slice asked for two");
  // A spreadsheet has no field types, so the kind comes from the value itself.
  assert.deepEqual(snapshot.rows[0], { id: "2", values: { A: { text: "甲", value: "甲", kind: "text" }, B: { text: "10", value: 10, kind: "number" } } });
  assert.equal(JSON.stringify(snapshot).includes("内部"), false);
  await assert.rejects(() => readSheetSlice({ ...wanted, columns: ["A", "Z"] }, sheets), /没有这些列：Z/);
});

test("column letters are the spreadsheet's own", () => {
  assert.deepEqual([1, 2, 26, 27, 28, 52, 53].map(columnLetter), ["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
});
