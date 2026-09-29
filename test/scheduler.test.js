import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScheduleStore } from "../src/control-plane/schedule-store.js";
import { Scheduler } from "../src/control-plane/scheduler.js";
import { zonedInstant } from "../src/control-plane/schedule-spec.js";

const WHO = { tenantId: "tenant-a", userId: "person-a", familyId: "login-a" };
const HOUR = 3600_000;
const ZONE = "Asia/Shanghai";
const at = (y, m, d, hh, mm) => zonedInstant({ year: y, month: m, day: d, hour: hh, minute: mm }, ZONE);
// 每天 09:00 -- the rule the reference products show in their own list views.
const daily = (time = "09:00") => ({ title: "每天汇总", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork",
  schedule: { frequency: "daily", time, timeZone: ZONE } });

// Fake timers, so "wakes when it should" is a step in the test rather than a wait.
function timers() {
  const pending = new Map();
  let id = 0;
  return {
    api: { set: (fn, delay) => { const key = ++id; pending.set(key, { fn, delay }); return key; }, clear: (key) => pending.delete(key) },
    delay: () => [...pending.values()].at(-1)?.delay ?? null,
    fire: async () => { const entry = [...pending.values()].at(-1); pending.clear(); await entry?.fn(); },
    count: () => pending.size,
  };
}

async function harness(t, { execute, authorize, postprocess, notify } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-scheduler-"));
  const clock = { at: at(2026, 9, 16, 8, 0) };
  const store = new ScheduleStore({ databaseFile: path.join(directory, "schedules.db"), now: () => clock.at });
  const clockTimers = timers();
  const ran = [];
  const scheduler = new Scheduler({ store, now: () => clock.at, timers: clockTimers.api, maxConcurrent: 2, authorize, postprocess, notify,
    execute: execute ?? (async (claim) => { ran.push(claim.schedule.title); return { detail: "ok" }; }) });
  t.after(async () => { await scheduler.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, scheduler, clock, ran, timers: clockTimers };
}

test("a report is persisted only as its verified Drive receipt", async t => {
  const artifact = { state: "verified", providerId: "saas-cli", fileToken: "FileFixture123",
    url: "https://fixture.feishu.cn/file/FileFixture123", name: "mydoubao-11111111-1111-4111-8111-111111111111.schedule.md",
    bytes: 25, sha256: "a".repeat(64), archivedAt: 1_000 };
  const seen = [];
  const { store, scheduler, clock } = await harness(t, {
    execute: async () => ({ detail: "SENSITIVE-REPORT-CONTENT", report: Buffer.from("SENSITIVE-REPORT-CONTENT") }),
    postprocess: async value => { seen.push(value.report.toString()); return { detail: `报告已保存到飞书云盘：${artifact.url}`, artifact }; },
  });
  const schedule = store.create(WHO, daily()); clock.at = schedule.nextAt;
  await scheduler.tick(); await Promise.all([...scheduler.running.values()]);
  const [run] = store.runs(WHO, schedule.id);
  assert.deepEqual(seen, ["SENSITIVE-REPORT-CONTENT"]);
  assert.doesNotMatch(run.detail, /SENSITIVE-REPORT-CONTENT/);
  assert.deepEqual(run.artifact, artifact);
});

test("an ambiguous archive receipt is recorded and the run cannot claim completion", async t => {
  const artifact = { state: "unknown", providerId: "saas-cli", fileToken: null, url: null,
    name: "mydoubao-11111111-1111-4111-8111-111111111111.schedule.md", bytes: 6,
    sha256: "b".repeat(64), archivedAt: 1_000 };
  const { store, scheduler, clock } = await harness(t, {
    execute: async () => ({ report: Buffer.from("report") }),
    postprocess: async () => { throw Object.assign(new Error("报告上传结果不确定，未自动重传"), { artifact }); },
  });
  const schedule = store.create(WHO, daily()); clock.at = schedule.nextAt;
  await scheduler.tick(); await Promise.all([...scheduler.running.values()]);
  const [run] = store.runs(WHO, schedule.id);
  assert.equal(run.outcome, "failed");
  assert.equal(run.artifact.state, "unknown");
  assert.match(run.detail, /不确定/);
});

test("cancelling an executing schedule aborts its executor", async (t) => {
  let signal;
  const { store, scheduler, clock } = await harness(t, { execute: (claim) => {
    signal = claim.signal;
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  const schedule = store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  scheduler.cancel(WHO.tenantId, schedule.id);
  await Promise.all([...scheduler.running.values()]);
  assert.equal(signal.aborted, true);
  assert.equal(store.runs(WHO, schedule.id)[0].outcome, "failed");
  assert.equal(scheduler.controllers.size, 0);
});

test("pause then resume during authorization cannot revive the claimed occurrence", async (t) => {
  let release, asked;
  const asking = new Promise((resolve) => { asked = resolve; });
  const { store, scheduler, clock, ran } = await harness(t, { authorize: () => new Promise(resolve => { release = resolve; asked(); }) });
  const schedule = store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  const ticking = scheduler.tick();
  await asking;
  store.setState(WHO, schedule.id, "paused");
  store.setState(WHO, schedule.id, "active");
  release({ ok: true });
  await ticking;
  assert.deepEqual(ran, []);
  assert.equal(store.runs(WHO, schedule.id)[0].outcome, "skipped");
});

test("it sleeps until the next occurrence and runs it when that time comes", async (t) => {
  const { store, scheduler, clock, ran, timers: fake } = await harness(t);
  store.create(WHO, daily());
  await scheduler.start();
  assert.equal(fake.delay(), HOUR, "08:00 now, 09:00 due -- it waits exactly as long as it has to");
  assert.deepEqual(ran, []);
  clock.at = at(2026, 9, 16, 9, 0);
  await fake.fire();
  await Promise.all([...scheduler.running.values()]);
  assert.deepEqual(ran, ["每天汇总"]);
  assert.equal(store.runs(WHO, store.list(WHO)[0].id)[0].outcome, "completed");
});

test("a server that was down runs the missed occurrence at once, and only once", async (t) => {
  const { store, scheduler, clock, ran, timers: fake } = await harness(t);
  store.create(WHO, daily());
  clock.at = at(2026, 9, 19, 10, 0);          // three days later, and past 09:00
  await scheduler.start();
  assert.equal(fake.delay(), 0, "an overdue schedule does not wait for its next turn");
  await fake.fire();
  await Promise.all([...scheduler.running.values()]);
  await scheduler.tick();
  assert.deepEqual(ran, ["每天汇总"], "the backlog is one run, not three days of them");
});

test("a failed run is recorded as failed and does not stop the schedule", async (t) => {
  const { store, scheduler, clock } = await harness(t, { execute: async () => { throw new Error("飞书读取失败"); } });
  const schedule = store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);
  const [run] = store.runs(WHO, schedule.id);
  assert.equal(run.outcome, "failed");
  assert.match(run.detail, /飞书读取失败/);
  assert.equal(store.get(WHO, schedule.id).state, "active", "tomorrow's run still stands");
  assert.equal(store.get(WHO, schedule.id).nextAt, at(2026, 9, 17, 9, 0));
});

test("no more than the allowed number run at once, and the rest get their turn after", async (t) => {
  const release = [];
  const finish = async (scheduler) => { release.splice(0).forEach((resolve) => resolve({ detail: "ok" })); await Promise.all([...scheduler.running.values()]); };
  const { store, scheduler, clock } = await harness(t, { execute: () => new Promise((resolve) => release.push(resolve)) });
  for (let index = 0; index < 4; index += 1) store.create(WHO, { ...daily(), title: `任务 ${index}` });
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  assert.equal(scheduler.running.size, 2, "the rest wait their turn");
  await finish(scheduler);
  await scheduler.tick();
  assert.equal(scheduler.running.size, 2, "and get it once a slot frees");
  await finish(scheduler);
  assert.equal(scheduler.running.size, 0);
});

test("a full queue waits for a slot instead of spinning", async (t) => {
  const release = [];
  const { store, scheduler, clock, timers: fake } = await harness(t, { execute: () => new Promise((resolve) => release.push(resolve)) });
  for (let index = 0; index < 4; index += 1) store.create(WHO, { ...daily(), title: `任务 ${index}` });
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  // The two it could not start are already overdue, so a timer here would be set
  // for zero milliseconds and wake into the same full queue, forever.
  assert.equal(fake.count(), 0, "nothing is armed while every slot is busy");
  release.splice(0).forEach((resolve) => resolve({ detail: "ok" }));
  await Promise.all([...scheduler.running.values()]);
  assert.equal(fake.delay(), 0, "a freed slot re-arms at once for the work still waiting");
  release.splice(0).forEach((resolve) => resolve({ detail: "ok" }));
});

test("a run that outlasts its own schedule does not start again on top of itself", async (t) => {
  const release = [];
  const { store, scheduler, clock, timers: fake } = await harness(t, { execute: () => new Promise((resolve) => release.push(resolve)) });
  const schedule = store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  assert.equal(scheduler.running.size, 1);
  clock.at = at(2026, 9, 17, 10, 0);            // still running when tomorrow's turn came due
  await scheduler.tick();
  assert.equal(scheduler.running.size, 1, "the slow run keeps its place rather than stacking up");
  assert.equal(fake.count(), 0, "and its overdue next turn does not arm a zero-delay timer that wakes into the same skip");
  release.splice(0).forEach((resolve) => resolve({ detail: "ok" }));
  await Promise.all([...scheduler.running.values()]);
  assert.equal(store.runs(WHO, schedule.id).length, 1, "and only the one run is recorded");
});

test("a task whose login has lapsed stops itself and says so, rather than failing every turn", async (t) => {
  const { store, scheduler, clock, ran } = await harness(t, { authorize: () => ({ ok: false, reason: "登录已过期" }) });
  const schedule = store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  assert.deepEqual(ran, [], "nothing ran -- there is no identity to run it as");
  const [run] = store.runs(WHO, schedule.id);
  assert.equal(run.outcome, "skipped", "and the turn is recorded as skipped, not as a failure");
  assert.match(run.detail, /登录已过期/);
  assert.equal(store.get(WHO, schedule.id).suspendedAt !== null, true);

  // The point of suspending rather than failing: a lapse of weeks leaves one
  // entry in the history, not one per turn for every turn nobody was there.
  clock.at = at(2026, 10, 16, 9, 0);
  await scheduler.tick();
  assert.equal(store.runs(WHO, schedule.id).length, 1, "a month later there is still just the one entry");
  assert.equal((await scheduler.status()).nextDueAt, null, "and the scheduler has stopped waking for it");
});

test("signing in again puts a suspended schedule back on the clock", async (t) => {
  let signedIn = false;
  const { store, scheduler, clock, ran } = await harness(t, { authorize: () => signedIn ? { ok: true } : { ok: false, reason: "登录已过期" } });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  assert.equal(store.list(WHO)[0].suspendedAt !== null, true);

  signedIn = true;
  clock.at = at(2026, 9, 19, 10, 0);
  assert.equal(store.resume(WHO), 1);
  clock.at = at(2026, 9, 20, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);
  assert.deepEqual(ran, ["每天汇总"], "it runs once on its next turn, not once per day it missed");
});

test("closing stops the clock and lets what is running finish", async (t) => {
  const release = [];
  const { store, scheduler, clock, timers: fake } = await harness(t, { execute: () => new Promise((resolve) => release.push(resolve)) });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  const closing = scheduler.close();
  release.forEach((resolve) => resolve({ detail: "ok" }));
  await closing;
  assert.equal(fake.count(), 0, "no timer is left behind");
  assert.deepEqual(await scheduler.status(), { running: 0, nextDueAt: null, closed: true });
});

test("what a finished run concluded is offered to whoever tells the owner", async (t) => {
  const told = [];
  const { store, scheduler, clock } = await harness(t, { notify: (finished) => { told.push(finished); },
    authorize: () => ({ ok: true, parentToken: "parent-token" }) });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);
  await Promise.all([...scheduler.notifying]);

  assert.equal(told.length, 1);
  assert.equal(told[0].outcome, "completed");
  assert.equal(told[0].detail, "ok");
  assert.equal(told[0].schedule.owner, WHO.userId, "the owner travels with it; nothing else knows who to tell");
  assert.equal(told[0].parentToken, "parent-token", "and the identity the run acted as");
});

test("a failed run is told about too, or a task that stopped working never says so", async (t) => {
  const told = [];
  const { store, scheduler, clock } = await harness(t, { notify: (finished) => { told.push(finished); },
    execute: async () => { throw new Error("沙箱未能启动"); } });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);
  await Promise.all([...scheduler.notifying]);

  assert.equal(told.length, 1);
  assert.equal(told[0].outcome, "failed");
  assert.match(told[0].detail, /沙箱未能启动/);
});

test("a notification that fails leaves the run recorded exactly as it was", async (t) => {
  // The run is over and written before anything is sent. An undelivered message
  // must not turn a finished task into a failed one -- they are two different
  // promises, and only the history was promised to the scheduler.
  const { store, scheduler, clock } = await harness(t, { notify: async () => { throw new Error("飞书不可达"); } });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);
  await Promise.all([...scheduler.notifying]);

  const [run] = store.recentRuns(WHO, 10);
  assert.equal(run.outcome, "completed");
  assert.equal(run.detail, "ok");
});

test("a slow notification does not hold the slot the next schedule is waiting for", async (t) => {
  // maxConcurrent is 2. If telling the owner counted against it, two schedules
  // waiting on a reply from Feishu would stop everything else from running.
  let release;
  const { store, scheduler, clock, ran } = await harness(t, { notify: () => new Promise((resolve) => { release = resolve; }) });
  store.create(WHO, daily("09:00"));
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);

  assert.equal((await scheduler.status()).running, 0, "the run is over even though the message is still going");
  assert.equal(scheduler.notifying.size, 1);
  release();
  await Promise.all([...scheduler.notifying]);
  assert.deepEqual(ran, ["每天汇总"]);
});

test("closing waits for a message that is still going out", async (t) => {
  // A notification starts when its run ends, so waiting only for runs would
  // leave a send in flight against a control plane that is shutting down.
  let release; let settled = false;
  const { store, scheduler, clock } = await harness(t, {
    notify: () => new Promise((resolve) => { release = () => { settled = true; resolve(); }; }) });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);

  const closing = scheduler.close();
  assert.equal(settled, false, "it is genuinely still in flight");
  release();
  await closing;
  assert.equal(settled, true);
  assert.equal(scheduler.notifying.size, 0);
});

test("an authorize that has to go and ask is awaited, not treated as a refusal", async (t) => {
  // It used to be called synchronously. Left that way, an async authorize
  // returns a promise, `verdict?.ok` is undefined, and EVERY schedule suspends
  // -- the whole feature off, with "登录已过期" as the explanation.
  const seen = [];
  const { store, scheduler, clock, ran } = await harness(t, {
    authorize: async (schedule) => { await new Promise((resolve) => setTimeout(resolve, 5)); seen.push(schedule.title); return { ok: true, parentToken: "minted-token" }; },
    execute: async (claim) => { ran.push(claim.parentToken); return { detail: "ok" }; } });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);

  assert.deepEqual(seen, ["每天汇总"]);
  assert.deepEqual(ran, ["minted-token"], "the token it minted is the one the run acts as");
  assert.equal(store.runs(WHO, store.list(WHO)[0].id)[0].outcome, "completed");
});

test("a bad moment is a failed turn, not a suspension", async (t) => {
  // A five-minute Feishu outage at 03:00 must not stop a daily task until
  // somebody notices. Tomorrow's occurrence has to survive it.
  const { store, scheduler, clock } = await harness(t, {
    authorize: async () => ({ ok: false, retry: true, reason: "暂时无法与飞书续期" }) });
  const schedule = store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();

  const [run] = store.runs(WHO, schedule.id);
  assert.equal(run.outcome, "failed");
  assert.match(run.detail, /暂时无法与飞书续期/);
  assert.equal(store.get(WHO, schedule.id).suspendedAt, null, "it is not suspended");
  assert.equal(store.get(WHO, schedule.id).nextAt, at(2026, 9, 17, 9, 0), "and tomorrow still stands");
});

test("an authorize that throws is a bad moment, not a crashed process", async (t) => {
  // Reached through `void this.tick()`, a rejection here is unhandled and takes
  // the control plane down with it.
  const { store, scheduler, clock } = await harness(t, {
    authorize: async () => { throw new Error("connect ECONNREFUSED"); } });
  const schedule = store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();

  const [run] = store.runs(WHO, schedule.id);
  assert.equal(run.outcome, "failed");
  assert.match(run.detail, /无法确认这个任务的身份/);
  assert.equal(store.get(WHO, schedule.id).suspendedAt, null);
});

test("two ticks over the same due row produce one run, not two", async (t) => {
  // A tick now yields while it asks who a run acts as, and #arm schedules
  // another from #run's finally. Without collapsing, the same claim runs twice.
  let asked = 0;
  const { store, scheduler, clock, ran } = await harness(t, {
    authorize: async () => { asked += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return { ok: true, parentToken: "t" }; } });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  const [first, second] = [scheduler.tick(), scheduler.tick()];
  await Promise.all([first, second]);
  await Promise.all([...scheduler.running.values()]);

  assert.equal(asked, 1, "the second tick joined the first rather than starting another");
  assert.deepEqual(ran, ["每天汇总"]);
});

test("closing waits for a run whose identity is still being minted", async (t) => {
  let release, asked; let settled = false;
  const asking = new Promise((resolve) => { asked = resolve; });
  const { store, scheduler, clock } = await harness(t, {
    authorize: () => new Promise((resolve) => { release = () => { settled = true; resolve({ ok: false, retry: true, reason: "算了" }); }; asked(); }) });
  store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  const ticking = scheduler.tick();
  await asking;

  const closing = scheduler.close();
  assert.equal(settled, false, "it is genuinely still in flight");
  release();
  await Promise.all([ticking, closing]);
  assert.equal(settled, true);
});

// ---- 立即运行：one run now, through the same path as a due run ----

test("a run now goes through the same identity check, executor, archive and notification, and moves nothing", async t => {
  const notified = [], authorized = [];
  const { store, scheduler, clock, ran } = await harness(t, {
    authorize: async (schedule) => { authorized.push(schedule.id); return { ok: true, parentToken: "owner-token" }; },
    notify: async (value) => { notified.push(value.outcome); },
  });
  const created = store.create(WHO, daily());
  clock.at += 5 * 60_000;
  const answer = await scheduler.runNow(created);
  assert.equal(answer.started, true);
  await Promise.allSettled([...scheduler.running.values()]);
  await Promise.allSettled([...scheduler.notifying]);
  assert.deepEqual(ran, ["每天汇总"], "the executor ran it");
  assert.deepEqual(authorized, [created.id], "as the owner, asked once");
  assert.deepEqual(notified, ["completed"], "and told them");
  const after = store.get(WHO, created.id);
  assert.equal(after.nextAt, created.nextAt, "tomorrow's run is where it was");
  const [run] = store.runs(WHO, created.id);
  assert.equal(run.id, answer.runId);
  assert.equal(run.outcome, "completed");
});

test("a run now is refused while the task is already running, and a due tick cannot slip in while it starts", async t => {
  let release;
  const { store, scheduler, clock, ran } = await harness(t, {
    authorize: async () => ({ ok: true }),
    execute: async (claim) => { ran.push(claim.runId); await new Promise((resolve) => { release = resolve; }); return { detail: "ok" }; },
  });
  const created = store.create(WHO, daily());
  // Due right now as well: without the slot taken first, the tick would claim it too.
  clock.at = created.nextAt;
  const started = scheduler.runNow(created);
  const ticked = scheduler.tick();
  await started; await ticked;
  assert.equal(ran.length, 1, "exactly one run, not the manual one plus the due one");
  await assert.rejects(scheduler.runNow(created), (error) => error.status === 409 && /正在执行/.test(error.message));
  release();
  await Promise.allSettled([...scheduler.running.values()]);
});

// The person pressing 立即运行 is looking at the answer. A refused identity is
// told to them on the spot, in words for this path: the reasons a due run gives
// say the task has been suspended, which a run now never does.
test("a refused identity on a run now is answered on the spot: nothing recorded, nothing suspended", async t => {
  const { store, scheduler, clock, ran } = await harness(t, {
    authorize: async () => ({ ok: false, reason: "登录已过期或未授权定时任务，任务已暂停，重新登录并授权后自动恢复" }) });
  const created = store.create(WHO, daily());
  clock.at += 60_000;
  await assert.rejects(scheduler.runNow(created), (error) => error.status === 409
    && /没有可用的授权，这次没有运行/.test(error.message) && !/已暂停/.test(error.message));
  assert.equal(ran.length, 0);
  const after = store.get(WHO, created.id);
  assert.equal(after.suspendedAt, null, "one manual try does not stop the schedule");
  assert.equal(after.state, "active");
  assert.equal(after.nextAt, created.nextAt);
  assert.equal(store.runs(WHO, created.id).length, 0, "the history is for runs nobody was watching");
  assert.equal(scheduler.running.size, 0, "the slot it took is given back");
});

test("a bad moment on a run now says to try again, and records nothing", async t => {
  const { store, scheduler } = await harness(t, {
    authorize: async () => ({ ok: false, retry: true, reason: "暂时无法与飞书续期（fetch failed），这次跳过，下次仍会尝试。" }) });
  const created = store.create(WHO, daily());
  await assert.rejects(scheduler.runNow(created), (error) => error.status === 503 && /稍后再试/.test(error.message));
  assert.equal(store.runs(WHO, created.id).length, 0);
  assert.equal(scheduler.running.size, 0);
});

// Asking for an identity can cost a Feishu exchange, so what is known without
// asking anyone is checked first.
test("a run now of a task that cannot run is refused before anything is asked or recorded", async t => {
  const asked = [];
  const { store, scheduler, clock } = await harness(t, { authorize: async (schedule) => { asked.push(schedule.id); return { ok: true }; } });
  const suspended = store.create(WHO, daily());
  store.suspend(WHO.tenantId, suspended.id);
  await assert.rejects(scheduler.runNow(store.get(WHO, suspended.id)), (error) => error.status === 409);
  const ending = store.create(WHO, { ...daily(), endAt: clock.at + 2 * 86400_000 });
  clock.at += 3 * 86400_000;
  await assert.rejects(scheduler.runNow(store.get(WHO, ending.id)), (error) => error.status === 409 && /结束日期/.test(error.message));
  assert.deepEqual(asked, [], "no identity was asked for");
  assert.equal(store.runs(WHO, suspended.id).length + store.runs(WHO, ending.id).length, 0);
  assert.equal(scheduler.running.size, 0, "the slot it took is given back");
});

// 参考上一次的结果: a run that could not read its last report still finishes,
// and its history says it ran without one, beside the saved report's link.
test("a run's note is kept beside its result, and a run without one reads as before", async t => {
  const artifact = { state: "verified", providerId: "saas-cli", fileToken: "FileFixture123",
    url: "https://fixture.feishu.cn/file/FileFixture123", name: "mydoubao-11111111-1111-4111-8111-111111111111.schedule.md",
    bytes: 6, sha256: "a".repeat(64), archivedAt: 1_000 };
  const notes = ["（没有读到上一次的结果，这次没有去重参考）", undefined];
  const { store, scheduler, clock } = await harness(t, {
    execute: async () => ({ report: Buffer.from("report"), ...(notes[0] ? { note: notes.shift() } : (notes.shift(), {})) }),
    postprocess: async () => ({ detail: `报告已保存到飞书云盘：${artifact.url}`, artifact }),
  });
  const schedule = store.create(WHO, daily());
  clock.at = schedule.nextAt;
  await scheduler.tick(); await Promise.all([...scheduler.running.values()]);
  assert.equal(store.runs(WHO, schedule.id)[0].detail, `报告已保存到飞书云盘：${artifact.url}（没有读到上一次的结果，这次没有去重参考）`);
  clock.at = store.get(WHO, schedule.id).nextAt;
  await scheduler.tick(); await Promise.all([...scheduler.running.values()]);
  assert.equal(store.runs(WHO, schedule.id)[0].detail, `报告已保存到飞书云盘：${artifact.url}`);
});

// ---- A store that answers promises, and is sometimes away (docs/scaling-plan.md §2.5) ----

// Before a due run is handed to its executor it is claimed and its identity
// settled, both of which wait. A run now of the same task arriving then must
// find the slot taken, as a due tick finds it taken during a run now.
test("a run now arriving while a due run's identity is being settled is refused, not run beside it", async (t) => {
  let release, asked, calls = 0;
  const asking = new Promise((resolve) => { asked = resolve; });
  // The due run's identity waits; anything asked after it is answered at once.
  const authorize = () => (++calls === 1 ? new Promise((resolve) => { release = resolve; asked(); }) : { ok: true });
  const { store, scheduler, clock, ran } = await harness(t, { authorize });
  const schedule = store.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  const ticking = scheduler.tick();
  await asking;
  await assert.rejects(scheduler.runNow(store.get(WHO, schedule.id)), (error) => error.status === 409 && /正在执行/.test(error.message));
  release({ ok: true });
  await ticking;
  await Promise.all([...scheduler.running.values()]);
  assert.deepEqual(ran, ["每天汇总"], "one run");
  assert.equal(store.runs(WHO, schedule.id).length, 1);
});

// What a database restarting looks like from here: every call refused for a
// while, then answered again.
function flaky(store, failures) {
  const down = { left: failures };
  const wrapped = new Proxy(store, { get(target, name) {
    const value = target[name];
    if (typeof value !== "function") return value;
    return (...args) => {
      if (down.left > 0 && name !== "close") { down.left -= 1; return Promise.reject(new Error("connection terminated")); }
      return Promise.resolve(value.apply(target, args));
    };
  } });
  return { wrapped, down };
}

test("a store that is away does not stop the clock: it asks again, and runs what is due once it is back", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-scheduler-"));
  const clock = { at: at(2026, 9, 16, 8, 0) };
  const file = new ScheduleStore({ databaseFile: path.join(directory, "schedules.db"), now: () => clock.at });
  const { wrapped, down } = flaky(file, 0);
  const fake = timers(), events = [], ran = [];
  const scheduler = new Scheduler({ store: wrapped, now: () => clock.at, timers: fake.api, onEvent: (event) => events.push(event),
    execute: async (claim) => { ran.push(claim.schedule.title); return { detail: "ok" }; } });
  t.after(async () => { await scheduler.close(); file.close(); await rm(directory, { recursive: true, force: true }); });
  file.create(WHO, daily());
  // Each call refused counts: a retry reads what is due, then when to wake.
  down.left = 3;
  await scheduler.start();
  assert.equal(events.at(-1).kind, "store-unavailable", "said, not swallowed");
  assert.equal(fake.delay(), 1000, "and asked again a second later");
  await fake.fire();                            // still away: asked again, later
  assert.equal(fake.delay(), 2000);
  await fake.fire();                            // back
  assert.equal(fake.delay(), HOUR, "sleeping until 09:00 as if nothing had happened");
  clock.at = at(2026, 9, 16, 9, 0);
  await fake.fire();
  await Promise.all([...scheduler.running.values()]);
  assert.deepEqual(ran, ["每天汇总"]);
});

test("a result the store cannot take at first is written when it is back, not lost with the run", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-scheduler-"));
  const clock = { at: at(2026, 9, 16, 8, 0) };
  const file = new ScheduleStore({ databaseFile: path.join(directory, "schedules.db"), now: () => clock.at });
  const events = [];
  let refusals = 2;
  const store = new Proxy(file, { get(target, name) {
    if (name === "finish") return (...args) => (refusals-- > 0 ? Promise.reject(new Error("connection terminated")) : target.finish(...args));
    const value = target[name];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const scheduler = new Scheduler({ store, now: () => clock.at, timers: timers().api, recordRetryMs: [5, 5, 5], onEvent: (event) => events.push(event),
    execute: async () => ({ detail: "ok" }) });
  t.after(async () => { await scheduler.close(); file.close(); await rm(directory, { recursive: true, force: true }); });
  const schedule = file.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await scheduler.tick();
  await Promise.all([...scheduler.running.values()]);
  const [run] = file.runs(WHO, schedule.id);
  assert.equal(run.outcome, "completed", "written on the third try");
  assert.deepEqual(events.map((event) => event.kind), ["completed"]);
});

test("the scheduler keeps its promises on the shared database too", async (t) => {
  const { PostgresScheduleStore } = await import("../src/control-plane/schedule-store-postgres.js");
  const { testPostgres } = await import("./helpers/postgres.js");
  const { default: pg } = await import("pg");
  const { randomBytes } = await import("node:crypto");
  const server = await testPostgres(t), pool = new pg.Pool({ ...(await server.database()), max: 4 });
  server.closeFirst(() => pool.end());
  const clock = { at: at(2026, 9, 16, 8, 0) };
  const store = await PostgresScheduleStore.open({ pool, key: randomBytes(32), now: () => clock.at });
  const fake = timers(), ran = [];
  const scheduler = new Scheduler({ store, now: () => clock.at, timers: fake.api, authorize: async () => ({ ok: true, parentToken: "p" }),
    execute: async (claim) => { ran.push([claim.schedule.title, claim.parentToken]); return { detail: "ok" }; } });
  server.closeFirst(() => scheduler.close());
  const schedule = await store.create(WHO, daily());
  await scheduler.start();
  assert.equal(fake.delay(), HOUR);
  clock.at = at(2026, 9, 16, 9, 0);
  await fake.fire();
  await Promise.all([...scheduler.running.values()]);
  clock.at += 60_000;
  const answer = await scheduler.runNow(await store.get(WHO, schedule.id));
  await Promise.all([...scheduler.running.values()]);
  assert.deepEqual(ran, [["每天汇总", "p"], ["每天汇总", "p"]]);
  assert.deepEqual((await store.runs(WHO, schedule.id)).map((run) => [run.kind, run.outcome]), [["manual", "completed"], ["scheduled", "completed"]]);
  assert.equal((await store.runs(WHO, schedule.id))[0].id, answer.runId);
  assert.equal(fake.delay(), HOUR, "and asleep until tomorrow's, looking again within the hour");
});
