// Live acceptance for a real, multi-file coding task, the way a person would
// work one in Codex or Claude Code (docs/coding-task-parity.md), with the real
// model, in the operator's own signed-in application.
//
//   node scripts/acceptance-coding-complex-live.js --paid [--task t2-stats-flags]
//
// Takes a task from the coding evaluation (scripts/fixtures/coding-eval): its
// repository, committed, opened as a coding task, and its request sent. While
// the turn runs, words are added to it (插话). When it ends, the result is
// judged by the task's hidden tests in a copy of the folder. Then a second turn
// asks for /review, which must change nothing; 查看改动 is checked against git;
// /undo takes the review turn back (no files to restore) and then the task's
// turn (every file back as committed). What the conversation showed at each
// step is printed and a screenshot of the conversation is kept.
//
// Paid: real model calls, several minutes. Needs the control plane at
// IDOU_SERVER_URL (default http://127.0.0.1:3041), the desktop signed in,
// and the application NOT running (it is launched on its own data directory).
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { codingEvalTasks, materialize } from "./fixtures/coding-eval/index.js";
import { waitForHumanChoice } from "./fixtures/agent-harness.js";
import { desktopProfileDir } from "../src/install-names.js";

if (!process.argv.includes("--paid")) {
  console.error("This runs real coding turns (paid model calls). Re-run with --paid to proceed.");
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = process.env.IDOU_DESKTOP_DATA_DIR || desktopProfileDir();
const SERVER = process.env.IDOU_SERVER_URL || "http://127.0.0.1:3041";
const taskAt = process.argv.indexOf("--task");
const TASK = taskAt > 0 ? process.argv[taskAt + 1] : "t2-stats-flags";
const STEER = "顺便在测试里覆盖 --precision 0，以及精度不合法时退出码为 2 的情况。";
const say = (line) => process.stdout.write(`  · ${line}\n`);
try { execFileSync("pgrep", ["-f", "/Applications/i豆.app/Contents/MacOS/(idou|MyDouBao)$"]); console.error("Quit i豆 first: it is launched here on its own data directory."); process.exit(2); }
catch { /* not running: go on */ }

const spec = (await codingEvalTasks()).find((task) => task.id === TASK);
if (!spec) { console.error(`no evaluation task ${TASK}`); process.exit(2); }
const repo = await mkdtemp(path.join(os.homedir(), ".idou-coding-complex-"));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "acceptance", GIT_AUTHOR_EMAIL: "acceptance@example.com", GIT_COMMITTER_NAME: "acceptance", GIT_COMMITTER_EMAIL: "acceptance@example.com" };
await materialize(spec, "repo", repo);
for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "the task as given"]]) execFileSync("git", args, { cwd: repo, env: gitEnv, stdio: "ignore" });
const git = (...args) => execFileSync("git", args, { cwd: repo, env: gitEnv }).toString();
const committed = git("rev-parse", "HEAD").trim();

let app, ok = false, judge = null;
try {
  say(`task ${TASK} in ${repo}`);
  app = await electron.launch({ executablePath: electronBinary, args: [ROOT, `--user-data-dir=${DATA}`], timeout: 60_000,
    env: { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: DATA, IDOU_SERVER_URL: SERVER } });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.locator("#new-task").waitFor();
  let status = null;
  for (let i = 0; i < 90 && !status?.connected; i += 1) {
    status = await page.evaluate(() => window.idou.authStatus()).catch(() => null);
    if (!status?.connected) await page.waitForTimeout(1000);
  }
  if (!status?.connected) throw new Error(`the application did not reconnect to Feishu (stage ${status?.stage ?? "unknown"}); sign in and re-run`);
  say("signed in");

  await page.locator('[data-section="coding"]').click();
  await app.evaluate(({ dialog }, cwd) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] }); }, repo);
  await page.locator("#pick-workspace").click();
  await page.locator("#project-path").filter({ hasText: repo }).waitFor();
  const known = new Set(((await page.evaluate(() => window.idou.snapshot()))?.tasks ?? []).map((task) => task.id));
  const current = async () => ((await page.evaluate(() => window.idou.snapshot()))?.tasks ?? []).find((item) => !known.has(item.id));
  const approvals = [];
  // Until the turn ends: approvals inside the folder allowed for the turn (and
  // counted), and -- once the Agent is working -- one 插话 through the composer.
  // A turn has begun once the task holds one more request than before, and has
  // ended once, after that, it is no longer running -- never the last turn's end.
  const turnsOf = (task) => (task?.messages ?? []).filter((message) => message.role === "user" && !message.steered).length;
  const runTurn = async ({ steer = null, minutes = 20, turns }) => {
    const started = Date.now();
    let steered = false, task = null;
    while (Date.now() - started < minutes * 60_000) {
      task = await current();
      if (task && turnsOf(task) >= turns && ["completed", "failed", "interrupted"].includes(task.status)) break;
      const card = page.locator("#approvals .approval").first();
      if (await card.isVisible().catch(() => false)) {
        approvals.push((await card.innerText()).replace(/\s+/g, " ").slice(0, 160));
        const remember = card.getByRole("button", { name: "本轮同类都允许", exact: true });
        await waitForHumanChoice(card, await remember.isVisible().catch(() => false) ? "本轮同类都允许" : "回答");
      }
      if (steer && !steered && task?.status === "running" && (task.activity ?? []).some((row) => row.type === "commandExecution" && row.status === "completed")) {
        await page.locator("#prompt").fill(steer); await page.locator("#send").click();
        steered = true; say(`插话 at ${Math.round((Date.now() - started) / 1000)} s: ${steer}`);
      }
      await page.waitForTimeout(2000);
    }
    await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn-summary").length > 0, null, { timeout: 30_000, polling: 500 }).catch(() => {});
    say(`turn: ${task?.status} after ${Math.round((Date.now() - started) / 1000)} s${task?.error ? ` (${task.error})` : ""}`);
    return { task, steered };
  };
  const flowOf = (index) => page.locator("#messages .coding-turn").nth(index).evaluate((turn) => [...turn.children].map((node) => {
    const kind = node.classList.contains("explore") ? "explore" : node.classList.contains("command") ? "command" : node.classList.contains("change") ? "change"
      : node.classList.contains("plan") ? "plan" : node.classList.contains("coding-steer") ? "steer" : node.classList.contains("coding-text") ? "text"
        : node.classList.contains("coding-turn-summary") ? "summary" : null;
    return kind ? { kind, line: (node.querySelector("summary") ?? node).innerText.replace(/\s+/g, " ").slice(0, 170) } : null;
  }).filter(Boolean));

  // Turn 1: the task, with a 插话 while it runs.
  await page.locator("#prompt").fill(spec.prompt); await page.locator("#send").click();
  const first = await runTurn({ steer: STEER, turns: 1 });
  const flow1 = await flowOf(0);
  for (const step of flow1) say(`1 ${step.kind.padEnd(8)} ${step.line}`);
  const bar1 = (await page.locator("#task-actions-note").innerText()).trim();
  say(`task bar: ${bar1}`);
  await page.locator("#messages").screenshot({ path: path.join(ROOT, "docs/evidence/desktop-coding-complex-live.png") });

  // Judged in a copy, with the tests the Agent never saw.
  judge = await mkdtemp(path.join(os.tmpdir(), "idou-coding-judge-"));
  await cp(repo, judge, { recursive: true });
  await materialize(spec, "hidden", judge);
  const tests = spawnSync("npm", ["test"], { cwd: judge, encoding: "utf8", timeout: 120_000 });
  const passed = tests.status === 0;
  say(`hidden tests: ${passed ? "pass" : "FAIL"} ${passed ? "" : (tests.stdout + tests.stderr).split("\n").filter((line) => /^not ok|# fail/.test(line)).slice(0, 5).join(" | ")}`);
  const changedFiles = git("status", "--porcelain").trim().split("\n").filter(Boolean);
  say(`changed in the folder: ${changedFiles.join(", ")}`);

  // Turn 2: /review, which must change nothing.
  const beforeReview = git("status", "--porcelain") + git("diff");
  await page.locator("#prompt").fill("/review"); await page.locator("#prompt").press("Escape"); await page.locator("#prompt").press("Enter");
  // Codex's review mode: pick what to look at.
  await page.locator("#mention-menu .mention-option", { hasText: "未提交的改动" }).click();
  const second = await runTurn({ minutes: 15, turns: 2 });
  const flow2 = await flowOf(1);
  for (const step of flow2) say(`2 ${step.kind.padEnd(8)} ${step.line}`);
  const reviewChangedNothing = git("status", "--porcelain") + git("diff") === beforeReview;

  // 查看改动 against git.
  await page.locator("#review-changes").click();
  const dialogText = (await page.locator("dialog.diff-dialog").innerText()).replace(/\s+/g, " ");
  await page.locator("dialog.diff-dialog").getByRole("button", { name: "关闭" }).click();
  const listedAll = changedFiles.every((line) => dialogText.includes(line.slice(3).trim()));
  say(`查看改动: ${dialogText.slice(0, 160)}`);

  // /undo the review turn: nothing to put back. Then the task's turn: everything.
  const undo = async (button) => {
    await page.locator("#prompt").fill("/undo"); await page.locator("#prompt").press("Escape"); await page.locator("#prompt").press("Enter");
    const card = page.locator("#confirmations .confirm-card"); await card.waitFor();
    const text = (await card.innerText()).replace(/\s+/g, " ");
    await waitForHumanChoice(card, button);
    return text;
  };
  const undoReview = await undo("撤回");
  say(`/undo review: ${undoReview.slice(0, 160)}`);
  await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn").length === 1, null, { timeout: 60_000, polling: 500 });
  const undoTask = await undo("撤回并恢复文件");
  say(`/undo task: ${undoTask.slice(0, 220)}`);
  await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn").length === 0, null, { timeout: 60_000, polling: 500 }).catch(() => {});
  const clean = git("status", "--porcelain") === "" && git("rev-parse", "HEAD").trim() === committed;

  const changes = flow1.filter((step) => step.kind === "change");
  const checks = [
    ["the task's turn completed", first.task?.status === "completed"],
    ["its result passes the hidden tests", passed],
    ["the words added mid-turn went into that turn", first.steered && flow1.some((step) => step.kind === "steer" && step.line.includes("precision 0"))],
    ["every file it changed is shown as a change with +/-, none as a shell rewrite", changes.length > 0 && changes.every((step) => /[+]\d+ −\d+/.test(step.line))],
    ["the commands are shown as written", flow1.filter((step) => step.kind === "command").every((step) => !/\/bin\/(z|ba)?sh -l?c/.test(step.line))],
    ["the turn closes with how long it took and what it changed", flow1.some((step) => step.kind === "summary" && /用时 .*改动 \d+ 个文件/.test(step.line))],
    // The turn started from the commit, so its net change is the working tree's.
    ["what the turn says it changed is what git sees", (() => {
      const said = /改动 (\d+) 个文件 \+(\d+) −(\d+)/.exec(flow1.find((step) => step.kind === "summary")?.line ?? "");
      const seen = /(\d+) 个文件 · \+(\d+) −(\d+)/.exec(dialogText);
      return Boolean(said && seen) && said.slice(1).join(",") === seen.slice(1).join(",");
    })()],
    ["how much of the context is left is shown, as Codex's footer shows it", /上下文剩余 \d{1,3}%/.test(bar1)],
    ["/review ran as its own turn and changed nothing", second.task?.status === "completed" && flow2.some((step) => step.kind === "text") && reviewChangedNothing],
    ["查看改动 lists every file git sees changed", listedAll],
    ["taking /review back restores nothing", /文件没有变化/.test(undoReview)],
    ["taking the task back names its files and puts the folder back as committed", /恢复|删除/.test(undoTask) && clean],
  ];
  for (const [what, passedCheck] of checks) process.stdout.write(`${passedCheck ? "OK  " : "FAIL"}  ${what}\n`);
  if (approvals.length) say(`approvals asked: ${approvals.join(" / ")}`);
  ok = checks.every(([, passedCheck]) => passedCheck);
} finally {
  await app?.close().catch(() => {});
  await rm(repo, { recursive: true, force: true }).catch(() => {});
  if (judge) await rm(judge, { recursive: true, force: true }).catch(() => {});
}
process.exit(ok ? 0 : 1);
