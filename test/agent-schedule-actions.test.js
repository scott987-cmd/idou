import test from "node:test";
import assert from "node:assert/strict";
import { agentScheduleActions, parseScheduleDraft, draftDefinition } from "../src/application/agent-schedule-actions.js";

const ZONE = { timeZone: "Asia/Shanghai" };
const MINE = { id: "11111111-1111-4111-8111-111111111111", title: "群消息每日要点", schedule: "每个工作日 09:00", state: "active",
  suspended: false, nextAt: Date.UTC(2026, 8, 21, 1, 0), endAt: null, memory: true, prompt: "汇总群里昨天的消息",
  access: { resources: [{ kind: "chat", id: "oc_Group123", label: "项目群" }], limits: { modelCalls: 12 } } };

// A schedule client and a person at the card, both recorded.
function harness({ answers = [], draftOutcome = { created: true, schedule: { id: MINE.id } }, full = false } = {}) {
  const state = { cards: [], removals: [], drafts: [], calls: [] };
  const client = {
    list: async () => ({ schedules: [MINE] }),
    setState: async (id, value) => { state.calls.push(["state", id, value]); return { schedule: { ...MINE, state: value } }; },
    remove: async (id) => { state.calls.push(["remove", id]); return { removed: true }; },
    runNow: async (id) => { state.calls.push(["runNow", id]); return { run: { runId: "22222222-2222-4222-8222-222222222222" } }; },
  };
  const answer = () => answers.shift() ?? { response: 0 };
  const actions = agentScheduleActions({ getSchedules: () => client,
    confirm: async (card) => { state.cards.push(card); return answer(); },
    confirmRemoval: async (ids) => { state.removals.push(ids); return answer(); },
    openDraft: async (draft) => { state.drafts.push(draft); return draftOutcome; }, unattended: () => full, timeZone: () => "Asia/Shanghai" });
  return { actions, state };
}

test("a draft is read the way the server reads a rule, and refused while the Agent can still fix it", () => {
  const draft = parseScheduleDraft(JSON.stringify({ title: " 群消息每日要点 ", prompt: "汇总", schedule: { frequency: "workday", time: "09:00" },
    resources: [{ kind: "chat", id: "oc_Group123", label: "项目群" }, { kind: "document", reference: "https://x.feishu.cn/docx/Doc123" }] }), ZONE);
  assert.equal(draft.title, "群消息每日要点");
  assert.deepEqual({ ...draft.schedule }, { frequency: "weekly", time: "09:00", weekdays: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai" }, "每个工作日 is Monday to Friday");
  assert.equal(draft.mode, "cowork");
  assert.equal(draft.memory, true, "on unless said otherwise, as the dialog has it");
  assert.deepEqual(draft.resources.map((row) => row.kind), ["chat", "document"]);
  const once = parseScheduleDraft(JSON.stringify({ title: "一次", prompt: "p", schedule: { frequency: "once", at: "2030-01-02T09:00:00+08:00" } }), ZONE);
  assert.equal(once.schedule.at, Date.parse("2030-01-02T09:00:00+08:00"));

  const refused = (value, pattern) => assert.throws(() => parseScheduleDraft(typeof value === "string" ? value : JSON.stringify(value), ZONE), pattern);
  refused("{not json", /合法的 JSON/);
  refused({ title: "t", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, capability: { modelCalls: 80 } }, /不认识的字段：capability/);
  refused({ title: "t", prompt: "p", schedule: { frequency: "hourly" } }, /执行频率/);
  refused({ title: "t", prompt: "p" }, /执行规则/);
  refused({ title: "", prompt: "p", schedule: { frequency: "daily", time: "09:00" } }, /名称/);
  refused({ title: "t", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, resources: [{ kind: "chat", id: "not-a-chat" }] }, /oc_/);
  refused({ title: "t", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, resources: [{ kind: "document", reference: "http://x.feishu.cn/docx/a" }] }, /链接无效/);
  refused({ title: "t", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, resources: [{ kind: "wiki", reference: "https://x" }] }, /kind/);
  refused({ title: "t", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, endDate: "明年" }, /endDate 要写成 YYYY-MM-DD/);
  refused({ title: "t", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, startDate: "下周一" }, /startDate 要写成 YYYY-MM-DD/);
  refused({ title: "t", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, startDate: "2030-02-01", endDate: "2030-01-31" }, /startDate 要早于 endDate/);
  const dated = parseScheduleDraft(JSON.stringify({ title: "t", prompt: "p", schedule: { frequency: "daily", time: "09:00" }, startDate: "2030-01-01", endDate: "2030-01-01" }), ZONE);
  assert.deepEqual([dated.startDate, dated.endDate], ["2030-01-01", "2030-01-01"], "one day is a valid 有效期");
  assert.equal(draft.startDate, null, "始终生效 unless said");
});

test("a draft creates nothing by itself: the Agent hears what the person did with it", async () => {
  const source = JSON.stringify({ title: "群消息每日要点", prompt: "汇总", schedule: { frequency: "daily", time: "09:00" } });
  const made = harness({ draftOutcome: { created: true, schedule: { id: MINE.id, title: MINE.title } } });
  assert.deepEqual(await made.actions["schedule-draft"]({ draft: source }), { created: true, schedule: { id: MINE.id, title: MINE.title } });
  assert.equal(made.state.drafts.length, 1);
  assert.deepEqual(made.state.calls, [], "the action itself changed nothing");

  for (const [outcome, pattern] of [[{ cancelled: true }, /没有创建这个定时任务/], [{ cancelled: true, reason: "timeout" }, /不要自己重新发起/],
    [{ cancelled: true, reason: "withdrawn" }, /已作废/], [{ cancelled: true, reason: "busy" }, /另一个对话框/]]) {
    await assert.rejects(harness({ draftOutcome: outcome }).actions["schedule-draft"]({ draft: source }), pattern);
  }
  await assert.rejects(made.actions["schedule-draft"]({ draft: "{}" }), /名称/, "a bad draft never reaches the dialog");
  assert.equal(made.state.drafts.length, 1);
});

test("listing reads the person's own tasks and asks nothing", async () => {
  const made = harness();
  const { schedules: [row] } = await made.actions["schedule-list"]({});
  assert.deepEqual(row, { id: MINE.id, title: MINE.title, rule: "每个工作日 09:00", state: "运行中", suspended: false, nextAt: "2026-09-21T01:00:00.000Z",
    startAt: null, endAt: null, memory: true, resources: [{ kind: "chat", label: "项目群" }], deliveries: [], modelCalls: 12, prompt: MINE.prompt });
  assert.equal(made.state.cards.length, 0);
});

test("pausing, resuming, deleting and running now each wait for the person's yes", async () => {
  const yes = { response: 1 }, no = { response: 0 }, late = { response: 0, reason: "timeout" };
  const made = harness({ answers: [no, yes, yes, no, yes, late, yes] });
  await assert.rejects(made.actions["schedule-pause"]({ id: MINE.id }), /取消了暂停/);
  assert.equal((await made.actions["schedule-pause"]({ id: MINE.id })).paused, true);
  assert.equal((await made.actions["schedule-resume"]({ id: MINE.id })).resumed, true);
  await assert.rejects(made.actions["schedule-delete"]({ id: MINE.id }), /没有删除任何东西/);
  assert.deepEqual(await made.actions["schedule-delete"]({ id: MINE.id }), { deleted: true, title: MINE.title });
  await assert.rejects(made.actions["schedule-run-now"]({ id: MINE.id }), /不要自己重新发起/, "a timeout is not a no, and not leave to ask again");
  assert.equal((await made.actions["schedule-run-now"]({ id: MINE.id })).started, true);
  assert.deepEqual(made.state.calls, [["state", MINE.id, "paused"], ["state", MINE.id, "active"], ["remove", MINE.id], ["runNow", MINE.id]],
    "each change happened once, after its yes, and never after a no");
  assert.deepEqual(made.state.removals, [[MINE.id], [MINE.id]], "deletion asks on the same card the page uses");
  assert.match(made.state.cards.find((card) => card.title === "立即运行定时任务？").detail, /计费/);
});

test("an id not in the person's own list is not there, whatever it looks like", async () => {
  const made = harness({ answers: [{ response: 1 }] });
  await assert.rejects(made.actions["schedule-delete"]({ id: "33333333-3333-4333-8333-333333333333" }), /找不到这个定时任务/);
  await assert.rejects(made.actions["schedule-pause"]({ id: "../../etc" }), /schedule-list/);
  assert.deepEqual(made.state.removals, []);
  assert.deepEqual(made.state.cards, [], "and nothing was asked about it");
});

// 结果还写到: a draft may propose where the results also go, like its resources --
// only a proposal, which the dialog pre-selects and the server proves again.
test("a draft may name where its results also go, checked while the Agent can still fix it", () => {
  const base = { title: "周报", prompt: "汇总", schedule: { frequency: "weekly", time: "17:00", weekdays: [5] } };
  const draft = parseScheduleDraft(JSON.stringify({ ...base, deliveries: [{ kind: "chat", id: "oc_Group123", label: "周报群" },
    { kind: "document", reference: "https://x.feishu.cn/docx/Doc12345678" }] }), ZONE);
  assert.deepEqual(draft.deliveries, [{ kind: "chat", id: "oc_Group123", label: "周报群" },
    { kind: "document", reference: "https://x.feishu.cn/docx/Doc12345678", label: "https://x.feishu.cn/docx/Doc12345678" }]);
  assert.deepEqual(draftDefinition(draft).deliveries, draft.deliveries, "sent as the dialog sends them");
  assert.equal(parseScheduleDraft(JSON.stringify(base), ZONE).deliveries.length, 0);
  assert.equal(draftDefinition(parseScheduleDraft(JSON.stringify(base), ZONE)).deliveries, undefined, "and not at all when there are none");
  const refused = (deliveries, pattern) => assert.throws(() => parseScheduleDraft(JSON.stringify({ ...base, deliveries }), ZONE), pattern);
  refused([{ kind: "sheet", reference: "https://x.feishu.cn/sheets/Sheet123" }], /deliveries 的 kind/);
  refused([{ kind: "chat", id: "ou_person" }], /oc_/);
  refused(new Array(4).fill({ kind: "chat", id: "oc_Group123" }), /最多 3 个去处/);
  refused("oc_Group123", /deliveries 是一个数组/);
});

test("under full access a draft with places is created as proposed, and the Agent hears what the server kept", async () => {
  const created = [];
  const actions = agentScheduleActions({ getSchedules: () => ({ create: async (definition) => { created.push(definition);
    return { schedule: { id: MINE.id, title: "周报", schedule: "每周五 17:00", nextAt: null, deliveries: [{ kind: "chat", id: "oc_Group123", label: "周报群" }] } }; } }),
    confirm: async () => assert.fail("no card"), confirmRemoval: async () => assert.fail("no card"), openDraft: async () => assert.fail("no dialog"),
    unattended: () => true, timeZone: () => "Asia/Shanghai" });
  const answer = await actions["schedule-draft"]({ draft: JSON.stringify({ title: "周报", prompt: "汇总", schedule: { frequency: "weekly", time: "17:00", weekdays: [5] },
    deliveries: [{ kind: "chat", id: "oc_Group123", label: "周报群" }] }) });
  assert.deepEqual(created[0].deliveries, [{ kind: "chat", id: "oc_Group123", label: "周报群" }]);
  assert.deepEqual(answer.schedule.deliveries, [{ kind: "chat", label: "周报群" }], "named as the person sees it");
});
