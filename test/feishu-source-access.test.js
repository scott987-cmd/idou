import test from "node:test";
import { personOf } from "../src/control-plane/limits.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { FeishuLoginService } from "../src/control-plane/feishu-login.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { FeishuLoginClient } from "../src/application/feishu-login-client.js";
import { FeishuSourceAccessClient } from "../src/knowledge/source-access-client.js";
import { sourceAccessInput, SOURCE_ACCESS_SCOPE } from "../src/knowledge/source-access-contract.js";
import { loadFeishuLoginConfig } from "../src/control-plane/server-config.js";
import { ACCOUNT_IDENTITY_SCOPE } from "../src/providers/feishu/account-identity.js";
import { SCHEDULE_RESOURCE_SCOPE } from "../src/providers/feishu/login-scopes.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const input = (ids = ["SyntheticDoc123"]) => ({ sources: ids.map(resourceId => ({ resourceType: "docx", resourceId })) });
async function fixture(t, { scheduleResourcesEnabled = false } = {}) {
  const state = { calls: [], grantedScope: [SOURCE_ACCESS_SCOPE, ...(scheduleResourcesEnabled ? [SCHEDULE_RESOURCE_SCOPE] : [])].join(" "), userId: "ou_synthetic", tenant: "tenant", permission: true, offset: 0 };
  const sessions = new SessionRegistry({ now: () => Date.now() + state.offset });
  const upstream = async (url, options) => {
    state.calls.push({ url, ...options });
    if (url.endsWith("/open-apis/authen/v2/oauth/token")) return Response.json({ code: 0, token_type: "Bearer", access_token: "SECRET-user-token", refresh_token: "SECRET-refresh", expires_in: 3600, scope: state.grantedScope });
    if (url.endsWith("/user_info")) return Response.json({ code: 0, data: { tenant_key: state.tenant, open_id: state.userId } });
    const custom = await state.onRequest?.(url, options); if (custom) return custom;
    if (state.onPermission) await state.onPermission(options);
    if (state.response) return state.response();
    return Response.json({ code: 0, data: { auth_result: state.permission } });
  };
  const authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_synthetic", fetchImpl: upstream, now: () => Date.now() + state.offset, scheduleResourcesEnabled });
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_synthetic", appSecret: "SECRET-app", fetchImpl: upstream, sourceAccess: authority });
  let login;
  const server = createServer(async (req, res) => {
    if (!await login.handle(req, res) && !await authority.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  login = new FeishuLoginService({ origin, sessions, provider, allowedTenants: ["tenant"], now: () => Date.now() + state.offset });
  t.after(() => { login.close(); server.closeAllConnections(); server.close(); });
  const authorize = async () => {
    const client = new FeishuLoginClient(), begun = await client.begin(origin);
    const launched = await fetch(begun.launchUrl, { redirect: "manual" }), target = new URL(launched.headers.get("location"));
    assert.equal(target.searchParams.get("scope"), authority.requiredScopes.join(" "));
    const callback = await fetch(`${origin}/auth/feishu/callback?state=${target.searchParams.get("state")}&code=SyntheticCode`, { headers: { cookie: launched.headers.get("set-cookie").split(";")[0] } });
    return { client, callback, begun };
  };
  const authenticate = async () => { const auth = await authorize(); assert.equal(auth.callback.status, 200); return auth.client.complete(); };
  const post = (token, data = input(), patch = {}) => fetch(`${origin}/v1/feishu/source-access`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...patch }, body: JSON.stringify(data) });
  return { state, sessions, authority, provider, login, origin, authenticate, authorize, post };
}

test("schedule creation resolves a Wiki node to its exact docx token under the server-held user credential", async t => {
  const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
  f.state.onRequest = async url => url.includes("/wiki/v2/spaces/get_node?") ? Response.json({ code: 0, data: { node: {
    node_token: "WikiNode123", node_type: "shortcut", obj_type: "docx", obj_token: "ConcreteDoc123", title: "研发规范",
  } } }) : null;
  const resources = await f.authority.resolveScheduleResources(session.token, [
    { kind: "document", reference: "https://fixture.feishu.cn/wiki/WikiNode123", label: "搜索结果" },
    { kind: "chat", id: "oc_fixture" },
  ]);
  assert.deepEqual(resources, [
    { kind: "document", reference: "https://fixture.feishu.cn/docx/ConcreteDoc123", label: "研发规范" },
    { kind: "chat", id: "oc_fixture" },
  ]);
  const paths = f.state.calls.map(call => new URL(call.url).pathname + new URL(call.url).search);
  assert.ok(paths.includes("/open-apis/wiki/v2/spaces/get_node?token=WikiNode123"));
  assert.ok(paths.includes("/open-apis/drive/v1/permissions/ConcreteDoc123/members/auth?type=docx&action=view"));
  assert.doesNotMatch(JSON.stringify(resources), /SECRET|WikiNode123/);
});

test("schedule resource resolution fails closed for unsupported Wiki targets, denial and disabled policy", async t => {
  const disabled = await fixture(t), disabledSession = await disabled.authenticate();
  await assert.rejects(disabled.authority.resolveScheduleResources(disabledSession.token, []), /schedule_resource_resolution_unavailable/);

  // A node carrying something this product cannot read, a node answering for a
  // different token, a proven refusal, and a probe nobody was allowed to make.
  for (const kind of ["mindnote", "file", "mismatch", "denied", "unprobeable"]) {
    const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
    f.state.onRequest = async url => {
      if (url.includes("/wiki/v2/spaces/get_node?")) {
        return Response.json({ code: 0, data: { node: {
          node_token: kind === "mismatch" ? "OtherWiki123" : "WikiNode123",
          obj_type: ["mindnote", "file"].includes(kind) ? kind : "docx", obj_token: "ConcreteDoc123",
        } } });
      }
      // Feishu refusing to answer the question is not a proven "no": it has its
      // own outcome so the operator is sent to the scope rather than to sharing.
      // It comes back as HTTP 400, as measured live; a 200 here modelled a Feishu
      // that does not exist, and hid that production never reached this outcome.
      return kind === "unprobeable" ? Response.json({ code: 99991679, msg: "no permission to the probe" }, { status: 400 }) : null;
    };
    if (kind === "denied") f.state.permission = false;
    const expected = kind === "denied" ? "schedule_resource_access_denied"
      : kind === "unprobeable" ? "schedule_resource_probe_unavailable" : "schedule_wiki_resource_unsupported";
    await assert.rejects(f.authority.resolveScheduleResources(session.token, [
      { kind: "document", reference: "https://fixture.feishu.cn/wiki/WikiNode123" },
    ]), new RegExp(expected), kind);
  }
});

// What Feishu said decides which refusal a person sees, because each has a
// different fix. Every shape below is Feishu's own, measured against the live
// tenant: refusals come back as HTTP 400 with the usual JSON body, a node that is
// not there is 131005, a file that is not there is 1063001, and a missing scope
// is 99991672 or 99991679. Before this, all of them surfaced as one "请重新登录"
// -- including a mistyped link, which re-logging in does nothing for.
test("each Feishu refusal is told apart by what Feishu said, not collapsed into one", async t => {
  const refuse = (code) => Response.json({ code, msg: "refused" }, { status: 400 });
  const node = Response.json({ code: 0, data: { node: { node_token: "WikiNode123", obj_type: "sheet", obj_token: "Concrete1234" } } });
  for (const [label, onNode, onProbe, expected, probed] of [
    ["a node that is not there", () => refuse(131005), null, "schedule_resource_unreadable", false],
    ["a login without the Wiki scope", () => refuse(99991679), null, "schedule_resource_probe_unavailable", false],
    ["an application that never applied for it", () => refuse(99991672), null, "schedule_resource_probe_unavailable", false],
    ["a resource behind the node that is not there", () => node.clone(), () => refuse(1063001), "schedule_resource_unreadable", true],
    ["a probe the application may not make", () => node.clone(), () => refuse(99991672), "schedule_resource_probe_unavailable", true],
  ]) {
    const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
    f.state.onRequest = async url => url.includes("/wiki/v2/spaces/get_node?") ? onNode()
      : url.includes("/members/auth") && onProbe ? onProbe() : null;
    await assert.rejects(f.authority.resolveScheduleResources(session.token, [
      { kind: "sheet", reference: "https://fixture.feishu.cn/wiki/WikiNode123" },
    ]), error => error.status === 403 && error.message === expected, label);
    // A refused node is never probed: there is nothing yet to ask about.
    assert.equal(f.state.calls.some(call => call.url.includes("/members/auth")), probed, label);
  }

  // A pasted link goes straight to the probe, and a mistyped one is the same
  // "not there" -- not an administrator's problem.
  const direct = await fixture(t, { scheduleResourcesEnabled: true }), directSession = await direct.authenticate();
  direct.state.onRequest = async url => url.includes("/members/auth") ? refuse(1063001) : null;
  await assert.rejects(direct.authority.resolveScheduleResources(directSession.token, [
    { kind: "sheet", reference: "https://fixture.feishu.cn/sheets/ShtToken1234" },
  ]), error => error.status === 403 && error.message === "schedule_resource_unreadable");
});

// The body of a refusal is read only to choose which refusal to give. A 4xx that
// claims success -- a node, or `auth_result: true` -- is still a refusal: nothing
// that did not come back 2xx can put a resource into an authorization.
test("a refusal whose body claims success is still refused", async t => {
  const liar = (body) => Response.json(body, { status: 400 });
  for (const [label, onNode, onProbe] of [
    ["a node", () => liar({ code: 0, data: { node: { node_token: "WikiNode123", obj_type: "sheet", obj_token: "Concrete1234" } } }), null],
    ["a permission", () => Response.json({ code: 0, data: { node: { node_token: "WikiNode123", obj_type: "sheet", obj_token: "Concrete1234" } } }),
      () => liar({ code: 0, data: { auth_result: true } })],
  ]) {
    const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
    f.state.onRequest = async url => url.includes("/wiki/v2/spaces/get_node?") ? onNode()
      : url.includes("/members/auth") && onProbe ? onProbe() : null;
    await assert.rejects(f.authority.resolveScheduleResources(session.token, [
      { kind: "sheet", reference: "https://fixture.feishu.cn/wiki/WikiNode123" },
    ]), error => error.status === 403 && error.message === "schedule_resource_unreadable", label);
  }
});

// What is left for the catch-all is what no Feishu answer explains: Feishu down,
// or something in between that does not speak its protocol.
test("an answer that is not Feishu's is the upstream being unavailable", async t => {
  for (const [label, response] of [
    ["a server error", () => Response.json({ code: 0 }, { status: 502 })],
    ["a page that is not JSON", () => new Response("<html>gateway</html>", { status: 400, headers: { "content-type": "text/html" } })],
  ]) {
    const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
    f.state.onRequest = async url => url.includes("/wiki/v2/spaces/get_node?") ? response() : null;
    await assert.rejects(f.authority.resolveScheduleResources(session.token, [
      { kind: "sheet", reference: "https://fixture.feishu.cn/wiki/WikiNode123" },
    ]), error => error.status === 502 && error.message === "schedule_resource_resolution_unavailable", label);
  }
});

// A Wiki node may carry a spreadsheet or a Base. Which one it carries is the
// node's to say, not the person's and not the client's: whatever kind was
// picked in the dialog, what gets stored is the resource the node resolves to,
// proven readable with the probe that matches it.
test("a Wiki node that carries a spreadsheet or a Base is pinned to it, whatever the client called it", async t => {
  for (const [objType, claimed, expected, probe, path] of [
    ["sheet", "document", "sheet", "sheet", "sheets"],
    ["bitable", "sheet", "base", "bitable", "base"],
    ["docx", "base", "document", "docx", "docx"],
  ]) {
    const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
    f.state.onRequest = async url => url.includes("/wiki/v2/spaces/get_node?") ? Response.json({ code: 0, data: { node: {
      node_token: "WikiNode123", obj_type: objType, obj_token: "Concrete1234", title: "季度台账",
    } } }) : null;
    const resolved = await f.authority.resolveScheduleResources(session.token, [
      { kind: claimed, reference: "https://fixture.feishu.cn/wiki/WikiNode123", label: "客户端自己写的名字" },
    ]);
    assert.deepEqual(resolved, [{ kind: expected, reference: `https://fixture.feishu.cn/${path}/Concrete1234`, label: "季度台账" }], objType);
    const paths = f.state.calls.map(call => new URL(call.url).pathname + new URL(call.url).search);
    assert.ok(paths.includes(`/open-apis/drive/v1/permissions/Concrete1234/members/auth?type=${probe}&action=view`), probe);
    // The node token is navigation; nothing durable may carry it.
    assert.doesNotMatch(JSON.stringify(resolved), /WikiNode123/);
  }
});

// A node address names a whole workbook or Base. A link copied while looking at
// one worksheet or table names that too, and dropping it would hand the task
// everything beside it -- the same widening a pasted sheet link must not cause.
test("a Wiki link that names one worksheet or table is pinned to that one, not to everything beside it", async t => {
  for (const [objType, query, expected] of [
    ["sheet", "?sheet=abc123", "https://fixture.feishu.cn/sheets/Concrete1234?sheet=abc123"],
    ["bitable", "?table=tblAbc123", "https://fixture.feishu.cn/base/Concrete1234?table=tblAbc123"],
    // Feishu's own links carry more than the part that names the resource.
    ["bitable", "?table=tblAbc123&view=vewXyz", "https://fixture.feishu.cn/base/Concrete1234?table=tblAbc123"],
    ["sheet", "", "https://fixture.feishu.cn/sheets/Concrete1234"],
  ]) {
    const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
    f.state.onRequest = async url => url.includes("/wiki/v2/spaces/get_node?") ? Response.json({ code: 0, data: { node: {
      node_token: "WikiNode123", obj_type: objType, obj_token: "Concrete1234",
    } } }) : null;
    const resolved = await f.authority.resolveScheduleResources(session.token, [
      { kind: objType === "sheet" ? "sheet" : "base", reference: `https://fixture.feishu.cn/wiki/WikiNode123${query}` },
    ]);
    assert.equal(resolved[0].reference, expected, query || "(no sub-resource)");
  }
});

// The part of the link that names a worksheet or a table is the client's claim
// about something the node has not answered yet. It is used only to narrow, and
// only where the node agrees: a link claiming a worksheet of what turns out to
// be a Base does not name a resource this person can have meant.
test("a Wiki link whose named sub-resource contradicts what the node carries is refused", async t => {
  for (const [objType, query] of [["bitable", "?sheet=abc123"], ["sheet", "?table=tblAbc123"], ["docx", "?table=tblAbc123"]]) {
    const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
    f.state.onRequest = async url => url.includes("/wiki/v2/spaces/get_node?") ? Response.json({ code: 0, data: { node: {
      node_token: "WikiNode123", obj_type: objType, obj_token: "Concrete1234",
    } } }) : null;
    await assert.rejects(f.authority.resolveScheduleResources(session.token, [
      { kind: "base", reference: `https://fixture.feishu.cn/wiki/WikiNode123${query}` },
    ]), error => error.status === 400 && error.message === "schedule_wiki_resource_unsupported", `${objType}${query}`);
    // Nothing was proven, so nothing was probed.
    assert.ok(!f.state.calls.some(call => call.url.includes("/members/auth")));
  }
});

// The pin is taken once, at creation. A node that is re-pointed afterwards
// carries something else; the authorization keeps naming what was proven then,
// and a later resolution is a different authorization, not a silent upgrade.
test("a Wiki node that is re-pointed later does not change what was already pinned", async t => {
  const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
  let behind = "FirstDoc1234";
  f.state.onRequest = async url => url.includes("/wiki/v2/spaces/get_node?") ? Response.json({ code: 0, data: { node: {
    node_token: "WikiNode123", obj_type: "docx", obj_token: behind,
  } } }) : null;
  const paste = [{ kind: "document", reference: "https://fixture.feishu.cn/wiki/WikiNode123" }];
  const first = await f.authority.resolveScheduleResources(session.token, paste);
  behind = "SecondDoc123";
  const second = await f.authority.resolveScheduleResources(session.token, paste);
  assert.equal(first[0].reference, "https://fixture.feishu.cn/docx/FirstDoc1234");
  assert.equal(second[0].reference, "https://fixture.feishu.cn/docx/SecondDoc123");
});

// Whose Feishu answered is checked before anything is resolved: a credential
// that now speaks for another tenant resolves nothing at all.
test("resolution stops when the session's own Feishu identity no longer matches", async t => {
  const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
  f.state.tenant = "another-tenant";
  await assert.rejects(f.authority.resolveScheduleResources(session.token, [
    { kind: "document", reference: "https://fixture.feishu.cn/docx/ConcreteDoc123" },
  ]), /feishu_source_access_denied/);
  assert.equal(f.state.calls.some(call => call.url.includes("/permissions/")), false, "nothing was probed for a stranger");
});

// Spreadsheets and Bases pasted directly were stored without anyone proving the
// person could read them: only documents were checked. Each kind is now proven
// with its own probe before it becomes an authorization.
test("a spreadsheet or Base link is proven readable before it is stored", async t => {
  const f = await fixture(t, { scheduleResourcesEnabled: true }), session = await f.authenticate();
  const resolved = await f.authority.resolveScheduleResources(session.token, [
    { kind: "sheet", reference: "https://fixture.feishu.cn/sheets/ShtToken1234?sheet=abc123", label: "台账" },
    { kind: "base", reference: "https://fixture.feishu.cn/base/BasToken1234?table=tblSynthetic1" },
    { kind: "chat", id: "oc_fixture" },
  ]);
  assert.deepEqual(resolved, [
    // The worksheet the link named stays part of the grant.
    { kind: "sheet", reference: "https://fixture.feishu.cn/sheets/ShtToken1234?sheet=abc123", label: "台账" },
    { kind: "base", reference: "https://fixture.feishu.cn/base/BasToken1234?table=tblSynthetic1" },
    { kind: "chat", id: "oc_fixture" },
  ]);
  const paths = f.state.calls.map(call => new URL(call.url).pathname + new URL(call.url).search);
  assert.ok(paths.includes("/open-apis/drive/v1/permissions/ShtToken1234/members/auth?type=sheet&action=view"));
  assert.ok(paths.includes("/open-apis/drive/v1/permissions/BasToken1234/members/auth?type=bitable&action=view"));

  // One refusal is enough: nothing is stored for the rest of the list either.
  const denied = await fixture(t, { scheduleResourcesEnabled: true }), deniedSession = await denied.authenticate();
  denied.state.permission = false;
  await assert.rejects(denied.authority.resolveScheduleResources(deniedSession.token, [
    { kind: "sheet", reference: "https://fixture.feishu.cn/sheets/ShtToken1234" },
  ]), /schedule_resource_access_denied/);
});

test("explicit opt-in performs real OAuth/login/native permission HTTP flow without returning or persisting tokens", async t => {
  const f = await fixture(t), session = await f.authenticate();
  const client = new FeishuSourceAccessClient({ getSession: async () => session });
  const value = await client.check(input(["SecondDoc123", "SyntheticDoc123"]));
  assert.equal(value.authorized, true); assert.equal(value.pointInTime, true);
  assert.equal(value.sourceSetHash, sourceAccessInput(input(["SecondDoc123", "SyntheticDoc123"])).sourceSetHash);
  assert.equal(value.identity.userId, session.identity.userId); assert.equal(value.identity.deviceId, session.identity.deviceId);
  assert.doesNotMatch(JSON.stringify([session, value, [...f.sessions.sessions.values()], [...f.login.flows.values()]]), /SECRET|refresh|access_token/);
  assert.equal(JSON.parse(f.state.calls.find(call => call.url.endsWith("/open-apis/authen/v2/oauth/token")).body).scope, SOURCE_ACCESS_SCOPE);
  const calls = f.state.calls.filter(call => call.url.includes("/permissions/")); assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call.method, "GET"); assert.equal(call.redirect, "error"); assert.equal(call.headers.authorization, "Bearer SECRET-user-token"); assert.equal(new URL(call.url).search, "?type=docx&action=view"); }
  assert.equal(f.state.calls.some(call => /raw_content|blocks|download/.test(call.url)), false);
  const again = await f.post(session.token); assert.equal(again.status, 200); assert.equal(again.headers.get("cache-control"), "no-store");
  assert.equal(f.state.calls.filter(call => call.url.includes("/permissions/")).length, 3);
});

test("default login remains identity-only and unknown enablement values fail configuration", () => {
  const env = { IDOU_PUBLIC_URL: "https://control.example", FEISHU_APP_ID: "cli_synthetic", FEISHU_APP_SECRET: "SECRET-app", FEISHU_ALLOWED_TENANTS: "tenant" };
  assert.equal(loadFeishuLoginConfig(env).sourceAccessEnabled, false);
  assert.equal(loadFeishuLoginConfig({ ...env, FEISHU_SOURCE_ACCESS_ENABLED: "1" }).sourceAccessEnabled, true);
  for (const value of ["0", "true", "SECRET"]) assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_SOURCE_ACCESS_ENABLED: value }), error => !error.message.includes("SECRET"));
  const provider = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_synthetic", appSecret: "SECRET-app" });
  assert.equal(new URL(provider.authorizationUrl({ redirectUri: "https://control.example/callback", state: "state", challenge: "challenge" })).searchParams.has("scope"), false);
});

test("missing granted permission scope or denied tenant cannot create a credential-bearing session", async t => {
  for (const reason of ["scope", "tenant"]) {
    const f = await fixture(t); if (reason === "scope") f.state.grantedScope = "drive:drive"; else f.state.tenant = "foreign";
    const flow = await f.authorize(); assert.equal(flow.callback.status, 403); await assert.rejects(flow.client.complete());
    assert.equal(f.sessions.sessions.size, 0);
    assert.equal(f.state.calls.filter(call => call.url.includes("/permissions/")).length, 0);
  }
});

test("child/model-development/other-parent credentials cannot use the retained user token", async t => {
  const f = await fixture(t), session = await f.authenticate();
  const child = f.sessions.issueForWiki(session.token);
  const development = f.sessions.issue({ tenantId: "tenant", userId: "ou_synthetic", deviceId: "local" });
  const parent = f.sessions.issue({ tenantId: "tenant", userId: "ou_synthetic", deviceId: session.identity.deviceId, authProvider: "feishu", appId: "cli_synthetic", deviceProof: "ed25519-login" });
  for (const token of [child.token, development.token, parent.token, "invalid"]) assert.equal((await f.post(token)).status, 403);
  assert.equal(f.state.calls.filter(call => call.url.includes("/permissions/")).length, 0);
});

test("a false or malformed permission and a changed live OAuth identity fail the whole check", async t => {
  for (const kind of ["false", "string", "user", "tenant", "upstream"]) {
    const f = await fixture(t), session = await f.authenticate();
    if (kind === "false") f.state.permission = false;
    if (kind === "string") f.state.permission = "true";
    if (kind === "user") f.state.userId = "ou_other";
    if (kind === "tenant") f.state.tenant = "other";
    if (kind === "upstream") f.state.response = () => Response.json({ code: 999, msg: "SECRET", data: { auth_result: true } });
    const response = await f.post(session.token); assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /SECRET|authorized/);
    if (["user", "tenant"].includes(kind)) assert.equal(f.state.calls.filter(call => call.url.includes("/permissions/")).length, 0);
  }
});

test("logout during the last awaited upstream result aborts and cannot return an authorized result", async t => {
  const f = await fixture(t), session = await f.authenticate(), entered = Promise.withResolvers(), held = Promise.withResolvers();
  let signal;
  f.state.onPermission = async options => { signal = options.signal; entered.resolve(); await held.promise; };
  const checking = f.post(session.token); await entered.promise;
  assert.equal((await fetch(`${f.origin}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${session.token}` } })).status, 200);
  assert.equal(signal.aborted, true); held.resolve();
  const result = await checking; assert.equal(result.ok, false); assert.doesNotMatch(await result.text(), /SECRET|authorized/);
  assert.equal((await f.post(session.token)).status, 403);
});

test("expiry and close remove access, including checks already in flight", async t => {
  const f = await fixture(t), session = await f.authenticate(); f.state.offset = 16 * 60000;
  assert.equal((await f.post(session.token)).status, 403);
  f.state.offset = 0; const fresh = await f.authenticate(), entered = Promise.withResolvers(), held = Promise.withResolvers(); let signal;
  f.state.onPermission = async options => { signal = options.signal; entered.resolve(); await held.promise; };
  const work = f.post(fresh.token); await entered.promise; f.authority.close(); assert.equal(signal.aborted, true); held.resolve();
  assert.equal((await work).ok, false); assert.equal(f.sessions.listenerCount("revoked"), 0);
});

test("cancelled/expired authorized flows discard pending credentials rather than binding another login", async t => {
  for (const action of ["cancel", "expire"]) {
    const f = await fixture(t), flow = await f.authorize(), identity = f.login.flows.get(new URL(flow.begun.launchUrl).searchParams.get("flow")).identity;
    if (action === "cancel") await flow.client.cancel(); else { f.state.offset = 6 * 60000; f.login.prune(); }
    const issued = f.sessions.issue({ ...identity, deviceId: "device", authProvider: "feishu", deviceProof: "ed25519-login" });
    assert.throws(() => f.authority.bind(identity, issued)); assert.equal((await f.post(issued.token)).status, 403);
  }
});

test("request bounds, exact schemas and fixed docx/view target deny arbitrary URL/action/token import", async t => {
  const f = await fixture(t), session = await f.authenticate();
  for (const value of [input([]), input(Array.from({ length: 21 }, (_, i) => `Doc${i}`)), input(["one", "one"]), input(["../other?type=file"]),
    { ...input(), accessToken: "SECRET" }, { sources: [{ resourceType: "wiki", resourceId: "Wiki123" }] }, { sources: [{ resourceType: "docx", resourceId: "Doc123", action: "edit" }] }]) {
    assert.equal((await f.post(session.token, value)).status, 400);
  }
  assert.equal((await f.post(session.token, { text: "x".repeat(5000) })).status, 413);
  assert.equal((await f.post(session.token, input(), { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.post(session.token, input(), { "content-encoding": "gzip" })).status, 415);
  assert.equal(f.state.calls.filter(call => call.url.includes("/permissions/")).length, 0);
});

test("per-parent single flight and a person's 100/minute ceiling bound upstream permission requests", async t => {
  const f = await fixture(t), session = await f.authenticate(), entered = Promise.withResolvers(), held = Promise.withResolvers();
  f.state.onPermission = async () => { entered.resolve(); await held.promise; };
  const first = f.post(session.token); await entered.promise; assert.equal((await f.post(session.token)).status, 429);
  held.resolve(); assert.equal((await first).status, 200); f.state.onPermission = null;
  const before = f.state.calls.length;
  f.authority.rates.checks.hit(personOf(session.identity), 100); assert.equal((await f.post(session.token)).status, 429); assert.equal(f.state.calls.length, before);
  assert.equal(f.state.calls.filter(call => call.url.includes("/permissions/")).length, 1);
});

test("upstream oversized/redirect/error bodies never leak or become a positive permission", async t => {
  for (const response of [() => new Response("SECRET", { status: 302, headers: { location: "https://evil.example" } }),
    () => Response.json({ code: 0, data: { auth_result: true }, secret: "SECRET".repeat(20000) }), () => new Response("SECRET", { status: 500 })]) {
    const f = await fixture(t), session = await f.authenticate(); f.state.response = response;
    const result = await f.post(session.token); assert.equal(result.status, 502); assert.doesNotMatch(await result.text(), /SECRET|authorized/);
  }
});

test("native client rejects changed sessions/substituted source sets and returns no arbitrary fields", async t => {
  const f = await fixture(t), session = await f.authenticate(); let current = session;
  const changed = new FeishuSourceAccessClient({ getSession: async () => current, fetchImpl: async (...args) => { const result = await fetch(...args); current = { ...session, token: "x".repeat(43) }; return result; } });
  await assert.rejects(changed.check(input())); current = session;
  const falseSet = new FeishuSourceAccessClient({ getSession: async () => current, fetchImpl: async (...args) => { const result = await (await fetch(...args)).json(); return Response.json({ ...result, sourceSetHash: "f".repeat(64) }); } });
  await assert.rejects(falseSet.check(input()));
  const extras = new FeishuSourceAccessClient({ getSession: async () => current, fetchImpl: async (...args) => { const result = await (await fetch(...args)).json(); return Response.json({ ...result, secret: "SECRET", identity: { ...result.identity, accessToken: "SECRET" } }); } });
  assert.doesNotMatch(JSON.stringify(await extras.check(input())), /SECRET|accessToken/);
});

test("a denied later source rejects the whole batch and a fresh check cannot reuse earlier success", async t => {
  const f = await fixture(t), session = await f.authenticate(); let count = 0;
  f.state.onPermission = async () => { f.state.permission = ++count !== 2; };
  assert.equal((await f.post(session.token, input(["ADoc123", "BDoc123"]))).status, 403);
  assert.equal(count, 2);
  f.state.onPermission = async () => { count++; f.state.permission = false; };
  assert.equal((await f.post(session.token, input(["ADoc123"]))).status, 403); assert.equal(count, 3);
});

test("the real server entry enables the configured read-only endpoint and revokes it on logout", async t => {
  const portProbe = createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const preload = `globalThis.fetch = async (url, options) => {
    if (url === "https://open.feishu.cn/open-apis/authen/v2/oauth/token") return Response.json({code:0,token_type:"Bearer",access_token:"SECRET-user",expires_in:3600,scope:"${SOURCE_ACCESS_SCOPE} ${ACCOUNT_IDENTITY_SCOPE}"});
    if (url === "https://open.feishu.cn/open-apis/authen/v1/user_info") return Response.json({code:0,data:{tenant_key:"tenant",open_id:"ou_synthetic",user_id:"employee123"}});
    if (url === "https://open.feishu.cn/open-apis/drive/v1/permissions/SyntheticDoc123/members/auth?type=docx&action=view" && options.method === "GET") return Response.json({code:0,data:{auth_result:true}});
    throw new Error("Unexpected synthetic upstream request");
  };`;
  const child = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, path.resolve("bin/server.js"), "--feishu"], {
    env: { PATH: process.env.PATH, IDOU_PUBLIC_URL: origin, IDOU_PORT: String(port), FEISHU_APP_ID: "cli_synthetic", FEISHU_APP_SECRET: "SECRET-app",
      FEISHU_ALLOWED_TENANTS: "tenant", FEISHU_SOURCE_ACCESS_ENABLED: "1", FEISHU_CLI_IDENTITY_CHECKS_ENABLED: "1", MINIMAX_API_KEY: "SECRET-model" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } assert.doesNotMatch(output, /SECRET/); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("Server startup timed out")), 10000);
    const data = () => { if (output.includes("Listening on loopback port")) done(); };
    const exit = () => done(new Error("Server exited before listening"));
    const done = error => { clearTimeout(timer); child.stdout.off("data", data); child.off("exit", exit); error ? reject(error) : resolve(); };
    child.stdout.on("data", data); child.once("exit", exit); data();
  });
  const client = new FeishuLoginClient(), begun = await client.begin(origin), launch = await fetch(begun.launchUrl, { redirect: "manual" });
  const target = new URL(launch.headers.get("location")); assert.equal(target.searchParams.get("scope"), `${SOURCE_ACCESS_SCOPE} ${ACCOUNT_IDENTITY_SCOPE}`);
  const callback = await fetch(`${origin}/auth/feishu/callback?state=${target.searchParams.get("state")}&code=SyntheticCode`, { headers: { cookie: launch.headers.get("set-cookie").split(";")[0] } });
  assert.equal(callback.status, 200); const session = await client.complete();
  const access = new FeishuSourceAccessClient({ getSession: async () => session }); assert.equal((await access.check(input())).authorized, true);
  assert.equal(session.identity.cliIdentityChecks, true);
  const match = () => fetch(`${origin}/v1/feishu/account-match`, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ tenantKey: "tenant", tenantUserId: "employee123" }) });
  assert.equal((await match()).status, 200);
  assert.equal((await fetch(`${origin}/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${session.token}` } })).status, 200);
  await assert.rejects(access.check(input()));
  assert.equal((await match()).status, 403);
});
