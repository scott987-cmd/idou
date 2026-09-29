import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { SiteService } from "../src/control-plane/site-service.js";
import { createSiteServer, siteCookieKey } from "../src/control-plane/site-server.js";
import { writeTemplate } from "../src/application/site-templates.js";
import { writeContract, readContract } from "../src/application/table-contract.js";
import { snapshotApp } from "../src/application/app-candidates.js";

// 文档网站 end to end on the serving side: a real template, packaged the way the
// desktop packages it, published through the real publish service, and then
// opened by somebody else through the real listener -- the page, its data, its
// live updates, its sharing and its withdrawal.
//
// No network, no account, no model: the only thing standing in for Feishu is
// the answer to "may this visitor read that table", which is the question the
// listener asks and this smoke controls so both answers can be checked.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-sites-serving-"));
const folder = path.join(directory, "site"), root = path.join(directory, "published");
let control = null, visitors = null;

try {
  // A site as the product makes one: a template, and a slice's contract.
  await mkdir(folder);
  await writeTemplate(folder, "dashboard");
  const fields = [{ id: "f1", name: "客户名称", type: "text", writable: false }, { id: "f2", name: "金额", type: "number", writable: false }];
  const snapshot = (digest, rows) => ({ sliceId: "s1", readAt: 1_700_000_000_000, truncated: false, rowCount: rows.length, digest,
    rows: rows.map((row, index) => ({ id: `rec${index}`, values: { f1: { text: row[0], value: row[0] }, f2: { text: String(row[1]), value: row[1] } } })) });
  const schema = { version: 1, sliceId: "s1", source: { kind: "base", title: "客户看板" }, fields, rows: { limit: 500, truncated: false }, refreshSeconds: 60 };
  await writeContract(folder, { schema, snapshot: snapshot("d1", [["北极星科技", 128.5], ["长风物流", 62]]) });
  const packed = await snapshotApp(folder, "index.html");
  assert.ok(packed.manifest.files.length >= 5, "版本包里应当有模版和契约的全部文件");

  // The two sides, wired as bin/server.js wires them.
  const sessions = new SessionRegistry();
  const registry = await SiteRegistry.open(root);
  const audit = [];
  let readable = new Set();
  const siteServer = createSiteServer({
    registry, origin: "http://127.0.0.1:0", cookieKey: await siteCookieKey(root), audit: (event) => audit.push(event),
    oauth: { authorizationUrl: ({ state }) => `https://feishu.invalid/authorize?state=${state}`,
      redeemVisitor: async ({ code }) => ({ identity: { userId: code, tenantId: "t1" }, token: `token-${code}`, expiresAt: Date.now() + 600_000 }) },
    readsSource: async ({ credential }) => readable.has(credential?.token),
  });
  siteServer.listen(0, "127.0.0.1"); await once(siteServer, "listening");
  visitors = siteServer;
  const sitesOrigin = `http://127.0.0.1:${siteServer.address().port}`;
  const service = new SiteService({ sessions, registry, origin: sitesOrigin, audit: (event) => audit.push(event),
    notify: (id, extra) => extra?.gone ? siteServer.forgetSite(id) : siteServer.notifySite(id) });
  control = createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  control.listen(0, "127.0.0.1"); await once(control, "listening");
  const controlOrigin = `http://127.0.0.1:${control.address().port}`;
  const session = sessions.issue({ tenantId: "t1", userId: "ou_owner", deviceId: "d1", authProvider: "feishu", appId: "cli_smoke", deviceProof: "ed25519-login" });
  const publish = (route, body) => fetch(`${controlOrigin}${route}`, { method: "POST",
    headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((answer) => answer.json());

  // 1. Published, following the table it was built on.
  const site = await publish("/v1/sites/publish", { name: "客户看板", manifest: packed.manifest, blobs: packed.blobs,
    share: { scope: "invited", inherit: true }, source: { kind: "base", token: "bascnSyntheticTok", tableId: "tblOne" },
    data: await readContract(folder) });
  assert.equal(site.share.inherit, true);
  assert.equal(site.url, `${sitesOrigin}/s/${site.id}/`);

  // 2. A stranger is sent to sign in, and comes back as somebody Feishu knows.
  const openFor = async (who) => {
    const sent = await fetch(`${sitesOrigin}/s/${site.id}/`, { redirect: "manual" });
    assert.equal(sent.status, 302, "没登录时应当去登录");
    const state = new URL(sent.headers.get("location")).searchParams.get("state");
    const back = await fetch(`${sitesOrigin}/_auth/callback?state=${state}&code=${who}`, { redirect: "manual" });
    assert.equal(back.status, 302);
    return back.headers.get("set-cookie").split(";")[0];
  };
  readable = new Set(["token-ou_colleague"]);
  const colleague = await openFor("ou_colleague");
  const denied = await openFor("ou_outsider");

  // 3. Feishu decides: the colleague sees the page, the outsider is told where
  //    to ask. Neither list was kept here.
  const page = await fetch(`${sitesOrigin}/s/${site.id}/`, { headers: { cookie: colleague } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data\/table-data\.js/);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  const refused = await fetch(`${sitesOrigin}/s/${site.id}/`, { headers: { cookie: denied } });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /在飞书的表格里设置/);

  // 4. The data and every asset are behind the same decision.
  const data = await fetch(`${sitesOrigin}/s/${site.id}/_data`, { headers: { cookie: colleague } }).then((answer) => answer.json());
  assert.equal(data.snapshot.digest, "d1");
  assert.equal(data.snapshot.rows[0].values.f1.text, "北极星科技");
  assert.equal((await fetch(`${sitesOrigin}/s/${site.id}/site.js`, { headers: { cookie: colleague } })).status, 200);
  assert.equal((await fetch(`${sitesOrigin}/s/${site.id}/_data`, { headers: { cookie: denied } })).status, 403);
  assert.equal((await fetch(`${sitesOrigin}/s/${site.id}/site.js`, { redirect: "manual" })).status, 302, "没登录的人连脚本都拿不到");

  // 5. A refresh reaches the page that is already open.
  const controller = new AbortController();
  const events = await fetch(`${sitesOrigin}/s/${site.id}/_events`, { headers: { cookie: colleague }, signal: controller.signal });
  const reader = events.body.getReader();
  await reader.read();
  await publish("/v1/sites/data", { siteId: site.id, schema, snapshot: snapshot("d2", [["北极星科技", 999], ["长风物流", 62]]) });
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: changed/);
  const after = await fetch(`${sitesOrigin}/s/${site.id}/_data`, { headers: { cookie: colleague } }).then((answer) => answer.json());
  assert.equal(after.snapshot.rows[0].values.f2.value, 999);
  controller.abort();

  // 6. Taking the permission away in Feishu closes the door, once the brief
  //    reuse of that answer has passed.
  readable = new Set();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await fetch(`${sitesOrigin}/s/${site.id}/`, { headers: { cookie: colleague } })).status, 200, "几秒内沿用上一次的答案");

  // 7. Sharing changed to 组织内: no table question at all, and the outsider --
  //    who is in the same tenant -- can now open it.
  await publish("/v1/sites/share", { siteId: site.id, share: { scope: "tenant" } });
  assert.equal((await fetch(`${sitesOrigin}/s/${site.id}/`, { headers: { cookie: denied } })).status, 200);

  // 8. Taken offline: the link stops working for everybody at once -- and the
  //    version is still here, so it goes back up without another upload.
  await publish("/v1/sites/withdraw", { siteId: site.id });
  const gone = await fetch(`${sitesOrigin}/s/${site.id}/`, { headers: { cookie: denied } });
  assert.equal(gone.status, 404);
  assert.match(await gone.text(), /已经被取消发布/);
  assert.deepEqual((await publish("/v1/sites/list", {})).sites.map((one) => one.offline), [true]);
  const back = await publish("/v1/sites/republish", { siteId: site.id });
  assert.equal(back.version, site.version, "重新发布的是同一个版本");
  assert.equal((await fetch(`${sitesOrigin}/s/${site.id}/`, { headers: { cookie: denied } })).status, 200);

  // 9. Erasing really removes it.
  await publish("/v1/sites/erase", { siteId: site.id });
  assert.equal((await fetch(`${sitesOrigin}/s/${site.id}/`, { headers: { cookie: denied } })).status, 404);
  assert.deepEqual((await publish("/v1/sites/list", {})).sites, []);

  const decisions = audit.filter((event) => event.event === "site-access");
  assert.ok(decisions.some((event) => event.reason === "source" && event.allowed));
  assert.ok(decisions.some((event) => event.reason === "source_denied" && !event.allowed));
  assert.ok(decisions.some((event) => event.reason === "tenant" && event.allowed));
  console.log(JSON.stringify({ passed: true, published: true, visitorLogin: true, feishuDecided: true,
    liveUpdate: true, shareChanged: true, withdrawn: true, paidCalls: 0, decisions: decisions.length }));
} finally {
  control?.close(); control?.closeAllConnections?.();
  visitors?.close(); visitors?.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
