import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { scheduleSpec, nextOccurrence, describeSchedule, knownRule, FREQUENCIES, CREATABLE } from "./schedule-spec.js";
import { makeDenyAllScheduleCapability, renewScheduleCapability, validateScheduleCapability } from "./schedule-capability.js";
import { scheduleDeliveries } from "./schedule-deliveries.js";
import { EITHER } from "../product-names.js";

const REPORT_NAME = new RegExp(`^${EITHER}-[a-f0-9-]{36}\\.schedule\\.md$`);

// Scheduled work, on the server, so it keeps running with the app closed and the
// person's machine off. That only means anything if it survives a restart too:
// the control plane holds everything else in memory, and a restart today signs
// everyone out. So a schedule is a row, not a timer, and the timer is rebuilt
// from the rows at start.
//
// Isolation is the same as every other store here: tenant and id are the primary
// key, every read and write is scoped by tenant, and one person's schedules are
// unreachable from another's session.
//
// What a schedule may do when it runs is not decided here. This holds only what
// was asked, when it should run, and what happened -- the authorisation to act on
// Feishu is a separate grant with its own expiry and audit, because a schedule
// that could quietly widen its own reach is the one thing this must not allow.
// perUser and perTenant are the defaults a store is opened with; the server
// takes both from its deployment file (loadCapacity). A tenant used to be
// allowed 50 in all -- a pilot's number, for a whole company.
export const SCHEDULE_LIMITS = Object.freeze({
  prompt: 4000, title: 60, perUser: 50, perTenant: 100_000, maxRuns: 200,
});

// What 运行记录 can be narrowed to, as WorkBuddy offers it: 全部, 成功, 失败,
// 运行中, 已归档. Fixed fragments, so a filter is chosen from this table and
// never written into the SQL. A set-aside run shows only under 已归档.
export const RUN_FILTERS = Object.freeze({
  "": "r.shelved_at IS NULL",
  completed: "r.shelved_at IS NULL AND r.outcome = 'completed'",
  // Everything that did not do the work: a skipped run (its authorization had
  // lapsed) wants the person's attention as much as a failed one.
  failed: "r.shelved_at IS NULL AND r.outcome IN ('failed','skipped')",
  running: "r.finished_at IS NULL",
  shelved: "r.shelved_at IS NOT NULL",
});
// A rule this build can run, in SQL, so that what is due -- and when the
// scheduler next wakes -- never includes one it cannot: a row left overdue that
// it could never start would otherwise stop it arming a timer for anything else.
// CASE first, so a row whose rule does not even parse is left out rather than
// failing the whole query.
const KNOWN_RULE = `CASE WHEN json_valid(spec) THEN json_extract(spec, '$.frequency') END IN (${FREQUENCIES.map((rule) => `'${rule}'`).join(",")})`;
// A run is this person's when it says so (G11), or -- written by a build from
// before runs carried an owner -- when its task is theirs. Bound twice: owner.
const MY_RUN = "(r.owner = ? OR (r.owner IS NULL AND s.owner = ?))";
// A finished run of this person's: tenant, run id, owner, tenant, owner.
const OWN_FINISHED_RUN = "tenant = ? AND id = ? AND finished_at IS NOT NULL AND (owner = ? OR (owner IS NULL AND schedule_id IN (SELECT id FROM schedules WHERE tenant = ? AND owner = ?)))";

// How late a scheduled run may start and still be the run it was due as; past
// this it is a 补跑 (G16).
export const CATCH_UP_AFTER_MS = 5 * 60_000;

// 有效期的开始日期 (G17): the first time the rule gives, but not before the day
// the task starts. Every next time is computed through this. Read since .36,
// set since .37 -- so .37 rolls back to a build that keeps to what it wrote.
export const firstOccurrence = (spec, after, startAt) => nextOccurrence(spec, Number.isSafeInteger(startAt) ? Math.max(after, startAt - 1) : after);

// The columns a row is moved with, as this file stores them: what rows()
// answers and load() takes, on either side (schedule-store-postgres.js).
export const SCHEDULE_COLUMNS = Object.freeze(["tenant", "id", "owner", "family", "title", "prompt", "mode", "spec", "end_at", "next_at", "state",
  "suspended_at", "created_at", "updated_at", "cancellation_revision", "capability", "capability_digest", "capability_revision", "memory", "start_at", "deliveries"]);
export const RUN_COLUMNS = Object.freeze(["tenant", "schedule_id", "id", "due_at", "started_at", "finished_at", "outcome", "detail",
  "artifact_state", "artifact_provider", "artifact_file_token", "artifact_url", "artifact_name", "artifact_bytes", "artifact_sha256", "archived_at",
  "shelved_at", "kind", "owner", "schedule_title"]);

const MODES = new Set(["cowork", "coding"]);
export const SCHEDULE_STATES = new Set(["active", "paused"]);
const STATES = SCHEDULE_STATES;
const artifactUrl = value => {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
};

// What a finished run's report receipt must be to be kept: the same checks
// wherever the runs are stored (schedule-store-postgres.js too).
export function checkRunArtifact(artifact) {
  if (artifact !== null && (!artifact || !["verified", "unknown"].includes(artifact.state) ||
      typeof artifact.providerId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(artifact.providerId) ||
      typeof artifact.name !== "string" || !REPORT_NAME.test(artifact.name) ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 4 * 1024 * 1024 ||
      typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.archivedAt) ||
      (artifact.fileToken !== null && (typeof artifact.fileToken !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(artifact.fileToken))) ||
      !artifactUrl(artifact.url))) throw new Error("运行产物记录无效");
}

const clean = (value, limit) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > 0 && text.length <= limit ? text : null;
};

// `creatable` is this build's CREATABLE, and a parameter only so the gate a new
// rule will pass through -- readable one release, creatable the next -- stays
// tested while every rule this build reads is also creatable.
export function scheduleDefinition(input, { now = Date.now(), creatable = CREATABLE } = {}) {
  const title = clean(input?.title, SCHEDULE_LIMITS.title);
  const prompt = clean(input?.prompt, SCHEDULE_LIMITS.prompt);
  if (!title) throw new Error("定时任务需要一个名称");
  if (!prompt) throw new Error("定时任务需要说明每次要做什么");
  if (!MODES.has(input?.mode)) throw new Error("定时任务的类型只能是工作任务或编程任务");
  // Throws with the person's own wording when the rule cannot be carried out.
  const spec = scheduleSpec(input?.schedule, { now });
  // Readable is not the same as creatable here: see CREATABLE. Worded for the
  // one way this is met -- a newer desktop talking to this server.
  if (!creatable.includes(spec.frequency)) throw new Error("服务端版本较旧，还不能创建这种执行规则的任务。请升级并重启服务端后再试。");
  const endAt = input?.endAt === null || input?.endAt === undefined ? null : Number(input.endAt);
  if (endAt !== null && !Number.isSafeInteger(endAt)) throw new Error("结束时间不合法");
  const startAt = input?.startAt === null || input?.startAt === undefined ? null : Number(input.startAt);
  if (startAt !== null) {
    if (!Number.isSafeInteger(startAt)) throw new Error("开始日期不合法");
    if (endAt !== null && startAt >= endAt) throw new Error("开始日期要早于结束日期");
  }
  // Only a clear yes turns it on: a desktop from before this sends nothing, and
  // its tasks behave as they always did.
  return { title, prompt, mode: input.mode, spec, endAt, startAt, memory: input?.memory === true };
}

export class ScheduleStore {
  constructor({ databaseFile, now = Date.now, limits = {} }) {
    this.now = now;
    this.limits = Object.freeze({ perUser: limits.perUser ?? SCHEDULE_LIMITS.perUser, perTenant: limits.perTenant ?? SCHEDULE_LIMITS.perTenant });
    if (![this.limits.perUser, this.limits.perTenant].every((value) => Number.isSafeInteger(value) && value >= 1) || this.limits.perUser > this.limits.perTenant) throw new Error("Invalid schedule limits");
    this.db = new DatabaseSync(databaseFile, { timeout: 1000, allowExtension: false });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1, 2, 3, 4, 5, 6, 7].includes(version)) throw new Error("Unsupported schedule store version");
      // v1 and v2 stored an interval in milliseconds, which cannot express "every
      // weekday at 09:00" at all. Changing a column's shape in SQLite means
      // rebuilding the table, so that is what this does -- carrying each old row
      // across as the daily rule its interval was standing in for.
      if (version === 1 || version === 2) this.#rebuild(version);
      this.db.exec(`CREATE TABLE IF NOT EXISTS schedules (
        tenant TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, family TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL, prompt TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('cowork','coding')),
        spec TEXT NOT NULL, end_at INTEGER, next_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','paused')), suspended_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(tenant,id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS schedule_runs (
        tenant TEXT NOT NULL, schedule_id TEXT NOT NULL, id TEXT NOT NULL,
        due_at INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
        outcome TEXT CHECK(outcome IN ('completed','failed','skipped')), detail TEXT,
        PRIMARY KEY(tenant,id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS schedule_runs_by_schedule ON schedule_runs(tenant, schedule_id, started_at DESC);
      -- A person's schedules are counted on every create, and the due ones are
      -- looked up on every tick: without these, both walked the whole table.
      -- Indexes only, so an older version opening this file is unaffected.
      CREATE INDEX IF NOT EXISTS schedules_by_owner ON schedules(tenant, owner);
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_at) WHERE state = 'active' AND suspended_at IS NULL;`);
      if (version < 4) this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE schedules ADD COLUMN cancellation_revision INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version=4; COMMIT;`);
      if (version < 5) this.db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE schedule_runs ADD COLUMN artifact_state TEXT CHECK(artifact_state IN ('verified','unknown'));
        ALTER TABLE schedule_runs ADD COLUMN artifact_provider TEXT;
        ALTER TABLE schedule_runs ADD COLUMN artifact_file_token TEXT;
        ALTER TABLE schedule_runs ADD COLUMN artifact_url TEXT;
        ALTER TABLE schedule_runs ADD COLUMN artifact_name TEXT;
        ALTER TABLE schedule_runs ADD COLUMN artifact_bytes INTEGER;
        ALTER TABLE schedule_runs ADD COLUMN artifact_sha256 TEXT;
        ALTER TABLE schedule_runs ADD COLUMN archived_at INTEGER;
        PRAGMA user_version=5; COMMIT;`);
      // Before trusted Drive archival, a successful run's `detail` was the
      // sandbox's stdout tail and could therefore contain source-document or
      // chat content. No receipt columns existed to distinguish that legacy
      // body from a safe archive status. Remove only those unreceipted success
      // details; failure diagnostics and verified/unknown artifact receipts
      // remain useful audit evidence.
      if (version < 6) this.db.exec(`BEGIN IMMEDIATE;
        UPDATE schedule_runs SET detail = NULL
          WHERE outcome = 'completed' AND artifact_state IS NULL AND detail IS NOT NULL;
        PRAGMA user_version=6; COMMIT;`);
      // Existing schedules predate per-resource authorization. They are kept for
      // audit and display, but paused rather than silently receiving the old
      // tenant-wide read authority. Recreating one is the explicit grant.
      if (version < 7) {
        const columns = new Set(this.db.prepare("PRAGMA table_info(schedules)").all().map(row => row.name));
        const additions = [
          ["capability", "ALTER TABLE schedules ADD COLUMN capability TEXT"],
          ["capability_digest", "ALTER TABLE schedules ADD COLUMN capability_digest TEXT"],
          ["capability_revision", "ALTER TABLE schedules ADD COLUMN capability_revision INTEGER NOT NULL DEFAULT 1"],
        ].filter(([name]) => !columns.has(name));
        this.db.exec("BEGIN IMMEDIATE");
        try {
          for (const [, sql] of additions) this.db.exec(sql);
          // Only a database that truly lacked the grant columns is legacy. A
          // downgraded fixture or restored metadata with the columns intact must
          // not lose an already valid, explicit grant.
          if (additions.length) this.db.exec("UPDATE schedules SET state='paused', capability=NULL, capability_digest=NULL, cancellation_revision=cancellation_revision+1");
          this.db.exec("PRAGMA user_version=7; COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      }
      // 归档 in 运行记录: a run the person has set aside. Added in place rather
      // than as version 8, because a build from before this refuses any
      // user_version it does not know -- a bump would turn rolling the app back
      // into losing the schedule store. One more nullable column is invisible to
      // it instead: it names the columns it writes and ignores the rest of
      // SELECT *, and all a rollback costs is that set-aside runs show again.
      if (!new Set(this.db.prepare("PRAGMA table_info(schedule_runs)").all().map((row) => row.name)).has("shelved_at")) {
        try { this.db.exec("ALTER TABLE schedule_runs ADD COLUMN shelved_at INTEGER"); }
        catch (error) { if (!/duplicate column name/i.test(error?.message ?? "")) throw error; }
      }
      // What kind of run a row is (G16): a 立即运行 or a 补跑 after the
      // scheduled time was missed; an ordinary scheduled run leaves it empty,
      // as every run from before this did.
      if (!new Set(this.db.prepare("PRAGMA table_info(schedule_runs)").all().map((row) => row.name)).has("kind")) {
        try { this.db.exec("ALTER TABLE schedule_runs ADD COLUMN kind TEXT"); }
        catch (error) { if (!/duplicate column name/i.test(error?.message ?? "")) throw error; }
      }
      // Whose a run is, and what its task was called (G11): kept on the run
      // itself, so deleting a task no longer takes its history with it -- the
      // reference product lists those runs under 已删除的定时任务. Filled in for
      // every run whose task still exists, each time the store opens, so runs
      // written by a build from before this are covered too.
      const runColumns = new Set(this.db.prepare("PRAGMA table_info(schedule_runs)").all().map((row) => row.name));
      for (const [name, type] of [["owner", "TEXT"], ["schedule_title", "TEXT"]]) {
        if (runColumns.has(name)) continue;
        try { this.db.exec(`ALTER TABLE schedule_runs ADD COLUMN ${name} ${type}`); }
        catch (error) { if (!/duplicate column name/i.test(error?.message ?? "")) throw error; }
      }
      this.db.exec(`UPDATE schedule_runs SET
        owner = (SELECT s.owner FROM schedules s WHERE s.tenant = schedule_runs.tenant AND s.id = schedule_runs.schedule_id),
        schedule_title = COALESCE(schedule_title, (SELECT s.title FROM schedules s WHERE s.tenant = schedule_runs.tenant AND s.id = schedule_runs.schedule_id))
        WHERE owner IS NULL AND EXISTS (SELECT 1 FROM schedules s WHERE s.tenant = schedule_runs.tenant AND s.id = schedule_runs.schedule_id)`);
      // 有效期的开始日期 (G17). Read and kept to by this build; set from the next
      // one on, so the build that one rolls back to already keeps to it.
      if (!new Set(this.db.prepare("PRAGMA table_info(schedules)").all().map((row) => row.name)).has("start_at")) {
        try { this.db.exec("ALTER TABLE schedules ADD COLUMN start_at INTEGER"); }
        catch (error) { if (!/duplicate column name/i.test(error?.message ?? "")) throw error; }
      }
      // 参考上一次的结果 (G4), added the same way and for the same reason. A
      // build from before this ignores it, and its edits leave it as it was.
      if (!new Set(this.db.prepare("PRAGMA table_info(schedules)").all().map((row) => row.name)).has("memory")) {
        try { this.db.exec("ALTER TABLE schedules ADD COLUMN memory INTEGER"); }
        catch (error) { if (!/duplicate column name/i.test(error?.message ?? "")) throw error; }
      }
      // Where each result is also written (schedule-deliveries.js), added the
      // same way: a build from before this never selects it, never writes it.
      if (!new Set(this.db.prepare("PRAGMA table_info(schedules)").all().map((row) => row.name)).has("deliveries")) {
        try { this.db.exec("ALTER TABLE schedules ADD COLUMN deliveries TEXT"); }
        catch (error) { if (!/duplicate column name/i.test(error?.message ?? "")) throw error; }
      }
      // A manually corrupted authorization must not stay on the scheduler. The
      // digest cannot be verified in SQL, so do it once at open and fail closed.
      for (const row of this.db.prepare("SELECT * FROM schedules WHERE capability IS NOT NULL").all()) {
        try { this.#capability(row); }
        catch {
          this.db.prepare("UPDATE schedules SET state='paused', capability=NULL, capability_digest=NULL, cancellation_revision=cancellation_revision+1 WHERE tenant=? AND id=?")
            .run(row.tenant, row.id);
        }
      }
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Invalid schedule store");
    } catch (error) { this.db.close(); throw error; }
  }

  // The documented way to change a column in SQLite: build the new table, copy
  // what is still meaningful, swap the names. Wrapped in one transaction so a
  // crash halfway leaves the old table intact rather than a half-migrated one.
  #rebuild(version) {
    const family = version === 2 ? "family" : "''";
    const suspended = version === 2 ? "suspended_at" : "NULL";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`CREATE TABLE schedules_v3 (
        tenant TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, family TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL, prompt TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('cowork','coding')),
        spec TEXT NOT NULL, end_at INTEGER, next_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','paused')), suspended_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(tenant,id)
      ) STRICT;`);
      for (const row of this.db.prepare("SELECT * FROM schedules").all()) {
        // The old interval is read as the daily rule it was standing in for, at
        // whatever wall-clock time its start happened to fall on.
        const clock = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date(row.start_at));
        const spec = JSON.stringify({ frequency: "daily", time: clock, timeZone: "Asia/Shanghai" });
        this.db.prepare(`INSERT INTO schedules_v3 (tenant, id, owner, family, title, prompt, mode, spec, end_at, next_at, state, suspended_at, created_at, updated_at)
          VALUES (?,?,?,${family === "''" ? "''" : "?"},?,?,?,?,?,?,?,${suspended === "NULL" ? "NULL" : "?"},?,?)`)
          .run(...[row.tenant, row.id, row.owner, ...(family === "''" ? [] : [row.family]), row.title, row.prompt, row.mode,
            spec, row.end_at, row.next_at, row.state, ...(suspended === "NULL" ? [] : [row.suspended_at]), row.created_at, row.updated_at]);
      }
      this.db.exec("DROP TABLE schedules; ALTER TABLE schedules_v3 RENAME TO schedules;");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close() { try { this.db.close(); } catch { /* already closed */ } }

  // Every row of both tables as stored, and rows loaded as they are: for moving
  // them between this file and the shared database (bin/migrate-data.js).
  // Loading replaces a row under the same key, so doing it twice is doing it once.
  rows() {
    const plain = (row) => ({ ...row });
    return {
      schedules: this.db.prepare(`SELECT ${SCHEDULE_COLUMNS.join(", ")} FROM schedules ORDER BY tenant, id`).all().map(plain),
      runs: this.db.prepare(`SELECT ${RUN_COLUMNS.join(", ")} FROM schedule_runs ORDER BY tenant, id`).all().map(plain),
    };
  }
  load({ schedules = [], runs = [] }) {
    const insert = (table, columns) => this.db.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(",")})`);
    const schedule = insert("schedules", SCHEDULE_COLUMNS), run = insert("schedule_runs", RUN_COLUMNS);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of schedules) schedule.run(...SCHEDULE_COLUMNS.map((name) => row[name] ?? null));
      for (const row of runs) run.run(...RUN_COLUMNS.map((name) => row[name] ?? null));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  #row(row) {
    if (!row) return null;
    const spec = JSON.parse(row.spec);
    let capability = null;
    try { capability = this.#capability(row); } catch { capability = null; }
    // A list that no longer reads as one writes nowhere, rather than failing the task.
    let deliveries = [];
    try { deliveries = row.deliveries ? scheduleDeliveries(JSON.parse(row.deliveries)) : []; } catch { deliveries = []; }
    return { id: row.id, tenant: row.tenant, owner: row.owner, family: row.family, title: row.title, prompt: row.prompt, deliveries,
      mode: row.mode, spec, schedule: describeSchedule(spec), ruleSupported: knownRule(spec), memory: row.memory === 1, startAt: row.start_at ?? null, endAt: row.end_at, nextAt: row.next_at, state: row.state,
      suspendedAt: row.suspended_at ?? null, cancellationRevision: row.cancellation_revision,
      capability, capabilityDigest: row.capability_digest ?? null, capabilityRevision: row.capability_revision ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  #capability(row) {
    if (row.capability === null || row.capability === undefined) return null;
    let capability; try { capability = JSON.parse(row.capability); } catch { throw new Error("定时任务资源授权无效"); }
    return validateScheduleCapability({ capability, digest: row.capability_digest, revision: row.capability_revision },
      { tenantId: row.tenant, userId: row.owner }).capability;
  }

  create(who, input) {
    const at = this.now(), definition = scheduleDefinition(input, { now: at });
    // A scheduled task belongs to a person, and runs only while that person has
    // a live login. Those are two different bindings and conflating them was a
    // real defect: sessions, credentials and the login family all live in
    // memory, so every control-plane restart hands the same person a brand new
    // familyId. Matched on the family, a restart would orphan every schedule --
    // unable to run and unable to be reclaimed. So the owner is the binding, and
    // the family is recorded only as provenance: which login set this up.
    if (!who?.familyId || !who?.userId || !who?.tenantId) throw new Error("定时任务必须由一个已登录的用户创建");
    const binding = input?.capabilityBinding ?? makeDenyAllScheduleCapability(who, definition.endAt);
    validateScheduleCapability(binding, who);
    if (binding.capability.validUntil !== definition.endAt) throw new Error("定时任务资源授权有效期与任务不一致");
    const nextAt = firstOccurrence(definition.spec, at, definition.startAt);
    if (nextAt === null) throw new Error("这个时间已经过去了");
    if (definition.endAt !== null && definition.endAt <= nextAt) throw new Error("结束时间必须晚于首次执行时间");
    const mine = this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE tenant = ? AND owner = ?").get(who.tenantId, who.userId).n;
    if (mine >= this.limits.perUser) throw new Error(`一个人最多 ${this.limits.perUser} 个定时任务，请先删掉不用的`);
    const all = this.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE tenant = ?").get(who.tenantId).n;
    if (all >= this.limits.perTenant) throw new Error(`这个企业的定时任务已达上限 ${this.limits.perTenant} 个，请联系管理员`);
    const deliveries = scheduleDeliveries(input?.deliveries);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO schedules (tenant, id, owner, family, title, prompt, mode, spec, end_at, next_at, state, created_at, updated_at,
      capability, capability_digest, capability_revision, memory, start_at, deliveries)
      VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?)`)
      .run(who.tenantId, id, who.userId, who.familyId, definition.title, definition.prompt, definition.mode,
        JSON.stringify(definition.spec), definition.endAt, nextAt, at, at, JSON.stringify(binding.capability), binding.digest, binding.revision,
        definition.memory ? 1 : 0, definition.startAt, deliveries.length ? JSON.stringify(deliveries) : null);
    return this.get(who, id);
  }

  // Replacing resources is a new authorization, never an in-place mutation of
  // the old manifest. The revision and digest change atomically, while the
  // cancellation revision kills any run that still holds the previous grant.
  updateCapability(who, id, binding, expectedRevision) {
    const current = this.get(who, id);
    if (!current || current.owner !== who.userId) throw new Error("找不到这个定时任务");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || current.capabilityRevision !== expectedRevision ||
        binding?.revision !== expectedRevision + 1) throw new Error("资源授权已经变化，请刷新后重试");
    validateScheduleCapability(binding, who);
    if (binding.capability.validUntil !== current.endAt) throw new Error("定时任务资源授权有效期与任务不一致");
    const changed = this.db.prepare(`UPDATE schedules SET capability = ?, capability_digest = ?, capability_revision = ?,
      cancellation_revision = cancellation_revision + 1, updated_at = MAX(?, updated_at + 1)
      WHERE tenant = ? AND id = ? AND owner = ? AND capability_revision = ?`)
      .run(JSON.stringify(binding.capability), binding.digest, binding.revision, this.now(), who.tenantId, id, who.userId, expectedRevision).changes;
    if (changed !== 1) throw new Error("资源授权已经变化，请刷新后重试");
    return this.get(who, id);
  }

  // Editing what a task is -- its name, words, rule, kind and end date -- by the
  // same rules that created it. Which resources it may read is a separate change
  // (updateCapability) and is not reachable from here. `updated_at` is the
  // version a person edited against: a second window, or a run that moved the
  // task on while the dialog was open, makes the older edit refuse rather than
  // overwrite. A new end date is a new authorization -- the grant is renewed to
  // the next revision, and the runs holding the old one are cancelled.
  updateDefinition(who, id, input, expectedUpdatedAt) {
    const current = this.get(who, id);
    if (!current || current.owner !== who.userId) throw new Error("找不到这个定时任务");
    if (!current.capability) throw new Error("这个任务没有资源授权，请重新创建定时任务");
    if (!Number.isSafeInteger(expectedUpdatedAt) || current.updatedAt !== expectedUpdatedAt) throw new Error("定时任务已经变化，请刷新后重试");
    const at = this.now(), definition = scheduleDefinition(input, { now: at });
    const renewing = definition.endAt !== current.endAt;
    const binding = renewing ? renewScheduleCapability({ capability: current.capability, revision: current.capabilityRevision }, { validUntil: definition.endAt }) : null;
    if (binding) validateScheduleCapability(binding, who);
    // A paused task keeps its place in the rule and stays paused; an active one
    // moves to the next occurrence of the rule as it now reads.
    // An edit that says nothing about a start date keeps the one the task has:
    // a desktop that cannot show it must not clear it by saving.
    const startAt = input?.startAt === undefined ? current.startAt : definition.startAt;
    // Likewise where the results go: a desktop from before this sends no list,
    // and saving from it must not take away the places chosen elsewhere.
    const deliveries = input?.deliveries === undefined ? current.deliveries : scheduleDeliveries(input.deliveries);
    const nextAt = firstOccurrence(definition.spec, at, startAt);
    if (nextAt === null && current.state === "active") throw new Error("这个时间已经过去了");
    if (definition.endAt !== null && nextAt !== null && definition.endAt <= nextAt) throw new Error("结束时间必须晚于下一次执行时间");
    const changed = this.db.prepare(`UPDATE schedules SET title = ?, prompt = ?, mode = ?, spec = ?, end_at = ?, next_at = ?, updated_at = MAX(?, updated_at + 1),
      capability = COALESCE(?, capability), capability_digest = COALESCE(?, capability_digest), capability_revision = COALESCE(?, capability_revision),
      cancellation_revision = cancellation_revision + ?, memory = ?, start_at = ?, deliveries = ?
      WHERE tenant = ? AND id = ? AND owner = ? AND updated_at = ?`)
      .run(definition.title, definition.prompt, definition.mode, JSON.stringify(definition.spec), definition.endAt, nextAt ?? current.nextAt, at,
        binding ? JSON.stringify(binding.capability) : null, binding?.digest ?? null, binding?.revision ?? null, binding ? 1 : 0,
        definition.memory ? 1 : 0, startAt, deliveries.length ? JSON.stringify(deliveries) : null, who.tenantId, id, who.userId, expectedUpdatedAt).changes;
    if (changed !== 1) throw new Error("定时任务已经变化，请刷新后重试");
    return this.get(who, id);
  }

  get(who, id) { return this.#row(this.db.prepare("SELECT * FROM schedules WHERE tenant = ? AND id = ?").get(who.tenantId, id)) ?? null; }

  // The tenant's tasks, or with `mine` only this person's: what the desktop
  // lists, without reading everybody else's to throw them away.
  list(who, { mine = false } = {}) {
    return (mine
      ? this.db.prepare("SELECT * FROM schedules WHERE tenant = ? AND owner = ? ORDER BY next_at ASC").all(who.tenantId, who.userId)
      : this.db.prepare("SELECT * FROM schedules WHERE tenant = ? ORDER BY next_at ASC").all(who.tenantId)).map((row) => this.#row(row));
  }

  setState(who, id, state) {
    if (!STATES.has(state)) throw new Error("定时任务状态只能是运行或暂停");
    const current = this.get(who, id);
    if (!current) throw new Error("找不到这个定时任务");
    if (state === "active" && !current.prompt) throw new Error("提示词已超过停用保留期，请先编辑补上提示词");
    if (state === "active" && !current.capability) throw new Error("这个任务没有资源授权，请重新创建定时任务");
    // Resuming after a long pause must not fire once for every occurrence missed.
    const nextAt = state === "active" ? firstOccurrence(current.spec, this.now(), current.startAt) ?? current.nextAt : current.nextAt;
    // Automatic completion also sets state=paused during claim(). A separate
    // counter distinguishes that from the owner's cancellation, and a quick
    // pause/resume must never revive an old run's authority.
    this.db.prepare("UPDATE schedules SET state = ?, next_at = ?, updated_at = MAX(?, updated_at + 1), cancellation_revision = cancellation_revision + ? WHERE tenant = ? AND id = ?")
      .run(state, nextAt, this.now(), state === "paused" ? 1 : 0, who.tenantId, id);
    return this.get(who, id);
  }

  // The task goes; its runs stay (G11), each marked with whose it was and what
  // it was called, and are listed under 已删除的定时任务 until they age out or
  // are deleted one by one. One transaction, so a run is never left nameless.
  remove(who, id) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT owner, title FROM schedules WHERE tenant = ? AND id = ?").get(who.tenantId, id);
      if (row) this.db.prepare("UPDATE schedule_runs SET owner = COALESCE(owner, ?), schedule_title = ? WHERE tenant = ? AND schedule_id = ?")
        .run(row.owner, row.title, who.tenantId, id);
      const removed = this.db.prepare("DELETE FROM schedules WHERE tenant = ? AND id = ?").run(who.tenantId, id).changes > 0;
      this.db.exec("COMMIT");
      return removed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // The login this schedule belongs to is gone, so there is nothing to run it
  // as. It stops until someone signs in again -- rather than failing identically
  // every turn until a person happens to look at its history.
  suspend(tenant, id) {
    return this.db.prepare("UPDATE schedules SET suspended_at = ?, updated_at = MAX(?, updated_at + 1) WHERE tenant = ? AND id = ? AND suspended_at IS NULL")
      .run(this.now(), this.now(), tenant, id).changes > 0;
  }

  // On the next sign-in everything that stopped for that reason comes back, and
  // only that: a schedule the person paused by hand stays paused, because being
  // suspended and being paused are not the same thing. Each one picks up from
  // now, so a lapse of weeks is not replayed as weeks of missed runs.
  //
  // Matched on the person, never on the login family -- a new sign-in is always
  // a new family, so matching on that would mean nobody could ever reclaim
  // their own schedules after a restart.
  resume(who) {
    if (!who?.userId || !who?.tenantId) throw new Error("定时任务必须由一个已登录的用户恢复");
    const at = this.now();
    const rows = this.db.prepare("SELECT * FROM schedules WHERE tenant = ? AND owner = ? AND suspended_at IS NOT NULL AND capability IS NOT NULL").all(who.tenantId, who.userId);
    for (const row of rows) {
      const next = firstOccurrence(JSON.parse(row.spec), at, row.start_at);
      this.db.prepare("UPDATE schedules SET suspended_at = NULL, next_at = ?, updated_at = MAX(?, updated_at + 1) WHERE tenant = ? AND id = ?")
        .run(next ?? row.next_at, at, row.tenant, row.id);
    }
    return rows.length;
  }

  // Everything due now, across tenants: the scheduler is server-wide, and each
  // row carries the tenant it belongs to so nothing crosses over.
  // `limit`: the scheduler asks for no more than it could start -- after a
  // day down, every daily task is due at once.
  due(at = this.now(), limit = null) {
    return this.db.prepare(`SELECT * FROM schedules WHERE state = 'active' AND suspended_at IS NULL AND capability IS NOT NULL AND next_at <= ? AND (end_at IS NULL OR end_at > ?) AND ${KNOWN_RULE} ORDER BY next_at ASC
      ${Number.isSafeInteger(limit) && limit > 0 ? `LIMIT ${limit}` : ""}`)
      .all(at, at).map((row) => this.#row(row)).filter(row => row.capability);
  }

  // When the next one is due, so a restarted server can sleep until then rather
  // than poll. Null when nothing is scheduled.
  nextDueAt() {
    const row = this.db.prepare(`SELECT MIN(next_at) AS at FROM schedules WHERE state = 'active' AND suspended_at IS NULL AND capability IS NOT NULL AND (end_at IS NULL OR end_at > next_at) AND ${KNOWN_RULE}`).get();
    return Number.isSafeInteger(row?.at) ? row.at : null;
  }

  // A run is claimed before it is executed: the row moves to its next occurrence
  // in the same transaction, so a second scheduler -- or a restart mid-run --
  // cannot run the same occurrence twice.
  claim(schedule, at = this.now()) {
    const runId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare(`SELECT * FROM schedules WHERE tenant = ? AND id = ? AND state = 'active' AND suspended_at IS NULL AND next_at <= ? AND ${KNOWN_RULE}`)
        .get(schedule.tenant, schedule.id, at);
      if (!current) { this.db.exec("ROLLBACK"); return null; }
      let capability = null; try { capability = this.#capability(current); } catch { /* paused below */ }
      if (!capability) {
        this.db.prepare("UPDATE schedules SET state='paused', cancellation_revision=cancellation_revision+1, updated_at = MAX(?, updated_at + 1) WHERE tenant=? AND id=?")
          .run(at, current.tenant, current.id);
        this.db.exec("COMMIT"); return null;
      }
      // Due before its 有效期 begins -- a time a build that did not know start
      // dates computed -- is not a run: it moves to the first time from then on.
      if (Number.isSafeInteger(current.start_at) && current.start_at > at) {
        const first = firstOccurrence(JSON.parse(current.spec), at, current.start_at);
        this.db.prepare("UPDATE schedules SET next_at = ?, updated_at = MAX(?, updated_at + 1) WHERE tenant = ? AND id = ?")
          .run(first ?? current.start_at, at, current.tenant, current.id);
        this.db.exec("COMMIT"); return null;
      }
      const dueAt = current.next_at;
      // A one-off has no next time once it has run, and a repeating rule can run
      // past its end date. Both finish the schedule rather than leaving a row
      // that is due forever.
      const next = nextOccurrence(JSON.parse(current.spec), at);
      const ended = next === null || (current.end_at !== null && next >= current.end_at);
      this.db.prepare("UPDATE schedules SET next_at = ?, state = ?, updated_at = MAX(?, updated_at + 1) WHERE tenant = ? AND id = ?")
        .run(next ?? dueAt, ended ? "paused" : "active", at, current.tenant, current.id);
      // Started well after its time -- the machine was asleep or the control
      // plane was down -- is a 补跑, and is called one.
      this.db.prepare("INSERT INTO schedule_runs (tenant, schedule_id, id, due_at, started_at, kind, owner, schedule_title) VALUES (?,?,?,?,?,?,?,?)")
        .run(current.tenant, current.id, runId, dueAt, at, at - dueAt >= CATCH_UP_AFTER_MS ? "catch-up" : null, current.owner, current.title);
      this.db.exec("COMMIT");
      return { runId, dueAt, schedule: this.#row(current) };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // A run a person asked for now, outside the rule. It is recorded like any
  // other run but moves nothing: next_at and state stay as they were, so asking
  // for a run never shifts or consumes a scheduled one. Refused for a task that
  // cannot run -- no grant, suspended, no words left, or past its end date,
  // where egress would refuse the run anyway.
  claimNow(schedule, at = this.now()) {
    const runId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT * FROM schedules WHERE tenant = ? AND id = ? AND suspended_at IS NULL AND capability IS NOT NULL AND prompt <> '' AND (end_at IS NULL OR end_at > ?)")
        .get(schedule.tenant, schedule.id, at);
      if (!current) { this.db.exec("ROLLBACK"); return null; }
      let capability = null; try { capability = this.#capability(current); } catch { /* refused below */ }
      if (!capability) { this.db.exec("ROLLBACK"); return null; }
      this.db.prepare("INSERT INTO schedule_runs (tenant, schedule_id, id, due_at, started_at, kind, owner, schedule_title) VALUES (?,?,?,?,?,'manual',?,?)")
        .run(current.tenant, current.id, runId, at, at, current.owner, current.title);
      this.db.exec("COMMIT");
      return { runId, dueAt: at, schedule: this.#row(current), manual: true };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  finish(tenant, runId, outcome, detail = null, artifact = null) {
    if (!["completed", "failed", "skipped"].includes(outcome)) throw new Error("未知的执行结果");
    checkRunArtifact(artifact);
    this.db.prepare(`UPDATE schedule_runs SET finished_at = ?, outcome = ?, detail = ?,
      artifact_state=?, artifact_provider=?, artifact_file_token=?, artifact_url=?, artifact_name=?, artifact_bytes=?, artifact_sha256=?, archived_at=?
      WHERE tenant = ? AND id = ?`).run(this.now(), outcome, detail === null ? null : String(detail).slice(0, 2000),
      artifact?.state ?? null, artifact?.providerId ?? null, artifact?.fileToken ?? null, artifact?.url ?? null,
      artifact?.name ?? null, artifact?.bytes ?? null, artifact?.sha256 ?? null, artifact?.archivedAt ?? null, tenant, runId);
  }

  #run(row, title = undefined) {
    const artifact = row.artifact_state ? { state: row.artifact_state, providerId: row.artifact_provider,
      fileToken: row.artifact_file_token, url: row.artifact_url, name: row.artifact_name,
      bytes: row.artifact_bytes, sha256: row.artifact_sha256, archivedAt: row.archived_at } : null;
    return { id: row.id, ...(title !== undefined ? { scheduleId: row.schedule_id, title } : {}),
      dueAt: row.due_at, startedAt: row.started_at, finishedAt: row.finished_at,
      outcome: row.outcome, detail: row.detail, artifact, shelvedAt: row.shelved_at ?? null, kind: row.kind ?? "scheduled",
      ...(row.task_deleted !== undefined ? { taskDeleted: row.task_deleted === 1 } : {}) };
  }

  runs(who, scheduleId, limit = 20) {
    const rows = this.db.prepare("SELECT * FROM schedule_runs WHERE tenant = ? AND schedule_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(who.tenantId, scheduleId, Math.min(Math.max(1, Number(limit) || 20), SCHEDULE_LIMITS.maxRuns));
    return rows.map((row) => this.#run(row));
  }

  // What a run said stops being kept here after a while; that it ran does not.
  //
  // This text is the container's own output, which for a task that reads a
  // person's documents every morning is their documents. It has to be stored at
  // the moment of the run, because the control plane is then the only place the
  // result exists -- but it stopped being the only place the moment the desktop
  // began mirroring finished runs into the person's own task records, on their
  // own machine under their own account. So this copy is a staging area, and a
  // staging area that keeps everything forever is just the old behaviour with a
  // better name.
  //
  // The row stays. When it ran, whether it succeeded and how long it took are
  // the history, and losing that would hide a task that has been failing for a
  // month. Only the words go.
  pruneRunDetail(olderThanMs) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) return 0;
    const before = this.now() - olderThanMs;
    // `finished_at IS NOT NULL` so a run still going is never touched, and
    // `detail IS NOT NULL` so this reports what it actually cleared.
    const result = this.db.prepare("UPDATE schedule_runs SET detail = NULL WHERE finished_at IS NOT NULL AND finished_at < ? AND detail IS NOT NULL")
      .run(before);
    return Number(result.changes ?? 0);
  }

  // Needed while active, bounded after pause, expiry, or loss of authorization.
  // Configuration/history remains, but an expired instruction cannot silently
  // resume as an empty task. A running task is never changed underneath it.
  prunePrompts(olderThanMs) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) return 0;
    const before = this.now() - olderThanMs;
    return Number(this.db.prepare(`UPDATE schedules SET prompt = '', state = 'paused',
      cancellation_revision = cancellation_revision + 1
      WHERE prompt <> '' AND ((state = 'paused' AND updated_at < ?) OR end_at < ? OR suspended_at < ?)
      AND NOT EXISTS (SELECT 1 FROM schedule_runs r WHERE r.tenant=schedules.tenant AND r.schedule_id=schedules.id AND r.finished_at IS NULL)`)
      .run(before, before, before).changes);
  }

  // Called only after this deployment's old containers have been stopped.
  recoverInterruptedRuns() {
    return Number(this.db.prepare(`UPDATE schedule_runs SET finished_at = ?, outcome = 'failed', detail = '服务重启中断了这次执行；未自动重跑。'
      WHERE finished_at IS NULL`).run(this.now()).changes);
  }

  // Every run across a tenant, newest first -- what the 运行记录 tab shows.
  // The person's own, chosen before the limit is applied: the tenant's newest
  // runs filtered afterwards could leave someone's whole history outside the
  // window whenever a colleague's schedules were busier. The view's filter is
  // applied here for the same reason: last month's failure is still found under
  // 失败 after fifty successes since.
  //
  // `scheduleId` narrows it to one task's own history -- the 运行历史 beside
  // its detail page (G12) -- with the same filters.
  recentRuns(who, limit = 50, filter = "", scheduleId = null) {
    if (typeof filter !== "string" || !Object.hasOwn(RUN_FILTERS, filter)) throw new Error("运行记录的筛选条件无效");
    const one = scheduleId === null ? "" : "AND r.schedule_id = ?";
    const rows = this.db.prepare(`SELECT r.*, COALESCE(s.title, r.schedule_title) AS task_title, s.id IS NULL AS task_deleted
      FROM schedule_runs r LEFT JOIN schedules s ON s.tenant = r.tenant AND s.id = r.schedule_id
      WHERE r.tenant = ? AND ${MY_RUN} AND ${RUN_FILTERS[filter]} ${one} ORDER BY r.started_at DESC LIMIT ?`)
      .all(who.tenantId, who.userId, who.userId, ...(scheduleId === null ? [] : [scheduleId]), Math.min(Math.max(1, Number(limit) || 50), SCHEDULE_LIMITS.maxRuns));
    return rows.map((row) => this.#run(row, row.task_title ?? null));
  }

  // Each of this person's schedules' newest run, by schedule id: what a list
  // row needs to say 运行中, or how the last run ended (G13, G14).
  latestRuns(who) {
    const rows = this.db.prepare(`SELECT r.* FROM schedule_runs r JOIN schedules s ON s.tenant = r.tenant AND s.id = r.schedule_id
      WHERE r.tenant = ? AND s.owner = ? AND r.started_at = (SELECT MAX(started_at) FROM schedule_runs x WHERE x.tenant = r.tenant AND x.schedule_id = r.schedule_id)`)
      .all(who.tenantId, who.userId);
    return new Map(rows.map((row) => [row.schedule_id, this.#run(row)]));
  }

  // The report the last run of this schedule left in Drive, as its receipt
  // says: what 参考上一次的结果 reads back. Only a verified receipt, since the
  // bytes are checked against it, and never one from another schedule.
  previousReport(tenant, scheduleId) {
    const row = this.db.prepare(`SELECT id, finished_at, artifact_file_token, artifact_name, artifact_bytes, artifact_sha256 FROM schedule_runs
      WHERE tenant = ? AND schedule_id = ? AND finished_at IS NOT NULL AND artifact_state = 'verified' AND artifact_file_token IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`).get(tenant, scheduleId);
    return row ? { runId: row.id, finishedAt: row.finished_at, fileToken: row.artifact_file_token, name: row.artifact_name,
      bytes: row.artifact_bytes, sha256: row.artifact_sha256 } : null;
  }

  // The reports this schedule still keeps in Drive, newest first: every verified
  // receipt that still names a file, with the length and digest the rotation
  // checks the file against before overwriting it. What the rotation counts,
  // and whose oldest it overwrites once a task keeps as many as it may.
  retainedReports(tenant, scheduleId) {
    return this.db.prepare(`SELECT id, artifact_file_token, artifact_name, artifact_bytes, artifact_sha256, archived_at FROM schedule_runs
      WHERE tenant = ? AND schedule_id = ? AND artifact_state = 'verified' AND artifact_file_token IS NOT NULL
      ORDER BY archived_at DESC, finished_at DESC`).all(tenant, scheduleId)
      .map((row) => ({ runId: row.id, fileToken: row.artifact_file_token, name: row.artifact_name,
        bytes: row.artifact_bytes, sha256: row.artifact_sha256, archivedAt: row.archived_at }));
  }

  // A run whose report is no longer kept: its file now holds a later run's
  // report, or was found deleted, renamed or changed in Drive. The receipt keeps
  // what was archived and when, and stops naming the file and its link, so
  // nothing reads it back or counts it as kept. No new state value, so an older
  // build reads these rows as it always read receipts without a file.
  supersedeReport(tenant, runId) {
    this.db.prepare(`UPDATE schedule_runs SET artifact_file_token = NULL, artifact_url = NULL
      WHERE tenant = ? AND id = ? AND artifact_state = 'verified'`).run(tenant, runId);
  }

  // One of this person's runs, or null. A run is theirs when the schedule it
  // belongs to is.
  getRun(who, runId) {
    const row = this.db.prepare(`SELECT r.*, COALESCE(s.title, r.schedule_title) AS task_title, s.id IS NULL AS task_deleted
      FROM schedule_runs r LEFT JOIN schedules s ON s.tenant = r.tenant AND s.id = r.schedule_id
      WHERE r.tenant = ? AND r.id = ? AND ${MY_RUN}`).get(who.tenantId, runId, who.userId, who.userId);
    return row ? this.#run(row, row.task_title ?? null) : null;
  }

  // Runs whose task is gone, kept a while (G11) and then let go, so the table
  // does not only grow. Runs of tasks that still exist are not touched here.
  pruneOrphanRuns(olderThanMs) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) return 0;
    return Number(this.db.prepare(`DELETE FROM schedule_runs WHERE finished_at IS NOT NULL AND finished_at < ?
      AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.tenant = schedule_runs.tenant AND s.id = schedule_runs.schedule_id)`)
      .run(this.now() - olderThanMs).changes);
  }

  // 归档 and 取消归档: out of 运行记录 into 已归档, and back. Setting aside twice
  // keeps the first time. Only a finished run: one still going has nothing to
  // set aside yet, and its open row is how the rest of this store knows it is
  // going. Answers the run as it now is, or null when it is not this person's
  // finished run.
  shelveRun(who, runId, shelved) {
    const args = [who.tenantId, runId, who.userId, who.tenantId, who.userId];
    const changed = shelved
      ? this.db.prepare(`UPDATE schedule_runs SET shelved_at = COALESCE(shelved_at, ?) WHERE ${OWN_FINISHED_RUN}`).run(this.now(), ...args).changes
      : this.db.prepare(`UPDATE schedule_runs SET shelved_at = NULL WHERE ${OWN_FINISHED_RUN}`).run(...args).changes;
    return changed > 0 ? this.getRun(who, runId) : null;
  }

  // One record, at the person's own request. The schedule and its other runs
  // are untouched, and a run still going is not deleted out from under itself.
  deleteRun(who, runId) {
    return this.db.prepare(`DELETE FROM schedule_runs WHERE ${OWN_FINISHED_RUN}`)
      .run(who.tenantId, runId, who.userId, who.tenantId, who.userId).changes > 0;
  }
}
