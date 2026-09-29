// The limits fixed in the code for the pilot were the whole server's: a
// hundred signed-in sessions, four Feishu reads at once, four renewals at once,
// thirty sign-ins a minute. Found 9-26 while scaling the server: the
// hundred-and-first person could not sign in (docs/scaling-plan.md). Each is
// now what one person gets, and the server's own limit is its capacity
// (limits.js, loadCapacity). These check both halves: many people are no
// longer turned away, and one person still cannot take everything.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { CountedMap, ExpiryQueue, Rates, Shares, personOf } from "../src/control-plane/limits.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { SessionRenewal } from "../src/control-plane/session-renewal.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { renewalProofMessage } from "../src/control-plane/login-proof.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const APP = "cli_scale_fixture";
const person = (userId, extra = {}) => ({ authProvider: "feishu", appId: APP, tenantId: "tenant_fixture", userId, displayName: userId, expiresAt: Date.now() + 600_000, ...extra });

test("the pieces: shares, rates, a counted map and an expiry queue", () => {
  const shares = new Shares({ max: 3, perPerson: 2 });
  assert.equal(shares.refusal("a"), null); shares.take("a"); shares.take("a");
  assert.equal(shares.refusal("a"), "person"); assert.equal(shares.refusal("b"), null); shares.take("b");
  assert.equal(shares.refusal("c"), "server");
  shares.give("a"); assert.equal(shares.refusal("c"), null); assert.equal(shares.total, 2); assert.equal(shares.people, 2);
  assert.throws(() => new Shares({ max: 1, perPerson: 2 }), /exceeds the whole/);

  let now = 0;
  const rates = new Rates({ windowMs: 1000, max: 5, perPerson: 2, now: () => now });
  rates.hit("a", 2); assert.equal(rates.refusal("a"), "person"); assert.equal(rates.refusal("b"), null);
  rates.hit("b", 2); rates.hit("c"); assert.equal(rates.refusal("d"), "server");
  assert.equal(rates.nextFor("a"), 1000);
  now = 1001; assert.equal(rates.refusal("a"), null, "the window moved on"); assert.equal(rates.refusal("d"), null);
  assert.equal(rates.sweep(), 0);

  const map = new CountedMap((value) => value.owner);
  map.set("x", { owner: "a" }); map.set("y", { owner: "a" }); map.set("z", { owner: "b" });
  map.set("y", { owner: "b" });
  assert.equal(map.held("a"), 1); assert.equal(map.held("b"), 2);
  map.delete("z"); map.delete("missing"); assert.equal(map.held("b"), 1);
  map.clear(); assert.equal(map.held("a"), 0); assert.equal(map.size, 0);

  const queue = new ExpiryQueue();
  for (const at of [50, 10, 40, 20, 30]) queue.add(at, `k${at}`, at);
  assert.equal(queue.due(5), null);
  const out = []; for (let entry; (entry = queue.due(35));) out.push(entry.value);
  assert.deepEqual(out, [10, 20, 30]); assert.equal(queue.size, 2);
});

test("a hundred and fifty people sign in: every one gets Feishu access and a renewal grant", () => {
  const sessions = new SessionRegistry();
  const access = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: APP });
  const renewal = new SessionRenewal({ sessions, checkIdentity: async () => ({}), transferSource: () => {} });
  const { publicKey } = generateKeyPairSync("ed25519");
  for (let index = 0; index < 150; index += 1) {
    const identity = person(`user-${index}`);
    access.remember(identity, `access-${index}`); renewal.remember(identity, `access-${index}`);
    const issued = sessions.issue({ ...identity, deviceId: `device-${index}`, deviceProof: "ed25519-login", ttlMs: 300_000 });
    access.bind(identity, issued); renewal.bind(identity, issued, publicKey);
  }
  assert.equal(access.signedIn, 150);
  assert.equal(renewal.signedIn, 150);
  access.close(); renewal.close();
});

test("one person still has a share: the seventeenth device at once is refused, and nobody else is", () => {
  const sessions = new SessionRegistry(), diagnostics = [];
  const access = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: APP });
  const renewal = new SessionRenewal({ sessions, checkIdentity: async () => ({}), transferSource: () => {}, diagnostic: (line) => diagnostics.push(line) });
  for (let index = 0; index < 16; index += 1) { const identity = person("busy"); access.remember(identity, "t"); renewal.remember(identity, "t"); }
  assert.throws(() => access.remember(person("busy"), "t"), /feishu_source_access_denied/);
  assert.throws(() => renewal.remember(person("busy"), "t"), /sign in again/);
  assert.match(diagnostics.at(-1), /这个账号同时登录的设备过多/);
  access.remember(person("other"), "t"); renewal.remember(person("other"), "t");
  access.close(); renewal.close();
});

test("the server's own capacity holds, and says which limit it was", () => {
  const sessions = new SessionRegistry(), diagnostics = [];
  const access = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: APP, capacity: { signedIn: 3 } });
  const renewal = new SessionRenewal({ sessions, checkIdentity: async () => ({}), transferSource: () => {}, diagnostic: (line) => diagnostics.push(line), capacity: { signedIn: 3 } });
  for (const userId of ["a", "b", "c"]) { access.remember(person(userId), "t"); renewal.remember(person(userId), "t"); }
  assert.throws(() => access.remember(person("d"), "t"), /feishu_source_access_denied/);
  assert.throws(() => renewal.remember(person("d"), "t"), /sign in again/);
  assert.match(diagnostics.at(-1), /服务器同时登录的会话已达上限/);
  access.close(); renewal.close();
});

test("six people read Feishu at once; a person's fifth read at once is refused", async () => {
  const sessions = new SessionRegistry(), gate = Promise.withResolvers();
  let entered = 0;
  // Feishu, answering each person as themselves once let go.
  const fetchImpl = async (url, options) => {
    entered += 1; await gate.promise;
    const userId = options.headers.authorization.slice("Bearer access-".length);
    const body = url.includes("user_info") ? { code: 0, data: { tenant_key: "tenant_fixture", open_id: userId } } : { code: 0, data: { auth_result: true } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const access = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: APP, fetchImpl });
  const signIn = (userId, device) => {
    const identity = person(userId);
    access.remember(identity, `access-${userId}`);
    const issued = sessions.issue({ ...identity, deviceId: device, deviceProof: "ed25519-login", ttlMs: 300_000 });
    access.bind(identity, issued);
    return issued.token;
  };
  const input = { sources: [{ resourceType: "docx", resourceId: "Doc123456789012345678" }] };
  const readers = Array.from({ length: 6 }, (_, index) => signIn(`reader-${index}`, `device-${index}`));
  const reads = readers.map((token) => access.check(token, input).catch((error) => error));
  for (const until = Date.now() + 2000; entered < 6 && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(entered, 6, "all six reads reached Feishu together (the pilot let four)");
  assert.equal(access.active, 6);
  const one = Array.from({ length: 5 }, (_, index) => signIn("one-person", `own-device-${index}`));
  const mine = one.slice(0, 4).map((token) => access.check(token, input).catch((error) => error));
  for (const until = Date.now() + 2000; entered < 10 && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(access.check(one[4], input), /feishu_source_access_busy/);
  gate.resolve();
  for (const result of await Promise.all([...reads, ...mine])) assert.equal(result?.authorized, true, String(result?.message ?? ""));
  assert.equal(access.active, 0);
  access.close();
});

test("ten people renew at once: none is turned away for the others", async () => {
  let now = 1_000_000;
  const sessions = new SessionRegistry({ now: () => now }), gate = Promise.withResolvers();
  let checking = 0;
  const renewal = new SessionRenewal({ sessions, now: () => now, transferSource: () => {},
    checkIdentity: async (token, signal) => { checking += 1; await gate.promise; signal.throwIfAborted(); return renewal.lastIdentity.get(token.toString("utf8")); } });
  renewal.lastIdentity = new Map();
  const origin = "https://control.example", pending = [];
  for (let index = 0; index < 10; index += 1) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const identity = { ...person(`renewer-${index}`), expiresAt: now + 3_600_000 };
    renewal.lastIdentity.set(`access-${index}`, identity);
    renewal.remember(identity, `access-${index}`);
    const issued = sessions.issue({ ...identity, deviceId: `device-${index}`, deviceProof: "ed25519-login", ttlMs: 60_000 });
    renewal.bind(identity, issued, publicKey);
    const challenge = renewal.begin(issued.token);
    const signature = sign(null, renewalProofMessage(origin, issued.id, challenge.challengeId, challenge.nonce), privateKey).toString("base64url");
    pending.push(renewal.renew(origin, issued.token, { challengeId: challenge.challengeId, signature }));
  }
  for (const until = Date.now() + 2000; checking < 10 && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(checking, 10, "all ten under way together (the pilot let four)");
  gate.resolve();
  const renewed = await Promise.all(pending);
  assert.equal(renewed.length, 10);
  assert.ok(renewed.every((issued) => sessions.verify(issued.token)));
  renewal.close();
});

test("a hundred sign-ins start in a minute; the configured rate still holds", () => {
  const provider = { sourceAccess: null, renewal: null };
  const keys = () => generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const login = new FeishuLoginService({ origin: "https://control.example", provider, sessions: new SessionRegistry(), allowedTenants: ["tenant_fixture"] });
  for (let index = 0; index < 100; index += 1) login.begin(keys(), 50_000);
  assert.equal(login.flows.size, 100, "the pilot turned the thirty-first away");
  login.close();
  const slow = new FeishuLoginService({ origin: "https://control.example", provider, sessions: new SessionRegistry(), allowedTenants: ["tenant_fixture"], capacity: { perMinute: 5 } });
  for (let index = 0; index < 5; index += 1) slow.begin(keys(), 50_000);
  assert.throws(() => slow.begin(keys(), 50_000), /login_limit_reached/);
  slow.close();
});

test("personOf names a person by tenant and user", () => {
  assert.equal(personOf({ tenantId: "t", userId: "u", appId: "ignored" }), "t\nu");
});
