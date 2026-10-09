// What an organisation decides about its enterprise skills, beyond what is on
// the shelf (docs/enterprise-skill-governance.md): whether a new version waits
// for an administrator, who besides the server's configured administrators may
// publish, every version that went up (to go back to), who can see each skill,
// and who used which.
//
// All of it in the administration database. The shelf itself
// (skill-registry.js) keeps its exact format: it is read strictly, and a field
// more would stop a release before this one from starting at all. So a
// rollback finds the shelf as it was and simply does not read these tables.
import { createHmac, randomUUID } from "node:crypto";
import { normalizeSkill, skillDigest } from "../skills/catalog-format.js";
import { RegistryError } from "./skill-registry.js";

export const SKILL_LIMITS = Object.freeze({ versionsKept: 5, departments: 50, publishers: 200, usageDays: 400, reasonChars: 300,
  // One person's uses of one skill counted in a day; versions one publisher, and
  // one organisation, may have waiting at once; decided ones kept this many days.
  usesPerPersonDay: 100, pendingPerPublisher: 10, pendingPerTenant: 100, decidedDays: 180 });
export const SUBMISSION_STATES = Object.freeze(["pending", "approved", "rejected", "superseded"]);

const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
const DEPARTMENT = /^[A-Za-z0-9_-]{1,128}$/;
const text = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
// An administrator carries `name`; a desktop session's identity `displayName`.
const who = (by) => ({ userId: text(by?.userId, 128), name: text(by?.name ?? by?.displayName, 64) });
const day = (at) => new Date(at).toISOString().slice(0, 10);

export class SkillGovernance {
  // `key`: a secret of the server's, so the record of who used a skill names
  // nobody (one summary per person, the same every day, nothing to read back).
  static async open({ db, key, now = Date.now, log = () => {} }) {
    if (!db?.dialect) throw new Error("企业技能管理需要管理库");
    if (!key || key.length < 16) throw new Error("企业技能管理需要一把服务端密钥");
    await db.schema("admin-skill-governance", `
      CREATE TABLE IF NOT EXISTS idou_admin_skill_settings (
        tenant text NOT NULL PRIMARY KEY, review_required integer NOT NULL DEFAULT 1,
        updated_by text NOT NULL DEFAULT '', updated_by_name text NOT NULL DEFAULT '', updated_at bigint NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS idou_admin_skill_publishers (
        tenant text NOT NULL, user_id text NOT NULL, name text NOT NULL DEFAULT '',
        added_by text NOT NULL DEFAULT '', added_by_name text NOT NULL DEFAULT '', added_at bigint NOT NULL,
        PRIMARY KEY (tenant, user_id));
      CREATE TABLE IF NOT EXISTS idou_admin_skill_versions (
        tenant text NOT NULL, skill_id text NOT NULL, version text NOT NULL, digest text NOT NULL, bundle text NOT NULL, title text NOT NULL DEFAULT '',
        published_at bigint NOT NULL, published_by text NOT NULL DEFAULT '', published_by_name text NOT NULL DEFAULT '',
        approved_by text NOT NULL DEFAULT '', approved_by_name text NOT NULL DEFAULT '', source text NOT NULL,
        PRIMARY KEY (tenant, skill_id, digest));
      CREATE INDEX IF NOT EXISTS idou_admin_skill_versions_time ON idou_admin_skill_versions (tenant, skill_id, published_at DESC);
      CREATE TABLE IF NOT EXISTS idou_admin_skill_submissions (
        id text NOT NULL PRIMARY KEY, tenant text NOT NULL, skill_id text NOT NULL, version text NOT NULL, digest text NOT NULL, bundle text NOT NULL,
        title text NOT NULL DEFAULT '', required_tools text NOT NULL DEFAULT '[]', submitted_by text NOT NULL, submitted_by_name text NOT NULL DEFAULT '', submitted_at bigint NOT NULL,
        state text NOT NULL, decided_by text NOT NULL DEFAULT '', decided_by_name text NOT NULL DEFAULT '', decided_at bigint NOT NULL DEFAULT 0,
        reason text NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS idou_admin_skill_submissions_state ON idou_admin_skill_submissions (tenant, state, submitted_at DESC);
      CREATE INDEX IF NOT EXISTS idou_admin_skill_submissions_by ON idou_admin_skill_submissions (tenant, submitted_by, submitted_at DESC);
      CREATE TABLE IF NOT EXISTS idou_admin_skill_visibility (
        tenant text NOT NULL, skill_id text NOT NULL, departments text NOT NULL DEFAULT '[]',
        updated_by text NOT NULL DEFAULT '', updated_by_name text NOT NULL DEFAULT '', updated_at bigint NOT NULL,
        PRIMARY KEY (tenant, skill_id));
      CREATE TABLE IF NOT EXISTS idou_admin_skill_usage (
        tenant text NOT NULL, skill_id text NOT NULL, day text NOT NULL, person text NOT NULL, uses bigint NOT NULL DEFAULT 0, version text NOT NULL DEFAULT '',
        PRIMARY KEY (tenant, skill_id, day, person));
      CREATE INDEX IF NOT EXISTS idou_admin_skill_usage_day ON idou_admin_skill_usage (tenant, day);`);
    const governance = new SkillGovernance({ db, key, now, log });
    await governance.reload();
    governance.onChange = ({ topic }) => { if (topic === "skills" || topic === "reset") governance.refresh(); };
    db.on("change", governance.onChange);
    // And every five minutes: a notice that was missed, or a reload that
    // failed, is not left standing until the next change.
    governance.timer = setInterval(() => governance.refresh(), 5 * 60_000);
    governance.timer.unref?.();
    return governance;
  }

  constructor({ db, key, now, log }) {
    Object.assign(this, { db, key, now, log });
    // Read on every catalogue read and every publish: held here, reloaded when
    // any process changes them (the database announces it).
    this.held = { settings: new Map(), publishers: new Map(), visibility: new Map() };
  }

  async reload() {
    const [settings, publishers, visibility] = await Promise.all([
      this.db.all("SELECT tenant, review_required, updated_by, updated_by_name, updated_at FROM idou_admin_skill_settings"),
      this.db.all("SELECT tenant, user_id, name, added_by, added_by_name, added_at FROM idou_admin_skill_publishers ORDER BY added_at"),
      this.db.all("SELECT tenant, skill_id, departments, updated_by, updated_by_name, updated_at FROM idou_admin_skill_visibility")]);
    const held = { settings: new Map(), publishers: new Map(), visibility: new Map() };
    for (const row of settings) held.settings.set(row.tenant, { reviewRequired: Number(row.review_required) === 1,
      updated: row.updated_at ? { by: { userId: row.updated_by, name: row.updated_by_name }, at: Number(row.updated_at) } : null });
    for (const row of publishers) {
      const list = held.publishers.get(row.tenant) ?? [];
      list.push({ userId: row.user_id, name: row.name, added: { by: { userId: row.added_by, name: row.added_by_name }, at: Number(row.added_at) } });
      held.publishers.set(row.tenant, list);
    }
    for (const row of visibility) {
      let departments = [];
      try { departments = JSON.parse(row.departments).filter((id) => DEPARTMENT.test(String(id))); } catch { departments = []; }
      const map = held.visibility.get(row.tenant) ?? new Map();
      map.set(row.skill_id, { departments, updated: { by: { userId: row.updated_by, name: row.updated_by_name }, at: Number(row.updated_at) } });
      held.visibility.set(row.tenant, map);
    }
    this.held = held;
  }
  refresh() { void this.reload().catch((error) => this.log({ component: "skills", event: "reload-failed", message: String(error?.message ?? error).slice(0, 200) })); }
  async #changed() { await this.reload(); await this.db.announce("skills", null); }

  // ------------------------------------------------------------ settings
  // On unless an administrator turned it off: a skill goes to everybody.
  settings(tenantId) { return this.held.settings.get(tenantId) ?? { reviewRequired: true, updated: null }; }
  async setSettings(tenantId, { reviewRequired }, by) {
    if (typeof reviewRequired !== "boolean") throw new Error("「上架前需要审核」只能是开或关");
    const before = this.settings(tenantId), editor = who(by);
    await this.db.run(`INSERT INTO idou_admin_skill_settings (tenant, review_required, updated_by, updated_by_name, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant) DO UPDATE SET review_required = excluded.review_required, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at`,
    [tenantId, reviewRequired ? 1 : 0, editor.userId, editor.name, this.now()]);
    await this.#changed();
    return { before, after: this.settings(tenantId) };
  }

  // ---------------------------------------------------------- publishers
  publishers(tenantId) { return this.held.publishers.get(tenantId) ?? []; }
  isPublisher(tenantId, userId) { return this.publishers(tenantId).some((person) => person.userId === userId); }
  async addPublisher(tenantId, { userId, name = "" }, by) {
    if (!OPEN_ID.test(String(userId))) throw new Error("要加的人无效");
    if (this.publishers(tenantId).length >= SKILL_LIMITS.publishers) throw new Error(`最多 ${SKILL_LIMITS.publishers} 位上架人`);
    const editor = who(by);
    await this.db.run(`INSERT INTO idou_admin_skill_publishers (tenant, user_id, name, added_by, added_by_name, added_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant, user_id) DO UPDATE SET name = excluded.name`, [tenantId, userId, text(name, 64), editor.userId, editor.name, this.now()]);
    await this.#changed();
  }
  async removePublisher(tenantId, userId) {
    const { changes } = await this.db.run("DELETE FROM idou_admin_skill_publishers WHERE tenant = ? AND user_id = ?", [tenantId, String(userId)]);
    await this.#changed();
    return changes > 0;
  }

  // ------------------------------------------------------------ versions
  // A version that went up, kept to go back to. The newest few per skill.
  async recordVersion(tenantId, skill, { publishedBy, approvedBy = null, source, at = this.now() }) {
    const bundle = normalizeSkill(skill), digest = skillDigest(bundle), publisher = who(publishedBy), approver = approvedBy ? who(approvedBy) : { userId: "", name: "" };
    await this.db.run(`INSERT INTO idou_admin_skill_versions (tenant, skill_id, version, digest, bundle, title, published_at, published_by, published_by_name, approved_by, approved_by_name, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant, skill_id, digest) DO UPDATE SET published_at = excluded.published_at, published_by = excluded.published_by, published_by_name = excluded.published_by_name,
        approved_by = excluded.approved_by, approved_by_name = excluded.approved_by_name, source = excluded.source`,
    [tenantId, bundle.id, bundle.version, digest, JSON.stringify(bundle), text(bundle.title, 160), at, publisher.userId, publisher.name, approver.userId, approver.name, source]);
    const kept = await this.db.all("SELECT digest FROM idou_admin_skill_versions WHERE tenant = ? AND skill_id = ? ORDER BY published_at DESC", [tenantId, bundle.id]);
    for (const row of kept.slice(SKILL_LIMITS.versionsKept)) await this.db.run("DELETE FROM idou_admin_skill_versions WHERE tenant = ? AND skill_id = ? AND digest = ?", [tenantId, bundle.id, row.digest]);
    return { digest };
  }
  // What is up now, kept before something replaces it -- once: a skill put up
  // before versions were recorded is otherwise gone the moment it is replaced.
  async keepLive(tenantId, live) {
    if (!live?.id) return;
    const { digest: _listed, ...skill } = live;
    const digest = skillDigest(normalizeSkill(skill));
    if (await this.db.get("SELECT 1 AS kept FROM idou_admin_skill_versions WHERE tenant = ? AND skill_id = ? AND digest = ?", [tenantId, skill.id, digest])) return;
    await this.recordVersion(tenantId, skill, { publishedBy: null, source: "earlier", at: this.now() - 1 });
  }
  // Skills with versions kept that are not up now (`live`: the ids that are):
  // withdrawn, to bring back from their own page.
  async withdrawn(tenantId, live) {
    const rows = await this.db.all(`SELECT skill_id, version, title, published_at, source FROM idou_admin_skill_versions WHERE tenant = ? ORDER BY published_at DESC`, [tenantId]);
    const seen = new Map();
    for (const row of rows) if (!live.includes(row.skill_id) && !seen.has(row.skill_id)) {
      seen.set(row.skill_id, { id: row.skill_id, version: row.version, title: row.title, at: Number(row.published_at), source: row.source });
    }
    return [...seen.values()];
  }
  async versions(tenantId, skillId) {
    const rows = await this.db.all(`SELECT version, digest, published_at, published_by, published_by_name, approved_by, approved_by_name, source
      FROM idou_admin_skill_versions WHERE tenant = ? AND skill_id = ? ORDER BY published_at DESC`, [tenantId, skillId]);
    return rows.map((row) => ({ version: row.version, digest: row.digest, at: Number(row.published_at), source: row.source,
      publishedBy: { userId: row.published_by, name: row.published_by_name }, approvedBy: row.approved_by ? { userId: row.approved_by, name: row.approved_by_name } : null }));
  }
  async version(tenantId, skillId, digest) {
    const row = await this.db.get("SELECT bundle FROM idou_admin_skill_versions WHERE tenant = ? AND skill_id = ? AND digest = ?", [tenantId, skillId, String(digest)]);
    return row ? normalizeSkill(JSON.parse(row.bundle)) : null;
  }

  // --------------------------------------------------------- submissions
  // A version waiting for an administrator. The shelf does not change.
  async submit(tenantId, skill, by) {
    const bundle = normalizeSkill(skill), digest = skillDigest(bundle), submitter = who(by);
    const waiting = await this.db.get("SELECT id FROM idou_admin_skill_submissions WHERE tenant = ? AND skill_id = ? AND digest = ? AND state = 'pending'", [tenantId, bundle.id, digest]);
    if (waiting) return { id: waiting.id, digest, already: true };
    // What may wait at once, so one publisher cannot fill the database.
    const [mine, all] = await Promise.all([
      this.db.get("SELECT count(*) AS n FROM idou_admin_skill_submissions WHERE tenant = ? AND submitted_by = ? AND state = 'pending'", [tenantId, submitter.userId]),
      this.db.get("SELECT count(*) AS n FROM idou_admin_skill_submissions WHERE tenant = ? AND state = 'pending'", [tenantId])]);
    if (Number(mine.n) >= SKILL_LIMITS.pendingPerPublisher) throw new RegistryError(429, "skill_submissions_waiting");
    if (Number(all.n) >= SKILL_LIMITS.pendingPerTenant) throw new RegistryError(429, "skill_review_queue_full");
    const id = randomUUID();
    await this.db.run(`INSERT INTO idou_admin_skill_submissions (id, tenant, skill_id, version, digest, bundle, title, required_tools, submitted_by, submitted_by_name, submitted_at, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`, [id, tenantId, bundle.id, bundle.version, digest, JSON.stringify(bundle), text(bundle.title, 160),
      JSON.stringify(bundle.requiredTools ?? []), submitter.userId, submitter.name, this.now()]);
    return { id, digest, already: false };
  }
  async submissions(tenantId, { state = "pending", submittedBy = null, limit = 100 } = {}) {
    if (state && !SUBMISSION_STATES.includes(state)) throw new Error("没有这种状态");
    const where = ["tenant = ?"], params = [tenantId];
    if (state) { where.push("state = ?"); params.push(state); }
    if (submittedBy) { where.push("submitted_by = ?"); params.push(submittedBy); }
    const rows = await this.db.all(`SELECT id, skill_id, version, digest, title, required_tools, submitted_by, submitted_by_name, submitted_at, state, decided_by, decided_by_name, decided_at, reason
      FROM idou_admin_skill_submissions WHERE ${where.join(" AND ")} ORDER BY submitted_at DESC LIMIT ?`, [...params, Math.min(Math.max(Number(limit) || 100, 1), 500)]);
    return rows.map(submission);
  }
  async submission(tenantId, id) {
    const row = await this.db.get(`SELECT id, skill_id, version, digest, bundle, title, required_tools, submitted_by, submitted_by_name, submitted_at, state, decided_by, decided_by_name, decided_at, reason
      FROM idou_admin_skill_submissions WHERE tenant = ? AND id = ?`, [tenantId, String(id)]);
    return row ? { ...submission(row), skill: normalizeSkill(JSON.parse(row.bundle)) } : null;
  }
  // Decided once: whoever changes it from pending first. An approval is
  // claimed this way before the version is put up (admin-api.js), so a
  // rejection at the same moment either wins or is refused -- never both.
  // `supersede: false`: the console's approval ends the older ones itself, once its version is up.
  async decide(tenantId, id, { decision, by, reason = "", supersede = true }) {
    if (!["approved", "rejected"].includes(decision)) throw new Error("没有这种决定");
    const decider = who(by), at = this.now();
    const { changes } = await this.db.run(`UPDATE idou_admin_skill_submissions SET state = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, reason = ?
      WHERE tenant = ? AND id = ? AND state = 'pending'`, [decision, decider.userId, decider.name, at, text(reason, SKILL_LIMITS.reasonChars), tenantId, String(id)]);
    if (!changes) return false;
    if (decision === "approved" && supersede) await this.supersede(tenantId, id);
    return true;
  }
  // An approved version up: the older ones of the same skill still waiting are ended.
  async supersede(tenantId, id) {
    const row = await this.db.get("SELECT skill_id, submitted_at, decided_at FROM idou_admin_skill_submissions WHERE tenant = ? AND id = ?", [tenantId, String(id)]);
    if (!row) return;
    await this.db.run(`UPDATE idou_admin_skill_submissions SET state = 'superseded', decided_at = ? WHERE tenant = ? AND skill_id = ? AND state = 'pending' AND submitted_at <= ?`,
      [Number(row.decided_at) || this.now(), tenantId, row.skill_id, Number(row.submitted_at)]);
  }
  // A claimed approval whose version could not be put up waits again.
  async reopen(tenantId, id) {
    await this.db.run(`UPDATE idou_admin_skill_submissions SET state = 'pending', decided_by = '', decided_by_name = '', decided_at = 0, reason = ''
      WHERE tenant = ? AND id = ? AND state = 'approved'`, [tenantId, String(id)]);
  }
  async pruneSubmissions() {
    const { changes } = await this.db.run("DELETE FROM idou_admin_skill_submissions WHERE state <> 'pending' AND decided_at > 0 AND decided_at < ?",
      [this.now() - SKILL_LIMITS.decidedDays * 86_400_000]);
    return changes;
  }
  async pendingCount(tenantId) {
    return Number((await this.db.get("SELECT count(*) AS n FROM idou_admin_skill_submissions WHERE tenant = ? AND state = 'pending'", [tenantId])).n);
  }

  // ---------------------------------------------------------- visibility
  // Everybody, unless departments are named: then those, and the departments under them.
  visibility(tenantId, skillId) { return this.held.visibility.get(tenantId)?.get(skillId) ?? { departments: [], updated: null }; }
  async setVisibility(tenantId, skillId, { departments = [] }, by) {
    if (!Array.isArray(departments)) throw new Error("可见范围要是部门的列表");
    const ids = [...new Set(departments.map(String))];
    if (ids.length > SKILL_LIMITS.departments) throw new Error(`最多指定 ${SKILL_LIMITS.departments} 个部门`);
    if (ids.some((id) => !DEPARTMENT.test(id))) throw new Error("部门无效");
    const before = this.visibility(tenantId, skillId), editor = who(by);
    if (!ids.length) await this.db.run("DELETE FROM idou_admin_skill_visibility WHERE tenant = ? AND skill_id = ?", [tenantId, skillId]);
    else await this.db.run(`INSERT INTO idou_admin_skill_visibility (tenant, skill_id, departments, updated_by, updated_by_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant, skill_id) DO UPDATE SET departments = excluded.departments, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at`,
    [tenantId, skillId, JSON.stringify(ids), editor.userId, editor.name, this.now()]);
    await this.#changed();
    return { before, after: this.visibility(tenantId, skillId) };
  }
  // The skills this person may see. `departmentsOf(who)`: every department
  // they are in, with those above (org-directory.js); somebody the address
  // book has never placed is in none, and sees what is for everybody.
  async visibleTo(identity, skills, departmentsOf) {
    const restricted = skills.filter((skill) => this.visibility(identity.tenantId, skill.id).departments.length);
    if (!restricted.length) return skills;
    const mine = new Set(departmentsOf ? await departmentsOf({ tenantId: identity.tenantId, userId: identity.userId }).catch(() => []) : []);
    return skills.filter((skill) => {
      const { departments } = this.visibility(identity.tenantId, skill.id);
      return !departments.length || departments.some((id) => mine.has(id));
    });
  }

  // --------------------------------------------------------------- usage
  #person(tenantId, userId) { return createHmac("sha256", this.key).update(`idou skill usage\n${tenantId}\n${userId}`).digest("base64url").slice(0, 32); }
  async recordUse(tenantId, { skillId, version = "", userId }) {
    if (!OPEN_ID.test(String(userId)) || !/^enterprise-[a-z0-9-]{1,96}$/.test(String(skillId))) return false;
    await this.db.run(`INSERT INTO idou_admin_skill_usage (tenant, skill_id, day, person, uses, version) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT (tenant, skill_id, day, person) DO UPDATE SET uses = CASE WHEN idou_admin_skill_usage.uses < ? THEN idou_admin_skill_usage.uses + 1 ELSE idou_admin_skill_usage.uses END, version = excluded.version`,
    [tenantId, skillId, day(this.now()), this.#person(tenantId, userId), text(version, 32), SKILL_LIMITS.usesPerPersonDay]);
    return true;
  }
  // Per skill over the last `days`: how many people, how many uses, and each day's uses.
  async usage(tenantId, skillIds, days = 30) {
    const out = new Map(skillIds.map((id) => [id, { people: 0, uses: 0, daily: [] }]));
    if (!skillIds.length) return out;
    const since = day(this.now() - (days - 1) * 86_400_000);
    const ids = [...new Set(skillIds)].slice(0, 200);
    const totals = await this.db.all(`SELECT skill_id, count(DISTINCT person) AS people, sum(uses) AS uses FROM idou_admin_skill_usage
      WHERE tenant = ? AND day >= ? AND skill_id IN (${ids.map(() => "?").join(",")}) GROUP BY skill_id`, [tenantId, since, ...ids]);
    for (const row of totals) Object.assign(out.get(row.skill_id), { people: Number(row.people), uses: Number(row.uses) });
    const daily = await this.db.all(`SELECT skill_id, day, sum(uses) AS uses FROM idou_admin_skill_usage
      WHERE tenant = ? AND day >= ? AND skill_id IN (${ids.map(() => "?").join(",")}) GROUP BY skill_id, day ORDER BY day`, [tenantId, since, ...ids]);
    for (const row of daily) out.get(row.skill_id).daily.push({ day: row.day, uses: Number(row.uses) });
    return out;
  }
  async pruneUsage() {
    const { changes } = await this.db.run("DELETE FROM idou_admin_skill_usage WHERE day < ?", [day(this.now() - SKILL_LIMITS.usageDays * 86_400_000)]);
    return changes;
  }

  close() { clearInterval(this.timer); if (this.onChange) this.db.off("change", this.onChange); }
}

function submission(row) {
  let tools = [];
  try { tools = JSON.parse(row.required_tools) ?? []; } catch { tools = []; }
  return { id: row.id, skillId: row.skill_id, version: row.version, digest: row.digest, title: row.title, requiredTools: tools,
    submittedBy: { userId: row.submitted_by, name: row.submitted_by_name }, at: Number(row.submitted_at), state: row.state,
    decision: row.decided_at ? { by: { userId: row.decided_by, name: row.decided_by_name }, at: Number(row.decided_at), reason: row.reason } : null };
}

// What a version changed, file by file: for an administrator to read before it goes up.
export function compareSkills(before, after) {
  const old = new Map((before?.files ?? []).map((file) => [file.path, file.text]));
  const now = new Map((after?.files ?? []).map((file) => [file.path, file.text]));
  const files = [];
  for (const [path, body] of now) {
    if (!old.has(path)) files.push({ path, change: "added", lines: body.split("\n").length });
    else if (old.get(path) !== body) files.push({ path, change: "changed", ...lineChanges(old.get(path), body) });
  }
  for (const path of old.keys()) if (!now.has(path)) files.push({ path, change: "removed", lines: old.get(path).split("\n").length });
  const fields = ["title", "description", "publisher", "version"].filter((field) => (before?.[field] ?? "") !== (after?.[field] ?? ""));
  const tools = { added: (after?.requiredTools ?? []).filter((tool) => !(before?.requiredTools ?? []).includes(tool)),
    removed: (before?.requiredTools ?? []).filter((tool) => !(after?.requiredTools ?? []).includes(tool)) };
  return { files, fields, tools };
}
// Lines added and removed, by a longest-common-subsequence walk over lines;
// skills are small (128 KiB in all), and past 2,000 lines a side only the counts are given.
function lineChanges(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  if (x.length > 2000 || y.length > 2000) return { added: y.length, removed: x.length, hunks: [], tooLong: true };
  const n = x.length, m = y.length, table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) table[i][j] = x[i] === y[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { i += 1; j += 1; continue; }
    if (j < m && (i === n || table[i][j + 1] >= table[i + 1][j])) { hunks.push({ kind: "+", line: y[j] }); added += 1; j += 1; }
    else { hunks.push({ kind: "-", line: x[i] }); removed += 1; i += 1; }
  }
  return { added, removed, hunks: hunks.slice(0, 400), ...(hunks.length > 400 ? { cut: hunks.length - 400 } : {}) };
}

// What a declared tool lets a task using the skill do, in words an
// administrator reviewing it can weigh (task-skill.js decides what is executable).
export function toolMeaning(tool) {
  const label = String(tool);
  if (label === "cli:local-files") return { tool: label, level: "files", meaning: "读写任务目录里的本机文件（任务原有的沙箱和确认照常生效）" };
  const mcp = /^mcp:([a-z0-9][a-z0-9_-]{0,63}):(.{1,100})$/.exec(label);
  if (mcp) return { tool: label, level: "connector", meaning: `调用连接器「${mcp[1]}」的工具「${mcp[2]}」：使用的人要先配好这个连接器，每次调用仍要本人确认` };
  return { tool: label, level: "declared", meaning: "只是声明：现在的任务用不了这类工具，带着它的技能只能预览（目前能用的是本机文件和单个连接器的工具）" };
}
