// 技能中心 → 连接器, the two things the first manual MCP runs got wrong
// (2026-09-23), checked in the real application window:
//
// - A row's menu stays open when a listing that answers late re-draws the page.
//   The second manual run lost 用于新任务 that way: the menu was open, the
//   page re-drew under it, and the click landed on nothing.
// - The custom form's button is 添加连接器, not a second 添加 beside an offered
//   connector's, and pressed with a field empty it says which field -- without
//   asking the main process, whose 请填写服务名称 named neither field nor form.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-connectors-desktop-"));
const data = path.join(directory, "data");
await mkdir(data, { recursive: true });
await writeFile(path.join(data, "mcp-connections.json"), JSON.stringify([{ id: "demo", title: "本机回显（合成）", transport: "stdio", command: "/bin/echo", args: [], enabledTools: ["echo"] }]));
const env = { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: data };
delete env.IDOU_SERVER_URL; delete env.IDOU_SESSION_FILE;
let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve(".")], env, cwd: directory, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  // Codex's own server list answers four seconds late; the menu is opened
  // before it does. Adding a server is recorded, never performed.
  const added = await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("idou:list-mcp-servers");
    ipcMain.handle("idou:list-mcp-servers", () => new Promise((resolve) => setTimeout(() => resolve([]), 4_000)));
    globalThis.addedMcpServers = [];
    ipcMain.removeHandler("idou:add-mcp-server");
    ipcMain.handle("idou:add-mcp-server", (_event, value) => { globalThis.addedMcpServers.push(value); return []; });
    return true;
  });
  assert.equal(added, true);
  await page.locator('[data-section="skills"]').click();
  await page.locator('.sc-tab[data-tab="connectors"]').click();

  await page.locator('.mcp-connection[data-connection="demo"] .mcp-use-menu > summary').click();
  await page.getByRole("menuitem", { name: "新工作任务", exact: true }).waitFor();
  // Marked now, so the late listing is proved to have re-drawn the row.
  await page.evaluate(() => { document.querySelector('.mcp-connection[data-connection="demo"]').dataset.before = "1"; });
  await page.waitForFunction(() => !document.querySelector('.mcp-connection[data-connection="demo"][data-before]'), null, { timeout: 10_000, polling: 100 });
  assert.equal(await page.evaluate(() => document.querySelector('details.sc-menu[data-menu="use:demo"]')?.open ?? null), true, "the open menu was closed by the re-draw");
  assert.equal(await page.getByRole("menuitem", { name: "新工作任务", exact: true }).isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.focus ?? document.activeElement?.tagName), "menu:use:demo");
  await page.keyboard.press("Escape");

  const submit = page.locator("#add-mcp-server");
  assert.equal((await submit.innerText()).trim(), "添加连接器");
  assert.equal(await page.getByRole("button", { name: "添加", exact: true }).count(), 0, "no second button is called just 添加");
  await submit.click();
  await page.locator("#error-banner").filter({ hasText: "先填连接器名称" }).waitFor();
  assert.match(await page.locator("#error-banner").innerText(), /先填连接器名称（例如 my-tool），再点「添加连接器」。/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "mcp-name", "the cursor is put in the empty field");
  await page.locator("#mcp-name").fill("my-tool");
  await submit.click();
  await page.locator("#error-banner").filter({ hasText: "可执行文件的绝对路径" }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "mcp-target");
  assert.deepEqual(await app.evaluate(() => globalThis.addedMcpServers), [], "an empty field is caught before the main process is asked");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, menuSurvivesRedraw: true, formNamesTheEmptyField: true }));
} catch (error) {
  console.error(String(error?.stack ?? error));
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
