// A SKILL.md shown as a document rather than a file dump, without ever handing
// it to the HTML parser.
//
// Skill text is untrusted. A folder someone imported, a plugin from a market
// and an entry on the enterprise shelf can each contain anything, including
// markup written to run. Every node here is made with `element()` and filled
// through textContent, so a `<script>` inside a skill is displayed as the eight
// characters it is. There is deliberately no innerHTML path, no link that can
// be followed and no image that can be fetched: a skill is something to read
// before trusting, and reading it must not do anything.
//
// It must also not hang. The first version parsed with regular expressions,
// and several of them backtracked catastrophically: a line of `[a](` repeated,
// a run of backticks, or a heading followed by thousands of spaces took minutes
// to hours at the 64 KB file limit, on the renderer's main thread, and a skill
// on the enterprise shelf would have frozen every employee who clicked it. So
// every scan here is written by hand, every inline mark has a bounded reach,
// and quote nesting has a depth limit. Nothing is quadratic in the input.
//
// The subset is what skill authors actually write: headings, paragraphs, lists,
// fenced code, block quotes, rules, pipe tables and a few inline marks.

// How far an inline mark may reach for its closing half. Longer than any real
// code span, bold run or link, and it is what keeps the scan linear.
const REACH = 400;
// Quotes nested deeper than this are shown as text rather than recursed into.
const MAX_QUOTE_DEPTH = 6;
// Bold, emphasis and link text are re-read for their own marks this many
// levels deep at most.
const MAX_INLINE_DEPTH = 3;
// A single line longer than this is shown as plain text: no real Markdown line
// is that long, and not classifying it bounds every per-line check.
const MAX_LINE = 4000;

const isSpace = character => character === " " || character === "\t";
const leading = line => { let index = 0; while (index < line.length && isSpace(line[index])) index++; return index; };

// Where `needle` next occurs starting in [from, limit), or -1. Bounded by
// `limit` rather than by the end of the string -- an unbounded indexOf per
// candidate is exactly the quadratic scan this file exists to avoid -- and it
// allocates nothing, because it runs once per candidate mark.
function within(text, needle, from, limit) {
  const last = Math.min(limit, text.length - needle.length);
  outer: for (let at = from; at <= last; at++) {
    for (let offset = 0; offset < needle.length; offset++) if (text[at + offset] !== needle[offset]) continue outer;
    return at;
  }
  return -1;
}
// Longer backtick runs than this are shown as they are rather than matched.
const MAX_TICKS = 8;

// The YAML header is metadata the dialog already shows (name, description), so
// it is lifted off the document. It is not hidden: documentNodes shows it as a
// key/value block, because the header's description is what a model reads when
// deciding to use the skill and may differ from the catalogue's.
export function skillFrontmatter(text) {
  const source = String(text ?? "");
  const lines = source.split("\n");
  if (lines[0]?.replace(/\r$/u, "") !== "---") return { meta: {}, body: source, header: [] };
  let end = -1;
  for (let index = 1; index < lines.length; index++) if (lines[index].replace(/\r$/u, "") === "---") { end = index; break; }
  if (end < 0) return { meta: {}, body: source, header: [] };
  const meta = {}, header = [];
  for (const raw of lines.slice(1, end)) {
    const line = raw.replace(/\r$/u, ""), colon = line.indexOf(":");
    header.push(line);
    if (colon < 1) continue;
    const key = line.slice(0, colon);
    if (!/^[A-Za-z_][\w-]*$/u.test(key)) continue;
    let value = line.slice(colon + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    meta[key] = value;
  }
  return { meta, body: lines.slice(end + 1).join("\n"), header };
}

const CJK = /[　-〿㐀-鿿＀-￯]/u;
// Soft line breaks inside a paragraph become a space in Markdown, which puts a
// visible gap in the middle of a Chinese sentence. Join CJK to CJK directly.
const joinLines = lines => lines.reduce((text, line) => !text ? line
  : CJK.test(text.at(-1)) && CJK.test(line[0]) ? text + line : `${text} ${line}`, "");

// Inline marks into nodes, in one left-to-right pass. Links keep their text and
// show where they point as a tooltip; they are never made clickable, because
// following a URL out of a skill someone has not yet decided to trust is exactly
// what preview is not. Images show their address as text and are never loaded.
export function inlineNodes(element, text, depth = 0) {
  const source = String(text ?? ""), nodes = [];
  let plain = 0, index = 0;
  const flush = end => { if (end > plain) nodes.push(source.slice(plain, end)); };
  const nested = (tag, inner, className) => {
    const node = element(tag, undefined, className);
    node.append(...(depth < MAX_INLINE_DEPTH ? inlineNodes(element, inner, depth + 1) : [inner]));
    return node;
  };
  const emit = (node, end) => { flush(index); nodes.push(node); index = end; plain = end; };

  while (index < source.length) {
    const character = source[index];

    if (character === "`") {
      let run = 1; while (source[index + run] === "`") run++;
      if (run > MAX_TICKS) { index += run; continue; }
      const fence = "`".repeat(run), from = index + run, limit = from + REACH;
      let close = -1, search = from;
      while (search < limit) {
        const at = within(source, fence, search, limit);
        if (at < 0) break;
        let length = run; while (source[at + length] === "`") length++;
        if (length === run) { close = at; break; }
        search = at + length;
      }
      if (close > from) { emit(element("code", source.slice(from, close).trim()), close + run); continue; }
      // The whole run is skipped, so it is never re-tried one tick at a time.
      index += run; continue;
    }

    if ((character === "*" || character === "_") && source[index + 1] === character) {
      const marker = character + character, close = within(source, marker, index + 2, index + 2 + REACH);
      if (close > index + 2) { emit(nested("strong", source.slice(index + 2, close)), close + 2); continue; }
      index += 2; continue;
    }

    if (character === "*" && source[index + 1] && !isSpace(source[index + 1])) {
      const close = within(source, "*", index + 1, index + 1 + REACH);
      if (close > index + 1 && !isSpace(source[close - 1])) { emit(nested("em", source.slice(index + 1, close)), close + 1); continue; }
      index++; continue;
    }

    if (character === "[" || (character === "!" && source[index + 1] === "[")) {
      const image = character === "!", open = image ? index + 1 : index;
      const label = within(source, "]", open + 1, open + 1 + REACH);
      if (label > open && source[label + 1] === "(") {
        const end = within(source, ")", label + 2, label + 2 + REACH);
        if (end > label) {
          const inner = source.slice(open + 1, label), href = source.slice(label + 2, end).trim().split(/\s/u)[0];
          if (image) { emit(element("span", `［图片：${inner || "未命名"}${href ? ` · ${href}` : ""}］`, "md-image"), end + 1); continue; }
          if (inner) { const node = nested("span", inner, "md-link"); if (href) node.title = href; emit(node, end + 1); continue; }
        }
      }
      index += image ? 2 : 1; continue;
    }

    if (character === "<" && (source.startsWith("http://", index + 1) || source.startsWith("https://", index + 1))) {
      const end = within(source, ">", index + 1, index + 1 + REACH), address = end > 0 ? source.slice(index + 1, end) : "";
      if (address && !/\s/u.test(address)) { emit(element("span", address, "md-link"), end + 1); continue; }
      index++; continue;
    }

    index++;
  }
  flush(source.length);
  return nodes;
}

function fill(element, tag, text, className) {
  const node = element(tag, undefined, className);
  node.append(...inlineNodes(element, text));
  return node;
}

// Line classifiers. Each looks at a line once, from the left, and never tries
// alternative splits of the same whitespace.
function headingOf(line) {
  let index = leading(line);
  if (index > 3) return null;
  let level = 0; while (line[index + level] === "#" && level < 7) level++;
  if (level < 1 || level > 6) return null;
  const after = index + level;
  if (after < line.length && !isSpace(line[after])) return null;
  let text = line.slice(after).trim();
  // An optional closing run of #, separated by a space: "## Title ##".
  let end = text.length; while (end > 0 && text[end - 1] === "#") end--;
  if (end < text.length && (end === 0 || isSpace(text[end - 1]))) text = text.slice(0, end).trim();
  return { level, text };
}
function isRule(line) {
  const text = line.trim(), marker = text[0];
  if (marker !== "-" && marker !== "*" && marker !== "_") return false;
  let count = 0;
  for (const character of text) { if (character === marker) count++; else if (!isSpace(character)) return false; }
  return count >= 3;
}
function fenceOf(line) {
  const index = leading(line);
  if (index > 3) return null;
  const marker = line[index];
  if (marker !== "`" && marker !== "~") return null;
  let run = 0; while (line[index + run] === marker) run++;
  if (run < 3) return null;
  const info = line.slice(index + run).trim();
  return { close: marker.repeat(run), language: /^[\w+-]{1,32}$/u.test(info) ? info : "" };
}
const isQuote = line => leading(line) <= 3 && line[leading(line)] === ">";
function unquote(line) { const index = leading(line) + 1; return isSpace(line[index]) ? line.slice(index + 1) : line.slice(index); }
function listItemOf(line) {
  const text = line.slice(leading(line));
  if ((text[0] === "-" || text[0] === "*" || text[0] === "+") && isSpace(text[1])) return { ordered: false, content: text.slice(2).trim() };
  let digits = 0; while (digits < 10 && text[digits] >= "0" && text[digits] <= "9") digits++;
  if (digits >= 1 && digits <= 9 && (text[digits] === "." || text[digits] === ")") && isSpace(text[digits + 1])) {
    return { ordered: true, start: Number(text.slice(0, digits)), content: text.slice(digits + 2).trim() };
  }
  return null;
}
function cellsOf(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map(cell => cell.trim());
}
function isTableSeparator(line) {
  if (!line || line.length > MAX_LINE || !line.includes("-")) return false;
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every(cell => /^:?-{2,}:?$/u.test(cell));
}
const isIndented = line => leading(line) >= 2;

// Block structure. Headings are shifted down so the document never outranks
// the dialog's own title, which is the <h2>.
export function markdownBlocks(element, text, depth = 0) {
  const lines = String(text ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const blocks = [];
  let index = 0;
  const plainLine = line => line.length > MAX_LINE;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (plainLine(line)) { blocks.push(element("p", line, "md-long")); index++; continue; }

    const fence = fenceOf(line);
    if (fence) {
      const body = [];
      index++;
      while (index < lines.length && !lines[index].trimStart().startsWith(fence.close)) body.push(lines[index++]);
      index++;
      const pre = element("pre", undefined, "md-code"), code = element("code", body.join("\n"));
      if (fence.language) code.dataset.language = fence.language;
      pre.append(code); blocks.push(pre); continue;
    }

    const heading = headingOf(line);
    if (heading) { blocks.push(fill(element, `h${Math.min(6, heading.level + 2)}`, heading.text, "md-heading")); index++; continue; }

    if (isRule(line)) { blocks.push(element("hr")); index++; continue; }

    if (isQuote(line)) {
      const quoted = [];
      while (index < lines.length && isQuote(lines[index]) && !plainLine(lines[index])) quoted.push(unquote(lines[index++]));
      const quote = element("blockquote", undefined, "md-quote");
      // Nesting is followed a few levels; past that the rest is shown as text,
      // so a line of thousands of `>` cannot exhaust the stack.
      if (depth < MAX_QUOTE_DEPTH) quote.append(...markdownBlocks(element, quoted.join("\n"), depth + 1));
      else quote.append(element("p", quoted.join("\n")));
      blocks.push(quote); continue;
    }

    // A pipe table needs a header row and a separator row directly under it.
    if (line.includes("|") && isTableSeparator(lines[index + 1])) {
      const table = element("table", undefined, "md-table"), head = element("thead"), headRow = element("tr");
      headRow.append(...cellsOf(line).map(cell => fill(element, "th", cell)));
      head.append(headRow); table.append(head);
      const body = element("tbody");
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() && !plainLine(lines[index])) {
        const row = element("tr");
        row.append(...cellsOf(lines[index++]).map(cell => fill(element, "td", cell)));
        body.append(row);
      }
      table.append(body);
      const scroller = element("div", undefined, "md-table-wrap");
      scroller.append(table); blocks.push(scroller); continue;
    }

    const first = listItemOf(line);
    if (first) {
      const list = element(first.ordered ? "ol" : "ul", undefined, "md-list");
      if (first.ordered && first.start !== 1) list.start = first.start;
      while (index < lines.length && !plainLine(lines[index])) {
        const item = listItemOf(lines[index]);
        if (!item || item.ordered !== first.ordered) break;
        const parts = [item.content];
        index++;
        // Continuation lines are indented under their bullet; a blank line or a
        // new bullet ends the item.
        while (index < lines.length && lines[index].trim() && !plainLine(lines[index]) && !listItemOf(lines[index]) && isIndented(lines[index])) parts.push(lines[index++].trim());
        list.append(fill(element, "li", joinLines(parts)));
      }
      blocks.push(list); continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !plainLine(lines[index]) && !listItemOf(lines[index]) && !isRule(lines[index])
      && !headingOf(lines[index]) && !isQuote(lines[index]) && !fenceOf(lines[index])) paragraph.push(lines[index++].trim());
    // Every branch above consumes at least one line; this makes sure a line no
    // rule claims can never stall the loop on untrusted input.
    if (!paragraph.length) paragraph.push(lines[index++].trim());
    blocks.push(fill(element, "p", joinLines(paragraph)));
  }
  return blocks;
}
