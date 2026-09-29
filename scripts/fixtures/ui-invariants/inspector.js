// Watches one launched Electron application against the rules in
// ./page-monitor.js, and adds the one rule the page cannot check by itself:
// a control drawn where a native view (Feishu, a preview, the sign-in page)
// sits on top of it -- how the 知识 menu hid under the Feishu page on
// 2026-09-24 with every smoke green.
//
//   const inspector = inspect(app);   // right after _electron.launch
//   ... drive the application ...
//   await inspector.sample();         // any time; also every 1.5 s and on each screenshot
//   inspector.findings                // [{ kind, where, detail, phase, count }]
import path from "node:path";
import { installMonitor } from "./page-monitor.js";

export const RENDERER = /\/renderer\/index\.html(?:[?#].*)?$/;
const key = (row) => `${row.kind}|${row.where}|${row.detail ?? ""}`;
// What the page says rather than how it is laid out: text a person has read is
// read, however soon it changes, so it needs no second look.
const SAID = new Set(["内部标识外露", "英文"]);

// 退出太慢: closing the application, from whatever state a smoke left it in,
// took longer than this. A card left waiting once held the quit for its whole
// five-minute timeout (2026-09-25).
const SLOW_CLOSE_MS = 15_000;

export function inspect(app, { every = 1500, slowClose = SLOW_CLOSE_MS, found = new Map(), stats = { launches: 0, pages: 0, samples: 0, installed: 0 } } = {}) {
  stats.launches += 1;
  const pages = new Set(), looking = new Map();
  let phase = "";
  const record = (row) => {
    const existing = found.get(key(row));
    if (existing) { existing.count += 1; return; }
    found.set(key(row), { ...row, phase, count: 1 });
  };
  const attach = (page) => {
    if (pages.has(page)) return;
    pages.add(page);
    stats.pages += 1;
    page.addInitScript(installMonitor).catch(() => {});
    page.evaluate(installMonitor).then(() => page.evaluate(() => Boolean(window.__uiInv))).then((ok) => { if (ok) stats.installed += 1; }).catch(() => {});
    page.on("close", () => pages.delete(page));
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) page.evaluate(installMonitor).catch(() => {}); });
    // A screenshot is a smoke saying "this is a state worth keeping": check it.
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async (options = {}) => {
      if (options.path) phase = path.basename(options.path);
      await sample(page, { checkpoint: true }).catch(() => {});
      return screenshot(options);
    };
  };
  for (const page of app.windows()) attach(page);
  app.on("window", attach);

  const views = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed() && /\/renderer\/index\.html/.test(win.webContents.getURL()))
    .flatMap((win) => win.contentView.children.map((view) => {
      const bounds = view.getBounds();
      const url = view.webContents && !view.webContents.isDestroyed() ? view.webContents.getURL() : "";
      return { ...bounds, visible: (typeof view.getVisible !== "function" || view.getVisible()) && bounds.width > 0 && bounds.height > 0, url: url.slice(0, 60) };
    }))).catch(() => []);

  const probe = async (page) => {
    if (page.isClosed() || !RENDERER.test(page.url())) return { events: [], checks: [] };
    const dom = await page.evaluate(() => window.__uiInv?.sample() ?? null).catch(() => null);
    if (!dom) return { events: [], checks: [] };
    stats.samples += 1;
    const covered = [];
    for (const view of (await views()).filter((row) => row.visible)) {
      const host = dom.hosts.find((row) => Math.abs(row.left - view.x) <= 2 && Math.abs(row.top - view.y) <= 2
        && Math.abs(row.right - (view.x + view.width)) <= 2 && Math.abs(row.bottom - (view.y + view.height)) <= 2);
      for (const row of dom.rows) {
        const width = Math.min(row.right, view.x + view.width) - Math.max(row.left, view.x);
        const height = Math.min(row.bottom, view.y + view.height) - Math.max(row.top, view.y);
        if (width > 2 && height > 2) covered.push({ kind: "被原生页面盖住", where: row.where, detail: `${host ? `#${host.id}` : "不在任何占位区域上的原生视图"} ${view.url.replace(/[?#].*$/, "")} @${view.x},${view.y} ${view.width}×${view.height}` });
      }
    }
    return { events: dom.events, checks: [...dom.checks, ...covered] };
  };

  // A layout finding must hold on a second look: menus animate and cards slide
  // in, and a frame caught mid-transition is not a fault.
  const look = async (page) => {
    const first = await probe(page);
    for (const row of first.events) record(row);
    const layout = first.checks.filter((row) => !SAID.has(row.kind));
    for (const row of first.checks) if (SAID.has(row.kind)) record(row);
    if (!layout.length) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await probe(page);
    for (const row of second.events) record(row);
    const again = new Set(second.checks.map(key));
    for (const row of layout) if (again.has(key(row))) record(row);
  };
  // The timer skips a look while one is under way. A checkpoint -- a
  // screenshot, an explicit sample, the close -- waits for it and takes its
  // own: it is a state the smoke said was worth keeping, and skipping it let a
  // chat ID on a page go unseen (2026-09-25).
  const sample = async (page, { checkpoint = false } = {}) => {
    while (looking.has(page)) {
      if (!checkpoint) return;
      await looking.get(page).catch(() => {});
    }
    const current = look(page);
    looking.set(page, current);
    try { await current; } finally { if (looking.get(page) === current) looking.delete(page); }
  };

  const timer = every ? setInterval(() => { for (const page of pages) void sample(page).catch(() => {}); }, every) : null;
  timer?.unref();
  const close = app.close.bind(app);
  app.close = async (...args) => {
    if (timer) clearInterval(timer);
    for (const page of pages) await sample(page, { checkpoint: true }).catch(() => {});
    const began = Date.now();
    try { return await close(...args); }
    finally {
      const took = Date.now() - began;
      if (took > slowClose) record({ kind: "退出太慢", where: "应用", detail: `关闭用了 ${Math.round(took / 1000)} 秒${phase ? `（最后停在 ${phase}）` : ""}` });
    }
  };
  app.on("close", () => { if (timer) clearInterval(timer); });
  return {
    stats,
    get findings() { return [...found.values()]; },
    async sample() { for (const page of pages) await sample(page, { checkpoint: true }); },
  };
}
