import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { SheetService } from "../src/application/sheet-service.js";
import { sheetEditProposal } from "../src/application/sheet-proposal.js";
import { mergeRelated } from "../src/providers/feishu/sheet-layout.js";
import { sheetDataFixture } from "../scripts/fixtures/sheet-data.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

const url = "https://test.feishu.cn/sheets/SyntheticSheet123?sheet=sales";
const merge = () => ({ start_row_index: 1, end_row_index: 2, start_column_index: 1, end_column_index: 2 });
function setup() {
  const f = sheetDataFixture(), provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, f.run), service = new SheetService({ provider: provider.sheets, getTask: () => ({}) });
  return { ...f, provider, service };
}
test("layout GET uses the exact selected identity/resource and preserves data while annotating merged cells", async () => {
  const f = setup(); f.state.merges = [merge()];
  const sheet = await f.provider.sheets.read(url, { range: "A1:D4" });
  assert.equal(sheet.layoutChecked, true); assert.equal(sheet.cells[1][1].value, "00123"); assert.equal(sheet.cells[1][1].mergeRelated, true);
  assert.equal(sheet.cells[2][2].mergeRelated, true); assert.equal(sheet.cells[3][3].mergeRelated, undefined);
  assert.deepEqual(f.state.calls.filter(args => args[0] === "api"), [["api", "GET", "/open-apis/sheets/v3/spreadsheets/SyntheticSheet123/sheets/sales", "--as", "user", "--format", "json"]]);
  assert.match(sheet.warnings.join(" "), /独立空白格/);
});
test("merge exclusion covers both possible end conventions and a clipped range cannot lose its outside anchor", async () => {
  const area = [{ startRowIndex: 1, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 3 }];
  for (const [row, column] of [[2, 2], [3, 3], [4, 4]]) assert.equal(mergeRelated(area, row, column), true);
  for (const [row, column] of [[1, 2], [2, 1], [5, 4], [4, 5]]) assert.equal(mergeRelated(area, row, column), false);
  const f = setup(); f.state.merges = [merge()]; const sheet = await f.provider.sheets.read(url, { range: "C3:D4" });
  assert.equal(sheet.cells[0][0].mergeRelated, true); assert.equal(sheet.cells[0][1].mergeRelated, undefined);
});
test("merged cells are excluded from native proposals, while other cells in the same sheet remain usable", async () => {
  const f = setup(); f.state.merges = [merge()]; const opened = await f.service.open("task", url, { range: "A1:D4" });
  const context = await f.service.prepareContext("task", { handle: opened.handle, intent: "propose-edit", mergeRelated: false });
  const proposal = address => JSON.stringify({ kind: "feishu-sheet-edit", changes: [{ address, value: "changed" }] });
  assert.throws(() => sheetEditProposal(proposal("B2"), context), /合并关联/);
  assert.equal(sheetEditProposal(proposal("A2"), context).changes[0].address, "A2");
});
test("layout metadata is checked against workbook selection and malformed or truncated merges fail closed", async () => {
  for (const mutate of [sheet => { sheet.sheet_id = "other"; }, sheet => { sheet.title = "other"; }, sheet => { sheet.hidden = true; }, sheet => { sheet.grid_properties.row_count++; }, sheet => { sheet.resource_type = "bitable"; }, sheet => { sheet.merges = {}; }, sheet => { sheet.merges = [null]; }, sheet => { sheet.merges = [{ ...merge(), start_row_index: -1 }]; }, sheet => { sheet.merges = [{ ...merge(), end_row_index: 0 }]; }, sheet => { sheet.merges = [{ ...merge(), end_column_index: 5 }]; }, sheet => { sheet.merges = [{ ...merge(), end_row_index: "2" }]; }, sheet => { sheet.merges = [merge(), merge()]; }]) {
    const f = setup(); f.state.transform = (name, data) => { if (name === "layout-get") mutate(data.sheet); return data; };
    await assert.rejects(f.provider.sheets.read(url), /布局未通过核验/); assert.equal(f.state.reads, 0);
  }
  for (const flag of ["has_more", "truncated", "warning_message"]) {
    const f = setup(); f.state.transform = (name, data) => { if (name === "layout-get") data[flag] = true; return data; }; await assert.rejects(f.provider.sheets.read(url), /布局未通过核验/);
  }
});
test("omitted merges means none by the public contract; metadata permission failure never falls back to cached cells", async () => {
  const f = setup(); f.state.transform = (name, data) => { if (name === "layout-get") delete data.sheet.merges; return data; };
  assert.equal((await f.provider.sheets.read(url)).cells.flat().some(cell => cell.mergeRelated), false);
  f.state.onLayout = () => { throw new Error("layout permission denied"); };
  await assert.rejects(f.provider.sheets.read(url), /permission denied/);
});
test("merge changes invalidate a previously opened proposal context and cancellation stops the layout read", async () => {
  const f = setup(), opened = await f.service.open("task", url);
  f.state.merges = [merge()];
  await assert.rejects(f.service.prepareContext("task", { handle: opened.handle, intent: "propose-edit" }), /已变化/); assert.equal(f.service.opened.size, 0);
  const gate = Promise.withResolvers();
  f.state.onLayout = async signal => { gate.resolve(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
  const pending = f.service.open("task", url), denied = assert.rejects(pending); await gate.promise; f.service.close("task"); await denied;
  assert.equal(f.service.opened.size, 0);
});
