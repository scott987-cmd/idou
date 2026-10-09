import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";

// 选中修改 in the actual Electron application (docs/sites-phase1.md §1.2): a
// local site's preview, its toolbar, a heading picked with the mouse through
// the browser's own inspect mode, a sentence typed beside it -- and that
// request in the composer of the site's coding task, for the person to send.
// Nothing is sent: no model, no Feishu, nothing billed. Then the page changes
// on disk and the preview shows it by itself.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-pick-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app;
const waitUntil = async (what, check, ms = 15_000) => {
  for (const until = Date.now() + ms; Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 100))) { const value = await check(); if (value) return value; }
  throw new Error(`等了 ${ms / 1000} 秒：${what}`);
};
try {
  const folder = path.join(directory, "周报站");
  await mkdir(folder);
  const page1 = (heading) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>周报</title>
<style>body{font:16px/1.6 sans-serif;margin:40px}h2{margin:24px 0 8px}</style></head>
<body><main class="wrap"><h1 id="title">销售周报</h1><section class="panel"><h2 class="panel-title">${heading}</h2><p>这周签了 12 单。</p></section></main>
<script>window.pageScriptRan = true;</script></body></html>`;
  await writeFile(path.join(folder, "index.html"), page1("本月签约"));
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/site-versions-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data") },
    timeout: 30_000 });
  const main = await app.firstWindow(); main.setDefaultTimeout(30_000);
  const errors = []; main.on("pageerror", (error) => errors.push(error.message));
  await main.waitForFunction(() => Boolean(window.idou?.sitePreview), null, { polling: 100 });
  const site = await app.evaluate((_electron, at) => globalThis.siteStoreFixture.create({ name: "周报站", at }), folder);
  const tasksBefore = (await main.evaluate(() => window.idou.snapshot())).tasks.length;

  await main.evaluate((id) => window.idou.sitePreview(id), site.id);
  const preview = await waitUntil("预览页面", () => app.windows().find((one) => /^http:\/\/127\.0\.0\.1:/.test(one.url())));
  const toolbar = await waitUntil("选中修改工具栏", () => app.windows().find((one) => one.url().endsWith("/site-pick.html")));
  await preview.locator("h2.panel-title").waitFor();
  await toolbar.locator("#pick-toggle").waitFor();
  // The page is the page: it runs its own script, and nothing of the toolbar is in it.
  assert.equal(await preview.evaluate(() => window.pageScriptRan), true);
  assert.equal(await preview.evaluate(() => typeof window.sitePick), "undefined", "the site's page cannot reach the toolbar");
  assert.equal(await preview.evaluate(() => document.querySelectorAll("[data-idou], idou-pick").length), 0, "nothing added to the page");

  // 选中修改, then a click on the heading: taken by the browser's inspect mode, not the page.
  await toolbar.locator("#pick-toggle").click();
  await toolbar.locator('#pick-toggle[aria-pressed="true"]').waitFor();
  assert.equal(await toolbar.locator("#pick-hint").isVisible(), true);
  const box = await preview.locator("h2.panel-title").boundingBox();
  await preview.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await preview.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await toolbar.locator("#panel:not([hidden])").waitFor();
  assert.equal(await toolbar.locator("#picked-label").innerText(), "标题「本月签约」");
  // The click went to the picker, not to the page.
  assert.equal(await preview.evaluate(() => window.pageScriptRan), true);
  await preview.screenshot({ path: path.join(evidence, "desktop-site-pick-preview.png") });
  await toolbar.locator("#pick-text").fill("字大一点，换成蓝色");
  await toolbar.screenshot({ path: path.join(evidence, "desktop-site-pick-toolbar.png") });

  // An empty sentence is said to be empty, in the toolbar.
  await toolbar.locator("#pick-text").fill("");
  await toolbar.locator("#pick-send").click();
  await toolbar.locator("#pick-error:not([hidden])").waitFor();
  assert.equal(await toolbar.locator("#pick-error").innerText(), "写一下要改成什么");
  await toolbar.locator("#pick-text").fill("字大一点，换成蓝色");
  await toolbar.locator("#pick-send").click();

  // In the composer of the site's coding task -- a new one on its folder -- for the person to send.
  await main.waitForFunction(() => document.querySelector("#prompt")?.value.includes("字大一点，换成蓝色"), null, { polling: 100 });
  const composed = await main.locator("#prompt").inputValue();
  assert.match(composed, /^改一下这个网站页面上的一处（我在预览里选中的）：字大一点，换成蓝色/);
  assert.match(composed, /- 文件：index\.html/);
  assert.match(composed, /- 元素：<h2 class="panel-title">，位置 main\.wrap > section\.panel > h2\.panel-title/);
  assert.match(composed, /- 现在显示：「本月签约」/);
  const shown = await main.evaluate(() => ({ section: document.querySelector('[data-section="coding"]')?.getAttribute("aria-current"), project: document.querySelector("#project-chip")?.textContent ?? "" }));
  assert.equal(shown.section, "page", "the coding section is open");
  await main.screenshot({ path: path.join(evidence, "desktop-site-pick-composer.png"), clip: await main.locator("#composer").boundingBox() });
  assert.equal((await main.evaluate(() => window.idou.snapshot())).tasks.length, tasksBefore, "nothing was sent: no task made, no turn started");
  // The toolbar is back to its button, nothing outlined.
  await toolbar.locator("#bar:not([hidden])").waitFor();
  assert.equal(await toolbar.locator("#pick-toggle").getAttribute("aria-pressed"), "false");

  // A coding task changes the page: the preview shows it by itself.
  await writeFile(path.join(folder, "index.html"), page1("本月签约（已改）"));
  await waitUntil("预览自己刷新", async () => (await preview.locator("h2.panel-title").innerText().catch(() => "")) === "本月签约（已改）", 10_000);

  // Picked again and cancelled: nothing goes anywhere.
  await toolbar.locator("#pick-toggle").click();
  await toolbar.locator('#pick-toggle[aria-pressed="true"]').waitFor();
  const title = await preview.locator("#title").boundingBox();
  await preview.mouse.click(title.x + title.width / 2, title.y + title.height / 2);
  await toolbar.locator("#panel:not([hidden])").waitFor();
  assert.equal(await toolbar.locator("#picked-label").innerText(), "标题「销售周报」");
  await toolbar.locator("#pick-cancel").click();
  await toolbar.locator("#bar:not([hidden])").waitFor();

  // A demo has no toolbar: there is no site of this computer's to change.
  await main.evaluate(() => window.idou.siteDemo({ template: "kanban" }));
  await waitUntil("样例预览", () => app.windows().find((one) => /^http:\/\/127\.0\.0\.1:/.test(one.url()) && one !== preview));
  assert.equal(app.windows().filter((one) => one.url().endsWith("/site-pick.html")).length, 0, "the closed preview's toolbar went with it, and a demo has none");

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, paidCalls: 0, picked: "标题「本月签约」", composed: true, sent: false, liveReload: true, demoWithoutToolbar: true,
    folder: await realpath(folder).then(() => "ok") }));
} finally {
  await app?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
