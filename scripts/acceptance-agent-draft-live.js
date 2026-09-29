// Live acceptance for G5: a scheduled task drafted in a conversation, by the
// real model, in the operator's own signed-in application.
//
//   node scripts/acceptance-agent-draft-live.js --paid [--chat <chat_id>] [--model <slug>]
//
// --model picks the conversation's model for this run only (e.g. MiniMax-M3
// when the server default is unavailable). Choosing persists, so the saved
// choice is put back afterwards byte for byte -- and removed if there was none.
// Restoring by choosing "the current model" instead once pinned the server's
// then default, GLM-5.3, as the person's own choice.
//
// Starts one work task asking for a scheduled task, and waits for the Agent to
// draft it -- which opens the same 添加定时任务 dialog a person would, filled
// in. It reads what the dialog holds, then presses 取消: whether a task is
// created is the person's 确定, never this script's. It checks that nothing
// was created and that the Agent was told so, and says what the model did.
//
// Paid: the conversation makes real model calls. Needs the control plane at
// IDOU_SERVER_URL (default http://127.0.0.1:3041), the desktop signed in to
// Feishu, and the application NOT running (it is launched here on its own data
// directory).
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { dataHome, desktopProfileDir } from "../src/install-names.js";

if (!process.argv.includes("--paid")) {
  console.error("This starts a real conversation and makes paid model calls. Re-run with --paid to proceed.");
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = process.env.IDOU_DESKTOP_DATA_DIR || desktopProfileDir();
const SERVER = process.env.IDOU_SERVER_URL || "http://127.0.0.1:3041";
const DB = process.env.IDOU_SCHEDULES_DB || path.join(dataHome(), "scheduled-tasks", "schedules.db");
const chatAt = process.argv.indexOf("--chat");
const CHAT = chatAt > 0 ? process.argv[chatAt + 1] : null;
if (chatAt > 0 && !/^oc_[A-Za-z0-9_-]+$/.test(CHAT ?? "")) { console.error("--chat needs a chat_id (oc_…)"); process.exit(2); }
const modelAt = process.argv.indexOf("--model");
const MODEL = modelAt > 0 ? process.argv[modelAt + 1] : null;
if (modelAt > 0 && !/^[A-Za-z0-9._-]+$/.test(MODEL ?? "")) { console.error("--model needs a model slug"); process.exit(2); }
const ASK = `帮我建一个定时任务：每个工作日早上 9 点，${CHAT ? `读会话 ${CHAT} 里的消息，` : ""}把前一天的消息整理成三条要点。请起草出来让我在对话框里确认。`;
const say = (line) => process.stdout.write(`  · ${line}\n`);

try { execFileSync("pgrep", ["-f", "/Applications/i豆.app/Contents/MacOS/(idou|MyDouBao)$"]); console.error("Quit i豆 first: it is launched here on its own data directory."); process.exit(2); }
catch { /* not running: go on */ }

const scheduleCount = () => {
  const db = new DatabaseSync(DB, { readOnly: true });
  try { return db.prepare("SELECT COUNT(*) AS n FROM schedules").get().n; } finally { db.close(); }
};

// Each account's saved model choice, as it is before this run touches it.
const choiceFiles = () => {
  const accounts = path.join(DATA, "accounts");
  return existsSync(accounts) ? readdirSync(accounts).map((name) => path.join(accounts, name, "model-choice.json")) : [];
};
const savedChoices = new Map(choiceFiles().map((file) => [file, existsSync(file) ? readFileSync(file) : null]));
const restoreChoices = () => {
  for (const file of choiceFiles()) {
    const before = savedChoices.get(file) ?? null;
    if (before) writeFileSync(file, before, { mode: 0o600 });
    else if (existsSync(file)) unlinkSync(file);
  }
};

let app, ok = false;
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

  if (MODEL) {
    const options = await page.evaluate(() => window.idou.modelOptions());
    if (!options.available.some((model) => model.slug === MODEL)) throw new Error(`the server does not offer ${MODEL}: ${options.available.map((model) => model.slug).join(", ")}`);
    if (options.current !== MODEL) await page.evaluate((slug) => window.idou.selectModel(slug), MODEL);
    say(`model for this run: ${MODEL} (was ${options.current ?? options.default})`);
  }
  const before = scheduleCount();
  // The new task is the one that was not there before; its state is read from
  // the application's own snapshot, not from the toolbar.
  const known = new Set(((await page.evaluate(() => window.idou.snapshot()))?.tasks ?? []).map((task) => task.id));
  const statusOf = async () => {
    const tasks = (await page.evaluate(() => window.idou.snapshot()).catch(() => null))?.tasks ?? [];
    return tasks.find((task) => !known.has(task.id))?.status ?? "";
  };
  const FINISHED = ["completed", "failed", "interrupted"];
  await page.locator('[data-section="cowork"]').click();
  await page.locator("#new-task").click();
  await page.locator("#prompt").fill(ASK);
  await page.locator("#send").click();
  say(`asked: ${ASK}`);

  // Either the draft dialog opens, or the task ends without one.
  const draft = page.locator("dialog.schedule-dialog", { hasText: "助手起草" });
  const deadline = Date.now() + 8 * 60_000;
  let taskStatus = "";
  while (Date.now() < deadline) {
    if (await draft.isVisible().catch(() => false)) break;
    taskStatus = await statusOf();
    if (FINISHED.includes(taskStatus)) break;
    await page.waitForTimeout(2000);
  }
  const opened = await draft.isVisible().catch(() => false);
  let fields = null;
  if (opened) {
    fields = await draft.evaluate((dialog) => ({
      heading: dialog.querySelector("h3")?.textContent ?? "",
      title: dialog.querySelector('.schedule-field input[type="text"], .schedule-field input:not([type])')?.value ?? "",
      prompt: dialog.querySelector(".schedule-field textarea")?.value ?? "",
      frequency: dialog.querySelector(".schedule-frequency")?.value ?? "",
      time: dialog.querySelector('.schedule-timing input[type="time"]')?.value ?? "",
      resources: dialog.querySelector(".schedule-resource-selected")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
      // A chip shows the name the draft gave; its title is the chat_id itself.
      resourceIds: [...dialog.querySelectorAll(".schedule-resource-chip span")].map((span) => span.title),
      memory: dialog.querySelector(".schedule-memory input")?.checked ?? null,
    }));
    say(`the draft dialog: ${JSON.stringify(fields)}`);
    // The dialog only: the page behind it is the operator's real account.
    await draft.screenshot({ path: path.join(ROOT, "docs/evidence/desktop-agent-draft-live.png") });
    await draft.locator(".schedule-dialog-actions button", { hasText: "取消" }).click();
    await draft.waitFor({ state: "detached" });
    say("pressed 取消");
    // The Agent hears no, and finishes its turn.
    const end = Date.now() + 5 * 60_000;
    while (Date.now() < end) {
      taskStatus = await statusOf();
      if (FINISHED.includes(taskStatus)) break;
      await page.waitForTimeout(2000);
    }
  }
  // The last message is drawn a moment after the task is marked finished. Polled
  // on a timer: by animation frame, a window in the background is never asked.
  const TOLD = /没有创建|未创建|没创建/;
  await page.waitForFunction((source) => new RegExp(source).test(document.querySelector("#messages")?.innerText.slice(-1500) ?? ""),
    TOLD.source, { timeout: 30_000, polling: 500 }).catch(() => {});
  const reply = (await page.locator("#messages").innerText().catch(() => "")).replace(/\s+/g, " ");
  say(`task status: ${taskStatus}`);
  say(`the conversation ends: …${reply.slice(-400)}`);
  const after = scheduleCount();

  const checks = [
    ["the model drafted a task, and the dialog opened as 助手起草", opened && /助手起草/.test(fields?.heading ?? "")],
    ["filled in: every working day at 09:00", fields?.frequency === "workday" && fields?.time === "09:00"],
    ...(CHAT ? [["with the chat it was asked about pre-selected", (fields?.resourceIds ?? []).includes(CHAT)]] : []),
    ["after 取消 nothing was created", after === before],
    ["and the Agent says it was not created", TOLD.test(reply.slice(-1500))],
    // A scheduled task only reads; its answer is delivered for it. A draft that
    // asks it to send somewhere will be refused at run time.
    ["the drafted prompt asks for no send or write", !/发到|发回|发送到|转发|推送到|写入|发给/.test(fields?.prompt ?? "")],
  ];
  for (const [what, passed] of checks) process.stdout.write(`${passed ? "OK  " : "FAIL"}  ${what}\n`);
  ok = checks.every(([, passed]) => passed);
} finally {
  await app?.close().catch(() => {});
  // After the application is closed, so nothing writes the choice again.
  if (MODEL) { try { restoreChoices(); say("the saved model choice is exactly as it was"); } catch (error) { say(`could not restore the saved model choice: ${error.message}`); } }
}
process.exit(ok ? 0 : 1);
