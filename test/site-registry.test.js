import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SITE_LIMITS, SiteRegistry, siteContentType } from "../src/control-plane/site-registry.js";
import { appHash } from "../src/apps/manifest.js";

const file = (name, body) => ({ path: name, bytes: Buffer.byteLength(body), sha256: appHash(Buffer.from(body)), body });
const PAGE = file("index.html", "<!doctype html><h1>台账</h1>");
const STYLE = file("site.css", "body{margin:0}");
const pack = (files = [PAGE, STYLE]) => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html",
    files: files.map(({ path: name, bytes, sha256 }) => ({ path: name, bytes, sha256 })) },
  blobs: files.map(({ path: name, body }) => ({ path: name, base64: Buffer.from(body).toString("base64") })),
});
const owner = { ownerId: "ou_owner", tenantId: "t1", name: "客户看板" };

async function registry(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-sites-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, open: () => SiteRegistry.open(root) };
}

test("publishing keeps a version whose bytes match its manifest, and serves them back", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  assert.match(published.id, /^[0-9a-f-]{36}$/);
  assert.equal(published.name, "客户看板");
  assert.equal(published.entry, "index.html");
  assert.equal(published.bytes, PAGE.bytes + STYLE.bytes);
  assert.deepEqual(published.share, { scope: "invited", inherit: false, members: [] });
  assert.equal(published.sourced, false);

  const page = await sites.file(published.id, "/");
  assert.equal(page.path, "index.html");
  assert.equal(page.bytes.toString(), "<!doctype html><h1>台账</h1>");
  assert.equal(page.contentType, "text/html; charset=utf-8");
  assert.equal((await sites.file(published.id, "site.css")).contentType, "text/css; charset=utf-8");
  assert.equal(await sites.file(published.id, "nope.js"), null);
  assert.equal(await sites.file("00000000-0000-4000-8000-000000000000", "/"), null);
  // Kept across restarts, and readable only by this account.
  assert.deepEqual((await open()).list().map((site) => site.id), [published.id]);
  assert.equal((await stat(path.join(root, "sites.json"))).mode & 0o777, 0o600);
});

test("a package that does not match its manifest is refused before anything is written", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const tampered = pack();
  tampered.blobs[0].base64 = Buffer.from("<!doctype html><h1>别的东西</h1>").toString("base64");
  await assert.rejects(() => sites.publish({ ...owner, ...tampered, share: { scope: "invited" } }), /版本包与清单不一致/);
  const missing = pack();
  missing.blobs.pop();
  await assert.rejects(() => sites.publish({ ...owner, ...missing, share: { scope: "invited" } }), /缺少文件/);
  const extra = pack();
  extra.blobs.push({ path: "sneak.js", base64: Buffer.from("x").toString("base64") });
  await assert.rejects(() => sites.publish({ ...owner, ...extra, share: { scope: "invited" } }), /清单之外的文件/);
  assert.deepEqual(sites.list(), []);
  assert.deepEqual((await readdir(root)).filter((name) => name !== "sites.json"), []);
});

test("bytes are checked again when they are served, not only when they were stored", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  // Somebody edits the stored blob on disk.
  const folder = path.join(root, published.id, published.version);
  const blob = (await readdir(folder)).find((name) => name.endsWith(".blob"));
  await writeFile(path.join(folder, blob), "<script>alert(1)</script>");
  await assert.rejects(() => sites.file(published.id, "/"), /与发布时的清单不一致/);
});

test("a published name never becomes a path on this disk", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const nested = file("assets/app.js", "console.log(1)");
  const published = await sites.publish({ ...owner, ...pack([PAGE, nested]), share: { scope: "invited" } });
  const stored = await readdir(path.join(root, published.id, published.version));
  assert.deepEqual(stored.filter((name) => name !== "manifest.json").every((name) => /^[0-9a-f]{64}\.blob$/.test(name)), true);
  assert.equal((await sites.file(published.id, "assets/app.js")).bytes.toString(), "console.log(1)");
});

test("publishing again makes a new version, and old ones are swept", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const first = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  let last = first;
  for (let round = 0; round < 4; round += 1) {
    last = await sites.publish({ ...owner, siteId: first.id, ...pack([file("index.html", `<!doctype html><p>${round}</p>`), STYLE]), share: { scope: "invited" } });
  }
  assert.equal(last.id, first.id);
  assert.notEqual(last.version, first.version);
  assert.equal((await sites.file(first.id, "/")).bytes.toString(), "<!doctype html><p>3</p>");
  const kept = (await readdir(path.join(root, first.id), { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(kept.length, SITE_LIMITS.versionsKept, "只保留最近几个版本");
  assert.equal(first.createdAt <= last.createdAt, true);
});

test("only the owner republishes, changes the sharing, or takes it down", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  const stranger = { ownerId: "ou_stranger" };
  await assert.rejects(() => sites.publish({ ...owner, ...stranger, siteId: published.id, ...pack(), share: { scope: "tenant" } }), /只有网站的所有者/);
  await assert.rejects(() => sites.setShare(published.id, { scope: "tenant" }, stranger), /只有网站的所有者/);
  await assert.rejects(() => sites.withdraw(published.id, stranger), /只有网站的所有者/);
  const shared = await sites.setShare(published.id, { scope: "tenant", members: [{ type: "department", id: "od-1" }] }, { ownerId: "ou_owner" });
  assert.deepEqual(shared.share, { scope: "tenant", inherit: false, members: [{ type: "department", id: "od-1", perm: "view" }] });
  assert.deepEqual((await open()).get(published.id).share.scope, "tenant", "改完存住了");
});

test("anonymous sharing needs the deployment's permission, at publish and at change", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  await assert.rejects(() => sites.publish({ ...owner, ...pack(), share: { scope: "anyone" } }), /没有开放/);
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "anyone" }, anonymousAllowed: true });
  assert.equal(published.share.scope, "anyone");
  await assert.rejects(() => sites.setShare(published.id, { scope: "anyone" }, { ownerId: "ou_owner" }), /没有开放/);
});

test("taking a site down stops the link but keeps the work, and it can go back up", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" },
    source: { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" } });
  assert.equal(published.sourced, true);
  assert.equal(published.offline, false);
  await sites.putData(published.id, { schema: { fields: [] }, snapshot: { digest: "d1", rows: [] } });

  assert.deepEqual(await sites.withdraw(published.id, { ownerId: "ou_owner" }), { withdrawn: true, kept: true });
  assert.equal(sites.get(published.id).offline, true);
  assert.equal(sites.list()[0].offline, true, "还在列表里，只是下线了");
  assert.equal((await readdir(root)).includes(published.id), true, "版本还在");
  assert.deepEqual((await sites.data(published.id)).snapshot.digest, "d1", "数据也还在");
  assert.equal((await open()).get(published.id).offline, true);

  const back = await sites.republish(published.id, { ownerId: "ou_owner" });
  assert.equal(back.offline, false);
  assert.equal(back.version, published.version, "重新发布的是同一个版本，不用再传一次");
  assert.equal((await sites.file(published.id, "/")).bytes.toString(), "<!doctype html><h1>台账</h1>");
  await assert.rejects(() => sites.republish(published.id, { ownerId: "ou_stranger" }), /只有网站的所有者/);
});

test("erasing a site removes the record, the versions and the data", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  await sites.putData(published.id, { schema: null, snapshot: { digest: "d1", rows: [] } });
  await assert.rejects(() => sites.erase(published.id, { ownerId: "ou_stranger" }), /只有网站的所有者/);
  assert.deepEqual(await sites.erase(published.id, { ownerId: "ou_owner" }), { erased: true });
  assert.deepEqual(sites.list(), []);
  assert.equal((await readdir(root)).includes(published.id), false);
  assert.deepEqual((await open()).list(), []);
});

test("the data a page is given is bounded, and absent until something writes it", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  assert.equal(await sites.data(published.id), null);
  const written = await sites.putData(published.id, { snapshot: { digest: "d9", rows: [{ id: "r1" }] } });
  assert.equal(written.digest, "d9");
  assert.equal(written.changed, true, "第一次写进来当然是变了");
  // The slice is re-read on a clock, so most writes carry the same numbers as
  // the last one. Saying so is what keeps every open page from re-fetching.
  assert.equal((await sites.putData(published.id, { snapshot: { digest: "d9", rows: [{ id: "r1" }] } })).changed, false,
    "同样的摘要又写了一遍，不该算变化");
  assert.equal((await sites.putData(published.id, { snapshot: { digest: "da", rows: [{ id: "r1" }] } })).changed, true);
  assert.equal((await sites.putData(published.id, { snapshot: { rows: [] } })).changed, true, "没有摘要就无从比较，按变了算");
  await assert.rejects(() => sites.putData(published.id, { snapshot: { rows: [{ big: "x".repeat(SITE_LIMITS.dataBytes) }] } }), /超过了上限/);
  await assert.rejects(() => sites.putData("00000000-0000-4000-8000-000000000000", {}), /找不到这个网站/);
});

test("a stored record this build would not accept is not served", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  const stored = JSON.parse(await readFile(path.join(root, "sites.json"), "utf8"));
  stored.sites.push({ ...stored.sites[0], id: "not-a-uuid" });
  stored.sites.push({ ...stored.sites[0], id: "11111111-1111-4111-8111-111111111111", share: { scope: "公开" } });
  await writeFile(path.join(root, "sites.json"), JSON.stringify(stored));
  assert.deepEqual((await open()).list().map((site) => site.id), [published.id]);
});

test("content types are named, and anything unrecognised is not guessed at", () => {
  assert.equal(siteContentType("a.html"), "text/html; charset=utf-8");
  assert.equal(siteContentType("a.JS"), "text/javascript; charset=utf-8");
  assert.equal(siteContentType("a.woff2"), "font/woff2");
  assert.equal(siteContentType("a.exe"), "application/octet-stream");
});
