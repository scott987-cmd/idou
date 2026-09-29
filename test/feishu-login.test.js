import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, get } from "node:http";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { MemoryStateStore } from "../src/control-plane/state-store.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { FeishuLoginClient, CLOCK_SKEW_MS, validateRenewal } from "../src/application/feishu-login-client.js";
import { DesktopAuth } from "../src/application/desktop-auth.js";
import { LOGIN_RETURN_PATH, LOGIN_RETURN_PATHS, loginProofMessage, MAX_SESSION_WINDOW_MS } from "../src/control-plane/login-proof.js";
import { openLoginReturn } from "../src/application/login-return.js";
import { loadFeishuLoginConfig } from "../src/control-plane/server-config.js";
import { DeviceIdentityStore } from "../src/application/device-identity.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const keys = () => generateKeyPairSync("ed25519");
const publicKey = (pair) => pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const signature = (pair, origin, flow, action = "complete") => sign(null, loginProofMessage(origin, flow.flowId, flow.nonce, action), pair.privateKey).toString("base64url");

async function setup(t, { longSessions = false, sessions = new SessionRegistry(), loginCapacity } = {}) {
  const state = { tenant: "allowed-tenant", calls: [], modelCalls: 0, audits: [], expiry: 3600, refresh: "never-return-refresh" };
  let login;
  const server = createModelGateway({ apiKey: "model-secret-fixture", sessions, authHandler: (req, res) => login.handle(req, res),
    fetchImpl: async () => { state.modelCalls++; return Response.json({ output_text: "synthetic model reply" }); }, audit: (event) => state.audits.push(event) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_synthetic", appSecret: "app-secret-fixture", sessions,
    ...(longSessions ? { sessionRenewalEnabled: true, longSessionDays: 30 } : {}), fetchImpl: async (url, options) => {
    state.calls.push({ url, ...options });
    if (state.failure) return new Response("app-secret-fixture SECRET", { status: 400 });
    if (url.endsWith("/open-apis/authen/v2/oauth/token")) return Response.json({ code: 0, access_token: "user-access-fixture", ...(state.refresh ? { refresh_token: state.refresh } : {}), token_type: "Bearer", expires_in: state.expiry });
    return Response.json({ code: 0, data: { tenant_key: state.tenant, open_id: state.openId ?? "ou_synthetic", name: "合成用户", email: "not-an-identity@example.com", mobile: "do-not-return" } });
  } });
  login = new FeishuLoginService({ origin, provider, sessions, allowedTenants: ["allowed-tenant"], capacity: loginCapacity });
  // Where a sign-in begun here without a FeishuLoginClient comes back to: what
  // that device's listener (login-return.js) would receive, by flow.
  const returned = new Map();
  const device = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1"); returned.set(url.searchParams.get("flow"), url.searchParams.get("secret"));
    res.writeHead(200, { "content-type": "text/plain" }); res.end("returned");
  });
  device.listen(0, "127.0.0.1"); await once(device, "listening");
  t.after(() => { login.close(); server.close(); server.closeAllConnections(); device.close(); device.closeAllConnections(); });
  const post = (route, value, headers = {}) => fetch(`${origin}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  const launch = async (launchUrl) => {
    const response = await fetch(launchUrl, { redirect: "manual" }); assert.equal(response.status, 302);
    return { url: new URL(response.headers.get("location")), cookie: response.headers.get("set-cookie").split(";")[0] };
  };
  // Followed, as a browser does, unless told otherwise: an authorized sign-in
  // is redirected back to the device that began it.
  const callback = (launched, patch = {}, { redirect = "follow" } = {}) => {
    const url = new URL(`${origin}/auth/feishu/callback`); url.searchParams.set("state", launched.url.searchParams.get("state")); url.searchParams.set("code", "synthetic-auth-code");
    for (const [name, value] of Object.entries(patch)) url.searchParams.set(name, value);
    return fetch(url, { headers: { cookie: launched.cookie }, redirect });
  };
  return { state, sessions, origin, login, provider, post, launch, callback, returnPort: device.address().port, returned };
}

test("real HTTP login flow binds PKCE/browser/device proof and yields a scoped gateway token, not Feishu secrets", async (t) => {
  let heard = 0;
  const f = await setup(t), client = new FeishuLoginClient({ onReturn: () => { heard += 1; } });
  const begun = await client.begin(f.origin), launched = await f.launch(begun.launchUrl);
  assert.equal(launched.url.origin, "https://accounts.feishu.cn");
  assert.equal(launched.url.pathname, "/open-apis/authen/v1/authorize");
  assert.equal(launched.url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(launched.url.searchParams.get("redirect_uri"), `${f.origin}/auth/feishu/callback`);
  assert.equal(launched.url.searchParams.has("scope"), false);
  assert.deepEqual(await client.complete(), { status: "pending" });
  // The authorizing browser is sent back to this device, with the secret that
  // completes the sign-in in the address and nowhere else.
  const returned = await f.callback(launched, {}, { redirect: "manual" }); assert.equal(returned.status, 302);
  assert.match(returned.headers.get("set-cookie"), /Max-Age=0/); assert.equal(returned.headers.get("referrer-policy"), "no-referrer");
  const back = new URL(returned.headers.get("location")), secret = back.searchParams.get("secret");
  assert.equal(`${back.origin}${back.pathname}`, client.returnUrl()); assert.equal(back.pathname, LOGIN_RETURN_PATH);
  assert.equal(back.searchParams.get("flow"), new URL(begun.launchUrl).searchParams.get("flow")); assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.doesNotMatch(await returned.text(), new RegExp(secret));
  assert.equal(heard, 0);
  const page = await fetch(back); assert.equal(page.status, 200); assert.match(await page.text(), /返回应用确认账号/);
  assert.equal(heard, 1, "the application is told at once");
  const result = await client.complete();
  await assert.rejects(fetch(back), "and the address stops listening once the sign-in is done");
  assert.equal(result.identity.provider, "feishu"); assert.equal(result.identity.tenantId, "allowed-tenant");
  assert.equal(result.identity.userId, "ou_synthetic"); assert.equal(result.identity.deviceProof, "ed25519-login");
  assert.doesNotMatch(JSON.stringify(result), /user-access-fixture|never-return-refresh|app-secret-fixture|not-an-identity|do-not-return/);
  assert.equal(f.state.calls.length, 2);
  const request = f.state.calls[0], form = new Map(Object.entries(JSON.parse(request.body)));
  assert.equal(request.url, "https://open.feishu.cn/open-apis/authen/v2/oauth/token"); assert.equal(request.redirect, "error");
  assert.equal(request.headers["content-type"], "application/json"); assert.equal(form.get("client_secret"), "app-secret-fixture");
  assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), launched.url.searchParams.get("code_challenge"));
  assert.equal(f.state.calls[1].url, "https://open.feishu.cn/open-apis/authen/v1/user_info");
  assert.equal(f.state.calls[1].headers.authorization, "Bearer user-access-fixture");
  const model = await f.post("/v1/responses", { model: "MiniMax-M3", input: "synthetic" }, { authorization: `Bearer ${result.token}` });
  assert.equal(model.status, 200); assert.equal((await model.json()).output_text, "synthetic model reply");
  const info = await fetch(`${f.origin}/auth/session`, { headers: { authorization: `Bearer ${result.token}` } }); assert.equal((await info.json()).identity.userId, "ou_synthetic");
  assert.deepEqual(f.sessions.verify(result.token).scopes, ["models:responses"]);
  assert.equal((await f.post("/auth/logout", {}, { authorization: `Bearer ${result.token}` })).status, 200);
  assert.equal((await f.post("/v1/responses", { model: "MiniMax-M3", input: "synthetic" }, { authorization: `Bearer ${result.token}` })).status, 401);
  assert.equal(f.state.modelCalls, 1); assert.doesNotMatch(JSON.stringify(f.state.audits), /fixture|synthetic-auth-code|ou_synthetic/);
});

// With several replicas the desktop's next request may reach another one, which
// reads the token from the shared store (sessions.js). So a login's answer
// waits for the store, and so does a logout's.
class HeldStore extends EventEmitter {
  constructor() { super(); this.inner = new MemoryStateStore(); this.ops = []; this.held = null; }
  async put(...args) { this.ops.push("put"); await this.held?.promise; return this.inner.put(...args); }
  async get(...args) { return this.inner.get(...args); }
  async take(...args) { this.ops.push("take"); await this.held?.promise; return this.inner.take(...args); }
  async delete(...args) { return this.inner.delete(...args); }
  async deleteChildren(...args) { this.ops.push("family"); return this.inner.deleteChildren(...args); }
  async present(...args) { return this.inner.present(...args); }
}

test("a login's tokens reach the desktop only once the shared store has them, and a logout is in the store before its answer", async (t) => {
  const store = new HeldStore(), sessions = new SessionRegistry({ state: store });
  t.after(() => sessions.close());
  const f = await setup(t, { sessions }), client = new FeishuLoginClient();
  const begun = await client.begin(f.origin);
  await f.callback(await f.launch(begun.launchUrl));
  store.held = Promise.withResolvers();
  let answered = false;
  const completing = client.complete().then((result) => { answered = true; return result; });
  for (const until = Date.now() + 5000; store.ops.length < 2 && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(store.ops, ["put", "put"], "the login's token and its model-turn token are on their way");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(answered, false, "and the desktop does not have them yet");
  store.held.resolve(); store.held = null;
  const result = await completing;
  const digest = (token) => createHash("sha256").update(token).digest("hex");
  for (const token of [result.token, result.turnToken]) assert.ok(await store.inner.get("session", digest(token)), "in the store by the time the desktop has it");
  store.ops.length = 0; store.held = Promise.withResolvers();
  let loggedOut = false;
  const leaving = f.post("/auth/logout", {}, { authorization: `Bearer ${result.token}` }).then((response) => { loggedOut = true; return response; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(store.ops, ["take"]);
  assert.equal(loggedOut, false, "no answer before the store has the revocation");
  store.held.resolve(); store.held = null;
  assert.equal((await leaving).status, 200);
  assert.deepEqual(store.ops, ["take", "family"]);
  for (const token of [result.token, result.turnToken]) assert.equal(await store.inner.get("session", digest(token)), null);
});

test("spoofed tenants, browser origins, foreign keys and proof replays cannot mint sessions", async (t) => {
  const f = await setup(t), pair = keys();
  assert.equal((await f.post("/auth/feishu/begin", { publicKey: publicKey(pair), returnPort: f.returnPort }, { origin: "https://evil.example" })).status, 403);
  const flow = await (await f.post("/auth/feishu/begin", { publicKey: publicKey(pair), returnPort: f.returnPort, tenantId: "allowed-tenant", userId: "admin", role: "admin" })).json();
  const launched = await f.launch(flow.launchUrl); await f.callback(launched);
  const secret = f.returned.get(flow.flowId);
  assert.equal((await f.post("/auth/feishu/complete", { flowId: flow.flowId, signature: signature(keys(), f.origin, flow), secret })).status, 403);
  assert.equal((await f.post("/auth/feishu/complete", { flowId: flow.flowId, signature: signature(pair, "https://other.example", flow), secret })).status, 403);
  assert.equal((await f.post("/auth/feishu/complete", { flowId: flow.flowId, signature: signature(pair, f.origin, flow, "cancel"), secret })).status, 403);
  const proof = { flowId: flow.flowId, signature: signature(pair, f.origin, flow), secret };
  const result = await (await f.post("/auth/feishu/complete", proof)).json(); assert.equal(result.identity.userId, "ou_synthetic");
  assert.equal((await f.post("/auth/feishu/complete", proof)).status, 400); assert.equal(f.sessions.sessions.size, 2, "the one successful login minted its root + model-turn pair; the replay minted nothing");
});

test("state/browser mismatch and repeated callbacks cannot exchange authorization codes", async (t) => {
  const f = await setup(t), pair = keys(), flow = f.login.begin(publicKey(pair), f.returnPort), launched = await f.launch(flow.launchUrl);
  const url = `${f.origin}/auth/feishu/callback?state=${launched.url.searchParams.get("state")}&code=synthetic`;
  assert.equal((await fetch(url)).status, 400);
  assert.equal((await fetch(`${url}&state=duplicate`, { headers: { cookie: launched.cookie } })).status, 400);
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.callback(launched)).status, 200); assert.equal((await f.callback(launched)).status, 400); assert.equal(f.state.calls.length, 2);
});

// Found 2026-09-27. Someone begins a sign-in on their own device and sends the
// link; the person who opens it is signed in to Feishu in their browser and
// clicks 授权. The session used to go to the device that began the sign-in --
// the sender -- with that person's account in it. The authorizing browser is
// now sent back to its own machine's loopback address, never the sender's, and
// only the secret it carries there completes the sign-in.
test("a sign-in link opened in someone else's browser gives whoever sent it nothing", async (t) => {
  const f = await setup(t), sender = new FeishuLoginClient();
  const begun = await sender.begin(f.origin), flowId = new URL(begun.launchUrl).searchParams.get("flow");
  // Their browser follows the link and authorizes. The redirect names a port
  // on 127.0.0.1 -- on their machine, where the sender's device is not.
  const theirs = await f.callback(await f.launch(begun.launchUrl), {}, { redirect: "manual" });
  assert.equal(theirs.status, 302);
  assert.equal(f.login.flows.get(flowId).status, "authorized", "Feishu has said who authorized it");
  assert.deepEqual(await sender.complete(), { status: "pending" }, "and the sender still has nothing");
  assert.equal(f.sessions.sessions.size, 0);
  // Guessing is no way round it: one wrong secret ends the sign-in.
  const guessed = await f.post("/auth/feishu/complete", { ...sender.proof(sender.attempt, "complete"), secret: "A".repeat(43) });
  assert.equal(guessed.status, 403); assert.equal((await guessed.json()).error, "login_completion_mismatch");
  assert.equal(f.login.flows.size, 0); assert.equal(f.sessions.sessions.size, 0);
  await assert.rejects(sender.complete(), /重新发起登录/);
  // Nor is a secret offered before anyone authorized: there is none yet.
  const early = await sender.begin(f.origin);
  const refused = await f.post("/auth/feishu/complete", { ...sender.proof(sender.attempt, "complete"), secret: "B".repeat(43) });
  assert.equal(refused.status, 403); assert.equal((await refused.json()).error, "login_completion_mismatch");
  assert.equal(f.login.flows.has(new URL(early.launchUrl).searchParams.get("flow")), false);
  await sender.cancel();
});

// Signing in without a way back is exactly what the attack above needs, so a
// desktop from before cannot opt out of it; it is told to update.
test("a sign-in that names no way back to its device is refused", async (t) => {
  const f = await setup(t), key = publicKey(keys());
  const bare = await f.post("/auth/feishu/begin", { publicKey: key });
  assert.equal(bare.status, 400); assert.equal((await bare.json()).error, "client_update_required");
  for (const returnPort of [80, 0, 65536, "50000", 50000.5, -1]) {
    const response = await f.post("/auth/feishu/begin", { publicKey: key, returnPort });
    assert.equal(response.status, 400, String(returnPort)); assert.equal((await response.json()).error, "invalid_login_request");
  }
  assert.equal(f.login.flows.size, 0);
});

// The device's side of it (login-return.js).
test("this device's return address answers only its own sign-in, and keeps the first secret it is given", async (t) => {
  let heard = 0;
  const loopback = await openLoginReturn({ onReturn: () => { heard += 1; } });
  t.after(() => loopback.close());
  const base = `http://127.0.0.1:${loopback.port}${LOGIN_RETURN_PATH}`, flow = "f".repeat(43), secret = "s".repeat(43);
  assert.ok(loopback.port >= 1024);
  assert.equal((await fetch(`${base}?flow=${flow}&secret=${secret}`)).status, 404, "nothing before the sign-in is named");
  loopback.expect(flow);
  for (const wrong of [`${base}?flow=${"g".repeat(43)}&secret=${secret}`, `${base}?flow=${flow}&secret=short`, `${base}?flow=${flow}&flow=${flow}&secret=${secret}`,
    `${base}?flow=${flow}&secret=${secret}&secret=${secret}`, `http://127.0.0.1:${loopback.port}/elsewhere?flow=${flow}&secret=${secret}`]) {
    assert.equal((await fetch(wrong)).status, 404, wrong);
  }
  assert.equal((await fetch(`${base}?flow=${flow}&secret=${secret}`, { method: "POST" })).status, 404);
  // A page that points its own name at 127.0.0.1 arrives under that name.
  const rebound = await new Promise((resolve, reject) => get({ host: "127.0.0.1", port: loopback.port, path: `${LOGIN_RETURN_PATH}?flow=${flow}&secret=${secret}`,
    headers: { host: `rebound.example:${loopback.port}` } }, resolve).on("error", reject));
  assert.equal(rebound.statusCode, 404); rebound.resume();
  assert.equal(loopback.secret(), null); assert.equal(heard, 0);
  const page = await fetch(`${base}?flow=${flow}&secret=${secret}`);
  assert.equal(page.status, 200); assert.match(await page.text(), /飞书授权完成，请返回应用确认账号/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer"); assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${base}?flow=${flow}&secret=${"t".repeat(43)}`)).status, 200);
  assert.equal(loopback.secret(), secret, "the first one stays"); assert.equal(heard, 1);
});

// The product was renamed; a server sends the path under the spelling its
// devices all answer, and a device answers it under both.
test("this device's return address answers under either spelling of the product's name, and nothing like it", async (t) => {
  assert.deepEqual([...LOGIN_RETURN_PATHS].sort(), ["/idou/login-complete", "/mydoubao/login-complete"]);
  assert.ok(LOGIN_RETURN_PATHS.includes(LOGIN_RETURN_PATH), "the path a server sends is one a device answers");
  for (const returnPath of LOGIN_RETURN_PATHS) {
    const loopback = await openLoginReturn();
    t.after(() => loopback.close());
    const flow = "f".repeat(43), secret = "s".repeat(43);
    loopback.expect(flow);
    for (const near of ["/IDOU/login-complete", "/idou/login-complete/", "/i/login-complete", "/login-complete"]) {
      assert.equal((await fetch(`http://127.0.0.1:${loopback.port}${near}?flow=${flow}&secret=${secret}`)).status, 404, near);
    }
    assert.equal((await fetch(`http://127.0.0.1:${loopback.port}${returnPath}?flow=${flow}&secret=${secret}`)).status, 200, returnPath);
    assert.equal(loopback.secret(), secret);
  }
});

// The browser's binding cookie carries the product's name, which changed; a
// server of either version may be the one the browser comes back to. It is read
// under either spelling -- and a browser sending two is still refused.
test("the browser's sign-in cookie is read under either spelling of the product's name, and only one may be sent", async (t) => {
  for (const [spelling, accepted] of [["idou", true], ["mydoubao", true]]) {
    const f = await setup(t), client = new FeishuLoginClient(), begun = await client.begin(f.origin), launched = await f.launch(begun.launchUrl);
    const value = launched.cookie.slice(launched.cookie.indexOf("=") + 1);
    const answer = await f.callback({ ...launched, cookie: `${spelling}_oauth=${value}` }, {}, { redirect: "manual" });
    assert.equal(answer.status === 302, accepted, spelling);
  }
  const f = await setup(t), client = new FeishuLoginClient(), begun = await client.begin(f.origin), launched = await f.launch(begun.launchUrl);
  const value = launched.cookie.slice(launched.cookie.indexOf("=") + 1);
  const twice = await f.callback({ ...launched, cookie: `idou_oauth=${value}; mydoubao_oauth=${value}` });
  assert.equal(twice.status, 400);
  assert.equal((await twice.json()).error, "oauth_state_or_browser_mismatch");
});

test("unapproved tenant, denied consent, upstream error and invalid user token all fail closed", async (t) => {
  for (const reason of ["tenant", "consent", "upstream", "invalid-expiry"]) {
    const f = await setup(t), client = new FeishuLoginClient(), begun = await client.begin(f.origin), launched = await f.launch(begun.launchUrl);
    if (reason === "tenant") f.state.tenant = "other-tenant";
    if (reason === "upstream") f.state.failure = true;
    if (reason === "invalid-expiry") f.state.expiry = 0;
    const returned = await f.callback(launched, reason === "consent" ? { error: "access_denied" } : {});
    assert.equal(returned.status, 403); assert.doesNotMatch(await returned.text(), /SECRET|fixture|other-tenant/);
    await assert.rejects(client.complete()); assert.equal(f.sessions.sessions.size, 0);
    if (reason === "consent") assert.equal(f.state.calls.length, 0);
  }
});

test("signed cancellation, login expiry, flow caps and rejected key formats bound the login state", async (t) => {
  // The rate new logins may start at is the server's capacity; set low here.
  const f = await setup(t, { loginCapacity: { perMinute: 30 } }), client = new FeishuLoginClient();
  await client.begin(f.origin); await client.cancel(); assert.equal(f.login.flows.size, 0);
  await assert.rejects(client.complete(), /过期/);
  assert.throws(() => f.login.begin("invalid-key"));
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }); assert.throws(() => f.login.begin(publicKey(rsa)));
  const flow = f.login.begin(publicKey(keys()), f.returnPort); f.login.flows.get(flow.flowId).expiresAt = Date.now() - 1;
  assert.throws(() => f.login.launch(flow.flowId), /expired/);
  for (let i = 0; i < 28; i++) f.login.begin(publicKey(keys()), f.returnPort);
  assert.throws(() => f.login.begin(publicKey(keys()), f.returnPort), /limit/);
  const oversized = await f.post("/auth/feishu/begin", { publicKey: "x".repeat(3000) }); assert.equal(oversized.status, 413);
});

test("cancelling during code exchange prevents late identity from resurrecting a completed login", async (t) => {
  const f = await setup(t), started = Promise.withResolvers(), gate = Promise.withResolvers();
  f.provider.exchangeCode = async () => { started.resolve(); await gate.promise; return { tenantId: "allowed-tenant", userId: "ou_late", appId: "cli_synthetic", expiresAt: Date.now() + 10000 }; };
  const client = new FeishuLoginClient(), begun = await client.begin(f.origin), launched = await f.launch(begun.launchUrl);
  const callback = f.callback(launched); await started.promise; await client.cancel(); gate.resolve();
  assert.equal((await callback).status, 403); assert.equal(f.login.flows.size, 0); assert.equal(f.sessions.sessions.size, 0);
});

test("real HTTP logins after durable device-store restart keep device identity but mint new revocable sessions", async t => {
  const f = await setup(t), directory = await mkdtemp(path.join(os.tmpdir(), "idou-device-login-")), cipher = fixtureCipher();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authenticate = async () => {
    const store = new DeviceIdentityStore({ directory, cipher }), client = new FeishuLoginClient({ getDeviceKey: origin => store.key(origin) });
    const begun = await client.begin(f.origin), launched = await f.launch(begun.launchUrl); await f.callback(launched); return client.complete();
  };
  const first = await authenticate(); await f.post("/auth/logout", {}, { authorization: `Bearer ${first.token}` });
  const second = await authenticate(); assert.equal(second.identity.deviceId, first.identity.deviceId); assert.notEqual(second.token, first.token);
  assert.equal(f.sessions.verify(first.token), null); assert.ok(f.sessions.verify(second.token));
});

test("cancel during durable key loading sends no login request and cannot restore the cancelled attempt", async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const client = new FeishuLoginClient({ getDeviceKey: () => gate.promise, fetchImpl: async () => { calls++; throw new Error("unexpected network"); } });
  const starting = client.begin("https://control.example"); await client.cancel(); gate.resolve(keys().privateKey);
  await assert.rejects(starting, /已取消/); assert.equal(calls, 0); assert.equal(client.attempt, null);
});

test("substituted device identity in redemption is revoked rather than accepted", async t => {
  const f = await setup(t), client = new FeishuLoginClient({ fetchImpl: async (url, options) => {
    const response = await fetch(url, options); if (!url.endsWith("/complete")) return response;
    const result = await response.json(); result.identity.deviceId = "x".repeat(43); return Response.json(result);
  } });
  const begun = await client.begin(f.origin), launched = await f.launch(begun.launchUrl); await f.callback(launched);
  await assert.rejects(client.complete(), /设备身份/); assert.equal(f.sessions.sessions.size, 0); assert.equal(client.attempt, null);
});

// A control plane on another machine keeps its own time, and every expiry the
// client checks was written by it. Two NTP-synchronised machines were 0.1 s
// apart: the 300 s sign-in flow came back 300.1 s away, and every sign-in to
// the remote deployment was refused as an invalid authorization entry.
test("a server clock a little ahead of this one still signs in; one handing out much more is still refused", async () => {
  const origin = "https://enterprise.example", now = 1_800_000_000_000, flowId = "f".repeat(43);
  const begin = (expiresAt) => new FeishuLoginClient({ now: () => now,
    fetchImpl: async () => Response.json({ flowId, nonce: "n".repeat(43), expiresAt, launchUrl: `${origin}/auth/feishu/launch?flow=${flowId}` }) }).begin(origin);
  assert.equal((await begin(now + 300_000 + 100)).launchUrl, `${origin}/auth/feishu/launch?flow=${flowId}`, "0.1 s ahead, as measured");
  assert.equal((await begin(now + 300_000 + CLOCK_SKEW_MS)).expiresAt, now + 300_000 + CLOCK_SKEW_MS);
  await assert.rejects(begin(now + 300_000 + CLOCK_SKEW_MS + 1), /无效的授权入口/);
  await assert.rejects(begin(now + 3_600_000), /无效的授权入口/, "an hour-long flow is still refused");
  // The renewal window a login carries gets the same allowance and no more.
  const session = { expiresAt: now + 600_000, renewal: { renewAfter: now + 480_000, notAfter: now + MAX_SESSION_WINDOW_MS + 100 } };
  assert.doesNotThrow(() => validateRenewal(session, now));
  assert.throws(() => validateRenewal({ ...session, renewal: { ...session.renewal, notAfter: now + MAX_SESSION_WINDOW_MS + CLOCK_SKEW_MS + 1 } }, now), /续期策略无效/);
});

test("client rejects substituted launch origins and concurrent/late login starts", async () => {
  const client = new FeishuLoginClient({ fetchImpl: async () => Response.json({ flowId: "x".repeat(43), nonce: "y".repeat(43), expiresAt: Date.now() + 10000, launchUrl: "https://evil.example" }) });
  await assert.rejects(client.begin("https://control.example"), /无效的授权入口/);
  const gate = Promise.withResolvers(), asked = Promise.withResolvers(), slow = new FeishuLoginClient({ fetchImpl: () => { asked.resolve(); return gate.promise; } });
  const beginning = slow.begin("https://control.example"); await assert.rejects(slow.begin("https://control.example"), /当前登录/);
  await asked.promise; await slow.cancel(); gate.resolve(Response.json({})); await assert.rejects(beginning, /无效的授权入口/);
});

test("late begin and redemption responses are cancelled or revoked instead of leaving accepted stale sessions", async (t) => {
  const f = await setup(t), beginGate = Promise.withResolvers(), beginSeen = Promise.withResolvers();
  const slowBegin = new FeishuLoginClient({ fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/begin")) { beginSeen.resolve(); await beginGate.promise; }
    return response;
  } });
  const beginning = slowBegin.begin(f.origin); await beginSeen.promise; await slowBegin.cancel(); beginGate.resolve();
  await assert.rejects(beginning, /已取消/); assert.equal(f.login.flows.size, 0);

  const redeemGate = Promise.withResolvers(), redeemSeen = Promise.withResolvers();
  const slowRedeem = new FeishuLoginClient({ fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/complete")) { redeemSeen.resolve(); await redeemGate.promise; }
    return response;
  } });
  const begun = await slowRedeem.begin(f.origin), launched = await f.launch(begun.launchUrl); await f.callback(launched);
  const completing = slowRedeem.complete(); await redeemSeen.promise; assert.equal(f.sessions.sessions.size, 2);
  await slowRedeem.cancel(); redeemGate.resolve(); await assert.rejects(completing, /未使用旧会话/);
  assert.equal(f.sessions.sessions.size, 0);
});

test("server OAuth configuration is explicit, tenant-restricted and never interpolates secret errors", () => {
  const env = { IDOU_PUBLIC_URL: "https://control.example", FEISHU_APP_ID: "cli_synthetic", FEISHU_APP_SECRET: "SECRET", FEISHU_ALLOWED_TENANTS: "tenant-a,tenant-b" };
  assert.deepEqual(loadFeishuLoginConfig(env).allowedTenants, ["tenant-a", "tenant-b"]);
  for (const patch of [{ FEISHU_ALLOWED_TENANTS: "" }, { FEISHU_ALLOWED_TENANTS: "*" }, { FEISHU_APP_ID: "SECRET" }, { IDOU_PUBLIC_URL: "http://public.example" }, { IDOU_PUBLIC_URL: "http://127.0.0.1:1234", IDOU_PORT: "4321" }]) {
    assert.throws(() => loadFeishuLoginConfig({ ...env, ...patch }), (error) => !error.message.includes("SECRET"));
  }
});

test("terminal HTTP login failures release the desktop flow so a new explicit authorization can start", async t => {
  for (const reason of ["expired", "denied", "server-restarted"]) {
    const f = await setup(t), client = new FeishuLoginClient(), launches = [];
    const auth = new DesktopAuth({ serverUrl: f.origin, client, openBrowser: async url => launches.push(url),
      activate: async () => assert.fail("Failed authorization must not activate"), deactivate: async () => {} });
    t.after(() => auth.close());
    await auth.begin();
    if (reason === "expired") client.attempt.expiresAt = Date.now() - 1;
    else if (reason === "server-restarted") f.login.flows.clear();
    else await f.callback(await f.launch(launches.at(-1)), { error: "access_denied" });
    await assert.rejects(auth.poll());
    assert.equal(auth.status().stage, "idle", reason);
    assert.equal(auth.status().pendingIdentity, null); assert.equal(client.attempt, null);
    assert.equal(f.sessions.sessions.size, 0); assert.equal(f.state.modelCalls, 0);
    await auth.begin(); assert.equal(launches.length, 2); assert.equal(auth.status().stage, "waiting");
  }
});

test("transient polling failures retain the flow for manual checking and never auto-retry", async t => {
  for (const status of [408, 429, 503, "network"]) {
    const f = await setup(t); let calls = 0, fail = true;
    const client = new FeishuLoginClient({ fetchImpl: async (url, options) => {
      if (url.endsWith("/complete")) {
        calls++;
        if (fail) { if (status === "network") throw new TypeError("offline"); return new Response("not exposed", { status }); }
      }
      return fetch(url, options);
    } });
    const launches = [], auth = new DesktopAuth({ serverUrl: f.origin, client, openBrowser: async url => launches.push(url),
      activate: async () => assert.fail("Polling must not activate"), deactivate: async () => {} });
    t.after(() => auth.close());
    await auth.begin(); const attempt = client.attempt;
    await assert.rejects(auth.poll()); assert.equal(calls, 1);
    assert.equal(auth.status().stage, "waiting"); assert.equal(client.attempt, attempt);
    await f.callback(await f.launch(launches.at(-1))); fail = false;
    await auth.poll(); assert.equal(calls, 2); assert.equal(auth.status().stage, "confirm");
  }
});

test("lost redemption response is not reissued; a later explicit check returns to fresh login", async t => {
  const f = await setup(t); let lose = true, launch;
  const client = new FeishuLoginClient({ fetchImpl: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith("/complete") && lose) { lose = false; await response.body.cancel(); throw new TypeError("response lost"); }
    return response;
  } });
  const auth = new DesktopAuth({ serverUrl: f.origin, client, openBrowser: async url => { launch = url; },
    activate: async () => assert.fail("Unknown response must not activate"), deactivate: async () => {} });
  t.after(() => auth.close());
  await auth.begin(); await f.callback(await f.launch(launch));
  await assert.rejects(auth.poll(), /response lost/); assert.equal(f.sessions.sessions.size, 2);
  await assert.rejects(auth.poll(), /重新发起/); assert.equal(auth.status().stage, "idle");
  assert.equal(f.sessions.sessions.size, 2, "the lost login's root + model-turn pair expire server-side; a retry mints no further credential");
  assert.equal(auth.status().connected, false); assert.equal(f.state.modelCalls, 0);
  await auth.begin(); assert.equal(auth.status().stage, "waiting");
});

test("malformed redemption is abandoned and known same-origin credentials are revoked", async t => {
  const f = await setup(t), client = new FeishuLoginClient({ fetchImpl: async (url, options) => {
    const response = await fetch(url, options); if (!url.endsWith("/complete")) return response;
    const value = await response.json(); value.expiresAt = Date.now() + 3600000; return Response.json(value);
  } });
  const begun = await client.begin(f.origin); await f.callback(await f.launch(begun.launchUrl));
  await assert.rejects(client.complete(), /响应无效/); assert.equal(client.attempt, null);
  assert.equal(f.sessions.sessions.size, 0); await client.begin(f.origin); await client.cancel();
});

// The desktop shows the authorization link for the case where the system browser
// did not open, or opened the wrong one. That link has to still work, while the
// browser binding stays exactly one browser at a time.
test("an unused authorization link can be reopened, rebinding to the newest browser only", async t => {
  const f = await setup(t), client = new FeishuLoginClient();
  const begun = await client.begin(f.origin);
  const first = await f.launch(begun.launchUrl), second = await f.launch(begun.launchUrl);
  assert.notEqual(first.cookie, second.cookie);
  // Same flow, so PKCE state is unchanged; only the browser binding moved.
  assert.equal(first.url.searchParams.get("state"), second.url.searchParams.get("state"));
  assert.equal(first.url.searchParams.get("code_challenge"), second.url.searchParams.get("code_challenge"));

  // The first browser's cookie no longer matches, so its tab cannot complete.
  const stale = await f.callback(first);
  assert.equal(stale.status, 400);
  assert.equal((await stale.json()).error, "oauth_state_or_browser_mismatch");

  const accepted = await f.callback(second, {}, { redirect: "manual" });
  assert.equal(accepted.status, 302);
  assert.equal(new URL(accepted.headers.get("location")).origin, new URL(client.returnUrl()).origin, "sent back to this device");

  // Once a callback has been accepted the link is spent and cannot be reopened.
  const spent = await fetch(begun.launchUrl, { redirect: "manual" });
  assert.equal(spent.status, 409);
});

// R2: which Feishu account the desktop's embedded web pages are signed in as.
// The desktop sends its embedded browser through the launch URL; everything
// after that is the same callback a login uses, and ends in a verdict.
async function signedIn(f) {
  const client = new FeishuLoginClient();
  const begun = await client.begin(f.origin);
  await f.callback(await f.launch(begun.launchUrl));
  return (await client.complete()).token;
}
const probe = (f, token, route, value = {}) => f.post(`/auth/feishu/web-identity/${route}`, value, { authorization: `Bearer ${token}` });

test("a web-identity probe says whether the embedded browser is the signed-in person, and keeps nothing", async t => {
  const f = await setup(t), token = await signedIn(f);
  const sessionsBefore = f.sessions.sessions.size, callsBefore = f.state.calls.length;
  const begun = await (await probe(f, token, "begin")).json();
  assert.match(begun.launchUrl, /\/auth\/feishu\/launch\?flow=/);
  assert.deepEqual(await (await probe(f, token, "status", { flowId: begun.flowId })).json(), { status: "pending", launched: false, expiresAt: begun.expiresAt });
  const launched = await f.launch(begun.launchUrl);
  assert.equal(launched.url.origin, "https://accounts.feishu.cn");
  const page = await f.callback(launched);
  assert.equal(page.status, 200);
  assert.match((await page.json()).message, /网页账号与应用登录一致/);
  const verdict = await (await probe(f, token, "status", { flowId: begun.flowId })).json();
  assert.equal(verdict.status, "verified");
  assert.equal((await probe(f, token, "status", { flowId: begun.flowId })).status, 404, "a verdict is read once");
  assert.equal(f.sessions.sessions.size, sessionsBefore, "no session came of it");
  assert.equal(f.state.calls.length, callsBefore + 2, "one exchange and one identity read");
  assert.doesNotMatch(JSON.stringify(verdict), /ou_|tenant|user-access|refresh/);
});

test("a browser signed in as someone else is a conflict, and who they are is not said", async t => {
  const f = await setup(t), token = await signedIn(f);
  const begun = await (await probe(f, token, "begin")).json();
  f.state.openId = "ou_someone_else";
  const page = await f.callback(await f.launch(begun.launchUrl));
  assert.equal(page.status, 403);
  const text = await page.text();
  assert.match(text, /不是同一个人/);
  assert.doesNotMatch(text, /ou_someone_else|合成用户/);
  const verdict = await (await probe(f, token, "status", { flowId: begun.flowId })).json();
  assert.equal(verdict.status, "conflict");
  assert.doesNotMatch(JSON.stringify(verdict), /ou_someone_else/);
});

test("another tenant is a conflict too, and a declined page is not mistaken for either", async t => {
  const f = await setup(t), token = await signedIn(f);
  const other = await (await probe(f, token, "begin")).json();
  f.state.tenant = "someone-elses-tenant";
  await f.callback(await f.launch(other.launchUrl));
  assert.equal((await (await probe(f, token, "status", { flowId: other.flowId })).json()).status, "conflict");
  f.state.tenant = "allowed-tenant";
  const declined = await (await probe(f, token, "begin")).json();
  const page = await f.callback(await f.launch(declined.launchUrl), { error: "access_denied", code: "" });
  assert.equal(page.status, 403);
  assert.equal((await (await probe(f, token, "status", { flowId: declined.flowId })).json()).status, "declined");
});

// A probe has no device key and no business becoming a login. Nor may anyone
// but the session that asked read what it found.
test("a probe cannot be completed into a session, read by another person, or begun without a Feishu login", async t => {
  const f = await setup(t), token = await signedIn(f);
  const begun = await (await probe(f, token, "begin")).json();
  await f.callback(await f.launch(begun.launchUrl));
  const pair = keys();
  const completed = await f.post("/auth/feishu/complete", { flowId: begun.flowId, signature: sign(null, Buffer.from("x"), pair.privateKey).toString("base64url") });
  assert.equal(completed.status, 400);
  assert.equal((await completed.json()).error, "login_expired_or_invalid");

  f.state.openId = "ou_second_person";
  const second = await signedIn(f);
  assert.equal((await probe(f, second, "status", { flowId: begun.flowId })).status, 404, "another person's session cannot read it");
  assert.equal((await (await probe(f, token, "status", { flowId: begun.flowId })).json()).status, "verified", "and it was still there for the one that asked");

  const development = f.sessions.issue({ tenantId: "allowed-tenant", userId: "ou_synthetic", deviceId: "dev" });
  assert.equal((await probe(f, development.token, "begin")).status, 403, "a development session has no Feishu account to compare");
  assert.equal((await probe(f, "not-a-token", "begin")).status, 401);
  const turn = f.sessions.issueForModelTurn(token);
  assert.equal((await probe(f, turn.token, "begin")).status, 403, "a derived token cannot start one");
});

test("probes are bounded per person", async t => {
  const f = await setup(t), token = await signedIn(f);
  for (let index = 0; index < 10; index += 1) assert.equal((await probe(f, token, "begin")).status, 200);
  const limited = await probe(f, token, "begin");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "web_identity_limit_reached");
});

// offline_access is what mints a refresh token. Whether Feishu retires older
// refresh tokens when it issues a new one is not documented, and unattended
// schedules depend on the one the server holds, so a probe never asks for it.
test("a probe asks for the login's permissions except offline_access, and retains nothing it is given", async () => {
  const calls = [];
  const sourceAccess = { feishu: SAAS_FEISHU, requiredScopes: ["docx:document:readonly"], identityChecksEnabled: false, cliProxyEnabled: false, cliWriteCapabilities: [],
    remember: () => { throw new Error("a probe must not hand a token to source access"); }, discard() {}, prune() {} };
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_synthetic", appSecret: "app-secret-fixture", sourceAccess, sessions: new SessionRegistry(),
    sessionRenewalEnabled: true, longSessionDays: 30, fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body });
      if (url.endsWith("/oauth/token")) return Response.json({ code: 0, access_token: "probe-access", refresh_token: "probe-refresh", token_type: "Bearer", expires_in: 7200, scope: "docx:document:readonly" });
      return Response.json({ code: 0, data: { tenant_key: "allowed-tenant", open_id: "ou_synthetic" } });
    } });
  const login = new URL(provider.authorizationUrl({ redirectUri: "https://example.test/cb", state: "s", challenge: "c" }));
  assert.equal(login.searchParams.get("scope"), "docx:document:readonly offline_access");
  const probeUrl = new URL(provider.authorizationUrl({ redirectUri: "https://example.test/cb", state: "s", challenge: "c", scopes: provider.probeScopes }));
  assert.equal(probeUrl.searchParams.get("scope"), "docx:document:readonly");
  const seen = await provider.probeIdentity({ code: "code", verifier: "verifier", redirectUri: "https://example.test/cb" });
  assert.deepEqual(seen, { tenantId: "allowed-tenant", userId: "ou_synthetic", appId: "cli_synthetic" });
  assert.equal(JSON.parse(calls[0].body).scope, "docx:document:readonly", "the exchange asks for the same, without offline_access");
  assert.doesNotMatch(JSON.stringify(seen), /probe-access|probe-refresh/);
});

// The unattended credential's own authorization. Its refresh token goes to the
// `redeemed` hook and nowhere else, and only once Feishu has said it belongs to
// the session's own person.
test("a dedicated authorization hands its own refresh token over, for the session's own person only", async t => {
  const f = await setup(t, { longSessions: true }), token = await signedIn(f);
  const who = f.sessions.verify(token), handed = [];
  f.state.refresh = "dedicated-refresh-fixture";
  const begun = f.login.beginGrant(who, async (value) => { handed.push(value); return { expiresAt: 42, resumed: 1 }; });
  assert.equal(f.login.grantStatus(who, begun.flowId).status, "pending");
  const launched = await f.launch(begun.launchUrl);
  assert.equal(launched.url.searchParams.get("scope"), "offline_access", "the login's own permissions, refresh included");
  const page = await f.callback(launched);
  assert.equal(page.status, 200);
  assert.match((await page.json()).message, /已为定时任务单独授权/);
  assert.deepEqual(handed, [{ appId: "cli_synthetic", tenantId: "allowed-tenant", userId: "ou_synthetic", refreshToken: "dedicated-refresh-fixture" }]);
  assert.deepEqual(f.login.grantStatus(who, begun.flowId), { status: "granted", expiresAt: 42, resumed: 1 });
  assert.throws(() => f.login.grantStatus(who, begun.flowId), /grant_unknown/, "read once");
});

test("a dedicated authorization by someone else, or without a refresh token, or unsaved, keeps nothing", async t => {
  const f = await setup(t, { longSessions: true }), token = await signedIn(f);
  const who = f.sessions.verify(token), handed = [];
  const hook = async (value) => { handed.push(value); return {}; };
  const run = async (prepare) => {
    const begun = f.login.beginGrant(who, hook);
    const launched = await f.launch(begun.launchUrl);
    prepare();
    await f.callback(launched);
    return f.login.grantStatus(who, begun.flowId).status;
  };
  assert.equal(await run(() => { f.state.openId = "ou_someone_else"; }), "conflict");
  assert.equal(await run(() => { f.state.openId = undefined; f.state.refresh = null; }), "no_refresh");
  assert.deepEqual(handed, [], "the hook never saw either");
  f.state.refresh = "dedicated-refresh-fixture";
  const failing = f.login.beginGrant(who, async () => { throw new Error("disk full"); });
  await f.callback(await f.launch(failing.launchUrl));
  assert.equal(f.login.grantStatus(who, failing.flowId).status, "grant_failed");
  const declined = f.login.beginGrant(who, hook);
  await f.callback(await f.launch(declined.launchUrl), { error: "access_denied", code: "" });
  assert.equal(f.login.grantStatus(who, declined.flowId).status, "declined");
});

test("a dedicated authorization needs a root Feishu login on a server that keeps long sessions, and is never a login itself", async t => {
  const short = await setup(t);
  const shortWho = short.sessions.verify(await signedIn(short));
  assert.throws(() => short.login.beginGrant(shortWho, async () => ({})), /grant_unavailable/, "no long sessions, no refresh token to keep");
  const f = await setup(t, { longSessions: true }), token = await signedIn(f);
  const who = f.sessions.verify(token);
  const development = f.sessions.issue({ tenantId: "allowed-tenant", userId: "ou_synthetic", deviceId: "dev" });
  assert.throws(() => f.login.beginGrant(development, async () => ({})), /grant_unavailable/);
  assert.throws(() => f.login.beginGrant(f.sessions.verify(f.sessions.issueForModelTurn(token).token), async () => ({})), /login_audience_required/);
  const begun = f.login.beginGrant(who, async () => ({}));
  await f.callback(await f.launch(begun.launchUrl));
  const completed = await f.post("/auth/feishu/complete", { flowId: begun.flowId, signature: sign(null, Buffer.from("x"), keys().privateKey).toString("base64url") });
  assert.equal(completed.status, 400, "a grant flow cannot be completed into a session");
  for (let index = 0; index < 4; index += 1) f.login.beginGrant(who, async () => ({}));
  assert.throws(() => f.login.beginGrant(who, async () => ({})), /grant_limit_reached/);
});
