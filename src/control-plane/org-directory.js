// The organisation's structure, as Feishu's address book has it: departments
// and who is in which (docs/admin-console.md §8). Filled by org-sync.js, read
// by the policy engine (a rule for a department applies to everybody in it
// and in the departments under it) and by the console.
//
// Kept only for what this deployment needs: the whole department tree (a
// hundred thousand people is about ten thousand departments), and, for each
// person who has used i豆, which departments they are in and whether Feishu
// still has them employed. Nobody else's record is copied here.
//
// A department's place in the tree is stored as its path from the root,
// "/od-a/od-b/", so "this department and everything under it" is one index
// range rather than a walk.
//
// Somebody the address book says has left waits on a list until an
// administrator has cleaned up after them (离职清理); cleaned_at says when.
// Coming back to work -- Feishu saying so -- takes them off it.
export const ORG_LIMITS = Object.freeze({ departmentsMax: 200_000, cachedPeople: 200_000, cacheMs: 10 * 60_000, nameChars: 128 });
const DEPARTMENT = /^[A-Za-z0-9_-]{1,128}$/;
const PATH = /^(\/[A-Za-z0-9_-]{1,128})+\/$/;
const keyOf = (tenantId, userId) => `${tenantId}\n${userId}`;

// "`column` is somebody in one of these departments, or in one under them",
// for a listing's WHERE (the people directory, the audit trail). A prefix
// match on the path, its underscores taken literally. The tenant is a
// parameter, never the outer row's: a subquery that names the outer row is
// run again for every row read (1.4 s for 100,000 people), one that does not
// is made once (5 ms). No departments: nobody.
export function inDepartments(column, tenantId, paths) {
  if (!/^[a-z_.]{1,40}$/.test(column)) throw new Error("列名无效");
  for (const path of paths) if (!PATH.test(String(path))) throw new Error("部门无效");
  if (!paths.length) return { sql: "1 = 0", params: [] };
  return {
    sql: `${column} IN (SELECT m.user_id FROM idou_admin_org_membership m WHERE m.tenant = ? AND m.department_id IN
      (SELECT d.department_id FROM idou_admin_departments d WHERE d.tenant = ? AND (${paths.map(() => "d.path LIKE ? ESCAPE '\\'").join(" OR ")})))`,
    params: [tenantId, tenantId, ...paths.map((path) => `${path.replace(/[\\%_]/g, (char) => `\\${char}`)}%`)],
  };
}

export class OrgDirectory {
  static async open({ db, now = Date.now, log = () => {} }) {
    if (!db?.dialect) throw new Error("组织架构需要管理库");
    await db.schema("admin-org", `
      CREATE TABLE IF NOT EXISTS idou_admin_departments (
        tenant text NOT NULL, department_id text NOT NULL, parent_id text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '',
        path text NOT NULL, depth integer NOT NULL, member_count integer NOT NULL DEFAULT 0, sort_order bigint NOT NULL DEFAULT 0,
        synced_at bigint NOT NULL, PRIMARY KEY (tenant, department_id));
      CREATE INDEX IF NOT EXISTS idou_admin_departments_parent ON idou_admin_departments (tenant, parent_id, sort_order);
      CREATE INDEX IF NOT EXISTS idou_admin_departments_path ON idou_admin_departments (tenant, path);
      CREATE TABLE IF NOT EXISTS idou_admin_org_people (
        tenant text NOT NULL, user_id text NOT NULL, employment text NOT NULL DEFAULT 'active', departments text NOT NULL DEFAULT '[]',
        checked_at bigint NOT NULL, departed_at bigint NOT NULL DEFAULT 0, cleaned_at bigint NOT NULL DEFAULT 0, PRIMARY KEY (tenant, user_id));
      CREATE INDEX IF NOT EXISTS idou_admin_org_people_departed ON idou_admin_org_people (tenant, employment, cleaned_at, departed_at);
      CREATE TABLE IF NOT EXISTS idou_admin_org_membership (
        tenant text NOT NULL, department_id text NOT NULL, user_id text NOT NULL, PRIMARY KEY (tenant, department_id, user_id));
      CREATE INDEX IF NOT EXISTS idou_admin_org_membership_user ON idou_admin_org_membership (tenant, user_id);
      CREATE TABLE IF NOT EXISTS idou_admin_org_sync (
        tenant text NOT NULL PRIMARY KEY, state text NOT NULL, detail text NOT NULL DEFAULT '{}', started_at bigint NOT NULL, finished_at bigint NOT NULL DEFAULT 0);`);
    const org = new OrgDirectory({ db, now, log });
    org.onChange = ({ topic }) => { if (topic === "org" || topic === "reset") org.cache.clear(); };
    db.on("change", org.onChange);
    return org;
  }

  constructor({ db, now, log }) {
    Object.assign(this, { db, now, log });
    this.cache = new Map();
  }

  // Every department a person is in, with every department above those:
  // what a rule for a department matches. Held ten minutes per person.
  async departmentsOf(who) {
    const key = keyOf(who.tenantId, who.userId), held = this.cache.get(key);
    if (held && held.until > this.now()) return held.ids;
    const rows = await this.db.all(`SELECT d.path FROM idou_admin_org_membership m JOIN idou_admin_departments d
      ON d.tenant = m.tenant AND d.department_id = m.department_id WHERE m.tenant = ? AND m.user_id = ?`, [who.tenantId, who.userId]);
    const ids = [...new Set(rows.flatMap((row) => String(row.path).split("/").filter(Boolean)))];
    if (this.cache.size >= ORG_LIMITS.cachedPeople) this.cache.clear();
    this.cache.set(key, { ids, until: this.now() + ORG_LIMITS.cacheMs });
    return ids;
  }

  // How deep each department is, for "the nearest department decides".
  async depths(tenantId, ids) {
    if (!ids.length) return new Map();
    const rows = await this.db.all(`SELECT department_id, depth FROM idou_admin_departments WHERE tenant = ? AND department_id IN (${ids.map(() => "?").join(",")})`, [tenantId, ...ids]);
    return new Map(rows.map((row) => [row.department_id, Number(row.depth)]));
  }

  // One level of the tree, for the console to unfold: the children of
  // `parentId` ("" for the top), with how many people are in each and how
  // many of them have used i豆.
  async children(tenantId, parentId = "") {
    const rows = await this.db.all(`SELECT department_id, parent_id, name, path, depth, member_count,
        (SELECT count(*) FROM idou_admin_departments c WHERE c.tenant = d.tenant AND c.parent_id = d.department_id) AS children
      FROM idou_admin_departments d WHERE tenant = ? AND parent_id = ? ORDER BY sort_order, name LIMIT 2000`, [tenantId, parentId]);
    return rows.map(department);
  }

  async get(tenantId, departmentId) {
    const row = await this.db.get("SELECT department_id, parent_id, name, path, depth, member_count, 0 AS children FROM idou_admin_departments WHERE tenant = ? AND department_id = ?", [tenantId, departmentId]);
    return row ? department(row) : null;
  }

  // Departments by name, for a picker.
  async search(tenantId, text, limit = 20) {
    const needle = String(text ?? "").trim().toLowerCase().slice(0, 64);
    if (!needle) return [];
    const rows = await this.db.all(`SELECT department_id, parent_id, name, path, depth, member_count, 0 AS children FROM idou_admin_departments
      WHERE tenant = ? AND lower(name) LIKE ? ESCAPE '\\' ORDER BY depth, name LIMIT ?`, [tenantId, `%${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`, Math.min(50, limit)]);
    return rows.map(department);
  }

  // The names of a list of departments, and the chain above each, for a
  // person's page: "研发中心 / 平台部 / 前端组".
  async named(tenantId, ids) {
    const wanted = [...new Set(ids.filter((id) => DEPARTMENT.test(String(id))))].slice(0, 200);
    if (!wanted.length) return [];
    const rows = await this.db.all(`SELECT department_id, path, name FROM idou_admin_departments WHERE tenant = ? AND department_id IN (${wanted.map(() => "?").join(",")})`, [tenantId, ...wanted]);
    const above = [...new Set(rows.flatMap((row) => String(row.path).split("/").filter(Boolean)))];
    const names = new Map((above.length ? await this.db.all(`SELECT department_id, name FROM idou_admin_departments WHERE tenant = ? AND department_id IN (${above.map(() => "?").join(",")})`, [tenantId, ...above]) : [])
      .map((row) => [row.department_id, row.name]));
    return rows.map((row) => ({ id: row.department_id, name: row.name, path: String(row.path).split("/").filter(Boolean).map((id) => names.get(id) ?? id) }));
  }

  // Departments as stored, for a set of ids: what an administrator's scope
  // is made of. One that Feishu no longer has is simply not returned.
  async departments(tenantId, ids) {
    const wanted = [...new Set(ids.filter((id) => DEPARTMENT.test(String(id))))].slice(0, 200);
    if (!wanted.length) return [];
    const rows = await this.db.all(`SELECT department_id, parent_id, name, path, depth, member_count, 0 AS children FROM idou_admin_departments
      WHERE tenant = ? AND department_id IN (${wanted.map(() => "?").join(",")})`, [tenantId, ...wanted]);
    return rows.map(department);
  }

  // A person as the address book has them, or null when never checked.
  async person(tenantId, userId) {
    const row = await this.db.get("SELECT employment, departments, checked_at, departed_at FROM idou_admin_org_people WHERE tenant = ? AND user_id = ?", [tenantId, userId]);
    if (!row) return null;
    let ids = [];
    try { ids = JSON.parse(row.departments); } catch { ids = []; }
    return { employment: row.employment, departments: await this.named(tenantId, ids), checkedAt: Number(row.checked_at), departedAt: Number(row.departed_at) || null };
  }

  // Whoever the address book says has left: still to be cleaned up after
  // ("pending", the earliest first -- a queue that empties as it is worked
  // through), or already cleaned up ("cleaned", the latest first).
  // `paths`: only people in those departments or under them (an
  // administrator's scope); null for everybody.
  async departed({ tenantId, state = "pending", limit = 100, paths = null } = {}) {
    const size = Math.max(1, Math.min(500, Number(limit) || 100));
    const within = paths ? inDepartments("user_id", tenantId, paths) : null;
    const scoped = within ? ` AND ${within.sql}` : "";
    const rows = state === "cleaned"
      ? await this.db.all(`SELECT user_id, departed_at, cleaned_at FROM idou_admin_org_people WHERE tenant = ? AND employment = 'resigned' AND cleaned_at > 0${scoped}
          ORDER BY cleaned_at DESC LIMIT ?`, [tenantId, ...(within?.params ?? []), size])
      : await this.db.all(`SELECT user_id, departed_at, cleaned_at FROM idou_admin_org_people WHERE tenant = ? AND employment = 'resigned' AND cleaned_at = 0${scoped}
          ORDER BY departed_at, user_id LIMIT ?`, [tenantId, ...(within?.params ?? []), size]);
    return rows.map((row) => ({ userId: row.user_id, departedAt: Number(row.departed_at), cleanedAt: Number(row.cleaned_at) || null }));
  }

  // Which of these people are in one of these departments or under them:
  // the console's "may this administrator touch them". Somebody the address
  // book has never placed is in none.
  async within(tenantId, userIds, paths) {
    const ids = [...new Set(userIds.map(String))].filter((id) => /^ou_[A-Za-z0-9_-]{1,128}$/.test(id));
    for (const path of paths) if (!PATH.test(String(path))) throw new Error("部门无效");
    const found = new Set();
    if (!ids.length || !paths.length) return found;
    const like = paths.map((path) => `${path.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
    for (let from = 0; from < ids.length; from += 500) {
      const slice = ids.slice(from, from + 500);
      const rows = await this.db.all(`SELECT DISTINCT m.user_id FROM idou_admin_org_membership m JOIN idou_admin_departments d ON d.tenant = m.tenant AND d.department_id = m.department_id
        WHERE m.tenant = ? AND m.user_id IN (${slice.map(() => "?").join(",")}) AND (${like.map(() => "d.path LIKE ? ESCAPE '\\'").join(" OR ")})`, [tenantId, ...slice, ...like]);
      for (const row of rows) found.add(row.user_id);
    }
    return found;
  }

  // How many wait to be cleaned up after, within `paths` (or everywhere).
  async pendingCount(tenantId, paths = null) {
    const within = paths ? inDepartments("user_id", tenantId, paths) : null;
    return Number((await this.db.get(`SELECT count(*) AS n FROM idou_admin_org_people WHERE tenant = ? AND employment = 'resigned' AND cleaned_at = 0${within ? ` AND ${within.sql}` : ""}`,
      [tenantId, ...(within?.params ?? [])])).n);
  }

  // Cleaned up after: off the waiting list. Only somebody the address book
  // says has left -- anybody else has nothing here to mark.
  async markCleaned(tenantId, userIds) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return 0;
    const at = this.now();
    let marked = 0;
    for (let from = 0; from < ids.length; from += 200) {
      const slice = ids.slice(from, from + 200);
      const result = await this.db.run(`UPDATE idou_admin_org_people SET cleaned_at = ? WHERE tenant = ? AND employment = 'resigned' AND cleaned_at = 0
        AND user_id IN (${slice.map(() => "?").join(",")})`, [at, tenantId, ...slice]);
      marked += Number(result?.changes ?? 0);
    }
    return marked;
  }

  async status(tenantId) {
    const row = await this.db.get("SELECT state, detail, started_at, finished_at FROM idou_admin_org_sync WHERE tenant = ?", [tenantId]);
    const counts = await this.db.get(`SELECT (SELECT count(*) FROM idou_admin_departments WHERE tenant = ?) AS departments,
      (SELECT count(*) FROM idou_admin_org_people WHERE tenant = ?) AS people, (SELECT count(*) FROM idou_admin_org_people WHERE tenant = ? AND employment = 'resigned') AS departed,
      (SELECT count(*) FROM idou_admin_org_people WHERE tenant = ? AND employment = 'resigned' AND cleaned_at = 0) AS pending`,
    [tenantId, tenantId, tenantId, tenantId]);
    let detail = {};
    try { detail = JSON.parse(row?.detail ?? "{}"); } catch { detail = {}; }
    return { state: row?.state ?? "never", detail, startedAt: Number(row?.started_at ?? 0) || null, finishedAt: Number(row?.finished_at ?? 0) || null,
      departments: Number(counts.departments), people: Number(counts.people), departed: Number(counts.departed), pending: Number(counts.pending) };
  }

  // ---------------------------------------------------------------- writes, by org-sync.js only
  async recordSync(tenantId, state, detail = {}, { started = false } = {}) {
    const at = this.now();
    await this.db.run(`INSERT INTO idou_admin_org_sync (tenant, state, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant) DO UPDATE SET state = excluded.state, detail = excluded.detail,
        started_at = CASE WHEN ? = 1 THEN excluded.started_at ELSE idou_admin_org_sync.started_at END, finished_at = excluded.finished_at`,
    [tenantId, state, JSON.stringify(detail).slice(0, 4000), at, started ? 0 : at, started ? 1 : 0]);
  }

  // The whole tree, replaced: what is not in it any more goes. Stamped later
  // than anything already there, so a clock stepped back cannot keep
  // departments Feishu no longer has.
  async replaceDepartments(tenantId, departments) {
    if (departments.length > ORG_LIMITS.departmentsMax) throw new Error(`部门超过 ${ORG_LIMITS.departmentsMax} 个`);
    await this.db.transaction(async (tx) => {
      const last = Number((await tx.get("SELECT max(synced_at) AS at FROM idou_admin_departments WHERE tenant = ?", [tenantId]))?.at ?? 0);
      const at = Math.max(this.now(), last + 1);
      for (let from = 0; from < departments.length; from += 200) {
        const slice = departments.slice(from, from + 200);
        await tx.run(`INSERT INTO idou_admin_departments (tenant, department_id, parent_id, name, path, depth, member_count, sort_order, synced_at)
          VALUES ${slice.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}
          ON CONFLICT (tenant, department_id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, path = excluded.path, depth = excluded.depth,
            member_count = excluded.member_count, sort_order = excluded.sort_order, synced_at = excluded.synced_at`,
        slice.flatMap((item) => [tenantId, item.id, item.parentId, String(item.name ?? "").slice(0, ORG_LIMITS.nameChars), item.path, item.depth, item.memberCount ?? 0, item.order ?? 0, at]));
      }
      await tx.run("DELETE FROM idou_admin_departments WHERE tenant = ? AND synced_at < ?", [tenantId, at]);
    });
  }

  // What the address book says of a batch of people. Returns, for those it
  // says have left, when that was first seen.
  async recordPeople(tenantId, people) {
    const at = this.now();
    const departed = new Map();
    await this.db.transaction(async (tx) => {
      for (const person of people) {
        const before = await tx.get("SELECT employment, departed_at FROM idou_admin_org_people WHERE tenant = ? AND user_id = ?", [tenantId, person.userId]);
        const departedAt = person.employment === "resigned" ? (before?.employment === "resigned" ? Number(before.departed_at) : at) : 0;
        if (departedAt) departed.set(person.userId, departedAt);
        // Back at work: off the waiting list, so that leaving again puts them on it again.
        await tx.run(`INSERT INTO idou_admin_org_people (tenant, user_id, employment, departments, checked_at, departed_at, cleaned_at) VALUES (?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT (tenant, user_id) DO UPDATE SET employment = excluded.employment, departments = excluded.departments, checked_at = excluded.checked_at,
            departed_at = excluded.departed_at, cleaned_at = CASE WHEN excluded.employment = 'resigned' THEN idou_admin_org_people.cleaned_at ELSE 0 END`,
        [tenantId, person.userId, person.employment, JSON.stringify(person.departments), at, departedAt]);
        await tx.run("DELETE FROM idou_admin_org_membership WHERE tenant = ? AND user_id = ?", [tenantId, person.userId]);
        for (const departmentId of person.departments) {
          await tx.run("INSERT INTO idou_admin_org_membership (tenant, department_id, user_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [tenantId, departmentId, person.userId]);
        }
      }
    });
    for (const person of people) this.cache.delete(keyOf(tenantId, person.userId));
    return departed;
  }

  async announce() { this.cache.clear(); await this.db.announce("org", null); }

  close() { if (this.onChange) this.db.off("change", this.onChange); }
}

function department(row) {
  return { id: row.department_id, parentId: row.parent_id, name: row.name, path: row.path, depth: Number(row.depth), memberCount: Number(row.member_count), children: Number(row.children ?? 0) };
}
