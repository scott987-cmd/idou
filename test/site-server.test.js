import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { createSiteDemos } from "../src/control-plane/site-demos.js";
import { createSiteServer, siteCookieKey } from "../src/control-plane/site-server.js";
import { appHash } from "../src/apps/manifest.js";

const body = "<!doctype html><h1>台账</h1><script>console.log(1)</script>";
const pack = () => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html",
    files: [{ path: "index.html", bytes: Buffer.byteLength(body), sha256: appHash(Buffer.from(body)) }] },
  blobs: [{ path: "index.html", base64: Buffer.from(body).toString("base64") }],
});

async function serving(t, { share = { scope: "invited" }, source = null, ...options } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-site-server-"));
  const registry = await SiteRegistry.open(root);
  const site = await registry.publish({ ownerId: "ou_owner", tenantId: "t1", name: "客户看板", ...pack(), share, source,
    anonymousAllowed: share.scope === "anyone" });
  const audit = [];
  const server = createSiteServer({ registry, origin: "https://sites.example", cookieKey: await siteCookieKey(root),
    audit: (event) => audit.push(event), ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); server.closeAllConnections?.(); await rm(root, { recursive: true, force: true }); });
  return { root, registry, site, server, base, audit };
}

// Signing a visitor cookie the way the server does, so a test can be a visitor
// without walking through Feishu.
// The console's, as the admin listener seals it: its own name and a key made from the sites' one.
async function asAdmin(root, visitor) {
  const { createHmac } = await import("node:crypto");
  const key = createHmac("sha256", await siteCookieKey(root)).update("idou admin console cookie v1").digest();
  const payload = Buffer.from(JSON.stringify({ u: visitor.userId, t: visitor.tenantId, e: Date.now() + 3_600_000 })).toString("base64url");
  return `idou_admin=${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}
async function asVisitor(root, visitor, name = "mydoubao_site") {
  const { createHmac } = await import("node:crypto");
  const key = await siteCookieKey(root);
  const payload = Buffer.from(JSON.stringify({ u: visitor.userId, t: visitor.tenantId, e: Date.now() + 3_600_000 })).toString("base64url");
  return `${name}=${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

test("a site nobody is signed in for sends them to sign in, and says so when it cannot", async (t) => {
  const plain = await serving(t);
  const answer = await fetch(`${plain.base}/s/${plain.site.id}/`, { redirect: "manual" });
  assert.equal(answer.status, 401, "没有配置登录时，直说而不是重定向到不存在的地方");
  assert.match(await answer.text(), /请先登录/);

  const withLogin = await serving(t, { oauth: { authorizationUrl: ({ redirectUri, state }) => `https://feishu.example/authorize?redirect=${encodeURIComponent(redirectUri)}&state=${state}`, probeIdentity: async () => ({}) } });
  const sent = await fetch(`${withLogin.base}/s/${withLogin.site.id}/`, { redirect: "manual" });
  assert.equal(sent.status, 302);
  const location = new URL(sent.headers.get("location"));
  assert.equal(location.origin, "https://feishu.example");
  assert.equal(location.searchParams.get("redirect"), "https://sites.example/_auth/callback");
});

test("the owner gets the bytes that were published, with a policy that lets the page reach nothing", async (t) => {
  const { base, site, root } = await serving(t);
  const answer = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_owner", tenantId: "t1" }) } });
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), body);
  assert.equal(answer.headers.get("content-type"), "text/html; charset=utf-8");
  const policy = answer.headers.get("content-security-policy");
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /form-action 'none'/);
  assert.equal(answer.headers.get("x-content-type-options"), "nosniff");
  assert.equal(answer.headers.get("referrer-policy"), "no-referrer");
});

// A published page's video is fetched in pieces: Safari -- and the in-app browser
// on an iPhone -- asks for bytes=0-1 first and will not play one only ever
// served whole (2026-09-24, when sites were first allowed video).
test("a video is served in the pieces a player asks for", async (t) => {
  const video = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-site-video-"));
  const registry = await SiteRegistry.open(root);
  const files = [["index.html", Buffer.from(body)], ["media/intro.mp4", video]];
  const site = await registry.publish({ ownerId: "ou_owner", tenantId: "t1", name: "带视频的页面", share: { scope: "invited" },
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: files.map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: appHash(bytes) })) },
    blobs: files.map(([name, bytes]) => ({ path: name, base64: bytes.toString("base64") })) });
  const server = createSiteServer({ registry, origin: "https://sites.example", cookieKey: await siteCookieKey(root) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.close(); server.closeAllConnections?.(); await rm(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}/s/${site.id}/media/intro.mp4`;
  const cookie = await asVisitor(root, { userId: "ou_owner", tenantId: "t1" });
  const get = (range) => fetch(url, { headers: { cookie, ...(range ? { range } : {}) } });

  const whole = await get();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), video);
  const first = await get("bytes=0-1");
  assert.equal(first.status, 206);
  assert.equal(first.headers.get("content-range"), "bytes 0-1/64");
  assert.deepEqual([...Buffer.from(await first.arrayBuffer())], [0, 1]);
  const last = await get("bytes=-4");
  assert.equal(last.headers.get("content-range"), "bytes 60-63/64");
  assert.deepEqual([...Buffer.from(await last.arrayBuffer())], [60, 61, 62, 63]);
  const rest = await get("bytes=62-");
  assert.deepEqual([...Buffer.from(await rest.arrayBuffer())], [62, 63]);
  const past = await get("bytes=64-");
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("content-range"), "bytes */64");
  await past.arrayBuffer();
  // Several ranges, or one that makes no sense, get the whole file.
  for (const range of ["bytes=0-1,4-5", "bytes=5-2", "items=0-1"]) {
    const answer = await get(range);
    assert.equal(answer.status, 200, range);
    assert.equal(Buffer.from(await answer.arrayBuffer()).length, 64, range);
  }
});

test("somebody the site was not shared with is refused, and told what to do", async (t) => {
  const { base, site, root, audit } = await serving(t);
  const answer = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_stranger", tenantId: "t1" }) } });
  assert.equal(answer.status, 403);
  const text = await answer.text();
  assert.match(text, /向分享给你的人申请/);
  assert.equal(text.includes("ou_owner"), false, "拒绝页不泄露任何标识符");
  assert.deepEqual(audit.filter((event) => event.event === "site-access").at(-1), { event: "site-access", siteId: site.id, allowed: false, reason: "not_shared", anonymous: false });
});

test("a site that follows its table asks Feishu about this visitor, and reuses that answer briefly", async (t) => {
  const asked = [];
  const { base, site, root } = await serving(t, {
    share: { scope: "invited", inherit: true },
    source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" },
    readsSource: async ({ visitor }) => { asked.push(visitor.userId); return visitor.userId === "ou_allowed"; },
  });
  const cookie = await asVisitor(root, { userId: "ou_allowed", tenantId: "t1" });
  assert.equal((await fetch(`${base}/s/${site.id}/`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${base}/s/${site.id}/`, { headers: { cookie } })).status, 200);
  assert.deepEqual(asked, ["ou_allowed"], "同一个人几秒内不重复问飞书");
  const refused = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_denied", tenantId: "t1" }) } });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /在飞书的表格里设置/);
  assert.deepEqual(asked, ["ou_allowed", "ou_denied"]);
});

test("组织内 and 互联网 behave as they are named", async (t) => {
  const inside = await serving(t, { share: { scope: "tenant" } });
  assert.equal((await fetch(`${inside.base}/s/${inside.site.id}/`, { headers: { cookie: await asVisitor(inside.root, { userId: "ou_any", tenantId: "t1" }) } })).status, 200);
  assert.equal((await fetch(`${inside.base}/s/${inside.site.id}/`, { headers: { cookie: await asVisitor(inside.root, { userId: "ou_any", tenantId: "t2" }) } })).status, 403);

  const open = await serving(t, { share: { scope: "anyone" }, anonymousAllowed: true });
  const answer = await fetch(`${open.base}/s/${open.site.id}/`);
  assert.equal(answer.status, 200, "开放给互联网的网站不需要登录");
  assert.equal(await answer.text(), body);
});

test("a forged or expired cookie is simply nobody", async (t) => {
  const { base, site, root } = await serving(t, { share: { scope: "tenant" } });
  const good = await asVisitor(root, { userId: "ou_any", tenantId: "t1" });
  const tampered = good.replace(/\.[^.]+$/, ".not-the-signature");
  assert.equal((await fetch(`${base}/s/${site.id}/`, { headers: { cookie: tampered } })).status, 401);
  const swapped = `mydoubao_site=${Buffer.from(JSON.stringify({ u: "ou_any", t: "t1", e: Date.now() + 1000 })).toString("base64url")}.x`;
  assert.equal((await fetch(`${base}/s/${site.id}/`, { headers: { cookie: swapped } })).status, 401);
  const expired = `mydoubao_site=${Buffer.from(JSON.stringify({ u: "ou_any", t: "t1", e: Date.now() - 1 })).toString("base64url")}.x`;
  assert.equal((await fetch(`${base}/s/${site.id}/`, { headers: { cookie: expired } })).status, 401);
});

test("the data route and the change stream are behind the same decision", async (t) => {
  const { base, site, root, registry, server } = await serving(t, { share: { scope: "tenant" } });
  await registry.putData(site.id, { schema: { fields: [] }, snapshot: { digest: "d1", rows: [] } });
  const cookie = await asVisitor(root, { userId: "ou_any", tenantId: "t1" });
  const data = await fetch(`${base}/s/${site.id}/_data`, { headers: { cookie } });
  assert.equal(data.status, 200);
  assert.deepEqual((await data.json()).snapshot, { digest: "d1", rows: [] });
  assert.equal((await fetch(`${base}/s/${site.id}/_data`)).status, 401, "没登录就没有数据");

  const controller = new AbortController();
  const events = await fetch(`${base}/s/${site.id}/_events`, { headers: { cookie }, signal: controller.signal });
  assert.equal(events.headers.get("content-type"), "text/event-stream");
  const reader = events.body.getReader();
  await reader.read();
  server.notifySite(site.id);
  const pushed = new TextDecoder().decode((await reader.read()).value);
  assert.match(pushed, /event: changed/);
  controller.abort();
});

test("only GET, only these routes, and a path that cannot leave the site", async (t) => {
  const { base, site, root } = await serving(t, { share: { scope: "tenant" } });
  const cookie = await asVisitor(root, { userId: "ou_any", tenantId: "t1" });
  assert.equal((await fetch(`${base}/s/${site.id}/`, { method: "POST", headers: { cookie } })).status, 405);
  assert.equal((await fetch(`${base}/`, { headers: { cookie } })).status, 404);
  assert.equal((await fetch(`${base}/s/00000000-0000-4000-8000-000000000000/`, { headers: { cookie } })).status, 404);
  for (const wanted of ["../sites.json", "..%2Fsites.json", "cookie.key", "manifest.json"]) {
    const answer = await fetch(`${base}/s/${site.id}/${wanted}`, { headers: { cookie } });
    assert.equal(answer.status, 404, wanted);
  }
});

test("signing in returns the visitor to where they were going, and nowhere else", async (t) => {
  const { base, site } = await serving(t, {
    oauth: { authorizationUrl: ({ state }) => `https://feishu.example/authorize?state=${state}`,
      probeIdentity: async () => ({ userId: "ou_owner", tenantId: "t1" }) },
  });
  const sent = await fetch(`${base}/s/${site.id}/`, { redirect: "manual" });
  const state = new URL(sent.headers.get("location")).searchParams.get("state");
  const back = await fetch(`${base}/_auth/callback?state=${state}&code=abc`, { redirect: "manual" });
  assert.equal(back.status, 302);
  assert.equal(back.headers.get("location"), `/s/${site.id}/`);
  const cookie = back.headers.get("set-cookie");
  assert.match(cookie, /^idou_site=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/, "站点地址是 https 时要带 Secure");
  // That cookie really is a session.
  const answer = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(answer.status, 200);
  // The same state cannot be replayed.
  assert.equal((await fetch(`${base}/_auth/callback?state=${state}&code=abc`, { redirect: "manual" })).status, 400);
});

// The product was renamed, and the visitor's cookie carries its name: one set
// under either spelling signs them in, and signing out clears both.
test("a visitor signed in under either spelling of the product's name stays signed in, and signs out of both", async (t) => {
  const { base, site, root } = await serving(t);
  for (const name of ["idou_site", "mydoubao_site"]) {
    const answer = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_owner", tenantId: "t1" }, name) }, redirect: "manual" });
    assert.equal(answer.status, 200, name);
  }
  const forged = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: "idou_site=e30.x" }, redirect: "manual" });
  assert.notEqual(forged.status, 200, "a cookie under the new spelling is checked like the old one");
  const out = await fetch(`${base}/_auth/logout`, { redirect: "manual" });
  const cleared = out.headers.getSetCookie();
  assert.deepEqual(cleared.map((line) => line.split("=")[0]).sort(), ["idou_site", "mydoubao_site"]);
  assert.ok(cleared.every((line) => /Max-Age=0/.test(line)));
});

test("a sign-in cannot be turned into a redirect somewhere else", async (t) => {
  const { base } = await serving(t, { oauth: { authorizationUrl: () => "https://feishu.example/authorize", probeIdentity: async () => ({ userId: "ou_owner", tenantId: "t1" }) } });
  const out = await fetch(`${base}/_auth/logout?to=https://evil.example/`, { redirect: "manual" });
  assert.equal(out.headers.get("location"), "/");
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  const sideways = await fetch(`${base}/_auth/logout?to=//evil.example/`, { redirect: "manual" });
  assert.equal(sideways.headers.get("location"), "/");
});

test("a group or department the visitor belongs to is asked for once, from Feishu", async (t) => {
  const asked = [];
  const { base, site, root } = await serving(t, {
    share: { scope: "invited", members: [{ type: "department", id: "od-sales" }] },
    memberships: async (visitor) => { asked.push(visitor.userId); return { departments: ["od-sales"], chats: [] }; },
  });
  const answer = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_sales", tenantId: "t1" }) } });
  assert.equal(answer.status, 200);
  assert.deepEqual(asked, ["ou_sales"]);
});

test("the demo gallery is served like any site here: behind the same sign-in, reading nothing", async (t) => {
  const { base, audit } = await serving(t, { demos: createSiteDemos() });
  // Not signed in, and this deployment does not allow anonymous: the same
  // answer any tenant-wide site gives. A demo holds nothing of anybody's, but
  // an unauthenticated route on a private deployment is the operator's call.
  assert.equal((await fetch(`${base}/demo/`, { redirect: "manual" })).status, 401);
  assert.equal((await fetch(`${base}/demo/dashboard-tech/`, { redirect: "manual" })).status, 401);

  const open = await serving(t, { demos: createSiteDemos(), anonymousAllowed: true });
  const index = await fetch(`${open.base}/demo/`);
  assert.equal(index.status, 200);
  const listed = await index.text();
  assert.match(listed, /样例/);
  assert.match(listed, /href="\/demo\/kanban-depth\//);
  const page = await fetch(`${open.base}/demo/kanban-depth/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /site\.css/);
  assert.equal((await fetch(`${open.base}/demo/kanban-depth/site.css`)).status, 200);
  // It is not the registry: a demo is never a site, and a name it does not
  // know is nothing rather than a read of something else.
  assert.equal((await fetch(`${open.base}/demo/nope-tech/`)).status, 404);
  assert.equal((await fetch(`${open.base}/demo/kanban-depth/../../s/x`, { redirect: "manual" })).status, 404);
  assert.deepEqual(open.audit.filter((event) => event.event === "site-demo").map((event) => event.demo),
    ["index", "kanban-depth", "kanban-depth", "nope-tech"]);

  // A deployment with no gallery says so rather than half-answering.
  const without = await serving(t, { anonymousAllowed: true });
  assert.equal((await fetch(`${without.base}/demo/`)).status, 404);
  assert.equal(audit.length >= 0, true);
});

test("a demo's sign-in asks for identity and nothing else", async (t) => {
  const asked = [];
  const { base } = await serving(t, { demos: createSiteDemos(),
    oauth: {
      authorizationUrl: ({ redirectUri, state, scopes }) => {
        asked.push(scopes);
        return `https://accounts.example/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      },
      probeIdentity: async () => ({ userId: "ou_visitor", tenantId: "t1" }),
    } });
  // A demo never asks Feishu anything about the visitor, so making them grant
  // this application their calendar and their messages in order to look at an
  // invented table would be both useless and alarming.
  const sent = await fetch(`${base}/demo/kanban-depth/`, { redirect: "manual" });
  assert.equal(sent.status, 302);
  assert.match(sent.headers.get("location"), /^https:\/\/accounts\.example\/authorize/);
  assert.deepEqual(asked, [[]], "样例的登录不该索要任何额外权限");

  // A real site's sign-in is left exactly as it was: what it needs depends on
  // the site, and narrowing it is a change to make with a live login in hand.
  const site = await serving(t, { oauth: {
    authorizationUrl: ({ state, redirectUri, scopes }) => { asked.push(scopes); return `https://accounts.example/a?state=${state}&r=${encodeURIComponent(redirectUri)}`; },
    probeIdentity: async () => ({ userId: "ou_visitor", tenantId: "t1" }),
  } });
  await fetch(`${site.base}/s/${site.site.id}/`, { redirect: "manual" });
  assert.equal(asked.at(-1), undefined, "普通站点仍然用登录本身的那一套");
});

test("an address outside the allowlist learns nothing at all", async (t) => {
  // Loopback is always in, so a test that connects from 127.0.0.1 cannot check
  // a refusal by connecting. The rule itself is checked in
  // address-allowlist.test.js; what matters here is that it runs before
  // everything else, so a refused address never reaches a route.
  const reached = [];
  const { base, audit, site } = await serving(t, { demos: createSiteDemos(),
    allowlist: { rules: ["203.0.113.0/24"], allows: (address) => { reached.push(address); return false; } } });
  for (const at of ["/", `/s/${site.id}/`, "/demo/", "/_auth/callback?code=x&state=y", "/s/nope/_events"]) {
    const answer = await fetch(`${base}${at}`, { redirect: "manual" });
    assert.equal(answer.status, 403, at);
    const said = await answer.text();
    // Not which sites exist, not that there is a sign-in, not what the page
    // looks like: only that this deployment does not take connections here.
    assert.match(said, /只允许指定网段访问/);
    assert.equal(said.includes(site.id), false);
    assert.equal(answer.headers.get("location"), null, "不该泄漏还有个登录在后面");
  }
  assert.equal(reached.length, 5, "每一个请求都问过名单");
  assert.equal(audit.filter((event) => event.event === "site-address-refused").length, 5);
  // Nothing behind it ran: no access decision, no login flow, no file read.
  assert.deepEqual(audit.filter((event) => ["site-access", "site-demo", "site-login"].includes(event.event)), []);
});

const consoleFor = (verdict, seen = []) => ({
  decide: async (visitor) => { seen.push(visitor.userId); return verdict; },
  refusal: (v) => `拒绝：${v.reason}`,
  state: async () => ({ deployment: { anonymous: true }, models: [], sites: [], audit: [], notYet: [] }),
  page: (state, who) => `<!doctype html><p>${who.userId}</p><p>${JSON.stringify(state)}</p>`,
});

test("the console is asked again on every request, not trusted from a cookie", async (t) => {
  const asked = [];
  const { base, root } = await serving(t, { role: "admin", console: consoleFor({ admin: true, reason: "chat-member" }, asked),
    oauth: { authorizationUrl: ({ state }) => `https://accounts.example/a?state=${state}`,
      probeIdentity: async () => ({ userId: "ou_boss", tenantId: "t1" }) } });
  // Signed out: the console sends them to sign in, asking for no scopes -- it
  // reads this server, never the visitor's Feishu.
  const out = await fetch(`${base}/admin`, { redirect: "manual" });
  assert.equal(out.status, 302);

  const cookie = await asAdmin(root, { userId: "ou_boss", tenantId: "t1" });
  const page = await fetch(`${base}/admin`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ou_boss/);
  const json = await fetch(`${base}/admin/state.json`, { headers: { cookie } });
  assert.equal(json.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual((await json.json()).deployment, { anonymous: true });
  // Being removed in Feishu has to take effect without waiting for a cookie to
  // expire, so the question is put again each time.
  assert.deepEqual(asked, ["ou_boss", "ou_boss"]);
});

test("somebody who is not an administrator is told which, and sees nothing", async (t) => {
  const { base, root, audit } = await serving(t, { role: "admin", console: consoleFor({ admin: false, reason: "not-in-chat" }),
    oauth: { authorizationUrl: ({ state }) => `https://accounts.example/a?state=${state}`,
      probeIdentity: async () => ({ userId: "ou_nobody", tenantId: "t1" }) } });
  const cookie = await asAdmin(root, { userId: "ou_nobody", tenantId: "t1" });
  for (const at of ["/admin", "/admin/state.json"]) {
    const answer = await fetch(`${base}${at}`, { headers: { cookie } });
    assert.equal(answer.status, 403, at);
    const said = await answer.text();
    assert.match(said, /not-in-chat/);
    assert.equal(said.includes("anonymous"), false, "拒绝页不该带上部署情况");
  }
  assert.deepEqual(audit.filter((event) => event.event === "admin-access").map((event) => event.allowed), [false, false]);
});

test("a deployment with no console does not have one", async (t) => {
  const { base } = await serving(t);
  assert.equal((await fetch(`${base}/admin`)).status, 404);
  assert.equal((await fetch(`${base}/admin/state.json`)).status, 404);
});

// Found in the security review of 2026-09-27: the console was served beside the
// sites, and a published page is script its author wrote -- opened by an
// administrator, it could read /admin/state.json as them. Now each has a
// listener of its own, and neither serves the other or takes the other's cookie.
test("the console and the sites never share an origin, a route or a sign-in", async (t) => {
  const sites = await serving(t);
  const admin = await serving(t, { role: "admin", console: consoleFor({ admin: true, reason: "chat-member" }) });
  assert.throws(() => createSiteServer({ registry: sites.registry, origin: "https://sites.example", cookieKey: Buffer.alloc(32, 1), console: consoleFor({ admin: true }) }),
    /不能和发布的网站同源/, "a console beside the sites is refused outright");
  assert.equal((await fetch(`${sites.base}/admin`)).status, 404);
  assert.equal((await fetch(`${sites.base}/admin/state.json`)).status, 404);
  assert.equal((await fetch(`${admin.base}/s/${admin.site.id}/`)).status, 404, "the console serves no site");
  assert.equal((await fetch(`${admin.base}/demo`)).status, 404);
  assert.equal((await fetch(`${admin.base}/`, { redirect: "manual" })).headers.get("location"), "/admin");
  // A visitor's sign-in is not the console's, even for an administrator, and the other way round.
  const visitor = await asVisitor(admin.root, { userId: "ou_boss", tenantId: "t1" });
  for (const name of ["idou_site", "mydoubao_site", "idou_admin"]) {
    const borrowed = visitor.replace(/^[^=]+=/, `${name}=`);
    const answer = await fetch(`${admin.base}/admin/state.json`, { headers: { cookie: borrowed }, redirect: "manual" });
    assert.notEqual(answer.status, 200, name);
  }
  assert.equal((await fetch(`${admin.base}/admin/state.json`, { headers: { cookie: await asAdmin(admin.root, { userId: "ou_boss", tenantId: "t1" }) } })).status, 200);
  const adminCookie = await asAdmin(sites.root, { userId: "ou_owner", tenantId: "t1" });
  assert.notEqual((await fetch(`${sites.base}/s/${sites.site.id}/`, { headers: { cookie: adminCookie.replace(/^idou_admin=/, "idou_site=") }, redirect: "manual" })).status, 200,
    "nor is the console's sign-in a visitor's");
});
