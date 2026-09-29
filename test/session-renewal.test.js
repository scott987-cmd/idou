import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuLoginClient } from "../src/application/feishu-login-client.js";
import { DesktopAuth, createSessionLease } from "../src/application/desktop-auth.js";
import { readClientSession } from "../src/control-plane/client-session.js";
import { renewalProofMessage } from "../src/control-plane/login-proof.js";
import { loadFeishuLoginConfig } from "../src/control-plane/server-config.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

async function setup(t, { enabled = true, source = false, lifetime = 3600, longSessionDays = 0, refresh = false } = {}) {
  const state = { now: Date.now(), user: "ou_fixture", calls: [], lifetime, activations: [], refreshCalls: 0, accessExpiresAt: null }, now = () => state.now;
  const sessions = new SessionRegistry({ now }), pair = generateKeyPairSync("ed25519");
  let login;
  const server = createServer((req, res) => void login.handle(req, res)); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sourceAccess = source ? new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_fixture", now }) : null;
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_fixture", appSecret: "synthetic-app-secret", sessions, now, sourceAccess, sessionRenewalEnabled: enabled, longSessionDays,
    fetchImpl: async (url, options) => {
      state.calls.push({ url, options });
      if (url.endsWith("/open-apis/authen/v2/oauth/token")) {
        const body = JSON.parse(options.body);
        if (body.grant_type === "refresh_token") {
          state.refreshCalls++;
          assert.equal(body.refresh_token, "synthetic-refresh");
          return Response.json({ code: 0, access_token: "synthetic-feishu-access-2", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: state.lifetime });
        }
        return Response.json({ code: 0, access_token: "synthetic-feishu-access", token_type: "Bearer", expires_in: state.lifetime,
          ...(refresh ? { refresh_token: "synthetic-refresh" } : {}),
          scope: sourceAccess?.requiredScopes.join(" ") });
      }
      if (state.gate) { state.entered?.resolve(); await state.gate.promise; }
      if (state.fail) throw new Error("synthetic unavailable");
      return Response.json({ code: 0, data: { tenant_key: "tenant_fixture", open_id: state.user, name: "合成用户" } });
    } });
  login = new FeishuLoginService({ origin, provider, sessions, now, allowedTenants: ["tenant_fixture"] });
  const client = new FeishuLoginClient({ now, getDeviceKey: () => pair.privateKey });
  const authorize = async url => {
    const redirect = await fetch(url, { redirect: "manual" }), cookie = redirect.headers.get("set-cookie").split(";")[0];
    const target = new URL(redirect.headers.get("location"));
    assert.equal(target.searchParams.has("scope"), source || longSessionDays > 0);
    // The default login stays identity-only. `offline_access` is asked for
    // exactly when the operator configured durable logins -- and it has to be
    // asked for, because Feishu issues a refresh token only when it is granted.
    // This fake returns one regardless of scope, so nothing else here would
    // notice a deployment that could never get one.
    if (longSessionDays > 0) assert.match(target.href, /offline_access/);
    else assert.doesNotMatch(target.href, /offline_access/);
    const response = await fetch(`${origin}/auth/feishu/callback?state=${target.searchParams.get("state")}&code=synthetic`, { headers: { cookie } }); assert.equal(response.status, 200);
  };
  const auth = new DesktopAuth({ serverUrl: origin, client, now, openBrowser: authorize,
    activate: async value => state.activations.push(value), deactivate: async () => {} });
  t.after(async () => { state.gate?.resolve(); await auth.close(); login.close(); server.close(); server.closeAllConnections(); });
  await auth.begin(); await auth.poll(); await auth.confirm();
  return { state, now, sessions, pair, origin, sourceAccess, provider, login, client, auth,
    post: (route, token, value = {}) => fetch(`${origin}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(value) }) };
}

test("online renewal follows real HTTP/device proof, rechecks Feishu, atomically replaces the runtime lease without switching workspace", async t => {
  const f = await setup(t), before = f.auth.active.session, filename = f.auth.active.lease.filename;
  assert.equal(f.auth.status().renewalState, "scheduled");
  f.state.now = before.renewal.renewAfter;
  await f.auth.renew(); const after = f.auth.active.session;
  assert.notEqual(before.token, after.token); assert.equal(after.renewal.notAfter, before.renewal.notAfter);
  assert.equal(f.state.activations.length, 1); assert.equal(f.auth.active.lease.filename, filename);
  // The lease carries the renewed session's mint-incapable turn token, not its root.
  assert.equal((await readClientSession(filename, f.origin, f.now())).token, after.turnToken);
  assert.notEqual(after.turnToken, after.token);
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(f.state.calls.length, 3); assert.ok(f.state.calls[2].url.endsWith("/authen/v1/user_info"));
  assert.equal(f.state.calls[2].options.headers.authorization, "Bearer synthetic-feishu-access");
  assert.doesNotMatch(await readFile(filename, "utf8"), /synthetic-feishu-access|never-keep-this|synthetic-app-secret/);
  assert.doesNotMatch(JSON.stringify(f.auth.status()), new RegExp(`${before.token}|${after.token}|synthetic-feishu-access`));
  const child = f.sessions.issueForWiki(after.token);
  await f.auth.logout(); assert.equal(f.sessions.verify(before.token), null); assert.equal(f.sessions.verify(after.token), null); assert.equal(f.sessions.verify(child.token), null);
  await assert.rejects(readFile(filename), { code: "ENOENT" });
});

test("disabled is backwards compatible and renewal never adds an OAuth scope", async t => {
  const f = await setup(t, { enabled: false }), before = f.auth.active.session;
  assert.equal(f.provider.renewal, null); assert.equal(before.renewal, undefined); assert.equal(f.auth.status().renewalState, "disabled");
  assert.equal((await f.post("/auth/session/renew-begin", before.token)).status, 403);
  assert.equal(f.state.calls.length, 2);
  const env = { IDOU_PUBLIC_URL: "https://enterprise.example", FEISHU_APP_ID: "cli_fixture", FEISHU_APP_SECRET: "fixture", FEISHU_ALLOWED_TENANTS: "tenant_fixture" };
  assert.equal(loadFeishuLoginConfig(env).sessionRenewalEnabled, false);
  assert.equal(loadFeishuLoginConfig({ ...env, FEISHU_SESSION_RENEWAL_ENABLED: "1" }).sessionRenewalEnabled, true);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_SESSION_RENEWAL_ENABLED: "true" }));
});

test("renewal rejects early, foreign-device/origin/session proofs, child tokens, duplicate challenges and redemption replay", async t => {
  const f = await setup(t), session = f.auth.active.session;
  assert.equal((await f.post("/auth/session/renew-begin", session.token)).status, 403);
  f.state.now = session.renewal.renewAfter;
  const child = f.sessions.issueForWiki(session.token);
  assert.equal((await f.post("/auth/session/renew-begin", child.token)).status, 403);
  const challenge = await (await f.post("/auth/session/renew-begin", session.token)).json();
  assert.equal((await f.post("/auth/session/renew-begin", session.token)).status, 403);
  const proof = (key = f.pair.privateKey, origin = f.origin, id = challenge.sessionId) => ({ challengeId: challenge.challengeId,
    signature: sign(null, renewalProofMessage(origin, id, challenge.challengeId, challenge.nonce), key).toString("base64url") });
  for (const value of [proof(generateKeyPairSync("ed25519").privateKey), proof(f.pair.privateKey, "https://evil.example"), proof(f.pair.privateKey, f.origin, "another-session")]) {
    assert.equal((await f.post("/auth/session/renew", session.token, value)).status, 403);
  }
  assert.equal(f.state.calls.length, 2);
  const response = await f.post("/auth/session/renew", session.token, proof()); assert.equal(response.status, 200); const after = await response.json();
  assert.equal((await f.post("/auth/session/renew", session.token, proof())).status, 403); assert.equal(f.state.calls.length, 3);
  assert.ok(f.sessions.verify(child.token)); assert.ok(f.sessions.verify(session.token));
  f.sessions.revoke(child.token); assert.ok(f.sessions.verify(after.token), "Child self-revocation must not revoke family");
  f.sessions.revoke(session.token); assert.equal(f.sessions.verify(after.token), null, "Old-parent logout must revoke successor");
});

test("original Feishu expiry caps renewal, no refresh token request or lifetime extension", async t => {
  const f = await setup(t, { lifetime: 1000 }), before = f.auth.active.session;
  f.state.now = before.renewal.renewAfter; await f.auth.renew();
  const after = f.auth.active.session; assert.equal(after.expiresAt, before.renewal.notAfter); assert.equal(after.renewal, undefined);
  assert.equal(f.auth.status().renewalState, "disabled"); assert.equal(f.state.calls.filter(call => call.url.includes("/token")).length, 1);
  f.state.now = after.expiresAt; assert.equal(f.sessions.verify(after.token), null);
});

test("expired predecessors do not remove successors or copied source authority, while new-parent logout does", async t => {
  const f = await setup(t, { source: true }), before = f.auth.active.session;
  f.state.now = before.renewal.renewAfter; await f.auth.renew(); const after = f.auth.active.session;
  assert.equal(f.sourceAccess.current(after.token).who.id, f.sessions.verify(after.token).id);
  f.state.now = before.expiresAt + 1; f.sessions.prune(); f.provider.renewal.prune(); f.sourceAccess.prune();
  assert.equal(f.sessions.verify(before.token), null); assert.ok(f.sessions.verify(after.token));
  assert.equal(f.sourceAccess.current(after.token).grant.token.toString(), "synthetic-feishu-access");
  f.sessions.revoke(after.token); assert.throws(() => f.sourceAccess.current(after.token));
});

test("changed upstream identity or unavailable upstream fails closed and cleans the native lease without retry", async t => {
  for (const reason of ["identity", "network"]) {
    const f = await setup(t), before = f.auth.active.session, file = f.auth.active.lease.filename;
    f.state.now = before.renewal.renewAfter;
    if (reason === "identity") f.state.user = "ou_other"; else f.state.fail = true;
    await assert.rejects(f.auth.renew()); assert.equal(f.auth.status().renewalState, "failed"); assert.equal(f.auth.status().connected, false);
    // A refused renewal ends the working session; the operator is told why.
    assert.equal(typeof f.auth.status().renewalFailure, "string");
    assert.ok(f.auth.status().renewalFailure.length > 0 && f.auth.status().renewalFailure.length <= 300);
    assert.equal(f.auth.status().renewalFailure.includes(before.token), false);
    assert.equal(f.sessions.verify(before.token), null); assert.equal(f.state.activations.length, 1);
    await assert.rejects(readFile(file), { code: "ENOENT" }); assert.equal(f.state.calls.length, 3);
  }
});

// setTimeout rounds its delay down, so a timer armed for exactly renewAfter can
// run a fraction of a millisecond early. The client refuses a renewal before the
// window, and that refusal used to retire the session — which made bounded online
// renewal fail every time and dropped the operator mid-task.
test("a renewal timer that fires a moment early re-arms instead of ending the session", async t => {
  const f = await setup(t), before = f.auth.active.session;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.state.now = before.renewal.renewAfter - 5;
  f.auth.schedule();
  t.mock.timers.tick(5);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.auth.status().renewalState, "scheduled");
  assert.equal(f.auth.status().connected, true);
  assert.equal(f.auth.status().renewalFailure, null);
  assert.ok(f.sessions.verify(before.token));
  assert.equal(f.auth.active.session, before);
  await stat(f.auth.active.lease.filename);
  t.mock.timers.reset();
});

test("a healthy session reports no renewal reason, and a successful renewal clears an earlier one", async t => {
  const f = await setup(t), before = f.auth.active.session;
  assert.equal(f.auth.status().renewalState, "scheduled"); assert.equal(f.auth.status().renewalFailure, null);
  f.auth.renewalFailure = "陈旧原因";
  f.state.now = before.renewal.renewAfter; await f.auth.renew();
  assert.equal(f.auth.status().renewalState, "scheduled"); assert.equal(f.auth.status().renewalFailure, null);
});

test("logout during fresh user_info check cancels renewal and cannot resurrect the account", async t => {
  const f = await setup(t), before = f.auth.active.session, file = f.auth.active.lease.filename;
  f.state.now = before.renewal.renewAfter; f.state.gate = Promise.withResolvers(); f.state.entered = Promise.withResolvers();
  const renewal = f.auth.renew(); const rejected = assert.rejects(renewal); await f.state.entered.promise;
  const logout = f.auth.logout(); f.state.gate.resolve(); await rejected; await logout;
  assert.equal(f.auth.active, null); assert.equal(f.sessions.sessions.size, 0); assert.equal(f.state.activations.length, 1);
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("lost successful renewal response revokes the undelivered successor through its parent; no automatic replay", async t => {
  const f = await setup(t), before = f.auth.active.session, fetchImpl = f.client.fetch;
  f.state.now = before.renewal.renewAfter;
  f.client.fetch = async (url, options) => {
    const result = await fetchImpl(url, options);
    if (url.endsWith("/auth/session/renew")) { assert.equal(result.status, 200); await result.body.cancel(); throw new Error("synthetic dropped reply"); }
    return result;
  };
  await assert.rejects(f.auth.renew()); assert.equal(f.sessions.sessions.size, 0); assert.equal(f.auth.status().connected, false);
  assert.equal(f.state.calls.length, 3);
});

test("native replacement failure revokes both parent and successor instead of claiming renewal succeeded", async t => {
  const f = await setup(t), before = f.auth.active.session;
  f.state.now = before.renewal.renewAfter; f.auth.active.lease.replace = async () => { throw new Error("synthetic disk failure"); };
  await assert.rejects(f.auth.renew(), /disk failure/); assert.equal(f.sessions.sessions.size, 0);
  assert.equal(f.auth.status().renewalState, "failed"); assert.equal(f.auth.status().connected, false);
});

test("lease replacement cannot revive a closed lease or replace its account", async t => {
  const f = await setup(t), original = f.auth.active.session, lease = await createSessionLease(original); t.after(() => lease.close());
  await assert.rejects(lease.replace({ ...original, identity: { ...original.identity, userId: "ou_other" } }), /身份变化/);
  await lease.close(); await assert.rejects(lease.replace(original), /已关闭/);
  await assert.rejects(readFile(lease.filename), { code: "ENOENT" });
});

test("renewal challenge expiry is terminal and does not contact Feishu", async t => {
  const f = await setup(t), session = f.auth.active.session;
  f.state.now = session.renewal.renewAfter;
  const challenge = await (await f.post("/auth/session/renew-begin", session.token)).json();
  const proof = { challengeId: challenge.challengeId, signature: sign(null, renewalProofMessage(f.origin, challenge.sessionId, challenge.challengeId, challenge.nonce), f.pair.privateKey).toString("base64url") };
  f.state.now = challenge.expiresAt;
  assert.equal((await f.post("/auth/session/renew", session.token, proof)).status, 403);
  assert.equal((await f.post("/auth/session/renew-begin", session.token)).status, 403); assert.equal(f.state.calls.length, 2);
});

test("native client rejects substituted renewal identity and extended lifetimes even from its configured server", async t => {
  for (const reason of ["identity", "expiry", "horizon"]) {
    const f = await setup(t), session = f.auth.active.session, fetchImpl = f.client.fetch;
    f.state.now = session.renewal.renewAfter;
    f.client.fetch = async (url, options) => {
      const response = await fetchImpl(url, options); if (!url.endsWith("/auth/session/renew")) return response;
      const result = await response.json();
      if (reason === "identity") result.identity.deviceId = "forged-device";
      else if (reason === "expiry") result.expiresAt = f.now() + 900001;
      else result.renewal.notAfter += 1000;
      return Response.json(result);
    };
    await assert.rejects(f.auth.renew(), /不匹配/); assert.equal(f.sessions.sessions.size, 0);
    assert.equal(f.auth.status().connected, false); assert.equal(f.state.activations.length, 1);
  }
});

test("long upstream access cannot create an unbounded renewal horizon", async t => {
  const f = await setup(t, { lifetime: 86400 }), first = f.auth.active.session;
  assert.equal(first.renewal.notAfter, f.now() + 14400000);
  for (let index = 0; index < 3; index++) {
    f.state.now = f.auth.active.session.renewal.renewAfter; await f.auth.renew();
    assert.equal(f.auth.active.session.renewal.notAfter, first.renewal.notAfter);
    // The current root + its turn child, plus at most one not-yet-pruned predecessor pair.
    assert.ok(f.sessions.sessions.size <= 4, "Expired predecessors (root and their turn child) are pruned");
  }
});

test("closing native app during renewal cannot install the late response or leave a live family", async t => {
  const f = await setup(t), session = f.auth.active.session;
  f.state.now = session.renewal.renewAfter; f.state.gate = Promise.withResolvers(); f.state.entered = Promise.withResolvers();
  const renewing = assert.rejects(f.auth.renew()); await f.state.entered.promise;
  const closing = f.auth.close(); f.state.gate.resolve(); await renewing; await closing;
  assert.equal(f.auth.active, null); assert.equal(f.sessions.sessions.size, 0); assert.equal(f.state.activations.length, 1);
});

// A login that must survive days cannot depend on one Feishu access token. With
// offline_access granted the server exchanges the refresh token as it goes; the
// four-hour ceiling stays in force for any login that never got one.
test("a long session outlives its access token, and one without a refresh token does not", async t => {
  // A ten-minute access token so the very first renewal already has to exchange
  // the refresh token, which is what a multi-day session depends on.
  const long = await setup(t, { longSessionDays: 30, refresh: true, lifetime: 600 });
  const first = long.auth.active.session;
  // The ceiling is the configured window, not the access token's own expiry.
  assert.ok(first.renewal.notAfter > long.state.now + 29 * 86400_000);

  // Push the access token to the edge of its life and renew: the refresh token
  // is exchanged and the session continues.
  long.state.now = first.renewal.renewAfter;
  await long.auth.renew();
  assert.equal(long.state.refreshCalls, 1);
  assert.ok(long.auth.active.session.expiresAt > first.expiresAt);
  assert.equal(long.auth.status().connected, true);
  // The refresh token is server-only and never appears in anything a client sees.
  assert.doesNotMatch(JSON.stringify(long.auth.status()), /synthetic-refresh/);

  // Same configuration, but Feishu granted no refresh token: the ceiling falls
  // back to the original four hours, bounded by the access token's own life.
  const short = await setup(t, { longSessionDays: 30, refresh: false });
  assert.ok(short.auth.active.session.renewal.notAfter <= short.state.now + 14400_000);
  assert.equal(short.state.refreshCalls, 0);
});

// Found on the deployed server (2026-09-23): every desktop session ended about
// two hours after sign-in. The renewal exchanged Feishu's access token when it
// neared its two hours, but the session's source access kept the old token and
// its expiry; it was pruned at that expiry, and the next renewal found nothing
// to transfer ("在线续期被拒绝……feishu_source_access_denied") and ended the
// session. Three hours of renewals, thirteen minutes apart, as the desktop does.
test("a session outlives Feishu's two-hour access token, and its source access goes on with the new one", async t => {
  const f = await setup(t, { source: true, refresh: true, longSessionDays: 30, lifetime: 7200 });
  const signedIn = f.state.now;
  while (f.state.now < signedIn + 3 * 3_600_000) {
    f.state.now = f.auth.active.session.renewal.renewAfter;
    await f.auth.renew();
    assert.equal(f.auth.status().connected, true, `still connected ${Math.round((f.state.now - signedIn) / 60_000)} minutes in`);
    const { grant } = f.sourceAccess.current(f.auth.active.session.token);
    assert.equal(grant.token.toString("utf8"), f.state.refreshCalls ? "synthetic-feishu-access-2" : "synthetic-feishu-access",
      "source access reads and writes with the token the renewal holds");
  }
  assert.equal(f.state.refreshCalls, 1, "the access token was exchanged once on the way");
});
