import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const root = await mkdtemp(path.join(os.tmpdir(), "idou-task-workspace-"));
const projectA = path.join(root, "first", "same-name");
const projectB = path.join(root, "second", "same-name");
const dataRoot = path.join(root, "app-data");
const evidence = path.resolve("docs/evidence/task-ui");
await mkdir(projectA, { recursive: true });
await mkdir(projectB, { recursive: true });
await mkdir(evidence, { recursive: true });

let app;
const choose = async (target) => app.evaluate(({ dialog }, value) => {
  dialog.showOpenDialog = async () => value ? { canceled: false, filePaths: [value] } : { canceled: true, filePaths: [] };
}, target);

try {
  app = await electron.launch({ executablePath: electronBinary, args: [process.cwd()], env: {
    ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: dataRoot,
  }, timeout: 30_000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.locator("#new-task").waitFor();
  await page.locator('[data-section="coding"]').click();

  await choose(projectA);
  await page.locator("#pick-workspace").click();
  await page.locator("#project-path").filter({ hasText: projectA }).waitFor();
  await page.locator("#prompt").fill("A 任务：只验证目录归属");
  await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: /^执行失败$/ }).waitFor();

  // Create another task in a different directory with the same basename. The
  // most recently chosen folder is now B, while task A must remain bound to A.
  await page.locator("#new-task").click();
  await choose(projectB);
  await page.locator("#pick-workspace").click();
  await page.locator("#project-path").filter({ hasText: projectB }).waitFor();
  await page.locator("#prompt").fill("B 任务：最后选择的是 B");
  await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: /^执行失败$/ }).waitFor();

  await page.locator(".recent-row > button:first-child").filter({ hasText: "A 任务" }).click();
  assert.equal(await page.locator("#project-chip").getAttribute("title"), projectA,
    "打开历史任务 A 时，顶栏目录必须来自 task.cwd，而不是最后选择的 B");
  await page.screenshot({ path: path.join(evidence, "u02-task-owned-directory.png"), scale: "css" });
  const openedA = await page.evaluate(async () => {
    const snapshot = await window.idou.snapshot();
    return snapshot.tasks.find((task) => task.messages.some((message) => message.text === "A 任务：只验证目录归属"));
  });
  assert.equal(openedA.cwd, projectA);

  // /new inherits A through the task id. The new record itself proves the main
  // process resolved A; a matching label alone is insufficient.
  await page.locator("#prompt").fill("/new");
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await page.locator("#welcome").waitFor();
  await page.locator("#project-path").filter({ hasText: projectA }).waitFor();
  await page.locator("#prompt").fill("A 的新任务");
  await page.locator("#send").click();
  await page.locator("#task-status").filter({ hasText: /^执行失败$/ }).waitFor();
  const inherited = await page.evaluate(async () => {
    const snapshot = await window.idou.snapshot();
    return snapshot.tasks.find((task) => task.messages.some((message) => message.text === "A 的新任务"));
  });
  assert.equal(inherited.cwd, projectA);
  assert.equal(inherited.permission, "plan");
  assert.equal(inherited.executionPermission, "standard");

  // Cancelling a picker and discovering a moved directory both preserve the
  // draft. Once invalidity is known the UI refuses another send until a new
  // directory is explicitly selected; it never falls back to B.
  await page.locator("#new-task").click();
  await page.locator("#prompt").fill("这个草稿必须留下");
  await choose(null);
  await page.locator("#pick-workspace").click();
  assert.equal(await page.locator("#prompt").inputValue(), "这个草稿必须留下");
  await page.locator("#project-path").filter({ hasText: projectA }).waitFor();
  const countBefore = await page.evaluate(async () => (await window.idou.snapshot()).tasks.length);
  await rm(projectA, { recursive: true });
  await page.locator("#send").click();
  await page.locator("#error-banner").filter({ hasText: /目录已移动或不可用/ }).waitFor();
  await page.screenshot({ path: path.join(evidence, "u02-invalid-draft.png"), scale: "css" });
  assert.equal(await page.locator("#prompt").inputValue(), "这个草稿必须留下");
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.match(await page.locator("#pick-workspace").innerText(), /重新选择/);
  assert.equal(await page.evaluate(async () => (await window.idou.snapshot()).tasks.length), countBefore);

  console.log(JSON.stringify({ passed: true, cases: ["A08", "A09", "A10"], projectA, projectB }));
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
