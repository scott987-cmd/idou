// 文档网站, against this machine's real Feishu account and two real tables.
// Reads only: it never creates, writes or deletes anything in the account.
//
//   node scripts/acceptance-sites-live.js --resources <file.json>
//
// The file names a real Base and a real spreadsheet of about 3,000 rows
// (`siteBase`, `siteSheet`; scripts/fixtures/live-resources.js).
//
// What it proves that the synthetic smoke cannot: that a real Base's field
// types and a real spreadsheet's header row come back the way table-slice.js
// expects, that paging a real 3,000-row sheet stops where the slice says, that
// every value in the contract matches an independent read of the same table,
// and that a plain static page built on the contract renders those values in a
// real browser.
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { resolveFeishuProvider } from "../src/providers/feishu/provider-registry.js";
import { TableSites } from "../src/application/table-sites.js";
import { snapshotChanged } from "../src/application/table-snapshot.js";
import { baseCellText } from "../src/providers/feishu/base-reader.js";
import { writeTemplate } from "../src/application/site-templates.js";
import { liveResources } from "./fixtures/live-resources.js";

const BINARY = path.resolve("resources/lark-cli/darwin-arm64/lark-cli");
const { siteBase: BASE_URL, siteSheet: SHEET_URL } = liveResources(["siteBase", "siteSheet"]);
const evidence = path.resolve("docs/evidence");

const cli = (args) => new Promise((resolve, reject) => {
  const child = spawn(BINARY, [...args, "--as", "user", "--format", "json"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });
  child.on("exit", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${args.join(" ")} 失败：${err.slice(0, 300)}`)));
});

const provider = resolveFeishuProvider();
// `environment` is what the application always passes: it puts the identity
// check on /open-apis/authen/v1/user_info, which reports the tenant. Without it
// the check falls back to `auth status`, which does not -- and a spreadsheet
// read then refuses for want of a tenant key. Measured on this account.
const feishu = provider.client.create({ binary: BINARY, environment: () => ({}) });
const sites = new TableSites({ baseRecords: feishu.baseRecords, sheets: feishu.sheets, references: provider.references,
  links: provider.links, identity: (options) => feishu.documentIdentity(options),
  renderCell: (value) => baseCellText(value) });
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-sites-live-"));
const report = {};

try {
  await mkdir(evidence, { recursive: true });

  // ---- A real Base ---------------------------------------------------------
  const base = await sites.describe(BASE_URL);
  report.base = { title: base.title, fields: base.fields.map((field) => `${field.name}:${field.type}`) };
  assert.equal(base.kind, "base");
  assert.ok(base.fields.length >= 2, "这张表至少要有两个字段才值得当样例");

  const folder = path.join(directory, "base-site");
  await mkdir(folder);
  const chosen = base.fields.slice(0, 3);
  const built = await sites.build(folder, { kind: "base", token: base.token, tableId: base.tableId,
    fields: chosen.map((field) => field.id), rows: 100, refreshSeconds: 60 });
  report.baseBuilt = { rows: built.rowCount, truncated: built.truncated, fields: built.fields };

  // Independently: the same table, read again through the CLI, not through us.
  const raw = await cli(["base", "+record-list", "--base-token", base.token, "--table-id", base.tableId, "--limit", "200"]);
  assert.equal(built.rowCount, raw.data.record_id_list.length, "行数与独立读取不一致");
  const snapshot = JSON.parse((await readFile(path.join(folder, "data", "table-data.js"), "utf8")).replace(/^globalThis\.__IDOU_TABLE__ = globalThis\.__MYDOUBAO_TABLE__ = /, "").replace(/;\n$/, ""));
  const column = Object.fromEntries(raw.data.field_id_list.map((id, index) => [id, index]));
  let compared = 0;
  for (const [index, recordId] of raw.data.record_id_list.entries()) {
    const row = snapshot.snapshot.rows.find((item) => item.id === recordId);
    assert.ok(row, `独立读到的记录 ${recordId} 不在快照里`);
    for (const field of chosen) {
      const upstream = raw.data.data[index][column[field.id]];
      const expected = upstream === null || upstream === undefined ? "" : typeof upstream === "object" ? null : String(upstream);
      if (expected === null) continue;  // people, attachments and the like are rendered, not compared here
      assert.equal(row.values[field.id].text, expected, `${recordId} 的「${field.name}」与独立读取不一致`);
      compared += 1;
    }
  }
  report.baseCellsCompared = compared;
  assert.ok(compared > 0, "没有比对到任何一个格子");

  // A field nobody picked is nowhere in what was written.
  const dropped = base.fields.find((field) => !chosen.some((item) => item.id === field.id));
  if (dropped) {
    const text = await readFile(path.join(folder, "data", "table-data.js"), "utf8");
    assert.equal(text.includes(dropped.id), false, "没选的字段出现在了契约里");
    report.droppedField = dropped.name;
  }

  // Read again: nothing changed upstream, so the probe says nothing changed.
  const again = await sites.build(folder, { kind: "base", token: base.token, tableId: base.tableId,
    fields: chosen.map((field) => field.id), rows: 100, refreshSeconds: 60 });
  const second = JSON.parse((await readFile(path.join(folder, "data", "table-data.js"), "utf8")).replace(/^globalThis\.__IDOU_TABLE__ = globalThis\.__MYDOUBAO_TABLE__ = /, "").replace(/;\n$/, ""));
  assert.equal(snapshotChanged(snapshot.snapshot, second.snapshot), false, "同样的数据读两次，摘要却变了");
  assert.notEqual(built.readAt, again.readAt, "两次读取的时间应当不同");
  report.digestStable = true;

  // ---- A real spreadsheet, at a size worth calling scale -------------------
  const sheet = await sites.describe(SHEET_URL);
  report.sheet = { title: sheet.title, columns: sheet.fields.map((field) => `${field.id}:${field.name}`) };
  assert.equal(sheet.kind, "sheet");
  const sheetFolder = path.join(directory, "sheet-site");
  await mkdir(sheetFolder);
  const columns = sheet.fields.slice(0, 3).map((field) => field.id);
  const sheetBuilt = await sites.build(sheetFolder, { kind: "sheet", token: sheet.token, sheetId: sheet.sheetId,
    origin: sheet.origin, columns, headerRow: 1, rows: 500, refreshSeconds: 300 });
  report.sheetBuilt = { rows: sheetBuilt.rowCount, truncated: sheetBuilt.truncated, fields: sheetBuilt.fields };
  assert.ok(sheetBuilt.rowCount > 0, "一行都没读到");
  assert.ok(sheetBuilt.rowCount <= 500, "读回来的行数超过了切片上限");

  // ---- A static page, in a real browser ------------------------------------
  const page = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>真实数据验收</title>
<style>body{font:14px/1.6 system-ui;margin:24px;color:#1b1b1b}table{border-collapse:collapse}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
h1{font-size:18px}small{color:#666}</style></head><body>
<h1 id="title"></h1><p><small id="meta"></small></p><table><thead><tr id="head"></tr></thead><tbody id="body"></tbody></table>
<script src="data/table-data.js"></script><script src="data/table.js"></script>
<script>
  var fields = Table.fields();
  document.getElementById("title").textContent = "真实多维表格：" + fields.map(function (f) { return f.name; }).join(" / ");
  document.getElementById("meta").textContent = Table.rowCount() + " 行 · 上次读取 " + Table.readAt().toLocaleString("zh-CN");
  var head = document.getElementById("head");
  fields.forEach(function (field) { var th = document.createElement("th"); th.textContent = field.name; head.appendChild(th); });
  var body = document.getElementById("body");
  Table.rows().forEach(function (row) {
    var tr = document.createElement("tr");
    fields.forEach(function (field) { var td = document.createElement("td"); td.textContent = row.text(field.name); tr.appendChild(td); });
    body.appendChild(tr);
  });
</script></body></html>`;
  await writeFile(path.join(folder, "index.html"), page);
  const rendered = await renderInElectron(path.join(folder, "index.html"), path.join(evidence, "sites-live-page.png"));
  report.rendered = rendered.text.slice(0, 200);
  // Every value the contract holds is on the page, as text.
  for (const row of snapshot.snapshot.rows) {
    for (const field of chosen) {
      const text = row.values[field.id].text;
      if (text) assert.ok(rendered.text.includes(text), `页面上没有出现「${text}」`);
    }
  }
  assert.equal(rendered.pwned, false, "页面执行了表格里的内容");
  report.pageRows = rendered.rows;
  assert.equal(rendered.rows, built.rowCount);

  // ---- And the page a person actually gets ---------------------------------
  // The bare page above proves the contract keeps every value. This proves the
  // product: the real 表格看板 template, on the same real table, rendered and
  // photographed. Looking at that picture is the only way to judge the thing
  // the user called low quality -- an assertion cannot see a layout.
  const productFolder = path.join(directory, "dashboard");
  await mkdir(productFolder);
  await writeTemplate(productFolder, "dashboard");
  await sites.build(productFolder, { kind: "base", token: base.token, tableId: base.tableId,
    fields: chosen.map((field) => field.id), rows: 100, refreshSeconds: 60 }, { title: base.title });
  const product = await renderTemplate(path.join(productFolder, "index.html"), path.join(evidence, "sites-live-dashboard.png"));
  report.dashboard = { rows: product.rows, chips: product.chips, people: product.people, links: product.links, chart: product.chart };
  assert.equal(product.rows, built.rowCount, "看板画出来的行数和读到的不一致");
  // No cell may still be showing a raw timestamp: that was the bug the user saw.
  assert.equal(/\b1[0-9]{12}\b/.test(product.text), false, "页面上还有没格式化的时间戳");
  assert.equal(product.pwned, false, "看板执行了表格里的内容");

  console.log(JSON.stringify({ passed: true, ...report }, null, 1));
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// A real Chromium, which is what a person opening the file gets.
async function renderInElectron(file, screenshot) {
  const { _electron: electron } = await import("playwright");
  const electronBinary = (await import("electron")).default;
  // Not in the site's own folder: that folder is a publishable version.
  const entry = path.join(await mkdtemp(path.join(os.tmpdir(), "idou-live-render-")), "electron-entry.cjs");
  await writeFile(entry, `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => { const win = new BrowserWindow({ width: 900, height: 700, show: false }); await win.loadFile(${JSON.stringify(file)}); global.__win = win; });
app.on("window-all-closed", () => {});`);
  const instance = await electron.launch({ executablePath: electronBinary, args: [entry], timeout: 30_000 });
  try {
    const window = await instance.firstWindow();
    await window.locator("#body tr").first().waitFor({ timeout: 15_000 });
    await window.screenshot({ path: screenshot, scale: "css" });
    return {
      text: await window.locator("body").innerText(),
      rows: await window.locator("#body tr").count(),
      pwned: await window.evaluate(() => Boolean(window.__pwned)),
    };
  } finally { await instance.close(); }
}

// The same, for a template page: what is asked of it is what the template
// promises -- typed cells drawn as chips, people and real links, and a chart.
async function renderTemplate(file, screenshot) {
  const { _electron: electron } = await import("playwright");
  const electronBinary = (await import("electron")).default;
  const entry = path.join(await mkdtemp(path.join(os.tmpdir(), "idou-live-product-")), "electron-entry.cjs");
  await writeFile(entry, `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => { const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false }); await win.loadFile(${JSON.stringify(file)}); });
app.on("window-all-closed", () => {});`);
  const instance = await electron.launch({ executablePath: electronBinary, args: [entry], timeout: 30_000 });
  try {
    const window = await instance.firstWindow();
    await window.locator("#rows tr").first().waitFor({ timeout: 15_000 });
    await window.screenshot({ path: screenshot, scale: "css" });
    return {
      rows: await window.locator("#rows tr").count(),
      chips: await window.locator("#rows .cell-chip").count(),
      people: await window.locator("#rows .cell-person").count(),
      links: await window.locator("#rows a[href]").count(),
      chart: await window.locator("#chart").isVisible(),
      text: await window.locator("body").innerText(),
      pwned: await window.evaluate(() => Boolean(window.__pwned)),
    };
  } finally { await instance.close(); }
}
