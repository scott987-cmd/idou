// The table every template is shown with: in the picker's pictures, and in the
// demos somebody can open and click before choosing one.
//
// It is invented, and it is obviously invented -- 北极星科技 is nobody's client.
// That matters: a demo made from real data would leak whichever account built
// it, and a demo made from lorem would show nothing about what the page does
// with a person, a link or a sum. These are the field kinds a Feishu Base
// really has, so every template is seen doing the thing it is for.
//
// One copy, because a picture that disagreed with the demo beside it would be
// worse than either alone.
export const SAMPLE_FIELDS = Object.freeze([
  { id: "fldName", name: "客户名称", type: "text", writable: false },
  { id: "fldOwner", name: "负责人", type: "user", writable: false },
  { id: "fldState", name: "状态", type: "single_select", writable: false },
  { id: "fldDate", name: "签订日期", type: "date", writable: false },
  { id: "fldLink", name: "合同", type: "url", writable: false },
  { id: "fldPaid", name: "已回款", type: "checkbox", writable: false },
  { id: "fldSum", name: "金额（元）", type: "number", style: "currency", writable: false },
]);

export const SAMPLE_ROWS = Object.freeze([
  ["北极星科技", [{ name: "张三" }], "进行中", 1789862400000, { link: "https://example.com/a", text: "查看合同" }, false, 1285000],
  ["长风物流", [{ name: "李四" }, { name: "王五" }], "已回款", 1787270400000, { link: "https://example.com/b", text: "查看合同" }, true, 620000],
  ["海生医疗", [{ name: "赵六" }], "进行中", 1790467200000, { link: "https://example.com/c", text: "查看合同" }, false, 3157500],
  ["青木设计", [{ name: "孙七" }], "待签", 1791072000000, null, false, 248000],
  ["远山教育", [{ name: "周八" }], "已回款", 1786665600000, { link: "https://example.com/e", text: "查看合同" }, true, 880000],
  ["常青建筑", [{ name: "吴九" }, { name: "郑十" }], "进行中", 1788480000000, { link: "https://example.com/f", text: "查看合同" }, false, 4020000],
]);

export const SAMPLE_TITLE = "客户合同台账";
// Fixed, so a picture rebuilt next month is the same picture. A demo's own
// 上次更新 line would otherwise be today's date and the diff would be noise.
export const SAMPLE_READ_AT = Date.parse("2026-09-20T09:30:00+08:00");

// A reader shaped like the deployment's own `baseRecords` part, so the sample
// goes through exactly the code a real table does -- field kinds and all.
export const sampleRecords = () => ({
  fields: async () => SAMPLE_FIELDS.map((field) => ({ ...field })),
  list: async () => ({ records: SAMPLE_ROWS.map((row, index) => ({ id: `rec${index}`,
    values: Object.fromEntries(SAMPLE_FIELDS.map((field, at) => [field.id, row[at]])) })), more: false }),
});

export const SAMPLE_SLICE = Object.freeze({ kind: "base", token: "bascnSampleTableToken", tableId: "tblSample",
  fields: SAMPLE_FIELDS.map((field) => field.id), rows: 100, refreshSeconds: 60 });
