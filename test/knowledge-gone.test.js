import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";

const alice = { principal: "alice", tenantKey: "tenant-a", verifiedAt: 1000 };
const doc = (key, text, identity = alice) => ({ providerId: "fixture", resourceId: `Doc${key}`, sourceUrl: `https://test.feishu.cn/docx/Doc${key}`,
  sourceRevision: "1", contentHash: `hash-${key}`, title: `文档 ${key}`, text, partial: false, warnings: [], identity });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-gone-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "wiki.enc"), cipher = fixtureCipher();
  let clock = 10_000, identity = alice;
  const documents = new Map(), broken = new Set();
  const provider = {
    documentIdentity: async () => identity,
    readDocument: async (url) => { if (broken.has(url)) throw new Error("暂时读不到"); return structuredClone(documents.get(url)); },
  };
  const open = () => new LocalWiki({ filename, provider, cipher, now: () => clock, ...options });
  const wiki = open();
  t.after(() => wiki.close());
  const add = async (source) => { documents.set(source.sourceUrl, source); await wiki.observe(source); await wiki.queue; };
  return { wiki, open, add, tick: (ms) => { clock += ms; }, break: (url) => broken.add(url), as: (value) => { identity = value; } };
}

test("三十天没再用到被清理的来源，清单里要说出来是哪篇、为什么", async (t) => {
  const f = await fixture(t, { retentionMs: 5_000 });
  await f.add(doc("A", "住宿费报销上限每晚 500 元。"));
  f.tick(6_000);
  await f.add(doc("B", "年假当年有效，次年三月底清零。"));
  const listed = await f.wiki.inventory();
  assert.deepEqual(listed.sources.map((source) => source.title), ["文档 B"]);
  assert.equal(listed.gone.length, 1);
  assert.equal(listed.gone[0].title, "文档 A");
  assert.equal(listed.gone[0].reason, "expired");
  assert.equal(listed.gone[0].sourceUrl, "https://test.feishu.cn/docx/DocA", "要能直接点回原文");
  assert.match(f.wiki.status().message, /文档 A/, "状态栏当场说一声");
});

test("本人亲手移除的不算「被清理」：他自己知道", async (t) => {
  const f = await fixture(t);
  await f.add(doc("A", "住宿费报销上限每晚 500 元。"));
  await f.add(doc("B", "年假当年有效。"));
  const target = (await f.wiki.inventory()).sources.find((source) => source.title === "文档 A");
  await f.wiki.forget(target.id);
  assert.deepEqual((await f.wiki.inventory()).gone, []);
});

test("超过篇数上限时，最久没用到的被挤出去，也要说", async (t) => {
  const f = await fixture(t, { maxDocuments: 2 });
  await f.add(doc("A", "第一篇。"));
  f.tick(10);
  await f.add(doc("B", "第二篇。"));
  f.tick(10);
  await f.add(doc("C", "第三篇。"));
  const listed = await f.wiki.inventory();
  assert.deepEqual(listed.sources.map((source) => source.title).sort(), ["文档 B", "文档 C"]);
  assert.deepEqual(listed.gone.map((item) => [item.title, item.reason]), [["文档 A", "count"]]);
});

test("连续三次读不回来被移除的，同样记下来", async (t) => {
  const f = await fixture(t);
  await f.add(doc("A", "采购申请单笔超过三万元需要财务负责人审批。"));
  f.break("https://test.feishu.cn/docx/DocA");
  for (let attempt = 0; attempt < 3; attempt += 1) await f.wiki.search("采购审批");
  const listed = await f.wiki.inventory();
  assert.equal(listed.sources.length, 0);
  assert.deepEqual(listed.gone.map((item) => [item.title, item.reason]), [["文档 A", "unreadable"]]);
});

test("清理记录跟着副本一起落盘，重启后仍然看得到；换一个账号看不到", async (t) => {
  const f = await fixture(t, { retentionMs: 5_000 });
  await f.add(doc("A", "住宿费报销上限每晚 500 元。"));
  f.tick(6_000);
  await f.add(doc("B", "年假当年有效。"));
  await f.wiki.close();
  const reopened = f.open();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.inventory()).gone.map((item) => item.title), ["文档 A"], "重启后清理记录还在");
  f.as({ principal: "bob", tenantKey: "tenant-a", verifiedAt: 2000 });
  assert.deepEqual((await reopened.inventory()).gone, [], "别人的清理记录不给另一个账号看");
});
