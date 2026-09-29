import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { buildDocumentIndex, profileState, exportProfiles, importProfiles, PROFILE_TERMS } from "../src/knowledge/retrieval.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";

const identity = { principal: "alice", tenantKey: "tenant-a", verifiedAt: 1000 };
const document = (key, text) => ({ providerId: "fixture", resourceId: `Doc${key}`, sourceUrl: `https://test.feishu.cn/docx/Doc${key}`,
  sourceRevision: "1", contentHash: `hash-${key}-${text.length}`, title: `文档 ${key}`, text, partial: false, warnings: [], identity });

const REPORT = "# 报销标准\n> 生效日期：2026-01-01\n\n一线城市住宿费上限每晚 500 元，其余城市 380 元。\n跨城出行默认高铁二等座，航班仅在当日往返时可选。\n";
const LEAVE = "# 请假管理办法\n> 生效日期：2026-03-01\n\n连续三天以内由直属上级批准，超过三天报部门负责人。\n年假当年有效，次年三月底前清零。\n";

async function fixture(t, documents = { a: REPORT, b: LEAVE }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-profiles-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "wiki.enc"), cipher = fixtureCipher();
  const sources = new Map(Object.entries(documents).map(([key, text]) => [`https://test.feishu.cn/docx/Doc${key}`, document(key, text)]));
  const provider = { documentIdentity: async () => identity, readDocument: async (url) => structuredClone(sources.get(url)) };
  let clock = 5_000_000;
  const open = () => new LocalWiki({ filename, provider, cipher, now: () => clock });
  const rows = async () => JSON.parse(gunzipSync(Buffer.from(cipher.decrypt(await readFile(`${filename}.profiles`)), "base64")).toString("utf8")).rows;
  return { filename, open, rows, sources, cipher, tick: (ms) => { clock += ms; } };
}

test("第一次提问算出来的词表会留在磁盘上，重启后不必再算一遍", async (t) => {
  const f = await fixture(t);
  const first = f.open();
  await first.load();
  for (const source of f.sources.values()) await first.observe(source);
  await first.queue;
  // 一次真实提问所做的事：先挑文档，再去核验。
  buildDocumentIndex(first.pages);
  await first.close();
  const file = await stat(`${f.filename}.profiles`);
  assert.equal(file.mode & 0o777, 0o600, "词表和正文一样是这个人的东西，不能给别人读");
  const bytes = await readFile(`${f.filename}.profiles`);
  assert.equal(bytes.includes(Buffer.from("住宿费")), false, "词表必须和知识副本一样加密");
  const saved = await f.rows();
  assert.equal(saved.length, 2);
  assert.ok(saved[0].terms.length && saved[0].terms.length <= PROFILE_TERMS);

  // 真正要证明的是「只靠磁盘上的内容就能还原」。同一个进程里词表缓存本来就在，
  // 所以这里用一个全新的模块实例，它什么都没算过。
  const cold = await import(`../src/knowledge/retrieval.js?restore=${Date.now()}`);
  const second = f.open();
  await second.load();
  assert.equal(cold.profileState(second.pages), "", "全新实例一开始什么都没有");
  assert.equal(cold.importProfiles(saved), 2);
  assert.equal(cold.profileState(second.pages).split("\n").filter(Boolean).length, 2, "重启后两篇的词表都该直接可用，不必重新分词");
  const index = cold.buildDocumentIndex(second.pages);
  assert.equal(index.size, 2);
  assert.ok(cold.rankDocuments(index, "住宿费上限")[0].page.title === "文档 a", "还原出来的词表要能照常选出文档");
  await second.close();
});

test("词表只描述此刻存着的那一版；正文变了或来源被移除，磁盘上的旧词表当场消失", async (t) => {
  const f = await fixture(t);
  const wiki = f.open();
  await wiki.load();
  for (const source of f.sources.values()) await wiki.observe(source);
  await wiki.queue;
  buildDocumentIndex(wiki.pages);
  await wiki.rememberProfiles(wiki.pages, { force: true });
  assert.equal((await f.rows()).length, 2);

  const leave = wiki.pages.find((page) => page.title === "文档 b");
  await wiki.forget(leave.id);
  const left = await f.rows();
  assert.deepEqual(left.map((row) => row.owner), [wiki.pages[0].owner], "被移除来源的词表不能留在磁盘上");
  assert.equal(left.length, 1);

  // 最后一篇也移除时，整个文件应该不见，而不是留下一个空壳。
  await wiki.forget(wiki.pages[0].id);
  await assert.rejects(stat(`${f.filename}.profiles`), (error) => error.code === "ENOENT");
  await wiki.close();
});

test("磁盘上的词表对不上就当没有：换了正文、文件被改坏，都只是慢一次，不会拿旧词表答题", async (t) => {
  const f = await fixture(t);
  const wiki = f.open();
  await wiki.load();
  for (const source of f.sources.values()) await wiki.observe(source);
  await wiki.queue;
  buildDocumentIndex(wiki.pages);
  await wiki.close();

  // 正文换了一版：contentHash 不同，旧词表描述的是已经不在的文字。
  const changed = await fixture(t, { a: `${REPORT}\n补充：出差补贴每日 120 元。`, b: LEAVE });
  await writeFile(`${changed.filename}.profiles`, await readFile(`${f.filename}.profiles`));
  const stale = changed.open();
  await stale.load();
  assert.equal(stale.pages.length, 0, "空库不受影响");
  await stale.close();

  await writeFile(`${f.filename}.profiles`, Buffer.from("这不是一个能解开的文件"));
  const broken = f.open();
  await broken.load();
  assert.equal(await broken.restoreProfiles(), 0, "读不了就当没有");
  assert.equal(broken.pages.length, 2, "词表坏了不能连知识副本一起丢掉");
  const hits = await broken.search("住宿费上限");
  assert.ok(hits.hits.some((hit) => hit.excerpt.includes("住宿费")), "照样能答，只是这一次要重新算词表");
  await broken.close();
});

test("换了一版的文档，只有这一版的词表会被接受", () => {
  const rows = [{ owner: "import:Doc1", contentHash: "v1", terms: ["住宿费", "上限"], counts: [3, 2] },
    { owner: "import:Doc2", contentHash: "v1", terms: ["住宿费"], counts: [0] },
    { owner: "import:Doc3", contentHash: "v1", terms: ["年假"], counts: [1, 2] },
    { owner: "import:Doc4", contentHash: "v1", terms: new Array(PROFILE_TERMS + 1).fill("词"), counts: new Array(PROFILE_TERMS + 1).fill(1) },
    { owner: "import:Doc5", terms: ["年假"], counts: [1] }];
  assert.equal(importProfiles(rows), 1, "只有形状正确的那一行能用：次数为零、长度对不上、词太多、没写版本，一律丢弃");
  assert.equal(importProfiles([{ owner: "import:Doc9", contentHash: "v1", terms: ["请假"], counts: [4] }]), 1);
  const page = { owner: "import:Doc9", contentHash: "v1", title: "请假", chunks: [{ text: "请假" }] };
  assert.deepEqual(exportProfiles([page])[0].terms, ["请假"], "导回来的是词本身，不是这个进程的编号");
  assert.deepEqual(exportProfiles([{ ...page, contentHash: "v2" }]), [], "另一版的正文没有词表，不能拿上一版顶替");
});

test("手上没算过词表，不等于该把磁盘上的词表删掉", async (t) => {
  const f = await fixture(t);
  const wiki = f.open();
  t.after(() => wiki.close());
  await wiki.load();
  for (const source of f.sources.values()) await wiki.observe(source);
  await wiki.queue;
  buildDocumentIndex(wiki.pages);
  await wiki.rememberProfiles(wiki.pages, { force: true });
  assert.equal((await f.rows()).length, 2);

  // 一组从没被索引过的页：此刻「手上一个词表都没有」，但磁盘上那份仍然有用
  // ——旧格式副本迁移时就是这个时刻，删掉它下一问就要重算一遍。
  const unknown = wiki.pages.map((page) => ({ ...page, contentHash: `${page.contentHash}-never-indexed` }));
  assert.equal(await wiki.rememberProfiles(unknown, { force: true }), false);
  assert.equal((await f.rows()).length, 2, "磁盘上的词表要留住");

  // 真的什么都不存了，才该消失。
  assert.equal(await wiki.rememberProfiles([], { force: true }), true);
  await assert.rejects(stat(`${f.filename}.profiles`), (error) => error.code === "ENOENT");
});
