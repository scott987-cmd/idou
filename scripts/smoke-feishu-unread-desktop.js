import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

// 飞书消息 carries Feishu's own unread count in the sidebar, the way Feishu does.
// Where the number comes from is the embedded messenger's page title, which needs
// a signed-in Feishu account and is covered by test/feishu-unread.test.js against
// the titles that client was measured writing. What this checks is the half that
// needs no account: the number the main process publishes reaching the tab,
// landing where a person can actually see it — a badge pushed outside the window
// or outside its own tab is invisible while the DOM still says it is there — and
// going away again once everything has been read.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-feishu-unread-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const env = { ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data") };
let app;

try {
  app = await electron.launch({ executablePath: electronBinary, args: [process.cwd()], env, timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(20_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  const tab = page.locator('[data-section="feishu"]'), badge = tab.locator(".nav-unread");
  assert.equal(await badge.count(), 0, "nothing unread, nothing on the tab");
  assert.equal(await app.evaluate(({ app: electronApp }) => electronApp.getBadgeCount()), 0, "nor on the Dock");

  // What the main process does when the messenger's title changes.
  const publish = (value) => app.evaluate(({ BrowserWindow }, unread) => {
    BrowserWindow.getAllWindows()[0].webContents.send("idou:feishu-unread", unread);
  }, value);

  await publish({ count: 9, label: "9" });
  await badge.waitFor();
  assert.equal((await badge.innerText()).trim(), "9");
  const box = await badge.boundingBox(), row = await tab.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, `the count must be drawn, not merely present: ${JSON.stringify(box)}`);
  assert.ok(box.x >= row.x && box.x + box.width <= row.x + row.width + 1, `the count must sit on its own tab: ${JSON.stringify({ box, row })}`);
  assert.ok(box.x + box.width <= await page.evaluate(() => innerWidth), "and inside the window");
  assert.ok(box.x > row.x + row.width / 2, "at the end of the row, as Feishu puts it");
  await page.screenshot({ path: path.join(evidence, "desktop-feishu-unread.png"), scale: "css" });

  // Feishu stops counting past 99 and writes 99+; the tab says what Feishu says.
  await publish({ count: 99, label: "99+" });
  await page.waitForFunction(() => document.querySelector('[data-section="feishu"] .nav-unread')?.textContent.trim() === "99+");

  // Read on the phone, gone here: the count is not a notification that stays.
  await publish({ count: 0, label: "" });
  await page.waitForFunction(() => !document.querySelector('[data-section="feishu"] .nav-unread'));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, shownOnTheTab: "9", keptAsFeishuWritesIt: "99+", clearedWhenRead: true, tabBox: { x: Math.round(box.x), width: Math.round(box.width) } }));
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => null);
    console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0],
      sidebar: await page?.locator('[data-section="feishu"]').innerText().catch(() => "unavailable") }));
  }
  throw error;
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
