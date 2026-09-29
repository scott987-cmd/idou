// Does retrieval actually put the answer in front of the model?
//
// Everything else about the knowledge copy is pinned by unit tests: what is
// stored, what is re-verified, what may reach a prompt. None of that says
// whether the passage holding the answer is the one that gets sent — and that
// is the whole point of the feature. This test runs the product's own path
// (knowledgeQuery → LocalWiki.search → knowledgeEvidence) over a fixed corpus
// of 16 generated company documents and 32 questions whose answers are known
// down to the sentence, and fails when coverage drops.
//
// The thresholds are floors under measured behaviour, not targets: at the time
// of writing this scores 68% / 100% / 100%, against 43% / 71% / 89% for the
// substring search it replaced. See test/fixtures/knowledge-eval/README.md.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { knowledgeQuery, knowledgeEvidence } from "../src/knowledge/task-scope.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/knowledge-eval/", import.meta.url));
// Floors, deliberately below what the code does today: this test is here to
// catch a regression, not to freeze the current numbers.
const FLOOR = { all: 0.7, some: 0.95, sourceDocument: 0.95 };
const identity = { tenantKey: "tenant_kbeval", principal: "principal_kbeval", verifiedAt: 1_700_000_000_000 };
const bare = (value) => String(value).replace(/\s+/gu, "");

test("检索评测：标准答案所依据的原文，要真的送到模型面前", async (t) => {
  const documents = new Map();
  for (const name of (await readdir(path.join(FIXTURE, "corpus"))).filter((file) => file.endsWith(".md")).sort()) {
    const text = await readFile(path.join(FIXTURE, "corpus", name), "utf8"), id = name.replace(/\.md$/, "");
    documents.set(`https://kbeval.feishu.cn/docx/KbEval${id}Doc0000000`, { id, text, title: (text.match(/^#\s+(.+)$/mu)?.[1] ?? id).trim() });
  }
  assert.equal(documents.size, 16);
  const read = (document, url) => ({ identity, providerId: "saas-cli", resourceId: `KbEval${document.id}Doc0000000`, sourceRevision: "1",
    contentHash: createHash("sha256").update(document.text).digest("hex"), sourceUrl: url, title: document.title, text: document.text, partial: false, warnings: [] });
  let reads = 0;
  const provider = { documentIdentity: async () => identity,
    readDocument: async (url) => { reads += 1; const document = documents.get(url); if (!document) throw new Error("no such document"); return read(document, url); } };

  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-eval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 1_700_000_100_000 });
  t.after(() => wiki.close());
  for (const [url, document] of documents) assert.ok(await wiki.observe(read(document, url)), `${document.id} 未被保留`);

  const questions = JSON.parse(await readFile(path.join(FIXTURE, "questions.json"), "utf8"));
  const answerable = questions.filter((question) => question.category !== "not-in-corpus");
  assert.equal(answerable.length, 28);
  const scored = { all: 0, some: 0, sourceDocument: 0 }, misses = [];
  let sent = 0;
  for (const question of answerable) {
    const result = await wiki.search(knowledgeQuery(question.question));
    const rows = knowledgeEvidence(result.hits);
    assert.ok(rows.length, `${question.id} 一条证据都没送出去`);
    assert.ok(rows.every((row) => row.excerpt.isWellFormed()), `${question.id} 送出了半个字符`);
    sent += rows.reduce((total, row) => total + row.excerpt.length, 0);
    const quoted = question.evidence.map((item) => rows.some((row) => bare(row.excerpt).includes(bare(item.quote))));
    const sources = new Set(question.source_docs.map((id) => `https://kbeval.feishu.cn/docx/KbEval${id}Doc0000000`));
    if (quoted.every(Boolean)) scored.all += 1; else misses.push(question.id);
    if (quoted.some(Boolean)) scored.some += 1;
    if (rows.some((row) => sources.has(row.sourceUrl))) scored.sourceDocument += 1;
  }
  const share = (count) => count / answerable.length;
  t.diagnostic(`证据齐全 ${Math.round(100 * share(scored.all))}% · 有部分证据 ${Math.round(100 * share(scored.some))}% · 命中正确文档 ${Math.round(100 * share(scored.sourceDocument))}% · 平均送出 ${Math.round(sent / answerable.length)} 字 · 重读 ${reads} 次`);
  assert.ok(share(scored.all) >= FLOOR.all, `证据齐全率跌到 ${Math.round(100 * share(scored.all))}%，低于 ${100 * FLOOR.all}%；漏掉：${misses.join(",")}`);
  assert.ok(share(scored.some) >= FLOOR.some, `有部分证据的比例跌到 ${Math.round(100 * share(scored.some))}%`);
  assert.ok(share(scored.sourceDocument) >= FLOOR.sourceDocument, `命中正确文档的比例跌到 ${Math.round(100 * share(scored.sourceDocument))}%`);

  // The four questions the corpus deliberately cannot answer must still bring
  // back something: the model needs enough to say "没有" with a reason, and a
  // silent empty result looks the same as a broken search.
  for (const question of questions.filter((item) => item.category === "not-in-corpus")) {
    const rows = knowledgeEvidence((await wiki.search(knowledgeQuery(question.question))).hits);
    assert.ok(rows.length, `${question.id} 应当仍然送回相关文档，让模型能说清楚哪里没有`);
  }

  // A name the question mentions brings the row that says who that is. Measured
  // on 2026-09-21: without it q12's evidence held nothing from the org chart, and
  // the Agent -- having read 「白鹭……负责人韩啸」 in one report -- answered three
  // times out of three that 韩啸 was "a project lead, not a department head",
  // which decides whether his own request skips a level.
  const q12 = questions.find((question) => question.id === "q12");
  const rows = knowledgeEvidence((await wiki.search(knowledgeQuery(q12.question))).hits);
  assert.ok(rows.some((row) => /平台研发部\|韩啸\||\|韩啸\|平台研发部\|部门经理/u.test(bare(row.excerpt))),
    "q12 的证据里应当有组织架构中写明韩啸是平台研发部负责人的那一行");
});

// 同一套语料，外加每篇 3 份「归档副本」——这是真实公司知识库最常见的样子，也是这
// 套检索最容易垮的地方：副本会把原件的特征词冲淡，让只有它答得上来的文档排不进去。
// 下限同样定在实测之下：写下时是 71% / 93% / 96%（16 篇干净语料是 75% / 100% / 100%）。
const DUPLICATE_FLOOR = { all: 0.6, some: 0.85, sourceDocument: 0.9 };

test("检索评测：库里塞满归档副本时，原件仍然要被挑中", async (t) => {
  const documents = new Map();
  for (const name of (await readdir(path.join(FIXTURE, "corpus"))).filter((file) => file.endsWith(".md")).sort()) {
    const text = await readFile(path.join(FIXTURE, "corpus", name), "utf8"), id = name.replace(/\.md$/, "");
    const title = (text.match(/^#\s+(.+)$/mu)?.[1] ?? id).trim();
    documents.set(`https://kbeval.feishu.cn/docx/KbEval${id}Doc0000000`, { id: `KbEval${id}Doc0000000`, text, title });
    // 副本：正文里的数字被挪过，标题写明是归档——谁都没被本人打开过。
    for (let copy = 0; copy < 3; copy += 1) {
      const shifted = text.replace(/(\d)/gu, (digit) => String((Number(digit) + copy + 1) % 10));
      documents.set(`https://kbeval.feishu.cn/docx/Copy${id}No${copy}`, { id: `Copy${id}No${copy}`, text: shifted, title: `${title}（20${20 + copy} 年归档）` });
    }
  }
  assert.equal(documents.size, 64);
  const read = (document, url) => ({ identity, providerId: "saas-cli", resourceId: document.id, sourceRevision: "1",
    contentHash: createHash("sha256").update(document.text).digest("hex"), sourceUrl: url, title: document.title, text: document.text, partial: false, warnings: [] });
  const provider = { documentIdentity: async () => identity,
    readDocument: async (url) => { const document = documents.get(url); if (!document) throw new Error("no such document"); return read(document, url); } };
  const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-eval-dup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 1_700_000_100_000 });
  t.after(() => wiki.close());
  for (const [url, document] of documents) await wiki.observe(read(document, url));
  await wiki.queue;

  const answerable = JSON.parse(await readFile(path.join(FIXTURE, "questions.json"), "utf8")).filter((question) => question.category !== "not-in-corpus");
  const scored = { all: 0, some: 0, sourceDocument: 0 }, misses = [];
  for (const question of answerable) {
    const rows = knowledgeEvidence((await wiki.search(knowledgeQuery(question.question))).hits);
    const quoted = question.evidence.map((item) => rows.some((row) => bare(row.excerpt).includes(bare(item.quote))));
    const sources = new Set(question.source_docs.map((id) => `https://kbeval.feishu.cn/docx/KbEval${id}Doc0000000`));
    if (quoted.every(Boolean)) scored.all += 1; else misses.push(question.id);
    if (quoted.some(Boolean)) scored.some += 1;
    if (rows.some((row) => sources.has(row.sourceUrl))) scored.sourceDocument += 1;
  }
  const share = (count) => count / answerable.length;
  t.diagnostic(`副本场景：证据齐全 ${Math.round(100 * share(scored.all))}% · 有部分证据 ${Math.round(100 * share(scored.some))}% · 命中原件 ${Math.round(100 * share(scored.sourceDocument))}%`);
  assert.ok(share(scored.sourceDocument) >= DUPLICATE_FLOOR.sourceDocument, `命中原件的比例跌到 ${Math.round(100 * share(scored.sourceDocument))}%：归档副本把原件挤掉了`);
  assert.ok(share(scored.all) >= DUPLICATE_FLOOR.all, `证据齐全率跌到 ${Math.round(100 * share(scored.all))}%；漏掉：${misses.join(",")}`);
  assert.ok(share(scored.some) >= DUPLICATE_FLOOR.some, `有部分证据的比例跌到 ${Math.round(100 * share(scored.some))}%`);
});

// 同一套语料外加一张合同台账，和真机上那张同构。点名一个合同编号问：台账要被读到，那一行要真的送到
// 模型面前。32 道评测题里没有一道带编号，所以上面两项测不出这件事；真机上量到过反例：台账排第一、
// 核验也过了，送出去的却是表头下的前十行——编号所在的那一行只带着编号这一个词，满篇「合同、到期、
// 状态」的段落先把 12,000 字的预算用完了。
test("检索评测：点名合同编号时，台账里那一行要真的送到模型面前", async (t) => {
  const { sheetKnowledgeSource, knowledgeSourceReader } = await import("../src/knowledge/sheet-source.js");
  const HEADER = ["合同编号", "客户名称", "所属行业", "客户负责人", "签订日期", "合同金额（万元）", "已回款（万元）", "服务到期日", "状态", "备注"];
  const CUSTOMERS = [["瀚川集团", "制造"], ["澜石科技", "互联网"], ["云岫教育", "教育"], ["鼎丰物流", "物流"], ["越秀医疗", "医疗"], ["长风传媒", "文化"], ["嘉和地产", "地产"], ["锦时零售", "零售"], ["北辰能源", "能源"], ["南屿旅游", "旅游"], ["恒益金融", "金融"]];
  const OWNERS = ["邱石", "沈佳禾", "许一帆", "陆泽", "唐雨桐", "韩啸"], STATUS = ["履行中", "已完成", "待启动", "已续签"];
  const columns = HEADER.map((_, index) => String.fromCharCode(65 + index));
  const code = (row) => `QL-HT-2026-${String(99 + row).padStart(4, "0")}`;
  const valueAt = (row, column) => {
    if (row === 1) return HEADER[column];
    const i = row - 2, [name, industry] = CUSTOMERS[i % CUSTOMERS.length];
    return [code(row), name, industry, OWNERS[i % OWNERS.length], `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
      (37.4 + i * 13.3).toFixed(1), (i * 7.1).toFixed(1), `2027-${String(((i + 5) % 12) + 1).padStart(2, "0")}-18`, STATUS[i % 4], i % 10 ? "" : "首付款 40%，验收后付清"][column];
  };
  const documents = new Map();
  for (const name of (await readdir(path.join(FIXTURE, "corpus"))).filter((file) => file.endsWith(".md")).sort()) {
    const text = await readFile(path.join(FIXTURE, "corpus", name), "utf8"), id = name.replace(/\.md$/, "");
    documents.set(`https://kbeval.feishu.cn/docx/KbEval${id}Doc0000000`, { id, text, title: (text.match(/^#\s+(.+)$/mu)?.[1] ?? id).trim() });
  }
  const read = (document, url) => ({ identity, providerId: "saas-cli", resourceId: `KbEval${document.id}Doc0000000`, sourceRevision: "1",
    contentHash: createHash("sha256").update(document.text).digest("hex"), sourceUrl: url, title: document.title, text: document.text, partial: false, warnings: [] });
  for (const rows of [121, 3000]) {
    const sheetUrl = `https://kbeval.feishu.cn/sheets/KbEvalLedger${rows}Sheet?sheet=s1`;
    const sheets = {
      readTable: async () => ({ kind: "feishu-sheet", providerId: "saas-cli", resourceId: `KbEvalLedger${rows}Sheet`, sheetId: "s1", sourceUrl: sheetUrl, sourceRevision: "5", contentHash: `ledger-${rows}`,
        title: "飞书电子表格 · Sheet1", sheets: [{ id: "s1", title: "Sheet1", kind: "sheet", hidden: false, rows, columns: columns.length }],
        rowIndices: Array.from({ length: rows }, (_, index) => index + 1), colIndices: columns,
        cells: Array.from({ length: rows }, (_, index) => columns.map((_, column) => ({ value: valueAt(index + 1, column) }))), truncated: false, warnings: [], identity }),
      revision: async () => ({ revision: "5", identity }),
    };
    const provider = knowledgeSourceReader({ documentIdentity: async () => identity,
      readDocument: async (url) => { const document = documents.get(url); if (!document) throw new Error("no such document"); return read(document, url); } }, sheetKnowledgeSource(sheets, { reference: SAAS_FEISHU.references.sheet }));
    const directory = await mkdtemp(path.join(os.tmpdir(), "knowledge-eval-ledger-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 1_700_000_100_000 });
    t.after(() => wiki.close());
    for (const [url, document] of documents) await wiki.observe(read(document, url));
    assert.ok(await wiki.observe(await provider.readDocument(sheetUrl)), "台账没有入库");
    const asks = [
      [`合同 ${code(99)} 的服务到期日和状态是什么？`, code(99)],
      [`合同 ${code(6)} 的到期日是哪天？`, code(6)],
      [`${code(rows)} 这份合同金额多少？`, code(rows)],
      [`${code(60).toLowerCase()} 是哪个客户的合同，谁负责？`, code(60)],
    ];
    const missed = [];
    for (const [question, wanted] of asks) {
      const evidence = knowledgeEvidence((await wiki.search(knowledgeQuery(question))).hits);
      if (!evidence.some((row) => row.sourceUrl === sheetUrl && row.excerpt.includes(wanted))) missed.push(question);
    }
    assert.deepEqual(missed, [], `${rows} 行的台账：这些问题点名的那一行没有送到模型面前`);
  }
});
