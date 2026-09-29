import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { standingGraph, standingLabel, documentDate, resolveTitle } from "../src/knowledge/standing.js";
import { chunkSpans } from "../src/knowledge/retrieval.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/knowledge-eval/corpus/", import.meta.url));
const page = (owner, title, text, warnings = []) => ({ owner, id: owner.repeat(64).slice(0, 64), title, warnings,
  chunks: chunkSpans(text).map((span) => ({ ...span, text: text.slice(span.start, span.end) })) });

async function corpus() {
  const pages = [];
  for (const name of (await readdir(FIXTURE)).filter((file) => file.endsWith(".md")).sort()) {
    const text = await readFile(path.join(FIXTURE, name), "utf8"), id = name.replace(/\.md$/, "");
    pages.push(page(id, (text.match(/^#\s+(.+)$/mu)?.[1] ?? id).trim(), text));
  }
  return pages;
}

test("文档自述的日期按种类取，正文没写就退回标题里的版本年份", () => {
  assert.deepEqual(documentDate("# 制度\n> 生效日期：2026-07-01 ｜ 编写：财务部\n正文"), { value: "2026-07-01", kind: "effective", quote: "> 生效日期：2026-07-01 ｜ 编写：财务部" });
  assert.equal(documentDate("# 纪要\n> 会议日期：2026-08-12\n").kind, "meeting");
  assert.equal(documentDate("自 2026 年 8 月 1 日起施行。").value, "2026-08-01");
  assert.equal(documentDate("没有任何日期", "差旅费报销管理办法（2025 版）").value, "2025-01-01");
  assert.equal(documentDate("没有任何日期", "无版本标题"), null);
});

test("表格行里的日期不是这张表的日期", () => {
  const sheet = "# 飞书电子表格 · Sheet1\n> 值快照 · 范围 A1:J121\n\n| 行 | A | B |\n|---|---|---|\n| 2 | QL-HT-2026-0101 | 2026-01-01 |\n";
  assert.equal(documentDate(sheet, "飞书电子表格 · Sheet1"), null, "第一行合同的签订日期不该被当成这张表的日期");
  assert.equal(documentDate(`# 台账\n> 发布日期：2026-07-02\n\n| 行 | A |\n|---|---|\n| 2 | 2026-01-01 |\n`).value, "2026-07-02");
});

test("引用式废止：只有点名另一篇并当场说它废止，才算数", async () => {
  const pages = await corpus();
  const graph = standingGraph(pages);
  const retired = pages.filter((item) => graph.get(item.owner).state === "superseded");
  assert.equal(retired.length, 1, `只应判定一篇被替代，实际：${retired.map((item) => item.title).join("、")}`);
  assert.equal(retired[0].owner, "d03");
  const record = graph.get("d03");
  assert.equal(record.supersededBy.title, "出差报销管理制度（2026 修订版）");
  // The judgement is quoted back so a person can check it, not trusted.
  assert.match(record.evidence, /自本制度施行之日起已废止/);
  assert.ok(record.prior < 1 && record.prior >= 0.5);
  assert.equal(graph.get("d02").prior, 1, "现行的那一版不降权，也不加权");
  assert.deepEqual(graph.get("d02").supersedes.map((item) => item.title), ["差旅费报销管理办法（2025 版）"]);
});

test("调整边：后面的决定改了前面的制度，标注但不降权", async () => {
  const graph = standingGraph(await corpus());
  const amended = [...graph].filter(([, record]) => record.amendedBy.length).map(([owner, record]) => [owner, record.amendedBy.map((item) => item.title)]);
  assert.deepEqual(amended.map(([owner]) => owner).sort(), ["d05", "d07", "d08"]);
  assert.equal(graph.get("d05").prior, 1, "被局部调整的制度在没被改到的地方仍然有效");
  assert.match(graph.get("d08").amendedBy[0].evidence, /24 小时缩短为 8 小时/);
  // 「Q3 OKR 中 KR1.1 的发布日期由总裁办另行更新」 names the OKR without quoting
  // its title; both meetings that changed it are recorded.
  assert.equal(graph.get("d07").amendedBy.length, 2);
  assert.ok(graph.get("d07").amendedBy.every((item) => /会议纪要/.test(item.title)));
});

test("纪要和汇报不会被后来复述它的文档判成「被调整」", async () => {
  const graph = standingGraph(await corpus());
  for (const owner of ["d10", "d12", "d15", "d16"]) {
    assert.deepEqual(graph.get(owner).amendedBy, [], `${owner} 是记录，不该被判成被调整`);
  }
});

test("表格里描述历史的「已废止」不算宣告，晚出的文档也不能废止早出的", () => {
  const table = page("a", "对照表", "# 对照表\n> 发布日期：2026-05-01\n\n| 制度 | 状态 |\n|---|---|\n| 《差旅费报销管理办法（2025 版）》 | 已废止 |\n");
  const victim = page("b", "差旅费报销管理办法（2025 版）", "# 差旅费报销管理办法（2025 版）\n> 生效日期：2025-03-01\n第一条 …\n");
  assert.equal(standingGraph([table, victim]).get("b").state, "current", "表格里的一行是在描述，不是在宣告");

  const older = page("c", "旧通知", "# 旧通知\n> 发布日期：2024-01-01\n《差旅费报销管理办法（2025 版）》已废止。\n");
  assert.equal(standingGraph([older, victim]).get("b").state, "conflict", "早出的文档说不了晚出文档的废止，只能算互相矛盾");
});

test("自述废止只认自己那一行，句子里点了别人就不算", () => {
  const own = page("a", "旧办法", "# 旧办法\n> 生效日期：2024-01-01\n本办法已废止，请按新制度执行。\n");
  assert.equal(standingGraph([own]).get("a").state, "self-void");
  const other = page("b", "通知", "# 通知\n> 发布日期：2026-01-01\n本通知发布后，《某某办法》已废止。\n");
  const graph = standingGraph([other]);
  assert.notEqual(graph.get("b").state, "self-void", "句子里废止的是别人，不是这篇自己");
  assert.equal(graph.get("b").prior, 1, "没有被任何文档废止，就不该降权");
});

test("标题解析要么唯一命中，要么放弃", async () => {
  const pages = await corpus();
  assert.equal(resolveTitle("差旅费报销管理办法（2025 版）", pages)?.owner, "d03");
  assert.equal(resolveTitle("差旅费报销管理办法", pages)?.owner, "d03", "去掉年份版本后唯一命中");
  assert.equal(resolveTitle("管理制度", pages), null, "对不上唯一一篇就不猜");
  assert.equal(resolveTitle("完全不存在的文件名", pages), null);
});

test("送给模型的标签只在有话可说时出现，且必带原文依据", async () => {
  const graph = standingGraph(await corpus());
  const retired = standingLabel(graph.get("d03"));
  assert.equal(retired.standing, "superseded");
  assert.match(retired.standingEvidence, /已废止/);
  assert.equal(retired.supersededBy.title, "出差报销管理制度（2026 修订版）");
  assert.equal(retired.docDate, "2025-03-01");
  const plain = standingLabel(graph.get("d09"));
  assert.equal(plain.standing, undefined, "没有关系的文档不带 standing 字段");
  assert.equal(plain.docDate, "2026-08-03", "自述日期照常给");
  assert.deepEqual(standingLabel(null), {});
});

test("副本不完整的文档略降一点，且永远不会被抬高", () => {
  const complete = page("a", "制度", "# 制度\n> 生效日期：2026-01-01\n第一条 正文。\n");
  const partial = page("b", "制度乙", "# 制度乙\n> 生效日期：2026-01-01\n第一条 正文。\n", ["图片、附件和嵌入表格等资源未展开，不能将当前文本视为这些资源的完整内容。"]);
  const graph = standingGraph([complete, partial]);
  assert.equal(graph.get("a").prior, 1);
  assert.ok(graph.get("b").prior < 1);
  for (const [, record] of graph) assert.ok(record.prior <= 1, "prior 永远不超过 1：只降权，不升权");
});

test("一句话点名几份就废止几份，隔着动词或分句的引用不算", () => {
  const page = (owner, title, text) => ({ owner, id: owner.repeat(64).slice(0, 64), title, warnings: [], contentHash: `${owner}:${text.length}:${title}`,
    chunks: chunkSpans(text).map((span) => ({ ...span, text: text.slice(span.start, span.end) })) });
  const states = (line) => {
    const a = page(`a${line.length}`, "住宿费管理细则（2024 版）", "# 住宿费管理细则（2024 版）\n> 生效日期：2024-01-01\n\n住宿费报销上限每晚 400 元。\n");
    const b = page(`b${line.length}`, "同城差旅补助办法（2023 版）", "# 同城差旅补助办法（2023 版）\n> 生效日期：2023-01-01\n\n同城住宿费报销上限每晚 260 元。\n");
    const h = page(`h${line.length}`, "员工手册（2026 版）", `# 员工手册（2026 版）\n> 生效日期：2026-01-01\n\n${line}\n`);
    const graph = standingGraph([a, b, h]);
    return [graph.get(a.owner).state, graph.get(b.owner).state];
  };
  for (const line of ["《住宿费管理细则（2024 版）》《同城差旅补助办法（2023 版）》自 2026 年起予以废止。",
    "《住宿费管理细则（2024 版）》和《同城差旅补助办法（2023 版）》予以废止。",
    "《住宿费管理细则（2024 版）》、《同城差旅补助办法（2023 版）》予以废止。"]) {
    assert.deepEqual(states(line), ["superseded", "superseded"], `并列点名的两份都该被判：${line}`);
  }
  for (const line of ["按《住宿费管理细则（2024 版）》执行，《同城差旅补助办法（2023 版）》予以废止。",
    "《住宿费管理细则（2024 版）》继续有效；《同城差旅补助办法（2023 版）》予以废止。"]) {
    assert.deepEqual(states(line), ["current", "superseded"], `隔着动词或分句的那一份不能被判：${line}`);
  }
});

test("预算不够时先装现行的：已废止的旧规矩不能把现行规矩整个挤出去", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os"), pathModule = await import("node:path");
  const { LocalWiki } = await import("../src/knowledge/local-wiki.js");
  const { fixtureCipher } = await import("../scripts/fixtures/wiki-cipher.js");
  const directory = await mkdtemp(pathModule.join(os.tmpdir(), "wiki-standing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = { principal: "alice", tenantKey: "tenant-a", verifiedAt: 1000 };
  // 两份旧文件短而密集地讲「住宿费上限」，现行的员工手册长、只讲一句：纯按分数排，
  // 两份旧的会把手册挤到预算之外，回答就会说 400 元。
  const texts = new Map([
    ["OldHotel", "# 住宿费管理细则（2024 版）\n> 生效日期：2024-01-01\n\n## 住宿\n住宿费报销上限每晚 400 元。\n住宿费上限含税，住宿费超标自理。\n住宿费发票需与行程一致。\n"],
    ["OldCity", "# 同城差旅补助办法（2023 版）\n> 生效日期：2023-01-01\n\n## 同城\n同城住宿费报销上限每晚 260 元。\n同城住宿费需部门负责人签字。\n住宿费上限按城市分档。\n"],
    ["Handbook", `# 员工手册（2026 版）\n> 生效日期：2026-01-01\n\n《住宿费管理细则（2024 版）》《同城差旅补助办法（2023 版）》自 2026 年 1 月 1 日起予以废止。\n\n## 一、考勤\n${"迟到早退按考勤制度处理，每月累计三次以上计一次事假。\n".repeat(12)}\n## 二、差旅\n住宿费报销上限每晚 500 元。\n\n## 三、其他\n${"其余未尽事宜由人力资源部解释。\n".repeat(12)}`]]);
  const documents = new Map([...texts].map(([key, text]) => [`https://test.feishu.cn/docx/Doc${key}`,
    { providerId: "fixture", resourceId: `Doc${key}`, sourceUrl: `https://test.feishu.cn/docx/Doc${key}`, sourceRevision: "1", contentHash: `hash-${key}`,
      title: (text.match(/^#\s+(.+)$/mu) ?? [])[1], text, partial: false, warnings: [], identity }]));
  const provider = { documentIdentity: async () => identity, readDocument: async (url) => structuredClone(documents.get(url)) };
  const wiki = new LocalWiki({ filename: pathModule.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 2000 });
  t.after(() => wiki.close());
  for (const source of documents.values()) await wiki.observe(source);
  await wiki.queue;
  const tight = await wiki.search("住宿费报销上限", { maxRows: 2, maxChars: 4000 });
  assert.match(tight.hits[0].title, /员工手册/, `现行的必须先装进去，实际：${tight.hits.map((hit) => hit.title).join("、")}`);
  assert.match(tight.hits[0].excerpt, /500 元/, "送出去的必须是现在生效的那个数");
  assert.ok(tight.hits.every((hit, index) => index === 0 || hit.standing === "superseded"), "现行的排在被替代的前面");
  // 不是把旧的删掉：位置够时它们照样送，并且每一份都说清被谁替代。
  const roomy = await wiki.search("住宿费报销上限", { maxRows: 8, maxChars: 12_000 });
  const retired = roomy.hits.filter((hit) => hit.standing === "superseded");
  assert.equal(retired.length, 2);
  assert.ok(retired.every((hit) => hit.supersededBy?.title === "员工手册（2026 版）"), "每一份旧文件都要说清是被哪一篇替代的");
});
