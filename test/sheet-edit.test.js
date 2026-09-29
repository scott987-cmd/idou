import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { sheetColumn } from "../src/providers/feishu/sheet-reader.js";
import { sheetEditRectangle } from "../src/providers/feishu/sheet-edits.js";
import { SheetService } from "../src/application/sheet-service.js";
import { SheetEdits } from "../src/application/sheet-edit.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

// 表格写入：+cells-set 没有「期望版本」参数，所以用实测过的两件事代替条件写入——每次写入版本号恰好 +1，
// 写入范围里 {} 的格子保持原样。写前重读这个矩形逐格核对原值；写后读回，逐格核对新值和其余格子；版本号
// 不是恰好 +1 就标记为期间有他人修改。
const TOKEN = "SyntheticSheetEdit123", SHEET = "sheet1";
const URL = `https://test.feishu.cn/sheets/${TOKEN}?sheet=${SHEET}`;
const columnIndex = letters => [...letters].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);

function fakeSheet() {
  const state = {
    revision: 7, calls: [], writes: 0, saved: [], onWrite: null, openId: "ou_edit", failReads: false, dryExtra: {},
    grid: [["编号", "金额", "状态", "备注"], ["00123", 1200.5, "履行中", null], ["00124", 800, "已完成", "首付款"]],
  };
  const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const flag = (argv, name) => argv[argv.indexOf(name) + 1];
  const run = async (_binary, argv) => {
    state.calls.push(argv);
    if (argv[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.openId, tenantKey: "tenant_edit", tokenStatus: "valid" } } }), stderr: "" };
    if (argv[0] === "api" && argv[1] === "GET" && argv[2] === `/open-apis/sheets/v3/spreadsheets/${TOKEN}/sheets/${SHEET}`) {
      return ok({ sheet: { sheet_id: SHEET, title: "合同台账", hidden: false, resource_type: "sheet", grid_properties: { row_count: 3, column_count: 4 }, merges: [] } });
    }
    if (argv[0] !== "sheets") throw new Error(`fixture refuses ${argv.join(" ")}`);
    if (argv.includes("--help")) return { code: 0, stdout: `Usage: lark-cli sheets ${argv[1]}\n\nRisk: write\n`, stderr: "" };
    if (argv[1] === "+workbook-info" && state.afterWrite) { const next = state.afterWrite; state.afterWrite = null; next(state); }
    if (argv[1] === "+workbook-info") return ok({ revision: state.revision, sheets: [{ sheet_id: SHEET, title: "合同台账", resource_type: "sheet", is_hidden: false, row_count: 3, column_count: 4 }] });
    if (argv[1] === "+revision-get") return ok({ revision: state.revision });
    if (argv[1] === "+cells-get") {
      if (state.failReads) throw new Error("synthetic read failure");
      const [, left, top, right, bottom] = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(flag(argv, "--range"));
      const rows = Array.from({ length: Number(bottom) - Number(top) + 1 }, (_, i) => Number(top) + i);
      const columns = Array.from({ length: columnIndex(right) - columnIndex(left) + 1 }, (_, i) => columnIndex(left) + i);
      return ok({ revision: state.revision, warning_message: "", has_more: false, ranges: [{ actual_range: flag(argv, "--range"), row_indices: rows, col_indices: columns.map(sheetColumn),
        cells: rows.map(row => columns.map(column => ({ value: state.grid[row - 1][column - 1] }))) }] });
    }
    if (argv[1] === "+cells-set") {
      const range = flag(argv, "--range"), cells = JSON.parse(flag(argv, "--cells"));
      if (argv.includes("--dry-run")) {
        return { code: 0, stdout: JSON.stringify({ ok: true, dry_run: true, data: { api: [{ method: "POST", url: `/open-apis/sheet_ai/v2/spreadsheets/${TOKEN}/tools/invoke_write`,
          body: { input: JSON.stringify({ cells, excel_id: TOKEN, range, sheet_id: flag(argv, "--sheet-id"), ...state.dryExtra }), tool_name: "set_cell_range" } }] } }), stderr: "" };
      }
      state.writes += 1;
      const [, left, top] = /^([A-Z]+)(\d+)/.exec(range);
      cells.forEach((line, i) => line.forEach((cell, j) => {
        if (!("value" in cell)) return; // {} leaves the cell as it was
        state.grid[Number(top) - 1 + i][columnIndex(left) - 1 + j] = cell.value === "" ? null : cell.value;
      }));
      state.revision += 1;
      const extra = state.onWrite?.(state) ?? {};
      if (extra.lost) throw new Error("synthetic lost acknowledgement");
      return ok({ revision: state.revision, updated_cells_count: cells.flat().length });
    }
    throw new Error(`fixture refuses ${argv[1]}`);
  };
  return { state, provider: new SaasFeishuCliProvider({ binary: STUB_CLI }, run) };
}

async function fixture(changes = [{ address: "A2", value: "00456" }, { address: "B3", value: 950 }]) {
  const sheet = fakeSheet(), task = { id: "task", status: "completed", messages: [] };
  const getTask = id => { assert.equal(id, task.id); return task; };
  const sheets = new SheetService({ provider: sheet.provider.sheets, getTask });
  const opened = await sheets.open(task.id, URL, { range: "A1:D3" });
  const context = await sheets.prepareContext(task.id, { handle: opened.handle, intent: "propose-edit" });
  task.messages = [{ role: "user", text: "修改编号和金额", context }, { id: "answer", role: "assistant", text: JSON.stringify({ kind: "feishu-sheet-edit", changes }) }];
  const edits = new SheetEdits({ sheets, getTask, provider: sheet.provider.sheetEdits, saveTask: async value => { sheet.state.saved.push(structuredClone(value)); } });
  sheet.state.lastSaved = () => sheet.state.saved.at(-1)?.messages[1]?.sheetEdit;
  return { ...sheet, task, sheets, edits };
}
const written = state => state.calls.filter(argv => argv[1] === "+cells-set" && !argv.includes("--dry-run") && !argv.includes("--help"));

test("逐格写入：写前核对原值，一次写入最小矩形（中间格子原样保留），读回核验，版本恰好加一", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  assert.equal(f.state.writes, 0, "preparing writes nothing");
  assert.equal(draft.range, "A2:B3");
  assert.deepEqual(draft.changes.map(({ address, before, after }) => [address, before, after]), [["A2", "00123", "00456"], ["B3", 800, 950]]);
  f.state.onWrite = state => { assert.equal(state.lastSaved()?.state, "dispatching", "the intent is saved before the CLI writes"); };
  const result = await f.edits.apply(draft);
  assert.equal(result.state, "verified"); assert.equal(result.revision, "8");
  assert.deepEqual(f.state.grid, [["编号", "金额", "状态", "备注"], ["00456", 1200.5, "履行中", null], ["00124", 950, "已完成", "首付款"]]);
  const [set] = written(f.state);
  assert.deepEqual(JSON.parse(set[set.indexOf("--cells") + 1]), [[{ value: "00456" }, {}], [{}, { value: 950 }]]);
  assert.equal(f.task.messages[1].sheetEdit.state, "verified");
  assert.equal(f.sheets.opened.size, 0, "the on-screen snapshot is dropped when the write goes out");
  await assert.rejects(f.edits.apply(draft), /已使用/);
  await assert.rejects(f.edits.prepare("task", "answer"), /已有写入记录/);
  assert.equal(f.state.writes, 1);
});

test("撤销：只有这些格子仍是写入后的值才写回原值，同样读回核验；撤销只有一次", async () => {
  const f = await fixture();
  await f.edits.apply(await f.edits.prepare("task", "answer"));
  const undo = await f.edits.prepareUndo("task", "answer");
  assert.equal(undo.kind, "undo"); assert.equal(undo.revision, "8");
  assert.deepEqual(undo.changes.map(({ address, before, after }) => [address, before, after]), [["A2", "00456", "00123"], ["B3", 950, 800]]);
  f.state.onWrite = state => { assert.equal(state.lastSaved()?.undo?.state, "dispatching"); };
  const result = await f.edits.apply(undo);
  assert.equal(result.state, "verified"); assert.equal(result.revision, "9");
  assert.deepEqual(f.state.grid[1], ["00123", 1200.5, "履行中", null]); assert.equal(f.state.grid[2][1], 800);
  await assert.rejects(f.edits.prepareUndo("task", "answer"), /已有撤销记录/);
});

test("撤销一个原本是空的格子：写回空值，读回确实为空", async () => {
  const f = await fixture([{ address: "D2", value: "补充备注" }]);
  assert.equal((await f.edits.apply(await f.edits.prepare("task", "answer"))).state, "verified");
  assert.equal(f.state.grid[1][3], "补充备注");
  const result = await f.edits.apply(await f.edits.prepareUndo("task", "answer"));
  assert.equal(result.state, "verified"); assert.equal(f.state.grid[1][3], null);
});

test("确认之后有人改了要写的格子：写入前的核对中止，一格都不写，也不留写入记录", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.grid[1][0] = "00999"; f.state.revision += 1;
  await assert.rejects(f.edits.apply(draft), /A2 在确认之后被改过/);
  assert.equal(f.state.writes, 0); assert.equal(f.task.messages[1].sheetEdit, undefined);
});

test("写入期间别人也写了（版本号跳了不止一）：照实标记为期间有他人修改", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = state => { state.grid[1][2] = "已暂停"; state.revision += 1; };
  const result = await f.edits.apply(draft);
  assert.equal(result.state, "conflict"); assert.equal(f.task.messages[1].sheetEdit.state, "conflict");
  await assert.rejects(f.edits.prepareUndo("task", "answer"), /不能在这里撤销/);
});

test("写入之后、读回之前又有人改了这些格子：分不清是谁的值，标记为期间有他人修改，不能在这里撤销", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = state => { state.afterWrite = next => { next.grid[1][0] = "00999"; next.revision += 1; }; };
  const result = await f.edits.apply(draft);
  assert.equal(result.state, "conflict"); assert.deepEqual([result.revision, f.task.messages[1].sheetEdit.readBackRevision], ["8", "9"]);
  await assert.rejects(f.edits.prepareUndo("task", "answer"), /不能在这里撤销/);
});

test("文本格式的格子把数字存成了文本（实测）：照实标记为读回不一致；撤销以读回的值为准，写回原来的文本", async () => {
  const f = await fixture([{ address: "A2", value: 456 }, { address: "B3", value: 950 }]), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = state => { state.grid[1][0] = "456"; };
  const result = await f.edits.apply(draft);
  assert.equal(result.state, "mismatch");
  assert.deepEqual(result.differences, [{ address: "A2", expected: 456, actual: "456", changed: true }]);
  f.state.onWrite = null;
  const undo = await f.edits.prepareUndo("task", "answer");
  assert.deepEqual(undo.changes.map(({ address, before, after }) => [address, before, after]), [["A2", "456", "00123"], ["B3", 950, 800]]);
  assert.equal((await f.edits.apply(undo)).state, "verified");
  assert.deepEqual([f.state.grid[1][0], f.state.grid[2][1]], ["00123", 800]);
});

test("读回时范围里没改的格子也变了：照实标记，但不能在这里撤销", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = state => { state.grid[1][1] = 1300; };
  const result = await f.edits.apply(draft);
  assert.equal(result.state, "mismatch");
  assert.deepEqual(result.differences, [{ address: "B2", expected: 1200.5, actual: 1300, changed: false }]);
  await assert.rejects(f.edits.prepareUndo("task", "answer"), /不能在这里撤销/);
});

test("写出去以后没收到回执：记为结果不确定，不重试，也不能再次提交", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = () => ({ lost: true });
  await assert.rejects(f.edits.apply(draft), /结果不确定/);
  assert.equal(f.task.messages[1].sheetEdit.state, "unknown");
  assert.equal(f.state.lastSaved()?.state, "unknown");
  await assert.rejects(f.edits.prepare("task", "answer"), /已有写入记录/);
  assert.equal(f.state.writes, 1);
});

test("写入之后有人又改了这些格子：撤销在核对时中止，不会覆盖别人的修改", async () => {
  const f = await fixture();
  await f.edits.apply(await f.edits.prepare("task", "answer"));
  const undo = await f.edits.prepareUndo("task", "answer");
  f.state.grid[2][1] = 999; f.state.revision += 1;
  await assert.rejects(f.edits.apply(undo), /B3 在确认之后被改过/);
  assert.equal(f.state.writes, 1); assert.equal(f.task.messages[1].sheetEdit.undo, undefined);
});

test("确认之后飞书身份变了：写入前中止，一格都不写", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.openId = "ou_someone_else";
  await assert.rejects(f.edits.apply(draft), /身份已变化/);
  assert.equal(f.state.writes, 0); assert.equal(f.task.messages[1].sheetEdit, undefined);
});

test("飞书回执了写入但读回失败：记为结果不确定，并留下回执里的版本号", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = state => { state.failReads = true; };
  await assert.rejects(f.edits.apply(draft), /已回执写入（版本 8）[\s\S]*读回没有完成/);
  assert.deepEqual([f.task.messages[1].sheetEdit.state, f.task.messages[1].sheetEdit.revision], ["unknown", "8"]);
  assert.equal(f.state.lastSaved()?.state, "unknown");
});

test("确认之后这条建议被回滚掉了：不写，也不把记录留在已经不存在的消息上", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.task.messages = f.task.messages.slice(0, 1);
  await assert.rejects(f.edits.apply(draft), /不在当前任务/);
  assert.equal(f.state.writes, 0);
});

test("CLI 预演出的请求多了东西（比如 copy_to_range）：拒绝，连许可都不申请", async () => {
  for (const extra of [{ copy_to_range: "A2:B100" }, { sheet_name: "Sheet2" }, { allow_overwrite: false }]) {
    const f = await fixture(); f.state.dryExtra = extra;
    await assert.rejects(f.edits.prepare("task", "answer"), /预演出的写入请求与确认内容不一致/);
    assert.equal(f.state.writes, 0);
  }
});

test("写入矩形：单格就是那一格，中间的格子是 {}，空值写成空字符串；太分散或重复的修改被拒绝", () => {
  assert.equal(sheetEditRectangle([{ address: "B2", before: 1, after: 2 }]).a1, "B2");
  const wide = sheetEditRectangle([{ address: "A1", before: "a", after: "b" }, { address: "C2", before: null, after: "c" }]);
  assert.equal(wide.a1, "A1:C2");
  assert.deepEqual(wide.cells, [[{ value: "b" }, {}, {}], [{}, {}, { value: "c" }]]);
  assert.deepEqual(sheetEditRectangle([{ address: "D2", before: "x", after: null }]).cells, [[{ value: "" }]]);
  assert.throws(() => sheetEditRectangle([{ address: "A1", before: 1, after: 2 }, { address: "A300", before: 1, after: 2 }]), /太散/);
  assert.throws(() => sheetEditRectangle([{ address: "A1", before: 1, after: 2 }, { address: "A1", before: 1, after: 3 }]), /两次/);
});
