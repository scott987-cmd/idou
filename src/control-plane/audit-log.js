// The audit trail an administrator reads: who did what, to what, when, and how
// it ended (docs/admin-console.md §6).
//
// **What it holds is metadata.** A person, an action, an object's id and name,
// an outcome, a few short fields. There is no column for a prompt, an answer, a
// message or a document's text, and that is the mechanism: the console cannot
// show what this cannot hold. `detail` takes short scalar fields only, and a
// test pins the columns.
//
// Sized for a deployment of a hundred thousand people: a million events a day,
// kept 180 days by default. On PostgreSQL the table is partitioned by day, so
// what has aged out goes by dropping a partition -- nothing to vacuum -- and a
// query for a week reads a week. On SQLite (one process, no shared database)
// it is one table, trimmed in batches.
//
// Events arrive from everywhere in the control plane and are written in
// batches; an administrator's own action is written before the request that
// made it is answered. Every event is also a JSON line on stderr from where it
// was raised, so an operator's log collection is a second copy that this
// process cannot alter.
import { inDepartments } from "./org-directory.js";

export const AUDIT_CATEGORIES = Object.freeze(["admin", "auth", "feishu", "schedule", "site", "skill", "media", "policy", "system"]);
export const AUDIT_OUTCOMES = Object.freeze(["ok", "refused", "failed"]);
export const ACTOR_KINDS = Object.freeze(["person", "admin", "system", "agent", "visitor"]);

export const AUDIT_LIMITS = Object.freeze({
  retentionDays: 180,
  batch: 500,
  flushMs: 1000,
  // What is held while the database is away. Past it the oldest go, counted:
  // the gateway must not fail over an audit line, and the stderr copy of each
  // event is already written.
  buffered: 20_000,
  detailBytes: 2048,
  detailFields: 24,
  // One page of the console, and one export.
  pageMax: 200,
  exportDays: 31,
  // Partitions made ahead of the clock, so a write never waits for one.
  daysAhead: 7,
});

// The columns, in order. A test asserts this set: adding one that could hold
// what somebody said is a decision, not an accident.
export const AUDIT_COLUMNS = Object.freeze(["id", "at", "tenant", "category", "action", "actor_kind", "actor_id", "actor_name",
  "target_kind", "target_id", "target_name", "outcome", "detail", "source", "address"]);

const ACTION = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+){0,4}$/;
const DAY_MS = 86_400_000;
const text = (value, max) => (typeof value === "string" ? value : value === null || value === undefined ? "" : String(value)).slice(0, max);
const dayOf = (at) => Math.floor(at / DAY_MS);
const stamp = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10).replaceAll("-", "");

// Short scalar fields only. Anything longer is cut, anything nested is dropped:
// a detail is "how many", "which kind", "why refused" -- never a body.
export function auditDetail(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return "{}";
  const kept = {};
  for (const [key, value] of Object.entries(detail).slice(0, AUDIT_LIMITS.detailFields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value === "string") kept[key] = value.slice(0, 200);
    else if (typeof value === "number" && Number.isFinite(value)) kept[key] = value;
    else if (typeof value === "boolean" || value === null) kept[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) kept[key] = value.slice(0, 20).map((item) => typeof item === "string" ? item.slice(0, 80) : item);
  }
  let json = JSON.stringify(kept);
  while (Buffer.byteLength(json) > AUDIT_LIMITS.detailBytes && Object.keys(kept).length) {
    delete kept[Object.keys(kept).at(-1)];
    json = JSON.stringify({ ...kept, truncated: true });
  }
  return json;
}

// One event as stored. Throws on what cannot be an audit event at all -- an
// unknown category or a malformed action is a bug in the caller, and quietly
// storing it would make it unfindable.
export function auditRow(event, now = Date.now()) {
  const at = Number.isSafeInteger(event?.at) && event.at > 0 ? event.at : now;
  const category = String(event?.category ?? "");
  if (!AUDIT_CATEGORIES.includes(category)) throw new Error(`Unknown audit category ${category.slice(0, 40)}`);
  const action = String(event?.action ?? "");
  if (!ACTION.test(action) || action.length > 64) throw new Error(`Invalid audit action ${action.slice(0, 64)}`);
  const outcome = event?.outcome ?? "ok";
  if (!AUDIT_OUTCOMES.includes(outcome)) throw new Error(`Invalid audit outcome ${String(outcome).slice(0, 20)}`);
  const actorKind = event?.actor?.kind ?? "system";
  if (!ACTOR_KINDS.includes(actorKind)) throw new Error(`Invalid audit actor ${String(actorKind).slice(0, 20)}`);
  return {
    at, tenant: text(event?.tenant, 128), category, action,
    actor_kind: actorKind, actor_id: text(event?.actor?.id, 128), actor_name: text(event?.actor?.name, 64),
    target_kind: text(event?.target?.kind, 32), target_id: text(event?.target?.id, 256), target_name: text(event?.target?.name, 128),
    outcome, detail: auditDetail(event?.detail), source: text(event?.source, 32), address: text(event?.address, 64),
  };
}

const INSERT_COLUMNS = AUDIT_COLUMNS.filter((column) => column !== "id");

// A position in a listing: the last row's time and id. Opaque to the browser,
// checked when it comes back.
export const auditCursor = {
  encode: (row) => Buffer.from(JSON.stringify([row.at, row.id])).toString("base64url"),
  decode(value) {
    if (typeof value !== "string" || !value || value.length > 100) return null;
    try {
      const [at, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      return Number.isSafeInteger(at) && Number.isSafeInteger(id) ? { at, id } : null;
    } catch { return null; }
  },
};

export class AuditLog {
  // `db` from admin-db.js. `retentionDays` from IDOU_AUDIT_RETENTION_DAYS.
  static async open({ db, retentionDays = AUDIT_LIMITS.retentionDays, now = Date.now, log = () => {} }) {
    if (!db?.dialect) throw new Error("审计日志需要管理库");
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("审计保留天数要在 1 到 3650 之间");
    const audit = new AuditLog({ db, retentionDays, now, log });
    await audit.#schema();
    return audit;
  }

  constructor({ db, retentionDays, now, log }) {
    this.db = db; this.retentionDays = retentionDays; this.now = now; this.log = log;
    this.buffer = [];
    this.dropped = 0;
    this.partitions = new Set();
    this.flushing = null;
    this.closed = false;
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, AUDIT_LIMITS.flushMs);
    this.timer.unref?.();
    this.lastComplaint = 0;
  }

  async #schema() {
    if (this.db.dialect === "postgres") {
      await this.db.schema("admin-audit", `
        CREATE SEQUENCE IF NOT EXISTS idou_admin_audit_id;
        CREATE TABLE IF NOT EXISTS idou_admin_audit (
          id bigint NOT NULL DEFAULT nextval('idou_admin_audit_id'),
          at bigint NOT NULL, tenant text NOT NULL, category text NOT NULL, action text NOT NULL,
          actor_kind text NOT NULL, actor_id text NOT NULL DEFAULT '', actor_name text NOT NULL DEFAULT '',
          target_kind text NOT NULL DEFAULT '', target_id text NOT NULL DEFAULT '', target_name text NOT NULL DEFAULT '',
          outcome text NOT NULL, detail text NOT NULL DEFAULT '{}', source text NOT NULL DEFAULT '', address text NOT NULL DEFAULT ''
        ) PARTITION BY RANGE (at);
        CREATE INDEX IF NOT EXISTS idou_admin_audit_time ON idou_admin_audit (tenant, at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idou_admin_audit_actor ON idou_admin_audit (tenant, actor_id, at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idou_admin_audit_category ON idou_admin_audit (tenant, category, at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idou_admin_audit_target ON idou_admin_audit (tenant, target_id, at DESC, id DESC);`);
      const today = dayOf(this.now());
      for (let day = today - 1; day <= today + AUDIT_LIMITS.daysAhead; day += 1) await this.#partition(day);
    } else {
      await this.db.schema("admin-audit", `
        CREATE TABLE IF NOT EXISTS idou_admin_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL, tenant TEXT NOT NULL, category TEXT NOT NULL, action TEXT NOT NULL,
          actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL DEFAULT '', actor_name TEXT NOT NULL DEFAULT '',
          target_kind TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '', target_name TEXT NOT NULL DEFAULT '',
          outcome TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT ''
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idou_admin_audit_time ON idou_admin_audit (tenant, at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idou_admin_audit_actor ON idou_admin_audit (tenant, actor_id, at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idou_admin_audit_category ON idou_admin_audit (tenant, category, at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idou_admin_audit_target ON idou_admin_audit (tenant, target_id, at DESC, id DESC);`);
    }
  }

  // One day's partition, made once. Two processes making the same one at the
  // same moment take turns on an advisory lock rather than racing the catalog.
  async #partition(day) {
    if (this.db.dialect !== "postgres" || this.partitions.has(day)) return;
    const name = `idou_admin_audit_p${stamp(day)}`;
    await this.db.transaction(async (tx) => {
      await tx.run("SELECT pg_advisory_xact_lock(hashtext('idou:admin-audit-partition'))");
      await tx.run(`CREATE TABLE IF NOT EXISTS ${name} PARTITION OF idou_admin_audit FOR VALUES FROM (${day * DAY_MS}) TO (${(day + 1) * DAY_MS})`);
    });
    this.partitions.add(day);
  }

  // Held, and written with the next batch. Never throws: an audit line that
  // cannot be formed is logged as such, and whatever raised it carries on.
  record(event) {
    if (this.closed) return false;
    let row;
    try { row = auditRow(event, this.now()); } catch (error) { this.log({ component: "audit", event: "audit-event-invalid", message: String(error?.message ?? error).slice(0, 200) }); return false; }
    this.buffer.push(row);
    if (this.buffer.length > AUDIT_LIMITS.buffered) {
      const over = this.buffer.length - AUDIT_LIMITS.buffered;
      this.buffer.splice(0, over);
      this.dropped += over;
    }
    if (this.buffer.length >= AUDIT_LIMITS.batch) void this.flush().catch(() => {});
    return true;
  }

  // Written now. For an administrator's own action: the request that made it
  // is answered only once this is stored, and fails if it cannot be.
  async write(event) {
    const row = auditRow(event, this.now());
    await this.#insert([row]);
    return row;
  }

  async flush() {
    // One flush at a time; whoever arrives during one waits for it, then
    // writes what is left, if anything.
    while (this.flushing) await this.flushing;
    if (!this.buffer.length) return;
    this.flushing = (async () => {
      while (this.buffer.length) {
        const batch = this.buffer.slice(0, AUDIT_LIMITS.batch);
        try { await this.#insert(batch); }
        catch (error) {
          if (this.now() - this.lastComplaint > 60_000) {
            this.lastComplaint = this.now();
            this.log({ component: "audit", event: "audit-write-failed", held: this.buffer.length, dropped: this.dropped, message: String(error?.message ?? error).slice(0, 200) });
          }
          return;
        }
        this.buffer.splice(0, batch.length);
      }
    })().finally(() => { this.flushing = null; });
    await this.flushing;
  }

  async #insert(rows) {
    if (!rows.length) return;
    if (this.db.dialect === "postgres") for (const day of new Set(rows.map((row) => dayOf(row.at)))) await this.#partition(day);
    const one = `(${INSERT_COLUMNS.map(() => "?").join(",")})`;
    const values = rows.flatMap((row) => INSERT_COLUMNS.map((column) => row[column]));
    await this.db.run(`INSERT INTO idou_admin_audit (${INSERT_COLUMNS.join(",")}) VALUES ${rows.map(() => one).join(",")}`, values);
  }

  // One page, newest first. `from`/`to` are required and bounded -- a query
  // without a time range reads the whole history, and on a partitioned table
  // the range is what keeps it to the days asked for.
  async query(filter = {}) {
    const { sql, params, size } = auditQuery(this.db.dialect, filter);
    const rows = await this.db.all(sql, params);
    const page = rows.slice(0, size).map(present);
    return { rows: page, next: rows.length > size ? auditCursor.encode(page.at(-1)) : null };
  }

  // Every row a filter matches, oldest last, a page at a time -- for an export
  // that is written to the browser as it is read.
  async *rows(filter) {
    if (filter.to - filter.from > AUDIT_LIMITS.exportDays * DAY_MS) throw new Error(`一次最多导出 ${AUDIT_LIMITS.exportDays} 天`);
    let cursor = null;
    do {
      const page = await this.query({ ...filter, cursor, limit: AUDIT_LIMITS.pageMax });
      for (const row of page.rows) yield row;
      cursor = page.next;
    } while (cursor);
  }

  // What has aged out. PostgreSQL: whole days, by dropping their partitions.
  // SQLite: a few thousand rows at a time, so one sweep never holds the file.
  async prune() {
    const cutoff = dayOf(this.now()) - this.retentionDays;
    if (this.db.dialect === "postgres") {
      const today = dayOf(this.now());
      for (let day = today; day <= today + AUDIT_LIMITS.daysAhead; day += 1) await this.#partition(day);
      const held = await this.db.all(`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'idou_admin_audit'`);
      let dropped = 0;
      for (const { name } of held) {
        const match = /_p(\d{4})(\d{2})(\d{2})$/.exec(name);
        if (!match) continue;
        const day = dayOf(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
        if (day >= cutoff) continue;
        await this.db.exec(`DROP TABLE IF EXISTS ${name}`);
        this.partitions.delete(day);
        dropped += 1;
      }
      return { partitions: dropped };
    }
    let removed = 0;
    for (;;) {
      const { changes } = await this.db.run("DELETE FROM idou_admin_audit WHERE id IN (SELECT id FROM idou_admin_audit WHERE at < ? LIMIT 5000)", [cutoff * DAY_MS]);
      removed += changes;
      if (changes < 5000) return { rows: removed };
    }
  }

  get pending() { return this.buffer.length; }

  async close() {
    clearInterval(this.timer);
    await this.flush().catch(() => {});
    this.closed = true;
  }
}

// The statement for one page. Its own function, so a test can ask SQLite how
// it would run exactly this. SQLite is told which index to use: it never
// gathers statistics here, and with a LIMIT and a time range it picks the time
// index even when a person is named -- reading every event of the week to find
// one person's (measured 2026-10-02). PostgreSQL has statistics and chooses.
// `within`: { paths, self } -- only what somebody in those departments did or
// had done to them, and what `self` did: what an administrator with a scope
// of departments reads.
export function auditQuery(dialect, { tenantId, from, to, actorId = null, category = null, action = null, targetId = null, outcome = null, within = null, cursor = null, limit = 50 } = {}) {
  if (typeof tenantId !== "string" || !tenantId) throw new Error("审计查询要指定租户");
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw new Error("审计查询要有时间范围");
  const where = ["tenant = ?", "at >= ?", "at < ?"], params = [tenantId, from, to];
  if (actorId) { where.push("actor_id = ?"); params.push(String(actorId).slice(0, 128)); }
  if (category) {
    if (!AUDIT_CATEGORIES.includes(category)) throw new Error("没有这个类别");
    where.push("category = ?"); params.push(category);
  }
  if (action) { where.push("action = ?"); params.push(String(action).slice(0, 64)); }
  if (targetId) { where.push("target_id = ?"); params.push(String(targetId).slice(0, 256)); }
  if (outcome) {
    if (!AUDIT_OUTCOMES.includes(outcome)) throw new Error("没有这个结果");
    where.push("outcome = ?"); params.push(outcome);
  }
  if (within) {
    const actor = inDepartments("actor_id", tenantId, within.paths ?? []), target = inDepartments("target_id", tenantId, within.paths ?? []);
    where.push(`(${actor.sql} OR ${target.sql}${within.self ? " OR actor_id = ?" : ""})`);
    params.push(...actor.params, ...target.params, ...(within.self ? [String(within.self)] : []));
  }
  const after = cursor ? auditCursor.decode(cursor) : null;
  if (cursor && !after) throw new Error("翻页位置无效");
  if (after) { where.push("(at < ? OR (at = ? AND id < ?))"); params.push(after.at, after.at, after.id); }
  const size = Math.max(1, Math.min(AUDIT_LIMITS.pageMax, Number(limit) || 50));
  const index = actorId ? "idou_admin_audit_actor" : targetId ? "idou_admin_audit_target" : category ? "idou_admin_audit_category" : "idou_admin_audit_time";
  const from_ = dialect === "sqlite" ? `idou_admin_audit INDEXED BY ${index}` : "idou_admin_audit";
  return { sql: `SELECT ${AUDIT_COLUMNS.join(",")} FROM ${from_} WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`,
    params: [...params, size + 1], size };
}

function present(row) {
  let detail = {};
  try { detail = JSON.parse(row.detail); } catch { /* stored by us; never malformed */ }
  return {
    id: row.id, at: row.at, tenant: row.tenant, category: row.category, action: row.action,
    actor: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name },
    target: { kind: row.target_kind, id: row.target_id, name: row.target_name },
    outcome: row.outcome, detail, source: row.source, address: row.address,
  };
}
