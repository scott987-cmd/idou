import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { FeishuLoginClient } from "../src/application/feishu-login-client.js";
import { DesktopAuth } from "../src/application/desktop-auth.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

async function setup(t) {
  const state = { tenant: "allowed-tenant", expiry: 3600, grants: [], rotate: false, issued: 0, current: null };
  const sessions = new SessionRegistry(); let login;
  const server = createModelGateway({ apiKey: "model-secret-fixture", sessions, authHandler: (req, res) => login.handle(req, res),
    fetchImpl: async () => Response.json({ output_text: "unused" }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_synthetic", appSecret: "app-secret-fixture", sessions,
    sessionRenewalEnabled: true, longSessionDays: 30,
    fetchImpl: async (url, options) => {
      if (String(url).endsWith("/open-apis/authen/v2/oauth/token")) {
        const request = JSON.parse(options.body);
        state.grants.push(request.grant_type);
        if (state.refuseRefresh && request.grant_type === "refresh_token") return new Response("{}", { status: 400 });
        // Like Feishu: a refresh token is spent by using it and replaced by a new one.
        if (state.rotate) {
          if (request.grant_type === "refresh_token" && request.refresh_token !== state.current) return new Response("{}", { status: 400 });
          state.current = `never-return-refresh-${++state.issued}`;
          return Response.json({ code: 0, access_token: `user-access-fixture-${state.issued}`, refresh_token: state.current, token_type: "Bearer", expires_in: state.expiry });
        }
        return Response.json({ code: 0, access_token: "user-access-fixture", refresh_token: "never-return-refresh", token_type: "Bearer", expires_in: state.expiry });
      }
      return Response.json({ code: 0, data: { tenant_key: state.tenant, open_id: "ou_synthetic", name: "合成用户" } });
    } });
  login = new FeishuLoginService({ origin, provider, sessions, allowedTenants: ["allowed-tenant"] });
  t.after(() => { login.close(); server.close(); server.closeAllConnections(); });
  const launch = async (launchUrl) => {
    const response = await fetch(launchUrl, { redirect: "manual" });
    return { url: new URL(response.headers.get("location")), cookie: response.headers.get("set-cookie").split(";")[0] };
  };
  const signIn = async (client) => {
    const begun = await client.begin(origin), launched = await launch(begun.launchUrl);
    const url = new URL(`${origin}/auth/feishu/callback`);
    url.searchParams.set("state", launched.url.searchParams.get("state")); url.searchParams.set("code", "synthetic-auth-code");
    await fetch(url, { headers: { cookie: launched.cookie } });
    return client.complete();
  };
  return { state, sessions, origin, login, provider, signIn };
}
const fixedKey = () => { const key = generateKeyPairSync("ed25519").privateKey; return { key, get: async () => key }; };

test("登录会发出一份可续用的凭据，重启后凭它换回可用会话，且凭据里看不到飞书令牌", async (t) => {
  const f = await setup(t), device = fixedKey();
  const client = new FeishuLoginClient({ getDeviceKey: device.get });
  const session = await f.signIn(client);
  assert.equal(typeof session.resume, "string");
  assert.doesNotMatch(session.resume, /never-return-refresh|user-access-fixture|app-secret-fixture/);
  // A brand-new client, as after a restart: no flow, no memory, only the device
  // key and the stored credential.
  const restarted = new FeishuLoginClient({ getDeviceKey: device.get });
  const resumed = await restarted.resume(f.origin, session.resume);
  assert.equal(resumed.status, "authenticated");
  assert.equal(resumed.identity.userId, "ou_synthetic");
  assert.equal(resumed.identity.tenantId, "allowed-tenant");
  assert.equal(resumed.identity.deviceProof, "ed25519-login");
  // The device identity must survive the round trip; deriving it differently on
  // either side silently breaks every resume.
  assert.equal(resumed.identity.deviceId, session.identity.deviceId);
  assert.notEqual(resumed.token, session.token);
  assert.ok(f.sessions.verify(resumed.token), "换回来的令牌必须是可用会话");
  assert.ok(f.state.grants.includes("refresh_token"), "续用必须真的去换一次令牌");
  assert.doesNotMatch(JSON.stringify(resumed), /never-return-refresh|user-access-fixture|app-secret-fixture/);
});

test("换一台设备的密钥拿同一份凭据换不到会话", async (t) => {
  const f = await setup(t), device = fixedKey();
  const session = await f.signIn(new FeishuLoginClient({ getDeviceKey: device.get }));
  const other = fixedKey();
  await assert.rejects(new FeishuLoginClient({ getDeviceKey: other.get }).resume(f.origin, session.resume), /HTTP 403/);
});

test("同一个挑战不能用第二次", async (t) => {
  const f = await setup(t), device = fixedKey();
  const session = await f.signIn(new FeishuLoginClient({ getDeviceKey: device.get }));
  const challenge = await (await fetch(`${f.origin}/auth/feishu/resume-challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const replay = () => fetch(`${f.origin}/auth/feishu/resume`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ resume: session.resume, nonce: challenge.nonce, signature: "AAAA" }) });
  assert.equal((await replay()).status, 403);
  // Consumed on the first attempt, however that attempt ended.
  assert.equal((await replay()).status, 403);
});

test("被篡改的凭据换不到会话", async (t) => {
  const f = await setup(t), device = fixedKey();
  const session = await f.signIn(new FeishuLoginClient({ getDeviceKey: device.get }));
  const blob = Buffer.from(session.resume, "base64url"); blob[10] ^= 0xff;
  await assert.rejects(new FeishuLoginClient({ getDeviceKey: device.get }).resume(f.origin, blob.toString("base64url")), /HTTP 403/);
});

test("飞书拒绝刷新时，续用失败而不是给出半个会话", async (t) => {
  const f = await setup(t), device = fixedKey();
  const session = await f.signIn(new FeishuLoginClient({ getDeviceKey: device.get }));
  f.state.refuseRefresh = true;
  await assert.rejects(new FeishuLoginClient({ getDeviceKey: device.get }).resume(f.origin, session.resume), /HTTP 403/);
});

// Found live (2026-09-12): hours into a session, a restart could not resume.
// The server's online renewal refreshes Feishu's access token when it is close
// to expiry, and Feishu rotates the refresh token as it does; the credential
// sealed at sign-in then holds a spent token. The renewal must hand back a
// credential sealed around the token the server now holds.
test("续期换过刷新令牌后，返回的新凭据能续用，登录时那份旧凭据则不能", async (t) => {
  const f = await setup(t), device = fixedKey();
  f.state.rotate = true;
  // A short access token puts the very first renewal inside the refresh window.
  f.state.expiry = 100;
  const client = new FeishuLoginClient({ getDeviceKey: device.get });
  const session = await f.signIn(client);
  assert.equal(typeof session.resume, "string");
  const renewed = await client.renew(session);
  assert.equal(f.state.grants.filter(grant => grant === "refresh_token").length, 1, "续期这一次确实换了刷新令牌");
  assert.equal(typeof renewed.resume, "string", "续期必须带回按新刷新令牌封装的凭据");
  assert.notEqual(renewed.resume, session.resume);
  assert.doesNotMatch(renewed.resume, /never-return-refresh|user-access-fixture|app-secret-fixture/);
  const stale = await new FeishuLoginClient({ getDeviceKey: device.get }).resume(f.origin, session.resume).then(() => "resumed", error => error.message);
  assert.notEqual(stale, "resumed", "登录时那份凭据里的刷新令牌已经用掉，不应还能续用");
  const resumed = await new FeishuLoginClient({ getDeviceKey: device.get }).resume(f.origin, renewed.resume);
  assert.equal(resumed.status, "authenticated");
  assert.equal(resumed.identity.deviceId, session.identity.deviceId);
});

// Found live (2026-09-22): the control plane runs on a server now, and a deploy
// restarted it. Its sessions live only in its memory, so every desktop was left
// holding a token it no longer knew -- until the person restarted the
// application, which signs in with the stored credential. The desktop now does
// that in place. This runs the real login service and the real client: the
// restart is the server forgetting every session, which is all a restart does
// to them.
test("服务端重启丢掉全部会话后，桌面用本机凭据原地续上，第二次重启也一样", async (t) => {
  const f = await setup(t), device = fixedKey();
  f.state.rotate = true;
  const store = { value: null };
  const resumeStore = { read: async () => store.value, write: async (_namespace, _server, value) => { store.value = value; }, clear: async () => { store.value = null; } };
  const lease = { filename: "/synthetic/lease.json", closed: 0, replaced: [], async close() { this.closed++; }, async replace(value) { this.replaced.push(value.token); } };
  const auth = new DesktopAuth({ serverUrl: f.origin, client: new FeishuLoginClient({ getDeviceKey: device.get }), resumeStore,
    leaseFactory: async () => lease, activate: async () => {}, deactivate: async () => {},
    openBrowser: async (launchUrl) => {
      const launched = await fetch(launchUrl, { redirect: "manual" });
      const state = new URL(launched.headers.get("location")).searchParams.get("state"), cookie = launched.headers.get("set-cookie").split(";")[0];
      const callback = new URL(`${f.origin}/auth/feishu/callback`); callback.searchParams.set("state", state); callback.searchParams.set("code", "synthetic-auth-code");
      await fetch(callback, { headers: { cookie } });
    } });
  t.after(() => auth.close());
  await auth.begin(); await auth.poll(); await auth.confirm();
  const first = auth.operatorSession().token, signedInWith = store.value;
  assert.ok(f.sessions.verify(first) && signedInWith);

  f.sessions.sessions.clear();
  // What the desktop's renewal meets thirteen minutes in: the server's own
  // answer for a session it does not know, which the client carries as such.
  const later = new FeishuLoginClient({ getDeviceKey: device.get, now: () => Date.now() + 13 * 60_000 + 1000 });
  await assert.rejects(later.renew(auth.active.session), (error) => error.status === 401 && error.code === "session_expired_or_invalid");

  assert.equal(await auth.recover(first), true);
  const second = auth.operatorSession().token;
  assert.notEqual(second, first);
  assert.ok(f.sessions.verify(second), "the restarted server knows the session it just issued");
  assert.equal(auth.status().renewalState, "scheduled");
  assert.deepEqual(lease.replaced, [second], "the same lease, the new session");
  assert.equal(lease.closed, 0);
  assert.notEqual(store.value, signedInWith, "the credential sealed around the rotated refresh token is the one kept");

  // Feishu refuses a spent refresh token, so a second restart recovers only if
  // the new credential was kept.
  f.sessions.sessions.clear();
  assert.equal(await auth.recover(second), true);
  assert.ok(f.sessions.verify(auth.operatorSession().token));
  assert.equal(f.state.grants.filter((grant) => grant === "refresh_token").length, 2, "one refresh per restart, no more");
});
