// The administration database on a PostgreSQL made before the product was
// renamed -- the production server's is one: its sessions went into
// mydoubao_* tables in September. Every store the console opens, and the
// queries that put SQL together from parts (a department's people, an
// administrator's scope over the audit trail), has to land on mydoubao_admin_*
// there, and not one idou_* table may appear beside them
// (database-names.js). The audit log alone was checked this way before.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { AccessList } from "../src/control-plane/access-list.js";
import { AuditLog } from "../src/control-plane/audit-log.js";
import { PeopleDirectory } from "../src/control-plane/people-directory.js";
import { AdminRoles } from "../src/control-plane/admin-roles.js";
import { PolicyStore } from "../src/control-plane/policy.js";
import { OrgDirectory } from "../src/control-plane/org-directory.js";
import { SiteSafety } from "../src/control-plane/site-safety.js";
import { testPostgres } from "./helpers/postgres.js";

const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
const TENANT = "tenant-a";

test("on a database from before the rename, every console store and every query built from parts uses its old names, and makes no new ones", async (t) => {
  const settings = await (await testPostgres({ after: (stop) => stops.push(stop) })).database();
  const raw = new pg.Pool({ ...settings, max: 2 }); raw.on("error", () => {});
  const pool = new pg.Pool({ ...settings, max: 4 }); pool.on("error", () => {});
  const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
  t.after(async () => { await pool.end(); await raw.end(); });
  // What makes it a database from before the rename: a table of the old name.
  await raw.query("CREATE TABLE mydoubao_state (namespace text)");
  const db = await openAdminDatabase({ pool, connect });
  t.after(() => db.close());
  const access = await AccessList.open({ db }), audit = await AuditLog.open({ db }), people = await PeopleDirectory.open({ db });
  const roles = await AdminRoles.open({ db, access }), policy = await PolicyStore.open({ db, models: ["MiniMax-M3"] }), org = await OrgDirectory.open({ db });
  const safety = await SiteSafety.open({ db, key: "a-server-key-of-thirty-two-bytes!" });
  t.after(async () => { await safety.close(); org.close(); policy.close(); roles.close(); access.close(); await audit.close(); await people.close(); });

  await org.replaceDepartments(TENANT, [{ id: "od-rd", parentId: "", name: "研发中心", path: "/od-rd/", depth: 1, memberCount: 1 }]);
  await org.recordPeople(TENANT, [{ userId: "ou_alice", employment: "resigned", departments: ["od-rd"] }]);
  people.seen({ tenantId: TENANT, userId: "ou_alice", name: "Alice", signIn: true }); await people.flush();
  await access.disable([{ tenantId: TENANT, userId: "ou_alice" }], { reason: "离职", by: { userId: "ou_admin" } });
  await roles.grant({ tenantId: TENANT, userId: "ou_lead", role: "admin", scope: ["od-rd"], by: { userId: "ou_owner" } });
  await policy.create({ tenantId: TENANT, target: { kind: "department", id: "od-rd" }, settings: { quota: { dailyTokens: 1000 } }, by: { userId: "ou_owner" } });
  await audit.write({ tenant: TENANT, category: "admin", action: "admin.person.disable", outcome: "ok", source: "admin-console", actor: { kind: "admin", id: "ou_admin" }, target: { kind: "person", id: "ou_alice", name: "Alice" } });

  // The queries put together from parts, each answered from the old tables.
  const paths = ["/od-rd/"], now = Date.now();
  assert.deepEqual((await people.list({ tenantId: TENANT, departmentPaths: paths })).people.map((person) => person.userId), ["ou_alice"]);
  assert.equal((await people.stats(TENANT, now, { departmentPaths: paths })).total, 1);
  assert.equal((await audit.query({ tenantId: TENANT, from: now - 60_000, to: now + 60_000, within: { paths, self: "ou_lead" } })).rows.length, 1);
  assert.deepEqual([...(await org.within(TENANT, ["ou_alice", "ou_bob"], paths))], ["ou_alice"]);
  assert.equal((await org.departed({ tenantId: TENANT, paths })).length, 1);
  assert.equal(await org.pendingCount(TENANT, paths), 1);
  assert.equal(await org.markCleaned(TENANT, ["ou_alice"]), 1);
  assert.deepEqual((await roles.decide({ tenantId: TENANT, userId: "ou_lead" })).scope, ["od-rd"]);
  // Content safety for published sites: rules, a check, a day's visits.
  const site = { id: "00000000-0000-4000-8000-000000000001", name: "联系表", ownerId: "ou_alice" };
  await safety.setRules(TENANT, { keywords: ["机密"] }, { userId: "ou_owner", name: "管理员" });
  const check = await safety.assess({ tenantId: TENANT, site, audience: "public", trigger: "publish", version: "v1",
    files: [{ path: "index.html", bytes: Buffer.from("<p>联系 13812345678</p>") }] });
  assert.equal(check.outcome, "review");
  assert.equal(await safety.decide(TENANT, check.id, { decision: "approved", by: { userId: "ou_owner", name: "管理员" } }), true);
  assert.deepEqual((await safety.checks({ tenantId: TENANT, siteIds: [site.id] })).checks.map((row) => row.id), [check.id]);
  assert.equal((await safety.latest(TENANT, [site.id])).get(site.id).id, check.id);
  safety.countVisit(TENANT, site.id, { anonymous: true }); await safety.flushVisits();
  assert.equal((await safety.visits(TENANT, [site.id], 7)).get(site.id).visits, 1);

  const tables = (await raw.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = current_schema() ORDER BY tablename")).rows.map((row) => row.tablename);
  assert.deepEqual(tables.filter((name) => name.startsWith("idou")), [], "no table of the new name beside the old ones");
  for (const name of ["mydoubao_admin_people", "mydoubao_admin_access", "mydoubao_admin_roles", "mydoubao_admin_policies", "mydoubao_admin_departments",
    "mydoubao_admin_org_people", "mydoubao_admin_org_membership", "mydoubao_admin_org_sync", "mydoubao_admin_audit",
    "mydoubao_admin_site_rules", "mydoubao_admin_site_checks", "mydoubao_admin_site_visits"]) assert.ok(tables.includes(name), `${name} is where it should be`);
});
