import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson, cliWriteFamily, parseCliWritePlan, validateCliWriteArgv } from "../src/providers/feishu/cli-write-plan.js";
import { describeCliWrite } from "../src/providers/feishu/cli-writer.js";
import { validateFeishuCliWriteRequest } from "../src/providers/feishu/cli-write-contract.js";
import { feishuCliSemanticRead, validateFeishuCliSemanticRead } from "../src/providers/feishu/cli-read-contract.js";

const hash = value => createHash("sha256").update(value).digest("hex");
const OPERATION = "123e4567-e89b-42d3-a456-426614174000";
const dryRun = api => JSON.stringify({ ok: true, dry_run: true, data: { api } });
const GUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

// Recorded from the pinned lark-cli 1.0.78 inside the application's own strict
// CLI environment: first with --dry-run, then the real request as it reached
// the sidecar. Bodies were byte-identical; the paths differed only in the
// `%3Cprimary%3E` placeholder and in carrying `params` as a query string.
const EVENT_BODY = { attendee_ability: "can_modify_event", end_time: { timestamp: "1789180200" }, free_busy_status: "busy",
  reminders: [{ minutes: 5 }], start_time: { timestamp: "1789178400" }, summary: "联调" };
const RECORDED = {
  event: { dry: { method: "POST", url: "/open-apis/calendar/v4/calendars/%3Cprimary%3E/events", body: EVENT_BODY },
    sent: "/open-apis/calendar/v4/calendars/primary/events" },
  reply: { dry: { method: "POST", url: "/open-apis/calendar/v4/calendars/%3Cprimary%3E/events/e1_0/reply", body: { rsvp_status: "accept" } },
    sent: "/open-apis/calendar/v4/calendars/primary/events/e1_0/reply" },
  task: { dry: { method: "POST", url: "/open-apis/task/v2/tasks", params: { user_id_type: "open_id" }, body: { summary: "联调任务" } },
    sent: "/open-apis/task/v2/tasks?user_id_type=open_id" },
  done: { dry: { method: "PATCH", url: `/open-apis/task/v2/tasks/${GUID}`, params: { user_id_type: "open_id" },
    body: { task: { completed_at: "1789111330000" }, update_fields: ["completed_at"] } }, sent: `/open-apis/task/v2/tasks/${GUID}?user_id_type=open_id` },
};

test("each recorded calendar and task write plans to exactly the request the CLI then sends", () => {
  for (const [name, { dry, sent }] of Object.entries(RECORDED)) {
    const plan = parseCliWritePlan(dryRun([dry]));
    assert.equal(plan.path, sent, `${name}: planned path is the path actually sent`);
    const intent = { action: "cli.write", operationId: OPERATION, requestMethod: plan.method, requestPath: plan.path, bodyHash: hash(canonicalJson(plan.body)) };
    // The live request -- recorded path, recorded body -- satisfies the grant.
    validateFeishuCliWriteRequest(intent, dry.method, sent, Buffer.from(JSON.stringify(dry.body)));
    // A different body, or another task, does not.
    assert.throws(() => validateFeishuCliWriteRequest(intent, dry.method, sent, Buffer.from(JSON.stringify({ ...dry.body, summary: "别的" }))));
  }
  const other = parseCliWritePlan(dryRun([RECORDED.done.dry]));
  const intent = { action: "cli.write", operationId: OPERATION, requestMethod: "PATCH", requestPath: other.path, bodyHash: hash(canonicalJson(other.body)) };
  assert.throws(() => validateFeishuCliWriteRequest(intent, "PATCH", "/open-apis/task/v2/tasks/ffffffff-4e5f-4a6b-8c7d-9e0f1a2b3c4d?user_id_type=open_id", Buffer.from(JSON.stringify(RECORDED.done.dry.body))));
});

test("query parameters are bound by value, not by the order they arrive in", () => {
  const plan = parseCliWritePlan(dryRun([{ ...RECORDED.task.dry, params: { user_id_type: "open_id" } }]));
  const intent = { action: "cli.write", operationId: OPERATION, requestMethod: "POST", requestPath: plan.path, bodyHash: hash(canonicalJson(plan.body)) };
  const body = Buffer.from(JSON.stringify(RECORDED.task.dry.body));
  validateFeishuCliWriteRequest(intent, "POST", "/open-apis/task/v2/tasks?user_id_type=open_id", body);
  // A parameter the family does not declare, or another value, is a different request.
  assert.throws(() => validateFeishuCliWriteRequest(intent, "POST", "/open-apis/task/v2/tasks?user_id_type=union_id", body));
  assert.throws(() => validateFeishuCliWriteRequest(intent, "POST", "/open-apis/task/v2/tasks?user_id_type=open_id&x=1", body));
  assert.equal(cliWriteFamily("POST", "/open-apis/task/v2/tasks?user_id_type=union_id"), null);
});

test("what stays out: other people's calendars edited in place, attendees, and fan-out commands", () => {
  for (const [method, path] of [
    ["PATCH", "/open-apis/calendar/v4/calendars/primary/events/e1_0"], ["POST", "/open-apis/calendar/v4/calendars/primary/events/e1_0/attendees"],
    ["POST", `/open-apis/task/v2/tasks/${GUID}/add_members`], ["DELETE", "/open-apis/calendar/v4/calendars/primary"],
    ["DELETE", "/open-apis/drive/v1/files/boxcnX"], ["DELETE", `/open-apis/task/v2/tasks/${GUID}/members`],
  ]) assert.equal(cliWriteFamily(method, path), null, `${method} ${path}`);
  // Deleting an event or a task exists now, but only as a deletion (see destructive-writes.test.js).
  assert.equal(cliWriteFamily("DELETE", `/open-apis/task/v2/tasks/${GUID}`).destructive, true);
  assert.equal(cliWriteFamily("DELETE", "/open-apis/calendar/v4/calendars/primary/events/e1_0").destructive, true);
  // The two commands that fan out are answered with the form that does not.
  assert.throws(() => validateCliWriteArgv(["task", "+complete", "--task-id", GUID]), /task \+update .*completed_at/);
  assert.throws(() => validateCliWriteArgv(["calendar", "+create", "--summary", "x", "--attendee-ids", "ou_a"]), /邀请参会人还没有接入/);
  assert.deepEqual(validateCliWriteArgv(["calendar", "+create", "--summary", "x"]), ["calendar", "+create", "--summary", "x"]);
  // A plan that still fans out is refused outright.
  assert.throws(() => parseCliWritePlan(dryRun([RECORDED.event.dry, { method: "POST", url: "/open-apis/calendar/v4/calendars/%3Cprimary%3E/events/<event_id>/attendees", body: {} }])), /多个请求/);
});

test("the confirmation says what will happen in words before the exact request", () => {
  const event = describeCliWrite(parseCliWritePlan(dryRun([RECORDED.event.dry])));
  assert.equal(event.target, "我的日历");
  assert.match(event.detail.split("\n")[0], /^日程「联调」 · .+ – .+ · 只建在这个日历上，不邀请任何人$/);
  const done = describeCliWrite(parseCliWritePlan(dryRun([RECORDED.done.dry])));
  assert.match(done.detail.split("\n")[0], /标记为已完成/);
  assert.equal(done.target, `任务 ${GUID}`, "the target names the task, not the query string");
  assert.match(describeCliWrite(parseCliWritePlan(dryRun([RECORDED.reply.dry]))).detail.split("\n")[0], /回复：接受/);
  const assigned = describeCliWrite(parseCliWritePlan(dryRun([{ ...RECORDED.task.dry, body: { summary: "交周报", members: [{ id: "ou_a", role: "assignee" }] } }])));
  assert.match(assigned.detail.split("\n")[0], /会指派给 1 人，他们会收到通知/);
});

// Feishu serves these reads as POSTs; the shapes were recorded from the real
// requests. A read is allowed only in exactly that shape.
test("calendar and task reads pass as reads only in their recorded shape", () => {
  const read = (path, body) => { const entry = feishuCliSemanticRead("POST", path); if (!entry) return "not a read"; try { validateFeishuCliSemanticRead(entry, Buffer.from(JSON.stringify(body))); return "allowed"; } catch { return "refused"; } };
  assert.equal(read("/open-apis/calendar/v4/freebusy/list", { need_rsvp_status: true, time_max: "2026-09-11T23:59:59+08:00", time_min: "2026-09-11T00:00:00+08:00", user_id: "ou_rec" }), "allowed");
  assert.equal(read("/open-apis/calendar/v4/calendars/primary/events/search_event?page_size=20", { query: "周会" }), "allowed");
  assert.equal(read("/open-apis/calendar/v4/calendars/primary/events/search_event?page_size=20", { query: "周会", filter: { time_range: { start_time: "2026-09-11T00:00:00+08:00", end_time: "2026-09-18T23:59:59+08:00" } } }), "allowed");
  assert.equal(read("/open-apis/task/v2/tasks/search", { query: "测试" }), "allowed");
  assert.equal(read("/open-apis/task/v2/tasks/search", { query: "测试", completed: true }), "refused");
  assert.equal(read("/open-apis/calendar/v4/freebusy/list", { time_min: "x", time_max: "y", user_id: "ou_rec" }), "refused");
  assert.equal(read("/open-apis/calendar/v4/calendars/primary/events", { summary: "x" }), "not a read");
  // Room finding and meeting details stay out until they are looked at on their own.
  assert.equal(read("/open-apis/calendar/v4/freebusy/room_find", { event_start_time: "2026-09-12T10:00:00+08:00", event_end_time: "2026-09-12T11:00:00+08:00", attendee_user_ids: ["ou_rec"] }), "not a read");
  assert.equal(read("/open-apis/calendar/v4/calendars/primary/events/mget_instance_relation_info", { instance_ids: ["e1_0"] }), "not a read");
  assert.equal(read("/open-apis/calendar/v4/calendars/primary/events/search_event?page_size=20&delete=1", { query: "x" }), "not a read");
});

// Recorded from the pinned CLI with the filters people actually use: who is
// attending, whether a task is done, who it is assigned to, when it is due, and
// the free-time suggestion scheduling needs. Each passes only in that shape.
test("calendar and task reads with filters pass in the shapes the CLI sends, and only those", () => {
  const read = (path, body) => { const entry = feishuCliSemanticRead("POST", path); if (!entry) return "not a read"; try { validateFeishuCliSemanticRead(entry, Buffer.from(JSON.stringify(body))); return "allowed"; } catch { return "refused"; } };
  const SEARCH = "/open-apis/calendar/v4/calendars/primary/events/search_event?page_size=20";
  const range = { start_time: "2026-09-12T00:00:00+08:00", end_time: "2026-09-30T23:59:59+08:00" };
  const recorded = [
    [SEARCH, { query: "", filter: { attendee_user_ids: ["ou_abc"], attendee_chat_ids: ["oc_def"] } }],
    [SEARCH + "&page_token=tok1", { query: "评审", filter: { attendee_user_ids: ["ou_abc"], attendee_chat_ids: ["oc_def"], meeting_room_ids: ["omm_ghi"] } }],
    [SEARCH, { query: "", filter: { time_range: range } }],
    ["/open-apis/calendar/v4/freebusy/suggestion", { search_start_time: "2026-09-12T09:00:00+08:00", search_end_time: "2026-09-12T18:00:00+08:00", timezone: "Asia/Shanghai", duration_minutes: 45,
      attendee_user_ids: ["ou_abc", "ou_rec"], attendee_chat_ids: ["oc_def"], excluded_event_times: [{ event_start_time: "2026-09-12T12:00:00+08:00", event_end_time: "2026-09-12T13:00:00+08:00" }] }],
    ["/open-apis/calendar/v4/freebusy/suggestion", { search_start_time: "2026-09-11T15:51:08+08:00", search_end_time: "2026-09-11T23:59:59+08:00", event_rrule: "FREQ=WEEKLY;BYDAY=MO", duration_minutes: 60, attendee_user_ids: ["ou_rec"] }],
    ["/open-apis/calendar/v4/freebusy/suggestion", { search_start_time: "2026-09-11T15:51:08+08:00", search_end_time: "2026-09-11T23:59:59+08:00", attendee_user_ids: ["ou_rec"] }],
    ["/open-apis/task/v2/tasks/search", { filter: { is_completed: false }, query: "测试" }],
    ["/open-apis/task/v2/tasks/search", { filter: { assignee_ids: ["ou_abc"] }, query: "" }],
    ["/open-apis/task/v2/tasks/search", { filter: { creator_ids: ["ou_abc"], follower_ids: ["ou_def"] }, query: "" }],
    ["/open-apis/task/v2/tasks/search?page_token=tok1", { filter: { due_time: range }, query: "x" }],
    ["/open-apis/task/v2/tasklists/search", { filter: { create_time: range, user_id: ["ou_abc"] }, query: "" }],
    ["/open-apis/task/v2/tasklists/search?page_token=tok1", { query: "项目" }],
  ];
  for (const [path, body] of recorded) assert.equal(read(path, body), "allowed", `${path} ${JSON.stringify(body)}`);
  // A guessed field name, a wrong id kind, an unbounded list or a stray field is refused.
  for (const [path, body] of [
    [SEARCH, { query: "x", filter: { user_ids: ["ou_abc"] } }],
    [SEARCH, { query: "x", filter: { attendee_user_ids: ["oc_def"] } }],
    ["/open-apis/calendar/v4/freebusy/suggestion", { search_start_time: "2026-09-12T09:00:00+08:00", search_end_time: "2026-09-12T18:00:00+08:00", attendee_user_ids: Array.from({ length: 51 }, (_, i) => `ou_${i}`) }],
    ["/open-apis/calendar/v4/freebusy/suggestion", { search_start_time: "2026-09-12T09:00:00+08:00", search_end_time: "2026-09-12T18:00:00+08:00", duration_minutes: 0 }],
    ["/open-apis/calendar/v4/freebusy/suggestion", { search_start_time: "2026-09-12T09:00:00+08:00" }],
    ["/open-apis/calendar/v4/freebusy/suggestion", { search_start_time: "2026-09-12T09:00:00+08:00", search_end_time: "2026-09-12T18:00:00+08:00", summary: "x" }],
    ["/open-apis/task/v2/tasks/search", { query: "x", filter: { is_completed: "false" } }],
    ["/open-apis/task/v2/tasks/search", { query: "x", filter: { tasklist_ids: ["t"] } }],
    ["/open-apis/task/v2/tasklists/search", { query: "x", filter: { user_id: "ou_abc" } }],
  ]) assert.equal(read(path, body), "refused", `${path} ${JSON.stringify(body)}`);
  assert.equal(read("/open-apis/task/v2/tasklists/search?delete=1", { query: "x" }), "not a read");
});
