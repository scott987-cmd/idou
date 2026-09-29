import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-confirmation-"));
const evidence = path.resolve("docs/evidence/task-ui"); await mkdir(evidence, { recursive: true });
let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/confirmation-desktop-entry.js")], env: {
    ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}),
    IDOU_DESKTOP_DATA_DIR: directory, IDOU_CONFIRM_TIMEOUT_MS: "1000",
  } });
  let page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  // Announcements are recorded rather than shown, from the start: a run in the
  // background is a window that is not in front, and every card it raised would
  // otherwise reach the person's own notification centre. Whether the window
  // counts as in front is this run's to say (`inFront`).
  await app.evaluate(({ app: electronApp, BrowserWindow, Notification }) => {
    globalThis.announced = []; globalThis.withdrawnNotices = 0; globalThis.bounces = 0; globalThis.inFront = true;
    Notification.prototype.show = function () { globalThis.announced.push({ title: this.title, body: this.body }); (globalThis.notices ??= []).push(this); };
    Notification.prototype.close = function () { globalThis.withdrawnNotices += 1; };
    if (electronApp.dock) { electronApp.dock.bounce = () => { globalThis.bounces += 1; return 7; }; electronApp.dock.cancelBounce = () => {}; }
    BrowserWindow.getAllWindows()[0].isFocused = () => globalThis.inFront;
  });

  // Task A starts, then the person moves to an idle Task B before its approval
  // arrives. A background card may mark A in the sidebar, but may not appear in B.
  await page.locator("#prompt").fill("后台确认归属"); await page.locator("#send").click();
  await page.locator("#task-title").filter({ hasText: "后台确认归属" }).waitFor();
  const taskA = await page.evaluate(async () => (await window.idou.snapshot()).tasks[0]);
  await page.locator("#new-task").click();
  await page.locator("#prompt").fill("后台查看任务"); await page.locator("#send").click();
  await page.locator("#task-title").filter({ hasText: "后台查看任务" }).waitFor();
  const taskB = await page.evaluate(async (id) => (await window.idou.snapshot()).tasks.find((row) => row.id !== id), taskA.id);
  await page.evaluate((id) => window.idou.stop(id), taskB.id);
  await page.locator("#task-status").filter({ hasText: "已停止" }).waitFor();
  await page.locator("#prompt").fill("这段草稿和焦点不能被后台卡片抢走"); await page.locator("#prompt").focus();
  await page.locator("#recent-tasks .recent-row", { hasText: taskA.title }).locator(".task-confirmation-badge").waitFor();
  assert.equal(await page.locator("#approvals .approval, .work-turn .approval").count(), 0, "background approval must not appear in task B");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "prompt", "background approval must not steal input focus");
  assert.equal(await page.locator("#prompt").inputValue(), "这段草稿和焦点不能被后台卡片抢走");

  // Opening A first shows an early request at task level. When the exact item
  // arrives, one repaint moves that same card beside the step, never duplicates it.
  await page.locator("#recent-tasks .recent-row", { hasText: taskA.title }).locator("button").first().click();
  const taskLevel = page.locator("#approvals .approval"); await taskLevel.waitFor();
  assert.equal(await taskLevel.count(), 1);
  assert.match(await taskLevel.locator("strong").innerText(), /确认创建飞书文档/);
  assert.equal((await taskLevel.locator("strong").innerText()).includes("zsh"), false);
  assert.equal(await taskLevel.locator(".approval-technical").evaluate((node) => node.open), false, "work command details stay folded by default");
  assert.match(await taskLevel.locator("pre").textContent(), /doc-create/);
  await app.evaluate((_electron, id) => globalThis.confirmationFixture.showStep(id), taskA.id);
  const attached = page.locator(".work-turn .approval"); await attached.waitFor();
  assert.equal(await page.locator(".approval").count(), 1, "the early task-level card must move, not duplicate");
  await app.evaluate(() => { globalThis.confirmationFixture.repaint(); globalThis.confirmationFixture.repaint(); });
  assert.equal(await page.locator(".approval").count(), 1, "duplicate snapshots still render one card");
  assert.equal((await app.evaluate(() => globalThis.confirmationFixture.responses)).length, 0, "painting and moving a card must not answer it");
  await page.screenshot({ path: path.join(evidence, "u10-step-confirmation.png"), scale: "css" });
  await attached.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor();
  const responses = await app.evaluate(() => globalThis.confirmationFixture.responses);
  assert.deepEqual(responses.map((row) => row.result), [{ decision: "decline" }], "cancel continues once and never retries or approves");
  assert.equal(await page.locator(".approval").count(), 0);

  // A backend withdrawal removes all buttons and leaves the associated step as
  // withdrawn rather than turning a disappearing card into apparent success.
  await page.locator("#recent-tasks .recent-row", { hasText: "后台查看任务" }).locator("button").first().click();
  await page.locator("#prompt").fill("后端撤销这次操作"); await page.locator("#send").click();
  await page.locator(".work-step", { hasText: "已撤销" }).waitFor();
  assert.equal(await page.locator(".approval button").count(), 0);
  assert.equal((await app.evaluate(() => globalThis.confirmationFixture.responses)).length, 1, "withdrawal cannot manufacture a response");

  // Application confirmation: keep the input focus, enforce the original main
  // process deadline across repaints, then reject the old id. No task is deleted.
  await page.locator("#prompt").fill("输入焦点仍在这里"); await page.locator("#prompt").focus();
  await page.evaluate((id) => { window.__pendingDelete = window.idou.deleteTask(id); }, taskB.id);
  const appCard = page.locator("#confirmations .confirm-card"); await appCard.waitFor();
  const expiredId = await appCard.getAttribute("data-confirm-id");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "prompt", "application card must not steal focus");
  await page.evaluate(() => document.querySelector("#theme-toggle").click());
  await appCard.locator(".confirm-state", { hasText: "已超时" }).waitFor({ timeout: 4000 });
  assert.equal(await appCard.locator("button").count(), 0);
  assert.deepEqual(await page.evaluate(async (id) => window.idou.confirmResponse({ id, response: 1 }), expiredId), { accepted: false });
  assert.ok((await page.evaluate(async () => (await window.idou.snapshot()).tasks)).some((row) => row.id === taskB.id));
  await page.screenshot({ path: path.join(evidence, "u10-expired-confirmation.png"), scale: "css" });

  // A card is announced -- a notification and a Dock bounce -- when the window
  // is not the one in front, and only then; the notification goes with the
  // card. 2026-09-23: a work task's video card lapsed twice while i豆 sat
  // behind another app, with nothing outside the window saying it was there.
  // Everything so far happened with the window in front: nothing announced.
  assert.deepEqual(await app.evaluate(() => globalThis.announced), [], "cards in front of the person are not announced");
  const lapse = async () => {
    await page.evaluate((id) => { window.__pendingDelete = window.idou.deleteTask(id); }, taskB.id);
    const card = page.locator("#confirmations .confirm-card"); await card.waitFor();
    await card.locator(".confirm-state", { hasText: "已超时" }).waitFor({ timeout: 4000 });
  };
  await lapse();
  assert.deepEqual(await app.evaluate(() => globalThis.announced), [], "a card in front of the person is not announced");
  await app.evaluate(() => { globalThis.inFront = false; });
  await lapse();
  const announced = await app.evaluate(() => globalThis.announced);
  assert.deepEqual(announced, [{ title: "i豆 需要你确认", body: "确认删除任务：回到 i豆 点确认或取消，1 秒内有效。" }]);
  if (await app.evaluate(({ app: electronApp }) => Boolean(electronApp.dock))) assert.equal(await app.evaluate(() => globalThis.bounces), 1);
  assert.equal(await app.evaluate(() => globalThis.withdrawnNotices), 1, "the notification is withdrawn when its card lapses");
  await app.evaluate(() => { globalThis.inFront = true; });


  // Reload retires a fresh card. A response carrying its old id is rejected by
  // main even though the renderer has been rebuilt.
  await page.evaluate((id) => { window.__pendingDelete = window.idou.deleteTask(id); }, taskB.id);
  await page.locator("#confirmations .confirm-card .confirm-actions").waitFor();
  const reloadId = await page.locator("#confirmations .confirm-card").getAttribute("data-confirm-id");
  await page.reload(); page.setDefaultTimeout(20_000); await page.locator("#new-task").waitFor();
  assert.deepEqual(await page.evaluate(async (id) => window.idou.confirmResponse({ id, response: 1 }), reloadId), { accepted: false });
  assert.ok((await page.evaluate(async () => (await window.idou.snapshot()).tasks)).some((row) => row.id === taskB.id));

  // A task's own card -- here a command to run -- is announced the same way. It
  // comes from the task, not from the application's confirmations, and was
  // never announced: in a real coding task a command card waited seven minutes,
  // unseen, behind another app (2026-09-23). The notice names the kind of card,
  // never the command; it goes when the card is answered.
  const counts = () => app.evaluate(() => ({ announced: globalThis.announced.length, withdrawn: globalThis.withdrawnNotices, bounces: globalThis.bounces }));
  const beforeCommand = await counts();
  await app.evaluate(() => { globalThis.inFront = false; });
  await page.locator("#new-task").click();
  await page.locator("#prompt").fill("在后台跑一条命令"); await page.locator("#send").click();
  const commandCard = page.locator(".approval").first(); await commandCard.waitFor();
  const commandNotices = (await app.evaluate(() => globalThis.announced)).slice(beforeCommand.announced);
  assert.deepEqual(commandNotices, [{ title: "i豆 需要你确认", body: "任务要运行一条命令：回到 i豆 点允许或拒绝。" }], `a command card behind another app is announced: ${JSON.stringify(commandNotices)}`);
  if (await app.evaluate(({ app: electronApp }) => Boolean(electronApp.dock))) assert.equal((await counts()).bounces, beforeCommand.bounces + 1);
  // Clicked, the notice leads back to its card from wherever the person went;
  // it used to only bring the window forward (2026-09-25). The window is kept
  // where it is: an acceptance run never takes the screen.
  await page.locator('[data-section="skills"]').click(); await page.locator("#skill-search").waitFor();
  assert.equal(await commandCard.isVisible(), false, "the card is out of sight in another section");
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; win.show = () => {}; win.focus = () => {};
    globalThis.notices.at(-1).emit("click");
  });
  await commandCard.waitFor();
  assert.match(await page.locator("#task-title").innerText(), /在后台跑一条命令/, "the notice opened the task its card waits in");
  await app.evaluate(() => { globalThis.inFront = true; });
  await commandCard.getByRole("button", { name: "拒绝", exact: true }).click();
  await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor();
  assert.equal((await counts()).withdrawn, beforeCommand.withdrawn + 1, "the notice goes once the card is answered");
  assert.equal((await counts()).announced, beforeCommand.announced + 1, "and a repaint never announces it twice");
  assert.deepEqual(errors, []);
  console.log("confirmation desktop smoke passed");
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
