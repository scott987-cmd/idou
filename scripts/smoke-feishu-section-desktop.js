// The embedded Feishu page stays exactly over the box the section gives it.
//
// The page is a native layer above the DOM, so it only moves when the renderer
// measures #feishu-chat-area again and tells the main process. That happened on
// window resize and scroll, but not when something above the area appeared:
// the error banner pushed the area down and the Feishu page stayed where it was,
// covering the banner's text (found reading the code after 2026-09-24's report
// of a cramped Feishu section).
//
// Inside the page, the messenger's own layout follows the rail: hiding Feishu's
// rail is a style sheet, and the messenger only lays itself out again on a
// resize, so the rail's width stayed behind as an empty strip down the right
// with the conversation list folded away (seen on the installed app, measured on
// Feishu's own page the same day). The synthetic messenger here is laid out the
// way Feishu's is.
//
// And the page stays on screen when something appears that is not over it: a
// card waiting in the dock beside it, or a window narrowed below 960 px, which
// used to open the sidebar over the section and hide the page behind it. What
// opens in the dock opens beside the page too: the composer's menus once slid
// under it.
//
//   node scripts/smoke-feishu-section-desktop.js
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { startFeishuSection, sleep, until } from "./fixtures/feishu-section-harness.js";

const section = await startFeishuSection({ prefix: "idou-feishu-section-" });
try {
  const { page, web, onScreen, errors } = section;
  await section.fixture({ messengerLayout: true });
  await section.signIn();
  await page.locator('[data-section="feishu"]').click();
  await until(web, (value) => value.state === "verified", "the pages verified as the signed-in person");
  const messenger = async () => (await onScreen()).find((view) => view.url.includes("/messenger"));
  const area = () => page.evaluate(() => {
    const rect = document.querySelector("#feishu-chat-area").getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  });
  const banner = () => page.evaluate(() => {
    const element = document.querySelector("#error-banner");
    return element.hidden ? null : Math.round(element.getBoundingClientRect().bottom);
  });
  // Where the page is against where it should be, a few frames after a change.
  const placement = async () => {
    await sleep(400);
    return { view: (await messenger())?.bounds ?? null, area: await area(), banner: await banner() };
  };
  const matches = ({ view, area: box }) => Boolean(view) && ["x", "y", "width", "height"].every((key) => Math.abs(view[key] - box[key]) <= 1);

  const before = await until(placement, matches, "the messenger placed over its area");
  assert.ok(matches(before));

  console.log("出错提示条出现：");
  // What error() does: the text, and the banner shown.
  await page.evaluate(() => { const element = document.querySelector("#error-banner"); element.textContent = "合成的出错提示：飞书页面不能盖住这一行"; element.hidden = false; });
  const shown = await placement();
  assert.ok(shown.banner !== null && shown.area.y >= shown.banner, `the banner pushed the area down: area.y=${shown.area.y}, banner bottom=${shown.banner}`);
  assert.ok(matches(shown), `the Feishu page followed its area down instead of covering the banner: view=${JSON.stringify(shown.view)} area=${JSON.stringify(shown.area)}`);
  assert.ok(shown.view.y >= shown.banner, "and the banner's text is not under the page");

  console.log("出错提示条消失：");
  await page.evaluate(() => { const element = document.querySelector("#error-banner"); element.textContent = ""; element.hidden = true; });
  const hidden = await placement();
  assert.ok(matches(hidden), `the page followed its area back up: view=${JSON.stringify(hidden.view)} area=${JSON.stringify(hidden.area)}`);

  console.log("飞书导航栏显示、隐藏：");
  // What the messenger page itself shows, in its own coordinates: the rail, the
  // content beside it, and in the content the list and the conversation.
  const panes = () => section.app.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL().includes("/messenger"));
    return contents?.executeJavaScript(`(() => {
      const box = (selector) => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect && rect.width ? { left: Math.round(rect.left), right: Math.round(rect.right) } : null; };
      return { viewport: innerWidth, rail: box(".appNavbar"), content: box("#app-page-container"), list: box(".page-view-messenger"), chat: box(".page-view-messenger-chat") };
    })()`);
  });
  // The conversation ends where the content ends: no strip after it, nothing
  // pushed past it, and the content itself inside the page.
  const fills = (value) => Boolean(value?.content && value.chat) && Math.abs(value.chat.right - value.content.right) <= 1 && value.content.right <= value.viewport;
  const railShown = (value) => value?.rail?.left === 0 && value.rail.right === 156;
  const initially = await until(panes, (value) => fills(value) && !value.rail, "the messenger laid out with its rail hidden");
  assert.ok(initially.list, `wide enough for the conversation list beside the conversation: ${JSON.stringify(initially)}`);
  const toggle = page.locator("#feishu-rail-toggle");
  await toggle.click();
  await until(panes, railShown, "Feishu's rail shown");
  // Laid out with the rail there, the way a person resizing the window would
  // leave it: the conversation list folded, the conversation beside the rail.
  await section.app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; const [width, height] = win.getSize(); win.setSize(width + 24, height); });
  const beside = await until(panes, (value) => railShown(value) && fills(value) && !value.list, "the messenger laid out beside its rail");
  assert.equal(beside.content.left, 156);
  await toggle.click();
  await until(panes, (value) => Boolean(value) && !value.rail, "Feishu's rail hidden again");
  await sleep(600);
  const without = await panes();
  assert.ok(fills(without), `the conversation reaches the edge again -- no empty strip where the rail was: ${JSON.stringify(without)}`);
  assert.ok(without.list, `and the conversation list is back: ${JSON.stringify(without)}`);
  await toggle.click();
  await until(panes, railShown, "Feishu's rail shown again");
  await sleep(600);
  const pushed = await panes();
  assert.ok(fills(pushed), `showing the rail does not push the conversation past the edge: ${JSON.stringify(pushed)}`);
  await toggle.click();
  await until(panes, (value) => !value?.rail && fills(value), "back to the rail hidden, as it started");

  console.log("待确认卡片：");
  // A card waiting for the person sits in the dock, beside the page. The page used
  // to be hidden for as long as any card waited, so a 「发送回复」 card took away
  // the very conversation it was about (found reading the code, 2026-09-24).
  // The card is the main process's own event, not a click on anyone's behalf.
  const card = { id: "synthetic-card-feishu-section", title: "发送回复", message: "合成的确认卡片：旁边的飞书页面应当还在", detail: "", boundary: "",
    buttons: ["取消", "发送"], defaultId: 1, cancelId: 0, danger: false, issuedAt: Date.now(), expiresAt: Date.now() + 120_000 };
  const toRenderer = (channel, value) => section.app.evaluate(({ BrowserWindow }, [name, payload]) => BrowserWindow.getAllWindows()[0].webContents.send(name, payload), [channel, value]);
  await toRenderer("idou:confirm", card);
  await page.locator(`#feishu-agent-dock [data-confirm-id="${card.id}"] button`).first().waitFor();
  const waiting = await placement();
  assert.ok(matches(waiting), `the page stays over its area while the card waits beside it: view=${JSON.stringify(waiting.view)} area=${JSON.stringify(waiting.area)}`);
  const cardBox = await page.locator(`[data-confirm-id="${card.id}"]`).boundingBox();
  assert.ok(cardBox.x >= waiting.view.x + waiting.view.width, `and the card is beside the page, not under it: card=${JSON.stringify(cardBox)} view=${JSON.stringify(waiting.view)}`);
  await toRenderer("idou:confirm-withdrawn", { id: card.id, reason: "withdrawn" });
  // Withdrawing says so in the banner; this run is done with the card.
  await page.evaluate(() => { const element = document.querySelector("#error-banner"); element.textContent = ""; element.hidden = true; });
  await until(placement, matches, "the page over its area once the card is gone");

  console.log("窗口变窄：");
  // Below 960 px the sidebar opened over the section, and the page -- a native
  // layer an overlay can only be shown over by hiding it -- stayed blank until
  // the sidebar was closed by hand.
  const size = await section.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize());
  await section.app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(900, win.getSize()[1]); });
  const narrow = await until(placement, (value) => matches(value) && value.area.width > 0, "the page over its area on a narrow window");
  assert.equal(await page.evaluate(() => document.body.classList.contains("sidebar-overlay")), false, "no sidebar laid over the page");
  assert.ok(narrow.area.x < 236, `the sidebar folded away to make room: area=${JSON.stringify(narrow.area)}`);
  await section.app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size);
  await until(placement, matches, "the page over its area at the old width again");

  console.log("飞书地址重定向到外面：");
  // Only Feishu's own pages belong in the section, and navigation was held to
  // that -- but not a redirect: a Feishu address answering with one put the
  // page it named inside the section, looking like part of the app (found
  // reading the code, 2026-09-24). It opens in the real browser instead.
  const outside = "https://outside.example/landing";
  const launched = () => section.app.evaluate(() => globalThis.loginFixture.launches);
  const launchedBefore = (await launched()).length;
  await section.app.evaluate(async ({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL().includes("/messenger"));
    await contents.loadURL(target).catch(() => {});
  }, `https://fixture.feishu.cn/fixture/leave?to=${encodeURIComponent(outside)}`);
  await sleep(600);
  const showing = await section.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => item.getURL()).filter((url) => url.includes("outside.example")));
  assert.deepEqual(showing, [], "no view shows the page outside Feishu");
  assert.deepEqual((await launched()).slice(launchedBefore), [outside], "it went to the real browser instead");
  assert.ok(await messenger(), "and the messenger is still what the section shows");

  console.log("重启之后：");
  // Feishu shows the person its page on every probe, so a verdict that did not
  // outlive the process put that page in front of them after every restart --
  // and, until the fix before this one, left the callback's JSON over the
  // messenger (2026-09-24).
  const accounts = path.join(section.directory, "accounts");
  const verdictFile = async () => path.join(accounts, (await readdir(accounts)).find((name) => /^[0-9a-f]{64}$/.test(name)), "web-identity.json");
  const kept = await until(async () => JSON.parse(await readFile(await verdictFile(), "utf8").catch(() => "null")), Boolean, "the verdict written down");
  assert.equal(kept.state, "verified");
  assert.match(kept.session, /^[0-9a-f]{64}$/, "bound to a digest of the pages' session");
  assert.ok(!JSON.stringify(kept).includes("alpha-session"), "never the cookie itself");
  await section.relaunch();
  await section.page.locator('[data-section="feishu"]').click();
  const again = await until(section.web, (value) => value.state === "verified", "the kept verdict after a restart", 15_000);
  await sleep(2000);
  assert.deepEqual(await section.read("authorizations"), [], "no probe after the restart: nothing was put in front of the person");
  assert.equal(again.checkedAt, kept.checkedAt, "the verdict is the one reached before");

  console.log("网页重新登录之后：");
  await section.app.evaluate(async () => {
    const session = globalThis.webIdentityFixture.pageSessions.at(-1);
    await session.cookies.set({ url: "https://fixture.feishu.cn/", domain: ".feishu.cn", name: "session", value: "alpha-session-2", secure: true, expirationDate: Date.now() / 1000 + 30 * 86400 });
  });
  await until(section.web, (value) => value.state === "verified" && value.checkedAt !== kept.checkedAt, "a fresh verdict for the new session", 40_000);
  assert.equal((await section.read("authorizations")).length, 1, "a different session is checked afresh");
  const rewritten = JSON.parse(await readFile(await verdictFile(), "utf8"));
  assert.notEqual(rewritten.session, kept.session, "and the kept verdict now names the new session");

  console.log("侧栏输入框的菜单：");
  // The composer's menus are lifted to the top of the page so the Accessibility
  // API can reach them, and were then kept inside the window and nothing more:
  // in the dock, 知识 with a few long titles slid left to fit the window and the
  // start of every title was under the messenger (installed app, 2026-09-24).
  // 知识 belongs to a task, so one is started for the chat the page shows; its
  // titles are the knowledge copy's, answered here for a copy this run has none of.
  const now = section.page;
  const titles = ["供应商框架合同摘要（QL-HT-2026-0328）", "面向私有化客户的企业桌面 Agent — 产品说明（首发稿 v0.1，内部评审用）",
    "新员工入职指引（2026 年 8 月更新）", "信息安全管理规范 V2.0"];
  await section.app.evaluate(({ ipcMain }, names) => {
    ipcMain.removeHandler("idou:knowledge-graph-snapshot");
    ipcMain.handle("idou:knowledge-graph-snapshot", () => ({ nodes: names.map((title, index) => ({ id: `synthetic-note-${index}`, title })) }));
  }, titles);
  await until(() => now.evaluate(() => window.idou.dockedChat()), (value) => Boolean(value?.name), "the page's chat named beside it", 30_000);
  const started = await now.evaluate(async () => {
    const created = await window.idou.createTask({ mode: "cowork" });
    return window.idou.bindFeishuChat(created.id);
  });
  assert.equal(started.bound, true, `the task belongs to the chat the page shows: ${JSON.stringify(started)}`);
  // Coming back is what has the dock look up the chat's conversation.
  await now.locator('[data-section="cowork"]').click();
  await now.locator('[data-section="feishu"]').click();
  await now.locator("#feishu-agent-dock #knowledge-scope-toggle").waitFor();
  const opensBeside = async (name, toggle, menu, shown) => {
    await now.locator(toggle).click();
    await now.locator(shown).first().waitFor();
    const view = (await until(messenger, Boolean, "the messenger still on screen")).bounds;
    const box = await now.locator(menu).boundingBox();
    const first = await now.locator(shown).first().boundingBox();
    const width = await now.evaluate(() => innerWidth);
    assert.ok(box.x >= view.x + view.width, `${name} opens beside the page, not under it: menu=${JSON.stringify(box)} page=${JSON.stringify(view)}`);
    assert.ok(first.x >= view.x + view.width, `and its first line starts where it can be seen: ${JSON.stringify(first)}`);
    assert.ok(box.x + box.width <= width, `and it ends inside the window: menu=${JSON.stringify(box)} window=${width}`);
    await now.keyboard.press("Escape");
    await now.locator(menu).waitFor({ state: "hidden" });
  };
  await opensBeside("知识", "#knowledge-scope-toggle", "#knowledge-scope-menu", "#knowledge-scope-menu .knowledge-pick span");
  await opensBeside("权限", "#permission-toggle", "#permission-menu", "#permission-menu button");
  assert.deepEqual(errors, []);
  console.log("feishu section smoke passed");
} finally {
  await section.close();
}
