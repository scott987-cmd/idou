import test from "node:test";
import assert from "node:assert/strict";
import { REMINDER_DAYS, ScheduleReminders } from "../src/control-plane/schedule-reminders.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

// The owner of scheduled tasks is told, through the bot, before the unattended
// authorization their tasks run on ends and when tasks of theirs are suspended
// (schedule-reminders.js). Found in the long-running review: the authorization
// ended, the tasks were suspended, and nothing reached anyone.
const DAY = 86400_000;
const OWNER = "ou_0f1e2d3c4b5a69788796a5b4c3d2e1f0", OTHER = "ou_1f1e2d3c4b5a69788796a5b4c3d2e1f0";
const WHO = { tenantId: "tenant-a", userId: OWNER };

function setup({ expiresIn = 6 * DAY, authorized = true, allowedTenants = null, failSends = 0, owners = [WHO] } = {}) {
  const clock = { at: Date.parse("2026-10-01T02:00:00Z") };
  const records = new Map([[`${WHO.tenantId}\n${WHO.userId}`, { state: "active", expiresAt: clock.at + expiresIn }]]);
  const unattended = {
    status: async (who) => {
      const record = records.get(`${who.tenantId}\n${who.userId}`);
      return record ? { available: true, authorized: authorized && record.expiresAt > clock.at, expiresAt: record.expiresAt, state: record.state } : { available: true, authorized: false, expiresAt: null };
    },
    store: {
      read: async (tenantId, userId) => records.get(`${tenantId}\n${userId}`) ?? null,
      patch: async (tenantId, userId, fields) => { const key = `${tenantId}\n${userId}`; records.set(key, { ...records.get(key), ...fields }); return records.get(key); },
    },
  };
  const tasks = [
    { tenant: "tenant-a", owner: OWNER, title: "每日产品简报", state: "active", suspendedAt: null, capability: {}, spec: { timeZone: "Asia/Shanghai" } },
    { tenant: "tenant-a", owner: OWNER, title: "周报汇总", state: "active", suspendedAt: null, capability: {}, spec: { timeZone: "Asia/Shanghai" } },
    { tenant: "tenant-a", owner: OWNER, title: "已暂停的", state: "paused", suspendedAt: null, capability: {}, spec: {} },
  ];
  const store = {
    owners: async ({ after, limit }) => owners.filter((who) => !after || `${who.tenantId}\n${who.userId}` > `${after.tenantId}\n${after.userId}`).slice(0, limit),
    list: async (who, { mine }) => (assert.equal(mine, true), tasks.filter((row) => row.tenant === who.tenantId && row.owner === who.userId)),
  };
  const sent = [];
  let failures = failSends;
  const bot = { sendText: async ({ openId, text }) => { if (failures > 0) { failures -= 1; return { sent: false, reason: "api_error" }; } sent.push({ openId, text }); return { sent: true }; } };
  const timers = { pending: [], set(fn, ms) { const entry = { fn, ms }; this.pending.push(entry); return entry; }, clear(entry) { this.pending = this.pending.filter((item) => item !== entry); },
    async fire() { const due = this.pending.splice(0); for (const entry of due) await entry.fn(); } };
  const logs = [];
  const reminders = new ScheduleReminders({ store, unattended, bot, feishu: SAAS_FEISHU, allowedTenants, now: () => clock.at, timers, log: (line) => logs.push(line) });
  return { reminders, clock, records, sent, timers, logs, tasks };
}

test("a week before the authorization ends, and again a day before, its owner is told once each", async () => {
  const { reminders, clock, sent, records } = setup({ expiresIn: 6 * DAY });
  assert.deepEqual(REMINDER_DAYS, [7, 1]);
  assert.equal(await reminders.sweep(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openId, OWNER, "to the owner, and nobody else");
  assert.match(sent[0].text, /「每日产品简报」「周报汇总」靠无人值守授权运行/);
  assert.doesNotMatch(sent[0].text, /已暂停的/, "only the tasks that would run");
  assert.match(sent[0].text, /10\/7 10:00 到期（还剩约 6 天）/, "when, in the tasks' own time zone");
  assert.match(sent[0].text, /重新授权后会接着运行/);
  assert.equal(await reminders.sweep(), 0, "not twice");
  assert.deepEqual(records.get(`${WHO.tenantId}\n${WHO.userId}`).reminders.sent, [7], "kept with the authorization, so a restart sends nothing twice");

  clock.at += 5.5 * DAY;
  assert.equal(await reminders.sweep(), 1);
  assert.match(sent[1].text, /还剩不到一天/);
  assert.equal(await reminders.sweep(), 0);

  // A new grant starts over.
  const record = records.get(`${WHO.tenantId}\n${WHO.userId}`);
  records.set(`${WHO.tenantId}\n${WHO.userId}`, { ...record, expiresAt: clock.at + 3 * DAY });
  assert.equal(await reminders.sweep(), 1);
});

test("a reminder missed while the server was down is not sent late on top of the next one", async () => {
  const { reminders, sent } = setup({ expiresIn: 12 * 3600_000 });
  assert.equal(await reminders.sweep(), 1);
  assert.equal(sent.length, 1, "one message, the more urgent one");
  assert.match(sent[0].text, /还剩不到一天/);
  assert.equal(await reminders.sweep(), 0, "and the week's reminder is not sent after it");
});

test("nothing is said far from the end, without an authorization, beyond the tenants served, or when the bot fails -- which is tried again", async () => {
  assert.equal(await setup({ expiresIn: 10 * DAY }).reminders.sweep(), 0);
  assert.equal(await setup({ authorized: false }).reminders.sweep(), 0);
  const beyond = setup({ allowedTenants: ["tenant-b"] });
  assert.equal(await beyond.reminders.sweep(), 0);
  assert.equal(beyond.sent.length, 0);
  const failing = setup({ failSends: 1 });
  assert.equal(await failing.reminders.sweep(), 0);
  assert.equal(await failing.reminders.sweep(), 1, "not marked sent until it was");
});

test("tasks suspended together are named in one message, and not again that day", async () => {
  const { reminders, clock, sent, timers } = setup();
  const task = (title) => ({ tenant: "tenant-a", owner: OWNER, title });
  reminders.suspended(task("每日产品简报"), "无人值守授权已到期，任务已暂停。重新授权后自动恢复。");
  reminders.suspended(task("周报汇总"), "无人值守授权已到期，任务已暂停。重新授权后自动恢复。");
  assert.equal(sent.length, 0, "gathered for a minute first");
  await timers.fire();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openId, OWNER);
  assert.match(sent[0].text, /你的定时任务「每日产品简报」「周报汇总」已暂停：无人值守授权已到期，任务已暂停。重新授权后自动恢复。/);
  assert.match(sent[0].text, /暂停超过 30 天的任务，提示词会被清除/);
  reminders.suspended(task("月度盘点"), "无人值守授权已到期");
  await timers.fire();
  assert.equal(sent.length, 1, "not again the same day");
  clock.at += DAY + 1;
  reminders.suspended(task("月度盘点"), "无人值守授权已到期");
  await timers.fire();
  assert.equal(sent.length, 2);
});

test("a suspension still gathering is said when the server stops, and nobody else is ever the recipient", async () => {
  const { reminders, sent } = setup();
  reminders.suspended({ tenant: "tenant-a", owner: OWNER, title: "每日产品简报" }, "飞书拒绝续期");
  reminders.suspended({ tenant: "tenant-a", owner: "u-not-an-open-id", title: "别人的" }, "飞书拒绝续期");
  await reminders.close();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].openId, OWNER);
  assert.doesNotMatch(sent[0].text, /别人的/);
});

test("without a bot nothing is sent, and nothing fails", async () => {
  const quiet = new ScheduleReminders({ store: { owners: async () => [WHO], list: async () => [] }, unattended: null, bot: null, feishu: SAAS_FEISHU });
  assert.equal(await quiet.sweep(), 0);
  quiet.suspended({ tenant: "tenant-a", owner: OWNER, title: "x" }, "y");
  await quiet.close();
});

// A message still on its way when the next batch flushes (the bot is slow, the
// minute has passed): the second does not go as well.
test("a second batch flushing while the first message is still being sent does not send again", async () => {
  const { reminders, sent, timers } = setup();
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const original = reminders.bot.sendText;
  reminders.bot.sendText = async (message) => { await slow; return original(message); };
  reminders.suspended({ tenant: "tenant-a", owner: OWNER, title: "每日产品简报" }, "飞书拒绝续期");
  const first = timers.pending.splice(0)[0].fn();
  reminders.suspended({ tenant: "tenant-a", owner: OWNER, title: "周报汇总" }, "飞书拒绝续期");
  const second = timers.pending.splice(0)[0].fn();
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(sent.length, 1);
});
