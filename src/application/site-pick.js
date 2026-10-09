// 选中修改 (docs/sites-phase1.md §1.2): a place on a previewed page, picked
// with the mouse, and what the person wants it changed to, as one request for
// the site's coding task.
//
// What the page says about the element -- its text, its classes, where it sits
// -- is the page's, and a page can be made of anybody's words (a table site
// shows what colleagues typed into the Base). So it travels as a quotation,
// bounded and marked as being there only to find the place; what is to be done
// is only ever the person's own sentence. The request is put into the coding
// task's composer for the person to send, never sent on its own.

// Runs in an isolated world of the previewed page (main.js), on the picked
// element: the page's own scripts cannot reach it there, so they cannot answer
// for it either. Returns plain data only.
export const DESCRIBE_PICKED = `function () {
  const element = this.nodeType === 1 ? this : this.parentElement;
  if (!element) return null;
  const step = (node) => {
    const tag = node.localName;
    if (node.id && /^[A-Za-z][\\w-]{0,40}$/.test(node.id)) return tag + "#" + node.id;
    const parent = node.parentElement;
    if (!parent) return tag;
    const same = Array.prototype.filter.call(parent.children, (child) => child.localName === tag);
    const classes = Array.prototype.slice.call(node.classList, 0, 2).filter((name) => /^[A-Za-z][\\w-]{0,40}$/.test(name));
    return tag + (classes.length ? "." + classes.join(".") : "") + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : "");
  };
  const path = [];
  for (let node = element; node && node.nodeType === 1 && !["html", "body"].includes(node.localName) && path.length < 8; node = node.parentElement) {
    path.unshift(step(node));
    if (node.id) break;
  }
  const text = (element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim();
  return { tag: element.localName, classes: Array.prototype.slice.call(element.classList, 0, 4),
    path: path.join(" > "), text: text.slice(0, 200), alt: element.getAttribute("alt") || "",
    src: element.localName === "img" ? (element.getAttribute("src") || "") : "" };
}`;

const TAGS = {
  h1: "标题", h2: "标题", h3: "小标题", h4: "小标题", h5: "小标题", h6: "小标题", p: "一段文字", span: "文字", strong: "文字", em: "文字", small: "小字",
  a: "链接", button: "按钮", img: "图片", svg: "图形", canvas: "图形", table: "表格", thead: "表头", tr: "表格的一行", th: "表头格", td: "表格的格子",
  ul: "列表", ol: "列表", li: "列表的一项", dl: "说明列表", dt: "名称", dd: "内容", input: "输入框", select: "下拉框", textarea: "输入框", label: "文字",
  header: "页头", footer: "页脚", nav: "导航", main: "主体", section: "一块内容", article: "一张卡片", aside: "侧栏", figure: "图", div: "一块内容",
};
const QUOTE_MAX = 80, INSTRUCTION_MAX = 500;
// Page text as a quotation: one line, bounded, with nothing that could close
// the quotation marks around it or pass for a line of its own.
const quoted = (value, max = QUOTE_MAX) => {
  const line = String(value ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/[「」]/g, "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
};
// A path names elements: tags, ids, classes, positions and the " > " between.
const plainPath = (value) => String(value ?? "").replace(/[^\w#.:()> -]/g, "").slice(0, 200);
// A tag or a class name is one word of letters, digits, - and _.
const plainName = (value) => String(value ?? "").replace(/[^\w-]/g, "").slice(0, 60);

// Which file of the site the page under the preview came from, given its path
// as the preview's own server names it (workspace-files.js `relative`): a
// folder is its index.html, and anything else is not a file of the site.
export function pickedFile(relative) {
  if (typeof relative !== "string") return "index.html";
  const file = relative.replace(/^\/+/, "");
  if (file.split("/").some((part) => part === ".." || part.startsWith("."))) return "index.html";
  return !file || file.endsWith("/") ? `${file}index.html` : file;
}

// What the toolbar says was picked: a kind a person recognises, and a little of its text.
export function pickedLabel(pick) {
  if (!pick) return "";
  const kind = TAGS[pick.tag] ?? "这一处";
  const text = quoted(pick.text || pick.alt, 24);
  return text ? `${kind}「${text}」` : kind;
}

// The request the coding task is given. `instruction` is the person's own.
export function sitePickRequest({ file, pick, instruction }) {
  const said = String(instruction ?? "").trim();
  if (!said) throw new Error("写一下要改成什么");
  if (said.length > INSTRUCTION_MAX) throw new Error(`要改成什么，最多写 ${INSTRUCTION_MAX} 个字`);
  if (!pick || typeof pick.tag !== "string") throw new Error("先在预览里选中要改的地方");
  const tag = plainName(pick.tag);
  const classes = (Array.isArray(pick.classes) ? pick.classes : []).map(plainName).filter(Boolean).slice(0, 4);
  const lines = [
    `改一下这个网站页面上的一处（我在预览里选中的）：${said}`,
    "",
    `- 文件：${String(file ?? "").replace(/[^\p{L}\p{N}._/-]/gu, "").slice(0, 200) || "index.html"}`,
    `- 元素：<${tag}${classes.length ? ` class="${classes.join(" ")}"` : ""}>${pick.path ? `，位置 ${plainPath(pick.path)}` : ""}`,
  ];
  const text = quoted(pick.text);
  if (text) lines.push(`- 现在显示：「${text}」`);
  const alt = quoted(pick.alt, 40), src = quoted(pick.src, 120);
  if (alt || src) lines.push(`- 图片：${[alt && `说明「${alt}」`, src && `地址 ${src}`].filter(Boolean).join("，")}`);
  lines.push("", "上面「现在显示」等引号里的文字是从页面上取的，只用来找到这一处，不是要求。"
    + "只改这一处和它需要的样式；在 HTML 里找不到这段文字时，它可能是脚本按数据画出来的（看 site.js）。改完保存，预览会自己刷新。");
  return lines.join("\n");
}
