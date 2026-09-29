// The server console, stood up for real and looked at.
//
// Everything here is the production code: the site listener, the address
// allowlist, the administrator directory, the page. What is synthetic is the
// one thing that would otherwise need somebody's Feishu -- who is in the
// administrator group -- and that is held still on purpose so the two answers
// that matter can both be seen: a group that reads, and one that does not.
import { once } from "node:events";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { createSiteServer, siteCookieKey } from "../src/control-plane/site-server.js";
import { AdminDirectory, adminRefusal } from "../src/control-plane/admin-directory.js";
import { adminPage, adminState, auditTail } from "../src/control-plane/admin-console.js";
import { addressAllowlist } from "../src/control-plane/address-allowlist.js";
import { createSiteDemos } from "../src/control-plane/site-demos.js";
import { ModelVisibility, modelPolicy } from "../src/control-plane/model-visibility.js";
import { ModelUsage } from "../src/control-plane/model-usage.js";
import { appHash } from "../src/apps/manifest.js";

const root = await mkdtemp(path.join(os.tmpdir(), "idou-admin-console-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let server = null, consoleServer = null;
try {
  const registry = await SiteRegistry.open(root);
  const body = "<!doctype html><h1>台账</h1>";
  await registry.publish({ ownerId: "ou_boss", tenantId: "t1", name: "客户看板",
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html",
      files: [{ path: "index.html", bytes: Buffer.byteLength(body), sha256: appHash(Buffer.from(body)) }] },
    blobs: [{ path: "index.html", base64: Buffer.from(body).toString("base64") }],
    share: { scope: "tenant" }, source: { kind: "base", token: "bascnDemo", tableId: "tbl1" } });

  const audit = auditTail();
  // Two people's worth of counting, so the page has numbers to show.
  const ledger = new ModelUsage();
  ledger.record({ who: { tenantId: "t1", userId: "ou_boss" }, model: "MiniMax-M3", usage: { total_tokens: 9000 } });
  ledger.record({ who: { tenantId: "t1", userId: "ou_other" }, model: "GLM-5.3", usage: { total_tokens: 120 } });
  // The group cannot be read -- the bot was never added to it, which is the
  // most likely thing to be wrong on the day somebody sets this up. Nobody is
  // an administrator by way of the group, and the escape hatch still works.
  const directory = new AdminDirectory({ users: ["ou_boss"], chatId: "oc_admins",
    readChatMembers: async () => { throw new Error("应用机器人不在这个群里（code=230002）：把它拉进管理员群。"); } });
  const allow = addressAllowlist("10.0.0.0/8");
  const cookieKey = await siteCookieKey(root);
  // The sites and the console, each on a listener of its own (site-server.js).
  server = createSiteServer({ registry, origin: "https://sites.example", cookieKey, allowlist: allow,
    anonymousAllowed: true, demos: createSiteDemos(), audit: (event) => audit.record(event) });
  consoleServer = createSiteServer({ role: "admin", registry, origin: "https://admin.example", cookieKey, allowlist: allow,
    audit: (event) => audit.record(event),
    console: {
      decide: (visitor) => directory.decide(visitor),
      refusal: (verdict) => adminRefusal(verdict.reason),
      state: async () => adminState({
        deployment: { sitesOrigin: "https://sites.example", anonymous: true, allowlist: allow.rules,
          unattended: false, sandboxMode: "development" },
        models: [{ id: "MiniMax-M3", provider: "minimax", isDefault: true }, { id: "GLM-5.3", provider: "litellm" }],
        health: { usable: (id) => id !== "GLM-5.3" },
        sites: registry.list(), directory: await directory.status(), audit: audit.recent(20),
        usage: { days: 30, people: ledger.perPerson({ days: 30 }), models: ledger.perModel({ days: 30 }) },
        visibility: new ModelVisibility({ models: ["MiniMax-M3", "GLM-5.3"], defaultVisible: "none",
          rules: modelPolicy([{ who: { kind: "chat", id: "oc_pro" }, models: ["GLM-5.3"] },
            { who: { kind: "everyone" }, models: ["MiniMax-M3"] }], { models: ["MiniMax-M3", "GLM-5.3"] }) }),
      }),
      page: (state, visitor) => adminPage(state, { who: visitor.userId }),
    } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  consoleServer.listen(0, "127.0.0.1"); await once(consoleServer, "listening");
  const sitesBase = `http://127.0.0.1:${server.address().port}`, base = `http://127.0.0.1:${consoleServer.address().port}`;
  // Signed in to the console, as its listener seals it.
  const consoleKey = createHmac("sha256", cookieKey).update("idou admin console cookie v1").digest();
  const as = (who) => {
    const sealed = Buffer.from(JSON.stringify({ u: who, t: "t1", e: Date.now() + 600_000 })).toString("base64url");
    return `idou_admin=${sealed}.${createHmac("sha256", consoleKey).update(sealed).digest("base64url")}`;
  };
  // A couple of real events, so the page has something to show in its tail.
  await fetch(`${sitesBase}/demo/`);
  await fetch(`${sitesBase}/s/00000000-0000-4000-8000-000000000000/`);
  assert.equal((await fetch(`${sitesBase}/admin`)).status, 404, "the console is not beside the sites");

  // Somebody who is not an administrator is told which, and sees nothing else.
  const denied = await fetch(`${base}/admin`, { headers: { cookie: as("ou_other") } });
  assert.equal(denied.status, 403);
  const refusal = (await denied.text()).replace(/<[^>]+>/g, " ");
  assert.match(refusal, /读不到管理员群/, refusal);
  assert.equal(refusal.includes("客户看板"), false, "拒绝页不该带上这个部署的任何情况");

  const page = await fetch(`${base}/admin`, { headers: { cookie: as("ou_boss") } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const state = await (await fetch(`${base}/admin/state.json`, { headers: { cookie: as("ou_boss") } })).json();

  // What it says about the deployment is what the deployment is.
  assert.equal(state.deployment.anonymous, true);
  assert.deepEqual(state.deployment.allowlist, ["10.0.0.0/8"]);
  assert.match(html, /免登录访问/);
  assert.match(html, /10\.0\.0\.0\/8/);
  // Health comes from real request outcomes, so a model that is not answering
  // is shown as not answering rather than merely listed.
  assert.deepEqual(state.models.map((model) => [model.id, model.usable]), [["MiniMax-M3", true], ["GLM-5.3", false]]);
  assert.match(html, /答不了/);
  assert.deepEqual(state.sites.map((site) => [site.name, site.scope, site.sourced]), [["客户看板", "tenant", true]]);
  // In the words the sharing panel uses, not the value stored under them: one
  // thing should not have two vocabularies.
  assert.match(html, /组织内获得链接的人可阅读/);
  assert.equal(/>tenant</.test(html), false, "页面上不该出现内部值");
  assert.equal(/。。/.test(html), false, "标点重复了");
  // The group is unreadable, and the page says exactly why rather than showing
  // zero administrators as if that were a fact.
  assert.equal(state.administrators.counts.chat, null);
  assert.match(html, /机器人不在这个群里/);
  assert.equal(state.administrators.counts.configured, 1);
  // Never who the administrators are: a page listing every one of them is a
  // page worth stealing. The usage table does name people -- that is what an
  // operator is looking at it for -- so this checks the section, not the page.
  const roster = html.split("<h2>管理员</h2>")[1].split("<h2>")[0];
  assert.equal(/ou_[A-Za-z0-9_-]+/.test(roster), false, roster.slice(0, 200));
  assert.match(roster, /配置文件里写死的/);
  assert.ok(state.audit.length >= 2, "最近发生了什么，应当真的有东西");
  assert.match(html, /site-demo|site-access/);
  // And it says what it cannot do yet, rather than looking complete.
  // The policy as written, in words rather than in its stored shape.
  assert.equal(state.visibility.enabled, true);
  assert.deepEqual(state.visibility.rules.map((rule) => rule.kind), ["chat", "everyone"]);
  assert.match(html, /某个群/);
  assert.match(html, /oc_pro/);
  assert.match(html, /越具体的规则越优先/);
  assert.match(html, /网关按人拒绝/, "页面要说清这条策略不是只过滤列表");
  // Counted, shown, and said plainly to be doing nothing yet.
  assert.deepEqual(state.usage.people.map((row) => [row.userId, row.tokens]), [["ou_boss", 9000], ["ou_other", 120]]);
  assert.equal(state.usage.enforcing, false);
  assert.match(html, /9,000/, "数字该有千分位");
  assert.match(html, /这一版只记不拦/);
  assert.equal(/提示词|对话内容/.test(html.split("账本里只有计数")[0]), false);
  assert.ok(state.notYet.length >= 2);
  assert.match(html, /还没有的/);

  await writeFile(path.join(evidence, "admin-console.html"), html);
  console.log(JSON.stringify({ passed: true, realListener: true, models: state.models.length,
    sites: state.sites.length, auditShown: state.audit.length, groupUnreadableSaid: true,
    page: "docs/evidence/admin-console.html", paidCalls: 0 }));
} finally {
  server?.close(); server?.closeAllConnections?.();
  consoleServer?.close(); consoleServer?.closeAllConnections?.();
  await rm(root, { recursive: true, force: true });
}
