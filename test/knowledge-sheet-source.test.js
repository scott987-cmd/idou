import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sheetProjection, sheetKnowledgeSource, baseProjection, baseKnowledgeSource, knowledgeSourceReader, SHEET_COVERAGE, coverageNote } from "../src/knowledge/sheet-source.js";
import { baseReference, baseCellText } from "../src/providers/feishu/base-reader.js";
import { feishuCliSemanticRead, validateFeishuCliSemanticRead } from "../src/providers/feishu/cli-read-contract.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { knowledgeQuery, knowledgeEvidence } from "../src/knowledge/task-scope.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { sheetDataFixture } from "../scripts/fixtures/sheet-data.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

const identity = { tenantKey: "tenant-a", principal: "alice", verifiedAt: 1000 };
const columns = ["A", "B", "C"];
const rows = [
  ["客户", "本期合同额（万元）", "签订日期"],
  ["瀚川集团", "386", "2026-03-28"],
  ["澜石科技", "110", "2026-05-12"],
];
const snapshot = (over = {}) => ({
  kind: "feishu-sheet", providerId: "saas-cli", resourceId: "ShtToken123", sheetId: "sheet1",
  sourceUrl: "https://test.feishu.cn/sheets/ShtToken123?sheet=sheet1", sourceRevision: "7", contentHash: "hash-v1",
  title: "飞书电子表格 · 2026 合同台账", sheets: [{ id: "sheet1", title: "2026 合同台账", kind: "sheet", hidden: false, rows: 3, columns: 3 }],
  range: "A1:C3", actualRange: "sheet1!A1:C3", rowIndices: [1, 2, 3], colIndices: columns,
  cells: rows.map((row) => row.map((value) => ({ value }))), warnings: ["仅为指定范围的值／公式快照，不代表整表已读全；样式、图表和权限信息未复制。"],
  identity, ...over });

test("表格投影保留表头、行号和每个单元格，并说明整理了哪一块", () => {
  const projection = sheetProjection(snapshot());
  assert.match(projection.text, /\| 行 \| A \| B \| C \|/);
  assert.match(projection.text, /\| 2 \| 瀚川集团 \| 386 \| 2026-03-28 \|/);
  assert.equal(projection.complete, true);
  assert.doesNotMatch(projection.text, /其余部分未整理/, "整表都读到了就不该说有遗漏");
  // A sheet larger than what one read carries must say so in the text itself.
  const partial = sheetProjection(snapshot({ sheets: [{ id: "sheet1", title: "台账", kind: "sheet", hidden: false, rows: 1240, columns: 12 }] }));
  assert.equal(partial.complete, false);
  assert.match(partial.text, /本副本只包含这个范围/);
  assert.match(partial.text, /共 1240 行 × 12 列/);
});

test("单元格里的换行、竖线和长文本不会把表格行拆散", () => {
  const projection = sheetProjection(snapshot({ cells: [[{ value: "备注\n第二行" }, { value: "a|b" }, { value: "字".repeat(400) }]], rowIndices: [1] }));
  const line = projection.text.trim().split("\n").at(-1);
  assert.equal(line.split("|").length, 6, `一行应当只有这些竖线：${line}`);
  assert.match(line, /备注 第二行/);
  assert.match(line, /字…/);
});

test("表格作为知识来源：入库、按内容检索、再核验都走同一条链接", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sheet-knowledge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let current = snapshot(), reads = 0, wanted = null;
  const reader = { read: async (url, options) => { reads += 1; wanted = { url, options }; return structuredClone(current); } };
  const sheets = sheetKnowledgeSource(reader, { reference: SAAS_FEISHU.references.sheet });
  assert.equal(sheets.matches("https://test.feishu.cn/sheets/ShtToken123?sheet=sheet1"), true);
  assert.equal(sheets.matches("https://test.feishu.cn/docx/Document123"), false);

  const documents = { documentIdentity: async () => identity, readDocument: async () => { throw new Error("文档读取器不该被用来读表格"); } };
  const provider = knowledgeSourceReader(documents, sheets);
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 2000 });
  t.after(() => wiki.close());

  assert.ok(await wiki.observe(await provider.readDocument(current.sourceUrl)), "表格没有被保留");
  // 这个读取器只会单次读：它拿到的是一次读取能承受的范围，而不是预览的前十行；
  // 真正的读取器有整表分页读，见 test/sheet-reader-table.test.js。
  assert.deepEqual(wanted.options.coverage, { maxRows: 200, maxCells: 2000 }, "入库时要按知识库的范围读，而不是预览的前十行");

  const result = await wiki.search(knowledgeQuery("瀚川集团本期合同额是多少？"));
  assert.equal(reads, 2, "检索前要再读一次表格核验");
  assert.equal(result.hits.length, 1);
  assert.match(result.hits[0].excerpt, /瀚川集团 \| 386/);
  assert.equal(result.hits[0].sourceUrl, current.sourceUrl);
  const evidence = knowledgeEvidence(result.hits);
  assert.match(evidence[0].title, /2026 合同台账/);
  assert.match(JSON.stringify(evidence), /不含公式、样式与图表/, "送进提示词的内容要自带这份副本的边界说明");

  // A later edit replaces the stored copy, exactly as a document revision does.
  const edited = rows.map((row) => [...row]);
  edited[1][1] = "420";
  current = snapshot({ sourceRevision: "8", contentHash: "hash-v2", cells: edited.map((row) => row.map((value) => ({ value }))) });
  const updated = await wiki.search(knowledgeQuery("瀚川集团本期合同额"));
  assert.equal(updated.hits[0].revision, "8");
  assert.match(updated.hits[0].excerpt, /瀚川集团 \| 420/);
});

test("表格读不回来时不返回任何缓存内容", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sheet-knowledge-deny-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let deny = false;
  const reader = { read: async () => { if (deny) throw new Error("SECRET 表格权限已收回"); return structuredClone(snapshot()); } };
  const provider = knowledgeSourceReader({ documentIdentity: async () => identity, readDocument: async () => { throw new Error("no"); } }, sheetKnowledgeSource(reader, { reference: SAAS_FEISHU.references.sheet }));
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 2000 });
  t.after(() => wiki.close());
  await wiki.observe(await provider.readDocument("https://test.feishu.cn/sheets/ShtToken123?sheet=sheet1"));
  deny = true;
  const result = await wiki.search(knowledgeQuery("瀚川集团"));
  assert.deepEqual(result.hits, []);
  assert.equal(result.unavailable, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|瀚川/);
});

// 飞书读取工具在每次读取的 warning_message 里写给调用程序的用法提示（真机上见过，完整读取也带着）。
// 以前它被存成表格副本的提示，「已加入」和每条搜索结果下面都显示它，看上去像是这张表出了问题。
test("表格加入知识库：已加入和搜索结果下面只说这份副本，不显示飞书写给调用程序的用法提示", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sheet-knowledge-advice-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const advice = "处理 ranges[n].cells 之前先看 has_more 和 actual_range，用 row_indices / col_indices 定位真实行列。";
  const cli = sheetDataFixture();
  cli.state.transform = (name, data) => { if (name === "+cells-get") { data.warning_message = advice; data.ranges[0].warning_message = advice; } return data; };
  // 真实的读取器和知识来源，只有 CLI 是假的。
  const feishu = new SaasFeishuCliProvider({ binary: STUB_CLI }, cli.run);
  const provider = knowledgeSourceReader({ documentIdentity: (options) => feishu.documentIdentity(options), readDocument: async () => { throw new Error("文档读取器不该读表格"); } },
    sheetKnowledgeSource(feishu.sheets, { reference: SAAS_FEISHU.references.sheet }));
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => Date.now() });
  t.after(() => wiki.close());

  const added = await provider.readDocument("https://test.feishu.cn/sheets/SyntheticSheet123?sheet=sales");
  assert.deepEqual(added.warnings, [coverageNote(SHEET_COVERAGE)], "「已加入」后面显示的是第一条提示");
  assert.ok(await wiki.observe(added));
  const { hits } = await wiki.search(knowledgeQuery("研发协作的编号是多少？"));
  assert.ok(hits.length > 0, "表格应当能被检索到");
  for (const hit of hits) assert.deepEqual(hit.warnings, [coverageNote(SHEET_COVERAGE)]);
  assert.equal(JSON.stringify(hits).includes(advice), false);
});

const baseSnapshot = (over = {}) => ({
  kind: "feishu-base", providerId: "saas-cli", appToken: "BasToken123", tableId: "tblSynthetic001",
  resourceId: "BasToken123:tblSynthetic001", sourceUrl: "https://test.feishu.cn/base/BasToken123?table=tblSynthetic001",
  sourceRevision: "rev0001", contentHash: "base-hash-v1", title: "飞书多维表格 · 客户台账 · 重点客户",
  fields: ["客户", "负责人", "本期合同额"],
  records: [{ id: "rec1", values: ["瀚川集团", "邱石", "386"] }, { id: "rec2", values: ["澜石科技", "沈佳禾", "110"] }],
  tables: [{ id: "tblSynthetic001", name: "重点客户" }, { id: "tblSynthetic002", name: "商机" }], truncated: false, identity, ...over });

test("多维表格投影：字段名当表头，每条记录一行，并说明同一个多维表格里还有哪些数据表", () => {
  const projection = baseProjection(baseSnapshot());
  assert.match(projection.text, /\| 客户 \| 负责人 \| 本期合同额 \|/);
  assert.match(projection.text, /\| 瀚川集团 \| 邱石 \| 386 \|/);
  assert.match(projection.text, /还有数据表：商机/);
  assert.equal(projection.complete, true);
  const more = baseProjection(baseSnapshot({ truncated: true }));
  assert.equal(more.complete, false);
  assert.match(more.text, /本副本只包含前若干条记录与字段/);
});

test("多维表格的人员、链接、附件单元格按人看到的文字投影，展不开的说清楚", () => {
  assert.equal(baseCellText([{ name: "邱石", id: "ou_1" }]), "邱石");
  assert.equal(baseCellText({ link: "https://example.com/a", text: "合同扫描件" }), "合同扫描件");
  assert.equal(baseCellText([{ file_token: "f1", file_name: "合同.pdf" }]), "合同.pdf");
  assert.equal(baseCellText([{ unknown: 1 }]), "（未展开内容）");
  assert.equal(baseCellText(null), "");
  assert.equal(baseCellText("含 | 竖线\n和换行"), "含 ｜ 竖线 和换行");
});

test("多维表格链接只接受 SaaS https base 链接，并按数据表分页", () => {
  assert.deepEqual(baseReference("https://test.feishu.cn/base/BasToken123?table=tblSynthetic001").tableId, "tblSynthetic001");
  assert.equal(baseReference("https://test.feishu.cn/base/BasToken123").tableId, null);
  for (const bad of ["http://test.feishu.cn/base/BasToken123", "https://evil.example.com/base/BasToken123", "https://test.feishu.cn/base/BasToken123#anchor", "not a url"]) {
    assert.throws(() => baseReference(bad), /多维表格/);
  }
});

test("三种来源按链接形状各走各的读取器，存进去的和核验回来的是同一条路", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "base-knowledge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const documents = { documentIdentity: async () => identity,
    readDocument: async (url) => { calls.push(["document", url]); return { kind: "feishu-document", identity, providerId: "saas-cli", resourceId: "Doc1", sourceUrl: url,
      sourceRevision: "1", contentHash: "doc-hash", title: "组织架构", text: "客户成功部负责人邱石，31 人。", partial: false, warnings: [] }; } };
  const sheets = sheetKnowledgeSource({ read: async (url) => { calls.push(["sheet", url]); return structuredClone(snapshot()); } }, { reference: SAAS_FEISHU.references.sheet });
  const bases = baseKnowledgeSource({ read: async (url) => { calls.push(["base", url]); return structuredClone(baseSnapshot()); } }, { reference: SAAS_FEISHU.references.base });
  const provider = knowledgeSourceReader(documents, sheets, bases);
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 2000 });
  t.after(() => wiki.close());
  for (const url of ["https://test.feishu.cn/docx/Doc1", "https://test.feishu.cn/sheets/ShtToken123?sheet=sheet1", "https://test.feishu.cn/base/BasToken123?table=tblSynthetic001"]) {
    assert.ok(await wiki.observe(await provider.readDocument(url)), `${url} 没有被保留`);
  }
  assert.deepEqual(calls.map((call) => call[0]), ["document", "sheet", "base"]);
  const hits = (await wiki.search(knowledgeQuery("瀚川集团的合同额和负责人"))).hits;
  const kinds = hits.map((hit) => hit.title);
  assert.ok(kinds.some((title) => /多维表格/.test(title)), `多维表格应当能被检索到：${kinds.join(" / ")}`);
  assert.ok(kinds.some((title) => /电子表格/.test(title)), `电子表格应当能被检索到：${kinds.join(" / ")}`);
});

// Recorded from the pinned bundled CLI (1.0.78) against a real spreadsheet:
// `sheets +workbook-info` and `sheets +cells-get` are POSTs to the sheet_ai read
// tool, not REST resources. Until this was in the read contract the bridge
// refused them, and a live spreadsheet read came back as Feishu's error mangled
// by the SDK — the app's own 飞书表格 view could not read a sheet either.
const SHEET_READ_PATH = "/open-apis/sheet_ai/v2/spreadsheets/uwE7FZDXV4eIOmG6L2hzLmqNAn4/tools/invoke_read";
const readShape = (path, body) => {
  const entry = feishuCliSemanticRead("POST", path);
  if (!entry) return "not a read";
  try { validateFeishuCliSemanticRead(entry, Buffer.from(JSON.stringify(body))); return "allowed"; } catch { return "refused"; }
};

test("电子表格的读取按录下来的形状放行，写入口径不受影响", () => {
  assert.equal(readShape(SHEET_READ_PATH, { input: JSON.stringify({ excel_id: "uwE7FZDXV4eIOmG6L2hzLmqNAn4" }), tool_name: "get_workbook_structure" }), "allowed");
  assert.equal(readShape(SHEET_READ_PATH, { input: JSON.stringify({ cell_limit: 1000000000, excel_id: "uwE7FZDXV4eIOmG6L2hzLmqNAn4", include_styles: false,
    max_chars: 80000, ranges: ["A1:J121"], sheet_id: "PIejyo", value_render_option: "formula" }), tool_name: "get_cell_ranges" }), "allowed");
  // Anything that is not one of the two recorded read tools, or carries a shape
  // nobody recorded, is refused rather than forwarded.
  assert.equal(readShape(SHEET_READ_PATH, { input: "{}", tool_name: "set_cell_range" }), "refused");
  assert.equal(readShape(SHEET_READ_PATH, { input: JSON.stringify({ excel_id: "x", ranges: ["A1:C3"], drop_table: true }), tool_name: "get_cell_ranges" }), "refused");
  assert.equal(readShape(SHEET_READ_PATH, { input: JSON.stringify({ excel_id: "x", ranges: Array.from({ length: 20 }, () => "A1:B2") }), tool_name: "get_cell_ranges" }), "refused");
  assert.equal(readShape(SHEET_READ_PATH, { input: "not json", tool_name: "get_cell_ranges" }), "refused");
  // The write half of the same endpoint stays a write: it is not a named read.
  assert.equal(readShape("/open-apis/sheet_ai/v2/spreadsheets/uwE7FZDXV4eIOmG6L2hzLmqNAn4/tools/invoke_write", { input: "{}", tool_name: "set_cell_range" }), "not a read");
});
