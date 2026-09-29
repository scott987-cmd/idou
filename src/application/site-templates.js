// Ready-made sites, in two axes: what the page is for, and what it looks like.
//
// A 场景 owns the structure -- the markup and the behaviour, which is where a
// 看板 differs from a 时间线. A 风格 owns nothing but a stylesheet. They meet
// through one vocabulary of class names, so five scenarios and three styles are
// fifteen sites out of eight files instead of fifteen copies drifting apart.
// Adding a style means writing one CSS file against that vocabulary; adding a
// scenario means writing markup that uses it.
//
// The files are real files under site-templates/, not strings in this module:
// they are HTML, CSS and JavaScript, and they are easier to write, read and
// review as themselves. They live under src/ so the release manifest covers
// them (release-manifest.js hashes every file under src/ and bin/), which means
// a template cannot be swapped out next to an installation.
//
// A scenario that shows a table reads it through the contract (table-contract.js)
// and nothing else: it never learns which kind of table it came from, never
// holds a credential, and renders every cell as text. One that does not -- a
// small game -- is plain static files and is never given one.
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "site-templates");
// What a template may be made of. A template is static: no imports to fetch, no
// build step, and nothing that only works on one machine.
const ALLOWED = new Set([".html", ".css", ".js", ".svg", ".json", ".md"]);

// How it looks. Only ever a stylesheet: a style that needed its own markup
// would stop being a style and become a scenario wearing one.
export const SITE_STYLES = Object.freeze([
  Object.freeze({ id: "clean", name: "简约", summary: "白底、克制的绿，字够大。适合给同事和客户看的正经页面。" }),
  Object.freeze({ id: "tech", name: "科技", summary: "深色底、发光的青，等宽数字和网格。适合盯着看的监控与大屏。" }),
  Object.freeze({ id: "depth", name: "立体", summary: "有厚度和投影，卡片会随指针轻微转动。适合展示和介绍页。" }),
]);
export const DEFAULT_STYLE = "clean";
export const siteStyle = (id) => SITE_STYLES.find((style) => style.id === id) ?? null;

// What it is for.
export const SITE_TEMPLATES = Object.freeze([
  Object.freeze({ id: "dashboard", name: "表格看板", table: true, styled: true,
    summary: "数字在上面，明细在下面，可排序可筛选。适合台账、报表、月度数据。" }),
  Object.freeze({ id: "directory", name: "名单查询", table: true, styled: true,
    summary: "一个搜索框加一片卡片，按任意一列筛。适合通讯录、产品目录、报名名单。" }),
  Object.freeze({ id: "kanban", name: "项目进度", table: true, styled: true,
    summary: "按状态那一列分成几列，一条记录一张卡。适合需求池、工单、招聘流程。" }),
  Object.freeze({ id: "timeline", name: "时间线", table: true, styled: true,
    summary: "按日期那一列排成一条线，同月归在一起。适合里程碑、发布计划、大事记。" }),
  Object.freeze({ id: "landing", name: "介绍页", table: false, styled: true,
    summary: "一个主视觉加几段卖点和一个行动按钮。不接表格，文案直接改 HTML。" }),
  Object.freeze({ id: "game", name: "小游戏", table: false, styled: false,
    summary: "一个能直接玩的贪吃蛇：计分、重开、键盘和触屏都行。当成骨架，把里面换成你自己的游戏。" }),
]);

export const siteTemplate = (id) => SITE_TEMPLATES.find((template) => template.id === id) ?? null;

// Where a combination's picture lives. A scenario with no style axis has one
// picture; the rest have one per style, because a style you cannot see is not
// a choice anybody can make.
export const previewName = (templateId, styleId = DEFAULT_STYLE) => {
  const template = siteTemplate(templateId);
  if (!template) return null;
  return template.styled ? `${template.id}-${siteStyle(styleId) ? styleId : DEFAULT_STYLE}.png` : `${template.id}.png`;
};

// The preview as the picker needs it: a data URL, because the picker is a
// renderer page with no file access of its own.
export async function templatePreview(id, styleId = DEFAULT_STYLE) {
  const name = previewName(id, styleId);
  if (!name) return null;
  try { return `data:image/png;base64,${(await readFile(path.join(ROOT, "previews", name))).toString("base64")}`; }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

// The files one combination is made of, as {name, bytes}. One place decides
// this, so writing a site, building a preview and standing up a demo can never
// disagree about what a template is.
export async function templateFiles(id, styleId = DEFAULT_STYLE) {
  const template = siteTemplate(id);
  if (!template) throw new Error("没有这个模版");
  const style = template.styled ? (siteStyle(styleId) ?? siteStyle(DEFAULT_STYLE)) : null;
  const from = template.styled ? path.join(ROOT, "scenarios", template.id) : path.join(ROOT, template.id);
  const files = [];
  for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !ALLOWED.has(path.extname(entry.name))) continue;
    files.push({ name: entry.name, bytes: await readFile(path.join(from, entry.name)) });
  }
  // The stylesheet is always written as site.css, whichever style it came from:
  // the markup asks for that one name, and a site that changed its look should
  // not change its file names too.
  if (style) files.push({ name: "site.css", bytes: await readFile(path.join(ROOT, "styles", `${style.id}.css`)) });
  if (!files.length) throw new Error("这个模版没有可用的文件");
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

// Writes a template into a site's folder. Never overwrites: a folder that
// already has an index.html is somebody's work, and a template is not worth
// losing it over. Returns what was written and what was left alone.
export async function writeTemplate(folder, id, styleId = DEFAULT_STYLE) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("需要网站目录的绝对路径");
  const files = await templateFiles(id, styleId);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const written = [], kept = [];
  for (const file of files) {
    const target = path.join(folder, file.name);
    if (await exists(target)) { kept.push(file.name); continue; }
    await writeFile(target, file.bytes, { mode: 0o600, flag: "wx" });
    written.push(file.name);
  }
  return { template: id, style: siteTemplate(id)?.styled ? (siteStyle(styleId) ? styleId : DEFAULT_STYLE) : null, written, kept };
}

// Change a site's look without touching anything else. This is only possible
// because a style is exactly one file: the markup and the behaviour are the
// scenario's and never vary, so swapping site.css is the whole operation.
//
// A stylesheet somebody has edited is their work. It is recognised by not
// matching any style this build ships, and replacing it needs saying so first
// -- `force`. Otherwise this refuses and says which one it looks like.
export async function restyleSite(folder, styleId, { force = false } = {}) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("需要网站目录的绝对路径");
  const style = siteStyle(styleId);
  if (!style) throw new Error("没有这个风格");
  const target = path.join(folder, "site.css");
  let current = null;
  try { current = await readFile(target); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const known = new Map();
  for (const one of SITE_STYLES) known.set(one.id, await readFile(path.join(ROOT, "styles", `${one.id}.css`)));
  const was = current ? [...known].find(([, bytes]) => bytes.equals(current))?.[0] ?? null : null;
  const edited = Boolean(current) && was === null;
  if (edited && !force) throw new Error("这个网站的 site.css 被改过了，换风格会覆盖掉你写的样式。");
  if (was === style.id) return { style: style.id, was, changed: false, edited: false };
  await writeFile(target, known.get(style.id), { mode: 0o600 });
  return { style: style.id, was, changed: true, edited };
}

// Which style a folder is wearing, or null when its stylesheet is somebody's
// own work (or there is none). Used to show the current choice rather than
// guess at it.
export async function styleOf(folder) {
  let current;
  try { current = await readFile(path.join(folder, "site.css")); } catch { return null; }
  for (const style of SITE_STYLES) {
    if ((await readFile(path.join(ROOT, "styles", `${style.id}.css`))).equals(current)) return style.id;
  }
  return null;
}

const exists = async (file) => { try { await stat(file); return true; } catch { return false; } };
