// What every screen of the application must satisfy, whichever smoke drove it
// there. Installed into the application's own page by ./hook.js; nothing in the
// product loads it.
//
// Each check is a class of fault met for real while filming the promo
// (2026-09-23..25), found only because a person was using the app:
//
//   超出父元素    the permission menu overflowed its column: the Accessibility
//                 API walks down only through boxes that contain the point, so
//                 a control outside its parent's box cannot be pressed.
//   被遮挡        a control another element sits on top of.
//   文字被截断    a label cut off by its own box or by an ancestor's.
//   页面横向溢出  a page wider than the window.
//   没有名字      a control the Accessibility API cannot name.
//   重复的 id     two elements answering the same #id.
//   英文          the MCP card read "Allow the computer MCP server to run tool".
//   内部标识外露  a send card showed the recipient's open_id, the tenant and an
//                 identity fingerprint in its body; every frame of the promo
//                 that held one had to be blurred by hand.
//   重绘丢状态    the approval card was rebuilt every second: the technical
//                 details someone opened folded shut, the reason being typed
//                 into 「拒绝，并告诉它怎么做」 vanished, a connector's menu closed.
//
// Controls under a native view (Feishu, a preview, the sign-in page) are found
// by ./hook.js, which can see where the main process put those views.
//
// The function is serialised into the page, so it may not refer to anything
// outside itself.
export function installMonitor() {
  if (!/\/renderer\/index\.html(?:[?#].*)?$/.test(location.href) || window.__uiInv) return;
  // Whatever goes wrong in here must never reach the page as its own error:
  // several smokes fail on any page error, and they would be right to.
  try {
  const events = [], seen = new Set();
  const report = (list, kind, where, detail = "") => {
    const key = `${kind}|${where}|${detail}`;
    if (list === events && seen.has(key)) return;
    if (list === events) seen.add(key);
    list.push({ kind, where, detail });
  };
  const text = (node, limit = 24) => {
    const value = (node.innerText ?? node.textContent ?? "").replace(/\s+/g, " ").trim();
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  };
  const describe = (node) => {
    if (!node || node.nodeType !== 1) return String(node);
    const id = node.id ? `#${node.id}` : "";
    const classes = [...node.classList].slice(0, 2).map((name) => `.${name}`).join("");
    const role = node.getAttribute("role") ? `[role=${node.getAttribute("role")}]` : "";
    const label = text(node) || node.getAttribute("aria-label") || node.getAttribute("placeholder") || "";
    return `${node.tagName.toLowerCase()}${id}${classes}${role}${label ? `「${label}」` : ""}`;
  };
  const place = (node) => {
    const owner = node.parentElement?.closest("[id]");
    return owner && owner !== node ? `${describe(node)} 在 #${owner.id} 里` : describe(node);
  };

  // One sample asks for the same ancestors' style and box thousands of times.
  let styles = new Map(), boxes = new Map();
  const css = (node) => { let style = styles.get(node); if (!style) { style = getComputedStyle(node); styles.set(node, style); } return style; };
  const rect = (node) => { let box = boxes.get(node); if (!box) { box = node.getBoundingClientRect(); boxes.set(node, box); } return box; };
  const fresh = () => { styles = new Map(); boxes = new Map(); };

  // What a person can see of an element: its box cut by the window and by
  // every ancestor that clips. Null when nothing of it shows.
  const shown = (node) => {
    const box = rect(node);
    if (box.width < 1 || box.height < 1) return null;
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
    let left = Math.max(box.left, 0), top = Math.max(box.top, 0), right = Math.min(box.right, innerWidth), bottom = Math.min(box.bottom, innerHeight);
    if (css(node).position !== "fixed") {
      for (let parent = node.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
        const style = css(parent);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") {
          const clip = rect(parent);
          if (style.overflowX !== "visible") { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
          if (style.overflowY !== "visible") { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
        }
        if (style.position === "fixed") break;
      }
    }
    if (right - left < 1 || bottom - top < 1) return null;
    return { left, top, right, bottom, box };
  };
  const inert = (node) => Boolean(node.closest("[inert], [aria-hidden='true']")) || node.matches(":disabled");
  // Whether `cover` is in a sticky or fixed layer that `node` is not in.
  const layerOf = (element) => { for (let at = element; at && at !== document.documentElement; at = at.parentElement) { const position = css(at).position; if (position === "sticky" || position === "fixed") return at; } return null; };
  const floating = (cover, node) => { const layer = layerOf(cover); return Boolean(layer) && !layer.contains(node); };

  const CONTROLS = "button, a[href], input:not([type=hidden]), textarea, select, summary, [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=tab], [role=switch], [role=checkbox], [role=radio]";
  // Where a native view is drawn over the page: what lies inside is meant to
  // be covered.
  const NATIVE_HOSTS = "#preview-area, #media-preview-area, #feishu-native-area, #feishu-chat-area, #feishu-web-area, #login-view-area";
  // Text that is data rather than the application speaking: code, commands,
  // parameters, what someone typed, what a document or the model said.
  const DATA = "pre, code, kbd, samp, textarea, input, select, script, style, svg, [contenteditable], [translate=no], .approval-technical, details.technical, .xterm, .terminal, .markdown, .message-body, .reply, .user-message, .turn-user, .turn-agent, .agent-text, .step-output, .file-name, .path, [data-content]";

  const accessibleName = (node) => {
    const labelled = node.getAttribute("aria-labelledby");
    if (labelled) return labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    const direct = node.getAttribute("aria-label") || node.getAttribute("title") || node.innerText?.trim() || node.getAttribute("alt") || "";
    if (direct) return direct;
    if (node.matches("input, textarea, select")) {
      if (node.matches("input[type=button], input[type=submit], input[type=reset]")) return node.value;
      if (node.id && document.querySelector(`label[for="${CSS.escape(node.id)}"]`)) return "label";
      if (node.closest("label")) return "label";
      return node.getAttribute("placeholder") || "";
    }
    return node.querySelector("img[alt]")?.getAttribute("alt") ?? "";
  };

  const ENGLISH = /(?:^|[^A-Za-z0-9_./\\-])((?:[A-Za-z][A-Za-z'’]*[\s,:;.!?]+){3,}[A-Za-z][A-Za-z'’]*)/;
  // Feishu's own identifiers: users (ou_/on_), chats (oc_), applications (cli_).
  // They belong in a folded 技术详情 or on an administrator's page, not in what a
  // person reads -- or shares, or records.
  const IDENTIFIER = /\b(?:ou|on|oc|cli)_[0-9a-z_]{6,}/i;
  const TECHNICAL = "details.approval-technical, details.confirm-technical, details.technical, [data-identifiers], textarea, input, .xterm, .terminal";
  const ALLOWED = /^(?:[A-Z0-9][\w.+-]*\s?)+$/; // runs of names and codes: "MiniMax-M3 GLM-5.3"

  const checks = () => {
    const found = [];
    const modal = [...document.querySelectorAll("dialog[open], [aria-modal='true']")].find((node) => shown(node));
    const root = document.scrollingElement ?? document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) report(found, "页面横向溢出", "页面", `${root.scrollWidth}>${root.clientWidth}`);

    const ids = new Map();
    for (const node of document.querySelectorAll("[id]")) ids.set(node.id, (ids.get(node.id) ?? 0) + 1);
    for (const [id, count] of ids) if (count > 1 && id) report(found, "重复的 id", `#${id}`, `${count} 个`);

    for (const node of document.querySelectorAll(CONTROLS)) {
      if (inert(node) || node.closest(NATIVE_HOSTS)) continue;
      if (modal && !modal.contains(node)) continue;
      const area = shown(node);
      if (!area) continue;
      if (!accessibleName(node)) report(found, "没有名字", place(node));
      const x = (area.left + area.right) / 2, y = (area.top + area.bottom) / 2;
      for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (css(parent).display === "contents") continue;
        const box = rect(parent);
        if (x < box.left - 0.5 || x > box.right + 0.5 || y < box.top - 0.5 || y > box.bottom + 0.5) {
          report(found, "超出父元素", place(node), `${describe(parent)} 的框 @${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}×${Math.round(box.height)}，控件中心在 ${Math.round(x)},${Math.round(y)}`);
          break;
        }
      }
      if (css(node).pointerEvents === "none") continue;
      const hit = document.elementFromPoint(x, y);
      // Covered by a layer that floats on purpose -- a sticky header the list
      // scrolls under, an open menu, the narrow window's sidebar -- is not a
      // layout fault; controls pressed into each other in the flow are.
      if (hit && hit !== node && !node.contains(hit) && !hit.contains(node) && !hit.closest("label")?.contains(node) && !floating(hit, node)) {
        report(found, "被遮挡", place(node), describe(hit));
      }
    }

    for (const node of document.body.querySelectorAll("*")) {
      const own = [...node.childNodes].some((child) => child.nodeType === 3 && child.nodeValue.trim());
      if (!own || node.closest(NATIVE_HOSTS)) continue;
      const area = shown(node);
      if (!area) continue;
      const style = css(node);
      const clipsX = style.overflowX === "hidden" || style.overflowX === "clip", clipsY = style.overflowY === "hidden" || style.overflowY === "clip";
      if (clipsX && node.scrollWidth > node.clientWidth + 1 && style.textOverflow !== "ellipsis") report(found, "文字被截断", place(node), `宽 ${node.scrollWidth}>${node.clientWidth}`);
      if (clipsY && node.scrollHeight > node.clientHeight + 1 && style.webkitLineClamp === "none" && style.textOverflow !== "ellipsis") report(found, "文字被截断", place(node), `高 ${node.scrollHeight}>${node.clientHeight}`);
      if (!clipsX && !clipsY && style.position !== "fixed") {
        // Cut off by an ancestor that hides what does not fit (not one that scrolls).
        const box = area.box;
        if (area.right - area.left < box.width - 1.5 || area.bottom - area.top < box.height - 1.5) {
          let cutter = null;
          for (let parent = node.parentElement; parent && parent !== document.documentElement; parent = parent.parentElement) {
            const outer = css(parent);
            if (/auto|scroll/.test(outer.overflowX + outer.overflowY)) { cutter = null; break; }
            if (/hidden|clip/.test(outer.overflowX + outer.overflowY)) { const clip = rect(parent); if (box.left < clip.left - 1 || box.right > clip.right + 1 || box.top < clip.top - 1 || box.bottom > clip.bottom + 1) { cutter = parent; break; } }
          }
          if (cutter && box.top < innerHeight && box.bottom > 0) report(found, "文字被截断", place(node), `被 ${describe(cutter)} 挡住一部分`);
        }
      }
      if (!node.closest(TECHNICAL)) for (const child of node.childNodes) {
        const hit = child.nodeType === 3 ? IDENTIFIER.exec(child.nodeValue) : null;
        if (hit) report(found, "内部标识外露", place(node), hit[0].slice(0, 40));
      }
      if (node.closest(DATA)) continue;
      for (const child of node.childNodes) {
        if (child.nodeType !== 3) continue;
        const match = ENGLISH.exec(child.nodeValue);
        if (match && !ALLOWED.test(match[1].trim())) report(found, "英文", place(node), match[1].trim().slice(0, 80));
      }
    }
    return found;
  };

  // What the page draws where, for the hook to lay over the native views.
  const surfaces = () => {
    const rows = [];
    for (const node of document.body.querySelectorAll(`${CONTROLS}, [role=menu], [role=dialog], [role=alert], [role=status]`)) {
      if (node.closest(NATIVE_HOSTS) || inert(node)) continue;
      const area = shown(node);
      if (area) rows.push({ where: place(node), left: area.left, top: area.top, right: area.right, bottom: area.bottom });
      if (rows.length >= 600) break;
    }
    const hosts = [...document.querySelectorAll(NATIVE_HOSTS)].map((node) => { const box = node.getBoundingClientRect(); return { id: node.id, left: box.left, top: box.top, right: box.right, bottom: box.bottom }; });
    return { rows, hosts };
  };

  // 重绘丢状态: something a person did to an element -- opened it, typed into
  // it, focused it, opened its menu -- is lost when the element is replaced by
  // a copy of itself, and nothing else they did since asked for that. Pressing
  // 「拒绝」 after typing a reason may well rebuild the card; a timer may not.
  let lastInput = { at: 0, target: null };
  const safe = (handler) => (...args) => { try { handler(...args); } catch { /* never the page's error */ } };
  for (const type of ["pointerdown", "keydown", "click"]) addEventListener(type, (event) => { lastInput = { at: performance.now(), target: event.target }; }, true);
  const signature = (node) => {
    const own = [node.tagName, node.id, node.getAttribute("name"), node.getAttribute("placeholder"), node.getAttribute("aria-label"),
      Object.entries(node.dataset).sort().join(";"), node.tagName === "DETAILS" ? node.querySelector("summary")?.textContent.trim() : ""].join("|");
    const owner = node.parentElement?.closest("[id], [data-id], [data-key], [data-task], [data-approval]");
    const ownerKey = owner ? [owner.tagName, owner.id, Object.entries(owner.dataset).sort().join(";")].join("|") : "";
    const scope = owner ?? document;
    const peers = [...scope.querySelectorAll(node.tagName)].filter((peer) => peer === node || (peer.id === node.id && Object.entries(peer.dataset).sort().join(";") === Object.entries(node.dataset).sort().join(";")));
    return `${ownerKey}>${own}#${peers.indexOf(node)}`;
  };
  const watched = new Map(); // element -> { sig, value?, open?, focused?, expanded? }
  const remember = (node, state) => { const row = watched.get(node) ?? { sig: signature(node) }; Object.assign(row, state, { at: performance.now() }); watched.set(node, row); };
  addEventListener("input", safe((event) => { const node = event.target; if (node?.matches?.("input, textarea") && !node.matches("[type=checkbox], [type=radio]")) remember(node, { value: node.value }); }), true);
  addEventListener("focusin", safe((event) => { const node = event.target; if (node?.matches?.("input, textarea, select, [contenteditable]")) remember(node, { focused: true }); }), true);
  addEventListener("focusout", safe((event) => { const row = watched.get(event.target); if (row && event.target.isConnected) row.focused = false; }), true);
  addEventListener("toggle", safe((event) => { const node = event.target; if (node?.tagName === "DETAILS") remember(node, { open: node.open }); }), true);
  // After the click has been handled: a microtask would run between this
  // listener and the control's own, before the menu is open.
  addEventListener("click", () => setTimeout(safe(() => { for (const node of document.querySelectorAll("[aria-expanded='true']")) if (!watched.get(node)?.expanded) remember(node, { expanded: true }); }), 0), true);
  const twinOf = (row, tag) => [...document.getElementsByTagName(tag)].find((candidate) => !watched.has(candidate) && signature(candidate) === row.sig) ?? null;
  new MutationObserver(safe(() => {
    for (const [node, row] of watched) {
      if (node.isConnected) { if (row.expanded && node.getAttribute("aria-expanded") !== "true") row.expanded = false; continue; }
      watched.delete(node);
      const twin = twinOf(row, node.tagName);
      if (!twin) continue;
      const target = lastInput.target;
      const elsewhere = lastInput.at > row.at && target && target !== node && !node.contains?.(target) && !twin.contains?.(target);
      if (!elsewhere) {
        if (typeof row.value === "string" && row.value && twin.value !== row.value) report(events, "重绘丢状态", describe(twin), "输入的内容被清空");
        if (row.open && !twin.open) report(events, "重绘丢状态", describe(twin), "展开的详情被收起");
        if (row.focused && document.activeElement !== twin && document.activeElement === document.body) report(events, "重绘丢状态", describe(twin), "输入焦点丢了");
        if (row.expanded && twin.getAttribute("aria-expanded") !== "true") report(events, "重绘丢状态", describe(twin), "打开的菜单被关上");
      }
      watched.set(twin, { ...row, value: twin.value, open: twin.open, focused: document.activeElement === twin, expanded: twin.getAttribute("aria-expanded") === "true", at: performance.now() });
    }
  })).observe(document, { childList: true, subtree: true }); // the document itself: an init script runs before <html> exists

  window.__uiInv = {
    sample() {
      try { fresh(); const drained = events.splice(0); return { events: drained, checks: checks(), ...surfaces(), size: { width: innerWidth, height: innerHeight } }; }
      catch (error) { return { events: [], checks: [{ kind: "巡检出错", where: "页面", detail: String(error?.message ?? error).slice(0, 120) }], rows: [], hosts: [] }; }
    },
  };
  } catch { /* a monitor that cannot start checks nothing, and says nothing into the page */ }
}
