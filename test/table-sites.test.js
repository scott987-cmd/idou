import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TableSites } from "../src/application/table-sites.js";
import { CONTRACT_DIR, CONTRACT_FILES } from "../src/application/table-contract.js";

const references = {
  base: (url) => { const found = /\/base\/([A-Za-z0-9]+)(?:\?table=(tbl[A-Za-z0-9]+))?/.exec(String(url)); if (!found) throw new Error("not a base"); return { appToken: found[1], tableId: found[2] ?? null, url }; },
  sheet: (url) => { const found = /\/sheets\/([A-Za-z0-9]+)/.exec(String(url)); if (!found) throw new Error("not a sheet"); return { token: found[1], url }; },
};
const baseRecords = {
  tables: async () => [{ id: "tblOne", name: "客户台账" }, { id: "tblTwo", name: "归档" }],
  fields: async (token, tableId) => tableId === "tblOne"
    ? [{ id: "fldName", name: "名称", type: "text" }, { id: "fldCount", name: "数量", type: "number" }, { id: "fldOwner", name: "负责人", type: "user" }]
    : [{ id: "fldOld", name: "旧字段", type: "text" }],
  list: async () => ({ records: [{ id: "rec1", values: { fldName: "探针一", fldCount: 1, fldOwner: "机密" } }], more: false }),
};
const sheets = {
  read: async () => ({ resourceId: "shtToken001", title: "飞书电子表格 · 台账", sheetId: "Sheet1",
    sheets: [{ id: "Sheet1", title: "台账" }, { id: "Sheet2", title: "备份" }],
    cells: [[{ value: "客户名" }, { value: "金额" }, { value: "" }]] }),
  readTable: async () => ({ sourceRevision: 7, rowIndices: [1, 2], colIndices: [1, 2], truncated: false,
    cells: [[{ value: "客户名" }, { value: "金额" }], [{ value: "甲" }, { value: 10 }]] }),
};
const sites = new TableSites({ baseRecords, sheets, references });
const BASE_URL = "https://test.feishu.cn/base/SyntheticBaseToken01?table=tblOne";

test("the picker reads structure only: which tables and which fields", async () => {
  const described = await sites.describe(BASE_URL);
  assert.equal(described.kind, "base");
  assert.equal(described.tableId, "tblOne");
  assert.equal(described.title, "客户台账");
  assert.deepEqual(described.tables.map((table) => table.name), ["客户台账", "归档"]);
  assert.deepEqual(described.fields.map((field) => [field.id, field.name, field.type]),
    [["fldName", "名称", "text"], ["fldCount", "数量", "number"], ["fldOwner", "负责人", "user"]]);
  // Another table of the same Base, without going back to the link.
  assert.deepEqual((await sites.describe(BASE_URL, { tableId: "tblTwo" })).fields.map((field) => field.id), ["fldOld"]);
  // A link with no table names the first one.
  assert.equal((await sites.describe("https://test.feishu.cn/base/SyntheticBaseToken01")).tableId, "tblOne");
});

test("a spreadsheet's columns come from its header row", async () => {
  const described = await sites.describe("https://test.feishu.cn/sheets/shtToken001");
  assert.equal(described.kind, "sheet");
  assert.equal(described.sheetId, "Sheet1");
  assert.deepEqual(described.sheets.map((sheet) => sheet.name), ["台账", "备份"]);
  assert.deepEqual(described.fields.map((field) => [field.id, field.name]), [["A", "客户名"], ["B", "金额"]], "an empty header is not a column");
});

test("a link that is neither is said plainly", async () => {
  await assert.rejects(() => sites.describe("https://test.feishu.cn/docx/Doc1"), /多维表格或电子表格的链接/);
});

test("building writes the contract, and only the confirmed fields reach it", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "idou-table-sites-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const built = await sites.build(folder, { kind: "base", token: "SyntheticBaseToken01", tableId: "tblOne",
    fields: ["fldName", "fldCount"], rows: 100, refreshSeconds: 60 }, { now: () => 42 });
  assert.deepEqual(built.paths, ["data/schema.json", "data/table-data.js", "data/table.js"]);
  assert.deepEqual(built.fields, ["名称", "数量"]);
  assert.equal(built.rowCount, 1);
  assert.equal(built.truncated, false);
  assert.equal(built.readAt, 42);
  assert.match(built.sliceId, /^[0-9a-f]{32}$/);
  const data = await readFile(path.join(folder, CONTRACT_DIR, CONTRACT_FILES.data), "utf8");
  assert.match(data, /探针一/);
  assert.equal(data.includes("机密"), false, "a field outside the slice never reaches the project");
  assert.equal(data.includes("fldOwner"), false);
});

test("a spreadsheet slice is built the same way", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "idou-table-sites-sheet-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const built = await sites.build(folder, { kind: "sheet", token: "shtToken001", sheetId: "Sheet1", columns: ["A", "B"], headerRow: 1, rows: 10, refreshSeconds: 300 });
  assert.deepEqual(built.fields, ["客户名", "金额"]);
  assert.equal(built.rowCount, 1);
  const schema = JSON.parse(await readFile(path.join(folder, CONTRACT_DIR, CONTRACT_FILES.schema), "utf8"));
  assert.equal(schema.source.kind, "sheet");
  assert.equal(schema.refreshSeconds, 300);
});

test("a slice the person never confirmed cannot be built", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "idou-table-sites-bad-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await assert.rejects(() => sites.build(folder, { kind: "base", token: "SyntheticBaseToken01", tableId: "tblOne", fields: [] }), /展示字段/);
  await assert.rejects(() => sites.build(folder, { kind: "base", token: "SyntheticBaseToken01", tableId: "tblOne", fields: ["fldName"], refreshSeconds: 1 }), /刷新间隔/);
});

test("a read is bracketed by who it is made as, and refuses a switch mid-read", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "idou-table-sites-who-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const seen = [];
  let principal = "p1";
  const watched = new TableSites({ baseRecords, sheets, references, identity: async () => { seen.push(principal); return { principal, tenantKey: "t1" }; } });
  const slice = { kind: "base", token: "SyntheticBaseToken01", tableId: "tblOne", fields: ["fldName"], rows: 10, refreshSeconds: 60 };
  await watched.build(folder, slice);
  assert.deepEqual(seen, ["p1", "p1"], "checked before the read and again after it");
  const switching = new TableSites({ baseRecords, sheets, references, identity: async () => ({ principal: `p${seen.push(1)}`, tenantKey: "t1" }) });
  await assert.rejects(() => switching.build(folder, slice), /身份已变化/);
  const refusing = new TableSites({ baseRecords, sheets, references, identity: async () => ({}) });
  await assert.rejects(() => refusing.build(folder, slice), /已核验的飞书身份/);
});

test("a spreadsheet is read by the link this deployment writes, not by a bare token", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "idou-table-sites-ref-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const asked = [];
  const watcher = { readTable: async (reference, options) => { asked.push({ reference, coverage: options.coverage }); return sheets.readTable(); } };
  const linked = new TableSites({ baseRecords, sheets: watcher, references,
    links: { sheet: (origin, token, sheetId) => `${origin}/sheets/${token}?sheet=${sheetId}` } });
  await linked.build(folder, { kind: "sheet", token: "shtToken001", sheetId: "Sheet1", origin: "https://example.feishu.cn",
    columns: ["A"], headerRow: 1, rows: 300, refreshSeconds: 300 });
  assert.equal(asked[0].reference, "https://example.feishu.cn/sheets/shtToken001?sheet=Sheet1");
  // The reader insists on being told how far to go; the slice already knows.
  assert.deepEqual(asked[0].coverage, { maxRows: 301, maxCells: 60_200, maxChars: 500_000 });
  // With no origin there is no link to build, and the token is passed as it was.
  const bare = new TableSites({ baseRecords, sheets: watcher, references });
  await bare.build(folder, { kind: "sheet", token: "shtToken001", sheetId: "Sheet1", columns: ["A"], headerRow: 1, rows: 10, refreshSeconds: 300 });
  assert.equal(asked[1].reference, "shtToken001");
});
