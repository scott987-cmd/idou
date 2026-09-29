import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { duplicateGroups, similarity, sketchOf, DUPLICATE } from "../src/knowledge/duplicates.js";
import { standingGraph } from "../src/knowledge/standing.js";
import { chunkSpans } from "../src/knowledge/retrieval.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { knowledgeEvidence, knowledgePrompt } from "../src/knowledge/task-scope.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/knowledge-eval/corpus/", import.meta.url));
const page = (owner, title, text, extra = {}) => ({ owner, id: owner.repeat(64).slice(0, 64), title, warnings: [], contentHash: `${owner}:${text.length}`,
  chunks: chunkSpans(text).map((span) => ({ ...span, text: text.slice(span.start, span.end) })), ...extra });

async function corpus() {
  const pages = [];
  for (const name of (await readdir(FIXTURE)).filter((file) => file.endsWith(".md")).sort()) {
    const text = await readFile(path.join(FIXTURE, name), "utf8"), id = name.replace(/\.md$/, "");
    pages.push(page(id, (text.match(/^#\s+(.+)$/mu)?.[1] ?? id).trim(), text));
  }
  return pages;
}

test("十六篇真实文档里没有一对被当成副本，哪怕是同一制度的两个年度版本", async () => {
  const pages = await corpus();
  const groups = duplicateGroups(pages, standingGraph(pages));
  assert.equal(groups.size, 0, `不该分组，实际：${[...groups.keys()].join("、")}`);
  let worst = 0, pair = "";
  for (let i = 0; i < pages.length; i += 1) for (let j = i + 1; j < pages.length; j += 1) {
    const score = similarity(sketchOf(pages[i]), sketchOf(pages[j]));
    if (score > worst) { worst = score; pair = `${pages[i].title} ↔ ${pages[j].title}`; }
  }
  assert.ok(worst < DUPLICATE, `不同文档的最高相似度 ${worst.toFixed(2)}（${pair}）必须低于阈值 ${DUPLICATE}`);
});

test("改了几个数字的副本会被认出来，整组只留一份代表", async () => {
  const pages = await corpus();
  const original = pages.find((item) => item.title.includes("差旅"));
  const text = original.chunks.map((chunk) => chunk.text).join("").replace(/(\d)/gu, (digit) => String((Number(digit) + 1) % 10));
  const copy = page("copy", `${original.title}（转存）`, text);
  const all = [...pages, copy];
  const groups = duplicateGroups(all, standingGraph(all));
  assert.equal(groups.size, 2, "只有这两篇互为副本");
  assert.equal(groups.get(copy.owner).copies, 2);
  assert.equal(groups.get(original.owner).representative.owner, groups.get(copy.owner).representative.owner, "同组必须选出同一份代表");
  const chosen = groups.get(copy.owner).representative.owner;
  assert.deepEqual(groups.get(chosen).others.map((item) => item.id), all.filter((item) => item.owner !== chosen && groups.has(item.owner)).map((item) => item.id));
  const other = chosen === copy.owner ? original : copy;
  assert.equal(groups.get(other.owner).others[0].id, groups.get(other.owner).representative.id, "非代表那一份要先看到代表是谁");
});

test("选代表的顺序可以讲清楚：被别的文档宣布作废的排最后，其次看自述日期、本人读过、正文更全", () => {
  const body = (date, tail = "") => `# 报销标准\n> 生效日期：${date}\n\n## 住宿\n一线城市住宿费上限每晚 500 元，其余城市 380 元，超出部分由本人承担。\n\n## 交通\n市内交通据实报销，需附行程单；跨城出行默认高铁二等座，航班仅在当日往返时可选。\n\n## 补贴\n差旅补贴每日 120 元，出差不足四小时不计补贴。\n\n## 提交\n报销单在行程结束后十个工作日内提交，逾期需说明原因。${tail}`;
  const build = (list) => duplicateGroups(list, standingGraph(list)).get(list[0].owner)?.representative.owner;
  const older = page("older", "报销标准", body("2025-01-01")), newer = page("newer", "报销标准", body("2026-01-01"));
  assert.equal(build([older, newer]), "newer", "自述日期更晚的代表整组");
  const read = page("read", "报销标准", body("2026-01-01"), { localReadAt: 9000 });
  assert.equal(build([newer, read]), "read", "本人真的打开过的那一份优先");
  const fuller = page("fuller", "报销标准", body("2026-01-01", "单笔超过 2000 元的还需部门负责人核准。"));
  assert.equal(build([newer, fuller]), "fuller", "同日期时正文更全的代表整组");
  // 作废是按标题点名的，所以这一份得有自己的标题：两份都叫《报销标准》时，
  // standing.js 会认为点名不清而谁都不判，这正是它该有的谨慎。
  const repealed = page("repealed", "报销标准（试行）", body("2027-01-01")),
    killer = page("killer", "报销标准废止通知", "# 报销标准废止通知\n> 生效日期：2027-06-01\n\n《报销标准（试行）》自本通知发布之日起予以废止。");
  const stale = page("stale", "报销标准", body("2028-01-01"), { staleCount: 1 });
  assert.equal(build([newer, stale]), "newer", "上次没核验成功的那一份不能代表整组，否则整组都进不了回答");
  const list = [repealed, newer, killer], standing = standingGraph(list);
  assert.equal(standing.get(repealed.owner).state, "superseded");
  assert.equal(duplicateGroups(list, standing).get(repealed.owner).representative.owner, "newer", "哪怕日期更晚，被宣布作废的也不做代表");
});

test("同一份文档存了两遍时，回答只拿到一份，并且被告知另一份存在", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-dup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const text = "# 报销标准\n> 生效日期：2026-01-01\n\n住宿费上限 500 元，市内交通据实报销，差旅补贴每日 120 元。\n";
  const identity = { principal: "alice", tenantKey: "tenant-a", verifiedAt: 1000 };
  const documents = new Map([["a", "https://test.feishu.cn/docx/AAA"], ["b", "https://test.feishu.cn/docx/BBB"]].map(([key, sourceUrl]) => [sourceUrl,
    { providerId: "fixture", resourceId: sourceUrl.slice(-3), sourceUrl, sourceRevision: "1", contentHash: `hash-${key}`,
      title: key === "a" ? "报销标准" : "报销标准（备份）", text, partial: false, warnings: [], identity }]));
  const provider = { documentIdentity: async () => identity, readDocument: async (url) => structuredClone(documents.get(url)) };
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 2000 });
  t.after(() => wiki.close());
  for (const document of documents.values()) await wiki.observe(document);
  await wiki.queue;
  const result = await wiki.search("住宿费上限");
  assert.equal(result.hits.length, 1, "两份几乎一样的文档只该送一份进答案");
  assert.equal(result.hits[0].duplicates.copies, 2);
  assert.equal(result.hits[0].duplicates.others.length, 1);
  const evidence = knowledgeEvidence(result.hits);
  assert.equal(evidence[0].duplicates.copies, 2);
  assert.match(knowledgePrompt("问题", evidence), /several copies/u, "提示词必须让模型说出库里有多份副本");
  const inventory = await wiki.inventory();
  assert.equal(inventory.duplicateGroups, 1);
  assert.equal(inventory.sources.filter((item) => item.duplicates?.copies === 2).length, 2, "清单两行都要标出副本，才有得清理");
  assert.equal(inventory.sources.filter((item) => item.duplicates?.speaksForGroup).length, 1);
});

test("标题自称归档的那一份不做代表：靠粘链接入库、没人读过时，原件不能被存档件顶掉", () => {
  const body = "# 报销标准\n> 生效日期：2026-01-01\n\n一线城市住宿费上限每晚 500 元，其余城市 380 元。\n跨城出行默认高铁二等座。\n";
  const page = (owner, title, text) => ({ owner, id: owner.repeat(64).slice(0, 64), title, warnings: [], contentHash: `${owner}:${text.length}`,
    chunks: chunkSpans(text).map((span) => ({ ...span, text: text.slice(span.start, span.end) })) });
  // 两份一模一样：谁都没被打开过，谁都没写更晚的日期，长度也相同——改之前只能按 id 抛硬币。
  // 存档件的 id 故意排在前面：没有标题这条规则时，它会赢下这次抛硬币。
  const original = page("zzz", "报销标准", body), archived = page("aaa", "报销标准（2024 年归档）", body);
  for (const list of [[original, archived], [archived, original]]) {
    const groups = duplicateGroups(list, standingGraph(list));
    assert.equal(groups.get(original.owner).representative.title, "报销标准", `原件必须代表本组：${list.map((item) => item.title).join("、")}`);
  }
  // 但这只是排序，不是删除：存档件仍在库里，并且被点明还有几份。
  const groups = duplicateGroups([original, archived], standingGraph([original, archived]));
  assert.equal(groups.get(archived.owner).copies, 2);
  assert.equal(groups.get(archived.owner).others[0].title, "报销标准");
});

test("挑文档时只看代表：一堆副本不能把原件的特征词冲淡", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os"), pathModule = await import("node:path");
  const { LocalWiki } = await import("../src/knowledge/local-wiki.js");
  const { fixtureCipher } = await import("../scripts/fixtures/wiki-cipher.js");
  const directory = await mkdtemp(pathModule.join(os.tmpdir(), "wiki-dupidf-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = { principal: "alice", tenantKey: "tenant-a", verifiedAt: 1000 };
  const documents = new Map();
  const add = (key, title, text) => documents.set(`https://test.feishu.cn/docx/${key}`, { providerId: "fixture", resourceId: key,
    sourceUrl: `https://test.feishu.cn/docx/${key}`, sourceRevision: "1", contentHash: `hash-${key}`, title, text, partial: false, warnings: [], identity });
  // 一篇只有它才答得上来的文档……
  add("Roster", "部门花名册", "# 部门花名册\n\n| 姓名 | 部门 | 职级 |\n|---|---|---|\n| 尉迟斐然 | 平台研发部 | M2 |\n| 澹台泽宇 | 质量保障部 | P7 |\n");
  // ……外加十二份它自己的归档副本，和一批无关文档。
  for (let index = 0; index < 12; index += 1) {
    add(`RosterCopy${index}`, `部门花名册（20${20 + (index % 9)} 年归档）`,
      `# 部门花名册（20${20 + (index % 9)} 年归档）\n\n| 姓名 | 部门 | 职级 |\n|---|---|---|\n| 尉迟斐然 | 平台研发部 | M${2 + (index % 3)} |\n| 澹台泽宇 | 质量保障部 | P${6 + (index % 3)} |\n`);
  }
  // 这些文档反复说「部门」，问题里也有这个词：名字还稀不稀有，就决定了谁被挑中。
  for (let index = 0; index < 10; index += 1) {
    add(`Other${index}`, `部门办公制度 ${index}`,
      `# 部门办公制度 ${index}\n\n各部门工位由部门负责人分配，部门会议室由部门助理预订，部门门禁卡由部门行政办理，部门访客登记由部门前台负责。部门第 ${index} 部分。\n`);
  }
  const provider = { documentIdentity: async () => identity, readDocument: async (url) => structuredClone(documents.get(url)) };
  const wiki = new LocalWiki({ filename: pathModule.join(directory, "wiki.enc"), provider, cipher: fixtureCipher(), now: () => 2000 });
  t.after(() => wiki.close());
  for (const source of documents.values()) await wiki.observe(source);
  await wiki.queue;
  const found = await wiki.search("尉迟斐然 是哪个部门的", { verify: 3 });
  assert.ok(found.hits.length, "总得答出点什么");
  assert.match(found.hits[0].title, /^部门花名册$/, `原件必须被挑中，实际：${found.hits.map((hit) => hit.title).join("、")}`);
  assert.match(found.hits[0].excerpt, /尉迟斐然/);
  assert.equal(found.hits[0].duplicates.copies, 13, "并且照实说明库里有多少份");
});
