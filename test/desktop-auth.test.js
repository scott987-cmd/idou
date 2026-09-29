import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { stat, readFile } from "node:fs/promises";
import { dataHome } from "../src/install-names.js";
import { DesktopAuth, accountNamespace, legacyAccountNamespace, createSessionLease } from "../src/application/desktop-auth.js";
import { readClientSession } from "../src/control-plane/client-session.js";
import { LoginRestartRequired } from "../src/application/feishu-login-client.js";

const session = () => ({ status: "authenticated", serverUrl: "https://enterprise.example", token: "a".repeat(43), expiresAt: Date.now() + 600000,
  identity: { provider: "feishu", appId: "cli_fixture", tenantId: "tenant_a", userId: "ou_a", displayName: "测试用户", deviceProof: "ed25519-login" } });
function setup(overrides = {}) {
  const value = session(), calls = [], leases = [];
  const client = { begin: async () => ({ launchUrl: "https://enterprise.example/auth/feishu/launch?flow=fixture" }),
    complete: async () => value, cancel: async () => calls.push("cancel"), request: async (_url, route, _body, token) => {
      calls.push({ route, token }); return { identity: value.identity, expiresAt: value.expiresAt };
    } };
  const auth = new DesktopAuth({ serverUrl: value.serverUrl, client, openBrowser: async (url) => calls.push({ browser: url }),
    activate: async (scope) => calls.push({ scope }), deactivate: async () => calls.push("deactivate"),
    leaseFactory: async () => { const lease = { filename: "/synthetic/lease.json", closed: 0, async close() { this.closed++; } }; leases.push(lease); return lease; }, ...overrides });
  return { auth, value, client, calls, leases };
}

test("desktop login requires identity confirmation, exposes no credentials, activates a namespaced lease then revokes on logout", async () => {
  const f = setup(); await f.auth.begin();
  const status = await f.auth.poll(); assert.equal(status.stage, "confirm"); assert.equal(status.connected, false); assert.equal(f.leases.length, 0);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(f.value.token));
  const confirmed = await f.auth.confirm(); assert.equal(confirmed.connected, true); assert.equal(f.leases.length, 1);
  assert.equal(f.calls.find((value) => value.scope)?.scope.namespace, accountNamespace(f.value));
  assert.doesNotMatch(JSON.stringify(confirmed), /lease\.json|token/);
  const loggedOut = await f.auth.logout(); assert.equal(loggedOut.identity, null); assert.equal(loggedOut.revoked, true);
  assert.equal(f.leases[0].closed, 1); assert.ok(f.calls.some((value) => value.route === "/auth/logout")); await f.auth.close();
});

// Found live: five hours into a session a server restart could not resume the
// login. Each renewal re-seals the resume credential around the refresh token
// the server now holds (Feishu rotates it on refresh), but the desktop kept the
// one from sign-in, whose token had been spent at the first rotation.
test("a renewal keeps the resume credential it returns, so a later restart can resume", async () => {
  const writes = [];
  const resumeStore = { write: async (_namespace, _server, value) => { writes.push(value); }, clear: async () => { writes.push("cleared"); }, read: async () => null };
  const f = setup({ resumeStore });
  const renewal = { renewAfter: f.value.expiresAt - 120000, notAfter: f.value.expiresAt + 3_600_000 };
  Object.assign(f.value, { renewal, resume: "sealed-at-sign-in" });
  f.client.request = async (_url, route) => { f.calls.push({ route }); return { identity: f.value.identity, expiresAt: f.value.expiresAt, renewal }; };
  const next = { ...f.value, token: "b".repeat(43), expiresAt: f.value.expiresAt + 600_000, resume: "sealed-after-rotation", renewal: { renewAfter: f.value.expiresAt + 480_000, notAfter: renewal.notAfter } };
  f.client.renew = async () => next;
  const replaced = [];
  const lease = { filename: "/synthetic/lease.json", closed: 0, async close() { this.closed++; }, async replace(value) { replaced.push(value.token); } };
  const auth = new DesktopAuth({ serverUrl: f.value.serverUrl, client: f.client, openBrowser: async () => {}, activate: async () => {}, deactivate: async () => {},
    leaseFactory: async () => lease, resumeStore });
  await auth.begin(); await auth.poll(); await auth.confirm();
  assert.deepEqual(writes, ["sealed-at-sign-in"]);
  await auth.renew();
  assert.deepEqual(replaced, [next.token]);
  assert.deepEqual(writes, ["sealed-at-sign-in", "sealed-after-rotation"], "the credential the renewal returned is the one kept");
  // A renewal that hands back no credential leaves the stored one alone.
  const bare = { ...next, token: "c".repeat(43), expiresAt: next.expiresAt + 600_000, renewal: { renewAfter: next.expiresAt + 480_000, notAfter: renewal.notAfter } };
  delete bare.resume;
  f.client.renew = async () => bare;
  await auth.renew();
  assert.deepEqual(writes, ["sealed-at-sign-in", "sealed-after-rotation"], "nothing written and nothing cleared");
  await auth.close();
});

// An account is a person, in a tenant, of one Feishu application. The control
// plane's address used to be part of its name, and a deployment that moved to a
// new address lost sight of every account's data.
test("account namespaces distinguish app/tenant/user, not the control plane's address, and survive new device login and display-name changes", () => {
  const original = session(), key = accountNamespace(original);
  for (const field of ["appId", "tenantId", "userId"]) assert.notEqual(accountNamespace({ ...original, identity: { ...original.identity, [field]: "different" } }), key);
  assert.equal(accountNamespace({ ...original, serverUrl: "https://another.example" }), key, "moving the deployment keeps the account");
  assert.equal(accountNamespace({ ...original, serverUrl: "http://127.0.0.1:3041" }), key);
  assert.equal(accountNamespace({ ...original, identity: { ...original.identity, displayName: "新名字", deviceId: "new-device" } }), key);
  assert.throws(() => accountNamespace({ ...original, identity: { ...original.identity, tenantId: "../tenant" } }));
  // The earlier name, kept only to find old data: it did carry the address.
  assert.notEqual(legacyAccountNamespace(original), key);
  assert.notEqual(legacyAccountNamespace({ ...original, serverUrl: "https://another.example" }), legacyAccountNamespace(original));
  assert.equal(legacyAccountNamespace({ ...original, identity: { ...original.identity, deviceId: "new-device" } }), legacyAccountNamespace(original));
});

// A machine that last signed in before the names changed resumes with the old
// name in its pointer. That is the same account: it is activated under its new
// name, told where its data was, and the credential moves with it.
test("a resume under the name an account had before activates it under its current name", async () => {
  const events = [];
  const legacy = legacyAccountNamespace(session()), current = accountNamespace(session());
  const resumeStore = { read: async (name) => (name === legacy ? "sealed-before" : null),
    write: async (name, _server, value) => { events.push(["write", name, value]); }, clear: async (name) => { events.push(["clear", name]); } };
  const f = setup({ resumeStore });
  f.client.resume = async () => ({ ...f.value, resume: "sealed-after" });
  const status = await f.auth.resume(legacy);
  assert.equal(status.connected, true);
  const activated = f.calls.find((value) => value.scope)?.scope;
  assert.equal(activated.namespace, current);
  assert.equal(activated.previous, legacy, "the data's old name goes to activation, where it is moved");
  assert.deepEqual(events, [["write", current, "sealed-after"], ["clear", legacy]], "the new credential is kept under the new name first, then the old file goes");
  await f.auth.close();
  // A pointer naming someone else is still refused.
  const other = setup({ resumeStore: { read: async () => "sealed", write: async () => {}, clear: async () => {} } });
  other.client.resume = async () => ({ ...other.value, identity: { ...other.value.identity, userId: "ou_someone_else" } });
  assert.equal((await other.auth.resume(legacy)).connected, false);
  await other.auth.close();
});

test("identity confirmation rejects a server response substituting the signed device", async () => {
  const f = setup(); f.value.identity.deviceId = "original-device";
  await f.auth.begin(); await f.auth.poll();
  f.client.request = async () => ({ identity: { ...f.value.identity, deviceId: "another-device" }, expiresAt: f.value.expiresAt });
  await assert.rejects(f.auth.confirm(), /身份已变化/); assert.equal(f.leases.length, 0); assert.equal(f.auth.active, null); await f.auth.close();
});

test("cancel during pending redemption cannot expose or activate a late result", async () => {
  const f = setup(), gate = Promise.withResolvers();
  f.client.complete = () => gate.promise; await f.auth.begin(); const polling = f.auth.poll();
  await f.auth.cancel(); gate.resolve(f.value); await assert.rejects(polling, /已取消/);
  assert.equal(f.auth.status().stage, "idle"); assert.equal(f.auth.status().pendingIdentity, null); assert.equal(f.leases.length, 0);
  assert.ok(f.calls.some((value) => value.route === "/auth/logout")); await f.auth.close();
});

test("revoked or changed identity and activation failures cannot install new connection or delete an existing one", async () => {
  const f = setup(); await f.auth.begin(); await f.auth.poll(); await f.auth.confirm();
  const active = f.auth.active;
  await f.auth.begin(); await f.auth.poll();
  f.client.request = async () => { throw new LoginRestartRequired("revoked"); };
  await assert.rejects(f.auth.confirm(), /revoked/); assert.equal(f.auth.active, active); assert.equal(f.leases.length, 1);
  assert.equal(f.auth.status().stage, "idle"); await f.auth.begin(); await f.auth.poll();
  f.client.request = async () => ({ identity: { ...f.value.identity, userId: "ou_other" }, expiresAt: f.value.expiresAt });
  await assert.rejects(f.auth.confirm(), /身份已变化/); assert.equal(f.auth.active, active);
  assert.equal(f.auth.status().stage, "idle"); assert.equal(f.auth.status().pendingIdentity, null);
  await f.auth.begin(); await f.auth.poll();
  f.client.request = async () => ({ identity: f.value.identity, expiresAt: f.value.expiresAt });
  f.auth.activate = async () => { throw new Error("active task"); };
  await assert.rejects(f.auth.confirm(), /active task/); assert.equal(f.leases[1].closed, 1); assert.equal(active.lease.closed, 0);
  await f.auth.close(); assert.equal(active.lease.closed, 1);
});

test("browser failure cancels server flow; cancelled confirmation revokes; failed remote logout is reported", async () => {
  const f = setup({ openBrowser: async () => { throw new Error("browser unavailable"); } });
  await assert.rejects(f.auth.begin(), /browser unavailable/); assert.equal(f.auth.status().stage, "idle"); assert.ok(f.calls.includes("cancel"));
  f.auth.openBrowser = async () => {}; await f.auth.begin(); await f.auth.poll(); await f.auth.cancel();
  assert.equal(f.auth.status().pendingIdentity, null); assert.ok(f.calls.some((value) => value.route === "/auth/logout"));
  await f.auth.begin(); await f.auth.poll(); await f.auth.confirm();
  f.client.request = async () => { throw new Error("offline"); };
  assert.equal((await f.auth.logout()).revoked, false); assert.equal(f.auth.active, null); assert.equal(f.leases[0].closed, 1); await f.auth.close();
});

test("session lease is consumed by the existing runtime reader, private on disk and removed idempotently", async () => {
  const value = session(), lease = await createSessionLease(value);
  try {
    // Off the coding agent's writable sandbox root (the OS temp base), so it
    // cannot replace or delete the lease token.
    assert.ok(!lease.filename.startsWith(os.tmpdir()), "lease must not live under the temp base");
    // ~/.idou/run, or ~/.mydoubao/run on a machine set up before the rename.
    assert.ok(lease.filename.startsWith(path.join(dataHome(), "run") + path.sep), "lease lives under the private run directory");
    assert.deepEqual(await readClientSession(lease.filename, value.serverUrl), { token: value.token, serverUrl: value.serverUrl, expiresAt: value.expiresAt });
    if (process.platform !== "win32") assert.equal((await stat(lease.filename)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(lease.filename, "utf8"), /identity|secret|appId/);
  } finally { await lease.close(); await lease.close(); }
  await assert.rejects(readFile(lease.filename), { code: "ENOENT" });
});

test("the lease carries the mint-incapable turn token, never the root", async () => {
  const value = { ...session(), turnToken: "t".repeat(43) }, lease = await createSessionLease(value);
  try {
    const read = await readClientSession(lease.filename, value.serverUrl);
    assert.equal(read.token, value.turnToken, "the agent-readable lease gets the turn token");
    assert.notEqual(read.token, value.token, "and never the root token");
  } finally { await lease.close(); }
});

test("operatorSession returns the in-memory root token, not the lease's turn token, and nothing after logout", async () => {
  const f = setup(); f.value.turnToken = "t".repeat(43);
  await f.auth.begin(); await f.auth.poll(); await f.auth.confirm();
  const op = f.auth.operatorSession();
  assert.equal(op.token, f.value.token, "the root, kept in memory for the services that mint");
  assert.notEqual(op.token, f.value.turnToken);
  await f.auth.logout();
  assert.equal(f.auth.operatorSession(), null);
  await f.auth.close();
});

test("local cleanup failure does not skip server revocation or resurrect the logged-out connection", async () => {
  const f = setup(); await f.auth.begin(); await f.auth.poll(); await f.auth.confirm();
  f.leases[0].close = async () => { throw new Error("disk unavailable"); };
  const status = await f.auth.logout();
  assert.equal(status.revoked, true); assert.equal(status.localCredentialRemoved, false); assert.equal(status.identity, null);
  assert.ok(f.calls.some((value) => value.route === "/auth/logout")); await f.auth.close();
});

test("expired or revoked pending confirmation returns to login without retiring the current account", async t => {
  for (const reason of ["expired", "revoked"]) {
    let now = Date.now(); const f = setup({ now: () => now }); t.after(() => f.auth.close());
    await f.auth.begin(); await f.auth.poll(); await f.auth.confirm(); const active = f.auth.active;
    const pending = { ...f.value, token: "b".repeat(43), expiresAt: now + 1000 };
    f.client.complete = async () => pending;
    await f.auth.begin(); await f.auth.poll();
    if (reason === "expired") now += 1001;
    else {
      const request = f.client.request;
      f.client.request = async (...args) => { if (args[1] === "/auth/session") throw new LoginRestartRequired("revoked"); return request(...args); };
    }
    await assert.rejects(f.auth.confirm());
    assert.equal(f.auth.active, active); assert.equal(f.auth.status().connected, true);
    assert.equal(f.auth.status().stage, "idle"); assert.equal(f.auth.status().pendingIdentity, null);
    assert.equal(f.leases.length, 1); assert.equal(active.lease.closed, 0);
    assert.ok(f.calls.some(call => call.route === "/auth/logout" && call.token === pending.token));
    await f.auth.begin(); assert.equal(f.auth.status().stage, "waiting");
  }
});

test("expiry during identity verification or lease creation never activates the expired candidate", async t => {
  for (const phase of ["identity", "lease"]) {
    let now = Date.now(); const f = setup({ now: () => now }); t.after(() => f.auth.close());
    await f.auth.begin(); await f.auth.poll();
    if (phase === "identity") {
      const request = f.client.request;
      f.client.request = async (...args) => { const result = await request(...args); if (args[1] === "/auth/session") now = f.value.expiresAt; return result; };
    } else {
      const factory = f.auth.leaseFactory;
      f.auth.leaseFactory = async (...args) => { const result = await factory(...args); now = f.value.expiresAt; return result; };
    }
    await assert.rejects(f.auth.confirm(), /已过期/);
    assert.equal(f.auth.status().stage, "idle"); assert.equal(f.auth.active, null);
    assert.equal(f.calls.some(call => call.scope), false);
    assert.ok(f.leases.every(lease => lease.closed === 1));
    assert.ok(f.calls.some(call => call.route === "/auth/logout"));
  }
});

test("cancellation holds single-flight until the old poll releases, then fresh login works", async t => {
  const f = setup(), gate = Promise.withResolvers(); t.after(() => f.auth.close());
  await f.auth.begin(); f.client.complete = () => gate.promise;
  const polling = f.auth.poll(); await f.auth.cancel();
  // begin is blocked until the old poll releases its single-flight reservation.
  await assert.rejects(f.auth.begin(), /当前登录/);
  gate.reject(new LoginRestartRequired("old flow expired")); await assert.rejects(polling);
  f.client.complete = async () => f.value;
  await f.auth.begin(); await f.auth.poll(); assert.equal(f.auth.status().stage, "confirm");
});

// The authorization link is the only way in when the system browser does not
// open, and it must never be offered outside the flow it belongs to.
test("the authorization link is offered only while a login is waiting", async () => {
  const f = setup();
  assert.equal(f.auth.status().launchUrl, null);
  await f.auth.begin();
  const waiting = f.auth.status();
  assert.equal(waiting.stage, "waiting");
  assert.equal(waiting.launchUrl, "https://enterprise.example/auth/feishu/launch?flow=fixture");
  assert.equal(f.calls.find(value => value.browser)?.browser, waiting.launchUrl);
  assert.equal((await f.auth.poll()).launchUrl, null);      // confirming an identity is not a way back in
  const confirmed = await f.auth.confirm();
  assert.equal(confirmed.launchUrl, null);
  await f.auth.logout(); assert.equal(f.auth.status().launchUrl, null);
  await f.auth.close();
});

test("a cancelled or failed login stops offering its authorization link", async () => {
  const cancelled = setup();
  await cancelled.auth.begin(); assert.ok(cancelled.auth.status().launchUrl);
  await cancelled.auth.cancel(); assert.equal(cancelled.auth.status().launchUrl, null);
  await cancelled.auth.close();

  const failed = setup({ openBrowser: async () => { throw new Error("browser unavailable"); } });
  await assert.rejects(failed.auth.begin());
  assert.equal(failed.auth.status().stage, "idle");
  assert.equal(failed.auth.status().launchUrl, null);
  await failed.auth.close();
});

// Found live: the application was closed seconds after it opened, while it was
// still resuming. The server had already spent the stored credential and sealed
// a new one into its answer; the desktop dropped that answer and cleared the
// store, so the next start had nothing -- and a start before the clear would
// have presented a spent token that Feishu refuses.
test("closing while a resume is on its way keeps the credential the server just sealed", async () => {
  const kept = [];
  const namespace = accountNamespace(session());
  const resumeStore = { read: async () => "sealed-before", write: async (_namespace, _server, value) => { kept.push(value); }, clear: async () => { kept.push("cleared"); } };
  let answer;
  const f = setup({ resumeStore });
  f.client.resume = () => new Promise((resolve) => { answer = resolve; });
  const resuming = f.auth.resume(namespace);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = f.auth.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(kept, [], "nothing is decided before the answer arrives");
  answer({ ...f.value, resume: "sealed-after" });
  await resuming; await closing;
  assert.deepEqual(kept, ["sealed-after"], "the new credential is kept, not cleared");
  assert.ok(f.calls.some((value) => value.route === "/auth/logout"), "and the session nobody will use is revoked");
  assert.equal(f.auth.status().connected, false);
});

test("a refusal from the server still discards the stored credential", async () => {
  const kept = [];
  const resumeStore = { read: async () => "sealed-before", write: async () => { kept.push("written"); }, clear: async () => { kept.push("cleared"); } };
  const f = setup({ resumeStore });
  f.client.resume = async () => { throw new LoginRestartRequired("续用已被拒绝"); };
  const status = await f.auth.resume(accountNamespace(session()));
  assert.deepEqual(kept, ["cleared"]);
  assert.match(status.resumeFailure, /续用已被拒绝/);
  await f.auth.close();
});

// Found live (2026-09-22): the control plane now runs on a server, its sessions
// live only in its memory, and a deploy restarted it. Every desktop kept a token
// the server no longer knew; the 定时任务 page showed session_expired_or_invalid,
// the renewal then failed, and only restarting the application -- which signs
// in with the stored credential -- brought the account back. The same happens to
// a machine that sleeps past its session. Now the account signs back in with
// that credential in place, as a renewal would.
const unknownSession = () => Object.assign(new LoginRestartRequired("飞书授权已失效或未获准（HTTP 401：session_expired_or_invalid），请重新发起登录。"),
  { status: 401, code: "session_expired_or_invalid" });
async function signedIn({ expiresIn = 600_000, renewing = true, stored = true, renew = null } = {}) {
  const store = { value: null, writes: [], cleared: 0 };
  const resumeStore = { read: async () => store.value, write: async (_namespace, _server, value) => { store.value = value; store.writes.push(value); },
    clear: async () => { store.value = null; store.cleared++; } };
  const f = setup();
  if (renew) f.client.renew = renew;
  // One reading of the clock: two could straddle a millisecond under load, and
  // renewAfter must be exactly expiresAt - 2 minutes (a full check failed so).
  const at = Date.now();
  const renewal = { renewAfter: at + expiresIn - 120000, notAfter: at + 3_600_000 };
  Object.assign(f.value, { expiresAt: at + expiresIn, ...(renewing ? { renewal } : {}), resume: stored ? "sealed-at-sign-in" : undefined });
  if (!stored) delete f.value.resume;
  f.client.request = async (_url, route, _body, token) => { f.calls.push({ route, token }); return { identity: f.value.identity, expiresAt: f.value.expiresAt, ...(renewing ? { renewal } : {}) }; };
  const replaced = [];
  const lease = { filename: "/synthetic/lease.json", closed: 0, async close() { this.closed++; }, async replace(value) { replaced.push(value.token); } };
  const auth = new DesktopAuth({ serverUrl: f.value.serverUrl, client: f.client, openBrowser: async () => {}, activate: async () => {}, deactivate: async () => {},
    leaseFactory: async () => lease, resumeStore });
  await auth.begin(); await auth.poll(); await auth.confirm();
  const successor = (mark, identity = {}, next = Date.now()) => ({ ...f.value, token: mark.repeat(43), expiresAt: next + 600_000, resume: `sealed-${mark}`,
    identity: { ...f.value.identity, ...identity }, renewal: { renewAfter: next + 480_000, notAfter: renewal.notAfter } });
  const revoked = () => f.calls.filter((call) => call.route === "/auth/logout").map((call) => call.token);
  return { ...f, auth, lease, replaced, store, successor, revoked };
}

test("a session the restarted server no longer knows is signed back in with the stored credential, in place", async () => {
  const f = await signedIn();
  const next = f.successor("r"), presented = [];
  f.client.renew = async () => { throw unknownSession(); };
  f.client.resume = async (_origin, credential) => { presented.push(credential); return next; };
  const status = await f.auth.renew();
  assert.deepEqual(presented, ["sealed-at-sign-in"], "the stored credential, once");
  assert.equal(status.connected, true);
  assert.equal(status.renewalState, "scheduled");
  assert.equal(f.auth.operatorSession().token, next.token, "every service's next request carries the new session");
  assert.deepEqual(f.replaced, [next.token], "and the coding agent's lease, the same file");
  assert.equal(f.lease.closed, 0, "nothing torn down");
  assert.equal(f.store.value, "sealed-r", "the credential the server sealed into the answer is the one kept");
  assert.deepEqual(f.revoked(), [], "and nothing revoked");
  await f.auth.close();
});

test("everyone refused at once shares one sign-in, and a request made with the old token just asks again", async () => {
  const f = await signedIn();
  const old = f.auth.operatorSession().token, next = f.successor("s");
  let resumes = 0;
  f.client.resume = async () => { resumes++; await new Promise((resolve) => setTimeout(resolve, 20)); return next; };
  assert.deepEqual(await Promise.all([f.auth.recover(old), f.auth.recover(old), f.auth.recover(old)]), [true, true, true]);
  assert.equal(resumes, 1, "a spent credential is presented once");
  assert.equal(await f.auth.recover(old), true, "already replaced: nothing to do but ask again");
  assert.equal(resumes, 1);
  await f.auth.close();
});

test("a session that ran out while the machine slept is signed back in; without a stored credential it ends as before", async () => {
  const f = await signedIn({ expiresIn: 400, renewing: false });
  const next = f.successor("w");
  f.client.resume = async () => next;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(f.auth.operatorSession()?.token, next.token);
  assert.equal(f.auth.status().connected, true);
  assert.equal(f.lease.closed, 0);
  await f.auth.close();

  const g = await signedIn({ expiresIn: 400, renewing: false, stored: false });
  let asked = false; g.client.resume = async () => { asked = true; };
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(asked, false);
  assert.equal(g.auth.status().renewalState, "expired");
  assert.equal(g.auth.status().connected, false);
  assert.equal(g.lease.closed, 1, "the lease goes with the session, as it always did");
  await g.auth.close();
});

test("a refusal of the stored credential discards it and ends the session as before", async () => {
  const f = await signedIn();
  const old = f.auth.operatorSession().token;
  f.client.renew = async () => { throw unknownSession(); };
  f.client.resume = async () => { throw new LoginRestartRequired("刷新令牌已被使用"); };
  await assert.rejects(f.auth.renew());
  const status = f.auth.status();
  assert.equal(status.connected, false);
  assert.equal(status.renewalState, "failed");
  assert.match(status.renewalFailure, /拒绝.*刷新令牌已被使用/);
  assert.equal(f.store.value, null, "a refused credential is not presented again");
  assert.equal(f.lease.closed, 1);
  assert.equal(await f.auth.recover(old), false, "and nothing is tried after the session ended");
  await f.auth.close();
});

test("a server not reachable yet keeps the credential and the lease, says so, and signs in on the next try", async () => {
  const f = await signedIn();
  const old = f.auth.operatorSession().token, next = f.successor("t");
  f.client.renew = async () => { throw unknownSession(); };
  f.client.resume = async () => { throw new TypeError("fetch failed"); };
  const status = await f.auth.renew();
  assert.equal(status.renewalState, "reconnecting");
  assert.equal(status.connected, false, "not shown as connected while the server does not know the session");
  assert.match(status.renewalFailure, /fetch failed/);
  assert.equal(f.store.value, "sealed-at-sign-in", "nothing was refused, so nothing is discarded");
  assert.equal(f.lease.closed, 0);
  f.client.resume = async () => next;
  assert.equal(await f.auth.recover(old), true, "a refused request tries again at once rather than waiting");
  assert.equal(f.auth.operatorSession().token, next.token);
  assert.equal(f.auth.status().renewalState, "scheduled");
  await f.auth.close();
});

test("signing out while waiting to reconnect stops trying", async () => {
  const f = await signedIn();
  const old = f.auth.operatorSession().token;
  f.client.renew = async () => { throw unknownSession(); };
  let resumes = 0; f.client.resume = async () => { resumes++; throw new TypeError("fetch failed"); };
  await f.auth.renew();
  await f.auth.logout();
  assert.equal(await f.auth.recover(old), false);
  assert.equal(resumes, 1);
  assert.equal(f.auth.status().renewalState, "disabled");
  await f.auth.close();
});

test("a sign-in that comes back under a changed policy is not swapped in under the running account", async () => {
  const f = await signedIn();
  const next = f.successor("p", { cliDriveWrites: true });
  f.client.renew = async () => { throw unknownSession(); };
  f.client.resume = async () => next;
  await assert.rejects(f.auth.renew());
  const status = f.auth.status();
  assert.equal(status.renewalState, "failed");
  assert.match(status.renewalFailure, /策略有变化.*⌘Q/);
  assert.deepEqual(f.replaced, [], "the running account keeps what it was built on");
  assert.ok(f.revoked().includes(next.token), "the session it would have used is revoked");
  assert.equal(f.store.value, "sealed-p", "and the credential kept, so a restart signs in under the new policy");
  await f.auth.close();
});

// After a sleep both timers are overdue at once: the renewal starts, and the
// session runs out while it is still on its way. The sign-in the expiry starts
// can finish first; the renewal failing afterwards must not undo it.
test("a renewal still on its way when a sign-in replaced the session leaves the new session alone", async () => {
  let refuse; const renewing = new Promise((_resolve, reject) => { refuse = reject; });
  const f = await signedIn({ expiresIn: 400, renew: () => renewing });
  const next = f.successor("x");
  f.client.resume = async () => next;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(f.auth.operatorSession()?.token, next.token, "the expiry signed back in while the renewal waited");
  refuse(unknownSession());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.auth.status().connected, true);
  assert.equal(f.auth.operatorSession()?.token, next.token);
  assert.equal(f.lease.closed, 0, "the lease stays");
  assert.deepEqual(f.revoked(), [], "and the new session is not revoked");
  await f.auth.close();
});

test("signing out while a sign-in with the stored credential is on its way leaves no way back in", async () => {
  const f = await signedIn();
  const old = f.auth.operatorSession().token, next = f.successor("l");
  let answer; f.client.resume = () => new Promise((resolve) => { answer = resolve; });
  const recovering = f.auth.recover(old);
  await new Promise((resolve) => setImmediate(resolve));
  const leaving = f.auth.logout();
  await new Promise((resolve) => setImmediate(resolve));
  answer(next);
  await leaving;
  assert.equal(await recovering, false);
  assert.equal(f.store.value, null, "the credential the answer brought is not written back after the sign-out cleared it");
  assert.ok(f.revoked().includes(next.token), "and the session nobody will use is revoked");
  assert.equal(f.auth.status().identity, null);
  await f.auth.close();
});

test("closing while a sign-in with the stored credential is on its way keeps the credential it brings back", async () => {
  const f = await signedIn();
  const old = f.auth.operatorSession().token, next = f.successor("c");
  let answer; f.client.resume = () => new Promise((resolve) => { answer = resolve; });
  const recovering = f.auth.recover(old);
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = f.auth.close().then(() => { closed = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(closed, false, "closing waits for the answer rather than leaving it to a process about to exit");
  answer(next);
  await closing;
  assert.equal(f.store.value, "sealed-c", "kept before closing returns: the stored one is spent, and the next start needs this one");
  await recovering;
});

test("a session that ended is not signed back into, however many requests are refused afterwards", async () => {
  const f = await signedIn({ expiresIn: 400, renewing: false });
  let resumes = 0;
  f.client.resume = async () => { resumes++; return f.successor("e", { cliDriveWrites: true }); };
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(resumes, 1);
  assert.equal(f.auth.status().renewalState, "failed");
  assert.equal(f.lease.closed, 1);
  const dead = f.auth.active.session.token;
  assert.equal(await f.auth.recover(dead), false);
  assert.equal(await f.auth.recover(dead), false);
  assert.equal(resumes, 1, "its lease is closed: another sign-in could not be put into it, and would only spend the credential again");
  await f.auth.close();
});

// Found on 2026-09-23: a server fault refused every session's renewal two hours
// in (403 feishu_source_access_denied), and the desktop stopped there until the
// application was restarted -- which signs in with the stored credential. A
// refusal now gets that sign-in at once; a renewal that got no answer does not.
test("a renewal that failed, refused or unanswered, is followed by a sign-in with the stored credential", async () => {
  const f = await signedIn();
  const next = f.successor("f"), refused = Object.assign(new LoginRestartRequired("飞书授权已失效或未获准（HTTP 403：feishu_source_access_denied），请重新发起登录。"),
    { status: 403, code: "feishu_source_access_denied" });
  let resumes = 0;
  f.client.renew = async () => { throw refused; };
  f.client.resume = async () => { resumes++; return next; };
  const status = await f.auth.renew();
  assert.equal(resumes, 1);
  assert.equal(status.connected, true);
  assert.equal(f.auth.operatorSession().token, next.token);
  assert.equal(f.lease.closed, 0);

  // Found live the same morning: a renewal that fell into the server's restart
  // got a 502, and the session ended for good. No answer is not an ending.
  const g = await signedIn();
  const after = g.successor("g");
  let answers = 0;
  g.client.renew = async () => { throw Object.assign(new Error("飞书登录请求暂未完成（HTTP 502），请稍后手动检查。"), { status: 502, code: null }); };
  g.client.resume = async () => { answers++; if (answers === 1) throw new TypeError("fetch failed"); return after; };
  const waiting = await g.auth.renew();
  assert.equal(waiting.renewalState, "reconnecting", "the server is still restarting: the session is kept and tried again");
  assert.equal(g.lease.closed, 0);
  assert.equal(await g.auth.recover(g.auth.operatorSession()?.token ?? g.auth.active.session.token), true, "and signs back in once it is up");
  assert.equal(g.auth.operatorSession().token, after.token);
  await f.auth.close(); await g.auth.close();
});

// 2026-09-23: renewal came due while the manager was busy with a sign-in step;
// it was marked paused and nothing ever asked again. The session ran out, the
// account signed back in with its stored credential, and a work task sent in
// the gap failed with "Development session expired".
test("a renewal that comes due while busy is tried again, before the session runs out", async () => {
  const f = setup();
  const at = Date.now(), renewal = { renewAfter: at + 400, notAfter: at + 3_600_000 };
  Object.assign(f.value, { expiresAt: at + 120_400, renewal });
  f.client.request = async (_url, route, _body, token) => { f.calls.push({ route, token }); return { identity: f.value.identity, expiresAt: f.value.expiresAt, renewal }; };
  const renewed = [];
  f.client.renew = async () => { const next = Date.now(); renewed.push(next); return { ...f.value, token: "r".repeat(43), expiresAt: next + 600_000, renewal: { renewAfter: next + 480_000, notAfter: renewal.notAfter } }; };
  const lease = { filename: "/synthetic/lease.json", closed: 0, async close() { this.closed++; }, async replace() {} };
  const auth = new DesktopAuth({ serverUrl: f.value.serverUrl, client: f.client, openBrowser: async () => {}, activate: async () => {}, deactivate: async () => {},
    leaseFactory: async () => lease, renewalRetryMs: 50 });
  await auth.begin(); await auth.poll(); await auth.confirm();
  auth.busy = true;                                             // a sign-in step is under way when renewal comes due
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(auth.status().renewalState, "paused");
  assert.deepEqual(renewed, [], "not while busy");
  auth.busy = false;                                            // the step finishes
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(renewed.length, 1, "tried again once the manager is free, long before the session would have run out");
  assert.equal(auth.status().renewalState, "scheduled");
  assert.equal(auth.operatorSession().token, "r".repeat(43));
  await auth.close();
});
