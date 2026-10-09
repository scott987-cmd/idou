// The directory of everybody who has used a deployment (people-directory.js)
// and the roles of those who administer it (admin-roles.js), on SQLite and on
// a PostgreSQL of the test's own.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { PeopleDirectory, peopleQuery, peopleCursor, DIRECTORY_LIMITS } from "../src/control-plane/people-directory.js";
import { AccessList } from "../src/control-plane/access-list.js";
import { AdminRoles, can, PERMISSIONS, ROLE_LIMITS } from "../src/control-plane/admin-roles.js";
import { AdminDirectory } from "../src/control-plane/admin-directory.js";
import { testPostgres } from "./helpers/postgres.js";

const KINDS = ["sqlite", "postgres"];
const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));

const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);
const DAY = 86_400_000;
const TENANT = "tenant-a";

async function database(t, kind) {
  if (kind === "postgres") {
    const settings = await (await postgres()).database();
    const pool = new pg.Pool({ ...settings, max: 4 }); pool.on("error", () => {});
    const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
    const db = await openAdminDatabase({ pool, connect });
    t.after(async () => { await db.close(); await pool.end(); });
    return db;
  }
  const db = await openAdminDatabase();
  t.after(() => db.close());
  return db;
}

for (const kind of KINDS) test(`${kind}: a sign-in is always written, a presence at most every ten minutes, and in batches`, async (t) => {
  const db = await database(t, kind);
  const clock = { at: T0 };
  const people = await PeopleDirectory.open({ db, now: () => clock.at });
  t.after(() => people.close());
  assert.equal(people.seen({ tenantId: TENANT, userId: "ou_a", name: "张三", client: "0.1.0-20261002.267", signIn: true }), true);
  await people.flush();
  clock.at += 60_000;
  assert.equal(people.seen({ tenantId: TENANT, userId: "ou_a" }), false, "a renewal a minute later is not a write");
  assert.equal(people.seen({ tenantId: TENANT, userId: "ou_a", name: "张三丰" }), true, "a new name is");
  clock.at += DIRECTORY_LIMITS.presenceEveryMs;
  assert.equal(people.seen({ tenantId: TENANT, userId: "ou_a" }), true, "and so is presence after ten minutes");
  assert.equal(people.seen({ tenantId: TENANT, userId: "not an id" }), false);
  await people.flush();
  const one = await people.get(TENANT, "ou_a");
  assert.deepEqual({ name: one.name, first: one.firstSeenAt, last: one.lastSeenAt, client: one.client, signIns: one.signIns },
    { name: "张三丰", first: T0, last: T0 + 60_000 + DIRECTORY_LIMITS.presenceEveryMs, client: "0.1.0-20261002.267", signIns: 1 });
  assert.equal(await people.get("tenant-b", "ou_a"), null, "per tenant");
});

for (const kind of KINDS) test(`${kind}: listing pages through everybody once, by any order, searched and filtered`, async (t) => {
  const db = await database(t, kind);
  const clock = { at: T0 };
  const people = await PeopleDirectory.open({ db, now: () => clock.at });
  const access = await AccessList.open({ db, now: () => clock.at });
  t.after(async () => { access.close(); await people.close(); });
  const names = ["王小明", "李华", "张伟", "Alice Wong", "王芳", "刘洋", "陈静", "王%_\\", "赵磊", "孙丽"];
  for (let index = 0; index < 230; index += 1) {
    people.seen({ tenantId: TENANT, userId: `ou_${String(index).padStart(4, "0")}`, name: `${names[index % names.length]}${index}`, signIn: true, at: T0 - (index % 40) * DAY - index });
  }
  people.seen({ tenantId: "tenant-b", userId: "ou_other", name: "王小明", signIn: true, at: T0 });
  await people.flush();
  await access.disable([{ tenantId: TENANT, userId: "ou_0003" }, { tenantId: TENANT, userId: "ou_0013" }], { by: { userId: "ou_admin" } });

  for (const sort of ["active", "name", "first"]) {
    const seen = [];
    let cursor = null, total = null;
    do {
      const page = await people.list({ tenantId: TENANT, sort, cursor, limit: 37 });
      if (!cursor) total = page.total;
      seen.push(...page.people);
      cursor = page.next;
    } while (cursor);
    assert.equal(total, 230, `${sort}: the count`);
    assert.equal(new Set(seen.map((person) => person.userId)).size, 230, `${sort}: everybody once`);
    const values = seen.map((person) => sort === "active" ? -person.lastSeenAt : sort === "first" ? -person.firstSeenAt : person.name.toLowerCase());
    assert.deepEqual(values, [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), `${sort}: in order`);
  }
  const wang = await people.list({ tenantId: TENANT, q: "王", limit: 200 });
  assert.equal(wang.total, 69);
  assert.ok(wang.people.every((person) => person.name.includes("王")));
  assert.equal((await people.list({ tenantId: TENANT, q: "alice" })).total, 23, "case does not matter");
  assert.equal((await people.list({ tenantId: TENANT, q: "%_\\" })).total, 23, "wildcards are taken literally");
  assert.equal((await people.list({ tenantId: TENANT, q: "ou_0042" })).people[0].userId, "ou_0042", "an open_id is looked up exactly");
  assert.equal((await people.list({ tenantId: TENANT, status: "disabled" })).total, 2);
  assert.equal((await people.list({ tenantId: TENANT, status: "enabled" })).total, 228);
  // Day offsets 0..39 by index: offsets 0..29 hold six people each, 30..39 five.
  assert.equal((await people.list({ tenantId: TENANT, activeSince: T0 - 7 * DAY })).total, 7 * 6, "offsets 0..6");
  assert.equal((await people.list({ tenantId: TENANT, inactiveBefore: T0 - 30 * DAY + 1 })).total, 10 * 5, "offsets 30..39");
  await assert.rejects(people.list({ tenantId: TENANT, cursor: "garbage" }), /翻页位置无效/);
  await assert.rejects(people.list({ tenantId: TENANT, sort: "salary" }), /没有这种排序/);
  const stats = await people.stats(TENANT, T0);
  assert.deepEqual(stats, { total: 230, activeDay: 6, activeWeek: 42, activeMonth: 180, newMonth: 180 });
  // Counted within departments, in one pass: everybody placed in one -- the
  // same numbers; an empty one -- none; half in another -- the even ones.
  await db.run("INSERT INTO idou_admin_departments (tenant, department_id, parent_id, name, path, depth, synced_at) VALUES (?, 'od-all', '', '全部', '/od-all/', 1, 0), (?, 'od-none', '', '空', '/od-none/', 1, 0), (?, 'od-even', 'od-all', '双', '/od-all/od-even/', 2, 0)", [TENANT, TENANT, TENANT]);
  for (let index = 0; index < 230; index += 1) {
    const userId = `ou_${String(index).padStart(4, "0")}`;
    await db.run("INSERT INTO idou_admin_org_membership (tenant, department_id, user_id) VALUES (?, ?, ?)", [TENANT, index % 2 ? "od-all" : "od-even", userId]);
  }
  assert.deepEqual(await people.stats(TENANT, T0, { departmentPaths: ["/od-all/"] }), stats, "a department and those under it: everybody");
  assert.deepEqual(await people.stats(TENANT, T0, { departmentPaths: ["/od-none/"] }), { total: 0, activeDay: 0, activeWeek: 0, activeMonth: 0, newMonth: 0 });
  assert.equal((await people.stats(TENANT, T0, { departmentPaths: ["/od-all/od-even/"] })).total, 115);
  assert.equal((await people.list({ tenantId: TENANT, departmentPaths: ["/od-all/od-even/", "/od-none/"] })).total, 115, "several departments: any of them");
  const named = await people.names(TENANT, ["ou_0001", "ou_0002", "ou_missing"]);
  assert.deepEqual([...named.keys()].sort(), ["ou_0001", "ou_0002"]);
  assert.equal(await people.forget(TENANT, "ou_0001"), 1);
  assert.equal(await people.get(TENANT, "ou_0001"), null);
});

test("sqlite: every listing is answered from its index and sorted in it", async (t) => {
  const db = await database(t, "sqlite");
  await PeopleDirectory.open({ db });
  const cursor = peopleCursor.encode(5, "ou_x");
  for (const [filter, index] of [
    [{ sort: "active" }, "idou_admin_people_active"],
    [{ sort: "active", cursor, q: "王", status: "enabled", activeSince: 1 }, "idou_admin_people_active"],
    [{ sort: "name", cursor: peopleCursor.encode("王", "ou_x") }, "idou_admin_people_name"],
    [{ sort: "first", status: "disabled" }, "idou_admin_people_first"],
    [{ sort: "active", departmentPaths: ["/od-a/od-b/"] }, "idou_admin_people_active"],
    [{ sort: "name", departmentPaths: ["/od-a/", "/od-c/"], status: "enabled" }, "idou_admin_people_name"],
  ]) {
    const { sql, params } = peopleQuery("sqlite", { tenantId: TENANT, ...filter });
    const plan = (await db.all(`EXPLAIN QUERY PLAN ${sql}`, params)).map((row) => row.detail).join(" | ");
    assert.match(plan, new RegExp(`USING (COVERING )?INDEX ${index} \\(tenant=\\?`), `${JSON.stringify(filter)}: ${plan}`);
    assert.doesNotMatch(plan, /TEMP B-TREE FOR ORDER BY/, plan);
    // A department's people are listed once, not again for every person read.
    assert.doesNotMatch(plan, /CORRELATED LIST SUBQUERY/, `${JSON.stringify(filter)}: ${plan}`);
  }
});

test("roles: the configured owner always, the group's members as administrators, granted roles from the database, and a disabled person as nobody", async (t) => {
  const db = await database(t, "sqlite");
  const access = await AccessList.open({ db });
  const group = { members: ["ou_chat1", "ou_chat2"], fail: false };
  const directory = new AdminDirectory({ users: ["ou_owner"], chatId: "oc_admins", readChatMembers: async () => { if (group.fail) throw new Error("bot not in group"); return group.members; } });
  const roles = await AdminRoles.open({ db, directory, access });
  t.after(() => { roles.close(); access.close(); });
  const who = (userId) => ({ tenantId: TENANT, userId });
  assert.deepEqual(await roles.decide(who("ou_owner")), { role: "owner", source: "configured", scope: null });
  assert.deepEqual(await roles.decide(who("ou_chat1")), { role: "admin", source: "chat", scope: null });
  assert.equal((await roles.decide(who("ou_stranger"))).reason, "not-in-chat");
  await roles.grant({ tenantId: TENANT, userId: "ou_auditor", role: "auditor", by: { userId: "ou_owner", name: "甲" } });
  await roles.grant({ tenantId: TENANT, userId: "ou_chat2", role: "owner", by: { userId: "ou_owner" } });
  assert.deepEqual(await roles.decide(who("ou_auditor")), { role: "auditor", source: "granted", scope: null });
  assert.deepEqual(await roles.decide(who("ou_chat2")), { role: "owner", source: "granted", scope: null }, "the higher of the two");
  assert.equal((await roles.decide({ tenantId: "tenant-b", userId: "ou_auditor" })).role, null, "a role is for its tenant");
  await assert.rejects(roles.grant({ tenantId: TENANT, userId: "ou_owner", role: "auditor", by: {} }), /配置文件里的超级管理员/);
  await assert.rejects(roles.grant({ tenantId: TENANT, userId: "ou_x", role: "root", by: {} }), /没有这个角色/);
  group.fail = true; directory.cached = null;
  assert.deepEqual(await roles.decide(who("ou_auditor")), { role: "auditor", source: "granted", scope: null }, "a granted role does not need the group");
  assert.equal((await roles.decide(who("ou_chat1"))).reason, "directory-unreadable", "fail closed for the group's members");
  group.fail = false; directory.cached = null;
  await access.disable([who("ou_chat1"), who("ou_owner")], { by: { userId: "ou_x" } });
  assert.equal((await roles.decide(who("ou_chat1"))).reason, "disabled");
  assert.equal((await roles.decide(who("ou_owner"))).role, "owner", "the way back in is never shut from inside");
  assert.deepEqual(await roles.revoke({ tenantId: TENANT, userId: "ou_auditor" }), { before: "auditor", after: null });
  assert.equal((await roles.decide(who("ou_auditor"))).role, null);
  assert.deepEqual(roles.list(TENANT).map((entry) => [entry.userId, entry.role]), [["ou_chat2", "owner"]]);
  assert.deepEqual(await roles.revoke({ tenantId: TENANT, userId: "ou_nobody" }), { before: null, after: null });
  assert.ok(can("auditor", "audit.export") && !can("auditor", "people.manage") && !can("admin", "roles.manage") && can("owner", "roles.manage"));
  assert.deepEqual(Object.keys(PERMISSIONS), ["owner", "admin", "auditor"]);
});

test("roles limited to departments: kept with the role, never for an owner, and the group's administrators have the whole tenant", async (t) => {
  const db = await database(t, "sqlite");
  const directory = new AdminDirectory({ users: ["ou_owner"], chatId: "oc_admins", readChatMembers: async () => ["ou_chat1"] });
  const roles = await AdminRoles.open({ db, directory });
  t.after(() => roles.close());
  const who = (userId) => ({ tenantId: TENANT, userId });
  await roles.grant({ tenantId: TENANT, userId: "ou_lead", role: "admin", scope: ["od-rd", "od-rd", "od-sales"], by: { userId: "ou_owner" } });
  assert.deepEqual(await roles.decide(who("ou_lead")), { role: "admin", source: "granted", scope: ["od-rd", "od-sales"] });
  assert.deepEqual(roles.list(TENANT)[0].scope, ["od-rd", "od-sales"]);
  // In the administrator group as well: the group's role is the whole tenant.
  await roles.grant({ tenantId: TENANT, userId: "ou_chat1", role: "admin", scope: ["od-rd"], by: { userId: "ou_owner" } });
  assert.deepEqual(await roles.decide(who("ou_chat1")), { role: "admin", source: "chat", scope: null });
  // Granted again without a scope: the whole tenant.
  await roles.grant({ tenantId: TENANT, userId: "ou_lead", role: "auditor", by: { userId: "ou_owner" } });
  assert.deepEqual(await roles.decide(who("ou_lead")), { role: "auditor", source: "granted", scope: null });
  await assert.rejects(roles.grant({ tenantId: TENANT, userId: "ou_x", role: "owner", scope: ["od-rd"], by: {} }), /不能限定部门/);
  await assert.rejects(roles.grant({ tenantId: TENANT, userId: "ou_x", role: "admin", scope: ["od rd"], by: {} }), /部门无效/);
  await assert.rejects(roles.grant({ tenantId: TENANT, userId: "ou_x", role: "admin", scope: Array.from({ length: ROLE_LIMITS.scopeDepartments + 1 }, (_, i) => `od-${i}`), by: {} }), /最多/);
});
