import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { CLI_WRITE_FAMILIES, canonicalJson, cliWriteFamily, deletionArgv, isDeletionArgv, isDestructiveRequest, parseCliWritePlan, validateCliWriteArgv } from "../src/providers/feishu/cli-write-plan.js";
import { SaasCliWriter, approveDeletion, approveDeletionForFullAccess, describeCliWrite } from "../src/providers/feishu/cli-writer.js";
import { feishuCliWriteIntent, validateFeishuCliWriteRequest, FEISHU_CLI_WRITE_ACTIONS, feishuCliWriteCapabilities } from "../src/providers/feishu/cli-write-contract.js";
import { agentFeishuActions } from "../src/application/agent-feishu-actions.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const GUID = "61ef00b1-063b-4cf0-8cb5-e81f4bf73624";
const SHEET = "/open-apis/sheet_ai/v2/spreadsheets/shtX/tools/invoke_write";
const RECORDS = "/open-apis/base/v3/bases/bascnX/tables/tblX/records";
const sheet = (tool, input) => ({ input: JSON.stringify({ excel_id: "shtX", sheet_name: "Sheet1", ...input }), tool_name: tool });

// Every body below was recorded from the pinned CLI with --dry-run.
const DESTRUCTIVE_SHEETS = {
  "+cells-clear": sheet("clear_cell_range", { clear_type: "contents", range: "A1:B2" }),
  "+dim-delete": sheet("modify_sheet_structure", { operation: "delete", range: "3:7" }),
  "+sheet-delete": sheet("modify_workbook_structure", { operation: "delete" }),
  "+chart-delete": sheet("manage_chart_object", { chart_id: "c1", operation: "delete" }),
  "+float-image-delete": sheet("manage_float_image_object", { float_image_id: "i1", operation: "delete" }),
  "+pivot-delete": sheet("manage_pivot_table_object", { pivot_table_id: "p1", operation: "delete" }),
  "+filter-delete": sheet("manage_filter_object", { filter_id: "s1", operation: "delete", sheet_id: "s1" }),
  "+history-revert": sheet("history_revert", { history_version_id: "3" }),
  "+cells-batch-clear": sheet("batch_update", { operations: [{ input: { clear_type: "contents", range: "A1:B2" }, tool_name: "clear_cell_range" }] }),
};
const ORDINARY_SHEETS = {
  "+cells-set": sheet("set_cell_range", { cells: [[{ value: "x" }]], range: "A1" }),
  "+csv-put": sheet("set_range_from_csv", { csv: "a,b", start_cell: "A1" }),
  "+dim-hide": sheet("modify_sheet_structure", { operation: "hide", range: "3:4" }),
  "+dim-ungroup": sheet("modify_sheet_structure", { operation: "ungroup", range: "3:4" }),
  "+cells-unmerge": sheet("merge_cells", { operation: "unmerge", range: "A1:B2" }),
};

test("every request that deletes, clears, reverts or overwrites is classified destructive, by one rule", () => {
  // A family that can DELETE, or whose path deletes, is destructive by definition.
  for (const family of CLI_WRITE_FAMILIES) {
    if (family.methods.includes("DELETE") || /delete/.test(family.pattern.source)) assert.equal(family.destructive, true, family.id);
  }
  for (const [command, body] of Object.entries(DESTRUCTIVE_SHEETS)) assert.equal(isDestructiveRequest("POST", SHEET, body), true, command);
  for (const [command, body] of Object.entries(ORDINARY_SHEETS)) assert.equal(isDestructiveRequest("POST", SHEET, body), false, command);
  // A body that cannot be read is not waved through as an ordinary write.
  assert.equal(isDestructiveRequest("POST", SHEET, { input: "{not json", tool_name: "set_cell_range" }), true);
  const doc = "/open-apis/docs_ai/v1/documents/doxcnX";
  assert.equal(isDestructiveRequest("PUT", doc, { block_id: "b1", command: "block_delete", format: "xml", revision_id: -1 }), true);
  assert.equal(isDestructiveRequest("PUT", doc, { command: "overwrite", content: "<p>x</p>", format: "xml", revision_id: -1 }), true);
  for (const command of ["block_replace", "block_insert_after", "append", "block_move_after"]) assert.equal(isDestructiveRequest("PUT", doc, { command }), false, command);
  assert.equal(isDestructiveRequest("POST", `${RECORDS}/batch_delete`, { record_id_list: ["rec1"] }), true);
  assert.equal(isDestructiveRequest("POST", `${RECORDS}/batch_create`, { records: [] }), false);
  assert.equal(isDestructiveRequest("DELETE", `/open-apis/task/v2/tasks/${GUID}`, null), true);
  assert.equal(isDestructiveRequest("DELETE", "/open-apis/calendar/v4/calendars/primary/events/e1_0?need_notification=true", null), true);
});

test("the Agent cannot reach a deletion endpoint directly or answer the CLI's own high-risk gate", () => {
  assert.throws(() => validateCliWriteArgv(["api", "DELETE", `/open-apis/task/v2/tasks/${GUID}`]), /不允许 api 直连端点|只允许这些飞书 CLI 领域/);
  assert.throws(() => validateCliWriteArgv(["base", "+record-delete", "--base-token", "b", "--table-id", "t", "--record-id", "rec1", "--yes"]), /高风险确认不能由 Agent 代答/);
  assert.throws(() => validateCliWriteArgv(["base", "+record-delete", "--yes=true"]), /高风险确认不能由 Agent 代答/);
  // The application's own deletion commands are fixed; only the id varies, and only within its shape.
  assert.deepEqual([...deletionArgv("task", GUID)], ["api", "DELETE", `/open-apis/task/v2/tasks/${GUID}`]);
  assert.deepEqual([...deletionArgv("event", "e1_0")], ["api", "DELETE", "/open-apis/calendar/v4/calendars/primary/events/e1_0", "--params", '{"need_notification":"true"}']);
  for (const bad of ["../x", "e1_0/attendees", "e1?x=1", "", "a b"]) assert.throws(() => deletionArgv("event", bad), /日程 ID 无效/, bad);
  assert.throws(() => deletionArgv("task", "not-a-guid"), /任务 ID 无效/);
  assert.throws(() => deletionArgv("file", "x"), /不支持/);
  assert.equal(isDeletionArgv(["api", "DELETE", "/open-apis/drive/v1/files/boxcnX"]), false);
  assert.equal(isDeletionArgv([...deletionArgv("event", "e1_0").slice(0, 3)]), false, "the notification flag is part of the fixed command");
});

test("a deletion can never travel under an ordinary write grant, and a DELETE carries no body", () => {
  const intent = (action, method, path, body) => ({ action, operationId: randomUUID(), requestMethod: method, requestPath: path, bodyHash: hash(canonicalJson(body ?? null)) });
  const bytes = body => body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  // A family that only ever destroys cannot even be granted as a write.
  assert.throws(() => feishuCliWriteIntent(intent("cli.write", "DELETE", `/open-apis/task/v2/tasks/${GUID}`, null)));
  assert.throws(() => feishuCliWriteIntent(intent("cli.write", "POST", `${RECORDS}/batch_delete`, { record_id_list: ["rec1"] })));
  // A sheet request is destructive only by its body, so a write grant is issued -- and then refused at the request.
  const clear = DESTRUCTIVE_SHEETS["+cells-clear"];
  const write = feishuCliWriteIntent(intent("cli.write", "POST", SHEET, clear));
  assert.throws(() => validateFeishuCliWriteRequest(write, "POST", SHEET, bytes(clear)), /does not match its grant/);
  const set = ORDINARY_SHEETS["+cells-set"];
  validateFeishuCliWriteRequest(feishuCliWriteIntent(intent("cli.write", "POST", SHEET, set)), "POST", SHEET, bytes(set));
  // Under a deletion grant the destructive request passes, bound to its exact body.
  const deletion = feishuCliWriteIntent(intent("cli.delete", "POST", SHEET, clear));
  validateFeishuCliWriteRequest(deletion, "POST", SHEET, bytes(clear));
  assert.throws(() => validateFeishuCliWriteRequest(deletion, "POST", SHEET, bytes(DESTRUCTIVE_SHEETS["+sheet-delete"])));
  // A DELETE is bound to "no body": a grant for anything else is invalid, and a body on the request is refused.
  const path = `/open-apis/task/v2/tasks/${GUID}`;
  assert.throws(() => feishuCliWriteIntent({ ...intent("cli.delete", "DELETE", path, null), bodyHash: hash("{}") }));
  const task = feishuCliWriteIntent(intent("cli.delete", "DELETE", path, null));
  validateFeishuCliWriteRequest(task, "DELETE", path, Buffer.alloc(0));
  assert.throws(() => validateFeishuCliWriteRequest(task, "DELETE", path, Buffer.from("null")));
  assert.throws(() => validateFeishuCliWriteRequest(task, "DELETE", `/open-apis/task/v2/tasks/${GUID.replace("61ef", "71ef")}`, Buffer.alloc(0)));
  assert.throws(() => validateFeishuCliWriteRequest(task, "PATCH", path, Buffer.alloc(0)));
  // Deletion is its own action with its own capability, enabled on its own.
  assert.ok(FEISHU_CLI_WRITE_ACTIONS.includes("cli.delete"));
  assert.deepEqual([...feishuCliWriteCapabilities(["cli.delete"])], ["cliDestructiveWrites"]);
  assert.ok(!feishuCliWriteCapabilities(["cli.write"]).includes("cliDestructiveWrites"));
});

// A stand-in for the pinned CLI: help text carries its risk label, --dry-run
// prints the recorded request, and a live call is recorded, not sent.
function fakeProvider({ risk = {}, dry = {} } = {}) {
  const calls = [];
  const out = value => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
  return { calls, invoke: async (args, options = {}) => {
    const key = `${args[0]} ${args[1]}`;
    if (args.includes("--help")) return { code: 0, stdout: `Usage: lark-cli ${key}\n\nRisk: ${risk[key] ?? "write"}\n`, stderr: "" };
    if (args.includes("--dry-run")) return out({ ok: true, dry_run: true, data: { api: [dry[key]] } });
    if (args[0] === "calendar" && args[1] === "+get") return out({ ok: true, identity: "user", data: { summary: "【MyDouBao 联调】日程写入测试，可删除", start_time: { datetime: "2026-09-11T09:00:00+08:00" }, end_time: { datetime: "2026-09-11T09:30:00+08:00" }, event_organizer: { display_name: "青岚科技" } } });
    if (args[0] === "api" && args[1] === "GET") return out({ ok: true, identity: "user", data: { task: { summary: "【MyDouBao 联调】任务写入测试，可删除", completed_at: "1789119089000" } } });
    calls.push({ args, options });
    if (args.includes("--yes") && options.highRiskConfirmed !== true) throw new Error("high-risk Feishu operations require explicit confirmation");
    return out({ ok: true, identity: "user", data: {} });
  } };
}
const RECORD_DELETE = { method: "POST", url: "/open-apis/base/v3/bases/bascnX/tables/tblX/records/batch_delete", body: { record_id_list: ["rec1", "rec2"] } };
const BLOCK_DELETE = { method: "PUT", url: "/open-apis/docs_ai/v1/documents/doxcnX", body: { block_id: "b1", command: "block_delete", format: "xml", revision_id: -1 } };
const CELLS_SET = { method: "POST", url: SHEET, body: ORDINARY_SHEETS["+cells-set"] };
const provider = () => fakeProvider({ risk: { "base +record-delete": "high-risk-write" },
  dry: { "base +record-delete": RECORD_DELETE, "docs +update": BLOCK_DELETE, "sheets +cells-set": CELLS_SET,
    "api DELETE": { method: "DELETE", url: `/open-apis/task/v2/tasks/${GUID}` } } });
const DELETE_ANSWER = Object.freeze({ response: 1, reason: "answered", destructive: true });

test("a destructive plan runs only after its own deletion answer, once, and only then with --yes", async () => {
  const fake = provider(), writer = new SaasCliWriter(fake);
  const plan = await writer.plan(["base", "+record-delete", "--base-token", "bascnX", "--table-id", "tblX", "--record-id", "rec1", "--record-id", "rec2"], "/tmp");
  assert.equal(plan.destructive, true); assert.equal(plan.highRisk, true);
  await assert.rejects(writer.run(plan), /必须先经过删除确认/);
  assert.deepEqual(fake.calls, [], "nothing was dispatched");
  // An ordinary confirmation, a timeout, a withdrawal or a cancel is not a deletion answer.
  for (const choice of [{ response: 1, reason: "answered" }, { response: 0, reason: "timeout" }, { response: 1, reason: "timeout", destructive: true }, { response: 0, reason: "answered", destructive: true }, null]) {
    assert.throws(() => approveDeletion(plan, choice), /没有得到删除确认/, JSON.stringify(choice));
  }
  approveDeletion(plan, DELETE_ANSWER);
  await writer.run(plan);
  assert.equal(fake.calls.length, 1);
  const [{ args, options }] = fake.calls;
  assert.ok(args.includes("--yes"), "the CLI's high-risk gate is answered by the application");
  assert.equal(options.highRiskConfirmed, true);
  assert.equal(options.feishuWriteIntent.action, "cli.delete");
  assert.equal(options.feishuWriteIntent.requestPath, RECORD_DELETE.url);
  await assert.rejects(writer.run(plan), /必须先经过删除确认/, "one answer, one run");
  assert.equal(fake.calls.length, 1);
});

test("the CLI's label and the request rule each make a plan destructive; neither is needed for an ordinary one", async () => {
  const fake = provider(), writer = new SaasCliWriter(fake);
  // docs +update is only "write" to the CLI, but block_delete deletes: the request rule catches it, and no --yes is added.
  const block = await writer.plan(["docs", "+update", "--doc", "doxcnX", "--command", "block_delete", "--block-id", "b1"], "/tmp");
  assert.equal(block.destructive, true); assert.equal(block.highRisk, false);
  approveDeletion(block, DELETE_ANSWER); await writer.run(block);
  assert.ok(!fake.calls[0].args.includes("--yes")); assert.equal(fake.calls[0].options.feishuWriteIntent.action, "cli.delete");
  assert.equal(describeCliWrite(block).summary, "删除飞书文档里的内容");
  // An ordinary write needs no deletion answer, travels as cli.write, and a deletion answer cannot be attached to it.
  const set = await writer.plan(["sheets", "+cells-set", "--spreadsheet-token", "shtX", "--sheet-name", "Sheet1", "--range", "A1", "--cells", "[[]]"], "/tmp");
  assert.equal(set.destructive, false);
  assert.throws(() => approveDeletion(set, DELETE_ANSWER), /没有得到删除确认/);
  await writer.run(set);
  assert.equal(fake.calls[1].options.feishuWriteIntent.action, "cli.write"); assert.ok(!fake.calls[1].args.includes("--yes"));
  // The application's own deletion command plans as a DELETE with no body.
  const task = await writer.planDeletion("task", GUID, "/tmp");
  assert.equal(task.destructive, true); assert.equal(task.method, "DELETE"); assert.equal(task.bodyHash, hash("null"));
  assert.match(describeCliWrite(task).detail, /^任务会被删除[^\n]*\n\n（删除请求只有地址，没有请求体）$/, "what that means, then the exact request");
});

test("the Agent's actions ask for a deletion as a deletion, and a confirmation that is not one executes nothing", async () => {
  const fake = provider(), writer = new SaasCliWriter(fake), asked = [];
  let answer = DELETE_ANSWER, deletions = true;
  const scope = { service: { get: () => ({ title: "联调任务", cwd: "/tmp" }) }, feishu: { cliWriter: writer },
    documentWriteAccess() {}, destructiveWriteAccess() { if (!deletions) throw new Error("当前企业策略没有开启删除类操作"); } };
  const actions = agentFeishuActions({ getScope: () => scope, confirm: async request => { asked.push(request); return answer; } });
  // A command the Agent wrote that turns out to delete gets the red card and the 确认删除 button.
  await actions.run({ argv: ["base", "+record-delete", "--base-token", "bascnX", "--table-id", "tblX", "--record-id", "rec1", "--record-id", "rec2"] }, "t1");
  assert.equal(asked[0].destructive, true); assert.deepEqual(asked[0].buttons, ["取消", "确认删除"]);
  assert.match(asked[0].detail, /删除 2 条记录：rec1、rec2/); assert.match(asked[0].detail, /记录删除后无法在这里恢复/);
  assert.equal(fake.calls.length, 1);
  // A confirm that says yes but not as a deletion (a bug, a different card) executes nothing.
  answer = { response: 1, reason: "answered" };
  await assert.rejects(actions.run({ argv: ["base", "+record-delete", "--base-token", "bascnX", "--table-id", "tblX", "--record-id", "rec1"] }, "t1"), /没有得到删除确认/);
  assert.equal(fake.calls.length, 1);
  // A cancelled deletion says so.
  answer = { response: 0, reason: "answered" };
  await assert.rejects(actions["task-delete"]({ taskId: GUID }, "t1"), /取消了这次删除/);
  // Event and task deletion read what they delete and name it on the card.
  answer = DELETE_ANSWER;
  const event = await actions["event-delete"]({ eventId: "e1_0" }, "t1");
  assert.equal(event.title, "【MyDouBao 联调】日程写入测试，可删除");
  const card = asked.at(-1);
  assert.equal(card.title, "确认删除日程"); assert.match(card.detail, /时间：2026-09-11 09:00 – 2026-09-11 09:30/); assert.match(card.detail, /组织者：青岚科技/);
  assert.deepEqual(fake.calls.at(-1).args.slice(0, 5), ["api", "DELETE", "/open-apis/calendar/v4/calendars/primary/events/e1_0", "--params", '{"need_notification":"true"}']);
  assert.equal(fake.calls.at(-1).options.feishuWriteIntent.action, "cli.delete");
  const task = await actions["task-delete"]({ taskId: GUID }, "t1");
  assert.equal(task.title, "【MyDouBao 联调】任务写入测试，可删除"); assert.match(asked.at(-1).detail, /（已完成）/);
  // Without the deployment's deletion capability, nothing is even planned.
  deletions = false; const before = fake.calls.length;
  await assert.rejects(actions["task-delete"]({ taskId: GUID }, "t1"), /没有开启删除类操作/);
  await assert.rejects(actions.run({ argv: ["base", "+record-delete", "--base-token", "bascnX", "--table-id", "tblX", "--record-id", "rec1"] }, "t1"), /没有开启删除类操作/);
  assert.equal(fake.calls.length, before);
  // A scope with no deletion check at all refuses rather than assuming.
  delete scope.destructiveWriteAccess;
  await assert.rejects(actions["event-delete"]({ eventId: "e1_0" }, "t1"), /拒绝执行删除/);
});

test("full-access tasks write documents without a card while retaining exact write and deletion grants", async () => {
  const fake = provider(), writer = new SaasCliWriter(fake);
  const scope = {
    service: { get: () => ({ title: "完全访问任务", cwd: "/tmp", permission: "full" }) },
    feishu: { cliWriter: writer },
    documentWriteAccess() {},
    destructiveWriteAccess() {},
  };
  const actions = agentFeishuActions({ getScope: () => scope, confirm: async () => assert.fail("full access must not raise a document-write card") });
  await actions.run({ argv: ["sheets", "+cells-set", "--spreadsheet-token", "shtX", "--sheet-name", "Sheet1", "--range", "A1", "--cells", "[[]]"] }, "t1");
  await actions.run({ argv: ["base", "+record-delete", "--base-token", "bascnX", "--table-id", "tblX", "--record-id", "rec1", "--record-id", "rec2"] }, "t1");
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].options.feishuWriteIntent.action, "cli.write");
  assert.equal(fake.calls[1].options.feishuWriteIntent.action, "cli.delete");
  assert.equal(fake.calls[1].options.highRiskConfirmed, true);
  // Since 2026-09-28 the same holds for a Feishu task and a calendar event,
  // deleting them included: still each under its own exact cli.delete grant.
  await actions["task-delete"]({ taskId: GUID }, "t1");
  await actions["event-delete"]({ eventId: "e1_0" }, "t1");
  assert.deepEqual(fake.calls.slice(2).map((call) => call.options.feishuWriteIntent.action), ["cli.delete", "cli.delete"]);
});

test("full access enters the writer by its own path: never as a deletion card's answer, never for another task", async () => {
  const fake = provider(), writer = new SaasCliWriter(fake);
  const plan = await writer.plan(["base", "+record-delete", "--base-token", "bascnX", "--table-id", "tblX", "--record-id", "rec1"], "/tmp");
  assert.throws(() => approveDeletion(plan, { response: 1, reason: "full-access" }), /没有得到删除确认/, "not a forged click");
  for (const task of [{ permission: "standard" }, { permission: "auto" }, { permission: "plan", executionPermission: "full" }, null]) {
    assert.throws(() => approveDeletionForFullAccess(plan, task), /完全访问授权/, JSON.stringify(task));
  }
  const ordinary = await writer.plan(["sheets", "+cells-set", "--spreadsheet-token", "shtX", "--sheet-name", "Sheet1", "--range", "A1", "--cells", "[[]]"], "/tmp");
  assert.throws(() => approveDeletionForFullAccess(ordinary, { permission: "full" }), /完全访问授权/, "only a deletion is approved as one");
  approveDeletionForFullAccess(plan, { permission: "full" });
  await writer.run(plan);
  await assert.rejects(writer.run(plan), /必须先经过删除确认/, "one authorization, one run");
  assert.equal(fake.calls.length, 1);
});

test("a malformed record deletion is refused at planning", () => {
  const dry = body => JSON.stringify({ ok: true, dry_run: true, data: { api: [{ ...RECORD_DELETE, body }] } });
  for (const body of [{ record_id_list: [] }, { record_id_list: ["rec1", "rec1"] }, { record_id_list: ["x"] }, { record_id_list: ["rec1"], extra: 1 }, { record_id_list: Array.from({ length: 501 }, (_, i) => `rec${i}`) }]) {
    assert.throws(() => parseCliWritePlan(dry(body)), /删除记录的请求只能是一组记录 ID/, JSON.stringify(body).slice(0, 60));
  }
  assert.throws(() => parseCliWritePlan(JSON.stringify({ ok: true, dry_run: true, data: { api: [{ method: "DELETE", url: `/open-apis/task/v2/tasks/${GUID}`, body: {} }] } })), /删除请求不应带请求体/);
  assert.equal(cliWriteFamily("POST", `${RECORDS}/batch_delete`).id, "base.records.delete");
});
