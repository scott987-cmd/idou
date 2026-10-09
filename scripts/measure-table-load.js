// How long a table site takes to open, by part, in Chromium against a real site
// server: bytes on the wire, time to the first rows, elements on the page, and
// one search. Rows are invented; the limits a desktop would apply are passed
// over on purpose, to see what a page does with more.
//
//   node scripts/measure-table-load.js 5000,20000 dashboard,directory,kanban,timeline
//
// Numbers from 2026-10-04 are in docs/sites-phase1.md §1.7.
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { createSiteServer, siteCookieKey } from "../src/control-plane/site-server.js";
import { appHash } from "../src/apps/manifest.js";
import { templateFiles } from "../src/application/site-templates.js";
import { contractFiles } from "../src/application/table-contract.js";

const sizes = (process.argv[2] ?? "5000").split(",").map(Number);
const templates = (process.argv[3] ?? "dashboard,directory,kanban,timeline").split(",");
const FIELDS = [
  ["f01", "客户", "text"], ["f02", "负责人", "people"], ["f03", "状态", "option"], ["f04", "区域", "option"], ["f05", "金额", "number"],
  ["f06", "数量", "number"], ["f07", "签约日期", "date"], ["f08", "行业", "option"], ["f09", "备注", "text"], ["f10", "标签", "options"],
  ["f11", "官网", "link"], ["f12", "评分", "number"],
];
const pick = (list, n) => list[n % list.length];
function table(count) {
  const fields = FIELDS.map(([id, name, kind]) => ({ id, name, kind, type: kind }));
  const rows = [];
  for (let n = 0; n < count; n += 1) {
    const at = Date.UTC(2026, 0, 1) + (n % 365) * 86400000;
    rows.push({ id: `rec${n}`, values: {
      f01: { kind: "text", text: `客户${n} 科技有限公司`, value: `客户${n} 科技有限公司` },
      f02: { kind: "people", text: pick(["张伟", "李娜", "王芳", "刘洋"], n), items: [pick(["张伟", "李娜", "王芳", "刘洋"], n)] },
      f03: { kind: "option", text: pick(["待跟进", "方案中", "已签约", "已流失"], n), value: pick(["待跟进", "方案中", "已签约", "已流失"], n) },
      f04: { kind: "option", text: pick(["华东", "华南", "华北", "西南", "西北"], n), value: pick(["华东", "华南", "华北", "西南", "西北"], n) },
      f05: { kind: "number", text: String((n * 37) % 100000), value: (n * 37) % 100000 },
      f06: { kind: "number", text: String(n % 50), value: n % 50 },
      f07: { kind: "date", text: new Date(at).toISOString().slice(0, 10), value: at },
      f08: { kind: "option", text: pick(["制造", "零售", "教育", "金融", "物流"], n), value: pick(["制造", "零售", "教育", "金融", "物流"], n) },
      f09: { kind: "text", text: `第 ${n} 条备注：需要在下周确认报价和交付时间`, value: `第 ${n} 条备注：需要在下周确认报价和交付时间` },
      f10: { kind: "options", text: "重点, 续约", items: ["重点", "续约"] },
      f11: { kind: "link", text: `https://example.com/c/${n}`, href: `https://example.com/c/${n}` },
      f12: { kind: "number", text: String(n % 5), value: n % 5 },
    } });
  }
  return { schema: { version: 1, fields, rows: { limit: count, truncated: false }, refreshSeconds: 60 }, snapshot: { rows, rowCount: count, readAt: Date.now(), digest: `d${count}`, truncated: false } };
}
const pack = (files) => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html",
    files: [...files].map(([file, bytes]) => ({ path: file, bytes: Buffer.byteLength(bytes), sha256: appHash(Buffer.from(bytes)) })) },
  blobs: [...files].map(([file, bytes]) => ({ path: file, base64: Buffer.from(bytes).toString("base64") })),
});

const root = await mkdtemp(path.join(os.tmpdir(), "idou-measure-"));
const registry = await SiteRegistry.open(root);
const cookieKey = await siteCookieKey(root);
const server = createSiteServer({ registry, origin: "http://127.0.0.1", cookieKey });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext();
const payload = Buffer.from(JSON.stringify({ u: "ou_viewer", t: "t1", e: Date.now() + 3_600_000 })).toString("base64url");
await context.addCookies([{ name: "idou_site", value: `${payload}.${createHmac("sha256", cookieKey).update(payload).digest("base64url")}`, url: base }]);
const results = [];
try {
  for (const count of sizes) {
    const data = table(count);
    for (const template of templates) {
      const files = new Map((await templateFiles(template, "clean")).map((file) => [file.name, file.bytes]));
      for (const [name, bytes] of contractFiles({ schema: data.schema, snapshot: { ...data.snapshot, rows: data.snapshot.rows.slice(0, 2) } })) files.set(name, bytes);
      const site = await registry.publish({ ownerId: "ou_owner", tenantId: "t1", name: `${template}-${count}`, share: { scope: "tenant" },
        source: { kind: "base", token: "bascnMeasure0001", tableId: "tblMeasure" }, ...pack(files) });
      // Past today's limits on purpose, to see what the page does with them.
      await registry.storage.putData(site.id, Buffer.from(JSON.stringify(data)));
      const page = await context.newPage();
      let dataBytes = 0, dataMs = 0;
      page.on("response", async (response) => {
        if (response.url().endsWith("data/table-data.js")) {
          const sizes = await response.request().sizes().catch(() => ({ responseBodySize: 0 }));
          dataBytes = sizes.responseBodySize; const timing = response.request().timing(); dataMs = Math.round(timing.responseEnd);
        }
      });
      const started = Date.now();
      await page.goto(`${base}/s/${site.id}/`, { waitUntil: "load", timeout: 120_000 });
      const ready = { dashboard: "#rows tr", directory: ".card", kanban: ".ticket", timeline: ".event" }[template];
      await page.waitForSelector(ready, { timeout: 120_000 });
      const shown = Date.now() - started;
      const nodes = await page.evaluate(() => document.getElementsByTagName("*").length);
      // One search keystroke, as a visitor types.
      const typed = await page.evaluate(async () => {
        const input = document.querySelector('input[type="search"], .search input');
        const count = document.getElementById("count");
        if (!input || !count) return null;
        const before = count.textContent, t0 = performance.now();
        input.value = "客户1"; input.dispatchEvent(new Event("input", { bubbles: true }));
        while (count.textContent === before && performance.now() - t0 < 10000) await new Promise((resolve) => setTimeout(resolve, 5));
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        return Math.round(performance.now() - t0);
      });
      results.push({ count, template, dataKB: Math.round(dataBytes / 1024), dataMs, shownMs: shown, domNodes: nodes, searchMs: typed });
      await page.close();
    }
  }
} finally {
  console.log(JSON.stringify(results, null, 1));
  await browser.close(); server.close(); server.closeAllConnections?.();
  await rm(root, { recursive: true, force: true });
}
