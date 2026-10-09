// The administration database (admin-db.js) and the audit trail on it
// (audit-log.js), on this machine's SQLite and on a PostgreSQL of the test's
// own -- every behaviour case runs on both, as the stores of the shared data do.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { openAdminDatabase, numbered } from "../src/control-plane/admin-db.js";
import { AuditLog, AUDIT_COLUMNS, AUDIT_LIMITS, auditDetail, auditRow, auditCursor, auditQuery } from "../src/control-plane/audit-log.js";
import { testPostgres } from "./helpers/postgres.js";

const KINDS = ["sqlite", "postgres"];
const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 2, 3, 0, 0);

async function database(t, kind, { legacy = false } = {}) {
  if (kind === "postgres") {
    const settings = await (await postgres()).database();
    const pools = [];
    const pool = () => { const made = new pg.Pool({ ...settings, max: 4 }); made.on("error", () => {}); pools.push(made); return made; };
    const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
    const raw = pool();
    if (legacy) await raw.query("CREATE TABLE mydoubao_state (namespace text)");
    const opened = [];
    const open = async () => { const db = await openAdminDatabase({ pool: pool(), connect }); opened.push(db); return db; };
    t.after(async () => { for (const db of opened) await db.close(); for (const made of pools) await made.end(); });
    return { open, raw: (sql, params) => raw.query(sql, params) };
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-admin-db-"));
  const file = path.join(directory, "admin.sqlite");
  const opened = [];
  const open = async () => { const db = await openAdminDatabase({ file }); opened.push(db); return db; };
  t.after(async () => { for (const db of opened) await db.close(); await rm(directory, { recursive: true, force: true }); });
  return { open, raw: null };
}

const event = (overrides = {}) => ({
  tenant: "tenant-a", category: "admin", action: "admin.person.disable",
  actor: { kind: "admin", id: "ou_admin1", name: "管理员甲" }, target: { kind: "person", id: "ou_person1", name: "张三" },
  outcome: "ok", detail: { reason: "离职" }, source: "admin-console", address: "10.0.0.8", ...overrides,
});

test("placeholders are numbered outside quoted text only", () => {
  assert.equal(numbered("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?"), "SELECT * FROM t WHERE a = $1 AND b = '?' AND c = $2");
});

test("a detail keeps short scalar fields and nothing that could carry a body", () => {
  const detail = JSON.parse(auditDetail({ count: 3, reason: "x".repeat(500), nested: { prompt: "secret words" }, list: ["a", { b: 1 }], ok: true, "bad key": 1 }));
  assert.equal(detail.count, 3);
  assert.equal(detail.reason.length, 200);
  assert.equal(detail.nested, undefined, "no nested object, whatever it is called");
  assert.equal(detail.list, undefined, "no array holding anything but scalars");
  assert.equal(detail["bad key"], undefined);
  const huge = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`field${index}`, "y".repeat(200)]));
  assert.ok(Buffer.byteLength(auditDetail(huge)) <= AUDIT_LIMITS.detailBytes);
  assert.equal(JSON.parse(auditDetail(huge)).truncated, true);
});

test("an event that is not one is refused, not stored somewhere unfindable", () => {
  assert.throws(() => auditRow(event({ category: "chat" })), /Unknown audit category/);
  assert.throws(() => auditRow(event({ action: "Admin Disable" })), /Invalid audit action/);
  assert.throws(() => auditRow(event({ outcome: "maybe" })), /Invalid audit outcome/);
  assert.throws(() => auditRow(event({ actor: { kind: "robot" } })), /Invalid audit actor/);
  assert.equal(auditCursor.decode("not-a-cursor"), null);
});

for (const kind of KINDS) test(`${kind}: the table holds exactly the audited columns -- none that could hold what somebody said`, async (t) => {
  const { open, raw } = await database(t, kind);
  const db = await open();
  await AuditLog.open({ db, now: () => T0 });
  const columns = kind === "postgres"
    ? (await raw("SELECT column_name FROM information_schema.columns WHERE table_name = 'idou_admin_audit'")).rows.map((row) => row.column_name)
    : (await db.all("SELECT name FROM pragma_table_info('idou_admin_audit')")).map((row) => row.name);
  assert.deepEqual(columns.sort(), [...AUDIT_COLUMNS].sort());
});

for (const kind of KINDS) test(`${kind}: events are written in batches, read newest first, a page at a time, and only the tenant's own`, async (t) => {
  const { open } = await database(t, kind);
  const clock = { at: T0 };
  const audit = await AuditLog.open({ db: await open(), now: () => clock.at });
  for (let index = 0; index < 120; index += 1) {
    clock.at = T0 + index * 1000;
    audit.record(event({ target: { kind: "person", id: `ou_person${index % 7}`, name: `人${index}` }, detail: { index } }));
  }
  audit.record(event({ tenant: "tenant-b", detail: { index: -1 } }));
  assert.equal(audit.pending, 121);
  await audit.flush();
  assert.equal(audit.pending, 0);
  const seen = [];
  let cursor = null;
  do {
    const page = await audit.query({ tenantId: "tenant-a", from: T0, to: T0 + DAY, cursor, limit: 50 });
    seen.push(...page.rows);
    cursor = page.next;
  } while (cursor);
  assert.equal(seen.length, 120, "every row once, across pages");
  assert.deepEqual(seen.map((row) => row.detail.index), Array.from({ length: 120 }, (_, index) => 119 - index), "newest first");
  assert.ok(seen.every((row) => row.tenant === "tenant-a"));
  const one = seen[0];
  assert.deepEqual({ actor: one.actor, outcome: one.outcome, address: one.address }, { actor: { kind: "admin", id: "ou_admin1", name: "管理员甲" }, outcome: "ok", address: "10.0.0.8" });
  const target = await audit.query({ tenantId: "tenant-a", from: T0, to: T0 + DAY, targetId: "ou_person3", limit: 200 });
  assert.equal(target.rows.length, 17);
  assert.ok(target.rows.every((row) => row.target.id === "ou_person3"));
  assert.equal((await audit.query({ tenantId: "tenant-a", from: T0, to: T0 + 30_000 })).rows.length, 30, "the time range is half-open and honoured");
  await assert.rejects(audit.query({ tenantId: "tenant-a", from: T0, to: T0 + DAY, cursor: "garbage" }), /翻页位置无效/);
  await assert.rejects(audit.query({ tenantId: "tenant-a" }), /时间范围/);
  await audit.close();
});

for (const kind of KINDS) test(`${kind}: filters by person, category and outcome, and an administrator's action is stored before it returns`, async (t) => {
  const { open } = await database(t, kind);
  const audit = await AuditLog.open({ db: await open(), now: () => T0 });
  await audit.write(event());
  audit.record(event({ category: "auth", action: "auth.sign-in", actor: { kind: "person", id: "ou_person1", name: "张三" }, target: {} }));
  audit.record(event({ category: "auth", action: "auth.refused", actor: { kind: "person", id: "ou_person2", name: "李四" }, outcome: "refused", detail: { reason: "account_disabled" } }));
  // Before any flush: the administrator's own action is already there.
  assert.equal((await audit.query({ tenantId: "tenant-a", from: T0 - 1, to: T0 + 1 })).rows.length, 1);
  await audit.flush();
  assert.equal((await audit.query({ tenantId: "tenant-a", from: T0 - 1, to: T0 + 1, category: "auth" })).rows.length, 2);
  assert.equal((await audit.query({ tenantId: "tenant-a", from: T0 - 1, to: T0 + 1, actorId: "ou_person2" })).rows[0].detail.reason, "account_disabled");
  assert.equal((await audit.query({ tenantId: "tenant-a", from: T0 - 1, to: T0 + 1, outcome: "refused" })).rows.length, 1);
  assert.equal((await audit.query({ tenantId: "tenant-a", from: T0 - 1, to: T0 + 1, action: "auth.sign-in" })).rows.length, 1);
  await assert.rejects(audit.query({ tenantId: "tenant-a", from: T0 - 1, to: T0 + 1, category: "chat" }), /没有这个类别/);
  await assert.rejects(audit.write(event({ category: "chat" })), /Unknown audit category/);
  assert.equal(audit.record(event({ category: "chat" })), false, "a bad event from a component is dropped and logged, never thrown at it");
  await audit.close();
});

for (const kind of KINDS) test(`${kind}: an export reads every row a page at a time, and refuses more than a month at once`, async (t) => {
  const { open } = await database(t, kind);
  const clock = { at: T0 };
  const audit = await AuditLog.open({ db: await open(), now: () => clock.at });
  for (let index = 0; index < 450; index += 1) { clock.at = T0 + index; audit.record(event({ detail: { index } })); }
  await audit.flush();
  const rows = [];
  for await (const row of audit.rows({ tenantId: "tenant-a", from: T0, to: T0 + DAY })) rows.push(row.detail.index);
  assert.equal(rows.length, 450);
  assert.equal(rows[0], 449);
  await assert.rejects(async () => { for await (const row of audit.rows({ tenantId: "tenant-a", from: T0, to: T0 + 40 * DAY })) void row; }, /一次最多导出 31 天/);
  await audit.close();
});

for (const kind of KINDS) test(`${kind}: what is older than the retention goes, and nothing younger`, async (t) => {
  const { open, raw } = await database(t, kind);
  const clock = { at: T0 - 200 * DAY };
  const audit = await AuditLog.open({ db: await open(), retentionDays: 180, now: () => clock.at });
  for (const daysAgo of [200, 181, 179, 1, 0]) { clock.at = T0 - daysAgo * DAY; await audit.write(event({ detail: { daysAgo } })); }
  clock.at = T0;
  await audit.prune();
  const left = (await audit.query({ tenantId: "tenant-a", from: T0 - 400 * DAY, to: T0 + DAY, limit: 200 })).rows.map((row) => row.detail.daysAgo);
  assert.deepEqual(left, [0, 1, 179]);
  if (kind === "postgres") {
    const partitions = (await raw(`SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'idou_admin_audit' ORDER BY 1`)).rows.map((row) => row.relname);
    assert.ok(partitions.every((name) => name >= `idou_admin_audit_p${new Date(T0 - 180 * DAY).toISOString().slice(0, 10).replaceAll("-", "")}`), "old days are dropped as whole partitions");
    assert.ok(partitions.includes(`idou_admin_audit_p${new Date(T0 + 7 * DAY).toISOString().slice(0, 10).replaceAll("-", "")}`), "and the coming week is made ahead");
  }
  await audit.close();
});

test("postgres: a database from before the rename keeps its own names, a day with no partition yet gets one, and a week reads a week", async (t) => {
  const { open, raw } = await database(t, "postgres", { legacy: true });
  const clock = { at: T0 };
  const audit = await AuditLog.open({ db: await open(), now: () => clock.at });
  clock.at = T0 + 30 * DAY;   // past the partitions made at start
  await audit.write(event());
  assert.equal((await raw("SELECT count(*)::int AS n FROM mydoubao_admin_audit")).rows[0].n, 1);
  assert.equal((await raw("SELECT to_regclass('idou_admin_audit') AS t")).rows[0].t, null, "no idou_ table beside the old ones");
  const plan = (await raw(`EXPLAIN SELECT * FROM mydoubao_admin_audit WHERE tenant = 'tenant-a' AND at >= ${T0} AND at < ${T0 + 2 * DAY}`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
  assert.ok(!plan.includes(new Date(T0 + 30 * DAY).toISOString().slice(0, 10).replaceAll("-", "")), "partitions outside the range are not read");
  await audit.close();
});

test("postgres: a change announced by one process is heard by another", async (t) => {
  const { open } = await database(t, "postgres");
  const [one, two] = [await open(), await open()];
  const heard = new Promise((resolve) => two.on("change", (change) => { if (!change.local) resolve(change); }));
  await one.announce("access", { revision: 7 });
  assert.deepEqual(await heard, { topic: "access", detail: { revision: 7 }, local: false });
});

for (const kind of KINDS) test(`${kind}: a transaction that fails leaves nothing behind`, async (t) => {
  const { open } = await database(t, kind);
  const db = await open();
  await db.exec("CREATE TABLE idou_admin_probe (id integer PRIMARY KEY, value text)");
  await assert.rejects(db.transaction(async (tx) => {
    await tx.run("INSERT INTO idou_admin_probe (id, value) VALUES (?, ?)", [1, "one"]);
    throw new Error("halfway");
  }), /halfway/);
  assert.equal((await db.all("SELECT * FROM idou_admin_probe")).length, 0);
  await db.transaction(async (tx) => { await tx.run("INSERT INTO idou_admin_probe (id, value) VALUES (?, ?)", [1, "one"]); });
  assert.equal((await db.get("SELECT value FROM idou_admin_probe WHERE id = ?", [1])).value, "one");
});

test("sqlite: the listings an administrator runs are answered from an index, not by reading the whole history", async (t) => {
  const { open } = await database(t, "sqlite");
  const db = await open();
  await AuditLog.open({ db, now: () => T0 });
  // The statements the log itself sends, asked of SQLite as they are.
  const plan = async (filter) => {
    const { sql, params } = auditQuery("sqlite", { tenantId: "a", from: 1, to: 2, ...filter });
    return (await db.all(`EXPLAIN QUERY PLAN ${sql}`, params)).map((row) => row.detail).join(" | ");
  };
  const cursor = auditCursor.encode({ at: 1, id: 5 });
  const cases = [
    [{}, "idou_admin_audit_time"],
    [{ cursor }, "idou_admin_audit_time"],
    [{ actorId: "ou_x" }, "idou_admin_audit_actor"],
    [{ actorId: "ou_x", category: "auth", cursor }, "idou_admin_audit_actor"],
    [{ category: "auth" }, "idou_admin_audit_category"],
    [{ targetId: "doc" }, "idou_admin_audit_target"],
    [{ outcome: "refused" }, "idou_admin_audit_time"],
  ];
  for (const [filter, index] of cases) {
    const text = await plan(filter);
    assert.match(text, new RegExp(`USING (COVERING )?INDEX ${index} \\(tenant=\\?`), `${JSON.stringify(filter)}: ${text}`);
    assert.doesNotMatch(text, /USE TEMP B-TREE FOR ORDER BY/, `${JSON.stringify(filter)} sorts in the index: ${text}`);
  }
});
