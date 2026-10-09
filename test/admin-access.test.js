// Disabling a person and signing them out of every device (access-list.js),
// enforced where every request and every mint passes: SessionRegistry, the
// sign-in and resume of feishu-login.js, unattended runs, published sites.
// docs/admin-console.md §5. Each case here fails if its check is taken out.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import pg from "pg";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { AccessList, AccessRefused, ACCESS_LIMITS } from "../src/control-plane/access-list.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { PostgresStateStore } from "../src/control-plane/state-store.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { FeishuLoginClient } from "../src/application/feishu-login-client.js";
import { openResume, sealResume } from "../src/control-plane/resume-credential.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { testPostgres } from "./helpers/postgres.js";

const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));

const ADMIN = { userId: "ou_admin_synthetic", name: "管理员" };
const PERSON = { tenantId: "allowed-tenant", userId: "ou_synthetic" };
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error("timed out"); await new Promise((resolve) => setTimeout(resolve, 20)); }
};

async function memoryAccess(t, clock = { at: 1_000_000 }) {
  const db = await openAdminDatabase();
  const access = await AccessList.open({ db, now: () => clock.at });
  t.after(async () => { access.close(); await db.close(); });
  return { db, access, clock };
}
const issue = (sessions, who = PERSON) => sessions.issue({ ...who, deviceId: "device-a", authProvider: "feishu", appId: "cli_synthetic", deviceProof: "ed25519-login" });

test("disabled: no session is accepted or issued, and enabling again lets a new sign-in through but not the old sessions", async (t) => {
  const { access, clock } = await memoryAccess(t);
  const sessions = new SessionRegistry({ access, now: () => clock.at });
  const before = issue(sessions);
  const child = sessions.issueForModelTurn(before.token);
  assert.ok(sessions.verify(before.token) && sessions.verify(child.token));
  clock.at += 1000;
  const [changed] = await access.disable([PERSON], { reason: "离职", by: ADMIN });
  assert.deepEqual(changed.after, { disabled: true, signedOutAt: clock.at });
  assert.equal(sessions.verify(before.token), null, "the login");
  assert.equal(sessions.verify(child.token), null, "and every token it minted");
  assert.throws(() => issue(sessions), (error) => error instanceof AccessRefused && error.code === "account_disabled");
  assert.equal(access.refusal(PERSON.tenantId, PERSON.userId, Infinity), "account_disabled");
  clock.at += 1000;
  await access.enable([PERSON], { by: ADMIN });
  assert.equal(sessions.verify(before.token), null, "enabling does not bring back a session from before");
  clock.at += 1000;
  const after = issue(sessions);
  assert.ok(sessions.verify(after.token), "a sign-in after enabling works");
  assert.ok(sessions.verify(sessions.rotate(after.token, 60_000).token), "and renews");
});

test("signed out: every session from before the moment is refused, a sign-in after it works", async (t) => {
  const { access, clock } = await memoryAccess(t);
  const sessions = new SessionRegistry({ access, now: () => clock.at });
  const first = issue(sessions);
  clock.at += 60_000;
  const renewed = sessions.rotate(first.token, 900_000);
  assert.equal(renewed.issuedAt, first.issuedAt, "a renewal belongs to the login it continues");
  clock.at += 1000;
  await access.signOut([PERSON], { by: ADMIN });
  assert.equal(sessions.verify(renewed.token), null, "renewed after the sign-in, still from before the sign-out");
  clock.at += 1;
  const fresh = issue(sessions);
  assert.ok(sessions.verify(fresh.token));
  assert.equal(access.refusal(PERSON.tenantId, PERSON.userId, 0), "signed_out", "a stored credential with no time is the oldest there is");
});

test("a session written by a build from before the field has no login time, and is refused once the person is signed out", async (t) => {
  const { access, clock } = await memoryAccess(t);
  const sessions = new SessionRegistry({ access, now: () => clock.at });
  const issued = issue(sessions);
  // As an older build wrote it: everything but issuedAt.
  const key = [...sessions.sessions.keys()][0];
  const { issuedAt, ...older } = sessions.sessions.get(key);
  assert.ok(issuedAt);
  sessions.sessions.set(key, Object.freeze(older));
  assert.ok(sessions.verify(issued.token));
  await access.signOut([PERSON], { by: ADMIN });
  assert.equal(sessions.verify(issued.token), null);
});

test("the access list refuses what is not a person, and more than a bulk action may hold", async (t) => {
  const { access } = await memoryAccess(t);
  await assert.rejects(access.disable([{ tenantId: "t", userId: "has space" }], { by: ADMIN }), /人员标识无效/);
  const many = Array.from({ length: ACCESS_LIMITS.bulk + 1 }, (_, index) => ({ tenantId: "t", userId: `ou_${index}` }));
  await assert.rejects(access.disable(many, { by: ADMIN }), /一次最多处理/);
  assert.deepEqual(await access.enable([PERSON], { by: ADMIN }), [], "enabling somebody nobody disabled changes nothing");
  const [one] = await access.disable([PERSON], { reason: "x".repeat(500), by: ADMIN });
  assert.ok(one);
  assert.equal(access.get(PERSON.tenantId, PERSON.userId).reason.length, ACCESS_LIMITS.reasonChars);
  assert.deepEqual(await access.disable([PERSON], { reason: "x".repeat(500), by: ADMIN }), [], "the same again is no change");
  assert.equal((await access.disabled({ tenantId: PERSON.tenantId })).length, 1);
});

test("postgres: one process disables, another refuses within moments, and signing out takes every session out of the shared store", async (t) => {
  const settings = await (await postgres()).database();
  const pools = [], closers = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); for (const pool of pools) await pool.end(); });
  const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
  const pool = () => { const made = new pg.Pool({ ...settings, max: 4 }); made.on("error", () => {}); pools.push(made); return made; };
  const key = randomBytes(32);
  const replica = async () => {
    const db = await openAdminDatabase({ pool: pool(), connect });
    const access = await AccessList.open({ db });
    const state = await PostgresStateStore.open({ pool: pool(), connect, key });
    const sessions = new SessionRegistry({ state, access });
    closers.push(async () => { sessions.close(); access.close(); await state.close(); await db.close(); });
    return { db, access, state, sessions };
  };
  const [coordinator, api] = [await replica(), await replica()];
  const issued = issue(coordinator.sessions);
  const other = issue(coordinator.sessions, { tenantId: PERSON.tenantId, userId: "ou_someone_else" });
  await coordinator.sessions.persisted(issued.token, other.token);
  await api.sessions.ensure(issued.token);
  assert.ok(api.sessions.verify(issued.token, { shared: true }), "the model replica holds the session");

  await coordinator.access.disable([PERSON], { reason: "调查", by: ADMIN });
  await until(() => api.access.isDisabled(PERSON.tenantId, PERSON.userId));
  assert.equal(api.sessions.verify(issued.token, { shared: true }), null, "refused at the other replica");

  await coordinator.access.enable([PERSON], { by: ADMIN });
  await until(() => !api.access.isDisabled(PERSON.tenantId, PERSON.userId));
  const again = issue(coordinator.sessions);
  await coordinator.sessions.persisted(again.token);
  await api.sessions.ensure(again.token);
  assert.ok(api.sessions.verify(again.token, { shared: true }));
  const families = await coordinator.sessions.revokePerson(PERSON.tenantId, PERSON.userId);
  assert.ok(families >= 1);
  await until(() => api.sessions.verify(again.token, { shared: true }) === null);
  const left = await coordinator.state.list("session", { owner: `${PERSON.tenantId}\n${PERSON.userId}` });
  assert.equal(left.length, 0, "nothing of the person's left in the store");
  assert.ok(coordinator.sessions.verify(other.token), "somebody else is untouched");
});

// The real sign-in and resume, against a Feishu of the test's own.
async function login(t) {
  const { access, db } = await memoryAccess(t, { get at() { return Date.now(); } });
  const reopened = await AccessList.open({ db });
  t.after(() => reopened.close());
  const audit = [];
  const sessions = new SessionRegistry({ access });
  let service;
  const gateway = createModelGateway({ apiKey: "model-secret-fixture", sessions, authHandler: (req, res) => service.handle(req, res),
    fetchImpl: async () => Response.json({ output_text: "unused" }) });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  const feishu = { refreshes: 0 };
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_synthetic", appSecret: "app-secret-fixture", sessions,
    sessionRenewalEnabled: true, longSessionDays: 30,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/open-apis/authen/v2/oauth/token")) {
        if (JSON.parse(options.body).grant_type === "refresh_token") feishu.refreshes += 1;
        return Response.json({ code: 0, access_token: "user-access-fixture", refresh_token: "never-return-refresh", token_type: "Bearer", expires_in: 3600 });
      }
      return Response.json({ code: 0, data: { tenant_key: PERSON.tenantId, open_id: PERSON.userId, name: "合成用户" } });
    } });
  const seen = [];
  service = new FeishuLoginService({ origin, provider, sessions, allowedTenants: [PERSON.tenantId], access, audit: (event) => audit.push(event),
    seen: (identity, client) => seen.push([identity.userId, client]) });
  t.after(() => { service.close(); gateway.close(); gateway.closeAllConnections(); });
  const signIn = async (client) => {
    const begun = await client.begin(origin);
    const launched = await fetch(begun.launchUrl, { redirect: "manual" });
    const url = new URL(`${origin}/auth/feishu/callback`);
    url.searchParams.set("state", new URL(launched.headers.get("location")).searchParams.get("state"));
    url.searchParams.set("code", "synthetic-auth-code");
    const page = await fetch(url, { headers: { cookie: launched.headers.get("set-cookie").split(";")[0] } });
    return { page, complete: () => client.complete() };
  };
  return { access, sessions, origin, signIn, audit, feishu, provider, seen };
}
const device = () => { const key = generateKeyPairSync("ed25519").privateKey; return async () => key; };

test("sign-in: a disabled person is told so on the page Feishu returned to, and the desktop hears account_disabled", async (t) => {
  const f = await login(t);
  await f.access.disable([PERSON], { reason: "离职", by: ADMIN });
  const { page, complete } = await f.signIn(new FeishuLoginClient({ getDeviceKey: device() }));
  assert.equal(page.status, 403);
  assert.match((await page.json()).message, /已被管理员停用/);
  await assert.rejects(complete(), (error) => error.code === "account_disabled");
  assert.deepEqual(f.audit.map((event) => [event.action, event.outcome, event.detail.reason]), [["auth.sign-in", "refused", "account_disabled"]]);
});

test("resume: a credential from before the sign-out is refused before Feishu's refresh token is spent; signing in again issues one that works", async (t) => {
  const f = await login(t), key = device();
  const first = await (await f.signIn(new FeishuLoginClient({ getDeviceKey: key }))).complete();
  assert.equal(first.status, "authenticated");
  assert.equal(openResume(f.provider.resumeKey, first.resume).issuedAt, f.sessions.verify(first.token).issuedAt, "the credential carries when its login began");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.access.signOut([PERSON], { by: ADMIN });
  const spentBefore = f.feishu.refreshes;
  await assert.rejects(new FeishuLoginClient({ getDeviceKey: key }).resume(f.origin, first.resume), (error) => error.code === "signed_out");
  assert.equal(f.feishu.refreshes, spentBefore, "refused without spending the refresh token");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await (await f.signIn(new FeishuLoginClient({ getDeviceKey: key }))).complete();
  const resumed = await new FeishuLoginClient({ getDeviceKey: key }).resume(f.origin, second.resume);
  assert.equal(resumed.status, "authenticated");
  assert.deepEqual(f.audit.map((event) => `${event.action}:${event.outcome}`), ["auth.sign-in:ok", "auth.resume:refused", "auth.sign-in:ok", "auth.resume:ok"]);
  assert.ok(f.audit.every((event) => !JSON.stringify(event).includes("never-return-refresh")), "no token in an audit line");
});

test("resume: a credential sealed by a build from before the issue time is refused once the person is signed out, and disabled refuses all", async (t) => {
  const f = await login(t), key = device();
  const first = await (await f.signIn(new FeishuLoginClient({ getDeviceKey: key }))).complete();
  const { issuedAt, ...older } = openResume(f.provider.resumeKey, first.resume);
  assert.ok(issuedAt);
  const oldStyle = sealResume(f.provider.resumeKey, older);
  await f.access.disable([PERSON], { by: ADMIN });
  await assert.rejects(new FeishuLoginClient({ getDeviceKey: key }).resume(f.origin, first.resume), (error) => error.code === "account_disabled");
  await f.access.enable([PERSON], { by: ADMIN });
  await assert.rejects(new FeishuLoginClient({ getDeviceKey: key }).resume(f.origin, oldStyle), (error) => error.code === "signed_out");
});

test("a desktop says which build it is, and the directory hears it with each sign-in and resume; a refusal reads as the administrator's", async (t) => {
  const f = await login(t), key = device();
  const client = new FeishuLoginClient({ getDeviceKey: key, client: "0.1.0-20261002.267" });
  const first = await (await f.signIn(client)).complete();
  await new FeishuLoginClient({ getDeviceKey: key, client: "0.1.0-20261002.267" }).resume(f.origin, first.resume);
  assert.deepEqual(f.seen, [[PERSON.userId, "0.1.0-20261002.267"], [PERSON.userId, "0.1.0-20261002.267"]]);
  assert.equal(new FeishuLoginClient({ client: "has spaces; and more" }).client, null, "only a release id is sent");
  await f.access.disable([PERSON], { by: ADMIN });
  await assert.rejects(new FeishuLoginClient({ getDeviceKey: key }).resume(f.origin, first.resume), /你的 i豆 账号已被管理员停用/);
});
