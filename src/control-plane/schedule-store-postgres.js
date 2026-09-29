// The schedule store in the shared PostgreSQL (docs/scaling-plan.md §2.5):
// the same methods as ScheduleStore (schedule-store.js), answered from two
// tables every coordinator reaches, so the one that takes over has every task
// and every run. The rules -- what a task may be, when it is next due, what a
// claim does -- are that file's; only where the rows live differs.
//
//   - What a person wrote and what a run said -- a task's name, its words, the
//     grant naming which resources it may read, a run's detail -- is sealed
//     with the key the replicas share, bound to the task or the run it belongs
//     to. Times, states and ids stay readable: they are what is selected on.
//   - What the file store did in one transaction is one transaction here, the
//     task's row taken FOR UPDATE: a claim that moves a task on and records its
//     run cannot happen twice for one occurrence, whichever coordinator asks.
//     A create counts a person's tasks under a lock per tenant, so the limits
//     hold however many requests arrive at once.
//   - Methods answer promises; the file store answers values. Callers await
//     either.
import { randomUUID } from "node:crypto";
import { describeSchedule, knownRule, nextOccurrence, FREQUENCIES } from "./schedule-spec.js";
import { makeDenyAllScheduleCapability, renewScheduleCapability, validateScheduleCapability } from "./schedule-capability.js";
import { CATCH_UP_AFTER_MS, RUN_COLUMNS, RUN_FILTERS, SCHEDULE_COLUMNS, SCHEDULE_LIMITS, SCHEDULE_STATES, checkRunArtifact, firstOccurrence, scheduleDefinition } from "./schedule-store.js";
import { openValue, sealValue } from "./state-store.js";
import { scheduleDeliveries } from "./schedule-deliveries.js";
import { namedDatabase } from "./database-names.js";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS idou_schedules (
    tenant text NOT NULL, id text NOT NULL, owner text NOT NULL, family text NOT NULL DEFAULT '',
    title bytea NOT NULL, prompt bytea, mode text NOT NULL CHECK (mode IN ('cowork','coding')),
    spec json NOT NULL, end_at bigint, next_at bigint NOT NULL, start_at bigint, memory boolean,
    state text NOT NULL CHECK (state IN ('active','paused')), suspended_at bigint,
    cancellation_revision bigint NOT NULL DEFAULT 0,
    capability bytea, capability_digest text, capability_revision bigint NOT NULL DEFAULT 1,
    created_at bigint NOT NULL, updated_at bigint NOT NULL,
    PRIMARY KEY (tenant, id));
  -- Where each result is also written (schedule-deliveries.js), sealed like the
  -- task's words. Added in place: a build from before this never selects it.
  ALTER TABLE idou_schedules ADD COLUMN IF NOT EXISTS deliveries bytea;
  CREATE INDEX IF NOT EXISTS idou_schedules_by_owner ON idou_schedules (tenant, owner);
  CREATE INDEX IF NOT EXISTS idou_schedules_due ON idou_schedules (next_at) WHERE state = 'active' AND suspended_at IS NULL AND capability IS NOT NULL;
  CREATE TABLE IF NOT EXISTS idou_schedule_runs (
    tenant text NOT NULL, id text NOT NULL, schedule_id text NOT NULL, owner text, schedule_title bytea, kind text,
    due_at bigint NOT NULL, started_at bigint NOT NULL, finished_at bigint,
    outcome text CHECK (outcome IN ('completed','failed','skipped')), detail bytea,
    artifact_state text CHECK (artifact_state IN ('verified','unknown')), artifact_provider text, artifact_file_token text,
    artifact_url text, artifact_name text, artifact_bytes bigint, artifact_sha256 text, archived_at bigint, shelved_at bigint,
    PRIMARY KEY (tenant, id));
  CREATE INDEX IF NOT EXISTS idou_schedule_runs_by_schedule ON idou_schedule_runs (tenant, schedule_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idou_schedule_runs_by_owner ON idou_schedule_runs (tenant, owner, started_at DESC);
  CREATE INDEX IF NOT EXISTS idou_schedule_runs_detail ON idou_schedule_runs (finished_at) WHERE detail IS NOT NULL;`;

// A rule this build can run, as in the file store's KNOWN_RULE: a row with any
// other is never due here, and never holds up the timer for one that is.
const KNOWN = [...FREQUENCIES];
const KNOWN_RULE = "(spec->>'frequency') = ANY($KNOWN::text[])";
const DUE = "state = 'active' AND suspended_at IS NULL AND capability IS NOT NULL";

// What is sealed, and what it is bound to. A task's name is bound to the task,
// and a run's copy of it to the same task, so deleting the task can copy the
// sealed bytes onto its runs unopened.
const TITLE = "schedule-title", PROMPT = "schedule-prompt", GRANT = "schedule-capability", DETAIL = "schedule-run-detail", DELIVERIES = "schedule-deliveries";
const slot = (tenant, id) => `${tenant}\n${id}`;
// bigint arrives as text; every one here is a millisecond time or a count.
const num = (value) => (value === null || value === undefined ? null : Number(value));
const STATES = SCHEDULE_STATES;

export class PostgresScheduleStore {
  static async open({ pool, key, now = Date.now, limits = {} }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("定时任务库需要 32 字节的封存密钥");
    ({ pool } = await namedDatabase({ pool }));
    const client = await pool.connect();
    try {
      // Two coordinators starting together would otherwise race to create the
      // same tables, and one of them fail.
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('idou:schema:schedules'))");
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
    const store = new PostgresScheduleStore({ pool, key, now, limits });
    await store.#sweepGrants();
    return store;
  }

  constructor({ pool, key, now, limits }) {
    Object.assign(this, { pool, key, now });
    this.limits = Object.freeze({ perUser: limits.perUser ?? SCHEDULE_LIMITS.perUser, perTenant: limits.perTenant ?? SCHEDULE_LIMITS.perTenant });
    if (![this.limits.perUser, this.limits.perTenant].every((value) => Number.isSafeInteger(value) && value >= 1) || this.limits.perUser > this.limits.perTenant) throw new Error("Invalid schedule limits");
  }

  // The pool is the server's; nothing here to let go of.
  close() {}

  #seal(namespace, tenant, id, value) { return sealValue(this.key, namespace, slot(tenant, id), value); }
  #open(namespace, tenant, id, sealed) { return sealed === null || sealed === undefined ? null : openValue(this.key, namespace, slot(tenant, id), sealed); }
  // `$KNOWN` in a statement is the list of rules this build runs.
  #query(sql, values = []) { return this.pool.query(sql.replaceAll("$KNOWN", `$${values.length + 1}`), sql.includes("$KNOWN") ? [...values, KNOWN] : values); }

  async #transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const query = (sql, values = []) => client.query(sql.replaceAll("$KNOWN", `$${values.length + 1}`), sql.includes("$KNOWN") ? [...values, KNOWN] : values);
      const result = await work(query);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  }

  // As the file store does when it opens: a grant that no longer validates
  // must not stay on the scheduler, where a row due that can never start would
  // stop the timer being armed for anything else. Only the rows the scheduler
  // reads. One that will not open at all was sealed under another key -- a
  // setting to fix, not a grant to throw away -- so that stops the start.
  async #sweepGrants() {
    for (let after = ["", ""]; ;) {
      const { rows } = await this.pool.query(`SELECT tenant, id, owner, capability, capability_digest, capability_revision FROM idou_schedules
        WHERE ${DUE} AND (tenant, id) > ($1, $2) ORDER BY tenant, id LIMIT 2000`, after);
      for (const row of rows) {
        let text;
        try { text = this.#open(GRANT, row.tenant, row.id, row.capability); }
        catch { throw new Error("定时任务库里的资源授权打不开：它是用另一把密钥封存的。检查 IDOU_STATE_KEY_FILE 是否和写入它的服务端一致。"); }
        try { this.#grant(row.tenant, row.owner, text, row.capability_digest, num(row.capability_revision)); }
        catch {
          await this.pool.query("UPDATE idou_schedules SET state = 'paused', capability = NULL, capability_digest = NULL, cancellation_revision = cancellation_revision + 1 WHERE tenant = $1 AND id = $2",
            [row.tenant, row.id]);
        }
      }
      if (rows.length < 2000) return;
      after = [rows.at(-1).tenant, rows.at(-1).id];
    }
  }

  #grant(tenant, owner, text, digest, revision) {
    if (text === null) return null;
    let capability; try { capability = JSON.parse(text); } catch { throw new Error("定时任务资源授权无效"); }
    return validateScheduleCapability({ capability, digest, revision }, { tenantId: tenant, userId: owner }).capability;
  }
  #capability(row) { return this.#grant(row.tenant, row.owner, this.#open(GRANT, row.tenant, row.id, row.capability), row.capability_digest, num(row.capability_revision)); }

  #row(row) {
    if (!row) return null;
    const spec = row.spec;
    let capability = null;
    try { capability = this.#capability(row); } catch { capability = null; }
    let deliveries = [];
    try { const text = this.#open(DELIVERIES, row.tenant, row.id, row.deliveries); deliveries = text ? scheduleDeliveries(JSON.parse(text)) : []; } catch { deliveries = []; }
    return { id: row.id, tenant: row.tenant, owner: row.owner, family: row.family, deliveries, title: this.#open(TITLE, row.tenant, row.id, row.title),
      prompt: this.#open(PROMPT, row.tenant, row.id, row.prompt) ?? "",
      mode: row.mode, spec, schedule: describeSchedule(spec), ruleSupported: knownRule(spec), memory: row.memory === true, startAt: num(row.start_at), endAt: num(row.end_at), nextAt: num(row.next_at), state: row.state,
      suspendedAt: num(row.suspended_at), cancellationRevision: num(row.cancellation_revision),
      capability, capabilityDigest: row.capability_digest ?? null, capabilityRevision: num(row.capability_revision),
      createdAt: num(row.created_at), updatedAt: num(row.updated_at) };
  }

  #run(row, title = undefined) {
    const artifact = row.artifact_state ? { state: row.artifact_state, providerId: row.artifact_provider,
      fileToken: row.artifact_file_token, url: row.artifact_url, name: row.artifact_name,
      bytes: num(row.artifact_bytes), sha256: row.artifact_sha256, archivedAt: num(row.archived_at) } : null;
    return { id: row.id, ...(title !== undefined ? { scheduleId: row.schedule_id, title } : {}),
      dueAt: num(row.due_at), startedAt: num(row.started_at), finishedAt: num(row.finished_at),
      outcome: row.outcome, detail: this.#open(DETAIL, row.tenant, row.id, row.detail), artifact, shelvedAt: num(row.shelved_at), kind: row.kind ?? "scheduled",
      ...(row.task_deleted !== undefined ? { taskDeleted: row.task_deleted === true } : {}) };
  }
  // The task's name for a run: the task's own while it exists, else the copy
  // the run was given. Both are sealed as the task's.
  #taskTitle(row) { return this.#open(TITLE, row.tenant, row.schedule_id, row.task_title ?? row.schedule_title) ?? null; }

  async create(who, input) {
    const at = this.now(), definition = scheduleDefinition(input, { now: at });
    if (!who?.familyId || !who?.userId || !who?.tenantId) throw new Error("定时任务必须由一个已登录的用户创建");
    const binding = input?.capabilityBinding ?? makeDenyAllScheduleCapability(who, definition.endAt);
    validateScheduleCapability(binding, who);
    if (binding.capability.validUntil !== definition.endAt) throw new Error("定时任务资源授权有效期与任务不一致");
    const nextAt = firstOccurrence(definition.spec, at, definition.startAt);
    if (nextAt === null) throw new Error("这个时间已经过去了");
    if (definition.endAt !== null && definition.endAt <= nextAt) throw new Error("结束时间必须晚于首次执行时间");
    const deliveries = scheduleDeliveries(input?.deliveries);
    const id = randomUUID();
    await this.#transaction(async (query) => {
      // The name is part of the statement, so it is the database's own (database-names.js).
      await query("SELECT pg_advisory_xact_lock(hashtextextended('idou:schedules:' || $1, 0))", [who.tenantId]);
      const counts = (await query("SELECT count(*) FILTER (WHERE owner = $2)::int AS mine, count(*)::int AS everyone FROM idou_schedules WHERE tenant = $1",
        [who.tenantId, who.userId])).rows[0];
      if (counts.mine >= this.limits.perUser) throw new Error(`一个人最多 ${this.limits.perUser} 个定时任务，请先删掉不用的`);
      if (counts.everyone >= this.limits.perTenant) throw new Error(`这个企业的定时任务已达上限 ${this.limits.perTenant} 个，请联系管理员`);
      await query(`INSERT INTO idou_schedules (tenant, id, owner, family, title, prompt, mode, spec, end_at, next_at, state, created_at, updated_at,
        capability, capability_digest, capability_revision, memory, start_at, deliveries) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$11,$12,$13,$14,$15,$16,$17)`,
      [who.tenantId, id, who.userId, who.familyId, this.#seal(TITLE, who.tenantId, id, definition.title), this.#seal(PROMPT, who.tenantId, id, definition.prompt),
        definition.mode, JSON.stringify(definition.spec), definition.endAt, nextAt, at,
        this.#seal(GRANT, who.tenantId, id, JSON.stringify(binding.capability)), binding.digest, binding.revision, definition.memory, definition.startAt,
        deliveries.length ? this.#seal(DELIVERIES, who.tenantId, id, JSON.stringify(deliveries)) : null]);
    });
    return this.get(who, id);
  }

  async updateCapability(who, id, binding, expectedRevision) {
    const current = await this.get(who, id);
    if (!current || current.owner !== who.userId) throw new Error("找不到这个定时任务");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || current.capabilityRevision !== expectedRevision ||
        binding?.revision !== expectedRevision + 1) throw new Error("资源授权已经变化，请刷新后重试");
    validateScheduleCapability(binding, who);
    if (binding.capability.validUntil !== current.endAt) throw new Error("定时任务资源授权有效期与任务不一致");
    const changed = (await this.pool.query(`UPDATE idou_schedules SET capability = $1, capability_digest = $2, capability_revision = $3,
      cancellation_revision = cancellation_revision + 1, updated_at = GREATEST($4, updated_at + 1)
      WHERE tenant = $5 AND id = $6 AND owner = $7 AND capability_revision = $8`,
    [this.#seal(GRANT, who.tenantId, id, JSON.stringify(binding.capability)), binding.digest, binding.revision, this.now(), who.tenantId, id, who.userId, expectedRevision])).rowCount;
    if (changed !== 1) throw new Error("资源授权已经变化，请刷新后重试");
    return this.get(who, id);
  }

  async updateDefinition(who, id, input, expectedUpdatedAt) {
    const current = await this.get(who, id);
    if (!current || current.owner !== who.userId) throw new Error("找不到这个定时任务");
    if (!current.capability) throw new Error("这个任务没有资源授权，请重新创建定时任务");
    if (!Number.isSafeInteger(expectedUpdatedAt) || current.updatedAt !== expectedUpdatedAt) throw new Error("定时任务已经变化，请刷新后重试");
    const at = this.now(), definition = scheduleDefinition(input, { now: at });
    const renewing = definition.endAt !== current.endAt;
    const binding = renewing ? renewScheduleCapability({ capability: current.capability, revision: current.capabilityRevision }, { validUntil: definition.endAt }) : null;
    if (binding) validateScheduleCapability(binding, who);
    const startAt = input?.startAt === undefined ? current.startAt : definition.startAt;
    const deliveries = input?.deliveries === undefined ? current.deliveries : scheduleDeliveries(input.deliveries);
    const nextAt = firstOccurrence(definition.spec, at, startAt);
    if (nextAt === null && current.state === "active") throw new Error("这个时间已经过去了");
    if (definition.endAt !== null && nextAt !== null && definition.endAt <= nextAt) throw new Error("结束时间必须晚于下一次执行时间");
    const changed = (await this.pool.query(`UPDATE idou_schedules SET title = $1, prompt = $2, mode = $3, spec = $4, end_at = $5, next_at = $6, updated_at = GREATEST($7, updated_at + 1),
      capability = COALESCE($8, capability), capability_digest = COALESCE($9, capability_digest), capability_revision = COALESCE($10, capability_revision),
      cancellation_revision = cancellation_revision + $11, memory = $12, start_at = $13, deliveries = $18
      WHERE tenant = $14 AND id = $15 AND owner = $16 AND updated_at = $17`,
    [this.#seal(TITLE, who.tenantId, id, definition.title), this.#seal(PROMPT, who.tenantId, id, definition.prompt), definition.mode, JSON.stringify(definition.spec),
      definition.endAt, nextAt ?? current.nextAt, at,
      binding ? this.#seal(GRANT, who.tenantId, id, JSON.stringify(binding.capability)) : null, binding?.digest ?? null, binding?.revision ?? null, binding ? 1 : 0,
      definition.memory, startAt, who.tenantId, id, who.userId, expectedUpdatedAt,
      deliveries.length ? this.#seal(DELIVERIES, who.tenantId, id, JSON.stringify(deliveries)) : null])).rowCount;
    if (changed !== 1) throw new Error("定时任务已经变化，请刷新后重试");
    return this.get(who, id);
  }

  async get(who, id) {
    return this.#row((await this.pool.query("SELECT * FROM idou_schedules WHERE tenant = $1 AND id = $2", [who.tenantId, id])).rows[0]) ?? null;
  }

  // The tenant's tasks, or with `mine` only this person's -- what the desktop
  // lists, without reading and opening everybody else's to throw them away.
  async list(who, { mine = false } = {}) {
    const { rows } = mine
      ? await this.pool.query("SELECT * FROM idou_schedules WHERE tenant = $1 AND owner = $2 ORDER BY next_at ASC, created_at, id", [who.tenantId, who.userId])
      : await this.pool.query("SELECT * FROM idou_schedules WHERE tenant = $1 ORDER BY next_at ASC, created_at, id", [who.tenantId]);
    return rows.map((row) => this.#row(row));
  }

  async setState(who, id, state) {
    if (!STATES.has(state)) throw new Error("定时任务状态只能是运行或暂停");
    return this.#transaction(async (query) => {
      const current = this.#row((await query("SELECT * FROM idou_schedules WHERE tenant = $1 AND id = $2 FOR UPDATE", [who.tenantId, id])).rows[0]);
      if (!current) throw new Error("找不到这个定时任务");
      if (state === "active" && !current.prompt) throw new Error("提示词已超过停用保留期，请先编辑补上提示词");
      if (state === "active" && !current.capability) throw new Error("这个任务没有资源授权，请重新创建定时任务");
      const nextAt = state === "active" ? firstOccurrence(current.spec, this.now(), current.startAt) ?? current.nextAt : current.nextAt;
      const { rows } = await query(`UPDATE idou_schedules SET state = $1, next_at = $2, updated_at = GREATEST($3, updated_at + 1), cancellation_revision = cancellation_revision + $4
        WHERE tenant = $5 AND id = $6 RETURNING *`, [state, nextAt, this.now(), state === "paused" ? 1 : 0, who.tenantId, id]);
      return this.#row(rows[0]);
    });
  }

  async remove(who, id) {
    return this.#transaction(async (query) => {
      const row = (await query("SELECT owner, title FROM idou_schedules WHERE tenant = $1 AND id = $2 FOR UPDATE", [who.tenantId, id])).rows[0];
      if (row) await query("UPDATE idou_schedule_runs SET owner = COALESCE(owner, $1), schedule_title = $2 WHERE tenant = $3 AND schedule_id = $4",
        [row.owner, row.title, who.tenantId, id]);
      return (await query("DELETE FROM idou_schedules WHERE tenant = $1 AND id = $2", [who.tenantId, id])).rowCount > 0;
    });
  }

  async suspend(tenant, id) {
    const at = this.now();
    return (await this.pool.query("UPDATE idou_schedules SET suspended_at = $1, updated_at = GREATEST($1, updated_at + 1) WHERE tenant = $2 AND id = $3 AND suspended_at IS NULL",
      [at, tenant, id])).rowCount > 0;
  }

  async resume(who) {
    if (!who?.userId || !who?.tenantId) throw new Error("定时任务必须由一个已登录的用户恢复");
    const at = this.now();
    return this.#transaction(async (query) => {
      const { rows } = await query("SELECT tenant, id, spec, start_at, next_at FROM idou_schedules WHERE tenant = $1 AND owner = $2 AND suspended_at IS NOT NULL AND capability IS NOT NULL FOR UPDATE",
        [who.tenantId, who.userId]);
      for (const row of rows) {
        const next = firstOccurrence(row.spec, at, num(row.start_at));
        await query("UPDATE idou_schedules SET suspended_at = NULL, next_at = $1, updated_at = GREATEST($2, updated_at + 1) WHERE tenant = $3 AND id = $4",
          [next ?? num(row.next_at), at, row.tenant, row.id]);
      }
      return rows.length;
    });
  }

  // `limit`: the scheduler asks for no more than it could start.
  async due(at = this.now(), limit = null) {
    const { rows } = await this.#query(`SELECT * FROM idou_schedules WHERE ${DUE} AND next_at <= $1 AND (end_at IS NULL OR end_at > $1) AND ${KNOWN_RULE}
      ORDER BY next_at ASC, created_at, id ${Number.isSafeInteger(limit) && limit > 0 ? `LIMIT ${limit}` : ""}`, [at]);
    return rows.map((row) => this.#row(row)).filter((row) => row.capability);
  }

  async nextDueAt() {
    const { rows } = await this.#query(`SELECT MIN(next_at) AS at FROM idou_schedules WHERE ${DUE} AND (end_at IS NULL OR end_at > next_at) AND ${KNOWN_RULE}`);
    const at = num(rows[0]?.at);
    return Number.isSafeInteger(at) ? at : null;
  }

  async claim(schedule, at = this.now()) {
    const runId = randomUUID();
    return this.#transaction(async (query) => {
      const current = (await query(`SELECT * FROM idou_schedules WHERE tenant = $1 AND id = $2 AND state = 'active' AND suspended_at IS NULL AND next_at <= $3 AND ${KNOWN_RULE} FOR UPDATE`,
        [schedule.tenant, schedule.id, at])).rows[0];
      if (!current) return null;
      let capability = null; try { capability = this.#capability(current); } catch { /* paused below */ }
      if (!capability) {
        await query("UPDATE idou_schedules SET state = 'paused', cancellation_revision = cancellation_revision + 1, updated_at = GREATEST($1, updated_at + 1) WHERE tenant = $2 AND id = $3",
          [at, current.tenant, current.id]);
        return null;
      }
      const startAt = num(current.start_at);
      if (Number.isSafeInteger(startAt) && startAt > at) {
        const first = firstOccurrence(current.spec, at, startAt);
        await query("UPDATE idou_schedules SET next_at = $1, updated_at = GREATEST($2, updated_at + 1) WHERE tenant = $3 AND id = $4", [first ?? startAt, at, current.tenant, current.id]);
        return null;
      }
      const dueAt = num(current.next_at), endAt = num(current.end_at);
      const next = nextOccurrence(current.spec, at);
      const ended = next === null || (endAt !== null && next >= endAt);
      await query("UPDATE idou_schedules SET next_at = $1, state = $2, updated_at = GREATEST($3, updated_at + 1) WHERE tenant = $4 AND id = $5",
        [next ?? dueAt, ended ? "paused" : "active", at, current.tenant, current.id]);
      await query("INSERT INTO idou_schedule_runs (tenant, schedule_id, id, due_at, started_at, kind, owner, schedule_title) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [current.tenant, current.id, runId, dueAt, at, at - dueAt >= CATCH_UP_AFTER_MS ? "catch-up" : null, current.owner, current.title]);
      return { runId, dueAt, schedule: this.#row(current) };
    });
  }

  async claimNow(schedule, at = this.now()) {
    const runId = randomUUID();
    return this.#transaction(async (query) => {
      const current = (await query("SELECT * FROM idou_schedules WHERE tenant = $1 AND id = $2 AND suspended_at IS NULL AND capability IS NOT NULL AND prompt IS NOT NULL AND (end_at IS NULL OR end_at > $3) FOR UPDATE",
        [schedule.tenant, schedule.id, at])).rows[0];
      if (!current) return null;
      let capability = null; try { capability = this.#capability(current); } catch { /* refused below */ }
      if (!capability) return null;
      await query("INSERT INTO idou_schedule_runs (tenant, schedule_id, id, due_at, started_at, kind, owner, schedule_title) VALUES ($1,$2,$3,$4,$4,'manual',$5,$6)",
        [current.tenant, current.id, runId, at, current.owner, current.title]);
      return { runId, dueAt: at, schedule: this.#row(current), manual: true };
    });
  }

  async finish(tenant, runId, outcome, detail = null, artifact = null) {
    if (!["completed", "failed", "skipped"].includes(outcome)) throw new Error("未知的执行结果");
    checkRunArtifact(artifact);
    await this.pool.query(`UPDATE idou_schedule_runs SET finished_at = $1, outcome = $2, detail = $3,
      artifact_state = $4, artifact_provider = $5, artifact_file_token = $6, artifact_url = $7, artifact_name = $8, artifact_bytes = $9, artifact_sha256 = $10, archived_at = $11
      WHERE tenant = $12 AND id = $13`,
    [this.now(), outcome, detail === null ? null : this.#seal(DETAIL, tenant, runId, String(detail).slice(0, 2000)),
      artifact?.state ?? null, artifact?.providerId ?? null, artifact?.fileToken ?? null, artifact?.url ?? null,
      artifact?.name ?? null, artifact?.bytes ?? null, artifact?.sha256 ?? null, artifact?.archivedAt ?? null, tenant, runId]);
  }

  async runs(who, scheduleId, limit = 20) {
    const { rows } = await this.pool.query("SELECT * FROM idou_schedule_runs WHERE tenant = $1 AND schedule_id = $2 ORDER BY started_at DESC, id LIMIT $3",
      [who.tenantId, scheduleId, Math.min(Math.max(1, Number(limit) || 20), SCHEDULE_LIMITS.maxRuns)]);
    return rows.map((row) => this.#run(row));
  }

  async pruneRunDetail(olderThanMs) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) return 0;
    return (await this.pool.query("UPDATE idou_schedule_runs SET detail = NULL WHERE finished_at IS NOT NULL AND finished_at < $1 AND detail IS NOT NULL",
      [this.now() - olderThanMs])).rowCount;
  }

  async prunePrompts(olderThanMs) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) return 0;
    const before = this.now() - olderThanMs;
    return (await this.pool.query(`UPDATE idou_schedules s SET prompt = NULL, state = 'paused', cancellation_revision = cancellation_revision + 1
      WHERE prompt IS NOT NULL AND ((state = 'paused' AND updated_at < $1) OR end_at < $1 OR suspended_at < $1)
      AND NOT EXISTS (SELECT 1 FROM idou_schedule_runs r WHERE r.tenant = s.tenant AND r.schedule_id = s.id AND r.finished_at IS NULL)`, [before])).rowCount;
  }

  // Each open run gets the same words, sealed as its own.
  async recoverInterruptedRuns() {
    const at = this.now();
    return this.#transaction(async (query) => {
      const { rows } = await query("SELECT tenant, id FROM idou_schedule_runs WHERE finished_at IS NULL FOR UPDATE");
      for (const row of rows) {
        await query("UPDATE idou_schedule_runs SET finished_at = $1, outcome = 'failed', detail = $2 WHERE tenant = $3 AND id = $4",
          [at, this.#seal(DETAIL, row.tenant, row.id, "服务重启中断了这次执行；未自动重跑。"), row.tenant, row.id]);
      }
      return rows.length;
    });
  }

  async recentRuns(who, limit = 50, filter = "", scheduleId = null) {
    if (typeof filter !== "string" || !Object.hasOwn(RUN_FILTERS, filter)) throw new Error("运行记录的筛选条件无效");
    const one = scheduleId === null ? "" : "AND r.schedule_id = $4";
    const { rows } = await this.pool.query(`SELECT r.*, s.title AS task_title, s.id IS NULL AS task_deleted
      FROM idou_schedule_runs r LEFT JOIN idou_schedules s ON s.tenant = r.tenant AND s.id = r.schedule_id
      WHERE r.tenant = $1 AND (r.owner = $2 OR (r.owner IS NULL AND s.owner = $2)) AND ${RUN_FILTERS[filter]} ${one} ORDER BY r.started_at DESC, r.id LIMIT $3`,
    [who.tenantId, who.userId, Math.min(Math.max(1, Number(limit) || 50), SCHEDULE_LIMITS.maxRuns), ...(scheduleId === null ? [] : [scheduleId])]);
    return rows.map((row) => this.#run(row, this.#taskTitle(row)));
  }

  async latestRuns(who) {
    const { rows } = await this.pool.query(`SELECT DISTINCT ON (r.schedule_id) r.* FROM idou_schedule_runs r JOIN idou_schedules s ON s.tenant = r.tenant AND s.id = r.schedule_id
      WHERE r.tenant = $1 AND s.owner = $2 ORDER BY r.schedule_id, r.started_at DESC, r.id`, [who.tenantId, who.userId]);
    return new Map(rows.map((row) => [row.schedule_id, this.#run(row)]));
  }

  async previousReport(tenant, scheduleId) {
    const row = (await this.pool.query(`SELECT id, finished_at, artifact_file_token, artifact_name, artifact_bytes, artifact_sha256 FROM idou_schedule_runs
      WHERE tenant = $1 AND schedule_id = $2 AND finished_at IS NOT NULL AND artifact_state = 'verified' AND artifact_file_token IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1`, [tenant, scheduleId])).rows[0];
    return row ? { runId: row.id, finishedAt: num(row.finished_at), fileToken: row.artifact_file_token, name: row.artifact_name,
      bytes: num(row.artifact_bytes), sha256: row.artifact_sha256 } : null;
  }

  // NULLS LAST: the order the file store's SQLite gives a descending sort.
  async retainedReports(tenant, scheduleId) {
    const { rows } = await this.pool.query(`SELECT id, artifact_file_token, artifact_name, artifact_bytes, artifact_sha256, archived_at FROM idou_schedule_runs
      WHERE tenant = $1 AND schedule_id = $2 AND artifact_state = 'verified' AND artifact_file_token IS NOT NULL
      ORDER BY archived_at DESC NULLS LAST, finished_at DESC NULLS LAST`, [tenant, scheduleId]);
    return rows.map((row) => ({ runId: row.id, fileToken: row.artifact_file_token, name: row.artifact_name,
      bytes: num(row.artifact_bytes), sha256: row.artifact_sha256, archivedAt: num(row.archived_at) }));
  }

  async supersedeReport(tenant, runId) {
    await this.pool.query("UPDATE idou_schedule_runs SET artifact_file_token = NULL, artifact_url = NULL WHERE tenant = $1 AND id = $2 AND artifact_state = 'verified'", [tenant, runId]);
  }

  async getRun(who, runId) {
    const row = (await this.pool.query(`SELECT r.*, s.title AS task_title, s.id IS NULL AS task_deleted
      FROM idou_schedule_runs r LEFT JOIN idou_schedules s ON s.tenant = r.tenant AND s.id = r.schedule_id
      WHERE r.tenant = $1 AND r.id = $2 AND (r.owner = $3 OR (r.owner IS NULL AND s.owner = $3))`, [who.tenantId, runId, who.userId])).rows[0];
    return row ? this.#run(row, this.#taskTitle(row)) : null;
  }

  async pruneOrphanRuns(olderThanMs) {
    if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) return 0;
    return (await this.pool.query(`DELETE FROM idou_schedule_runs r WHERE finished_at IS NOT NULL AND finished_at < $1
      AND NOT EXISTS (SELECT 1 FROM idou_schedules s WHERE s.tenant = r.tenant AND s.id = r.schedule_id)`, [this.now() - olderThanMs])).rowCount;
  }

  async shelveRun(who, runId, shelved) {
    const own = "tenant = $1 AND id = $2 AND finished_at IS NOT NULL AND (owner = $3 OR (owner IS NULL AND schedule_id IN (SELECT id FROM idou_schedules WHERE tenant = $1 AND owner = $3)))";
    const changed = shelved
      ? (await this.pool.query(`UPDATE idou_schedule_runs SET shelved_at = COALESCE(shelved_at, $4) WHERE ${own}`, [who.tenantId, runId, who.userId, this.now()])).rowCount
      : (await this.pool.query(`UPDATE idou_schedule_runs SET shelved_at = NULL WHERE ${own}`, [who.tenantId, runId, who.userId])).rowCount;
    return changed > 0 ? this.getRun(who, runId) : null;
  }

  async deleteRun(who, runId) {
    return (await this.pool.query(`DELETE FROM idou_schedule_runs WHERE tenant = $1 AND id = $2 AND finished_at IS NOT NULL
      AND (owner = $3 OR (owner IS NULL AND schedule_id IN (SELECT id FROM idou_schedules WHERE tenant = $1 AND owner = $3)))`, [who.tenantId, runId, who.userId])).rowCount > 0;
  }

  // Every row as the file store keeps it (its SCHEDULE_COLUMNS and
  // RUN_COLUMNS), opened; and rows in that shape loaded, sealed as they go in.
  // For bin/migrate-data.js, either way.
  async rows() {
    const schedules = [], runs = [];
    for (let after = ["", ""]; ;) {
      const { rows } = await this.pool.query("SELECT *, spec::text AS spec_text FROM idou_schedules WHERE (tenant, id) > ($1, $2) ORDER BY tenant, id LIMIT 5000", after);
      for (const row of rows) {
        const opened = {
          title: () => this.#open(TITLE, row.tenant, row.id, row.title),
          prompt: () => this.#open(PROMPT, row.tenant, row.id, row.prompt) ?? "",
          spec: () => row.spec_text,
          capability: () => this.#open(GRANT, row.tenant, row.id, row.capability),
          memory: () => (row.memory === null ? null : row.memory ? 1 : 0),
          deliveries: () => this.#open(DELIVERIES, row.tenant, row.id, row.deliveries ?? null),
        };
        schedules.push(Object.fromEntries(SCHEDULE_COLUMNS.map((name) => [name,
          Object.hasOwn(opened, name) ? opened[name]() : /(_at|_revision)$/.test(name) ? num(row[name]) : row[name]])));
      }
      if (rows.length < 5000) break;
      after = [rows.at(-1).tenant, rows.at(-1).id];
    }
    for (let after = ["", ""]; ;) {
      const { rows } = await this.pool.query("SELECT * FROM idou_schedule_runs WHERE (tenant, id) > ($1, $2) ORDER BY tenant, id LIMIT 5000", after);
      for (const row of rows) {
        const opened = {
          detail: () => this.#open(DETAIL, row.tenant, row.id, row.detail),
          schedule_title: () => this.#open(TITLE, row.tenant, row.schedule_id, row.schedule_title),
        };
        runs.push(Object.fromEntries(RUN_COLUMNS.map((name) => [name,
          Object.hasOwn(opened, name) ? opened[name]() : /(_at|_bytes)$/.test(name) ? num(row[name]) : row[name]])));
      }
      if (rows.length < 5000) break;
      after = [rows.at(-1).tenant, rows.at(-1).id];
    }
    return { schedules, runs };
  }

  async load({ schedules = [], runs = [] }) {
    const upsert = (table, columns) => `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})
      ON CONFLICT (tenant, id) DO UPDATE SET ${columns.filter((name) => name !== "tenant" && name !== "id").map((name) => `${name} = EXCLUDED.${name}`).join(", ")}`;
    await this.#transaction(async (query) => {
      for (const row of schedules) {
        await query(upsert("idou_schedules", SCHEDULE_COLUMNS), SCHEDULE_COLUMNS.map((name) => {
          const value = row[name] ?? null;
          if (name === "title") return this.#seal(TITLE, row.tenant, row.id, String(value ?? ""));
          if (name === "prompt") return value ? this.#seal(PROMPT, row.tenant, row.id, value) : null;
          if (name === "capability") return value === null ? null : this.#seal(GRANT, row.tenant, row.id, value);
          if (name === "memory") return value === null ? null : value === 1 || value === true;
          if (name === "deliveries") return value === null ? null : this.#seal(DELIVERIES, row.tenant, row.id, value);
          if (name === "family") return value ?? "";
          return value;
        }));
      }
      for (const row of runs) {
        await query(upsert("idou_schedule_runs", RUN_COLUMNS), RUN_COLUMNS.map((name) => {
          const value = row[name] ?? null;
          if (name === "detail") return value === null ? null : this.#seal(DETAIL, row.tenant, row.id, value);
          if (name === "schedule_title") return value === null ? null : this.#seal(TITLE, row.tenant, row.schedule_id, value);
          return value;
        }));
      }
    });
  }
}
