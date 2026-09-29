import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScheduleService } from "../src/control-plane/schedule-service.js";
import { ScheduleConsent } from "../src/control-plane/schedule-consent.js";
import { ScheduleStore } from "../src/control-plane/schedule-store.js";
import { zonedInstant } from "../src/control-plane/schedule-spec.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const ZONE = "Asia/Shanghai";
const at = (y, m, d, hh, mm) => zonedInstant({ year: y, month: m, day: d, hour: hh, minute: mm }, ZONE);
const NOW = at(2026, 9, 16, 8, 0);
const ME = { id: "s1", tenantId: "tenant-a", userId: "person-a", familyId: "login-a", authProvider: "feishu", audience: "codex-model-gateway" };
const COLLEAGUE = { id: "s2", tenantId: "tenant-a", userId: "person-b", familyId: "login-b", authProvider: "feishu", audience: "codex-model-gateway" };
const daily = () => ({ title: "每天汇总", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork",
  schedule: { frequency: "daily", time: "09:00", timeZone: ZONE } });

function response() {
  const out = { status: 0, headers: {}, body: "", headersSent: false };
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? {}; out.headersSent = true; };
  out.end = (chunk) => { if (chunk !== undefined) out.body += String(chunk); };
  out.once = () => {}; out.off = () => {}; out.destroy = () => {};
  return out;
}
const request = (url, { token = "me", body = {}, method = "POST", headers = {} } = {}) => {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  return Object.assign(stream, { method, url,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, resume() {} });
};

async function service(t, { allowDevelopment = false, unattended = null, grants = null, feishu = null, resourceResolver = null, runNow = null, push = null, now = () => NOW, people = {} } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-schedule-service-"));
  const store = new ScheduleStore({ databaseFile: path.join(directory, "s.db"), now: () => NOW });
  const armed = [], cancelled = [];
  const sessions = { prune() {}, verify: (token) => ({ me: ME, colleague: COLLEAGUE,
    dev: { ...ME, authProvider: "development" }, wrong: { ...ME, audience: "skill-center" }, ...people })[token] ?? null };
  const consent = new ScheduleConsent({ sessions, now: () => NOW });
  const made = new ScheduleService({ sessions, store, consent, scheduler: { start: () => armed.push(1), cancel: (...args) => cancelled.push(args), ...(runNow ? { runNow } : {}) }, allowDevelopment, unattended, grants, feishu, resourceResolver, push, now });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { service: made, store, armed, cancelled, consent };
}
const call = async (service, url, options) => {
  const res = response();
  const claimed = await service.handle(request(url, options), res);
  return { claimed, status: res.status, body: res.body ? JSON.parse(res.body) : null };
};

test("a schedule can be created, listed and read back the way a person wrote it", async (t) => {
  const { service: made, armed } = await service(t);
  const created = await call(made, "/v1/schedules/create", { body: daily() });
  assert.equal(created.status, 200);
  assert.equal(created.body.schedule.schedule, "每天 09:00", "the list shows the rule, not an interval");
  assert.equal(created.body.schedule.nextAt, at(2026, 9, 16, 9, 0));
  assert.equal(created.body.schedule.state, "active");
  assert.equal(armed.length, 1, "the clock is re-armed, since the new one may be due before whatever it was waiting for");

  const listed = await call(made, "/v1/schedules", {});
  assert.equal(listed.body.schedules.length, 1);
  assert.equal(listed.body.schedules[0].id, created.body.schedule.id);
  assert.equal(listed.body.schedules[0].ruleSupported, true);
  // What this server will create, so the desktop's dialog offers exactly that.
  assert.deepEqual(listed.body.rules, ["once", "daily", "weekly", "biweekly", "monthly", "yearly", "interval"]);
  const biweekly = await call(made, "/v1/schedules/create", { body: { ...daily(), schedule: { frequency: "biweekly", time: "09:00", weekdays: [1], timeZone: ZONE } } });
  assert.equal(biweekly.status, 200);
  assert.equal(biweekly.body.schedule.schedule, "每两周的周一 09:00");
});

test("resource grants are parsed by the selected provider and bound to the authenticated owner", async (t) => {
  const { service: made, store } = await service(t, { feishu: SAAS_FEISHU });
  const created = await call(made, "/v1/schedules/create", { body: { ...daily(), resources: [
    { kind: "document", reference: "https://feishu.cn/docx/DocFixture123456" },
    { kind: "chat", id: "oc_FixtureChat123" },
  ] } });
  assert.equal(created.status, 200);
  assert.equal(created.body.schedule.access.configured, true);
  assert.deepEqual(created.body.schedule.access.resources.map(row => row.kind), ["chat", "document"]);
  const saved = store.get(ME, created.body.schedule.id);
  assert.equal(saved.capability.tenantId, ME.tenantId);
  assert.equal(saved.capability.ownerId, ME.userId);
  assert.equal(saved.capability.providerId, SAAS_FEISHU.id);
  assert.match(saved.capabilityDigest, /^[a-f0-9]{64}$/);

  const invalid = await call(made, "/v1/schedules/create", { body: { ...daily(), resources: [
    { kind: "document", reference: "https://feishu.cn/wiki/DocFixture123456" },
  ] } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Wiki/);
});

test("resource grants use the server resolver output rather than a client-supplied Wiki mapping", async (t) => {
  const seen = [];
  const resourceResolver = { resolveScheduleResources: async (token, resources) => {
    seen.push({ token, resources });
    return [{ kind: "document", reference: "https://fixture.feishu.cn/docx/ConcreteDoc123", label: "服务端解析" }];
  } };
  const { service: made } = await service(t, { feishu: SAAS_FEISHU, resourceResolver });
  const response = await call(made, "/v1/schedules/create", { body: { ...daily(), resources: [
    { kind: "document", reference: "https://fixture.feishu.cn/wiki/WikiNode123", label: "客户端声称" },
  ] } });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1); assert.equal(seen[0].token, "me");
  assert.deepEqual(response.body.schedule.access.resources, [{ kind: "document", id: "ConcreteDoc123",
    reference: "https://fixture.feishu.cn/docx/ConcreteDoc123", label: "服务端解析" }]);
});

// Spreadsheets and Bases used to skip the server resolver entirely: it ran only
// when a document was in the list, so a pasted spreadsheet became an
// authorization without anyone proving the person could read it.
test("every linked resource goes through the server resolver, not only documents", async (t) => {
  const seen = [];
  const resourceResolver = { resolveScheduleResources: async (token, resources) => {
    seen.push(resources.map(row => row.kind));
    return [{ kind: "base", reference: "https://fixture.feishu.cn/base/BasToken1234", label: "服务端解析" }];
  } };
  const { service: made } = await service(t, { feishu: SAAS_FEISHU, resourceResolver });
  const response = await call(made, "/v1/schedules/create", { body: { ...daily(), resources: [
    { kind: "sheet", reference: "https://fixture.feishu.cn/wiki/WikiNode123", label: "客户端声称是表格" },
  ] } });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [["sheet"]]);
  assert.deepEqual(response.body.schedule.access.resources, [{ kind: "base", id: "BasToken1234",
    reference: "https://fixture.feishu.cn/base/BasToken1234", label: "服务端解析" }]);
});

// Each refusal the resolver can give reaches the person as its own sentence,
// because each has a different fix. Measured live, a mistyped link and a missing
// scope both used to arrive as "如刚升级，请重新登录飞书以授予 Wiki 只读权限";
// neither is fixed by logging in again.
test("each resource refusal reaches the person as its own message, pointing at its own fix", async (t) => {
  for (const [code, status, says, never] of [
    ["schedule_resource_unreadable", 403, [/检查链接/, /已被删除/], /管理员|重新登录/],
    ["schedule_resource_probe_unavailable", 403, [/wiki:wiki:readonly/, /docs:permission\.member:auth/, /管理员/], /检查链接/],
    ["schedule_resource_access_denied", 403, [/所有者分享/], /管理员|检查链接/],
    ["schedule_resource_resolution_unavailable", 502, [/稍后重试/], /Wiki 只读权限|检查链接/],
  ]) {
    const resourceResolver = { resolveScheduleResources: async () => { throw Object.assign(new Error(code), { status }); } };
    const { service: made } = await service(t, { feishu: SAAS_FEISHU, resourceResolver });
    const response = await call(made, "/v1/schedules/create", { body: { ...daily(), resources: [
      { kind: "sheet", reference: "https://fixture.feishu.cn/wiki/WikiNode123" },
    ] } });
    assert.equal(response.status, status, code);
    const message = JSON.stringify(response.body);
    for (const pattern of says) assert.match(message, pattern, code);
    assert.doesNotMatch(message, never, code);
    // Never the generic fallback: every refusal the resolver gives has been named.
    assert.doesNotMatch(message, /定时任务资源核验失败/, code);
  }
});

test("replacing resources creates a new grant revision and cancels every old in-flight authority", async (t) => {
  const { service: made, store, cancelled } = await service(t, { feishu: SAAS_FEISHU });
  const created = await call(made, "/v1/schedules/create", { body: { ...daily(), resources: [
    { kind: "chat", id: "oc_FirstChat123" },
  ] } });
  const id = created.body.schedule.id, before = store.get(ME, id);
  const updated = await call(made, "/v1/schedules/resources", { body: { id, expectedRevision: 1, resources: [
    { kind: "chat", id: "oc_SecondChat123", label: "新会话" },
  ] } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.schedule.access.revision, 2);
  assert.deepEqual(updated.body.schedule.access.resources, [{ kind: "chat", id: "oc_SecondChat123", label: "新会话" }]);
  const after = store.get(ME, id);
  assert.equal(after.capabilityRevision, before.capabilityRevision + 1);
  assert.notEqual(after.capabilityDigest, before.capabilityDigest);
  assert.equal(after.cancellationRevision, before.cancellationRevision + 1);
  assert.deepEqual(cancelled, [[ME.tenantId, id]]);

  const stale = await call(made, "/v1/schedules/resources", { body: { id, expectedRevision: 1, resources: [] } });
  assert.equal(stale.status, 409);
  const colleague = await call(made, "/v1/schedules/resources", { token: "colleague", body: { id, expectedRevision: 2, resources: [] } });
  assert.equal(colleague.status, 404);
});

test("nothing in a response carries a credential", async (t) => {
  const { service: made } = await service(t);
  const created = await call(made, "/v1/schedules/create", { body: daily() });
  const text = JSON.stringify(created.body);
  for (const word of ["token", "secret", "authorization", "familyId", "login-a"]) {
    assert.equal(text.toLowerCase().includes(word.toLowerCase()), false, `${word} must not be in a response`);
  }
});

test("a colleague in the same tenant cannot see, pause or delete what they did not create", async (t) => {
  // The store is keyed by tenant, so without an owner check a colleague's
  // session would reach these rows.
  const { service: made } = await service(t);
  const mine = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;

  const theirList = await call(made, "/v1/schedules", { token: "colleague" });
  assert.deepEqual(theirList.body.schedules, [], "not listed");
  for (const [url, body] of [["/v1/schedules/state", { id: mine.id, state: "paused" }],
    ["/v1/schedules/delete", { id: mine.id }], ["/v1/schedules/runs", { id: mine.id }]]) {
    const refused = await call(made, url, { token: "colleague", body });
    assert.equal(refused.status, 404, `${url} must refuse`);
  }
  const still = await call(made, "/v1/schedules", {});
  assert.equal(still.body.schedules[0].state, "active", "and it is untouched");
});

test("pausing and resuming is the person's own choice and survives a round trip", async (t) => {
  const { service: made } = await service(t);
  const mine = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  const paused = await call(made, "/v1/schedules/state", { body: { id: mine.id, state: "paused" } });
  assert.equal(paused.body.schedule.state, "paused");
  assert.equal((await call(made, "/v1/schedules", { body: { state: "paused" } })).body.schedules.length, 1);
  assert.equal((await call(made, "/v1/schedules", { body: { state: "active" } })).body.schedules.length, 0);
  const resumed = await call(made, "/v1/schedules/state", { body: { id: mine.id, state: "active" } });
  assert.equal(resumed.body.schedule.state, "active");
  assert.equal((await call(made, "/v1/schedules/state", { body: { id: mine.id, state: "deleted" } })).status, 400);
});

// G11: the task goes, its history stays -- named, marked as a deleted task's,
// and still only the person's own.
test("deleting a task keeps its run history, named and marked, and still only its owner's", async (t) => {
  const { service: made, store } = await service(t);
  const mine = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  const ran = store.claim(store.get(ME, mine.id), at(2026, 9, 16, 9, 0));
  store.finish(ME.tenantId, ran.runId, "completed");
  assert.equal((await call(made, "/v1/schedules/runs", { body: { id: mine.id } })).body.runs.length, 1);

  const removed = await call(made, "/v1/schedules/delete", { body: { id: mine.id } });
  assert.deepEqual(removed.body, { removed: true });
  assert.deepEqual((await call(made, "/v1/schedules", {})).body.schedules, []);
  const [kept] = (await call(made, "/v1/schedules/runs", {})).body.runs;
  assert.equal(kept.id, ran.runId, "its history stays");
  assert.equal(kept.title, "每天汇总", "under the name it had");
  assert.equal(kept.taskDeleted, true);
  assert.deepEqual((await call(made, "/v1/schedules/runs", { token: "colleague" })).body.runs, [], "and it is still nobody else's");
  const gone = await call(made, "/v1/schedules/runs/delete", { body: { runId: ran.runId } });
  assert.deepEqual(gone.body, { removed: true }, "and can be deleted on its own");
});

test("the run history is across every schedule, newest first, and names each one", async (t) => {
  const { service: made, store } = await service(t);
  const first = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  const second = (await call(made, "/v1/schedules/create", { body: { ...daily(), title: "另一个" } })).body.schedule;
  store.claim(store.get(ME, first.id), at(2026, 9, 16, 9, 0));
  store.claim(store.get(ME, second.id), at(2026, 9, 16, 9, 1));

  const history = await call(made, "/v1/schedules/runs", {});
  assert.equal(history.body.runs.length, 2);
  assert.equal(history.body.runs[0].title, "另一个", "newest first");
  assert.equal(history.body.runs[1].title, "每天汇总");
  assert.ok(history.body.runs.every((row) => row.scheduleId), "each row says which schedule it came from");
});

test("a rule that cannot be carried out is refused with the person's own wording", async (t) => {
  const { service: made } = await service(t);
  const bad = await call(made, "/v1/schedules/create", { body: { ...daily(), schedule: { frequency: "hourly" } } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /执行频率/);
  const noTitle = await call(made, "/v1/schedules/create", { body: { ...daily(), title: "" } });
  assert.match(noTitle.body.error, /名称/);
});

test("only a verified login reaches this, and only through its own routes", async (t) => {
  const { service: made } = await service(t);
  assert.equal((await call(made, "/v1/schedules", { token: "nobody" })).status, 401);
  assert.equal((await call(made, "/v1/schedules", { token: "dev" })).status, 403, "development login is refused by default");
  assert.equal((await call(made, "/v1/schedules", { token: "wrong" })).status, 403, "and so is a narrower audience");
  assert.equal((await call(made, "/v1/schedules", { headers: { origin: "https://example.com" } })).status, 403, "a browser is never the caller");
  assert.equal((await call(made, "/v1/schedules", { method: "GET" })).status, 405);
  // Another service's route is left to that service.
  const res = response();
  assert.equal(await made.handle(request("/healthz"), res), false);
});

test("a development login works when the server is started that way", async (t) => {
  const { service: made } = await service(t, { allowDevelopment: true });
  assert.equal((await call(made, "/v1/schedules", { token: "dev" })).status, 200);
});

test("authorizing hands over an identity and revives what had no identity to run as", async (t) => {
  const { service: made, store, consent } = await service(t);
  const mine = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  // A schedule whose owner was not signed in suspends itself; re-authorizing is
  // what puts it back on the clock, or the person would sign in and find their
  // schedules still sitting there.
  store.suspend(ME.tenantId, mine.id);

  assert.deepEqual((await call(made, "/v1/schedules/consent", {})).body, { authorized: false, expiresAt: null });
  const granted = await call(made, "/v1/schedules/authorize", {});
  assert.equal(granted.body.authorized, true);
  assert.equal(granted.body.resumed, 1, "and the suspended one comes back");
  assert.equal(store.get(ME, mine.id).suspendedAt, null);
  assert.equal(consent.live(ME.tenantId, ME.userId).token, "me");

  const revoked = await call(made, "/v1/schedules/revoke", {});
  assert.deepEqual(revoked.body, { authorized: false, revoked: true });
  assert.equal(consent.live(ME.tenantId, ME.userId), null);
});

test("the identity comes from the request's own Bearer, never from the body", async (t) => {
  // A token in a body is a token in a log, and the one that authorises this is
  // by definition the one already presented.
  const { service: made, consent } = await service(t);
  await call(made, "/v1/schedules/authorize", { token: "me", body: { token: "colleague" } });
  assert.equal(consent.live(ME.tenantId, ME.userId).token, "me");
  assert.equal(consent.live(COLLEAGUE.tenantId, COLLEAGUE.userId), null, "the body was not read as an identity");
});

test("one person authorizing does not authorize another", async (t) => {
  const { service: made, consent } = await service(t);
  await call(made, "/v1/schedules/authorize", { token: "me" });
  assert.deepEqual((await call(made, "/v1/schedules/consent", { token: "colleague" })).body, { authorized: false, expiresAt: null });
  await call(made, "/v1/schedules/revoke", { token: "colleague" });
  assert.equal(consent.live(ME.tenantId, ME.userId).token, "me", "and revoking theirs leaves mine alone");
});

test("an oversized or malformed body is refused before it is parsed as a schedule", async (t) => {
  const { service: made } = await service(t);
  const huge = Object.assign(Readable.from([Buffer.alloc(33_000, 0x20)]),
    { method: "POST", url: "/v1/schedules/create", headers: { authorization: "Bearer me", "content-type": "application/json" }, resume() {} });
  const res = response();
  await made.handle(huge, res);
  assert.equal(res.status, 413);

  const wrongType = await call(made, "/v1/schedules/create", { headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 415);
});

test("the advertised 4000-character Chinese prompt crosses HTTP without truncation", async t => {
  const { service: made } = await service(t);
  const prompt = "中".repeat(4000);
  const created = await call(made, "/v1/schedules/create", { body: { ...daily(), prompt } });
  assert.equal(created.status, 200);
  assert.equal(created.body.schedule.prompt, prompt);
  assert.equal((await call(made, "/v1/schedules", { token: "colleague" })).body.schedules.length, 0);
});

// A stand-in for UnattendedConsent: this exercises the routes and the gate, not
// the credential machinery, which has its own tests against a synthetic Feishu.
function fakeUnattended() {
  const state = { granted: false, calls: [] };
  return { state,
    async grantRedeemed(redeemed) { state.calls.push(["grant", redeemed.userId, redeemed.refreshToken]); state.granted = true; return { expiresAt: NOW + 30 * 86400_000 }; },
    async revoke(who) { state.calls.push(["revoke", who.userId]); const had = state.granted; state.granted = false; return had; },
    async status() { return { available: true, windowDays: 30, authorized: state.granted, expiresAt: state.granted ? NOW + 30 * 86400_000 : null, state: null, reason: null, lastUsedAt: null }; } };
}

// A stand-in for the login service's dedicated authorization: `authorize`
// completes the flow the way a Feishu callback would, handing over the
// refresh token of an authorization belonging to `as`.
const FLOW = "f".repeat(43);
function fakeGrants() {
  const flows = new Map();
  return {
    begin(who, redeemed) { flows.set(FLOW, { who, redeemed, status: "pending" }); return { flowId: FLOW, launchUrl: `https://cp.example/auth/feishu/launch?flow=${FLOW}`, expiresAt: NOW + 300_000 }; },
    async authorize(as = ME) {
      const flow = flows.get(FLOW);
      try { flow.result = await flow.redeemed({ appId: "cli_x", tenantId: as.tenantId, userId: as.userId, refreshToken: "dedicated-refresh" }); flow.status = "granted"; }
      catch { flow.status = "grant_failed"; }
    },
    status(who, flowId) {
      const flow = flows.get(flowId);
      if (!flow || flow.who.familyId !== who.familyId) throw Object.assign(new Error("grant_unknown"), { status: 404 });
      return { status: flow.status, ...(flow.result ?? {}), ...(flow.status === "pending" ? { expiresAt: NOW + 300_000 } : {}) };
    },
  };
}

test("unattended running is offered, granted and taken back through its own routes", async (t) => {
  const unattended = fakeUnattended(), grants = fakeGrants();
  const { service: made, store, armed } = await service(t, { unattended, grants });
  const created = await call(made, "/v1/schedules/create", { body: daily() });
  store.suspend(ME.tenantId, created.body.schedule.id);

  const before = await call(made, "/v1/schedules/unattended", {});
  assert.equal(before.body.authorized, false);
  assert.equal(before.body.windowDays, 30, "the window travels so the confirmation can name a real date");

  // Authorizing starts a dedicated Feishu authorization; nothing is granted yet.
  const begun = await call(made, "/v1/schedules/unattended/authorize", {});
  assert.equal(begun.status, 200);
  assert.deepEqual(begun.body, { pending: true, flowId: FLOW, launchUrl: `https://cp.example/auth/feishu/launch?flow=${FLOW}`, expiresAt: NOW + 300_000 });
  assert.equal(unattended.state.calls.length, 0);
  assert.equal((await call(made, "/v1/schedules/unattended/authorize/status", { body: { flowId: FLOW } })).body.status, "pending");

  await grants.authorize();
  const granted = await call(made, "/v1/schedules/unattended/authorize/status", { body: { flowId: FLOW } });
  assert.equal(granted.status, 200);
  assert.equal(granted.body.authorized, true);
  assert.equal(granted.body.resumed, 1, "what was suspended for want of an identity runs again");
  assert.equal(armed.length > 0, true, "and the clock is re-armed");
  // Its own authorization's token, never anything from the request.
  assert.deepEqual(unattended.state.calls[0], ["grant", ME.userId, "dedicated-refresh"]);

  assert.equal((await call(made, "/v1/schedules/unattended", {})).body.authorized, true);
  const revoked = await call(made, "/v1/schedules/unattended/revoke", {});
  assert.deepEqual(revoked.body, { authorized: false, revoked: true });
  assert.equal((await call(made, "/v1/schedules/unattended", {})).body.authorized, false);
});

test("an authorization that turns out to be someone else's is not kept", async (t) => {
  const unattended = fakeUnattended(), grants = fakeGrants();
  const { service: made } = await service(t, { unattended, grants });
  await call(made, "/v1/schedules/unattended/authorize", {});
  await grants.authorize(COLLEAGUE);
  const answer = await call(made, "/v1/schedules/unattended/authorize/status", { body: { flowId: FLOW } });
  assert.equal(answer.body.status, "grant_failed");
  assert.equal(unattended.state.calls.length, 0, "nothing was sealed");
  assert.equal((await call(made, "/v1/schedules/unattended/authorize/status", { token: "colleague", body: { flowId: FLOW } })).status, 404,
    "and another person cannot read someone's authorization");
});

test("revoking unattended running does not quietly restart anything", async (t) => {
  const unattended = fakeUnattended(), grants = fakeGrants();
  const { service: made, store } = await service(t, { unattended, grants });
  const created = await call(made, "/v1/schedules/create", { body: daily() });
  await call(made, "/v1/schedules/unattended/authorize", {});
  await grants.authorize();
  store.suspend(ME.tenantId, created.body.schedule.id);
  await call(made, "/v1/schedules/unattended/revoke", {});
  assert.equal(store.get(ME, created.body.schedule.id).suspendedAt !== null, true, "taking consent back is not a way to resume tasks");
});

test("a server without the feature says so rather than failing the request", async (t) => {
  // The desktop asks this to decide whether to offer the choice at all. A 503
  // would make it draw a button that can only ever error.
  const { service: made } = await service(t);
  const status = await call(made, "/v1/schedules/unattended", {});
  assert.equal(status.status, 200);
  assert.equal(status.body.available, false);
  assert.equal(status.body.authorized, false);
  assert.equal((await call(made, "/v1/schedules/unattended/authorize", {})).status, 503);
  assert.equal((await call(made, "/v1/schedules/unattended/authorize/status", { body: { flowId: FLOW } })).status, 503);
});

test("the unattended routes keep the gate every other route has", async (t) => {
  const { service: made } = await service(t, { unattended: fakeUnattended(), grants: fakeGrants() });
  for (const url of ["/v1/schedules/unattended", "/v1/schedules/unattended/authorize", "/v1/schedules/unattended/authorize/status", "/v1/schedules/unattended/revoke"]) {
    assert.equal((await call(made, url, { method: "GET" })).status, 405, `${url} is POST only`);
    assert.equal((await call(made, url, { headers: { origin: "https://example.test" } })).status, 403, `${url} refuses a browser`);
    assert.equal((await call(made, url, { token: "nobody" })).status, 401, `${url} needs a live login`);
    // Signed in but with the wrong audience: authenticated, not authorized.
    assert.equal((await call(made, url, { token: "wrong" })).status, 403, `${url} refuses a derived audience`);
  }
});

test("nothing the unattended routes answer with is a token", async (t) => {
  const grants = fakeGrants();
  const { service: made } = await service(t, { unattended: fakeUnattended(), grants });
  const bodies = [];
  bodies.push((await call(made, "/v1/schedules/unattended/authorize", {})).body);
  await grants.authorize();
  bodies.push((await call(made, "/v1/schedules/unattended/authorize/status", { body: { flowId: FLOW } })).body);
  for (const url of ["/v1/schedules/unattended", "/v1/schedules/unattended/revoke"]) bodies.push((await call(made, url, {})).body);
  assert.doesNotMatch(JSON.stringify(bodies), /"me"|Bearer|refresh|sealed/i);
});

// ---- 编辑 and 立即运行 through the service ----

test("a task can be edited by its owner against the version they saw, and by nobody else", async (t) => {
  const { service: made } = await service(t);
  const created = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  assert.ok(Number.isSafeInteger(created.updatedAt), "the list carries the version an edit is made against");
  const edited = await call(made, "/v1/schedules/update", { body: { ...daily(), id: created.id, title: "改过的名字", expectedUpdatedAt: created.updatedAt } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.schedule.title, "改过的名字");
  // The same stale version a second time is a conflict, not an overwrite.
  const stale = await call(made, "/v1/schedules/update", { body: { ...daily(), id: created.id, title: "旧窗口", expectedUpdatedAt: created.updatedAt } });
  assert.equal(stale.status, 409);
  // Someone else in the tenant is told it does not exist.
  const other = await call(made, "/v1/schedules/update", { token: "colleague", body: { ...daily(), id: created.id, expectedUpdatedAt: edited.body.schedule.updatedAt } });
  assert.equal(other.status, 404);
  const missing = await call(made, "/v1/schedules/update", { body: { ...daily(), id: created.id } });
  assert.equal(missing.status, 400, "no version, no edit");
});

test("a run now reaches the scheduler for the owner's task, and says so plainly when it cannot", async (t) => {
  const asked = [];
  const { service: made } = await service(t, { runNow: async (row) => { asked.push(row.id); return { runId: "run-now-1", started: true }; } });
  const created = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  const ran = await call(made, "/v1/schedules/run-now", { body: { id: created.id } });
  assert.equal(ran.status, 200);
  assert.deepEqual(ran.body.run, { runId: "run-now-1", started: true });
  assert.deepEqual(asked, [created.id]);
  assert.equal((await call(made, "/v1/schedules/run-now", { token: "colleague", body: { id: created.id } })).status, 404);

  // The scheduler's own refusal keeps its status and its words.
  const { service: busy } = await service(t, { runNow: async () => { throw Object.assign(new Error("这个任务正在执行，请等它结束后再试"), { status: 409 }); } });
  const row = (await call(busy, "/v1/schedules/create", { body: daily() })).body.schedule;
  const refused = await call(busy, "/v1/schedules/run-now", { body: { id: row.id } });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /正在执行/);

  // A server that manages schedules but does not execute them says that.
  const { service: manageOnly } = await service(t);
  const kept = (await call(manageOnly, "/v1/schedules/create", { body: daily() })).body.schedule;
  const none = await call(manageOnly, "/v1/schedules/run-now", { body: { id: kept.id } });
  assert.equal(none.status, 503);
  assert.match(none.body.error, /不执行/);
});

// 运行记录, one record at a time: set aside and back, deleted, and narrowed by
// the view's filter -- each only on the person's own finished runs.
test("one run record is set aside, brought back or deleted by its owner, and by nobody else", async (t) => {
  const { service: made, store } = await service(t);
  const mine = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  const done = store.claim(store.get(ME, mine.id), at(2026, 9, 16, 9, 0));
  store.finish(ME.tenantId, done.runId, "failed", "飞书读取失败");
  const going = store.claimNow(store.get(ME, mine.id), at(2026, 9, 16, 9, 5));

  const set = await call(made, "/v1/schedules/runs/shelve", { body: { runId: done.runId, shelved: true } });
  assert.equal(set.status, 200);
  assert.equal(set.body.run.id, done.runId);
  assert.equal(set.body.run.shelvedAt, NOW);
  assert.equal(set.body.run.title, "每天汇总", "answered the way the list shows it");
  assert.deepEqual((await call(made, "/v1/schedules/runs", {})).body.runs.map((run) => run.id), [going.runId]);
  assert.deepEqual((await call(made, "/v1/schedules/runs", { body: { filter: "shelved" } })).body.runs.map((run) => run.id), [done.runId]);
  assert.deepEqual((await call(made, "/v1/schedules/runs", { body: { filter: "running" } })).body.runs.map((run) => run.id), [going.runId]);
  assert.equal((await call(made, "/v1/schedules/runs", { body: { filter: "everything" } })).status, 400);

  // Someone else's run is the same 404 as one that does not exist.
  for (const [route, body] of [["/v1/schedules/runs/shelve", { runId: done.runId, shelved: false }], ["/v1/schedules/runs/delete", { runId: done.runId }]]) {
    const refused = await call(made, route, { token: "colleague", body });
    assert.equal(refused.status, 404, route);
    assert.match(refused.body.error, /找不到这条运行记录/);
  }
  assert.equal(store.getRun(ME, done.runId).shelvedAt, NOW, "and nothing changed");
  const peek = await call(made, "/v1/schedules/runs/delete", { token: "colleague", body: { runId: going.runId } });
  assert.equal(peek.status, 404, "not a 409: that someone's run is in progress is not a colleague's to learn");

  const busy = await call(made, "/v1/schedules/runs/delete", { body: { runId: going.runId } });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error, "任务进行中，无法删除");
  assert.equal((await call(made, "/v1/schedules/runs/shelve", { body: { runId: going.runId, shelved: true } })).body.error, "任务进行中，无法归档");

  assert.equal((await call(made, "/v1/schedules/runs/shelve", { body: { runId: done.runId, shelved: false } })).body.run.shelvedAt, null);
  const removed = await call(made, "/v1/schedules/runs/delete", { body: { runId: done.runId } });
  assert.deepEqual(removed.body, { removed: true });
  assert.equal((await call(made, "/v1/schedules/runs/delete", { body: { runId: done.runId } })).status, 404, "gone");
  assert.equal((await call(made, "/v1/schedules", {})).body.schedules.length, 1, "the schedule itself is untouched");

  for (const body of [{}, { runId: "not-a-run" }, { runId: done.runId, shelved: "yes" }]) {
    assert.equal((await call(made, "/v1/schedules/runs/shelve", { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(made, "/v1/schedules/runs/delete", { headers: { origin: "https://example.com" }, body: { runId: going.runId } })).status, 403,
    "the same gate as every other route");
});

// Checked, then acted on: a second window deleting the same record in between
// must still end in "gone", not in a success that removed nothing.
test("a run record deleted in between the check and the delete is reported gone", async (t) => {
  const { service: made, store } = await service(t);
  const mine = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  const done = store.claimNow(store.get(ME, mine.id), NOW);
  store.finish(ME.tenantId, done.runId, "completed");
  store.deleteRun = () => false;
  store.shelveRun = () => null;
  assert.equal((await call(made, "/v1/schedules/runs/delete", { body: { runId: done.runId } })).status, 404);
  assert.equal((await call(made, "/v1/schedules/runs/shelve", { body: { runId: done.runId, shelved: true } })).status, 404);
});

// G12-G14: the list says how each task's newest run stands; a task's own
// history is filtered like 运行记录.
test("the list carries each task's newest run, and one task's history takes the view's filters", async (t) => {
  const { service: made, store } = await service(t);
  const mine = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  const quiet = (await call(made, "/v1/schedules/create", { body: { ...daily(), title: "从没跑过" } })).body.schedule;
  const done = store.claimNow(store.get(ME, mine.id), NOW);
  store.finish(ME.tenantId, done.runId, "failed", "飞书读取失败");
  const listed = (await call(made, "/v1/schedules", {})).body.schedules;
  assert.deepEqual(listed.find((row) => row.id === mine.id).lastRun, { id: done.runId, startedAt: NOW, finishedAt: NOW, outcome: "failed", kind: "manual" });
  assert.equal(listed.find((row) => row.id === quiet.id).lastRun, null);
  assert.deepEqual((await call(made, "/v1/schedules/runs", { body: { id: mine.id, filter: "failed" } })).body.runs.map((run) => run.id), [done.runId]);
  assert.deepEqual((await call(made, "/v1/schedules/runs", { body: { id: mine.id, filter: "completed" } })).body.runs, []);
  assert.equal((await call(made, "/v1/schedules/runs", { token: "colleague", body: { id: mine.id } })).status, 404);
});

// 测试通知 (G9). Pressed in 设置 by the person, sent to that person; what the
// server can say about its channel is shown before anything is pressed.
test("a test notification goes to the one who pressed it, once", async (t) => {
  const off = await service(t);
  const refused = await call(off.service, "/v1/schedules/notify/test", {});
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, /没有开启飞书消息推送/, "said in words, for 设置 to show as it is");

  let clock = NOW;
  const asked = [];
  const push = { test: async (value) => { asked.push(value); return { sent: true, as: "bot" }; } };
  const { service: made } = await service(t, { push, now: () => clock });
  // A body naming someone else is not read at all.
  assert.deepEqual((await call(made, "/v1/schedules/notify/test", { body: { userId: "person-b", openId: "ou_someone_else", tenantId: "tenant-b" } })).body, { sent: true, as: "bot" });
  assert.deepEqual(asked, [{ who: ME, parentToken: "me" }], "to the caller, on the caller's own session -- nothing from the body");

  const again = await call(made, "/v1/schedules/notify/test", {});
  assert.equal(again.status, 429, "a second press moments later sends nothing");
  assert.match(again.body.error, /稍等/);
  assert.equal(asked.length, 1);
  assert.equal((await call(made, "/v1/schedules/notify/test", { token: "colleague" })).status, 200, "one person's wait is not another's");
  assert.deepEqual(asked[1].who, COLLEAGUE);
  clock += 10_000;
  assert.equal((await call(made, "/v1/schedules/notify/test", {})).status, 200, "and it passes");
  assert.equal(asked.length, 3);

  const browser = await call(made, "/v1/schedules/notify/test", { token: "colleague", headers: { origin: "https://example.com" } });
  assert.equal(browser.status, 403);
});

test("a test that did not go says why, in words and in the server's own code", async (t) => {
  const push = { test: async () => ({ sent: false, reason: "owner_not_feishu" }) };
  const { service: made } = await service(t, { push, allowDevelopment: true });
  const result = await call(made, "/v1/schedules/notify/test", { token: "dev" });
  assert.equal(result.status, 200, "an answer, not an error: the request itself was fine");
  assert.equal(result.body.sent, false);
  assert.equal(result.body.reason, "owner_not_feishu");
  assert.match(result.body.message, /开发登录/);
});


test("a start date set in the dialog reaches the store, and the first run waits for it (G17)", async (t) => {
  const { service: made } = await service(t);
  const start = at(2026, 10, 1, 0, 0);
  const created = await call(made, "/v1/schedules/create", { body: { ...daily(), startAt: start, endAt: at(2026, 12, 31, 23, 59) } });
  assert.equal(created.status, 200);
  assert.equal(created.body.schedule.startAt, start);
  assert.equal(created.body.schedule.nextAt, at(2026, 10, 1, 9, 0));
  const backwards = await call(made, "/v1/schedules/create", { body: { ...daily(), startAt: start, endAt: at(2026, 9, 20, 23, 59) } });
  assert.equal(backwards.status, 400);
  assert.match(backwards.body.error, /开始日期要早于结束日期/);
});

// 结果还写到 (schedule-deliveries.js): offered only where this server can write
// there for this person, and each document proven editable, as them, when chosen.
const WRITER = { ...ME, cliBridge: true, cliDocumentWrites: true, cliMessageWrites: true };
const DOC_LINK = "https://fixture.feishu.cn/docx/ConcreteDoc123";
function writableResolver({ actions = ["document.append", "message.send"], resolved = null, refuse = null } = {}) {
  const seen = [];
  return { seen, scheduleResourcesEnabled: true, cliWriteActions: actions,
    resolveScheduleResources: async (token, resources, options = {}) => {
      seen.push({ token, kinds: resources.map((row) => row.kind), action: options.action ?? "view" });
      if (refuse) throw Object.assign(new Error(refuse), { status: 403 });
      return resolved ?? resources.map((row) => ({ kind: row.kind, reference: DOC_LINK, label: "服务端核验的标题" }));
    } };
}

test("where results can also go is offered only where this server, and this login, can write there", async (t) => {
  const listed = async (options, token = "writer") => (await call((await service(t, { feishu: SAAS_FEISHU, people: { writer: WRITER }, ...options })).service, "/v1/schedules", { token })).body;
  assert.deepEqual((await listed({ resourceResolver: writableResolver() })).deliveries, { max: 3, kinds: ["document", "chat"] });
  assert.deepEqual((await listed({ resourceResolver: writableResolver({ actions: ["message.send"] }) })).deliveries, { max: 3, kinds: ["chat"] });
  assert.equal((await listed({ resourceResolver: writableResolver() }, "me")).deliveries, undefined, "a login that cannot write through the bridge is offered nothing");
  assert.equal((await listed({ resourceResolver: writableResolver({ actions: [] }) })).deliveries, undefined);
  assert.equal((await listed({ resourceResolver: { ...writableResolver(), scheduleResourcesEnabled: false } })).deliveries, undefined);
  assert.equal((await listed({ resourceResolver: null })).deliveries, undefined, "nothing without the bridge");
});

test("a document chosen for the results is proven editable, as the person, when the task is saved", async (t) => {
  const resolver = writableResolver();
  const { service: made, store } = await service(t, { feishu: SAAS_FEISHU, resourceResolver: resolver, people: { writer: WRITER } });
  const created = await call(made, "/v1/schedules/create", { token: "writer", body: { ...daily(), deliveries: [
    { kind: "chat", id: "oc_FixtureChat123", label: "产品群" },
    { kind: "document", reference: "https://fixture.feishu.cn/wiki/WikiNode123", label: "客户端声称" },
  ] } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.deepEqual(resolver.seen, [{ token: "writer", kinds: ["document"], action: "edit" }], "an edit check, as the person asking; chats are not probed");
  const expected = [{ kind: "document", id: "ConcreteDoc123", reference: DOC_LINK, label: "服务端核验的标题" }, { kind: "chat", id: "oc_FixtureChat123", label: "产品群" }];
  assert.deepEqual(created.body.schedule.deliveries, expected, "the server's resolution, never the client's mapping");
  assert.deepEqual(store.get(ME, created.body.schedule.id).deliveries, expected);
  assert.deepEqual((await call(made, "/v1/schedules", { token: "writer" })).body.schedules[0].deliveries, expected);
});

test("a place the person cannot write to, or this server cannot, is refused rather than stored", async (t) => {
  const attempt = async (options, deliveries, token = "writer") => {
    const { service: made, store } = await service(t, { feishu: SAAS_FEISHU, people: { writer: WRITER }, ...options });
    const answer = await call(made, "/v1/schedules/create", { token, body: { ...daily(), deliveries } });
    assert.equal(store.list(ME).length, 0, "nothing was created");
    return answer;
  };
  const doc = [{ kind: "document", reference: DOC_LINK }];
  const denied = await attempt({ resourceResolver: writableResolver({ refuse: "schedule_resource_access_denied" }) }, doc);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /不能编辑这份文档/, "said as editing, not reading");
  const sheet = await attempt({ resourceResolver: writableResolver({ resolved: [{ kind: "sheet", reference: "https://fixture.feishu.cn/sheets/Sheet123456" }] }) }, doc);
  assert.equal(sheet.status, 400);
  assert.match(sheet.body.error, /只能追加到文档/);
  const noChats = await attempt({ resourceResolver: writableResolver({ actions: ["document.append"] }) }, [{ kind: "chat", id: "oc_FixtureChat123" }]);
  assert.equal(noChats.status, 400);
  assert.match(noChats.body.error, /不能发到会话/);
  const noLogin = await attempt({ resourceResolver: writableResolver() }, doc, "me");
  assert.equal(noLogin.status, 400);
  assert.match(noLogin.body.error, /不能追加到文档/);
  const many = await attempt({ resourceResolver: writableResolver() }, new Array(4).fill(0).map((_, index) => ({ kind: "chat", id: `oc_FixtureChat12${index}` })));
  assert.equal(many.status, 400);
  assert.match(many.body.error, /最多写到 3 个地方/);
  const badChat = await attempt({ resourceResolver: writableResolver() }, [{ kind: "chat", id: "ou_notachat123" }]);
  assert.equal(badChat.status, 400);
});

test("an edit keeps where results go unless it says, and what it says is proven again", async (t) => {
  const resolver = writableResolver();
  const { service: made, store } = await service(t, { feishu: SAAS_FEISHU, resourceResolver: resolver, people: { writer: WRITER } });
  const created = (await call(made, "/v1/schedules/create", { token: "writer", body: { ...daily(), deliveries: [{ kind: "document", reference: DOC_LINK }] } })).body.schedule;
  resolver.seen.length = 0;
  const renamed = await call(made, "/v1/schedules/update", { token: "writer", body: { ...daily(), title: "改名", id: created.id, expectedUpdatedAt: created.updatedAt } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(resolver.seen.length, 0, "a change that does not touch them asks Feishu nothing");
  assert.deepEqual(renamed.body.schedule.deliveries, created.deliveries);
  const moved = await call(made, "/v1/schedules/update", { token: "writer", body: { ...daily(), id: created.id, expectedUpdatedAt: renamed.body.schedule.updatedAt,
    deliveries: [{ kind: "chat", id: "oc_FixtureChat123", label: "产品群" }] } });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.body.schedule.deliveries, [{ kind: "chat", id: "oc_FixtureChat123", label: "产品群" }]);
  const cleared = await call(made, "/v1/schedules/update", { token: "writer", body: { ...daily(), id: created.id, expectedUpdatedAt: moved.body.schedule.updatedAt, deliveries: [] } });
  assert.deepEqual(cleared.body.schedule.deliveries, []);
  assert.deepEqual(store.get(ME, created.id).deliveries, []);
  // A refused proof leaves the task as it was.
  const refusing = writableResolver({ refuse: "schedule_resource_access_denied" });
  const again = await service(t, { feishu: SAAS_FEISHU, resourceResolver: refusing, people: { writer: WRITER } });
  const plain = (await call(again.service, "/v1/schedules/create", { token: "writer", body: daily() })).body.schedule;
  const refused = await call(again.service, "/v1/schedules/update", { token: "writer", body: { ...daily(), title: "不应保存", id: plain.id, expectedUpdatedAt: plain.updatedAt,
    deliveries: [{ kind: "document", reference: DOC_LINK }] } });
  assert.equal(refused.status, 403);
  assert.equal(again.store.get(ME, plain.id).title, "每天汇总", "nothing of the edit was kept");
});

// A report linked before 2026-09-29 was linked as /drive/file/<token>, which
// Feishu answers with its 404 page. The record keeps what was written; the
// person is shown the link the deployment opens -- the button and the sentence.
test("a report linked in the old form is shown with the link Feishu opens, and a current one as it is", async (t) => {
  const { service: made, store } = await service(t, { feishu: SAAS_FEISHU });
  const created = (await call(made, "/v1/schedules/create", { body: daily() })).body.schedule;
  const old = "https://tenant.feishu.cn/drive/file/FileTokenFixture001", real = "https://tenant.feishu.cn/file/FileTokenFixture001";
  const artifact = (url, runId) => ({ state: "verified", providerId: "saas-cli", fileToken: "FileTokenFixture001", url, name: `mydoubao-${runId}.schedule.md`, bytes: 3, sha256: "a".repeat(64), archivedAt: NOW });
  const before = store.claimNow(store.get(ME, created.id), NOW);
  store.finish(ME.tenantId, before.runId, "completed", `报告已保存到飞书云盘：${old}`, artifact(old, before.runId));
  const after = store.claimNow(store.get(ME, created.id), NOW + 1000);
  store.finish(ME.tenantId, after.runId, "completed", `报告已保存到飞书云盘：${real}`, artifact(real, after.runId));
  for (const body of [{}, { id: created.id }]) {
    const { runs } = (await call(made, "/v1/schedules/runs", { body })).body;
    for (const run of runs) {
      assert.equal(run.artifact.url, real, "the button opens the file");
      assert.equal(run.detail, `报告已保存到飞书云盘：${real}`, "and the sentence names it the same way");
    }
    assert.equal(runs.length, 2);
  }
  assert.equal(store.getRun(ME, before.runId).artifact.url, old, "what was written stays written");
  const shelved = (await call(made, "/v1/schedules/runs/shelve", { body: { runId: before.runId, shelved: true } })).body.run;
  assert.equal(shelved.artifact.url, real);
  // Without a Feishu deployment nothing is rewritten.
  const plain = await service(t);
  const again = (await call(plain.service, "/v1/schedules/create", { body: daily() })).body.schedule;
  const claim = plain.store.claimNow(plain.store.get(ME, again.id), NOW);
  plain.store.finish(ME.tenantId, claim.runId, "completed", `报告：${old}`, artifact(old, claim.runId));
  assert.equal((await call(plain.service, "/v1/schedules/runs", { body: {} })).body.runs[0].artifact.url, old);
});
