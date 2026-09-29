import test from "node:test";
import assert from "node:assert/strict";
import { baseEditProposal } from "../src/application/base-proposal.js";
import { contextualPrompt } from "../src/application/task-context.js";

// 多维表格修改建议只是惰性数据：记录要在读到的这一页里，字段要可编辑（纯文本或数字），类型要对，值要确实变了。
const context = (patch = {}) => ({ kind: "feishu-base", intent: "propose-edit", truncated: false, sourceUrl: "https://test.feishu.cn/base/IcTestBaseToken0000000001?table=tblTestTable0001",
  fields: [{ id: "fld67C2JKj", name: "名称", type: "text", style: "plain", writable: true }, { id: "fldxmbuDTr", name: "数量", type: "number", style: "plain", writable: true },
    { id: "fldOwner001", name: "负责人", type: "user", writable: false }],
  rows: [
    { record: "rec28b25lP00W8", cells: [{ field: "名称", fieldId: "fld67C2JKj", text: "探针记录一", value: "探针记录一" }, { field: "数量", fieldId: "fldxmbuDTr", text: "1", value: 1 }, { field: "负责人", fieldId: "fldOwner001", text: "张三", unsupported: true }] },
    { record: "rec28b25lP01tm", cells: [{ field: "名称", fieldId: "fld67C2JKj", text: "", value: null }, { field: "数量", fieldId: "fldxmbuDTr", text: "2", value: 2 }, { field: "负责人", fieldId: "fldOwner001", text: "", unsupported: true }] },
  ], ...patch });
const proposal = changes => JSON.stringify({ kind: "feishu-base-edit", changes });

test("多维表格修改建议：记录在这一页、字段可编辑、类型对、值确实变了，原样通过；再校验一遍结果不变", () => {
  const changes = [{ record: "rec28b25lP00W8", field: "名称", value: "探针记录一（已核对）" }, { record: "rec28b25lP01tm", field: "数量", value: 20.5 }, { record: "rec28b25lP01tm", field: "名称", value: "补上名称" }];
  const result = baseEditProposal(proposal(changes), context());
  assert.deepEqual(result, { kind: "feishu-base-edit", changes });
  assert.deepEqual(baseEditProposal(JSON.stringify(result), context()), result);
});

test("不在这一页、不可编辑、类型不对、没变、清空、重复、多出来的键、意图不对：都被拒绝", () => {
  const control = `带${String.fromCharCode(7)}控制符`;
  const bad = [
    [], [{ record: "recNotOnPage01", field: "名称", value: "x" }], [{ record: "rec28b25lP00W8", field: "负责人", value: "李四" }],
    [{ record: "rec28b25lP00W8", field: "不存在", value: "x" }], [{ record: "rec28b25lP00W8", field: "数量", value: "3" }], [{ record: "rec28b25lP00W8", field: "名称", value: 3 }],
    [{ record: "rec28b25lP00W8", field: "数量", value: 1 }], [{ record: "rec28b25lP00W8", field: "名称", value: "" }], [{ record: "rec28b25lP00W8", field: "名称", value: null }],
    [{ record: "rec28b25lP00W8", field: "名称", value: "a" }, { record: "rec28b25lP00W8", field: "名称", value: "b" }],
    [{ record: "rec28b25lP00W8", field: "名称", value: "x", fieldId: "fld67C2JKj" }], [{ record: "rec28b25lP00W8", field: "数量", value: Number.MAX_SAFE_INTEGER + 1 }],
    [{ record: "rec28b25lP00W8", field: "名称", value: "x".repeat(2001) }], [{ record: "rec28b25lP00W8", field: "名称", value: control }],
  ];
  for (const changes of bad) assert.throws(() => baseEditProposal(proposal(changes), context()), /多维表格建议无效/, JSON.stringify(changes).slice(0, 80));
  for (const patch of [{ intent: undefined }, { kind: "feishu-sheet" }, { truncated: true }]) {
    assert.throws(() => baseEditProposal(proposal([{ record: "rec28b25lP00W8", field: "名称", value: "x" }]), context(patch)), /多维表格建议无效/);
  }
  const many = Array.from({ length: 11 }, (_, i) => `rec${String(i).padStart(11, "0")}`);
  const wide = context({ rows: many.map(record => ({ record, cells: [{ field: "名称", fieldId: "fld67C2JKj", text: "a", value: "a" }] })) });
  assert.throws(() => baseEditProposal(proposal(many.map(record => ({ record, field: "名称", value: "b" }))), wide), /多维表格建议无效/, "at most 10 records");
  assert.equal(baseEditProposal(proposal(many.slice(0, 10).map(record => ({ record, field: "名称", value: "b" }))), wide).changes.length, 10);
});

test("提示词：修改建议只要 JSON、只改可编辑字段；分析时说明这只是一页、不能据此写入", () => {
  const propose = contextualPrompt("把名称改一下", context());
  assert.match(propose, /"kind":"feishu-base-edit"/); assert.match(propose, /writable/); assert.match(propose, /Do not use tools or write to Feishu/);
  const analyse = contextualPrompt("总结一下", context({ intent: undefined }));
  assert.match(analyse, /one page/); assert.match(analyse, /Do not write to Feishu/);
});
