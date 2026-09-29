import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { answerConfirm, runAgentTool, waitForHumanConfirm } from "./fixtures/agent-harness.js";
import { localEnvFile } from "../src/install-names.js";

// A development control plane with scheduled tasks on, so the list can be seen
// with something in it, and so a task can actually fire.
//
// The operator's own configuration when it is there. Step 9 runs a schedule for
// real and reads the model's answer back out of 运行记录, so a placeholder key
// fails it -- this smoke stopped being a pure UI exercise the moment it started
// waiting for a task to fire. Without the file the first eight steps still run,
// which is the whole value on a machine that has no credentials.
const LIVE = localEnvFile();
const live = existsSync(LIVE) && process.env.IDOU_SMOKE_NO_LIVE !== "1";

async function controlPlane(dataDir) {
  let minimax = LIVE;
  if (!live) {
    // Enough to get the control plane past its startup check so the section can
    // be drawn; nothing reaches a model, and step 9 is skipped below.
    minimax = path.join(dataDir, "minimax.json");
    await writeFile(minimax, JSON.stringify({ region: "cn", api_key: "smoke-placeholder-not-a-real-key" }), { mode: 0o600 });
  }
  const child = spawn(process.execPath, ["bin/server.js", "--dev"], { cwd: process.cwd(),
    // Not the default 8443: it is a popular port and something else may well be
    // on it, which is exactly why the port is configurable at all.
    env: { ...process.env, MINIMAX_CONFIG_FILE: minimax, IDOU_SCHEDULED_TASKS: "1",
      IDOU_SCHEDULED_TASKS_PORT: "8452", IDOU_SCHEDULED_TASKS_DIR: path.join(dataDir, "scheduled") },
    stdio: ["ignore", "pipe", "pipe"] });
  const sessionFile = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the control plane did not report a session file:\n${out}`)), 30_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const found = out.match(/Client connection file: (.+)/);
      if (found) { clearTimeout(timer); resolve(found[1].trim()); }
    });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`the control plane exited (${code}):\n${out}`)); });
    // Rejecting here never assigns `server`, so the finally below has nothing to
    // shut down and the child would keep the port -- which is then what the next
    // run fails on, pointing at a port conflict rather than at what went wrong.
  }).catch((error) => { child.kill("SIGTERM"); throw error; });
  console.log(`  · control plane up, session file ${sessionFile}`);
  return { child, sessionFile };
}

// 定时任务 is a first-class section, the way it is in the two products people
// already use. What this checks is the half that needs no control plane: that
// the section is reachable, that it draws where a person can see it, and that
// creating one asks for exactly what the reference dialog asks for.
//
// Boxes, not DOM presence. A control pushed outside the window, or behind
// another, still answers a DOM query perfectly happily -- this product has been
// fooled by exactly that before.
// Under $HOME: colima mounts only /Users/$USER into its Linux VM, so a
// /var/folders path does not exist from the daemon's side and every container
// refuses to start. Hit four times now.
const directory = await mkdtemp(path.join(os.homedir(), ".idou-schedules-"));
// A calendar day, where this computer is, the way a date field holds it.
const dayFromToday = (days) => {
  const day = new Date(); day.setDate(day.getDate() + days);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
};
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app;
let server;

// Sent and forgotten, a signal proves nothing: a control plane that outlives its
// run holds port 8452, and the next run then fails on a port conflict that says
// nothing about what is actually wrong. So wait for the exit, and stop asking
// nicely if it does not come.
const stop = async (child) => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited.finally(() => clearTimeout(forced));
};

// A box, measured again if the element was replaced while being measured. The
// section redraws whole on every load -- once for 读取中… and once with the
// answer -- and a handle taken before the second redraw measures a detached
// node as null. That failed this smoke intermittently for a list that was on
// screen the whole time, and was misread once as a signing fault. Something
// that never gets a box still fails.
const visible = async (locator, what) => {
  const deadline = Date.now() + 5_000;
  let box = null;
  while (!(box && box.width > 0 && box.height > 0) && Date.now() < deadline) {
    await locator.waitFor({ state: "visible", timeout: Math.max(deadline - Date.now(), 1) }).catch(() => {});
    box = await locator.boundingBox().catch(() => null);
    if (!(box && box.width > 0 && box.height > 0)) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(box && box.width > 0 && box.height > 0, `${what} has no box on screen`);
  return box;
};

// A task row's actions wait for the pointer, as in the reference product (G13):
// hover, then press. Its 更多 menu holds 暂停/恢复, 修改资源 and 删除; the row
// itself opens the task's page (G12). Clicked on its name, clear of the buttons.
let page;
const taskRow = (name) => page.locator(".schedule-task-row", { hasText: name }).first();
async function rowAction(name, label) {
  const row = taskRow(name);
  await row.hover();
  await row.locator(".schedule-row-actions button", { hasText: label }).click();
}
async function rowMenu(name, label) {
  const row = taskRow(name);
  await row.hover();
  await row.locator(".schedule-more > summary").click();
  await row.locator(".schedule-menu button", { hasText: label }).click();
}
async function openTask(name) {
  await taskRow(name).locator(".schedule-title").click();
  await page.locator(".schedule-detail-page").waitFor();
}

try {
  // Inside the try, so that a control plane which starts and then fails to come
  // up is still shut down and its directory still removed. Started outside, the
  // very first failure leaked both -- and the leaked port is what the next run
  // reported, which sent the search in the wrong direction entirely.
  server = await controlPlane(directory);
  const env = { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"),
    IDOU_SESSION_FILE: server.sessionFile };
  console.log("  · launching the app …");
  // Through an entry that exposes the Agent bridge, so step 8f can run the real
  // bin/agent.js with a task's environment; the application is otherwise as-is.
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/schedules-desktop-entry.js")], env, timeout: 30_000 });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  console.log("  · app window ready");
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();

  // 1. The section is in the sidebar, beside the others, not behind a setting.
  const tab = page.locator('[data-section="schedules"]');
  const tabBox = await visible(tab, "the 定时任务 sidebar item");
  const window = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(tabBox.x >= 0 && tabBox.y >= 0 && tabBox.x + tabBox.width <= window.width,
    `the sidebar item is off screen: ${JSON.stringify(tabBox)}`);
  assert.equal((await tab.innerText()).includes("定时任务"), true);

  // 2. Opening it draws the section. There is no control plane here, so the
  //    list request fails -- and the panel must still be there, with the error
  //    said out loud, rather than a blank page.
  await tab.click();
  const toolbar = page.locator(".schedule-toolbar");
  await toolbar.waitFor();
  await visible(toolbar, "the toolbar");
  for (const [selector, what] of [[".schedule-tab", "the tabs"], [".schedule-add", "添加定时任务"], [".schedule-from-template", "从模板添加"]]) {
    await visible(page.locator(selector).first(), what);
  }
  const tabs = await page.locator(".schedule-tab").allInnerTexts();
  assert.deepEqual(tabs.map((text) => text.trim()), ["定时任务", "运行记录"], "both tabs, in that order");
  // The top bar names the page and nothing more. There is no conversation here,
  // so no title and no divider -- the reference top bar shows neither, and for
  // days this page read 「定时任务 / 从一个想法开始」.
  assert.equal((await page.locator("#section-title").innerText()).trim(), "定时任务");
  assert.equal(await page.locator("#task-title").isVisible(), false, "no placeholder title on a page without a conversation");
  assert.equal(await page.locator(".toolbar .divider").isVisible(), false, "and no divider beside nothing");
  await visible(page.locator(".schedule-list"), "the list area");
  // The banner is where a main-process failure surfaces, and the first version
  // of this section raised `clientSession is not defined` into it while every
  // other check here still passed. Only the screenshot caught it.
  // Not "the banner is empty": with no control plane configured it correctly
  // says so, and that is the honest state rather than a defect. What must not
  // appear there is a programming error.
  const banner = page.locator("#error-banner");
  const complaint = (await banner.count()) && await banner.isVisible() ? (await banner.innerText()).trim() : "";
  assert.doesNotMatch(complaint, /ReferenceError|TypeError|is not defined|undefined|\bnull\b/,
    `the app is reporting a programming error: ${complaint}`);
  // With no control plane there is nothing to list, and the empty state is what
  // a person should meet -- not a blank panel and not a stack trace.
  assert.match(await page.locator(".schedule-list").innerText(), /还没有定时任务|读取中/);

  // 2b. Under the empty list, the templates, as the reference product shows its
  //     定时任务模版. One fills the dialog in -- name, words, rule and the kind of
  //     resource it reads -- and leaves which one to the person.
  await page.locator(".schedule-template").first().waitFor();
  assert.deepEqual(await page.locator(".schedule-template strong").allInnerTexts(),
    ["群消息每日要点", "每周工作周报", "数据表每日摘要", "到期待办提醒", "客户反馈归纳", "月度复盘"]);
  await page.locator('.schedule-template[data-template="chat-digest"] button').click();
  const fromTemplate = page.locator("dialog.schedule-dialog");
  await visible(fromTemplate, "the dialog a template opens");
  assert.equal((await fromTemplate.locator("h3").innerText()).trim(), "添加定时任务");
  assert.equal(await fromTemplate.locator('.schedule-field input[type="text"], .schedule-field input:not([type])').first().inputValue(), "群消息每日要点");
  assert.match(await fromTemplate.locator(".schedule-field textarea").first().inputValue(), /需要我回复或跟进/);
  assert.equal(await fromTemplate.locator(".schedule-frequency").inputValue(), "workday");
  assert.equal(await fromTemplate.locator(".schedule-timing input[type=time]").first().inputValue(), "09:00");
  assert.equal(await fromTemplate.locator(".schedule-resource-kind").inputValue(), "chat");
  assert.match(await fromTemplate.locator(".schedule-template-hint").innerText(), /要读会话/);
  await page.screenshot({ path: path.join(evidence, "desktop-schedule-template.png") });
  await fromTemplate.locator(".schedule-dialog-actions button", { hasText: "取消" }).click();
  await fromTemplate.waitFor({ state: "detached" });

  // 3. Creating asks for what the reference dialog asks for, and the timing
  //    controls follow the chosen frequency rather than all showing at once.
  await page.locator(".schedule-add").click();
  const dialog = page.locator("dialog.schedule-dialog");
  await dialog.waitFor();
  await visible(dialog, "the create dialog");
  const fields = await dialog.locator(".schedule-field > span").allInnerTexts();
  for (const label of ["名称", "提示词", "执行频率", "有效期", "任务类型", "可访问的飞书资源"]) {
    assert.ok(fields.some((text) => text.includes(label)), `the dialog asks for ${label}; it showed ${JSON.stringify(fields)}`);
  }
  await visible(dialog.locator(".schedule-resource-picker"), "the visual resource picker");
  assert.deepEqual((await dialog.locator(".schedule-resource-kind option").allInnerTexts()).map(text => text.trim()), ["文档", "电子表格", "多维表格", "会话"]);

  // Captured in the state a person first meets it -- 每天, the common case --
  // rather than after the frequency switching below has moved it around.
  await page.screenshot({ path: path.join(evidence, "desktop-schedules.png") });
  // 有效期 as WorkBuddy has it (G17): 开始日期 and 结束日期, neither before
  // today, and the end never before the start.
  const startDate = dialog.locator(".schedule-start-date"), endDate = dialog.locator(".schedule-end-date");
  await visible(startDate, "开始日期"); await visible(endDate, "结束日期");
  assert.match((await dialog.locator(".schedule-validity").innerText()).replace(/\s+/g, " "), /开始日期.*结束日期/);
  assert.equal(await startDate.getAttribute("min"), dayFromToday(0));
  await startDate.fill(dayFromToday(5));
  assert.equal(await endDate.getAttribute("min"), dayFromToday(5), "the end follows the start");
  await startDate.fill("");
  await startDate.dispatchEvent("change");
  assert.equal(await endDate.getAttribute("min"), dayFromToday(0), "and lets go of it");

  // Exactly the rules this server says it will create -- the reference
  // toolbar's list, now that .30 (the build this one rolls back to) runs 双周,
  // 每年 and 按间隔 as well.
  const frequency = dialog.locator(".schedule-frequency");
  assert.deepEqual((await frequency.locator("option").allInnerTexts()).map((text) => text.trim()),
    ["每天", "每个工作日", "每周", "双周", "每月", "每年", "按间隔", "单次"], "the frequencies this server creates");

  const weekdays = dialog.locator(".schedule-weekdays");
  assert.equal(await weekdays.isVisible(), false, "weekday pickers stay hidden until 每周 is chosen");
  await frequency.selectOption("weekly");
  await visible(weekdays, "the weekday pickers");
  assert.equal(await dialog.locator(".schedule-weekday").count(), 7);
  await frequency.selectOption("once");
  assert.equal(await weekdays.isVisible(), false, "and go away again");
  await visible(dialog.locator('input[type="datetime-local"]'), "the one-off moment picker");
  // 按间隔 shows its window and step, starts on Monday to Friday, and says it costs.
  await frequency.selectOption("interval");
  await visible(dialog.locator(".schedule-interval"), "the interval window and step");
  await visible(weekdays, "its days");
  assert.deepEqual(await dialog.locator(".schedule-weekday input:checked").evaluateAll((nodes) => nodes.map((node) => node.value)), ["1", "2", "3", "4", "5"]);
  assert.match(await dialog.locator("p.schedule-when", { hasText: "费用" }).innerText(), /间隔越短费用越高/);
  // 每年 asks for the month; 每个工作日 asks for no days at all.
  await frequency.selectOption("yearly");
  await visible(dialog.locator(".schedule-month"), "the month");
  assert.equal(await dialog.locator(".schedule-interval").isVisible(), false);
  await frequency.selectOption("workday");
  assert.equal(await weekdays.isVisible(), false, "每个工作日 is the days already");

  // 4. Create one for real, through the dialog, and see it in the list. Until
  //    now only the empty state had ever been looked at.
  await frequency.selectOption("daily");
  await dialog.locator('.schedule-field input[type="text"], .schedule-field input:not([type])').first().fill("每天早上的 AI 早报");
  await dialog.locator(".schedule-field textarea").first().fill("把昨天的群消息汇总成三条要点。");
  await dialog.locator(".schedule-resource-kind").selectOption("chat");
  await dialog.locator(".schedule-resource-manual").fill("oc_ScheduleFixture123");
  await dialog.locator(".schedule-resource-add").click();
  // A chat typed in by its ID reads as unnamed, the ID's end telling it apart;
  // the whole ID is on hover, not on a screen a person shares or records.
  assert.match(await dialog.locator(".schedule-resource-selected").innerText(), /会话 · （没有名称 · …e123）/);
  assert.equal(await dialog.locator(".schedule-resource-chip span").first().getAttribute("title"), "oc_ScheduleFixture123");
  // 参考上一次的结果 (G4): offered, and on for a new task, as decided.
  await visible(dialog.locator(".schedule-memory"), "the 参考上一次的结果 option");
  assert.equal(await dialog.locator(".schedule-memory input").isChecked(), true, "on for a new task");
  await dialog.locator(".schedule-dialog-actions button.primary").click();

  // A row as the reference product draws it (G13): name and rule on the left,
  // when it runs next on the right, as a relative time, and under 当前 (G14).
  const row = page.locator(".schedule-task-row").first();
  await row.waitFor();
  await visible(row, "the schedule row");
  const rowText = (await row.innerText()).replace(/\s+/g, " ");
  assert.match(rowText, /每天早上的 AI 早报/);
  assert.match(rowText, /每天 09:00/, `the row says the rule the way a person wrote it: ${rowText}`);
  assert.match(rowText, /(\d+(分钟|小时|天)后|即将)执行/, `and when it next runs, the way the reference product says it: ${rowText}`);
  assert.match((await page.locator(".schedule-group-head").allInnerTexts()).join("|"), /当前 1/, "under 当前");
  await visible(page.locator(".schedule-group-head", { hasText: "当前" }), "the 当前 group heading");
  // Its actions come up on hover, in the status's place.
  assert.equal(await row.locator(".schedule-row-actions").isVisible(), false, "actions wait for the pointer");
  await row.hover();
  await visible(row.locator(".schedule-run-now"), "▶ 立即运行 on hover");
  await visible(row.locator(".schedule-more > summary"), "更多 on hover");
  await page.screenshot({ path: path.join(evidence, "desktop-schedules-row-hover.png") });

  // The row opens the task (G12): back to 定时任务 and its name at the top,
  // 立即运行 / 删除 / 取消 / 保存, its form, what it may read, its own 运行历史.
  await openTask("每天早上的 AI 早报");
  const detail = page.locator(".schedule-detail-page");
  assert.equal((await detail.locator(".schedule-detail-title").innerText()).trim(), "每天早上的 AI 早报");
  assert.deepEqual((await detail.locator(".schedule-detail-actions button").allInnerTexts()).map((text) => text.trim()), ["立即运行", "删除", "取消", "保存"]);
  const grantText = (await detail.locator(".schedule-detail-grant").innerText()).replace(/\s+/g, " ");
  assert.match(grantText, /授权 v1/, `the current resource grant revision: ${grantText}`);
  assert.match(grantText, /可访问 1 个指定飞书资源/, `the exact selected resource count: ${grantText}`);
  assert.match(grantText, /模型最多 12 次 · 参考上次结果/, `the model budget its one resource earns, and that it consults its last result: ${grantText}`);
  assert.match(grantText, /会话 · （没有名称 · …e123）/);
  assert.equal(await detail.locator(".schedule-detail-resources li").first().getAttribute("title"), "oc_ScheduleFixture123");
  assert.match((await detail.locator(".schedule-detail-history").innerText()).replace(/\s+/g, " "), /运行历史 \(0\).*还没有运行记录/);
  await page.screenshot({ path: path.join(evidence, "desktop-schedule-detail.png") });
  // Replacing resources preserves the task but signs a new grant. The visible
  // revision is the user's proof that an old run cannot keep the new scope.
  await detail.locator(".schedule-detail-grant button", { hasText: "修改资源" }).click();
  const resourceDialog = page.locator("dialog.schedule-resource-dialog");
  await visible(resourceDialog, "the resource replacement dialog");
  assert.match(await resourceDialog.locator(".schedule-resource-selected").innerText(), /…e123/);
  await resourceDialog.locator(".schedule-resource-chip button", { hasText: "移除" }).click();
  await resourceDialog.locator(".schedule-resource-kind").selectOption("chat");
  await resourceDialog.locator(".schedule-resource-manual").fill("oc_ScheduleFixture456");
  await resourceDialog.locator(".schedule-resource-add").click();
  await resourceDialog.locator(".schedule-dialog-actions button.primary").click();
  await resourceDialog.waitFor({ state: "detached" });
  await page.locator(".schedule-detail-grant", { hasText: "授权 v2" }).waitFor();
  const replacedText = (await page.locator(".schedule-detail-grant").innerText()).replace(/\s+/g, " ");
  assert.match(replacedText, /授权 v2/, `resource replacement creates a new revision: ${replacedText}`);
  assert.match(replacedText, /会话 · （没有名称 · …e456）/);
  assert.equal(await page.locator(".schedule-detail-grant .schedule-detail-resources li").first().getAttribute("title"), "oc_ScheduleFixture456");
  // Without a Feishu login nothing can run, and the banner is what says so.
  await visible(page.locator(".schedule-banner"), "the authorization banner");
  // Two different bargains, two different sentences. "关闭应用即失效" belongs to
  // the session-scoped button alone: said as a blanket claim it became false the
  // moment unattended runs existed, and it is the line a person would rely on.
  // A development server has the unattended feature off, so only the first is
  // offered here -- and that absence is worth asserting too.
  const bannerText = (await page.locator(".schedule-banner").innerText()).replace(/\s+/g, " ");
  assert.doesNotMatch(bannerText, /关闭应用即失效/, `the blanket claim is gone from the banner: ${bannerText}`);
  await visible(page.locator(".schedule-banner button", { hasText: "本次登录内授权" }), "the session-scoped authorize button");
  assert.equal(await page.locator(".schedule-banner button", { hasText: "允许无人值守运行" }).count(), 0,
    "a development server does not offer what it cannot do");
  await page.screenshot({ path: path.join(evidence, "desktop-schedules-list.png") });

  // 4b. The detail page is the edit surface, filled in with what the task is;
  //     保存 changes it in place -- the reference products edit rather than make
  //     you delete and recreate. What it may read is not part of this form.
  const editTitle = detail.locator('.schedule-field input[type="text"], .schedule-field input:not([type])').first();
  assert.equal(await editTitle.inputValue(), "每天早上的 AI 早报", "the page opens on the task as it is");
  assert.equal(await detail.locator(".schedule-resource-picker").count(), 0, "resources are 修改资源's to change, not this form's");
  await editTitle.fill("每天早上的 AI 早报（已编辑）");
  await detail.locator(".schedule-detail-actions button", { hasText: "保存" }).click();
  await page.locator(".schedule-detail-title", { hasText: "每天早上的 AI 早报（已编辑）" }).waitFor();
  assert.match((await page.locator(".schedule-detail-grant").innerText()).replace(/\s+/g, " "), /授权 v2/, "an edit keeps the grant it had");
  await page.locator(".schedule-detail-back").click();
  await page.locator(".schedule-task-row", { hasText: "每天早上的 AI 早报（已编辑）" }).waitFor();

  // 4c. 立即运行 asks the server for one run now. Nothing is authorized yet, so
  //     the answer is no -- said on the spot, in words for this path (a due
  //     run's refusal says the task was suspended, which this never does), and
  //     not written into the history: step 8 still finds 运行记录 empty.
  await rowAction("每天早上的 AI 早报", "立即运行");
  await page.waitForFunction(() => /没有可用的授权，这次没有运行/.test(document.querySelector("#error-banner")?.innerText ?? ""),
    null, { timeout: 15_000 });
  const refusal = await page.locator("#error-banner").innerText();
  assert.doesNotMatch(refusal, /已暂停/, `a run now suspends nothing, and does not say it did: ${refusal}`);
  assert.doesNotMatch((await page.locator(".schedule-task-row").first().innerText()).replace(/\s+/g, " "), /已挂起/, "and the row is as it was");

  // 4d. 每个工作日 made through the dialog is stored as 每周 on Monday to Friday
  //     and reads back as what was chosen. Paused at once: with a live login it
  //     would otherwise run, paid, the next working morning.
  await page.locator(".schedule-add").click();
  await frequency.selectOption("workday");
  await dialog.locator('.schedule-field input[type="text"], .schedule-field input:not([type])').first().fill("工作日早会纪要");
  await dialog.locator(".schedule-field textarea").first().fill("把早会群里的讨论整理成待办。");
  await dialog.locator(".schedule-timing input[type=time]").first().fill("09:30");
  // Starting two weeks from today (G17): its first run waits for that day.
  await dialog.locator(".schedule-start-date").fill(dayFromToday(14));
  await dialog.locator(".schedule-resource-kind").selectOption("chat");
  await dialog.locator(".schedule-resource-manual").fill("oc_ScheduleFixture789");
  await dialog.locator(".schedule-resource-add").click();
  await dialog.locator(".schedule-dialog-actions button.primary").click();
  const workdayRow = page.locator(".schedule-task-row", { hasText: "工作日早会纪要" });
  await workdayRow.waitFor();
  const workdayText = (await workdayRow.innerText()).replace(/\s+/g, " ");
  assert.match(workdayText, /每个工作日 09:30/);
  const waits = Number(workdayText.match(/(\d+)天后执行/)?.[1]);
  assert.ok(waits >= 13 && waits <= 17, `the first run is on or after its start day, two weeks out: ${workdayText}`);
  await openTask("工作日早会纪要");
  assert.equal(await page.locator(".schedule-detail-page .schedule-start-date").inputValue(), dayFromToday(14), "and its page shows the day it starts");
  await page.locator(".schedule-detail-back").click();
  await workdayRow.waitFor();
  await rowMenu("工作日早会纪要", "暂停");
  await page.locator(".schedule-task-row", { hasText: "工作日早会纪要" }).filter({ hasText: "已暂停" }).waitFor();
  // A paused task moves under 已暂停 (G14).
  await page.locator(".schedule-group-head", { hasText: "已暂停 1" }).waitFor();

  // 4f. 按间隔 made through the dialog reads back the way it was meant, and is
  //     paused at once: with a live login it would otherwise run, paid, every
  //     two hours of a working day this smoke happens to run in.
  await page.locator(".schedule-add").click();
  await frequency.selectOption("interval");
  await dialog.locator('.schedule-field input[type="text"], .schedule-field input:not([type])').first().fill("工作时间群消息巡检");
  await dialog.locator(".schedule-field textarea").first().fill("看看群里有没有需要我回复的消息。");
  await dialog.locator(".schedule-timing input[type=time]").first().fill("09:00");
  await dialog.locator(".schedule-interval input[type=time]").fill("18:00");
  await dialog.locator(".schedule-interval input[type=number]").fill("2");
  await dialog.locator(".schedule-resource-kind").selectOption("chat");
  await dialog.locator(".schedule-resource-manual").fill("oc_ScheduleFixture790");
  await dialog.locator(".schedule-resource-add").click();
  await dialog.locator(".schedule-dialog-actions button.primary").click();
  const intervalRow = page.locator(".schedule-task-row", { hasText: "工作时间群消息巡检" });
  await intervalRow.waitFor();
  assert.match((await intervalRow.innerText()).replace(/\s+/g, " "), /每个工作日 09:00–18:00，每 2 小时一次/);
  await rowMenu("工作时间群消息巡检", "暂停");
  await page.locator(".schedule-task-row", { hasText: "工作时间群消息巡检" }).filter({ hasText: "已暂停" }).waitFor();

  // 4e. With tasks in the list, the templates are one click from the toolbar,
  //     and one click back.
  await page.locator(".schedule-from-template").click();
  await page.locator(".schedule-templates-head", { hasText: "定时任务模板" }).waitFor();
  assert.equal(await page.locator(".schedule-template").count(), 6);
  await page.locator(".schedule-templates-head button", { hasText: "返回列表" }).click();
  await page.locator(".schedule-task-row", { hasText: "每天早上的 AI 早报" }).waitFor();

  // 5. Pausing is one click, and the row says so rather than only the server.
  // By name: once there are two tasks, which one is listed first depends on the
  // hour this smoke runs at.
  const morning = page.locator(".schedule-task-row", { hasText: "每天早上的 AI 早报" });
  await rowMenu("每天早上的 AI 早报", "暂停");
  await morning.filter({ hasText: "已暂停" }).waitFor();

  // 6. Search narrows the list without a round trip, the way the reference
  //    toolbar does. Typed one character at a time, because re-fetching per
  //    keystroke is exactly what would throw away the caret.
  const search = page.locator(".schedule-search");
  await visible(search, "the search box");
  await search.pressSequentially("不存在的名字", { delay: 10 });
  await page.locator(".schedule-empty", { hasText: "没有符合的定时任务" }).waitFor();
  await search.fill("早报");
  await page.locator(".schedule-row").first().waitFor();
  assert.equal(await search.inputValue(), "早报", "and the box keeps what was typed");
  await search.fill("");

  // 7. 批量管理 puts a checkbox on each row and the bulk actions above them,
  //    and takes the per-row buttons away while it is on -- two ways to act on
  //    one row at once is how someone pauses one thing and deletes another.
  await page.locator(".schedule-toolbar button", { hasText: "批量管理" }).click();
  await visible(page.locator(".schedule-selection"), "the selection bar");
  await visible(page.locator(".schedule-pick").first(), "the row checkbox");
  assert.equal(await page.locator(".schedule-row-actions").count(), 0, "per-row buttons step aside");
  // A row's own box, then 全选 -- the first box in the bar is 全选, which was
  // the same thing only while the list had one task in it.
  await page.locator(".schedule-pick").first().check();
  assert.match(await page.locator(".schedule-selection").innerText(), /已选 1 项/);
  await page.locator(".schedule-selection input[type=checkbox]").first().check();
  assert.match(await page.locator(".schedule-selection").innerText(), /已选 3 项/);
  await page.screenshot({ path: path.join(evidence, "desktop-schedules-batch.png") });
  await page.locator(".schedule-toolbar button", { hasText: "退出批量" }).click();
  await page.locator(".schedule-task-row .schedule-row-actions").first().waitFor({ state: "attached" });

  // 8. The history is its own tab, and empty here because nothing has run yet.
  await page.locator(".schedule-tab", { hasText: "运行记录" }).click();
  await visible(page.locator(".schedule-list"), "the history list");
  assert.match(await page.locator(".schedule-list").innerText(), /还没有运行记录|读取中/);
  await page.screenshot({ path: path.join(evidence, "desktop-schedules-runs.png") });

  // 8b. 桌面通知 lives in 设置, on unless turned off. The test button asks the
  //     main process for a real system notification -- recorded here instead of
  //     shown -- the switch is kept, and a clicked notice lands on 运行记录.
  await app.evaluate(({ Notification }) => {
    globalThis.__notices = [];
    Notification.prototype.show = function show() { globalThis.__notices.push({ title: this.title, body: this.body }); };
  });
  await page.locator("#settings").click();
  const noticeSwitch = page.locator("#desktop-notifications");
  await visible(noticeSwitch, "the desktop notification switch");
  await page.waitForFunction(() => document.querySelector("#desktop-notifications")?.disabled === false);
  assert.equal(await noticeSwitch.isChecked(), true, "on unless turned off");
  await page.locator("#test-notification").click();
  await page.locator(".notification-note", { hasText: "已发出" }).waitFor();
  assert.deepEqual(await app.evaluate(() => globalThis.__notices), [{ title: "i豆测试通知", body: "看到这条，定时任务跑完时也会这样提醒你。" }]);
  await noticeSwitch.uncheck();
  await page.locator(".notification-note", { hasText: "已关闭" }).waitFor();
  assert.equal((await page.evaluate(() => window.idou.notificationPreferences())).desktop, false, "and the choice is kept");
  await noticeSwitch.check();
  await page.locator(".notification-note", { hasText: "已开启" }).waitFor();
  // 模型: which model a person uses is kept by the server now, and a person who
  // has not picked follows its default -- the first option says so.
  await page.waitForFunction(() => document.querySelectorAll("#model-select option").length >= 2, null, { polling: 200 });
  assert.match((await page.locator("#model-select option").first().innerText()).trim(), /^跟随服务端默认（MiniMax-M3）$/);
  const models = await page.evaluate(() => window.idou.modelOptions());
  assert.equal(models.kept, "server", "the choice is the server's to keep");
  assert.equal(models.choice, null, "following the default");
  assert.equal(models.current, "MiniMax-M3");
  assert.match(await page.locator("#model-select").evaluate((node) => node.parentElement.innerText), /服务端/);
  // 飞书消息 (G9) and WorkBuddy's 测试通知. A development login is not a
  // Feishu account, so the test is refused by the real service before anything
  // is addressed -- and says why. A second press straight after sends nothing.
  await page.locator(".notification-feishu p", { hasText: "只发给你本人" }).waitFor();
  const feishuTest = page.locator("#test-feishu-notification");
  await visible(feishuTest, "测试通知");
  await feishuTest.click();
  await page.locator(".notification-feishu-note", { hasText: "测试通知发送失败：当前是开发登录" }).waitFor();
  await feishuTest.click();
  await page.locator(".notification-feishu-note", { hasText: "请稍等几秒" }).waitFor();
  assert.equal((await feishuTest.innerText()).trim(), "测试通知", "the button is itself again");
  await page.screenshot({ path: path.join(evidence, "desktop-notification-settings.png") });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("idou:open-schedule-runs", { runId: "run-from-a-notice" }));
  await page.locator(".schedule-tab.current", { hasText: "运行记录" }).waitFor();
  await page.locator(".schedule-tab", { hasText: "定时任务" }).click();

  // 8c. One run record at a time, as in WorkBuddy: 归档 moves it into 已归档,
  //     取消归档 brings it back, 删除 takes that record and nothing else, and
  //     the filter narrows the list. A development server never executes, so
  //     two finished runs are written into this smoke's own throwaway store --
  //     labelled as such -- and everything after that goes through the real
  //     service, store and in-app confirmation card.
  const seeded = new DatabaseSync(path.join(directory, "scheduled", "schedules.db"), { timeout: 5_000 });
  const morningTask = seeded.prepare("SELECT tenant, id FROM schedules WHERE title LIKE '每天早上的 AI 早报%'").get();
  const seed = seeded.prepare("INSERT INTO schedule_runs (tenant, schedule_id, id, due_at, started_at, finished_at, outcome, detail) VALUES (?,?,?,?,?,?,?,?)");
  const hourAgo = Date.now() - 3_600_000;
  seed.run(morningTask.tenant, morningTask.id, randomUUID(), hourAgo, hourAgo, hourAgo + 9_000, "failed", "冒烟测试写入的失败记录");
  seed.run(morningTask.tenant, morningTask.id, randomUUID(), hourAgo + 60_000, hourAgo + 60_000, hourAgo + 70_000, "completed", "冒烟测试写入的完成记录");
  seeded.close();
  await page.locator(".schedule-tab", { hasText: "运行记录" }).click();
  const runRows = page.locator(".schedule-list .schedule-row");
  const failedRun = runRows.filter({ hasText: "冒烟测试写入的失败记录" }), completedRun = runRows.filter({ hasText: "冒烟测试写入的完成记录" });
  await failedRun.waitFor();
  assert.equal(await runRows.count(), 2);
  // Under a day heading (G15), each named the way the reference history names
  // it (G16): an ordinary run 成功 or 失败.
  assert.match((await page.locator(".schedule-date-group").first().innerText()).trim(), /^(今天|昨天) ▾$/);
  assert.match(await failedRun.locator(".schedule-outcome").innerText(), /^失败$/);
  assert.match(await completedRun.locator(".schedule-outcome").innerText(), /^成功$/);
  await visible(failedRun.locator("button", { hasText: "归档" }), "a run record's 归档");
  await visible(failedRun.locator("button", { hasText: "删除" }), "a run record's 删除");
  const runFilter = page.locator(".schedule-run-filter");
  assert.deepEqual((await runFilter.locator("option").allInnerTexts()).map((text) => text.trim()), ["全部", "成功", "失败", "运行中", "已归档"]);
  // A filter redraws the list through 读取中… first, and a count taken then is
  // zero; counted once the list has settled.
  const settled = () => page.locator(".schedule-list").filter({ hasNotText: "读取中" }).first().waitFor();
  await runFilter.selectOption("failed");
  await settled();
  assert.equal(await runRows.count(), 1, "失败 keeps only the failure");
  assert.equal(await failedRun.count(), 1);
  await runFilter.selectOption("running");
  await page.locator(".schedule-empty", { hasText: "没有匹配的记录" }).waitFor();
  await runFilter.selectOption("");
  await settled();
  assert.equal(await runRows.count(), 2);

  // Cancelling the card changes nothing; confirming moves the record.
  await failedRun.locator("button", { hasText: "归档" }).click();
  assert.match(await answerConfirm(page, "取消"), /归档后该记录将移入已归档列表/);
  assert.equal(await runRows.count(), 2, "cancelled: still there");
  await failedRun.locator("button", { hasText: "归档" }).click();
  await waitForHumanConfirm(page, "归档");
  await failedRun.waitFor({ state: "detached" });
  await page.locator(".schedule-note", { hasText: "已归档" }).waitFor();
  await runFilter.selectOption("shelved");
  await failedRun.waitFor();
  await page.screenshot({ path: path.join(evidence, "desktop-schedule-run-archived.png") });
  await failedRun.locator("button", { hasText: "取消归档" }).click();
  await page.locator(".schedule-empty", { hasText: "暂无归档记录" }).waitFor();
  await runFilter.selectOption("");
  await failedRun.waitFor();

  await completedRun.locator("button", { hasText: "删除" }).click();
  const deleteCard = await answerConfirm(page, "取消");
  assert.match(deleteCard, /删除该运行记录/);
  assert.match(deleteCard, /不会影响定时任务本身/);
  assert.equal(await runRows.count(), 2, "cancelled: still there");
  await completedRun.locator("button", { hasText: "删除" }).click();
  // The card has to be where the person is: this section has no agent panel,
  // so it sits at the top of the page, and a box proves it is on screen.
  await visible(page.locator("#confirmations .confirm-card"), "the delete confirmation card");
  await page.screenshot({ path: path.join(evidence, "desktop-schedule-run-delete-confirm.png") });
  await waitForHumanConfirm(page, "删除");
  await completedRun.waitFor({ state: "detached" });
  await page.locator(".schedule-note", { hasText: "已删除这条运行记录" }).waitFor();
  assert.equal(await runRows.count(), 1, "that record only");
  await page.locator(".schedule-tab", { hasText: "定时任务" }).click();
  await page.locator(".schedule-task-row", { hasText: "每天早上的 AI 早报" }).waitFor();
  // The task's own page shows its own history, filtered the same way (G12).
  await openTask("每天早上的 AI 早报");
  const ownHistory = page.locator(".schedule-detail-history");
  await ownHistory.locator("strong", { hasText: "运行历史 (1)" }).waitFor();
  assert.match(await ownHistory.innerText(), /冒烟测试写入的失败记录/);
  await ownHistory.locator(".schedule-detail-filter").selectOption("completed");
  await page.locator(".schedule-detail-history .schedule-empty", { hasText: "没有匹配的记录" }).waitFor();
  await page.locator(".schedule-detail-back").click();
  await page.locator(".schedule-task-row", { hasText: "每天早上的 AI 早报" }).waitFor();

  // 8c2. 运行记录 pages the way WorkBuddy's does (G18): the newest 10, 展开更多
  //      for 10 more, 收起 back to 10; its day headings fold (G19); and 刷新
  //      reads again without leaving the tab (G20). Fourteen older runs are
  //      written into this smoke's throwaway store while the tab is open, two
  //      and three days back, so the record above stays the newest.
  await page.locator(".schedule-tab", { hasText: "运行记录" }).click();
  await runRows.first().waitFor();
  assert.equal(await runRows.count(), 1);
  const olderStore = new DatabaseSync(path.join(directory, "scheduled", "schedules.db"), { timeout: 5_000 });
  const seedOlder = olderStore.prepare("INSERT INTO schedule_runs (tenant, schedule_id, id, due_at, started_at, finished_at, outcome, detail) VALUES (?,?,?,?,?,?,?,?)");
  for (let n = 0; n < 14; n += 1) {
    const at = Date.now() - (2 + (n % 2)) * 86_400_000 - n * 60_000;
    seedOlder.run(morningTask.tenant, morningTask.id, randomUUID(), at, at, at + 5_000, "completed", `冒烟测试写入的较早记录 ${n + 1}`);
  }
  olderStore.close();
  assert.equal(await runRows.count(), 1, "nothing changes until asked");
  const refresh = page.locator(".schedule-toolbar .schedule-refresh");
  assert.equal(await refresh.getAttribute("aria-label"), "刷新");
  await refresh.click();
  await page.locator(".schedule-runs-more", { hasText: "展开更多" }).waitFor();
  assert.equal(await runRows.count(), 10, "the newest 10 of 15");
  assert.equal(await page.locator(".schedule-runs-less").count(), 0, "nothing to fold back yet");
  await page.locator(".schedule-runs-more").click();
  await page.waitForFunction(() => document.querySelectorAll(".schedule-list .schedule-row").length === 15);
  assert.equal(await page.locator(".schedule-runs-more").count(), 0, "all of them now");
  await page.locator(".schedule-runs-less").scrollIntoViewIfNeeded();
  await visible(page.locator(".schedule-runs-less"), "收起");
  await page.screenshot({ path: path.join(evidence, "desktop-schedule-runs-paging.png") });
  await page.locator(".schedule-runs-less", { hasText: "收起" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".schedule-list .schedule-row").length === 10);
  const newestDay = page.locator(".schedule-date-group").first();
  const dayLabel = (await newestDay.innerText()).trim().replace(/ ▾$/, "");
  await newestDay.click();
  await page.locator(".schedule-date-group", { hasText: `${dayLabel} ▸` }).waitFor();
  assert.equal(await runRows.filter({ hasText: "冒烟测试写入的失败记录" }).count(), 0, "a folded day hides its runs");
  await page.locator(".schedule-date-group", { hasText: `${dayLabel} ▸` }).click();
  await runRows.filter({ hasText: "冒烟测试写入的失败记录" }).waitFor();
  await page.locator(".schedule-tab", { hasText: "定时任务" }).click();
  await page.locator(".schedule-task-row", { hasText: "每天早上的 AI 早报" }).waitFor();

  // 8d. Deleting a task is asked on the main process's card, in WorkBuddy's
  //     words plus the one thing that differs here: its run records go too.
  //     Cancelling changes nothing; the page cannot delete on its own.
  const doomed = page.locator(".schedule-task-row", { hasText: "工作日早会纪要" });
  await rowMenu("工作日早会纪要", "删除");
  const taskCard = await answerConfirm(page, "取消");
  assert.match(taskCard, /删除「工作日早会纪要」？/);
  assert.match(taskCard, /此操作将永久删除该定时任务并停止所有后续运行/);
  assert.match(taskCard, /运行记录会留在「运行记录」里/, "its history stays (G11), and the card says so");
  await doomed.waitFor();
  await rowMenu("工作日早会纪要", "删除");
  await waitForHumanConfirm(page, "删除定时任务");
  await doomed.waitFor({ state: "detached" });
  await page.locator(".schedule-note", { hasText: "定时任务已删除" }).waitFor();

  // 8e. 批量管理 deletes a selection with one card that names what it holds.
  await page.locator(".schedule-toolbar button", { hasText: "批量管理" }).click();
  await page.locator(".schedule-selection input[type=checkbox]").first().check();
  assert.match(await page.locator(".schedule-selection").innerText(), /已选 2 项/);
  await page.locator(".schedule-selection button", { hasText: "删除" }).click();
  await visible(page.locator("#confirmations .confirm-card"), "the bulk delete card");
  const bulkCard = await waitForHumanConfirm(page, "删除");
  assert.match(bulkCard, /删除选中的 2 个任务？/);
  assert.match(bulkCard, /「每天早上的 AI 早报（已编辑）」/);
  assert.match(bulkCard, /「工作时间群消息巡检」/);
  await page.locator(".schedule-note", { hasText: "已删除 2 个定时任务" }).waitFor();
  assert.equal(await page.locator(".schedule-list .schedule-task-row").count(), 0);
  await page.locator(".schedule-empty", { hasText: "还没有定时任务" }).waitFor();
  // The deleted task's run is still in 运行记录, under its name, marked (G11).
  await page.locator(".schedule-tab", { hasText: "运行记录" }).click();
  const orphan = page.locator(".schedule-list .schedule-row", { hasText: "冒烟测试写入的失败记录" });
  await orphan.waitFor();
  assert.match((await orphan.innerText()).replace(/\s+/g, " "), /每天早上的 AI 早报（已编辑） 任务已删除/);
  await page.locator(".schedule-tab", { hasText: "定时任务" }).click();
  await page.locator(".schedule-empty", { hasText: "还没有定时任务" }).waitFor();

  // 8f. A task drafted in a conversation (G5), through the real bin/agent.js and
  //     the bridge a task's Agent is given. The draft opens the ordinary dialog,
  //     filled in; closing it creates nothing and says so to the Agent; 确定
  //     creates it. Pausing and deleting on the Agent's word ask on the cards.
  const work = path.join(directory, "agent");
  await mkdir(work, { recursive: true });
  await writeFile(path.join(work, "draft.json"), JSON.stringify({ title: "助手起草的早会纪要", prompt: "把早会群里昨天的讨论整理成待办。",
    schedule: { frequency: "workday", time: "08:30" }, resources: [{ kind: "chat", id: "oc_ScheduleFixture901", label: "助手建议的群" }] }));
  const agent = (args) => runAgentTool(app, "schedule-smoke-task", args, { cwd: work });
  const draftDialog = page.locator("dialog.schedule-dialog", { hasText: "助手起草" });
  const drafting = agent(["schedule-draft", "--draft-file", "draft.json"]);
  await visible(draftDialog, "the drafted dialog");
  assert.equal(await draftDialog.locator('.schedule-field input[type="text"], .schedule-field input:not([type])').first().inputValue(), "助手起草的早会纪要");
  assert.equal(await draftDialog.locator(".schedule-frequency").inputValue(), "workday");
  assert.equal(await draftDialog.locator(".schedule-timing input[type=time]").first().inputValue(), "08:30");
  assert.match(await draftDialog.locator(".schedule-resource-selected").innerText(), /会话 · 助手建议的群/, "the suggested resource, pre-selected");
  assert.equal(await draftDialog.locator(".schedule-memory input").isChecked(), true);
  assert.match(await draftDialog.locator(".schedule-draft-hint").innerText(), /点「确定」才会创建/);
  await page.screenshot({ path: path.join(evidence, "desktop-schedule-agent-draft.png") });
  await draftDialog.locator(".schedule-dialog-actions button", { hasText: "取消" }).click();
  const declined = await drafting;
  assert.equal(declined.code, 1);
  assert.match(declined.stderr, /没有创建这个定时任务/);
  assert.equal(await page.locator(".schedule-list .schedule-task-row").count(), 0, "closing it created nothing");

  const creating = agent(["schedule-draft", "--draft-file", "draft.json"]);
  await visible(draftDialog, "the drafted dialog, again");
  await draftDialog.locator(".schedule-dialog-actions button.primary").click();
  const created = await creating;
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.json.created, true);
  assert.equal(created.json.schedule.title, "助手起草的早会纪要");
  assert.equal(created.json.schedule.rule, "每个工作日 08:30");
  const draftedRow = page.locator(".schedule-task-row", { hasText: "助手起草的早会纪要" });
  await draftedRow.waitFor();

  const listed = await agent(["schedule-list"]);
  assert.equal(listed.code, 0, listed.stderr);
  const mine = listed.json.schedules.find((item) => item.id === created.json.schedule.id);
  assert.deepEqual([mine.state, mine.memory, mine.resources], ["运行中", true, [{ kind: "chat", label: "助手建议的群" }]]);

  const pausing = agent(["schedule-pause", "--id", mine.id]);
  assert.match(await waitForHumanConfirm(page, "暂停"), /暂停「助手起草的早会纪要」/);
  assert.equal((await pausing).json.paused, true);
  await page.locator(".schedule-task-row", { hasText: "助手起草的早会纪要" }).filter({ hasText: "已暂停" }).waitFor();

  const deleting = agent(["schedule-delete", "--id", mine.id]);
  assert.match(await answerConfirm(page, "取消"), /删除「助手起草的早会纪要」？/);
  const kept = await deleting;
  assert.match(kept.stderr, /没有删除任何东西/);
  await draftedRow.waitFor();
  const deletingAgain = agent(["schedule-delete", "--id", mine.id]);
  await waitForHumanConfirm(page, "删除定时任务");
  assert.equal((await deletingAgain).json.deleted, true);
  await draftedRow.waitFor({ state: "detached" });

  // 9. And the whole point of it: authorize from the banner, let a task fire by
  //    itself, and see what it said in 运行记录. One real paid model call, which
  //    is the only way this view can be looked at with anything in it.
  //    Skipped out loud without credentials -- a smoke that quietly drops its
  //    one live step still prints ALL CHECKS PASSED, which is the exact shape of
  //    a green suite that proves nothing.
  if (!live) console.log(`  · skipping the live run: ${existsSync(LIVE) ? "IDOU_SMOKE_NO_LIVE=1" : `${LIVE} is not there`}`);
  else {
    await page.locator(".schedule-tab", { hasText: "定时任务" }).click();
    await page.locator(".schedule-banner button", { hasText: "本次登录内授权" }).click();
    await page.locator(".schedule-banner").waitFor({ state: "detached" });
    console.log("  · authorized; scheduling a task a minute out …");

    await page.locator(".schedule-add").click();
    const soon = dialog.locator(".schedule-frequency");
    await soon.selectOption("once");
    const at = new Date(Date.now() + 65_000);
    const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}T${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    await dialog.locator('input[type="datetime-local"]').fill(local);
    await dialog.locator('.schedule-field input[type="text"], .schedule-field input:not([type])').first().fill("一分钟后的问候");
    await dialog.locator(".schedule-field textarea").first().fill("只回答两个字，不要解释，不要使用任何工具：就绪");
    await dialog.locator(".schedule-dialog-actions button.primary").click();
    await page.locator(".schedule-task-row", { hasText: "一分钟后的问候" }).waitFor();

    console.log(`  · waiting for ${at.toLocaleTimeString()} …`);
    const history = page.locator(".schedule-tab", { hasText: "运行记录" });
    let recorded = false;
    for (let attempt = 0; attempt < 40 && !recorded; attempt += 1) {
      await page.waitForTimeout(5000);
      await history.click();
      // Read after the fetch, not during it: the list says 读取中 first, and
      // reading then reports "nothing recorded" for a task that had in fact run.
      await page.locator(".schedule-list").filter({ hasNotText: "读取中" }).first().waitFor({ timeout: 15_000 }).catch(() => {});
      // Its own row: step 8c leaves a written-in failure in this list.
      const own = page.locator(".schedule-list .schedule-row", { hasText: "一分钟后的问候" });
      recorded = (await own.count()) > 0 && /成功|失败|补跑/.test(await own.first().innerText());
      if (!recorded) await page.locator(".schedule-tab", { hasText: "定时任务" }).click();
    }
    const historyText = (await page.locator(".schedule-list").innerText()).replace(/\s+/g, " ");
    assert.ok(recorded, `nothing was recorded: ${historyText}`);
    assert.match(historyText, /一分钟后的问候/, `the row names the schedule it came from: ${historyText}`);
    assert.match(historyText, /成功/, `it ran and finished: ${historyText}`);
    assert.match(historyText, /就绪/, `and the model's own answer is what a person reads: ${historyText}`);
    await page.screenshot({ path: path.join(evidence, "desktop-schedules-runs.png") });
    console.log(`  · recorded: ${historyText.slice(0, 120)}`);
  }

  assert.deepEqual(errors, [], `the page raised errors: ${errors.join(" | ")}`);
  console.log("ALL CHECKS PASSED — 定时任务 draws, creates, lists, pauses, and keeps its history in its own tab");
} finally {
  await app?.close().catch(() => {});
  await stop(server?.child);
  await rm(directory, { recursive: true, force: true });
}
