import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-task-queue-"));
const evidence = path.resolve("docs/evidence/task-ui"); await mkdir(evidence, { recursive: true });
let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/task-queue-desktop-entry.js")], env: {
    ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}),
    IDOU_DESKTOP_DATA_DIR: directory,
  } });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator("#prompt").fill("先处理正在运行的工作"); await page.locator("#send").click();
  // Running with nothing typed, the one button is 停止; 下一轮 comes with something to queue.
  await page.locator("#send").filter({ hasText: "停止" }).waitFor();
  assert.equal(await page.locator("#queue-send").isHidden(), true, "nothing typed, nothing to queue");

  await page.locator("#prompt").fill("下一轮原稿");
  await page.locator("#queue-send").filter({ hasText: "下一轮" }).waitFor(); await page.locator("#queue-send").click();
  const queue = page.locator("#task-queue"); await queue.getByText("下一轮 · 1 条").waitFor();
  assert.equal(await page.locator("#messages .message.user").count(), 1, "排队不是一轮对话");
  assert.equal((await app.evaluate(() => globalThis.taskQueueFixture.turns)).length, 1, "排队不得启动第二轮");

  const queued = queue.locator(".queue-entry").first(), editor = queued.locator("textarea"), save = queued.getByRole("button", { name: "保存修改" });
  assert.equal(await save.isDisabled(), true, "未修改时不应保存");
  await editor.fill("下一轮修订稿"); assert.equal(await save.isEnabled(), true, "输入后保存按钮应立即可用"); await save.click();
  await queue.locator(".queue-reason").filter({ hasText: "下一轮内容已编辑；请核对当前设置后继续" }).waitFor();
  assert.equal(await queue.getByRole("button", { name: "按当前设置继续" }).isDisabled(), true, "本轮仍运行时不能继续队列");
  const persisted = JSON.parse(await readFile(path.join(directory, "task-queue.json"), "utf8"));
  assert.equal(persisted.entries.find(row => row.state === "paused")?.payload.text, "下一轮修订稿", "界面确认前已经持久化");

  // 输入框空着时，发送位置上的按钮就是「停止」。
  await page.locator("#send").filter({ hasText: "停止" }).click();
  await page.waitForFunction(async () => (await window.idou.snapshot()).tasks[0].status === "interrupted");
  assert.equal((await app.evaluate(() => globalThis.taskQueueFixture.turns)).length, 1, "停止后队列不能自行启动");
  await page.screenshot({ path: path.join(evidence, "u12-next-turn-queue-paused.png"), scale: "css" });

  const resume = queue.getByRole("button", { name: "按当前设置继续" }); await resume.click();
  await page.locator("#messages").filter({ hasText: "已执行：下一轮修订稿" }).waitFor();
  await page.waitForFunction(async () => (await window.idou.snapshot()).tasks[0].status === "completed");
  assert.deepEqual(await app.evaluate(() => globalThis.taskQueueFixture.turns.map(row => row.text)), ["先处理正在运行的工作", "下一轮修订稿"]);
  assert.equal(await page.evaluate(async () => (await window.idou.snapshot()).tasks[0].queue.entries.length), 0);
  assert.equal(await queue.isHidden(), true, "已派发的记录不再冒充待办");
  assert.deepEqual(errors, []);
  console.log("task queue desktop smoke passed");
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
