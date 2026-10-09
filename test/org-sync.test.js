// The organisation's structure, read from Feishu's address book (org-sync.js)
// into the administration database (org-directory.js), and what it is for:
// rules for departments (policy.js), and people Feishu says have left being
// disabled. Against a Feishu of the test's own, answering in the shapes the
// address book API documents; a refusal is HTTP 400 with its code, as measured.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { OrgDirectory } from "../src/control-plane/org-directory.js";
import { OrgSync, CONTACT_SCOPES } from "../src/control-plane/org-sync.js";
import { PeopleDirectory } from "../src/control-plane/people-directory.js";
import { AccessList } from "../src/control-plane/access-list.js";
import { PolicyStore, PolicyEngine } from "../src/control-plane/policy.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { testPostgres } from "./helpers/postgres.js";

const KINDS = ["sqlite", "postgres"];
const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));
const TENANT = "tenant-a";

// 总部 ─┬─ 研发中心 ─┬─ 平台部
//       │            └─ 应用部
//       └─ 销售部
const ALL_DEPARTMENTS = [
  { open_department_id: "od-rd", parent_department_id: "0", name: "研发中心", member_count: 60, order: 1 },
  { open_department_id: "od-platform", parent_department_id: "od-rd", name: "平台部", member_count: 30, order: 1 },
  { open_department_id: "od-apps", parent_department_id: "od-rd", name: "应用部", member_count: 30, order: 2 },
  { open_department_id: "od-sales", parent_department_id: "0", name: "销售部", member_count: 40, order: 2 },
  { open_department_id: "od-gone", parent_department_id: "0", name: "已撤销", status: { is_deleted: true } },
];
const USERS = {
  ou_alice: { open_id: "ou_alice", name: "Alice", department_ids: ["od-platform"], status: { is_resigned: false, is_activated: true } },
  ou_bob: { open_id: "ou_bob", name: "Bob", department_ids: ["od-sales"], status: { is_resigned: true } },
  ou_carol: { open_id: "ou_carol", name: "Carol", department_ids: ["od-apps", "od-sales"], status: { is_resigned: false } },
};

// `range`: the application's 通讯录权限范围 -- `{ all: true }` for everybody,
// or some departments and people. Everybody is answered as Feishu answers it
// (its docs, and measured 2026-10-05): the root's first-level departments and
// the people directly under the root, never "0" -- and the root is readable.
// Outside a range Feishu does not answer: the root and its children are
// refused (HTTP 403, 40004, as measured 2026-10-02), and a person outside is
// left out of users/batch. `departments` stands in for another organisation.
function feishu({ refuse = null, pageSize = 2, withoutDepartmentIds = false, users = USERS, departments: DEPARTMENTS = ALL_DEPARTMENTS, range = { all: true }, refuseDepartments = false } = {}) {
  const calls = [];
  const all = range.all === true || (range.departments ?? []).includes("0");
  const under = (root) => {
    const out = [];
    const walk = (id) => { for (const item of DEPARTMENTS.filter((d) => d.parent_department_id === id)) { out.push(item); walk(item.open_department_id); } };
    walk(root);
    return out;
  };
  const covered = (id) => !refuseDepartments && (all || (range.departments ?? []).some((top) => top === id || under(top).some((d) => d.open_department_id === id)));
  const paged = (items, searchParams) => {
    const start = Number(searchParams.get("page_token") || 0), page = items.slice(start, start + pageSize);
    const more = start + pageSize < items.length;
    return Response.json({ code: 0, msg: "success", data: { items: page, has_more: more, ...(more ? { page_token: String(start + pageSize) } : {}) } });
  };
  const noAuthority = () => new Response(JSON.stringify({ code: 40004, msg: "no dept authority error" }), { status: 403, headers: { "content-type": "application/json" } });
  const fetch = async (url) => {
    const { pathname, searchParams } = new URL(url);
    calls.push(pathname);
    if (refuse) return new Response(JSON.stringify({ code: refuse, msg: "Access denied. One of the following scopes is required: [contact:contact.base:readonly, contact:contact:readonly_as_app].应用尚未开通所需的应用身份权限" }), { status: 400, headers: { "content-type": "application/json" } });
    if (pathname === "/open-apis/contact/v3/scopes") {
      const said = range.all === true
        ? { department_ids: DEPARTMENTS.filter((d) => d.parent_department_id === "0" && !d.status?.is_deleted).map((d) => d.open_department_id),
          user_ids: Object.values(users).filter((user) => (user.department_ids ?? []).includes("0")).map((user) => user.open_id) }
        : { department_ids: range.departments, user_ids: range.users };
      return Response.json({ code: 0, msg: "success", data: { ...said, group_ids: [], has_more: false } });
    }
    const children = /^\/open-apis\/contact\/v3\/departments\/([^/]+)\/children$/.exec(pathname);
    if (children) {
      const [, parent] = children;
      assert.equal(searchParams.get("fetch_child"), "true");
      if (parent === "0" ? !all || refuseDepartments : !covered(parent)) return noAuthority();
      return paged(under(parent), searchParams);
    }
    const one = /^\/open-apis\/contact\/v3\/departments\/([^/]+)$/.exec(pathname);
    // The root: readable for everybody (measured: 200, code 0, a department with no counts), refused otherwise.
    if (one?.[1] === "0") return all && !refuseDepartments ? Response.json({ code: 0, msg: "success", data: { department: { open_department_id: "0", name: "" } } }) : noAuthority();
    if (one) {
      const item = DEPARTMENTS.find((d) => d.open_department_id === one[1]);
      return item && covered(item.open_department_id) ? Response.json({ code: 0, msg: "success", data: { department: item } }) : noAuthority();
    }
    if (pathname === "/open-apis/contact/v3/users/batch") {
      const items = searchParams.getAll("user_ids").map((id) => users[id]).filter(Boolean)
        .filter((item) => all || (range.users ?? []).includes(item.open_id) || (item.department_ids ?? []).some(covered))
        .map((item) => withoutDepartmentIds ? (({ department_ids, ...rest }) => rest)(item) : item);
      return Response.json({ code: 0, msg: "success", data: { items } });
    }
    throw new Error(`unexpected ${pathname}`);
  };
  return { fetch, calls };
}

async function setup(t, kind, options = {}) {
  let db;
  if (kind === "postgres") {
    const settings = await (await postgres()).database();
    const pool = new pg.Pool({ ...settings, max: 4 }); pool.on("error", () => {});
    const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
    db = await openAdminDatabase({ pool, connect });
    t.after(async () => { await db.close(); await pool.end(); });
  } else { db = await openAdminDatabase(); t.after(() => db.close()); }
  const org = await OrgDirectory.open({ db });
  const people = await PeopleDirectory.open({ db });
  const access = await AccessList.open({ db });
  t.after(async () => { org.close(); access.close(); await people.close(); });
  for (const userId of ["ou_alice", "ou_bob", "ou_carol", "ou_dave"]) people.seen({ tenantId: TENANT, userId, name: userId.slice(3), signIn: true });
  await people.flush();
  const upstream = feishu(options);
  const audit = [];
  const sync = new OrgSync({ feishu: SAAS_FEISHU, bot: { token: async () => "t-synthetic" }, org, people, access, audit: (event) => audit.push(event), fetch: upstream.fetch, sleep: async () => {} });
  return { db, org, people, access, sync, upstream, audit };
}

for (const kind of KINDS) test(`${kind}: the tree, who is where, and who has left -- disabled at once, listed, nothing deleted`, async (t) => {
  const f = await setup(t, kind);
  const result = await f.sync.sync(TENANT);
  assert.deepEqual({ ok: result.ok, departments: result.departments, checked: result.checked, departed: result.departed, disabled: result.disabled, unknown: result.unknown },
    { ok: true, departments: 4, checked: 3, departed: 1, disabled: 1, unknown: 1 }, "Dave is outside the contact range: not answered, not taken as gone");
  assert.deepEqual((await f.org.children(TENANT, "")).map((d) => [d.name, d.children]), [["研发中心", 2], ["销售部", 0]]);
  assert.deepEqual((await f.org.children(TENANT, "od-rd")).map((d) => d.name), ["平台部", "应用部"]);
  assert.deepEqual((await f.org.departmentsOf({ tenantId: TENANT, userId: "ou_alice" })).sort(), ["od-platform", "od-rd"], "with the departments above");
  assert.deepEqual((await f.org.person(TENANT, "ou_alice")).departments[0].path, ["研发中心", "平台部"]);
  assert.equal(f.access.isDisabled(TENANT, "ou_bob"), true);
  assert.equal(f.access.get(TENANT, "ou_bob").reason, "飞书显示已离职（自动）");
  assert.equal(f.access.isDisabled(TENANT, "ou_dave"), false);
  assert.deepEqual((await f.org.departed({ tenantId: TENANT })).map((row) => row.userId), ["ou_bob"]);
  assert.ok(f.audit.some((event) => event.action === "admin.person.disable" && event.target.id === "ou_bob" && event.actor.kind === "system"));
  assert.equal((await f.org.status(TENANT)).state, "ok");
  // Again: the same answer, no second disabling, the departed time kept.
  const departedAt = (await f.org.departed({ tenantId: TENANT }))[0].departedAt;
  assert.equal((await f.sync.sync(TENANT)).disabled, 0);
  assert.equal((await f.org.departed({ tenantId: TENANT }))[0].departedAt, departedAt);
  assert.deepEqual((await f.org.search(TENANT, "研发")).map((d) => d.name), ["研发中心"]);
});

for (const kind of KINDS) test(`${kind}: without the scopes, what to ask for is recorded -- not an empty organisation`, async (t) => {
  const f = await setup(t, kind, { refuse: 99991672 });
  const result = await f.sync.sync(TENANT);
  assert.equal(result.ok, false);
  assert.equal(result.state, "missing_scopes");
  assert.deepEqual(result.named, ["contact:contact.base:readonly", "contact:contact:readonly_as_app"]);
  const status = await f.org.status(TENANT);
  assert.deepEqual({ state: status.state, departments: status.departments }, { state: "missing_scopes", departments: 0 });
  assert.equal(await f.access.disabledCount(TENANT), 0, "nobody disabled on a refusal");
  assert.ok(CONTACT_SCOPES.every(([scope, name]) => scope.startsWith("contact:") && name));
});

test("a field Feishu left out for want of a scope is said to be that", async (t) => {
  const f = await setup(t, "sqlite", { withoutDepartmentIds: true });
  const result = await f.sync.sync(TENANT);
  assert.equal(result.missingField, "contact:user.department:readonly");
});

test("rules for departments: the nearest department decides, and everyone else is untouched", async (t) => {
  const f = await setup(t, "sqlite");
  await f.sync.sync(TENANT);
  const store = await PolicyStore.open({ db: f.db, models: ["MiniMax-M3", "GLM-5.3"] });
  t.after(() => store.close());
  const policy = new PolicyEngine({ store, models: ["MiniMax-M3", "GLM-5.3"], org: f.org });
  const by = { userId: "ou_admin" };
  await store.create({ tenantId: TENANT, target: { kind: "department", id: "od-rd" }, settings: { quota: { dailyTokens: 5000 }, features: { mediaVideo: false } }, by });
  await store.create({ tenantId: TENANT, target: { kind: "department", id: "od-platform" }, settings: { quota: { dailyTokens: 9000 } }, by });
  await store.create({ tenantId: TENANT, target: { kind: "department", id: "od-sales" }, settings: { features: { mediaVideo: true } }, by });
  const alice = await policy.effective({ tenantId: TENANT, userId: "ou_alice" });
  assert.equal(alice.quota.dailyTokens, 9000, "平台部 over 研发中心");
  assert.equal(alice.features.mediaVideo, false, "what 平台部 does not say, 研发中心 does");
  const carol = await policy.effective({ tenantId: TENANT, userId: "ou_carol" });
  assert.equal(carol.quota.dailyTokens, 5000, "应用部 has no rule: 研发中心's");
  assert.equal(carol.features.mediaVideo, false, "研发中心 and 销售部 are equally near, and one says off: off");
  const dave = await policy.effective({ tenantId: TENANT, userId: "ou_dave" });
  assert.equal(dave.quota.dailyTokens, null);
});

for (const kind of KINDS) test(`${kind}: who has left waits until cleaned up after; an administrator who enables them again has the last word`, async (t) => {
  const users = structuredClone(USERS);
  const f = await setup(t, kind, { users });
  await f.sync.sync(TENANT);
  assert.deepEqual((await f.org.status(TENANT)).pending, 1);
  // Enabled again by an administrator: tomorrow's run leaves Bob as he is.
  await f.access.enable([{ tenantId: TENANT, userId: "ou_bob" }], { by: { userId: "ou_admin", name: "管理员" } });
  const audited = f.audit.length;
  assert.equal((await f.sync.sync(TENANT)).disabled, 0);
  assert.equal(f.access.isDisabled(TENANT, "ou_bob"), false);
  assert.equal(f.audit.slice(audited).filter((event) => event.action === "admin.person.disable").length, 0);
  // Cleaned up after: off the waiting list, on the cleaned one; a second mark changes nothing.
  assert.equal(await f.org.markCleaned(TENANT, ["ou_bob", "ou_alice"]), 1, "Alice still works here: nothing to mark");
  assert.equal(await f.org.markCleaned(TENANT, ["ou_bob"]), 0);
  assert.deepEqual({ pending: (await f.org.status(TENANT)).pending, list: (await f.org.departed({ tenantId: TENANT })).length }, { pending: 0, list: 0 });
  assert.deepEqual((await f.org.departed({ tenantId: TENANT, state: "cleaned" })).map((row) => row.userId), ["ou_bob"]);
  await f.sync.sync(TENANT);
  assert.equal((await f.org.status(TENANT)).pending, 0, "a run does not put a cleaned-up person back on the list");
  // Back at work, then leaving again: on the list again, and disabled again.
  users.ou_bob.status.is_resigned = false;
  await f.sync.sync(TENANT);
  assert.deepEqual(await f.org.departed({ tenantId: TENANT, state: "cleaned" }), []);
  users.ou_bob.status.is_resigned = true;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await f.sync.sync(TENANT)).disabled, 1, "leaving after being enabled is leaving again");
  assert.deepEqual((await f.org.departed({ tenantId: TENANT })).map((row) => row.userId), ["ou_bob"]);
});

test("a clock stepped back does not keep departments Feishu no longer has", async (t) => {
  const db = await openAdminDatabase();
  let clock = 10_000;
  const org = await OrgDirectory.open({ db, now: () => clock });
  t.after(async () => { org.close(); await db.close(); });
  const top = (id) => ({ id, parentId: "", name: id, path: `/${id}/`, depth: 1, memberCount: 0 });
  await org.replaceDepartments(TENANT, [top("od-a"), top("od-b")]);
  clock = 5_000;
  await org.replaceDepartments(TENANT, [top("od-a")]);
  assert.deepEqual((await org.children(TENANT, "")).map((d) => d.id), ["od-a"]);
});

test("a run never rejects -- it starts from a timer, where an unanswered rejection would end the process", async (t) => {
  const f = await setup(t, "sqlite");
  const broken = Object.create(f.org);
  broken.recordSync = async () => { throw new Error("database gone"); };
  const sync = new OrgSync({ feishu: SAAS_FEISHU, bot: { token: async () => "t-synthetic" }, org: broken, people: f.people, access: f.access, fetch: f.upstream.fetch, sleep: async () => {} });
  const result = await sync.sync(TENANT);
  assert.deepEqual({ ok: result.ok, state: result.state }, { ok: false, state: "failed" });
});

for (const kind of KINDS) test(`${kind}: a contact range of some departments -- those and everything under them, the rest left alone and said so`, async (t) => {
  // 研发中心 only: 平台部 and 应用部 come with it; 销售部 is outside, and Bob in it is not taken for gone.
  const f = await setup(t, kind, { range: { departments: ["od-platform", "od-rd"], users: [] } });
  const result = await f.sync.sync(TENANT);
  assert.deepEqual({ ok: result.ok, departments: result.departments, range: result.range, disabled: result.disabled },
    { ok: true, departments: 3, range: { all: false, departments: 2, users: 0 }, disabled: 0 }, "a department inside another is read once");
  assert.deepEqual((await f.org.children(TENANT, "")).map((d) => [d.name, d.children]), [["研发中心", 2]]);
  assert.equal(f.access.isDisabled(TENANT, "ou_bob"), false, "outside the range: not answered, not disabled");
  assert.ok(!f.upstream.calls.includes("/open-apis/contact/v3/departments/0/children"), "the root is not asked when the range is not everybody");
  assert.deepEqual((await f.org.status(TENANT)).detail.range, { all: false, departments: 2, users: 0 });
});

test("a range of one person (measured 2026-10-02) is said as that range, with what to change -- not a refusal, not the whole organisation", async (t) => {
  const f = await setup(t, "sqlite", { range: { departments: [], users: ["ou_alice"] } });
  const result = await f.sync.sync(TENANT);
  assert.deepEqual({ ok: result.ok, range: result.range, departments: result.departments }, { ok: true, range: { all: false, departments: 0, users: 1 }, departments: 0 });
  assert.ok(f.upstream.calls.includes("/open-apis/contact/v3/departments/0"), "the root was asked, and refused");
  assert.equal(f.access.isDisabled(TENANT, "ou_bob"), false, "outside the range: not taken for gone");
});

test("a department in the range that Feishu then refuses is said to be the range -- not a bare refusal", async (t) => {
  const f = await setup(t, "sqlite", { range: { departments: ["od-rd"], users: [] }, refuseDepartments: true });
  const result = await f.sync.sync(TENANT);
  assert.deepEqual({ ok: result.ok, state: result.state, code: result.code }, { ok: false, state: "missing_range", code: 40004 });
  assert.equal((await f.org.status(TENANT)).state, "missing_range");
  assert.equal(f.audit.at(-1).outcome, "refused");
});

for (const kind of KINDS) test(`${kind}: everybody, as Feishu says it -- first-level departments, people under the root, no "0" -- is everybody`, async (t) => {
  const f = await setup(t, kind);
  const result = await f.sync.sync(TENANT);
  assert.deepEqual(result.range, { all: true, departments: 2, users: 0 }, "the two first-level departments, and everybody");
  assert.ok(f.upstream.calls.includes("/open-apis/contact/v3/departments/0/children"), "walked from the root");
  // An organisation of two people and no departments, as measured 2026-10-05:
  // no departments, two people -- read until then as a range of two.
  const small = await setup(t, kind, { departments: [], users: { ou_alice: { ...USERS.ou_alice, department_ids: ["0"] }, ou_carol: { ...USERS.ou_carol, department_ids: ["0"] } } });
  const two = await small.sync.sync(TENANT);
  assert.deepEqual({ ok: two.ok, range: two.range, departments: two.departments, checked: two.checked }, { ok: true, range: { all: true, departments: 0, users: 2 }, departments: 0, checked: 2 });
  assert.deepEqual((await small.org.status(TENANT)).detail.range, { all: true, departments: 0, users: 2 });
});

