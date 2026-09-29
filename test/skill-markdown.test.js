import test from "node:test";
import assert from "node:assert/strict";
import { inlineNodes, markdownBlocks, skillFrontmatter } from "../src/desktop/renderer/skill-markdown.js";

// A stand-in for document.createElement that records exactly what the renderer
// builds. It has no innerHTML at all, so any attempt to parse markup would show
// up as a missing property rather than silently working.
function fake(tag, text, className) {
  const node = { tag, className, children: [], dataset: {}, append(...items) { this.children.push(...items); } };
  if (text !== undefined) node.textContent = text;
  return node;
}
const textOf = node => typeof node === "string" ? node : node.textContent ?? node.children.map(textOf).join("");
const tags = nodes => nodes.map(node => typeof node === "string" ? "#text" : node.tag);

test("frontmatter is lifted off and read as metadata, not rendered as prose", () => {
  const { meta, body } = skillFrontmatter('---\nname: weekly-brief\ndescription: "整理本周进展"\n---\n# 周报\n正文');
  assert.deepEqual(meta, { name: "weekly-brief", description: "整理本周进展" });
  assert.equal(body, "# 周报\n正文");
  assert.deepEqual(skillFrontmatter("没有头部").meta, {});
});

// The reason this renderer exists instead of a Markdown library: skill text is
// untrusted, and preview must display it, never run it.
test("markup inside a skill is shown as text and never becomes an element", () => {
  const blocks = markdownBlocks(fake, "<script>window.__skillExecuted = true</script>\n\n<img src=x onerror=alert(1)>");
  assert.deepEqual(tags(blocks), ["p", "p"]);
  assert.equal(textOf(blocks[0]), "<script>window.__skillExecuted = true</script>");
  assert.equal(textOf(blocks[1]), "<img src=x onerror=alert(1)>");
  const everything = JSON.stringify(blocks);
  assert.doesNotMatch(everything, /"tag":"(script|img|a|iframe)"/);
});

test("links keep their text but cannot be followed, and images are never fetched", () => {
  const nodes = inlineNodes(fake, "见 [说明](https://example.com/x) 与 ![截图](https://example.com/a.png)");
  const link = nodes.find(node => node.className === "md-link");
  assert.equal(link.tag, "span");
  assert.equal(textOf(link), "说明");
  assert.equal(link.title, "https://example.com/x");
  // The address is shown as text -- a reviewer deciding on a skill should see
  // where its images point -- but nothing is ever loaded from it.
  assert.equal(nodes.find(node => node.className === "md-image").textContent, "［图片：截图 · https://example.com/a.png］");
  assert.doesNotMatch(JSON.stringify(nodes), /"src"|"href"/);
});

test("the structures skill authors actually write come out as structure", () => {
  const blocks = markdownBlocks(fake, [
    "# 使用方法", "先读文档，", "再动手。", "", "- 第一步", "- 第二步 **重要**", "", "1. 甲", "2. 乙",
    "", "```bash", "lark-cli docs +fetch", "```", "", "> 注意：不要删", "", "---",
    "", "| 字段 | 说明 |", "| --- | --- |", "| name | 技能名 |",
  ].join("\n"));
  assert.deepEqual(tags(blocks), ["h3", "p", "ul", "ol", "pre", "blockquote", "hr", "div"]);
  // Chinese soft breaks join without a stray space.
  assert.equal(textOf(blocks[1]), "先读文档，再动手。");
  assert.equal(blocks[2].children.length, 2);
  assert.equal(textOf(blocks[2].children[1].children.find(node => node.tag === "strong")), "重要");
  assert.equal(blocks[4].children[0].textContent, "lark-cli docs +fetch");
  assert.equal(blocks[4].children[0].dataset.language, "bash");
  const table = blocks[7].children[0];
  assert.equal(table.tag, "table");
  assert.equal(textOf(table.children[1].children[0]), "name技能名");
});

// The dialog title is the <h2>; a skill's own "# Title" must not outrank it.
test("headings are shifted below the dialog's own title", () => {
  assert.deepEqual(tags(markdownBlocks(fake, "# a\n## b\n###### c")), ["h3", "h4", "h6"]);
});

test("hostile or malformed input always terminates", () => {
  const nasty = ["```", "unterminated fence", "|a|", "|-|", ">", "> >", "#", "* ", "1.", "***", "", "`", "**", "[x](", "![](", "<http://"].join("\n");
  const blocks = markdownBlocks(fake, nasty.repeat(200));
  assert.ok(blocks.length > 0);
});

// The inputs a review found that froze the first, regex-based version for
// minutes to hours, each at the 64 KB a skill file may be (MAX_FILE_BYTES). An
// enterprise skill like this would have hung every client that opened it. The
// budget is generous for a slow CI machine and still orders of magnitude under
// what any super-linear scan would take at this size.
test("worst-case skill files render in linear time at the 64 KB file limit", () => {
  const size = 65_000;
  const cases = {
    "unclosed links": "[a](".repeat(size / 4),
    "backtick run": `x${"`".repeat(size)}`,
    "alternating ticks": "`a``".repeat(size / 4),
    "heading then spaces": `## T${" ".repeat(size)}end`,
    "table header then spaces": `a|b\n${" ".repeat(size)}x`,
    "bullet, spaces, line separator": `- ${" ".repeat(size)}a\u2028b`,
    "front matter line separator": `---\nname: ${" ".repeat(size)}\u2028x\n---\nbody`,
    "stars": "*a".repeat(size / 2),
    "bold markers": "**a".repeat(size / 3),
    "image openers": "![a](".repeat(size / 5),
    "deep quote": ">".repeat(size),
  };
  for (const [name, text] of Object.entries(cases)) {
    const started = performance.now();
    const { body } = skillFrontmatter(text);
    const blocks = markdownBlocks(fake, body);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1500, `${name}: ${elapsed.toFixed(0)} ms`);
    assert.ok(blocks.length > 0, `${name} still renders something`);
  }
});

// Thousands of nested quotes used to recurse once per '>' and overflow the stack.
test("deeply nested quotes are followed a few levels, then shown as text", () => {
  // Under the long-line limit, so this exercises the depth cap itself.
  const blocks = markdownBlocks(fake, `${"> ".repeat(1500)}深处`);
  let depth = 0, node = blocks[0];
  while (node?.tag === "blockquote") { depth++; node = node.children[0]; }
  assert.ok(depth >= 2 && depth <= 8, `followed ${depth} levels`);
  assert.match(JSON.stringify(blocks), /深处/);
  // Over it, the whole line is simply text.
  const long = markdownBlocks(fake, `${">".repeat(65_000)}x`);
  assert.equal(long[0].tag, "p");
});

// Seen in the real lark-doc skill: bold text and link text that carry inline
// code. Without re-reading their content, the backticks showed up literally.
test("marks nested inside bold and link text are rendered, not shown raw", () => {
  const [bold] = inlineNodes(fake, "**默认使用 `--as user` 身份**");
  assert.equal(bold.tag, "strong");
  assert.ok(bold.children.some(node => node.tag === "code" && node.textContent === "--as user"));
  assert.doesNotMatch(textOf(bold), /`/);
  const [link] = inlineNodes(fake, "[`../lark-shared/SKILL.md`](../lark-shared/SKILL.md)");
  assert.equal(link.className, "md-link");
  assert.equal(link.children[0].tag, "code");
  assert.equal(link.title, "../lark-shared/SKILL.md");
});
