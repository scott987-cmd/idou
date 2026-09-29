#!/usr/bin/env node
// Turning a finished draft into a .docx or .pptx is mechanical, and leaving it
// to the Agent means it spends a turn installing packages and writing a
// throwaway script — which in practice it does not finish. So the product ships
// the conversion, the same way it ships the Feishu CLI, and the Agent writes
// Markdown and calls this.
//
//   node bin/doc-tool.js docx <input.md> <output.docx>
//   node bin/doc-tool.js pptx <input.md> <output.pptx>
//
// The Markdown convention is the one people already write:
//   #  title          → document title / deck cover
//   ## heading        → heading / a new slide
//   ### subheading    → subheading / slide subtitle
//   - item            → bullet
//   everything else   → paragraph / slide body line
import "../src/adopt-legacy-env.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [, , format, input, output] = process.argv;
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };
if (!["docx", "pptx"].includes(format)) fail("用法：doc-tool.js <docx|pptx> <输入.md> <输出文件>");
if (!input || !output) fail("需要输入的 Markdown 文件和输出文件路径");
if (path.extname(output).toLowerCase() !== `.${format}`) fail(`输出文件名要以 .${format} 结尾`);

const source = await readFile(input, "utf8").catch(() => fail(`读不到输入文件：${input}`));

// One pass, because the shapes both writers need are the same: a flat list of
// blocks in document order.
function blocks(markdown) {
  const out = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { out.push({ kind: "heading", level: heading[1].length, text: inline(heading[2]) }); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) { out.push({ kind: "bullet", text: inline(bullet[1]) }); continue; }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) { out.push({ kind: "bullet", text: inline(numbered[1]) }); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { out.push({ kind: "row", cells: line.trim().slice(1, -1).split("|").map((cell) => inline(cell.trim())) }); continue; }
    out.push({ kind: "text", text: inline(line) });
  }
  // A Markdown table's separator row is punctuation, not content.
  return out.filter((block) => !(block.kind === "row" && block.cells.every((cell) => /^:?-{2,}:?$/.test(cell))));
}
// Emphasis markers and link syntax would otherwise be read out literally in the
// finished file, which looks like a bug to whoever opens it.
const inline = (text) => text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1").replace(/`([^`]+)`/g, "$1");

const parsed = blocks(source);
if (!parsed.length) fail("输入文件里没有可以转换的内容");

if (format === "docx") {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, WidthType } = await import("docx");
  const levels = { 1: HeadingLevel.TITLE, 2: HeadingLevel.HEADING_1, 3: HeadingLevel.HEADING_2, 4: HeadingLevel.HEADING_3 };
  const children = [];
  for (let at = 0; at < parsed.length; at += 1) {
    const block = parsed[at];
    if (block.kind === "row") {
      const rows = [];
      while (at < parsed.length && parsed[at].kind === "row") { rows.push(parsed[at].cells); at += 1; }
      at -= 1;
      const width = Math.max(...rows.map((row) => row.length));
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
        rows: rows.map((row) => new TableRow({ children: Array.from({ length: width }, (_, index) => new TableCell({ children: [new Paragraph(row[index] ?? "")] })) })) }));
      children.push(new Paragraph(""));
    } else if (block.kind === "heading") children.push(new Paragraph({ text: block.text, heading: levels[block.level] }));
    else if (block.kind === "bullet") children.push(new Paragraph({ text: block.text, bullet: { level: 0 } }));
    else children.push(new Paragraph(block.text));
  }
  await writeFile(output, await Packer.toBuffer(new Document({ sections: [{ children }] })));
} else {
  // Text only, on purpose: pptxgenjs declares image-size, whose parsers loop
  // forever on crafted images and have no fixed release. Its builds never load
  // it and nothing here hands it an image; test/doc-tool.test.js fails if either changes.
  const { default: PptxGenJS } = await import("pptxgenjs");
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_16x9";
  // `##` starts a slide. Anything before the first one belongs to the cover, so
  // a document written as prose still comes out as a usable deck.
  const slides = [];
  let current = null;
  for (const block of parsed) {
    if (block.kind === "heading" && block.level <= 2) { current = { title: block.text, lines: [] }; slides.push(current); continue; }
    if (!current) { current = { title: "", lines: [] }; slides.push(current); }
    if (block.kind === "row") current.lines.push(block.cells.filter(Boolean).join("　"));
    else current.lines.push(block.text);
  }
  for (const [index, slide] of slides.entries()) {
    const page = deck.addSlide();
    const cover = index === 0 && !slide.lines.length;
    if (slide.title) page.addText(slide.title, { x: 0.6, y: cover ? 2.4 : 0.5, w: 8.8, h: cover ? 1.2 : 0.8, fontSize: cover ? 40 : 28, bold: true, color: "1F2329" });
    if (slide.lines.length) {
      page.addText(slide.lines.map((line) => ({ text: line, options: { bullet: true, breakLine: true } })),
        { x: 0.8, y: 1.5, w: 8.4, h: 3.6, fontSize: 18, color: "51565D", lineSpacingMultiple: 1.4 });
    }
  }
  await deck.writeFile({ fileName: output });
}
process.stdout.write(`${output}\n`);
