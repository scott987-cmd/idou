// Every template this build ships, published and opened the way a visitor
// opens it: sandboxed, under a capability, its data the latest the server
// holds (docs/sites-phase0.md §0.1–§0.2). A page that worked from a folder and
// broke once published -- storage it could not reach, a path that left its
// capability -- would be what most visitors meet first.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { createSiteServer, siteCookieKey } from "../src/control-plane/site-server.js";
import { appHash } from "../src/apps/manifest.js";
import { SITE_TEMPLATES, SITE_STYLES, DEFAULT_STYLE, templateFiles } from "../src/application/site-templates.js";
import { contractFiles } from "../src/application/table-contract.js";
import { readBaseSlice } from "../src/application/table-snapshot.js";
import { SAMPLE_FIELDS, SAMPLE_ROWS, SAMPLE_SLICE, SAMPLE_TITLE, sampleRecords } from "../src/application/site-sample.js";

const pack = (files) => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html",
    files: [...files].map(([file, bytes]) => ({ path: file, bytes: Buffer.byteLength(bytes), sha256: appHash(Buffer.from(bytes)) })) },
  blobs: [...files].map(([file, bytes]) => ({ path: file, base64: Buffer.from(bytes).toString("base64") })),
});
// The sample table with its first client renamed: what the table says after publishing.
const renamed = () => ({
  fields: async () => SAMPLE_FIELDS.map((field) => ({ ...field })),
  list: async () => ({ records: SAMPLE_ROWS.map((row, index) => ({ id: `rec${index}`,
    values: Object.fromEntries(SAMPLE_FIELDS.map((field, at) => [field.id, index === 0 && at === 0 ? "北极星科技（已更名）" : row[at]])) })), more: false }),
});

test("every template, published, opens sandboxed without an error and follows its table", { timeout: 240_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-site-templates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const cookieKey = await siteCookieKey(root);
  const server = createSiteServer({ registry, origin: "http://127.0.0.1", cookieKey });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const payload = Buffer.from(JSON.stringify({ u: "ou_viewer", t: "t1", e: Date.now() + 3_600_000 })).toString("base64url");
  await context.addCookies([{ name: "idou_site", value: `${payload}.${createHmac("sha256", cookieKey).update(payload).digest("base64url")}`, url: base }]);
  const sample = await readBaseSlice(SAMPLE_SLICE, sampleRecords(), { title: SAMPLE_TITLE });
  const later = await readBaseSlice(SAMPLE_SLICE, renamed(), { title: SAMPLE_TITLE });
  assert.notEqual(later.snapshot.digest, sample.snapshot.digest);

  const opened = [];
  for (const template of SITE_TEMPLATES) {
    for (const style of template.styled ? SITE_STYLES.map((item) => item.id) : [DEFAULT_STYLE]) {
      const files = new Map((await templateFiles(template.id, style)).map((file) => [file.name, file.bytes]));
      if (template.table) for (const [name, bytes] of contractFiles(sample)) files.set(name, bytes);
      const site = await registry.publish({ ownerId: "ou_owner", tenantId: "t1", name: `${template.name}-${style}`, share: { scope: "tenant" },
        ...(template.table ? { source: { kind: "base", token: SAMPLE_SLICE.token, tableId: SAMPLE_SLICE.tableId } } : {}), ...pack(files) });
      if (template.table) await registry.putData(site.id, sample);
      const page = await context.newPage();
      const problems = [];
      page.on("pageerror", (error) => problems.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") problems.push(message.text()); });
      await page.goto(`${base}/s/${site.id}/`);
      await page.waitForLoadState("networkidle");
      const label = `${template.id}-${style}`;
      assert.match(page.url(), /\/~/, `${label}: under a capability`);
      assert.deepEqual(problems, [], `${label}: ${problems.join(" | ")}`);
      if (template.table) {
        await page.waitForFunction(() => document.body.innerText.includes("北极星科技"), null, { timeout: 10_000, polling: 100 });
        // The table changes while it is open: the page follows. One page at a
        // time: each holds a change stream, and over plain HTTP/1.1 a browser
        // opens at most six connections to one host (production is HTTP/2).
        await registry.putData(site.id, later);
        server.notifySite(site.id);
        await page.waitForFunction(() => document.body.innerText.includes("北极星科技（已更名）"), null, { timeout: 15_000, polling: 200 })
          .catch(() => assert.fail(`${label}: did not follow its table`));
        opened.push(label);
        await page.close();
      } else {
        assert.ok((await page.locator("body").innerText()).trim().length > 0 || template.id === "blank", `${label}: shows something`);
        await page.close();
      }
    }
  }
  assert.ok(opened.length >= 10, `${opened.length} table pages opened`);
});

// Found 2026-10-04 (a table site of thousands of rows loading slowly): every
// template drew every row at once -- a hundred thousand elements for 5000 rows
// -- and drew them all again on each keystroke. Now a page at a time.
test("a table of hundreds of rows is drawn a page at a time, and 显示更多 draws the next", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-site-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registry = await SiteRegistry.open(root);
  const cookieKey = await siteCookieKey(root);
  const server = createSiteServer({ registry, origin: "http://127.0.0.1", cookieKey });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections?.(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const payload = Buffer.from(JSON.stringify({ u: "ou_viewer", t: "t1", e: Date.now() + 3_600_000 })).toString("base64url");
  await context.addCookies([{ name: "idou_site", value: `${payload}.${createHmac("sha256", cookieKey).update(payload).digest("base64url")}`, url: base }]);
  const fields = [{ id: "f1", name: "客户", kind: "text", type: "text" }, { id: "f2", name: "状态", kind: "option", type: "single_select" },
    { id: "f3", name: "签约日期", kind: "date", type: "date" }, { id: "f4", name: "金额", kind: "number", type: "number" }];
  const states = ["待跟进", "方案中", "已签约"];
  const rows = Array.from({ length: 250 }, (_, n) => ({ id: `r${n}`, values: {
    f1: { kind: "text", text: `客户${n}`, value: `客户${n}` }, f2: { kind: "option", text: states[n % 3], value: states[n % 3] },
    f3: { kind: "date", text: "", value: Date.UTC(2026, 0, 1) + n * 86_400_000 }, f4: { kind: "number", text: String(n), value: n } } }));
  const data = { schema: { version: 1, fields, rows: { limit: 250, truncated: false }, refreshSeconds: 60 }, snapshot: { rows, rowCount: 250, digest: "p250", readAt: Date.now() } };
  const expect = { dashboard: ["#rows tr", 100], directory: ["#cards .card", 60], timeline: [".event", 100] };
  for (const template of ["dashboard", "directory", "timeline", "kanban"]) {
    const files = new Map((await templateFiles(template, DEFAULT_STYLE)).map((file) => [file.name, file.bytes]));
    for (const [name, bytes] of contractFiles(data)) files.set(name, bytes);
    const site = await registry.publish({ ownerId: "ou_owner", tenantId: "t1", name: `${template}-pages`, share: { scope: "tenant" },
      source: { kind: "base", token: SAMPLE_SLICE.token, tableId: SAMPLE_SLICE.tableId }, ...pack(files) });
    await registry.putData(site.id, data);
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (error) => problems.push(error.message));
    await page.goto(`${base}/s/${site.id}/`);
    if (template === "kanban") {
      await page.locator(".column").first().waitFor();
      // 250 cards in three columns of 84, 83, 83: thirty each, and the rest a button away.
      assert.deepEqual(await page.locator(".column").evaluateAll((columns) => columns.map((column) => column.querySelectorAll(".ticket").length)), [30, 30, 30]);
      await page.locator(".column .more").first().click();
      assert.equal(await page.locator(".column").first().locator(".ticket").count(), 60, "the next thirty of that column");
    } else {
      const [selector, size] = expect[template];
      await page.locator(selector).first().waitFor();
      assert.equal(await page.locator(selector).count(), size, `${template}: the first page`);
      const more = page.locator(".more");
      assert.match(await more.innerText(), new RegExp(`还有 ${250 - size} 条`));
      await more.click();
      assert.equal(await page.locator(selector).count(), Math.min(250, size * 2), `${template}: the next page`);
      // A search starts from the first page of what it found.
      await page.locator('input[type="search"], .search input').first().fill("客户1");
      await page.waitForFunction((count) => /\/ 250/.test(document.getElementById("count")?.textContent ?? ""), null, { timeout: 5_000, polling: 50 });
      assert.ok(await page.locator(selector).count() <= size, `${template}: a search shows its first page`);
    }
    assert.deepEqual(problems, [], `${template}: ${problems.join(" | ")}`);
    await page.close();
  }
});
