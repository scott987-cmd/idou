// Live acceptance for a coding task as Codex and Claude Code run one
// (docs/coding-task-parity.md), with the real model, in the operator's own
// signed-in application.
//
//   node scripts/acceptance-coding-live.js --paid
//
// Makes a small repository with a bug and a test under $HOME, opens it as a
// coding task, asks the Agent to fix the bug and run the test, and checks what
// the conversation shows: the steps in order (browsing, commands, changes),
// the turn's summary, the working-tree diff, and that /undo puts the files
// back. The repository is removed afterwards; the task stays in the list.
//
// Paid: the turn makes real model calls. Needs the control plane at
// IDOU_SERVER_URL (default http://127.0.0.1:3041), the desktop signed in,
// and the application NOT running (it is launched on its own data directory).
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { waitForHumanChoice } from "./fixtures/agent-harness.js";
import { desktopProfileDir } from "../src/install-names.js";

if (!process.argv.includes("--paid")) {
  console.error("This runs a real coding turn (paid model calls). Re-run with --paid to proceed.");
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = process.env.IDOU_DESKTOP_DATA_DIR || desktopProfileDir();
const SERVER = process.env.IDOU_SERVER_URL || "http://127.0.0.1:3041";
const say = (line) => process.stdout.write(`  · ${line}\n`);
try { execFileSync("pgrep", ["-f", "/Applications/i豆.app/Contents/MacOS/(idou|MyDouBao)$"]); console.error("Quit i豆 first: it is launched here on its own data directory."); process.exit(2); }
catch { /* not running: go on */ }

const repo = await mkdtemp(path.join(os.homedir(), ".idou-coding-live-"));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "acceptance", GIT_AUTHOR_EMAIL: "acceptance@example.com", GIT_COMMITTER_NAME: "acceptance", GIT_COMMITTER_EMAIL: "acceptance@example.com" };
await mkdir(path.join(repo, "src")); await mkdir(path.join(repo, "test"));
await writeFile(path.join(repo, "package.json"), JSON.stringify({ name: "sum-live", type: "module", scripts: { test: "node --test" } }, null, 2));
const BUGGY = "export function sum(a, b) {\n  return a - b;\n}\n";
await writeFile(path.join(repo, "src", "sum.js"), BUGGY);
await writeFile(path.join(repo, "test", "sum.test.js"), "import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { sum } from \"../src/sum.js\";\n\ntest(\"sum adds\", () => {\n  assert.equal(sum(2, 3), 5);\n});\n");
for (const args of [["init", "-q"], ["add", "."], ["commit", "-qm", "sum with a bug"]]) execFileSync("git", args, { cwd: repo, env: gitEnv, stdio: "ignore" });

let app, ok = false;
try {
  say(`repository ${repo}`);
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
  await page.locator("#prompt").fill("src/sum.js 的 sum 算错了，修好它，并运行 npm test 确认测试通过。");
  await page.locator("#send").click();
  let task = null;
  const started = Date.now();
  for (let i = 0; i < 240; i += 1) {
    task = ((await page.evaluate(() => window.idou.snapshot()))?.tasks ?? []).find((item) => !known.has(item.id));
    if (["completed", "failed", "interrupted"].includes(task?.status)) break;
    // M01: the person reviews and answers every approval in the real window.
    const card = page.locator("#approvals .approval").first();
    if (await card.isVisible().catch(() => false)) await waitForHumanChoice(card, "本轮同类都允许");
    await page.waitForTimeout(2000);
  }
  say(`the turn: ${task?.status} after ${Math.round((Date.now() - started) / 1000)} s${task?.error ? ` (${task.error})` : ""}`);
  await page.waitForFunction(() => document.querySelector("#messages .coding-turn-summary") !== null, null, { timeout: 30_000, polling: 500 }).catch(() => {});

  const flow = await page.locator("#messages .coding-turn").first().evaluate((turn) => [...turn.children].map((node) => {
    const kind = node.classList.contains("explore") ? "explore" : node.classList.contains("command") ? "command" : node.classList.contains("change") ? "change"
      : node.classList.contains("plan") ? "plan" : node.classList.contains("coding-text") ? "text" : node.classList.contains("coding-turn-summary") ? "summary" : null;
    return kind ? { kind, line: (node.querySelector("summary") ?? node).innerText.replace(/\s+/g, " ").slice(0, 160) } : null;
  }).filter(Boolean));
  for (const step of flow) say(`${step.kind.padEnd(8)} ${step.line}`);
  await page.locator("#messages").screenshot({ path: path.join(ROOT, "docs/evidence/desktop-coding-live.png") });
  const fixed = await readFile(path.join(repo, "src", "sum.js"), "utf8");
  const tests = (() => { try { execFileSync("npm", ["test"], { cwd: repo, stdio: "ignore" }); return true; } catch { return false; } })();

  await page.locator("#review-changes").click();
  const diff = (await page.locator("dialog.diff-dialog").innerText()).replace(/\s+/g, " ");
  say(`查看改动: ${diff.slice(0, 200)}`);
  await page.locator("dialog.diff-dialog").getByRole("button", { name: "关闭" }).click();

  await page.locator("#prompt").fill("/undo"); await page.locator("#prompt").press("Escape"); await page.locator("#prompt").press("Enter");
  const card = page.locator("#confirmations .confirm-card");
  await card.waitFor();
  const asked = (await card.innerText()).replace(/\s+/g, " ");
  say(`/undo asked: ${asked.slice(0, 220)}`);
  await waitForHumanChoice(card, "撤回并恢复文件");
  await page.waitForFunction(() => document.querySelectorAll("#messages .coding-turn").length === 0, null, { timeout: 60_000, polling: 500 }).catch(() => {});
  const restored = await readFile(path.join(repo, "src", "sum.js"), "utf8");
  const clean = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();

  const checks = [
    ["the turn completed", task?.status === "completed"],
    ["the bug is fixed and the test passes", /a \+ b/.test(fixed) && tests],
    ["the flow shows its steps in order, the change among them", flow.some((step) => step.kind === "change" && /sum\.js/.test(step.line))],
    ["commands are shown as written, not wrapped", flow.filter((step) => step.kind === "command").every((step) => !/\/bin\/(z|ba)?sh -l?c/.test(step.line))],
    ["the turn closes with how long it took and what changed", flow.some((step) => step.kind === "summary" && /用时 .*改动 1 个文件/.test(step.line))],
    ["查看改动 lists the change", /sum\.js/.test(diff)],
    ["/undo names the file it will put back", /恢复 src\/sum\.js/.test(asked)],
    ["and puts it back", restored === BUGGY && clean === ""],
  ];
  for (const [what, passed] of checks) process.stdout.write(`${passed ? "OK  " : "FAIL"}  ${what}\n`);
  ok = checks.every(([, passed]) => passed);
} finally {
  await app?.close().catch(() => {});
  await rm(repo, { recursive: true, force: true }).catch(() => {});
}
process.exit(ok ? 0 : 1);
