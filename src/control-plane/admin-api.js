// The administration console's routes (docs/admin-console.md). admin-server.js
// has already decided who is asking, that they administer this deployment, and
// -- for anything that changes something -- that the request came from the
// console's own page. Each route here names the permission it needs, works
// within the administrator's own tenant, and writes what it changed to the
// audit log before it answers.
//
// What it never returns: anything anybody said. People are names and ids,
// usage is counts, the audit trail is who did what to which object.
import { can, ROLE_NAMES, ROLES } from "./admin-roles.js";
import { AUDIT_CATEGORIES, AUDIT_LIMITS, AUDIT_OUTCOMES } from "./audit-log.js";
import { ACCESS_LIMITS } from "./access-list.js";
import { PEOPLE_SORTS } from "./people-directory.js";
import { FEATURES, CLIENT_ENFORCED } from "./policy.js";
import { CONTACT_SCOPES } from "./org-sync.js";
import { SCAN_CATEGORIES } from "./content-scan.js";
import { ACTION_NAMES, TRIGGERS, OUTCOMES } from "./site-safety.js";
import { compareSkills, toolMeaning } from "./skill-governance.js";

// 300 万, 1.5 亿: how people here say large numbers.
const tokenWords = (value) => value >= 1e8 ? `${+(value / 1e8).toFixed(2)} 亿` : value >= 1e4 ? `${+(value / 1e4).toFixed(1)} 万` : String(value);

// A rule's settings in one short line, for an audit line's before and after.
export function policySummary(settings) {
  if (!settings) return "";
  const parts = [];
  if (settings.models?.allowed) parts.push(`模型 ${settings.models.allowed.join("、")}`);
  if (settings.models?.default) parts.push(`默认 ${settings.models.default}`);
  if (settings.quota?.dailyTokens) parts.push(`每天 ${tokenWords(settings.quota.dailyTokens)} token${settings.quota.downgradeTo ? `，超额换 ${settings.quota.downgradeTo}` : "，超额拒绝"}`);
  if (settings.quota?.concurrency) parts.push(`同时 ${settings.quota.concurrency} 个`);
  const off = Object.entries(settings.features ?? {}).filter(([, on]) => !on).map(([key]) => FEATURES[key] ?? key);
  const on = Object.entries(settings.features ?? {}).filter(([, on]) => on).map(([key]) => FEATURES[key] ?? key);
  if (off.length) parts.push(`关闭 ${off.join("、")}`);
  if (on.length) parts.push(`开启 ${on.join("、")}`);
  return parts.join("；").slice(0, 200);
}

const DAY = 86_400_000;
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
// Cleaning up after people who have left, many at once: each one touches
// every store that holds their data, so a batch is kept to what one request
// finishes in seconds.
export const OFFBOARD_BULK = 50;
const OFFBOARD_REASON = "离职清理";
// What a route gives an administrator whose role is limited to some
// departments (admin-roles.js): "any" -- nothing about people in it; "scoped"
// -- it narrows what it shows, and refuses what it is asked to do, to the
// people there; "tenant" -- the whole tenant or nothing, so refused.
export const ROUTE_KINDS = Object.freeze(["any", "scoped", "tenant"]);
const WHOLE = Object.freeze({ all: true, ids: null, paths: null, departments: [] });
const offboardDetail = (done) => ({ tasks: done.tasks?.schedules ?? 0, runs: done.tasks?.runs ?? 0, credential: done.credential === true, model: done.model === true,
  reservations: done.reservations ?? 0, sitesOffline: done.sitesOffline?.length ?? 0, sessions: done.sessions ?? 0 });

class Refusal extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (message) => new Refusal(400, "bad_request", message);

// CSV that Excel opens as UTF-8: a BOM, quoted fields, and no formula -- a
// cell that begins with = + - @ is a formula to a spreadsheet, and a name is
// text somebody else chose.
export function csvRow(values) {
  return `${values.map((value) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
  }).join(",")}\r\n`;
}

const isoMinute = (at) => new Date(at).toISOString().replace("T", " ").slice(0, 19);

// `offboard(who)`: let go of a person's data here, through the live stores
// (bin/server.js) -- the same rules as bin/forget-person.js, without stopping
// the coordinator, because it goes through the services that hold the data in
// memory rather than around them.
// `policy`: { store, engine, models, ceilings } (policy.js) -- the rules the
// console edits and the engine that says what anybody actually gets.
// `org`: the organisation's structure (org-directory.js) and `orgSync` what
// reads it from Feishu (org-sync.js); both absent without a Feishu application.
// `forgetSite(id)`: the site server closes what it holds open for a site
// taken down (site-server.js).
// `tasks`: { store, unattended } -- the scheduled tasks' store and the
// unattended consent (scheduled-tasks.js), when scheduled tasks are on.
// `skills`: the enterprise skills' shelf (skill-registry.js), when it is
// writable. `safety`: content safety for published sites (site-safety.js).
export function createAdminApi({ people, access, roles, audit, usage = null, sessions, sites = null, forgetSite = () => {}, system, personData = null, offboard = null,
  policy = null, org = null, orgSync = null, tasks = null, skills = null, skillGovernance = null, safety = null, rescans = null, appId = null,
  // 服务状态 beyond this process (process-status.js): `read()` every process,
  // traffic, self-check history and alerts; `alerts` how alerts are set up;
  // `testAlert(admin)` one message to the administrator asking.
  status = null, now = Date.now, log = () => {} }) {
  if (!people || !access || !roles || !audit || !sessions || typeof system !== "function") throw new Error("管理接口缺少依赖");
  // 全部重新检查 runs through the server's own re-reads (scheduleRescans), so
  // that what it leaves unread is read again and stopping the server stops it.
  // Left out, the button would still work and quietly do neither.
  if (safety && sites && !rescans) throw new Error("管理接口缺少依赖：开启文档网站内容安全时要传入补查计划（scheduleRescans）");

  // Recorded before the request is answered: an administrator's action that
  // cannot be written down does not happen silently.
  const record = (admin, action, target, detail = {}, outcome = "ok") => audit.write({
    category: "admin", action, outcome, tenant: admin.tenantId, source: "admin-console", address: admin.address,
    actor: { kind: "admin", id: admin.userId, name: admin.name }, target, detail: { role: admin.role, ...detail } });

  const who = (admin, userId) => {
    if (!OPEN_ID.test(String(userId ?? ""))) throw bad("人员标识无效");
    return { tenantId: admin.tenantId, userId: String(userId) };
  };
  const nameOf = async (admin, userId) => (await people.get(admin.tenantId, userId))?.name ?? "";
  // Enterprise skills: the one on this tenant's shelf, a submission of this
  // tenant's, putting a decided version on the shelf, who else could approve.
  const skillOn = (admin, id) => {
    if (!skills) throw new Refusal(404, "no_skills", "这个部署没有可管理的企业技能。");
    const skill = skills.list(admin.tenantId).find((item) => item.id === id);
    if (!skill) throw new Refusal(404, "no_skill", "没有这个技能。");
    return skill;
  };
  const submissionOf = async (admin, id) => {
    if (!skills || !skillGovernance) throw new Refusal(404, "no_skills", "这个部署没有可管理的企业技能。");
    const found = await skillGovernance.submission(admin.tenantId, id);
    if (!found) throw new Refusal(404, "no_submission", "没有这个提交。");
    return found;
  };
  const placeSkill = async (admin, bundle) => {
    try { await skills.place(admin.tenantId, bundle); }
    catch (error) {
      if (error?.status === 409 && error.message === "skill_already_published") throw new Refusal(409, "already_live", "线上已经是这个版本。");
      if (error?.status === 409 && error.message === "skill_shelf_full") throw new Refusal(409, "shelf_full", "企业技能已经满 100 个，先下架不用的。");
      throw error;
    }
  };
  // Every whole-organisation administrator but this one -- configured, in the
  // administrator group, granted here -- who is not disabled.
  // `unreadable`: the administrator group could not be read, so whether there
  // is somebody else is not known -- and not guessed to be nobody.
  const otherApprovers = async (admin) => {
    const listed = new Set(roles.configured);
    const directory = await roles.directory?.status?.().catch(() => null);
    for (const userId of (await roles.directory?.recipients?.().catch(() => [])) ?? []) listed.add(userId);
    for (const entry of roles.list(admin.tenantId)) if (["owner", "admin"].includes(entry.role) && !entry.scope?.length) listed.add(entry.userId);
    listed.delete(admin.userId);
    const ids = [...listed].filter((userId) => !access.isDisabled?.(admin.tenantId, userId));
    return { ids, unreadable: Boolean(directory?.unreadable), others: ids.length > 0 || Boolean(directory?.unreadable) };
  };
  // One change to a skill's shelf at a time, in this process (the console's
  // routes run on the coordinator only): two approvals, or an approval and a
  // rollback, never interleave their placing and their record.
  const skillTurns = new Map(), testAlerts = new Map();
  const oneAtATime = (admin, id, work) => {
    const key = `${admin.tenantId}\n${id}`;
    const turn = (skillTurns.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    const settled = turn.catch(() => {}).finally(() => { if (skillTurns.get(key) === settled) skillTurns.delete(key); });
    skillTurns.set(key, settled);
    return turn;
  };
  // The departments asked for: known to the address book, or already named
  // for this skill (one Feishu has since dropped stays until it is taken off).
  const departmentsFor = async (admin, id, value) => {
    if (!Array.isArray(value)) throw bad("可见范围要是部门的列表");
    const departments = [...new Set(value.map(String))];
    const kept = new Set(skillGovernance ? skillGovernance.visibility(admin.tenantId, id).departments : []);
    const fresh = departments.filter((departmentId) => !kept.has(departmentId));
    if (org && fresh.length && (await org.departments(admin.tenantId, fresh)).length !== fresh.length) throw bad("有的部门不在组织架构里，先同步组织架构再选。");
    return departments;
  };
  const departmentWords = async (admin, ids) => ids.length ? (org ? (await org.departments(admin.tenantId, ids)).map((department) => department.name).join("、") || ids.join("、") : ids.join("、")) : "全员";
  // A kept version's history must not be lost to a failure after the shelf changed.
  const keepVersion = (work) => work.catch((error) => log({ component: "admin-console", event: "skill-version-not-recorded", message: String(error?.message ?? error).slice(0, 200) }));
  // The departments an administrator is limited to, as they stand now: one
  // Feishu no longer has covers nobody, and without the organisation a
  // limited administrator covers nobody at all.
  const scopeOf = async (admin) => {
    if (!admin.scope) return WHOLE;
    const departments = org ? await org.departments(admin.tenantId, admin.scope) : [];
    return { all: false, ids: admin.scope, paths: departments.map((d) => d.path), departments };
  };
  // Of these people, those this administrator may see and act on.
  const inScope = async ({ admin, scope }, userIds) => {
    if (scope.all) return new Set(userIds);
    return org && scope.paths.length ? org.within(admin.tenantId, userIds, scope.paths) : new Set();
  };
  const requireInScope = async (ctx, userId) => {
    if (!(await inScope(ctx, [userId])).has(userId)) throw new Refusal(403, "out_of_scope", "这个人不在你管理的部门里。");
  };
  const departmentInScope = ({ scope }, department) => scope.all || Boolean(department && scope.paths.some((path) => department.path.startsWith(path)));
  // A rule this administrator may change: about somebody, or a department, in their scope.
  const ruleInScope = async (ctx, target) => {
    if (ctx.scope.all) return true;
    if (target?.kind === "user") return (await inScope(ctx, [String(target.id)])).has(String(target.id));
    if (target?.kind === "department" && org) return departmentInScope(ctx, (await org.departments(ctx.admin.tenantId, [String(target.id)]))[0]);
    return false;
  };
  // An existing rule, before it is changed or removed. One that is not there
  // is left to the store to say so.
  const requireRuleInScope = async (ctx, id) => {
    const rule = policy?.store.get(id);
    if (rule && rule.tenantId === ctx.admin.tenantId && !(await ruleInScope(ctx, rule.target))) throw new Refusal(403, "out_of_scope", "这条规则不在你管理的范围里。");
  };
  // A site of this tenant, or a 404 that says nothing of other tenants'.
  const siteIn = (admin, siteId) => {
    const site = sites?.get(siteId);
    if (!site || site.tenantId !== admin.tenantId) throw new Refusal(404, "no_site", "没有这个网站。");
    return site;
  };
  // A check as the console shows it: where, what kind, a masked sample -- the
  // fingerprints stay in the database.
  const shownCheck = (check) => check && { ...check, findings: check.findings.map(({ fingerprint, ...rest }) => rest) };
  // The tenant's sites a limited administrator may see.
  const sitesIn = async ({ admin, scope }) => {
    let mine = sites ? sites.list().filter((site) => site.tenantId === admin.tenantId) : [];
    if (!scope.all) { const owners = await inScope({ admin, scope }, mine.map((site) => String(site.ownerId))); mine = mine.filter((site) => owners.has(String(site.ownerId))); }
    return mine;
  };
  // A check of a site this administrator may act on.
  const checkIn = async ({ admin, scope }, checkId) => {
    const check = await safety.check(admin.tenantId, checkId);
    if (!check) throw new Refusal(404, "no_check", "没有这次检查。");
    const site = sites.get(check.siteId);
    if (site && site.tenantId === admin.tenantId) await requireInScope({ admin, scope }, String(site.ownerId));
    else if (!scope.all) throw new Refusal(404, "no_site", "这个网站已经不在了。");
    return { check, site: site && site.tenantId === admin.tenantId ? site : null };
  };
  // What a limited administrator's listings are narrowed to.
  const pathsOf = ({ scope }) => (scope.all ? null : scope.paths);
  // A batch to clean up after: never oneself, never an owner from the
  // configuration, never somebody outside the administrator's scope.
  const offboardBatch = async ({ admin, scope }, ids) => {
    const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    if (!unique.length || unique.length > OFFBOARD_BULK) throw bad(`一次清理 1 到 ${OFFBOARD_BULK} 人`);
    const everyone = unique.map((userId) => who(admin, userId));
    const allowed = await inScope({ admin, scope }, everyone.map((person) => person.userId));
    const list = everyone.filter((person) => allowed.has(person.userId));
    const skipped = list.filter((person) => person.userId === admin.userId || roles.configured.includes(person.userId)).map((person) => person.userId);
    return { targets: list.filter((person) => !skipped.includes(person.userId)), skipped, outOfScope: everyone.filter((person) => !allowed.has(person.userId)).map((person) => person.userId) };
  };
  // Off the organisation's waiting list. Done is done: a failure here is logged, not the request's.
  const cleaned = async (admin, userIds) => {
    if (!org || !userIds.length) return;
    try { await org.markCleaned(admin.tenantId, userIds); }
    catch (error) { log({ component: "admin-api", event: "org-mark-cleaned-failed", message: String(error?.message ?? error).slice(0, 200) }); }
  };
  const accessOf = (tenantId, userId) => {
    const entry = access.get(tenantId, userId);
    return { disabled: entry?.disabled === true, signedOutAt: entry?.signedOutAt || null, reason: entry?.disabled ? entry.reason : "",
      changedBy: entry ? entry.by : null, changedAt: entry?.at ?? null };
  };
  const range = (query, { maxDays = null } = {}) => {
    const to = query.get("to") ? Number(query.get("to")) : now() + 60_000;
    const from = query.get("from") ? Number(query.get("from")) : to - 7 * DAY;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) throw bad("时间范围无效");
    if (maxDays && to - from > maxDays * DAY) throw bad(`一次最多 ${maxDays} 天`);
    return { from, to };
  };

  // A person's own rule, with one feature set or cleared: what "stop their
  // scheduled tasks" is -- the policy the scheduler already asks before every
  // run -- rather than a second switch of its own.
  const setPersonFeature = async (admin, userId, feature, value) => {
    const existing = policy.store.rules(admin.tenantId).find((rule) => rule.source !== "file" && rule.target.kind === "user" && rule.target.id === userId) ?? null;
    const features = { ...(existing?.settings.features ?? {}) };
    if (value === null) delete features[feature]; else features[feature] = value;
    const settings = { ...(existing?.settings ?? {}), features };
    if (!Object.keys(features).length) delete settings.features;
    const name = await nameOf(admin, userId);
    if (!existing) {
      if (value === null) return { changed: false };
      const rule = await policy.store.create({ tenantId: admin.tenantId, target: { kind: "user", id: userId }, settings, note: "", by: admin });
      await record(admin, "admin.policy.create", ruleTarget(rule, name), { after: policySummary(rule.settings) });
      return { changed: true };
    }
    if (JSON.stringify(existing.settings.features ?? {}) === JSON.stringify(features)) return { changed: false };
    if (!Object.keys(settings).length) {
      const removed = await policy.store.remove(existing.id, { tenantId: admin.tenantId });
      await record(admin, "admin.policy.delete", ruleTarget(removed, name), { before: policySummary(removed.settings) });
      return { changed: true };
    }
    const changed = await policy.store.update(existing.id, { tenantId: admin.tenantId, settings, note: existing.note, by: admin });
    await record(admin, "admin.policy.update", ruleTarget(changed.after, name), { before: policySummary(changed.before.settings), after: policySummary(changed.after.settings) });
    return { changed: true };
  };
  // A page of owners within the scope: owners are paged in their own order and
  // those outside are passed over, up to a bounded number of pages a request.
  const taskOwners = async ({ admin, scope }, after, size) => {
    let cursor = after, shown = [];
    for (let pages = 0; pages < 20; pages += 1) {
      const page = await tasks.store.ownersOf(admin.tenantId, { after: cursor, limit: scope.all ? size : 200, since: now() - DAY });
      const allowed = await inScope({ admin, scope }, page.owners.map((row) => row.userId));
      for (const row of page.owners) {
        if (shown.length === size) return { owners: shown, next: cursor };
        if (allowed.has(row.userId)) shown.push(row);
        cursor = row.userId;
      }
      if (!page.next) return { owners: shown, next: null };
      if (shown.length === size) return { owners: shown, next: cursor };
    }
    return { owners: shown, next: cursor };
  };

  const routes = [
    // Who is asking, and what the page may offer them.
    ["GET", /^\/admin\/api\/me$/, "view", "any", async ({ admin, scope }) => {
      const sys = await system();
      const trails = !scope.all && org ? new Map((await org.named(admin.tenantId, scope.departments.map((d) => d.id))).map((d) => [d.id, d.path])) : new Map();
      return { user: { userId: admin.userId, tenantId: admin.tenantId, name: admin.name || await nameOf(admin, admin.userId) },
        role: admin.role, roleName: ROLE_NAMES[admin.role], source: admin.source,
        // null: the whole tenant. Otherwise the departments, as they stand now.
        scope: scope.all ? null : scope.departments.map((d) => ({ id: d.id, name: d.name, path: d.path, trail: trails.get(d.id) ?? [d.name] })),
        permissions: ["view", "people.manage", "offboard", "roles.manage", "policy.manage", "content.manage", "audit.export"].filter((name) => can(admin.role, name)),
        csrf: admin.csrf, release: sys.release ?? null, features: { usage: Boolean(usage) && scope.all, system: scope.all, sites: Boolean(sites), personData: Boolean(personData),
          offboard: Boolean(offboard && personData), policy: Boolean(policy), org: Boolean(org), tasks: Boolean(tasks?.store), skills: Boolean(skills) && scope.all, siteSafety: Boolean(safety && sites) } };
    }],

    ["GET", /^\/admin\/api\/overview$/, "view", "scoped", async ({ admin, scope }) => {
      const at = now();
      if (!scope.all) {
        const [stats, disabledPage, recent] = await Promise.all([
          people.stats(admin.tenantId, at, { departmentPaths: scope.paths }),
          people.list({ tenantId: admin.tenantId, status: "disabled", departmentPaths: scope.paths, limit: 1 }),
          audit.query({ tenantId: admin.tenantId, from: at - 30 * DAY, to: at + 60_000, category: "admin", limit: 8, within: { paths: scope.paths, self: admin.userId } }),
        ]);
        return { scoped: true, people: { ...stats, disabled: disabledPage.total ?? 0 }, usage: null, checks: null, models: null, release: null, recent: recent.rows };
      }
      const [stats, disabled, sys, recent, summary] = await Promise.all([
        people.stats(admin.tenantId, at),
        access.disabledCount(admin.tenantId),
        system(),
        audit.query({ tenantId: admin.tenantId, from: at - 30 * DAY, to: at + 60_000, category: "admin", limit: 8 }),
        usage ? usage.summary({ tenantId: admin.tenantId, days: 14, at }) : null,
      ]);
      return { people: { ...stats, disabled }, usage: summary, checks: sys.checks, models: sys.models, release: sys.release ?? null, recent: recent.rows };
    }],

    ["GET", /^\/admin\/api\/people$/, "view", "scoped", async ({ admin, scope, query }) => {
      const sort = query.get("sort") || "active";
      if (!PEOPLE_SORTS.includes(sort)) throw bad("没有这种排序");
      const status = query.get("status") || "all";
      const active = query.get("active") || "";
      const at = now();
      const windows = { "1d": 1, "7d": 7, "30d": 30 };
      const department = query.get("department") && org ? await org.get(admin.tenantId, query.get("department")) : null;
      if (query.get("department") && !department) throw bad("没有这个部门");
      if (department && !departmentInScope({ scope }, department)) throw new Refusal(403, "out_of_scope", "这个部门不在你管理的范围里。");
      const paths = department ? [department.path] : pathsOf({ scope });
      const filter = { tenantId: admin.tenantId, q: query.get("q") || "", status, sort, cursor: query.get("cursor") || null, limit: Number(query.get("limit")) || 50,
        ...(paths ? { departmentPaths: paths } : {}),
        ...(windows[active] ? { activeSince: at - windows[active] * DAY } : {}), ...(active === "inactive30d" ? { inactiveBefore: at - 30 * DAY } : {}) };
      let page;
      try { page = await people.list(filter); } catch (error) { throw bad(error.message); }
      const tokens = usage ? await usage.forPeople({ tenantId: admin.tenantId, userIds: page.people.map((person) => person.userId), days: 30, at }) : new Map();
      return { ...page, department, scoped: !scope.all, people: page.people.map((person) => ({ ...person, access: accessOf(admin.tenantId, person.userId), usage30d: tokens.get(person.userId) ?? { tokens: 0, requests: 0 } })) };
    }],

    ["GET", /^\/admin\/api\/people\/(ou_[A-Za-z0-9_-]+)$/, "view", "scoped", async ({ admin, scope }, [, userId]) => {
      const person = who(admin, userId), at = now();
      await requireInScope({ admin, scope }, person.userId);
      const [profile, devices, use, inventory, history] = await Promise.all([
        people.get(person.tenantId, person.userId),
        sessions.devices(person.tenantId, person.userId).catch(() => null),
        usage ? usage.person({ ...person, days: 30, at }) : null,
        personData ? personData({ ...person, appId }).catch((error) => ({ error: String(error?.message ?? error).slice(0, 160) })) : null,
        audit.query({ tenantId: person.tenantId, from: at - 90 * DAY, to: at + 60_000, actorId: person.userId, limit: 30 }),
      ]);
      const about = await audit.query({ tenantId: person.tenantId, from: at - 365 * DAY, to: at + 60_000, targetId: person.userId, category: "admin", limit: 20 });
      const organisation = org ? await org.person(person.tenantId, person.userId).catch(() => null) : null;
      const tasksStopped = policy && tasks?.store ? !(await policy.engine.permits(person, "scheduledTasks")) : null;
      const role = await roles.decide(person);
      return { person: profile ?? { tenantId: person.tenantId, userId: person.userId, name: "", firstSeenAt: null, lastSeenAt: null, client: "", signIns: 0 },
        known: Boolean(profile), access: accessOf(person.tenantId, person.userId), adminRole: role.role ? { role: role.role, roleName: ROLE_NAMES[role.role], source: role.source } : null,
        devices, usage: use, inventory, activity: history.rows, adminActions: about.rows, organisation, tasksStopped };
    }],

    // Every device out now; a sign-in afterwards works.
    ["POST", /^\/admin\/api\/people\/(ou_[A-Za-z0-9_-]+)\/sign-out$/, "people.manage", "scoped", async ({ admin, scope }, [, userId]) => {
      const person = who(admin, userId);
      await requireInScope({ admin, scope }, person.userId);
      await access.signOut([person], { by: admin });
      const families = await sessions.revokePerson(person.tenantId, person.userId);
      await record(admin, "admin.person.sign-out", { kind: "person", id: person.userId, name: await nameOf(admin, person.userId) }, { sessions: families });
      return { ok: true, sessions: families, access: accessOf(person.tenantId, person.userId) };
    }],

    ["POST", /^\/admin\/api\/people\/(ou_[A-Za-z0-9_-]+)\/disable$/, "people.manage", "scoped", async ({ admin, scope, body }, [, userId]) => {
      const person = who(admin, userId);
      await requireInScope({ admin, scope }, person.userId);
      if (person.userId === admin.userId) throw new Refusal(409, "self", "不能停用自己。");
      if (roles.configured.includes(person.userId)) throw new Refusal(409, "configured_owner", "这位是配置文件里的超级管理员，不能在后台停用。");
      const reason = String(body?.reason ?? "").trim().slice(0, ACCESS_LIMITS.reasonChars);
      const changed = await access.disable([person], { reason, by: admin });
      const families = await sessions.revokePerson(person.tenantId, person.userId);
      if (changed.length) await record(admin, "admin.person.disable", { kind: "person", id: person.userId, name: await nameOf(admin, person.userId) }, { reason, sessions: families });
      return { ok: true, changed: changed.length > 0, access: accessOf(person.tenantId, person.userId) };
    }],

    ["POST", /^\/admin\/api\/people\/(ou_[A-Za-z0-9_-]+)\/enable$/, "people.manage", "scoped", async ({ admin, scope }, [, userId]) => {
      const person = who(admin, userId);
      await requireInScope({ admin, scope }, person.userId);
      const changed = await access.enable([person], { by: admin });
      if (changed.length) await record(admin, "admin.person.enable", { kind: "person", id: person.userId, name: await nameOf(admin, person.userId) });
      return { ok: true, changed: changed.length > 0, access: accessOf(person.tenantId, person.userId) };
    }],

    // Up to a thousand at once: an offboarding list from HR, a team leaving.
    ["POST", /^\/admin\/api\/people\/bulk$/, "people.manage", "scoped", async ({ admin, scope, body }) => {
      const action = String(body?.action ?? "");
      if (!["disable", "enable", "sign-out"].includes(action)) throw bad("没有这个操作");
      const ids = [...new Set(Array.isArray(body?.userIds) ? body.userIds.map(String) : [])];
      if (!ids.length || ids.length > ACCESS_LIMITS.bulk) throw bad(`一次处理 1 到 ${ACCESS_LIMITS.bulk} 人`);
      const everyone = ids.map((userId) => who(admin, userId));
      const allowed = await inScope({ admin, scope }, everyone.map((person) => person.userId));
      const outOfScope = everyone.filter((person) => !allowed.has(person.userId)).map((person) => person.userId);
      const list = everyone.filter((person) => allowed.has(person.userId));
      const skipped = action === "disable" ? list.filter((person) => person.userId === admin.userId || roles.configured.includes(person.userId)).map((person) => person.userId) : [];
      const targets = list.filter((person) => !skipped.includes(person.userId));
      const reason = String(body?.reason ?? "").trim().slice(0, ACCESS_LIMITS.reasonChars);
      const changed = !targets.length ? [] : action === "disable" ? await access.disable(targets, { reason, by: admin })
        : action === "enable" ? await access.enable(targets, { by: admin }) : await access.signOut(targets, { by: admin });
      if (action !== "enable") for (const person of targets) await sessions.revokePerson(person.tenantId, person.userId);
      const names = await people.names(admin.tenantId, changed.map((entry) => entry.userId));
      for (const entry of changed) {
        await record(admin, `admin.person.${action}`, { kind: "person", id: entry.userId, name: names.get(entry.userId) ?? "" }, { bulk: targets.length, ...(reason && action === "disable" ? { reason } : {}) });
      }
      return { ok: true, requested: ids.length, changed: changed.length, skipped, outOfScope };
    }],

    // What leaving would take away, before anybody confirms it.
    ["GET", /^\/admin\/api\/people\/(ou_[A-Za-z0-9_-]+)\/offboard$/, "offboard", "scoped", async ({ admin, scope }, [, userId]) => {
      if (!offboard || !personData) throw new Refusal(404, "no_offboarding", "这个部署不能在后台做离职清理。");
      const person = who(admin, userId);
      await requireInScope({ admin, scope }, person.userId);
      const [profile, inventory] = await Promise.all([people.get(person.tenantId, person.userId), personData({ ...person, appId })]);
      return { person: profile, access: accessOf(person.tenantId, person.userId), inventory, confirm: profile?.name || person.userId };
    }],

    // Disabled first, every session ended, then the data let go: tasks and
    // their runs, the unattended authorization, the model choice, the Drive
    // ledger's rows; published sites taken offline with their files kept;
    // usage counts and the audit trail kept. Typed confirmation: the name.
    ["POST", /^\/admin\/api\/people\/(ou_[A-Za-z0-9_-]+)\/offboard$/, "offboard", "scoped", async ({ admin, scope, body }, [, userId]) => {
      if (!offboard) throw new Refusal(404, "no_offboarding", "这个部署不能在后台做离职清理。");
      const person = who(admin, userId);
      await requireInScope({ admin, scope }, person.userId);
      if (person.userId === admin.userId) throw new Refusal(409, "self", "不能清理自己。");
      if (roles.configured.includes(person.userId)) throw new Refusal(409, "configured_owner", "这位是配置文件里的超级管理员，不能在后台清理。");
      const profile = await people.get(person.tenantId, person.userId);
      const expected = profile?.name || person.userId;
      if (String(body?.confirm ?? "").trim() !== expected) throw new Refusal(409, "confirm_mismatch", `请输入「${expected}」确认。`);
      await access.disable([person], { reason: OFFBOARD_REASON, by: admin });
      const done = await offboard({ ...person, appId });
      const detail = offboardDetail(done);
      await record(admin, "admin.person.offboard", { kind: "person", id: person.userId, name: expected }, detail);
      await cleaned(admin, [person.userId]);
      return { ok: true, done: detail, sitesOffline: done.sitesOffline ?? [] };
    }],

    // Many people who have left, together: what would go, summed, and then
    // the same as one person, one after another. Confirmed by typing how many.
    ["GET", /^\/admin\/api\/people\/offboard$/, "offboard", "scoped", async ({ admin, scope, query }) => {
      if (!offboard || !personData) throw new Refusal(404, "no_offboarding", "这个部署不能在后台做离职清理。");
      const { targets, skipped, outOfScope } = await offboardBatch({ admin, scope }, String(query.get("ids") ?? "").split(","));
      const names = await people.names(admin.tenantId, targets.map((person) => person.userId));
      const totals = { schedules: 0, runs: 0, credentials: 0, models: 0, sites: 0, reservations: 0 };
      for (const person of targets) {
        const inventory = await personData({ ...person, appId });
        totals.schedules += inventory.tasks?.schedules ?? 0;
        totals.runs += inventory.tasks?.runs ?? 0;
        totals.credentials += inventory.credential ? 1 : 0;
        totals.models += inventory.model ? 1 : 0;
        totals.sites += (inventory.sites ?? []).filter((site) => site.withdrawn ?? !site.offline).length;
        totals.reservations += Array.isArray(inventory.reservations) ? inventory.reservations.length : Number(inventory.reservations ?? 0);
      }
      return { people: targets.map((person) => ({ userId: person.userId, name: names.get(person.userId) ?? "" })), skipped, outOfScope, totals, confirm: String(targets.length) };
    }],
    ["POST", /^\/admin\/api\/people\/offboard$/, "offboard", "scoped", async ({ admin, scope, body }) => {
      if (!offboard) throw new Refusal(404, "no_offboarding", "这个部署不能在后台做离职清理。");
      const { targets, skipped, outOfScope } = await offboardBatch({ admin, scope }, Array.isArray(body?.userIds) ? body.userIds : []);
      if (String(body?.confirm ?? "").trim() !== String(targets.length)) throw new Refusal(409, "confirm_mismatch", `请输入人数「${targets.length}」确认。`);
      if (!targets.length) return { ok: true, done: 0, failed: [], skipped, outOfScope };
      await access.disable(targets, { reason: OFFBOARD_REASON, by: admin });
      const names = await people.names(admin.tenantId, targets.map((person) => person.userId));
      const finished = [], failed = [];
      for (const person of targets) {
        const target = { kind: "person", id: person.userId, name: names.get(person.userId) ?? "" };
        try {
          const detail = offboardDetail(await offboard({ ...person, appId }));
          await record(admin, "admin.person.offboard", target, { ...detail, bulk: targets.length });
          finished.push(person.userId);
        } catch (error) {
          // The rest still go; this one stays disabled and on the list, to try again.
          failed.push({ userId: person.userId, name: target.name, message: String(error?.message ?? error).slice(0, 200) });
          await record(admin, "admin.person.offboard", target, { bulk: targets.length, error: String(error?.message ?? error).slice(0, 120) }, "failed");
        }
      }
      await cleaned(admin, finished);
      return { ok: failed.length === 0, done: finished.length, failed, skipped, outOfScope };
    }],

    // The rules, as written: the console's for this tenant, and the file's.
    ["GET", /^\/admin\/api\/policies$/, "view", "scoped", async ({ admin, scope }) => {
      if (!policy) throw new Refusal(404, "no_policy", "这个部署没有策略。");
      let rules = policy.store.rules(admin.tenantId), editable = () => true;
      if (!scope.all) {
        // What reaches their people: everyone's, groups', their departments' and
        // those above them, their people's. What they may change: the last two
        // but the departments above.
        const users = await inScope({ admin, scope }, rules.filter((rule) => rule.target.kind === "user").map((rule) => rule.target.id));
        const held = org ? new Map((await org.departments(admin.tenantId, rules.filter((rule) => rule.target.kind === "department").map((rule) => rule.target.id))).map((d) => [d.id, d])) : new Map();
        const inside = (rule) => departmentInScope({ scope }, held.get(rule.target.id));
        const above = (rule) => Boolean(held.get(rule.target.id)) && scope.paths.some((path) => path.startsWith(held.get(rule.target.id).path));
        rules = rules.filter((rule) => ["everyone", "chat"].includes(rule.target.kind) || (rule.target.kind === "user" && users.has(rule.target.id))
          || (rule.target.kind === "department" && (inside(rule) || above(rule))));
        editable = (rule) => (rule.target.kind === "user" && users.has(rule.target.id)) || (rule.target.kind === "department" && inside(rule));
      }
      const names = await people.names(admin.tenantId, rules.filter((rule) => rule.target.kind === "user").map((rule) => rule.target.id));
      const departments = org ? new Map((await org.named(admin.tenantId, rules.filter((rule) => rule.target.kind === "department").map((rule) => rule.target.id))).map((d) => [d.id, d.path.join(" / ")])) : new Map();
      return { rules: rules.map((rule) => ({ ...rule, editable: rule.source !== "file" && editable(rule),
        targetName: rule.target.kind === "user" ? names.get(rule.target.id) ?? "" : rule.target.kind === "department" ? departments.get(rule.target.id) ?? "" : "", summary: policySummary(rule.settings) })),
        departments: Boolean(org), scoped: !scope.all,
        features: Object.entries(FEATURES).map(([key, name]) => ({ key, name, offered: policy.ceilings[key] !== false, clientEnforced: CLIENT_ENFORCED.includes(key) })),
        models: policy.models, defaultVisible: policy.engine.defaultVisible };
    }],

    ["POST", /^\/admin\/api\/policies$/, "policy.manage", "scoped", async ({ admin, scope, body }) => {
      if (!policy) throw new Refusal(404, "no_policy", "这个部署没有策略。");
      if (!(await ruleInScope({ admin, scope }, body?.target))) throw new Refusal(403, "out_of_scope", "你只能为你管理的部门和其中的人设规则。");
      let rule;
      try { rule = await policy.store.create({ tenantId: admin.tenantId, target: body?.target, settings: body?.settings, note: body?.note, by: admin }); }
      catch (error) { throw bad(error.message); }
      await record(admin, "admin.policy.create", ruleTarget(rule, await targetName(admin, rule)), { after: policySummary(rule.settings) });
      return { ok: true, rule };
    }],

    ["PUT", /^\/admin\/api\/policies\/([0-9a-f-]{36})$/, "policy.manage", "scoped", async ({ admin, scope, body }, [, id]) => {
      if (!policy) throw new Refusal(404, "no_policy", "这个部署没有策略。");
      await requireRuleInScope({ admin, scope }, id);
      let changed;
      try { changed = await policy.store.update(id, { tenantId: admin.tenantId, settings: body?.settings, note: body?.note, by: admin }); }
      catch (error) { throw bad(error.message); }
      await record(admin, "admin.policy.update", ruleTarget(changed.after, await targetName(admin, changed.after)),
        { before: policySummary(changed.before.settings), after: policySummary(changed.after.settings) });
      return { ok: true, rule: changed.after };
    }],

    ["DELETE", /^\/admin\/api\/policies\/([0-9a-f-]{36})$/, "policy.manage", "scoped", async ({ admin, scope }, [, id]) => {
      if (!policy) throw new Refusal(404, "no_policy", "这个部署没有策略。");
      await requireRuleInScope({ admin, scope }, id);
      let removed;
      try { removed = await policy.store.remove(id, { tenantId: admin.tenantId }); } catch (error) { throw bad(error.message); }
      await record(admin, "admin.policy.delete", ruleTarget(removed, await targetName(admin, removed)), { before: policySummary(removed.settings) });
      return { ok: true };
    }],

    // What one person actually gets, and which rule decided each part of it.
    ["GET", /^\/admin\/api\/policies\/effective$/, "view", "scoped", async ({ admin, scope, query }) => {
      if (!policy) throw new Refusal(404, "no_policy", "这个部署没有策略。");
      const person = who(admin, query.get("user"));
      await requireInScope({ admin, scope }, person.userId);
      return { person: await people.get(person.tenantId, person.userId), effective: await policy.engine.effective(person) };
    }],

    // The organisation: how the last reading of Feishu's address book went,
    // what to ask for if it could not, the top of the tree.
    ["GET", /^\/admin\/api\/org$/, "view", "scoped", async ({ admin, scope }) => {
      if (!org) return { available: false, scopes: CONTACT_SCOPES.map(([name, label]) => ({ scope: name, name: label })) };
      const paths = pathsOf({ scope });
      const [status, top, pending, cleanedUp, pendingHere] = await Promise.all([org.status(admin.tenantId), org.children(admin.tenantId, ""),
        org.departed({ tenantId: admin.tenantId, state: "pending", limit: OFFBOARD_BULK * 2, paths }), org.departed({ tenantId: admin.tenantId, state: "cleaned", limit: 10, paths }),
        paths ? org.pendingCount(admin.tenantId, paths) : null]);
      const names = await people.names(admin.tenantId, [...pending, ...cleanedUp].map((row) => row.userId));
      const described = (row) => ({ ...row, name: names.get(row.userId) ?? "", access: accessOf(admin.tenantId, row.userId) });
      return { available: true, canSync: Boolean(orgSync) && scope.all, canOffboard: Boolean(offboard && personData), bulk: OFFBOARD_BULK, scoped: !scope.all,
        status: paths ? { ...status, pending: pendingHere } : status, top,
        scopes: CONTACT_SCOPES.map(([name, label]) => ({ scope: name, name: label })), pending: pending.map(described), cleaned: cleanedUp.map(described) };
    }],
    ["GET", /^\/admin\/api\/org\/departments$/, "view", "any", async ({ admin, query }) => {
      if (!org) throw new Refusal(404, "no_org", "这个部署没有组织架构。");
      const parent = String(query.get("parent") ?? "");
      return { parent: parent ? await org.get(admin.tenantId, parent) : null, departments: await org.children(admin.tenantId, parent) };
    }],
    ["GET", /^\/admin\/api\/org\/search$/, "view", "any", async ({ admin, query }) => {
      if (!org) throw new Refusal(404, "no_org", "这个部署没有组织架构。");
      const found = await org.search(admin.tenantId, query.get("q") || "");
      const named = new Map((await org.named(admin.tenantId, found.map((d) => d.id))).map((d) => [d.id, d.path]));
      return { departments: found.map((d) => ({ ...d, trail: named.get(d.id) ?? [d.name] })) };
    }],
    // Read the address book again now. Started, not waited for: a large
    // organisation takes minutes, and the page asks how it went.
    ["POST", /^\/admin\/api\/org\/sync$/, "people.manage", "tenant", async ({ admin }) => {
      if (!orgSync) throw new Refusal(404, "no_org_sync", "这个部署没有配置飞书应用，读不了通讯录。");
      void orgSync.sync(admin.tenantId).catch(() => {});
      await record(admin, "admin.org.sync", { kind: "organisation", id: "", name: "" });
      return { ok: true, started: true };
    }],

    ["GET", /^\/admin\/api\/audit$/, "view", "scoped", async ({ admin, scope, query }) => {
      const { from, to } = range(query, { maxDays: 400 });
      const category = query.get("category") || null, outcome = query.get("outcome") || null;
      if (category && !AUDIT_CATEGORIES.includes(category)) throw bad("没有这个类别");
      if (outcome && !AUDIT_OUTCOMES.includes(outcome)) throw bad("没有这个结果");
      try {
        return await audit.query({ tenantId: admin.tenantId, from, to, category, outcome, actorId: query.get("actor") || null,
          targetId: query.get("target") || null, action: query.get("action") || null, cursor: query.get("cursor") || null, limit: Number(query.get("limit")) || 50,
          within: scope.all ? null : { paths: scope.paths, self: admin.userId } });
      } catch (error) { throw bad(error.message); }
    }],

    // Streamed: a month of a large deployment is millions of rows.
    ["GET", /^\/admin\/api\/audit\/export$/, "audit.export", "scoped", async ({ admin, scope, query, res, send }) => {
      const { from, to } = range(query, { maxDays: AUDIT_LIMITS.exportDays });
      const filter = { tenantId: admin.tenantId, from, to, category: query.get("category") || null, outcome: query.get("outcome") || null,
        actorId: query.get("actor") || null, targetId: query.get("target") || null, action: query.get("action") || null,
        within: scope.all ? null : { paths: scope.paths, self: admin.userId } };
      if (filter.category && !AUDIT_CATEGORIES.includes(filter.category)) throw bad("没有这个类别");
      await record(admin, "admin.audit.export", { kind: "audit", id: "", name: "" }, { from: isoMinute(from), to: isoMinute(to), ...(filter.category ? { category: filter.category } : {}) });
      return stream(res, send, `idou-audit-${new Date(from).toISOString().slice(0, 10)}_${new Date(to).toISOString().slice(0, 10)}.csv`,
        ["时间(UTC)", "类别", "动作", "结果", "操作人", "操作人 open_id", "对象类型", "对象", "对象标识", "来源", "地址", "详情"],
        (async function* () {
          for await (const row of audit.rows(filter)) {
            yield [isoMinute(row.at), row.category, row.action, row.outcome, row.actor.name, row.actor.id, row.target.kind, row.target.name, row.target.id,
              row.source, row.address, JSON.stringify(row.detail)];
          }
        })());
    }],

    ["GET", /^\/admin\/api\/usage$/, "view", "tenant", async ({ admin, query }) => {
      if (!usage) throw new Refusal(404, "no_usage", "这个部署没有开启用量记账。");
      const days = [7, 30, 90].includes(Number(query.get("days"))) ? Number(query.get("days")) : 30;
      const [summary, top] = await Promise.all([usage.summary({ tenantId: admin.tenantId, days }), usage.ranking({ tenantId: admin.tenantId, days, limit: 100 })]);
      const names = await people.names(admin.tenantId, top.map((row) => row.userId));
      return { ...summary, people: top.map((row) => ({ ...row, name: names.get(row.userId) ?? "" })) };
    }],

    ["GET", /^\/admin\/api\/usage\/export$/, "audit.export", "tenant", async ({ admin, query, res, send }) => {
      if (!usage) throw new Refusal(404, "no_usage", "这个部署没有开启用量记账。");
      const days = [7, 30, 90].includes(Number(query.get("days"))) ? Number(query.get("days")) : 30;
      await record(admin, "admin.usage.export", { kind: "usage", id: "", name: "" }, { days });
      return stream(res, send, `idou-usage-${days}d-${new Date(now()).toISOString().slice(0, 10)}.csv`,
        ["姓名", "open_id", "请求数", "输入 token", "输出 token", "总 token", "被降级", "用过几个模型", "最近一次(UTC)"],
        (async function* () {
          const batch = [];
          for await (const row of usage.everyone({ tenantId: admin.tenantId, days })) {
            batch.push(row);
            if (batch.length < 500) continue;
            yield* named(batch.splice(0));
          }
          yield* named(batch);
          async function* named(rows) {
            const names = await people.names(admin.tenantId, rows.map((row) => row.userId));
            for (const row of rows) yield [names.get(row.userId) ?? "", row.userId, row.requests, row.input, row.output, row.tokens, row.downgraded, row.models, row.lastAt ? isoMinute(row.lastAt) : ""];
          }
        })());
    }],

    ["GET", /^\/admin\/api\/admins$/, "view", "any", async ({ admin }) => {
      const granted = roles.list(admin.tenantId);
      const configured = roles.configured;
      const names = await people.names(admin.tenantId, [...configured, ...granted.map((entry) => entry.userId)]);
      const trails = org ? new Map((await org.named(admin.tenantId, granted.flatMap((entry) => entry.scope ?? []))).map((d) => [d.id, d.path.join(" / ")])) : new Map();
      const directory = roles.directory ? await roles.directory.status() : null;
      return {
        configured: configured.map((userId) => ({ userId, name: names.get(userId) ?? "" })),
        chat: directory?.chatId ? { chatId: directory.chatId, members: directory.counts?.chat ?? null, unreadable: directory.unreadable ?? null } : null,
        granted: granted.map((entry) => ({ ...entry, name: names.get(entry.userId) ?? "", roleName: ROLE_NAMES[entry.role],
          scope: entry.scope ? entry.scope.map((id) => ({ id, name: trails.get(id) ?? null })) : null })),
        departments: Boolean(org),
        roles: ROLES.map((role) => ({ role, name: ROLE_NAMES[role] })),
      };
    }],

    ["POST", /^\/admin\/api\/admins$/, "roles.manage", "tenant", async ({ admin, body }) => {
      const person = who(admin, body?.userId);
      if (person.userId === admin.userId) throw new Refusal(409, "self", "不能修改自己的角色。");
      const role = String(body?.role ?? "");
      if (!ROLES.includes(role)) throw bad("没有这个角色");
      // Limited to some departments: each one has to be in the organisation as it stands.
      const scope = [...new Set(Array.isArray(body?.scope) ? body.scope.map(String) : [])];
      if (scope.length && !org) throw bad("这个部署没有组织架构，不能按部门授予");
      const found = scope.length ? await org.departments(admin.tenantId, scope) : [];
      if (found.length !== scope.length) throw bad("有的部门不在通讯录里");
      let changed;
      try { changed = await roles.grant({ ...person, role, by: admin, note: String(body?.note ?? ""), scope }); }
      catch (error) { throw new Refusal(409, "refused", error.message); }
      await record(admin, "admin.role.grant", { kind: "person", id: person.userId, name: await nameOf(admin, person.userId) },
        { from: changed.before ?? "", to: role, ...(scope.length ? { scope: found.map((d) => d.name).join("、").slice(0, 120) } : {}) });
      return { ok: true, ...changed };
    }],

    ["DELETE", /^\/admin\/api\/admins\/(ou_[A-Za-z0-9_-]+)$/, "roles.manage", "tenant", async ({ admin }, [, userId]) => {
      const person = who(admin, userId);
      if (person.userId === admin.userId) throw new Refusal(409, "self", "不能收回自己的角色。");
      const changed = await roles.revoke(person);
      if (changed.before) await record(admin, "admin.role.revoke", { kind: "person", id: person.userId, name: await nameOf(admin, person.userId) }, { from: changed.before });
      return { ok: true, ...changed };
    }],

    ["GET", /^\/admin\/api\/system$/, "view", "tenant", async () => {
      const [state, read] = await Promise.all([system(), status ? status.read().catch((error) => ({ error: String(error?.message ?? error).slice(0, 200) })) : null]);
      return { ...state, status: read, alerts: status?.alerts ?? null };
    }],

    // A message to the administrator asking, and nobody else: whether the bot
    // and its permission work, before a real alert has to.
    ["POST", /^\/admin\/api\/system\/alerts\/test$/, "policy.manage", "tenant", async ({ admin }) => {
      if (!status?.testAlert) throw new Refusal(409, "no_bot", "这个服务端没有配置飞书应用，发不了告警。");
      // Once a minute each: a message each time, a row in the alerts list each time.
      const last = testAlerts.get(admin.userId) ?? 0;
      if (now() - last < 60_000) throw new Refusal(429, "too_soon", "一分钟内只能发一次测试告警。");
      testAlerts.set(admin.userId, now());
      const answer = await status.testAlert(admin);
      await record(admin, "admin.alerts.test", { kind: "system", id: "alerts" }, { sent: Boolean(answer?.sent) }, answer?.sent ? "ok" : "failed");
      if (!answer?.sent) throw new Refusal(502, "alert_not_sent", `没有发出去：${answer?.reason ?? "原因不明"}。最常见的是飞书应用没有开通 im:message:send_as_bot。`);
      return { ok: true };
    }],

    // What this tenant has published: by name, by whom, to whom, and in what
    // state. An administrator's take-down (held) is a state of its own.
    ["GET", /^\/admin\/api\/sites$/, "view", "scoped", async ({ admin, scope, query }) => {
      if (!sites) return { sites: [], enabled: false };
      const q = String(query.get("q") || "").trim().toLowerCase(), owner = String(query.get("owner") || ""), state = String(query.get("state") || ""), audience = String(query.get("audience") || "");
      if (state && !["online", "offline", "held", "anyone", "review"].includes(state)) throw bad("没有这种状态");
      let listed = sites.list().filter((site) => site.tenantId === admin.tenantId && (!q || String(site.name ?? "").toLowerCase().includes(q)) && (!owner || site.ownerId === owner)
        && (!state || (state === "held" ? Boolean(site.held) : state === "review" ? Boolean(site.review) : state === "offline" ? site.offline && !site.held && !site.review
          : state === "anyone" ? !site.offline && site.share?.scope === "anyone" : !site.offline))
        && (!audience || site.share?.scope === audience));
      if (!scope.all) { const owners = await inScope({ admin, scope }, listed.map((site) => String(site.ownerId))); listed = listed.filter((site) => owners.has(String(site.ownerId))); }
      listed.sort((a, b) => Number(Boolean(b.held)) - Number(Boolean(a.held)) || (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
      const shown = listed.slice(0, 500);
      const names = await people.names(admin.tenantId, [...shown.map((site) => site.ownerId), ...shown.map((site) => sites.get(site.id)?.held?.by?.userId).filter(Boolean)]);
      const visited = safety ? await safety.visits(admin.tenantId, shown.map((site) => site.id), 7) : new Map();
      return { enabled: true, total: listed.length, sites: shown.map((site) => {
        const held = sites.get(site.id)?.held ?? null;
        return { id: site.id, name: site.name, ownerId: site.ownerId, owner: names.get(site.ownerId) ?? "",
          scope: site.share?.scope ?? null, inherit: site.share?.inherit === true, offline: site.offline === true, sourced: Boolean(site.source),
          bytes: site.bytes ?? null, createdAt: site.createdAt ?? null, publishedAt: site.publishedAt ?? null,
          held: held ? { at: held.at, reason: held.reason, by: { userId: held.by?.userId ?? "", name: held.by?.name || names.get(held.by?.userId) || "" } } : null,
          review: site.review ?? null, visits7d: visited.get(site.id) ? { visits: visited.get(site.id).visits, anonymous: visited.get(site.id).anonymous, refused: visited.get(site.id).refused } : null };
      }) };
    }],
    // Scheduled tasks: how many, in what state, whose -- never what they say.
    ["GET", /^\/admin\/api\/tasks$/, "view", "scoped", async ({ admin, scope, query }) => {
      if (!tasks?.store) return { available: false };
      const page = await taskOwners({ admin, scope }, String(query.get("cursor") || ""), Math.max(1, Math.min(100, Number(query.get("limit")) || 50)));
      const names = await people.names(admin.tenantId, page.owners.map((row) => row.userId));
      const owners = [];
      for (const row of page.owners) {
        const who = { tenantId: admin.tenantId, userId: row.userId };
        const credential = tasks.unattended?.store ? await tasks.unattended.store.read(who.tenantId, who.userId).catch(() => null) : null;
        owners.push({ ...row, name: names.get(row.userId) ?? "", access: accessOf(who.tenantId, who.userId),
          unattended: credential ? { state: credential.state, expiresAt: credential.expiresAt ?? null } : null,
          stopped: policy ? !(await policy.engine.permits(who, "scheduledTasks")) : false });
      }
      return { available: true, scoped: !scope.all, totals: scope.all ? await tasks.store.tenantTotals(admin.tenantId) : null, owners, next: page.next };
    }],
    // Stopping somebody's scheduled tasks is their policy's "定时任务: 关":
    // every run asks it first, and they cannot create new ones. Allowing them
    // again clears that from their rule.
    ["POST", /^\/admin\/api\/people\/(ou_[A-Za-z0-9_-]+)\/tasks\/(stop|allow)$/, "policy.manage", "scoped", async ({ admin, scope }, [, userId, action]) => {
      if (!policy) throw new Refusal(404, "no_policy", "这个部署没有策略。");
      const person = who(admin, userId);
      await requireInScope({ admin, scope }, person.userId);
      return { ok: true, ...(await setPersonFeature(admin, person.userId, "scheduledTasks", action === "stop" ? false : null)) };
    }],
    // The long-lived Feishu credential a person left with the server for their
    // tasks: gone, and any run of it in flight stopped. What Feishu itself
    // granted stays until it expires or they remove it there.
    ["POST", /^\/admin\/api\/people\/(ou_[A-Za-z0-9_-]+)\/unattended\/revoke$/, "people.manage", "scoped", async ({ admin, scope }, [, userId]) => {
      if (!tasks?.unattended) throw new Refusal(404, "no_unattended", "这个部署没有开启无人值守的定时任务。");
      const person = who(admin, userId);
      await requireInScope({ admin, scope }, person.userId);
      const had = await tasks.unattended.revoke(person);
      if (had) await record(admin, "admin.unattended.revoke", { kind: "person", id: person.userId, name: await nameOf(admin, person.userId) });
      return { ok: true, changed: Boolean(had) };
    }],

    // Content safety for published sites (docs/site-content-safety.md): the
    // rules, what waits for an administrator, and every check made.
    ["GET", /^\/admin\/api\/site-safety$/, "view", "scoped", async ({ admin, scope }) => {
      if (!safety || !sites) return { available: false };
      const mine = await sitesIn({ admin, scope });
      const waiting = mine.filter((site) => site.review?.state === "pending"), rejected = mine.filter((site) => site.review?.state === "rejected");
      const names = await people.names(admin.tenantId, [...waiting, ...rejected].map((site) => site.ownerId));
      const shown = async (site) => ({ site: { id: site.id, name: site.name, ownerId: site.ownerId, owner: names.get(site.ownerId) ?? "", scope: site.share?.scope ?? null, review: site.review },
        check: shownCheck(sites.get(site.id)?.review?.checkId ? await safety.check(admin.tenantId, sites.get(site.id).review.checkId) : null) });
      const recent = await safety.checks({ tenantId: admin.tenantId, siteIds: scope.all ? null : mine.map((site) => site.id), limit: 20 });
      const rules = safety.rules(admin.tenantId);
      return { available: true, editable: scope.all, aiAvailable: Boolean(safety.moderate),
        rules: { actions: rules.actions, keywords: rules.keywords, ai: rules.ai, reviewAllPublic: rules.reviewAllPublic, updated: rules.updated },
        categories: SCAN_CATEGORIES, actionNames: ACTION_NAMES, triggers: TRIGGERS,
        waiting: await Promise.all(waiting.map(shown)), rejected: await Promise.all(rejected.map(shown)),
        recent: recent.checks.map(shownCheck), next: recent.next };
    }],
    ["GET", /^\/admin\/api\/site-safety\/checks$/, "view", "scoped", async ({ admin, scope, query }) => {
      if (!safety) throw new Refusal(404, "no_safety", "这个部署没有开启文档网站。");
      const outcome = query.get("outcome") || null, siteId = query.get("site") || null;
      if (outcome && !OUTCOMES.includes(outcome)) throw bad("没有这种结果");
      try {
        const page = await safety.checks({ tenantId: admin.tenantId, outcome, siteId, siteIds: scope.all ? null : (await sitesIn({ admin, scope })).map((site) => site.id),
          cursor: query.get("cursor") || null, limit: Number(query.get("limit")) || 50 });
        return { checks: page.checks.map(shownCheck), next: page.next };
      } catch (error) { throw bad(error.message); }
    }],
    ["GET", /^\/admin\/api\/site-safety\/checks\/([0-9a-f-]{36})$/, "view", "scoped", async ({ admin, scope }, [, id]) => {
      if (!safety) throw new Refusal(404, "no_safety", "这个部署没有开启文档网站。");
      const { check, site } = await checkIn({ admin, scope }, id);
      return { check: shownCheck(check), site: site ? { id: site.id, name: site.name, ownerId: site.ownerId, owner: await nameOf(admin, site.ownerId), scope: site.share?.scope ?? null,
        review: sites.list().find((item) => item.id === site.id)?.review ?? null, offline: site.offline === true } : null };
    }],
    ["PUT", /^\/admin\/api\/site-safety\/rules$/, "content.manage", "tenant", async ({ admin, body }) => {
      if (!safety) throw new Refusal(404, "no_safety", "这个部署没有开启文档网站。");
      let changed;
      try { changed = await safety.setRules(admin.tenantId, body, admin); } catch (error) { throw bad(error.message); }
      const words = (rules) => `${Object.entries(rules.actions).map(([category, by]) => `${SCAN_CATEGORIES[category]} 公开${ACTION_NAMES[by.public]}/组织内${ACTION_NAMES[by.internal]}`).join("；")}；敏感词 ${rules.keywords.length} 个；AI 审核${rules.ai ? "开" : "关"}；公开网站${rules.reviewAllPublic ? "一律" : "有问题才"}送审`;
      await record(admin, "admin.site-rules.update", { kind: "site-rules", id: "", name: "内容安全规则" }, { before: words(changed.before).slice(0, 400), after: words(changed.after).slice(0, 400) });
      return { ok: true, rules: changed.after };
    }],
    // Let through: the site goes up if this is the check it waits on, and what
    // was found is not stopped again. Only what the rules sent to review --
    // what they refuse outright, they refuse.
    ["POST", /^\/admin\/api\/site-safety\/checks\/([0-9a-f-]{36})\/approve$/, "content.manage", "scoped", async ({ admin, scope }, [, id]) => {
      if (!safety) throw new Refusal(404, "no_safety", "这个部署没有开启文档网站。");
      const { check, site } = await checkIn({ admin, scope }, id);
      if (!site) throw new Refusal(404, "no_site", "这个网站已经不在了。");
      if (check.outcome !== "review") throw new Refusal(409, "not_reviewable", check.outcome === "block" ? "被拦截的内容按规则不能放行；要放行，先在规则里把这一类改成「送管理员审核」。" : "这次检查没有要审核的内容。");
      if (check.decision) throw new Refusal(409, "decided", "这次检查已经处理过了。");
      const awaited = site.review?.state === "pending" && site.review.checkId === id;
      await sites.approve(site.id, { by: admin, checkId: id, version: check.version || null, fingerprints: check.findings.filter((finding) => finding.action === "review").map((finding) => finding.fingerprint),
        aiDigest: check.ai?.verdict === "review" ? check.textDigest : null });
      await safety.decide(admin.tenantId, id, { decision: "approved", by: admin });
      await record(admin, "admin.site.approve", { kind: "site", id: site.id, name: site.name }, { check: id, trigger: check.trigger, online: awaited && !site.held });
      return { ok: true, online: awaited && sites.get(site.id)?.offline === false };
    }],
    ["POST", /^\/admin\/api\/site-safety\/checks\/([0-9a-f-]{36})\/reject$/, "content.manage", "scoped", async ({ admin, scope, body }, [, id]) => {
      if (!safety) throw new Refusal(404, "no_safety", "这个部署没有开启文档网站。");
      const { check, site } = await checkIn({ admin, scope }, id);
      if (!site || !(site.review?.state === "pending" && site.review.checkId === id)) throw new Refusal(409, "not_waiting", "这个网站没有在等这次检查的审核。");
      const reason = String(body?.reason ?? "").trim().slice(0, 200);
      if (!reason) throw bad("请写不通过的原因：发布人会看到它");
      await sites.reject(site.id, { by: admin, reason });
      await safety.decide(admin.tenantId, id, { decision: "rejected", by: admin, reason });
      await record(admin, "admin.site.reject", { kind: "site", id: site.id, name: site.name }, { check: check.id, reason });
      return { ok: true };
    }],
    // Every site of the tenant checked again under today's rules. Started, not
    // waited for; pages the model did not get to read are read again on the
    // server's own clock (scheduleRescans).
    ["POST", /^\/admin\/api\/site-safety\/rescan$/, "content.manage", "tenant", async ({ admin }) => {
      if (!safety || !sites) throw new Refusal(404, "no_safety", "这个部署没有开启文档网站。");
      void rescans.run({ tenantId: admin.tenantId, all: true }).catch(() => {});
      await record(admin, "admin.site-rules.rescan", { kind: "site-rules", id: "", name: "全部重新检查" });
      return { ok: true, started: true };
    }],

    // Enterprise skills (docs/enterprise-skill-governance.md): what is on the
    // shelf, what waits for an administrator, every version that went up, who
    // sees which, who used which, and who may publish. The shelf is the
    // registry's; the rest is the governance's, in this database.
    ["GET", /^\/admin\/api\/skills$/, "view", "tenant", async ({ admin }) => {
      if (!skills) return { available: false, skills: [] };
      const shelf = skills.list(admin.tenantId);
      const usage = skillGovernance ? await skillGovernance.usage(admin.tenantId, shelf.map((skill) => skill.id), 30) : new Map();
      // When and by whom what is up now went up: the kept version with its digest.
      const up = new Map();
      if (skillGovernance) for (const skill of shelf) up.set(skill.id, (await skillGovernance.versions(admin.tenantId, skill.id)).find((version) => version.digest === skill.digest) ?? null);
      return { available: true, governed: Boolean(skillGovernance),
        skills: shelf.map((skill) => ({ id: skill.id, version: skill.version, title: skill.title, description: skill.description,
          publisher: skill.publisher, requiredTools: skill.requiredTools, files: skill.files.length, digest: skill.digest,
          visibility: skillGovernance ? skillGovernance.visibility(admin.tenantId, skill.id).departments : [],
          usage: usage.get(skill.id) ? { people: usage.get(skill.id).people, uses: usage.get(skill.id).uses } : null,
          published: up.get(skill.id) && up.get(skill.id).source !== "earlier" ? { at: up.get(skill.id).at, by: up.get(skill.id).publishedBy, approvedBy: up.get(skill.id).approvedBy } : null })),
        withdrawn: skillGovernance ? await skillGovernance.withdrawn(admin.tenantId, shelf.map((skill) => skill.id)) : [],
        pending: skillGovernance ? await skillGovernance.pendingCount(admin.tenantId) : 0,
        settings: skillGovernance ? { reviewRequired: skillGovernance.settings(admin.tenantId).reviewRequired } : null };
    }],
    // One skill: its files, as text, each version that went up, who sees it, who used it, what was done to it.
    ["GET", /^\/admin\/api\/skills\/(enterprise-[a-z0-9][a-z0-9-]{0,95})$/, "view", "tenant", async ({ admin }, [, id]) => {
      const versions = skillGovernance ? await skillGovernance.versions(admin.tenantId, id) : [];
      // Withdrawn: shown from its newest kept version, to bring back.
      const onShelf = skills?.list(admin.tenantId).find((item) => item.id === id) ?? null;
      const kept = !onShelf && versions.length ? await skillGovernance.version(admin.tenantId, id, versions[0].digest) : null;
      const skill = onShelf ?? (kept ? { ...kept, digest: versions[0].digest } : skillOn(admin, id));
      const departments = skillGovernance ? skillGovernance.visibility(admin.tenantId, id).departments : [];
      const named = org && departments.length ? new Map((await org.departments(admin.tenantId, departments)).map((department) => [department.id, department])) : null;
      const used = skillGovernance ? (await skillGovernance.usage(admin.tenantId, [id], 30)).get(id) : null;
      // Every one of the 30 days, used or not, so a quiet day reads as one.
      const usage = used ? { ...used, daily: Array.from({ length: 30 }, (_, index) => {
        const day = new Date(skillGovernance.now() - (29 - index) * 86_400_000).toISOString().slice(0, 10);
        return { day, uses: used.daily.find((point) => point.day === day)?.uses ?? 0 };
      }) } : null;
      const now = Date.now();
      const trail = (await audit.query({ tenantId: admin.tenantId, from: now - 400 * 86_400_000, to: now + 60_000, targetId: id, limit: 30 })).rows;
      return { skill: { id: skill.id, version: skill.version, title: skill.title, description: skill.description, publisher: skill.publisher, requiredTools: skill.requiredTools,
          runtimeVersions: skill.runtimeVersions, digest: skill.digest, files: skill.files.map((file) => ({ path: file.path, text: file.text })) },
        live: Boolean(onShelf), tools: skill.requiredTools.map(toolMeaning), versions: versions.map((version) => ({ ...version, live: Boolean(onShelf) && version.digest === skill.digest })),
        // A department Feishu no longer has is still in the setting -- nobody is under it -- and said so.
        visibility: { departments: departments.map((departmentId) => named ? (named.has(departmentId) ? named.get(departmentId) : { id: departmentId, name: null, gone: true }) : { id: departmentId, name: departmentId }) },
        usage, trail };
    }],
    ["POST", /^\/admin\/api\/skills\/(enterprise-[a-z0-9][a-z0-9-]{0,95})\/withdraw$/, "content.manage", "tenant", async ({ admin, body }, [, id]) => {
      const reason = String(body?.reason ?? "").trim().slice(0, 200);
      return oneAtATime(admin, id, async () => {
        const skill = skillOn(admin, id);
        // Kept first, so it can be brought back from its page.
        if (skillGovernance) await skillGovernance.keepLive(admin.tenantId, skill);
        await skills.withdraw(admin.tenantId, id);
        await record(admin, "admin.skill.withdraw", { kind: "skill", id, name: skill.title || id }, { version: skill.version, ...(reason ? { reason } : {}) });
        return { ok: true };
      });
    }],
    // Back to a version that went up before: on the shelf again, as a new revision.
    ["POST", /^\/admin\/api\/skills\/(enterprise-[a-z0-9][a-z0-9-]{0,95})\/rollback$/, "content.manage", "tenant", async ({ admin, body }, [, id]) => {
      if (!skills || !skillGovernance) throw new Refusal(404, "no_skills", "这个部署没有可管理的企业技能。");
      const bundle = await skillGovernance.version(admin.tenantId, id, String(body?.digest ?? ""));
      if (!bundle) throw new Refusal(404, "no_version", "没有这个版本，可能已经不在保留的最近 5 个里。");
      return oneAtATime(admin, id, async () => {
        const live = skills.list(admin.tenantId).find((item) => item.id === id) ?? null;
        if (live?.digest === String(body?.digest)) throw new Refusal(409, "already_live", "线上已经是这个版本。");
        await skillGovernance.keepLive(admin.tenantId, live);
        await placeSkill(admin, bundle);
        await keepVersion(skillGovernance.recordVersion(admin.tenantId, bundle, { publishedBy: admin, approvedBy: admin, source: "rollback" }));
        await record(admin, "admin.skill.rollback", { kind: "skill", id, name: bundle.title || id }, { from: live?.version ?? "已下架", to: bundle.version });
        return { ok: true, version: bundle.version };
      });
    }],
    ["PUT", /^\/admin\/api\/skills\/(enterprise-[a-z0-9][a-z0-9-]{0,95})\/visibility$/, "content.manage", "tenant", async ({ admin, body }, [, id]) => {
      if (!skillGovernance) throw new Refusal(404, "no_skills", "这个部署不支持按部门设置可见范围。");
      // Up now, or withdrawn with versions kept: limited before it is brought back.
      const kept = (await skillGovernance.versions(admin.tenantId, id))[0];
      const skill = skills?.list(admin.tenantId).find((item) => item.id === id) ?? (kept ? { id, title: (await skillGovernance.version(admin.tenantId, id, kept.digest))?.title } : skillOn(admin, id));
      const departments = await departmentsFor(admin, id, body?.departments);
      return oneAtATime(admin, id, async () => {
        let changed;
        try { changed = await skillGovernance.setVisibility(admin.tenantId, id, { departments }, admin); } catch (error) { throw bad(error.message); }
        await record(admin, "admin.skill.visibility", { kind: "skill", id, name: skill.title || id }, { before: await departmentWords(admin, changed.before.departments), after: await departmentWords(admin, changed.after.departments) });
        return { ok: true };
      });
    }],
    // What waits for an administrator, and what was decided.
    ["GET", /^\/admin\/api\/skills\/submissions$/, "view", "tenant", async ({ admin, query }) => {
      if (!skillGovernance) return { submissions: [] };
      const state = query.get("state") || "pending";
      try { return { submissions: await skillGovernance.submissions(admin.tenantId, { state: state === "all" ? null : state, limit: 100 }) }; }
      catch (error) { throw bad(error.message); }
    }],
    // A submission to read before deciding: every file, and what it changes from the version up now.
    ["GET", /^\/admin\/api\/skills\/submissions\/([0-9a-f-]{36})$/, "view", "tenant", async ({ admin }, [, submissionId]) => {
      const found = await submissionOf(admin, submissionId);
      const live = skills?.list(admin.tenantId).find((item) => item.id === found.skillId) ?? null;
      const { digest: _digest, ...liveBundle } = live ?? {};
      return { submission: { ...found, skill: undefined }, skill: { ...found.skill, files: found.skill.files.map((file) => ({ path: file.path, text: file.text })) },
        tools: found.skill.requiredTools.map(toolMeaning), live: live ? { version: live.version, digest: live.digest } : null,
        changes: compareSkills(live ? liveBundle : null, found.skill), selfReview: found.submittedBy.userId === admin.userId && (await otherApprovers(admin)).others,
        // Who will see it once it is up: what is set for the skill now, to keep or change on approving.
        visibility: { departments: await (async () => {
          const ids = skillGovernance.visibility(admin.tenantId, found.skillId).departments;
          const named = org && ids.length ? new Map((await org.departments(admin.tenantId, ids)).map((department) => [department.id, department])) : null;
          return ids.map((departmentId) => named?.get(departmentId) ?? { id: departmentId, name: named ? null : departmentId, gone: Boolean(named) });
        })() } };
    }],
    // `departments` (optional): who will see it, set before it goes up, so a
    // new skill can start with a few departments rather than everybody.
    ["POST", /^\/admin\/api\/skills\/submissions\/([0-9a-f-]{36})\/approve$/, "content.manage", "tenant", async ({ admin, body }, [, submissionId]) => {
      const found = await submissionOf(admin, submissionId);
      if (found.state !== "pending") throw new Refusal(409, "decided", "这个提交已经处理过了。");
      if (found.submittedBy.userId === admin.userId) {
        const approvers = await otherApprovers(admin);
        if (approvers.unreadable) throw new Refusal(403, "own_submission", "读不到管理员群，确认不了有没有别的管理员能审核：稍后再试，或请另一位管理员审核。");
        if (approvers.others) throw new Refusal(403, "own_submission", "不能审核自己提交的版本：请另一位管理员审核。");
      }
      // Sent only when the reviewer changed it, with what they saw: a change
      // somebody else made meanwhile is not silently undone.
      const departments = body?.departments === undefined ? null : await departmentsFor(admin, found.skillId, body.departments);
      if (departments && !Array.isArray(body?.visibilityWas)) throw bad("改可见范围时要带上改之前看到的范围（visibilityWas）");
      return oneAtATime(admin, found.skillId, async () => {
        const was = skillGovernance.visibility(admin.tenantId, found.skillId).departments;
        if (departments && [...new Set(body.visibilityWas.map(String))].sort().join("\n") !== [...was].sort().join("\n")) {
          throw new Refusal(409, "visibility_changed", "这个技能的可见范围刚被别人改过：重新打开审核看一眼。");
        }
        // Claimed before anything changes: a rejection at the same moment either
        // came first (and this is refused) or is refused itself. The older
        // versions waiting are ended only once this one is up.
        if (!await skillGovernance.decide(admin.tenantId, submissionId, { decision: "approved", by: admin, supersede: false })) throw new Refusal(409, "decided", "这个提交已经处理过了。");
        let visibility = null;
        try {
          if (departments) {
            try { visibility = await skillGovernance.setVisibility(admin.tenantId, found.skillId, { departments }, admin); } catch (error) { throw bad(error.message); }
          }
          await skillGovernance.keepLive(admin.tenantId, skills.list(admin.tenantId).find((item) => item.id === found.skillId) ?? null);
          await placeSkill(admin, found.skill);
        } catch (error) {
          // As it was: waiting again, seen by whom it was seen by -- and written
          // down. Each step on its own: one failing does not skip the others.
          const undo = (step, work) => Promise.resolve().then(work).catch((undone) => log({ component: "admin-console", event: "skill-approve-undo-failed", step, message: String(undone?.message ?? undone).slice(0, 200) }));
          await undo("reopen", () => skillGovernance.reopen(admin.tenantId, submissionId));
          if (visibility) await undo("visibility", () => skillGovernance.setVisibility(admin.tenantId, found.skillId, { departments: was }, admin));
          await undo("audit", () => record(admin, "admin.skill.approve", { kind: "skill", id: found.skillId, name: found.title || found.skillId },
            { version: found.version, error: String(error?.code ?? error?.message ?? error).slice(0, 80) }, "failed"));
          throw error;
        }
        // It is up: what follows is bookkeeping, and its failure is said, not turned into the approval's.
        await keepVersion(skillGovernance.supersede(admin.tenantId, submissionId));
        await keepVersion(skillGovernance.recordVersion(admin.tenantId, found.skill, { publishedBy: found.submittedBy, approvedBy: admin, source: "approve" }));
        await record(admin, "admin.skill.approve", { kind: "skill", id: found.skillId, name: found.title || found.skillId },
          { version: found.version, submittedBy: found.submittedBy.name || found.submittedBy.userId, ...(found.submittedBy.userId === admin.userId ? { self: true } : {}),
            ...(visibility ? { before: await departmentWords(admin, visibility.before.departments), visibility: await departmentWords(admin, visibility.after.departments) } : {}) });
        return { ok: true };
      });
    }],
    ["POST", /^\/admin\/api\/skills\/submissions\/([0-9a-f-]{36})\/reject$/, "content.manage", "tenant", async ({ admin, body }, [, submissionId]) => {
      const found = await submissionOf(admin, submissionId);
      const reason = String(body?.reason ?? "").trim().slice(0, 300);
      if (!reason) throw bad("请写驳回的原因：提交人会看到它");
      if (!await skillGovernance.decide(admin.tenantId, submissionId, { decision: "rejected", by: admin, reason })) throw new Refusal(409, "decided", "这个提交已经处理过了。");
      await record(admin, "admin.skill.reject", { kind: "skill", id: found.skillId, name: found.title || found.skillId }, { version: found.version, reason });
      return { ok: true };
    }],
    // Whether a new version waits for an administrator.
    ["PUT", /^\/admin\/api\/skills\/settings$/, "content.manage", "tenant", async ({ admin, body }) => {
      if (!skillGovernance) throw new Refusal(404, "no_skills", "这个部署没有可管理的企业技能。");
      let changed;
      try { changed = await skillGovernance.setSettings(admin.tenantId, { reviewRequired: body?.reviewRequired }, admin); } catch (error) { throw bad(error.message); }
      await record(admin, "admin.skill.settings", { kind: "skill-settings", id: "", name: "上架前需要审核" },
        { before: changed.before.reviewRequired ? "需要审核" : "直接上线", after: changed.after.reviewRequired ? "需要审核" : "直接上线" });
      return { ok: true };
    }],
    // Who may publish: the server's configured administrators, and those added here.
    ["GET", /^\/admin\/api\/skills\/publishers$/, "view", "tenant", async ({ admin }) => {
      if (!skills) return { publishers: [] };
      const configured = skills.administrators ? [...skills.administrators] : [];
      const added = skillGovernance ? skillGovernance.publishers(admin.tenantId) : [];
      const rows = [...configured.map((userId) => ({ userId, source: "configured" })), ...added.filter((person) => !configured.includes(person.userId)).map((person) => ({ ...person, source: "console" }))];
      return { publishers: await Promise.all(rows.map(async (row) => ({ ...row, name: (await nameOf(admin, row.userId)) || row.name || "" }))) };
    }],
    ["POST", /^\/admin\/api\/skills\/publishers$/, "content.manage", "tenant", async ({ admin, body }) => {
      if (!skillGovernance) throw new Refusal(404, "no_skills", "这个部署没有可管理的企业技能。");
      const person = who(admin, body?.userId), name = await nameOf(admin, person.userId);
      try { await skillGovernance.addPublisher(admin.tenantId, { userId: person.userId, name }, admin); } catch (error) { throw bad(error.message); }
      await record(admin, "admin.skill.publishers", { kind: "person", id: person.userId, name }, { change: "add" });
      return { ok: true };
    }],
    ["DELETE", /^\/admin\/api\/skills\/publishers\/(ou_[A-Za-z0-9_-]{1,128})$/, "content.manage", "tenant", async ({ admin }, [, userId]) => {
      if (!skillGovernance) throw new Refusal(404, "no_skills", "这个部署没有可管理的企业技能。");
      if (skills?.administrators?.has(userId)) throw new Refusal(409, "configured", "这位上架人写在服务器配置里，要在服务器上改。");
      if (!await skillGovernance.removePublisher(admin.tenantId, userId)) throw new Refusal(404, "no_publisher", "名单里没有这个人。");
      await record(admin, "admin.skill.publishers", { kind: "person", id: userId, name: await nameOf(admin, userId) }, { change: "remove" });
      return { ok: true };
    }],

    // Taken down, with a reason its owner will see: the link stops working
    // and only an administrator brings it back.
    ["POST", /^\/admin\/api\/sites\/([0-9a-f-]{36})\/hold$/, "content.manage", "scoped", async ({ admin, scope, body }, [, siteId]) => {
      const site = siteIn(admin, siteId);
      await requireInScope({ admin, scope }, String(site.ownerId));
      const reason = String(body?.reason ?? "").trim().slice(0, 200);
      if (!reason) throw bad("请写下线的原因：发布人会看到它");
      if (site.held) return { ok: true, changed: false };
      await sites.hold(siteId, { by: admin, reason });
      forgetSite(siteId);
      await record(admin, "admin.site.hold", { kind: "site", id: siteId, name: site.name }, { owner: await nameOf(admin, site.ownerId) || site.ownerId, reason });
      return { ok: true, changed: true };
    }],
    ["POST", /^\/admin\/api\/sites\/([0-9a-f-]{36})\/release$/, "content.manage", "scoped", async ({ admin, scope }, [, siteId]) => {
      const site = siteIn(admin, siteId);
      await requireInScope({ admin, scope }, String(site.ownerId));
      if (!site.held) return { ok: true, changed: false };
      const released = await sites.release(siteId);
      await record(admin, "admin.site.release", { kind: "site", id: siteId, name: site.name }, { owner: await nameOf(admin, site.ownerId) || site.ownerId, online: !released.offline });
      return { ok: true, changed: true, offline: released.offline };
    }],
  ];

  function ruleTarget(rule, name) {
    return { kind: `policy-${rule.target.kind}`, id: rule.target.id || "everyone", name: name || { everyone: "所有人", chat: "群", department: "部门", user: "成员" }[rule.target.kind] };
  }
  async function targetName(admin, rule) {
    if (rule.target.kind === "user") return nameOf(admin, rule.target.id);
    if (rule.target.kind === "department" && org) return (await org.named(admin.tenantId, [rule.target.id]))[0]?.path.join(" / ") ?? rule.target.id;
    return rule.target.kind === "everyone" ? "所有人" : rule.target.id;
  }

  async function stream(res, send, filename, header, rows) {
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="${filename}"` });
    res.write(`﻿${csvRow(header)}`);
    try {
      for await (const values of rows) {
        if (!res.write(csvRow(values))) await new Promise((resolve) => res.once("drain", resolve));
        if (res.destroyed) return;
      }
    } catch (error) {
      log({ component: "admin-console", event: "export-failed", message: String(error?.message ?? error).slice(0, 200) });
      res.write(csvRow(["导出中断", String(error?.message ?? error).slice(0, 120)]));
    }
    res.end();
  }

  for (const [method, pattern, , kind] of routes) if (!ROUTE_KINDS.includes(kind)) throw new Error(`${method} ${pattern} 没有说明管理范围`);
  return {
    routes,
    async handle(ctx) {
      for (const [method, pattern, permission, kind, work] of routes) {
        const match = pattern.exec(ctx.path);
        if (!match) continue;
        if (ctx.method !== method && !(method === "GET" && ctx.method === "HEAD")) continue;
        if (!can(ctx.admin.role, permission)) { ctx.json(403, { error: "forbidden", message: "你的角色不能做这件事。" }); return; }
        try {
          ctx.scope = await scopeOf(ctx.admin);
          if (kind === "tenant" && !ctx.scope.all) throw new Refusal(403, "tenant_only", "这件事只有管理整个组织的管理员能做。");
          const value = await work(ctx, match);
          if (value !== undefined && !ctx.res.headersSent) ctx.json(200, value);
        } catch (error) {
          if (error instanceof Refusal) { ctx.json(error.status, { error: error.code, message: error.message }); return; }
          log({ component: "admin-console", event: "route-failed", route: ctx.path.slice(0, 80), message: String(error?.message ?? error).slice(0, 200) });
          if (!ctx.res.headersSent) ctx.json(500, { error: "internal", message: "后台出错了，请稍后再试。" });
          else ctx.res.end();
        }
        return;
      }
      ctx.json(404, { error: "not_found", message: "没有这个接口。" });
    },
  };
}
