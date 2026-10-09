// Small pieces every page is built from. Everything here makes elements and
// sets text: nothing is ever parsed as HTML, so a name somebody chose in
// Feishu stays a name.
const SVG = "http://www.w3.org/2000/svg";

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "style") for (const [name, setting] of Object.entries(value)) node.style.setProperty(name, setting);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}
export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  for (const child of children.flat()) if (child) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
export const clear = (node) => { while (node.firstChild) node.firstChild.remove(); return node; };

// Line icons, drawn here so the page loads nothing from anywhere else.
const ICONS = {
  overview: ["M4 4h7v7H4z", "M13 4h7v4h-7z", "M13 10h7v10h-7z", "M4 13h7v7H4z"],
  people: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1", "M16 3.5a4 4 0 0 1 0 7.5", "M22 21v-1a6 6 0 0 0-4-5.6"],
  shield: ["M12 3l8 3v6c0 4.5-3.3 8.3-8 9-4.7-.7-8-4.5-8-9V6z", "M9 12l2 2 4-4"],
  chart: ["M4 20V4", "M4 20h16", "M8 16v-4", "M12 16V8", "M16 16v-6"],
  list: ["M8 6h12", "M8 12h12", "M8 18h12", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
  globe: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M3 12h18", "M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"],
  pulse: ["M3 12h4l3-8 4 16 3-8h4"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-3.5-3.5"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  out: ["M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3", "M10 17l5-5-5-5", "M15 12H4"],
  tree: ["M5 4h5v5H5z", "M14 15h5v5h-5z", "M14 4h5v5h-5z", "M7.5 9v8.5H14", "M10 6.5h4"],
  scan: ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 13l2 2 4-4"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  puzzle: ["M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z"],
  sliders: ["M4 6h10", "M18 6h2", "M4 12h4", "M12 12h8", "M4 18h12", "M20 18h0", "M14 4v4", "M8 10v4", "M16 16v4"],
};
export function icon(name, className = "") {
  return svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", class: className, "aria-hidden": "true" },
    (ICONS[name] ?? []).map((d) => svg("path", { d })));
}

// ---------------------------------------------------------------- formats
const NUMBER = new Intl.NumberFormat("zh-CN");
export const fmt = (value) => Number.isFinite(value) ? NUMBER.format(value) : "—";
// Tokens the way people here count large numbers: 万 and 亿.
export function tokens(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e9 ? 1 : 2)} 亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e5 ? 0 : 1)} 万`;
  return NUMBER.format(value);
}
const pad = (n) => String(n).padStart(2, "0");
export function dateTime(at) {
  if (!at) return "—";
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// How long ago -- or, for a time still to come (a task's next run), how long
// until: "17 小时后", never "刚刚" for tomorrow morning.
export function ago(at, now = Date.now()) {
  if (!at) return "从未";
  const seconds = Math.round(Math.abs(now - at) / 1000), side = at > now ? "后" : "前";
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟${side}`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时${side}`;
  if (seconds < 86_400 * 30) return `${Math.floor(seconds / 86_400)} 天${side}`;
  return dateTime(at).slice(0, 10);
}
export const shortDay = (day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

// ---------------------------------------------------------------- people
const HUES = [172, 200, 214, 262, 330, 12, 32, 88, 150];
export function avatar(name, id, large = false) {
  const text = (String(name || "").trim() || "?").slice(-2);
  let hash = 0;
  for (const char of String(id || name || "")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return h("span", { class: `avatar${large ? " large" : ""}`, style: { background: `hsl(${HUES[hash % HUES.length]} 45% 42%)` }, "aria-hidden": "true", text });
}
export function personCell(person, { link = true } = {}) {
  const name = person.name || "（未登录过）";
  const body = h("span", { class: "person" }, avatar(person.name, person.userId),
    h("span", { class: "names" }, h("b", { text: name }), h("span", { text: person.userId })));
  return link ? h("a", { href: `#/people/${encodeURIComponent(person.userId)}`, class: "plain-link", onclick: (event) => event.stopPropagation() }, body) : body;
}
export const pill = (text, kind = "", plain = false) => h("span", { class: `pill ${kind}${plain ? " plain" : ""}`, text });
export function statusPill(access) {
  if (access?.disabled) return pill("已停用", "bad");
  return pill("正常", "ok");
}
export function copyButton(text) {
  return h("button", { class: "copy", type: "button", title: "复制", "aria-label": "复制", onclick: async (event) => {
    event.stopPropagation();
    try { await navigator.clipboard.writeText(text); toast("已复制"); } catch { toast("复制失败，请手动选中", "bad"); }
  } }, "复制");
}

// ---------------------------------------------------------------- feedback
export function toast(message, kind = "") {
  const host = document.getElementById("toasts");
  const node = h("div", { class: `toast ${kind}`, text: message });
  host.append(node);
  setTimeout(() => node.remove(), kind === "bad" ? 6000 : 3200);
}
export const loading = (text = "正在加载…") => h("div", { class: "loading-page" }, h("span", { class: "spinner" }), text);
export const empty = (title, text = "") => h("div", { class: "empty-state" }, h("b", { text: title }), text ? h("span", { text }) : null);
export const errorBanner = (error) => h("div", { class: "error-banner", role: "alert" }, h("b", { text: "没有成功：" }), h("span", { text: error?.message ?? String(error) }));

// A question before anything is changed. `reason`: ask why, optionally
// required. `typed`: the exact text to type back, for what cannot be undone.
// `cancel: false`: nothing to decide, only something to read and close.
export function confirm({ title, message, confirmText = "确定", danger = false, reason = null, typed = null, extra = null, wide = false, cancel = true }) {
  return new Promise((resolve) => {
    const area = reason ? h("textarea", { class: "input", maxlength: 200, placeholder: reason.placeholder ?? "", rows: 3 }) : null;
    const typedInput = typed ? h("input", { class: "input", autocomplete: "off", spellcheck: "false", placeholder: typed }) : null;
    const error = h("div", { class: "modal-error" });
    const ok = h("button", { class: `button ${danger ? "danger solid" : "primary"}`, type: "submit", text: confirmText });
    const form = h("form", { method: "dialog" },
      h("div", { class: "modal-body" }, h("h2", { text: title }), message ? h("p", { text: message }) : null, extra,
        reason ? h("div", { class: "field" }, h("label", { text: reason.label ?? "原因" }), area, reason.help ? h("span", { class: "help", text: reason.help }) : null) : null,
        typed ? h("div", { class: "field" }, h("label", { text: `请输入「${typed}」确认` }), typedInput) : null, error),
      h("div", { class: "modal-foot" }, cancel ? h("button", { class: "button", type: "button", value: "cancel", text: "取消", onclick: () => close(null) }) : null, ok));
    const dialog = h("dialog", { class: `modal${wide ? " wide" : ""}` }, form);
    const close = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (reason?.required && !area.value.trim()) { error.textContent = `请填写${reason.label ?? "原因"}`; area.focus(); return; }
      if (typed && typedInput.value.trim() !== typed) { error.textContent = "输入的内容不一致"; typedInput.focus(); return; }
      close({ reason: area?.value.trim() ?? "" });
    });
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(null); });
    document.body.append(dialog);
    dialog.showModal();
    (typedInput ?? area ?? ok).focus();
  });
}

// ---------------------------------------------------------------- layout
export function pageHead(title, subtitle = "", actions = []) {
  return h("div", { class: "page-head" }, h("div", {}, h("h1", { text: title }), subtitle ? h("p", { text: subtitle }) : null),
    actions.length ? h("div", { class: "page-actions" }, actions) : null);
}
export function section(title, hint, ...children) {
  return h("section", { class: "section" }, h("div", { class: "section-head" }, h("h2", { text: title }), hint ? h("span", { class: "hint", text: hint }) : null), children);
}
export const panel = (...children) => h("div", { class: "panel" }, children);
export function segmented(options, value, onChange, label) {
  const group = h("div", { class: "segmented", role: "group", "aria-label": label ?? "" });
  for (const [key, text] of options) {
    group.append(h("button", { type: "button", "aria-pressed": key === value ? "true" : "false", text, onclick: () => onChange(key) }));
  }
  return group;
}
export function select(options, value, onChange, label) {
  const node = h("select", { class: "select", "aria-label": label ?? "", onchange: () => onChange(node.value) });
  for (const [key, text] of options) node.append(h("option", { value: key, text, selected: key === value }));
  return node;
}
export function searchInput(value, onChange, placeholder) {
  let timer = null;
  const node = h("input", { class: "input search-input", type: "search", value, placeholder, "aria-label": placeholder,
    oninput: () => { clearTimeout(timer); timer = setTimeout(() => onChange(node.value.trim()), 300); } });
  return node;
}
export function stat({ label, value, unit = "", sub = [], spark = null }) {
  return panel(h("div", { class: "stat" }, h("div", { class: "label", text: label }),
    h("div", { class: "value" }, value, unit ? h("small", { text: unit }) : null),
    sub.filter(Boolean).length ? h("div", { class: "sub" }, sub.filter(Boolean).map((item) => item instanceof Node ? item : h("span", { text: item }))) : null, spark));
}
export function kv(entries) {
  return h("dl", { class: "kv" }, entries.filter(Boolean).flatMap(([key, value]) => [h("dt", { text: key }), h("dd", {}, value ?? "—")]));
}

// A table. `columns`: [{ label, cell(row) -> node|text, num, width }].
export function table({ columns, rows, onRow = null, selectable = null, emptyText = "没有数据" }) {
  const head = h("tr", {}, selectable ? h("th", { class: "check" }, selectable.all) : null,
    columns.map((column) => h("th", { class: column.num ? "num" : "", style: column.width ? { width: column.width } : null, text: column.label })));
  const body = h("tbody");
  if (!rows.length) body.append(h("tr", {}, h("td", { colspan: columns.length + (selectable ? 1 : 0) }, empty(emptyText))));
  for (const row of rows) {
    const tr = h("tr", { class: onRow ? "clickable" : "", onclick: onRow ? (event) => { if (!event.target.closest("a,button,input,label")) onRow(row); } : null });
    append(tr, [selectable ? h("td", { class: "check" }, selectable.box(row, tr)) : null,
      columns.map((column) => {
        const value = column.cell(row);
        return h("td", { class: column.num ? "num" : column.className ?? "" }, value instanceof Node ? value : String(value ?? "—"));
      })]);
    body.append(tr);
  }
  return h("div", { class: "table-wrap" }, h("table", { class: "data" }, h("thead", {}, head), body));
}

// Pages forward and back by position: the server only ever gives "next";
// the way back is the positions already passed.
export function pager({ stack, next, onMove, total = null, shown }) {
  const page = stack.length + 1;
  return h("div", { class: "table-foot" },
    h("span", { text: total === null || total === undefined ? `第 ${page} 页` : `共 ${fmt(total)} 条 · 第 ${page} 页${shown ? `，本页 ${shown} 条` : ""}` }),
    h("div", { class: "pager" },
      h("button", { class: "button small", type: "button", text: "上一页", disabled: stack.length === 0, onclick: () => onMove(-1) }),
      h("button", { class: "button small", type: "button", text: "下一页", disabled: !next, onclick: () => onMove(1) })));
}

// ---------------------------------------------------------------- charts
// Bars by day. One scale places bars and the labels both, drawn at the width
// the chart actually has -- so a label is 11px on a phone and on a wide screen,
// rather than scaled with the picture -- and drawn again when that changes.
export function bars(series, options = {}) {
  const box = h("div", { class: "chart", style: { height: `${options.height ?? 200}px` } });
  let drawn = 0;
  const draw = () => {
    const width = Math.round(box.clientWidth);
    if (!width || Math.abs(width - drawn) < 2) return;
    drawn = width;
    clear(box).append(barsAt(series, { ...options, width }));
  };
  if (typeof ResizeObserver === "function") new ResizeObserver(draw).observe(box);
  requestAnimationFrame(draw);
  return box;
}
function barsAt(series, { value = (point) => point.value, label = (point) => point.label, format = fmt, height = 200, width, highlightLast = true } = {}) {
  const top = 10, bottom = 24, left = 56, right = 8;
  const values = series.map(value);
  const max = Math.max(1, ...values);
  const step = niceStep(max / 4);
  const ceiling = Math.max(step, Math.ceil(max / step) * step);
  const inner = width - left - right, slot = inner / Math.max(1, series.length), barWidth = Math.max(2, Math.min(28, slot * 0.62));
  const y = (v) => top + (height - top - bottom) * (1 - v / ceiling);
  const nodes = [];
  for (let tick = 0; tick <= ceiling + 1e-9; tick += step) {
    nodes.push(svg("line", { class: "grid-line", x1: left, x2: width - right, y1: y(tick), y2: y(tick) }));
    nodes.push(svg("text", { x: left - 8, y: y(tick) + 4, "text-anchor": "end" }, format(tick)));
  }
  // As many day labels as fit, always the last.
  const every = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(inner / 46))));
  series.forEach((point, index) => {
    const x = left + slot * index + (slot - barWidth) / 2, v = value(point);
    const bar = svg("rect", { class: `bar${highlightLast && index === series.length - 1 ? " today" : ""}`, x, y: y(v), width: barWidth, height: Math.max(0, y(0) - y(v)), rx: 2 });
    bar.append(svg("title", {}, `${label(point)}：${format(v)}`));
    nodes.push(bar);
    const last = index === series.length - 1;
    if ((index % every === 0 && series.length - 1 - index >= every / 2) || last) nodes.push(svg("text", { x: x + barWidth / 2, y: height - 7, "text-anchor": "middle" }, label(point)));
  });
  return svg("svg", { class: "bars", width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "按天的柱状图" }, nodes);
}
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const fraction = raw / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}
export function sparkline(values, { width = 160, height = 34 } = {}) {
  if (!values.length) return null;
  const max = Math.max(1, ...values), stepX = width / Math.max(1, values.length - 1);
  const points = values.map((v, index) => [index * stepX, height - 3 - (height - 6) * (v / max)]);
  const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points.at(-1);
  return svg("svg", { class: "spark", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", "aria-hidden": "true" },
    svg("path", { class: "area", d: `${line} L${width},${height} L0,${height} Z` }), svg("path", { class: "line", d: line }),
    svg("circle", { cx: lastX, cy: lastY, r: 2.6 }));
}
