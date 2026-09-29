import test from "node:test";
import assert from "node:assert/strict";
import { knowledgeGraph, documentTerms } from "../src/knowledge/graph.js";

const page = (id, title, text) => ({ id, title, text, sourceUrl: `https://example.feishu.cn/docx/${id}` });

test("只把真正共有的主题连起来，无关文档不相连", () => {
  const { nodes, links } = knowledgeGraph([
    page("a", "美股估值速览", "市盈率 市净率 估值 分化 美股 龙头 报酬率 市盈率 估值"),
    page("b", "美股分化与估值", "估值 市盈率 分化 美股 报酬率 龙头 市净率 估值"),
    page("c", "成都市城市概况", "成都 天府 火锅 熊猫 旅游 气候 人口 成都"),
  ]);
  assert.equal(nodes.length, 3);
  const between = (x, y) => links.find(l => (l.source === x && l.target === y) || (l.source === y && l.target === x));
  assert.ok(between("a", "b"), "两篇同主题文档之间应当有连线");
  assert.equal(between("a", "c"), undefined);
  assert.equal(between("b", "c"), undefined);
  assert.ok(between("a", "b").shared.length >= 2);
});

test("每篇都出现的词不制造关系，否则整张图会连成一团", () => {
  // "报告" appears in all three, so it must not be what links any pair.
  const { links } = knowledgeGraph([
    page("a", "报告一", "报告 报告 报告 苹果 苹果 香蕉"),
    page("b", "报告二", "报告 报告 报告 火箭 火箭 卫星"),
    page("c", "报告三", "报告 报告 报告 钢琴 钢琴 小提琴"),
  ]);
  for (const link of links) assert.ok(!link.shared.includes("报告"), `"报告" 不应当成为连接依据：${JSON.stringify(link)}`);
});

test("标题参与主题判断，正文为空也不会崩", () => {
  const { nodes } = knowledgeGraph([page("a", "薪酬数据总览分析", ""), page("b", "薪酬数据结构", "")]);
  assert.equal(nodes.length, 2);
  assert.ok(nodes[0].terms.length > 0);
});

test("分词不跨标点粘连，英文停用词不进入词表", () => {
  const terms = documentTerms("成都，火锅。the report");
  assert.ok(!terms.has("都火"), "标点两侧的字不应当粘成一个词");
  assert.ok(terms.has("火锅"));
  assert.ok(!terms.has("the"));
  assert.ok(terms.has("report"));
});

test("空输入返回空图，不抛错", () => {
  assert.deepEqual(knowledgeGraph([]), { nodes: [], links: [] });
});
