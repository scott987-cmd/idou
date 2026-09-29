import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
