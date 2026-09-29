import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { storedPages, storedBytes } from "../scripts/fixtures/wiki-store.js";

const identity = { principal: "alice", tenantKey: "tenant-a", verifiedAt: 1000 };
const document = (key, text) => ({ providerId: "fixture", resourceId: `Doc${key}`, sourceUrl: `https://test.feishu.cn/docx/Doc${key}`,
  sourceRevision: "1", contentHash: `hash-${key}-${text.length}`, title: `文档 ${key}`, text, partial: false, warnings: [], identity });
const fileFor = (owner) => `${createHash("sha256").update(owner).digest("hex")}.enc`;

async function fixture(t, texts = { a: "住宿费报销上限每晚 500 元。", b: "年假当年有效，次年三月底清零。", c: "报销单十个工作日内提交。" }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-pages-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "wiki.enc"), cipher = fixtureCipher();
  const sources = new Map(Object.entries(texts).map(([key, text]) => [`https://test.feishu.cn/docx/Doc${key}`, document(key, text)]));
  const provider = { documentIdentity: async () => identity, readDocument: async (url) => structuredClone(sources.get(url)) };
  const open = () => new LocalWiki({ filename, provider, cipher, now: () => 5_000_000 });
  const wiki = open();
  for (const source of sources.values()) await wiki.observe(source);
  await wiki.queue;
  return { directory, filename, cipher, sources, open, wiki,
    files: async () => (await readdir(`${filename}.d`)).sort(),
    // 页文件按这篇文档的 owner 命名，owner 由存下来的页自己给出。
    pageFile: async (title) => {
      const page = (await storedPages(cipher, filename)).find((item) => item.title === title);
      return path.join(`${filename}.d`, fileFor(page.owner));
    } };
}

test("一篇文档一个加密文件，清单说哪些算数；正文不以明文落在任何一个文件里", async (t) => {
  const f = await fixture(t);
  t.after(() => f.wiki.close());
  assert.equal((await f.files()).length, 3);
  assert.equal((await stat(f.filename)).mode & 0o777, 0o600);
  for (const name of await f.files()) assert.equal((await stat(path.join(`${f.filename}.d`, name))).mode & 0o777, 0o600);
  assert.equal((await storedBytes(f.filename)).includes(Buffer.from("住宿费")), false);
  assert.deepEqual((await storedPages(f.cipher, f.filename)).map((page) => page.title).sort(), ["文档 a", "文档 b", "文档 c"]);
  // 清单本身不带正文：它每次改动都要重写，越小越好。
  const manifest = JSON.parse(f.cipher.decrypt(await readFile(f.filename)));
  assert.equal(manifest.version, 2);
  assert.deepEqual(Object.keys(manifest.pages[0]).sort(), ["bytes", "owner", "state"]);
});

test("移除一篇，它的字节当场离开这台机器；最后一篇移除后目录里不留页文件", async (t) => {
  const f = await fixture(t);
  t.after(() => f.wiki.close());
  const list = await f.wiki.inventory();
  const gone = list.sources.find((source) => source.title === "文档 b");
  await f.wiki.forget(gone.id);
  assert.equal((await f.files()).length, 2);
  assert.equal((await storedBytes(f.filename)).includes(Buffer.from("年假")), false, "被移除文档的正文不能还躺在磁盘上");
  for (const source of (await f.wiki.inventory()).sources) await f.wiki.forget(source.id);
  assert.deepEqual(await f.files(), []);
  assert.deepEqual(await storedPages(f.cipher, f.filename), []);
});

test("写到一半崩掉留下的页文件，下一次写入时清掉；清单没认的文件不参与回答", async (t) => {
  const f = await fixture(t);
  t.after(() => f.wiki.close());
  const orphan = path.join(`${f.filename}.d`, fileFor("fixture:DocGhost"));
  await writeFile(orphan, await f.cipher.encrypt(JSON.stringify({ owner: "fixture:DocGhost", title: "半截文档" })), { mode: 0o600 });
  assert.equal((await f.files()).length, 4);
  const restarted = f.open();
  t.after(() => restarted.close());
  await restarted.load();
  assert.equal(restarted.pages.length, 3, "清单没认的文件不算库里的文档");
  await restarted.save(restarted.pages.map((page) => ({ ...page, usedAt: 6_000_000 })));
  assert.equal((await f.files()).length, 3, "下一次写入时把它清掉");
});

test("一篇页文件损坏只丢这一篇，并且说出来；其余照常回答", async (t) => {
  const f = await fixture(t);
  await f.wiki.close();
  await writeFile(await f.pageFile("文档 b"), Buffer.from("这不是一个能解开的文件"), { mode: 0o600 });
  const reopened = f.open();
  t.after(() => reopened.close());
  await reopened.load();
  assert.equal(reopened.pages.length, 2);
  assert.match(reopened.status().message, /1 篇本机副本读不出来/);
  assert.deepEqual(reopened.pages.map((page) => page.title).sort(), ["文档 a", "文档 c"]);
});

test("旧版的单文件副本会被原地迁移成一页一个文件，内容不变", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "wiki.enc"), cipher = fixtureCipher();
  const source = document("legacy", "旧版副本里的住宿费上限是 400 元。");
  const provider = { documentIdentity: async () => identity, readDocument: async () => structuredClone(source) };
  // 先用旧格式写一份：这正是升级前机器上的样子。
  const seed = new LocalWiki({ filename: path.join(directory, "seed.enc"), provider, cipher, now: () => 5_000_000 });
  await seed.observe(source); await seed.queue;
  const page = (await storedPages(cipher, path.join(directory, "seed.enc")))[0];
  await seed.close();
  await writeFile(filename, await cipher.encrypt(JSON.stringify({ version: 1, pages: [page] })), { mode: 0o600 });

  const wiki = new LocalWiki({ filename, provider, cipher, now: () => 5_000_000 });
  t.after(() => wiki.close());
  await wiki.load();
  assert.equal(wiki.pages.length, 1);
  assert.equal(JSON.parse(cipher.decrypt(await readFile(filename))).version, 2, "原来的路径变成清单");
  assert.deepEqual((await readdir(`${filename}.d`)).length, 1);
  assert.equal((await storedPages(cipher, filename))[0].chunks.map((chunk) => chunk.text).join(""), source.text);
  const found = await wiki.search("住宿费");
  assert.equal(found.hits.length, 1);
  assert.match(found.hits[0].excerpt, /400 元/);
});
