import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { SiteService } from "../src/control-plane/site-service.js";
import { appHash } from "../src/apps/manifest.js";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { SiteSafety } from "../src/control-plane/site-safety.js";
import { CHECKED_SITE_ROUTES, siteRequestTimeout } from "../src/application/site-requests.js";
import { CHAT_MODELS } from "../src/providers/codex/chat-models.js";
import { AccessList } from "../src/control-plane/access-list.js";
import { forgetPerson } from "../src/control-plane/person-data.js";

const body = "<!doctype html><h1>台账</h1>";
const pack = (text = body) => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html",
    files: [{ path: "index.html", bytes: Buffer.byteLength(text), sha256: appHash(Buffer.from(text)) }] },
  blobs: [{ path: "index.html", base64: Buffer.from(text).toString("base64") }],
});

async function serving(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-site-service-"));
  const registry = await SiteRegistry.open(root);
  const sessions = new SessionRegistry();
  const notified = [], audit = [];
  const service = new SiteService({ sessions, registry, origin: "https://sites.example",
    notify: (id, extra) => notified.push({ id, ...extra }), audit: (event) => audit.push(event), ...options });
  const server = createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); server.closeAllConnections?.(); await rm(root, { recursive: true, force: true }); });
  const feishu = sessions.issue({ tenantId: "t1", userId: "ou_owner", deviceId: "d1", authProvider: "feishu", appId: "cli_test", deviceProof: "ed25519-login" });
  const other = sessions.issue({ tenantId: "t1", userId: "ou_other", deviceId: "d2", authProvider: "feishu", appId: "cli_test", deviceProof: "ed25519-login" });
  const development = sessions.issue({ tenantId: "t1", userId: "ou_dev", deviceId: "d3" });
  const call = (route, payload, token = feishu.token, headers = {}) => fetch(`${base}${route}`, { method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(payload ?? {}) });
  return { registry, service, call, feishu, other, development, notified, audit, base, root };
}

test("publishing needs a Feishu session, and a browser can never ask at all", async (t) => {
  const { call, development, base } = await serving(t);
  assert.equal((await call("/v1/sites/list", {}, null)).status, 401);
  assert.equal((await call("/v1/sites/list", {}, "nonsense")).status, 401);
  assert.equal((await call("/v1/sites/list", {}, development.token)).status, 403);
  assert.equal((await call("/v1/sites/list", {}, undefined, { origin: "https://anything" })).status, 403);
  assert.equal((await fetch(`${base}/v1/sites/list`)).status, 405);
  assert.equal((await fetch(`${base}/v1/sites/nope`, { method: "POST" })).status, 404, "别的路径不归它管");
});

test("a development server may publish under a development session, when it says so", async (t) => {
  const { call, development } = await serving(t, { allowDevelopment: true });
  const answer = await call("/v1/sites/publish", { name: "开发", ...pack(), share: { scope: "invited" } }, development.token);
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).name, "开发");
});

test("publish, list, share, refresh and withdraw, each answering the owner only", async (t) => {
  const { call, other, notified, audit, service } = await serving(t);
  const published = await (await call("/v1/sites/publish", { name: "客户看板", ...pack(), share: { scope: "invited" },
    source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" },
    data: { schema: { fields: [] }, snapshot: { digest: "d1", rows: [] } } })).json();
  assert.match(published.url, /^https:\/\/sites\.example\/s\/[0-9a-f-]{36}\/$/);
  assert.equal(published.sourced, true);
  assert.equal(service.link(published.id), published.url);
  assert.deepEqual(notified, [{ id: published.id }]);
  assert.equal(audit.at(-1).event, "site-published");

  const listed = await (await call("/v1/sites/list")).json();
  assert.deepEqual(listed.sites.map((site) => site.id), [published.id]);
  assert.equal(listed.anonymousAllowed, false);
  assert.deepEqual((await (await call("/v1/sites/list", {}, other.token)).json()).sites, [], "别人的列表里没有我的网站");

  const shared = await (await call("/v1/sites/share", { siteId: published.id, share: { scope: "tenant", inherit: true } })).json();
  assert.deepEqual(shared.share, { scope: "tenant", inherit: true, members: [] });
  assert.equal(audit.at(-1).event, "site-share-changed");
  // Refused before anything is read for it -- the bot is not asked about groups for a site that is not theirs.
  assert.equal((await call("/v1/sites/share", { siteId: published.id, share: { scope: "tenant" } }, other.token)).status, 403);

  const refreshed = await (await call("/v1/sites/data", { siteId: published.id, schema: { fields: [] }, snapshot: { digest: "d2", rows: [] } })).json();
  assert.equal(refreshed.digest, "d2");
  assert.deepEqual(notified.at(-1), { id: published.id });
  // The desktop re-reads the table on a clock, so the same numbers arrive over
  // and over. Waking every open page for those would be the whole payload
  // fetched again, every interval, for nothing.
  const quiet = notified.length;
  await call("/v1/sites/data", { siteId: published.id, schema: { fields: [] }, snapshot: { digest: "d2", rows: [] } });
  assert.equal(notified.length, quiet, "数据没变也通知了页面");
  await call("/v1/sites/data", { siteId: published.id, schema: { fields: [] }, snapshot: { digest: "d2b", rows: [] } });
  assert.equal(notified.length, quiet + 1, "数据变了却没通知页面");
  assert.equal((await call("/v1/sites/data", { siteId: published.id, snapshot: { digest: "d3" } }, other.token)).status, 403);

  assert.equal((await call("/v1/sites/withdraw", { siteId: published.id }, other.token)).status, 403);
  assert.deepEqual(await (await call("/v1/sites/withdraw", { siteId: published.id })).json(), { withdrawn: true, kept: true });
  assert.deepEqual(notified.at(-1), { id: published.id, gone: true });
  // Offline, not gone: still listed, still the owner's, and one call from back up.
  const offline = (await (await call("/v1/sites/list")).json()).sites;
  assert.deepEqual(offline.map((site) => [site.id, site.offline]), [[published.id, true]]);
  const back = await (await call("/v1/sites/republish", { siteId: published.id })).json();
  assert.equal(back.offline, false);
  assert.equal(back.version, published.version, "同一个版本，没有再传一次");
  assert.equal(audit.at(-1).event, "site-republished");
  assert.equal((await call("/v1/sites/republish", { siteId: published.id }, other.token)).status, 400);
  // Erasing is the one that really removes it.
  assert.deepEqual(await (await call("/v1/sites/erase", { siteId: published.id })).json(), { erased: true });
  assert.deepEqual((await (await call("/v1/sites/list")).json()).sites, []);
});

test("anonymous sharing is the deployment's decision, and the answer says so", async (t) => {
  const closed = await serving(t);
  assert.equal(closed.service.anonymousAllowed, false);
  const refused = await closed.call("/v1/sites/publish", { name: "公开", ...pack(), share: { scope: "anyone" } });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /没有开放/);

  const open = await serving(t, { anonymousAllowed: true });
  const published = await (await open.call("/v1/sites/publish", { name: "公开", ...pack(), share: { scope: "anyone" } })).json();
  assert.equal(published.share.scope, "anyone");
  assert.equal((await (await open.call("/v1/sites/list")).json()).anonymousAllowed, true);
});

test("a version package that does not hold together is refused with its reason", async (t) => {
  const { call, notified } = await serving(t);
  const broken = pack();
  broken.blobs[0].base64 = Buffer.from("something else").toString("base64");
  const answer = await call("/v1/sites/publish", { name: "坏的", ...broken, share: { scope: "invited" } });
  assert.equal(answer.status, 400);
  assert.match((await answer.json()).error, /与清单不一致/);
  assert.deepEqual(notified, []);
  assert.equal((await call("/v1/sites/publish", { name: "空的", share: { scope: "invited" } })).status, 400);
  assert.equal((await call("/v1/sites/share", { share: { scope: "tenant" } })).status, 400, "没有网站标识");
});

// An administrator turned publishing, or links for anyone, off for this
// person (policy.js): refused before anything is written, in those words.
test("publishing and links for anyone are refused when an administrator turned them off", async (t) => {
  const denied = new Set(["sitesAnonymous"]);
  const { call, registry } = await serving(t, { policy: { permits: async (who, feature) => !denied.has(feature) } });
  const site = { name: "看板", ...pack() };
  const open = await call("/v1/sites/publish", { ...site, share: { scope: "anyone" } });
  assert.equal(open.status, 403);
  assert.match((await open.json()).error, /互联网上获得链接的人可阅读/);
  assert.equal((await call("/v1/sites/publish", { ...site, share: { scope: "tenant" } })).status, 200, "inside the organisation is still allowed");
  denied.add("sitesPublish");
  const none = await call("/v1/sites/publish", { ...site, share: { scope: "tenant" } });
  assert.equal(none.status, 403);
  assert.match((await none.json()).error, /管理员没有给你开放发布文档网站/);
  assert.equal(registry.list().length, 1, "nothing written by the refused ones");
});

test("a site an administrator took down: its owner sees it held, with the reason, and is told that reason when trying to bring it back", async (t) => {
  const { registry, call } = await serving(t);
  const published = await (await call("/v1/sites/publish", { name: "客户名单", ...pack(), share: { scope: "tenant" } })).json();
  await registry.hold(published.id, { by: { userId: "ou_admin", name: "管理员" }, reason: "包含客户电话" });
  const listed = (await (await call("/v1/sites/list")).json()).sites[0];
  assert.deepEqual({ offline: listed.offline, reason: listed.held.reason }, { offline: true, reason: "包含客户电话" });
  for (const [route, payload] of [["/v1/sites/republish", {}], ["/v1/sites/share", { share: { scope: "invited" } }], ["/v1/sites/erase", {}]]) {
    const refused = await call(route, { siteId: published.id, ...payload });
    assert.equal(refused.status, 400, route);
    assert.match((await refused.json()).error, /管理员下线了这个网站（包含客户电话），要恢复请联系管理员/, route);
  }
});

// Content safety on the way in (site-safety.js), through the routes the
// desktop calls: refused with the reason, waiting with the site offline, or
// recorded -- and never shown before it is checked.
async function guarded(t, { verdict = null } = {}) {
  const db = await openAdminDatabase();
  const safety = await SiteSafety.open({ db, key: "a-server-key-of-thirty-two-bytes!", moderate: verdict ? async () => verdict : null });
  t.after(async () => { await safety.close(); await db.close(); });
  return { ...(await serving(t, { safety, anonymousAllowed: true })), safety };
}
const ID_NUMBER = (() => { const b = "11010519900101123"; const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]; return b + "10X98765432"[w.reduce((t, x, i) => t + x * Number(b[i]), 0) % 11]; })();
const table = (value) => ({ schema: { fields: [{ id: "f1", name: "联系方式" }] }, snapshot: { digest: `d-${value}`, rows: [{ id: "r1", values: { f1: { kind: "text", value } } }] } });

test("a public site with a phone number waits offline for an administrator; one with an identity number is refused and nothing is kept", async (t) => {
  const { call, registry, audit } = await guarded(t);
  const waiting = await call("/v1/sites/publish", { name: "联系表", ...pack("<p>13812345678</p>"), share: { scope: "anyone" } });
  assert.equal(waiting.status, 200);
  const site = await waiting.json();
  assert.deepEqual({ offline: site.offline, state: site.review.state }, { offline: true, state: "pending" });
  assert.match(site.review.reason, /发现 1 处手机号。等管理员审核通过后才会上线/);
  assert.equal(audit.at(-1).event, "site-published");
  assert.ok(audit.some((event) => event.event === "site-review" && event.siteId === site.id));
  const back = await call("/v1/sites/republish", { siteId: site.id });
  assert.equal(back.status, 400);
  assert.match((await back.json()).error, /等待管理员审核/);

  const refused = await call("/v1/sites/publish", { name: "名单", ...pack(`<p>${ID_NUMBER}</p>`), share: { scope: "anyone" } });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /公开网站不允许包含身份证号（发现 1 处身份证号，例如 index.html 第 1 行），没有发布/);
  assert.deepEqual(registry.list().map((item) => item.name), ["联系表"], "nothing kept of what was refused");
  assert.ok(audit.some((event) => event.event === "site-refused"));
  // Inside the organisation the same phone number is recorded and the site is up.
  const inside = await (await call("/v1/sites/publish", { name: "内部联系表", ...pack("<p>13812345678</p>"), share: { scope: "tenant" } })).json();
  assert.deepEqual([inside.offline, inside.review], [false, null]);
  // Shared inside instead, the waiting one is up.
  const moved = await (await call("/v1/sites/share", { siteId: site.id, share: { scope: "tenant" } })).json();
  assert.deepEqual([moved.offline, moved.review], [false, null]);
  // Saving the same sharing again is no check and ends no wait.
  const third = await (await call("/v1/sites/publish", { name: "又一个", ...pack("<p>13900001111</p>"), share: { scope: "anyone" } })).json();
  const resaved = await (await call("/v1/sites/share", { siteId: third.id, share: { scope: "anyone" } })).json();
  assert.equal(resaved.review.state, "pending", "re-checked, still waiting -- not cleared by saving the sharing again");
});

test("new data for a public site is checked before it is shown: refused data is not written, the page keeps what it had", async (t) => {
  const { call, registry } = await guarded(t);
  const site = await (await call("/v1/sites/publish", { name: "看板", ...pack(), share: { scope: "anyone" }, data: table("暂无") })).json();
  assert.equal(site.offline, false);
  const refused = await call("/v1/sites/data", { siteId: site.id, ...table("13812345678") });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /这次的数据没有更新到线上/);
  assert.equal((await registry.data(site.id)).snapshot.digest, "d-暂无", "the page keeps what it showed");
  assert.equal((await call("/v1/sites/data", { siteId: site.id, ...table("已更新") })).status, 200);
  assert.equal((await registry.data(site.id)).snapshot.digest, "d-已更新");
  assert.equal((await call("/v1/sites/data", { siteId: site.id, ...table("已更新") })).status, 200, "the same data again is not checked again");
});

test("a credential is refused whoever the site is for; the model's doubt makes a public site wait", async (t) => {
  const { call } = await guarded(t, { verdict: { verdict: "review", categories: ["advertising"], reason: "引导加私人微信" } });
  const secret = await call("/v1/sites/publish", { name: "工具", ...pack("<script>const k = 'sk-a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'</script>"), share: { scope: "invited" } });
  assert.equal(secret.status, 422);
  assert.match((await secret.json()).error, /不允许包含密钥或凭据/);
  const doubted = await (await call("/v1/sites/publish", { name: "促销", ...pack("<p>优惠请加微信</p>"), share: { scope: "anyone" } })).json();
  assert.deepEqual([doubted.offline, doubted.review.state], [true, "pending"]);
  assert.match(doubted.review.reason, /AI 审核：引导加私人微信/);
});

// What the desktop waits for (site-requests.js) against what the server does:
// every request the server checks first can wait on the model reading the page,
// up to the longest allowance a model has; given up on sooner, the site still
// goes up while its owner is told it failed. Found in review before .270: the
// desktop gave every request 60 seconds, the MiniMax reading alone may take 90.
test("every request the server checks before it shows anything, the desktop waits for long enough", async (t) => {
  const { call, safety } = await guarded(t);
  const checkedBy = new Set();
  let route = null;
  const assess = safety.assess.bind(safety);
  safety.assess = async (args) => { checkedBy.add(route); return assess(args); };
  const send = async (path, payload) => { route = path; const answer = await call(path, payload); assert.ok(answer.status < 500, `${path}: ${answer.status}`); return answer.json(); };
  const site = await send("/v1/sites/publish", { name: "看板", ...pack(), share: { scope: "tenant" }, data: table("一月") });
  await send("/v1/sites/list", {});
  await send("/v1/sites/share", { siteId: site.id, share: { scope: "anyone" } });
  await send("/v1/sites/data", { siteId: site.id, ...table("二月") });
  await send("/v1/sites/publish", { siteId: site.id, name: "看板", ...pack("<h1>第二版</h1>"), share: { scope: "anyone" } });
  await send("/v1/sites/versions", { siteId: site.id });
  await send("/v1/sites/files", { siteId: site.id, version: site.version });
  await send("/v1/sites/rollback", { siteId: site.id, version: site.version });
  await send("/v1/sites/withdraw", { siteId: site.id });
  await send("/v1/sites/republish", { siteId: site.id });
  await send("/v1/sites/erase", { siteId: site.id });
  assert.deepEqual([...checkedBy].sort(), [...CHECKED_SITE_ROUTES].sort(), "the routes that check are the ones the desktop waits long for");
  const longest = Math.max(...Object.values(CHAT_MODELS).map((model) => model.sideCalls.proposal.timeoutMs));
  for (const path of checkedBy) assert.ok(siteRequestTimeout(path) >= longest + 30_000, `${path} waits ${siteRequestTimeout(path)} ms against a reading of up to ${longest}`);
});

// Found in the third review before .270. A change that waits minutes on its
// content check is written only while the site is still what was checked: the
// owner's 取消发布 in the meantime, another publish that got there first, or
// the owner being offboarded, each make it refused rather than undone.
// `hold(trigger)` holds every check of that kind until `release()`; `pass()` lets
// later ones through while those already held stay held.
const holding = (safety) => {
  let release = () => {}, gate = null, open = true;
  const close = () => { open = false; gate = new Promise((resolve) => { release = () => { open = true; resolve(); }; }); };
  const held = new Set();
  const assess = safety.assess.bind(safety);
  // A check waits on the gate that was closed when it came.
  safety.assess = async (args) => { if (held.has(args.trigger)) await gate; return assess(args); };
  return { hold: (trigger) => { if (open) close(); held.add(trigger); }, release: () => release(), pass: () => held.clear() };
};

test("taking a site down while its update is being checked is not undone when the update lands", async (t) => {
  const { call, registry, safety } = await guarded(t);
  const checks = holding(safety);
  const site = await (await call("/v1/sites/publish", { name: "看板", ...pack("<p>第一版</p>"), share: { scope: "anyone" } })).json();
  checks.hold("update");
  const updating = call("/v1/sites/publish", { siteId: site.id, name: "看板", ...pack("<p>第二版，发错了</p>"), share: { scope: "anyone" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await (await call("/v1/sites/withdraw", { siteId: site.id })).json(), { withdrawn: true, kept: true });
  checks.release();
  const answer = await updating;
  assert.equal(answer.status, 409);
  assert.match((await answer.json()).error, /检查期间有了变化/);
  assert.deepEqual([registry.get(site.id).offline, registry.get(site.id).version], [true, site.version], "still down, still the first version");
});

test("a first publish given up on, landing after a later one under the same id, does not overwrite it", async (t) => {
  const { call, registry, safety } = await guarded(t);
  const checks = holding(safety);
  const id = "6f0d2c1e-0000-4000-8000-0000000000aa";
  checks.hold("publish");
  const abandoned = call("/v1/sites/publish", { siteId: id, name: "报名页", ...pack("<p>旧的</p>"), share: { scope: "anyone" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  checks.pass();
  const later = await call("/v1/sites/publish", { siteId: id, name: "报名页", ...pack("<p>新的</p>"), share: { scope: "tenant" } });
  assert.equal(later.status, 200);
  const kept = await later.json();
  checks.release();
  assert.equal((await abandoned).status, 409);
  assert.deepEqual([registry.get(id).version, registry.get(id).share.scope], [kept.version, "tenant"]);
});

test("a person offboarded while their publish is being checked publishes nothing", async (t) => {
  const db = await openAdminDatabase();
  const access = await AccessList.open({ db });
  t.after(async () => { access.close(); await db.close(); });
  const safetyDb = await openAdminDatabase();
  const safety = await SiteSafety.open({ db: safetyDb, key: "a-server-key-of-thirty-two-bytes!" });
  t.after(async () => { await safety.close(); await safetyDb.close(); });
  const { call, registry, feishu } = await serving(t, { safety, access, anonymousAllowed: true });
  const checks = holding(safety);
  const offline = await (await call("/v1/sites/publish", { name: "旧页", ...pack("<p>旧页</p>"), share: { scope: "anyone" } })).json();
  await call("/v1/sites/withdraw", { siteId: offline.id });
  checks.hold("publish"); checks.hold("republish");
  const first = call("/v1/sites/publish", { name: "新页", ...pack("<p>新页</p>"), share: { scope: "anyone" } });
  const back = call("/v1/sites/republish", { siteId: offline.id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The console's 离职清理: disabled, then everything of theirs taken down.
  const who = { tenantId: feishu.tenantId ?? "t1", userId: "ou_owner" };
  await access.disable([who], { reason: "离职", by: { userId: "ou_admin" } });
  const cleaning = forgetPerson({ who, sites: registry });
  checks.release();
  const [published, republished] = await Promise.all([first, back]);
  await cleaning;
  assert.deepEqual([published.status, republished.status], [403, 403]);
  assert.deepEqual(registry.list({ ownerId: "ou_owner" }).filter((site) => !site.offline), [], "nothing of theirs is up");
});

// Fourth review before .270: on a site waiting for review or turned down -- it
// is offline already -- 取消发布 changed only what the review returns it to,
// which the stamp did not cover, and an update checked meanwhile put it up.
test("取消发布 on a site waiting for review, or turned down, while an update is checked, is not undone either", async (t) => {
  const { call, registry, safety } = await guarded(t);
  const checks = holding(safety);
  for (const state of ["pending", "rejected"]) {
    const site = await (await call("/v1/sites/publish", { name: state, ...pack(`<p>${state} 13812345678</p>`), share: { scope: "anyone" } })).json();
    assert.equal(registry.get(site.id).review.state, "pending");
    if (state === "rejected") await registry.reject(site.id, { by: { userId: "ou_admin" }, reason: "删掉手机号" });
    checks.hold("update");
    const updating = call("/v1/sites/publish", { siteId: site.id, name: state, ...pack(`<p>${state} 改好了</p>`), share: { scope: "anyone" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await call("/v1/sites/withdraw", { siteId: site.id });
    checks.release();
    assert.equal((await updating).status, 409, state);
    assert.equal(registry.get(site.id).offline, true, `${state}: still down`);
    checks.pass();
  }
});

// Fifth review before .270: saving the same sharing again re-ran the check, and
// a reading that passed now -- the model answering where it had not -- ended a
// wait, or an administrator's 不通过.
test("the same sharing saved again, or a collaborator added, ends no wait and no 不通过", async (t) => {
  let answering = false;
  const db = await openAdminDatabase();
  const safety = await SiteSafety.open({ db, key: "a-server-key-of-thirty-two-bytes!",
    moderate: async () => answering ? { verdict: "pass", categories: [], reason: "" } : { verdict: "review", categories: [], reason: "模型没有回答（HTTP 529）", failed: true } });
  t.after(async () => { await safety.close(); await db.close(); });
  const { call, registry } = await serving(t, { safety, anonymousAllowed: true });
  for (const state of ["pending", "rejected"]) {
    answering = false;
    const site = await (await call("/v1/sites/publish", { name: state, ...pack(`<p>${state} 产品介绍</p>`), share: { scope: "anyone" } })).json();
    assert.equal(registry.get(site.id).review.state, "pending", "the model did not answer: it waits");
    if (state === "rejected") await registry.reject(site.id, { by: { userId: "ou_admin" }, reason: "再看看" });
    answering = true;
    assert.equal((await call("/v1/sites/share", { siteId: site.id, share: { scope: "anyone", members: [{ type: "user", id: "ou_colleague", name: "同事" }] } })).status, 200);
    assert.deepEqual([registry.get(site.id).review.state, registry.get(site.id).offline], [state, true], `${state}: as it was`);
  }
});

test("new data for a site that is gone is answered as that, not as a server without sites", async (t) => {
  const { call } = await serving(t);
  const answer = await call("/v1/sites/data", { siteId: "6f0d2c1e-0000-4000-8000-0000000000dd", schema: null, snapshot: { digest: "d", rows: [] } });
  assert.equal(answer.status, 400, "the desktop reads a 404 as 「这个服务端还没有开启文档网站」");
  assert.match((await answer.json()).error, /找不到这个网站/);
});

// docs/sites-phase0.md §0.4, found in the 2026-10-03 benchmark: 仅邀请的人 let
// in the owner alone -- the desktop never sent anybody. People, groups and
// departments can now be added; a group the application's bot cannot read is
// refused up front, since nobody in it could ever be let in; and the names the
// owner saw are kept for showing.
test("collaborators: people, groups the bot can read, departments from the organisation, with their names kept", async (t) => {
  const readable = new Set(["oc_sales"]);
  const groups = { members: async (chatId) => { if (!readable.has(chatId)) throw new Error("bot not in chat"); return new Set(["ou_in_group"]); } };
  const departments = { search: async (tenantId, text) => (tenantId === "t1" && text.includes("销售") ? [{ id: "od-sales", name: "销售部", trail: ["总部", "销售部"], memberCount: 12 }] : []) };
  const { call } = await serving(t, { groups, departments });
  const found = await (await call("/v1/sites/departments", { query: "销售" })).json();
  assert.deepEqual(found, { available: true, departments: [{ id: "od-sales", name: "销售部", trail: ["总部", "销售部"], members: 12 }] });
  const share = (members) => ({ scope: "invited", members });
  const refused = await call("/v1/sites/publish", { name: "台账", ...pack(), share: share([{ type: "chat", id: "oc_secret", name: "保密群" }]) });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /应用机器人不在群「保密群」里/);
  const published = await (await call("/v1/sites/publish", { name: "台账", ...pack(), share: share([
    { type: "user", id: "ou_colleague", name: "张三" }, { type: "chat", id: "oc_sales", name: "销售群" }, { type: "department", id: "od-sales", name: "销售部" }]) })).json();
  assert.deepEqual(published.share.members.map((member) => [member.type, member.id, member.name]),
    [["user", "ou_colleague", "张三"], ["chat", "oc_sales", "销售群"], ["department", "od-sales", "销售部"]]);
  // Changing it later checks the same way.
  const later = await call("/v1/sites/share", { siteId: published.id, share: share([{ type: "chat", id: "oc_secret", name: "保密群" }]) });
  assert.equal(later.status, 400);
  // Without an organisation to search, said plainly rather than an empty list that looks like "none".
  const bare = await serving(t);
  assert.deepEqual(await (await bare.call("/v1/sites/departments", { query: "销售" })).json(), { departments: [], available: false });
});

// Versions and going back (docs/sites-phase0.md §0.6). A site kept its last
// three versions and nothing could reach them: a bad update stayed up until
// its owner rebuilt the old page by hand.
test("a site goes back to a version it keeps, and the newer one is kept to come back to", async (t) => {
  const { call, other, audit, notified, registry } = await serving(t);
  const first = await (await call("/v1/sites/publish", { name: "台账", ...pack("<h1>一版</h1>"), share: { scope: "tenant" } })).json();
  const second = await (await call("/v1/sites/publish", { siteId: first.id, name: "台账", ...pack("<h1>二版</h1>"), share: { scope: "tenant" } })).json();
  const listed = await (await call("/v1/sites/versions", { siteId: first.id })).json();
  assert.deepEqual(listed.versions.map((row) => [row.version, row.current, row.files, row.bytes]),
    [[second.version, true, 1, Buffer.byteLength("<h1>二版</h1>")], [first.version, false, 1, Buffer.byteLength("<h1>一版</h1>")]]);
  assert.ok(listed.versions.every((row) => typeof row.publishedAt === "number"), "each version says when it went up");
  // A kept version, to look at before deciding: its own files, as they were.
  const looked = await (await call("/v1/sites/files", { siteId: first.id, version: first.version })).json();
  assert.equal(looked.version, first.version);
  assert.equal(Buffer.from(looked.blobs[0].base64, "base64").toString(), "<h1>一版</h1>");
  assert.equal(looked.manifest.entry, "index.html");

  // Only its owner sees them, and only its owner goes back.
  for (const route of ["/v1/sites/versions", "/v1/sites/files", "/v1/sites/rollback"]) {
    assert.equal((await call(route, { siteId: first.id, version: first.version }, other.token)).status, 403, route);
  }
  const back = await call("/v1/sites/rollback", { siteId: first.id, version: first.version });
  assert.equal(back.status, 200);
  const now = await back.json();
  assert.deepEqual([now.version, now.offline, now.url], [first.version, false, `https://sites.example/s/${first.id}/`]);
  assert.equal(audit.at(-1).event, "site-rolled-back");
  assert.equal(audit.at(-1).version, first.version);
  assert.equal(notified.at(-1).id, first.id, "open pages are told");
  assert.equal((await registry.file(first.id, "/")).bytes.toString(), "<h1>一版</h1>", "what a visitor gets now");
  const after = (await (await call("/v1/sites/versions", { siteId: first.id })).json()).versions;
  assert.deepEqual(after.map((row) => [row.version, row.current]), [[first.version, true], [second.version, false]], "the newer one is still there");

  // Nothing to go back to: the one already up, or one it does not keep.
  const same = await call("/v1/sites/rollback", { siteId: first.id, version: first.version });
  assert.equal(same.status, 400);
  assert.match((await same.json()).error, /已经是线上的版本/);
  const unknown = await call("/v1/sites/rollback", { siteId: first.id, version: "0".repeat(64) });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /没有保留这一版/);

  // Taken down by its owner: going back is publishing that version, so it is up again.
  await call("/v1/sites/withdraw", { siteId: first.id });
  const up = await (await call("/v1/sites/rollback", { siteId: first.id, version: second.version })).json();
  assert.deepEqual([up.version, up.offline], [second.version, false]);
  // Held by an administrator: nothing its owner does brings it back.
  await registry.hold(first.id, { by: { userId: "ou_admin" }, reason: "核查中" });
  const held = await call("/v1/sites/rollback", { siteId: first.id, version: first.version });
  assert.equal(held.status, 400);
  assert.match((await held.json()).error, /管理员下线了这个网站（核查中）/);
  assert.equal(registry.get(first.id).version, second.version);
});

test("a kept version whose files no longer match is not put up", async (t) => {
  const { call, registry, root } = await serving(t);
  const first = await (await call("/v1/sites/publish", { name: "台账", ...pack("<h1>一版</h1>"), share: { scope: "tenant" } })).json();
  const second = await (await call("/v1/sites/publish", { siteId: first.id, name: "台账", ...pack("<h1>二版</h1>"), share: { scope: "tenant" } })).json();
  const { createHash } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(root, first.id, first.version, `${createHash("sha256").update("index.html").digest("hex")}.blob`), "<h1>被改过</h1>");
  for (const route of ["/v1/sites/rollback", "/v1/sites/files"]) {
    const refused = await call(route, { siteId: first.id, version: first.version });
    assert.equal(refused.status, 400, route);
    assert.match((await refused.json()).error, /与发布时的清单不一致/);
  }
  assert.equal(registry.get(first.id).version, second.version, "the version up stays up");
});

// Going back is checked under today's audience, not the one the old version
// went up under: a phone number fine inside the organisation waits for an
// administrator once the site is public.
test("going back to a version is checked again for who may read the site now", async (t) => {
  const { call, audit } = await guarded(t);
  const first = await (await call("/v1/sites/publish", { name: "联系表", ...pack("<p>13812345678</p>"), share: { scope: "tenant" } })).json();
  assert.equal(first.offline, false, "inside the organisation it is up");
  const second = await (await call("/v1/sites/publish", { siteId: first.id, name: "联系表", ...pack("<p>请在飞书里联系</p>"), share: { scope: "tenant" } })).json();
  const opened = await (await call("/v1/sites/share", { siteId: first.id, share: { scope: "anyone" } })).json();
  assert.equal(opened.offline, false);
  const back = await (await call("/v1/sites/rollback", { siteId: first.id, version: first.version })).json();
  assert.deepEqual([back.version, back.offline, back.review?.state], [first.version, true, "pending"]);
  assert.match(back.review.reason, /手机号/);
  assert.ok(audit.some((event) => event.event === "site-review" && event.trigger === "rollback"));
  // And forward again to the clean one: up, the wait over.
  const forward = await (await call("/v1/sites/rollback", { siteId: first.id, version: second.version })).json();
  assert.deepEqual([forward.version, forward.offline, forward.review], [second.version, false, null]);
});

// Found reviewing phase 0 (2026-10-03): sharing asked the bot about every group
// named before checking that the site was the caller's or the ids were ids, and
// the answer -- kept forever -- grew the server with each request.
test("nothing is asked of the bot for a share that is not the caller's or not well formed", async (t) => {
  const read = [];
  const groups = { members: async (id) => { read.push(id); return new Set(); } };
  const { call, other } = await serving(t, { groups });
  const site = await (await call("/v1/sites/publish", { name: "台账", ...pack(), share: { scope: "invited" } })).json();
  assert.equal((await call("/v1/sites/share", { siteId: site.id, share: { scope: "invited", members: [{ type: "chat", id: "oc_a" }] } }, other.token)).status, 403);
  assert.equal((await call("/v1/sites/share", { siteId: "missing", share: { scope: "invited", members: [{ type: "chat", id: "oc_a" }] } })).status, 400);
  const huge = await call("/v1/sites/share", { siteId: site.id, share: { scope: "invited", members: [{ type: "chat", id: "x".repeat(4096) }] } });
  assert.equal(huge.status, 400);
  assert.match((await huge.json()).error, /协作者无效/);
  assert.deepEqual(read, [], "the bot was asked about nothing");
  assert.equal((await call("/v1/sites/share", { siteId: site.id, share: { scope: "invited", members: [{ type: "chat", id: "oc_sales", name: "销售群" }] } })).status, 200);
  assert.deepEqual(read, ["oc_sales"]);
  // What this server can do, for the desktop to offer only that.
  assert.deepEqual((await (await call("/v1/sites/list", {})).json()).features, ["versions", "addresses", "compressed-requests", "groups"]);
});

test("going back to the version up, or to one not kept, is refused before anything is checked", async (t) => {
  const { call, safety } = await guarded(t);
  const first = await (await call("/v1/sites/publish", { name: "台账", ...pack("<h1>一版</h1>"), share: { scope: "tenant" } })).json();
  let checks = 0;
  const assess = safety.assess.bind(safety);
  safety.assess = async (args) => { checks += 1; return assess(args); };
  assert.equal((await call("/v1/sites/rollback", { siteId: first.id, version: first.version })).status, 400);
  assert.equal((await call("/v1/sites/rollback", { siteId: first.id, version: "1".repeat(64) })).status, 400);
  assert.equal(checks, 0, "no check recorded, nothing sent to an administrator");
});

test("a site's address name is set by its owner, and its link then reads by it", async (t) => {
  const { call, other, audit } = await serving(t);
  const site = await (await call("/v1/sites/publish", { name: "台账", ...pack(), share: { scope: "tenant" } })).json();
  assert.equal((await call("/v1/sites/address", { siteId: site.id, address: "销售台账" }, other.token)).status, 403);
  const named = await (await call("/v1/sites/address", { siteId: site.id, address: "销售台账" })).json();
  assert.equal(named.url, `https://sites.example/s/${encodeURIComponent("销售台账")}/`);
  assert.equal(audit.at(-1).event, "site-address-changed");
  const listed = (await (await call("/v1/sites/list", {})).json()).sites[0];
  assert.deepEqual([listed.address, listed.url], ["销售台账", named.url]);
  const refused = await call("/v1/sites/address", { siteId: site.id, address: "x" });
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error, /地址名要 2 到 40 个字/);
  const cleared = await (await call("/v1/sites/address", { siteId: site.id, address: null })).json();
  assert.equal(cleared.url, `https://sites.example/s/${site.id}/`);
});

test("who opened a site is its owner's to see, and only theirs", async (t) => {
  const asked = [];
  const visitors = { stats: async (tenantId, siteId) => { asked.push([tenantId, siteId]); return { views: 3, people: 2, days: [], departments: [], sources: {} }; } };
  const { call, other } = await serving(t, { visitors });
  const site = await (await call("/v1/sites/publish", { name: "台账", ...pack(), share: { scope: "tenant" } })).json();
  assert.equal((await call("/v1/sites/stats", { siteId: site.id }, other.token)).status, 403);
  assert.deepEqual(await (await call("/v1/sites/stats", { siteId: site.id })).json(), { views: 3, people: 2, days: [], departments: [], sources: {} });
  assert.deepEqual(asked, [["t1", site.id]]);
  assert.ok((await (await call("/v1/sites/list", {})).json()).features.includes("stats"));
});

test("a table's data may come compressed and up to 32 MB; every other route keeps its old limit", async (t) => {
  const { gzipSync } = await import("node:zlib");
  const { SITE_LIMITS } = await import("../src/control-plane/site-registry.js");
  const { base, call, feishu, registry } = await serving(t);
  const listed = await (await call("/v1/sites/list", {})).json();
  assert.ok(listed.features.includes("compressed-requests"));
  assert.deepEqual(listed.limits, { dataBytes: SITE_LIMITS.dataBytes }, "said, so the desktop can say it before sending");
  const site = await (await call("/v1/sites/publish", { name: "大表", ...pack(), share: { scope: "invited" }, source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" } })).json();
  const zipped = (payload, headers = {}) => fetch(`${base}/v1/sites/data`, { method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${feishu.token}`, ...headers }, body: gzipSync(Buffer.from(JSON.stringify(payload))) });
  // 20,000 rows' worth: past the 14 MB a body could be before, and past the 8 MB data could be.
  const rows = Array.from({ length: 20_000 }, (_, at) => ({ id: `rec${at}`, values: { fldName: { text: `客户 ${at} ${"·".repeat(400)}`, kind: "text" } } }));
  const big = { siteId: site.id, schema: { fields: [] }, snapshot: { digest: "big", rows } };
  assert.ok(Buffer.byteLength(JSON.stringify(big)) > 14 * 1024 * 1024);
  const answer = await zipped(big);
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.equal((await registry.data(site.id)).snapshot.rows.length, 20_000);
  // Uncompressed too, from a desktop that did not ask first.
  assert.equal((await call("/v1/sites/data", { ...big, snapshot: { ...big.snapshot, digest: "big2" } })).status, 200);
  // A small body that inflates past the limit is stopped as it inflates.
  const bomb = await fetch(`${base}/v1/sites/data`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${feishu.token}` },
    body: gzipSync(Buffer.from(`{"siteId":"${site.id}","pad":"${"0".repeat(SITE_LIMITS.dataBytes + 2 * 1024 * 1024)}"}`)) });
  assert.equal(bomb.status, 413);
  assert.match((await bomb.json()).error, /表格数据超过了服务端能存的上限/);
  assert.equal((await zipped({}, { "content-encoding": "br" })).status, 415);
  const broken = await fetch(`${base}/v1/sites/data`, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${feishu.token}` }, body: "not gzip" });
  assert.equal(broken.status, 400);
  // Sharing has nothing big to carry, and is held to what it always was.
  const huge = await call("/v1/sites/share", { siteId: site.id, share: { scope: "invited" }, pad: "x".repeat(15 * 1024 * 1024) });
  assert.equal(huge.status, 413);
  assert.equal((await huge.json()).error, "版本包太大");
});
