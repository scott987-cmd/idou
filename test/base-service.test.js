import test from "node:test";
import assert from "node:assert/strict";
import { BaseService, describeBaseChange } from "../src/application/base-service.js";

// 多维表格引用的生命周期，和电子表格一样：十分钟句柄；发送前重读同一页，内容摘要和身份都没变才给出引用，变了就作废。
const LINK = "https://test.feishu.cn/base/IcTestBaseToken0000000001?table=tblTestTable0001";
function page(overrides = {}) {
  const fields = [{ id: "fld67C2JKj", name: "名称", type: "text", style: "plain", writable: true }, { id: "fldxmbuDTr", name: "数量", type: "number", style: "plain", writable: true }];
  const records = [{ id: "rec28b25lP00W8", cells: [{ fieldId: "fld67C2JKj", text: "探针记录一", value: "探针记录一" }, { fieldId: "fldxmbuDTr", text: "1", value: 1 }] }];
  return { kind: "feishu-base", providerId: "saas-cli", baseToken: "IcTestBaseToken0000000001", tableId: "tblTestTable0001", resourceId: "IcTestBaseToken0000000001:tblTestTable0001",
    sourceUrl: LINK, title: "飞书多维表格 · 数据表", tables: [{ id: "tblTestTable0001", name: "数据表" }], fields, records, offset: 0, limit: 20, more: false, truncated: false,
    sourceRevision: "abc", contentHash: "hash-1", identity: { principal: "p1", tenantKey: "t1", verifiedAt: 1 }, ...overrides };
}
function service(pages) {
  const calls = []; let now = 1000;
  const provider = { snapshot: async (reference, options) => { calls.push({ reference, options }); return pages.shift(); } };
  return { calls, svc: new BaseService({ provider, getTask: id => ({ id }), now: () => now }), tick: ms => { now += ms; } };
}

test("打开一页：返回句柄、不带身份；发送前重读同一页，没变才给出按记录和字段名排好的引用", async () => {
  const { svc, calls } = service([page(), page()]);
  const opened = await svc.open("task", LINK, { tableId: "tblTestTable0001" });
  assert.equal(opened.identity, undefined); assert.ok(opened.handle);
  const context = await svc.prepareContext("task", { handle: opened.handle, intent: "propose-edit" });
  assert.deepEqual([calls[1].options.tableId, calls[1].options.offset, calls[1].options.limit], ["tblTestTable0001", 0, 20]);
  assert.deepEqual([context.intent, context.principal, context.tenantKey], ["propose-edit", "p1", "t1"]);
  assert.deepEqual(context.rows, [{ record: "rec28b25lP00W8", cells: [{ field: "名称", fieldId: "fld67C2JKj", text: "探针记录一", value: "探针记录一" }, { field: "数量", fieldId: "fldxmbuDTr", text: "1", value: 1 }] }]);
  assert.deepEqual([context.tables, context.identity, context.records], [undefined, undefined, undefined]);
});

test("内容或身份变了、句柄过期、字段没读全、参数不认识：都不发送旧内容", async () => {
  const changed = service([page(), page({ contentHash: "hash-2" })]);
  const a = await changed.svc.open("task", LINK);
  await assert.rejects(changed.svc.prepareContext("task", { handle: a.handle }), /内容已变化/);
  assert.equal(changed.svc.opened.size, 0);

  const other = service([page(), page({ identity: { principal: "p2", tenantKey: "t1", verifiedAt: 2 } })]);
  const b = await other.svc.open("task", LINK);
  await assert.rejects(other.svc.prepareContext("task", { handle: b.handle }), /读取身份已变化/);

  const expired = service([page()]);
  const c = await expired.svc.open("task", LINK); expired.tick(10 * 60000);
  await assert.rejects(expired.svc.prepareContext("task", { handle: c.handle }), /已失效/);

  const cut = service([page({ truncated: true }), page({ truncated: true })]);
  const d = await cut.svc.open("task", LINK);
  await assert.rejects(cut.svc.prepareContext("task", { handle: d.handle, intent: "propose-edit" }), /没有读全/);

  const unknown = service([]);
  await assert.rejects(unknown.svc.open("task", LINK, { limit: 500 }), /参数无效/);
  assert.equal(unknown.calls.length, 0);
});

test("刷新前后哪里变了：说出是身份、字段、记录顺序还是哪条记录的哪个字段，从不带值", () => {
  const two = () => page({ records: [page().records[0], { id: "rec28b25lP01tm", cells: [{ fieldId: "fld67C2JKj", text: "探针记录二", value: "探针记录二" }, { fieldId: "fldxmbuDTr", text: "2", value: 2 }] }] });
  const base = two();
  assert.equal(describeBaseChange(base, two()), null);
  assert.match(describeBaseChange(base, { ...two(), identity: { principal: "p2", tenantKey: "t1" } }), /读取身份已变化/);
  assert.match(describeBaseChange(base, { ...two(), contentHash: "x", records: [...two().records].reverse() }), /记录顺序变了/);
  assert.match(describeBaseChange(base, { ...two(), contentHash: "x", records: two().records.slice(0, 1) }), /记录有增减/);
  assert.equal(describeBaseChange(base, { ...two(), fields: [...two().fields].reverse() }), null, "column order alone is not a change");
  assert.match(describeBaseChange(base, { ...two(), contentHash: "x", fields: two().fields.slice(0, 1) }), /字段有增减/);
  assert.match(describeBaseChange(base, { ...two(), contentHash: "x", fields: [{ ...two().fields[0], name: "标题" }, two().fields[1]] }), /字段名称或类型变了/);
  const edited = two(); edited.contentHash = "x"; edited.records[1].cells[1] = { fieldId: "fldxmbuDTr", text: "20", value: 20 };
  const said = describeBaseChange(base, edited);
  assert.match(said, /记录 rec28b25lP01tm 的「数量」变了/); assert.doesNotMatch(said, /20/);
  assert.match(describeBaseChange(base, { ...two(), contentHash: "x", more: true }), /分页状态变了/);
});
