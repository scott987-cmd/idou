import test from "node:test";
import assert from "node:assert/strict";
import { SLICE_LIMITS } from "../src/application/table-slice.js";
import { columnLetter, contractKey, probeBaseSlice, readBaseSlice, readSheetSlice, snapshotChanged, snapshotDigest } from "../src/application/table-snapshot.js";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { CONTRACT_DIR, CONTRACT_FILES, contractFiles } from "../src/application/table-contract.js";
import { SaasBaseRecords } from "../src/providers/feishu/base-records.js";
import { baseCellText } from "../src/providers/feishu/base-reader.js";

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
  // A column renamed is seen -- as its heading -- though no value moved.
  const renamed = await readBaseSlice(slice, baseRecords(5, { fields: FIELDS.map((field) => field.id === "fldName" ? { ...field, name: "客户名称" } : field) }), { now: () => 1 });
  assert.equal(snapshotChanged(first.snapshot, renamed.snapshot), true, "a renamed column is a change");
  const retyped = await readBaseSlice(slice, baseRecords(5, { fields: FIELDS.map((field) => field.id === "fldName" ? { ...field, type: "url" } : field) }), { now: () => 1 });
  assert.equal(snapshotChanged(first.snapshot, retyped.snapshot), true, "a column drawn differently is a change");
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

// A reader that answers each page a little later, and says how many were being
// read at once -- what docs/sites-phase1.md §1.7 changed.
function slowRecords(total, { state = null, fail = null } = {}) {
  const calls = [];
  let inFlight = 0, most = 0;
  return {
    calls, order: [], get most() { return most; },
    async fields() { return FIELDS; },
    ...(state ? { async tableState(token, tableId) { this.order.push("state"); assert.equal(tableId, "tblXYZ123"); return state; } } : {}),
    async list(token, tableId, { offset, limit }) {
      this.order.push("list");
      calls.push({ offset, limit });
      inFlight += 1; most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      if (fail?.(offset)) throw new Error(`第 ${offset} 行起的那页读失败了`);
      const records = [];
      for (let at = offset; at < Math.min(total, offset + limit); at += 1) records.push({ id: `rec${String(at).padStart(5, "0")}`, values: { fldName: `name-${at}`, fldAmount: at } });
      return { records, more: offset + limit < total };
    },
  };
}

test("a large table is read a few pages at a time, and comes back in its own order", async () => {
  const records = slowRecords(2050);
  const { snapshot } = await readBaseSlice({ ...slice, rows: 5000 }, records);
  assert.equal(snapshot.rowCount, 2050);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(snapshot.rows.map((row) => row.id), Array.from({ length: 2050 }, (_, at) => `rec${String(at).padStart(5, "0")}`));
  assert.equal(records.most, SLICE_LIMITS.pagesAtOnce, "never more at once than allowed, and not one at a time either");
  // Every page once, from where the one before it ended.
  assert.deepEqual(records.calls.slice(0, 11).map((call) => call.offset).sort((a, b) => a - b), Array.from({ length: 11 }, (_, page) => page * SLICE_LIMITS.pageRows));
});

test("a small table costs one call, not a wave of them", async () => {
  const records = slowRecords(50);
  const { snapshot } = await readBaseSlice({ ...slice, rows: 5000 }, records);
  assert.equal(snapshot.rowCount, 50);
  assert.deepEqual(records.calls, [{ offset: 0, limit: SLICE_LIMITS.pageRows }]);
});

test("the read stops at the cap even when pages are asked for together", async () => {
  const records = slowRecords(30_000);
  const { snapshot } = await readBaseSlice({ ...slice, rows: 1000 }, records);
  assert.equal(snapshot.rowCount, 1000);
  assert.equal(snapshot.truncated, true);
  assert.ok(records.calls.every((call) => call.offset + call.limit <= 1000), "nothing past the cap is asked for");
});

test("a short page with more to come: the pages asked after it are dropped, and nothing is lost or doubled", async () => {
  // Feishu answering 150 rows of a page of 200 and saying there is more.
  const records = slowRecords(1000);
  const list = records.list.bind(records);
  records.list = async (token, tableId, options) => {
    const page = await list(token, tableId, options);
    return options.offset === 200 ? { records: page.records.slice(0, 150), more: true } : page;
  };
  const { snapshot } = await readBaseSlice({ ...slice, rows: 5000 }, records);
  assert.equal(snapshot.rowCount, 1000);
  assert.equal(new Set(snapshot.rows.map((row) => row.id)).size, 1000);
  assert.ok(records.calls.some((call) => call.offset === 350), "read on from where the short page ended");
});

test("a row seen on two pages -- the table moved while it was read -- is kept once", async () => {
  const records = slowRecords(400);
  const list = records.list.bind(records);
  // A row added above shifts the second page by one: it starts with the first page's last row.
  records.list = async (token, tableId, options) => list(token, tableId, options.offset === 200 ? { ...options, offset: 199 } : options);
  const { snapshot } = await readBaseSlice({ ...slice, rows: 5000 }, records);
  const ids = snapshot.rows.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("one page failing fails the read, after every page it started has settled", async () => {
  const records = slowRecords(2000, { fail: (offset) => offset === 400 });
  await assert.rejects(() => readBaseSlice({ ...slice, rows: 5000 }, records), /第 400 行起的那页读失败了/);
});

test("what the table says of itself is taken before its rows, and only as numbers", async () => {
  const records = slowRecords(10, { state: { rev: 7, count: 10 } });
  const read = await readBaseSlice(slice, records);
  assert.equal(read.probe, "7:10");
  assert.equal(records.order[0], "state", "before the rows: a change made while they are read leaves the next probe different");
  assert.equal((await readBaseSlice(slice, slowRecords(10))).probe, null, "a deployment that cannot say has no probe");
  assert.equal((await readBaseSlice(slice, slowRecords(10, { state: { rev: "7", count: 10 } }))).probe, null);
  assert.equal(await probeBaseSlice(slice, slowRecords(10, { state: { rev: 8, count: 11 } })), "8:11");
  assert.equal(await probeBaseSlice({ kind: "sheet", token: "shtcnABCDEFGHIJ", sheetId: "Sheet1", columns: ["A"], rows: 5, refreshSeconds: 60 }, slowRecords(1, { state: { rev: 1, count: 1 } })), null);
});

test("the size cap is counted in bytes as sent, so a table in Chinese is held to it too", async () => {
  // About 11 million characters, about 30 million bytes: under the cap counted
  // the old way, in characters, and over it as the server counts.
  const chinese = baseRecords(SLICE_LIMITS.rows, { value: () => "中".repeat(500) });
  await assert.rejects(() => readBaseSlice({ ...slice, rows: SLICE_LIMITS.rows }, chinese), /MB，超过了 24\.0 MB；请减少字段或行数/);
});

test("the row count the table gave bounds the pages asked for, and a table grown since is still read to its end", async () => {
  const exact = slowRecords(1502, { state: { rev: 1, count: 1502 } });
  await readBaseSlice({ ...slice, rows: 5000 }, exact);
  assert.equal(exact.calls.length, 8, "1,502 rows: eight pages, none past the end");
  const unknown = slowRecords(1502);
  await readBaseSlice({ ...slice, rows: 5000 }, unknown);
  assert.ok(unknown.calls.length > 8, "without a count, a wave may run past the end");
  // Rows added after the count was taken: the last page's `more` is believed.
  const grown = slowRecords(1502, { state: { rev: 1, count: 1000 } });
  const { snapshot } = await readBaseSlice({ ...slice, rows: 5000 }, grown);
  assert.equal(snapshot.rowCount, 1502);
  // Shrunk since: stops where the table ends.
  const shrunk = slowRecords(300, { state: { rev: 1, count: 1502 } });
  assert.equal((await readBaseSlice({ ...slice, rows: 5000 }, shrunk)).snapshot.rowCount, 300);
});

// Recorded from a real Base (test/fixtures/base-record-shapes.json): a date
// field comes back from `base +record-list` as an ISO string with its offset,
// not as milliseconds. Read as before, every date on a real table's site was
// empty -- the dashboard's 签约日期 column all "—", a timeline with no events.
test("a Base's dates, as Feishu sends them, are dates on the site", async () => {
  const shapes = JSON.parse(await readFile(new URL("./fixtures/base-record-shapes.json", import.meta.url), "utf8"));
  const answer = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const records = new SaasBaseRecords({ id: "saas-cli", async invoke(argv) {
    if (argv.includes("+field-list")) return answer(shapes.fieldList);
    if (argv.includes("+record-list")) return answer({ ...shapes.recordList, has_more: false });
    if (argv.includes("+table-list")) return answer({ tables: [{ id: "tblShape01", name: "客户台账", rev: 1, records_count: 2 }] });
    throw new Error(`not recorded: ${argv.join(" ")}`);
  } });
  const fields = shapes.fieldList.fields.map((field) => field.id);
  const { schema, snapshot } = await readBaseSlice({ kind: "base", token: "bascnShape01", tableId: "tblShape01", fields, rows: 100, refreshSeconds: 60 },
    records, { renderCell: (value) => baseCellText(value) });
  const date = schema.fields.find((field) => field.name === "签约日期");
  assert.equal(date.kind, "date");
  const cell = snapshot.rows[0].values[date.id];
  assert.equal(cell.value, Date.UTC(2026, 10, 17), "2026-11-17T08:00:00.000+08:00 is that instant");
  assert.equal(snapshot.rows[1].values[date.id].value, Date.UTC(2026, 10, 18));
  // The page as a browser loads it: the date drawn as a date, not "—".
  const files = contractFiles({ schema, snapshot });
  const page = vm.createContext({ console });
  for (const name of [CONTRACT_FILES.data, CONTRACT_FILES.runtime]) vm.runInContext(files.get(`${CONTRACT_DIR}/${name}`), page);
  assert.equal(page.Table.rows()[0].text("签约日期"), new Date(Date.UTC(2026, 10, 17)).toLocaleDateString("zh-CN"));
  // The other kinds in the same table, as they came.
  const byName = (name) => snapshot.rows[0].values[schema.fields.find((field) => field.name === name).id];
  assert.equal(byName("金额").value, 44000);
  assert.equal(byName("区域").value, "华东", "a single select arrives as a one-item list");
  assert.equal(byName("客户").text, "客户12000 科技有限公司");
});

test("a date in a shape that is not certain is no date, never a guess", async () => {
  const at = async (value) => {
    const reader = { async fields() { return [{ id: "fldWhen", name: "日期", type: "datetime" }]; },
      async list() { return { records: [{ id: "rec0001", values: { fldWhen: value } }], more: false }; } };
    const { snapshot } = await readBaseSlice({ kind: "base", token: "bascnShape01", tableId: "tblShape01", fields: ["fldWhen"], rows: 10, refreshSeconds: 60 }, reader);
    return snapshot.rows[0].values.fldWhen.value;
  };
  assert.equal(await at(1789862400000), 1789862400000, "milliseconds, as the open API sends them");
  assert.equal(await at("1789862400000"), 1789862400000);
  assert.equal(await at(["2026-11-17T08:00:00.000+08:00"]), Date.UTC(2026, 10, 17), "inside a list");
  assert.equal(await at("2026-11-17T00:00:00Z"), Date.UTC(2026, 10, 17));
  assert.equal(await at("2026-11-17"), Date.UTC(2026, 10, 17), "a day alone is that day");
  assert.equal(await at("2026-11-17T08:00:00"), null, "no offset: this computer's zone would decide it");
  assert.equal(await at("2026/11/17"), null);
  assert.equal(await at("下周三"), null);
  assert.equal(await at(null), null);
  assert.equal(await at(-1), null);
});

// A site published before 10-06 holds its dates empty. Nothing in the table
// moves when this reader learns to read them, and no text changes either; what
// is behind the text does. It has to reach the site -- once, and without the
// site being taken for one whose table moves unannounced (site-refresh.js).
test("a cell changed only behind its text is sent again, and the table is not taken to have moved", async () => {
  const when = { kind: "base", token: "bascnShape01", tableId: "tblShape01", fields: ["fldWhen", "fldSite"], rows: 10, refreshSeconds: 60 };
  const reader = (site) => ({
    async fields() { return [{ id: "fldWhen", name: "签约日期", type: "datetime" }, { id: "fldSite", name: "官网", type: "url" }]; },
    async list() { return { records: [{ id: "rec0001", values: { fldWhen: "2026-11-17T08:00:00.000+08:00", fldSite: [{ text: "官网", link: site }] } }], more: false }; },
  });
  const render = (value) => Array.isArray(value) ? String(value[0]?.text ?? "") : String(value ?? "");
  const now = await readBaseSlice(when, reader("https://a.example/"), { renderCell: render });
  // What the reader before 10-06 made of the same table: the same text, no date behind it.
  const before = structuredClone(now.snapshot);
  before.rows[0].values.fldWhen.value = null;
  assert.equal(snapshotDigest({ fields: now.schema.fields, rows: before.rows }), now.snapshot.digest, "the table has not moved");
  assert.notEqual(contractKey(now.schema, before), contractKey(now.schema, now.snapshot), "but the site is sent its dates");
  // A link given a new address under the same words: the same.
  const moved = await readBaseSlice(when, reader("https://b.example/"), { renderCell: render });
  assert.equal(moved.snapshot.digest, now.snapshot.digest);
  assert.notEqual(contractKey(moved.schema, moved.snapshot), contractKey(now.schema, now.snapshot));
  // And nothing that is not shown: the same table read again is the same key.
  const again = await readBaseSlice(when, reader("https://a.example/"), { renderCell: render, now: () => 1 });
  assert.equal(contractKey(again.schema, again.snapshot), contractKey(now.schema, now.snapshot), "a read at another time is not a change");
});

// One field of every kind `base +field-list` names, recorded from a real Base
// with a second table its links point into (test/fixtures/base-field-shapes.json).
// Read as before 10-06: created and updated times as raw ISO text, creators as
// text, an auto number as a number with no value, several options as their
// first, a link to records as "（未展开内容）", a location likewise, an address
// as its Markdown, an empty number as 0, percentages as fractions, a time
// dropped -- and the columns in whatever order that call listed the fields.
const recordedBase = async () => {
  const shapes = JSON.parse(await readFile(new URL("./fixtures/base-field-shapes.json", import.meta.url), "utf8"));
  const answer = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const flag = (argv, name) => argv[argv.indexOf(name) + 1];
  const calls = [];
  const records = new SaasBaseRecords({ id: "saas-cli", async invoke(argv) {
    calls.push(argv[1]);
    if (argv.includes("+field-list")) return answer(shapes.fieldList);
    if (argv.includes("+record-list")) return answer({ ...shapes.recordList, has_more: false });
    if (argv.includes("+table-list")) return answer(shapes.tableList);
    if (argv.includes("+table-get")) return answer(flag(argv, "--table-id") === "tblShapeProjects" ? shapes.linkedTableGet : shapes.tableGet);
    if (argv.includes("+view-get-visible-fields")) return answer(shapes.visibleFields);
    if (argv.includes("+record-get")) {
      const wanted = argv.flatMap((value, index) => argv[index - 1] === "--record-id" ? [value] : []);
      const at = wanted.map((id) => shapes.linkedRecordGet.record_id_list.indexOf(id));
      return answer({ ...shapes.linkedRecordGet, record_id_list: wanted, data: at.map((index) => shapes.linkedRecordGet.data[index]) });
    }
    throw new Error(`not recorded: ${argv.join(" ")}`);
  } });
  const slice = { kind: "base", token: "bascnShapeTypes01", tableId: "tblShapeMain", fields: shapes.fieldList.fields.map((field) => field.id), rows: 100, refreshSeconds: 60 };
  return { shapes, records, slice, calls };
};

test("every kind of field a real Base has reads as Feishu shows it", async () => {
  const { records, slice } = await recordedBase();
  const { schema, snapshot } = await readBaseSlice(slice, records, { renderCell: (value) => baseCellText(value) });
  const field = (name) => schema.fields.find((item) => item.name === name);
  const cell = (row, name) => snapshot.rows[row].values[field(name).id];
  // In the table's own order, its primary field first.
  assert.deepEqual(schema.fields.slice(0, 6).map((item) => item.name), ["名称", "电话", "官网", "邮箱", "条码", "数量"]);
  assert.deepEqual(Object.fromEntries(["标签", "关联项目", "创建时间", "更新时间", "创建人", "修改人", "编号", "位置", "官网", "公式数字"].map((name) => [name, field(name).kind])),
    { 标签: "options", 关联项目: "options", 创建时间: "date", 更新时间: "date", 创建人: "people", 修改人: "people", 编号: "text", 位置: "text", 官网: "link", 公式数字: "text" });
  assert.deepEqual(cell(0, "标签").items, ["重点", "外部", "合同"], "every option, not the first");
  assert.deepEqual(cell(0, "关联项目").items, ["北极星迁移（改名）", "远山官网"], "linked records by their names");
  assert.equal(cell(0, "创建时间").value, Date.parse("2026-10-06T09:56:57.000+08:00"));
  assert.equal(cell(0, "更新时间").style, "datetime", "shown with its time, as the field is");
  assert.equal(cell(0, "开会时间").style, "datetime");
  assert.equal(cell(0, "截止日期").style, undefined, "a day is a day");
  assert.deepEqual(cell(0, "创建人").items, ["张晓明"]);
  assert.equal(cell(0, "编号").text, "T-001");
  assert.equal(cell(0, "位置").text, "天安门，北京东城长安街北侧", "a location reads as its address");
  assert.deepEqual([cell(0, "官网").text, cell(0, "官网").href], ["北极星官网", "https://example.com/beiji"], "Markdown, as a link");
  assert.deepEqual([cell(1, "官网").text, cell(1, "官网").href], ["https://example.org/page-1", "https://example.org/page-1"]);
  assert.deepEqual([cell(3, "占比").value, cell(3, "占比").style], [0.3, "percent"]);
  assert.equal(cell(3, "完成度").style, "percent", "a progress bar is a percentage");
  assert.equal(cell(3, "金额").style, "currency");
  assert.equal(snapshot.rows[6].values[field("名称").id].text, "空行 6");
  for (const name of ["数量", "金额", "占比", "评分"]) assert.equal(cell(6, name).value, null, `an empty ${name} is no number`);
  // The page as a browser loads it.
  const files = contractFiles({ schema, snapshot });
  const page = vm.createContext({ console });
  for (const name of [CONTRACT_FILES.data, CONTRACT_FILES.runtime]) vm.runInContext(files.get(`${CONTRACT_DIR}/${name}`), page);
  const row = (index) => page.Table.rows()[index];
  assert.equal(row(3).text("占比"), "30%");
  assert.equal(row(0).text("开会时间"), new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(Date.parse("2026-10-06T09:30:00.000+08:00"))));
  assert.equal(row(6).text("数量"), "", "not 0");
});

test("a link's names, and a formula's sources, are tables the probe asks about too", async () => {
  const { records, slice, calls } = await recordedBase();
  const { probe } = await readBaseSlice(slice, records, { renderCell: (value) => baseCellText(value) });
  // The table has formulas: every table of the Base is asked about.
  assert.equal(probe, "8:30|tblShapeProjects:2");
  calls.length = 0;
  assert.equal(await probeBaseSlice(slice, records, { probe }), probe, "nothing moved: the same, in one call");
  assert.deepEqual(calls, ["+table-list"]);
  // The linked table renamed a project: this table's revision stays where it was (measured live).
  const moved = { ...records, tableState: (token, table, options) => records.tableState(token, table, options).then((state) => ({ ...state, others: { ...state.others, tblShapeProjects: 3 } })) };
  assert.equal(await probeBaseSlice(slice, moved, { probe }), "8:30|tblShapeProjects:3", "read again");
  // A table gone, or a deployment that cannot say: nothing to compare.
  const gone = { ...records, tableState: (token, table, options) => records.tableState(token, table, options).then((state) => ({ ...state, others: { tblShapeProjects: null } })) };
  assert.equal(await probeBaseSlice(slice, gone, { probe }), null);
  // Without a link or a formula in the slice, only the table itself.
  const { shapes } = await recordedBase();
  const plain = shapes.fieldList.fields.filter((item) => ["text", "number"].includes(item.type)).map((item) => item.id);
  assert.equal((await readBaseSlice({ ...slice, fields: plain }, records)).probe, "8:30");
});

test("linked records that cannot be named are counted, never shown as unexpanded", async () => {
  const { records, slice } = await recordedBase();
  const refusing = Object.assign(Object.create(Object.getPrototypeOf(records)), records, { primaryField: async () => { throw new Error("没有权限"); } });
  const { schema, snapshot } = await readBaseSlice(slice, refusing, { renderCell: (value) => baseCellText(value) });
  const link = schema.fields.find((item) => item.name === "关联项目");
  assert.deepEqual(snapshot.rows[0].values[link.id].items, ["2 条记录"]);
  assert.equal(JSON.stringify(snapshot).includes("未展开内容"), false);
});
