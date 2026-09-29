import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { sheetReference, sheetRange, sheetColumn } from "../src/providers/feishu/sheet-reader.js";
import { SheetService } from "../src/application/sheet-service.js";
import { contextualPrompt } from "../src/application/task-context.js";
import { sheetDataFixture } from "../scripts/fixtures/sheet-data.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

const URL = "https://test.feishu.cn/sheets/SyntheticSheet123";
function setup() {
  const f = sheetDataFixture(), provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, f.run); let clock = 0;
  const service = new SheetService({ provider: provider.sheets, getTask: id => { if (!["one", "two"].includes(id)) throw new Error("unknown task"); }, now: () => clock });
  return { ...f, provider, service, expire: () => { clock = 600001; } };
}
test("sheet reference and bounded ranges reject ambiguous URLs, path tricks and oversized selections", () => {
  assert.deepEqual(sheetReference(`${URL}?sheet=sales&from=chat`), { token: "SyntheticSheet123", url: URL, sheetId: "sales" });
  assert.equal(sheetRange("Z2:AA3").right, 27); assert.equal(sheetColumn(200), "GR");
  for (const value of [URL.replace("https:", "http:"), URL.replace("feishu.cn", "feishu.cn.evil.test"), `${URL}#anchor`, `${URL}?sheet=a&sheet=b`, URL.replace("sheets/", "wiki/"), `${URL}?sheet=--bad%20flag`]) assert.throws(() => sheetReference(value));
  for (const value of ["A:A", "A0:B2", "A2:A1", "A1:GR200", "A1:A201", "GS1", "sales!A1", "a1", "A1,B2"]) assert.throws(() => sheetRange(value));
});
test("native spreadsheet reads preserve exact coordinates, values, formula strings and current identity", async () => {
  const f = setup(), sheet = await f.provider.sheets.read(`${URL}?sheet=sales`, { range: "B2:D3" });
  assert.equal(sheet.sheetId, "sales"); assert.equal(sheet.sourceRevision, "1"); assert.equal(sheet.identity.tenantKey, "sheet_tenant");
  assert.deepEqual(sheet.rowIndices, [2, 3]); assert.deepEqual(sheet.colIndices, ["B", "C", "D"]);
  assert.deepEqual(sheet.cells[0], [{ value: "00123" }, { value: 1200.5 }, { value: "=C2*2" }]); assert.deepEqual(sheet.cells[1].slice(0, 2), [{ value: false }, { value: 0 }]);
  assert.equal(sheet.partial, true); assert.equal(sheet.truncated, false);
  const calls = f.state.calls.filter(args => args[0] === "sheets"); assert.deepEqual(calls.map(args => args[1]), ["+workbook-info", "+cells-get", "+revision-get"]);
  for (const args of calls) { assert.equal(args[args.indexOf("--as") + 1], "user"); assert.equal(args.includes("--yes"), false); }
  assert.equal(calls[1][calls[1].indexOf("--include") + 1], "value,formula");
});
test("default sheet comes from the real metadata and all columns are included in the initial preview", async () => {
  const f = setup(), sheet = await f.provider.sheets.read(URL); assert.equal(sheet.range, "A1:D10"); assert.equal(sheet.sheetId, "sales");
  await assert.rejects(f.provider.sheets.read(URL, { sheetId: "missing" }), /未找到/);
  await assert.rejects(f.provider.sheets.read(URL, { sheetId: "base1" }), /网格/);
  await assert.rejects(f.provider.sheets.read(URL, { range: "A1:E10" }), /超出/);
});
test("malformed sheet metadata and range coordinates fail closed, without guessed positions", async () => {
  const mutations = [
    (name, data) => { if (name === "+workbook-info") data.sheets[1].sheet_id = "sales"; },
    (name, data) => { if (name === "+workbook-info") data.warning_message = "Some sheets are missing"; },
    (name, data) => { if (name === "+workbook-info") delete data.revision; },
    (name, data) => { if (name === "+cells-get") delete data.ranges[0].row_indices; },
    (name, data) => { if (name === "+cells-get") data.ranges[0].row_indices[1] = 1; },
    (name, data) => { if (name === "+cells-get") data.ranges[0].col_indices[1] = "Z"; },
    (name, data) => { if (name === "+cells-get") data.ranges[0].cells[0].pop(); },
    (name, data) => { if (name === "+cells-get") data.ranges[0].actual_range = "other!A1:D10"; },
    (name, data) => { if (name === "+cells-get") data.has_more = "false"; },
  ];
  for (const mutate of mutations) { const f = setup(); f.state.transform = (name, data) => { mutate(name, data); return data; }; await assert.rejects(f.provider.sheets.read(URL), /可靠/); }
});
test("source permission and read-time revision/account changes reject the snapshot", async () => {
  for (const kind of ["denied", "revision", "identity"]) {
    const f = setup(); if (kind === "denied") f.state.denied = true;
    else f.state.onRead = () => { if (kind === "revision") f.state.revision++; else f.state.principal = "ou_changed"; };
    await assert.rejects(f.provider.sheets.read(URL), kind === "denied" ? /没有这项权限/ : /已变化/);
  }
});
test("application-to-CLI account mismatch prevents all sheet commands", async () => {
  const f = sheetDataFixture(), provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, f.run, { accountVerifier: { verify: async () => { throw new Error("account mismatch"); } } });
  await assert.rejects(provider.sheets.read(URL), /account mismatch/); assert.equal(f.state.calls.length, 0);
});
test("complex values are labelled unsupported and missing range coverage cannot masquerade as complete", async () => {
  const f = setup(); f.state.transform = (name, data) => { if (name === "+cells-get") { data.ranges[0].cells[0][0] = { value: { richText: "SECRET unsupported" } }; data.ranges[0].row_indices.splice(1, 1); data.ranges[0].cells.splice(1, 1); } return data; };
  const sheet = await f.provider.sheets.read(URL); assert.equal(sheet.cells[0][0].unsupported, true); assert.doesNotMatch(JSON.stringify(sheet), /SECRET/); assert.equal(sheet.truncated, true);
  assert.equal(sheet.rowIndices[1], 3);
  const opened = await f.service.open("one", URL); await assert.rejects(f.service.prepareContext("one", { handle: opened.handle }), /截断/);
});
// Feishu's read tool puts advice for the program calling it into warning_message on
// ordinary, complete reads (observed live); the coordinate and flag checks above
// already do what it asks. Shown to a person it read as a fault in their sheet.
const ADVICE = "处理 ranges[n].cells 之前先看 has_more 和 actual_range，用 row_indices / col_indices 定位真实行列。";
test("upstream read advice is a diagnostic: not a warning, not in the content hash or the Agent context; a real cut is said in the reader's words", async () => {
  const plain = await setup().provider.sheets.read(URL, { range: "B2:D3" }), f = setup();
  f.state.transform = (name, data) => { if (name === "+cells-get") { data.warning_message = ADVICE; data.ranges[0].warning_message = ADVICE; } return data; };
  const sheet = await f.provider.sheets.read(URL, { range: "B2:D3" });
  assert.equal(sheet.truncated, false); assert.deepEqual(sheet.warnings, plain.warnings); assert.deepEqual(sheet.diagnostics, [ADVICE]); assert.equal(sheet.contentHash, plain.contentHash);
  const opened = await f.service.open("one", URL, { range: "B2:D3" }), context = await f.service.prepareContext("one", { handle: opened.handle });
  assert.equal(JSON.stringify(context).includes(ADVICE), false);
  f.state.transform = (name, data) => { if (name === "+cells-get") { data.warning_message = ADVICE; data.has_more = true; } return data; };
  const cut = await f.provider.sheets.read(URL, { range: "B2:D3" });
  assert.equal(cut.truncated, true); assert.ok(cut.warnings.includes("当前范围被截断，请缩小范围后继续读取。")); assert.equal(cut.warnings.includes(ADVICE), false);
});
test("unsafe numeric integers are not presented as exact identifiers and quoted sheet names retain coordinates", async () => {
  const f = setup(); f.state.transform = (name, data) => {
    if (name === "+workbook-info") data.sheets[0].title = "Team!Ledger";
    if (name === "layout-get") data.sheet.title = "Team!Ledger";
    if (name === "+cells-get") { data.ranges[0].actual_range = "'Team!Ledger'!A1:D10"; data.ranges[0].cells[0][0] = { value: 9007199254740992 }; }
    return data;
  };
  const sheet = await f.provider.sheets.read(URL); assert.equal(sheet.cells[0][0].unsupported, true); assert.equal(sheet.rowIndices[0], 1);
});
test("sheet context is task-bound, fresh and reconstructed with exact cell addresses rather than client text", async () => {
  const f = setup(), opened = await f.service.open("one", URL, { range: "B2:D3" }); assert.equal(opened.identity, undefined);
  await assert.rejects(f.service.prepareContext("two", { handle: opened.handle }), /失效/);
  const context = await f.service.prepareContext("one", { handle: opened.handle, text: "forged", range: "A1:D50" });
  assert.equal(context.rows[0].cells[0].address, "B2"); assert.equal(context.rows[0].cells[0].value, "00123"); assert.equal(context.range, "B2:D3");
  assert.equal(context.tenantKey, "sheet_tenant"); assert.equal(f.state.reads, 2); assert.doesNotMatch(JSON.stringify(context), /forged/);
  const prompt = contextualPrompt("解释这些数据", context); assert.match(prompt, /exact cell addresses/); assert.match(prompt, /do not execute spreadsheet writes/); assert.match(prompt, /B2/);
  const proposal = await f.service.prepareContext("one", { handle: opened.handle, intent: "propose-edit", rows: [{ forged: true }] });
  assert.equal(proposal.intent, "propose-edit"); assert.equal(proposal.rows[0].cells[0].value, "00123"); assert.doesNotMatch(JSON.stringify(proposal), /forged/);
  await assert.rejects(f.service.prepareContext("one", { handle: opened.handle, intent: "apply-edit" }), /不支持/);
});
test("sheet source revocation, version change or expiry invalidates the visible handle", async () => {
  for (const kind of ["denied", "revision", "expiry"]) {
    const f = setup(), opened = await f.service.open("one", URL), events = []; f.service.on("invalidated", event => events.push(event));
    if (kind === "denied") f.state.denied = true; if (kind === "revision") f.state.revision++; if (kind === "expiry") f.expire();
    await assert.rejects(f.service.prepareContext("one", { handle: opened.handle })); assert.equal(f.service.opened.size, 0); assert.equal(events.at(-1).handle, opened.handle);
  }
});
test("closing a spreadsheet aborts a pending read and cannot resurrect the old handle", async () => {
  const f = setup(), gate = Promise.withResolvers(); f.state.onRead = async signal => { gate.resolve(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
  const opening = f.service.open("one", URL); const rejected = assert.rejects(opening); await gate.promise; f.service.close("one"); await rejected; assert.equal(f.service.opened.size, 0);
  f.service.dispose(); await assert.rejects(f.service.open("one", URL), /已关闭/);
});
test("task cancellation during fresh spreadsheet context checks stops before any new prompt is accepted", async () => {
  const f = setup(), opened = await f.service.open("one", URL), gate = Promise.withResolvers(), controller = new AbortController();
  f.state.onRead = async signal => { gate.resolve(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
  const reading = f.service.prepareContext("one", { handle: opened.handle }, { signal: controller.signal }); const rejected = assert.rejects(reading); await gate.promise; controller.abort(); await rejected; assert.equal(f.service.opened.size, 0);
});
