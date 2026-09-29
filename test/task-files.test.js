import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { attachFiles, attachmentKind, isDerived, listTaskFiles, removeTaskFile, taskFilesPrompt, READABLE_SUFFIX } from "../src/application/task-files.js";

const newDir = () => mkdtemp(path.join(os.tmpdir(), "taskfiles-"));

// A real .xlsx, written by Node's own deflate through the same container format
// Excel uses, so the conversion is exercised end to end rather than mocked.
async function spreadsheet(into, name = "销售.xlsx") {
  const { deflateRawSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const parts = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ["xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="明细" sheetId="1"/></sheets></workbook>'],
    ["xl/sharedStrings.xml", '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>产品</t></si><si><t>销售额</t></si><si><t>豆浆机</t></si></sst>'],
    ["xl/worksheets/sheet1.xml", '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>128000</v></c></row></sheetData></worksheet>'],
  ];
  const locals = [], central = []; let offset = 0;
  for (const [entry, xml] of parts) {
    const raw = Buffer.from(xml, "utf8"), data = deflateRawSync(raw), nameBytes = Buffer.from(entry, "utf8");
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30);
    locals.push(local, data);
    const record = Buffer.alloc(46 + nameBytes.length);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42); nameBytes.copy(record, 46);
    central.push(record);
    offset += local.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const file = path.join(into, name);
  await writeFile(file, Buffer.concat([...locals, directory, end]));
  return file;
  function crc32(buffer) {
    let crc = ~0;
    for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    return ~crc >>> 0;
  }
}

// A PDF carrying each way a file has smuggled code into a reader: JavaScript on
// open, on a page and behind a link, and a font matrix with a string where
// numbers belong (the CVE-2024-4367 shape). Written by hand so the parser sees
// exactly these bytes; all ASCII, so string offsets are byte offsets.
async function hostilePdf(into, name = "报告.pdf") {
  const payload = (where) => `(globalThis.__pdfPayloadRan = "${where}")`;
  const content = "BT /F1 20 Tf 72 720 Td (Quarterly report) Tj ET\nBT /F2 12 Tf 72 690 Td (Revenue grew in the north) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /Names << /JavaScript << /Names [(init) 6 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 7 0 R >> >> /Contents 5 0 R /Annots [8 0 R] /AA << /O 9 0 R >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Action /S /JavaScript /JS ${payload("open-action")} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding /FontMatrix [0.001 0 0 0.001 0 (0\\); globalThis.__pdfPayloadRan = "font-matrix"; //)] >>',
    `<< /Type /Annot /Subtype /Link /Rect [72 715 260 740] /Border [0 0 0] /A << /S /JavaScript /JS ${payload("link")} >> >>`,
    `<< /Type /Action /S /JavaScript /JS ${payload("page-open")} >>`,
  ];
  let body = "%PDF-1.7\n";
  const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const file = path.join(into, name);
  await writeFile(file, body);
  return file;
}

// pdf.js used to compile fonts and PostScript functions with `new Function`,
// which is how CVE-2024-4367 turned a crafted font into code. Every route from a
// string to code is watched for as long as one conversion runs.
function watchCodeGeneration() {
  const calls = [], original = { Function: globalThis.Function, constructor: Function.prototype.constructor, eval: globalThis.eval };
  const note = (kind, args) => calls.push(`${kind}: ${String(args.at(-1) ?? "").slice(0, 80)}`);
  const watched = new Proxy(original.Function, {
    apply: (target, self, args) => { note("Function", args); return Reflect.apply(target, self, args); },
    construct: (target, args) => { note("new Function", args); return Reflect.construct(target, args); },
  });
  globalThis.Function = watched;
  original.Function.prototype.constructor = watched;
  globalThis.eval = new Proxy(original.eval, { apply: (target, self, args) => { note("eval", args); return Reflect.apply(target, self, args); } });
  return { calls, stop() { globalThis.Function = original.Function; original.Function.prototype.constructor = original.constructor; globalThis.eval = original.eval; } };
}

const atLeast = (version, floor) => {
  const [have, need] = [version, floor].map((value) => value.split(".").map((part) => Number.parseInt(part, 10)));
  for (let index = 0; index < 3; index += 1) if (have[index] !== need[index]) return have[index] > need[index];
  return true;
};

test("附加二进制表格时同时写出可读副本，Agent 读得到内容", async () => {
  const source = await newDir(), task = await newDir();
  const file = await spreadsheet(source);
  const [added] = await attachFiles(task, [file]);
  assert.equal(added.kind, "convertible");
  assert.equal(added.converted, true, added.reason);
  const readable = await readFile(path.join(task, `销售.xlsx${READABLE_SUFFIX}`), "utf8");
  assert.match(readable, /豆浆机/);
  assert.match(readable, /128000/);
  // 副本要说清自己是副本，免得被当成交付物改。
  assert.match(readable, /自动转换/);
});

// 附加的 PDF 可能来自任何地方，而转换就在桌面端主进程里做。
test("PDF 里夹带的脚本只被当成数据：文字照常读出，没有任何代码被生成或执行", async () => {
  const source = await newDir(), task = await newDir();
  const file = await hostilePdf(source);
  // 先确认监视本身拦得到三条路，免得它什么都没看见也算通过。
  const control = watchCodeGeneration();
  try { new Function("return 1")(); (function () {}).constructor("return 2")(); globalThis.eval("3"); } finally { control.stop(); }
  assert.equal(control.calls.length, 3, `监视没有拦到从字符串生成代码：${JSON.stringify(control.calls)}`);

  delete globalThis.__pdfPayloadRan;
  const watch = watchCodeGeneration();
  let added;
  try { [added] = await attachFiles(task, [file]); } finally { watch.stop(); }
  assert.equal(added.converted, true, added.reason);
  const readable = await readFile(path.join(task, `报告.pdf${READABLE_SUFFIX}`), "utf8");
  assert.match(readable, /Quarterly report/);
  assert.match(readable, /Revenue grew in the north/);
  assert.equal(globalThis.__pdfPayloadRan, undefined, `PDF 里的脚本被执行了：${globalThis.__pdfPayloadRan}`);
  assert.deepEqual(watch.calls, [], "解析 PDF 时不该从字符串生成代码");
});

// officeparser 把 pdf.js 钉死在 CVE-2026-16633（GHSA-hq66-cqwq-w95j）修复之前的
// 版本上，package.json 用 overrides 换成了修复版。按 officeparser 自己的位置解析，
// 因为运行时它就是这样找到 pdf.js 的。
test("解析 PDF 用的 pdf.js 含 CVE-2026-16633 的修复，而且这条覆盖仍然必要", async () => {
  const parser = import.meta.resolve("officeparser");
  const loaded = createRequire(parser)("pdfjs-dist/package.json").version;
  assert.ok(atLeast(loaded, "6.2.108"), `officeparser 实际加载的 pdf.js 是 ${loaded}，低于修复版本 6.2.108`);
  // 等 officeparser 自己带上修复版，这条覆盖就只会把它拖在旧版本上。
  const declared = JSON.parse(await readFile(new URL("../package.json", parser), "utf8")).dependencies["pdfjs-dist"];
  assert.ok(!atLeast(declared.replace(/^[\^~>=\s]+/, ""), "6.2.108"), `officeparser 自带的 pdf.js（${declared}）已含修复，删掉 package.json 里 overrides 的这一项`);
});

test("列表把可读副本归到源文件名下，不当成一个独立文件", async () => {
  const source = await newDir(), task = await newDir();
  await attachFiles(task, [await spreadsheet(source)]);
  const rows = await listTaskFiles(task);
  assert.deepEqual(rows.map((row) => row.name), ["销售.xlsx"]);
  assert.equal(rows[0].readableCopy, `销售.xlsx${READABLE_SUFFIX}`);
  assert.ok(rows[0].bytes > 0);
  assert.match(taskFilesPrompt(rows), /读同目录下的 销售\.xlsx\.读取版\.md/);
});

test("纯文本文件不需要转换，也不会多出副本", async () => {
  const source = await newDir(), task = await newDir();
  await writeFile(path.join(source, "笔记.md"), "# 标题\n正文");
  const [added] = await attachFiles(task, [path.join(source, "笔记.md")]);
  assert.equal(added.kind, "text");
  assert.equal(added.converted, false);
  assert.deepEqual((await readdir(task)).sort(), ["笔记.md"]);
  assert.equal((await listTaskFiles(task))[0].readableCopy, null);
});

test("同名文件不会被静默覆盖——那可能是 Agent 刚写出的结果", async () => {
  const source = await newDir(), task = await newDir();
  await writeFile(path.join(source, "结果.md"), "外面的版本");
  await writeFile(path.join(task, "结果.md"), "任务里已有的版本");
  await assert.rejects(() => attachFiles(task, [path.join(source, "结果.md")]), /已经有一个叫/);
  assert.equal(await readFile(path.join(task, "结果.md"), "utf8"), "任务里已有的版本");
});

test("路径、隐藏文件、目录和自动生成的副本都不接受", async () => {
  const source = await newDir(), task = await newDir();
  await mkdir(path.join(source, "一个目录"));
  await writeFile(path.join(source, ".隐藏"), "x");
  await writeFile(path.join(source, `别的.xlsx${READABLE_SUFFIX}`), "x");
  await assert.rejects(() => attachFiles(task, ["相对路径.txt"]), /只能添加本机文件/);
  await assert.rejects(() => attachFiles(task, [path.join(source, "一个目录")]), /不能添加文件夹/);
  await assert.rejects(() => attachFiles(task, [path.join(source, ".隐藏")]), /隐藏文件/);
  await assert.rejects(() => attachFiles(task, [path.join(source, `别的.xlsx${READABLE_SUFFIX}`)]), /读取版/);
  await assert.rejects(() => attachFiles(task, []), /请先选择/);
  assert.deepEqual(await readdir(task), []);
});

test("删除源文件时它的可读副本一并删除，原始文件不受影响", async () => {
  const source = await newDir(), task = await newDir();
  const file = await spreadsheet(source);
  await attachFiles(task, [file]);
  assert.deepEqual(await removeTaskFile(task, "销售.xlsx"), []);
  assert.deepEqual(await readdir(task), []);
  assert.ok((await readFile(file)).length > 0, "放进来之前的原始文件不该被动");
});

test("没有文件时不往提示词里塞空话", () => {
  assert.equal(taskFilesPrompt([]), "");
});

test("识别文件类型，并认得自己生成的副本", () => {
  assert.equal(attachmentKind("表.xlsx"), "convertible");
  assert.equal(attachmentKind("稿.docx"), "convertible");
  assert.equal(attachmentKind("说明.pdf"), "convertible");
  assert.equal(attachmentKind("笔记.md"), "text");
  assert.equal(attachmentKind("图.png"), "image");
  assert.equal(attachmentKind("包.zip"), "other");
  assert.equal(attachmentKind(`表.xlsx${READABLE_SUFFIX}`), "derived");
  assert.equal(isDerived(`表.xlsx${READABLE_SUFFIX}`), true);
  assert.equal(isDerived("表.xlsx"), false);
});
