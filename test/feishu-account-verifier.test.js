import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { personOf } from "../src/control-plane/limits.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { loadFeishuLoginConfig } from "../src/control-plane/server-config.js";
import { FeishuLoginClient } from "../src/application/feishu-login-client.js";
import { FeishuAccountVerifier } from "../src/application/feishu-account-verifier.js";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { FeishuRuntimeRefused } from "../src/providers/feishu/bundled-runtime.js";
import { ACCOUNT_IDENTITY_SCOPE, accountCandidate, accountCandidateHash } from "../src/providers/feishu/account-identity.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { SaasWikiSourceReader } from "../src/providers/feishu/wiki-source-reader.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

const reference = "https://test.feishu.cn/docx/SyntheticDoc123";
const candidate = { tenantKey: "tenant", tenantUserId: "员工-123" };
const envelope = data => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data }) });
async function fixture(t, enabled = true) {
  const state = { serverUser: "ou_app_user", cliUser: "ou_cli_user", serverTenantUser: candidate.tenantUserId, cliTenantUser: candidate.tenantUserId,
    tenant: "tenant", cliTenant: "tenant", calls: [], cliCalls: [], denied: false, offset: 0 };
  const sessions = new SessionRegistry({ now: () => Date.now() + state.offset });
  let authority, login;
  const upstream = async (url, options) => {
    state.calls.push(url);
    if (url.endsWith("/open-apis/authen/v2/oauth/token")) return Response.json({ code: 0, token_type: "Bearer", access_token: "SECRET-server-user", expires_in: 3600, scope: state.scopes ?? authority.requiredScopes.join(" ") });
    assert.ok(url.endsWith("/user_info")); assert.equal(options.headers.authorization, "Bearer SECRET-server-user");
    await state.onUser?.(options);
    return Response.json({ code: 0, data: { open_id: state.serverUser, tenant_key: state.tenant, user_id: state.serverTenantUser, email: "PRIVATE" } });
  };
  authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_app", fetchImpl: upstream, identityChecksEnabled: enabled, now: () => Date.now() + state.offset });
  const oauth = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_app", appSecret: "SECRET-app", fetchImpl: upstream, sourceAccess: authority });
  const server = createServer(async (req, res) => { if (!await login.handle(req, res) && !await authority.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  login = new FeishuLoginService({ origin, sessions, provider: oauth, allowedTenants: ["tenant"] });
  t.after(() => { login.close(); server.closeAllConnections(); server.close(); });
  const authenticate = async () => {
    const client = new FeishuLoginClient(), begun = await client.begin(origin), launch = await fetch(begun.launchUrl, { redirect: "manual" });
    const url = new URL(launch.headers.get("location")); assert.equal(url.searchParams.get("scope"), authority.requiredScopes.join(" "));
    const callback = await fetch(`${origin}/auth/feishu/callback?state=${url.searchParams.get("state")}&code=SyntheticCode`, { headers: { cookie: launch.headers.get("set-cookie").split(";")[0] } });
    return { callback, client };
  };
  const flow = await authenticate(); assert.equal(flow.callback.status, 200); const session = await flow.client.complete();
  state.session = session;
  const verifier = new FeishuAccountVerifier({ getSession: async () => state.session });
  const runner = async (_binary, args, options) => {
    state.cliCalls.push(args); await state.onCli?.(args, options);
    if (args[0] === "api") {
      assert.deepEqual(args.slice(0, 7), ["api", "GET", "/open-apis/authen/v1/user_info", "--as", "user", "--format", "json"]);
      return state.cliResponse ?? envelope({ open_id: state.cliUser, tenant_key: state.cliTenant, user_id: state.cliTenantUser, email: "PRIVATE-cli" });
    }
    assert.equal(args[0], "docs");
    if (state.denied) return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: { type: "authorization", message: "SECRET-denied" } }) };
    return envelope({ document: { document_id: "SyntheticDoc123", revision_id: 1, content: "<title>企业项目</title><p>项目验收原文。</p>" } });
  };
  const provider = new SaasFeishuCliProvider({ profile: "synthetic", binary: STUB_CLI }, runner, { accountVerifier: verifier });
  const post = (body = candidate, token = session.token, headers = {}) => fetch(`${origin}/v1/feishu/account-match`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { state, sessions, authority, login, origin, authenticate, session, verifier, provider, post };
}

test("desktop pacing serializes fresh identity checks without a cache or increased server rate", async t => {
  const f = await fixture(t), timestamps = [], waits = []; let clock = Date.now();
  const verifier = new FeishuAccountVerifier({ getSession: async () => f.state.session, requestIntervalMs: 600, now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; } });
  const read = async () => { timestamps.push(clock); return { tenantKey: "tenant", tenantUserId: candidate.tenantUserId, openId: "ou_cli_user" }; };
  const before = f.state.calls.length;
  await Promise.all([verifier.verify(read), verifier.verify(read), verifier.verify(read)]);
  assert.deepEqual(timestamps.map(value => value - timestamps[0]), [0, 600, 1200]); assert.deepEqual(waits, [600, 600]);
  assert.equal(f.state.calls.length - before, 3);
  f.state.serverTenantUser = "changed"; await assert.rejects(verifier.verify(read), /未使用旧验证结果/);
});

test("queued identity cancellation never reads the CLI or sends an account request", async t => {
  const f = await fixture(t); let entered, release, reads = 0;
  const ready = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  f.state.onUser = async () => { entered(); await barrier; };
  const verifier = new FeishuAccountVerifier({ getSession: async () => f.state.session, requestIntervalMs: 600, wait: async () => {} });
  const read = async () => { reads++; return { tenantKey: "tenant", tenantUserId: candidate.tenantUserId, openId: "ou_cli_user" }; };
  const first = verifier.verify(read); await ready;
  const controller = new AbortController(), rejected = assert.rejects(verifier.verify(read, { signal: controller.signal }), error => /已取消/.test(error.message) && !error.message.includes("SECRET"));
  controller.abort(new Error("SECRET")); release(); await first; await rejected; assert.equal(reads, 1);
});

test("real OAuth/native/provider/Wiki path matches different app open_ids and rechecks sources without sharing credentials", async t => {
  const f = await fixture(t), directory = await mkdtemp(path.join(os.tmpdir(), "idou-account-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider: f.provider, cipher: fixtureCipher(Buffer.alloc(32, 11)) });
  t.after(() => wiki.close());
  assert.equal(f.session.identity.cliIdentityChecks, true);
  const doc = await f.provider.readDocument(reference); await wiki.observe(doc);
  const found = await wiki.search("项目"); assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].sourceUrl, reference);
  assert.ok(f.state.cliCalls.filter(args => args[0] === "api").length >= 6);
  assert.ok(f.state.calls.filter(url => url.endsWith("/user_info")).length >= 6);
  const checked = await f.post(); assert.equal(checked.status, 200); assert.equal(checked.headers.get("cache-control"), "no-store");
  assert.equal((await checked.json()).candidateHash, accountCandidateHash(candidate));
  const bytes = await readFile(wiki.filename); assert.equal(bytes.includes(Buffer.from("项目验收原文")), false);
  assert.doesNotMatch(JSON.stringify([doc, found, f.session, [...f.sessions.sessions.values()], f.state.cliCalls]), /SECRET|PRIVATE|员工-123/);
  f.state.cliTenantUser = "other";
  await assert.rejects(wiki.search("项目"), /匹配/);
});

test("tenant/user mismatch, absent user ID, bot and legacy/raw envelopes never reach a document read", async t => {
  for (const kind of ["tenant", "user", "missing", "bot", "raw", "error"]) {
    const f = await fixture(t);
    if (kind === "tenant") f.state.cliTenant = "foreign";
    if (kind === "user") f.state.cliTenantUser = "someone_else";
    if (kind === "missing") f.state.cliTenantUser = undefined;
    if (kind === "bot") f.state.cliResponse = { ...envelope({}), stdout: JSON.stringify({ ok: true, identity: "bot", data: {} }) };
    if (kind === "raw") f.state.cliResponse = { ...envelope({}), stdout: JSON.stringify({ code: 0, data: { user_id: candidate.tenantUserId } }) };
    if (kind === "error") f.state.cliResponse = { code: 1, stdout: "", stderr: "SECRET-keychain-error" };
    await assert.rejects(f.provider.readDocument(reference), error => /匹配/.test(error.message) && !/SECRET/.test(error.message));
    assert.equal(f.state.cliCalls.some(args => args[0] === "docs"), false);
  }
});

test("matching identity never grants source ACL; mutable user ID is freshly resolved and not a login key", async t => {
  const f = await fixture(t);
  const original = await f.provider.documentIdentity(); f.state.denied = true;
  await assert.rejects(f.provider.readDocument(reference), /没有这项权限/);
  f.state.denied = false; f.state.serverTenantUser = "replacement";
  await assert.rejects(f.provider.documentIdentity(), /匹配/);
  f.state.cliTenantUser = "replacement";
  assert.equal((await f.provider.documentIdentity()).principal, original.principal, "mutable tenant user ID must not split local account ownership");
  f.state.serverUser = "ou_other";
  await assert.rejects(f.provider.documentIdentity(), /匹配/);
});

test("opt-in and employee ID scope are required; old/development/child/foreign parent sessions do not qualify", async t => {
  const old = await fixture(t, false); await assert.rejects(old.provider.documentIdentity()); assert.equal(old.state.cliCalls.length, 0); assert.equal((await old.post()).status, 403);
  const f = await fixture(t);
  for (const token of [f.sessions.issueForWiki(f.session.token).token, f.sessions.issue({ tenantId: "tenant", userId: "user", deviceId: "d" }).token,
    f.sessions.issue({ tenantId: "tenant", userId: "ou_app_user", deviceId: f.session.identity.deviceId, authProvider: "feishu", appId: "cli_app", deviceProof: "ed25519-login", cliIdentityChecks: true }).token]) assert.equal((await f.post(candidate, token)).status, 403);
  f.state.scopes = f.authority.requiredScopes.filter(scope => scope !== ACCOUNT_IDENTITY_SCOPE).join(" ");
  const flow = await f.authenticate(); assert.equal(flow.callback.status, 403); await assert.rejects(flow.client.complete());
  assert.equal(f.session.identity.userId, "ou_app_user");
});

test("request shape forbids arbitrary URLs, imported tokens and body identities; responses contain no contact PII", async t => {
  const f = await fixture(t);
  for (const body of [{ ...candidate, token: "SECRET" }, { ...candidate, identity: {} }, { ...candidate, url: "https://evil.example" }, [], null, { ...candidate, tenantUserId: " " }]) assert.equal((await f.post(body)).status, 400);
  assert.equal((await f.post(candidate, f.session.token, { origin: "https://evil.example" })).status, 403);
  const value = await (await f.post()).json();
  assert.doesNotMatch(JSON.stringify(value), /SECRET|PRIVATE|tenantUserId|员工/);
  for (const value of ["部门.员工:123", "员工-123"]) assert.equal(accountCandidate({ ...candidate, tenantUserId: value }).tenantUserId, value);
  for (const value of ["a\n", "a\u0000", "x".repeat(65)]) assert.throws(() => accountCandidate({ ...candidate, tenantUserId: value }));
});

test("session change/cancellation during CLI reading prevents the server match request", async t => {
  for (const kind of ["switch", "cancel"]) {
    const f = await fixture(t), controller = new AbortController(), count = f.state.calls.length;
    f.state.onCli = () => { if (kind === "switch") f.state.session = { ...f.session, token: "x".repeat(43) }; else controller.abort(); };
    await assert.rejects(f.provider.documentIdentity({ signal: controller.signal }), /匹配/);
    assert.equal(f.state.calls.length, count);
  }
});

test("revocation, expiry, disabled policy and closure during user-info await cannot produce a positive match", async t => {
  for (const kind of ["revoke", "expire", "disable", "close"]) {
    const f = await fixture(t);
    f.state.onUser = () => { if (kind === "revoke") f.sessions.revoke(f.session.token); if (kind === "expire") f.state.offset = 1000000; if (kind === "disable") f.authority.identityChecksEnabled = false; if (kind === "close") f.authority.close(); };
    await assert.rejects(f.provider.documentIdentity(), /匹配/);
  }
});

test("account switch after an earlier check is denied again at the actual CLI dispatch boundary", async t => {
  const f = await fixture(t); await f.provider.documentIdentity(); f.state.cliTenantUser = "other";
  await assert.rejects(f.provider.invoke(["docs", "+update", "--as", "user"]), /匹配/);
  assert.equal(f.state.cliCalls.some(args => args.includes("+update")), false);
});

test("identity change while a document is being returned cannot deliver its contents", async t => {
  const f = await fixture(t);
  f.state.onCli = args => { if (args[0] === "docs") f.state.cliTenantUser = "other"; };
  await assert.rejects(f.provider.readDocument(reference), /匹配/);
  assert.equal(f.state.cliCalls.filter(args => args[0] === "docs").length, 1);
});

test("Wiki identity probes preserve cancellation, including HTTP checks already in flight", async t => {
  const f = await fixture(t), native = new SaasWikiSourceReader(f.provider, { origin: "https://test.feishu.cn" });
  const early = new AbortController(); early.abort();
  await assert.rejects(native.documentIdentity({ signal: early.signal }), /匹配/); assert.equal(f.state.cliCalls.length, 0);
  let entered, release, upstreamSignal;
  const arrived = new Promise(resolve => { entered = resolve; });
  f.state.onUser = options => { upstreamSignal = options.signal; entered(); return new Promise(resolve => { release = resolve; }); };
  const controller = new AbortController(), pending = native.documentIdentity({ signal: controller.signal });
  const rejected = assert.rejects(pending, /匹配/); await arrived;
  const aborted = upstreamSignal.aborted ? Promise.resolve() : once(upstreamSignal, "abort");
  controller.abort(); await rejected; await aborted; release();
  // A late, abort-ignoring upstream result is discarded rather than cached.
  f.state.onUser = null;
});

test("native response substitution, overflow and account switch after HTTP cannot return identity", async t => {
  for (const kind of ["candidate", "subject", "overflow", "switch", "extra"]) {
    const f = await fixture(t);
    f.verifier.transport.fetch = async (...args) => {
      const response = await fetch(...args), value = await response.json();
      if (kind === "candidate") value.candidateHash = "0".repeat(64);
      if (kind === "subject") value.identity.userId = "other";
      if (kind === "overflow") value.extra = "x".repeat(4096);
      if (kind === "switch") f.state.session = { ...f.session, token: "x".repeat(43) };
      if (kind === "extra") value.access_token = "SECRET";
      return Response.json(value);
    };
    if (kind === "extra") assert.doesNotMatch(JSON.stringify(await f.provider.documentIdentity()), /SECRET|access_token/);
    else await assert.rejects(f.provider.documentIdentity(), /匹配/);
  }
});

test("account probe is single-flight and rate bounded, and explicit configuration never enables it by default", async t => {
  const f = await fixture(t); let release, entered;
  const arrived = new Promise(resolve => { entered = resolve; });
  f.state.onUser = () => new Promise(resolve => { release = resolve; entered(); });
  const pending = f.post(); await arrived; assert.equal((await f.post()).status, 429); release(); assert.equal((await pending).status, 200);
  f.state.onUser = null; f.authority.rates.identity.hit(personOf(f.session.identity), 120); assert.equal((await f.post()).status, 429);
  const env = { IDOU_PUBLIC_URL: "https://control.example", FEISHU_APP_ID: "cli_synthetic", FEISHU_APP_SECRET: "SECRET", FEISHU_ALLOWED_TENANTS: "tenant" };
  assert.equal(loadFeishuLoginConfig(env).identityChecksEnabled, false);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_CLI_IDENTITY_CHECKS_ENABLED: "1" }));
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_SOURCE_ACCESS_ENABLED: "1", FEISHU_CLI_IDENTITY_CHECKS_ENABLED: "true" }));
  assert.equal(loadFeishuLoginConfig({ ...env, FEISHU_SOURCE_ACCESS_ENABLED: "1", FEISHU_CLI_IDENTITY_CHECKS_ENABLED: "1" }).identityChecksEnabled, true);
});

// 2026-09-24, in the desktop's own arrangement -- paced checks, and the docked
// chat reading its list through them: the application refused to run its
// Feishu CLI because src/ had changed since the release was signed, and this
// check and the chat reader after it turned that into "not matched" and "check
// the CLI login, message permissions and network". It is this process's own
// state, named as such before any CLI runs or the server is asked anything.
test("a CLI the application refuses to run is named, not reported as an identity mismatch", async t => {
  const f = await fixture(t), asked = f.state.calls.length, ran = [];
  const verifier = new FeishuAccountVerifier({ getSession: async () => f.state.session, requestIntervalMs: 600, wait: async () => {} });
  const provider = new SaasFeishuCliProvider({ profile: "synthetic", binary: path.join(os.tmpdir(), `idou-absent-cli-${process.pid}`, "lark-cli") },
    async (...args) => { ran.push(args); throw new Error("ran"); }, { accountVerifier: verifier });
  for (const attempt of [() => provider.documentIdentity(), () => provider.readDocument(reference), () => provider.chatReader.list()]) {
    await assert.rejects(attempt, error => error instanceof FeishuRuntimeRefused && !/匹配|读取失败/.test(error.message));
  }
  assert.deepEqual(ran, []); assert.equal(f.state.calls.length, asked, "the server was asked nothing");
});
