// Published sites, opened in a real browser (docs/sites-phase0.md §0.1, §0.2).
//
// Found in the 2026-10-03 benchmark: every site was served from one origin
// under one sign-in cookie, so a page's script could read any other site its
// visitor could open -- its page, its scripts, its data -- and carry it off by
// navigating away; and a site built on a table showed its visitors the numbers
// frozen into the version when it was published, whatever the table said
// since. Both were invisible to tests that fetched the routes directly. Here a
// page does what a page can do, in Chromium, as a visitor allowed into both.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { createSiteServer, siteCookieKey } from "../src/control-plane/site-server.js";
import { appHash } from "../src/apps/manifest.js";
import { TABLE_RUNTIME } from "../src/application/table-contract.js";

const SECRET = "B-ONLY-客户名单-13900001111";
const pack = (files) => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html",
    files: Object.entries(files).map(([file, text]) => ({ path: file, bytes: Buffer.byteLength(text), sha256: appHash(Buffer.from(text)) })) },
  blobs: Object.entries(files).map(([file, text]) => ({ path: file, base64: Buffer.from(text).toString("base64") })),
});
const table = (rows, digest) => ({ schema: { fields: [{ id: "f1", name: "名称", kind: "text" }], refreshSeconds: 60 },
  snapshot: { rows: rows.map((text, index) => ({ id: `r${index}`, values: { f1: { kind: "text", text } } })), readAt: Date.now(), digest } });
const frozen = (data) => `window.__IDOU_TABLE__ = ${JSON.stringify(data)};\n`;

// Site A: a table site whose author also tries every way a page has to reach
// another site the visitor can open, and writes down what it got.
const attacker = (victim) => `<!doctype html><meta charset="utf-8"><title>A</title>
<ul id="rows"></ul><pre id="report">running</pre>
<script src="data/table-data.js"></script><script src="data/table.js"></script>
<script>
function draw() {
  var list = document.getElementById("rows"); list.textContent = "";
  Table.rows().forEach(function (row) { var item = document.createElement("li"); item.textContent = row.text("名称"); list.appendChild(item); });
}
draw(); Table.onChange(draw);
var victim = "/s/${victim}/", report = {};
function done(name, value) { report[name] = String(value).slice(0, 300); document.getElementById("report").textContent = JSON.stringify(report); }
fetch(victim + "_data", { credentials: "include" }).then(function (r) { return r.text(); }).then(function (t) { done("fetchData", t); }, function (e) { done("fetchData", "blocked:" + e); });
fetch(victim, { credentials: "include" }).then(function (r) { return r.text(); }).then(function (t) { done("fetchPage", t); }, function (e) { done("fetchPage", "blocked:" + e); });
fetch(victim, { credentials: "include", redirect: "manual" }).then(function (r) { done("redirect", r.type + " " + (r.headers.get("location") || "")); }, function (e) { done("redirect", "blocked:" + e); });
var script = document.createElement("script"); script.src = victim + "data/table-data.js";
script.onload = function () { done("scriptInclude", JSON.stringify(window.__IDOU_TABLE__)); };
script.onerror = function () { done("scriptInclude", "blocked"); };
document.head.appendChild(script);
var frame = document.createElement("iframe"); frame.src = victim;
frame.onload = function () { try { done("frame", frame.contentDocument.body.innerText + " " + frame.contentWindow.location.href); } catch (e) { done("frame", "blocked:" + e.name); } };
document.body.appendChild(frame);
setTimeout(function () { if (!report.frame) done("frame", "blocked:never loaded"); }, 2500);
var opened = window.open(victim, "_blank");
setTimeout(function () { try { done("popup", opened.document.body.innerText + " " + opened.location.href); } catch (e) { done("popup", "blocked:" + (e && e.name)); } }, 1500);
try { localStorage.setItem("x", "1"); done("storage", "available"); } catch (e) { done("storage", "unavailable"); }
</script>`;

// Site B: what the visitor may read and site A may not.
const victimPage = `<!doctype html><meta charset="utf-8"><title>B</title><h1>${SECRET}</h1><script src="data/table-data.js"></script><script src="data/table.js"></script>`;

test("a page cannot read another site its visitor can open, and a table site's page follows its table", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-site-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const source = { kind: "base", token: "bascnFixture", table: "tblFixture" };
  const victim = await registry.publish({ ownerId: "ou_owner", tenantId: "t1", name: "客户名单", share: { scope: "tenant" }, source,
    ...pack({ "index.html": victimPage, "data/table-data.js": frozen(table([SECRET], "b1")), "data/table.js": TABLE_RUNTIME }) });
  await registry.putData(victim.id, table([SECRET], "b1"));
  const site = await registry.publish({ ownerId: "ou_author", tenantId: "t1", name: "看板", share: { scope: "tenant" }, source,
    ...pack({ "index.html": attacker(victim.id), "data/table-data.js": frozen(table(["发布时的一行"], "a0")), "data/table.js": TABLE_RUNTIME }) });
  // The table moved after publishing: what a visitor opens is this, not what was frozen in.
  await registry.putData(site.id, table(["A-第一行"], "a1"));
  const cookieKey = await siteCookieKey(root);
  const server = createSiteServer({ registry, origin: "http://127.0.0.1", cookieKey });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  // Signed in as somebody in the tenant: both sites are open to them.
  const payload = Buffer.from(JSON.stringify({ u: "ou_viewer", t: "t1", e: Date.now() + 3_600_000 })).toString("base64url");
  await context.addCookies([{ name: "idou_site", value: `${payload}.${createHmac("sha256", cookieKey).update(payload).digest("base64url")}`, url: base }]);
  const page = await context.newPage();
  const popups = [];
  context.on("page", (opened) => popups.push(opened));

  // The visitor can open B themselves.
  const own = await context.newPage();
  await own.goto(`${base}/s/${victim.id}/`);
  assert.match(await own.locator("h1").innerText(), /B-ONLY/);
  await own.close();

  await page.goto(`${base}/s/${site.id}/`);
  assert.match(page.url(), new RegExp(`/s/${site.id}/~`), "let in under a capability");
  // A's own data: the latest the server holds, not the snapshot in the version.
  await page.waitForFunction(() => document.querySelector("#rows")?.innerText.includes("A-第一行"), null, { timeout: 10_000, polling: 100 });
  const report = async () => JSON.parse(await page.locator("#report").innerText());
  await page.waitForFunction(() => { try { return Object.keys(JSON.parse(document.querySelector("#report").innerText)).length >= 7; } catch { return false; } }, null, { timeout: 15_000, polling: 200 });
  const got = await report();
  for (const [name, value] of Object.entries(got)) assert.ok(!value.includes("B-ONLY") && !value.includes("13900001111"), `${name} reached site B: ${value}`);
  assert.doesNotMatch(got.redirect, new RegExp(`/s/${victim.id}/~`), "B's capability is not handed to A");
  assert.match(got.frame, /^blocked/);
  assert.match(got.popup, /^blocked/);
  assert.equal(got.storage, "unavailable", "the page is an origin of its own, with nothing stored under the server's");

  // The table changes while the page is open: the page follows, unprompted.
  const changed = await registry.putData(site.id, table(["A-第一行", "A-新加的一行"], "a2"));
  assert.equal(changed.changed, true);
  server.notifySite(site.id);
  await page.waitForFunction(() => document.querySelector("#rows")?.innerText.includes("A-新加的一行"), null, { timeout: 10_000, polling: 100 });
  // Reopened, it starts from the latest too.
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#rows")?.innerText.includes("A-新加的一行"), null, { timeout: 10_000, polling: 100 });

  // An address copied out of the visitor's bar gets somebody else nothing of theirs.
  const stranger = await browser.newContext();
  t.after(() => stranger.close());
  const strangerPage = await stranger.newPage();
  const response = await strangerPage.goto(page.url());
  assert.notEqual(response.status(), 200, "no sign-in, no page, capability or not");
  assert.doesNotMatch(strangerPage.url(), /~/, "sent back to the way in");
});

// Found reviewing phase 0 (2026-10-03): only HTML was served sandboxed. An SVG
// is a document too -- opened on its own, or by a page's window.open (which
// escapes the sandbox, as popups are allowed to), it ran at this server's
// origin with the visitor's sign-in and read another site outright.
test("no file a site publishes runs as this server, whatever kind of document it is", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-site-svg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const victim = await registry.publish({ ownerId: "ou_owner", tenantId: "t1", name: "客户名单", share: { scope: "tenant" }, ...pack({ "index.html": `<!doctype html><h1>${SECRET}</h1>` }) });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="40"><text id="t" y="20">running</text><script><![CDATA[
var say = function (text) { document.getElementById("t").textContent = text; };
say("origin:" + self.origin);
fetch("/s/${victim.id}/", { credentials: "include" }).then(function (r) { return r.text(); }).then(function (text) { say("read:" + text.slice(0, 400)); }, function (e) { say("blocked:" + e); });
]]></script></svg>`;
  const site = await registry.publish({ ownerId: "ou_author", tenantId: "t1", name: "图", share: { scope: "tenant" },
    ...pack({ "index.html": "<!doctype html><p>图</p>", "evil.svg": svg }) });
  const cookieKey = await siteCookieKey(root);
  const server = createSiteServer({ registry, origin: "http://127.0.0.1", cookieKey });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const payload = Buffer.from(JSON.stringify({ u: "ou_viewer", t: "t1", e: Date.now() + 3_600_000 })).toString("base64url");
  await context.addCookies([{ name: "idou_site", value: `${payload}.${createHmac("sha256", cookieKey).update(payload).digest("base64url")}`, url: base }]);
  const page = await context.newPage();
  await page.goto(`${base}/s/${site.id}/evil.svg`);
  await page.waitForFunction(() => !/^(running|origin:)/.test(document.getElementById("t")?.textContent ?? "running"), null, { timeout: 10_000, polling: 100 })
    .catch(() => {});
  const said = await page.evaluate(() => document.getElementById("t")?.textContent ?? "");
  assert.doesNotMatch(said, /B-ONLY|13900001111/, `the SVG read the other site: ${said}`);
  assert.equal(await page.evaluate(() => self.origin), "null", "opened on its own, it is an origin of its own");
});
