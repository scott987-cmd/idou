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
  assert.deepEqual(audit.filter((event) => event.event === "site-access").at(-1), { event: "site-access", siteId: site.id, allowed: false, reason: "not_shared", anonymous: false, counted: "refused" });
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

// Found in the 2026-10-03 benchmark: the visitor's Feishu credential was held
// in memory only, and once it ran out (about two hours) or the server
// restarted, the visitor was told they had no permission on the table -- when
// nobody had asked Feishu at all (docs/sites-phase0.md §0.3).
test("following a table, a visitor without a live Feishu credential is asked to sign in again, never refused for it", async (t) => {
  const answers = { ou_expired: "relogin", ou_flaky: "unavailable" };
  const oauth = { authorizationUrl: ({ state }) => `https://feishu.example/authorize?state=${state}`, probeIdentity: async () => null,
    redeemVisitor: async () => ({ identity: { userId: "ou_fresh", tenantId: "t1" }, token: "u-token", expiresAt: Date.now() + 3_600_000 }) };
  const { base, site, root } = await serving(t, { share: { scope: "invited", inherit: true }, source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" }, oauth,
    readsSource: async ({ visitor, credential }) => (credential ? answers[visitor.userId] ?? true : "relogin") });
  // Signed in, with no credential held here (run out, or a restart): sent to sign in.
  const stale = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_stale", tenantId: "t1" }) }, redirect: "manual" });
  assert.equal(stale.status, 302);
  assert.match(stale.headers.get("location"), /^https:\/\/feishu\.example\/authorize/);
  // Signed in again: a credential is held, Feishu is asked, the visitor is let in.
  const state = new URL(stale.headers.get("location")).searchParams.get("state");
  const back = await fetch(`${base}/_auth/callback?state=${state}&code=abc`, { redirect: "manual" });
  const cookie = back.headers.get("set-cookie").split(";")[0];
  const entered = await fetch(`${base}/s/${site.id}/`, { headers: { cookie }, redirect: "manual" });
  assert.equal(entered.status, 302);
  assert.match(entered.headers.get("location"), new RegExp(`^/s/${site.id}/~`));
  // Feishu says the token is no longer good: sign in again, not "no permission".
  const relogin = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_expired", tenantId: "t1" }) }, redirect: "manual" });
  assert.match(relogin.headers.get("location") ?? "", /feishu\.example/);
  // Just signed in and still nothing to ask with: said plainly, not a loop of sign-ins.
  const { createHmac } = await import("node:crypto");
  const key = await siteCookieKey(root);
  const fresh = Buffer.from(JSON.stringify({ u: "ou_new", t: "t1", e: Date.now() + 3_600_000, i: Date.now() })).toString("base64url");
  const looped = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: `idou_site=${fresh}.${createHmac("sha256", key).update(fresh).digest("base64url")}` }, redirect: "manual" });
  assert.equal(looped.status, 503);
  assert.match(await looped.text(), /暂时没能向飞书确认/);
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
    assert.equal(answer.status, 302, name);
    assert.match(answer.headers.get("location"), new RegExp(`^/s/${site.id}/~`), `${name}: let in, under a capability`);
  }
  const forged = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: "idou_site=e30.x" }, redirect: "manual" });
  assert.notEqual(forged.status, 200, "a forged cookie opens nothing");
  assert.doesNotMatch(forged.headers.get("location") ?? "", /~/, "a cookie under the new spelling is checked like the old one");
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

// Found in the security review of 2026-09-27: the console was served beside the
// sites, and a published page is script its author wrote -- opened by an
// administrator, it could read the console as them. The console has a listener
// of its own now (admin-server.js, test/admin-server.test.js); this one refuses
// its paths and refuses to be given one.
test("the sites listener serves no console, and will not be given one", async (t) => {
  const sites = await serving(t);
  assert.throws(() => createSiteServer({ registry: sites.registry, origin: "https://sites.example", cookieKey: Buffer.alloc(32, 1), console: {} }),
    /不能和发布的网站同源/, "a console beside the sites is refused outright");
  for (const at of ["/admin", "/admin/state.json", "/admin/api/me", "/admin/assets/app.js"]) {
    assert.equal((await fetch(`${sites.base}${at}`)).status, 404, at);
  }
});

// docs/sites-phase0.md §0.4: a site shared with a group lets in the people the
// bot reads in that group, and asks only about the groups the site names.
test("a site shared with a group lets in its members, and nobody else", async (t) => {
  const asked = [];
  const { base, site, root } = await serving(t, {
    share: { scope: "invited", members: [{ type: "chat", id: "oc_sales", name: "销售群" }] },
    memberships: async (visitor, chats) => { asked.push(chats); return { chats: visitor.userId === "ou_member" ? chats.filter((id) => id === "oc_sales") : [], departments: [] }; },
  });
  const member = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_member", tenantId: "t1" }) } });
  assert.equal(member.status, 200);
  const outsider = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId: "ou_outsider", tenantId: "t1" }) } });
  assert.equal(outsider.status, 403);
  assert.ok(asked.every((chats) => chats.length === 1 && chats[0] === "oc_sales"), "asked about this site's groups only");
});

// Found reviewing phase 0 (2026-10-03): a group the bot could not read just
// then told everybody in it "not shared", and kept saying so for 90 seconds.
test("a group that cannot be read is no answer, not a refusal, and is asked again", async (t) => {
  let readable = false;
  const { base, site, root } = await serving(t, {
    share: { scope: "invited", members: [{ type: "chat", id: "oc_sales", name: "销售群" }] },
    memberships: async (visitor, chats) => (readable ? { chats, departments: [] } : { chats: [], departments: [], unknown: true }),
  });
  const cookie = await asVisitor(root, { userId: "ou_member", tenantId: "t1" });
  const unread = await fetch(`${base}/s/${site.id}/`, { headers: { cookie } });
  assert.equal(unread.status, 503);
  assert.match(await unread.text(), /暂时没能向飞书确认你在不在分享给的群或部门里/);
  readable = true;
  assert.equal((await fetch(`${base}/s/${site.id}/`, { headers: { cookie } })).status, 200, "read now: let in, nothing kept from the failure");
});

// Found reviewing phase 0 (2026-10-03): a capability address copied out of a
// visitor's address bar served their pages to anything that did not say it
// was a browser fetching for a page -- curl, a chat's link preview -- for
// twelve hours. Now only a page's own fetches go by the capability alone.
test("a capability address opens nothing for somebody else, browser or not; a page's own fetches go by it alone", async (t) => {
  const { base, site, root } = await serving(t, { share: { scope: "tenant" } });
  const cookie = await asVisitor(root, { userId: "ou_viewer", tenantId: "t1" }, "idou_site");
  const at = (await fetch(`${base}/s/${site.id}/`, { headers: { cookie }, redirect: "manual" })).headers.get("location");
  assert.match(at, new RegExp(`^/s/${site.id}/~`));
  // The page reads its own address: who opened it is not written there.
  assert.doesNotMatch(Buffer.from(at.split("~")[1].split(".")[0], "base64url").toString("latin1"), /ou_viewer/, "the visitor is sealed in, not spelled out");
  // The visitor's own browser, opening it: the page.
  assert.equal((await fetch(`${base}${at}`, { headers: { cookie, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, redirect: "manual" })).status, 200);
  // Pasted elsewhere: a link preview or curl says nothing; another browser, or another person, is opening a page.
  const other = await asVisitor(root, { userId: "ou_other", tenantId: "t1" }, "idou_site");
  for (const headers of [{}, { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, { cookie: other }, { cookie: other, "sec-fetch-mode": "cors" }]) {
    const copied = await fetch(`${base}${at}`, { headers, redirect: "manual" });
    assert.equal(copied.status, 302, JSON.stringify(Object.keys(headers)));
    assert.equal(copied.headers.get("location"), `/s/${site.id}/`, "sent the normal way in");
  }
  // What the sandboxed page itself fetches carries no cookie: the capability is enough.
  const fetched = await fetch(`${base}${at}`, { headers: { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" }, redirect: "manual" });
  assert.equal(fetched.status, 200);
  assert.match(fetched.headers.get("content-security-policy"), /; sandbox allow-scripts/, "and sandboxed, whatever it is");
});

// Found reviewing phase 0 (2026-10-03): Feishu refusing a credential made
// moments ago sent the visitor to sign in again, which made another credential
// just like it -- round and round until the browser gave up on redirects. And
// Feishu giving no answer was asked again by every file of the page, each
// waiting out its timeout.
test("a credential refused right after signing in ends in a plain answer, and no answer is not asked again by every file", async (t) => {
  const asked = [], arriving = ["ou_refused", "ou_flaky"];
  const oauth = { authorizationUrl: ({ state }) => `https://feishu.example/authorize?state=${state}`, probeIdentity: async () => null,
    redeemVisitor: async () => ({ identity: { userId: arriving.shift(), tenantId: "t1" }, token: "u-token", expiresAt: Date.now() + 3_600_000 }) };
  const { base, site, root } = await serving(t, { share: { scope: "invited", inherit: true }, source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" }, oauth,
    readsSource: async ({ visitor, credential }) => { asked.push(visitor.userId); return !credential ? "relogin" : visitor.userId === "ou_refused" ? "relogin" : "unavailable"; } });
  const signIn = async () => {
    const start = await fetch(`${base}/s/${site.id}/`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    return (await fetch(`${base}/_auth/callback?state=${state}&code=abc`, { redirect: "manual" })).headers.get("set-cookie").split(";")[0];
  };
  const refused = await signIn();
  const again = await fetch(`${base}/s/${site.id}/`, { headers: { cookie: refused }, redirect: "manual" });
  assert.equal(again.status, 503, "not another round of signing in");
  assert.doesNotMatch(again.headers.get("location") ?? "", /feishu\.example/);
  // No answer: the page and its files are one question for a few seconds.
  const flaky = await signIn();
  asked.length = 0;
  for (let at = 0; at < 3; at += 1) assert.equal((await fetch(`${base}/s/${site.id}/`, { headers: { cookie: flaky }, redirect: "manual" })).status, 503);
  assert.deepEqual(asked, ["ou_flaky"], "asked once, not once a file");
});

// docs/sites-phase1.md §1.6: an address name leads on to the site, where
// signing in and the capability go as always.
test("a site's address name leads to it, an old name too, and an unknown one says what a missing site says", async (t) => {
  const { base, site, registry } = await serving(t, { share: { scope: "tenant" } });
  await registry.setAddress(site.id, { ownerId: "ou_owner", address: "客户看板" });
  const named = await fetch(`${base}/s/${encodeURIComponent("客户看板")}/page.html?from=qr`, { redirect: "manual" });
  assert.equal(named.status, 302);
  assert.equal(named.headers.get("location"), `/s/${site.id}/page.html?from=qr`);
  await registry.setAddress(site.id, { ownerId: "ou_owner", address: "客户总览" });
  assert.equal((await fetch(`${base}/s/${encodeURIComponent("客户看板")}/`, { redirect: "manual" })).headers.get("location"), `/s/${site.id}/`, "the old name still leads there");
  const unknown = await fetch(`${base}/s/${encodeURIComponent("没有这个")}/`, { redirect: "manual" });
  await registry.withdraw(site.id, { ownerId: "ou_owner" });
  const down = await fetch(`${base}/s/${encodeURIComponent("客户总览")}/`, { redirect: "manual" });
  assert.deepEqual([unknown.status, down.status], [404, 404]);
  assert.equal(await unknown.text(), await down.text(), "a name nobody uses and a site taken down read the same");
  assert.equal((await fetch(`${base}/s/%E0%A4%A/`, { redirect: "manual" })).status, 404, "a broken encoding is no name");
});

// Found building visit numbers (docs/sites-phase1.md §1.5): since sites were
// opened under a capability, every opening was two -- the way in and the page --
// and both were counted.
test("an opening is counted once, with where it came from; a refusal once too", async (t) => {
  const views = [];
  const { base, site, root, audit } = await serving(t, { share: { scope: "tenant" }, onView: (view) => views.push(view) });
  const cookie = await asVisitor(root, { userId: "ou_viewer", tenantId: "t1" }, "idou_site");
  const entered = await fetch(`${base}/s/${site.id}/?from=qr`, { headers: { cookie }, redirect: "manual" });
  await fetch(`${base}${entered.headers.get("location")}`, { headers: { cookie, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "Mozilla/5.0 Lark/7.1" }, redirect: "manual" });
  // What the page loads is not another opening.
  await fetch(`${base}${entered.headers.get("location")}`, { headers: { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" }, redirect: "manual" });
  await new Promise((resolve) => setImmediate(resolve));
  const counted = audit.filter((event) => event.event === "site-access" && event.counted);
  assert.deepEqual(counted.map((event) => event.counted), ["visit"]);
  assert.deepEqual(views.map((view) => [view.site.id, view.visitor, view.source]), [[site.id, { tenantId: "t1", userId: "ou_viewer" }, "qr"]]);
  const outsider = await asVisitor(root, { userId: "ou_x", tenantId: "t2" }, "idou_site");
  await fetch(`${base}/s/${site.id}/`, { headers: { cookie: outsider }, redirect: "manual" });
  assert.deepEqual(audit.filter((event) => event.event === "site-access" && event.counted).map((event) => event.counted), ["visit", "refused"]);
});

// Found 2026-10-04 (a table site of thousands of rows loading slowly): its data
// was rebuilt for every request, sent uncompressed and never cached -- 4 MB
// for 5000 rows, again on every reload. Now the same bytes for every visitor,
// wrapped and compressed once per change, and not sent again while unchanged.
test("a table site's data is sent compressed, the same for everyone, and not again until it changes", async (t) => {
  const { base, site, root, registry } = await serving(t, { share: { scope: "tenant" }, source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" } });
  const rows = Array.from({ length: 400 }, (_, n) => ({ id: `r${n}`, values: { f1: { kind: "text", text: `第 ${n} 行的客户名称`, value: `第 ${n} 行的客户名称` } } }));
  await registry.putData(site.id, { schema: { fields: [{ id: "f1", name: "客户", kind: "text" }] }, snapshot: { rows, digest: "a1", readAt: 1 } });
  const capabilityOf = async (userId) => (await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId, tenantId: "t1" }, "idou_site") }, redirect: "manual" })).headers.get("location");
  const asSubresource = { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script", "accept-encoding": "gzip, deflate, br" };
  const first = await fetch(`${base}${await capabilityOf("ou_a")}data/table-data.js`, { headers: asSubresource });
  const second = await fetch(`${base}${await capabilityOf("ou_b")}data/table-data.js`, { headers: asSubresource });
  assert.equal(first.status, 200);
  const [one, two] = [Buffer.from(await first.arrayBuffer()), Buffer.from(await second.arrayBuffer())];
  assert.equal(one.equals(two), true, "the same bytes for every visitor");
  assert.equal(first.headers.get("etag"), second.headers.get("etag"));
  // fetch has already undone the compression; what went over the wire was smaller.
  const raw = await fetch(`${base}${await capabilityOf("ou_a")}data/table-data.js`, { headers: asSubresource });
  assert.equal(raw.headers.get("content-encoding"), "gzip");
  assert.ok(Number(raw.headers.get("content-length")) < one.length / 3, `${raw.headers.get("content-length")} of ${one.length}`);
  assert.match(one.toString(), /currentScript/, "where to ask again comes from the script's own address");
  assert.doesNotMatch(one.toString(), /~/, "no visitor's capability in what everybody gets");
  // Unchanged: nothing sent. Changed: sent again, under a new tag.
  const again = await fetch(`${base}${await capabilityOf("ou_a")}data/table-data.js`, { headers: { ...asSubresource, "if-none-match": first.headers.get("etag") } });
  assert.equal(again.status, 304);
  await registry.putData(site.id, { schema: { fields: [{ id: "f1", name: "客户", kind: "text" }] }, snapshot: { rows: rows.slice(1), digest: "a2", readAt: 2 } });
  const moved = await fetch(`${base}${await capabilityOf("ou_a")}data/table-data.js`, { headers: { ...asSubresource, "if-none-match": first.headers.get("etag") } });
  assert.equal(moved.status, 200);
  assert.notEqual(moved.headers.get("etag"), first.headers.get("etag"));
  // The data the page asks for when told the table changed: the same treatment.
  const data = await fetch(`${base}${await capabilityOf("ou_a")}_data`, { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "accept-encoding": "gzip" } });
  assert.equal(data.headers.get("content-encoding"), "gzip");
  assert.equal((await data.json()).snapshot.digest, "a2");
  assert.equal((await fetch(`${base}${await capabilityOf("ou_a")}_data`, { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "if-none-match": data.headers.get("etag") } })).status, 304);
  // A published file too: its version is its tag.
  const pageAt = `${base}${await capabilityOf("ou_a")}`;
  const opened = await fetch(pageAt, { headers: { cookie: await asVisitor(root, { userId: "ou_a", tenantId: "t1" }, "idou_site"), "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
  assert.equal(opened.status, 200);
  const cached = await fetch(pageAt, { headers: { cookie: await asVisitor(root, { userId: "ou_a", tenantId: "t1" }, "idou_site"), "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "if-none-match": opened.headers.get("etag") } });
  assert.equal(cached.status, 304);
  assert.match(opened.headers.get("content-security-policy"), /sandbox/, "still sandboxed");
});

test("a visitor's request does not read the data: it is read and compressed once per write, and kept compressed only", async (t) => {
  const { base, site, root, registry } = await serving(t, { share: { scope: "tenant" }, source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" } });
  let reads = 0;
  const real = registry.dataBytes.bind(registry);
  registry.dataBytes = async (id) => { reads += 1; return real(id); };
  // Past the size kept plain as well: 5,000 rows of a long text.
  const rows = Array.from({ length: 5000 }, (_, n) => ({ id: `r${n}`, values: { f1: { kind: "text", text: `第 ${n} 行的客户名称和一段说明`.padEnd(120, "。") } } }));
  const table = (digest, list = rows) => ({ schema: { fields: [{ id: "f1", name: "客户", kind: "text" }] }, snapshot: { rows: list, digest, readAt: 1 } });
  await registry.putData(site.id, table("a1"));
  const capabilityOf = async (userId) => (await fetch(`${base}/s/${site.id}/`, { headers: { cookie: await asVisitor(root, { userId, tenantId: "t1" }, "idou_site") }, redirect: "manual" })).headers.get("location");
  const script = { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script", "accept-encoding": "gzip" };
  const bodies = [];
  for (const who of ["ou_a", "ou_b", "ou_c"]) {
    const answer = await fetch(`${base}${await capabilityOf(who)}data/table-data.js`, { headers: script });
    assert.equal(answer.status, 200);
    bodies.push(Buffer.from(await answer.arrayBuffer()));
  }
  assert.equal(reads, 1, "three visitors, one read of the data");
  assert.ok(bodies[0].length > 1024 * 1024, `${bodies[0].length} bytes: past what is kept plain`);
  // A client that takes no gzip still gets the whole of it, inflated for it.
  const plain = await fetch(`${base}${await capabilityOf("ou_a")}data/table-data.js`, { headers: { ...script, "accept-encoding": "identity" } });
  assert.equal(plain.headers.get("content-encoding"), null);
  const plainBody = Buffer.from(await plain.arrayBuffer());
  assert.equal(plainBody.equals(bodies[0]), true);
  assert.equal(Number(plain.headers.get("content-length")), plainBody.length);
  const head = await fetch(`${base}${await capabilityOf("ou_a")}data/table-data.js`, { method: "HEAD", headers: { ...script, "accept-encoding": "identity" } });
  assert.equal(Number(head.headers.get("content-length")), plainBody.length);
  assert.equal(reads, 1, "nor for that");
  // A new write is read again, once, and served.
  await registry.putData(site.id, table("a2", rows.slice(1)));
  const moved = await fetch(`${base}${await capabilityOf("ou_a")}data/table-data.js`, { headers: script });
  assert.notEqual(Buffer.from(await moved.arrayBuffer()).equals(bodies[0]), true);
  await fetch(`${base}${await capabilityOf("ou_b")}data/table-data.js`, { headers: script }).then((answer) => answer.arrayBuffer());
  assert.equal(reads, 2);
});

test("the same visitor opening a site again is given the same address, so the browser's cache can answer", async (t) => {
  // Measured on a real 20,000-row Base (2026-10-06): a new capability at every
  // opening was a new address for every file, and the table's 737 KB went again each time.
  let clock = Date.parse("2026-10-06T01:00:00Z");
  const { base, site, root } = await serving(t, { share: { scope: "tenant" }, source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" }, now: () => clock });
  const { createHmac } = await import("node:crypto");
  const key = await siteCookieKey(root);
  const cookieFor = (userId, until) => {
    const payload = Buffer.from(JSON.stringify({ u: userId, t: "t1", e: until })).toString("base64url");
    return `idou_site=${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  };
  const week = clock + 7 * 86_400_000;
  const entry = async (cookie) => (await fetch(`${base}/s/${site.id}/`, { headers: { cookie }, redirect: "manual" })).headers.get("location");
  const first = await entry(cookieFor("ou_a", week));
  assert.match(first, new RegExp(`^/s/${site.id}/~`));
  clock += 60_000;
  assert.equal(await entry(cookieFor("ou_a", week)), first, "a minute later: the same address");
  assert.notEqual(await entry(cookieFor("ou_b", week)), first, "somebody else's is their own");
  // A sign-in ending sooner ends the capability with it -- and is as stable.
  const soon = clock + 3_600_000;
  const short = await entry(cookieFor("ou_a", soon));
  assert.notEqual(short, first);
  clock += 60_000;
  assert.equal(await entry(cookieFor("ou_a", soon)), short);
  // Past the step, a new one: an address does not stay valid for ever because it was once asked for.
  clock += 6 * 3_600_000;
  assert.notEqual(await entry(cookieFor("ou_a", week)), first);
  // The address it was given still opens the page, for its own visitor only.
  const page = await fetch(`${base}${first}`, { headers: { cookie: cookieFor("ou_a", week), "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, redirect: "manual" });
  assert.equal(page.status, 200);
});

test("capabilities end on a step of their own, never after the sign-in", async () => {
  const { capabilityUntil } = await import("../src/control-plane/site-server.js");
  const now = Date.parse("2026-10-06T01:23:45Z");
  const until = capabilityUntil(now);
  assert.equal(until % (6 * 3_600_000), 0, "on a six-hour boundary");
  assert.ok(until > now + 6 * 3_600_000 - 1 && until <= now + 12 * 3_600_000, new Date(until).toISOString());
  assert.equal(capabilityUntil(now + 60_000), until, "the same for a minute later");
  assert.equal(capabilityUntil(now, now + 3_600_000), now + 3_600_000, "the sign-in's end when it comes first");
});
