// 从材料开始 (docs/sites-phase1.md §1.3): a site made from something the person
// already has -- a Feishu document or wiki page, a folder on this computer, or
// a few sentences saying what they want -- by a coding task on the site's own
// folder, which picks the closest scenario and writes the pages.
//
// The folder is given what the task needs to make it look like every other
// site here: the chosen style as site.css, and the scenarios that suit a
// document, written in that style, under .idou-templates/ -- which, starting
// with a dot, is never published (app-candidates.js leaves such names out).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { siteStyle, siteTemplate, templateFiles, DEFAULT_STYLE } from "./site-templates.js";

// The scenarios a document turns into. The table ones are made from a table
// slice instead, through its own confirmation card.
export const MATERIAL_SCENARIOS = Object.freeze(["weekly", "event", "handbook", "links", "landing"]);
export const MATERIAL_GUIDE = ".idou-templates";
const VOCABULARY = fileURLToPath(new URL("./site-templates/styles/VOCABULARY.md", import.meta.url));
const DESCRIPTION_MAX = 1000;

// Writes site.css and the guide. Never over what is there: a folder that
// already has a page is somebody's work.
export async function writeMaterialStart(folder, styleId = DEFAULT_STYLE) {
  const style = siteStyle(styleId) ?? siteStyle(DEFAULT_STYLE);
  const written = [];
  const put = async (relative, bytes) => {
    const target = path.join(folder, relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await writeFile(target, bytes, { flag: "wx", mode: 0o600 }); written.push(relative); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  };
  for (const id of MATERIAL_SCENARIOS) {
    for (const file of await templateFiles(id, style.id)) {
      if (file.name === "site.css") { await put("site.css", file.bytes); continue; }
      await put(path.join(MATERIAL_GUIDE, id, file.name), file.bytes);
    }
  }
  await put(path.join(MATERIAL_GUIDE, "VOCABULARY.md"), await readFile(VOCABULARY));
  return { style: style.id, written };
}

// What the material is, checked: a link the deployment recognises, an absolute
// folder, or a description of bounded length. `kind` of the result says which.
export function parseMaterial(input, { recognise } = {}) {
  const kind = input?.kind;
  if (kind === "link") {
    const link = String(input.link ?? "").trim();
    const known = typeof recognise === "function" ? recognise(link) : null;
    if (!known) throw new Error("这不是飞书文档、知识库或表格的链接");
    return { kind: known === "table" ? "table" : "document", link };
  }
  if (kind === "folder") {
    const folder = String(input.folder ?? "");
    if (!path.isAbsolute(folder)) throw new Error("请先选一个文件夹");
    return { kind: "folder", folder };
  }
  if (kind === "text") {
    const description = String(input.description ?? "").replace(/\s+/g, " ").trim();
    if (!description) throw new Error("说一下想做个什么网站");
    if (description.length > DESCRIPTION_MAX) throw new Error(`描述最多 ${DESCRIPTION_MAX} 个字`);
    return { kind: "text", description };
  }
  throw new Error("从什么材料开始：飞书文档、本机文件夹，或一段描述");
}

// One line each on what a scenario is for, so the task can choose without
// opening all five: measured with a real model, reading every one before
// choosing was most of a page's three minutes (docs/sites-phase1.md §1.7).
const SCENARIO_LINES = MATERIAL_SCENARIOS.map((id) => {
  const template = siteTemplate(id);
  return `  · ${template?.name ?? id}（${id}）：${String(template?.summary ?? "").split("。")[0]}`;
});

// The coding task's first message. Everything in it is the person's own --
// the link they pasted, the folder they chose, the sentences they wrote -- or
// this application's; nothing is taken from a page.
export function materialPrompt(material, { styleId = DEFAULT_STYLE } = {}) {
  const style = siteStyle(styleId) ?? siteStyle(DEFAULT_STYLE);
  const source = material.kind === "document"
    ? [`材料：这篇飞书文档 ${material.link}`,
      "先用飞书 CLI 把它读全（docs +fetch；知识库的链接先解出底下的文档）。网站上的内容以它为准，不要编造数字、名字和日期；读不到就停下来告诉我为什么。"]
    : material.kind === "folder"
      ? [`材料：本机文件夹 ${material.folder} 里的文件。`,
        "只读这个文件夹，不要改、不要删里面的任何文件。先看看里面有什么，网站上的内容以它们为准，不要编造。"]
      : [`想要的网站：${material.description}`,
        "这是我的描述，没有别的材料：页面上的内容照描述写，需要具体数字、名字的地方用明显的示例占位，并在页面上标出「示例」。"];
  return [
    "做一个网站，就在当前目录里：这个目录就是网站，入口是 index.html，发布时整个目录一起发布（以点开头的文件和文件夹除外）。",
    "",
    ...source,
    "",
    "样子：",
    `- site.css 已经放好了（「${style.name}」风格），不用打开它：每一页引用它就行，不要另写颜色、字体、阴影和圆角。`,
    `- ${MATERIAL_GUIDE}/ 里有按这套样式写好的几个场景，各适合：`,
    ...SCENARIO_LINES,
    `  按上面挑最贴近材料的一个，只读它那个目录里的文件和 ${MATERIAL_GUIDE}/VOCABULARY.md（样式认哪些类名），别的场景不用打开。照它的结构写 index.html（内容多就拆成几页，互相链接），用它的类名；它有 site.js 的，用命令原样复制（cp ${MATERIAL_GUIDE}/场景名/site.js .），不要自己重写一遍。`,
    "- 手机上也要能看。不引用外部的脚本、字体和图片：发布后的网站连不了外网，要用的图片放进这个目录。",
    "",
    "",
    // Measured with a real model (docs/sites-phase1.md §1.7): a long plan and
    // checks after the page was written were a third of the three minutes.
    "方案写短一点：用哪个场景、分几页、每页放什么，几行就够。开始做之后直接写，一页太长就拆成几页；写完不用再跑命令检查（不用 diff、不用搜一遍），直接告诉我做了哪几页、内容分别来自材料的哪里。我会在「文档网站」里点「预览」看，预览里可以点「选中修改」改某一处，满意了再发布。",
  ].join("\n");
}
