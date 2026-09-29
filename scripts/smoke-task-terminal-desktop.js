import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const root = await mkdtemp(path.join(os.tmpdir(), "idou-task-terminal-"));
const projectA = path.join(root, "project-a"), projectB = path.join(root, "project-b"), evidence = path.resolve("docs/evidence/task-ui");
await mkdir(projectA); await mkdir(projectB); await mkdir(evidence, { recursive: true });
let app;

async function choose(cwd) {
  await app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] }); }, cwd);
}
async function makeTask(page, cwd, title) {
  await choose(cwd); await page.locator("#pick-workspace").click(); await page.locator("#project-path").filter({ hasText: cwd }).waitFor();
  await page.locator("#prompt").fill(title); await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: "执行失败" }).waitFor();
  return page.evaluate(async (text) => (await window.idou.snapshot()).tasks.find(task => task.messages.some(message => message.text === text)), title);
}
async function command(page, text, expected) {
  const input = page.locator(".terminal-host:not([hidden]) .xterm-helper-textarea"); await input.focus(); await page.keyboard.type(text); await page.keyboard.press("Enter");
  await page.locator(".terminal-host:not([hidden])").filter({ hasText: expected }).waitFor();
}

try {
  app = await electron.launch({ executablePath: electronBinary, args: [process.cwd()], env: {
    ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: path.join(root, "data"), IDOU_TERMINAL_CANARY: "must-not-appear",
    ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}),
  }, timeout: 30_000 });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor(); await page.locator('[data-section="coding"]').click();
  const a = await makeTask(page, projectA, "A 终端任务");
  assert.equal(await page.locator("#task-terminal").isHidden(), true, "a task terminal is closed by default");
  await page.locator("#workbench-terminal").click(); await page.locator("#terminal-status").filter({ hasText: "运行中" }).waitFor();
  await command(page, "printf 'A_TERMINAL_OK=%s CANARY=%s\\n' \"$PWD\" \"${IDOU_TERMINAL_CANARY-unset}\"", "CANARY=unset");
  const outputA = await page.locator(".terminal-host:not([hidden])").innerText(); assert.match(outputA, new RegExp(`A_TERMINAL_OK=${projectA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} CANARY=unset`));
  const colors = await page.evaluate(() => { const row = document.querySelector(".terminal-host:not([hidden]) .xterm-rows span"), host = document.querySelector(".terminal-host:not([hidden]) .xterm"); return { row: row ? getComputedStyle(row).color : null, host: host ? getComputedStyle(host).color : null, background: host ? getComputedStyle(host).backgroundColor : null }; });
  assert.notEqual(colors.row, "rgb(0, 0, 0)", `terminal text must be readable: ${JSON.stringify(colors)}`);

  // A double click is an explicit terminal selection, the same action a person
  // uses in xterm. Only that selection becomes a removable draft chip.
  const marker = page.locator(".terminal-host:not([hidden]) .xterm-rows").getByText(/A_TERMINAL_OK=/).last();
  await marker.click({ clickCount: 2 }); await page.waitForFunction(() => !document.querySelector("#terminal-add-selection").disabled);
  await page.locator("#terminal-add-selection").click();
  const chip = page.locator("#mention-row .mention-chip").filter({ hasText: "终端输出" }); await chip.waitFor();
  assert.equal(await page.locator("#prompt").inputValue(), "", "adding output must not silently type or send anything");
  await chip.getByRole("button", { name: /移除引用/ }).click(); assert.equal(await page.locator("#mention-row .mention-chip").count(), 0);

  await page.locator("#new-task").click(); const b = await makeTask(page, projectB, "B 终端任务");
  await page.locator("#workbench-terminal").click(); await page.locator("#terminal-status").filter({ hasText: "运行中" }).waitFor();
  await command(page, "printf 'B_TERMINAL_OK=%s\\n' \"$PWD\"", `B_TERMINAL_OK=${projectB}`);
  assert.doesNotMatch(await page.locator(".terminal-host:not([hidden])").innerText(), /A_TERMINAL_OK=/, "task B must not display task A output");

  const forged = await page.evaluate(async ({ aId, bId }) => {
    const a = await window.idou.terminalOpen(aId, { cols: 80, rows: 24, env: { IDOU_TERMINAL_CANARY: "forged" }, pid: 1 });
    try { await window.idou.terminalWrite(bId, a.terminalId, "echo forged\\r"); return "accepted"; }
    catch (error) { return String(error.message); }
  }, { aId: a.id, bId: b.id });
  assert.match(forged, /不属于当前任务/);

  await page.locator(".recent-row > button:first-child").filter({ hasText: "A 终端任务" }).click();
  assert.equal(await page.locator("#task-terminal").isVisible(), true, "task A remembers that its terminal panel was open");
  const returned = await page.locator(".terminal-host:not([hidden])").innerText(); assert.match(returned, /A_TERMINAL_OK=/); assert.doesNotMatch(returned, /B_TERMINAL_OK=/);
  await page.screenshot({ path: path.join(evidence, "u13-human-task-terminal.png"), scale: "css" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, cases: ["E06", "E07", "E08", "E09"], taskA: a.id, taskB: b.id, canaryAbsent: true, colors, paidCalls: 0 }));
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
