import { readableError } from "./errors.js";
// The knowledge copy as a network: each verified document a node, each pair
// that keeps discussing the same things a link. Drawn on a canvas and left
// running, because the useful thing about this view is watching related
// documents pull together into clusters — a still picture of the same data
// reads as an undifferentiated mesh.
//
// Building it re-checks every source against Feishu, so it is an explicit
// action rather than something that happens on entering the section.
const REPULSION = 5200, SPRING = 0.0016, DAMPING = 0.9, CENTER = 0.0016, MAX_STEP = 6;

export function knowledgeGraphUi({ api, root, element, isCurrent }) {
  let disposed = false, frame = null, nodes = [], links = [], hover = null, selected = null, seed = 1;
  const card = element("section", undefined, "knowledge-graph");
  const head = element("div", undefined, "knowledge-graph-head"), copy = element("div");
  const title = element("strong", "文档关系"), note = element("p", "查看哪些资料在讨论相同主题。生成前会逐篇重新核验飞书权限与版本。");
  const build = element("button", "重新核验并生成关系图"); build.id = "build-knowledge-graph";
  const status = element("p", ""); status.id = "knowledge-graph-status"; status.setAttribute("role", "status");
  const canvas = element("canvas"); canvas.id = "knowledge-graph-canvas";
  const detail = element("div", undefined, "knowledge-graph-detail"); detail.hidden = true;
  const visual = element("details", undefined, "knowledge-graph-visual"); visual.hidden = true;
  visual.append(element("summary", "查看关系图"), canvas, detail);
  copy.append(title, note); head.append(copy, build); card.append(head, status, visual); root.append(card);
  const active = () => !disposed && isCurrent() && card.isConnected;

  // A fixed sequence, so the same graph lays out the same way twice instead of
  // rearranging itself every time someone opens the section.
  const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

  function fit() {
    const ratio = window.devicePixelRatio || 1, width = canvas.clientWidth || 640, height = canvas.clientHeight || 420;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d"); context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width, height, context };
  }

  function place(graph) {
    const { width, height } = fit();
    const byId = new Map();
    nodes = graph.nodes.map((node, index) => {
      const angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
      const item = { ...node, x: width / 2 + Math.cos(angle) * (width / 4) + (random() - 0.5) * 40,
        y: height / 2 + Math.sin(angle) * (height / 4) + (random() - 0.5) * 40, vx: 0, vy: 0,
        radius: Math.max(7, Math.min(26, 7 + Math.sqrt(node.chars || 1) / 6)) };
      byId.set(node.id, item); return item;
    });
    links = graph.links.map((link) => ({ ...link, a: byId.get(link.source), b: byId.get(link.target) })).filter((link) => link.a && link.b);
    const strongest = links.reduce((max, link) => Math.max(max, link.strength), 1);
    for (const link of links) link.weight = link.strength / strongest;
  }

  function step() {
    const { width, height, context } = fit();
    for (let a = 0; a < nodes.length; a += 1) {
      for (let b = a + 1; b < nodes.length; b += 1) {
        const one = nodes[a], two = nodes[b];
        let dx = two.x - one.x, dy = two.y - one.y;
        let distance = Math.hypot(dx, dy);
        // Two nodes exactly on top of each other have no direction to separate
        // in; nudge them apart deterministically instead of dividing by zero.
        if (distance < 0.01) { dx = (random() - 0.5) || 0.01; dy = (random() - 0.5) || 0.01; distance = Math.hypot(dx, dy); }
        const force = REPULSION / (distance * distance);
        const fx = (dx / distance) * force, fy = (dy / distance) * force;
        one.vx -= fx; one.vy -= fy; two.vx += fx; two.vy += fy;
      }
    }
    for (const link of links) {
      const dx = link.b.x - link.a.x, dy = link.b.y - link.a.y;
      const pull = SPRING * (1 + link.weight * 3);
      link.a.vx += dx * pull; link.a.vy += dy * pull;
      link.b.vx -= dx * pull; link.b.vy -= dy * pull;
    }
    for (const node of nodes) {
      node.vx += (width / 2 - node.x) * CENTER; node.vy += (height / 2 - node.y) * CENTER;
      node.vx *= DAMPING; node.vy *= DAMPING;
      node.vx = Math.max(-MAX_STEP, Math.min(MAX_STEP, node.vx));
      node.vy = Math.max(-MAX_STEP, Math.min(MAX_STEP, node.vy));
      node.x = Math.max(node.radius + 4, Math.min(width - node.radius - 4, node.x + node.vx));
      // The label sits under the node, so the floor has to leave room for it or
      // the bottom row of titles is cut off by the canvas edge.
      node.y = Math.max(node.radius + 4, Math.min(height - node.radius - 20, node.y + node.vy));
    }
    draw(context, width, height);
  }

  // The theme tokens are light-dark() functions, which a canvas cannot parse —
  // assigning one silently leaves the previous colour in place. Resolving them
  // through a probe element hands back a plain rgb() for whichever theme is on.
  const probe = element("span"); probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
  card.append(probe);
  const resolve = (token, fallback) => {
    probe.style.color = ""; probe.style.color = `var(${token})`;
    const value = getComputedStyle(probe).color;
    return value && value !== "rgba(0, 0, 0, 0)" ? value : fallback;
  };
  const styles = () => ({ line: resolve("--line", "#dfe2d9"), text: resolve("--text", "#2d302c"),
    muted: resolve("--muted", "#71766b"), action: resolve("--action", "#30362c"), paper: resolve("--paper", "#fffffd") });

  function draw(context, width, height) {
    const theme = styles(), now = performance.now();
    context.clearRect(0, 0, width, height);
    for (const link of links) {
      context.strokeStyle = theme.line;
      context.globalAlpha = 0.25 + link.weight * 0.5;
      context.lineWidth = 0.6 + link.weight * 2.2;
      context.beginPath(); context.moveTo(link.a.x, link.a.y); context.lineTo(link.b.x, link.b.y); context.stroke();
      // A travelling highlight: signal moving between related documents. Purely
      // decorative, and the reason this reads as a network rather than a mesh.
      const phase = ((now / 2600) + link.weight) % 1;
      context.globalAlpha = 0.5 * link.weight;
      context.fillStyle = theme.action;
      context.beginPath();
      context.arc(link.a.x + (link.b.x - link.a.x) * phase, link.a.y + (link.b.y - link.a.y) * phase, 1.6, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
    for (const node of nodes) {
      const focused = node === hover || node === selected;
      context.beginPath(); context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      context.fillStyle = node.synthesized ? theme.action : theme.paper;
      context.fill();
      context.lineWidth = focused ? 2.5 : 1.2; context.strokeStyle = focused ? theme.text : theme.muted; context.stroke();
    }
    context.fillStyle = theme.text; context.font = "11px -apple-system, system-ui, sans-serif"; context.textAlign = "center";
    for (const node of nodes) {
      if (nodes.length > 26 && node !== hover && node !== selected && node.radius < 12) continue;
      const label = node.title.length > 14 ? `${node.title.slice(0, 13)}…` : node.title;
      context.fillText(label, node.x, node.y + node.radius + 13);
    }
  }

  function loop() { if (!active() || !nodes.length) { frame = null; return; } step(); frame = requestAnimationFrame(loop); }
  function start() { if (frame === null) frame = requestAnimationFrame(loop); }

  const at = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    return nodes.find((node) => Math.hypot(node.x - x, node.y - y) <= node.radius + 4) ?? null;
  };
  canvas.addEventListener("mousemove", (event) => { hover = at(event); canvas.style.cursor = hover ? "pointer" : "default"; });
  canvas.addEventListener("mouseleave", () => { hover = null; });
  canvas.addEventListener("click", (event) => {
    selected = at(event);
    detail.hidden = !selected;
    if (!selected) return;
    detail.replaceChildren(element("strong", selected.title),
      element("small", `版本 ${selected.revision} · ${selected.chars} 字 · ${selected.chunkCount} 段${selected.synthesized ? " · 已归纳" : ""}`),
      element("p", selected.terms.length ? `主题：${selected.terms.slice(0, 8).join("、")}` : "没有与其他文档共有的主题词"));
    const related = links.filter((link) => link.a === selected || link.b === selected)
      .sort((x, y) => y.strength - x.strength).slice(0, 5);
    if (related.length) {
      const list = element("ul");
      for (const link of related) {
        const other = link.a === selected ? link.b : link.a;
        list.append(element("li", `${other.title} — 共有 ${link.shared.join("、")}`));
      }
      detail.append(element("small", "关系最强的文档："), list);
    }
  });

  build.onclick = async () => {
    if (!active()) return;
    build.disabled = true; status.textContent = "正在逐篇重新核验来源权限与版本…";
    try {
      const graph = await api.knowledgeGraph();
      if (!active()) return;
      place(graph);
      visual.hidden = !graph.nodes.length; visual.open = Boolean(graph.nodes.length);
      status.textContent = graph.nodes.length
        ? `已重新核验：${graph.nodes.length} 篇文档 · ${graph.links.length} 条主题关系${graph.unavailable ? ` · ${graph.unavailable} 篇当前不可读，未纳入` : ""}`
        : "知识副本还是空的。在工作任务里打开完整飞书文档，读过的文档会自动进入知识库。";
      detail.hidden = true; selected = null;
      start();
    } catch (cause) {
      if (active()) status.textContent = readableError(cause);
    } finally { if (active()) build.disabled = false; }
  };

  // On entry the section draws what the store already holds — no network, no
  // waiting — and says plainly that it has not been re-checked. Building it
  // afterwards is the verified version, which replaces this one.
  (async () => {
    try {
      const graph = await api.knowledgeGraphSnapshot();
      if (!active() || !graph.nodes.length) { if (active() && !graph.nodes.length) status.textContent = "知识副本还是空的。在工作任务里打开完整飞书文档，读过的文档会自动进入知识库。"; return; }
      place(graph);
      visual.hidden = false;
      const when = graph.observedAt ? new Date(graph.observedAt).toLocaleString("zh-CN") : "";
      status.textContent = `${graph.nodes.length} 篇文档 · ${graph.links.length} 条主题关系 · 来自本机副本${when ? `（最近阅读 ${when}）` : ""}，尚未重新核验权限`;
      start();
    } catch (cause) { if (active()) status.textContent = readableError(cause); }
  })();
  const onResize = () => { if (nodes.length) start(); };
  window.addEventListener("resize", onResize);
  return { dispose() { disposed = true; window.removeEventListener("resize", onResize); if (frame !== null) cancelAnimationFrame(frame); frame = null; card.remove(); } };
}
