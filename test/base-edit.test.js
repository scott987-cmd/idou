import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { SaasBaseRecords } from "../src/providers/feishu/base-records.js";
import { SaasBaseEdits, baseEditUpdate } from "../src/providers/feishu/base-edits.js";
import { BaseService } from "../src/application/base-service.js";
import { BaseEdits, undoableBaseEdit } from "../src/application/base-edit.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

// 多维表格写入：没有能用来发现他人写入的版本号（rev 读有延迟，批量更新只回忽略了哪些字段），
// 所以写前重读这些记录、逐字段核对原值，写后读回、逐字段核对新值；中间那一两秒里别人改同一字段会被覆盖，卡片会说明。
// 写完马上读，飞书可能还给写入前的值（实测），所以读回仍是旧值时隔几秒再读；一直是旧值就记为待核查，由人稍后重新核对。
const BASE = "IcTestBaseToken0000000001", TABLE = "tblTestTable0001";
const LINK = `https://test.feishu.cn/base/${BASE}?table=${TABLE}`;

function fakeBase() {
  const state = {
    calls: [], writes: 0, saved: [], onWrite: null, afterWrite: null, openId: "ou_edit", failReads: false, dryExtra: null, receipt: {}, waited: [], lag: 0, lagging: 0, served: null,
    names: { fld67C2JKj: "名称", fldxmbuDTr: "数量", fld7shKWyX: "状态" },
    records: { rec28b25lP00W8: { fld67C2JKj: "探针记录一", fldxmbuDTr: 1, fld7shKWyX: "待处理" }, rec28b25lP01tm: { fld67C2JKj: null, fldxmbuDTr: 2, fld7shKWyX: "进行中" } },
  };
  const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const all = (argv, name) => argv.flatMap((value, i) => argv[i - 1] === name ? [value] : []);
  // Record columns come in their own order, not the field list's.
  const order = ["fld67C2JKj", "fld7shKWyX", "fldxmbuDTr"];
  const columns = (ids, fieldIds = order, records = state.records) => ({ data: ids.map(id => fieldIds.map(fieldId => records[id][fieldId] ?? null)), fields: fieldIds.map(id => state.names[id]),
    field_id_list: fieldIds, field_type_list: fieldIds.map(id => id === "fldxmbuDTr" ? "number" : "text"), record_id_list: ids, has_more: false, rev: 3 });
  const run = async (_binary, argv) => {
    state.calls.push(argv);
    if (argv[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.openId, tenantKey: "tenant_edit", tokenStatus: "valid" } } }), stderr: "" };
    if (argv[0] !== "base") throw new Error(`fixture refuses ${argv.join(" ")}`);
    if (argv.includes("--help")) return { code: 0, stdout: `Usage: lark-cli base ${argv[1]}\n\nRisk: write\n`, stderr: "" };
    if (argv[1] === "+table-list") return ok({ tables: [{ id: TABLE, name: "数据表", records_count: 2, rev: 3 }], total: 1 });
    if (argv[1] === "+field-list") {
      return ok({ fields: [{ id: "fld67C2JKj", name: state.names.fld67C2JKj, type: "text", style: { type: "plain" } }, { id: "fldxmbuDTr", name: state.names.fldxmbuDTr, type: "number", style: { type: "plain" } },
        { id: "fld7shKWyX", name: state.names.fld7shKWyX, type: "text", style: { type: "plain" } }], total: 3 });
    }
    if (argv[1] === "+record-list") return ok(columns(Object.keys(state.records)));
    if (argv[1] === "+record-get") {
      if (state.afterWrite && state.writes > 0) { const next = state.afterWrite; state.afterWrite = null; next(state); }
      if (state.failReads) throw new Error("synthetic read failure");
      // Served from before the last write, as Feishu does for a while after one.
      const records = state.lagging > 0 ? (state.lagging -= 1, state.served) : state.records;
      const fields = all(argv, "--field-id");
      return ok(columns(all(argv, "--record-id").filter(id => records[id]), fields.length ? fields : undefined, records));
    }
    if (argv[1] === "+record-batch-update") {
      const update = JSON.parse(all(argv, "--json")[0]).update_records;
      if (argv.includes("--dry-run")) {
        return { code: 0, stdout: JSON.stringify({ ok: true, dry_run: true, data: { api: [{ method: "POST", url: `/open-apis/base/v3/bases/${BASE}/tables/${TABLE}/records/batch_update`,
          body: { update_records: { ...update, ...state.dryExtra } } }] } }), stderr: "" };
      }
      state.writes += 1;
      if (state.lag) Object.assign(state, { served: structuredClone(state.records), lagging: state.lag });
      const byName = Object.fromEntries(Object.entries(state.names).map(([id, name]) => [name, id]));
      for (const [record, fields] of Object.entries(update)) for (const [name, value] of Object.entries(fields)) state.records[record][byName[name]] = value;
      const extra = state.onWrite?.(state) ?? {};
      if (extra.lost) throw new Error("synthetic lost acknowledgement");
      return ok(state.receipt);
    }
    throw new Error(`fixture refuses ${argv[1]}`);
  };
  const provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, run);
  provider.baseRecords ??= new SaasBaseRecords(provider);
  return { state, provider };
}

async function fixture(changes = [{ record: "rec28b25lP00W8", field: "数量", value: 5 }, { record: "rec28b25lP01tm", field: "名称", value: "补上名称" }]) {
  const base = fakeBase(), task = { id: "task", status: "completed", messages: [] };
  const getTask = id => { assert.equal(id, task.id); return task; };
  const bases = new BaseService({ provider: base.provider.baseRecords, getTask });
  const opened = await bases.open(task.id, LINK);
  const context = await bases.prepareContext(task.id, { handle: opened.handle, intent: "propose-edit" });
  task.messages = [{ role: "user", text: "改一下数量和名称", context }, { id: "answer", role: "assistant", text: JSON.stringify({ kind: "feishu-base-edit", changes }) }];
  const edits = new BaseEdits({ bases, getTask, provider: new SaasBaseEdits(base.provider, { wait: async ms => { base.state.waited.push(ms); } }), saveTask: async value => { base.state.saved.push(structuredClone(value)); } });
  base.state.lastSaved = () => base.state.saved.at(-1)?.messages[1]?.baseEdit;
  return { ...base, task, bases, edits };
}
const written = state => state.calls.filter(argv => argv[1] === "+record-batch-update" && !argv.includes("--dry-run") && !argv.includes("--help"));

test("多维表格写入：写前核对这些字段的当前值，一次批量更新只含确认的记录和字段，逐条读回核验", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  assert.equal(f.state.writes, 0, "preparing writes nothing");
  assert.deepEqual(draft.changes.map(({ record, label, field, before, after }) => [record, label, field, before, after]),
    [["rec28b25lP00W8", "名称：探针记录一", "数量", 1, 5], ["rec28b25lP01tm", "状态：进行中", "名称", null, "补上名称"]]);
  f.state.onWrite = state => { assert.equal(state.lastSaved()?.state, "dispatching", "the intent is saved before the CLI writes"); };
  const result = await f.edits.apply(draft);
  assert.equal(result.state, "verified");
  const [update] = written(f.state);
  assert.deepEqual(JSON.parse(update[update.indexOf("--json") + 1]), { update_records: { rec28b25lP00W8: { "数量": 5 }, rec28b25lP01tm: { "名称": "补上名称" } } });
  assert.deepEqual([f.state.records.rec28b25lP00W8.fldxmbuDTr, f.state.records.rec28b25lP01tm.fld67C2JKj], [5, "补上名称"]);
  assert.equal(f.task.messages[1].baseEdit.state, "verified");
  assert.equal(f.bases.opened.size, 0, "the page on screen is dropped when the write goes out");
  await assert.rejects(f.edits.apply(draft), /已使用/);
  await assert.rejects(f.edits.prepare("task", "answer"), /已有写入记录/);
  assert.equal(f.state.writes, 1);
});

test("撤销：这些字段仍是写入后的值才写回原值（原来是空的就写回空），同样逐条读回；撤销只有一次", async () => {
  const f = await fixture();
  await f.edits.apply(await f.edits.prepare("task", "answer"));
  const undo = await f.edits.prepareUndo("task", "answer");
  assert.deepEqual(undo.changes.map(({ record, field, before, after }) => [record, field, before, after]), [["rec28b25lP00W8", "数量", 5, 1], ["rec28b25lP01tm", "名称", "补上名称", null]]);
  f.state.onWrite = state => { assert.equal(state.lastSaved()?.undo?.state, "dispatching"); };
  assert.equal((await f.edits.apply(undo)).state, "verified");
  assert.deepEqual([f.state.records.rec28b25lP00W8.fldxmbuDTr, f.state.records.rec28b25lP01tm.fld67C2JKj], [1, null]);
  await assert.rejects(f.edits.prepareUndo("task", "answer"), /已有撤销记录/);
});

test("确认之后值被改过、字段被改名、记录被删、身份变了、建议被回滚：写入前中止，一条都不写，也不留记录", async () => {
  const cases = [
    [f => { f.state.records.rec28b25lP00W8.fldxmbuDTr = 9; }, /在确认之后被改过/],
    [f => { f.state.names.fldxmbuDTr = "件数"; }, /已被改名或删除/],
    [f => { delete f.state.records.rec28b25lP01tm; }, /已经不在这张表里/],
    [f => { f.state.openId = "ou_someone_else"; }, /身份已变化/],
    [f => { f.task.messages = f.task.messages.slice(0, 1); }, /不在当前任务/],
  ];
  for (const [change, message] of cases) {
    const f = await fixture(), draft = await f.edits.prepare("task", "answer");
    change(f);
    await assert.rejects(f.edits.apply(draft), message);
    assert.equal(f.state.writes, 0); assert.equal(f.task.messages[1]?.baseEdit, undefined);
  }
});

test("飞书把数字存成了文本：照实标记为读回不一致；这种同值异型的不一致可以撤销，撤销以读回的值为准", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = state => { state.records.rec28b25lP00W8.fldxmbuDTr = "5"; };
  const result = await f.edits.apply(draft);
  assert.equal(result.state, "mismatch");
  assert.deepEqual(result.differences, [{ record: "rec28b25lP00W8", field: "数量", fieldId: "fldxmbuDTr", expected: 5, actual: "5" }]);
  assert.equal(undoableBaseEdit(f.task.messages[1].baseEdit), true);
  f.state.onWrite = null;
  const undo = await f.edits.prepareUndo("task", "answer");
  assert.deepEqual(undo.changes.map(({ field, before, after }) => [field, before, after]), [["数量", "5", 1], ["名称", "补上名称", null]]);
  assert.equal((await f.edits.apply(undo)).state, "verified");
});

test("读回的是另一个值、或者飞书说忽略了某些字段：照实标记，但不能在这里撤销", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = state => { state.records.rec28b25lP00W8.fldxmbuDTr = 7; };
  assert.equal((await f.edits.apply(draft)).state, "mismatch");
  await assert.rejects(f.edits.prepareUndo("task", "answer"), /不能在这里撤销/);

  const g = await fixture(), second = await g.edits.prepare("task", "answer");
  g.state.receipt = { ignored_fields: ["名称"] };
  assert.equal((await g.edits.apply(second)).state, "mismatch");
  assert.deepEqual(g.task.messages[1].baseEdit.ignored, ["名称"]);
  await assert.rejects(g.edits.prepareUndo("task", "answer"), /不能在这里撤销/);
});

test("写后读回滞后：读回仍是写入前的值就隔几秒再读，读到确认的值记为已核验；写入本身不重复", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.lag = 2;
  assert.equal((await f.edits.apply(draft)).state, "verified");
  assert.deepEqual(f.state.waited, [1000, 2000]);
  assert.equal(f.state.calls.filter(argv => argv[1] === "+record-get").length, 4, "one read before the write, three after it");
  assert.equal(f.state.writes, 1);
});

test("等完仍是写入前的值：记为结果待核查而不是读回不一致，不能撤销；稍后重新读回核对，读到确认的值才改记为已核验，才可以撤销", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.lag = 99;
  const result = await f.edits.apply(draft);
  assert.equal(result.state, "unknown");
  assert.deepEqual(f.state.waited, [1000, 2000, 3000, 4000, 5000]);
  assert.deepEqual(result.differences.map(({ record, field, actual, stale }) => [record, field, actual, stale]), [["rec28b25lP00W8", "数量", 1, true], ["rec28b25lP01tm", "名称", null, true]]);
  await assert.rejects(f.edits.prepareUndo("task", "answer"), /不能在这里撤销/);
  assert.equal((await f.edits.recheck("task", "answer")).state, "unknown", "still served from before the write");
  f.state.lagging = 0;
  assert.equal((await f.edits.recheck("task", "answer")).state, "verified");
  assert.equal(f.state.lastSaved()?.state, "verified");
  assert.equal(f.state.writes, 1, "checking again only reads");
  const undo = await f.edits.prepareUndo("task", "answer");
  f.state.lag = 0;
  assert.equal((await f.edits.apply(undo)).state, "verified");
  await assert.rejects(f.edits.recheck("task", "answer"), /没有需要重新核对/);
});

test("重新读回核对：读到另一个值仍记为不一致，不等待；身份变了、任务正在执行时不核对", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = state => { state.records.rec28b25lP00W8.fldxmbuDTr = 7; };
  assert.equal((await f.edits.apply(draft)).state, "mismatch");
  assert.deepEqual(f.state.waited, [], "a third value is not a lag");
  f.state.openId = "ou_someone_else";
  await assert.rejects(f.edits.recheck("task", "answer"), /身份已变化/);
  f.state.openId = "ou_edit"; f.task.status = "running";
  await assert.rejects(f.edits.recheck("task", "answer"), /任务结束/);
  f.task.status = "completed";
  const checked = await f.edits.recheck("task", "answer");
  assert.equal(checked.state, "mismatch");
  assert.deepEqual(checked.differences.map(({ field, expected, actual }) => [field, expected, actual]), [["数量", 5, 7]]);
  assert.equal(f.state.writes, 1);
});

test("写出去后没收到回执、或读回失败：记为结果不确定，不重试，也不能再次提交", async () => {
  const f = await fixture(), draft = await f.edits.prepare("task", "answer");
  f.state.onWrite = () => ({ lost: true });
  await assert.rejects(f.edits.apply(draft), /结果不确定/);
  assert.deepEqual([f.task.messages[1].baseEdit.state, f.state.lastSaved()?.state], ["unknown", "unknown"]);
  await assert.rejects(f.edits.prepare("task", "answer"), /已有写入记录/);
  assert.equal(f.state.writes, 1);

  const g = await fixture(), second = await g.edits.prepare("task", "answer");
  g.state.onWrite = state => { state.failReads = true; };
  await assert.rejects(g.edits.apply(second), /读回没有完成/);
  assert.equal(g.task.messages[1].baseEdit.state, "unknown");
});

test("CLI 预演出的请求和确认的不一样（多一条记录、多一个字段、值不同）：拒绝，连许可都不申请；同一字段两次、超过 10 条记录也拒绝", async () => {
  for (const extra of [{ rec28b25lP01HS: { "名称": "x" } }, { rec28b25lP00W8: { "数量": 5, "状态": "已完成" } }, { rec28b25lP00W8: { "数量": 6 } }]) {
    const f = await fixture(); f.state.dryExtra = extra;
    await assert.rejects(f.edits.prepare("task", "answer"), /预演出的写入请求与确认内容不一致/);
    assert.equal(f.state.writes, 0);
  }
  const change = (record, after) => ({ record, field: "数量", fieldId: "fldxmbuDTr", before: 1, after });
  assert.throws(() => baseEditUpdate([change("rec28b25lP00W8", 2), change("rec28b25lP00W8", 3)]), /无效/);
  assert.throws(() => baseEditUpdate(Array.from({ length: 11 }, (_, i) => change(`rec${String(i).padStart(11, "0")}`, 2))), /最多修改 10 条记录/);
});
