import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { SaasBaseRecords } from "../src/providers/feishu/base-records.js";
import { feishuCliSemanticRead, validateFeishuCliSemanticRead } from "../src/providers/feishu/cli-read-contract.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

// 多维表格的类型化读取。形状照测试多维表格实录：字段列表里类型是字符串、带 style；记录按列返回，
// 行的顺序跟着这次响应自己的字段列表，和字段列表接口的顺序不一样；文本是字符串，数字是数字。
const BASE = "IcTestBaseToken0000000001", TABLE = "tblTestTable0001";
const LINK = `https://test.feishu.cn/base/${BASE}?table=${TABLE}`;
const FIELDS = [
  { id: "fld67C2JKj", name: "名称", type: "text", style: { type: "plain" }, default_value: null },
  { id: "fldxmbuDTr", name: "数量", type: "number", style: { type: "plain", precision: 0, percentage: false, thousands_separator: false }, default_value: null },
  { id: "fld7shKWyX", name: "状态", type: "text", style: { type: "plain" }, default_value: null },
  { id: "fldOwner001", name: "负责人", type: "user", multiple: true },
  { id: "fldPhone001", name: "电话", type: "text", style: { type: "phone" } },
];
const COLUMNS = { fields: ["名称", "状态", "数量", "负责人", "电话"], field_id_list: ["fld67C2JKj", "fld7shKWyX", "fldxmbuDTr", "fldOwner001", "fldPhone001"], field_type_list: ["text", "text", "number", "user", "text"] };
const ROWS = {
  rec28b25lP00W8: ["探针记录一", "待处理", 1, [{ id: "ou_zhang", name: "张三" }], "+8613800000000"],
  rec28b25lP01tm: ["探针记录二", null, 2, [], null],
  rec28b25lP01HS: ["探针记录三", "进行中", 3, [], null],
};

function fakeBase({ answer = data => data } = {}) {
  const calls = [];
  const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data: answer(data) }), stderr: "" });
  const columnar = (ids, fieldIds = COLUMNS.field_id_list) => {
    const picks = fieldIds.map(id => COLUMNS.field_id_list.indexOf(id));
    return { data: ids.map(id => picks.map(i => ROWS[id][i])), fields: picks.map(i => COLUMNS.fields[i]), field_id_list: fieldIds,
      field_type_list: picks.map(i => COLUMNS.field_type_list[i]), record_id_list: ids, rev: 3, timezone: "Asia/Shanghai" };
  };
  const run = async (_binary, argv) => {
    calls.push(argv);
    if (argv[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: "ou_base", tenantKey: "tenant_base", tokenStatus: "valid" } } }), stderr: "" };
    const all = name => argv.flatMap((value, i) => argv[i - 1] === name ? [value] : []);
    if (argv[1] === "+table-list") return ok({ tables: [{ id: TABLE, name: "数据表", records_count: 3, rev: 3 }], total: 1 });
    if (argv[1] === "+field-list") return ok({ fields: FIELDS, total: FIELDS.length });
    if (argv[1] === "+record-list") {
      const offset = Number(all("--offset")[0]), limit = Number(all("--limit")[0]), ids = Object.keys(ROWS).slice(offset, offset + limit);
      return ok({ ...columnar(ids), has_more: offset + limit < Object.keys(ROWS).length, query_context: { field_scope: "all_fields", record_scope: "all_records" } });
    }
    if (argv[1] === "+record-get") {
      const ids = all("--record-id").filter(id => ROWS[id]), fields = all("--field-id");
      return ok({ ...columnar(ids, fields.length ? fields : undefined), has_more: false });
    }
    throw new Error(`fixture refuses ${argv.join(" ")}`);
  };
  return { calls, records: new SaasBaseRecords(new SaasFeishuCliProvider({ binary: STUB_CLI }, run)) };
}

test("多维表格一页：列按记录返回的顺序，格子按这次响应自己的字段标识对齐、保留类型；只有纯文本和数字可编辑", async () => {
  const f = fakeBase(), page = await f.records.snapshot(LINK, { limit: 2 });
  assert.deepEqual(page.fields.map(field => [field.name, field.writable]), [["名称", true], ["状态", true], ["数量", true], ["负责人", false], ["电话", false]]);
  const [first, second] = page.records;
  assert.equal(first.id, "rec28b25lP00W8");
  assert.deepEqual(first.cells.map(cell => cell.value ?? cell.text), ["探针记录一", "待处理", 1, "张三", "+8613800000000"]);
  assert.deepEqual([first.cells[3].unsupported, first.cells[4].unsupported], [true, true]);
  assert.deepEqual(second.cells.slice(0, 3).map(cell => cell.value), ["探针记录二", null, 2]);
  assert.deepEqual([page.more, page.truncated, page.sourceUrl], [true, false, LINK]);
  assert.ok(f.calls.filter(argv => argv[0] === "base").every(argv => argv.includes("--as") && argv.includes("user") && argv.includes("json")));
});

test("飞书的字段列表每次顺序可能不同（实测）：内容摘要不受列顺序影响，同一页读两次摘要不变", async () => {
  let call = 0;
  const f = fakeBase({ answer: data => Array.isArray(data.fields) && data.fields[0]?.id && !data.record_id_list ? { ...data, fields: ++call % 2 ? data.fields : [...data.fields].reverse() } : data });
  const first = await f.records.snapshot(LINK), second = await f.records.snapshot(LINK);
  assert.equal(call, 2);
  assert.equal(first.contentHash, second.contentHash);
  assert.deepEqual(first.fields.map(field => field.name), second.fields.map(field => field.name));
});

test("错位、重复或多出来的记录一律拒绝，不猜", async () => {
  for (const broken of [
    data => ({ ...data, data: data.data.slice(1) }),
    data => ({ ...data, record_id_list: [data.record_id_list[0], data.record_id_list[0]], data: data.data.slice(0, 2) }),
    data => ({ ...data, data: data.data.map(row => row.slice(1)) }),
    data => ({ ...data, field_id_list: ["fldUnknown01", ...data.field_id_list.slice(1)] }),
    data => ({ ...data, has_more: "yes" }),
  ]) {
    const f = fakeBase({ answer: data => Array.isArray(data.record_id_list) ? broken(data) : data });
    await assert.rejects(f.records.snapshot(LINK), /未展示可能错位/);
  }
});

test("按记录 ID 读：可以只取部分字段；飞书给了没要的记录就拒绝；不存在的记录只是不出现", async () => {
  const f = fakeBase();
  const page = await f.records.get(BASE, TABLE, ["rec28b25lP00W8", "recGone000001"], { fieldIds: ["fld67C2JKj", "fldxmbuDTr"] });
  assert.deepEqual(page.records, [{ id: "rec28b25lP00W8", values: { fld67C2JKj: "探针记录一", fldxmbuDTr: 1 } }]);
  const call = f.calls.find(argv => argv[1] === "+record-get");
  assert.deepEqual(call.filter((_, i) => call[i - 1] === "--field-id"), ["fld67C2JKj", "fldxmbuDTr"]);
  const g = fakeBase({ answer: data => data.record_id_list ? { ...data, record_id_list: ["rec28b25lP01tm"], data: [data.data[0]] } : data });
  await assert.rejects(g.records.get(BASE, TABLE, ["rec28b25lP00W8"]), /未展示可能错位/);
  await assert.rejects(f.records.get(BASE, TABLE, ["not-a-record"]), /记录标识无效/);
});

test("知识库包着的多维表格链接暂不支持：明确拒绝，不去读别的东西", async () => {
  const f = fakeBase();
  await assert.rejects(f.records.snapshot(`https://test.feishu.cn/wiki/${BASE}?table=${TABLE}`), /知识库里的多维表格链接暂不支持/);
  assert.equal(f.calls.length, 0);
});

test("控制面：按记录 ID 读是一个具名读取——只认记录 ID 列表和字段投影，别的形状、别的路径都不放行", () => {
  const PATH = `/open-apis/base/v3/bases/${BASE}/tables/${TABLE}/records/batch_get`;
  const read = (path, body) => {
    const entry = feishuCliSemanticRead("POST", path); if (!entry) return "not a read";
    try { validateFeishuCliSemanticRead(entry, Buffer.from(JSON.stringify(body))); return "allowed"; } catch { return "refused"; }
  };
  assert.equal(read(PATH, { record_id_list: ["rec28b25lP00W8"] }), "allowed");
  assert.equal(read(PATH, { record_id_list: ["rec28b25lP00W8", "rec28b25lP01tm"], select_fields: ["名称", "fldxmbuDTr"] }), "allowed");
  for (const body of [{}, { record_id_list: [] }, { record_id_list: ["x1"] }, { record_id_list: ["rec1a", "rec1a"] }, { record_id_list: Array.from({ length: 101 }, (_, i) => `rec${i}a`) },
    { record_id_list: ["rec1a"], select_fields: [] }, { record_id_list: ["rec1a"], select_fields: ["名\u0000称"] }, { record_id_list: ["rec1a"], filter: { conjunction: "and" } }]) {
    assert.equal(read(PATH, body), "refused", JSON.stringify(body).slice(0, 80));
  }
  for (const path of [`${PATH}?page_size=1`, PATH.replace("batch_get", "batch_update"), PATH.replace("batch_get", "batch_delete"), PATH.replace("batch_get", "search")]) {
    assert.equal(read(path, { record_id_list: ["rec1a"] }), "not a read", path);
  }
});
