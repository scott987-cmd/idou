import test from "node:test";
import assert from "node:assert/strict";
import { agentKnowledgeActions } from "../src/application/agent-knowledge-actions.js";

const id = (n) => String(n).repeat(64).slice(0, 64);
const hit = (over = {}) => ({ id: id(1), title: "考勤与休假管理制度（2026 版）", sourceUrl: "https://x.feishu.cn/docx/a", revision: "3",
  section: "## 第十九条 审批层级", excerpt: "3 天以上：直属上级 → 部门负责人 → HR 负责人（杜若）。", ...over });

function fixture({ scope: knowledgeScope = { mode: "all", ids: [] }, hits = [hit()], document = null, fail = null } = {}) {
  const calls = [];
  let allowed = 0;
  const wiki = {
    search: async (query, options) => { calls.push(["search", query, options]); if (fail) throw new Error(fail); return { hits, unavailable: 0, limited: false, message: "" }; },
    document: async (reference, options) => { calls.push(["document", reference, options]); if (fail) throw new Error(fail); return document; },
  };
  const scope = { wiki, service: { get: (taskId) => { if (taskId !== "task-1") throw new Error("找不到这个任务"); return { id: taskId, knowledgeScope }; } } };
  const actions = agentKnowledgeActions({ getScope: () => scope, businessAccess: () => { allowed += 1; } });
  return { actions, calls, gate: () => allowed };
}

test("kb-search 查的是本人已核验的副本，返回带来源和短编号的原文段落", async () => {
  const { actions, calls, gate } = fixture();
  const result = await actions["kb-search"]({ query: "请假 审批 层级" }, "task-1");
  assert.equal(gate(), 1, "读也要过企业身份这道闸");
  assert.equal(calls[0][1], "请假 审批 层级");
  assert.equal(calls[0][2].ids, null, "范围是全部时不限定文档");
  assert.equal(result.excerpts[0].id.length, 12);
  assert.equal(result.excerpts[0].sourceUrl, "https://x.feishu.cn/docx/a");
  assert.equal(result.excerpts[0].section, "## 第十九条 审批层级");
  assert.match(result.note, /kb-read/);
});

test("任务选定了文档时，agent 只能搜到这些文档", async () => {
  const { actions, calls } = fixture({ scope: { mode: "selected", ids: [id(1), id(2)] } });
  await actions["kb-search"]({ query: "报销" }, "task-1");
  assert.deepEqual(calls[0][2].ids, [id(1), id(2)]);
  const read = fixture({ scope: { mode: "selected", ids: [id(1)] }, document: { id: id(1), title: "制度", sourceUrl: "https://x.feishu.cn/docx/a", revision: "1", text: "正文" } });
  await read.actions["kb-read"]({ doc: id(1).slice(0, 12) }, "task-1");
  assert.deepEqual(read.calls[0][2].ids, [id(1)], "按编号打开也不能越过选定范围");
});

test("没选知识范围就没有企业知识可读，说清楚而不是报一个看不懂的错", async () => {
  const { actions } = fixture({ scope: null });
  await assert.rejects(actions["kb-search"]({ query: "请假" }, "task-1"), /没有选择知识范围/);
  await assert.rejects(actions["kb-read"]({ doc: id(1) }, "task-1"), /没有选择知识范围/);
});

test("别的任务、空检索词和不成形的编号都被拒绝", async () => {
  const { actions } = fixture();
  await assert.rejects(actions["kb-search"]({ query: "请假" }, "task-other"), /找不到这个任务/);
  await assert.rejects(actions["kb-search"]({ query: "  " }, "task-1"), /--query 无效/);
  await assert.rejects(actions["kb-search"]({ query: "字".repeat(300) }, "task-1"), /--query 无效/);
  await assert.rejects(actions["kb-read"]({ doc: "../../etc/passwd" }, "task-1"), /--doc/);
  await assert.rejects(actions["kb-read"]({ doc: "abc" }, "task-1"), /--doc/);
});

test("kb-read 按位置取一段，并说明还剩多少可以接着读", async () => {
  const text = "甲".repeat(10_000);
  const { actions, calls } = fixture({ document: { id: id(1), title: "长文档", sourceUrl: "https://x.feishu.cn/docx/a", revision: "9", text } });
  const first = await actions["kb-read"]({ doc: id(1).slice(0, 12) }, "task-1");
  assert.equal(calls[0][1], id(1).slice(0, 12));
  assert.equal(first.from, 0);
  assert.equal(first.excerpt.length, 4000);
  assert.equal(first.chars, 10_000);
  assert.match(first.note, new RegExp(`--around ${first.to}`));
  const next = await actions["kb-read"]({ doc: id(1).slice(0, 12), around: String(first.to) }, "task-1");
  assert.equal(next.from, first.to - 2000, "从给的位置往前留一半上下文");
  assert.ok(next.to > first.to);
});

test("这一刻核验不过的文档不返回任何正文", async () => {
  const { actions } = fixture({ fail: "这篇文档此刻无法从飞书重新核验，没有返回任何正文" });
  await assert.rejects(actions["kb-read"]({ doc: id(1) }, "task-1"), /无法从飞书重新核验/);
  await assert.rejects(actions["kb-search"]({ query: "请假" }, "task-1"), /无法从飞书重新核验/);
});

test("检索不到时告诉 agent 换个说法再试，而不是让它下结论", async () => {
  const { actions } = fixture({ hits: [] });
  const result = await actions["kb-search"]({ query: "年终奖" }, "task-1");
  assert.deepEqual(result.excerpts, []);
  assert.match(result.note, /换文档里会用的说法/);
});

test("kb-read --match 把整张表里含这个词的行全部列出来，带表头，并说清一共几行", async () => {
  const rows = Array.from({ length: 3000 }, (_, index) => `| ${index + 2} | QL-HT-2026-${String(index + 2).padStart(4, "0")} | 2026-${String((index % 12) + 1).padStart(2, "0")}-15 | ${index * 10} |`);
  const text = ["# 飞书电子表格 · 合同台账", "> 值快照", "", "| 行 | A | B | C |", "|---|---|---|---|", ...rows].join("\n");
  const { actions } = fixture({ document: { id: id(3), title: "合同台账", sourceUrl: "https://x.feishu.cn/sheets/s", revision: "7", text } });
  const one = await actions["kb-read"]({ doc: id(3).slice(0, 12), match: "QL-HT-2026-2734" }, "task-1");
  assert.equal(one.matched, 1);
  assert.deepEqual(one.header, ["| 行 | A | B | C |"], "表头要一起给，否则看不懂列");
  assert.match(one.lines[0], /QL-HT-2026-2734/);
  assert.match(one.note, /已全部列出/);
  const month = await actions["kb-read"]({ doc: id(3).slice(0, 12), match: "2026-09-15" }, "task-1");
  assert.equal(month.matched, 250, "3000 行里每 12 行一个九月");
  assert.equal(month.lines.length, 80, "一次最多列 80 行");
  assert.match(month.note, /共 250 行.*只列出前 80 行/u, "列不全时必须说清楚，不能让人当成全部");
  await assert.rejects(actions["kb-read"]({ doc: id(3).slice(0, 12), match: "x".repeat(51) }, "task-1"), /--match/);
});
