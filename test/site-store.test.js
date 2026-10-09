import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SiteStore } from "../src/application/site-store.js";

const slice = { kind: "base", token: "bascnABCDEFGHIJ", tableId: "tblOne", fields: ["fldA", "fldB"], rows: 100, refreshSeconds: 60 };

async function store(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-sites-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "account", "sites.json"), root = path.join(directory, "sites");
  return { directory, file, root, open: () => SiteStore.open(file, root) };
}

test("a site has its own folder, so a coding task can be opened on it later", async (t) => {
  const { file, root, open } = await store(t);
  const sites = await open();
  assert.deepEqual(sites.list(), []);
  const site = await sites.create({ name: "客户看板", slice });
  assert.equal(site.name, "客户看板");
  assert.equal(path.dirname(site.folder), root);
  assert.equal((await stat(site.folder)).isDirectory(), true);
  assert.equal((await stat(site.folder)).mode & 0o777, 0o700);
  assert.equal(site.lastReadAt, null);
  assert.match(site.sliceId, /^[0-9a-f]{32}$/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await open()).list().map((row) => row.name), ["客户看板"], "kept across restarts");
});

test("a site with no table is a site: a small game is just files", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  const game = await sites.create({ name: "贪吃蛇" });
  assert.equal(game.slice, null);
  assert.equal(game.sliceId, null);
  assert.equal((await stat(game.folder)).isDirectory(), true);
  await assert.rejects(() => sites.recordRead(game.id, { rowCount: 1 }), /没有接表格/);
  assert.deepEqual((await open()).list().map((row) => [row.name, row.slice]), [["贪吃蛇", null]], "kept across restarts");
});

test("a name nobody typed still names something", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  assert.equal((await sites.create({ slice, title: "客户台账" })).name, "客户台账");
  assert.equal((await sites.create({ name: "   ", slice })).name, "未命名网站");
  assert.equal((await sites.create({ name: "报表/2026", slice })).name, "未命名网站", "a name that could be a path is not one");
  assert.equal((await sites.create({ name: "  季度  报表 ", slice })).name, "季度 报表");
});

test("a read records what it found, and never changes what the site is", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  const site = await sites.create({ name: "客户看板", slice });
  await sites.recordRead(site.id, { readAt: 1_700_000_000_000, rowCount: 42, digest: "d1" });
  const after = sites.get(site.id);
  assert.equal(after.lastReadAt, 1_700_000_000_000);
  assert.equal(after.rowCount, 42);
  assert.equal(after.digest, "d1");
  assert.deepEqual(after.slice, sites.get(site.id).slice);
  assert.deepEqual((await open()).get(site.id).digest, "d1");
  await assert.rejects(() => sites.recordRead("nope", { rowCount: 1 }), /找不到这个网站/);
});

test("renaming and forgetting; forgetting keeps the folder", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  const site = await sites.create({ name: "客户看板", slice });
  await sites.rename(site.id, "季度看板");
  assert.equal(sites.get(site.id).name, "季度看板");
  await sites.rename(site.id, "");
  assert.equal(sites.get(site.id).name, "季度看板", "an empty name is not a rename");
  await sites.forget(site.id);
  assert.deepEqual(sites.list(), []);
  assert.equal((await stat(site.folder)).isDirectory(), true, "the page somebody wrote is theirs");
  await assert.rejects(() => sites.forget(site.id), /找不到这个网站/);
});

test("a record this build would not accept is not honoured, and the file is left alone", async (t) => {
  const { file, open } = await store(t);
  await (await open()).create({ name: "客户看板", slice });
  await writeFile(file, JSON.stringify({ version: 1, sites: [
    { id: "a", name: "坏的", folder: "relative/path", slice },
    { id: "b", name: "也坏", folder: "/tmp/x", slice: { ...slice, fields: [] } },
    { id: "c", name: "好的", folder: "/tmp/y", slice },
    { id: "d", name: "小游戏", folder: "/tmp/z", slice: null },
  ] }));
  assert.deepEqual((await open()).list().map((row) => row.id), ["c", "d"]);
  assert.equal(JSON.parse(await readFile(file, "utf8")).sites.length, 4, "the file itself is left as it was");
});

test("a directory that already exists can become a site, and only once", async (t) => {
  const { root, open } = await store(t);
  const sites = await open();
  const elsewhere = path.join(root, "..", `made-by-a-coding-task-${Date.now()}`);
  await mkdir(elsewhere, { recursive: true });
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  // A page written in a coding task is already somewhere. Copying it would
  // leave two copies to keep in step -- the task's next turn would edit one and
  // publishing would send the other.
  const made = await sites.create({ name: "马里奥", at: elsewhere });
  assert.equal(made.folder, elsewhere);
  assert.equal(made.slice, null, "收进来的目录不接表格");
  await assert.rejects(() => sites.create({ name: "又一个", at: elsewhere }), /已经是一个网站/);
  await assert.rejects(() => sites.create({ name: "相对路径", at: "not/absolute" }), /绝对路径/);
  assert.deepEqual((await open()).list().map((site) => site.folder), [elsewhere]);
});

// Found in review before .270: the desktop gave up on a publish after 60
// seconds while the server's content check could still be reading the page, and
// went on to publish it; publishing again put up a second site. The first
// publish now goes out under an id kept beforehand.
test("a first publish goes out under an id kept before it is sent, the same id until the site is known to be up", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  const site = await sites.create({ name: "联系表" });
  const first = (await sites.recordPublishing(site.id)).publishingId;
  assert.match(first, /^[0-9a-f-]{36}$/);
  assert.equal((await sites.recordPublishing(site.id)).publishingId, first, "asked again: the same id");
  assert.equal((await open()).get(site.id).publishingId, first, "kept across a restart, as a quit in the middle needs");
  await sites.recordPublish(site.id, { publishedId: first, url: "https://sites.example/s/x/", scope: "anyone" });
  assert.deepEqual([sites.get(site.id).publishedId, sites.get(site.id).publishingId], [first, null], "up: the id is the site's own now");
  assert.equal((await sites.recordPublishing(site.id)).publishingId, null, "published: no new id is minted");
  // Taken off the server: the next first publish gets an id of its own.
  await sites.recordPublish(site.id, {});
  const next = (await sites.recordPublishing(site.id)).publishingId;
  assert.ok(next && next !== first);
});

// Found in the third review before .270: every write saved the whole list from
// what it had read, so a refresh recorded at the same moment as a publish's
// kept id lost one of them -- and a lost id brings back the second site.
test("writes at the same moment are all kept", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  const table = await sites.create({ name: "看板", slice });
  const files = await sites.create({ name: "报名页" });
  await Promise.all([
    sites.recordRead(table.id, { readAt: 1, rowCount: 12, digest: "d1" }),
    sites.recordPublishing(files.id),
    sites.rename(table.id, "销售看板"),
  ]);
  const reread = await open();
  assert.deepEqual([reread.get(table.id).rowCount, reread.get(table.id).name, Boolean(reread.get(files.id).publishingId)], [12, "销售看板", true]);
});

// Fifth review before .270: whether a published site is up, and for whom, was
// only ever what this desktop last did to it; the server's word now replaces it.
test("what the server says of a published site replaces what this desktop last did, and only that", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  const site = await sites.create({ name: "看板", slice });
  await sites.recordPublish(site.id, { publishedId: "6f0d2c1e-0000-4000-8000-0000000000cc", url: "https://sites.example/s/x/", scope: "invited", offline: true });
  const before = sites.get(site.id);
  await sites.recordServer(site.id, { offline: false, scope: "anyone", inherit: false });
  const after = (await open()).get(site.id);
  assert.deepEqual([after.publishedOffline, after.publishedScope, after.publishedInherit], [false, "anyone", false]);
  assert.deepEqual([after.publishedAt, after.url, after.publishedId], [before.publishedAt, before.url, before.publishedId], "when it went up and its link stay");
});

// Only on this computer (docs/sites-phase0.md §0.5): a published site taken out
// of this list stays up, keeps its folder, its record and its refresh, and
// comes back exactly as it was. A site nobody can open has nothing to hide:
// it leaves the list (forget).
test("a published site hidden on this computer keeps everything, and comes back as it was", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  const site = await sites.create({ name: "看板", slice });
  await assert.rejects(() => sites.setHidden(site.id, true), /还没有发布/);
  await sites.recordPublish(site.id, { publishedId: "6f0d2c1e-0000-4000-8000-0000000000dd", url: "https://sites.example/s/x/", scope: "tenant" });
  const before = sites.get(site.id);
  await sites.setHidden(site.id, true);
  const hidden = (await open()).get(site.id);
  assert.equal(hidden.hidden, true, "kept across a restart");
  assert.deepEqual(sites.list().map((row) => row.id), [site.id], "still in the store: still refreshed, still followed");
  await sites.setHidden(site.id, false);
  const back = (await open()).get(site.id);
  assert.deepEqual({ ...back, hidden: undefined }, { ...before, hidden: undefined });
  assert.notEqual(back.hidden, true);
  assert.equal((await stat(site.folder)).isDirectory(), true);
});

test("a full read keeps what the table said of itself; a check moves only when it was looked at; a push is remembered", async (t) => {
  const { open } = await store(t);
  const sites = await open();
  const site = await sites.create({ name: "客户看板", slice });
  await sites.recordRead(site.id, { readAt: 1000, rowCount: 3, digest: "d1", key: "k1:d1", probe: "7:3" });
  assert.equal(sites.get(site.id).key, "k1:d1");
  assert.deepEqual([sites.get(site.id).probe, sites.get(site.id).fullReadAt, sites.get(site.id).lastReadAt], ["7:3", 1000, 1000]);
  const checked = await sites.recordCheck(site.id, 5000);
  assert.deepEqual([checked.lastReadAt, checked.fullReadAt, checked.probe, checked.digest], [5000, 1000, "7:3", "d1"], "nothing was read: only when it was looked at");
  await sites.recordPushed(site.id, "k1:d1");
  const reopened = (await open()).get(site.id);
  assert.deepEqual([reopened.lastReadAt, reopened.fullReadAt, reopened.probe, reopened.pushedKey], [5000, 1000, "7:3", "k1:d1"], "kept across restarts");
  await sites.recordRead(site.id, { readAt: 9000, rowCount: 3, digest: "d2", probe: "8:3", probeBefore: "7:3", probeMissed: true, reader: 2 });
  const again = (await open()).get(site.id);
  assert.deepEqual([again.probe, again.probeBefore, again.probeMissed, again.reader], ["8:3", "7:3", true, 2], "and which reader made it (site-refresh.js)");
  await sites.recordRead(site.id, { readAt: 9500, rowCount: 3, digest: "d2" });
  assert.equal(sites.get(site.id).probe, null, "a read with no probe leaves none behind to compare with");
  assert.equal(sites.get(site.id).probeMissed, false, "the caller carries a miss forward; the store only keeps what it is told");
  await assert.rejects(() => sites.recordCheck("nope"), /找不到这个网站/);
});

test("a site's folder is named for it, so a coding task on it shows a name and not an id", async (t) => {
  const { root, open } = await store(t);
  const sites = await open();
  const one = await sites.create({ name: "入职指南" });
  const two = await sites.create({ name: "入职指南" });
  assert.match(path.basename(one.folder), /^入职指南-[0-9a-f]{8}$/);
  assert.notEqual(one.folder, two.folder, "two sites of one name are two folders");
  assert.equal(path.dirname(one.folder), root);
  assert.match(path.basename((await sites.create({ name: "..销售 周报·2026 版." })).folder), /^销售-周报-2026-版-[0-9a-f]{8}$/, "nothing the file system treats specially, no dot to hide it");
  assert.match(path.basename((await sites.create({ name: "· . ·" })).folder), /^[0-9a-f-]{36}$/, "nothing left of the name: the id");
});

// 2026-10-08: a site nobody published could not be deleted, only taken out of
// the list. 删除 sends its folder to the Trash -- and only a folder the store
// made: a site joined from a folder of the person's own would take their
// project with it (main.js site-delete).
test("only a folder the store made itself can be deleted with its site", async (t) => {
  const { directory, root, open } = await store(t);
  const sites = await open();
  const made = await sites.create({ name: "空网站" });
  assert.equal(await sites.ownedFolder(made.id), made.folder.replace(/^\/var\//, "/private/var/"));
  // A folder of the person's own, joined to the list.
  const project = path.join(directory, "我的项目"); await mkdir(project);
  const joined = await sites.create({ name: "我的项目", at: project });
  assert.equal(await sites.ownedFolder(joined.id), null);
  // A site's folder swapped for a link out of the root.
  const linked = await sites.create({ name: "被换成链接" });
  await rm(linked.folder, { recursive: true }); await symlink(project, linked.folder);
  assert.equal(await sites.ownedFolder(linked.id), null);
  // Gone from disk: nothing to delete.
  const gone = await sites.create({ name: "目录没了" });
  await rename(gone.folder, path.join(directory, "挪走了"));
  assert.equal(await sites.ownedFolder(gone.id), null);
  assert.equal(await stat(project).then((entry) => entry.isDirectory()), true, "nothing here deletes anything");
});

