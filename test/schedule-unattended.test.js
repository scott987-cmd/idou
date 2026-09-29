import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { UnattendedCredentialStore } from "../src/control-plane/unattended-credential.js";
import { UnattendedConsent } from "../src/control-plane/unattended-consent.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const TENANT = "tenant_fixture", USER = "ou_fixture", APP = "cli_synthetic";

async function setup(t, { windowDays = 30, longSessionDays = 30, refresh = "never-return-refresh", tenant = TENANT } = {}) {
  // `valid` is every refresh token Feishu would still accept. Each authorization
  // starts a chain of its own; using a token spends it and adds its successor.
  const state = { now: Date.now(), grants: [], rotate: false, refuseRefresh: false, throwOn: null, outage: false, omitRefresh: false, issued: 0, current: refresh, tenant, userInfo: 0,
    valid: new Set([refresh]), dedicated: 0 };
  const now = () => state.now;
  const sessions = new SessionRegistry({ now });
  const sourceAccess = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: APP, now, cliProxyScopes: ["fixture:read"], cliWriteActions: ["message.send"] });
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: APP, appSecret: "app-secret-fixture", sessions, sourceAccess, now,
    sessionRenewalEnabled: true, longSessionDays,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/open-apis/authen/v2/oauth/token")) {
        const request = JSON.parse(options.body);
        state.grants.push(request.grant_type);
        if (state.outage || state.throwOn === state.grants.length) throw new Error("fetch failed: ECONNREFUSED");
        if (state.refuseRefresh) return new Response("{}", { status: 400 });
        // Like Feishu: using a refresh token spends it and returns a new one.
        if (state.rotate) {
          if (!state.valid.has(request.refresh_token)) return new Response(JSON.stringify({ code: 20064, msg: "The refresh token has been revoked." }), { status: 400, headers: { "content-type": "application/json" } });
          state.valid.delete(request.refresh_token);
          const next = `rotated-refresh-${++state.issued}`;
          state.valid.add(next);
          if (request.refresh_token === state.current) state.current = next;
          return Response.json({ code: 0, access_token: `access-${state.issued}`, refresh_token: next, token_type: "Bearer", expires_in: 3600 });
        }
        return Response.json({ code: 0, access_token: "access-fixture", refresh_token: state.omitRefresh ? undefined : refresh, token_type: "Bearer", expires_in: 3600 });
      }
      state.userInfo += 1;
      return Response.json({ code: 0, data: { tenant_key: state.tenant, open_id: USER, name: "合成用户" } });
    } });

  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-unattended-")));
  const store = await UnattendedCredentialStore.open({ directory, now });
  const audits = [];
  const consent = new UnattendedConsent({ store, sessions, provider, windowDays, now,
    allowedTenants: [TENANT], audit: (event) => audits.push(event) });
  t.after(async () => { consent.close(); sourceAccess.close(); provider.renewal?.close?.(); await rm(directory, { recursive: true, force: true }); });

  // A signed-in login with a refresh token behind it, built directly rather than
  // through the HTTP flow: what this exercises is what happens after, and the
  // login path has its own tests.
  const device = generateKeyPairSync("ed25519");
  const signIn = () => {
    const identity = { authProvider: "feishu", appId: APP, tenantId: TENANT, userId: USER,
      displayName: "合成用户", expiresAt: now() + 600_000, cliBridge: true, cliMessageWrites: true };
    sourceAccess.remember(identity, "access-fixture");
    provider.renewal.remember(identity, "access-fixture", state.current);
    const issued = sessions.issue({ ...identity, deviceId: "device_fixture", deviceProof: "ed25519-login", ttlMs: 600_000 });
    sourceAccess.bind(identity, issued);
    provider.renewal.bind(identity, issued, device.publicKey);
    return issued;
  };
  // What the dedicated authorization hands over: a refresh token from its own
  // Feishu authorization, never the one the signed-in session holds.
  const grant = async ({ appId = APP, tenantId = TENANT, userId = USER } = {}) => {
    const refreshToken = `dedicated-refresh-${++state.dedicated}`;
    state.valid.add(refreshToken);
    return consent.grantRedeemed({ appId, tenantId, userId, refreshToken });
  };
  return { state, sessions, sourceAccess, provider, store, consent, audits, signIn, grant, now };
}

test("granting seals a credential, and the bytes on disk are not the token", async (t) => {
  const it = await setup(t);
  it.signIn();
  const granted = await it.grant();
  assert.ok(granted.expiresAt > it.state.now + 29 * 86400_000, "the window is the configured one");
  const record = await it.store.read(TENANT, USER);
  assert.equal(record.state, "active");
  assert.doesNotMatch(JSON.stringify(record), /dedicated-refresh|never-return-refresh|app-secret-fixture/);
  assert.equal(it.store.unseal(record).refreshToken, "dedicated-refresh-1", "the dedicated authorization's own token, not the session's");
  assert.deepEqual(it.audits.map((event) => event.kind), ["unattended_consent_granted"]);
  assert.doesNotMatch(JSON.stringify(it.audits), new RegExp(`${TENANT}|${USER}`), "the audit carries hashes, not identifiers");
});

test("a deployment without long sessions refuses, and names the settings", async (t) => {
  const it = await setup(t, { longSessionDays: 0 });
  await assert.rejects(() => it.grant(), /FEISHU_SESSION_RENEWAL_ENABLED|FEISHU_LONG_SESSION_DAYS/);
  assert.equal(await it.store.read(TENANT, USER), null, "nothing is written");
});

// Which person an authorization belongs to is established by the login service
// before this is reached; these are the checks that remain here.
test("a token for another application, a tenant not admitted, or no token at all is refused", async (t) => {
  const it = await setup(t);
  await assert.rejects(() => it.grant({ appId: "cli_other" }), /另一个应用/);
  await assert.rejects(() => it.grant({ tenantId: "tenant_elsewhere" }), /租户/);
  await assert.rejects(() => it.consent.grantRedeemed({ appId: APP, tenantId: TENANT, userId: USER, refreshToken: "" }), /长效凭据/);
  assert.equal(await it.store.read(TENANT, USER), null, "nothing is written");
});

// The defect this version exists for. The first one sealed a copy of the
// refresh token the signed-in session held; a refresh token is single-use, so
// the desktop's first refresh killed the schedule's copy -- or the first
// scheduled run killed the desktop's login. With its own authorization each
// side spends only its own chain.
test("the unattended credential and the signed-in session never share a refresh token", async (t) => {
  const it = await setup(t);
  it.state.rotate = true;
  it.signIn();
  await it.grant();
  const desktop = async () => {
    const identity = await it.provider.adoptRefreshed({ refreshToken: it.state.current });
    it.sourceAccess.discard(identity); it.provider.renewal.discard(identity);
  };
  await desktop();                                      // the desktop refreshes first
  const run = await it.consent.identity(TENANT, USER);
  assert.equal(run.ok, true, `the schedule still runs: ${run.reason}`);
  await desktop();                                      // and the desktop still can, after the run
  it.state.now += 16 * 60_000;
  const tomorrow = await it.consent.identity(TENANT, USER);
  assert.equal(tomorrow.ok, true, tomorrow.reason);

  // What the shared copy did: a record holding the session's token dies the
  // moment the desktop refreshes.
  const shared = it.state.current;
  await it.store.write(TENANT, USER, { ...(await it.store.read(TENANT, USER)),
    sealed: it.store.seal({ appId: APP, tenantId: TENANT, userId: USER, refreshToken: shared, notAfter: it.state.now + 86400_000 }) });
  it.consent.live.delete(`${TENANT}\n${USER}`);
  await desktop();
  const dead = await it.consent.identity(TENANT, USER);
  assert.equal(dead.ok, false, "a copy of the session's token is spent by the session");
});

test("the minted identity is a usable session that can still reach Feishu", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  const minted = await it.consent.identity(TENANT, USER);
  assert.equal(minted.ok, true, minted.reason);
  const who = it.sessions.verify(minted.token);
  assert.equal(who.userId, USER);
  assert.equal(who.deviceId, it.store.deviceId, "it acts as the server's own device, not the laptop's");
  assert.equal(who.cliBridge, true, "the login's capabilities travel with it");
  assert.equal(who.cliMessageWrites, true, "or the result push would be refused");
  assert.doesNotThrow(() => it.sourceAccess.current(minted.token), "and a run could actually reach Feishu");
});

test("a rotated refresh token is persisted, so tomorrow's run still works", async (t) => {
  // The failure this prevents appears 24 hours later, on a schedule nobody is
  // watching: the first mint spends the stored token, Feishu returns a new one,
  // and if it is not written down the second mint presents a spent token.
  const it = await setup(t);
  it.state.rotate = true;
  it.signIn(); await it.grant();

  const first = await it.consent.identity(TENANT, USER);
  assert.equal(first.ok, true, first.reason);
  it.state.now += 16 * 60_000;                       // past the minted session's life
  const second = await it.consent.identity(TENANT, USER);
  assert.equal(second.ok, true, second.reason);
  assert.equal(it.state.grants.filter((kind) => kind === "refresh_token").length, 2, "two exchanges, both accepted");
  assert.notEqual(first.token, second.token);
});

test("two schedules due at once share one exchange and one session", async (t) => {
  // Not an optimisation: a second exchange would present the token the first
  // just spent, and Feishu would refuse it -- killing the chain on the first
  // morning two schedules happened to fall together.
  const it = await setup(t);
  it.state.rotate = true;
  it.signIn(); await it.grant();
  const [a, b] = await Promise.all([it.consent.identity(TENANT, USER), it.consent.identity(TENANT, USER)]);
  assert.equal(a.ok, true, a.reason);
  assert.equal(a.token, b.token);
  assert.equal(it.state.grants.filter((kind) => kind === "refresh_token").length, 1);
});

test("a still-usable session is reused rather than re-minted", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  const first = await it.consent.identity(TENANT, USER);
  const again = await it.consent.identity(TENANT, USER);
  assert.equal(again.token, first.token);
  assert.equal(it.state.grants.filter((kind) => kind === "refresh_token").length, 1);

  // Once too little is left for a ten-minute run plus its message, a new one.
  it.state.now += 5 * 60_000;
  const fresh = await it.consent.identity(TENANT, USER);
  assert.notEqual(fresh.token, first.token);
});

test("a refusal from Feishu suspends once, and the next schedule never asks again", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  it.state.refuseRefresh = true;

  const first = await it.consent.identity(TENANT, USER);
  assert.equal(first.ok, false);
  assert.equal(first.retry, false, "this is terminal, not a bad moment");
  assert.match(first.reason, /飞书拒绝了这次续期/);
  const calls = it.state.grants.length;

  const second = await it.consent.identity(TENANT, USER);
  assert.equal(second.ok, false);
  assert.equal(it.state.grants.length, calls, "answered from disk; Feishu is not asked fifty times");
  assert.equal((await it.store.read(TENANT, USER)).state, "needs_reauthorization");
  assert.equal((await it.consent.status({ tenantId: TENANT, userId: USER })).authorized, false);
});

test("a transport failure keeps the schedule alive instead of stopping it overnight", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  it.state.throwOn = it.state.grants.length + 1;

  const answer = await it.consent.identity(TENANT, USER);
  assert.equal(answer.ok, false);
  assert.equal(answer.retry, true, "a five-minute outage must not silently stop a daily task");
  assert.equal((await it.store.read(TENANT, USER)).state, "active", "the credential is untouched");
  assert.equal((await it.store.read(TENANT, USER)).failures, 1);
});

test("repeated transport failures do eventually stop asking", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  it.state.outage = true;
  // Three separate occasions, not three calls in one moment -- see below.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await it.consent.identity(TENANT, USER);
    it.state.now += 11 * 60_000;
  }
  const record = await it.store.read(TENANT, USER);
  assert.equal(record.state, "needs_reauthorization");
  assert.match(record.reason, /无法连上飞书/, "and says it could not reach Feishu, rather than that Feishu said no");
});

// The scheduler authorizes due schedules one after another, and a person can
// press 立即运行 three times; neither is three bad moments. Before this, three
// schedules due at 09:00 during a blip finished the credential within a second,
// with a reason blaming Feishu for refusing.
test("schedules asking one after another during an outage are one bad moment, not three", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  const before = it.state.grants.length;
  it.state.outage = true;
  const answers = [];
  for (let n = 0; n < 3; n += 1) answers.push(await it.consent.identity(TENANT, USER));
  assert.ok(answers.every((answer) => answer.ok === false && answer.retry === true), "each is told to try again later");
  assert.equal(it.state.grants.length - before, 1, "Feishu is asked once for the whole moment");
  assert.equal((await it.store.read(TENANT, USER)).state, "active");
  assert.equal((await it.store.read(TENANT, USER)).failures, 1);

  it.state.outage = false;
  it.state.now += 11 * 60_000;
  // An exchange that hands back no new refresh token keeps using the old one,
  // which is resealed all the same -- and the count must clear on that path too.
  it.state.omitRefresh = true;
  assert.equal((await it.consent.identity(TENANT, USER)).ok, true, "once it has passed, the next occasion asks again");
  assert.equal((await it.store.read(TENANT, USER)).failures, 0, "and a success clears the count, rotated token or not");
});

test("an expired window is refused without spending the token", async (t) => {
  const it = await setup(t, { windowDays: 1 });
  it.signIn(); await it.grant();
  const before = it.state.grants.length;
  it.state.now += 2 * 86400_000;
  const answer = await it.consent.identity(TENANT, USER);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /到期/);
  assert.equal(it.state.grants.length, before, "nothing was exchanged");
});

test("a tenant that is no longer allowed is refused without spending the token", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  it.consent.allowedTenants = new Set(["someone-else"]);
  const before = it.state.grants.length;
  const answer = await it.consent.identity(TENANT, USER);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /租户/);
  assert.equal(it.state.grants.length, before);
});

test("an unreadable credential is deleted rather than retried forever", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  const record = await it.store.read(TENANT, USER);
  await it.store.write(TENANT, USER, { ...record, sealed: `${record.sealed.slice(0, -4)}AAAA` });
  const answer = await it.consent.identity(TENANT, USER);
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /无法读取/);
  assert.equal(await it.store.read(TENANT, USER), null);
});

test("no credential at all is a refusal that says what to do", async (t) => {
  const it = await setup(t);
  const answer = await it.consent.identity(TENANT, USER);
  assert.equal(answer.ok, false);
  assert.equal(answer.retry, false);
  assert.match(answer.reason, /没有开启无人值守运行/);
});

test("revoking deletes the credential and kills the session it minted", async (t) => {
  const it = await setup(t);
  it.signIn(); await it.grant();
  const minted = await it.consent.identity(TENANT, USER);
  assert.ok(it.sessions.verify(minted.token));

  assert.equal(await it.consent.revoke({ tenantId: TENANT, userId: USER }), true);
  assert.equal(await it.store.read(TENANT, USER), null);
  assert.equal(it.sessions.verify(minted.token), null, "a run in flight loses its identity at once");
  assert.equal(await it.consent.revoke({ tenantId: TENANT, userId: USER }), false);
});

test("minting many times over does not fill the renewal registry", async (t) => {
  // `renewal.remember` denies at a hundred pending-plus-granted, and that denial
  // lands after the token has been spent -- so a leak here would not refuse a
  // run, it would destroy the credential.
  const it = await setup(t);
  it.state.rotate = true;
  it.signIn(); await it.grant();
  for (let round = 0; round < 40; round += 1) {
    const minted = await it.consent.identity(TENANT, USER);
    assert.equal(minted.ok, true, `round ${round}: ${minted.reason}`);
    it.sessions.revoke(minted.token);
    it.consent.live.delete(`${TENANT}\n${USER}`);
    it.state.now += 60_000;
  }
});

test("status reads without opening the seal or calling Feishu", async (t) => {
  const it = await setup(t);
  assert.deepEqual(await it.consent.status({ tenantId: TENANT, userId: USER }),
    // `windowDays` even with nothing granted: the confirmation card names the
    // real date this would run until, and has nowhere else to learn it.
    { available: true, authorized: false, windowDays: 30, expiresAt: null, state: null, reason: null, lastUsedAt: null });
  it.signIn(); await it.grant();
  const before = it.state.grants.length;
  const status = await it.consent.status({ tenantId: TENANT, userId: USER });
  assert.equal(status.authorized, true);
  assert.ok(status.expiresAt > it.state.now);
  assert.equal(it.state.grants.length, before);
});
