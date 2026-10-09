import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { writeTemplate } from "../src/application/site-templates.js";
import { writeContract } from "../src/application/table-contract.js";
import { readBaseSlice } from "../src/application/table-snapshot.js";
import { baseCellText } from "../src/providers/feishu/base-reader.js";
import { SaasBaseRecords } from "../src/providers/feishu/base-records.js";

// What the templates actually do with a real table's worth of field kinds, in a
// real browser. A screenshot says a page rendered; this says the page works:
// people and options are chips, a link is a link, a date is a date, money has
// its separators -- and the table sorts, filters and charts when clicked.
//
// Every kind here is one a Feishu Base really has. They used to render as empty
// columns and raw timestamps, because the contract flattened everything that
// was not a string or a number and dropped the rest.
const FIELDS = [
  { id: "fldName", name: "客户名称", type: "text" },
  { id: "fldOwner", name: "负责人", type: "user" },
  { id: "fldState", name: "状态", type: "single_select" },
  { id: "fldTags", name: "标签", type: "multi_select" },
  { id: "fldDate", name: "签订日期", type: "date" },
  { id: "fldLink", name: "合同", type: "url" },
  { id: "fldPaid", name: "已回款", type: "checkbox" },
  { id: "fldSum", name: "金额（元）", type: "number", style: "currency" },
];
const ROWS = [
  ["北极星科技", [{ name: "张三" }], "进行中", ["重点", "续约"], 1789862400000, { link: "https://example.com/a", text: "查看合同" }, false, 1285000],
  ["长风物流", [{ name: "李四" }, { name: "王五" }], "已回款", ["新签"], 1787270400000, { link: "https://example.com/b", text: "查看合同" }, true, 620000],
  ["海生医疗", [{ name: "赵六" }], "进行中", [], 1790467200000, null, false, 3157500],
  ["青木设计", [], "待签", ["小额"], 1791072000000, { link: "https://example.com/d", text: "查看合同" }, false, 248000],
];

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-template-render-"));
let instance = null;
try {
  const records = {
    fields: async () => FIELDS,
    list: async () => ({ records: ROWS.map((row, index) => ({ id: `rec${index}`,
      values: Object.fromEntries(FIELDS.map((field, at) => [field.id, row[at]])) })), more: false }),
  };
  const { schema, snapshot } = await readBaseSlice(
    { kind: "base", token: "bascnSyntheticTok", tableId: "tblOne", fields: FIELDS.map((field) => field.id), rows: 100, refreshSeconds: 60 },
    records, { renderCell: (value) => baseCellText(value), title: "客户合同台账" });
  assert.deepEqual(schema.fields.map((field) => field.kind),
    ["text", "people", "option", "options", "date", "link", "boolean", "number"], "契约要带上字段的含义");

  const made = [];
  for (const id of ["dashboard", "directory"]) {
    const folder = path.join(directory, id);
    await mkdir(folder);
    await writeTemplate(folder, id);
    await writeContract(folder, { schema, snapshot });
    made.push({ id, file: path.join(folder, "index.html") });
  }
  await writeFile(path.join(directory, "entry.cjs"), `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => { const win = new BrowserWindow({ width: 1200, height: 900, useContentSize: true, show: false });
  await win.loadFile(${JSON.stringify(made[0].file)}); });
app.on("window-all-closed", () => {});`);
  instance = await electron.launch({ executablePath: electronBinary, args: [path.join(directory, "entry.cjs")], timeout: 30_000 });
  const window = await instance.firstWindow(); // 生成的网页，不是 i豆 的窗口
  window.setDefaultTimeout(15_000);
  const failures = [];
  window.on("pageerror", (error) => failures.push(error.message));

  // ---- 表格看板 ----------------------------------------------------------
  await window.goto(`file://${made[0].file}`);
  await window.locator("#rows tr").first().waitFor();
  const cellAt = (row, column) => window.locator(`#rows tr:nth-child(${row}) td:nth-child(${column})`);
  assert.deepEqual(await cellAt(1, 2).locator(".cell-person").allInnerTexts(), ["张三"], "人员画成名字");
  assert.deepEqual(await cellAt(2, 2).locator(".cell-person").allInnerTexts(), ["李四", "王五"]);
  assert.deepEqual(await cellAt(1, 3).locator(".cell-chip").allInnerTexts(), ["进行中"], "单选画成标签");
  assert.deepEqual(await cellAt(1, 4).locator(".cell-chip").allInnerTexts(), ["重点", "续约"], "多选画成多个标签");
  assert.equal(await cellAt(1, 5).innerText(), "2026/9/20", "日期不是时间戳");
  const link = cellAt(1, 6).locator("a");
  assert.equal(await link.getAttribute("href"), "https://example.com/a");
  assert.equal(await link.getAttribute("rel"), "noreferrer noopener");
  assert.equal(await cellAt(3, 6).innerText(), "—", "没有链接就是一横，不是空白");
  assert.equal(await cellAt(1, 7).innerText(), "否");
  assert.equal(await cellAt(2, 7).innerText(), "是");
  assert.equal(await cellAt(1, 8).innerText(), "1,285,000.00", "金额有千分位和两位小数");

  // 汇总、图表、筛选、排序：点下去才算数。
  assert.match(await window.locator("#tiles .tile").nth(1).innerText(), /5,310,500/);
  const chart = window.locator("#chart");
  assert.equal(await chart.isVisible(), true, "有分类和数字就该有图");
  assert.match(await chart.locator(".chart-title").innerText(), /状态 · 金额/);
  assert.deepEqual(await chart.locator(".bar-label").allInnerTexts(), ["进行中", "已回款", "待签"], "按合计从大到小");
  assert.deepEqual(await chart.locator(".bar-value").allInnerTexts(), ["4,442,500", "620,000", "248,000"]);

  const names = () => window.locator("#rows tr td:nth-child(1)").allInnerTexts();
  assert.deepEqual(await names(), ["北极星科技", "长风物流", "海生医疗", "青木设计"], "默认是表里的顺序");
  await window.locator("#head-row th:nth-child(8) .sort").click();
  assert.deepEqual(await names(), ["青木设计", "长风物流", "北极星科技", "海生医疗"], "按金额从小到大");
  await window.locator("#head-row th:nth-child(8) .sort").click();
  assert.deepEqual(await names(), ["海生医疗", "北极星科技", "长风物流", "青木设计"], "再点一次反过来");
  await window.locator("#head-row th:nth-child(8) .sort").click();
  assert.deepEqual(await names(), ["北极星科技", "长风物流", "海生医疗", "青木设计"], "第三次取消排序");

  await window.locator(".facet-chip", { hasText: "进行中" }).click();
  assert.deepEqual(await names(), ["北极星科技", "海生医疗"], "按分类筛");
  assert.equal(await window.locator("#count").innerText(), "2 / 4 条");
  assert.deepEqual(await chart.locator(".bar-label").allInnerTexts(), ["进行中"], "图跟着筛选走");
  await window.locator("#q").fill("海生");
  // A search waits for the typing to pause before it draws (thousands of rows, 2026-10-04).
  await window.waitForFunction(() => document.getElementById("count")?.textContent === "1 / 4 条", null, { polling: 50, timeout: 5_000 });
  assert.deepEqual(await names(), ["海生医疗"], "搜索和筛选叠加");
  await window.locator("#q").fill("");
  await window.locator(".facet-chip", { hasText: "全部" }).click();
  assert.deepEqual(await names(), ["北极星科技", "长风物流", "海生医疗", "青木设计"]);

  // ---- 名单查询 ----------------------------------------------------------
  await window.goto(`file://${made[1].file}`);
  await window.locator(".card").first().waitFor();
  assert.equal(await window.locator(".card h2").first().innerText(), "北极星科技");
  assert.deepEqual(await window.locator(".card").first().locator(".cell-person").allInnerTexts(), ["张三"]);
  assert.deepEqual(await window.locator(".card").first().locator(".cell-chip").allInnerTexts(), ["进行中", "重点", "续约"]);
  assert.equal(await window.locator(".card").first().locator("a").getAttribute("href"), "https://example.com/a");
  // 名单查询和表格看板现在用同一套类名（styles/VOCABULARY.md）：一个风格能同时
  // 认得五个场景，靠的就是这个。
  assert.deepEqual(await window.locator(".facet-chip").allInnerTexts(), ["全部", "已回款", "待签", "进行中"], "分类取自单选那一列");
  await window.locator(".facet-chip", { hasText: "已回款" }).click();
  assert.deepEqual(await window.locator(".card h2").allInnerTexts(), ["长风物流"]);

  // ---- 分类选哪一列：真实表里有空行的样子 ----------------------------------
  // 这一段的形状来自真实账号上跑出来的画面：那张表有几条记录和几行空行，客户名称
  // 那一列的取值数因此小于总行数，旧规则就让它当上了分类——标签栏一个客户一个标签，
  // 图表一个客户一根柱子。
  //
  // 这里三列都是纯文本，**没有单选字段可以靠**：能把「名称」挡掉的只剩那一条规则
  // 本身——有值的每一行都各不相同的列是名字，不是分类。名称的取值数还比状态少，
  // 所以「取值越少越好筛」这个偏好在这里是帮倒忙的，挡不住它。
  const FLAT = [{ id: "fldWho", name: "客户", type: "text" }, { id: "fldState", name: "状态", type: "text" },
    { id: "fldSum", name: "金额", type: "number" }];
  const FLAT_ROWS = [
    ["北极星科技", "进行中", 10], ["长风物流", "已回款", 20], ["海生医疗", "待签", 30],
    ["青木设计", "已流失", 40], ["云岭能源", "待续约", 50],
    ["", "进行中", 60],   // 名字没填，状态填了
    ["", "", 70],         // 两个都没填
  ];
  const flat = await readBaseSlice(
    { kind: "base", token: "bascnSyntheticTok", tableId: "tblFlat", fields: FLAT.map((field) => field.id), rows: 100, refreshSeconds: 60 },
    { fields: async () => FLAT,
      list: async () => ({ records: FLAT_ROWS.map((row, index) => ({ id: `flat${index}`,
        values: Object.fromEntries(FLAT.map((field, at) => [field.id, row[at]])) })), more: false }) },
    { renderCell: (value) => baseCellText(value), title: "有空行的台账" });
  const flatFolder = path.join(directory, "flat");
  await mkdir(flatFolder);
  await writeTemplate(flatFolder, "dashboard");
  await writeContract(flatFolder, { schema: flat.schema, snapshot: flat.snapshot });
  await window.goto(`file://${path.join(flatFolder, "index.html")}`);
  await window.locator("#rows tr").first().waitFor();
  assert.equal(await window.locator("#rows tr").count(), 7, "空行也是行，别悄悄丢掉");
  assert.deepEqual(await window.locator(".facet-chip").allInnerTexts(),
    ["全部", "已回款", "已流失", "待签", "待续约", "进行中"], "分类选在了客户那一列——那是名字，不是分类");
  assert.match(await window.locator("#chart .chart-title").innerText(), /^状态 · 金额$/);
  // 未填写那一撮合计 70，和「进行中」并列最高；它仍然要排在最后。
  assert.deepEqual(await window.locator("#chart .bar-label").allInnerTexts(),
    ["进行中", "待续约", "已流失", "待签", "已回款", "未填写"]);
  assert.deepEqual(await window.locator("#chart .bar-value").allInnerTexts(), ["70", "50", "40", "30", "20", "70"]);

  // ---- 真实表格的每一种字段 -----------------------------------------------
  // 从真实多维表格录下的形状（test/fixtures/base-field-shapes.json）：31 个字段，
  // 一样一个。10-06 之前这张表在看板里每列被挤成一两个字宽、一行 225 像素高，
  // 合计里把占比加了起来，时间线挑中「创建时间」——三十条全落在同一天。
  const shapes = JSON.parse(await readFile(new URL("../test/fixtures/base-field-shapes.json", import.meta.url), "utf8"));
  const answer = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const recorded = new SaasBaseRecords({ id: "saas-cli", async invoke(argv) {
    if (argv.includes("+field-list")) return answer(shapes.fieldList);
    if (argv.includes("+record-list")) return answer({ ...shapes.recordList, has_more: false });
    if (argv.includes("+table-list")) return answer(shapes.tableList);
    if (argv.includes("+table-get")) return answer(argv[argv.indexOf("--table-id") + 1] === "tblShapeProjects" ? shapes.linkedTableGet : shapes.tableGet);
    if (argv.includes("+view-get-visible-fields")) return answer(shapes.visibleFields);
    if (argv.includes("+record-get")) {
      const wanted = argv.flatMap((value, index) => argv[index - 1] === "--record-id" ? [value] : []);
      return answer({ ...shapes.linkedRecordGet, record_id_list: wanted, data: wanted.map((id) => shapes.linkedRecordGet.data[shapes.linkedRecordGet.record_id_list.indexOf(id)]) });
    }
    throw new Error(`没有录过：${argv.join(" ")}`);
  } });
  const every = await readBaseSlice({ kind: "base", token: "bascnShapeTypes01", tableId: "tblShapeMain", fields: shapes.fieldList.fields.map((field) => field.id), rows: 100, refreshSeconds: 60 },
    recorded, { renderCell: (value) => baseCellText(value), title: "全部字段类型" });
  for (const id of ["dashboard", "timeline"]) {
    const folder = path.join(directory, `every-${id}`);
    await mkdir(folder);
    await writeTemplate(folder, id);
    await writeContract(folder, { schema: every.schema, snapshot: every.snapshot });
  }
  await window.goto(`file://${path.join(directory, "every-dashboard", "index.html")}`);
  await window.locator("#rows tr").first().waitFor();
  const heights = await window.locator("#rows tr").evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
  assert.ok(Math.max(...heights) < 80, `31 列的表一行一格，不换行：最高 ${Math.max(...heights)} 像素`);
  assert.equal(await window.locator("#head-row th").first().innerText(), "名称", "列按表里的顺序，主字段在最前");
  const tiles = await window.locator("#tiles .tile span").allInnerTexts();
  assert.ok(!tiles.some((label) => /占比|完成度/.test(label)), `百分比不进合计：${tiles.join("、")}`);
  assert.ok(tiles.some((label) => /金额/.test(label)), "金额照样合计");
  const column = async (name) => (await window.locator("#head-row th").allInnerTexts()).findIndex((label) => label.trim() === name) + 1;
  assert.equal(await window.locator(`#rows tr:nth-child(4) td:nth-child(${await column("占比")})`).innerText(), "30%");
  assert.equal(await window.locator(`#rows tr:nth-child(1) td:nth-child(${await column("官网")}) a`).getAttribute("href"), "https://example.com/beiji");
  assert.deepEqual(await window.locator(`#rows tr:nth-child(1) td:nth-child(${await column("关联项目")}) .cell-chip`).allInnerTexts(), ["北极星迁移（改名）", "远山官网"]);
  assert.equal(await window.locator(`#rows tr:nth-child(7) td:nth-child(${await column("数量")})`).innerText(), "—", "空的数字不是 0");
  await window.goto(`file://${path.join(directory, "every-timeline", "index.html")}`);
  await window.locator(".event").first().waitFor();
  const deadline = every.schema.fields.find((field) => field.name === "截止日期").id;
  const days = new Set(every.snapshot.rows.map((row) => row.values[deadline].value).filter(Boolean).map((at) => new Date(at).toLocaleDateString("zh-CN")));
  const when = new Set(await window.locator(".event-when").allInnerTexts());
  assert.ok([...days].every((day) => when.has(day)), `时间线按人填的截止日期排，不是创建时间：${[...when].slice(0, 3).join("、")}`);
  // 创建时间排在前面的表（字段顺序由人定）：时间线也不该挑它。
  const SYSTEM_FIRST = [{ id: "fldName", name: "事项", type: "text" }, { id: "fldMade", name: "创建时间", type: "created_at" }, { id: "fldDue", name: "截止日期", type: "datetime" }];
  const systemFirst = await readBaseSlice({ kind: "base", token: "bascnSyntheticTok", tableId: "tblDue", fields: SYSTEM_FIRST.map((field) => field.id), rows: 10, refreshSeconds: 60 },
    { fields: async () => SYSTEM_FIRST, list: async () => ({ more: false, records: [["交付一期", "2026-03-01T00:00:00.000+08:00"], ["验收", "2026-05-20T00:00:00.000+08:00"]].map(([name, due], index) => ({
      id: `recDue${index}`, values: { fldName: name, fldMade: "2026-10-06T09:56:57.000+08:00", fldDue: due } })) }) },
    { renderCell: (value) => baseCellText(value), title: "交付计划" });
  const systemFolder = path.join(directory, "system-first");
  await mkdir(systemFolder);
  await writeTemplate(systemFolder, "timeline");
  await writeContract(systemFolder, systemFirst);
  await window.goto(`file://${path.join(systemFolder, "index.html")}`);
  await window.locator(".event").first().waitFor();
  assert.deepEqual((await window.locator(".event-when").allInnerTexts()).sort(), [new Date("2026-03-01T00:00:00+08:00"), new Date("2026-05-20T00:00:00+08:00")].map((at) => at.toLocaleDateString("zh-CN")).sort(),
    "创建时间是系统记的，一批建的都在同一天");

  assert.deepEqual(failures, [], "模版页面报错了");
  console.log(JSON.stringify({ passed: true, kinds: schema.fields.length, sorted: true, filtered: true, charted: true, facetSkipsNames: true, recordedKinds: every.schema.fields.length, paidCalls: 0 }));
} finally {
  await instance?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
