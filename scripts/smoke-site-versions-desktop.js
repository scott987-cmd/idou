import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { SiteService } from "../src/control-plane/site-service.js";
import { appHash, appManifest } from "../src/apps/manifest.js";
import { snapshotApp } from "../src/application/app-candidates.js";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { SiteVisitors } from "../src/control-plane/site-visitors.js";

// The versions a published site keeps, in the actual Electron application
// (docs/sites-phase0.md §0.6). Found in the 2026-10-03 benchmark: the server
// kept three versions of every site and nothing could reach them, so a bad
// update stayed up until its owner rebuilt the old page by hand. Here a site
// with two versions on the server is opened from its row's ⋯ menu: the list
// says which is up, the older one opens in a preview window with its own page,
// and going back to it stops at a card -- cancelled here, since only the
// person answers one. Synthetic Feishu, no network, no model.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-versions-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app, control = null, adminDb = null, visitors = null;
// One version of the site: its own files, with index.html saying which it is.
const version = (snapshot, mark) => {
  const files = new Map(snapshot.blobs.map((blob) => [blob.path, Buffer.from(blob.base64, "base64")]));
  files.set("index.html", Buffer.from(files.get("index.html").toString("utf8").replace("<body>", `<body><p id="version-mark">${mark}</p>`)));
  const manifest = { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html",
    files: [...files].map(([file, bytes]) => ({ path: file, bytes: bytes.length, sha256: appHash(bytes) })) };
  appManifest(manifest);
  return { manifest, blobs: [...files].map(([file, bytes]) => ({ path: file, base64: bytes.toString("base64") })) };
};
try {
  const published = await SiteRegistry.open(path.join(directory, "published"));
  const sessions = new SessionRegistry();
  // Who opened it, for 访问统计 (docs/sites-phase1.md §1.5): synthetic people, three of them in one department.
  adminDb = await openAdminDatabase();
  visitors = await SiteVisitors.open({ db: adminDb, key: "a-smoke-key-of-thirty-two-bytes!!",
    departmentOf: async (who) => (who.userId.startsWith("ou_sales") ? "od-synthetic-sales" : "od-synthetic-legal"),
    named: async (_tenant, ids) => ids.map((id) => ({ id, name: id === "od-synthetic-sales" ? "销售部（合成）" : "法务部（合成）" })) });
  const service = new SiteService({ sessions, registry: published, origin: "https://sites.test", notify: () => {}, visitors });
  control = createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  control.listen(0, "127.0.0.1"); await once(control, "listening");
  const session = sessions.issue({ tenantId: "synthetic", userId: "ou_owner", deviceId: "d1", authProvider: "feishu", appId: "cli_smoke", deviceProof: "ed25519-login" });
  const sessionFile = path.join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: `http://127.0.0.1:${control.address().port}` }), { mode: 0o600 });
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/site-versions-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile },
    timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  await page.locator('[data-section="sites"]').click();
  await page.locator("#site-new").click();
  await page.locator('.template-dialog .template-card[data-template="game"] .template-pick').click();
  await page.locator("#ask-input").fill("贪吃蛇");
  await page.locator("#ask-ok").click();
  await page.locator(".site-row").first().waitFor();
  // The preview of the new site opens by itself, with its 选中修改 toolbar beside it; it is not what is looked at here.
  let made = null;
  for (const until = Date.now() + 15_000; !made && Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 100))) made = app.windows().find((other) => /^http:\/\/127\.0\.0\.1:/.test(other.url()));
  assert.ok(made, "the new site's preview opened");
  await made.close();

  // Two versions of it on the server, the second up: what two publishes from
  // this machine leave behind.
  const local = await app.evaluate(() => globalThis.siteStoreFixture.list()[0]);
  const snapshot = await snapshotApp(local.folder, "index.html");
  const first = await published.publish({ ownerId: "ou_owner", tenantId: "synthetic", name: "贪吃蛇", share: { scope: "tenant" }, ...version(snapshot, "第一版的页面") });
  const second = await published.publish({ siteId: first.id, ownerId: "ou_owner", tenantId: "synthetic", name: "贪吃蛇", share: { scope: "tenant" }, ...version(snapshot, "第二版的页面") });
  await app.evaluate((_electron, { id, publishedId }) => globalThis.siteStoreFixture.recordPublish(id, { publishedId, url: `https://sites.test/s/${publishedId}/`, scope: "tenant", inherit: false, offline: false }),
    { id: local.id, publishedId: first.id });
  for (const [userId, source] of [["ou_sales_1", "feishu"], ["ou_sales_2", "feishu"], ["ou_sales_3", "qr"], ["ou_sales_1", "feishu"], ["ou_legal_1", "direct"]]) {
    await visitors.view({ tenantId: "synthetic", siteId: first.id, visitor: { tenantId: "synthetic", userId }, source });
  }
  await page.locator('[data-section="skills"]').click();
  await page.locator('[data-section="sites"]').click();
  const row = page.locator(".site-row").first();
  await row.locator(".site-link").waitFor();
  assert.match(await row.locator(".site-meta").innerText(), /已发布 · 组织内获得链接的人可阅读/);

  // ⋯ holds what is used less often, inside the window and reachable where it is drawn.
  const toggle = row.locator(".site-more");
  await toggle.click();
  const menu = page.locator("#site-menu");
  await menu.waitFor();
  assert.deepEqual(await menu.locator("button").allInnerTexts(), ["历史版本", "取消发布", "二维码和发到群", "访问统计", "起地址名", "只在这台电脑隐藏", "下线并删除"]);
  const placed = await menu.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const items = [...node.querySelectorAll("button")].map((item) => { const at = item.getBoundingClientRect(); return document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) === item; });
    return { inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, items };
  });
  assert.deepEqual(placed, { inside: true, items: [true, true, true, true, true, true, true] }, "every item is drawn where it can be pressed");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  assert.equal(await toggle.evaluate((node) => node === document.activeElement), true, "Escape returns to the button");

  // 访问统计: people and openings, a bar a day, departments -- never anybody's name.
  await toggle.click();
  await menu.locator(".site-stats").click();
  const stats = page.locator("#site-stats");
  await stats.waitFor();
  assert.deepEqual(await stats.locator(".stats-figure strong").allInnerTexts(), ["4", "5"]);
  assert.deepEqual(await stats.locator(".stats-row .stats-name").allInnerTexts(), ["销售部（合成）", "其他部门"], "one person's department is shown with the others");
  assert.match(await stats.innerText(), /在飞书里打开 3 次 · 扫二维码 1 次 · 直接打开链接 1 次/);
  assert.doesNotMatch(await stats.innerText(), /ou_/);
  const statsBox = await stats.boundingBox();
  await page.screenshot({ path: path.join(evidence, "desktop-site-stats.png"), clip: statsBox });
  await stats.getByRole("button", { name: "关闭" }).click();
  await stats.waitFor({ state: "detached" });

  // 历史版本: newest first, which one is up said in words.
  await toggle.click();
  await menu.locator(".site-versions").click();
  const dialog = page.locator("#site-versions");
  await dialog.waitFor();
  const rows = dialog.locator(".site-version");
  await rows.nth(1).waitFor();
  assert.equal(await rows.count(), 2);
  assert.equal(await rows.nth(0).getAttribute("data-version"), second.version);
  assert.equal(await rows.nth(0).locator(".site-version-live").innerText(), "正在线上");
  assert.equal(await rows.nth(0).locator(".site-version-rollback").count(), 0, "nothing to go back to on the one that is up");
  assert.match(await rows.nth(1).innerText(), /\d+ 个文件 · \d+ KB/);
  const box = await dialog.boundingBox();
  assert.ok(box && box.width > 300 && box.height > 150, JSON.stringify(box));
  await page.screenshot({ path: path.join(evidence, "desktop-site-versions.png"), clip: box });

  // The older one, looked at: its own page, in a window that says it is only the owner's.
  const opening = app.waitForEvent("window", { timeout: 15_000 });
  await rows.nth(1).locator(".site-version-preview").click();
  const preview = await opening;
  await preview.locator("#version-mark").waitFor();
  assert.equal(await preview.locator("#version-mark").innerText(), "第一版的页面");
  const titles = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((one) => one.getTitle()));
  assert.ok(titles.includes("贪吃蛇 · 历史版本（只有你能看到）"), titles.join(" / "));
  await preview.close();

  // A card that comes up while the dialog is open is still there after it
  // closes: the dialog took it, and the container for every later card, with
  // it when it was removed (review of phase 0, 2026-10-03).
  void page.evaluate((args) => window.idou.siteRollback(args).catch(() => null), { id: local.id, version: first.version });
  const early = page.locator("#confirmations .confirm-card");
  await early.waitFor();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => Boolean(document.querySelector("#confirmations")?.isConnected)), true, "the container is still in the page");
  await early.waitFor();
  await early.getByRole("button", { name: "取消" }).click();
  await early.waitFor({ state: "detached" }).catch(() => {});
  await toggle.click();
  await menu.locator(".site-versions").click();
  await dialog.waitFor();
  await rows.nth(1).waitFor();

  // Going back: the dialog goes, and the card says what changes for whom.
  await rows.nth(1).locator(".site-version-rollback").click();
  await dialog.waitFor({ state: "detached" });
  const card = page.locator("#confirmations .confirm-card");
  await card.waitFor();
  assert.equal(await card.locator("strong").first().innerText(), "确认回到这一版");
  const said = await card.innerText();
  assert.match(said, /谁能打开：组织内获得链接的人可阅读（不变）/);
  assert.match(said, /现在线上的那一版也保留，可以再回来/);
  assert.match(said, /本机目录里的文件不变/);
  // The card is the person's to answer. Cancelled here; nothing changed.
  await card.getByRole("button", { name: "取消" }).click();
  await card.waitFor({ state: "detached" }).catch(() => {});
  assert.equal(published.get(first.id).version, second.version, "cancelled: the version up stays up");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, syntheticFeishu: true, paidCalls: 0, versions: 2, previewed: true, cardCancelled: true }));
} finally {
  await app?.close();
  control?.close(); control?.closeAllConnections?.();
  visitors?.close(); await adminDb?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
