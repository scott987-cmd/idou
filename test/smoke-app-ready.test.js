// A script that drives the application's window acts only once the page has
// said it is ready. index.html draws the sidebar and 新工作任务 before app.js
// has run, so a control on screen proves nothing: smoke-preview-desktop.js
// waited for #new-task, clicked 技能中心 in the 30–150 ms before the buttons
// were wired, and waited 60 s for a section that never opened (2 of 7 runs,
// 2026-10-03). Forty-odd smokes waited the same way and a dozen more clicked
// straight after taking the window; this reads every one of them.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { APP_READY, drivenBeforeReady } from "../scripts/fixtures/app-ready.js";

test("the page says it is ready only once app.js has wired it and restored the draft", async () => {
  const html = await readFile(path.resolve("src/desktop/renderer/index.html"), "utf8");
  assert.match(html, /<body data-app-state="starting">/, "the document starts out not ready");
  const renderer = path.resolve("src/desktop/renderer");
  const claims = [];
  for (const name of (await readdir(renderer)).filter((entry) => entry.endsWith(".js"))) {
    for (const match of (await readFile(path.join(renderer, name), "utf8")).matchAll(/dataset\.appState\s*=/g)) claims.push(`${name}@${match.index}`);
  }
  assert.equal(claims.length, 1, `only app.js says the page is ready: ${claims.join(", ")}`);
  // Its last statement: everything the module does on arrival -- wiring the
  // sidebar, restoring the draft, reading the connection -- comes before it.
  const app = await readFile(path.join(renderer, "app.js"), "utf8");
  assert.ok(app.trimEnd().endsWith('\ndocument.body.dataset.appState = "ready";'), "app.js must end by saying the page is ready");
  assert.equal(APP_READY, 'body[data-app-state="ready"]');
});

test("no script acts on the application's window before it is ready", async () => {
  const rows = [];
  for (const folder of ["scripts", "scripts/fixtures"]) {
    const names = (await readdir(path.resolve(folder))).filter((name) => folder === "scripts" ? /^(?:smoke|acceptance)-.*\.js$/.test(name) : name.endsWith(".js"));
    for (const name of names) {
      for (const row of drivenBeforeReady(await readFile(path.resolve(folder, name), "utf8"))) rows.push(`${folder}/${name}:${row.line} ${row.why}`);
    }
  }
  assert.deepEqual(rows, []);
});

test("the waits that fail are recognised, and the ones that hold are not", () => {
  // What smoke-preview-desktop.js did.
  assert.equal(drivenBeforeReady(`const page = await app.firstWindow(); page.setDefaultTimeout(60_000);
  await page.locator("#new-task").waitFor();
  await page.evaluate(() => document.querySelector('[data-section="skills"]').click());`).length, 2);
  // A Playwright click passes its own checks on index.html's markup as well.
  assert.deepEqual(drivenBeforeReady(`app = await launch(); let page = await app.firstWindow(); page.on("pageerror", record);
  await page.locator('[data-section="coding"]').click();`).map((row) => row.why), ["firstWindow() 之后没先等 appReady(page)"]);
  // Handed to a helper is acted on too.
  assert.equal(drivenBeforeReady(`const page = await app.firstWindow();\nawait signIn(page);\nawait appReady(page);`).length, 1);
  assert.equal(drivenBeforeReady(`let page = await app.firstWindow(); await appReady(page);\nawait page.reload(); await page.locator("#prompt").fill("x");`).length, 1, "a reloaded page starts over");

  assert.deepEqual(drivenBeforeReady(`const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20_000); page.on("pageerror", (e) => errors.push(e));
  // the page is the person's
  await appReady(page);
  await page.locator("#settings").click();
  await page.reload(); page.setDefaultTimeout(20_000); await appReady(page);`), []);
  // Read for the failure report, or a page of the script's own.
  assert.deepEqual(drivenBeforeReady(`try { run(); } catch (error) {
  if (app) { const page = await app.firstWindow().catch(() => null); console.error(await page?.locator("#error-banner").innerText()); }
  throw error;
}`), []);
  assert.deepEqual(drivenBeforeReady(`const window = await instance.firstWindow(); // 生成的网页，不是 i豆 的窗口
  await window.locator("#start").click();`), []);
});
