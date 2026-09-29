// An Agent reply shown the way people read it -- headings, lists, tables, code
// and links -- instead of as the raw Markdown characters.
//
// Parsing is markdown-it, the parser behind VS Code's Markdown preview, pinned
// in package.json and loaded from its self-contained browser build. It is told
// to treat raw HTML as text. Its output never reaches the HTML parser: the token
// stream is turned into nodes here, one allow-listed element per token, with
// every piece of text going in as a text node. A reply that quotes `<script>`
// therefore shows those characters, and no reply can produce an element or an
// attribute that is not named in this file.
//
// A reply is untrusted: it can repeat whatever a document, a chat or a web page
// the Agent read had in it. Two rules follow. An image is never fetched -- a
// remote image carrying data out in its address is the classic leak, and the
// page's CSP would refuse it anyway -- so it is shown as its description and
// address. A link is followed only when the person clicks it, only if it is
// https, and only in the system browser; this window never navigates.
import MarkdownIt from "../../../node_modules/markdown-it/dist/browser/markdown-it.esm.min.mjs";

// markdown-it is linear on hostile input (a 64 KB line of `[a](`, a 64 KB
// quote run and similar finish in well under 200 ms), but a reply past these
// sizes would still cost the renderer more than it is worth, so it is shown as
// written instead.
const MAX_TEXT = 100_000;
const MAX_TOKENS = 40_000;

const parser = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false, maxNesting: 20 });

const ELEMENTS = Object.freeze({ paragraph: "p", bullet_list: "ul", ordered_list: "ol", list_item: "li", blockquote: "blockquote",
  thead: "thead", tbody: "tbody", tr: "tr", th: "th", td: "td", strong: "strong", em: "em", s: "s" });
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const CLASSES = Object.freeze({ bullet_list: "md-list", ordered_list: "md-list", blockquote: "md-quote" });
const ALIGN = /^text-align:(left|center|right)$/;
const TASK = /^\[([ xX])\] /;

// The only addresses a click may hand to the system browser.
export function externalLink(href) {
  try {
    const url = new URL(String(href ?? ""));
    return url.protocol === "https:" && !url.username && !url.password && url.hostname ? url.href : null;
  } catch { return null; }
}

function make(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const attr = (token, name) => token.attrGet?.(name) ?? token.attrs?.find(([key]) => key === name)?.[1] ?? null;

function inline(children, parent, doc, taskItem) {
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  children.forEach((token, index) => {
    switch (token.type) {
      case "text": {
        let text = token.content;
        // A GFM task item: `- [ ] 写周报` shows a box rather than the brackets.
        if (taskItem && index === 0 && TASK.test(text)) { top().append(make(doc, "span", "md-task", /^\[ \]/.test(text) ? "☐" : "☑")); text = text.slice(4); }
        top().append(doc.createTextNode(text));
        break;
      }
      case "softbreak": case "hardbreak": top().append(make(doc, "br")); break;
      case "code_inline": top().append(make(doc, "code", undefined, token.content)); break;
      case "link_open": {
        const href = attr(token, "href"), target = externalLink(href);
        const node = target ? make(doc, "a", "md-anchor") : make(doc, "span", "md-inert-link");
        if (target) { node.href = target; node.rel = "noreferrer noopener"; node.dataset.externalLink = target; }
        node.title = target ?? `未打开的链接：${String(href ?? "").slice(0, 300)}`;
        top().append(node); stack.push(node);
        break;
      }
      case "image": {
        const src = attr(token, "src"), target = externalLink(src);
        const node = make(doc, "span", "md-image", `[图片] ${token.content || "未命名"}`);
        node.title = `图片不会自动加载：${String(src ?? "").slice(0, 300)}`;
        if (target) { const open = make(doc, "a", "md-anchor", "打开"); open.href = target; open.rel = "noreferrer noopener"; open.dataset.externalLink = target; open.title = target; node.append(" ", open); }
        top().append(node);
        break;
      }
      default:
        if (token.nesting === 1 && ELEMENTS[token.type.replace(/_open$/, "")]) { const node = make(doc, ELEMENTS[token.type.replace(/_open$/, "")]); top().append(node); stack.push(node); }
        else if (token.nesting === -1) { if (stack.length > 1) stack.pop(); }
        // html_inline and anything unforeseen: its characters, as text.
        else if (token.content) top().append(doc.createTextNode(token.content));
    }
  });
}

function blocks(tokens, root, doc) {
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let taskItem = false;
  for (const token of tokens) {
    if (token.type === "inline") { inline(token.children ?? [], top(), doc, taskItem); taskItem = false; continue; }
    if (token.nesting === -1) { if (stack.length > 1) stack.pop(); continue; }
    if (token.nesting === 1) {
      // A tight list's paragraphs are marked hidden: their text belongs directly in the item.
      if (token.hidden) { stack.push(top()); continue; }
      const kind = token.type.replace(/_open$/, "");
      let node;
      if (kind === "heading") node = make(doc, HEADINGS.has(token.tag) ? token.tag : "p", "md-heading");
      else if (kind === "table") { const wrap = make(doc, "div", "md-table-wrap"); node = make(doc, "table", "md-table"); wrap.append(node); top().append(wrap); stack.push(node); continue; }
      else node = make(doc, ELEMENTS[kind] ?? "div", CLASSES[kind]);
      if (kind === "ordered_list") { const start = Number(attr(token, "start")); if (Number.isInteger(start) && start > 1 && start < 1e6) node.start = start; }
      if (kind === "th" || kind === "td") { const align = ALIGN.exec(attr(token, "style") ?? "")?.[1]; if (align) node.className = `md-align-${align}`; }
      if (kind === "list_item") taskItem = true;
      top().append(node); stack.push(node);
      continue;
    }
    if (token.type === "fence" || token.type === "code_block") {
      const pre = make(doc, "pre", "md-code"), code = make(doc, "code", undefined, token.content.replace(/\n$/, ""));
      const language = String(token.info ?? "").trim().split(/\s+/)[0];
      if (/^[A-Za-z0-9_+#.-]{1,30}$/.test(language)) pre.dataset.language = language;
      pre.append(code); top().append(pre);
    } else if (token.type === "hr") top().append(make(doc, "hr"));
    // html_block (raw HTML is off, so this is only a guard) and anything unforeseen: as text.
    else if (token.content) top().append(make(doc, "p", undefined, token.content));
  }
}

// The reply as nodes. Past the size limits, or if the parser ever throws, the
// reply is shown exactly as written -- which is what every reply looked like
// before this file existed.
export function renderReply(text, doc = globalThis.document) {
  const source = String(text ?? "");
  const root = make(doc, "div", "message-text markdown");
  let tokens = null;
  if (source.length <= MAX_TEXT) { try { tokens = parser.parse(source, {}); } catch { tokens = null; } }
  if (!tokens || tokens.length > MAX_TOKENS) { root.className = "message-text"; root.textContent = source; return root; }
  blocks(tokens, root, doc);
  return root;
}
