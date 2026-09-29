import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evidencePage } from "../src/knowledge/local-wiki.js";
import { knowledgeQuery } from "../src/knowledge/task-scope.js";

// 词频（一个词出现在几篇文档里）决定了哪篇文档值得重新读。它必须只取决于库里
// 有哪些文档，而不能取决于「这一次词表是现算的还是从磁盘恢复的」：真实账号上，
// 恢复后的词频只按每篇的 800 个特征词算，冷启动时按全文算，结果「生产临时权限
// 最多开多久」这一问在重启后再也选不中写着 8 小时新规定的那篇汇报，模型照着旧
// 规定答成了 24 小时。

const FIXTURE = fileURLToPath(new URL("./fixtures/knowledge-eval/", import.meta.url));
const identity = { tenantKey: "tenant-a", principal: "alice", verifiedAt: 1 };
let generation = 0;
const fresh = () => import(`../src/knowledge/retrieval.js?process=${process.pid}-${generation++}`);

async function corpus() {
  const sources = [];
  for (const name of (await readdir(path.join(FIXTURE, "corpus"))).filter((file) => file.endsWith(".md")).sort()) {
    const text = await readFile(path.join(FIXTURE, "corpus", name), "utf8"), id = name.replace(/\.md$/, "");
    sources.push({ identity, providerId: "fixture", resourceId: id, sourceRevision: "1", contentHash: createHash("sha256").update(text).digest("hex"),
      sourceUrl: `https://test.feishu.cn/docx/${id}`, title: (text.match(/^#\s+(.+)$/mu)?.[1] ?? id).trim(), text, partial: false, warnings: [] });
  }
  return { sources, pages: sources.map((source) => evidencePage(source, 1)) };
}

test("重启前后挑中的文档一模一样：词频不能因为词表是不是从磁盘恢复的而变", async () => {
  const { pages } = await corpus();
  const before = await fresh(), after = await fresh();
  const cold = before.buildDocumentIndex(pages);
  // 重启：新进程什么都没算过，只带着落盘的词表和词频回来。经过一次 JSON 往返，
  // 和真正写进文件再读出来一样。
  after.importProfiles(JSON.parse(JSON.stringify(before.exportProfiles(pages))));
  after.importFrequencies(JSON.parse(JSON.stringify(before.exportFrequencies())));
  const restored = after.buildDocumentIndex(pages);
  assert.equal(restored.frequency.size, cold.frequency.size, "恢复出来的词频项数必须和冷启动一致");
  const questions = JSON.parse(await readFile(path.join(FIXTURE, "questions.json"), "utf8"));
  for (const question of questions) {
    const terms = before.queryTerms(knowledgeQuery(question.question));
    const expected = before.rankDocuments(cold, terms, { limit: 8 }).map((hit) => hit.page.resourceId);
    const actual = after.rankDocuments(restored, terms, { limit: 8 }).map((hit) => hit.page.resourceId);
    assert.deepEqual(actual, expected, `${question.id} 重启后挑中的文档变了`);
  }
});

test("没有落盘词频可用时，宁可重新算一遍，也不拿词表凑一个不一样的词频", async () => {
  const { pages } = await corpus();
  const before = await fresh(), after = await fresh();
  const cold = before.buildDocumentIndex(pages);
  // 旧版侧车文件只有词表，没有词频。
  after.importProfiles(JSON.parse(JSON.stringify(before.exportProfiles(pages))));
  const rebuilt = after.buildDocumentIndex(pages);
  assert.equal(rebuilt.frequency.size, cold.frequency.size);
  for (const [term, count] of cold.frequency) assert.equal(rebuilt.frequency.get(term), count, `「${term}」的词频不一致`);
});

test("库里增删改了几篇之后，增量更新出来的词频必须和从头算的一模一样", async () => {
  const { sources, pages } = await corpus();
  const incremental = await fresh(), scratch = await fresh();
  incremental.buildDocumentIndex(pages.slice(0, 14));
  // 改一篇、删一篇、加两篇：这正是一次正常使用里库会发生的事。
  const changed = evidencePage({ ...sources[3], contentHash: `${sources[3].contentHash}-v2`, text: `${sources[3].text}\n\n补充：生产临时权限自 2026-08-15 起最长 8 小时。\n` }, 1);
  const next = [...pages.slice(0, 14).filter((_, index) => index !== 5).map((page, index) => (index === 3 ? changed : page)), pages[14], pages[15]];
  const updated = incremental.buildDocumentIndex(next).frequency;
  const expected = scratch.buildDocumentIndex(next).frequency;
  assert.equal(updated.size, expected.size, "增量更新后的词频项数和从头算不一致");
  for (const [term, count] of expected) assert.equal(updated.get(term), count, `「${term}」的词频不一致`);
});
