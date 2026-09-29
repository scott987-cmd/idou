// 结果还写到 (schedule-deliveries.js), on the real schedules page in a real
// Electron page: offered only where the server says it can write, only this
// tenant's own chats listed, a choice kept across a redraw, and sent on save
// only when it changed -- every save would otherwise ask Feishu again whether
// each document is still editable.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import electronBinary from "electron";

const MAIN = `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(process.env.PAGE);
});
`;

const page = (schedulesUrl) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><main id="root"></main>
<script type="module">
  import { schedulesUi } from ${JSON.stringify(schedulesUrl)};
  window.saved = []; window.writable = true;
  // A gate the test opens (window.gate(): { promise, open }). The run history
  // and each search wait on one when a test holds them: a delay would be a
  // guess about how fast this machine is, and on a slow one it guessed wrong.
  window.gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return { promise, open }; };
  const DOC = { kind: "document", id: "DoxcnAbCdEf123456", reference: "https://tenant.feishu.cn/docx/DoxcnAbCdEf123456", label: "周报汇总" };
  const item = window.item = { id: "s1", title: "每日产品简报", state: "active", spec: { frequency: "daily", time: "09:00" }, nextAt: Date.now() + 3600e3,
    prompt: "总结", updatedAt: 1, deliveries: [DOC], access: { configured: true, revision: 1, resources: [], limits: { modelCalls: 10 } } };
  const api = {
    scheduleConsent: async () => ({ authorized: true, expiresAt: Date.now() + 3600e3 }),
    scheduleUnattended: async () => ({ available: false }),
    listSchedules: async () => ({ schedules: [item], rules: ["daily"], ...(window.writable ? { deliveries: { max: 3, kinds: ["document", "chat"] } } : {}) }),
    scheduleRuns: async () => { await window.runsHeld; return { runs: [] }; },
    listScheduleChats: async () => ({ chats: [{ id: "oc_1234567890abcdef", name: "产品群", external: false }, { id: "oc_9999999999999999", name: "客户外部群", external: true }], next: null }),
    // A search answers when its gate opens, if a test holds it; each answer is counted.
    searchScheduleResources: async (text) => { await (window.searchHeld ?? []).shift(); window.answered = (window.answered ?? 0) + 1;
      return { documents: [{ url: "https://tenant.feishu.cn/docx/Found" + text.length + "abcdefgh", title: "找到的：" + text }], next: null }; },
    updateSchedule: async (id, definition, expected) => { window.saved.push(JSON.parse(JSON.stringify(definition))); return { schedule: item }; },
  };
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const action = async (fn, onError) => { try { return await fn(); } catch (error) { window.lastError = String(error?.message ?? error); onError?.(error); } };
  const readableError = (error) => String(error?.message ?? error);
  window.ui = schedulesUi({ api, root: document.getElementById("root"), element, action, readableError });
  await window.ui.render();
  window.ready = true;
</script></body></html>`;

test("where results also go is chosen on the task's page, from this tenant's chats, and saved only when it changed", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-deliveries-ui-"));
  const html = path.join(directory, "index.html"), main = path.join(directory, "main.cjs");
  await writeFile(html, page(pathToFileURL(path.resolve("src/desktop/renderer/schedules.js")).href));
  await writeFile(main, MAIN);
  const app = await electron.launch({ executablePath: electronBinary, args: [main], env: { ...process.env, PAGE: html } });
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => app.close().catch(() => {}));
  const screen = await app.firstWindow();
  await screen.waitForFunction(() => window.ready === true && document.querySelector(".schedule-title"));
  await screen.locator(".schedule-title").first().click();
  const picker = screen.locator(".schedule-delivery-picker");
  await picker.waitFor();
  assert.deepEqual(await picker.locator(".schedule-resource-chip span").allTextContents(), ["文档 · 周报汇总"], "what the task has, as the person named it");
  assert.deepEqual(await picker.locator(".schedule-resource-kind option").allTextContents(), ["文档", "会话"], "only the kinds this server writes to");
  assert.match(await screen.locator(".schedule-delivery-hint").textContent(), /最多 3 个/);

  // A save that did not touch them sends none, so nothing is proven again.
  const save = screen.locator(".schedule-detail-actions .primary");
  await save.click();
  await screen.waitForFunction(() => window.saved.length === 1);
  assert.equal(Object.hasOwn((await screen.evaluate(() => window.saved[0])), "deliveries"), false);

  // Only this tenant's own chats are offered.
  await picker.locator(".schedule-resource-kind").selectOption("chat");
  await picker.locator(".schedule-resource-search").click();
  await picker.locator(".schedule-resource-result").first().waitFor();
  assert.deepEqual(await picker.locator(".schedule-resource-result strong").allTextContents(), ["产品群"]);
  assert.match(await picker.locator(".schedule-resource-status").textContent(), /1 个外部群不能作为去处/);
  await picker.locator(".schedule-resource-result").first().click();
  assert.deepEqual(await picker.locator(".schedule-resource-chip span").allTextContents(), ["文档 · 周报汇总", "会话 · 产品群"]);

  // A redraw of the same task keeps the unsaved choice.
  await screen.evaluate(() => window.ui.render());
  await screen.locator(".schedule-delivery-picker").waitFor();
  assert.deepEqual(await screen.locator(".schedule-delivery-picker .schedule-resource-chip span").allTextContents(), ["文档 · 周报汇总", "会话 · 产品群"]);

  // Saved, the whole list goes: a document by its link, a chat by its id.
  await screen.locator(".schedule-detail-actions .primary").click();
  await screen.waitForFunction(() => window.saved.length === 2);
  assert.deepEqual((await screen.evaluate(() => window.saved[1])).deliveries, [
    { kind: "document", reference: "https://tenant.feishu.cn/docx/DoxcnAbCdEf123456", label: "周报汇总" },
    { kind: "chat", id: "oc_1234567890abcdef", label: "产品群" }]);

  // A server that cannot write anywhere shows no such field at all.
  await screen.evaluate(() => { window.writable = false; window.item.updatedAt = 3; return window.ui.render(); });
  await screen.locator(".schedule-detail-page").waitFor();
  assert.equal(await screen.locator(".schedule-delivery-picker").count(), 0);
  assert.equal(await screen.evaluate(() => window.lastError ?? null), null);
});

// The task page is drawn when it opens and again when its run history has
// loaded. A search pressed in between used to answer into the picker drawn
// first, already replaced: nothing appeared, as if 搜索 did nothing (found on
// the installed app, 2026-09-28). The answer belongs to the picker on screen,
// whichever drawing that is; and the latest search wins over a slower earlier one.
test("a search on a task's page lands in the picker on screen, whenever the page is drawn again", { timeout: 90_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-deliveries-redraw-"));
  const html = path.join(directory, "index.html"), main = path.join(directory, "main.cjs");
  await writeFile(html, page(pathToFileURL(path.resolve("src/desktop/renderer/schedules.js")).href));
  await writeFile(main, MAIN);
  const app = await electron.launch({ executablePath: electronBinary, args: [main], env: { ...process.env, PAGE: html } });
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(() => app.close().catch(() => {}));
  const screen = await app.firstWindow();
  await screen.waitForFunction(() => window.ready === true && document.querySelector(".schedule-title"));
  const onScreen = () => screen.locator(".schedule-detail-page .schedule-delivery-picker");
  const shown = async () => ({ results: await onScreen().locator(".schedule-resource-result strong").allTextContents(),
    status: await onScreen().locator(".schedule-resource-status").textContent() });
  // Drawings of the task page, counted as they are put on screen.
  await screen.evaluate(() => { window.drawn = 0; new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes)
    if (node.classList?.contains("schedule-detail-page")) window.drawn += 1; }).observe(document.getElementById("root"), { childList: true }); });

  // Answered before the page is drawn again: still there afterwards. The run
  // history is held until the answer is on screen, then let through.
  await screen.evaluate(() => { const runs = window.gate(); window.runsHeld = runs.promise; window.openRuns = runs.open; });
  await screen.locator(".schedule-title").first().click();
  await onScreen().waitFor();
  await onScreen().locator(".schedule-resource-query").fill("周报");
  await onScreen().locator(".schedule-resource-search").click();
  await onScreen().locator(".schedule-resource-result", { hasText: "找到的：周报" }).waitFor({ timeout: 5000 });
  const before = await screen.evaluate(() => { window.runsHeld = null; window.openRuns(); return window.drawn; });
  await screen.waitForFunction((count) => window.drawn > count, before, { polling: 100 });
  assert.deepEqual((await shown()).results, ["找到的：周报"], "the answer survives the page being drawn again");
  assert.equal((await shown()).status, "显示 1 项，点击即可加入。");

  // Answered after the page is drawn again: it lands in the picker on screen.
  // The search is held until the page has been drawn again.
  await screen.evaluate(() => { const search = window.gate(); window.searchHeld = [search.promise]; window.openSearch = search.open; window.drawn = 0; });
  await onScreen().locator(".schedule-resource-query").fill("月报");
  await onScreen().locator(".schedule-resource-search").click();
  await screen.evaluate(() => window.ui.render());
  await screen.waitForFunction(() => window.drawn >= 2, null, { polling: 100 });
  assert.equal((await shown()).status, "正在搜索飞书…", "the picker drawn meanwhile says a search is under way");
  await screen.evaluate(() => window.openSearch());
  await onScreen().locator(".schedule-resource-result", { hasText: "找到的：月报" }).waitFor({ timeout: 5000 });
  assert.deepEqual((await shown()).results, ["找到的：月报"]);

  // A slower earlier search does not overwrite a later one: the later is let
  // through first, the earlier after it.
  await screen.evaluate(() => { const earlier = window.gate(), later = window.gate();
    window.searchHeld = [earlier.promise, later.promise]; window.openEarlier = earlier.open; window.openLater = later.open; });
  await onScreen().locator(".schedule-resource-query").fill("旧的");
  await onScreen().locator(".schedule-resource-search").click();
  await screen.evaluate(() => window.ui.render());
  await onScreen().locator(".schedule-resource-query").fill("新的一次");
  await onScreen().locator(".schedule-resource-search").click();
  await screen.evaluate(() => window.openLater());
  await onScreen().locator(".schedule-resource-result", { hasText: "找到的：新的一次" }).waitFor({ timeout: 5000 });
  const answered = await screen.evaluate(() => { window.openEarlier(); return window.answered; });
  await screen.waitForFunction((count) => window.answered > count, answered, { polling: 50 });
  await screen.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual((await shown()).results, ["找到的：新的一次"], "the later search's answer stays");

  // What was found can be chosen from the picker on screen.
  await onScreen().locator(".schedule-resource-result").first().click();
  assert.deepEqual(await onScreen().locator(".schedule-resource-chip span").allTextContents(), ["文档 · 周报汇总", "文档 · 找到的：新的一次"]);
  assert.equal(await screen.evaluate(() => window.lastError ?? null), null);
});
