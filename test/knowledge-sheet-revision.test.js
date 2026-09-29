import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sheetKnowledgeSource, knowledgeSourceReader } from "../src/knowledge/sheet-source.js";
import { tableNotes } from "../src/providers/feishu/sheet-reader.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

// 每次提问都要重新核验来源。对一张几千行的表，每问都分页重读一遍是付不起的；
// 电子表格有自己的版本号，以当前用户身份问一次版本号，就能同时证明「他还打开得了」
// 和「存着的单元格就是飞书里的单元格」。
const identity = { tenantKey: "tenant-a", principal: "alice", verifiedAt: 1000 };
const URL = "https://test.feishu.cn/sheets/ShtToken123?sheet=sheet1";

function reader() {
  const state = { revision: 3, calls: [], denied: false };
  const snapshot = (coverage = null) => ({
    kind: "feishu-sheet", providerId: "saas-cli", resourceId: "ShtToken123", sheetId: "sheet1", sourceUrl: URL,
    // 真实读取器把整理上限算进内容指纹：同一张表按不同上限整理，是不同的副本。
    sourceRevision: String(state.revision), contentHash: `hash-r${state.revision}-${coverage?.maxRows ?? "single"}`, title: "飞书电子表格 · 合同台账",
    sheets: [{ id: "sheet1", title: "合同台账", kind: "sheet", hidden: false, rows: 3, columns: 3 }],
    range: "A1:C3", actualRange: "A1:C3", rowIndices: [1, 2, 3], colIndices: ["A", "B", "C"],
    cells: [["客户", "合同额（万元）", "到期日"], ["瀚川集团", "386", "2026-09-30"], ["澜石科技", String(100 + state.revision), "2026-12-31"]].map((row) => row.map((value) => ({ value }))),
    truncated: false, warnings: [], identity,
  });
  return {
    state,
    snapshot,
    readTable: async (_url, { coverage } = {}) => { state.calls.push("readTable"); if (state.denied) throw new Error("权限已收回"); return snapshot(coverage); },
    revision: async () => { state.calls.push("revision"); if (state.denied) throw new Error("权限已收回"); return { revision: String(state.revision), identity }; },
  };
}

// 先经 `first`（存下这一页时的表格来源）入库，之后一律用今天的整表来源核验。
async function fixture(t, first = null) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-sheet-rev-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sheets = reader();
  let source = first ? first(sheets) : sheetKnowledgeSource(sheets, { reference: SAAS_FEISHU.references.sheet });
  const provider = knowledgeSourceReader({ documentIdentity: async () => identity, readDocument: async () => { throw new Error("文档读取器不该读表格"); } },
    { matches: (url) => source.matches(url), readDocument: (url, options) => source.readDocument(url, options) });
  const cipher = fixtureCipher();
  const open = () => {
    const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher, now: () => 2000 });
    t.after(() => wiki.close());
    return wiki;
  };
  const f = { sheets, wiki: open(), reopen: async () => { await f.wiki.close(); f.wiki = open(); return f.wiki; } };
  assert.ok(await f.wiki.observe(await provider.readDocument(URL)));
  source = sheetKnowledgeSource(sheets, { reference: SAAS_FEISHU.references.sheet });
  sheets.state.calls.length = 0;
  return f;
}

test("版本没变：核验只问一次版本号，不重读任何单元格，照样答得出来", async (t) => {
  const f = await fixture(t);
  const found = await f.wiki.search("瀚川集团 到期日");
  assert.deepEqual(f.sheets.state.calls, ["revision"]);
  assert.ok(found.hits.some((hit) => hit.excerpt.includes("2026-09-30")));
});

test("版本变了：整张表重新读，答案用的是新数字", async (t) => {
  const f = await fixture(t);
  f.sheets.state.revision = 4;
  const found = await f.wiki.search("澜石科技 合同额");
  assert.deepEqual(f.sheets.state.calls, ["revision", "readTable"]);
  assert.ok(found.hits.some((hit) => hit.excerpt.includes("104")), "必须用新版本的数");
  assert.equal(found.hits.some((hit) => hit.excerpt.includes("103")), false, "旧版本的数不能再出现");
});

test("权限收回：版本号问不到，就当读不到，不拿存着的内容答题", async (t) => {
  const f = await fixture(t);
  f.sheets.state.denied = true;
  const found = await f.wiki.search("瀚川集团 到期日");
  assert.deepEqual(found.hits, []);
  assert.deepEqual(f.sheets.state.calls, ["revision"], "问不到版本号就停下，不去重读整表");
});

// 以前的单次读取最多只收 200 行。那样存下的副本版本号可能一直没变，但它不是整张表，
// 版本号不能替它作证：要整表重读一次，换成整表副本落盘，重启以后才只问版本号。
test("旧的单次读取副本：版本没变也整表重读一次，重启后只问版本号", async (t) => {
  const f = await fixture(t, (sheets) => sheetKnowledgeSource({ read: async () => {
    const whole = sheets.snapshot();
    return { ...whole, range: "A1:C2", actualRange: "A1:C2", rowIndices: [1, 2], cells: whole.cells.slice(0, 2), partial: true,
      warnings: ["仅为指定范围的值／公式快照，不代表整表已读全；样式、图表和权限信息未复制。"] };
  } }, { reference: SAAS_FEISHU.references.sheet }));
  const first = await f.wiki.search("瀚川集团 到期日");
  assert.deepEqual(f.sheets.state.calls, ["readTable"], "旧副本不能凭版本号放行");
  assert.ok(first.hits.some((hit) => hit.excerpt.includes("2026-09-30")));
  f.sheets.state.calls.length = 0;
  const second = await (await f.reopen()).search("澜石科技 合同额");
  assert.deepEqual(f.sheets.state.calls, ["revision"], "整表副本存下之后，版本没变就不再重读，重启也一样");
  assert.ok(second.hits.some((hit) => hit.excerpt.includes("103")), "旧副本里没有的那一行，重读之后要答得出来");
});

// 整理上限以后也可能调整：按旧上限整理的副本同样不能凭版本号放行。
test("整理上限换了：按旧上限存的副本重读一次，重启后只问版本号", async (t) => {
  const f = await fixture(t, (sheets) => sheetKnowledgeSource(sheets, { reference: SAAS_FEISHU.references.sheet, coverage: { maxRows: 2, maxCells: 6, maxChars: 1000 } }));
  await f.wiki.search("瀚川集团 到期日");
  assert.deepEqual(f.sheets.state.calls, ["readTable"]);
  f.sheets.state.calls.length = 0;
  await (await f.reopen()).search("瀚川集团 到期日");
  assert.deepEqual(f.sheets.state.calls, ["revision"]);
});

// 以前的整表读取把飞书读取工具的 warning_message 也存成了副本的提示。那是写给调用程序的用法说明，
// 却显示在每条搜索结果下面，像是表格出了问题；版本号不动，它就一直留着。整表重读一次，新副本不带它，
// 内容指纹随之变化而落盘，重启以后才只问版本号。
test("旧副本存着飞书写给调用程序的用法提示：版本没变也整表重读一次，重启后只问版本号", async (t) => {
  const advice = "处理 ranges[n].cells 之前先看 has_more 和 actual_range，用 row_indices / col_indices 定位真实行列。";
  const f = await fixture(t, (sheets) => sheetKnowledgeSource({
    readTable: async (url, options) => ({ ...(await sheets.readTable(url, options)), contentHash: "hash-with-advice", warnings: [advice] }) }, { reference: SAAS_FEISHU.references.sheet }));
  const first = await f.wiki.search("瀚川集团 到期日");
  assert.deepEqual(f.sheets.state.calls, ["readTable"], "带着用法提示的副本不能凭版本号放行");
  assert.ok(first.hits.length > 0);
  assert.equal(first.hits.some((hit) => hit.warnings.includes(advice)), false, "重读之后就不再显示它");
  f.sheets.state.calls.length = 0;
  const second = await (await f.reopen()).search("瀚川集团 到期日");
  assert.deepEqual(f.sheets.state.calls, ["revision"], "干净的副本落盘之后，重启也只问版本号");
  assert.equal(second.hits.some((hit) => hit.warnings.includes(advice)), false);
});

// 反过来，读取器自己写下的说明（只整理了前多少行、合并关联、复杂单元格）是副本本来就该有的：
// 认不出它们，这样的副本每次提问都会把整张表重读一遍。
test("副本里只有读取器自己的说明时，版本没变照样只问版本号", async (t) => {
  const notes = [tableNotes.cut({ rows: 3, columns: 3 }, { rows: 40, columns: 3 }), tableNotes.merged, tableNotes.complex];
  const f = await fixture(t, (sheets) => sheetKnowledgeSource({
    readTable: async (url, options) => ({ ...(await sheets.readTable(url, options)), warnings: notes }) }, { reference: SAAS_FEISHU.references.sheet }));
  const found = await f.wiki.search("瀚川集团 到期日");
  assert.deepEqual(f.sheets.state.calls, ["revision"]);
  assert.ok(found.hits.some((hit) => notes.every((line) => hit.warnings.includes(line))));
});
