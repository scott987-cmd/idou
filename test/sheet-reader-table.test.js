import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { sheetColumn, isTableNote } from "../src/providers/feishu/sheet-reader.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

// 一张几千行的台账，按页读、只认一个版本。假的 CLI 只回答读操作，任何写都会报错。
const URL = "https://test.feishu.cn/sheets/BigLedger12345?sheet=ledger";
const HEADER = ["合同编号", "客户", "金额", "签订日期", "到期日", "状态"];
const valueAt = (row, column) => row === 1 ? HEADER[column - 1]
  : [`QL-HT-2026-${String(row).padStart(4, "0")}`, `客户${row % 37}`, row * 10, "2026-01-01", `2026-${String((row % 12) + 1).padStart(2, "0")}-15`, row % 3 ? "履约中" : "已结清"][column - 1];

function bigSheet({ rows = 3000, columns = 6, onCells = null, merges = [], transform = null } = {}) {
  const state = { revision: 7, calls: [], cellsRead: 0 };
  const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const run = async (_binary, argv) => {
    state.calls.push(argv);
    if (argv[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: "ou_big", tenantKey: "tenant_big", tokenStatus: "valid" } } }), stderr: "" };
    if (argv[0] === "api" && argv[1] === "GET" && argv[2] === "/open-apis/sheets/v3/spreadsheets/BigLedger12345/sheets/ledger") {
      return ok({ sheet: { sheet_id: "ledger", title: "合同台账", hidden: false, resource_type: "sheet", grid_properties: { row_count: rows, column_count: columns }, merges } });
    }
    if (argv[0] !== "sheets") throw new Error(`fixture refuses ${argv.join(" ")}`);
    if (argv[1] === "+workbook-info") return ok({ revision: state.revision, sheets: [{ sheet_id: "ledger", title: "合同台账", resource_type: "sheet", is_hidden: false, row_count: rows, column_count: columns }] });
    if (argv[1] === "+revision-get") return ok({ revision: state.revision });
    if (argv[1] === "+cells-get") {
      state.cellsRead += 1;
      onCells?.(state);
      const requested = argv[argv.indexOf("--range") + 1];
      const [, left, top, right, bottom] = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(requested);
      const index = (letters) => [...letters].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
      const rowIndices = Array.from({ length: Number(bottom) - Number(top) + 1 }, (_, i) => Number(top) + i);
      const colIndices = Array.from({ length: index(right) - index(left) + 1 }, (_, i) => sheetColumn(index(left) + i));
      const data = { revision: state.revision, warning_message: "", has_more: false, ranges: [{ actual_range: requested, row_indices: rowIndices, col_indices: colIndices,
        cells: rowIndices.map((row) => colIndices.map((_, column) => ({ value: valueAt(row, index(left) + column) }))) }] };
      transform?.(data, Number(top));
      return ok(data);
    }
    throw new Error(`fixture refuses ${argv[1]}`);
  };
  return { state, reader: new SaasFeishuCliProvider({ binary: STUB_CLI }, run).sheets };
}
const COVERAGE = { maxRows: 5000, maxCells: 100_000, maxChars: 450_000 };

test("三千行的台账按页读全，一次版本、一次布局，每页不超过 200 行", async () => {
  const f = bigSheet();
  const table = await f.reader.readTable(URL, { coverage: COVERAGE });
  assert.equal(table.rowIndices.length, 3000);
  assert.deepEqual([table.rowIndices[0], table.rowIndices.at(-1)], [1, 3000]);
  assert.deepEqual(table.colIndices, ["A", "B", "C", "D", "E", "F"]);
  assert.equal(table.cells[2733][0].value, "QL-HT-2026-2734", "第 2734 行必须真的在副本里");
  assert.equal(table.truncated, false);
  assert.equal(table.sourceRevision, "7");
  const names = f.state.calls.filter((argv) => argv[0] === "sheets").map((argv) => argv[1]);
  assert.equal(names.filter((name) => name === "+workbook-info").length, 1);
  assert.equal(names.filter((name) => name === "+revision-get").length, 1);
  assert.equal(f.state.cellsRead, 15, "3000 行 ÷ 每页 200 行");
  for (const argv of f.state.calls.filter((item) => item[1] === "+cells-get")) {
    const [, top, bottom] = /^A(\d+):F(\d+)$/.exec(argv[argv.indexOf("--range") + 1]);
    assert.ok(Number(bottom) - Number(top) + 1 <= 200, "单页不能超过 200 行");
  }
});

test("读到一半表格被人改了，整次读取作废，不拼接两个版本", async () => {
  const f = bigSheet({ onCells: (state) => { if (state.cellsRead === 7) state.revision = 8; } });
  await assert.rejects(f.reader.readTable(URL, { coverage: COVERAGE }), /版本已变化/);
});

test("正文会超过一页知识副本的上限时，读到哪算哪，并如实说只整理了前多少行", async () => {
  const f = bigSheet();
  const table = await f.reader.readTable(URL, { coverage: { ...COVERAGE, maxChars: 20_000 } });
  assert.equal(table.truncated, true);
  assert.ok(table.rowIndices.length > 0 && table.rowIndices.length < 3000);
  assert.ok(table.warnings.some((line) => line.includes(`只整理了前 ${table.rowIndices.length} 行`)), table.warnings.join(" / "));
});

// 飞书读取工具在每页的 warning_message 里写的是给调用程序的用法提示（先看 has_more，按 row_indices /
// col_indices 定位），完整读取也照样带着。读取器本来就这样核对；它说的不是这张表，不能当成表格的提示。
const ADVICE = "处理 ranges[n].cells 之前先看 has_more 和 actual_range，用 row_indices / col_indices 定位真实行列。";

test("每页附带的用法提示只留作诊断：不进提示，不改内容指纹，同样的话只记一次", async () => {
  const plain = await bigSheet({ rows: 450 }).reader.readTable(URL, { coverage: COVERAGE });
  const f = bigSheet({ rows: 450, transform: (data) => { data.warning_message = ADVICE; data.ranges[0].warning_message = ADVICE; } });
  const table = await f.reader.readTable(URL, { coverage: COVERAGE });
  assert.equal(f.state.cellsRead, 3);
  assert.equal(table.truncated, false);
  assert.deepEqual(table.warnings, []);
  assert.deepEqual(table.diagnostics, [ADVICE]);
  assert.equal(table.contentHash, plain.contentHash, "同样的单元格、同一个版本，就是同一份内容");
});

test("飞书真的截断时由读取器自己说；整表读取写下的每条提示，核验已存副本时都认得出来", async () => {
  const f = bigSheet({
    merges: [{ start_row_index: 0, end_row_index: 0, start_column_index: 0, end_column_index: 1 }],
    transform: (data, top) => {
      data.warning_message = ADVICE;
      if (top === 1) data.ranges[0].cells[1][2] = { value: { richText: [] } };
      if (top === 401) data.has_more = true;
    },
  });
  const table = await f.reader.readTable(URL, { coverage: COVERAGE });
  assert.equal(table.truncated, true);
  assert.equal(f.state.cellsRead, 3, "被截断的那一页之后不再往下读");
  assert.equal(table.warnings.length, 3, table.warnings.join(" / "));
  assert.match(table.warnings[0], /^只整理了前 600 行、6 列；表格共 3000 行 × 6 列/);
  // 认不出自己写的提示，副本就永远过不了版本号核验，每次提问都要把整张表重读一遍。
  assert.ok(table.warnings.every(isTableNote), table.warnings.join(" / "));
  assert.equal(isTableNote(ADVICE), false);
  assert.deepEqual(table.diagnostics, [ADVICE]);
});

test("核对版本只发一个请求，不读任何单元格", async () => {
  const f = bigSheet();
  const current = await f.reader.revision(URL);
  assert.equal(current.revision, "7");
  assert.equal(current.identity.tenantKey, "tenant_big");
  assert.equal(f.state.cellsRead, 0);
  assert.deepEqual(f.state.calls.filter((argv) => argv[0] === "sheets").map((argv) => argv[1]), ["+revision-get"]);
});
