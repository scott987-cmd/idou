import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { SiteService } from "../src/control-plane/site-service.js";
import { appHash } from "../src/apps/manifest.js";
import { waitForHumanChoice } from "./fixtures/agent-harness.js";

// 文档网站's list from the server, in the actual Electron application
// (docs/sites-phase0.md §0.5). Found in the 2026-10-03 benchmark: the list was
// only this computer's, so a site published from another computer had nowhere
// to be looked at, taken down or deleted, and 移出列表 left a site up with no
// way back to it. Here a site the server has and this computer does not is
// listed, looked at, brought onto this computer, hidden here and shown again;
// deleting it stops at the red deletion card, which is cancelled -- only the
// person answers one. Synthetic Feishu, no network, no model.
// --with-person: somebody at this machine answers the send card instead of it being cancelled.
const withPerson = process.argv.includes("--with-person");
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-list-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app, control = null;
const page = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>周报</title></head><body><h1 id=\"mark\">另一台电脑发布的周报</h1></body></html>";
const pack = (text) => ({
  manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(text), sha256: appHash(Buffer.from(text)) }] },
  blobs: [{ path: "index.html", base64: Buffer.from(text).toString("base64") }],
});
try {
  const published = await SiteRegistry.open(path.join(directory, "published"));
  const sessions = new SessionRegistry();
  const service = new SiteService({ sessions, registry: published, origin: "https://sites.test", notify: () => {} });
  // How long the server takes over a version's files: long enough, when set, to see the row say what it is doing.
  let slowFiles = 0;
  control = createServer(async (req, res) => {
    if (req.url === "/v1/sites/files" && slowFiles) await new Promise((resolve) => setTimeout(resolve, slowFiles));
    if (!await service.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  control.listen(0, "127.0.0.1"); await once(control, "listening");
  const session = sessions.issue({ tenantId: "synthetic", userId: "ou_owner", deviceId: "d1", authProvider: "feishu", appId: "cli_smoke", deviceProof: "ed25519-login" });
  const sessionFile = path.join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: `http://127.0.0.1:${control.address().port}` }), { mode: 0o600 });
  // Published from another computer: the server has it, this one has nothing of it.
  const elsewhere = await published.publish({ ownerId: "ou_owner", tenantId: "synthetic", name: "部门周报", share: { scope: "tenant" }, ...pack(page) });
  // Somebody else's site already called 周报 (an address name is unique on the server).
  const named = await published.publish({ ownerId: "ou_someone", tenantId: "synthetic", name: "别人的周报", share: { scope: "tenant" }, ...pack("<!doctype html><p>别人的</p>") });
  await published.setAddress(named.id, { ownerId: "ou_someone", address: "周报" });
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/site-versions-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile },
    timeout: 30_000 });
  const window = await app.firstWindow(); window.setDefaultTimeout(30_000);
  const errors = []; window.on("pageerror", (error) => errors.push(error.message));
  await window.locator("#new-task").waitFor();
  await window.locator('[data-section="sites"]').click();
  const remoteRow = window.locator(`.site-row[data-site="remote:${elsewhere.id}"]`);
  await remoteRow.waitFor();
  assert.match(await remoteRow.locator(".site-meta").innerText(), /这台电脑上没有它的目录 · 已发布 · 组织内获得链接的人可阅读/);
  // Nothing here to edit or re-read: it is looked at as it is up there, or brought here.
  assert.deepEqual(await remoteRow.locator(".site-row-actions > button").allInnerTexts(), ["预览", "下载到这台电脑", "分享设置", "复制链接", "⋯"]);
  await remoteRow.locator(".site-more").click();
  assert.deepEqual(await window.locator("#site-menu button").allInnerTexts(), ["历史版本", "取消发布", "二维码和发到群", "起地址名", "下线并删除"]);
  await window.keyboard.press("Escape");
  await window.locator("#site-menu").waitFor({ state: "hidden" });
  const box = await window.locator("#site-list").boundingBox();
  await window.screenshot({ path: path.join(evidence, "desktop-site-list-remote.png"), clip: box });

  // Looked at: the version up now, in a window that says it is only the owner's.
  const opening = app.waitForEvent("window", { timeout: 15_000 });
  await remoteRow.locator(".site-preview").click();
  const preview = await opening;
  await preview.locator("#mark").waitFor();
  assert.equal(await preview.locator("#mark").innerText(), "另一台电脑发布的周报");
  const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((one) => one.getTitle()));
  assert.ok(titles.includes("部门周报 · 线上版本（只有你能看到）"), titles.join(" / "));
  await preview.close();

  // Brought onto this computer: a folder of its own with the page in it, the
  // row now this computer's, joined to the same site. While it comes, the row
  // says so and does not offer it again (§0.7).
  slowFiles = 2000;
  await remoteRow.locator(".site-download").click();
  await remoteRow.locator(".site-progress").waitFor();
  assert.equal(await remoteRow.locator(".site-progress").innerText(), "正在下载到这台电脑……");
  assert.equal(await remoteRow.locator(".site-download").isDisabled(), true);
  assert.equal(await remoteRow.locator(".site-more").isDisabled(), false, "⋯ stays: 取消发布 is never held back");
  await window.screenshot({ path: path.join(evidence, "desktop-site-progress.png"), clip: await remoteRow.boundingBox() });
  await remoteRow.waitFor({ state: "detached" });
  slowFiles = 0;
  const local = await app.evaluate(() => globalThis.siteStoreFixture.list()[0]);
  assert.equal(local.publishedId, elsewhere.id, "the same site, not a second one");
  assert.equal(await readFile(path.join(local.folder, "index.html"), "utf8"), page);
  const row = window.locator(`.site-row[data-site="${local.id}"]`);
  await row.waitFor();
  assert.deepEqual(await row.locator(".site-row-actions > button").allInnerTexts(), ["预览", "用编程任务修改", "分享设置", "更新线上", "复制链接", "⋯"]);
  assert.equal(published.list({ ownerId: "ou_owner" }).length, 1);

  // 用编程任务修改 opens a coding task on the site's own folder, and a request
  // typed there and left unsent comes back with that folder after a look at
  // 设置 -- not in whichever project was used last, or none, one 发送 away from
  // going there (2026-10-08).
  await row.locator(".site-edit").click();
  await window.locator("#project-chip").waitFor();
  assert.match(await window.locator("#project-name").innerText(), new RegExp(local.name));
  await window.locator("#prompt").fill("把首页标题改大一点");
  await window.locator("#settings").click();
  await window.locator("#model-select").waitFor({ state: "attached" });
  await window.locator('[data-section="coding"]').click();
  await window.locator("#project-chip").waitFor({ timeout: 5_000 });
  assert.match(await window.locator("#project-name").innerText(), new RegExp(local.name), "the draft's folder came back with it");
  assert.equal(await window.locator("#prompt").inputValue(), "把首页标题改大一点");
  await window.locator("#prompt").fill("");
  await window.locator('[data-section="sites"]').click();
  await row.waitFor();

  // Hidden on this computer: out of the list, still up, listed apart and back again.
  await row.locator(".site-more").click();
  assert.deepEqual(await window.locator("#site-menu button").allInnerTexts(), ["历史版本", "取消发布", "二维码和发到群", "起地址名", "只在这台电脑隐藏", "下线并删除"]);
  await window.locator("#site-menu .site-hide").click();
  // Out of the list -- and into the folded one, which draws it too (hidden).
  // Waiting for it to leave the page altogether passed only when a poll fell
  // between two renders (failed in the acceptance run, 2026-10-06).
  await window.locator(`.site-hidden-list .site-row[data-site="${local.id}"]`).waitFor({ state: "attached" });
  assert.equal(await window.locator(`.site-row[data-site="${local.id}"]:visible`).count(), 0, "not in the list any more");
  const fold = window.locator(".site-hidden-toggle");
  assert.equal(await fold.innerText(), "只在这台电脑隐藏的网站（1 个，照常在线）");
  assert.equal(await window.locator(".site-hidden-list").isVisible(), false, "folded until asked for");
  await fold.click();
  const hiddenRow = window.locator(`.site-hidden-list .site-row[data-site="${local.id}"]`);
  assert.match(await hiddenRow.innerText(), /照常在线/);
  assert.equal(published.get(elsewhere.id).offline, false, "hiding here takes nothing down");
  assert.equal(await window.locator(`.site-row[data-site="remote:${elsewhere.id}"]`).count(), 0, "hidden here is not listed as somebody else's");
  await hiddenRow.locator(".site-unhide").click();
  await window.locator(`#site-list .site-row[data-site="${local.id}"]`).waitFor();

  // A name people can say (docs/sites-phase1.md §1.6): one taken is said in the
  // dialog, which stays open to try another; then the link reads by it.
  await window.locator(`#site-list .site-row[data-site="${local.id}"] .site-more`).click();
  await window.locator("#site-menu .site-address").click();
  const naming = window.locator("#site-address-dialog");
  await naming.waitFor();
  await naming.locator("#site-address-input").fill("周报");
  await naming.locator("#site-address-save").click();
  await naming.locator(".site-problems").filter({ hasText: "已经被别的网站用了" }).waitFor();
  await naming.locator("#site-address-input").fill("部门周报");
  await naming.locator("#site-address-save").click();
  await naming.waitFor({ state: "detached" });
  assert.equal(published.get(elsewhere.id).address, "部门周报");
  await window.locator(`#site-list .site-row[data-site="${local.id}"]`).waitFor();
  const drawn = (await window.evaluate(() => window.idou.sites())).find((row) => row.id === local.id);
  assert.equal(drawn.url, `https://sites.test/s/${encodeURIComponent("部门周报")}/`, "复制链接 copies the link by its name");

  // Handing the link on (docs/sites-phase1.md §1.4): its QR code, drawn here,
  // and into a group -- as the person, so a card, cancelled here. The copy
  // buttons are not pressed: the clipboard is whoever's at this machine.
  await window.locator(`#site-list .site-row[data-site="${local.id}"] .site-more`).click();
  await window.locator("#site-menu .site-share-out").click();
  const sharing = window.locator("#site-sharing");
  await sharing.waitFor();
  const qr = sharing.locator("img.sharing-qr");
  assert.match(await qr.getAttribute("src"), /^data:image\/svg\+xml;base64,/);
  assert.match(await qr.getAttribute("alt"), /扫码打开 https:\/\/sites\.test\/s\//);
  const qrBox = await qr.boundingBox();
  assert.ok(qrBox && qrBox.width >= 160, JSON.stringify(qrBox));
  await window.screenshot({ path: path.join(evidence, "desktop-site-sharing.png"), clip: await sharing.boundingBox() });
  await sharing.locator("#sharing-chat-search").fill("销售");
  await sharing.locator(".sharing-chat").first().click();
  await sharing.locator("#sharing-note").fill("本周的看板");
  await sharing.locator("#sharing-send").click();
  await sharing.waitFor({ state: "detached" });
  const sendCard = window.locator("#confirmations .confirm-card");
  await sendCard.waitFor();
  assert.equal(await sendCard.locator("strong").first().innerText(), "确认把网站发到飞书群");
  const sendText = await sendCard.innerText();
  assert.match(sendText, /销售群（合成）/);
  assert.match(sendText, /本周的看板/);
  assert.match(sendText, /群里的人能不能打开，看网站的「谁可以打开」：组织内获得链接的人可阅读/);
  // The person's card. Run --with-person, somebody at this machine answers it
  // and the one message the card names goes to the (synthetic) group.
  if (withPerson) {
    await waitForHumanChoice(sendCard, "发送");
    for (const until = Date.now() + 15_000; Date.now() < until && !(await app.evaluate(() => globalThis.siteSends.length)); ) await new Promise((resolve) => setTimeout(resolve, 100));
    const sends = await app.evaluate(() => globalThis.siteSends);
    assert.equal(sends.length, 1, "one message, the one on the card");
    const [message] = sends;
    assert.deepEqual([message.chat_id, message.msgType, message.as, message.intent], ["oc_synthetic_sales", "post", "user", "message.send"]);
    const nodes = message.content.zh_cn.content.flat();
    assert.ok(nodes.every((node) => ["text", "a"].includes(node.tag)), "static nodes only");
    assert.equal(nodes[0].text, `${local.name}\n`, "the site's name, then its link");
    assert.match(nodes.find((node) => node.tag === "a").href, /^https:\/\/sites\.test\/s\//);
    assert.equal(nodes.at(-1).text, "本周的看板", "the note, as written");
  } else {
    await sendCard.getByRole("button", { name: "取消" }).click();
    await sendCard.waitFor({ state: "detached" }).catch(() => {});
    assert.equal((await app.evaluate(() => globalThis.siteSends)).length, 0, "cancelled: nothing sent");
  }

  // Deleting it is a deletion card; the person's to answer. Cancelled here.
  await window.locator(`#site-list .site-row[data-site="${local.id}"] .site-more`).click();
  await window.locator("#site-menu .site-erase").click();
  const card = window.locator("#confirmations .confirm-card");
  await card.waitFor();
  assert.equal(await card.locator("strong").first().innerText(), "确认下线并删除这个网站");
  const said = await card.innerText();
  assert.match(said, /保留的所有版本和数据一起删除，不能恢复/);
  assert.match(said, /这台电脑上的目录保留/);
  assert.equal(await card.evaluate((node) => node.classList.contains("danger")), true, "drawn as a deletion");
  await card.getByRole("button", { name: "取消" }).click();
  await card.waitFor({ state: "detached" }).catch(() => {});
  assert.ok(published.get(elsewhere.id), "cancelled: nothing deleted");

  // A table site whose automatic reading fails says so on its row, with the
  // reason, instead of a published page quietly going on with old numbers (§0.7).
  const slice = { kind: "base", token: "bascnSyntheticGone01", tableId: "tblSyntheticGone", fields: ["fldA"], rows: 50, refreshSeconds: 15 };
  const broken = await app.evaluate((_electron, value) => globalThis.siteStoreFixture.create({ name: "读不到的看板", slice: value }), slice);
  const up = await published.publish({ ownerId: "ou_owner", tenantId: "synthetic", name: "读不到的看板", share: { scope: "invited" },
    source: { kind: "base", token: slice.token, tableId: slice.tableId }, ...pack("<!doctype html><title>看板</title><p>看板</p>") });
  await app.evaluate((_electron, { id, publishedId }) => globalThis.siteStoreFixture.recordPublish(id, { publishedId, url: `https://sites.test/s/${publishedId}/`, scope: "invited", inherit: false, offline: false }),
    { id: broken.id, publishedId: up.id });
  const trouble = window.locator(`.site-row[data-site="${broken.id}"] .site-refresh-trouble`);
  await trouble.waitFor({ timeout: 60_000 });
  assert.match(await trouble.innerText(), /^数据没有更新：.+。从.+起已连续失败 \d+ 次，之后会隔一段时间再试。$/);
  await window.screenshot({ path: path.join(evidence, "desktop-site-refresh-trouble.png"), clip: await window.locator(`.site-row[data-site="${broken.id}"]`).boundingBox() });

  // Letting more people in asks first; the card is the person's, cancelled here
  // and nothing changes (review of phase 0, 2026-10-03).
  await window.locator(`.site-row[data-site="${broken.id}"] .site-share`).click();
  const share = window.locator(".share-dialog");
  await share.waitFor();
  await share.locator("#share-tenant").check();
  await share.locator("#share-confirm").click();
  const widen = window.locator("#confirmations .confirm-card");
  await widen.waitFor();
  assert.equal(await widen.locator("strong").first().innerText(), "确认让更多人打开这个网站");
  assert.match(await widen.innerText(), /谁能打开：仅邀请的人可访问 → 组织内获得链接的人可阅读/);
  await widen.getByRole("button", { name: "取消" }).click();
  await widen.waitFor({ state: "detached" }).catch(() => {});
  assert.equal(published.get(up.id).share.scope, "invited", "cancelled: who may open it is as it was");

  // Deleted on the server from somewhere else: shown as not published, said
  // why, and it can leave the list -- not up, with every action failing.
  await published.erase(up.id, { ownerId: "ou_owner" });
  await window.locator('[data-section="skills"]').click();
  await window.locator('[data-section="sites"]').click();
  const goneRow = window.locator(`.site-row[data-site="${broken.id}"]`);
  await goneRow.locator(".site-note").waitFor();
  assert.match(await goneRow.locator(".site-note").innerText(), /服务端上已经没有这个网站了/);
  assert.equal(await goneRow.locator(".site-publish").count(), 1, "can be published again");
  await goneRow.locator(".site-more").click();
  const offered = await window.locator("#site-menu button").allInnerTexts();
  assert.equal(offered.at(-1), "移出列表", offered.join("、"));
  assert.ok(!offered.includes("下线并删除") && !offered.includes("取消发布"), "nothing to take down that is not there");
  // And deleted from this computer, since 2026-10-08: a site nobody published
  // could only leave the list, its folder staying behind. 删除 sends the folder
  // the application made to the Trash -- through the red card, cancelled here.
  assert.ok(offered.includes("删除"), offered.join("、"));
  await window.locator("#site-menu .site-delete").click();
  const deleting = window.locator("#confirmations .confirm-card");
  await deleting.waitFor();
  assert.equal(await deleting.locator("strong").first().innerText(), "确认删除网站");
  const deletingText = await deleting.innerText();
  assert.match(deletingText, /删除「读不到的看板」/);
  assert.match(deletingText, /目录移到废纸篓，需要时可以从废纸篓放回/);
  assert.match(deletingText, /它没有发布过，线上没有它/);
  assert.equal(await deleting.evaluate((node) => node.classList.contains("danger")), true, "drawn as a deletion");
  await deleting.getByRole("button", { name: "取消" }).click();
  await deleting.waitFor({ state: "detached" }).catch(() => {});
  assert.ok((await app.evaluate((_electron, id) => globalThis.siteStoreFixture.list().some((site) => site.id === id), broken.id)), "cancelled: still listed");
  assert.equal(await stat(broken.folder).then((entry) => entry.isDirectory(), () => false), true, "cancelled: the folder is where it was");
  // A site joined from a folder of the person's own is never deleted: it only leaves the list.
  const own = path.join(directory, "我自己的项目"); await mkdir(own);
  const joined = await app.evaluate((_electron, at) => globalThis.siteStoreFixture.create({ name: "我自己的项目", at }), own);
  await window.locator('[data-section="skills"]').click();
  await window.locator('[data-section="sites"]').click();
  const joinedRow = window.locator(`.site-row[data-site="${joined.id}"]`);
  await joinedRow.locator(".site-more").click();
  const joinedOffered = await window.locator("#site-menu button").allInnerTexts();
  assert.ok(joinedOffered.includes("移出列表") && !joinedOffered.includes("删除"), joinedOffered.join("、"));
  await window.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, syntheticFeishu: true, paidCalls: 0, listedFromServer: true, downloaded: true, hiddenAndBack: true, deletionCardCancelled: true, localDeletionCardCancelled: true, ownFolderNotDeletable: true, progressShown: true, refreshTroubleShown: true, widenCardCancelled: true, goneShown: true, addressNamed: true, sendCardCancelled: !withPerson, sentToGroup: withPerson }));
} finally {
  await app?.close();
  control?.close(); control?.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
