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
  return { registry, service, call, feishu, other, development, notified, audit, base };
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
  assert.equal((await call("/v1/sites/share", { siteId: published.id, share: { scope: "tenant" } }, other.token)).status, 400);

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
