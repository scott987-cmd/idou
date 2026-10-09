// Visits of a site, for the person who published it (docs/sites-phase1.md §1.5).
import test from "node:test";
import assert from "node:assert/strict";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { SiteVisitors, VISITOR_LIMITS, visitSource } from "../src/control-plane/site-visitors.js";

const DAY = 86_400_000;
async function visitors(t, { clock } = {}) {
  const db = await openAdminDatabase();
  const departments = { ou_a: "od-sales", ou_b: "od-sales", ou_c: "od-sales", ou_d: "od-legal", ou_e: null };
  const store = await SiteVisitors.open({ db, key: "a-server-key-of-thirty-two-bytes!", now: () => clock.at,
    departmentOf: async (who) => departments[who.userId] ?? null,
    named: async (_tenant, ids) => ids.map((id) => ({ id, name: { "od-sales": "销售部", "od-legal": "法务部" }[id] })) });
  t.after(async () => { store.close(); await db.close(); });
  return store;
}

test("people are counted once a day, views every time; departments too small to hide anybody are shown together", async (t) => {
  const clock = { at: Date.parse("2026-10-04T08:00:00Z") };
  const store = await visitors(t, { clock });
  const open = (userId, source = "direct") => store.view({ tenantId: "t1", siteId: "s1", visitor: userId ? { tenantId: "t1", userId } : null, source });
  for (const user of ["ou_a", "ou_a", "ou_b", "ou_c", "ou_d", "ou_e"]) await open(user, user === "ou_b" ? "feishu" : "direct");
  await open(null); await open(null);
  clock.at += DAY;
  await open("ou_a", "qr");
  await store.view({ tenantId: "t1", siteId: "other", visitor: { tenantId: "t1", userId: "ou_a" } });
  const seen = await store.stats("t1", "s1");
  assert.equal(seen.days.length, VISITOR_LIMITS.periodDays, "every day of the period, quiet ones too");
  assert.deepEqual(seen.days.slice(-2).map((day) => [day.views, day.people]), [[8, 5], [1, 1]]);
  assert.deepEqual([seen.views, seen.people, seen.anonymous], [9, 5, 2]);
  assert.deepEqual(seen.sources, { feishu: 1, qr: 1, direct: 7 });
  // 销售部 has three people: shown. 法务部 has one: with the others, never by name.
  assert.deepEqual(seen.departments, [{ name: "销售部", people: 3 }, { name: "其他部门", people: 1, others: true }]);
  assert.equal(JSON.stringify(seen).includes("ou_"), false, "nobody's id in what the publisher sees");
});

test("what is older than kept goes, and a busy page is held in memory between writes", async (t) => {
  const clock = { at: Date.parse("2026-06-01T08:00:00Z") };
  const store = await visitors(t, { clock });
  await store.view({ tenantId: "t1", siteId: "s1", visitor: { tenantId: "t1", userId: "ou_a" } });
  await store.flush();
  clock.at += (VISITOR_LIMITS.keepDays + 2) * DAY;
  await store.view({ tenantId: "t1", siteId: "s1", visitor: { tenantId: "t1", userId: "ou_b" } });
  await store.flush();
  const rows = await store.db.all("SELECT day FROM idou_site_visitors");
  assert.deepEqual(rows.map((row) => row.day), [new Date(clock.at).toISOString().slice(0, 10)]);
});

test("where a visit came from", () => {
  assert.equal(visitSource({ from: "qr", userAgent: "Mozilla/5.0 Lark/7.1" }), "qr");
  assert.equal(visitSource({ userAgent: "Mozilla/5.0 (Macintosh) Feishu/7.30.6" }), "feishu");
  assert.equal(visitSource({ userAgent: "Mozilla/5.0 Chrome/141" }), "direct");
  assert.equal(visitSource({ userAgent: "Mozilla/5.0 Larkspur" }), "direct", "a word that only starts like it is not it");
});
