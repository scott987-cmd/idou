import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSiteStorage, SITE_LIMITS, SiteConflict, SiteRegistry, siteAddress, siteContentType, stampOf } from "../src/control-plane/site-registry.js";
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

test("an administrator's take-down: offline at once, and its owner can neither bring it back, reshare, publish over nor erase it until released", async (t) => {
  const { root, open } = await registry(t);
  const sites = await open();
  const live = await sites.publish({ ...owner, ...pack(), share: { scope: "tenant" } });
  const down = await sites.publish({ ...owner, ...pack(), share: { scope: "tenant" } });
  await sites.withdraw(down.id, { ownerId: "ou_owner" });
  const admin = { userId: "ou_admin", name: "管理员" };
  const held = await sites.hold(live.id, { by: admin, reason: "包含客户电话" });
  assert.deepEqual({ offline: held.offline, reason: held.held.reason }, { offline: true, reason: "包含客户电话" });
  assert.equal("by" in held.held, false, "who took it down is the audit trail's to say, not the owner's listing");
  assert.equal(sites.get(live.id).offline, true, "written as offline too: a build that knows nothing of holds keeps it down");
  for (const attempt of [() => sites.republish(live.id, { ownerId: "ou_owner" }), () => sites.setShare(live.id, { scope: "invited" }, { ownerId: "ou_owner" }),
    () => sites.erase(live.id, { ownerId: "ou_owner" }), () => sites.publish({ ...owner, siteId: live.id, ...pack(), share: { scope: "tenant" } })]) {
    await assert.rejects(attempt, /管理员下线了这个网站（包含客户电话）/);
  }
  assert.equal((await readdir(root)).includes(live.id), true, "the files stay");
  assert.equal((await open()).get(live.id).held.reason, "包含客户电话", "kept across a restart");
  // Released: back to what it was -- online.
  assert.equal((await sites.release(live.id)).offline, false);
  assert.equal((await sites.republish(live.id, { ownerId: "ou_owner" })).offline, false, "its owner manages it again");
  // One its owner had taken down already stays down when released; and taking
  // it down while held is what a release then returns to.
  await sites.hold(down.id, { by: admin, reason: "核查" });
  assert.equal((await sites.release(down.id)).offline, true);
  const again = await sites.publish({ ...owner, ...pack(), share: { scope: "tenant" } });
  await sites.hold(again.id, { by: admin, reason: "核查" });
  await sites.withdraw(again.id, { ownerId: "ou_owner" });
  assert.equal((await sites.release(again.id)).offline, true, "its owner withdrew it meanwhile");
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

test("a version that must wait for an administrator is written offline and waiting, and only an administrator's yes -- or an audience it passes for -- brings it up", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const admin = { userId: "ou_admin", name: "管理员" };
  // Published straight into waiting: no moment online.
  const waiting = await sites.publish({ ...owner, ...pack(), share: { scope: "anyone" }, anonymousAllowed: true, review: { checkId: "c1", reason: "发现 1 处手机号" } });
  assert.deepEqual({ offline: waiting.offline, state: waiting.review.state, reason: waiting.review.reason }, { offline: true, state: "pending", reason: "发现 1 处手机号" });
  await assert.rejects(sites.republish(waiting.id, { ownerId: "ou_owner" }), /在等待管理员审核（发现 1 处手机号）/);
  // An older check approved -- refused data, say -- does not end a newer wait.
  const older = await sites.approve(waiting.id, { by: admin, fingerprints: ["f0"], checkId: "c0" });
  assert.deepEqual([older.offline, older.review.state, sites.get(waiting.id).review.approved.fingerprints], [true, "pending", ["f0"]]);
  // The check it waits on approved: online, and what was let through is remembered for next time.
  const approved = await sites.approve(waiting.id, { by: admin, fingerprints: ["f1"], aiDigest: "t1", checkId: "c1" });
  assert.deepEqual({ offline: approved.offline, review: approved.review }, { offline: false, review: null });
  assert.deepEqual(sites.get(waiting.id).review.approved.fingerprints, ["f0", "f1"]);
  const again = await sites.publish({ ...owner, siteId: waiting.id, ...pack(), share: { scope: "anyone" }, anonymousAllowed: true });
  assert.deepEqual([again.offline, sites.get(waiting.id).review.approved.fingerprints], [false, ["f0", "f1"]], "a later version keeps what was approved");

  // Turned down: offline, the owner told why; a new version that passes goes up.
  const second = await sites.publish({ ...owner, ...pack(), share: { scope: "anyone" }, anonymousAllowed: true, review: { checkId: "c2", reason: "AI 审核：疑似广告引流" } });
  const rejected = await sites.reject(second.id, { by: admin, reason: "外链到赌博网站" });
  assert.deepEqual([rejected.offline, rejected.review.state], [true, "rejected"]);
  await assert.rejects(sites.republish(second.id, { ownerId: "ou_owner" }), /没有通过这个网站的审核：外链到赌博网站/);
  await assert.rejects(sites.reject(second.id, { by: admin, reason: "x" }), /没有在等待审核/);
  assert.equal((await sites.publish({ ...owner, siteId: second.id, ...pack(), share: { scope: "anyone" }, anonymousAllowed: true })).offline, false);

  // An audience it passes for ends the wait: shared only inside the organisation, it is up.
  const third = await sites.publish({ ...owner, ...pack(), share: { scope: "anyone" }, anonymousAllowed: true, review: { checkId: "c3", reason: "x" } });
  const unchecked = await sites.setShare(third.id, { scope: "tenant" }, { ownerId: "ou_owner" });
  assert.equal(unchecked.review.state, "pending", "a sharing changed without a check ends no wait");
  const inside = await sites.setShare(third.id, { scope: "tenant" }, { ownerId: "ou_owner", review: null });
  assert.deepEqual([inside.offline, inside.review], [false, null]);
  // Made public again, it waits again -- written offline in the same save.
  const out = await sites.setShare(third.id, { scope: "anyone" }, { ownerId: "ou_owner", anonymousAllowed: true, review: { checkId: "c4", reason: "y" } });
  assert.deepEqual([out.offline, out.review.state], [true, "pending"]);
  // Taken down by its owner while waiting: approved, it stays down.
  await sites.withdraw(third.id, { ownerId: "ou_owner" });
  assert.equal((await sites.approve(third.id, { by: admin, checkId: "c4" })).offline, true);
});

test("an administrator's hold outranks an approval: the site stays down until released, then is what its owner wanted", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const admin = { userId: "ou_admin", name: "管理员" };
  const site = await sites.publish({ ...owner, ...pack(), share: { scope: "anyone" }, anonymousAllowed: true, review: { checkId: "c1", reason: "x" } });
  await sites.hold(site.id, { by: admin, reason: "核查中" });
  assert.equal((await sites.approve(site.id, { by: admin, checkId: "c1" })).offline, true, "held: still down");
  assert.equal((await sites.release(site.id)).offline, false, "released: online, as approved");
  const { files, data, version } = await sites.contents(site.id);
  assert.deepEqual([files.map((file) => file.path).sort(), data, version], [["index.html", "site.css"], null, site.version]);
  assert.match(files.find((file) => file.path === "index.html").bytes.toString(), /台账/);
});

// Found in the third review before .270: each change saved the whole list from
// the records it had read, so two at once -- an administrator's hold and an
// owner's withdraw, a check again in the background -- undid one another.
test("changes made at the same moment are all kept: each is made from the records as they are when its turn comes", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const a = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  const b = await sites.publish({ ...owner, name: "第二个", ...pack(), share: { scope: "invited" } });
  const c = await sites.publish({ ...owner, name: "第三个", ...pack(), share: { scope: "invited" } });
  await Promise.all([
    sites.hold(a.id, { by: { userId: "ou_admin" }, reason: "核实中" }),
    sites.withdraw(b.id, { ownerId: owner.ownerId }),
    sites.awaitReview(c.id, { checkId: "check-1", reason: "发现 1 处手机号。" }),
  ]);
  assert.deepEqual([Boolean(sites.get(a.id).held), sites.get(b.id).offline, sites.get(c.id).review.state], [true, true, "pending"]);
  const reopened = await open();
  assert.deepEqual([Boolean(reopened.get(a.id).held), reopened.get(b.id).offline, reopened.get(c.id).review.state], [true, true, "pending"], "and so they were saved");
});

test("an administrator's reason ending in a stop is not given a second one", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const site = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" }, review: { checkId: "check-1", reason: "发现 1 处手机号。" } });
  await sites.reject(site.id, { by: { userId: "ou_admin" }, reason: "公开前删掉手机号。" });
  await assert.rejects(() => sites.republish(site.id, { ownerId: owner.ownerId }), (error) => !/[。，；：][。，；：！？]/u.test(error.message) && /删掉手机号。改好后/.test(error.message));
  const held = await sites.publish({ ...owner, name: "另一个", ...pack(), share: { scope: "invited" } });
  await sites.hold(held.id, { by: { userId: "ou_admin" }, reason: "包含客户电话！" });
  await assert.rejects(() => sites.republish(held.id, { ownerId: owner.ownerId }), (error) => /（包含客户电话），要恢复/.test(error.message));
});

test("offboarding takes down a site waiting for review too: an approval later does not put it back up", async (t) => {
  const { forgetPerson } = await import("../src/control-plane/person-data.js");
  const { open } = await registry(t);
  const sites = await open();
  const waiting = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" }, review: { checkId: "check-1", reason: "发现 1 处手机号" } });
  const done = await forgetPerson({ who: { tenantId: owner.tenantId, userId: owner.ownerId }, sites });
  assert.deepEqual(done.sitesOffline.map((site) => site.id), [waiting.id]);
  await sites.approve(waiting.id, { by: { userId: "ou_admin" }, checkId: "check-1" });
  assert.equal(sites.get(waiting.id).offline, true, "approved, and still down: its owner has left");
});

// Fourth review before .270: a publish refused when its record was to be
// written (the site changed during its check, or its owner was disabled) left
// the files it had already written, which no record named and nothing removed.
test("a publish refused when it comes to be written leaves no files behind", async (t) => {
  const { root, open } = await registry(t);
  const { SiteConflict, SiteRefused, stampOf } = await import("../src/control-plane/site-registry.js");
  const sites = await open();
  const versions = async (id) => (await readdir(path.join(root, id)).catch(() => [])).filter((name) => /^[0-9a-f]{64}$/.test(name));
  // A first publish whose owner is disabled after its files are written: asked
  // once before (still allowed) and again when the record is to be written.
  let asked = 0;
  const id = "6f0d2c1e-0000-4000-8000-0000000000bb";
  await assert.rejects(() => sites.publish({ ...owner, siteId: id, ...pack(), share: { scope: "invited" }, expect: null, allowed: () => asked++ === 0 }), SiteRefused);
  assert.equal(asked, 2, "refused when it came to be written, its files already there");
  assert.deepEqual(await versions(id), [], "nothing of a site that never was");
  // An update whose site is taken down while its files are written: the
  // version up stays, the refused one goes.
  const site = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  const expect = stampOf(sites.get(site.id));
  const updating = sites.publish({ ...owner, siteId: site.id, ...pack([file("index.html", "<h1>第二版</h1>")]), share: { scope: "invited" }, expect });
  await sites.withdraw(site.id, { ownerId: owner.ownerId });
  await assert.rejects(() => updating, SiteConflict);
  assert.deepEqual(await versions(site.id), [site.version]);
});

test("approving an older check marks the version that check was of, not a newer one waiting", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const site = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" }, review: { checkId: "check-2", reason: "公开网站都要管理员审核" } });
  await sites.approve(site.id, { by: { userId: "ou_admin" }, checkId: "check-1", version: "an-older-version" });
  assert.deepEqual([sites.get(site.id).review.state, sites.get(site.id).review.approved.version], ["pending", "an-older-version"]);
});

// Fifth review before .270: approving an old check left behind took a newer
// approval back to the old version, and under 公开网站一律送审 the reviewed
// version up then counted as unreviewed.
test("approving an old check left behind does not take a newer approval back", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const first = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" }, review: { checkId: "c1", reason: "公开网站都要管理员审核" } });
  await sites.approve(first.id, { by: { userId: "ou_admin" }, checkId: "c1", version: first.version });
  const second = await sites.publish({ ...owner, siteId: first.id, ...pack([file("index.html", "<h1>第二版</h1>")]), share: { scope: "invited" }, review: { checkId: "c2", reason: "公开网站都要管理员审核" } });
  await sites.approve(first.id, { by: { userId: "ou_admin" }, checkId: "c2", version: second.version });
  assert.equal(sites.get(first.id).review.approved.version, second.version);
  await sites.approve(first.id, { by: { userId: "ou_admin" }, checkId: "c0", version: first.version });
  assert.equal(sites.get(first.id).review.approved.version, second.version, "the version up stays the reviewed one");
});

// Fifth review before .270: a check again compares the data it read with what
// is there in the same turn it takes the site down, so data written meanwhile
// has to be in that queue too.
test("new data is written in turn with the records: a check again queued after it sees it", async (t) => {
  const { root } = await registry(t);
  const { FileSiteStorage } = await import("../src/control-plane/site-registry.js");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  class Slow extends FileSiteStorage { async putData(...args) { if (JSON.parse(args[1]).snapshot?.digest === "new") await gate; return super.putData(...args); } }
  const sites = await SiteRegistry.open(root, { storage: new Slow(root) });
  const site = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  await sites.putData(site.id, { snapshot: { digest: "old", rows: [] } });
  const writing = sites.putData(site.id, { snapshot: { digest: "new", rows: [] } });
  const taking = sites.awaitReview(site.id, { checkId: "c1", reason: "发现 1 处手机号", still: () => true, dataDigest: "old" });
  release();
  await writing;
  assert.equal((await taking).stale, true, "it was checked against data no longer there");
  assert.deepEqual([sites.get(site.id).offline, sites.get(site.id).review?.state ?? null], [false, null]);
});

// Fifth review before .270: offboarding took down sites waiting for review or
// held too, while every preview of it counted only those up.
test("offboarding's preview counts the sites offboarding takes down", async (t) => {
  const { personInventory, forgetPerson } = await import("../src/control-plane/person-data.js");
  const { open } = await registry(t);
  const sites = await open();
  const up = await sites.publish({ ...owner, name: "在线的", ...pack(), share: { scope: "invited" } });
  const down = await sites.publish({ ...owner, name: "自己下线的", ...pack(), share: { scope: "invited" } });
  await sites.withdraw(down.id, { ownerId: owner.ownerId });
  await sites.publish({ ...owner, name: "等审核的", ...pack(), share: { scope: "invited" }, review: { checkId: "c1", reason: "发现 1 处手机号" } });
  const held = await sites.publish({ ...owner, name: "被下线的", ...pack(), share: { scope: "invited" } });
  await sites.hold(held.id, { by: { userId: "ou_admin" }, reason: "核实中" });
  // Taken down by its owner, then held: nothing of theirs to take down (sixth review).
  const theirs = await sites.publish({ ...owner, name: "自己下线后被管理员下线的", ...pack(), share: { scope: "invited" } });
  await sites.withdraw(theirs.id, { ownerId: owner.ownerId });
  await sites.hold(theirs.id, { by: { userId: "ou_admin" }, reason: "核实中" });
  const who = { tenantId: owner.tenantId, userId: owner.ownerId };
  const preview = (await personInventory({ who, sites })).sites.filter((site) => site.withdrawn).map((site) => site.name).sort();
  const done = (await forgetPerson({ who, sites })).sitesOffline.map((site) => site.name).sort();
  assert.deepEqual(preview, done);
  assert.deepEqual(done, ["在线的", "等审核的", "被下线的"].sort());
  void up;
});

// Sixth review before .270: held while waiting for review, or after 不通过,
// then rolled back to .269 -- whose release reads only the hold's copy -- the
// site went up on release. That copy is down while a review is open.
test("a site held while it waits or was turned down stays down when a build before .270 releases it", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  for (const turnedDown of [false, true]) {
    const site = await sites.publish({ ...owner, name: turnedDown ? "没通过" : "等审核", ...pack(), share: { scope: "invited" }, review: { checkId: "c1", reason: "发现 1 处手机号" } });
    if (turnedDown) await sites.reject(site.id, { by: { userId: "ou_admin" }, reason: "删掉手机号" });
    await sites.hold(site.id, { by: { userId: "ou_admin" }, reason: "核实中" });
    const raw = sites.get(site.id);
    // .269's release: offline is what the hold kept, nothing else.
    assert.equal(raw.held.wasOffline, true, turnedDown ? "turned down" : "waiting");
    assert.equal(raw.review.wasOffline, false, "its owner still wants it up, once it is let through");
  }
});

// Found reviewing phase 0 (2026-10-03).
test("going back: a conflict says so, an old record gets no invented time, and each approved version stays approved", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const versionOf = (n) => pack([PAGE, file("site.css", `body{margin:${n}px}`)]);
  const first = await sites.publish({ ...owner, share: { scope: "invited" }, ...versionOf(1) });
  const second = await sites.publish({ ...owner, siteId: first.id, share: { scope: "invited" }, ...versionOf(2) });
  // Changed while it was checked -- here two publishes pushed the version out --
  // is a conflict to refresh after, not "not kept".
  const stamp = stampOf(sites.get(first.id));
  await sites.publish({ ...owner, siteId: first.id, share: { scope: "invited" }, ...versionOf(3) });
  await sites.publish({ ...owner, siteId: first.id, share: { scope: "invited" }, ...versionOf(4) });
  await assert.rejects(sites.revert(first.id, { ownerId: "ou_owner", version: first.version, expect: stamp }), SiteConflict);

  // A record from before times were kept: going back does not give it today's.
  const legacy = await (await registry(t)).open();
  const dumped = await sites.dump();
  for (const row of dumped) delete row.record.versionAt;
  await legacy.restore(dumped);
  const kept = legacy.get(first.id).history;
  await legacy.revert(first.id, { ownerId: "ou_owner", version: kept[2] });
  const listed = await legacy.versions(first.id);
  assert.equal(listed.find((row) => row.version === kept[2]).publishedAt, null, "no time rather than a wrong one");

  // Approved while another version was up, then gone back to: still approved.
  await legacy.approve(first.id, { by: { userId: "ou_admin" }, version: kept[1] });
  await legacy.approve(first.id, { by: { userId: "ou_admin" }, version: kept[2] });
  assert.deepEqual([...legacy.get(first.id).review.approved.versions].sort(), [kept[1], kept[2]].sort());
  assert.equal(second.version !== first.version, true);
});

test("a new version that names no table keeps the table the site follows", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const source = { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne" };
  const site = await sites.publish({ ...owner, share: { scope: "invited", inherit: true }, source, ...pack() });
  await sites.publish({ ...owner, siteId: site.id, share: { scope: "invited", inherit: true }, source: null, ...pack([PAGE]) });
  assert.deepEqual(sites.get(site.id).source, { ...source, sheetId: null });
  assert.equal(sites.list()[0].sourced, true);
});

// docs/sites-phase1.md §1.6: /s/销售周报/ instead of an id nobody can say.
test("a site's address name is its own, survives new versions, and the names it had still lead to it", async (t) => {
  const { open } = await registry(t);
  const sites = await open();
  const first = await sites.publish({ ...owner, share: { scope: "tenant" }, ...pack() });
  const other = await sites.publish({ ...owner, name: "别的", share: { scope: "tenant" }, ...pack([PAGE]) });
  assert.equal((await sites.setAddress(first.id, { ownerId: "ou_owner", address: "销售周报" })).address, "销售周报");
  await assert.rejects(sites.setAddress(first.id, { ownerId: "ou_other", address: "别的名字" }), /只有网站的所有者/);
  await assert.rejects(sites.setAddress(other.id, { ownerId: "ou_owner", address: "销售周报" }), /已经被别的网站用了/);
  await sites.setAddress(other.id, { ownerId: "ou_owner", address: "Team-Board" });
  await assert.rejects(sites.setAddress(first.id, { ownerId: "ou_owner", address: "team-board" }), /已经被别的网站用了/, "Latin letters compared without case");
  for (const bad of ["a", "-x", "_x", "带 空格", "admin", "6f0d2c1e-0000-4000-8000-0000000000ee", "x".repeat(41), "a/b"]) {
    await assert.rejects(sites.setAddress(first.id, { ownerId: "ou_owner", address: bad }), /地址名|不能用/, bad);
  }
  // Renamed: the old name still leads here, and stays taken.
  await sites.setAddress(first.id, { ownerId: "ou_owner", address: "季度周报" });
  assert.equal(sites.byAddress("销售周报")?.id, first.id);
  assert.equal(sites.byAddress("季度周报")?.id, first.id);
  await assert.rejects(sites.setAddress(other.id, { ownerId: "ou_owner", address: "销售周报" }), /已经被别的网站用了/);
  // A new version keeps it; going without a name keeps the old ones leading here.
  await sites.publish({ ...owner, siteId: first.id, share: { scope: "tenant" }, ...pack([PAGE]) });
  assert.equal(sites.get(first.id).address, "季度周报");
  await sites.setAddress(first.id, { ownerId: "ou_owner", address: null });
  assert.equal(sites.list({ ownerId: "ou_owner" }).find((row) => row.id === first.id).address, null);
  assert.equal(sites.byAddress("季度周报")?.id, first.id);
  // At most five old names; erased, they are free again.
  for (const name of ["一号", "二号", "三号", "四号", "五号", "六号"]) await sites.setAddress(first.id, { ownerId: "ou_owner", address: name });
  assert.equal(sites.get(first.id).addresses.length, 5);
  await sites.erase(first.id, { ownerId: "ou_owner" });
  assert.equal(sites.byAddress("六号"), null);
  await sites.setAddress(other.id, { ownerId: "ou_owner", address: "六号" });
  assert.equal(siteAddress(" 销售周报 "), "销售周报", "spaces around a name are not part of it");
});

test("which write of the data is there is known without reading it, and the digest is read once per write", async (t) => {
  const { root } = await registry(t);
  class Counting extends FileSiteStorage { reads = 0; async readData(id) { this.reads += 1; return super.readData(id); } }
  const storage = new Counting(root);
  const sites = await SiteRegistry.open(root, { storage });
  const published = await sites.publish({ ...owner, ...pack(), share: { scope: "invited" } });
  assert.equal(await sites.dataStamp(published.id), null, "nothing written yet");
  assert.equal(await sites.dataDigest(published.id), null);
  await sites.putData(published.id, { snapshot: { digest: "d1", rows: [] } });
  const first = await sites.dataStamp(published.id);
  assert.equal(typeof first, "string");
  // The same bytes written again are still another write.
  await sites.putData(published.id, { snapshot: { digest: "d1", rows: [] } });
  const second = await sites.dataStamp(published.id);
  assert.notEqual(second, first);
  storage.reads = 0;
  assert.equal(await sites.dataDigest(published.id), "d1");
  assert.equal(await sites.dataDigest(published.id), "d1");
  assert.equal((await sites.putData(published.id, { snapshot: { digest: "d1", rows: [] } })).changed, false);
  assert.equal(storage.reads, 1, "18 MB parsed once for the write that is there, not on every question");
  assert.equal((await sites.putData(published.id, { snapshot: { digest: "d2", rows: [] } })).changed, true);
  assert.equal(await sites.dataDigest(published.id), "d2", "a new write is read anew");
  await sites.erase(published.id, { ownerId: owner.ownerId });
  assert.equal(await sites.dataStamp(published.id), null);
});
