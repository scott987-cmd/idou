// 完全访问 as the person's standing authorization for one task (2026-09-28):
// "默认每一步先问你；你一授权，它就全自动做完。" By default every outward action
// the Agent asks for raises its card; from a task on 完全访问 it runs without
// one -- sends, uploads, images, schedules and skills as well as Feishu writes.
// A video still asks, whatever the task: the Token Plan it is made on allows
// interactive use only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentDeliveryActions } from "../src/application/agent-delivery-actions.js";
import { agentMediaActions } from "../src/application/agent-media-actions.js";
import { agentScheduleActions, draftDefinition, parseScheduleDraft } from "../src/application/agent-schedule-actions.js";
import { agentSkillActions } from "../src/application/agent-skill-actions.js";
import { LocalSkillStore } from "../src/skills/local-skill-store.js";
import { getPermission } from "../src/modes.js";

const FULL = Object.freeze({ id: "t1", title: "完全访问任务", permission: "full" });
const STANDARD = Object.freeze({ id: "t1", title: "标准任务", permission: "standard" });
const HANDLE = "11111111-2222-4333-8444-555555555555";

// A person at the card who says no, and a record of every card raised.
const person = () => { const cards = []; return { cards, confirm: async (card) => { cards.push(card); return { response: 0, reason: "answered" }; } }; };

test("a document goes to a colleague without the card from a task on full access, and with it otherwise", async () => {
  for (const task of [FULL, STANDARD]) {
    const { cards, confirm } = person(), sent = [];
    const draft = { recipient: { kind: "user", name: "陈默", id: "ou_colleague", department: "产品" }, text: "请看这份周报", sender: { tenantKey: "tenant", principal: "p".repeat(20) } };
    const scope = { messageWriteAccess() {}, service: { get: () => task }, documents: { opened: new Map([["t1", { handle: "doc-handle" }]]) },
      documentDelivery: { busy: () => false, prepare: async () => ({ id: "preview-1" }),
        send: async (_task, _id, approve) => (await approve(structuredClone(draft))) ? (sent.push(draft.recipient.name), { sent: true }) : null } };
    const actions = agentDeliveryActions({ getScope: () => scope, confirm });
    if (task === FULL) {
      assert.deepEqual(await actions["doc-share"]({ recipient: HANDLE }, "t1"), { sent: true });
      assert.deepEqual([cards.length, sent], [0, ["陈默"]]);
    } else {
      await assert.rejects(actions["doc-share"]({ recipient: HANDLE }, "t1"), /取消了这次发送/);
      assert.deepEqual([cards.length, sent], [1, []]);
      assert.equal(cards[0].title, "确认发送飞书私信");
    }
  }
});

test("an image, a save to Drive and a stop go without their cards on full access; a video asks every time", async () => {
  const media = (task) => {
    const { cards, confirm } = person(), done = [];
    const scope = { service: { get: () => task }, driveWriteAccess() {},
      media: { prepare: async (_task, request) => ({ request, session: { serverUrl: "https://agent.example" },
        lease: { offer: request.kind === "image" ? { provider: "minimax", model: "image-01" } : { provider: "qwen", model: "happyhorse-1.1-t2v", seconds: 6, resolution: "1080P", aspectRatio: "16:9" } } }),
        create: async (draft) => { done.push(`create ${draft.request.kind}`); return { id: "job", state: "running" }; },
        refresh: async (_task, _job, stop) => { done.push(stop ? "stop" : "read"); return { state: stop ? "cancelled" : "running" }; } },
      mediaDelivery: { prepare: async () => ({ folder: { title: "报告", url: "https://x.feishu.cn/drive/folder/fldcnX" }, name: "a.png", bytes: Buffer.from("x"),
        sha256: "a".repeat(64), policy: { remainingBytes: 10, maxBytes: 20 } }), save: async () => { done.push("save"); return { saved: true }; } } };
    return { actions: agentMediaActions({ getScope: () => scope, confirm, openPreview: async () => {} }), cards, done };
  };
  const JOB = "36c87d85-7c76-4962-9b5f-611712f08ad7";
  const full = media(FULL);
  await full.actions["media-create"]({ kind: "image", prompt: "一只猫" }, "t1");
  await full.actions["media-save"]({ job: JOB, folder: "https://x.feishu.cn/drive/folder/fldcnX" }, "t1");
  await full.actions["media-cancel"]({ job: JOB }, "t1");
  assert.deepEqual([full.cards.length, full.done], [0, ["create image", "save", "stop"]]);
  await assert.rejects(full.actions["media-create"]({ kind: "video", prompt: "日出" }, "t1"), /取消/, "a video still asks, on full access too");
  assert.deepEqual(full.cards.map((card) => card.title), ["确认生成视频"]);
  assert.match(full.cards[0].detail, /happyhorse-1\.1-t2v/);
  assert.equal(full.done.length, 3, "and nothing was generated without the person's answer");

  const standard = media(STANDARD);
  for (const [name, params] of [["media-create", { kind: "image", prompt: "一只猫" }], ["media-save", { job: JOB, folder: "https://x.feishu.cn/drive/folder/fldcnX" }], ["media-cancel", { job: JOB }]]) {
    await assert.rejects(standard.actions[name](params, "t1"), /取消/, name);
  }
  assert.deepEqual([standard.cards.length, standard.done], [3, []]);
});

test("on full access a drafted schedule is created as the dialog would create it, and pausing, running and deleting ask nothing", async () => {
  const MINE = { id: "11111111-1111-4111-8111-111111111111", title: "群消息每日要点", schedule: "每个工作日 09:00", state: "active", nextAt: Date.UTC(2030, 0, 1) };
  const harness = (task) => {
    const { cards, confirm } = person(), calls = [], removals = [], drafts = [];
    const client = { list: async () => ({ schedules: [MINE] }),
      create: async (definition) => { calls.push(["create", definition]); return { schedule: { ...MINE, id: "22222222-2222-4222-8222-222222222222" } }; },
      setState: async (id, state) => { calls.push(["state", state]); return { schedule: { ...MINE, state } }; },
      remove: async () => { calls.push(["remove"]); return { removed: true }; },
      runNow: async () => { calls.push(["run"]); return { run: { runId: "r" } }; } };
    const actions = agentScheduleActions({ getSchedules: () => client, confirm, confirmRemoval: async (ids) => { removals.push(ids); return { response: 0 }; },
      openDraft: async (draft) => { drafts.push(draft); return { cancelled: true }; }, unattended: (taskId) => taskId === task.id && task.permission === "full",
      timeZone: () => "Asia/Shanghai" });
    return { actions, cards, calls, removals, drafts };
  };
  const source = JSON.stringify({ title: "群消息每日要点", prompt: "汇总", schedule: { frequency: "workday", time: "09:00" },
    resources: [{ kind: "chat", id: "oc_Group123", label: "项目群" }, { kind: "document", reference: "https://x.feishu.cn/docx/Doc123" }],
    startDate: "2030-01-01", endDate: "2030-12-31" });
  const full = harness(FULL);
  const created = await full.actions["schedule-draft"]({ draft: source }, "t1");
  assert.equal(created.created, true); assert.equal(created.schedule.id, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(full.drafts, [], "no dialog");
  const [[, definition]] = full.calls;
  assert.deepEqual(definition, draftDefinition(parseScheduleDraft(source, { timeZone: "Asia/Shanghai" })));
  assert.deepEqual(definition.schedule, { frequency: "weekly", time: "09:00", weekdays: [1, 2, 3, 4, 5], timeZone: "Asia/Shanghai" });
  assert.deepEqual(definition.resources, [{ kind: "chat", id: "oc_Group123", label: "项目群" }, { kind: "document", reference: "https://x.feishu.cn/docx/Doc123", label: "https://x.feishu.cn/docx/Doc123" }]);
  assert.equal(definition.startAt, Date.parse("2030-01-01T00:00:00")); assert.equal(definition.endAt, Date.parse("2030-12-31T23:59:59"));
  for (const name of ["schedule-pause", "schedule-resume", "schedule-run-now", "schedule-delete"]) await full.actions[name]({ id: MINE.id }, "t1");
  assert.deepEqual(full.calls.slice(1).map(([name, value]) => value ? `${name} ${value}` : name), ["state paused", "state active", "run", "remove"]);
  assert.deepEqual([full.cards.length, full.removals.length], [0, 0]);
  // Another task, or one that cannot be found, is not on full access.
  await assert.rejects(full.actions["schedule-pause"]({ id: MINE.id }, "another-task"), /取消了暂停/);
  assert.equal(full.cards.length, 1);

  const standard = harness(STANDARD);
  await assert.rejects(standard.actions["schedule-draft"]({ draft: source }, "t1"), /没有创建这个定时任务/);
  assert.equal(standard.drafts.length, 1, "the dialog, as before");
  await assert.rejects(standard.actions["schedule-delete"]({ id: MINE.id }, "t1"), /取消了这次删除/);
  assert.deepEqual([standard.calls, standard.removals.length], [[], 1]);
});

test("a skill the Agent wrote in its task folder is enabled without the card on full access, and says which one it switched off", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-skill-action-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "task"), elsewhere = path.join(root, "elsewhere");
  const write = async (directory, name) => { await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: 写周报时按这个格式\n---\n\n# ${name}\n\n先写结论。\n`); };
  await write(path.join(cwd, "weekly"), "weekly-report"); await write(path.join(cwd, "minutes"), "minutes"); await write(elsewhere, "outside");
  const store = new LocalSkillStore({ filename: path.join(root, "local-skills.json") });
  const harness = (task) => { const { cards, confirm } = person();
    return { cards, actions: agentSkillActions({ getScope: () => ({ service: { get: () => ({ ...task, cwd }) }, localSkills: store }), confirm }) }; };

  const full = harness(FULL);
  const first = await full.actions["skill-enable"]({ dir: "weekly" }, "t1");
  assert.deepEqual([first.enabled, first.title, first.for, first.switchedOff], [true, "weekly-report", ["cowork"], undefined]);
  const second = await full.actions["skill-enable"]({ dir: "minutes", for: "cowork,coding" }, "t1");
  assert.deepEqual(second.switchedOff?.title, "weekly-report", "one skill at a time: the one before is named");
  assert.equal(full.cards.length, 0);
  assert.deepEqual((await store.list()).filter((skill) => skill.enabled).map((skill) => [skill.title, skill.modes]), [["minutes", ["cowork", "coding"]]]);
  await assert.rejects(full.actions["skill-enable"]({ dir: "../elsewhere" }, "t1"), /必须在当前任务的文件夹里/);
  await assert.rejects(full.actions["skill-enable"]({ dir: "weekly", for: "everything" }, "t1"), /--for/);

  const standard = harness(STANDARD);
  await assert.rejects(standard.actions["skill-enable"]({ dir: "weekly" }, "t1"), /没有启用这个技能/);
  assert.equal(standard.cards.length, 1);
  assert.match(standard.cards[0].detail, /「minutes」会停用/);
  assert.deepEqual((await store.list()).filter((skill) => skill.enabled).map((skill) => skill.title), ["minutes"], "declined: nothing switched");
});

test("what 完全访问 says it covers, the Agent is told it covers", () => {
  const full = getPermission("full");
  for (const words of ["改文档", "发给同事", "传云盘", "生成图片", "日程", "定时任务", "生成视频仍会问你", "只对当前任务生效"]) assert.ok(full.summary.includes(words), words);
  assert.match(full.instruction, /Only generating a video still asks/);
  assert.match(full.instruction, /never send to or share with anyone the person did not ask for/);
});

// The rule that keeps this from drifting, over every Agent action module rather
// than the five above: one that can raise a card also knows the task's
// standing authorization -- or it would ask on full access forever, and the
// copy that says an authorized task finishes on its own would not be true.
test("every Agent action module that can raise a card consults the task's full access", async () => {
  const directory = new URL("../src/application/", import.meta.url);
  const modules = (await readdir(directory)).filter((name) => /^agent-.*-actions\.js$/.test(name));
  assert.ok(modules.length >= 5, modules.join(", "));
  for (const name of modules) {
    const text = await readFile(new URL(name, directory), "utf8");
    const asks = /\bconfirm(?:Removal)?\(|openDraft\(/.test(text);
    if (asks) assert.match(text, /permitsUnattendedActions|unattended\(/, `${name} raises a card without consulting full access`);
  }
});
