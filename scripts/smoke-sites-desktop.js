import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { answerConfirm, waitForHumanChoice } from "./fixtures/agent-harness.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { SiteService } from "../src/control-plane/site-service.js";

// 文档网站 in the actual Electron application, against a synthetic Base (no
// account, no network, no model): 从表格新建 → pick the slice → the confirmation
// card → the site, its folder and its data. And a site that is only files -- a
// small game -- in the same list, which is why the slice is optional.
//
// What is asserted is what the design promises (docs/table-driven-sites.md):
// only the confirmed fields leave the machine, the card says what is being
// agreed to, and a cell's contents stay text.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-coding-table-"));
const workspace = path.join(directory, "workspace");
await mkdir(workspace);
const BASE = "https://test.feishu.cn/base/SyntheticBaseToken0001?table=tblSyntheticTable1";
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app, control = null;

try {
  // A control plane with the publishing side of 文档网站 on it, so the desktop's
  // own publish path is exercised rather than described. Without this the
  // publish button is only ever drawn, and a mistake in it -- a name out of
  // scope, say -- reaches an installation instead of this file.
  const published = await SiteRegistry.open(path.join(directory, "published"));
  const sessions = new SessionRegistry();
  const service = new SiteService({ sessions, registry: published, origin: "https://sites.test", notify: () => {} });
  control = createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  control.listen(0, "127.0.0.1"); await once(control, "listening");
  const session = sessions.issue({ tenantId: "synthetic", userId: "ou_owner", deviceId: "d1",
    authProvider: "feishu", appId: "cli_smoke", deviceProof: "ed25519-login" });
  const sessionFile = path.join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt,
    serverUrl: `http://127.0.0.1:${control.address().port}` }), { mode: 0o600 });
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/sites-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile },
    timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator('[data-section="sites"]').click();
  await page.locator("#site-new").waitFor();
  assert.match(await page.locator("#library").innerText(), /还没有网站/);

  // 0. With nothing made yet, a list of names says nothing -- so the front page
  //    is the templates themselves, and each one opens as a real page with the
  //    sample table in it. A picture cannot tell you whether the sorting works.
  const gallery = page.locator("#site-gallery");
  await gallery.locator(".template-card").first().waitFor();
  assert.equal(await gallery.locator(".template-card").count(), 6, "首页应当把每个模版都摆出来");
  assert.deepEqual(await gallery.locator(".style-chip").allInnerTexts(), ["简约", "科技", "立体"]);
  const otherWindow = async () => app.windows().find((other) => other !== page)
    ?? await app.waitForEvent("window", { predicate: (other) => other !== page, timeout: 15_000 });
  const windowTitles = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((one) => one.getTitle()));
  await gallery.locator('.template-card[data-template="kanban"] .template-demo').click();
  const demo = await otherWindow();
  await demo.waitForLoadState("domcontentloaded");
  assert.equal((await windowTitles()).includes("项目进度 · 简约 · 样例（用的是示例数据）"), true, (await windowTitles()).join(" / "));
  // Live, not photographed: the columns are grouped by the 状态 column and the
  // search box really filters. And nothing was created by looking.
  await demo.locator(".column").first().waitFor();
  assert.deepEqual(await demo.locator(".column-head span:first-child").allInnerTexts(), ["进行中", "已回款", "待签"]);
  await demo.locator("#q").fill("海生");
  assert.deepEqual(await demo.locator(".ticket-title").allInnerTexts(), ["海生医疗"], "样例里的搜索是真的能用的");
  assert.equal(await page.evaluate(async () => (await window.idou.sites()).length), 0, "看一眼样例不该建出网站");
  await demo.close();


  // 1. A ready-made site is chosen first, then the table it shows. The picker
  //    lists what the table offers -- names and types read from Feishu, so
  //    nothing downstream has to guess a type.
  await page.locator("#site-new").click();
  const picker = page.locator(".template-dialog");
  await picker.locator('.template-card[data-template="dashboard"]').waitFor();
  // Two axes: 场景 is what the page is for, 风格 is what it looks like. Five
  // scenarios and three styles are fifteen sites out of eight files, and the
  // picker has to show both or the second axis is not a choice anybody makes.
  assert.deepEqual(await picker.locator(".template-card .template-name").allInnerTexts(),
    ["表格看板", "名单查询", "项目进度", "时间线", "介绍页", "小游戏", "空网站"]);
  assert.deepEqual(await picker.locator(".template-card .template-tag").allInnerTexts(),
    ["接一张表格", "接一张表格", "接一张表格", "接一张表格", "不接表格", "不接表格", "不接表格"]);
  assert.deepEqual(await picker.locator(".style-chip").allInnerTexts(), ["简约", "科技", "立体"]);
  assert.equal(await picker.locator('.style-chip[data-style="clean"]').getAttribute("aria-pressed"), "true");
  // Every template shows a picture of itself, and it is really drawn -- an
  // <img> that failed to decode is still an <img>. Decoding a data URL is fast
  // but not instant, so wait for it: measuring naturalWidth the moment the card
  // appears reads 0 from an image that is perfectly fine a tick later.
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll(".template-dialog .template-card img")];
    return images.length === 6 && images.every((image) => image.complete && image.naturalWidth > 0);
  }, null, { polling: 100 });
  const shots = await picker.locator(".template-card img").evaluateAll((images) => images.map((image) => ({
    template: image.closest(".template-card").dataset.template, width: image.naturalWidth, height: image.naturalHeight,
    box: Math.round(image.getBoundingClientRect().width), data: image.src.startsWith("data:image/png;base64,") })));
  assert.deepEqual(shots.map((shot) => shot.template), ["dashboard", "directory", "kanban", "timeline", "landing", "game"]);
  for (const shot of shots) {
    assert.equal(shot.data, true, `${shot.template} 的预览不是内嵌图片`);
    assert.equal(shot.width, 1200, `${shot.template} 的预览没有解码`);
    assert.equal(shot.height, 750, `${shot.template} 的预览尺寸不对`);
    assert.ok(shot.box > 120, `${shot.template} 的预览画出来只有 ${shot.box}px`);
  }
  await page.screenshot({ path: path.join(evidence, "desktop-site-templates.png"), scale: "css" });
  // Choosing a style changes what every card shows -- that is the axis working.
  const cleanShot = await picker.locator('.template-card[data-template="dashboard"] img').getAttribute("src");
  await picker.locator('.style-chip[data-style="tech"]').click();
  await page.waitForFunction((was) => {
    const image = document.querySelector('.template-dialog .template-card[data-template="dashboard"] img');
    return image && image.src !== was && image.complete && image.naturalWidth > 0;
  }, cleanShot, { polling: 100 });
  assert.equal(await picker.locator('.style-chip[data-style="tech"]').getAttribute("aria-pressed"), "true");
  await picker.locator('.style-chip[data-style="clean"]').click();
  await page.waitForFunction(() => document.querySelector('.template-dialog .style-chip[data-style="clean"]')
    ?.getAttribute("aria-pressed") === "true", null, { polling: 100 });
  await picker.locator('.template-card[data-template="dashboard"] .template-pick').click();
  await page.locator("#ask-input").fill(BASE);
  await page.locator("#ask-ok").click();
  const dialog = page.locator(".table-dialog");
  await dialog.waitFor();
  await dialog.locator('.table-field[data-field="fldOwner0001"]').waitFor();
  assert.deepEqual(await dialog.locator(".table-field-name").allInnerTexts(), ["名称", "数量", "负责人"]);
  assert.deepEqual(await dialog.locator(".table-field-type").allInnerTexts(), ["text", "number", "user"]);
  assert.match(await dialog.locator("header").innerText(), /客户台账/);
  assert.match(await dialog.locator("#table-note").innerText(), /已选 3 个字段/);

  // 2. One field is taken out of the slice, and that is the whole point: it
  //    must not appear anywhere downstream.
  await dialog.locator('.table-field[data-field="fldOwner0001"] input').uncheck();
  await dialog.locator("#table-note").filter({ hasText: "已选 2 个字段" }).waitFor();
  await dialog.locator("#table-rows").fill("200");
  await dialog.locator("#table-refresh").selectOption("300");
  await dialog.locator("#site-name").fill("客户看板");
  // The one control this smoke cannot press: the data-table selector is only
  // drawn when the source has more than one table, and the synthetic Base has
  // one. Everything else in this section is clicked here.

  // 3. Nothing is read until the card is answered, and the card names exactly
  //    what was picked.
  await dialog.locator("#table-build").click();
  const card = page.locator("#confirmations .confirm-card");
  await card.waitFor();
  assert.equal(await card.locator("strong").first().innerText(), "确认把表格接进这个网站");
  const detail = await card.locator("pre").innerText();
  assert.match(detail, /字段：名称、数量/);
  assert.equal(detail.includes("负责人"), false, "a field left out of the slice is not in the card either");
  assert.match(detail, /最多行数：200/);
  assert.match(detail, /可写字段：无（只读）/);
  assert.match(await card.innerText(), /以你本人的飞书身份读取/);
  await waitForHumanChoice(card, "读取并建站");
  await page.locator(".site-row").waitFor();

  // 3b. Making it opened it. Before this, the very next question after building
  //     a site was 谁可以打开 -- a sharing decision about a page nobody had
  //     seen. It may already be up by the time the list finished redrawing, so
  //     look before waiting: waiting on an event that already fired hangs.
  // The window's own title, not document.title -- Playwright's page.title()
  // reads the DOM, and the whole point of this title is that the page does not
  // get to write it. Its <title> says 数据看板; the window has to say whose site
  // this is and that nobody else can see it yet.
  const built = await otherWindow();
  await built.waitForLoadState("domcontentloaded");
  assert.equal(await built.title(), "数据看板", "预览打开的不是这个模版的页面");
  assert.equal((await windowTitles()).includes("客户看板 · 本地预览（还没有发布）"), true, (await windowTitles()).join(" / "));
  await built.locator("#rows tr").first().waitFor();
  assert.equal(await built.locator("#rows").innerText().then((text) => text.includes("负责人")), false,
    "预览里出现了没选的字段");
  // A page, so it gets nothing a page does not need: the opener is denied.
  assert.equal(await built.evaluate(() => window.open("https://example.com") === null), true, "预览里的页面开得出新窗口");
  await built.close();


  // 4. The site is in the list, with its own folder, and only the confirmed
  //    fields are in the contract that was written there.
  assert.match(await page.locator(".site-row .site-name").innerText(), /客户看板/);
  // The line says when it will re-read, and that this machine is what does it:
  // a published page stops following the table when the application is closed,
  // and a sentence that hides that is worse than no sentence.
  assert.match(await page.locator(".site-row .site-meta").innerText(),
    /接了表格 · 2 个字段 · 2 行 · 每 5 分钟（发布后开始自动读取） · 上次 /);
  // The site's folder is in this account's own data; the smoke finds it the
  // same way a person would: it is the only one with a contract in it.
  const folder = await (async function find(at, depth = 0) {
    if (depth > 6) return null;
    for (const entry of await readdir(at, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const here = path.join(entry.parentPath ?? at, entry.name);
      if (entry.name === "data" && (await readdir(here)).includes("schema.json")) return path.dirname(here);
      const found = await find(here, depth + 1);
      if (found) return found;
    }
    return null;
  })(path.join(directory, "data"));
  assert.ok(folder, "the site's folder was not found in this account's data");
  const at = (name) => path.join(folder, "data", name);
  assert.deepEqual((await readdir(path.join(folder, "data"))).sort(), ["schema.json", "table-data.js", "table.js"]);
  const schema = JSON.parse(await readFile(at("schema.json"), "utf8"));
  assert.deepEqual(schema.fields.map((field) => [field.name, field.type]), [["名称", "text"], ["数量", "number"]]);
  assert.equal(schema.rows.limit, 200);
  assert.equal(schema.refreshSeconds, 300, "切片里记的是选的刷新间隔");
  const data = await readFile(at("table-data.js"), "utf8");
  assert.equal(data.includes("负责人"), false, "the field the person removed never reached the project");
  assert.equal(data.includes("fldOwner0001"), false);
  assert.equal(data.includes("张三"), false, "nor did its values");

  // 5. A cell that looks like markup is a string, and stays one: the runtime
  //    hands the page text, and loading the pair runs nothing from the table.
  const context = vm.createContext({ console });
  vm.runInContext(data, context);
  vm.runInContext(await readFile(at("table.js"), "utf8"), context);
  assert.equal(context.Table.rowCount(), 2);
  assert.equal(context.Table.rows()[0].text("名称"), "<img src=x onerror=window.__basePwned=true>探针一");
  assert.equal(context.Table.rows()[1].value("数量"), 2);
  assert.equal(context.__basePwned, undefined);

  // 6. The template is in the folder too, and it is the page a person opens.
  assert.deepEqual((await readdir(folder)).sort(), ["data", "index.html", "site.css", "site.js"]);
  const shown = await renderInElectron(path.join(folder, "index.html"));
  assert.equal(shown.title, "客户看板", "看板用的是这个网站的名字，不是把字段名拼起来");
  assert.match(shown.tile, /^2\n?条记录$/, `概览块显示的是 ${JSON.stringify(shown.tile)}`);
  assert.equal(shown.count, "2 条");
  assert.deepEqual(shown.columns, ["名称", "数量"]);
  assert.match(shown.text, /探针二/);
  assert.equal(shown.text.includes("负责人"), false, "没选的字段不会出现在页面上");
  assert.equal(shown.pwned, false, "页面执行了表格里的内容");
  assert.equal(shown.rows, 2);

  // 7. A site that is only files sits in the same list: no table, nothing read.
  await page.locator("#site-new").click();
  await page.locator('.template-dialog .template-card[data-template="game"] .template-pick').click();
  await page.locator("#ask-input").fill("贪吃蛇");
  await page.locator("#ask-ok").click();
  await page.locator(".site-row").nth(1).waitFor();

  // ...and it is a game somebody can actually play. Left alone, the snake runs
  // into the wall on its own, which is the one thing about it that is not
  // random: if the loop does not run, this never happens.
  const gameFolder = (await readdir(path.dirname(folder))).map((name) => path.join(path.dirname(folder), name))
    .find((at) => at !== folder);
  assert.deepEqual((await readdir(gameFolder)).sort(), ["game.js", "index.html", "site.css"]);
  const played = await playGame(path.join(gameFolder, "index.html"));
  assert.equal(played.started, true, "点了开始，幕布没收起来");
  assert.match(played.ended, /撞到了 · 得分 \d+/);
  // A site with no table opens the same way, and what opens is the game.
  const shot = await otherWindow();
  await shot.waitForLoadState("domcontentloaded");
  assert.equal((await windowTitles()).includes("贪吃蛇 · 本地预览（还没有发布）"), true, (await windowTitles()).join(" / "));
  assert.equal(await shot.locator("#start").count(), 1, "预览里的游戏没有画出来");
  await shot.close();

  const kinds = await page.locator(".site-row .site-meta").allInnerTexts();
  assert.equal(kinds.filter((line) => line.startsWith("只有文件，不接表格")).length, 1);
  // And the button on the row opens the table-backed one, which is where the
  // typed cells have to show up: a person chip is how you can tell at a glance
  // that the contract kept what the field meant.
  assert.equal(await page.locator(".site-row .site-preview").count(), 2, "每个网站都能预览");
  await page.locator('.site-row[data-site] .site-preview').first().click();
  const looked = await otherWindow();
  await looked.waitForLoadState("domcontentloaded");
  assert.equal((await windowTitles()).includes("客户看板 · 本地预览（还没有发布）"), true, "从列表上点开的不是这个网站");
  await looked.locator("#rows tr").first().waitFor();
  await looked.close();
  // Neither is published yet, and only the table-backed one can be re-read.
  assert.equal(kinds.filter((line) => line.endsWith("未发布")).length, 2);
  assert.equal(await page.locator(".site-row .site-refresh").count(), 1, "only the table-backed site can be re-read");
  // Publishing is offered on both, and taking a site down is not offered until
  // there is something to take down.
  assert.equal(await page.locator(".site-row .site-publish").count(), 2);
  assert.equal(await page.locator(".site-row .site-unpublish").count(), 0);
  // The sharing panel speaks Feishu's words, and offers 跟随表格权限 only for a
  // site that has a table to follow.
  await page.locator('.site-row[data-site] .site-publish').first().click();
  const share = page.locator(".share-dialog");
  await share.waitFor();
  assert.deepEqual(await share.locator(".share-scope strong").allInnerTexts(), ["跟随表格权限", "仅邀请的人可访问", "组织内获得链接的人可阅读"]);
  assert.equal(await share.locator("#share-inherit").isChecked(), true, "接了表格的网站默认跟随表格权限");
  await share.getByRole("button", { name: "取消" }).click();
  await share.waitFor({ state: "detached" });

  // 8. Published, for real: the sharing panel, the confirmation card nobody can
  //    click for you, and a link that the server agrees exists.
  await page.locator('.site-row[data-site] .site-publish').first().click();
  const publishShare = page.locator(".share-dialog");
  await publishShare.waitFor();
  await publishShare.locator("#share-tenant").check();
  await publishShare.locator("#share-confirm").click();
  const publishCard = page.locator("#confirmations .confirm-card");
  await publishCard.waitFor();
  assert.equal(await publishCard.locator("strong").first().innerText(), "确认发布这个网站");
  assert.match(await publishCard.locator("pre").innerText(), /谁能打开：组织内获得链接的人可阅读/);
  await waitForHumanChoice(publishCard, "发布");
  await page.locator(".site-row .site-link").first().waitFor();
  assert.match(await page.locator(".site-row .site-meta").first().innerText(), /已发布 · 组织内获得链接的人可阅读/);
  const serverSide = published.list({ ownerId: "ou_owner" });
  assert.equal(serverSide.length, 1, "服务端应当真的收到了这个网站");
  assert.equal(serverSide[0].share.scope, "tenant");
  assert.equal(serverSide[0].offline, false);
  assert.ok((await published.file(serverSide[0].id, "/")).bytes.toString().includes("data/table-data.js"), "发布的是模版页面本身");
  assert.deepEqual((await published.data(serverSide[0].id)).snapshot.rowCount, 2, "数据跟着版本一起上去了");

  // 8b. And the link can actually be copied. The window denies every web
  //     permission, so navigator.clipboard is refused there -- this is the one
  //     place that would have caught that, and it only catches it by clicking.
  //     The clipboard belongs to whoever is at this machine, so it is put back.
  const before = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await page.locator(".site-row .site-link").first().click();
    await page.locator(".site-row .site-link").filter({ hasText: "已复制" }).first().waitFor();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(copied, `https://sites.test/s/${serverSide[0].id}/`, "复制到剪贴板的不是这个网站的链接");
  } finally {
    await app.evaluate(({ clipboard }, text) => text ? clipboard.writeText(text) : clipboard.clear(), before);
  }

  // 9. Taken offline, then back up -- without sending the bytes again.
  await page.locator(".site-row .site-unpublish").first().click();
  const downCard = page.locator("#confirmations .confirm-card");
  await downCard.waitFor();
  assert.match(await downCard.locator("pre").innerText(), /随时可以「重新发布」/);
  await waitForHumanChoice(downCard, "取消发布");
  await page.locator(".site-row .site-republish").first().waitFor();
  assert.match(await page.locator(".site-row .site-meta").first().innerText(), /已下线（版本还在，可重新发布）/);
  assert.equal(published.get(serverSide[0].id).offline, true);
  await page.locator(".site-row .site-republish").first().click();
  await page.locator(".site-row .site-link").first().waitFor();
  assert.equal(published.get(serverSide[0].id).offline, false);
  assert.equal(published.get(serverSide[0].id).version, serverSide[0].version, "同一个版本回来了");

  // 9b. Re-reading the table on a published site: the local contract is
  //     rewritten and the server is given the same numbers. Another path with
  //     its own call to the control plane, and therefore another button that
  //     has to be pressed rather than drawn.
  const beforeReads = await app.evaluate(() => globalThis.tableFixture.reads);
  await page.locator(".site-row .site-refresh").first().click();
  // The click returns before the read does, so wait for the read itself rather
  // than for a line of text that was already on screen.
  for (let waited = 0; waited < 100; waited += 1) {
    if (await app.evaluate(() => globalThis.tableFixture.reads) > beforeReads) break;
    await page.waitForTimeout(100);
  }
  assert.equal(await app.evaluate(() => globalThis.tableFixture.reads), beforeReads + 1, "重新读取应当真的去读一次表");
  assert.equal((await published.data(serverSide[0].id)).snapshot.rowCount, 2, "线上数据跟着更新");

  // 9b2. Changing the look afterwards, and pushing it out. A style is one
  //      stylesheet, so this replaces one file; the page's structure and
  //      behaviour are the scenario's and do not move. And what is online only
  //      changes when 更新线上 is pressed -- before this existed, editing a
  //      published site changed nothing anybody else could see.
  const row = page.locator('.site-row[data-site]').first();
  assert.match(await row.locator(".site-meta").innerText(), /已发布/);
  const onlineBefore = (await published.file(serverSide[0].id, "site.css")).bytes.toString();
  assert.match(onlineBefore, /简约/, "发布出去的是简约那一份");
  await row.locator(".site-restyle").click();
  const restyle = page.locator(".share-dialog");
  await restyle.waitFor();
  assert.deepEqual(await restyle.locator(".share-scope strong").allInnerTexts(), ["简约", "科技", "立体"]);
  assert.equal(await restyle.locator("#restyle-clean").isChecked(), true, "面板应当显示它现在穿的那一个");
  await restyle.locator("#restyle-tech").check();
  await restyle.locator("#restyle-confirm").click();
  await restyle.waitFor({ state: "detached" });
  await (await otherWindow()).close();   // the preview it opened to show the new look
  // Local now, online not yet: that is the promise 发布 makes.
  assert.equal((await published.file(serverSide[0].id, "site.css")).bytes.toString(), onlineBefore, "没点更新，线上就不该变");
  await page.locator('.site-row[data-site]').first().locator(".site-update").click();
  const updateCard = page.locator("#confirmations .confirm-card");
  await updateCard.waitFor();
  assert.equal(await updateCard.locator("strong").first().innerText(), "确认更新线上版本");
  assert.match(await updateCard.locator("pre").innerText(), /（不变）/, "更新内容不是一次分享决定");
  await waitForHumanChoice(updateCard, "更新");
  await page.waitForFunction(async () => true, null, { polling: 100 });
  const after = published.list({ ownerId: "ou_owner" }).find((one) => one.id === serverSide[0].id);
  for (let waited = 0; waited < 100 && after.version === serverSide[0].version; waited += 1) await page.waitForTimeout(100);
  const online = published.list({ ownerId: "ou_owner" }).find((one) => one.id === serverSide[0].id);
  assert.notEqual(online.version, serverSide[0].version, "更新之后线上应当是一个新版本");
  assert.match((await published.file(serverSide[0].id, "site.css")).bytes.toString(), /科技/, "线上换成了科技那一份");
  assert.equal(online.share.scope, "tenant", "更新内容不会改动谁能打开");

  // 9c. The sharing panel on a site that is already published changes the
  //     scope in place, with no new upload.
  // Whatever version is online now: 更新线上 above made a new one, and this
  // step is about sharing, which must not make another.
  const settled = published.get(serverSide[0].id).version;
  await page.locator(".site-row .site-share").first().click();
  const again = page.locator(".share-dialog");
  await again.waitFor();
  assert.equal(await again.locator("#share-inherit").isChecked(), false, "面板应当显示它当前的档位");
  assert.equal(await again.locator("#share-tenant").isChecked(), true);
  await again.locator("#share-invited").check();
  await again.locator("#share-confirm").click();
  await page.locator(".site-row .site-meta").first().filter({ hasText: "仅邀请的人可访问" }).waitFor();
  assert.equal(published.get(serverSide[0].id).share.scope, "invited");
  assert.equal(published.get(serverSide[0].id).version, settled, "改档位不会产生新版本");

  // 10. Editing a site opens a coding task on its own folder.
  await page.locator('.site-row[data-site] .site-edit').first().click();
  await page.locator("#project-chip").waitFor();
  assert.match(await page.locator("#project-name").innerText(), /客户看板/);

  // 11. Moving a site out of the list: a card, and the folder is kept.
  await page.locator('[data-section="sites"]').click();
  await page.locator("#site-list").waitFor();
  // Both sites made so far are here before anything is read.
  await page.locator(".site-row").nth(1).waitFor();
  const going = await page.locator(".site-row").last().locator(".site-name").innerText();
  const kept = await page.locator(".site-row").first().locator(".site-name").innerText();
  await page.locator(".site-row .site-forget").last().click();
  const forgetCard = page.locator("#confirmations .confirm-card");
  await forgetCard.waitFor();
  assert.match(await forgetCard.locator("pre").innerText(), /目录和里面的文件都保留/);
  await waitForHumanChoice(forgetCard, "移出列表");
  // Which row is left, by name. Counting rows is unreliable here for a reason
  // worth writing down: the list is redrawn by replacing its children, so there
  // is a moment when it holds none, and a count taken then is 0 for a redraw
  // rather than for a removal.
  await page.locator(".site-row").filter({ hasText: kept }).waitFor();
  assert.equal(await page.locator(".site-row").filter({ hasText: going }).count(), 0, `「${going}」应当已经移出列表`);
  assert.deepEqual((await readdir(gameFolder)).sort(), ["game.js", "index.html", "site.css"], "目录没被删");

  const reads = await app.evaluate(() => globalThis.tableFixture.reads);
  assert.equal(shown.rows, 2);
  // Building the site read the slice once; 重新读取 read it once more. Opening
  // the page, publishing it and changing its sharing read it no times at all --
  // and the clock did not read it either, because this site asked for every 5
  // minutes and this smoke is not 5 minutes long.
  assert.equal(reads, 2, "只有建站和重新读取会去读表，其他都不该读");

  // 12. 数值会跟着表格走 -- the clock.
  //
  // Everything downstream of it was built and tested first: the digest notices,
  // the server pushes `changed`, the page re-fetches. What did not exist was
  // the thing that looks. 每 N 分钟 was stored on the slice and printed in this
  // list, and no code read it, so a published site only ever changed when
  // somebody pressed 重新读取. This section is that gap, in the real
  // application: publish a site that asks for every 15 seconds, change the
  // table underneath it, and wait for the numbers to arrive at the server
  // without anybody touching anything.
  await page.locator("#site-new").click();
  await page.locator('.template-dialog .template-card[data-template="dashboard"] .template-pick').click();
  await page.locator("#ask-input").fill(BASE);
  await page.locator("#ask-ok").click();
  const live = page.locator(".table-dialog");
  await live.waitFor();
  await live.locator("#table-refresh").selectOption("15");
  await live.locator("#site-name").fill("跟着表格走");
  await live.locator("#table-build").click();
  const liveCard = page.locator("#confirmations .confirm-card");
  await liveCard.waitFor();
  await waitForHumanChoice(liveCard, "读取并建站");
  const liveRow = page.locator(".site-row").filter({ hasText: "跟着表格走" });
  await liveRow.waitFor();
  await (await otherWindow()).close();   // the preview it opened on creation
  await liveRow.locator(".site-publish").click();
  await page.locator(".share-dialog #share-confirm").click();
  const liveConfirm = page.locator("#confirmations .confirm-card");
  await liveConfirm.waitFor();
  await waitForHumanChoice(liveConfirm, "发布");
  await liveRow.locator(".site-link").waitFor();
  const liveId = published.list({ ownerId: "ou_owner" }).find((one) => one.name === "跟着表格走").id;
  assert.equal((await published.data(liveId)).snapshot.rowCount, 2);

  // A third record appears in the table. Nobody presses anything after this.
  await app.evaluate(() => {
    globalThis.tableFixture.records.recSynthetic003 =
      { fldName00001: "探针三", fldCount0001: 3, fldOwner0001: [] };
  });
  let arrived = null;
  for (let waited = 0; waited < 400 && !arrived; waited += 1) {
    const data = await published.data(liveId);
    if (data?.snapshot?.rowCount === 3) arrived = data;
    else await page.waitForTimeout(250);
  }
  assert.ok(arrived, "表里多了一行，等了 100 秒线上还是旧数据 —— 自动读取没有发生");
  assert.equal(arrived.snapshot.rows.at(-1).values.fldName00001.text, "探针三", "读到的不是新那一行");
  // And the list says so without being clicked, because the read tells it to.
  await liveRow.locator(".site-meta").filter({ hasText: "3 行" }).waitFor();
  assert.match(await liveRow.locator(".site-meta").innerText(), /每 15 秒 自动读取（应用开着时）/);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, syntheticFeishu: true, paidCalls: 0,
    templates: 7, styles: 3, liveDemo: true, fieldsOffered: 3, fieldsConfirmed: 2, cardAnswered: true, contractWritten: 3,
    templateRendered: shown.rows + " rows", upstreamReads: reads, clockFollowedTheTable: true }));
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => null);
    if (page) console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0],
      banner: await page.locator("#error-banner").innerText().catch(() => ""),
      dialog: await page.locator(".table-dialog").innerText().catch(() => "") }));
  }
  throw error;
} finally {
  await app?.close();
  control?.close(); control?.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// The game template, played. A game that renders and does nothing is not a
// game, and a screenshot cannot tell the difference.
async function playGame(file) {
  const entry = path.join(await mkdtemp(path.join(os.tmpdir(), "idou-play-")), "electron-entry.cjs");
  await writeFile(entry, `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => { const win = new BrowserWindow({ width: 700, height: 900, show: false }); await win.loadFile(${JSON.stringify(file)}); });
app.on("window-all-closed", () => {});`);
  const instance = await electron.launch({ executablePath: electronBinary, args: [entry], timeout: 30_000 });
  try {
    const window = await instance.firstWindow();
    const failures = [];
    window.on("pageerror", (error) => failures.push(error.message));
    await window.locator("#start").click();
    const started = await window.locator("#curtain").isHidden();
    // 20 cells, starting at x=8 moving right, 110ms a step: the wall is about
    // 1.3 seconds away. Two seconds is that with room to spare.
    await window.locator("#curtain:not([hidden])").waitFor({ timeout: 5_000 });
    const ended = await window.locator("#message").innerText();
    assert.deepEqual(failures, [], "游戏页面报错了");
    return { started, ended };
  } finally { await instance.close(); }
}

// The generated site in a real browser, which is the only way to know that a
// template works: a page that throws renders nothing and says nothing.
async function renderInElectron(file) {
  // The helper goes anywhere but the site's own folder: this folder is about to
  // be packaged, and a file the package does not allow fails the publish.
  const entry = path.join(await mkdtemp(path.join(os.tmpdir(), "idou-render-")), "electron-entry.cjs");
  await writeFile(entry, `const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => { const win = new BrowserWindow({ width: 1000, height: 780, show: false }); await win.loadFile(${JSON.stringify(file)}); });
app.on("window-all-closed", () => {});`);
  const instance = await electron.launch({ executablePath: electronBinary, args: [entry], timeout: 30_000 });
  try {
    const window = await instance.firstWindow();
    const failures = [];
    window.on("pageerror", (error) => failures.push(error.message));
    await window.locator("#rows tr").first().waitFor({ timeout: 15_000 });
    const shown = { text: await window.locator("body").innerText(), rows: await window.locator("#rows tr").count(),
      title: await window.locator("#title").innerText(), tile: await window.locator("#tiles .tile").first().innerText(),
      count: await window.locator("#count").innerText(), columns: await window.locator("#head-row th").allInnerTexts(),
      pwned: await window.evaluate(() => Boolean(window.__basePwned)) };
    assert.deepEqual(failures, [], "模版页面报错了");
    return shown;
  } finally { await instance.close(); }
}
