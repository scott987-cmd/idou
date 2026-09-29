import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScheduleStore, scheduleDefinition, SCHEDULE_LIMITS } from "../src/control-plane/schedule-store.js";
import { zonedInstant } from "../src/control-plane/schedule-spec.js";
import { reportCandidates } from "../src/control-plane/schedule-report-archive.js";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { PostgresScheduleStore } from "../src/control-plane/schedule-store-postgres.js";
import { openValue, sealValue } from "../src/control-plane/state-store.js";
import { testPostgres } from "./helpers/postgres.js";

const WHO = { tenantId: "tenant-a", userId: "person-a", familyId: "login-a" };
const OTHER = { tenantId: "tenant-b", userId: "person-b", familyId: "login-b" };
// The same person, signing in after the control plane restarted. Sessions,
// credentials and the login family all live in memory, so this is a brand new
// familyId every time -- which is exactly why a schedule cannot be bound to one.
const AGAIN = { tenantId: "tenant-a", userId: "person-a", familyId: "login-a-after-restart" };
const HOUR = 3600_000;
const ZONE = "Asia/Shanghai";
const at = (y, m, d, hh, mm) => zonedInstant({ year: y, month: m, day: d, hour: hh, minute: mm }, ZONE);

// 每天 09:00 -- the rule the reference products show in their own list views.
const daily = () => ({ title: "每天汇总", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork",
  schedule: { frequency: "daily", time: "09:00", timeZone: ZONE } });

// Both stores, one behaviour (docs/scaling-plan.md §2.5): every case here that
// is about what the store does, rather than how its file is laid out, runs on
// this machine's SQLite file and on the shared PostgreSQL.
const KINDS = ["sqlite", "postgres"];
// One server for the file. Its stop is queued for a hook registered here, at
// the top level: handed to `after` from inside a test, it would run when that
// test ended, under every test after it.
const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));

// `reopen` is another store on the same data: the process after a restart, or
// a second coordinator. `raw` reaches under the store the way a newer build, a
// rollback or somebody editing the database would.
async function store(t, { kind = "sqlite", clock = { at: at(2026, 9, 16, 8, 0) } } = {}) {
  if (kind === "postgres") {
    const database = await (await postgres()).database(), key = randomBytes(32), pools = [];
    t.after(async () => { for (const pool of pools) await pool.end(); });
    const reopen = async () => {
      const pool = new pg.Pool({ ...database, max: 4 }); pool.on("error", () => {}); pools.push(pool);
      return PostgresScheduleStore.open({ pool, key, now: () => clock.at });
    };
    const opened = await reopen(), admin = pools[0];
    const grant = (id) => `${WHO.tenantId}\n${id}`;
    const raw = {
      setSpec: (schedule, spec) => admin.query("UPDATE idou_schedules SET spec = $1 WHERE tenant = $2 AND id = $3", [typeof spec === "string" ? spec : JSON.stringify(spec), WHO.tenantId, schedule.id]),
      setNextAt: (id, value) => admin.query("UPDATE idou_schedules SET next_at = $1 WHERE id = $2", [value, id]),
      receipt: async (runId) => ({ ...(await admin.query("SELECT artifact_state, artifact_file_token, artifact_url, artifact_name FROM idou_schedule_runs WHERE id = $1", [runId])).rows[0] }),
      capability: async (id) => openValue(key, "schedule-capability", grant(id), (await admin.query("SELECT capability FROM idou_schedules WHERE id = $1", [id])).rows[0].capability),
      setCapability: (id, text, digest) => admin.query("UPDATE idou_schedules SET capability = $1, capability_digest = $2 WHERE tenant = $3 AND id = $4",
        [sealValue(key, "schedule-capability", grant(id), text), digest, WHO.tenantId, id]),
    };
    return { opened, clock, raw, reopen, admin, kind };
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-schedules-"));
  const stores = [];
  const reopen = async () => { const made = new ScheduleStore({ databaseFile: path.join(directory, "schedules.db"), now: () => clock.at }); stores.push(made); return made; };
  const opened = await reopen();
  t.after(async () => { for (const made of stores) made.close(); await rm(directory, { recursive: true, force: true }); });
  const raw = {
    setSpec: (schedule, spec) => opened.db.prepare("UPDATE schedules SET spec = ? WHERE tenant = ? AND id = ?").run(typeof spec === "string" ? spec : JSON.stringify(spec), WHO.tenantId, schedule.id),
    setNextAt: (id, value) => opened.db.prepare("UPDATE schedules SET next_at = ? WHERE id = ?").run(value, id),
    receipt: (runId) => ({ ...opened.db.prepare("SELECT artifact_state, artifact_file_token, artifact_url, artifact_name FROM schedule_runs WHERE id = ?").get(runId) }),
    capability: (id) => opened.db.prepare("SELECT capability FROM schedules WHERE id = ?").get(id).capability,
    setCapability: (id, text, digest) => opened.db.prepare("UPDATE schedules SET capability = ?, capability_digest = ? WHERE tenant = ? AND id = ?").run(text, digest, WHO.tenantId, id),
  };
  return { opened, clock, directory, raw, reopen, kind };
}

// due() answers "what is due across the whole store", never "is this one due".
// Asserting on it directly reads every other schedule in the test as well, and
// one left ticking from an earlier step quietly becomes the answer -- which is
// what went wrong three times while writing this file. Ask about one schedule.
const isDue = async (store, schedule, when) => (await store.due(when)).some((row) => row.id === schedule.id);

for (const kind of KINDS) test(`${kind}: prompt retention clears inactive instructions, never active or in-flight tasks`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const active = await opened.create(WHO, daily());
  const paused = await opened.create(WHO, { ...daily(), prompt: "PAUSED-MARKER" });
  const suspended = await opened.create(WHO, { ...daily(), prompt: "SUSPENDED-MARKER" });
  const running = await opened.create(WHO, daily());
  await opened.setState(WHO, paused.id, "paused");
  await opened.suspend(WHO.tenantId, suspended.id);
  clock.at = running.nextAt;
  const claim = await opened.claim(running);
  await opened.setState(WHO, running.id, "paused");
  clock.at += 31 * 86400_000;
  for (const bad of [0, -1, NaN, null, "30"]) assert.equal(await opened.prunePrompts(bad), 0);
  assert.equal(await opened.prunePrompts(30 * 86400_000), 2);
  assert.equal((await opened.get(WHO, active.id)).prompt, daily().prompt);
  assert.equal((await opened.get(WHO, running.id)).prompt, daily().prompt);
  assert.equal((await opened.get(WHO, paused.id)).prompt, "");
  assert.equal((await opened.get(WHO, suspended.id)).prompt, "");
  await assert.rejects(async () => await opened.setState(WHO, paused.id, "active"), /编辑补上提示词/);
  assert.equal(await opened.recoverInterruptedRuns(), 1);
  assert.equal((await opened.runs(WHO, running.id))[0].id, claim.runId);
  assert.equal((await opened.runs(WHO, running.id))[0].outcome, "failed");
  assert.equal(await opened.prunePrompts(30 * 86400_000), 1);
  assert.equal(await opened.prunePrompts(30 * 86400_000), 0);
});

// Retention takes the words, not the task. Giving it words again is an edit --
// the person's own act -- and resuming stays a separate click, so an emptied
// task can never come back by itself.
for (const kind of KINDS) test(`${kind}: an expired prompt comes back only through an edit, and stays paused`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  await opened.setState(WHO, schedule.id, "paused");
  clock.at += 31 * 86400_000;
  assert.equal(await opened.prunePrompts(30 * 86400_000), 1);
  await assert.rejects(async () => await opened.setState(WHO, schedule.id, "active"), /编辑补上提示词/);
  const expired = await opened.get(WHO, schedule.id);
  await assert.rejects(async () => await opened.updateDefinition(WHO, schedule.id, { ...daily(), prompt: " " }, expired.updatedAt), /需要说明每次要做什么/);
  const revived = await opened.updateDefinition(WHO, schedule.id, { ...daily(), prompt: "REVIVED" }, expired.updatedAt);
  assert.equal(revived.prompt, "REVIVED");
  assert.equal(revived.state, "paused", "words back, still paused");
  assert.equal((await opened.setState(WHO, schedule.id, "active")).state, "active");
});

test("v3 databases migrate without retaining legacy successful report bodies", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-v3-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = path.join(directory, "schedules.db"), clock = { at: at(2026, 9, 16, 8, 0) };
  const original = new ScheduleStore({ databaseFile, now: () => clock.at });
  const schedule = original.create(WHO, daily());
  clock.at = schedule.nextAt;
  const claim = original.claim(schedule);
  original.finish(WHO.tenantId, claim.runId, "completed", "fixture result");
  original.close();
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`ALTER TABLE schedules DROP COLUMN cancellation_revision;
    ALTER TABLE schedule_runs DROP COLUMN artifact_state;
    ALTER TABLE schedule_runs DROP COLUMN artifact_provider;
    ALTER TABLE schedule_runs DROP COLUMN artifact_file_token;
    ALTER TABLE schedule_runs DROP COLUMN artifact_url;
    ALTER TABLE schedule_runs DROP COLUMN artifact_name;
    ALTER TABLE schedule_runs DROP COLUMN artifact_bytes;
    ALTER TABLE schedule_runs DROP COLUMN artifact_sha256;
    ALTER TABLE schedule_runs DROP COLUMN archived_at;
    PRAGMA user_version=3;`);
  legacy.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const migrated = new ScheduleStore({ databaseFile, now: () => clock.at });
    try {
      assert.equal(migrated.get(WHO, schedule.id).prompt, daily().prompt);
      assert.equal(migrated.get(WHO, schedule.id).cancellationRevision, 0);
      const run = migrated.runs(WHO, schedule.id)[0];
      assert.equal(run.detail, null, "legacy successful output is not control-plane storage");
      assert.equal(run.outcome, "completed", "audit history survives the scrub");
      assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 7);
    } finally { migrated.close(); }
  }
});

test("v6 schedules are preserved but paused without inventing a broad resource grant", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-v6-capability-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const databaseFile = path.join(directory, "schedules.db"), clock = { at: at(2026, 9, 16, 8, 0) };
  const current = new ScheduleStore({ databaseFile, now: () => clock.at });
  const created = current.create(WHO, daily());
  current.close();
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`ALTER TABLE schedules DROP COLUMN capability;
    ALTER TABLE schedules DROP COLUMN capability_digest;
    ALTER TABLE schedules DROP COLUMN capability_revision;
    PRAGMA user_version=6;`);
  legacy.close();

  const migrated = new ScheduleStore({ databaseFile, now: () => clock.at });
  try {
    const row = migrated.get(WHO, created.id);
    assert.equal(row.state, "paused");
    assert.equal(row.capability, null, "legacy rows do not inherit tenant-wide read access");
    assert.equal(row.cancellationRevision, 1);
    assert.throws(() => migrated.setState(WHO, row.id, "active"), /资源授权/);
    clock.at = created.nextAt;
    assert.deepEqual(migrated.due(), []);
  } finally { migrated.close(); }
});

for (const kind of KINDS) test(`${kind}: ended schedules expire their prompt even if their stored state was active`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const row = await opened.create(WHO, { ...daily(), endAt: clock.at + 2 * HOUR });
  clock.at += 32 * 86400_000;
  assert.equal(await opened.prunePrompts(30 * 86400_000), 1);
  assert.equal((await opened.get(WHO, row.id)).prompt, "");
  assert.equal((await opened.get(WHO, row.id)).state, "paused");
});

test("a schedule says what to do and when, and refuses what it cannot run", () => {
  assert.equal(scheduleDefinition(daily()).spec.frequency, "daily");
  assert.throws(() => scheduleDefinition({ ...daily(), title: "" }), /名称/);
  assert.throws(() => scheduleDefinition({ ...daily(), prompt: "  " }), /每次要做什么/);
  assert.throws(() => scheduleDefinition({ ...daily(), mode: "feishu" }), /类型/);
  // The rule itself is checked where it is written, in the person's own words.
  assert.throws(() => scheduleDefinition({ ...daily(), schedule: { frequency: "hourly" } }), /执行频率/);
  assert.throws(() => scheduleDefinition({ ...daily(), schedule: { frequency: "daily", time: "9:00" } }), /HH:MM/);
});

for (const kind of KINDS) test(`${kind}: the rule is stored as written and read back the way a person says it`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const weekly = await opened.create(WHO, { ...daily(), schedule: { frequency: "weekly", time: "09:00", weekdays: [1, 3, 5], timeZone: ZONE } });
  assert.equal(weekly.schedule, "每周一、三、五 09:00", "the list shows the rule, not an interval");
  assert.equal(weekly.nextAt, at(2026, 9, 16, 9, 0), "Wednesday, later today");
  // An interval in milliseconds could not express this at all; it is why the
  // first storage model had to be rebuilt.
  assert.deepEqual([...weekly.spec.weekdays], [1, 3, 5]);
  assert.equal(clock.at < weekly.nextAt, true);
});

for (const kind of KINDS) test(`${kind}: schedules survive the process that wrote them`, async (t) => {
  const { opened, reopen } = await store(t, { kind });
  const created = await opened.create(WHO, daily());
  opened.close();
  // The control plane keeps everything else in memory and loses it on restart;
  // a schedule that did that would silently stop happening.
  const second = await reopen();
  assert.deepEqual((await second.list(WHO)).map((row) => row.id), [created.id]);
  assert.equal((await second.get(WHO, created.id)).nextAt, at(2026, 9, 16, 9, 0));
  assert.equal((await second.get(WHO, created.id)).schedule, "每天 09:00");
});

for (const kind of KINDS) test(`${kind}: one tenant's schedules are invisible and untouchable from another's`, async (t) => {
  const { opened } = await store(t, { kind });
  const mine = await opened.create(WHO, daily());
  assert.deepEqual(await opened.list(OTHER), []);
  assert.equal(await opened.get(OTHER, mine.id), null);
  assert.equal(await opened.remove(OTHER, mine.id), false, "another tenant cannot delete it");
  assert.equal((await opened.get(WHO, mine.id)).id, mine.id);
});

for (const kind of KINDS) test(`${kind}: an occurrence is claimed once, even by two schedulers at the same moment`, async (t) => {
  const { opened, clock, reopen } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  // Two stores on the same data, asking at the same moment.
  const other = await reopen();
  const claims = await Promise.all([opened.claim(schedule, clock.at), other.claim(schedule, clock.at)]);
  assert.equal(claims.filter(Boolean).length, 1, "one claim wins; the other finds nothing due");
  assert.equal(claims.find(Boolean).dueAt, at(2026, 9, 16, 9, 0));
  assert.equal((await opened.get(WHO, schedule.id)).nextAt, at(2026, 9, 17, 9, 0), "and the schedule has moved on to tomorrow");
});

for (const kind of KINDS) test(`${kind}: time away does not become a burst of catch-up runs`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  clock.at = at(2026, 9, 19, 10, 0);            // the server was down for three days
  const claim = await opened.claim((await opened.due(clock.at))[0], clock.at);
  assert.ok(claim, "it runs once now");
  assert.equal(await isDue(opened, schedule, clock.at), false, "not once for every day missed");
  assert.equal((await opened.get(WHO, schedule.id)).nextAt, at(2026, 9, 20, 9, 0), "and stays on the person's chosen time");
});

for (const kind of KINDS) test(`${kind}: a one-off runs once and is finished, rather than being due forever`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const once = await opened.create(WHO, { ...daily(), title: "只跑一次", schedule: { frequency: "once", at: at(2026, 9, 16, 19, 15), timeZone: ZONE } });
  assert.equal(once.schedule, "单次 2026-09-16 19:15");
  clock.at = at(2026, 9, 16, 19, 15);
  assert.ok(await opened.claim(once, clock.at), "it runs at its moment");
  const after = await opened.get(WHO, once.id);
  assert.equal(after.state, "paused", "and then it is done");
  assert.equal(await isDue(opened, once, at(2026, 9, 20, 0, 0)), false);
  // Creating one in the past is refused rather than firing immediately.
  await assert.rejects(async () => await opened.create(WHO, { ...daily(), schedule: { frequency: "once", at: at(2026, 9, 1, 9, 0), timeZone: ZONE } }), /已经过去/);
});

for (const kind of KINDS) test(`${kind}: paused stops it, resuming does not replay what was missed, and an end date finishes it`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  await opened.setState(WHO, schedule.id, "paused");
  clock.at = at(2026, 9, 18, 10, 0);
  assert.equal(await isDue(opened, schedule, clock.at), false, "a paused schedule is never due");
  const resumed = await opened.setState(WHO, schedule.id, "active");
  assert.equal(resumed.nextAt, at(2026, 9, 19, 9, 0), "it picks up from now, not from the backlog");

  // The end date bounds the next turn, not the run happening now.
  const ending = await opened.create(WHO, { ...daily(), title: "快到期", endAt: at(2026, 9, 19, 12, 0) });
  assert.equal(ending.nextAt, at(2026, 9, 19, 9, 0));
  await opened.claim(ending, at(2026, 9, 19, 9, 0));
  assert.equal((await opened.get(WHO, ending.id)).state, "paused", "the next turn is past the end, so that run was the last");
});

for (const kind of KINDS) test(`${kind}: a schedule belongs to a person, and records which login set it up`, async (t) => {
  const { opened } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  assert.equal(schedule.owner, "person-a", "the owner is the binding");
  assert.equal(schedule.family, "login-a", "the login is kept as provenance only");
  await assert.rejects(async () => await opened.create({ tenantId: "t", userId: "u" }, daily()), /已登录的用户/);
});

for (const kind of KINDS) test(`${kind}: a lapsed login stops its schedules instead of failing them forever`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  assert.equal(await isDue(opened, schedule, clock.at), true);
  assert.equal(await opened.suspend(WHO.tenantId, schedule.id), true);
  assert.equal(await isDue(opened, schedule, at(2026, 9, 26, 12, 0)), false, "a suspended schedule is never due, however long it waits");
  assert.equal(await opened.nextDueAt(), null, "and the scheduler has nothing to wake up for");
  assert.equal(await opened.claim(schedule, clock.at), null, "nor can one be claimed directly");
  assert.equal(await opened.suspend(WHO.tenantId, schedule.id), false, "suspending twice changes nothing");
});

for (const kind of KINDS) test(`${kind}: signing in again revives what the lapse stopped, and only that`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const lapsed = await opened.create(WHO, daily());
  const byHand = await opened.create(WHO, { ...daily(), title: "我自己停掉的" });
  await opened.setState(WHO, byHand.id, "paused");
  await opened.suspend(WHO.tenantId, lapsed.id);
  await opened.suspend(WHO.tenantId, byHand.id);          // both stopped, for different reasons

  clock.at = at(2026, 9, 25, 10, 0);
  assert.equal(await opened.resume(AGAIN), 2, "both had suspension lifted");
  assert.equal((await opened.get(WHO, lapsed.id)).suspendedAt, null);
  assert.equal((await opened.get(WHO, lapsed.id)).state, "active", "the one the login stopped runs again");
  assert.equal((await opened.get(WHO, byHand.id)).state, "paused", "the one the person stopped stays stopped");
  assert.equal((await opened.get(WHO, lapsed.id)).nextAt, at(2026, 9, 26, 9, 0), "and picks up from now, not from the backlog");
  assert.equal(await isDue(opened, lapsed, clock.at), false, "nothing is owed for the days it was away");
});

for (const kind of KINDS) test(`${kind}: a restart does not orphan a schedule, and another person still cannot touch it`, async (t) => {
  const { opened } = await store(t, { kind });
  const mine = await opened.create(WHO, daily());
  await opened.suspend(WHO.tenantId, mine.id);
  assert.equal(await opened.resume(OTHER), 0, "another tenant's sign-in does nothing");
  assert.equal(await opened.resume({ ...WHO, userId: "person-c" }), 0, "and neither does a different person in the same tenant");
  assert.equal((await opened.get(WHO, mine.id)).suspendedAt !== null, true);
  // Every restart hands the same person a new login family, because none of it
  // is on disk. Bound to the family, a restart would leave every schedule
  // unrunnable AND unreclaimable -- deletable and nothing else.
  assert.equal(await opened.resume(AGAIN), 1, "the same person signing in after a restart gets them back");
  assert.equal((await opened.get(WHO, mine.id)).suspendedAt, null);
});

for (const kind of KINDS) test(`${kind}: every run is recorded, with what became of it`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  const claim = await opened.claim(schedule, clock.at);
  clock.at += 45_000;
  await opened.finish(WHO.tenantId, claim.runId, "failed", "飞书读取失败");
  const [run] = await opened.runs(WHO, schedule.id);
  assert.equal(run.outcome, "failed");
  assert.equal(run.detail, "飞书读取失败");
  assert.equal(run.dueAt, at(2026, 9, 16, 9, 0));
  assert.ok(run.finishedAt > run.startedAt);
  await assert.rejects(async () => await opened.finish(WHO.tenantId, claim.runId, "half-done"), /未知的执行结果/);

  // The 运行记录 view is across every schedule, newest first, and names each one.
  const [recent] = await opened.recentRuns(WHO);
  assert.equal(recent.id, claim.runId);
  assert.equal(recent.title, "每天汇总", "so a row can say which schedule it came from");
  assert.equal(recent.outcome, "failed");
});

// Found wiring desktop notifications, which read this list: it took the
// tenant's newest runs and only then kept the person's own, so a busy colleague
// could push somebody's every run out of their own 运行记录.
for (const kind of KINDS) test(`${kind}: 运行记录 is the person's own newest runs, however busy the rest of the tenant is`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const COLLEAGUE = { tenantId: WHO.tenantId, userId: "person-b", familyId: "login-b" };
  const mine = await opened.create(WHO, daily()), theirs = await opened.create(COLLEAGUE, daily());
  const own = await opened.claimNow(mine, clock.at);
  await opened.finish(WHO.tenantId, own.runId, "completed");
  for (let n = 0; n < 60; n += 1) {
    clock.at += 1000;
    await opened.finish(WHO.tenantId, (await opened.claimNow(theirs, clock.at)).runId, "completed");
  }
  const listed = await opened.recentRuns(WHO, 50);
  assert.deepEqual(listed.map((run) => run.id), [own.runId], "only mine, and mine is there");
  assert.equal((await opened.recentRuns(COLLEAGUE, 50)).length, 50);
});

test("a store written before wall-clock rules keeps its schedules, as the rule they stood for", async (t) => {
  // v1 and v2 stored an interval in milliseconds. This migration only ever runs
  // against a database that already holds real schedules, so it is the one path
  // that cannot be left to run for the first time in front of a person's data.
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-schedules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "schedules.db"), start = at(2026, 9, 16, 9, 0);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE schedules (
    tenant TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, family TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL, prompt TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('cowork','coding')),
    interval_ms INTEGER NOT NULL CHECK(interval_ms >= 300000),
    start_at INTEGER NOT NULL, end_at INTEGER, next_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','paused')), suspended_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(tenant,id)
  ) STRICT; PRAGMA user_version=2;`);
  old.prepare(`INSERT INTO schedules VALUES ('tenant-a','kept','person-a','login-old','旧任务','做点什么','cowork',86400000,?,NULL,?,'active',NULL,?,?)`)
    .run(start, start, start, start);
  old.close();

  const opened = new ScheduleStore({ databaseFile: file, now: () => start });
  t.after(() => opened.close());
  const [kept] = await opened.list(WHO);
  assert.equal(kept.id, "kept", "the schedule that was already there survives");
  assert.equal(kept.title, "旧任务");
  assert.equal(kept.family, "login-old", "and what v2 already recorded is carried across");
  assert.equal(kept.schedule, "每天 09:00", "its daily interval is read as the daily rule it stood for");
  assert.equal(kept.nextAt, start);
});

// Counted per person since 2026-09-26: a whole tenant used to be allowed 50
// (test/capacity.test.js has the tenant's own ceiling).
for (const kind of KINDS) test(`${kind}: a person cannot fill the server with schedules`, async (t) => {
  const { opened } = await store(t, { kind });
  for (let index = 0; index < SCHEDULE_LIMITS.perUser; index += 1) await opened.create(WHO, daily());
  await assert.rejects(async () => await opened.create(WHO, daily()), /一个人最多/);
  await assert.doesNotReject(async () => await opened.create({ ...WHO, userId: "person-a2", familyId: "login-a2" }, daily()), "somebody else in the same tenant is unaffected");
  await assert.doesNotReject(async () => await opened.create(OTHER, daily()), "and so is another tenant");
});

for (const kind of KINDS) test(`${kind}: what a run said is cleared after its window; that it ran is not`, async (t) => {
  // The control plane stores this because at the moment of the run it is the
  // only place the result exists. It stops being the only place once the
  // desktop mirrors finished runs into the person's own task records, so
  // keeping it here for good is an archive nobody agreed to.
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  const first = await opened.claim(schedule, clock.at);
  await opened.finish(WHO.tenantId, first.runId, "completed", "昨天的十条要点……");

  clock.at += 29 * 86400_000;
  assert.equal(await opened.pruneRunDetail(30 * 86400_000), 0, "inside the window nothing is touched");
  assert.equal((await opened.runs(WHO, schedule.id))[0].detail, "昨天的十条要点……");

  clock.at += 2 * 86400_000;
  assert.equal(await opened.pruneRunDetail(30 * 86400_000), 1);
  const [run] = await opened.runs(WHO, schedule.id);
  assert.equal(run.detail, null, "the words are gone");
  assert.equal(run.outcome, "completed", "and the history is not");
  assert.equal(run.startedAt, first.startedAt ?? run.startedAt);
  assert.equal(await opened.pruneRunDetail(30 * 86400_000), 0, "a second pass finds nothing left to clear");
});

for (const kind of KINDS) test(`${kind}: a run still going is never pruned, whatever the window`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  await opened.claim(schedule, clock.at);
  clock.at += 400 * 86400_000;
  assert.equal(await opened.pruneRunDetail(1), 0, "an unfinished run has no finished_at and must not be touched");
  assert.equal((await opened.runs(WHO, schedule.id))[0].outcome, null);
});

for (const kind of KINDS) test(`${kind}: a nonsense retention clears nothing rather than everything`, async (t) => {
  // The failure that matters: a bad value turning into "delete all of it".
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  const run = await opened.claim(schedule, clock.at);
  await opened.finish(WHO.tenantId, run.runId, "completed", "要点");
  for (const bad of [0, -1, NaN, null, undefined, "30", 1.5]) assert.equal(await opened.pruneRunDetail(bad), 0, `refused: ${String(bad)}`);
  assert.equal((await opened.runs(WHO, schedule.id))[0].detail, "要点");
});

// ---- Editing a task, and running one now (parity with WorkBuddy's 编辑 and 测试运行) ----

import { makeScheduleCapability, validateScheduleCapability } from "../src/control-plane/schedule-capability.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const granted = (endAt = null) => makeScheduleCapability({ feishu: SAAS_FEISHU, who: WHO, validUntil: endAt, resources: [
  { kind: "sheet", reference: "https://exampletenant.feishu.cn/sheets/hp86Fs23V4sf0zG0R8ozi2qLABy?sheet=20RQ2y", label: "台账" },
  { kind: "chat", id: "oc_0123456789abcdef0123456789abcdef", label: "项目群" },
] });

for (const kind of KINDS) test(`${kind}: editing a task changes what it is and never what it may read`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const created = await opened.create(WHO, { ...daily(), capabilityBinding: granted() });
  clock.at += HOUR;
  const edited = await opened.updateDefinition(WHO, created.id, { title: "每周汇总", prompt: "把上周的要点列出来。", mode: "cowork",
    schedule: { frequency: "weekly", time: "10:30", weekdays: [1, 3], timeZone: ZONE } }, created.updatedAt);
  assert.equal(edited.title, "每周汇总");
  assert.equal(edited.prompt, "把上周的要点列出来。");
  assert.deepEqual(edited.spec.weekdays, [1, 3]);
  assert.notEqual(edited.nextAt, created.nextAt, "the next run follows the rule as it now reads");
  // The grant is untouched: same manifest, same digest, same revision.
  assert.deepEqual(edited.capability, created.capability);
  assert.equal(edited.capabilityDigest, created.capabilityDigest);
  assert.equal(edited.capabilityRevision, created.capabilityRevision);
  assert.equal(edited.cancellationRevision ?? 0, created.cancellationRevision ?? 0, "an edit that keeps the grant cancels nothing");
});

// The trap this project has met twice: a spreadsheet's link does not carry its
// worksheet, so rebuilding a grant from its links widens one sheet to the whole
// workbook. A new end date renews the grant from the stored manifest instead.
for (const kind of KINDS) test(`${kind}: a new end date renews the grant to the next revision, keeping the one worksheet it named`, async (t) => {
  const { opened } = await store(t, { kind });
  const created = await opened.create(WHO, { ...daily(), capabilityBinding: granted() });
  const endAt = at(2026, 12, 31, 23, 59);
  const edited = await opened.updateDefinition(WHO, created.id, { ...daily(), endAt }, created.updatedAt);
  assert.equal(edited.capabilityRevision, created.capabilityRevision + 1);
  assert.equal(edited.capability.validUntil, endAt);
  assert.deepEqual(edited.capability.resources, created.capability.resources, "the same resources, the one sheet included");
  assert.equal(edited.capability.resources.find((row) => row.kind === "sheet").subId, "20RQ2y");
  assert.doesNotThrow(() => validateScheduleCapability({ capability: edited.capability, digest: edited.capabilityDigest, revision: edited.capabilityRevision },
    { tenantId: WHO.tenantId, userId: WHO.userId }));
  assert.equal(edited.cancellationRevision, (created.cancellationRevision ?? 0) + 1, "a run holding the old grant is cancelled");
});

for (const kind of KINDS) test(`${kind}: an edit made against an older version of the task is refused, not merged`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const created = await opened.create(WHO, daily());
  const first = await opened.updateDefinition(WHO, created.id, { ...daily(), title: "第一次改" }, created.updatedAt);
  clock.at += 1;
  await assert.rejects(async () => await opened.updateDefinition(WHO, created.id, { ...daily(), title: "旧窗口" }, created.updatedAt), /已经变化/);
  assert.equal((await opened.get(WHO, created.id)).title, "第一次改");
  // A run that moved the task on while a dialog was open counts as a change too.
  clock.at = first.nextAt;
  assert.ok(await opened.claim(await opened.get(WHO, created.id), clock.at));
  await assert.rejects(async () => await opened.updateDefinition(WHO, created.id, { ...daily(), title: "对话框开着时跑过了" }, first.updatedAt), /已经变化/);
});

for (const kind of KINDS) test(`${kind}: an edit keeps a paused task paused, and reaches only the owner's own tasks`, async (t) => {
  const { opened } = await store(t, { kind });
  const created = await opened.create(WHO, daily());
  const paused = await opened.setState(WHO, created.id, "paused");
  const edited = await opened.updateDefinition(WHO, created.id, { ...daily(), title: "暂停中改名" }, paused.updatedAt);
  assert.equal(edited.state, "paused");
  const stranger = { ...WHO, userId: "person-other" };
  await assert.rejects(async () => await opened.updateDefinition(stranger, created.id, daily(), edited.updatedAt), /找不到/);
});

for (const kind of KINDS) test(`${kind}: a run now is recorded like any run and moves nothing about the schedule`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const created = await opened.create(WHO, daily());
  clock.at += 5 * 60_000;
  const claim = await opened.claimNow(created, clock.at);
  assert.ok(claim?.runId);
  assert.equal(claim.manual, true);
  const after = await opened.get(WHO, created.id);
  assert.equal(after.nextAt, created.nextAt, "the next scheduled run is where it was");
  assert.equal(after.state, created.state);
  const [run] = await opened.runs(WHO, created.id);
  assert.equal(run.id, claim.runId);
  assert.equal(run.dueAt, clock.at);
});

for (const kind of KINDS) test(`${kind}: a run now is refused for a task that cannot run: suspended, past its end, or without words`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const suspended = await opened.create(WHO, daily());
  await opened.suspend(WHO.tenantId, suspended.id);
  assert.equal(await opened.claimNow(await opened.get(WHO, suspended.id), clock.at), null);
  const ending = await opened.create(WHO, { ...daily(), endAt: at(2026, 9, 20, 0, 0) });
  clock.at = at(2026, 9, 21, 0, 0);
  assert.equal(await opened.claimNow(ending, clock.at), null);
});

// 运行记录, one record at a time, the way WorkBuddy offers it: 归档 moves a run
// into 已归档 and 取消归档 brings it back; 删除 takes that one record and nothing
// else. Neither reaches a run still going, or anybody else's.
for (const kind of KINDS) test(`${kind}: a finished run is set aside into 已归档 and brought back, and never while it is still going`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  const done = await opened.claimNow(schedule, clock.at);
  clock.at += 1000;
  await opened.finish(WHO.tenantId, done.runId, "completed", "报告已保存");
  clock.at += 1000;
  const going = await opened.claimNow(schedule, clock.at);

  clock.at += 1000;
  const shelvedAt = clock.at;
  const set = await opened.shelveRun(WHO, done.runId, true);
  assert.equal(set.id, done.runId);
  assert.equal(set.shelvedAt, shelvedAt);
  assert.deepEqual((await opened.recentRuns(WHO)).map((run) => run.id), [going.runId], "out of 运行记录");
  assert.deepEqual((await opened.recentRuns(WHO, 50, "shelved")).map((run) => run.id), [done.runId], "and into 已归档");
  clock.at += 1000;
  assert.equal((await opened.shelveRun(WHO, done.runId, true)).shelvedAt, shelvedAt, "setting aside twice keeps the first time");
  // Still its schedule's history: one schedule's own list is every run it made.
  assert.deepEqual((await opened.runs(WHO, schedule.id)).map((run) => run.id), [going.runId, done.runId]);

  assert.equal((await opened.shelveRun(WHO, done.runId, false)).shelvedAt, null);
  assert.deepEqual((await opened.recentRuns(WHO)).map((run) => run.id), [going.runId, done.runId], "取消归档 puts it back");
  assert.deepEqual(await opened.recentRuns(WHO, 50, "shelved"), []);

  assert.equal(await opened.shelveRun(WHO, going.runId, true), null, "a run still going has nothing to set aside");
  assert.equal((await opened.getRun(WHO, going.runId)).shelvedAt, null);
});

for (const kind of KINDS) test(`${kind}: deleting one run takes that record only; someone else's, or one still going, is untouched`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const COLLEAGUE = { tenantId: WHO.tenantId, userId: "person-b", familyId: "login-b" };
  const schedule = await opened.create(WHO, daily()), theirs = await opened.create(COLLEAGUE, daily());
  const first = await opened.claimNow(schedule, clock.at);
  await opened.finish(WHO.tenantId, first.runId, "failed", "飞书读取失败");
  clock.at += 1000;
  const second = await opened.claimNow(schedule, clock.at);
  await opened.finish(WHO.tenantId, second.runId, "completed");
  clock.at += 1000;
  const going = await opened.claimNow(schedule, clock.at);
  const colleague = await opened.claimNow(theirs, clock.at);
  await opened.finish(WHO.tenantId, colleague.runId, "completed");

  assert.equal(await opened.deleteRun(COLLEAGUE, first.runId), false, "a colleague in the same tenant cannot delete my run");
  assert.equal(await opened.shelveRun(COLLEAGUE, first.runId, true), null, "or set it aside");
  assert.equal(await opened.getRun(COLLEAGUE, first.runId), null, "or read it");
  assert.equal(await opened.deleteRun(OTHER, first.runId), false, "nor can another tenant");
  assert.equal(await opened.deleteRun(WHO, colleague.runId), false, "and I cannot delete theirs");
  assert.equal(await opened.deleteRun(WHO, going.runId), false, "a run still going is not deleted out from under itself");

  assert.equal(await opened.deleteRun(WHO, first.runId), true);
  assert.equal(await opened.deleteRun(WHO, first.runId), false, "and it is gone");
  assert.deepEqual((await opened.runs(WHO, schedule.id)).map((run) => run.id), [going.runId, second.runId], "the other runs stay");
  assert.ok(await opened.get(WHO, schedule.id), "and so does the schedule");
  assert.equal((await opened.runs(COLLEAGUE, theirs.id)).length, 1);
});

for (const kind of KINDS) test(`${kind}: 运行记录 is narrowed before it is cut to 50, so last month's failure is still found`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  const failed = await opened.claimNow(schedule, clock.at);
  await opened.finish(WHO.tenantId, failed.runId, "failed", "飞书读取失败");
  clock.at += 1000;
  const skipped = await opened.claimNow(schedule, clock.at);
  await opened.finish(WHO.tenantId, skipped.runId, "skipped", "无人值守授权已到期，任务已暂停。");
  for (let n = 0; n < 60; n += 1) {
    clock.at += 1000;
    await opened.finish(WHO.tenantId, (await opened.claimNow(schedule, clock.at)).runId, "completed");
  }
  clock.at += 1000;
  const going = await opened.claimNow(schedule, clock.at);

  assert.equal((await opened.recentRuns(WHO, 50)).some((run) => run.outcome !== "completed" && run.finishedAt !== null), false, "outside the newest 50");
  assert.deepEqual((await opened.recentRuns(WHO, 50, "failed")).map((run) => run.id), [skipped.runId, failed.runId], "失败 includes a run that never happened");
  assert.deepEqual((await opened.recentRuns(WHO, 50, "running")).map((run) => run.id), [going.runId]);
  assert.equal((await opened.recentRuns(WHO, 50, "completed")).length, 50);
  assert.ok((await opened.recentRuns(WHO, 50, "completed")).every((run) => run.outcome === "completed"));

  await opened.shelveRun(WHO, failed.runId, true);
  assert.deepEqual((await opened.recentRuns(WHO, 50, "failed")).map((run) => run.id), [skipped.runId], "a set-aside failure shows only under 已归档");
  for (const bad of ["archived", "constructor", "__proto__", "r.shelved_at IS NULL OR 1=1", 7, null]) {
    await assert.rejects(async () => await opened.recentRuns(WHO, 50, bad), /筛选条件无效/, `refused: ${String(bad)}`);
  }
});

test("setting runs aside adds a column, not a version, so the build before this still opens the store", async (t) => {
  const { opened, clock, directory } = await store(t);
  const schedule = await opened.create(WHO, daily());
  const run = await opened.claimNow(schedule, clock.at);
  await opened.finish(WHO.tenantId, run.runId, "completed");
  await opened.shelveRun(WHO, run.runId, true);
  assert.equal(opened.db.prepare("PRAGMA user_version").get().user_version, 7,
    "a build from before this refuses any version it does not know");
  opened.close();

  // A store written by that earlier build: no such column. Opening it adds one,
  // and every run it held is simply not set aside.
  const databaseFile = path.join(directory, "schedules.db");
  const earlier = new DatabaseSync(databaseFile);
  earlier.exec("ALTER TABLE schedule_runs DROP COLUMN shelved_at");
  earlier.close();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const again = new ScheduleStore({ databaseFile, now: () => clock.at });
    try {
      assert.equal(again.getRun(WHO, run.runId).shelvedAt, null);
      assert.equal(again.db.prepare("PRAGMA user_version").get().user_version, 7);
    } finally { again.close(); }
  }
});

// What a newer build leaves behind when this one is rolled back underneath it:
// a rule written there, read here.

for (const kind of KINDS) test(`${kind}: a rule from a newer build is never due here, and does not hold up anything that is`, async (t) => {
  const { opened, clock, raw } = await store(t, { kind });
  const newer = await opened.create(WHO, daily());
  const ordinary = await opened.create(WHO, { ...daily(), title: "普通", schedule: { frequency: "daily", time: "10:00", timeZone: ZONE } });
  await raw.setSpec(newer, { frequency: "every-minutes", everyMinutes: 30, time: "09:00", timeZone: ZONE });

  clock.at = at(2026, 9, 16, 9, 30);
  assert.equal(await isDue(opened, newer, clock.at), false, "overdue by its stored time, and still not run here");
  assert.equal(await opened.claim(await opened.get(WHO, newer.id), clock.at), null);
  // The scheduler sleeps until nextDueAt. An overdue row it can never start
  // would make that "now" forever, and it stops arming a timer at all.
  assert.equal(await opened.nextDueAt(), at(2026, 9, 16, 10, 0), "it wakes for the one it can run");
  const listed = await opened.get(WHO, newer.id);
  assert.equal(listed.ruleSupported, false);
  assert.equal(listed.schedule, "新版本的执行规则");
  assert.equal(listed.nextAt, at(2026, 9, 16, 9, 0), "and its time is left for the build that knows it");
  assert.equal((await opened.get(WHO, ordinary.id)).ruleSupported, true);

  clock.at = at(2026, 9, 16, 10, 0);
  assert.equal(await isDue(opened, ordinary, clock.at), true);
  assert.ok(await opened.claim(await opened.get(WHO, ordinary.id), clock.at));

  // Resuming after sign-in computes a next time; a rule without one keeps its own.
  await opened.suspend(WHO.tenantId, newer.id);
  assert.equal(await opened.resume(WHO), 1);
  assert.equal((await opened.get(WHO, newer.id)).nextAt, at(2026, 9, 16, 9, 0));

  // A rule that does not even parse is left out of what is due, rather than
  // failing the query that every other schedule's timer depends on. (The
  // shared database's json column cannot hold one to begin with.)
  if (kind === "sqlite") {
    await raw.setSpec(newer, "{not json");
    await assert.doesNotReject(async () => await opened.due(at(2026, 9, 17, 12, 0)));
    assert.equal(await opened.nextDueAt(), at(2026, 9, 17, 10, 0));
  }
});

for (const kind of KINDS) test(`${kind}: 双周 written by the next build runs every other week here, not every day`, async (t) => {
  const { opened, clock, raw } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  // 2026-09-16 is a Wednesday, in the week that starts on the 14th.
  await raw.setSpec(schedule, { frequency: "biweekly", time: "09:00", weekdays: [3], anchorWeek: "2026-09-14", timeZone: ZONE });
  clock.at = at(2026, 9, 16, 9, 0);
  assert.ok(await opened.claim(await opened.get(WHO, schedule.id), clock.at));
  assert.equal((await opened.get(WHO, schedule.id)).nextAt, at(2026, 9, 30, 9, 0), "two weeks on");
  assert.equal((await opened.get(WHO, schedule.id)).schedule, "每两周的周三 09:00");
});

// .30 read these three and ran them; this build is the first to create them.
for (const kind of KINDS) test(`${kind}: 双周, 每年 and 按间隔 can be created, and a task changed to one, and they read back as written`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const made = [];
  for (const [schedule, words, next] of [
    [{ frequency: "biweekly", time: "09:00", weekdays: [3], timeZone: ZONE }, "每两周的周三 09:00", at(2026, 9, 16, 9, 0)],
    [{ frequency: "yearly", time: "09:00", month: 3, dayOfMonth: 1, timeZone: ZONE }, "每年 3 月 1 日 09:00", at(2027, 3, 1, 9, 0)],
    [{ frequency: "interval", time: "09:00", until: "18:00", everyHours: 2, weekdays: [1, 2, 3, 4, 5], timeZone: ZONE }, "每个工作日 09:00–18:00，每 2 小时一次", at(2026, 9, 16, 9, 0)],
  ]) {
    const created = await opened.create(WHO, { ...daily(), schedule });
    assert.equal(created.schedule, words);
    assert.equal(created.nextAt, next, schedule.frequency);
    assert.equal(created.ruleSupported, true);
    made.push(created);
  }
  const [biweekly] = made;
  assert.equal((await opened.get(WHO, biweekly.id)).spec.anchorWeek, "2026-09-14", "counted from the week it was made in");
  const mine = await opened.create(WHO, daily());
  clock.at += 1000;
  const changed = await opened.updateDefinition(WHO, mine.id, { ...daily(), schedule: { frequency: "yearly", time: "10:00", month: 12, dayOfMonth: 31, timeZone: ZONE } }, mine.updatedAt);
  assert.equal(changed.schedule, "每年 12 月 31 日 10:00");
});

// The way the next new rule arrives: readable in one release, creatable in the
// one after. While it is only readable, a request to create it -- from a newer
// desktop -- is refused in words that name the server as the older side.
test("a rule this build reads but does not yet create is refused as an older server's", () => {
  const input = { ...daily(), schedule: { frequency: "yearly", time: "09:00", month: 3, dayOfMonth: 1, timeZone: ZONE } };
  assert.throws(() => scheduleDefinition(input, { creatable: ["once", "daily", "weekly", "monthly"] }), /服务端版本较旧/);
  assert.equal(scheduleDefinition(input).spec.frequency, "yearly");
});

// What a rollback from the release that scales model budgets finds: a grant
// with more than eight calls. A build whose bound was eight paused such a task
// and wiped its grant on open, as if it were corrupt. This one keeps it.
for (const kind of KINDS) test(`${kind}: a grant with a larger model budget, written by a later build, survives the store being opened`, async (t) => {
  const { opened, raw, reopen } = await store(t, { kind });
  const { createHash } = await import("node:crypto");
  const schedule = await opened.create(WHO, daily());
  const capability = JSON.parse(await raw.capability(schedule.id));
  capability.limits.modelCalls = 74;
  const canonical = (value) => JSON.stringify(value, (_key, item) => (!item || typeof item !== "object" || Array.isArray(item)) ? item
    : Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])));
  await raw.setCapability(schedule.id, JSON.stringify(capability), createHash("sha256").update(canonical(capability)).digest("hex"));
  opened.close();
  const again = await reopen();
  const kept = await again.get(WHO, schedule.id);
  assert.equal(kept.state, "active");
  assert.equal(kept.capability?.limits?.modelCalls, 74);
});

// 参考上一次的结果 (G4): off unless a person asked for it, kept by an edit, and
// what it reads back is the last *verified* report of this schedule only.
for (const kind of KINDS) test(`${kind}: 参考上一次的结果 is off unless asked for, and reads back only this schedule's last verified report`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const plain = await opened.create(WHO, daily());
  assert.equal(plain.memory, false, "a desktop that does not send it gets today's behaviour");
  const remembering = await opened.create(WHO, { ...daily(), memory: true });
  assert.equal(remembering.memory, true);
  clock.at += 1000;
  assert.equal((await opened.updateDefinition(WHO, remembering.id, { ...daily() }, remembering.updatedAt)).memory, false, "an edit that leaves it out turns it off");
  if (kind === "sqlite") assert.equal(opened.db.prepare("PRAGMA user_version").get().user_version, 7, "a column, not a version");

  const artifact = (runId, state, fileToken) => ({ state, providerId: "saas-cli", fileToken, url: fileToken ? `https://x.feishu.cn/file/${fileToken}` : null,
    name: `mydoubao-${runId}.schedule.md`, bytes: 10, sha256: "c".repeat(64), archivedAt: clock.at });
  assert.equal(await opened.previousReport(WHO.tenantId, plain.id), null, "nothing before the first report");
  const first = await opened.claimNow(plain, clock.at);
  await opened.finish(WHO.tenantId, first.runId, "completed", null, artifact(first.runId, "verified", "FileOlder000001"));
  clock.at += 60_000;
  const uncertain = await opened.claimNow(plain, clock.at);
  // An upload whose result was never confirmed can still carry the token it
  // was handed; that is exactly what must not be read back as this task's.
  await opened.finish(WHO.tenantId, uncertain.runId, "failed", "上传结果不确定", artifact(uncertain.runId, "unknown", "FileUnsure00001"));
  assert.equal((await opened.previousReport(WHO.tenantId, plain.id)).fileToken, "FileOlder000001", "an unverified upload is not a report to read");
  clock.at += 60_000;
  const second = await opened.claimNow(plain, clock.at);
  await opened.finish(WHO.tenantId, second.runId, "completed", null, artifact(second.runId, "verified", "FileNewer000002"));
  const previous = await opened.previousReport(WHO.tenantId, plain.id);
  assert.deepEqual({ ...previous, finishedAt: undefined }, { runId: second.runId, finishedAt: undefined, fileToken: "FileNewer000002",
    name: `mydoubao-${second.runId}.schedule.md`, bytes: 10, sha256: "c".repeat(64) });
  assert.equal(await opened.previousReport(WHO.tenantId, remembering.id), null, "and never another schedule's");
  assert.equal(await opened.previousReport(OTHER.tenantId, plain.id), null, "or another tenant's");
});

// Each task keeps its KEPT_REPORTS latest reports (schedule-report-archive.js):
// what it keeps is its verified receipts that still name a file, newest first,
// with the length and digest its file is checked against before an overwrite.
// A run whose report is no longer kept stops naming the file -- neither counted
// as kept nor read back -- while its receipt of what was archived stays.
for (const kind of KINDS) test(`${kind}: a task keeps its verified reports that still name a file, and a superseded run stops naming one`, async (t) => {
  const { opened, clock, raw } = await store(t, { kind });
  const task = await opened.create(WHO, daily()), other = await opened.create(WHO, daily());
  const artifact = (runId, state, fileToken) => ({ state, providerId: "saas-cli", fileToken, url: `https://x.feishu.cn/file/${fileToken}`,
    name: `mydoubao-${runId}.schedule.md`, bytes: 10, sha256: "d".repeat(64), archivedAt: clock.at });
  const archived = [];
  for (const token of ["FileKeptOne0001", "FileKeptTwo0002", "FileKeptThree03"]) {
    clock.at += 60_000;
    const run = await opened.claimNow(task, clock.at);
    await opened.finish(WHO.tenantId, run.runId, "completed", null, artifact(run.runId, "verified", token));
    archived.push(run.runId);
  }
  clock.at += 60_000;
  const unsure = await opened.claimNow(task, clock.at);
  await opened.finish(WHO.tenantId, unsure.runId, "failed", "上传结果不确定", artifact(unsure.runId, "unknown", "FileUnsure00001"));
  clock.at += 60_000;
  const elsewhere = await opened.claimNow(other, clock.at);
  await opened.finish(WHO.tenantId, elsewhere.runId, "completed", null, artifact(elsewhere.runId, "verified", "FileOtherTask01"));

  const kept = async () => (await opened.retainedReports(WHO.tenantId, task.id)).map((row) => row.fileToken);
  assert.deepEqual(await kept(), ["FileKeptThree03", "FileKeptTwo0002", "FileKeptOne0001"], "newest first, verified only, this task only");
  const oldest = (await opened.retainedReports(WHO.tenantId, task.id)).at(-1);
  assert.deepEqual({ ...oldest, archivedAt: typeof oldest.archivedAt }, { runId: archived[0], fileToken: "FileKeptOne0001",
    name: `mydoubao-${archived[0]}.schedule.md`, bytes: 10, sha256: "d".repeat(64), archivedAt: "number" },
  "what an overwrite checks the file against comes from the receipt");
  assert.deepEqual(reportCandidates(await opened.retainedReports(WHO.tenantId, task.id)).map((row) => row.runId), [archived[0]],
    "with three kept, the oldest is the one to overwrite");
  assert.deepEqual(reportCandidates(await opened.retainedReports(WHO.tenantId, other.id)), [], "one kept report: a new file");

  await opened.supersedeReport(OTHER.tenantId, archived[1]);
  assert.equal((await kept()).length, 3, "another tenant cannot supersede this one's report");
  await opened.supersedeReport(WHO.tenantId, archived[0]);
  assert.deepEqual(await kept(), ["FileKeptThree03", "FileKeptTwo0002"]);
  assert.deepEqual(await raw.receipt(archived[0]), { artifact_state: "verified", artifact_file_token: null, artifact_url: null, artifact_name: `mydoubao-${archived[0]}.schedule.md` },
    "the receipt of what was archived stays; the file and its link go");
  await opened.supersedeReport(WHO.tenantId, unsure.runId);
  assert.equal((await raw.receipt(unsure.runId)).artifact_file_token, "FileUnsure00001",
    "an unverified receipt is never touched");
  assert.equal((await opened.previousReport(WHO.tenantId, task.id)).fileToken, "FileKeptThree03", "the report read back is still the newest");
});

// G16: a run says what kind it was, the way WorkBuddy's history does -- 测试运行
// (立即运行) and 补跑 (started well after its time) apart from an ordinary run.
for (const kind of KINDS) test(`${kind}: a run knows whether it was on time, a catch-up, or a run now`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const schedule = await opened.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0) + 60_000;
  const onTime = await opened.claim(await opened.get(WHO, schedule.id), clock.at);
  await opened.finish(WHO.tenantId, onTime.runId, "completed");
  clock.at = at(2026, 9, 17, 9, 0) + 6 * 60_000;
  const late = await opened.claim(await opened.get(WHO, schedule.id), clock.at);
  await opened.finish(WHO.tenantId, late.runId, "completed");
  clock.at += 1000;
  const manual = await opened.claimNow(await opened.get(WHO, schedule.id), clock.at);
  assert.deepEqual((await opened.runs(WHO, schedule.id)).map((run) => [run.id, run.kind]),
    [[manual.runId, "manual"], [late.runId, "catch-up"], [onTime.runId, "scheduled"]]);
});

// G13/G14: each schedule's newest run, for the list row; G12: one task's own
// history, with the same filters as 运行记录.
for (const kind of KINDS) test(`${kind}: the newest run of each of my schedules, and one schedule's own filtered history`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const COLLEAGUE = { tenantId: WHO.tenantId, userId: "person-b", familyId: "login-b" };
  const first = await opened.create(WHO, daily()), second = await opened.create(WHO, { ...daily(), title: "另一个" }), theirs = await opened.create(COLLEAGUE, daily());
  const old = await opened.claimNow(first, clock.at);
  await opened.finish(WHO.tenantId, old.runId, "failed", "飞书读取失败");
  clock.at += 1000;
  const going = await opened.claimNow(first, clock.at);
  await opened.finish(WHO.tenantId, (await opened.claimNow(theirs, clock.at)).runId, "completed");
  const latest = await opened.latestRuns(WHO);
  assert.deepEqual([...latest.keys()], [first.id], "a schedule that never ran has none, and a colleague's is not mine");
  assert.equal(latest.get(first.id).id, going.runId);
  assert.equal(latest.get(first.id).finishedAt, null, "still going");
  assert.equal(latest.has(second.id), false);

  assert.deepEqual((await opened.recentRuns(WHO, 50, "", first.id)).map((run) => run.id), [going.runId, old.runId]);
  assert.deepEqual((await opened.recentRuns(WHO, 50, "failed", first.id)).map((run) => run.id), [old.runId]);
  assert.deepEqual(await opened.recentRuns(WHO, 50, "", second.id), []);
  assert.deepEqual(await opened.recentRuns(COLLEAGUE, 50, "", first.id), [], "not someone else's task's history");
});

// G11: a task's history outlives it, under the name it had, still its owner's
// alone, and goes only when it has aged out or is deleted one by one.
for (const kind of KINDS) test(`${kind}: deleting a task keeps its runs, named, and they age out on their own`, async (t) => {
  const { opened, clock, directory } = await store(t, { kind });
  const COLLEAGUE = { tenantId: WHO.tenantId, userId: "person-b", familyId: "login-b" };
  const doomed = await opened.create(WHO, { ...daily(), title: "要删掉的任务" }), kept = await opened.create(WHO, { ...daily(), title: "留着的任务" });
  const old = await opened.claimNow(doomed, clock.at);
  await opened.finish(WHO.tenantId, old.runId, "completed");
  clock.at += 1000;
  const stays = await opened.claimNow(kept, clock.at);
  await opened.finish(WHO.tenantId, stays.runId, "completed");
  clock.at += 1000;
  assert.equal(await opened.remove(WHO, doomed.id), true);
  const [latest, earlier] = await opened.recentRuns(WHO);
  assert.deepEqual([earlier.id, earlier.title, earlier.taskDeleted], [old.runId, "要删掉的任务", true], "its run stays, under its name");
  assert.equal(latest.taskDeleted, false);
  assert.deepEqual(await opened.recentRuns(COLLEAGUE), [], "and is nobody else's");
  assert.equal((await opened.getRun(WHO, old.runId)).title, "要删掉的任务");
  assert.equal((await opened.shelveRun(WHO, old.runId, true)).shelvedAt, clock.at, "it can still be set aside");
  assert.equal(await opened.deleteRun(COLLEAGUE, old.runId), false);

  // Aged out: a deleted task's run after 90 days; a live task's run never.
  clock.at += 91 * 86_400_000;
  assert.equal(await opened.pruneOrphanRuns(90 * 86_400_000), 1);
  assert.deepEqual(await opened.recentRuns(WHO, 50, "shelved"), []);
  assert.deepEqual((await opened.recentRuns(WHO)).map((run) => run.id), [stays.runId], "a live task's history is not pruned here");

  // A run written by a build from before runs carried an owner is claimed by
  // its task's owner when the store next opens -- before that task can go.
  // (Only this file's store has such runs to find.)
  if (kind !== "sqlite") return;
  const later = await opened.claimNow(await opened.get(WHO, kept.id), clock.at);
  await opened.finish(WHO.tenantId, later.runId, "failed");
  opened.db.prepare("UPDATE schedule_runs SET owner = NULL, schedule_title = NULL WHERE id = ?").run(later.runId);
  opened.close();
  const reopened = new ScheduleStore({ databaseFile: path.join(directory, "schedules.db"), now: () => clock.at });
  t.after(() => reopened.close());
  assert.equal(reopened.db.prepare("SELECT owner, schedule_title FROM schedule_runs WHERE id = ?").get(later.runId).owner, WHO.userId);
  reopened.remove(WHO, kept.id);
  assert.deepEqual(reopened.recentRuns(WHO).map((run) => [run.id, run.title, run.taskDeleted]),
    [[later.runId, "留着的任务", true], [stays.runId, "留着的任务", true]]);
});

// G17: a start date is kept to wherever a next time is worked out. Read since
// .36, which this build rolls back to; set from this one on.
for (const kind of KINDS) test(`${kind}: a start date is set, checked, and kept to everywhere`, async (t) => {
  const { opened, clock, raw } = await store(t, { kind });
  const start = at(2026, 10, 1, 0, 0);
  await assert.rejects(async () => await opened.create(WHO, { ...daily(), startAt: start, endAt: start }), /开始日期要早于结束日期/);
  await assert.rejects(async () => await opened.create(WHO, { ...daily(), startAt: "明天" }), /开始日期不合法/);
  const schedule = await opened.create(WHO, { ...daily(), startAt: start });
  assert.equal(schedule.startAt, start);
  assert.equal(schedule.nextAt, at(2026, 10, 1, 9, 0), "the first run is on its first day, not tomorrow");
  assert.equal((await opened.get(WHO, schedule.id)).startAt, start);

  clock.at += 1000;
  const paused = await opened.setState(WHO, schedule.id, "paused");
  assert.equal((await opened.setState(WHO, schedule.id, "active")).nextAt, at(2026, 10, 1, 9, 0), "resumed, it waits for its first day");
  clock.at += 1000;
  const edited = await opened.updateDefinition(WHO, schedule.id, { ...daily(), schedule: { frequency: "daily", time: "10:00", timeZone: ZONE } }, (await opened.get(WHO, schedule.id)).updatedAt);
  assert.equal(edited.startAt, start, "an edit that says nothing of it keeps it");
  assert.equal(edited.nextAt, at(2026, 10, 1, 10, 0));
  assert.ok(paused);

  // Due too early -- a time a build without start dates worked out -- is not run.
  await raw.setNextAt(schedule.id, at(2026, 9, 17, 10, 0));
  clock.at = at(2026, 9, 17, 10, 0);
  assert.equal(await opened.claim(await opened.get(WHO, schedule.id), clock.at), null);
  assert.equal((await opened.get(WHO, schedule.id)).nextAt, at(2026, 10, 1, 10, 0), "it moves to its first day");
  assert.deepEqual(await opened.runs(WHO, schedule.id), []);

  await opened.suspend(WHO.tenantId, schedule.id);
  await opened.resume(WHO);
  assert.equal((await opened.get(WHO, schedule.id)).nextAt, at(2026, 10, 1, 10, 0), "back after sign-in, still from its first day");

  // Taken away by an edit that says so; the next time is then the rule's own.
  const cleared = await opened.updateDefinition(WHO, schedule.id, { ...daily(), startAt: null }, (await opened.get(WHO, schedule.id)).updatedAt);
  assert.equal(cleared.startAt, null);
  assert.equal(cleared.nextAt, at(2026, 9, 18, 9, 0));
});


// ---- What the shared database adds (docs/scaling-plan.md §2.5) ----

// The file store is synchronous, so its count and its insert could never be
// interleaved; two coordinators' requests on the shared database can be.
for (const kind of KINDS) test(`${kind}: a person's creates arriving at once still stop at the limit`, async (t) => {
  const { opened } = await store(t, { kind });
  const results = await Promise.allSettled(Array.from({ length: SCHEDULE_LIMITS.perUser + 5 }, async () => opened.create(WHO, daily())));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, SCHEDULE_LIMITS.perUser);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => /一个人最多/.test(result.reason.message)));
  assert.equal((await opened.list(WHO)).length, SCHEDULE_LIMITS.perUser);
});

for (const kind of KINDS) test(`${kind}: my own tasks without the rest of the tenant's, and no more of what is due than asked for`, async (t) => {
  const { opened, clock } = await store(t, { kind });
  const COLLEAGUE = { tenantId: WHO.tenantId, userId: "person-b", familyId: "login-b" };
  const mine = await opened.create(WHO, daily());
  await opened.create(COLLEAGUE, daily());
  assert.equal((await opened.list(WHO)).length, 2, "the tenant's");
  assert.deepEqual((await opened.list(WHO, { mine: true })).map((row) => row.id), [mine.id], "and mine alone");
  for (let n = 0; n < 3; n += 1) await opened.create(WHO, daily());
  clock.at = at(2026, 9, 16, 9, 0);
  assert.equal((await opened.due(clock.at)).length, 5);
  assert.equal((await opened.due(clock.at, 2)).length, 2, "after a day down everything is due; the scheduler reads what it can start");
});

test("postgres: what a person wrote, what a run said and what it may read are sealed in the database", async (t) => {
  const { opened, clock, admin } = await store(t, { kind: "postgres" });
  const schedule = await opened.create(WHO, { ...daily(), title: "TITLE-MARKER", prompt: "PROMPT-MARKER", capabilityBinding: granted() });
  clock.at = schedule.nextAt;
  const claim = await opened.claim(schedule, clock.at);
  await opened.finish(WHO.tenantId, claim.runId, "failed", "DETAIL-MARKER");
  const stored = async () => (await admin.query("SELECT s::text AS row FROM idou_schedules s UNION ALL SELECT r::text FROM idou_schedule_runs r")).rows.map((row) => row.row).join("\n");
  const markers = ["TITLE-MARKER", "PROMPT-MARKER", "DETAIL-MARKER", "oc_0123456789abcdef0123456789abcdef", "hp86Fs23V4sf0zG0R8ozi2qLABy"];
  for (const marker of markers) assert.equal((await stored()).includes(marker), false, `${marker} is sealed`);
  assert.equal((await opened.getRun(WHO, claim.runId)).detail, "DETAIL-MARKER", "and opens for the store that holds the key");
  // Deleting the task copies its name onto its runs, still sealed.
  await opened.remove(WHO, schedule.id);
  assert.equal((await stored()).includes("TITLE-MARKER"), false);
  assert.equal((await opened.getRun(WHO, claim.runId)).title, "TITLE-MARKER");
});

test("postgres: a store opened with another key refuses to start, and throws no grant away", async (t) => {
  const { opened, admin } = await store(t, { kind: "postgres" });
  const schedule = await opened.create(WHO, { ...daily(), capabilityBinding: granted() });
  await assert.rejects(PostgresScheduleStore.open({ pool: admin, key: randomBytes(32) }), /另一把密钥/);
  assert.ok((await opened.get(WHO, schedule.id)).capability, "the grant is still there for the key it was sealed with");
  assert.equal((await opened.get(WHO, schedule.id)).state, "active");
});

// bin/migrate-data.js moves these rows; what arrives must be what left, every
// field of every kind of row, and it must read back the same through the store.
test("every task and run moves from the file to the database and back unchanged", async (t) => {
  const file = await store(t), shared = await store(t, { kind: "postgres", clock: file.clock });
  const { opened, clock } = file;
  const COLLEAGUE = { tenantId: WHO.tenantId, userId: "person-b", familyId: "login-b" };
  const granting = opened.create(WHO, { ...daily(), title: "带授权", capabilityBinding: granted(), memory: true });
  const starting = opened.create(WHO, { ...daily(), title: "有开始日期", startAt: at(2026, 10, 1, 0, 0), endAt: at(2026, 12, 31, 0, 0) });
  const paused = opened.create(WHO, { ...daily(), title: "暂停的" }); opened.setState(WHO, paused.id, "paused");
  const suspended = opened.create(COLLEAGUE, { ...daily(), title: "挂起的" }); opened.suspend(WHO.tenantId, suspended.id);
  const doomed = opened.create(WHO, { ...daily(), title: "要删掉的" });
  clock.at = at(2026, 9, 16, 9, 0);
  const done = opened.claim(opened.get(WHO, granting.id), clock.at);
  opened.finish(WHO.tenantId, done.runId, "completed", "报告已保存", { state: "verified", providerId: "saas-cli", fileToken: "FileMoved000001",
    url: "https://x.feishu.cn/file/FileMoved000001", name: `mydoubao-${done.runId}.schedule.md`, bytes: 12, sha256: "e".repeat(64), archivedAt: clock.at });
  opened.shelveRun(WHO, done.runId, true);
  clock.at += 1000;
  const orphan = opened.claimNow(doomed, clock.at); opened.finish(WHO.tenantId, orphan.runId, "failed", "飞书读取失败");
  opened.remove(WHO, doomed.id);
  clock.at += 1000;
  const going = opened.claimNow(opened.get(WHO, granting.id), clock.at);
  clock.at += 31 * 86400_000;
  opened.prunePrompts(30 * 86400_000);

  const before = opened.rows();
  assert.equal(before.schedules.length, 4); assert.equal(before.runs.length, 3);
  await shared.opened.load(before);
  await shared.opened.load(before);
  assert.deepEqual(await shared.opened.rows(), before, "loaded twice, the same rows once");
  const back = await store(t);
  back.opened.load(await shared.opened.rows());
  assert.deepEqual(back.opened.rows(), before, "and back to a file");
  // And they read the same through either store.
  const byId = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const who of [WHO, COLLEAGUE]) {
    assert.deepEqual(byId(await shared.opened.list(who)), byId(opened.list(who)));
    assert.deepEqual(await shared.opened.recentRuns(who, 50, ""), opened.recentRuns(who, 50, ""));
    assert.deepEqual(await shared.opened.recentRuns(who, 50, "shelved"), opened.recentRuns(who, 50, "shelved"));
  }
  assert.deepEqual(await shared.opened.getRun(WHO, going.runId), opened.getRun(WHO, going.runId));
  assert.deepEqual(await shared.opened.previousReport(WHO.tenantId, granting.id), opened.previousReport(WHO.tenantId, granting.id));
  assert.equal(await shared.opened.nextDueAt(), opened.nextDueAt());
});

// 结果还写到 (schedule-deliveries.js): where each result also goes, kept beside
// the task rather than inside its read grant, which an older build validates key
// by key and would pause the task over.
const PLACE_DOC = { kind: "document", id: "DoxcnAbCdEf123456", reference: "https://tenant.feishu.cn/docx/DoxcnAbCdEf123456", label: "周报汇总" };
const PLACE_CHAT = { kind: "chat", id: "oc_1234567890abcdef", label: "产品群" };
for (const kind of KINDS) test(`${kind}: where the results also go is stored with the task, kept by an edit that does not say, replaced by one that does`, async (t) => {
  const { opened, clock, reopen, admin } = await store(t, { kind });
  const plain = await opened.create(WHO, daily());
  assert.deepEqual(plain.deliveries, [], "none unless chosen");
  const placed = await opened.create(WHO, { ...daily(), deliveries: [PLACE_CHAT, PLACE_DOC] });
  assert.deepEqual(placed.deliveries, [PLACE_DOC, PLACE_CHAT]);
  clock.at += 1000;
  const renamed = await opened.updateDefinition(WHO, placed.id, { ...daily(), title: "改名" }, placed.updatedAt);
  assert.deepEqual(renamed.deliveries, [PLACE_DOC, PLACE_CHAT], "an edit from a desktop that does not know of them keeps them");
  clock.at += 1000;
  const narrowed = await opened.updateDefinition(WHO, placed.id, { ...daily(), deliveries: [PLACE_CHAT] }, renamed.updatedAt);
  assert.deepEqual(narrowed.deliveries, [PLACE_CHAT]);
  // What the scheduler hands a run is the same row, and a restart or a second
  // coordinator reads the same list.
  assert.deepEqual((await opened.list(WHO)).find((row) => row.id === placed.id).deliveries, [PLACE_CHAT]);
  assert.deepEqual((await (await reopen()).get(WHO, placed.id)).deliveries, [PLACE_CHAT]);
  clock.at += 1000;
  assert.deepEqual((await opened.updateDefinition(WHO, placed.id, { ...daily(), deliveries: [] }, narrowed.updatedAt)).deliveries, []);
  for (const bad of [[{ kind: "chat", id: "ou_1f2e3d4c5b6a7988" }], [PLACE_DOC, PLACE_CHAT, { ...PLACE_CHAT, id: "oc_2" }, { ...PLACE_CHAT, id: "oc_3" }], [{ ...PLACE_DOC, extra: 1 }]]) {
    await assert.rejects(async () => await opened.create(WHO, { ...daily(), deliveries: bad }), undefined, JSON.stringify(bad));
  }
  if (kind === "postgres") {
    // At rest like the rest of a task: which chats and documents a person's
    // results go to is not readable from the database.
    const again = await opened.create(WHO, { ...daily(), deliveries: [PLACE_DOC, PLACE_CHAT] });
    const bytes = (await admin.query("SELECT deliveries FROM idou_schedules WHERE id = $1", [again.id])).rows[0].deliveries;
    assert.ok(Buffer.isBuffer(bytes));
    assert.doesNotMatch(bytes.toString("latin1"), /oc_1234567890abcdef|DoxcnAbCdEf123456/);
  } else {
    assert.equal(opened.db.prepare("PRAGMA user_version").get().user_version, 7, "a column, not a version");
    // A list that no longer reads as one writes nowhere, rather than failing the task.
    opened.db.prepare("UPDATE schedules SET deliveries = ? WHERE id = ?").run('[{"kind":"chat","id":"ou_x"}]', placed.id);
    assert.deepEqual((await opened.get(WHO, placed.id)).deliveries, []);
    assert.equal((await opened.get(WHO, placed.id)).state, "active");
  }
});

test("where results go is a column the build before it never sees, and a store from that build opens with none", async (t) => {
  const { opened, clock, directory } = await store(t);
  const placed = opened.create(WHO, { ...daily(), deliveries: [PLACE_CHAT] });
  opened.close();
  const databaseFile = path.join(directory, "schedules.db");
  // The build before it selects columns by name and never this one.
  const earlier = new DatabaseSync(databaseFile);
  assert.equal(earlier.prepare("SELECT title FROM schedules WHERE id = ?").get(placed.id).title, "每天汇总");
  earlier.exec("ALTER TABLE schedules DROP COLUMN deliveries");
  earlier.close();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const again = new ScheduleStore({ databaseFile, now: () => clock.at });
    try {
      assert.deepEqual(again.get(WHO, placed.id).deliveries, [], "added again, empty");
      assert.equal(again.db.prepare("PRAGMA user_version").get().user_version, 7);
    } finally { again.close(); }
  }
});
