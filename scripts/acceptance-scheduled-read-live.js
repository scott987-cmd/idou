// Live acceptance: a scheduled task reads what it was granted, end to end.
//
//   node scripts/acceptance-scheduled-read-live.js --paid --resources <file.json>
//
// The file names the test resources and the text each holds (origin, wikiBase,
// wikiSheet, wikiDocument, their markers; scripts/fixtures/live-resources.js).
//
// Creates two one-off tasks in the operator's own signed-in application, each
// granted one test resource through the real resource picker and the real
// control plane: a Wiki node carrying a whole Base, and a Wiki link naming one
// worksheet of a spreadsheet. Both are due a few minutes out. It then closes the
// application and waits for both to run for real -- a scheduled run in the
// sandbox, reading Feishu as the person through egress, and a model call each,
// which is paid -- and reports what each run recorded.
//
// This is the check no fixture can stand in for: that a run is told what it was
// granted (task.json's resource section), that egress lets it read exactly that,
// and that the pinned CLI and model together actually do. Re-run it after
// upgrading lark-cli or Codex.
//
// Needs: the control plane at IDOU_SERVER_URL (default http://127.0.0.1:3041)
// with scheduled tasks on; the desktop signed in to Feishu; the application NOT
// running (it is launched here on its own data directory, where the login is).
// The test resources are the ones in docs/evidence/wiki-pinning-cases.json; they
// hold the markers below, which a successful run's report should repeat.
//
// It creates tasks and never deletes them: deleting asks for a person's click,
// and that click is not this script's to make.
//
//   node scripts/acceptance-scheduled-read-live.js --paid --all-kinds
//
// Also a whole document, a whole spreadsheet and one Base table: five runs,
// staggered two minutes apart. Run it whenever the sandbox image changes.
//
//   node scripts/acceptance-scheduled-read-live.js --paid --multi
//
// Only one task, granted a document, a spreadsheet and a Base at once.
//
//   node scripts/acceptance-scheduled-read-live.js --paid --chat <chat_id>
//
// Only one task, granted one chat. There is no designated test group; the
// person's own single chat with the application's bot works, once 测试通知
// (scripts/acceptance-notify-live.js) has put its fixed line there, which is
// the marker a successful run repeats.
//
//   node scripts/acceptance-scheduled-read-live.js --paid --run-now <task title>
//
// Instead of creating tasks, presses 立即运行 on an existing one (one this script
// created earlier, so its report should repeat the same marker) and keeps the
// application open until that run finishes: a run now is authorized while the
// person is there, and may be running as their live login. Then it checks what
// 立即运行 promises -- the run completed, and the task's next time and state
// are exactly what they were.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { dataHome, desktopProfileDir } from "../src/install-names.js";
import { liveResources } from "./fixtures/live-resources.js";

if (!process.argv.includes("--paid")) {
  console.error("This creates real scheduled tasks and makes paid model calls. Re-run with --paid to proceed.");
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = process.env.IDOU_DESKTOP_DATA_DIR || desktopProfileDir();
const SERVER = process.env.IDOU_SERVER_URL || "http://127.0.0.1:3041";
const DB = process.env.IDOU_SCHEDULES_DB || path.join(dataHome(), "scheduled-tasks", "schedules.db");
const LIVE = liveResources(["origin", "wikiDocument", "documentMarker", "wikiSheet", "sheetId", "sheetMarker", "wikiBase", "baseTable", "baseMarker"]);
const ORIGIN = LIVE.origin;
const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
const chatAt = process.argv.indexOf("--chat");
const CHAT = chatAt > 0 ? process.argv[chatAt + 1] : null;
if (chatAt > 0 && !/^oc_[A-Za-z0-9_-]+$/.test(CHAT ?? "")) { console.error("--chat needs a chat_id (oc_…)"); process.exit(2); }
const ONLY_MULTI = process.argv.includes("--multi") && !process.argv.includes("--all-kinds");
const CASES = [
  ...(ONLY_MULTI || CHAT ? [] : [
  { title: `验收-整本Base-${stamp}`, kind: "base", link: `${ORIGIN}/wiki/${LIVE.wikiBase}`, marker: LIVE.baseMarker, minutes: 3 },
  { title: `验收-单张工作表-${stamp}`, kind: "sheet", link: `${ORIGIN}/wiki/${LIVE.wikiSheet}?sheet=${LIVE.sheetId}`, marker: LIVE.sheetMarker, minutes: 5 },
  ]),
  // --all-kinds: the rest of what a task can be granted, each read the way its
  // own line in the run's instructions says. Needed whenever the CLI in the
  // sandbox changes: 1.0.96 kept every request the same and still broke the
  // single-sheet read, because its output grew and the run ran out of model
  // calls. A chat has no designated test group; see --chat.
  ...(process.argv.includes("--all-kinds") ? [
    { title: `验收-文档-${stamp}`, kind: "document", link: `${ORIGIN}/wiki/${LIVE.wikiDocument}`, marker: LIVE.documentMarker, minutes: 7 },
    { title: `验收-整本表格-${stamp}`, kind: "sheet", link: `${ORIGIN}/wiki/${LIVE.wikiSheet}`, marker: LIVE.sheetMarker, minutes: 9 },
    { title: `验收-单张数据表-${stamp}`, kind: "base", link: `${ORIGIN}/wiki/${LIVE.wikiBase}?table=${LIVE.baseTable}`, marker: LIVE.baseMarker, minutes: 11 },
  ] : []),
  // --multi: one task granted three resources at once, on the model budget its
  // grant gives (it grows with the resources). Its report should carry every
  // marker, and none that was not granted.
  ...(process.argv.includes("--multi") ? [
    { title: `验收-三种资源-${stamp}`, resources: [
      { kind: "document", link: `${ORIGIN}/wiki/${LIVE.wikiDocument}` },
      { kind: "sheet", link: `${ORIGIN}/wiki/${LIVE.wikiSheet}` },
      { kind: "base", link: `${ORIGIN}/wiki/${LIVE.wikiBase}` },
    ], marker: [LIVE.documentMarker, LIVE.sheetMarker, LIVE.baseMarker].join(" / "), minutes: ONLY_MULTI ? 3 : 13 },
  ] : []),
  ...(CHAT ? [{ title: `验收-会话-${stamp}`, kind: "chat", link: CHAT, marker: "发来的测试通知", minutes: 3 }] : []),
];
// No link in the prompt: what is asserted is that the run reads what it was
// granted, and it only knows that from the resource section.
// Said for every kind of resource. Asked for "cells or record fields" of a
// document holding only its title, a run went looking for the rest and tried
// four ways of fetching it; once it ran out of model calls doing so.
const PROMPT = "读取本任务获准读取的飞书资源，把其中的文字原样逐条列出（表格按单元格，多维表格按记录字段，文档按段落），不要改写，不要总结。";
const runNowAt = process.argv.indexOf("--run-now");
const RUN_NOW = runNowAt > 0 ? process.argv[runNowAt + 1] : null;
if (runNowAt > 0 && !RUN_NOW) { console.error("--run-now needs the title of an existing task"); process.exit(2); }
// Creating tasks waits for their runs in the control plane's own database, which
// is on this Mac only when the control plane is. Since 2026-09-22 it runs on the
// server, and that file here is the copy it left behind: read, it says nothing
// about the runs. --run-now reads through the application instead.
const LOCAL = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/.test(SERVER);
if (!RUN_NOW && !LOCAL) { console.error(`The control plane at ${SERVER} is not this Mac's: creating tasks waits on a database that is not here. Use --run-now <title of an existing task>.`); process.exit(2); }
const say = (line) => process.stdout.write(`  · ${line}\n`);

try { execFileSync("pgrep", ["-f", "/Applications/i豆.app/Contents/MacOS/(idou|MyDouBao)$"]); console.error("Quit i豆 first: it is launched here on its own data directory."); process.exit(2); }
catch { /* not running: go on */ }

const localTime = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}T${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
let app, pressed = null;
try {
  say("launching the operator's own application …");
  app = await electron.launch({ executablePath: electronBinary, args: [ROOT, `--user-data-dir=${DATA}`], timeout: 60_000,
    env: { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: DATA, IDOU_SERVER_URL: SERVER } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.locator("#new-task").waitFor();
  // A resumed login spends a single-use refresh token in the background; closing
  // before it lands can lose the login. Wait for it, whatever else happens.
  let status = null;
  for (let i = 0; i < 90 && !status?.connected; i += 1) {
    status = await page.evaluate(() => window.idou.authStatus()).catch(() => null);
    if (!status?.connected) await page.waitForTimeout(1000);
  }
  if (!status?.connected) throw new Error(`the application did not reconnect to Feishu (stage ${status?.stage ?? "unknown"}); sign in and re-run`);
  say("signed in");

  await page.locator('[data-section="schedules"]').click();
  await page.locator(".schedule-toolbar").waitFor();
  const banner = await page.locator(".schedule-banner").innerText().catch(() => "");
  say(`banner: ${banner.replace(/\s+/g, " ").slice(0, 120) || "(none)"}`);

  if (RUN_NOW) pressed = await runNow(page);
  for (const item of RUN_NOW ? [] : CASES) {
    const at = new Date(Date.now() + item.minutes * 60_000);
    await page.locator(".schedule-add").click();
    const dialog = page.locator("dialog.schedule-dialog");
    await dialog.waitFor();
    await dialog.locator(".schedule-frequency").selectOption("once");
    await dialog.locator('input[type="datetime-local"]').fill(localTime(at));
    await dialog.locator('.schedule-field input[type="text"], .schedule-field input:not([type])').first().fill(item.title);
    await dialog.locator(".schedule-field textarea").first().fill(PROMPT);
    for (const resource of item.resources ?? [{ kind: item.kind, link: item.link }]) {
      await dialog.locator(".schedule-resource-kind").selectOption(resource.kind);
      await dialog.locator(".schedule-resource-manual").fill(resource.link);
      await dialog.locator(".schedule-resource-add").click();
    }
    await dialog.locator(".schedule-dialog-actions button.primary").click();
    const row = page.locator(".schedule-task-row", { hasText: item.title });
    const error = dialog.locator(".schedule-error");
    await Promise.race([row.waitFor({ timeout: 30_000 }), error.filter({ hasText: /\S/ }).waitFor({ timeout: 30_000 })]).catch(() => {});
    if (!(await row.count())) throw new Error(`creating ${item.title} failed: ${(await error.innerText().catch(() => "")).trim() || "no row appeared"}`);
    say(`created ${item.title}, due ${at.toLocaleTimeString()}: ${(await row.innerText()).replace(/\s+/g, " ").slice(0, 140)}`);
  }
  await page.waitForTimeout(3000);
} finally {
  await app?.close().catch(() => {});
}

if (RUN_NOW) process.exit(pressed?.ok ? 0 : 1);

async function runNow(page) {
  const row = page.locator(".schedule-task-row", { hasText: RUN_NOW }).first();
  await row.waitFor();
  // Through the application, as its own page reads them: the control plane may
  // be on another machine. Shaped as the database rows the checks below name.
  const read = () => page.evaluate(async (title) => {
    const { schedules } = await window.idou.listSchedules();
    const schedule = schedules.find((item) => item.title === title);
    const run = schedule ? ((await window.idou.scheduleRuns(schedule.id, 1)).runs ?? [])[0] ?? null : null;
    return { schedule: schedule && { id: schedule.id, state: schedule.state, next_at: schedule.nextAt, suspended_at: schedule.suspended ? 1 : null },
      run: run && { id: run.id, started_at: run.startedAt, finished_at: run.finishedAt, outcome: run.outcome, detail: run.detail, kind: run.kind,
        artifact_state: run.artifact?.state ?? null, artifact_url: run.artifact?.url ?? null, artifact_bytes: run.artifact?.bytes ?? null } };
  }, RUN_NOW);
  const before = await read();
  if (!before.schedule) throw new Error(`no task titled ${RUN_NOW}`);
  // 桌面通知, recorded in the main process instead of shown: the run this
  // presses must be told once it finishes, by name.
  await app.evaluate(({ Notification }) => {
    globalThis.__notices = [];
    Notification.prototype.show = function show() { globalThis.__notices.push({ title: this.title, body: this.body }); };
  });
  const clickedAt = Date.now();
  // Its actions come up on hover, as in the reference product.
  await row.hover();
  await row.locator(".schedule-row-actions button", { hasText: "立即运行" }).click();
  const note = page.locator(".schedule-note"), banner = page.locator("#error-banner");
  await Promise.race([note.filter({ hasText: /已开始运行/ }).waitFor({ timeout: 60_000 }), banner.filter({ hasText: /\S/ }).waitFor({ timeout: 60_000 })]).catch(() => {});
  const said = (await note.innerText().catch(() => "")).trim();
  if (!/已开始运行/.test(said)) throw new Error(`立即运行 did not start: ${(await banner.innerText().catch(() => "")).trim() || said || "no answer"}`);
  say(`pressed 立即运行: ${said}`);
  let after = await read();
  for (const deadline = Date.now() + 15 * 60_000; Date.now() < deadline && !(after.run?.started_at >= clickedAt - 1000 && after.run?.finished_at);) {
    await page.waitForTimeout(10_000);
    after = await read();
  }
  const run = after.run?.started_at >= clickedAt - 1000 ? after.run : null;
  // The notifier looks every 30 seconds.
  let notices = [];
  for (const deadline = Date.now() + 45_000; Date.now() < deadline; await page.waitForTimeout(3000)) {
    notices = await app.evaluate(() => globalThis.__notices ?? []);
    if (notices.some((notice) => notice.body.includes(RUN_NOW))) break;
  }
  const told = notices.filter((notice) => notice.body.includes(RUN_NOW));
  const checks = [
    ["the run finished and completed", run?.outcome === "completed"],
    ["its report was archived", run?.artifact_state === "verified" || run?.artifact_state === "unknown"],
    ["the next time did not move", after.schedule.next_at === before.schedule.next_at],
    ["the state did not change", after.schedule.state === before.schedule.state],
    ["nothing was suspended", after.schedule.suspended_at === null],
    ["a desktop notification named the task, once", told.length === 1],
    // The history calls it 测试运行完成, as the reference product does (G16).
    ["it is recorded as a run now, not a scheduled one", run?.kind === "manual"],
  ];
  for (const [what, ok] of checks) console.log(`${ok ? "OK  " : "FAIL"}  ${what}`);
  console.log(`      run ${run?.id ?? "(none)"} outcome=${run?.outcome ?? "(none)"} detail=${run?.detail ?? ""}`);
  console.log(`      report ${run?.artifact_state ?? "(no archive)"} ${run?.artifact_url ?? ""} ${run?.artifact_bytes ?? ""}`);
  console.log(`      notice ${told.map((notice) => `${notice.title}：${notice.body}`).join(" | ") || "(none)"}`);
  console.log(`      state ${before.schedule.state} -> ${after.schedule.state}, next ${new Date(before.schedule.next_at).toLocaleString()} -> ${new Date(after.schedule.next_at).toLocaleString()}`);
  return { ok: checks.every(([, ok]) => ok) };
}

// The runs happen in the control plane whether or not the application is open.
say(`closed the application; waiting for ${CASES.length} runs …`);
const db = new DatabaseSync(DB, { readOnly: true });
const deadline = Date.now() + 20 * 60_000;
let rows = [];
while (Date.now() < deadline) {
  rows = CASES.map((item) => {
    const schedule = db.prepare("SELECT id, state, suspended_at FROM schedules WHERE title = ?").get(item.title);
    const run = schedule && db.prepare("SELECT id, outcome, finished_at, detail, artifact_state, artifact_url, artifact_bytes, archived_at FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT 1").get(schedule.id);
    return { ...item, schedule, run };
  });
  if (rows.every((row) => row.run?.finished_at || row.schedule?.suspended_at)) break;
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
db.close();
let failed = 0;
for (const row of rows) {
  const run = row.run;
  const done = run?.outcome === "completed";
  if (!done) failed += 1;
  console.log(`${done ? "RAN " : "FAIL"}  ${row.title}`);
  console.log(`      schedule ${row.schedule?.id ?? "(missing)"} state=${row.schedule?.state ?? "?"}${row.schedule?.suspended_at ? " SUSPENDED" : ""}`);
  console.log(`      run ${run?.id ?? "(none)"} outcome=${run?.outcome ?? "(none)"} detail=${run?.detail ?? ""}`);
  console.log(`      report ${run?.artifact_state ?? "(no archive)"} ${run?.artifact_url ?? ""} ${run?.artifact_bytes ?? ""}`);
  console.log(`      expect the report to repeat ${row.marker}`);
}
console.log(`\n${rows.length - failed}/${rows.length} runs completed. Whether each report carries its marker is read from the archived report or the bot's message.`);
process.exitCode = failed ? 1 : 0;
