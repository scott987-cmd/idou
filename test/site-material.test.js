import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MATERIAL_GUIDE, MATERIAL_SCENARIOS, materialPrompt, parseMaterial, writeMaterialStart } from "../src/application/site-material.js";
import { snapshotApp } from "../src/application/app-candidates.js";

// 从材料开始 (docs/sites-phase1.md §1.3): what a site made from a document, a
// folder or a description is given to start from, and the coding task's first message.

const recognise = (value) => /\/docx\/|\/wiki\//.test(value) ? "document" : /\/base\/|\/sheets\//.test(value) ? "table" : null;

test("a material is one of three kinds, each checked", () => {
  assert.deepEqual(parseMaterial({ kind: "link", link: " https://synthetic.feishu.cn/docx/AbcDocToken01 " }, { recognise }),
    { kind: "document", link: "https://synthetic.feishu.cn/docx/AbcDocToken01" });
  assert.deepEqual(parseMaterial({ kind: "link", link: "https://synthetic.feishu.cn/base/AbcBaseToken01" }, { recognise }).kind, "table", "a table goes the table's own way");
  assert.throws(() => parseMaterial({ kind: "link", link: "https://example.com/page" }, { recognise }), /不是飞书文档、知识库或表格的链接/);
  assert.throws(() => parseMaterial({ kind: "link", link: "https://synthetic.feishu.cn/docx/x" }), /不是飞书/, "no deployment to recognise it: refused");
  assert.deepEqual(parseMaterial({ kind: "folder", folder: "/Users/someone/资料" }), { kind: "folder", folder: "/Users/someone/资料" });
  assert.throws(() => parseMaterial({ kind: "folder", folder: null }), /先选一个文件夹/, "a handle that named nothing");
  assert.throws(() => parseMaterial({ kind: "folder", folder: "资料" }), /先选一个文件夹/);
  assert.deepEqual(parseMaterial({ kind: "text", description: "  入职指南\n讲报销  " }), { kind: "text", description: "入职指南 讲报销" });
  assert.throws(() => parseMaterial({ kind: "text", description: " " }), /说一下想做个什么网站/);
  assert.throws(() => parseMaterial({ kind: "text", description: "长".repeat(1001) }), /最多 1000 个字/);
  assert.throws(() => parseMaterial({ kind: "zip" }), /从什么材料开始/);
});

test("the folder starts with the chosen style and the scenarios to choose from -- none of which is published", async (t) => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "idou-site-material-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const started = await writeMaterialStart(folder, "tech");
  assert.equal(started.style, "tech");
  assert.equal(await readFile(path.join(folder, "site.css"), "utf8"), await readFile(new URL("../src/application/site-templates/styles/tech.css", import.meta.url), "utf8"));
  assert.deepEqual((await readdir(path.join(folder, MATERIAL_GUIDE))).sort(), [...MATERIAL_SCENARIOS, "VOCABULARY.md"].sort());
  for (const id of MATERIAL_SCENARIOS) assert.ok((await readdir(path.join(folder, MATERIAL_GUIDE, id))).includes("index.html"), id);
  // Published: only the site's own page.
  await writeFile(path.join(folder, "index.html"), "<!doctype html><title>入职指南</title><link rel=\"stylesheet\" href=\"site.css\"><h1>入职指南</h1>");
  const snapshot = await snapshotApp(folder, "index.html");
  assert.deepEqual(snapshot.manifest.files.map((file) => file.path).sort(), ["index.html", "site.css"], "the guide never leaves this computer");
  // Again over it: nothing written over.
  await writeFile(path.join(folder, "site.css"), "/* mine */");
  assert.deepEqual((await writeMaterialStart(folder, "clean")).written, []);
  assert.equal(await readFile(path.join(folder, "site.css"), "utf8"), "/* mine */");
});

test("the first message says what the material is and where the look comes from", () => {
  const document = materialPrompt({ kind: "document", link: "https://synthetic.feishu.cn/wiki/AbcWikiToken01" }, { styleId: "depth" });
  assert.match(document, /材料：这篇飞书文档 https:\/\/synthetic\.feishu\.cn\/wiki\/AbcWikiToken01/);
  assert.match(document, /docs \+fetch/);
  assert.match(document, /不要编造/);
  assert.match(document, /\.idou-templates\/ 里有按这套样式写好的几个场景，各适合：/);
  for (const line of ["周报（weekly）", "活动页（event）", "培训手册（handbook）：左边目录、右边按章节读", "内部导航（links）", "介绍页（landing）"]) assert.ok(document.includes(`  · ${line}`), line);
  assert.match(document, /只读它那个目录里的文件和 \.idou-templates\/VOCABULARY\.md/, "chosen from the lines, not by opening all five");
  assert.match(document, /发布后的网站连不了外网/);
  assert.match(document, /site\.css 已经放好了（「立体」风格），不用打开它/, "no reading what is already decided");
  assert.match(document, /方案写短一点/);
  assert.match(document, /用命令原样复制（cp \.idou-templates\/场景名\/site\.js \.），不要自己重写一遍/, "measured: re-typing it was a minute");
  assert.match(document, /写完不用再跑命令检查/);
  const folder = materialPrompt({ kind: "folder", folder: "/Users/someone/资料" });
  assert.match(folder, /本机文件夹 \/Users\/someone\/资料/);
  assert.match(folder, /不要改、不要删/);
  assert.match(folder, /「简约」风格/, "the default style");
  const text = materialPrompt({ kind: "text", description: "给新同事的入职指南" });
  assert.match(text, /想要的网站：给新同事的入职指南/);
  assert.match(text, /标出「示例」/, "no material: what is made up is said to be");
});
