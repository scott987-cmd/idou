import test from "node:test";
import assert from "node:assert/strict";
import { chunkSpans, termCounts, queryTerms, buildIndex, buildDocumentIndex, rankDocuments, rankChunks, excerptSpan, selectExcerpts, CHUNK_MAX, CHUNK_MIN } from "../src/knowledge/retrieval.js";

const page = (owner, title, text) => ({ owner, title, id: owner.repeat(64).slice(0, 64),
  chunks: chunkSpans(text).map((span) => ({ ...span, id: `${owner}:${span.start}`, text: text.slice(span.start, span.end) })), text });
const index = (...pages) => buildIndex(pages);

test("分段是原文的无损切分：拼回去要一模一样，每段都是原文的一段切片", () => {
  const texts = [
    "# 标题\n\n第一段。\n\n## 小节\n正文很短。\n",
    "没有任何换行的一长串中文".repeat(400),
    `${"行\n".repeat(2000)}`,
    "中😀".repeat(900),
    "",
  ];
  for (const text of texts) {
    const spans = chunkSpans(text);
    assert.equal(spans.map((span) => text.slice(span.start, span.end)).join(""), text);
    for (const span of spans) {
      assert.ok(span.end > span.start);
      assert.ok(span.end - span.start <= CHUNK_MAX, `${span.end - span.start} 超过上限`);
      assert.ok(text.slice(span.start, span.end).isWellFormed(), "不能切出半个字符");
    }
    for (let i = 1; i < spans.length; i++) assert.equal(spans[i].start, spans[i - 1].end, "段与段之间不能有重叠或空隙");
  }
});

test("标题另起一段，短小节不会被切碎", () => {
  const text = `## 第一节\n${"甲".repeat(300)}\n## 第二节\n${"乙".repeat(300)}\n### 第三节\n${"丙".repeat(300)}\n`;
  const spans = chunkSpans(text);
  const heads = spans.map((span) => text.slice(span.start, span.start + 5));
  assert.ok(heads.filter((head) => head.startsWith("##")).length >= 2, `标题应当在段首：${JSON.stringify(heads)}`);
  for (const span of spans.slice(0, -1)) assert.ok(span.end - span.start >= CHUNK_MIN, "不能切出没有上下文的碎片");
});

test("切词：中文既出单字也出双字，数字跟着它修饰的词，英文按词", () => {
  const counts = termCounts("请假 4 天 Q3 OKR 达标");
  for (const term of ["请", "假", "请假", "4", "q3", "okr", "达标"]) assert.ok(counts.has(term), `缺少 ${term}`);
  assert.deepEqual(queryTerms(""), []);
  assert.ok(queryTerms("我下个月想请 4 天假，审批要走到谁那一级？").includes("假"), "问题里被数字隔开的字也要能检索");
});

test("常见词压不过罕见词：到处都出现的「审批」不能把「请假」挤掉", () => {
  const leave = page("a", "考勤与休假管理制度", "## 第十九条 请假审批层级\n请假 3 天以上：直属上级 → 部门负责人 → HR 负责人。\n");
  const purchase = page("b", "采购管理制度", `## 审批权限\n${"采购审批按金额分级，逐级审批，审批人见下表。".repeat(20)}\n`);
  const notice = page("c", "关于调整请购审批权限的通知", `请购单审批权限调整，审批层级如下。${"审批".repeat(50)}\n`);
  const hits = rankChunks(index(leave, purchase, notice), "我下个月想请 4 天假，审批要走到谁那一级？", { limit: 3 });
  assert.equal(hits[0].page.owner, "a", `排在前面的应当是考勤制度，实际：${hits.map((hit) => hit.page.owner).join(",")}`);
});

test("文档的分量只能在相关的结果之间排序，不能凭空造出一个命中", () => {
  const fresh = page("a", "出差报销管理制度（2026 修订版）", "## 第十六条\nM2 属第二档，火车可乘一等座。\n");
  const old = page("b", "差旅费报销管理办法（2025 版）", "## 第十五条\nC 类人员乘坐二等座，M2 属 C 类。\n");
  const unrelated = page("c", "信息安全管理规范", "数据分级与外发审批。\n");
  const prior = (candidate) => (candidate.owner === "a" ? 3 : 1);
  const hits = rankChunks(index(fresh, old, unrelated), "我是 M2，坐高铁能买一等座吗？", { prior });
  assert.equal(hits[0].page.owner, "a");
  assert.ok(!hits.some((hit) => hit.page.owner === "c"), "没有匹配的文档，权重再高也不能进结果");
  assert.ok(hits.every((hit) => hit.relevance > 0));
});

test("同一篇最多给几段，结果稳定可重复", () => {
  const long = page("a", "制度", `${"## 小节\n请假规定与请假流程。\n".repeat(40)}`);
  const hits = rankChunks(index(long), "请假", { perDocument: 3 });
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((hit) => hit.chunk.id), rankChunks(index(long), "请假", { perDocument: 3 }).map((hit) => hit.chunk.id));
});

test("摘录向上长到它所属的标题，并带上表头，本身仍是原文的一段切片", () => {
  const text = `# 出差报销管理制度\n\n## 第十六条 城际交通\n\n| 出差档位 | 飞机 | 火车 |\n|---|---|---|\n| 第一档 | 头等舱 | 一等座 |\n| 第二档 | 经济舱 | 一等座 |\n${"| 第三档 | 经济舱 | 二等座 |\n".repeat(200)}`;
  const doc = page("a", "出差报销管理制度", text);
  const first = excerptSpan(text, doc.chunks[0], { maxChars: 900 });
  assert.equal(text.slice(first.start, first.end).length, first.end - first.start);
  assert.ok(first.end - first.start <= 900);
  assert.match(first.heading, /出差报销管理制度/, "摘录要说明自己出自哪一节");
  // A row far down the table: the header is too far above to quote everything
  // in between, so it travels with the section label instead.
  const deep = excerptSpan(text, doc.chunks.at(-1), { maxChars: 900 });
  assert.ok(deep.start > text.indexOf("| 第三档"), "这一段离表头已经很远");
  assert.match(text.slice(deep.start, deep.end), /第三档/);
  assert.match(deep.heading, /出差档位 \| 飞机 \| 火车/, "表格行必须带着表头一起交给模型");
});

test("一篇里重叠的两处命中合成一段，预算用完就停", () => {
  const text = `## 一\n${"甲".repeat(400)}\n## 二\n${"乙".repeat(400)}\n## 三\n${"丙".repeat(400)}\n`;
  const doc = page("a", "文档", text);
  const hits = doc.chunks.slice(0, 2).map((chunk) => ({ page: doc, chunk, score: 1, relevance: 1 }));
  const rows = selectExcerpts(hits, { maxChars: 4000, excerptChars: 1200, pageText: (value) => value.text });
  assert.equal(rows.length, 1, "相邻命中不该把同一段内容算两次");
  const tiny = selectExcerpts(hits, { maxChars: 10, excerptChars: 1200, pageText: (value) => value.text });
  assert.equal(tiny.length, 0, "预算装不下就不送");
});

test("同一批文档换个顺序仍是同一个索引，内容一变就重建", () => {
  const a = page("a", "考勤与休假管理制度", "## 第十九条 请假审批层级\n请假 3 天以上：直属上级 → 部门负责人 → HR 负责人。\n");
  const b = page("b", "采购管理制度", "## 审批权限\n采购审批按金额分级。\n");
  // The store re-sorts itself by what was used most recently, so the same
  // documents arrive in a different order after every search; rebuilding the
  // whole index each time was the single largest cost at a thousand documents.
  assert.equal(buildIndex([a, b]), buildIndex([b, a]), "顺序不同不该算成另一个索引");
  const changed = page("a", "考勤与休假管理制度", "## 第十九条 请假审批层级\n改成两级审批。\n");
  assert.notEqual(buildIndex([changed, b]), buildIndex([a, b]), "内容变了必须重建");
});

test("选候选看的是整篇文档的画像，只保留能把它和别的文档区分开的词", () => {
  const leave = page("a", "考勤与休假管理制度", `## 第十九条 请假审批层级\n请假 3 天以上：直属上级 → 部门负责人 → HR 负责人（杜若）。\n${"公司规定通用条款。\n".repeat(40)}`);
  const purchase = page("b", "采购管理制度", `## 审批权限\n${"采购审批按金额分级，逐级审批。\n".repeat(40)}`);
  const index = buildDocumentIndex([leave, purchase]);
  assert.equal(index.documents, true);
  assert.equal(rankDocuments(index, "请假 审批 层级 杜若")[0].page.owner, "a");
  // Ranking a document is the same arithmetic as ranking a passage, including
  // the standing prior: a document nothing matched cannot be lifted into the
  // result by being important.
  assert.deepEqual(rankDocuments(index, "完全无关的词", { prior: () => 5 }), []);
  const demoted = rankDocuments(index, "审批", { prior: (candidate) => (candidate.owner === "b" ? 0.75 : 1) });
  assert.ok(demoted.every((hit) => hit.relevance > 0));
});

test("画像按内容缓存：同一批文档换个顺序还是同一份索引", () => {
  const a = page("a", "考勤与休假管理制度", "请假 3 天以上要三级审批。\n");
  const b = page("b", "采购管理制度", "采购按金额分级审批。\n");
  assert.equal(buildDocumentIndex([a, b]), buildDocumentIndex([b, a]));
});

test("问题里最稀有的那几个词说了算：带着它的那一段被抬起来，只复述常见词的段落不动", () => {
  const make = (owner, title, text) => ({ owner, id: owner.repeat(64).slice(0, 64), title, revision: "1", sourceUrl: `https://x/${owner}`,
    warnings: [], contentHash: `${owner}:${text.length}`, chunks: chunkSpans(text).map((span) => ({ ...span, id: `${owner}-${span.start}`, text: text.slice(span.start, span.end) })) });
  // 复述问题里几乎所有常见词、却没有答案的段落；真正的答案只带着 P6 和南京。
  const chatter = Array.from({ length: 4 }, (_, index) => make(`faq${index}`, `差旅常见问题 ${index}`,
    `# 差旅常见问题 ${index}\n\n我下周去出差，住宿报销上限是多少？住宿报销上限按出差标准执行，是多少要看档位。\n`));
  const answer = make("rule", "出差报销管理制度",
    "# 出差报销管理制度\n\n## 第十四条 出差档位\n\n| 出差档位 | 一类城市 | 二类城市 |\n|---|---|---|\n| 第三档（M1、P6、P7） | 600 | 450 |\n\n南京、成都属于二类城市，P6 适用第三档。\n");
  const pages = [...chatter, answer];
  const terms = queryTerms("我是 P6，下周去南京出差，住宿报销上限是多少");
  const gap = (coverage) => {
    const ranked = rankChunks(buildIndex(pages), terms, { limit: 10, perDocument: 2, coverage });
    const carrying = ranked.find((hit) => hit.page.owner === "rule").score;
    const echoing = ranked.find((hit) => hit.page.owner.startsWith("faq")).score;
    return carrying / echoing;
  };
  assert.ok(gap(1) > gap(0) * 1.1, `带着 P6 的那一段要被拉开差距：${gap(0).toFixed(2)} → ${gap(1).toFixed(2)}`);
  // 库里根本没有的词（「我是」「下周去」这种）不能算「稀有」，否则它们会占掉名额，
  // 真正指向答案的词反而不起作用。
  const absent = queryTerms("我是 P6，下周去南京出差，住宿报销上限是多少，另外问一句瀚川集团违约金");
  const ranked = rankChunks(buildIndex(pages), absent, { limit: 10, perDocument: 2, coverage: 1 });
  assert.equal(ranked[0].page.owner, "rule", "多问一句库里没有的事，不该把答案挤下去");
});

// 真机上量到的：121 行的合同台账排第一、也核验过了，送出去的却是表头下的前十行——点名的编号所在那一行
// 只带着编号这一个词，复述「合同、到期、状态」的段落个个分数比它高，把摘录预算先用完了。
test("问题点名的编号：含它的段落排到最前，每个编号最多两段；遍布多篇文档的（通常是日期）不抬", () => {
  const make = (owner, title, text) => ({ owner, id: owner.repeat(64).slice(0, 64), title, revision: "1", sourceUrl: `https://x/${owner}`,
    warnings: [], contentHash: `${owner}:${text.length}`, chunks: chunkSpans(text).map((span) => ({ ...span, id: `${owner}-${span.start}`, text: text.slice(span.start, span.end) })) });
  const prose = Array.from({ length: 3 }, (_, index) => make(`rule${index}`, `合同管理制度 ${index}`,
    `# 合同管理制度 ${index}\n\n合同到期前三十天确认合同状态，服务到期日以合同约定为准，状态变更要登记，2027-03-18 起执行。\n`));
  const rows = Array.from({ length: 120 }, (_, index) => `| QL-HT-2026-${String(101 + index).padStart(4, "0")} | 客户${index} | 2027-03-18 | 履行中 |`);
  const ledger = make("ledger", "飞书电子表格 · 台账", `# 飞书电子表格 · 台账\n\n| 合同编号 | 客户 | 服务到期日 | 状态 |\n|---|---|---|---|\n${rows.join("\n")}\n`);
  const ask = (pages, question, identifiers) => rankChunks(buildIndex(pages), queryTerms(question), { limit: 12, perDocument: 4, coverage: 1, identifiers });
  const holds = (hit, value) => hit.chunk.text.includes(value);

  const question = "合同 ql-ht-2026-0198 的服务到期日和状态是什么？";
  assert.equal(holds(ask([...prose, ledger], question, [])[0], "QL-HT-2026-0198"), false, "前提：只凭排序，那一行排不到最前");
  assert.ok(holds(ask([...prose, ledger], question, ["ql-ht-2026-0198"])[0], "QL-HT-2026-0198"), "大小写不同也是同一个编号，含它的那一段排第一");

  // 一份合同摘要里三处写着同一个编号：最多抬两段，第三段按原来的分数排。
  const summary = make("summary", "合同摘要", ["一", "二", "三"].map((part) => `## 第${part}部分\n${"条".repeat(300)} QL-HT-2026-0198 ${"款".repeat(300)}\n`).join("\n"));
  const capped = ask([...prose, summary], question, ["QL-HT-2026-0198"]);
  assert.deepEqual(capped.slice(0, 3).map((hit) => holds(hit, "QL-HT-2026-0198")), [true, true, false]);

  // 四篇文档都写着的日期不指向任何一篇：有没有它，顺序都一样。
  const dated = "2027-03-18 到期的合同有哪些？";
  assert.deepEqual(ask([...prose, ledger], dated, ["2027-03-18"]).map((hit) => hit.chunk.id), ask([...prose, ledger], dated, []).map((hit) => hit.chunk.id));
});

// A roster answers to a name, and ranking never sends its row: the row holds the
// one word of the question and nothing else it says (retrieval.js,
// questionCellNames). Built like the case measured on 2026-09-21 -- the name is
// also a cell in a project tracker that matches the rest of the question better.
test("a name the question mentions sends the row that names it, from each document that has one", async () => {
  const { chunkSpans, buildIndex, rankChunks, queryTerms, questionCellNames } = await import("../src/knowledge/retrieval.js");
  const page = (owner, text) => ({ owner, id: owner, title: owner, contentHash: owner,
    chunks: chunkSpans(text).map((span, index) => ({ id: `${owner}#${index}`, start: span.start, end: span.end, text: text.slice(span.start, span.end) })) });
  const rules = (n) => Array.from({ length: n }, (_, i) => `第 ${i + 1} 条 采购申请的审批按金额分级，部门负责人审批后交财务负责人，比价按规定执行。`).join("\n\n");
  const office = (n) => Array.from({ length: n }, (_, i) => `第 ${i + 1} 条 办公区在 12 层，访客在前台登记，班车早上八点发车。`).join("\n\n");
  const pages = [
    page("roster", `# 组织架构\n\n${office(6)}\n\n## 部门设置\n\n|部门|负责人|人数|\n|---|---|---|\n|平台研发部|韩啸|38|\n|客户成功部|邱石|31|\n`),
    page("tracker", `# 项目周报\n\n|事项|负责人|状态|\n|---|---|---|\n|测试服务器采购申请|韩啸|审批中|\n\n韩啸于 9 月初发起了测试服务器的采购申请，等待审批。\n`),
    page("policy", `# 请购审批权限\n\n${rules(8)}\n\n|层级|金额|审批节点|\n|---|---|---|\n|二级|1 万至 10 万|部门负责人 → 财务负责人|\n`),
    page("faq", `# 采购常见问题\n\n${rules(5)}`),
    page("minutes", `# 部门会议\n\n|部门|事项|\n|---|---|\n|部门|采购|\n\n${rules(3)}`),
  ];
  const question = "韩啸提的那个测试服务器采购申请要经过谁审批？";
  assert.deepEqual(questionCellNames(pages, question), ["韩啸"], "部门、采购 are cells too, but they are ordinary words here");
  const terms = queryTerms(question);
  const plain = rankChunks(buildIndex(pages), terms, { limit: 3, perDocument: 1 });
  assert.ok(!plain.some((hit) => hit.page.owner === "roster"), "ranking alone does not send the roster");
  const named = rankChunks(buildIndex(pages), terms, { limit: 3, perDocument: 1, cells: ["韩啸"] });
  assert.ok(named.some((hit) => hit.page.owner === "roster" && hit.chunk.text.includes("|平台研发部|韩啸|")), "the roster row is sent");
  assert.ok(named.some((hit) => hit.page.owner === "tracker"), "and the tracker still is");
});
