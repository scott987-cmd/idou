// The administration console's listener and routes (admin-server.js,
// admin-api.js), against real stores on an in-memory administration database:
// who may sign in, that every request is decided again, that a change has to
// come from the console's own page, and what each role may do.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac, randomBytes } from "node:crypto";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { AccessList } from "../src/control-plane/access-list.js";
import { AuditLog } from "../src/control-plane/audit-log.js";
import { PeopleDirectory } from "../src/control-plane/people-directory.js";
import { AdminRoles } from "../src/control-plane/admin-roles.js";
import { AdminDirectory } from "../src/control-plane/admin-directory.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { ModelUsage } from "../src/control-plane/model-usage.js";
import { createAdminServer, loadAdminAssets, ADMIN_SERVER_LIMITS } from "../src/control-plane/admin-server.js";
import { createAdminApi, csvRow, ROUTE_KINDS } from "../src/control-plane/admin-api.js";
import { systemState } from "../src/control-plane/admin-console.js";
import { PolicyStore, PolicyEngine } from "../src/control-plane/policy.js";
import { OrgDirectory } from "../src/control-plane/org-directory.js";
import { CONTACT_SCOPES } from "../src/control-plane/org-sync.js";
import { SiteSafety, scheduleRescans } from "../src/control-plane/site-safety.js";
// The server's re-reads with timers that never fire: the console needs them wired, these tests do not run them.
const idleRescans = (registry, safety) => scheduleRescans({ registry, safety, timers: { set: () => null, clear: () => {} } });

const TENANT = "tenant-a";
const ORIGIN = "http://localhost:3045";
const OWNER = "ou_owner", ADMIN = "ou_admin", AUDITOR = "ou_auditor", PERSON = "ou_person", OTHER = "ou_other";

async function consoleServer(t, { allowlist = null, apiOptions = {}, withPolicy = false, withOrg = false } = {}) {
  const db = await openAdminDatabase();
  let org = null;
  if (withOrg) { org = await OrgDirectory.open({ db }); t.after(() => org.close()); apiOptions = { ...apiOptions, org }; }
  if (withPolicy) {
    const store = await PolicyStore.open({ db, models: ["MiniMax-M3", "GLM-5.3"] });
    const engine = new PolicyEngine({ store, models: ["MiniMax-M3", "GLM-5.3"], ceilings: { mediaVideo: false }, org });
    t.after(() => store.close());
    apiOptions = { ...apiOptions, policy: { store, engine, models: ["MiniMax-M3", "GLM-5.3"], ceilings: engine.ceilings } };
  }
  const access = await AccessList.open({ db });
  const audit = await AuditLog.open({ db });
  const people = await PeopleDirectory.open({ db });
  const decided = [];
  const directory = new AdminDirectory({ users: [OWNER], chatId: "oc_admins", readChatMembers: async () => [ADMIN] });
  const roles = await AdminRoles.open({ db, directory, access });
  const spied = { decide: roles.decide.bind(roles) };
  roles.decide = async (visitor) => { decided.push(visitor.userId); return spied.decide(visitor); };
  await roles.grant({ tenantId: TENANT, userId: AUDITOR, role: "auditor", by: { userId: OWNER } });
  const sessions = new SessionRegistry({ access });
  const usage = await ModelUsage.open({});
  for (const [userId, name] of [[PERSON, "张三"], [OTHER, "=HYPERLINK(\"x\")"], [ADMIN, "管理员乙"], [OWNER, "超管甲"]]) people.seen({ tenantId: TENANT, userId, name, signIn: true });
  people.seen({ tenantId: "tenant-b", userId: "ou_elsewhere", name: "别的租户", signIn: true });
  await people.flush();
  usage.record({ who: { tenantId: TENANT, userId: PERSON }, model: "MiniMax-M3", usage: { input_tokens: 1000, output_tokens: 500 } });
  const api = createAdminApi({ people, access, roles, audit, usage: usage.reports, sessions, appId: "cli_synthetic",
    system: async () => systemState({ release: "0.1.0-test", models: [{ id: "MiniMax-M3", isDefault: true }] }), ...apiOptions });
  const siteKey = randomBytes(32);
  const flows = [];
  const oauth = {
    authorizationUrl: ({ state, scopes, redirectUri }) => { flows.push({ state, scopes, redirectUri }); return `https://accounts.example/authorize?state=${state}`; },
    probeIdentity: async ({ code }) => ({ userId: code, tenantId: TENANT, name: { [OWNER]: "超管甲", [ADMIN]: "管理员乙", [AUDITOR]: "审计丙", [PERSON]: "张三" }[code] ?? "" }),
  };
  const server = createAdminServer({ origin: ORIGIN, cookieKey: siteKey, oauth, allowlist, roles, api, assets: await loadAdminAssets(), audit: (event) => audit.record(event) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); server.closeAllConnections(); roles.close(); access.close(); await audit.close(); await people.close(); usage.close(); await db.close(); });

  // Signing in the way a browser does: /admin, Feishu, the callback.
  const signIn = async (userId) => {
    const start = await fetch(`${base}/admin`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const back = await fetch(`${base}/_auth/callback?state=${state}&code=${userId}`, { redirect: "manual" });
    const cookie = back.headers.get("set-cookie")?.split(";")[0] ?? null;
    return { status: back.status, cookie, location: back.headers.get("location") };
  };
  const as = async (userId) => {
    const { cookie } = await signIn(userId);
    const me = await (await fetch(`${base}/admin/api/me`, { headers: { cookie } })).json();
    const call = (method, path, body, headers = {}) => fetch(`${base}/admin/api/${path}`, { method, headers: { cookie, origin: ORIGIN, "x-idou-csrf": me.csrf,
      ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { cookie, me, get: (path) => fetch(`${base}/admin/api/${path}`, { headers: { cookie } }), post: (path, body = {}, headers) => call("POST", path, body, headers), remove: (path) => call("DELETE", path, {}) };
  };
  return { base, server, db, access, audit, people, roles, sessions, decided, flows, signIn, as, siteKey, org };
}

test("signed out: the page sends to Feishu asking for no scopes, the API answers 401, and nothing else is served", async (t) => {
  const f = await consoleServer(t);
  const page = await fetch(`${f.base}/admin`, { redirect: "manual" });
  assert.equal(page.status, 302);
  assert.deepEqual(f.flows.at(-1).scopes, [], "identity only");
  assert.equal(f.flows.at(-1).redirectUri, `${ORIGIN}/_auth/callback`);
  const api = await fetch(`${f.base}/admin/api/me`);
  assert.equal(api.status, 401);
  assert.equal((await api.json()).error, "signed_out");
  assert.equal((await fetch(`${f.base}/`, { redirect: "manual" })).headers.get("location"), "/admin");
  for (const at of ["/s/00000000-0000-0000-0000-000000000000/", "/demo", "/anything"]) assert.equal((await fetch(`${f.base}${at}`)).status, 404, at);
  const script = await fetch(`${f.base}/admin/assets/app.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((await fetch(`${f.base}/admin/assets/app.js`, { headers: { "if-none-match": script.headers.get("etag") } })).status, 304);
  assert.equal((await fetch(`${f.base}/admin/assets/../../admin-api.js`)).status, 404);
});

test("only an administrator signs in; a refusal says why and is written down", async (t) => {
  const f = await consoleServer(t);
  const refused = await f.signIn(PERSON);
  assert.equal(refused.status, 403);
  assert.equal(refused.cookie, null, "no cookie for somebody who is not an administrator");
  const owner = await f.signIn(OWNER);
  assert.equal(owner.status, 302);
  assert.match(owner.cookie, /^idou_admin=/);
  await f.audit.flush();
  const lines = (await f.audit.query({ tenantId: TENANT, from: 0, to: Date.now() + 60_000, action: "admin.sign-in" })).rows;
  assert.deepEqual(lines.map((row) => [row.actor.id, row.outcome]).sort(), [[OWNER, "ok"], [PERSON, "refused"]]);
  const page = await fetch(`${f.base}/admin`, { headers: { cookie: owner.cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /i豆 管理后台/);
});

test("every request is decided again: taking the role back takes effect without waiting for the cookie", async (t) => {
  const f = await consoleServer(t);
  const auditor = await f.as(AUDITOR);
  assert.equal(auditor.me.role, "auditor");
  assert.deepEqual(auditor.me.permissions, ["view", "audit.export"]);
  const before = f.decided.length;
  await auditor.get("overview"); await auditor.get("people");
  assert.equal(f.decided.length - before, 2);
  await f.roles.revoke({ tenantId: TENANT, userId: AUDITOR });
  const after = await auditor.get("people");
  assert.equal(after.status, 403);
  assert.equal((await after.json()).error, "not_admin");
});

test("a change must come from the console's page: its origin, this sign-in's token, and JSON", async (t) => {
  const f = await consoleServer(t);
  const admin = await f.as(ADMIN);
  const path = `people/${PERSON}/sign-out`;
  assert.equal((await admin.post(path, {}, { origin: "https://evil.example" })).status, 403, "another origin");
  assert.equal((await admin.post(path, {}, { "x-idou-csrf": "forged" })).status, 403, "a token not given to this sign-in");
  const another = await f.as(ADMIN);
  assert.equal((await admin.post(path, {}, { "x-idou-csrf": another.me.csrf })).status, 403, "a token from another sign-in");
  const form = await fetch(`${f.base}/admin/api/${path}`, { method: "POST", headers: { cookie: admin.cookie, origin: ORIGIN, "x-idou-csrf": admin.me.csrf, "content-type": "application/x-www-form-urlencoded" }, body: "a=1" });
  assert.equal(form.status, 415);
  assert.equal((await admin.post(path)).status, 200);
});

test("a published site's sign-in is never the console's", async (t) => {
  const f = await consoleServer(t);
  const payload = Buffer.from(JSON.stringify({ u: OWNER, t: TENANT, e: Date.now() + 3_600_000 })).toString("base64url");
  const visitor = `${payload}.${createHmac("sha256", f.siteKey).update(payload).digest("base64url")}`;
  const v1Key = createHmac("sha256", f.siteKey).update("idou admin console cookie v1").digest();
  const oldConsole = `${payload}.${createHmac("sha256", v1Key).update(payload).digest("base64url")}`;
  for (const cookie of [`idou_site=${visitor}`, `mydoubao_site=${visitor}`, `idou_admin=${visitor}`, `idou_admin=${oldConsole}`]) {
    assert.equal((await fetch(`${f.base}/admin/api/me`, { headers: { cookie } })).status, 401, cookie.split("=")[0]);
  }
});

test("each role does what it may: the auditor reads and exports, changes nothing; only an owner grants roles", async (t) => {
  const f = await consoleServer(t);
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN), owner = await f.as(OWNER);
  assert.equal((await auditor.post(`people/${PERSON}/disable`, { reason: "x" })).status, 403);
  assert.equal((await auditor.get("audit/export")).status, 200);
  assert.equal((await admin.post("admins", { userId: PERSON, role: "auditor" })).status, 403, "an administrator does not grant roles");
  const granted = await owner.post("admins", { userId: PERSON, role: "auditor", note: "季度审计" });
  assert.equal(granted.status, 200);
  assert.equal((await owner.post("admins", { userId: OWNER, role: "auditor" })).status, 409, "not one's own role");
  const list = await (await owner.get("admins")).json();
  assert.deepEqual(list.granted.map((entry) => [entry.userId, entry.role, entry.name]).sort(), [[AUDITOR, "auditor", ""], [PERSON, "auditor", "张三"]]);
  assert.equal(list.configured[0].name, "超管甲");
  assert.equal((await owner.remove(`admins/${PERSON}`)).status, 200);
});

test("disabling someone signs them out everywhere, is refused for oneself and the configured owner, and is written down with the reason", async (t) => {
  const f = await consoleServer(t);
  const admin = await f.as(ADMIN);
  const session = f.sessions.issue({ tenantId: TENANT, userId: PERSON, deviceId: "d1", authProvider: "feishu", appId: "cli_synthetic", deviceProof: "ed25519-login" });
  assert.ok(f.sessions.verify(session.token));
  const disabled = await admin.post(`people/${PERSON}/disable`, { reason: "离职" });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).access.disabled, true);
  assert.equal(f.sessions.verify(session.token), null);
  assert.equal((await admin.post(`people/${ADMIN}/disable`, {})).status, 409);
  assert.equal((await admin.post(`people/${OWNER}/disable`, {})).status, 409);
  const listed = await (await admin.get("people?status=disabled")).json();
  assert.deepEqual(listed.people.map((person) => [person.userId, person.access.disabled, person.access.reason]), [[PERSON, true, "离职"]]);
  const detail = await (await admin.get(`people/${PERSON}`)).json();
  assert.equal(detail.access.disabled, true);
  assert.equal(detail.usage.byModel[0].tokens, 1500);
  const trail = await (await admin.get(`audit?category=admin&target=${PERSON}`)).json();
  assert.deepEqual(trail.rows.map((row) => [row.action, row.actor.id, row.detail.reason]), [["admin.person.disable", ADMIN, "离职"]]);
  assert.equal(trail.rows[0].target.name, "张三");
  const enabled = await admin.post(`people/${PERSON}/enable`);
  assert.equal((await enabled.json()).access.disabled, false);
  const bulk = await (await admin.post("people/bulk", { action: "disable", userIds: [PERSON, OTHER, ADMIN, OWNER], reason: "批量" })).json();
  assert.deepEqual({ changed: bulk.changed, skipped: bulk.skipped.sort() }, { changed: 2, skipped: [ADMIN, OWNER].sort() });
  assert.equal((await admin.post("people/bulk", { action: "explode", userIds: [PERSON] })).status, 400);
});

test("everything stays inside the administrator's tenant", async (t) => {
  const f = await consoleServer(t);
  const admin = await f.as(ADMIN);
  const everyone = await (await admin.get("people?limit=200")).json();
  assert.ok(everyone.people.every((person) => person.tenantId === TENANT));
  assert.equal(everyone.people.some((person) => person.userId === "ou_elsewhere"), false);
  const elsewhere = await (await admin.get("people/ou_elsewhere")).json();
  assert.equal(elsewhere.known, false, "a person of another tenant is unknown here");
});

test("exports are CSV that Excel opens, with nothing a spreadsheet would run", async (t) => {
  const f = await consoleServer(t);
  const owner = await f.as(OWNER);
  await owner.post(`people/${OTHER}/disable`, { reason: "=cmd|' /C calc'!A0" });
  await f.audit.flush();
  const answer = await owner.get(`audit/export?from=${Date.now() - 3_600_000}&to=${Date.now() + 60_000}`);
  assert.equal(answer.status, 200);
  assert.match(answer.headers.get("content-type"), /^text\/csv/);
  assert.match(answer.headers.get("content-disposition"), /attachment; filename="idou-audit-/);
  const bytes = Buffer.from(await answer.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "a BOM, so Excel reads it as UTF-8");
  const text = bytes.subarray(3).toString("utf8");
  assert.ok(text.startsWith("时间(UTC),类别,动作"), "then the header");
  assert.match(text, /'=HYPERLINK/, "a name that looks like a formula is quoted as text");
  assert.doesNotMatch(text.replace(/'=HYPERLINK/g, "").replace(/'=cmd/g, ""), /(^|,)=/m);
  assert.equal(csvRow(["a,b", "say \"hi\"", "+1", "-2", "@x", "plain"]), "\"a,b\",\"say \"\"hi\"\"\",'+1,'-2,'@x,plain\r\n");
  assert.equal((await owner.get(`audit/export?from=${Date.now() - 40 * 86_400_000}`)).status, 400, "more than a month at once");
  const usage = await (await owner.get("usage/export?days=7")).text();
  assert.match(usage, /张三,ou_person,1,1000,500,1500/);
  const exported = await (await owner.get("audit?action=admin.audit.export")).json();
  assert.equal(exported.rows.length, 1, "an export is itself written down");
});

test("too many requests from one administrator are slowed, and an address off the list learns nothing", async (t) => {
  const f = await consoleServer(t);
  const admin = await f.as(ADMIN);
  const answers = await Promise.all(Array.from({ length: ADMIN_SERVER_LIMITS.burst + 10 }, () => admin.get("me")));
  assert.ok(answers.some((answer) => answer.status === 429));
  const closed = await consoleServer(t, { allowlist: { allows: () => false } });
  const refused = await fetch(`${closed.base}/admin`, { redirect: "manual" });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("location"), null, "not even that there is a sign-in");
});

test("offboarding: previewed first, confirmed by the person's name, done after disabling them, and written down with what went", async (t) => {
  const asked = [];
  const inventory = { tasks: { schedules: 3, runs: 214 }, credential: { state: "active" }, model: "MiniMax-M3", sites: [{ id: "s1", name: "销售看板", offline: false }], reservations: [] };
  const f = await consoleServer(t, { apiOptions: {
    personData: async (who) => ({ ...inventory, who }),
    offboard: async (who) => { asked.push({ ...who, disabledFirst: f.access.isDisabled(who.tenantId, who.userId) });
      return { tasks: { schedules: 3, runs: 214 }, credential: true, model: true, reservations: 0, sitesOffline: [{ id: "s1", name: "销售看板" }], sessions: 2 }; } } });
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  assert.equal((await auditor.get(`people/${PERSON}/offboard`)).status, 403, "an auditor reads, never lets go of anything");
  const preview = await (await admin.get(`people/${PERSON}/offboard`)).json();
  assert.deepEqual({ confirm: preview.confirm, tasks: preview.inventory.tasks.schedules, app: preview.inventory.who.appId }, { confirm: "张三", tasks: 3, app: "cli_synthetic" });
  assert.equal(asked.length, 0, "a preview changes nothing");
  assert.equal((await admin.post(`people/${PERSON}/offboard`, { confirm: "李四" })).status, 409, "the wrong name");
  assert.equal(asked.length, 0);
  assert.equal((await admin.post(`people/${ADMIN}/offboard`, { confirm: "管理员乙" })).status, 409, "not oneself");
  const done = await admin.post(`people/${PERSON}/offboard`, { confirm: "张三" });
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).done, { tasks: 3, runs: 214, credential: true, model: true, reservations: 0, sitesOffline: 1, sessions: 2 });
  assert.deepEqual(asked, [{ tenantId: TENANT, userId: PERSON, appId: "cli_synthetic", disabledFirst: true }]);
  assert.equal(f.access.get(TENANT, PERSON).reason, "离职清理");
  const line = (await (await admin.get(`audit?action=admin.person.offboard`)).json()).rows[0];
  assert.deepEqual({ actor: line.actor.id, target: line.target.name, tasks: line.detail.tasks, sites: line.detail.sitesOffline }, { actor: ADMIN, target: "张三", tasks: 3, sites: 1 });
  const without = await consoleServer(t);
  assert.equal((await (await without.as(ADMIN)).get(`people/${PERSON}/offboard`)).status, 404, "a deployment without the stores has no offboarding here");
});

test("policies: read by every role, changed only by those who may, every change written down with before and after", async (t) => {
  const f = await consoleServer(t, { withPolicy: true });
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  const listed = await (await auditor.get("policies")).json();
  assert.equal(listed.rules.length, 0);
  assert.equal(listed.features.find((feature) => feature.key === "mediaVideo").offered, false, "the console says what the deployment does not offer");
  assert.equal(listed.features.find((feature) => feature.key === "fullAccess").clientEnforced, true);
  assert.equal((await auditor.post("policies", { target: { kind: "everyone" }, settings: { features: { mediaImage: false } } })).status, 403);
  const created = await admin.post("policies", { target: { kind: "user", id: PERSON }, settings: { quota: { dailyTokens: 2000000, downgradeTo: "GLM-5.3" }, features: { feishuDelete: false } }, note: "试用" });
  assert.equal(created.status, 200);
  const rule = (await created.json()).rule;
  assert.equal((await admin.post("policies", { target: { kind: "user", id: PERSON }, settings: { features: { mediaImage: false } } })).status, 400, "one rule per person");
  assert.equal((await admin.post("policies", { target: { kind: "everyone" }, settings: { models: { allowed: ["GPT-9"] } } })).status, 400);
  const changed = await fetch(`${f.base}/admin/api/policies/${rule.id}`, { method: "PUT", headers: { cookie: admin.cookie, origin: ORIGIN, "x-idou-csrf": admin.me.csrf, "content-type": "application/json" },
    body: JSON.stringify({ settings: { quota: { dailyTokens: 1000000, downgradeTo: "GLM-5.3" } } }) });
  assert.equal(changed.status, 200);
  const effective = await (await admin.get(`policies/effective?user=${PERSON}`)).json();
  assert.deepEqual(effective.effective.quota, { dailyTokens: 1000000, downgradeTo: "GLM-5.3", concurrency: null });
  assert.deepEqual(effective.effective.sources.dailyTokens, [rule.id], "and which rule decided it");
  assert.equal(effective.person.name, "张三");
  assert.equal((await admin.remove(`policies/${rule.id}`)).status, 200);
  const trail = (await (await admin.get("audit?category=admin&limit=10")).json()).rows.filter((row) => row.action.startsWith("admin.policy."));
  assert.deepEqual(trail.map((row) => row.action), ["admin.policy.delete", "admin.policy.update", "admin.policy.create"]);
  const update = trail[1];
  assert.match(update.detail.before, /每天 200 万 token，超额换 GLM-5.3/);
  assert.match(update.detail.after, /每天 100 万 token/);
  assert.equal(update.target.name, "张三");
});

test("the organisation: the tree a level at a time, people narrowed to a department and those under it, and what to turn on", async (t) => {
  const without = await consoleServer(t);
  const bare = await (await (await without.as(ADMIN)).get("org")).json();
  assert.deepEqual({ available: bare.available, scopes: bare.scopes.map((scope) => scope.scope) }, { available: false, scopes: CONTACT_SCOPES.map(([scope]) => scope) },
    "without a Feishu application the page still says what would be needed");

  const syncs = [];
  const f = await consoleServer(t, { withOrg: true, apiOptions: { orgSync: { sync: async (tenantId) => { syncs.push(tenantId); } } } });
  // 研发中心 ─┬─ 平台部 (od-a_b)      销售部
  //           └─ 应用部 (od-aXb)      and another tenant's department
  // "od-a_b" against "od-aXb": an unescaped "_" in a LIKE pattern matches any character.
  await f.org.replaceDepartments(TENANT, [
    { id: "od-rd", parentId: "", name: "研发中心", path: "/od-rd/", depth: 1, memberCount: 2, order: 1 },
    { id: "od-a_b", parentId: "od-rd", name: "平台部", path: "/od-rd/od-a_b/", depth: 2, memberCount: 1, order: 1 },
    { id: "od-aXb", parentId: "od-rd", name: "应用部", path: "/od-rd/od-aXb/", depth: 2, memberCount: 1, order: 2 },
    { id: "od-sales", parentId: "", name: "销售部", path: "/od-sales/", depth: 1, memberCount: 1, order: 2 },
  ]);
  await f.org.replaceDepartments("tenant-b", [{ id: "od-b", parentId: "", name: "别的租户的部门", path: "/od-b/", depth: 1, memberCount: 1 }]);
  await f.org.recordPeople(TENANT, [
    { userId: PERSON, employment: "active", departments: ["od-a_b"] },
    { userId: OTHER, employment: "resigned", departments: ["od-aXb"] },
    { userId: ADMIN, employment: "active", departments: ["od-sales"] },
  ]);
  await f.org.recordPeople("tenant-b", [{ userId: "ou_elsewhere", employment: "resigned", departments: ["od-b"] }]);

  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  assert.equal(admin.me.features.org, true);
  const page = await (await auditor.get("org")).json();
  assert.deepEqual({ available: page.available, canSync: page.canSync, departed: page.status.departed },
    { available: true, canSync: true, departed: 1 }, "the other tenant's leaver is not counted");
  assert.deepEqual(page.top.map((d) => [d.name, d.children]), [["研发中心", 2], ["销售部", 0]]);
  assert.deepEqual(page.pending.map((row) => [row.userId, row.name]), [[OTHER, "=HYPERLINK(\"x\")"]]);
  assert.deepEqual(page.cleaned, []);
  assert.deepEqual((await (await auditor.get("org/departments?parent=od-rd")).json()).departments.map((d) => d.name), ["平台部", "应用部"]);
  assert.deepEqual((await (await auditor.get("org/departments?parent=od-b")).json()).departments, [], "another tenant's tree is not unfolded here");
  const found = await (await auditor.get(`org/search?q=${encodeURIComponent("平台")}`)).json();
  assert.deepEqual(found.departments.map((d) => [d.id, d.trail]), [["od-a_b", ["研发中心", "平台部"]]]);
  assert.deepEqual((await (await auditor.get(`org/search?q=${encodeURIComponent("别的")}`)).json()).departments, []);

  const inDepartment = async (id) => {
    const response = await auditor.get(`people?department=${encodeURIComponent(id)}`);
    return response.status === 200 ? (await response.json()).people.map((person) => person.userId).sort() : response.status;
  };
  assert.deepEqual(await inDepartment("od-rd"), [OTHER, PERSON].sort(), "a department and those under it");
  assert.deepEqual(await inDepartment("od-a_b"), [PERSON], "only that department: '_' is a character, not a wildcard");
  assert.deepEqual(await inDepartment("od-sales"), [ADMIN]);
  assert.equal(await inDepartment("od-nowhere"), 400);
  assert.equal(await inDepartment("od-b"), 400, "another tenant's department is no department here");
  const person = await (await auditor.get(`people/${PERSON}`)).json();
  assert.deepEqual({ employment: person.organisation.employment, path: person.organisation.departments[0].path }, { employment: "active", path: ["研发中心", "平台部"] });

  assert.equal((await auditor.post("org/sync")).status, 403, "an auditor reads the organisation, does not start a sync");
  assert.equal(syncs.length, 0);
  assert.equal((await admin.post("org/sync")).status, 200);
  assert.deepEqual(syncs, [TENANT], "the administrator's own tenant, never one named in the request");
  const line = (await (await admin.get("audit?action=admin.org.sync")).json()).rows[0];
  assert.equal(line.actor.id, ADMIN);

  const unsynced = await consoleServer(t, { withOrg: true });
  const unsyncedAdmin = await unsynced.as(ADMIN);
  assert.equal((await (await unsyncedAdmin.get("org")).json()).canSync, false);
  assert.equal((await unsyncedAdmin.post("org/sync")).status, 404);
});

test("cleaning up after many who have left: summed first, confirmed by how many, one failure does not stop the rest, and the done ones leave the waiting list", async (t) => {
  const asked = [];
  const f = await consoleServer(t, { withOrg: true, apiOptions: {
    personData: async (who) => ({ tasks: { schedules: 2, runs: 10 }, credential: who.userId === PERSON ? { state: "active" } : null, model: null,
      sites: [{ id: `s-${who.userId}`, name: "看板", offline: false }], reservations: [] }),
    offboard: async (who) => {
      asked.push(who.userId);
      if (who.userId === OTHER) throw new Error("云盘额度记录写不进去");
      return { tasks: { schedules: 2, runs: 10 }, credential: true, model: false, reservations: 0, sitesOffline: [{ id: "s", name: "看板" }], sessions: 1 };
    } } });
  await f.org.recordPeople(TENANT, [{ userId: PERSON, employment: "resigned", departments: [] }, { userId: OTHER, employment: "resigned", departments: [] }]);
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  const ids = [PERSON, OTHER, ADMIN, OWNER].join(",");
  assert.equal((await auditor.get(`people/offboard?ids=${ids}`)).status, 403);
  const preview = await (await admin.get(`people/offboard?ids=${ids}`)).json();
  assert.deepEqual({ people: preview.people.map((person) => person.userId), skipped: preview.skipped, confirm: preview.confirm },
    { people: [PERSON, OTHER], skipped: [ADMIN, OWNER], confirm: "2" }, "never oneself, never an owner from the configuration");
  assert.deepEqual(preview.totals, { schedules: 4, runs: 20, credentials: 1, models: 0, sites: 2, reservations: 0 });
  assert.equal(asked.length, 0, "a preview changes nothing");

  const userIds = [PERSON, OTHER, ADMIN, OWNER];
  assert.equal((await admin.post("people/offboard", { userIds, confirm: "4" })).status, 409, "the number that will actually go");
  assert.equal((await admin.post("people/offboard", { userIds: Array.from({ length: 51 }, (_, i) => `ou_many${i}`), confirm: "51" })).status, 400);
  assert.equal(asked.length, 0);
  assert.equal(f.access.isDisabled(TENANT, PERSON), false, "nothing disabled before the confirmation matches");

  const result = await (await admin.post("people/offboard", { userIds, confirm: "2" })).json();
  assert.deepEqual({ ok: result.ok, done: result.done, failed: result.failed.map((row) => row.userId), skipped: result.skipped },
    { ok: false, done: 1, failed: [OTHER], skipped: [ADMIN, OWNER] });
  assert.deepEqual(asked, [PERSON, OTHER]);
  for (const userId of [PERSON, OTHER]) assert.equal(f.access.get(TENANT, userId).reason, "离职清理", "both disabled first");
  const lines = (await (await admin.get("audit?action=admin.person.offboard")).json()).rows;
  assert.deepEqual(lines.map((line) => [line.target.id, line.outcome, line.detail.bulk]).sort(), [[OTHER, "failed", 2], [PERSON, "ok", 2]]);
  const page = await (await admin.get("org")).json();
  assert.deepEqual({ pending: page.pending.map((row) => row.userId), cleaned: page.cleaned.map((row) => row.userId), count: page.status.pending },
    { pending: [OTHER], cleaned: [PERSON], count: 1 }, "the one that failed stays on the list, to try again");
});

test("a department administrator: only the people in their departments -- every route narrows to them, refuses, or is the tenant's", async (t) => {
  const LEAD = "ou_lead";
  const offboarded = [], revoked = [];
  const safetyDb = await openAdminDatabase();
  const safety = await SiteSafety.open({ db: safetyDb, key: "a-server-key-of-thirty-two-bytes!" });
  t.after(async () => { await safety.close(); await safetyDb.close(); });
  const checkOf = async (siteId, ownerId) => (await safety.assess({ tenantId: TENANT, site: { id: siteId, name: "x", ownerId }, audience: "public", files: [{ path: "index.html", bytes: Buffer.from("<p>13812345678</p>") }], trigger: "publish", version: "v1" })).id;
  const insideCheck = await checkOf("00000000-0000-4000-8000-000000000001", PERSON), outsideCheck = await checkOf("00000000-0000-4000-8000-000000000002", ADMIN);
  const f = await consoleServer(t, { withOrg: true, withPolicy: true, apiOptions: { safety,
    tasks: { store: { tenantTotals: async () => ({ total: 2, owners: 2, active: 2, paused: 0, suspended: 0 }),
      ownersOf: async (tenant, { after = "" } = {}) => ({ owners: [ADMIN, PERSON].sort().filter((id) => id > after).map((userId) => ({ userId, total: 1, active: 1, paused: 0, suspended: 0, nextAt: null, runs: { completed: 0, failed: 0, skipped: 0 } })), next: null }) },
      unattended: { store: { read: async () => null }, revoke: async (who) => { revoked.push(who.userId); return true; } } },
    skills: { list: () => [{ id: "enterprise-x", version: "1.0.0", title: "X", description: "", publisher: "", requiredTools: [], files: [{}], digest: "d" }], withdraw: async () => ({}) },
    personData: async () => ({ tasks: { schedules: 1, runs: 1 }, credential: null, model: null, sites: [], reservations: [] }),
    offboard: async (who) => { offboarded.push(who.userId); return { tasks: { schedules: 1, runs: 1 }, sitesOffline: [], sessions: 0 }; },
    sites: (() => {
      const held = new Map();
      const all = [{ id: "00000000-0000-4000-8000-000000000001", tenantId: TENANT, ownerId: PERSON, name: "平台看板" }, { id: "00000000-0000-4000-8000-000000000002", tenantId: TENANT, ownerId: ADMIN, name: "销售看板" }];
      return { list: () => all, get: (id) => all.find((site) => site.id === id) ?? null, hold: async (id) => { held.set(id, true); }, release: async (id) => ({ offline: false, held: held.delete(id) }) };
    })(), rescans: { again: () => {}, run: async () => ({ checked: 0, waiting: 0, unread: 0 }), stop: () => {} } } });
  // 研发中心 ─┬─ 平台部: 张三          销售部: 管理员乙, 部门丁 (the department administrator
  //           └─ 应用部: OTHER (left)  himself sits outside the departments he manages)
  await f.org.replaceDepartments(TENANT, [
    { id: "od-rd", parentId: "", name: "研发中心", path: "/od-rd/", depth: 1, memberCount: 2 },
    { id: "od-a_b", parentId: "od-rd", name: "平台部", path: "/od-rd/od-a_b/", depth: 2, memberCount: 1 },
    { id: "od-aXb", parentId: "od-rd", name: "应用部", path: "/od-rd/od-aXb/", depth: 2, memberCount: 1 },
    { id: "od-sales", parentId: "", name: "销售部", path: "/od-sales/", depth: 1, memberCount: 2 },
  ]);
  await f.org.recordPeople(TENANT, [{ userId: PERSON, employment: "active", departments: ["od-a_b"] }, { userId: OTHER, employment: "resigned", departments: ["od-aXb"] },
    { userId: ADMIN, employment: "resigned", departments: ["od-sales"] }, { userId: LEAD, employment: "active", departments: ["od-sales"] }]);
  f.people.seen({ tenantId: TENANT, userId: LEAD, name: "部门丁", signIn: true }); await f.people.flush();
  await f.roles.grant({ tenantId: TENANT, userId: LEAD, role: "admin", scope: ["od-rd"], by: { userId: OWNER } });
  const owner = await f.as(OWNER), lead = await f.as(LEAD);
  // Before: the owner acts on somebody inside and somebody outside; and a rule each.
  await owner.post(`people/${PERSON}/sign-out`); await owner.post(`people/${ADMIN}/sign-out`);
  const rule = async (target, settings) => (await (await owner.post("policies", { target, settings })).json()).rule;
  const everyoneRule = await rule({ kind: "everyone" }, { features: { mediaImage: true } });
  const rdRule = await rule({ kind: "department", id: "od-rd" }, { quota: { dailyTokens: 5000 } });
  const salesRule = await rule({ kind: "department", id: "od-sales" }, { quota: { dailyTokens: 7000 } });
  const outsiderRule = await rule({ kind: "user", id: ADMIN }, { features: { mediaImage: false } });
  const insiderRule = await rule({ kind: "user", id: PERSON }, { features: { mediaImage: false } });
  const json = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });
  const put = (path, body) => fetch(`${f.base}/admin/api/${path}`, { method: "PUT", headers: { cookie: lead.cookie, origin: ORIGIN, "x-idou-csrf": lead.me.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });

  // Who they are, and over whom.
  assert.deepEqual(lead.me.scope.map((d) => [d.id, d.trail]), [["od-rd", ["研发中心"]]]);
  assert.deepEqual({ usage: lead.me.features.usage, system: lead.me.features.system }, { usage: false, system: false });

  // What each route does for them. A sample request for every route this API
  // has: a route added without saying what a limited administrator gets is
  // caught below, by the list of routes that no sample reached.
  const probes = [
    // "any": nothing about people in it.
    ["GET", "me", async (r) => assert.equal(r.status, 200)],
    ["GET", "org/departments?parent=od-rd", async (r) => assert.equal(r.status, 200)],
    ["GET", `org/search?q=${encodeURIComponent("销售")}`, async (r) => assert.equal(r.status, 200)],
    ["GET", "admins", async (r) => assert.equal(r.status, 200)],
    // "tenant": refused.
    ["POST", "org/sync", async (r) => assert.equal(r.status, 403)],
    ["GET", "usage", async (r) => assert.equal(r.status, 403)],
    ["GET", "usage/export", async (r) => assert.equal(r.status, 403)],
    ["POST", "admins", async (r) => assert.equal(r.status, 403), { userId: OTHER, role: "auditor" }],
    ["DELETE", `admins/${OTHER}`, async (r) => assert.equal(r.status, 403)],
    ["GET", "system", async (r) => assert.equal(r.status, 403)],
    ["POST", "system/alerts/test", async (r) => assert.equal(r.status, 403)],
    // "scoped": narrowed, or refused for somebody outside.
    ["GET", "overview", async (r) => { const { body } = await json(r); assert.deepEqual({ scoped: body.scoped, total: body.people.total, usage: body.usage }, { scoped: true, total: 2, usage: null }); }],
    ["GET", "people", async (r) => assert.deepEqual((await r.json()).people.map((p) => p.userId).sort(), [OTHER, PERSON].sort())],
    ["GET", "people?department=od-sales", async (r) => assert.equal(r.status, 403)],
    ["GET", `people/${ADMIN}`, async (r) => assert.equal(r.status, 403)],
    ["POST", `people/${ADMIN}/sign-out`, async (r) => assert.equal(r.status, 403)],
    ["POST", `people/${ADMIN}/disable`, async (r) => assert.equal(r.status, 403), { reason: "x" }],
    ["POST", `people/${ADMIN}/enable`, async (r) => assert.equal(r.status, 403)],
    ["POST", "people/bulk", async (r) => { const { body } = await json(r); assert.deepEqual({ changed: body.changed, outOfScope: body.outOfScope }, { changed: 1, outOfScope: [ADMIN] }); },
      { action: "sign-out", userIds: [ADMIN, PERSON] }],
    ["GET", `people/${ADMIN}/offboard`, async (r) => assert.equal(r.status, 403)],
    ["POST", `people/${ADMIN}/offboard`, async (r) => assert.equal(r.status, 403), { confirm: "管理员乙" }],
    ["GET", `people/offboard?ids=${ADMIN},${OTHER}`, async (r) => { const { body } = await json(r); assert.deepEqual({ people: body.people.map((p) => p.userId), outOfScope: body.outOfScope }, { people: [OTHER], outOfScope: [ADMIN] }); }],
    ["POST", "people/offboard", async (r) => { const { body } = await json(r); assert.deepEqual({ done: body.done, outOfScope: body.outOfScope }, { done: 0, outOfScope: [ADMIN] }); },
      { userIds: [ADMIN], confirm: "0" }],
    ["GET", "policies", async (r) => {
      const rules = (await r.json()).rules.filter((x) => x.source !== "file");
      assert.deepEqual(rules.map((x) => [x.id, x.editable]).sort(), [[everyoneRule.id, false], [rdRule.id, true], [insiderRule.id, true]].sort(),
        "everyone's and the departments' that reach their people; not 销售部's, not an outsider's");
    }],
    ["POST", "policies", async (r) => assert.equal(r.status, 403), { target: { kind: "department", id: "od-sales" }, settings: { quota: { dailyTokens: 1 } } }],
    ["PUT", `policies/${salesRule.id}`, async (r) => assert.equal(r.status, 403), { settings: { quota: { dailyTokens: 1 } } }],
    ["DELETE", `policies/${outsiderRule.id}`, async (r) => assert.equal(r.status, 403)],
    ["GET", `policies/effective?user=${ADMIN}`, async (r) => assert.equal(r.status, 403)],
    ["GET", "org", async (r) => { const { body } = await json(r); assert.deepEqual({ pending: body.pending.map((p) => p.userId), count: body.status.pending, canSync: body.canSync }, { pending: [OTHER], count: 1, canSync: false }); }],
    ["GET", "audit?category=admin", async (r) => {
      const rows = (await r.json()).rows;
      assert.ok(rows.some((row) => row.target.id === PERSON), "what was done to their people");
      assert.ok(!rows.some((row) => row.target.id === ADMIN || row.actor.id === ADMIN), "nothing about somebody outside");
    }],
    ["GET", "audit/export", async (r) => { const text = await r.text(); assert.match(text, new RegExp(PERSON)); assert.doesNotMatch(text, new RegExp(ADMIN)); }],
    ["GET", "sites", async (r) => assert.deepEqual((await r.json()).sites.map((site) => site.name), ["平台看板"])],
    ["GET", "tasks", async (r) => { const { body } = await json(r); assert.deepEqual({ owners: body.owners.map((row) => row.userId), totals: body.totals }, { owners: [PERSON], totals: null }); }],
    ["POST", `people/${ADMIN}/tasks/stop`, async (r) => assert.equal(r.status, 403)],
    ["POST", `people/${ADMIN}/tasks/allow`, async (r) => assert.equal(r.status, 403)],
    ["POST", `people/${ADMIN}/unattended/revoke`, async (r) => assert.equal(r.status, 403)],
    ["GET", "skills", async (r) => assert.equal(r.status, 403)],
    ["POST", "skills/enterprise-x/withdraw", async (r) => assert.equal(r.status, 403)],
    ["GET", "skills/enterprise-x", async (r) => assert.equal(r.status, 403)],
    ["POST", "skills/enterprise-x/rollback", async (r) => assert.equal(r.status, 403), { digest: "d" }],
    ["PUT", "skills/enterprise-x/visibility", async (r) => assert.equal(r.status, 403), { departments: [] }],
    ["GET", "skills/submissions", async (r) => assert.equal(r.status, 403)],
    ["GET", "skills/submissions/00000000-0000-4000-8000-000000000009", async (r) => assert.equal(r.status, 403)],
    ["POST", "skills/submissions/00000000-0000-4000-8000-000000000009/approve", async (r) => assert.equal(r.status, 403)],
    ["POST", "skills/submissions/00000000-0000-4000-8000-000000000009/reject", async (r) => assert.equal(r.status, 403), { reason: "x" }],
    ["PUT", "skills/settings", async (r) => assert.equal(r.status, 403), { reviewRequired: false }],
    ["GET", "skills/publishers", async (r) => assert.equal(r.status, 403)],
    ["POST", "skills/publishers", async (r) => assert.equal(r.status, 403), { userId: "ou_someone" }],
    ["DELETE", "skills/publishers/ou_someone", async (r) => assert.equal(r.status, 403)],
    ["GET", "site-safety", async (r) => { const { body } = await json(r); assert.deepEqual([r.status, body.editable], [200, false]); }],
    ["GET", "site-safety/checks", async (r) => assert.deepEqual((await r.json()).checks.map((check) => check.id), [insideCheck], "only checks of their people's sites")],
    ["GET", `site-safety/checks/${outsideCheck}`, async (r) => assert.equal(r.status, 403)],
    ["PUT", "site-safety/rules", async (r) => assert.equal(r.status, 403), { keywords: ["x"] }],
    ["POST", `site-safety/checks/${outsideCheck}/approve`, async (r) => assert.equal(r.status, 403)],
    ["POST", `site-safety/checks/${outsideCheck}/reject`, async (r) => assert.equal(r.status, 403), { reason: "x" }],
    ["POST", "site-safety/rescan", async (r) => assert.equal(r.status, 403)],
    ["POST", "sites/00000000-0000-4000-8000-000000000002/hold", async (r) => assert.equal(r.status, 403), { reason: "x" }],
    ["POST", "sites/00000000-0000-4000-8000-000000000002/release", async (r) => assert.equal(r.status, 403)],
  ];
  const reached = new Set();
  const routes = createAdminApi({ people: {}, access: {}, roles: {}, audit: {}, sessions: {}, system: async () => ({}) }).routes;
  for (const [index, [method, path, check, body]] of probes.entries()) {
    // Within an administrator's 60 at once and 20 a second (ADMIN_SERVER_LIMITS):
    // there are more routes than that, and a refusal for speed is no answer.
    if (index && index % 40 === 0) await new Promise((resolve) => setTimeout(resolve, 2100));
    const response = method === "GET" ? await lead.get(path) : method === "PUT" ? await put(path, body ?? {}) : method === "DELETE" ? await lead.remove(path) : await lead.post(path, body ?? {});
    await check(response);
    const route = routes.find(([verb, pattern]) => verb === method && pattern.test(`/admin/api/${path.split("?")[0]}`));
    assert.ok(route, `${method} ${path} is no route`);
    reached.add(route);
  }
  assert.deepEqual(routes.filter((route) => !reached.has(route)).map(([method, pattern]) => `${method} ${pattern}`), [], "every route has a sample here");
  assert.ok(routes.every(([, , , kind]) => ROUTE_KINDS.includes(kind)));

  // Nothing done to anybody outside along the way.
  assert.equal(f.access.isDisabled(TENANT, ADMIN), false);
  assert.equal(offboarded.length, 0);
  assert.deepEqual(revoked, []);
  // Inside, it all works: a rule for 平台部, and its member's effective policy.
  assert.equal((await lead.post("policies", { target: { kind: "department", id: "od-a_b" }, settings: { quota: { dailyTokens: 3000 } } })).status, 200);
  assert.equal((await (await lead.get(`policies/effective?user=${PERSON}`)).json()).effective.quota.dailyTokens, 3000);
  assert.equal((await lead.get(`people/${PERSON}`)).status, 200);
});

test("taking a site down from the console: a reason its owner sees, the link closed at once, and only an administrator brings it back", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { SiteRegistry } = await import("../src/control-plane/site-registry.js");
  const { appHash } = await import("../src/apps/manifest.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-admin-sites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const body = "<!doctype html><h1>看板</h1>";
  const publish = (tenantId, name) => registry.publish({ ownerId: PERSON, tenantId, name, share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(body), sha256: appHash(Buffer.from(body)) }] },
    blobs: [{ path: "index.html", base64: Buffer.from(body).toString("base64") }] });
  const site = await publish(TENANT, "客户名单"), elsewhere = await publish("tenant-b", "别处的");
  const forgotten = [];
  const f = await consoleServer(t, { apiOptions: { sites: registry, forgetSite: (id) => forgotten.push(id) } });
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  assert.equal((await auditor.post(`sites/${site.id}/hold`, { reason: "x" })).status, 403, "an auditor looks, takes nothing down");
  assert.equal((await admin.post(`sites/${site.id}/hold`, {})).status, 400, "a reason, which its owner will read");
  assert.equal((await admin.post(`sites/${elsewhere.id}/hold`, { reason: "x" })).status, 404, "another tenant's site is no site here");
  assert.equal((await admin.post(`sites/${site.id}/hold`, { reason: "包含客户电话" })).status, 200);
  assert.deepEqual({ offline: registry.get(site.id).offline, reason: registry.get(site.id).held.reason, by: registry.get(site.id).held.by.userId }, { offline: true, reason: "包含客户电话", by: ADMIN });
  assert.deepEqual(forgotten, [site.id], "the pages open on it are closed");
  const listed = await (await admin.get("sites?state=held")).json();
  assert.deepEqual(listed.sites.map((row) => [row.name, row.held.reason, row.held.by.name]), [["客户名单", "包含客户电话", "管理员乙"]]);
  assert.equal((await (await admin.get("sites?state=anyone")).json()).sites.length, 0, "no longer public");
  await assert.rejects(registry.republish(site.id, { ownerId: PERSON }), /管理员下线了这个网站/, "its owner cannot bring it back");
  assert.equal((await admin.post(`sites/${site.id}/release`)).status, 200);
  assert.equal(registry.get(site.id).offline, false);
  const trail = (await (await admin.get("audit?category=admin")).json()).rows.filter((row) => row.action.startsWith("admin.site."));
  assert.deepEqual(trail.map((row) => [row.action, row.target.name, row.detail.reason ?? null]), [["admin.site.release", "客户名单", null], ["admin.site.hold", "客户名单", "包含客户电话"]]);
});

test("scheduled tasks: counts by person and never what a task says; stopping them is their policy's switch; the unattended credential revoked", async (t) => {
  const revoked = [];
  const credentials = new Map([[PERSON, { state: "active", expiresAt: Date.UTC(2026, 10, 1) }]]);
  const f = await consoleServer(t, { withPolicy: true, apiOptions: { tasks: {
    store: { tenantTotals: async () => ({ total: 3, owners: 1, active: 2, paused: 1, suspended: 0 }),
      ownersOf: async () => ({ owners: [{ userId: PERSON, total: 3, active: 2, paused: 1, suspended: 0, nextAt: Date.UTC(2026, 9, 3, 1), runs: { completed: 5, failed: 1, skipped: 0 } }], next: null }) },
    unattended: { store: { read: async (tenant, userId) => credentials.get(userId) ?? null }, revoke: async (who) => { revoked.push(who.userId); return credentials.delete(who.userId); } } } } });
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  const page = await (await auditor.get("tasks")).json();
  assert.deepEqual({ totals: page.totals.total, row: [page.owners[0].name, page.owners[0].unattended.state, page.owners[0].stopped, page.owners[0].runs.failed] },
    { totals: 3, row: ["张三", "active", false, 1] });
  assert.equal((await auditor.post(`people/${PERSON}/tasks/stop`)).status, 403, "an auditor reads, stops nothing");
  // Stopped: a rule of his own with 定时任务 off, which every run asks first.
  assert.equal((await admin.post(`people/${PERSON}/tasks/stop`)).status, 200);
  assert.equal((await (await admin.get("tasks")).json()).owners[0].stopped, true);
  assert.equal((await (await admin.get(`people/${PERSON}`)).json()).tasksStopped, true);
  const rules = async () => (await (await admin.get("policies")).json()).rules.filter((rule) => rule.target.kind === "user" && rule.target.id === PERSON);
  assert.deepEqual((await rules()).map((rule) => rule.settings), [{ features: { scheduledTasks: false } }]);
  // Allowed again: the rule goes, having nothing else in it.
  assert.equal((await admin.post(`people/${PERSON}/tasks/allow`)).status, 200);
  assert.deepEqual(await rules(), []);
  // With a rule of his own already: merged into it, and taken out of it again.
  await admin.post("policies", { target: { kind: "user", id: PERSON }, settings: { quota: { dailyTokens: 1000 } } });
  await admin.post(`people/${PERSON}/tasks/stop`);
  assert.deepEqual((await rules())[0].settings, { quota: { dailyTokens: 1000 }, features: { scheduledTasks: false } });
  await admin.post(`people/${PERSON}/tasks/allow`);
  assert.deepEqual((await rules())[0].settings, { quota: { dailyTokens: 1000 } });
  // The unattended credential: revoked, once.
  assert.deepEqual(await (await admin.post(`people/${PERSON}/unattended/revoke`)).json(), { ok: true, changed: true });
  assert.deepEqual(await (await admin.post(`people/${PERSON}/unattended/revoke`)).json(), { ok: true, changed: false });
  assert.deepEqual(revoked, [PERSON, PERSON]);
  const trail = (await (await admin.get("audit?category=admin&limit=20")).json()).rows.map((row) => row.action);
  assert.equal(trail.filter((action) => action === "admin.unattended.revoke").length, 1);
  assert.ok(["admin.policy.create", "admin.policy.delete", "admin.policy.update"].every((action) => trail.includes(action)), "each stop and allow is a policy change, written down");
});

test("enterprise skills: listed for the tenant, and taken off the shelf with a reason written down", async (t) => {
  const shelf = new Map([[TENANT, [{ id: "enterprise-weekly", version: "1.2.0", title: "周报", description: "汇总本周的群消息", publisher: "IT", requiredTools: ["feishu.read"], files: [{ path: "SKILL.md" }], digest: "d1" }]]]);
  const f = await consoleServer(t, { apiOptions: { skills: { list: (tenant) => shelf.get(tenant) ?? [], withdraw: async (tenant, id) => { shelf.set(tenant, shelf.get(tenant).filter((skill) => skill.id !== id)); return { id }; } } } });
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  assert.deepEqual((await (await auditor.get("skills")).json()).skills.map((skill) => [skill.id, skill.title, skill.files]), [["enterprise-weekly", "周报", 1]]);
  assert.equal((await auditor.post("skills/enterprise-weekly/withdraw", { reason: "x" })).status, 403);
  assert.equal((await admin.post("skills/enterprise-nothing/withdraw", {})).status, 404);
  assert.equal((await admin.post("skills/enterprise-weekly/withdraw", { reason: "会把客户资料发到外部" })).status, 200);
  assert.deepEqual(shelf.get(TENANT), []);
  const line = (await (await admin.get("audit?action=admin.skill.withdraw")).json()).rows[0];
  assert.deepEqual([line.target.name, line.detail.version, line.detail.reason], ["周报", "1.2.0", "会把客户资料发到外部"]);
});

test("content safety in the console: what waits, looked at with values masked, let through or turned down, and the rules", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { SiteRegistry } = await import("../src/control-plane/site-registry.js");
  const { appHash } = await import("../src/apps/manifest.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-admin-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const safetyDb = await openAdminDatabase();
  const safety = await SiteSafety.open({ db: safetyDb, key: "a-server-key-of-thirty-two-bytes!" });
  t.after(async () => { await safety.close(); await safetyDb.close(); });
  // As the site service publishes (site-service.js): checked first, written waiting.
  const publish = async (name, text) => {
    const id = (await import("node:crypto")).randomUUID();
    const files = [{ path: "index.html", bytes: Buffer.from(text) }];
    const check = await safety.assess({ tenantId: TENANT, site: { id, name, ownerId: PERSON }, audience: "public", files, trigger: "publish", version: "v1" });
    await registry.publish({ siteId: id, ownerId: PERSON, tenantId: TENANT, name, share: { scope: "anyone" }, anonymousAllowed: true,
      manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(text), sha256: appHash(Buffer.from(text)) }] },
      blobs: [{ path: "index.html", base64: Buffer.from(text).toString("base64") }], review: check.outcome === "review" ? { checkId: check.id, reason: check.reason } : null });
    return { id, check };
  };
  const first = await publish("联系表", "<p>销售热线 13812345678</p>"), second = await publish("名单", "<p>13900001111</p>");
  const f = await consoleServer(t, { apiOptions: { sites: registry, safety, rescans: idleRescans(registry, safety) } });
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  const page = await (await auditor.get("site-safety")).json();
  assert.deepEqual(page.waiting.map((row) => [row.site.name, row.check.outcome]).sort(), [["名单", "review"], ["联系表", "review"]]);
  assert.equal((await auditor.post(`site-safety/checks/${first.check.id}/approve`)).status, 403, "an auditor looks, decides nothing");
  const detail = (await (await admin.get(`site-safety/checks/${first.check.id}`)).json()).check;
  assert.deepEqual(detail.findings.map((finding) => [finding.where, finding.sample, "fingerprint" in finding]), [["index.html 第 1 行", "138****5678", false]]);
  assert.match(detail.excerpt, /销售热线 138\*\*\*\*5678/);
  assert.ok(!JSON.stringify(detail).includes("13812345678"));
  // Let through: up, and the same number does not wait again.
  assert.deepEqual(await (await admin.post(`site-safety/checks/${first.check.id}/approve`)).json(), { ok: true, online: true });
  assert.equal(registry.get(first.id).offline, false);
  assert.equal(registry.get(first.id).review.approved.version, "v1", "the version that check was of (fifth review before .270)");
  assert.equal((await admin.post(`site-safety/checks/${first.check.id}/approve`)).status, 409, "decided once");
  const again = await safety.assess({ tenantId: TENANT, site: { id: first.id, name: "联系表", ownerId: PERSON }, audience: "public",
    files: [{ path: "index.html", bytes: Buffer.from("<p>销售热线 13812345678</p>") }], trigger: "update", version: "v2", approved: registry.get(first.id).review.approved });
  assert.equal(again.outcome, "record");
  // Turned down: a reason is required, the owner sees it.
  assert.equal((await admin.post(`site-safety/checks/${second.check.id}/reject`, {})).status, 400);
  assert.equal((await admin.post(`site-safety/checks/${second.check.id}/reject`, { reason: "公开前删掉手机号" })).status, 200);
  assert.deepEqual([registry.get(second.id).review.state, registry.get(second.id).review.reason, registry.get(second.id).offline], ["rejected", "公开前删掉手机号", true]);
  // What the rules refuse cannot be let through here.
  const blocked = await safety.assess({ tenantId: TENANT, site: { id: second.id, name: "名单", ownerId: PERSON }, audience: "public", files: [{ path: "a.js", bytes: Buffer.from("sk-a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5") }], trigger: "update", version: "v3" });
  assert.equal((await admin.post(`site-safety/checks/${blocked.id}/approve`)).status, 409);
  // The rules: changed by an administrator of the whole tenant, written down with before and after.
  const put = (who, body) => fetch(`${f.base}/admin/api/site-safety/rules`, { method: "PUT", headers: { cookie: who.cookie, origin: ORIGIN, "x-idou-csrf": who.me.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put(auditor, { keywords: ["机密"] })).status, 403);
  assert.equal((await put(admin, { actions: { secret: { public: "record" } } })).status, 400);
  assert.equal((await put(admin, { keywords: ["机密"], reviewAllPublic: true })).status, 200);
  assert.deepEqual(safety.rules(TENANT).keywords, ["机密"]);
  const trail = (await (await admin.get("audit?category=admin&limit=20")).json()).rows;
  assert.deepEqual(trail.filter((row) => row.action.startsWith("admin.site")).map((row) => row.action), ["admin.site-rules.update", "admin.site.reject", "admin.site.approve"]);
  assert.match(trail[0].detail.after, /敏感词 1 个；AI 审核开；公开网站一律送审/);
  // Visits, by site, on the sites page.
  for (let n = 0; n < 3; n += 1) safety.countVisit(TENANT, first.id, { anonymous: true });
  await safety.flushVisits();
  const listed = (await (await admin.get("sites")).json()).sites;
  assert.deepEqual(listed.find((site) => site.id === first.id).visits7d, { visits: 3, anonymous: 3, refused: 0 });
  assert.equal(listed.find((site) => site.id === second.id).review.state, "rejected");
});


// Found in review before .270: 全部重新检查 left pages the model did not answer
// for unread until the next restart, though the server reads such pages again
// every half hour after its own start. The console's pass now hands them on.
test("a 全部重新检查 that leaves pages unread by the model hands them to the server's own re-reads", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { SiteRegistry } = await import("../src/control-plane/site-registry.js");
  const { appHash } = await import("../src/apps/manifest.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-admin-rescan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const text = "<p>产品介绍</p>";
  await registry.publish({ ownerId: PERSON, tenantId: TENANT, name: "产品页", share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(text), sha256: appHash(Buffer.from(text)) }] },
    blobs: [{ path: "index.html", base64: Buffer.from(text).toString("base64") }] });
  let answering = false;
  const safetyDb = await openAdminDatabase();
  const safety = await SiteSafety.open({ db: safetyDb, key: "a-server-key-of-thirty-two-bytes!",
    moderate: async () => answering ? { verdict: "pass", categories: [], reason: "" } : { verdict: "review", categories: [], reason: "模型没有回答（HTTP 529）", failed: true } });
  t.after(async () => { await safety.close(); await safetyDb.close(); });
  // The server's own re-reads, on timers of the test's own.
  const { scheduleRescans } = await import("../src/control-plane/site-safety.js");
  const armed = [];
  const rescans = scheduleRescans({ registry, safety, timers: { set: (run, ms) => { const timer = { run, ms }; armed.push(timer); return timer; }, clear: () => {} } });
  t.after(() => rescans.stop());
  const f = await consoleServer(t, { apiOptions: { sites: registry, safety, rescans } });
  const admin = await f.as(ADMIN);
  const settled = async (count) => { for (let n = 0; n < 300 && (await safety.checks({ tenantId: TENANT, limit: 10 })).checks.length < count; n += 1) await new Promise((resolve) => setTimeout(resolve, 10)); await new Promise((resolve) => setTimeout(resolve, 30)); };
  assert.deepEqual(armed.map((timer) => timer.ms), [180_000], "the start-up pass, not yet run");
  await armed[0].run();
  assert.equal(armed.length, 2, "the start-up pass left the page unread: half an hour on");
  assert.deepEqual(await (await admin.post("site-safety/rescan")).json(), { ok: true, started: true });
  await settled(2);
  assert.equal(armed.length, 2, "a pass already armed: the console's adds none");
  // The model answers now: the half-hourly pass reads the page and arms nothing more,
  // and neither does the console's.
  answering = true;
  await armed[1].run();
  assert.equal(armed.length, 2);
  await admin.post("site-safety/rescan");
  await settled(4);
  assert.equal(armed.length, 2, "read: nothing handed on");
  // A page the model has not read, unread again, with nothing armed: the console's pass hands it on.
  const another = "<p>秋季活动</p>";
  await registry.publish({ ownerId: PERSON, tenantId: TENANT, name: "活动页", share: { scope: "anyone" }, anonymousAllowed: true,
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(another), sha256: appHash(Buffer.from(another)) }] },
    blobs: [{ path: "index.html", base64: Buffer.from(another).toString("base64") }] });
  answering = false;
  await admin.post("site-safety/rescan");
  await settled(6);
  assert.deepEqual(armed.slice(2).map((timer) => timer.ms), [1_800_000], "handed to the server's half-hourly re-reads");
});

// Found in the third review before .270: nothing showed that the server hands
// its re-reads to the console. Left out, 全部重新检查 still ran and quietly
// neither followed up what it left unread nor stopped with the server.
test("the console with sites and content safety will not start without the server's re-reads", () => {
  const needs = { people: {}, access: {}, roles: {}, audit: {}, sessions: {}, system: async () => ({}), sites: { list: () => [] }, safety: {} };
  assert.throws(() => createAdminApi(needs), /补查计划/);
  assert.doesNotThrow(() => createAdminApi({ ...needs, rescans: { run: async () => ({}), again: () => {}, stop: () => {} } }));
  assert.doesNotThrow(() => createAdminApi({ ...needs, safety: null }), "no content safety: nothing to re-read");
});

// docs/enterprise-skill-governance.md: a version waits, is read file by file
// against what is up, is approved by somebody other than who submitted it or
// turned down with a reason; earlier versions go back up; a skill is opened to
// departments; who may publish is kept here; every step is written down.
// Found in review (2026-10-03): approving put the version up before it claimed
// the submission, so a rejection at the same moment left a version online that
// its publisher was told was turned down; the version up before versions were
// recorded was lost when it was replaced; a withdrawn skill could not be
// reached to bring back; administrators from the group did not count as
// another approver; a new skill could not start with a few departments.
test("enterprise skills, governed: one decision per version, nothing lost, nothing approved by its own publisher", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { SkillRegistry } = await import("../src/control-plane/skill-registry.js");
  const { SkillGovernance } = await import("../src/control-plane/skill-governance.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-admin-skills-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await new SkillRegistry({ filename: path.join(root, "registry.json"), administrators: [OWNER] }).load();
  const governanceDb = await openAdminDatabase();
  const governance = await SkillGovernance.open({ db: governanceDb, key: "a-server-key-of-thirty-two-bytes!" });
  t.after(async () => { governance.close(); await governanceDb.close(); });
  const bundle = (version, text) => ({ id: "enterprise-weekly", version, title: "周报助手", description: "整理周报", publisher: "平台组", requiredTools: [],
    runtimeVersions: { codex: [], feishu: [] }, files: [{ path: "SKILL.md", text: `---\nname: enterprise-weekly\ndescription: 周报\n---\n${text}` }] });
  // Up before versions were recorded: nothing in the history yet.
  await registry.place(TENANT, bundle("0.9.0", "版本记录之前"));
  const f = await consoleServer(t, { withOrg: true, apiOptions: { skills: registry, skillGovernance: governance } });
  const owner = await f.as(OWNER), admin = await f.as(ADMIN), auditor = await f.as(AUDITOR);
  await f.org.replaceDepartments(TENANT, [{ id: "od-legal", parentId: "", name: "法务部", path: "/od-legal/", depth: 1, memberCount: 3 }]);

  // The configured owner's own version: the administrator group's ADMIN could approve it, so the owner may not.
  const own = await governance.submit(TENANT, bundle("1.0.0", "第一版"), { userId: OWNER, name: "超管甲" });
  assert.equal((await (await owner.get(`skills/submissions/${own.id}`)).json()).selfReview, true);
  assert.equal((await owner.post(`skills/submissions/${own.id}/approve`)).status, 403, "the group's administrators count as others");
  // Approved and turned down at the same moment: exactly one of them happens.
  const [approved, rejected] = await Promise.all([admin.post(`skills/submissions/${own.id}/approve`, { departments: ["od-legal"], visibilityWas: [] }), owner.post(`skills/submissions/${own.id}/reject`, { reason: "再看看" })]);
  const statuses = [approved.status, rejected.status].sort();
  assert.deepEqual(statuses, [200, 409], "one decision");
  const final = await governance.submission(TENANT, own.id);
  assert.equal(registry.list(TENANT)[0].version, final.state === "approved" ? "1.0.0" : "0.9.0", "the shelf agrees with the decision");
  if (final.state === "rejected") {
    const again = await governance.submit(TENANT, bundle("1.0.1", "第一版"), { userId: OWNER, name: "超管甲" });
    assert.equal((await admin.post(`skills/submissions/${again.id}/approve`, { departments: ["od-legal"], visibilityWas: [] })).status, 200);
  }
  // Limited before it went up; what was up before is kept to go back to.
  assert.deepEqual(governance.visibility(TENANT, "enterprise-weekly").departments, ["od-legal"]);
  const detail = await (await auditor.get("skills/enterprise-weekly")).json();
  assert.deepEqual(detail.versions.map((version) => [version.version, version.source]).at(-1), ["0.9.0", "earlier"]);
  const listed = await (await auditor.get("skills")).json();
  assert.equal(listed.skills[0].published.approvedBy.userId, ADMIN, "who put up what is up now");
  // Withdrawn: kept, listed, reachable, and brought back.
  assert.equal((await admin.post("skills/enterprise-weekly/withdraw", { reason: "暂停" })).status, 200);
  assert.deepEqual((await (await auditor.get("skills")).json()).withdrawn.map((skill) => skill.id), ["enterprise-weekly"]);
  const gone = await (await auditor.get("skills/enterprise-weekly")).json();
  assert.deepEqual([gone.live, gone.versions.some((version) => version.live)], [false, false]);
  // A department Feishu has dropped stays in the setting and is said to be gone; a list is required.
  await f.org.replaceDepartments(TENANT, []);
  assert.deepEqual((await (await auditor.get("skills/enterprise-weekly")).json()).visibility.departments, [{ id: "od-legal", name: null, gone: true }]);
  const put = (who, route, body) => fetch(`${f.base}/admin/api/${route}`, { method: "PUT", headers: { cookie: who.cookie, origin: ORIGIN, "x-idou-csrf": who.me.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put(admin, "skills/enterprise-weekly/visibility", { departments: "od-legal" })).status, 400, "not a list: refused, not opened to everybody");
  assert.equal((await put(admin, "skills/enterprise-weekly/visibility", { departments: ["od-legal"] })).status, 200, "kept as it was");
  assert.equal((await admin.post("skills/enterprise-weekly/rollback", { digest: gone.versions[0].digest })).status, 200);
  assert.equal(registry.list(TENANT)[0].id, "enterprise-weekly", "back on the shelf");
});

// Found in the second review (2026-10-03): an approval that could not go up
// left its visibility change and ended the older versions waiting; it wrote
// over a visibility somebody changed while it was being read; and an
// unreadable administrator group let a publisher approve their own version.
test("enterprise skills, governed: an approval that fails changes nothing, and none undoes another's change", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { SkillRegistry } = await import("../src/control-plane/skill-registry.js");
  const { SkillGovernance } = await import("../src/control-plane/skill-governance.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-admin-skills-undo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await new SkillRegistry({ filename: path.join(root, "registry.json"), administrators: [OWNER] }).load();
  const governanceDb = await openAdminDatabase();
  const clock = { at: Date.now() };
  const governance = await SkillGovernance.open({ db: governanceDb, key: "a-server-key-of-thirty-two-bytes!", now: () => clock.at });
  t.after(async () => { governance.close(); await governanceDb.close(); });
  const bundle = (version) => ({ id: "enterprise-weekly", version, title: "周报助手", description: "整理周报", publisher: "平台组", requiredTools: [],
    runtimeVersions: { codex: [], feishu: [] }, files: [{ path: "SKILL.md", text: `---\nname: enterprise-weekly\ndescription: 周报\n---\n第 ${version} 版` }] });
  await registry.place(TENANT, bundle("1.0.0"));
  const older = await governance.submit(TENANT, bundle("1.1.0"), { userId: PERSON, name: "张三" });
  clock.at += 1000;
  const newer = await governance.submit(TENANT, bundle("1.2.0"), { userId: PERSON, name: "张三" });
  const f = await consoleServer(t, { withOrg: true, apiOptions: { skills: registry, skillGovernance: governance } });
  await f.org.replaceDepartments(TENANT, [{ id: "od-legal", parentId: "", name: "法务部", path: "/od-legal/", depth: 1, memberCount: 3 }]);
  const admin = await f.as(ADMIN), owner = await f.as(OWNER);
  // 1.2.0 went up another way meanwhile: approving it fails -- and leaves nothing changed.
  await registry.place(TENANT, bundle("1.2.0"));
  const failed = await admin.post(`skills/submissions/${newer.id}/approve`, { departments: ["od-legal"], visibilityWas: [] });
  assert.equal(failed.status, 409);
  assert.deepEqual(governance.visibility(TENANT, "enterprise-weekly").departments, [], "visibility as it was");
  assert.deepEqual([(await governance.submission(TENANT, newer.id)).state, (await governance.submission(TENANT, older.id)).state], ["pending", "pending"], "nothing ended");
  const trail = (await (await admin.get("audit?category=admin&limit=10")).json()).rows.filter((row) => row.action === "admin.skill.approve");
  assert.deepEqual(trail.map((row) => row.outcome), ["failed"], "written down as failed");
  // Somebody limits it while the reviewer reads: the reviewer's change is refused, not laid over it.
  const put = (who, route, value) => fetch(`${f.base}/admin/api/${route}`, { method: "PUT", headers: { cookie: who.cookie, origin: ORIGIN, "x-idou-csrf": who.me.csrf, "content-type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await put(owner, "skills/enterprise-weekly/visibility", { departments: ["od-legal"] })).status, 200);
  assert.equal((await admin.post(`skills/submissions/${older.id}/approve`, { departments: [], visibilityWas: [] })).status, 409);
  assert.deepEqual(governance.visibility(TENANT, "enterprise-weekly").departments, ["od-legal"]);
  assert.equal((await admin.post(`skills/submissions/${older.id}/approve`, { departments: [] })).status, 400, "a change to the visibility says what it changes from");
  // Left alone, an approval keeps what is set.
  assert.equal((await admin.post(`skills/submissions/${older.id}/approve`)).status, 200);
  assert.deepEqual(governance.visibility(TENANT, "enterprise-weekly").departments, ["od-legal"]);
  assert.equal((await governance.submission(TENANT, newer.id)).state, "pending", "a newer version still waits");
  // The owner's own version while the administrator group cannot be read: not approved by its owner.
  const own = await governance.submit(TENANT, bundle("1.3.0"), { userId: OWNER, name: "超管甲" });
  f.roles.directory.readChatMembers = async () => { throw new Error("bot removed from the group"); };
  f.roles.directory.cached = null;
  const refused = await owner.post(`skills/submissions/${own.id}/approve`);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).message, /读不到管理员群/);
});

test("enterprise skills, governed: review, versions, who sees them, who may publish -- each written down", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const { SkillRegistry } = await import("../src/control-plane/skill-registry.js");
  const { SkillGovernance } = await import("../src/control-plane/skill-governance.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-admin-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await new SkillRegistry({ filename: path.join(root, "registry.json"), administrators: ["ou_configured"] }).load();
  const governanceDb = await openAdminDatabase();
  const governance = await SkillGovernance.open({ db: governanceDb, key: "a-server-key-of-thirty-two-bytes!" });
  t.after(async () => { governance.close(); await governanceDb.close(); });
  const bundle = (version, text, tools = []) => ({ id: "enterprise-weekly", version, title: "周报助手", description: "整理周报", publisher: "平台组", requiredTools: tools,
    runtimeVersions: { codex: [], feishu: [] }, files: [{ path: "SKILL.md", text: `---\nname: enterprise-weekly\ndescription: 周报\n---\n${text}` }] });
  // Up already, and two versions submitted since: one by the administrator themselves.
  await registry.place(TENANT, bundle("1.0.0", "第一版"));
  await governance.recordVersion(TENANT, bundle("1.0.0", "第一版"), { publishedBy: { userId: "ou_configured", name: "配置的上架人" }, source: "publish" });
  const mine = await governance.submit(TENANT, bundle("1.1.0", "第一版\n加了一段", ["cli:local-files"]), { userId: ADMIN, name: "管理员乙" });
  const f = await consoleServer(t, { withOrg: true, apiOptions: { skills: registry, skillGovernance: governance } });
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN), owner = await f.as(OWNER);
  const put = (who, route, body) => fetch(`${f.base}/admin/api/${route}`, { method: "PUT", headers: { cookie: who.cookie, origin: ORIGIN, "x-idou-csrf": who.me.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });

  const listed = await (await auditor.get("skills")).json();
  assert.deepEqual([listed.pending, listed.settings.reviewRequired, listed.skills[0].version, listed.skills[0].published.by.name], [1, true, "1.0.0", "配置的上架人"]);
  // Read before deciding: every file, what changed, what its tools allow.
  const review = await (await auditor.get(`skills/submissions/${mine.id}`)).json();
  assert.deepEqual([review.live.version, review.changes.fields, review.changes.tools.added, review.tools[0].level], ["1.0.0", ["version"], ["cli:local-files"], "files"]);
  assert.match(review.skill.files[0].text, /加了一段/);
  assert.equal(review.selfReview, false, "the auditor did not submit it");
  assert.equal((await auditor.post(`skills/submissions/${mine.id}/approve`)).status, 403, "an auditor reads, decides nothing");
  // Not one's own, while somebody else could approve it.
  const own = await admin.post(`skills/submissions/${mine.id}/approve`);
  assert.equal(own.status, 403);
  assert.match((await own.json()).message, /不能审核自己提交的版本/);
  assert.equal((await owner.post(`skills/submissions/${mine.id}/approve`)).status, 200);
  assert.equal((await owner.post(`skills/submissions/${mine.id}/approve`)).status, 409, "decided once");
  assert.equal(registry.list(TENANT)[0].version, "1.1.0", "up now");
  // Turned down: a reason is required.
  const second = await governance.submit(TENANT, bundle("1.2.0", "把客户名单发到群里"), { userId: "ou_configured", name: "配置的上架人" });
  assert.equal((await owner.post(`skills/submissions/${second.id}/reject`, {})).status, 400);
  assert.equal((await owner.post(`skills/submissions/${second.id}/reject`, { reason: "会发出客户名单" })).status, 200);
  assert.equal(registry.list(TENANT)[0].version, "1.1.0", "a version turned down never goes up");
  // Back to the first version.
  const detail = await (await auditor.get("skills/enterprise-weekly")).json();
  assert.deepEqual(detail.versions.map((version) => [version.version, version.live]), [["1.1.0", true], ["1.0.0", false]]);
  assert.equal((await admin.post("skills/enterprise-weekly/rollback", { digest: detail.versions[0].digest })).status, 409, "already up");
  assert.equal((await admin.post("skills/enterprise-weekly/rollback", { digest: detail.versions[1].digest })).status, 200);
  assert.equal(registry.list(TENANT)[0].version, "1.0.0");
  // Opened to one department only.
  await f.org.replaceDepartments(TENANT, [{ id: "od-legal", parentId: "", name: "法务部", path: "/od-legal/", depth: 1, memberCount: 3 }]);
  assert.equal((await put(admin, "skills/enterprise-weekly/visibility", { departments: ["od-none"] })).status, 400, "a department the address book does not know");
  assert.equal((await put(admin, "skills/enterprise-weekly/visibility", { departments: ["od-legal"] })).status, 200);
  assert.deepEqual((await (await auditor.get("skills/enterprise-weekly")).json()).visibility.departments.map((department) => department.name), ["法务部"]);
  // Who may publish: the configured one stays; one added here can be removed.
  assert.equal((await admin.post("skills/publishers", { userId: PERSON })).status, 200);
  const publishers = (await (await auditor.get("skills/publishers")).json()).publishers;
  assert.deepEqual(publishers.map((person) => [person.userId, person.source]), [["ou_configured", "configured"], [PERSON, "console"]]);
  assert.equal(publishers[1].name, "张三");
  assert.equal(registry.administers({ userId: PERSON, tenantId: TENANT }), false, "the registry alone does not know the console's list");
  assert.equal((await admin.remove("skills/publishers/ou_configured")).status, 409, "the server's configuration is changed on the server");
  assert.equal((await admin.remove(`skills/publishers/${PERSON}`)).status, 200);
  assert.equal((await put(admin, "skills/settings", { reviewRequired: false })).status, 200);
  assert.equal(governance.settings(TENANT).reviewRequired, false);
  // All of it in the trail, under the skill.
  const trail = (await (await admin.get("audit?category=admin&limit=50")).json()).rows.map((row) => row.action);
  for (const action of ["admin.skill.approve", "admin.skill.reject", "admin.skill.rollback", "admin.skill.visibility", "admin.skill.publishers", "admin.skill.settings"]) assert.ok(trail.includes(action), action);
  assert.ok((await (await auditor.get("skills/enterprise-weekly")).json()).trail.some((row) => row.action === "admin.skill.rollback"), "the skill's own record");
});

// docs/service-status.md: the page reads every process, the self-checks kept
// and the alerts sent; a test alert goes to the administrator asking, nobody
// else, and is written down either way.
test("服务状态: what every process reports, and a test alert to the one asking only", async (t) => {
  const sent = [];
  const status = { read: async () => ({ at: 1, processes: [{ name: "api-3043", condition: "online" }] }), alerts: { enabled: true, users: 1, chat: false, bot: true },
    testAlert: async (admin) => { sent.push(admin.userId); return sent.length === 1 ? { sent: true } : { sent: false, reason: "99991672 no permission" }; } };
  const clock = { at: Date.now() };
  const f = await consoleServer(t, { apiOptions: { status, now: () => clock.at } });
  const auditor = await f.as(AUDITOR), admin = await f.as(ADMIN);
  const read = await (await auditor.get("system")).json();
  assert.deepEqual([read.release, read.status.processes[0].name, read.alerts.enabled], ["0.1.0-test", "api-3043", true]);
  assert.equal((await auditor.post("system/alerts/test")).status, 403, "an auditor reads, sends nothing");
  assert.equal((await admin.post("system/alerts/test")).status, 200);
  assert.deepEqual(sent, [ADMIN], "to the one asking");
  assert.equal((await admin.post("system/alerts/test")).status, 429, "once a minute");
  assert.deepEqual(sent, [ADMIN], "nothing sent the second time");
  clock.at += 61_000;
  const failed = await admin.post("system/alerts/test");
  assert.equal(failed.status, 502);
  assert.match((await failed.json()).message, /im:message:send_as_bot/);
  const trail = (await (await admin.get("audit?category=admin&limit=10")).json()).rows.filter((row) => row.action === "admin.alerts.test");
  assert.deepEqual(trail.map((row) => row.outcome).sort(), ["failed", "ok"]);
  // What cannot be read is said; the rest of the page still comes.
  const broken = await consoleServer(t, { apiOptions: { status: { read: async () => { throw new Error("database gone"); }, alerts: null, testAlert: null } } });
  const body = await (await (await broken.as(AUDITOR)).get("system")).json();
  assert.deepEqual([body.release, /database gone/.test(body.status.error)], ["0.1.0-test", true]);
  assert.equal((await (await broken.as(ADMIN)).post("system/alerts/test")).status, 409);
});
