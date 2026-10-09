// Everybody who has used this deployment, as an administrator looks for them
// (docs/admin-console.md §4): a name, an open_id, when they were first and
// last here, which desktop they run.
//
// Filled from sign-ins, not from Feishu's address book: a person is here once
// they have signed in, with the name Feishu gave at that sign-in, and nothing
// is asked of Feishu for it. A hundred thousand people on line at once renew
// their sessions every quarter of an hour, so a presence is written at most
// every ten minutes per person, and in batches; a sign-in is always written.
//
// Listings are paged by position, never by offset -- page two thousand costs
// what page one does -- and each is served by an index. SQLite is told which,
// for the reason audit-log.js gives.
import { inDepartments } from "./org-directory.js";
export const DIRECTORY_LIMITS = Object.freeze({
  presenceEveryMs: 10 * 60_000,
  flushMs: 5_000,
  batch: 500,
  pageMax: 200,
  // People whose presence was written recently, remembered so they are not
  // written again; past this the memory starts over, which costs one write each.
  remembered: 200_000,
  nameChars: 64,
  clientChars: 64,
  searchChars: 64,
});

const PERSON = /^[A-Za-z0-9_-]{1,128}$/;
const keyOf = (tenantId, userId) => `${tenantId}\n${userId}`;
const SORTS = Object.freeze({
  active: { column: "last_seen_at", direction: "DESC", index: "idou_admin_people_active" },
  name: { column: "name_key", direction: "ASC", index: "idou_admin_people_name" },
  first: { column: "first_seen_at", direction: "DESC", index: "idou_admin_people_first" },
});
export const PEOPLE_SORTS = Object.freeze(Object.keys(SORTS));
const nameKey = (name) => String(name ?? "").toLowerCase();

export const peopleCursor = {
  encode: (value, userId) => Buffer.from(JSON.stringify([value, userId])).toString("base64url"),
  decode(cursor) {
    if (typeof cursor !== "string" || !cursor || cursor.length > 400) return null;
    try {
      const [value, userId] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      return (typeof value === "string" || Number.isSafeInteger(value)) && typeof userId === "string" && PERSON.test(userId) ? { value, userId } : null;
    } catch { return null; }
  },
};

// The statement for one page, apart so a test can ask SQLite how it runs it.
// `status`: everyone, only the disabled, or only those who are not -- answered
// against the access table, which holds only people somebody acted on.
// `departmentPaths`: only people in those departments or any under them (their
// paths in org-directory.js) -- a department picked, or an administrator's scope.
export function peopleQuery(dialect, { tenantId, q = "", status = "all", activeSince = null, inactiveBefore = null, departmentPaths = null, sort = "active", cursor = null, limit = 50 } = {}) {
  if (typeof tenantId !== "string" || !PERSON.test(tenantId)) throw new Error("要指定租户");
  const order = SORTS[sort];
  if (!order) throw new Error("没有这种排序");
  if (!["all", "disabled", "enabled"].includes(status)) throw new Error("没有这种状态");
  const where = ["p.tenant = ?"], params = [tenantId];
  const search = String(q ?? "").trim().slice(0, DIRECTORY_LIMITS.searchChars);
  if (search) {
    if (/^ou_[A-Za-z0-9_-]+$/.test(search)) { where.push("p.user_id = ?"); params.push(search); }
    else { where.push("p.name_key LIKE ? ESCAPE '\\'"); params.push(`%${nameKey(search).replace(/[\\%_]/g, (char) => `\\${char}`)}%`); }
  }
  if (Number.isSafeInteger(activeSince)) { where.push("p.last_seen_at >= ?"); params.push(activeSince); }
  if (Number.isSafeInteger(inactiveBefore)) { where.push("p.last_seen_at < ?"); params.push(inactiveBefore); }
  if (departmentPaths) {
    const within = inDepartments("p.user_id", tenantId, departmentPaths);
    where.push(within.sql); params.push(...within.params);
  }
  if (status === "disabled") where.push("EXISTS (SELECT 1 FROM idou_admin_access a WHERE a.tenant = p.tenant AND a.user_id = p.user_id AND a.disabled = 1)");
  if (status === "enabled") where.push("NOT EXISTS (SELECT 1 FROM idou_admin_access a WHERE a.tenant = p.tenant AND a.user_id = p.user_id AND a.disabled = 1)");
  const counted = { where: [...where], params: [...params] };
  const after = cursor ? peopleCursor.decode(cursor) : null;
  if (cursor && !after) throw new Error("翻页位置无效");
  if (after) {
    const [before, tie] = order.direction === "DESC" ? ["<", "<"] : [">", ">"];
    where.push(`(p.${order.column} ${before} ? OR (p.${order.column} = ? AND p.user_id ${tie} ?))`);
    params.push(after.value, after.value, after.userId);
  }
  const size = Math.max(1, Math.min(DIRECTORY_LIMITS.pageMax, Number(limit) || 50));
  const from = dialect === "sqlite" ? `idou_admin_people p INDEXED BY ${order.index}` : "idou_admin_people p";
  return {
    sql: `SELECT p.tenant, p.user_id, p.name, p.name_key, p.first_seen_at, p.last_seen_at, p.client, p.sign_ins FROM ${from}
      WHERE ${where.join(" AND ")} ORDER BY p.${order.column} ${order.direction}, p.user_id ${order.direction} LIMIT ?`,
    params: [...params, size + 1], size, order,
    count: { sql: `SELECT count(*) AS n FROM idou_admin_people p WHERE ${counted.where.join(" AND ")}`, params: counted.params },
  };
}

export class PeopleDirectory {
  static async open({ db, now = Date.now, log = () => {} }) {
    if (!db?.dialect) throw new Error("成员目录需要管理库");
    await db.schema("admin-people", `
      CREATE TABLE IF NOT EXISTS idou_admin_people (
        tenant text NOT NULL,
        user_id text NOT NULL,
        name text NOT NULL DEFAULT '',
        name_key text NOT NULL DEFAULT '',
        first_seen_at bigint NOT NULL,
        last_seen_at bigint NOT NULL,
        client text NOT NULL DEFAULT '',
        sign_ins integer NOT NULL DEFAULT 0,
        updated_at bigint NOT NULL,
        PRIMARY KEY (tenant, user_id)
      );
      CREATE INDEX IF NOT EXISTS idou_admin_people_active ON idou_admin_people (tenant, last_seen_at DESC, user_id DESC);
      CREATE INDEX IF NOT EXISTS idou_admin_people_name ON idou_admin_people (tenant, name_key, user_id);
      CREATE INDEX IF NOT EXISTS idou_admin_people_first ON idou_admin_people (tenant, first_seen_at DESC, user_id DESC);
      CREATE TABLE IF NOT EXISTS idou_admin_access (
        tenant text NOT NULL, user_id text NOT NULL, disabled integer NOT NULL DEFAULT 0, signed_out_at bigint NOT NULL DEFAULT 0,
        reason text NOT NULL DEFAULT '', changed_by text NOT NULL DEFAULT '', changed_by_name text NOT NULL DEFAULT '', changed_at bigint NOT NULL,
        PRIMARY KEY (tenant, user_id));
      CREATE TABLE IF NOT EXISTS idou_admin_departments (
        tenant text NOT NULL, department_id text NOT NULL, parent_id text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '',
        path text NOT NULL, depth integer NOT NULL, member_count integer NOT NULL DEFAULT 0, sort_order bigint NOT NULL DEFAULT 0,
        synced_at bigint NOT NULL, PRIMARY KEY (tenant, department_id));
      CREATE TABLE IF NOT EXISTS idou_admin_org_membership (
        tenant text NOT NULL, department_id text NOT NULL, user_id text NOT NULL, PRIMARY KEY (tenant, department_id, user_id));`);
    return new PeopleDirectory({ db, now, log });
  }

  constructor({ db, now, log }) {
    this.db = db; this.now = now; this.log = log;
    this.pending = new Map();
    this.written = new Map();
    this.flushing = null;
    this.closed = false;
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, DIRECTORY_LIMITS.flushMs);
    this.timer.unref?.();
  }

  // Somebody was here. `signIn` for a sign-in or a resume, which is always
  // written; a renewal is presence, written at most every ten minutes.
  seen({ tenantId, userId, name = "", client = "", signIn = false, at = this.now() } = {}) {
    if (this.closed || !PERSON.test(String(tenantId ?? "")) || !PERSON.test(String(userId ?? ""))) return false;
    const key = keyOf(tenantId, userId);
    const cleanName = String(name ?? "").trim().slice(0, DIRECTORY_LIMITS.nameChars);
    const cleanClient = String(client ?? "").trim().slice(0, DIRECTORY_LIMITS.clientChars);
    const last = this.written.get(key);
    if (!signIn && last && at - last.at < DIRECTORY_LIMITS.presenceEveryMs && (!cleanName || cleanName === last.name) && (!cleanClient || cleanClient === last.client)) return false;
    const held = this.pending.get(key);
    this.pending.set(key, {
      tenantId, userId,
      name: cleanName || held?.name || "",
      client: cleanClient || held?.client || "",
      at: Math.max(at, held?.at ?? 0),
      signIns: (held?.signIns ?? 0) + (signIn ? 1 : 0),
    });
    if (this.pending.size >= DIRECTORY_LIMITS.batch) void this.flush().catch(() => {});
    return true;
  }

  async flush() {
    while (this.flushing) await this.flushing;
    if (!this.pending.size) return;
    this.flushing = (async () => {
      while (this.pending.size) {
        const batch = [...this.pending.values()].slice(0, DIRECTORY_LIMITS.batch);
        // In a fixed order, so two processes writing overlapping batches lock
        // rows in the same order and never wait on each other in a circle.
        batch.sort((a, b) => (a.tenantId === b.tenantId ? (a.userId < b.userId ? -1 : 1) : (a.tenantId < b.tenantId ? -1 : 1)));
        const now = this.now();
        try {
          await this.db.run(`INSERT INTO idou_admin_people (tenant, user_id, name, name_key, first_seen_at, last_seen_at, client, sign_ins, updated_at)
            VALUES ${batch.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
            ON CONFLICT (tenant, user_id) DO UPDATE SET
              name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE idou_admin_people.name END,
              name_key = CASE WHEN excluded.name <> '' THEN excluded.name_key ELSE idou_admin_people.name_key END,
              last_seen_at = CASE WHEN excluded.last_seen_at > idou_admin_people.last_seen_at THEN excluded.last_seen_at ELSE idou_admin_people.last_seen_at END,
              client = CASE WHEN excluded.client <> '' THEN excluded.client ELSE idou_admin_people.client END,
              sign_ins = idou_admin_people.sign_ins + excluded.sign_ins,
              updated_at = excluded.updated_at`,
          batch.flatMap((row) => [row.tenantId, row.userId, row.name, nameKey(row.name), row.at, row.at, row.client, row.signIns, now]));
        } catch (error) {
          this.log({ component: "people", event: "people-write-failed", held: this.pending.size, message: String(error?.message ?? error).slice(0, 200) });
          return;
        }
        for (const row of batch) {
          const key = keyOf(row.tenantId, row.userId);
          if (this.pending.get(key) === row) this.pending.delete(key);
          if (this.written.size >= DIRECTORY_LIMITS.remembered) this.written.clear();
          this.written.set(key, { at: row.at, name: row.name, client: row.client });
        }
      }
    })().finally(() => { this.flushing = null; });
    await this.flushing;
  }

  // One page of people, and how many match in all.
  async list(filter = {}) {
    const { sql, params, size, order, count } = peopleQuery(this.db.dialect, filter);
    const [rows, total] = await Promise.all([this.db.all(sql, params), filter.cursor ? Promise.resolve(null) : this.db.get(count.sql, count.params)]);
    const page = rows.slice(0, size).map(person);
    const last = rows.length > size ? rows[size - 1] : null;
    return { people: page, next: last ? peopleCursor.encode(last[order.column], last.user_id) : null, total: total ? Number(total.n) : null };
  }

  async get(tenantId, userId) {
    const row = await this.db.get("SELECT tenant, user_id, name, first_seen_at, last_seen_at, client, sign_ins FROM idou_admin_people WHERE tenant = ? AND user_id = ?", [tenantId, userId]);
    return row ? person(row) : null;
  }

  // Names for a set of people -- the usage table and the audit log hold ids.
  async names(tenantId, userIds) {
    const ids = [...new Set(userIds.filter((id) => typeof id === "string" && PERSON.test(id)))].slice(0, 500);
    if (!ids.length) return new Map();
    const rows = await this.db.all(`SELECT user_id, name FROM idou_admin_people WHERE tenant = ? AND user_id IN (${ids.map(() => "?").join(",")})`, [tenantId, ...ids]);
    return new Map(rows.map((row) => [row.user_id, row.name]));
  }

  // The figures on the overview, each from an index range.
  // `departmentPaths`: counted within those departments only (an
  // administrator's scope).
  async stats(tenantId, at = this.now(), { departmentPaths = null } = {}) {
    const day = 86_400_000;
    if (departmentPaths) {
      // A department's people are listed once and counted in one pass: five
      // separate counts would list them five times.
      const within = inDepartments("user_id", tenantId, departmentPaths);
      const row = await this.db.get(`SELECT count(*) AS total, coalesce(sum(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END), 0) AS today,
          coalesce(sum(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END), 0) AS week, coalesce(sum(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END), 0) AS month,
          coalesce(sum(CASE WHEN first_seen_at >= ? THEN 1 ELSE 0 END), 0) AS fresh
        FROM idou_admin_people WHERE tenant = ? AND ${within.sql}`, [at - day, at - 7 * day, at - 30 * day, at - 30 * day, tenantId, ...within.params]);
      return { total: Number(row.total), activeDay: Number(row.today), activeWeek: Number(row.week), activeMonth: Number(row.month), newMonth: Number(row.fresh) };
    }
    const count = async (where, params) => Number((await this.db.get(`SELECT count(*) AS n FROM idou_admin_people WHERE tenant = ? ${where}`, [tenantId, ...params])).n);
    const [total, today, week, month, fresh] = await Promise.all([
      count("", []), count("AND last_seen_at >= ?", [at - day]), count("AND last_seen_at >= ?", [at - 7 * day]),
      count("AND last_seen_at >= ?", [at - 30 * day]), count("AND first_seen_at >= ?", [at - 30 * day]),
    ]);
    return { total, activeDay: today, activeWeek: week, activeMonth: month, newMonth: fresh };
  }

  // Off the list, for a person whose data is being let go (offboarding). What
  // happened stays in the audit log.
  async forget(tenantId, userId) {
    this.pending.delete(keyOf(tenantId, userId));
    this.written.delete(keyOf(tenantId, userId));
    const { changes } = await this.db.run("DELETE FROM idou_admin_people WHERE tenant = ? AND user_id = ?", [tenantId, userId]);
    return changes;
  }

  async close() {
    clearInterval(this.timer);
    await this.flush().catch(() => {});
    this.closed = true;
  }
}

function person(row) {
  return { tenantId: row.tenant, userId: row.user_id, name: row.name, firstSeenAt: Number(row.first_seen_at), lastSeenAt: Number(row.last_seen_at),
    client: row.client, signIns: Number(row.sign_ins) };
}
