import { markdownBlocks, skillFrontmatter } from "./skill-markdown.js";

// 技能中心: one place to find a skill, and one way to look at any of them.
//
// Laid out after the two products the people using this already work in, 豆包工作
// and WorkBuddy, which arrived independently at the same skeleton:
//
//   - one toolbar: 技能 / 连接器 tabs, search, 我的技能, + 添加
//   - browsing is a uniform grid: an icon, a name, one or two lines on what it
//     does, and at most ONE control on the item itself -- a switch, or + to
//     install. Everything else is one click away, not on the card.
//   - clicking an item opens a single detail dialog: the skill rendered as a
//     document, its switch in the header, and one primary action, which is to
//     try it in a conversation
//   - managing what you added is its own page, grouped by where it came from
//
// What this replaced was one 2,700px page that stacked five sections -- an
// import form, a market form, an MCP form, the enterprise shelf and the
// built-ins -- each under its own paragraph of explanation, with up to seven
// buttons on a single card. The safety properties did not move: everything that
// grants a skill or plugin influence is confirmed by the main process, not
// here, and a skill's text is only ever displayed, never parsed as HTML
// (skill-markdown.js).
//
// The page is re-drawn from `data` on every change, which keeps it simple, so
// three things a re-draw would otherwise destroy are held outside the DOM: what
// has keyboard focus (data-focus keys), what has been typed into a form
// (drafts), and which slow operations are still running (busy).

const KINDS = {
  enterprise: { tag: "企业", hook: "enterprise-skill-card", hue: 262 },
  feishu: { tag: "飞书内置", hook: "skill-card", hue: 214 },
  local: { tag: "我导入的", hook: "local-skill-card" },
  plugin: { tag: "市场插件", hook: "plugin-item" },
};
const CHIPS = [["all", "全部"], ["enterprise", "企业"], ["feishu", "飞书内置"], ["local", "我导入的"], ["plugin", "市场插件"]];
const MODE_NAMES = { cowork: "工作任务", coding: "编程任务" };
const SOURCE_NAMES = { feishu: "内置飞书技能", local: "本机技能", plugins: "市场插件", markets: "技能市场", servers: "连接器", connections: "已添加的连接", offered: "企业连接器" };
// How a connection reaches its tools, said the way the people using it would.
const TRANSPORTS = { enterprise: "企业代理", stdio: "本机程序", http: "远程服务" };
// A file this large is shown as plain text rather than parsed.
const MAX_RENDERED = 200_000;

function hueOf(text) { let hash = 0; for (const character of String(text)) hash = (hash * 31 + character.codePointAt(0)) >>> 0; return hash % 360; }
// Built-in titles all start with 飞书, so the initial is taken after it --
// otherwise twenty-six icons would read 飞.
function initialOf(title) {
  const trimmed = String(title || "?").replace(/^(飞书|Lark)\s*[/／·\-]?\s*/iu, "").trim() || String(title || "?");
  return trimmed.match(/[一-鿿]/u)?.[0] ?? trimmed.charAt(0).toUpperCase();
}
// "飞书审批：查询和处理审批…" -> 审批, with the rest as its description. The
// 飞书 prefix is dropped from the name on the card because every one of these
// carries it and the 飞书内置 tag already says so -- the way 豆包工作 names its
// own as 文档, 表格, 会议. The full title stays in the detail dialog.
//
// A few upstream descriptions carry no Chinese name, or are written in English
// ("Use when user mentions 起草邮件…"), and the card showed the raw id or that
// English (UI rules, 2026-09-25). Those get a name and a line here -- labels
// only; what the skill says to the Agent is still read from the CLI.
// test/skill-center.test.js checks every skill the bundled CLI carries, so a
// new one without a Chinese name fails there, not on someone's screen.
const BUILTIN_NAMES = {
  "lark-event": ["事件订阅", "实时监听和订阅飞书里的事件，例如新消息、审批和日程的变化。"],
  "lark-mail": [null, "起草、发送、回复和查阅飞书邮件，整理邮件文件夹和标签。"],
  "lark-shared": ["飞书技能共用规则", "所有飞书技能共用的登录、身份和权限规则。"],
  "lark-skill-maker": ["技能制作", null],
};
export function splitBuiltin(skill) {
  const name = typeof skill === "string" ? skill : skill.name, text = typeof skill === "string" ? "" : skill.description || "";
  const colon = text.search(/[：:]/u), head = colon >= 2 && colon <= 24 ? text.slice(0, colon) : "";
  const full = head && !head.includes("\n") ? head : name;
  const short = full.replace(/^飞书\s*(?:[/／]\s*Lark\s*)?/u, "").replace(/^[/／]\s*Lark\s*/u, "").trim() || full;
  const [title, line] = BUILTIN_NAMES[name] ?? [];
  return { name, title: title ?? short, fullTitle: title ?? full, description: (line ?? ((full === head ? text.slice(colon + 1) : text) || "内置飞书工作技能")).trim() };
}
// Some built-in skills only hand their requests to another one ("…统一交由
// lark-meeting 技能处理"); four cards saying "use 视频会议 instead" are not four
// skills. The Agent still has them; the shelf shows the one they point to.
export function builtinAlias(skill) {
  return /统一交由\s*(lark-[\w-]+)\s*技能处理/u.exec(typeof skill === "string" ? "" : skill?.description ?? "")?.[1] ?? null;
}
const escapeKey = key => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : String(key).replace(/["\\]/gu, "\\$&"));

export function skillCenterUi({ api, root, element, action, readableError, isCurrent, detail, startTask, openCreatedTask, placeConfirmations = () => {} }) {
  let disposed = false;
  const alive = () => !disposed && isCurrent();
  const view = { tab: "skills", page: "browse", chip: "all", query: "", notice: "" };
  const data = {
    loaded: false, failures: {},
    enterprise: [], enterpriseState: "loading", enterpriseNote: "正在核验租户、签名与版本…", administrator: false,
    feishu: [], local: [], plugins: [], markets: [], servers: [],
    // Connections a task is started with (see connectionRow), and what the
    // administrator has opened to this account; offeredReady says that list was
    // actually read, so a connection missing from it can be called withdrawn.
    connections: [], offered: [], offeredReady: false,
  };
  // Held outside the DOM so a re-draw does not lose them.
  const drafts = { market: "", mcpName: "", mcpKind: "command", mcpTarget: "" };
  // The last check of each connection, by id and digest, so it survives re-draws
  // and is dropped the moment the connection itself changes.
  const probes = new Map();
  const busy = new Set();
  // Task kinds chosen for a local skill that is switched off; they are only
  // sent to the main process when it is switched on.
  const pendingModes = new Map();
  const modesOf = skill => pendingModes.get(skill.id) ?? skill.modes ?? ["cowork"];
  const cleanups = [];
  const listen = (target, type, handler) => { target.addEventListener(type, handler); cleanups.push(() => target.removeEventListener(type, handler)); };
  // Which open menu's list is whose while it is drawn outside its row (menu()).
  // Declared before the toolbar's own menu is built, which is the first use.
  const liftedLists = new WeakMap();

  // Re-draw `scope` and put keyboard focus back on the control that had it.
  // Without this every toggle, chip and background load dropped focus to
  // <body>, and a screen reader never heard the switch's new state.
  function keepingFocus(scope, rebuild) {
    const active = document.activeElement, key = active && scope.contains(active) ? active.dataset?.focus : null;
    // A row's menu that is open stays open: a listing landing late re-draws the
    // page, and 用于新任务 opened a second earlier used to vanish under the pointer.
    const open = [...scope.querySelectorAll("details.sc-menu[open][data-menu]")].map(node => node.dataset.menu);
    rebuild();
    for (const menuKey of open) { const node = scope.querySelector(`details.sc-menu[data-menu="${escapeKey(menuKey)}"]`); if (node) node.open = true; }
    if (key) scope.querySelector(`[data-focus="${escapeKey(key)}"]`)?.focus({ preventScroll: true });
  }
  function focusable(node, key) { node.dataset.focus = key; return node; }

  // A slow operation runs once at a time per key, and its controls stay
  // disabled across re-draws until it finishes.
  async function guarded(key, run) {
    if (busy.has(key)) return undefined;
    busy.add(key); repaint();
    try { return await run(); } finally { busy.delete(key); if (alive()) repaint(); }
  }
  function repaint() { if (!alive()) return; paint(); refreshDetail(); }

  // ---------- toolbar ----------
  const head = element("header", undefined, "sc-head");
  const title = element("h1", "技能中心", "sc-title");
  const tabs = element("div", undefined, "sc-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "技能中心");
  const search = element("input", undefined, "sc-search"); search.type = "search"; search.id = "skill-search"; search.setAttribute("aria-label", "搜索");
  const tabButton = (value, label) => {
    const node = focusable(element("button", label, "sc-tab"), `tab:${value}`); node.type = "button"; node.dataset.tab = value; node.setAttribute("role", "tab");
    node.onclick = () => { view.tab = value; view.page = "browse"; view.notice = ""; search.value = ""; view.query = ""; paint(); };
    tabs.append(node); return node;
  };
  tabButton("skills", "技能"); tabButton("connectors", "连接器");
  const tools = element("div", undefined, "sc-tools");
  search.oninput = () => { view.query = search.value.trim().toLowerCase(); paintPage(); };
  const mine = element("button", undefined, "sc-mine"); mine.type = "button"; mine.id = "open-my-skills";
  mine.onclick = () => { view.tab = "skills"; view.page = view.page === "mine" ? "browse" : "mine"; view.notice = ""; paint(); };
  const add = menu("+ 添加", "sc-add", [
    ["导入技能文件夹", "import-local-skill", () => guarded("import", importLocal)],
    ["添加技能市场", "open-add-market", () => { view.tab = "skills"; view.page = "mine"; paint(); focusLater("#marketplace-source"); }],
    ["添加连接器", "open-add-connector", () => { view.tab = "connectors"; view.page = "browse"; paint(); focusLater("#mcp-name"); }],
  ], action);
  tools.append(search, mine, add);
  head.append(title, tabs, tools);
  const page = element("div", undefined, "sc-page");
  root.append(head, page);

  function focusLater(selector) { queueMicrotask(() => root.querySelector?.(selector)?.focus?.()); }

  // A small drop-down on <details>. It closes on a click outside, on Escape,
  // and when focus leaves it -- otherwise it stayed open over whatever the
  // next Tab landed on.
  // `key` names a menu that lives in the re-drawn page, so a re-draw can keep it
  // open and keep focus on it (keepingFocus).
  //
  // Open, the list is drawn on <body> (on the dialog, inside the detail dialog,
  // which makes everything outside it inert) and placed under its button. Left
  // inside <details> it hung outside that element's box, and the Accessibility
  // API -- which looks for a control only inside boxes that contain the point --
  // could not press 用于新任务's items (found by the UI rules, 2026-09-25; the
  // composer's menus had the same fault on 2026-09-24).
  function menu(label, className, items, run, key = null) {
    const wrap = element("details", undefined, `sc-menu ${className}`), summary = element("summary", label), list = element("div", undefined, "sc-menu-list");
    if (key) { wrap.dataset.menu = key; focusable(summary, `menu:${key}`); }
    list.setAttribute("role", "menu");
    liftedLists.set(wrap, list);
    for (const [text, id, handler, extraClass] of items) {
      const item = element("button", text, extraClass); item.type = "button"; item.setAttribute("role", "menuitem"); if (id) item.id = id;
      item.onclick = () => { wrap.open = false; run(handler); };
      list.append(item);
    }
    wrap.append(summary, list);
    const escape = event => {
      if (event.key !== "Escape" || !wrap.open) return;
      event.preventDefault(); event.stopPropagation(); wrap.open = false; summary.focus();
    };
    const leave = event => { if (wrap.open && !wrap.contains(event.relatedTarget) && !list.contains(event.relatedTarget)) wrap.open = false; };
    for (const node of [wrap, list]) { node.addEventListener("keydown", escape); node.addEventListener("focusout", leave); }
    wrap.addEventListener("toggle", () => { if (wrap.open) liftMenu(wrap, summary, list); else dropMenu(wrap, list); });
    return wrap;
  }
  function liftMenu(wrap, summary, list) {
    (wrap.closest("dialog") ?? document.body).append(list);
    list.classList.add("sc-menu-lifted");
    const box = summary.getBoundingClientRect(), width = list.offsetWidth, height = list.offsetHeight;
    // Under the button when it fits, over it when it does not; lined up with
    // its left edge, or its right edge near the window's; never off the window.
    const below = box.bottom + 6, above = box.top - 6 - height;
    const top = below + height <= innerHeight - 8 || above < 8 ? below : above;
    const left = box.left + width <= innerWidth - 8 ? box.left : box.right - width;
    list.style.left = `${Math.max(8, Math.min(left, innerWidth - 8 - width))}px`;
    list.style.top = `${Math.max(8, Math.min(top, innerHeight - 8 - height))}px`;
  }
  function dropMenu(wrap, list) {
    list.classList.remove("sc-menu-lifted"); list.style.left = ""; list.style.top = "";
    if (list.parentElement !== wrap) wrap.append(list);
  }
  // Document-wide, because the 更多 menu lives in the detail dialog, not here.
  listen(document, "click", event => {
    for (const open of document.querySelectorAll("details.sc-menu[open]")) if (!open.contains(event.target) && !liftedLists.get(open)?.contains(event.target)) open.open = false;
  });
  // A re-draw replaces a row with its menu open; the list drawn on <body> goes
  // with the row it belonged to, or it would stay on screen over the new one.
  const sweepLifted = new MutationObserver(() => {
    for (const list of document.querySelectorAll(".sc-menu-lifted")) if (![...document.querySelectorAll("details.sc-menu[open]")].some(open => liftedLists.get(open) === list)) list.remove();
  });
  sweepLifted.observe(document.body, { childList: true, subtree: true });
  cleanups.push(() => { sweepLifted.disconnect(); for (const list of document.querySelectorAll(".sc-menu-lifted")) list.remove(); });

  // ---------- data ----------
  async function loadEnterprise() {
    data.enterpriseState = "loading"; data.enterpriseNote = "正在核验租户、签名与版本…"; paintPage();
    // Who may change the shelf is the server's answer, not a client guess -- and
    // it is asked on its own. It used to be asked only after the listing
    // succeeded, so an administrator whose listing failed (an empty shelf did,
    // until the server stopped refusing those) was never offered 上架 at all.
    const shelf = api.skillShelf().catch(() => null);
    try {
      const result = await api.listEnterpriseSkills(); if (!alive()) return;
      data.enterprise = result.skills; data.enterpriseState = "ready";
      data.administrator = (await shelf)?.administrator === true; if (!alive()) return;
      data.enterpriseNote = `已核验目录版本 ${result.revision} · ${result.skills.length} 项技能${data.administrator ? " · 你可以上架和下架" : ""}`;
    } catch (cause) {
      if (!alive()) return;
      data.enterprise = []; data.enterpriseState = "error"; data.enterpriseNote = readableError(cause);
      data.administrator = (await shelf)?.administrator === true; if (!alive()) return;
    }
    paint();
  }
  // A listing that fails is said so, not shown as "nothing here": an empty
  // state that tells someone to import a skill does not help when the real
  // problem is that the list could not be read.
  const loader = (name, read, shape = rows => rows) => async () => {
    try { data[name] = shape(await read()); delete data.failures[name]; }
    catch (cause) { data.failures[name] = readableError(cause); }
  };
  const loaders = {
    feishu: loader("feishu", () => api.listSkills(), rows => rows.filter(row => !builtinAlias(row)).map(splitBuiltin)),
    local: loader("local", () => api.listLocalSkills()),
    plugins: loader("plugins", () => api.listPlugins()),
    markets: loader("markets", () => api.listMarketplaces()),
    servers: loader("servers", () => api.listMcpServers()),
    builtins: loader("builtins", () => api.listBuiltinConnectors?.() ?? []),
    connections: loader("connections", () => api.listMcp()),
    // Asked of the server, so not part of the first paint (see start).
    offered: async () => {
      try { data.offered = await api.listEnterpriseMcp(); data.offeredReady = true; delete data.failures.offered; }
      catch (cause) { data.offeredReady = false; data.failures.offered = readableError(cause); }
    },
  };
  async function reload(...names) { await Promise.all(names.map(name => loaders[name]())); if (alive()) repaint(); }

  // ---------- items ----------
  function items(kind) {
    if (kind === "enterprise") return data.enterprise.map(skill => ({ kind, key: `e:${skill.id}`, id: skill.id, title: skill.title, description: skill.description, raw: skill }));
    if (kind === "feishu") return data.feishu.map(skill => ({ kind, key: `f:${skill.name}`, id: skill.name, title: skill.title, fullTitle: skill.fullTitle, description: skill.description, raw: skill }));
    if (kind === "local") return data.local.map(skill => ({ kind, key: `l:${skill.id}`, id: skill.id, title: skill.title, description: skill.description, raw: skill }));
    return data.plugins.map(row => ({ kind: "plugin", key: `p:${row.id}`, id: row.id, title: row.name, description: row.description || "这个插件没有写说明。", raw: row }));
  }
  const matches = item => !view.query || [item.title, item.fullTitle, item.description, item.id].some(value => String(value ?? "").toLowerCase().includes(view.query));

  function avatar(item, extra = "") {
    const node = element("span", initialOf(item.title), `sc-avatar ${extra}`.trim());
    node.style.setProperty("--h", String(KINDS[item.kind]?.hue ?? hueOf(item.id)));
    node.setAttribute("aria-hidden", "true");
    return node;
  }
  function toggle(on, label, key, focusKey, change, run = action) {
    const node = focusable(element("button", undefined, "sc-switch"), focusKey); node.type = "button";
    node.setAttribute("role", "switch"); node.setAttribute("aria-checked", String(on)); node.setAttribute("aria-label", label);
    node.disabled = busy.has(key);
    node.onclick = event => { event.stopPropagation(); run(() => guarded(key, () => change(!on))); };
    return node;
  }
  // The one control an item may carry. Enterprise and built-in skills have
  // none: an enterprise skill is chosen per task, and a built-in is simply on.
  function control(item, where, run = action) {
    const focusKey = `${where}:${item.key}`;
    if (item.kind === "local") return toggle(item.raw.enabled, `${item.raw.enabled ? "停用" : "启用"}「${item.title}」`, `local:${item.id}`, focusKey, on => setLocal(item.raw, on), run);
    if (item.kind !== "plugin") return null;
    if (item.raw.unusable) return element("span", "用不了", "sc-state bad");
    if (item.raw.installed) return toggle(item.raw.enabled, `${item.raw.enabled ? "停用" : "启用"}「${item.title}」`, `plugin:${item.id}`, focusKey, on => setPlugin(item.raw, on), run);
    const plus = focusable(element("button", "+", "sc-plus"), focusKey); plus.type = "button"; plus.setAttribute("aria-label", `安装「${item.title}」`);
    plus.disabled = busy.has(`plugin:${item.id}`);
    plus.onclick = event => { event.stopPropagation(); run(() => guarded(`plugin:${item.id}`, () => installPlugin(item.raw))); };
    return plus;
  }
  function card(item, extra = "") {
    const node = focusable(element("article", undefined, `sc-item ${KINDS[item.kind].hook} ${extra}`.trim()), `card:${item.key}`);
    node.tabIndex = 0; node.dataset.kind = item.kind; node.setAttribute("aria-label", `${item.title}，${KINDS[item.kind].tag}，按回车查看详情`);
    const main = element("div", undefined, "sc-main"), name = element("div", undefined, "sc-name");
    const heading = element("h3", item.title); heading.title = item.fullTitle ?? item.title; name.append(heading);
    // The tag says where an item came from. Once a chip has already narrowed
    // the grid to one source, twenty-six identical tags are only noise.
    if (view.chip === "all" || view.page === "mine" || extra.includes("featured")) name.append(element("span", KINDS[item.kind].tag, `sc-tag ${item.kind}`));
    main.append(name, element("p", item.description, "sc-desc"));
    if (item.kind === "enterprise" && extra.includes("featured")) main.append(element("small", `${item.raw.publisher} · ${item.raw.version}`, "sc-by"));
    if (item.kind === "local" && view.page === "mine") main.append(element("small", `用于 ${modesOf(item.raw).map(mode => MODE_NAMES[mode]).join("、")}`, "sc-by"));
    node.append(avatar(item), main);
    const ctl = control(item, "card"); if (ctl) { const box = element("div", undefined, "sc-ctl"); box.append(ctl); node.append(box); }
    node.onclick = () => action(() => openDetail(item));
    // Only when the card itself has focus: Enter on the switch or + inside it
    // must operate that control, not be taken over to open the dialog.
    node.onkeydown = event => { if (event.target !== node || (event.key !== "Enter" && event.key !== " ")) return; event.preventDefault(); action(() => openDetail(item)); };
    return node;
  }
  const empty = (text, ...buttons) => { const node = element("div", undefined, "sc-empty"); node.append(element("p", text, "empty-note"), ...buttons); return node; };
  // A button whose work is guarded by `key`, run through `run` (action, or the
  // dialog's variant so its errors show where the person is looking).
  function button(label, className, key, work, run = action) {
    const node = focusable(element("button", label, className), `btn:${key}:${label}`); node.type = "button";
    node.disabled = busy.has(key);
    node.onclick = () => run(() => guarded(key, work));
    return node;
  }
  function failures(...names) {
    const lines = names.filter(name => data.failures[name]).map(name => `${SOURCE_NAMES[name]}没读出来：${data.failures[name]}`);
    if (!lines.length) return [];
    const node = element("div", undefined, "sc-warn"); node.setAttribute("role", "status");
    node.append(...lines.map(line => element("p", line)), button("重试", "sc-secondary", "reload", () => reload(...names)));
    return [node];
  }

  // ---------- pages ----------
  function paint() {
    if (!alive()) return;
    for (const node of tabs.children) { const on = node.dataset.tab === view.tab; node.setAttribute("aria-selected", String(on)); node.classList.toggle("on", on); }
    search.placeholder = view.tab === "connectors" ? "搜索连接器" : "搜索技能";
    const owned = data.local.length + data.plugins.filter(row => row.installed).length;
    mine.replaceChildren(element("span", view.page === "mine" && view.tab === "skills" ? "‹ 全部技能" : "我的技能"), ...(view.page === "mine" ? [] : [element("span", String(owned), "sc-count")]));
    mine.hidden = view.tab !== "skills";
    paintPage();
  }
  function paintPage() {
    if (!alive()) return;
    keepingFocus(page, () => {
      const body = view.tab === "connectors" ? connectorsPage() : view.page === "mine" ? minePage() : browsePage();
      page.replaceChildren(...(view.notice ? [element("p", view.notice, "sc-callout sc-notice")] : []), body);
    });
  }

  function featuredSection() {
    const featured = element("section", undefined, "sc-featured enterprise-skills"), top = element("div", undefined, "sc-section-head");
    const refresh = button("重新核验", "sc-link", "enterprise", loadEnterprise); refresh.id = "refresh-enterprise-skills";
    if (data.enterpriseState === "loading") refresh.disabled = true;
    top.append(element("h2", "企业精选"), element("p", data.enterpriseNote, "enterprise-skill-status"), refresh);
    const list = element("div", undefined, "sc-grid featured"); list.id = "enterprise-skill-list";
    const shown = items("enterprise").filter(matches);
    list.append(...shown.map(item => card(item, "featured")));
    featured.append(top, list);
    if (data.enterpriseState === "ready" && !shown.length && !view.query) {
      featured.append(empty(data.administrator ? "企业货架还是空的。在「我的技能」里打开一个本机技能，从「更多」上架即可。" : "本企业还没有上架技能。"));
    }
    return { featured, shown };
  }

  function browsePage() {
    const wrap = element("div", undefined, "sc-browse");
    // The enterprise shelf is what a company curates for its people, so it is
    // the featured row here -- the same place both reference products put
    // their 精选. Under the 企业 chip it is the whole page, status and retry
    // included, rather than a bare grid saying there is nothing.
    if (view.chip === "all" || view.chip === "enterprise") {
      const { featured, shown } = featuredSection();
      // A search that matches nothing on the shelf should not leave its header
      // and a count sitting above the real results.
      if (!view.query || shown.length) wrap.append(featured);
    }

    const all = element("section", undefined, "sc-all");
    const chips = element("div", undefined, "sc-chips"); chips.setAttribute("role", "toolbar"); chips.setAttribute("aria-label", "按来源筛选");
    for (const [value, label] of CHIPS) {
      const count = value === "all" ? CHIPS.slice(1).reduce((sum, [kind]) => sum + items(kind).length, 0) : items(value).length;
      const chip = focusable(element("button", undefined, "sc-chip"), `chip:${value}`); chip.type = "button"; chip.dataset.chip = value; chip.setAttribute("aria-pressed", String(view.chip === value));
      chip.append(element("span", label), element("span", String(count), "sc-count"));
      chip.onclick = () => { view.chip = value; paintPage(); };
      chips.append(chip);
    }
    all.append(chips);
    if (view.chip === "enterprise") { wrap.prepend(all); return wrap; }
    all.append(...failures("local", "feishu", "plugins"));
    const kinds = view.chip === "all" ? ["local", "feishu", "plugin"] : [view.chip];
    const shown = kinds.flatMap(kind => items(kind)).filter(matches);
    const grid = element("div", undefined, "sc-grid"); grid.id = "skill-browse";
    grid.append(...shown.map(item => card(item)));
    const goMarket = () => { const go = focusable(element("button", "添加技能市场", "sc-primary"), "btn:go-market"); go.type = "button"; go.onclick = () => { view.page = "mine"; paint(); focusLater("#marketplace-source"); }; return go; };
    all.append(shown.length ? grid
      : !data.loaded ? empty("正在读取技能…")
      : view.query ? empty(`没有找到和「${search.value}」相关的技能。`)
      : view.chip === "local" ? empty("还没有导入过技能。技能是一个包含 SKILL.md 的文件夹。", button("导入技能文件夹", "sc-primary", "import", importLocal))
      : view.chip === "plugin" ? empty("还没有可以安装的插件。先添加一个技能市场。", goMarket())
      : empty("这里还没有技能。"));
    wrap.append(all);
    return wrap;
  }

  // What this person added, grouped by where it came from -- the way 豆包工作
  // splits 本地 from 豆包推荐. Built-ins and the enterprise shelf are handed to
  // everyone, so they are not "mine" and are not repeated here.
  function minePage() {
    const wrap = element("div", undefined, "sc-mine-page");
    const active = data.local.find(skill => skill.enabled);
    wrap.append(element("p", active
      ? `正在生效：新建的${modesOf(active).map(mode => MODE_NAMES[mode]).join("和")}会带上「${active.title}」。同一时间只有一个本机技能生效。`
      : "没有启用本机技能，新任务按默认方式工作。", "sc-callout"));

    const group = (label, count) => { const section = element("section", undefined, "sc-group"); section.append(element("h2", `${label}${count === undefined ? "" : ` · ${count}`}`)); wrap.append(section); return section; };
    const locals = items("local").filter(matches);
    const localGroup = group("我导入的", data.local.length); localGroup.classList.add("local-skills");
    localGroup.append(...failures("local"));
    const importInline = button("导入技能文件夹", "sc-secondary", "import", importLocal);
    if (locals.length) { const grid = element("div", undefined, "sc-grid"); grid.append(...locals.map(item => card(item))); localGroup.append(grid, importInline); }
    else localGroup.append(empty(!data.loaded ? "正在读取…" : view.query ? "没有匹配的本机技能。" : "还没有导入过技能。技能是一个包含 SKILL.md 的文件夹。", importInline));

    const installed = items("plugin").filter(item => item.raw.installed).filter(matches);
    const pluginGroup = group("已安装的市场插件", data.plugins.filter(row => row.installed).length);
    pluginGroup.append(...failures("plugins"));
    if (installed.length) { const grid = element("div", undefined, "sc-grid"); grid.append(...installed.map(item => card(item))); pluginGroup.append(grid); }
    else pluginGroup.append(empty("还没有安装市场插件。在「全部技能」的市场插件里点 + 安装。"));

    // Where plugins come from. A market can be a folder on this machine, which
    // is how somebody publishes their own: point it at a directory, edit the
    // files, and it is live.
    const sources = group("技能来源", data.markets.length);
    sources.append(element("p", "一份技能清单：这台电脑上的文件夹，或一个 Git 仓库。添加市场不会安装任何东西。", "sc-hint"), ...failures("markets"));
    const form = element("form", undefined, "market-form sc-form"), source = focusable(element("input"), "input:market");
    source.id = "marketplace-source"; source.placeholder = "本机文件夹绝对路径，或 owner/repo、https://… 的 Git 地址"; source.setAttribute("aria-label", "市场地址");
    source.value = drafts.market; source.oninput = () => { drafts.market = source.value; };
    const submit = focusable(element("button", "添加市场", "sc-primary"), "btn:market-add"); submit.type = "submit"; submit.disabled = busy.has("market");
    const refresh = button("刷新市场", "sc-secondary", "market", async () => { data.markets = await api.upgradeMarketplaces(); await reload("plugins"); });
    form.append(source, submit, refresh);
    form.onsubmit = event => { event.preventDefault(); action(() => guarded("market", async () => {
      const before = data.markets.length;
      data.markets = await api.addMarketplace({ source: drafts.market });
      // Cleared only when something was actually added: a declined or failed
      // add leaves the address there to correct.
      if (data.markets.length > before) drafts.market = "";
      await reload("plugins");
    })); };
    const list = element("div", undefined, "market-list sc-rows");
    list.append(...(data.markets.length ? data.markets.map(row => {
      const line = element("div", undefined, "sc-row market-card");
      const text = element("div", undefined, "sc-row-text");
      text.append(element("strong", row.name), element("small", `${row.kind === "local" ? "本机文件夹" : "Git 仓库"} · ${row.source}`));
      line.append(text, button("移除", "sc-secondary", `market:${row.name}`, async () => { data.markets = await api.removeMarketplace(row.name); await reload("plugins"); }));
      return line;
    }) : [element("p", "还没有添加过市场。", "empty-note")]));
    sources.append(form, list);
    return wrap;
  }

  // MCP servers are how a task reaches an outside tool, including a program on
  // this machine. They sit beside skills rather than inside them, the way both
  // reference products keep 连接器 as a sibling tab.
  // App-owned MCP capabilities, one-click. Enabling one makes its tools ride
  // along on every coding task; each call still asks for confirmation.
  function builtinSection() {
    const rows = data.builtins ?? [];
    if (!rows.length) return [];
    const list = element("div", undefined, "mcp-list sc-rows");
    list.append(...rows.map(row => {
      const line = element("div", undefined, "sc-row mcp-card");
      const text = element("div", undefined, "sc-row-text");
      text.append(element("strong", row.title), element("small", row.description));
      if (row.tools?.length) text.append(element("small", `工具：${row.tools.map(tool => tool.name).join("、")}`, "sc-row-tools"));
      // 电脑操作需要 macOS 的「辅助功能」和「屏幕录制」，而这两项只有在应用**申请过**
      // 之后才会出现在系统设置的列表里：从没申请过的应用根本不在列表中，也就无从勾选。
      // 这个按钮就是去申请——弹出系统授权框，同时把本应用注册进那两个列表。
      const extras = row.key === "computer" ? [button("检查权限", "sc-secondary", "computer-permissions", async () => {
        const status = await api.requestComputerPermissions();
        const accessibility = Boolean(status?.accessibility), screen = status?.screen === "granted";
        // Only tell the person to restart when there is something left for them
        // to switch on -- saying it while both are already granted reads as an
        // instruction to do something that is not needed.
        view.notice = status?.supported === false ? "这项权限只有 macOS 需要，当前系统不涉及。"
          : accessibility && screen ? "辅助功能和屏幕录制都已授权，电脑操作可以直接使用。"
          : `辅助功能：${accessibility ? "已授权" : "未授权——请在刚弹出的对话框里同意，或到「系统设置 → 隐私与安全性 → 辅助功能」勾选本应用"}；`
            + `屏幕录制：${screen ? "已授权" : "未授权——截屏会失败，请到「隐私与安全性 → 屏幕录制」勾选本应用"}。`
            + "勾选之后需要重启本应用才会生效。";
        paint();
      })] : [];
      line.append(avatar({ kind: "plugin", id: row.id, title: row.title }), text,
        element("span", row.enabled ? "已启用" : "未启用", `sc-state${row.enabled ? " on" : ""}`), ...extras,
        toggle(row.enabled, `${row.enabled ? "停用" : "启用"}「${row.title}」`, `builtin:${row.key}`, `builtin:${row.key}`,
          async on => { data.builtins = await api.setBuiltinConnectorEnabled(row.key, on); }));
      return line;
    }));
    return [element("h3", "内置能力", "sc-subhead"),
      element("p", "编程任务可用的内置工具。启用后自动对每个编程任务生效。调用前按任务的权限确认：逐步确认每次都问；标准和自动每一轮只问一次（电脑操作按应用问）；完全访问不再询问。", "sc-hint"),
      ...failures("builtins"), list];
  }
  // Connections a task is started with, one per task: the ones an
  // administrator opened to this account (企业连接器) and the ones imported from
  // a configuration file. Until 2026-09-23 they sat at the foot of 设置, behind
  // 获取企业 MCP and 导入 MCP 配置; both reference products keep every connector
  // on this page instead, with the raw configuration one level down (WorkBuddy:
  // 连接器 → 自定义连接器 → 配置 MCP). Adding, checking, using and removing one
  // are each confirmed by the main process, exactly as they were there.
  const matchesConnection = row => !view.query || [row.title, row.id].some(value => String(value).toLowerCase().includes(view.query));
  function connectionRow(row, offer) {
    const shown = row ?? offer, key = `connection:${shown.id}`;
    const line = element("div", undefined, "sc-row mcp-connection"); line.dataset.connection = shown.id;
    const text = element("div", undefined, "sc-row-text");
    text.append(element("strong", shown.title), element("small", `${TRANSPORTS[shown.transport] ?? shown.transport} · 工具：${shown.enabledTools.join("、")}`, "sc-row-tools"));
    const probe = row && probes.get(`${row.id}:${row.digest}`);
    if (probe) text.append(element("small", probe, "sc-row-probe"));
    line.append(avatar({ kind: "plugin", id: shown.id, title: shown.title }), text);
    if (!row) {
      line.append(element("span", "未添加", "sc-state"), button("添加", "sc-secondary add-enterprise-connection", key, () => addEnterprise(offer)));
      return line;
    }
    // An enterprise connection the server no longer lists, or lists under a
    // different policy, cannot start a task (the main process refuses it); it
    // says why and offers what can still be done.
    const withdrawn = row.transport === "enterprise" && data.offeredReady && !offer;
    const changed = row.transport === "enterprise" && offer && offer.policyDigest !== row.policyDigest;
    line.append(element("span", withdrawn ? "管理员已收回" : changed ? "授权有变化" : "已添加", `sc-state${withdrawn || changed ? " bad" : " on"}`));
    if (changed) line.append(button("更新", "sc-secondary", key, () => addEnterprise(offer)));
    else if (!withdrawn) line.append(menu("用于新任务", "mcp-use-menu", [
      ["新工作任务", undefined, () => guarded(key, () => useConnection(row, "cowork")), "use-mcp-cowork"],
      ["新编程任务", undefined, () => guarded(key, () => useConnection(row, "coding")), "use-mcp-coding"],
    ], action, `use:${shown.id}`));
    line.append(menu("更多", "mcp-more-menu", [
      // Checked under the old grant it could only fail; 更新 is the way forward.
      ...(withdrawn || changed ? [] : [["检查连接", undefined, () => guarded(key, () => probeConnection(row)), "probe-mcp-connection"]]),
      ["移除", undefined, () => guarded(key, () => removeConnection(row)), "remove-mcp-connection"],
    ], action, `more:${shown.id}`));
    return line;
  }
  function enterpriseConnectors() {
    const added = data.connections.filter(row => row.transport === "enterprise");
    const offers = new Map(data.offered.map(row => [row.id, row]));
    const ids = [...new Set([...data.offered.map(row => row.id), ...added.map(row => row.id)])];
    // Nothing offered and nothing added: most servers offer none, and a heading
    // over an empty list would only raise the question of what is missing.
    if (!ids.length && !data.failures.offered) return [];
    const rows = ids.map(id => ({ row: added.find(row => row.id === id) ?? null, offer: offers.get(id) ?? null })).filter(({ row, offer }) => matchesConnection(row ?? offer));
    const list = element("div", undefined, "mcp-list sc-rows"); list.id = "enterprise-connectors";
    list.append(...rows.map(({ row, offer }) => connectionRow(row, offer)));
    return [element("h3", "企业连接器", "sc-subhead"),
      element("p", "管理员为你开通的工具。服务凭据留在企业服务端，工具的参数和结果会经过企业服务端。添加后在新任务里选用，每次调用工具都要你确认。", "sc-hint"),
      ...failures("offered"), ...(rows.length ? [list] : ids.length ? [element("p", "没有匹配的企业连接器。", "empty-note")] : [])];
  }
  function connectorsPage() {
    const wrap = element("div", undefined, "sc-connectors");
    // Whether the server has answered what it offers this account; the section
    // is absent both before it answers and when it offers nothing.
    wrap.dataset.enterprise = data.offeredReady ? "ready" : data.failures.offered ? "failed" : "loading";
    wrap.append(...enterpriseConnectors(), ...builtinSection(), element("h3", "自定义连接器", "sc-subhead"),
      element("p", "连接器让任务调用外部工具：远程 MCP 服务填 https 地址；本机的命令行工具填可执行文件路径。也可以从不含密钥的配置文件导入一个连接，只在选用它的新任务里生效。", "sc-hint"), ...failures("servers", "connections"));
    const form = element("form", undefined, "mcp-form sc-form");
    const name = focusable(element("input"), "input:mcp-name"); name.id = "mcp-name"; name.placeholder = "名称，例如 my-tool"; name.setAttribute("aria-label", "连接器名称");
    name.value = drafts.mcpName; name.oninput = () => { drafts.mcpName = name.value; };
    const kind = focusable(element("select"), "input:mcp-kind"); kind.id = "mcp-kind"; kind.setAttribute("aria-label", "连接器类型");
    for (const [value, label] of [["command", "本机命令"], ["url", "远程地址"]]) { const option = element("option", label); option.value = value; kind.append(option); }
    kind.value = drafts.mcpKind;
    const target = focusable(element("input"), "input:mcp-target"); target.id = "mcp-target"; target.setAttribute("aria-label", "命令或地址");
    target.value = drafts.mcpTarget; target.oninput = () => { drafts.mcpTarget = target.value; };
    const placeholder = () => { target.placeholder = kind.value === "url" ? "https://… 的 MCP 服务地址" : "可执行文件绝对路径，后面可加空格分隔的参数"; };
    placeholder(); kind.onchange = () => { drafts.mcpKind = kind.value; placeholder(); };
    // Not just 添加: an offered enterprise connector's row has an 添加 of its
    // own, and the first manual run of it pressed this one instead (2026-09-23).
    const submit = focusable(element("button", "添加连接器", "sc-primary"), "btn:mcp-add"); submit.type = "submit"; submit.id = "add-mcp-server"; submit.disabled = busy.has("mcp");
    const importFile = button("从配置文件导入", "sc-secondary", "mcp-import", importConnection); importFile.id = "import-mcp";
    form.append(name, kind, target, submit, importFile);
    form.onsubmit = event => { event.preventDefault(); action(() => {
      // An empty field is said here, in the form's own words, with the cursor
      // put in it; the main process's refusal (请填写服务名称) named neither.
      const missing = !drafts.mcpName.trim() ? name : !drafts.mcpTarget.trim() ? target : null;
      if (missing) {
        missing.focus();
        throw new Error(missing === name ? "先填连接器名称（例如 my-tool），再点「添加连接器」。"
          : `先填${drafts.mcpKind === "url" ? " https:// 开头的 MCP 服务地址" : "可执行文件的绝对路径"}，再点「添加连接器」。`);
      }
      return guarded("mcp", async () => {
        const [command, ...args] = drafts.mcpTarget.trim().split(/\s+/u), before = data.servers.length;
        data.servers = await api.addMcpServer(drafts.mcpKind === "url" ? { name: drafts.mcpName, kind: "url", url: drafts.mcpTarget.trim() } : { name: drafts.mcpName, kind: "command", command, args });
        if (data.servers.length > before) { drafts.mcpName = ""; drafts.mcpTarget = ""; }
      });
    }); };
    const shown = data.servers.filter(row => !view.query || row.name.toLowerCase().includes(view.query));
    const imported = data.connections.filter(row => row.transport !== "enterprise").filter(matchesConnection);
    const list = element("div", undefined, "mcp-list sc-rows");
    list.append(...(shown.length || imported.length ? [...shown.map(row => {
      const line = element("div", undefined, "sc-row mcp-card");
      const text = element("div", undefined, "sc-row-text");
      const where = row.transport.kind === "url" ? row.transport.url : [row.transport.command, ...row.transport.args].join(" ");
      text.append(element("strong", row.name), element("small", where));
      line.append(avatar({ kind: "plugin", id: row.name, title: row.name }), text,
        element("span", row.enabled ? (row.transport.kind === "url" ? "远程" : "本机") : row.disabledReason || "已停用", `sc-state${row.enabled ? " on" : ""}`));
      // Only a server that says it needs sign-in gets the button for it.
      if (["needs_login", "logged_in", "logged_out"].includes(row.authStatus)) {
        line.append(button(row.authStatus === "logged_in" ? "退出登录" : "登录", "sc-secondary", `mcp:${row.name}`, async () => {
          data.servers = row.authStatus === "logged_in" ? await api.logoutMcpServer(row.name) : await api.loginMcpServer(row.name);
        }));
      }
      line.append(button("删除", "sc-secondary", `mcp:${row.name}`, async () => { data.servers = await api.removeMcpServer(row.name); }));
      return line;
    }), ...imported.map(row => connectionRow(row, null))] : [element("p", !data.loaded ? "正在读取…" : view.query ? "没有匹配的连接器。" : "还没有添加过连接器。", "empty-note")]));
    wrap.append(form, list);
    return wrap;
  }

  // ---------- actions ----------
  async function importLocal() {
    const added = await api.importLocalSkill(); if (!added) return;
    view.chip = "local";
    // Re-importing changed content under an enabled skill's name switches it
    // off until the new instructions are confirmed; the person is told why.
    view.notice = added.switchedOffForReview
      ? `「${added.title}」已换成新导入的内容，并先停用了。新内容要重新确认后才会用于新任务：打开它看过之后再启用。`
      : added.replaced ? `「${added.title}」已更新为新导入的内容。` : `已导入「${added.title}」。启用后，新建的任务会使用它。`;
    await reload("local");
  }
  // Switching on is confirmed by the main process; switching off takes nothing
  // away from anyone and is not.
  async function setLocal(skill, on) {
    data.local = await api.setLocalSkillEnabled(skill.id, on, modesOf(skill));
    if (on && data.local.find(row => row.id === skill.id)?.enabled) pendingModes.delete(skill.id);
  }
  async function setPlugin(row, on) { data.plugins = await api.setPluginEnabled(row.id, on); }
  // A connection's four actions. Each returns null when the person declined the
  // main process's confirmation, and then nothing here changes.
  async function importConnection() {
    const added = await api.importMcp(); if (!added || !alive()) return;
    view.notice = `已导入「${added.title}」。要用它，点它这一行的「用于新任务」。`;
    await reload("connections");
  }
  async function addEnterprise(offer) {
    const added = await api.importEnterpriseMcp({ id: offer.id, policyDigest: offer.policyDigest }); if (!added || !alive()) return;
    view.notice = `已添加「${added.title}」。要用它，点它这一行的「用于新任务」。`;
    await reload("connections", "offered");
  }
  async function probeConnection(row) {
    const result = await api.useMcp({ id: row.id, digest: row.digest }, "cowork", true); if (!result || !alive()) return;
    probes.set(`${row.id}:${row.digest}`, `检查通过：${result[0].tools.length} 个工具 · 检查进程已关闭，发送时重连`);
  }
  async function useConnection(row, mode) {
    const created = await api.useMcp({ id: row.id, digest: row.digest }, mode, false); if (!created || !alive()) return;
    await openCreatedTask(created, mode);
  }
  async function removeConnection(row) {
    await api.removeMcp({ id: row.id, digest: row.digest }); if (!alive()) return;
    await reload("connections");
    if (!data.connections.some(entry => entry.id === row.id && entry.digest === row.digest)) probes.delete(`${row.id}:${row.digest}`);
  }
  async function installPlugin(row) { data.plugins = await api.installPlugin(row.id); }

  // ---------- detail dialog ----------
  const part = id => detail.querySelector(`#skill-detail-${id}`);
  let current = null, detailEpoch = 0, mcpSelection, openedFrom = null;
  const closeButton = detail.querySelector("#close-skill-detail");
  if (closeButton) closeButton.onclick = () => detail.close();
  listen(detail, "close", () => {
    current = null; detailEpoch++;
    // A skill opened again later gets its block built afresh.
    const extra = part("extra"); if (extra) extra.dataset.item = "";
    // Back to the card that opened it, so Tab carries on from there.
    const key = openedFrom; openedFrom = null;
    if (key && alive()) queueMicrotask(() => root.querySelector(`[data-focus="${escapeKey(`card:${key}`)}"]`)?.focus({ preventScroll: true }));
  });
  // Escape with 更多 open closes that menu, not the whole dialog.
  listen(detail, "cancel", event => {
    const open = detail.querySelector("details.sc-menu[open]");
    if (open) { event.preventDefault(); open.open = false; open.querySelector("summary")?.focus(); }
  });

  // Errors from inside the dialog are shown inside it. The page's banner sits
  // behind the modal backdrop, where they were three dimmed characters wide and
  // not announced at all. They still go to action() as well, so the banner
  // carries them once the dialog is closed.
  function dialogAction(run) {
    const line = part("error"); if (line) { line.hidden = true; line.textContent = ""; }
    return action(async () => {
      try { return await run(); }
      catch (cause) { if (detail.open && line) { line.textContent = readableError(cause); line.hidden = false; } throw cause; }
    });
  }

  async function openDetail(item) {
    const epoch = ++detailEpoch;
    if (item.kind === "enterprise") {
      // Verified before it is shown, exactly as the old 核验并预览 button did: an
      // entry withdrawn from the shelf, or one whose signature no longer checks
      // out, is refused -- the refusal reaches the error banner through action()
      // -- and is never presented as something that can be used. A request
      // superseded by a newer one says nothing.
      let files;
      try { files = (await api.readEnterpriseSkill({ id: item.raw.id, version: item.raw.version, digest: item.raw.digest })).files; }
      catch (cause) { if (epoch !== detailEpoch || !alive()) return; throw cause; }
      if (epoch !== detailEpoch || !alive()) return;
      current = item; mcpSelection = undefined; openedFrom = item.key;
      paintDetail(); part("body").replaceChildren(...documentNodes(files));
      show();
      if (item.raw.requiredTools.some(tool => tool.startsWith("mcp:"))) void checkConnections(item, epoch);
      return;
    }
    current = item; mcpSelection = undefined; openedFrom = item.key;
    paintDetail(); part("body").replaceChildren(element("p", "正在读取内容…", "empty-note"));
    show();
    void loadBody(item, epoch);
  }
  function show() {
    const line = part("error"); if (line) { line.hidden = true; line.textContent = ""; }
    if (!detail.open) detail.showModal();
    // A confirmation already waiting on the page would otherwise be left inert
    // behind this modal, and the main process refuses a second one until it is
    // answered -- so every confirmed action in the dialog would fail.
    placeConfirmations();
    detail.querySelector(".sd-scroll")?.scrollTo?.(0, 0);
  }
  // Re-read the item after its underlying row changed, keeping the dialog open.
  function refreshDetail() {
    if (!current || !detail.open) return;
    const fresh = items(current.kind).find(item => item.key === current.key);
    if (!fresh) { detail.close(); return; }
    current = fresh;
    keepingFocus(detail, paintDetail);
  }

  async function loadBody(item, epoch) {
    const body = part("body");
    try {
      let files;
      if (item.kind === "feishu") files = [{ path: "SKILL.md", text: await api.readSkill(item.raw.name) }];
      else if (item.kind === "local") files = item.raw.files;
      else files = [{ path: "说明", text: item.description }];
      if (epoch !== detailEpoch || !alive()) return;
      body.replaceChildren(...documentNodes(files));
    } catch (cause) {
      if (epoch === detailEpoch && alive()) body.replaceChildren(element("p", readableError(cause), "sd-error"));
    }
  }
  // SKILL.md first, as a document; every other file after it under its own
  // path, so nothing a skill ships is hidden from the person deciding on it.
  // Each file is rendered on its own: one malformed or oversized file shows as
  // plain text instead of taking the whole preview down with it. The front
  // matter is shown too, because its description is what a model reads when
  // deciding to use the skill and can differ from the catalogue's.
  function documentNodes(files) {
    const ordered = [...files].sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
    const nodes = [];
    const raw = text => { const pre = element("pre", undefined, "md-code"); pre.append(element("code", text)); return pre; };
    for (const file of ordered) {
      if (ordered.length > 1 || file.path !== "SKILL.md") nodes.push(element("h3", file.path, "sd-file"));
      const text = String(file.text ?? "");
      const markdown = /\.(md|markdown)$/iu.test(file.path) || file.path === "说明";
      if (!markdown || text.length > MAX_RENDERED) { nodes.push(raw(text)); continue; }
      try {
        const { header, body } = skillFrontmatter(text);
        if (header.length) { const box = element("pre", undefined, "sd-frontmatter"); box.append(element("code", header.join("\n"))); nodes.push(box); }
        const section = element("div", undefined, "sd-doc"); section.append(...markdownBlocks(element, body));
        nodes.push(section);
      } catch { nodes.push(raw(text)); }
    }
    return nodes;
  }

  async function checkConnections(item, epoch) {
    const status = detail.querySelector(".skill-dependencies .sd-status"), select = detail.querySelector(".skill-mcp-select"), check = detail.querySelector(".check-skill-mcp");
    if (!status || !select) return;
    check.disabled = true; select.disabled = true; resetSelect(select);
    try {
      const result = await api.enterpriseSkillConnections({ id: item.raw.id, version: item.raw.version, digest: item.raw.digest });
      if (epoch !== detailEpoch || !alive()) return;
      for (const connection of result.connections) {
        const option = element("option", `${connection.title} · ${connection.transport} · ${connection.enabledTools.join("、")}`); option.value = connection.id; select.append(option);
      }
      status.textContent = result.connections.length ? "选一个连接。创建任务时会再核验一次，每次调用工具仍要确认。" : "没有匹配连接。请先在「连接器」里添加这个技能需要的连接，并允许它声明的工具，再回来检查。";
      select.disabled = !result.connections.length;
      select.onchange = () => { mcpSelection = result.connections.find(row => row.id === select.value); syncUseButtons(); };
    } catch (cause) { if (epoch === detailEpoch && alive()) status.textContent = readableError(cause); }
    finally { if (epoch === detailEpoch && alive()) check.disabled = false; }
  }
  function resetSelect(select) { const option = element("option", "选择一个工具连接"); option.value = ""; select.replaceChildren(option); mcpSelection = undefined; syncUseButtons(); }
  function syncUseButtons() {
    if (current?.kind !== "enterprise") return;
    const needsMcp = current.raw.requiredTools.some(tool => tool.startsWith("mcp:"));
    for (const node of detail.querySelectorAll(".use-enterprise-skill")) node.disabled = busy.has("use") || !current.raw.compatible || (needsMcp && !mcpSelection);
  }

  function paintDetail() {
    const item = current; if (!item) return;
    const face = part("avatar");
    face.textContent = initialOf(item.title); face.style.setProperty("--h", String(KINDS[item.kind].hue ?? hueOf(item.id)));
    part("title").textContent = item.fullTitle ?? item.title;
    part("sub").textContent = item.description;
    const switchBox = part("switch"); switchBox.replaceChildren();
    const ctl = item.kind === "local" || (item.kind === "plugin" && item.raw.installed) ? control(item, "detail", dialogAction) : null;
    if (ctl) switchBox.append(ctl);

    const raw = item.raw;
    part("meta").replaceChildren(...[
      element("span", KINDS[item.kind].tag, `sc-tag ${item.kind}`),
      ...(item.kind === "enterprise" ? [`版本 ${raw.version}`, `发布者 ${raw.publisher}`, "签名已核验 · 不代表内容已审查"]
        : item.kind === "feishu" ? [raw.name, "随内置飞书 CLI 更新"]
        : item.kind === "local" ? [`版本 ${raw.version}`, `${raw.files.length} 个文件`, "本机导入 · 未经服务端签名审核"]
        : [`来自 ${raw.marketplace}`, ...(raw.version ? [`版本 ${raw.version}`] : [])]).map(text => typeof text === "string" ? element("span", text) : text),
    ]);

    // This block holds state a person is working with -- the chosen tool
    // connection, an open version history, a focused checkbox -- so it is only
    // built when a different skill is shown. Changes to it re-build it
    // explicitly (rebuildExtras); unrelated re-draws leave it alone.
    const extra = part("extra");
    const keep = (item.kind === "enterprise" || item.kind === "local") && extra.dataset.item === item.key && extra.children.length > 0;
    if (!keep) {
      extra.replaceChildren(); extra.dataset.item = item.key;
      if (item.kind === "enterprise") {
        if (raw.requiredTools.length) extra.append(element("p", `声明工具：${raw.requiredTools.join("、")}`, "sd-note"));
        if (!raw.compatible) extra.append(element("p", raw.compatibilityMessage, "sd-warn"));
        if (raw.requiredTools.some(tool => tool.startsWith("mcp:"))) {
          const block = element("div", undefined, "skill-dependencies"), status = element("p", "需要绑定一个已导入的工具连接；不会自动添加服务或授权工具。", "sd-status");
          const select = element("select", undefined, "skill-mcp-select"); select.setAttribute("aria-label", `${item.title} 的工具连接`); select.disabled = true;
          const check = element("button", "检查可用连接", "check-skill-mcp sc-secondary"); check.type = "button";
          check.onclick = () => dialogAction(() => checkConnections(item, detailEpoch));
          block.append(status, check, select); extra.append(block); resetSelect(select);
        }
      }
      if (item.kind === "local") extra.append(...localExtras(item));
      if (item.kind === "plugin" && raw.unusable) extra.append(element("p", raw.unusable, "sd-warn"));
    }
    extra.hidden = !extra.children.length;

    // Less frequent, and in two cases irreversible, so behind 更多 rather than
    // next to the button people are meant to press.
    const more = part("more"); more.replaceChildren();
    const extras = [];
    if (item.kind === "local" && data.administrator) extras.push(["上架到企业", undefined, () => guarded(`local:${raw.id}`, async () => { if (await api.publishSkill(raw.id)) await loadEnterprise(); }), "publish-skill"]);
    if (item.kind === "local") extras.push(["移除", undefined, () => guarded(`local:${raw.id}`, async () => { await api.removeLocalSkill(raw.id); detail.close(); await reload("local"); }), "remove-local-skill"]);
    if (item.kind === "enterprise" && data.administrator) extras.push(["从企业货架下架", undefined, () => guarded("enterprise", async () => { if (await api.unpublishSkill(raw.id)) { detail.close(); await loadEnterprise(); } }), "unpublish-skill"]);
    if (item.kind === "plugin" && raw.installed) extras.push(["卸载", undefined, () => guarded(`plugin:${raw.id}`, async () => { data.plugins = await api.removePlugin(raw.id); }), "remove-plugin"]);
    if (extras.length) more.append(menu("更多", "sd-more-menu", extras, dialogAction));

    const actions = part("actions"); actions.replaceChildren();
    if (item.kind === "enterprise") {
      for (const [mode, label, style] of [["coding", "在编程任务中使用", "sc-secondary"], ["cowork", "在工作任务中使用", "sc-primary"]]) {
        const use = focusable(element("button", label, `use-enterprise-skill ${style}`), `use:${mode}`); use.type = "button"; use.dataset.mode = mode;
        use.onclick = () => dialogAction(async () => {
          if (busy.has("use")) return;
          busy.add("use"); syncUseButtons();
          try {
            const created = await api.useEnterpriseSkill({ id: raw.id, version: raw.version, digest: raw.digest }, mode, mcpSelection);
            if (!created || !alive()) return;
            detail.close(); await openCreatedTask(created, mode);
          } finally { busy.delete("use"); syncUseButtons(); }
        });
        actions.append(use);
      }
      syncUseButtons();
    } else if (item.kind === "plugin" && !raw.installed) {
      if (!raw.unusable) actions.append(button("安装", "sc-primary", `plugin:${raw.id}`, () => installPlugin(raw), dialogAction));
    } else if (item.kind === "plugin" && !raw.enabled) {
      actions.append(button("启用", "sc-primary", `plugin:${raw.id}`, () => setPlugin(raw, true), dialogAction));
    } else {
      const coding = item.kind === "local" && !modesOf(raw).includes("cowork");
      actions.append(button(coding ? "去编程任务里试用" : "在对话中试用", "sc-primary try-skill", `try:${item.key}`, () => tryInConversation(item), dialogAction));
    }
  }

  // The task kinds and version history of a local skill, in the dialog.
  function localExtras(item) {
    const raw = item.raw, nodes = [];
    // Which task kinds this skill is offered to. For a skill that is on,
    // changing them changes what new tasks receive, so it is confirmed the way
    // switching it on is, and nothing moves until the main process accepts.
    // For one that is off, the choice is held until it is switched on -- and
    // the primary button is re-drawn to match it.
    const scope = element("div", undefined, "local-skill-scope sd-scope"); scope.append(element("span", "用于"));
    const chosen = new Set(modesOf(raw)), locked = busy.has(`local:${raw.id}`);
    for (const [mode, label] of Object.entries(MODE_NAMES)) {
      const field = element("label", undefined, "sd-check"), box = focusable(element("input"), `mode:${raw.id}:${mode}`);
      box.type = "checkbox"; box.checked = chosen.has(mode); box.disabled = locked;
      box.onchange = () => dialogAction(async () => {
        const next = new Set(modesOf(raw)); if (box.checked) next.add(mode); else next.delete(mode);
        if (!next.size) { box.checked = true; throw new Error("请至少选择一种任务类型"); }
        if (!raw.enabled) { pendingModes.set(raw.id, [...next]); rebuildExtras(); repaint(); return; }
        try { await guarded(`local:${raw.id}`, async () => { data.local = await api.setLocalSkillEnabled(raw.id, true, [...next]); }); }
        finally { rebuildExtras(); }
      });
      field.append(box, element("span", label)); scope.append(field);
    }
    nodes.push(scope);
    if (raw.history.length) {
      // Superseded versions stay available: re-importing a skill should not be
      // a one-way door.
      const history = element("details", undefined, "skill-history");
      history.append(element("summary", `历史版本（${raw.history.length}）`));
      for (const past of raw.history) {
        const row = element("div", undefined, "skill-history-row");
        row.append(element("small", `版本 ${past.version} · ${past.files} 个文件 · ${new Date(past.importedAt).toLocaleString("zh-CN")}`),
          button("换回这一版", "rollback-local-skill sc-secondary", `local:${raw.id}`, async () => {
            data.local = await api.rollbackLocalSkill(raw.id, past.digest);
            rebuildExtras();
            const fresh = items("local").find(entry => entry.key === item.key);
            if (fresh && current?.key === item.key) void loadBody(fresh, detailEpoch);
          }, dialogAction));
        history.append(row);
      }
      nodes.push(history);
    }
    return nodes;
  }
  // The local block is re-built only when its own state changed, so an open
  // history list or a focused checkbox is not thrown away by unrelated redraws.
  function rebuildExtras() {
    if (!current || current.kind !== "local" || !detail.open) return;
    const fresh = items("local").find(item => item.key === current.key) ?? current;
    const extra = part("extra"), open = extra.querySelector(".skill-history")?.open;
    keepingFocus(extra, () => { extra.replaceChildren(...localExtras(fresh)); const history = extra.querySelector(".skill-history"); if (history && open) history.open = true; });
  }

  // Trying a skill is starting a conversation with it, which is where this
  // product does everything else too. Which kind of task is decided here, from
  // the skill's current choice, never from whatever the button was drawn with.
  async function tryInConversation(item) {
    if (item.kind === "local" && !item.raw.enabled) {
      await setLocal(item.raw, true);
      // Declining the confirmation leaves it off, and then there is nothing to try.
      if (!data.local.find(skill => skill.id === item.raw.id)?.enabled) return;
    }
    const fresh = item.kind === "local" ? data.local.find(skill => skill.id === item.raw.id) : null;
    const coding = Boolean(fresh) && !modesOf(fresh).includes("cowork");
    detail.close();
    // A coding task needs a folder chosen first, so that one only goes as far
    // as the section; creating the task there binds the enabled skill.
    if (coding) return startTask({ mode: "coding", create: false });
    const prefill = item.kind === "feishu" ? `使用「${item.title}」：` : item.kind === "plugin" ? `使用插件「${item.title}」：` : "";
    return startTask({ mode: "cowork", create: true, prefill });
  }

  // ---------- start ----------
  paint();
  void (async () => {
    await Promise.all(Object.entries(loaders).filter(([name]) => name !== "offered").map(([, load]) => load()));
    data.loaded = true;
    if (alive()) paint();
  })();
  // A question to the server can take seconds; it fills its own section when it
  // answers instead of holding up everything this machine can list at once.
  void reload("offered");
  // Loaded on arrival rather than behind a button: a shelf nobody clicks looks
  // exactly like a shelf with nothing on it.
  void loadEnterprise();

  return {
    dispose() {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (detail.open) detail.close();
    },
  };
}
