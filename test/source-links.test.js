import test from "node:test";
import assert from "node:assert/strict";
import { matchSource, citedByLink } from "../src/desktop/renderer/source-links.js";

// 两次真机评测里模型真实抄错的两种样子，都来自同一个租户。
const sources = [
  { title: "出差报销管理制度（2026 修订版）", sourceUrl: "https://exampletenant.feishu.cn/docx/YQIM0cVauBZ9nBKDu36zrWHoAty" },
  { title: "研发中心 8 月项目进展汇报", sourceUrl: "https://exampletenant.feishu.cn/docx/XOTi0LY6kBQlIWK7OUzz5j7JAd4" },
  { title: "重点客户台账", sourceUrl: "https://exampletenant.feishu.cn/sheets/YBPI0OJCIBqB0KKhU0TzZAkxAz2?sheet=s1" },
];

test("完全一致的链接不改，也不算更正", () => {
  const found = matchSource("https://exampletenant.feishu.cn/docx/YQIM0cVauBZ9nBKDu36zrWHoAty", sources);
  assert.equal(found.source, sources[0]);
  assert.equal(found.corrected, false);
});

test("域名被抄掉几个字母，指回真正的来源", () => {
  const found = matchSource("https://exampleten.feishu.cn/docx/XOTi0LY6kBQlIWK7OUzz5j7JAd4", sources);
  assert.equal(found.source, sources[1]);
  assert.equal(found.corrected, true);
});

test("文档 token 错了一位，指回真正的来源", () => {
  const found = matchSource("https://exampletenant.feishu.cn/docx/YQIM0cVauBZ9nBKDu36zrVHoAty", sources);
  assert.equal(found.source, sources[0]);
  assert.equal(found.corrected, true);
});

test("类型不同、差得远、或者两个来源都差不多近时，一律不猜", () => {
  assert.equal(matchSource("https://exampletenant.feishu.cn/wiki/YQIM0cVauBZ9nBKDu36zrWHoAty", sources), null, "docx 和 wiki 不是一回事");
  assert.equal(matchSource("https://exampletenant.feishu.cn/docx/wlMG0jncWBuJxoKeEY1zF8RuAn2", sources), null, "别的文档不能被指到来源上");
  assert.equal(matchSource("https://example.com/docx/YQIM0cVauBZ9nBKDu36zrWHoAty", sources), null, "别的网站不碰");
  assert.equal(matchSource("http://exampletenant.feishu.cn/docx/YQIM0cVauBZ9nBKDu36zrWHoAty", sources), null, "只处理 https");
  const twins = [{ sourceUrl: "https://t.feishu.cn/docx/AAAAAAAAAAAAAAAA1" }, { sourceUrl: "https://t.feishu.cn/docx/AAAAAAAAAAAAAAAA2" }];
  assert.equal(matchSource("https://t.feishu.cn/docx/AAAAAAAAAAAAAAAA3", twins), null, "可能是任何一个，就不改");
});

test("带查询参数的表格链接，按类型和 token 对上", () => {
  const found = matchSource("https://exampletenant.feishu.cn/sheets/YBPI0OJCIBqB0KKhU0TzZAkxAz2", sources);
  assert.equal(found?.source, sources[2]);
});

test("回答里抄错的地址，也算引用了那个来源", () => {
  const text = "依据《研发中心 8 月项目进展汇报》（https://exampleten.feishu.cn/docx/XOTi0LY6kBQlIWK7OUzz5j7JAd4），以及 https://exampletenant.feishu.cn/docx/YQIM0cVauBZ9nBKDu36zrVHoAty。";
  assert.deepEqual([...citedByLink(text, sources)].sort(), [sources[0].sourceUrl, sources[1].sourceUrl].sort());
});
