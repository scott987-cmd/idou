import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { appReady } from "./fixtures/app-ready.js";

// What the person who published a site reads when an administrator or the
// content checks stand between it and its readers (docs/site-content-safety.md):
// waiting for review, turned down, taken down -- each with its reason, and only
// the buttons that can do something. In the actual Electron app, against a
// server of this smoke's own that answers /v1/sites/list as the real one does.
// Publishing itself is behind a card a person answers, so the three sites are
// written as already published, the way the app records them. The
// administrators' reasons end in stops of their own, as people write them.
//
//   node scripts/smoke-site-review-desktop.js
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-review-desktop-"));
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
const now = Date.now();
const SITES = [
  { name: "联系表", review: { state: "pending", at: now - 600_000, reason: "发现 1 处手机号。等管理员审核通过后才会上线，在那之前链接打不开。" } },
  { name: "客户名单", review: { state: "rejected", at: now - 3_600_000, reason: "公开前删掉手机号。" } },
  { name: "销售看板", held: { at: now - 7_200_000, reason: "包含客户电话！" } },
].map((site) => ({ ...site, id: randomUUID(), publishedId: randomUUID() }));
// A first publish the app stopped waiting for (it quit, or the check took too
// long) that went up after all: recorded only by the id it went out under.
const UNRECORDED = { name: "报名页", id: randomUUID(), publishingId: randomUUID(), review: { state: "pending", at: now - 60_000, reason: "发现 1 处手机号。等管理员审核通过后才会上线，在那之前链接打不开。" } };
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async () => syntheticResponseStream("好的。"),
  authHandler: async (req, res) => {
    if (req.url !== "/v1/sites/list") return false;
    for await (const chunk of req) void chunk;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ anonymousAllowed: true, sites: [...SITES, { ...UNRECORDED, publishedId: UNRECORDED.publishingId }].map((site) => ({ id: site.publishedId, name: site.name, offline: true, held: site.held ?? null, review: site.review ?? null,
      share: { scope: "anyone", inherit: false, members: [] }, url: `https://sites.example/s/${site.publishedId}/`, ownerId: "synthetic", tenantId: "synthetic" })) }));
    return true;
  } });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });
// The app's own record of three published sites (site-store.js).
const data = path.join(directory, "data");
await mkdir(data, { recursive: true });
const records = [];
for (const site of SITES) {
  const folder = path.join(directory, "sites", site.id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "index.html"), `<!doctype html><title>${site.name}</title><h1>${site.name}</h1>`);
  records.push({ id: site.id, name: site.name, folder, slice: null, sliceId: null, createdAt: now - 86_400_000, lastReadAt: null, rowCount: 0, digest: null, truncated: false,
    // What this desktop last did: up, and for the organisation only. The server says otherwise.
    publishedId: site.publishedId, url: `https://sites.example/s/${site.publishedId}/`, publishedScope: "tenant", publishedInherit: false, publishedOffline: false, publishedAt: now - 86_400_000 });
}
{
  const folder = path.join(directory, "sites", UNRECORDED.id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "index.html"), `<!doctype html><title>${UNRECORDED.name}</title>`);
  records.push({ id: UNRECORDED.id, name: UNRECORDED.name, folder, slice: null, sliceId: null, createdAt: now - 3_600_000, lastReadAt: null, rowCount: 0, digest: null, truncated: false,
    publishedId: null, url: null, publishedScope: null, publishedInherit: false, publishedOffline: false, publishedAt: null, publishingId: UNRECORDED.publishingId });
}
await writeFile(path.join(data, "sites.json"), JSON.stringify({ version: 1, sites: records }), { mode: 0o600 });

let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: ["."], timeout: 30_000,
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: data, IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin } });
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await appReady(page);
  await page.locator('[data-section="sites"]').click();
  const row = (site) => page.locator(`.site-row[data-site="${site.id}"]`);
  await row(SITES[0]).waitFor();
  const [waiting, rejected, held] = await Promise.all(SITES.map(async (site) => (await row(site).locator(".site-text").innerText()).replace(/\s+/g, " ")));
  assert.match(waiting, /等待管理员审核 原因：发现 1 处手机号。等管理员审核通过后才会上线，在那之前链接打不开。/, waiting);
  assert.match(rejected, /审核没通过 原因：公开前删掉手机号。改好后点「更新线上」，会重新检查。/, rejected);
  assert.match(held, /管理员下线了 原因：包含客户电话。要恢复请联系管理员。/, held);
  // The reason is read whole: its line wraps rather than being cut off.
  for (const site of SITES) {
    const line = row(site).locator(".site-state");
    assert.equal(await line.evaluate((node) => node.scrollWidth <= node.clientWidth + 1 && getComputedStyle(node).textOverflow !== "ellipsis"), true, site.name);
  }
  const buttons = async (site) => (await row(site).locator("button").allInnerTexts()).map((text) => text.trim());
  // Waiting or turned down: a new version is checked again; bringing the same one back is not on offer.
  for (const site of SITES.slice(0, 2)) {
    const shown = await buttons(site);
    assert.ok(shown.includes("更新线上") && !shown.includes("重新发布"), `${site.name}: ${shown.join(" ")}`);
  }
  // Held by an administrator: nothing here brings it back.
  const shownHeld = await buttons(SITES[2]);
  assert.ok(!shownHeld.includes("重新发布") && !shownHeld.includes("更新线上"), shownHeld.join(" "));
  // The first publish that went up unrecorded: found on the server by its id, and adopted.
  await page.locator(`.site-row[data-site="${UNRECORDED.id}"] .site-state`).waitFor();
  assert.match((await row(UNRECORDED).locator(".site-text").innerText()).replace(/\s+/g, " "), /等待管理员审核 原因：发现 1 处手机号/);
  const kept = JSON.parse(await readFile(path.join(data, "sites.json"), "utf8")).sites.find((site) => site.id === UNRECORDED.id);
  assert.deepEqual([kept.publishedId, kept.publishingId, kept.url], [UNRECORDED.publishingId, null, `https://sites.example/s/${UNRECORDED.publishingId}/`]);
  // And what the server says of each -- down, for anyone -- replaces what this desktop last did.
  const followed = JSON.parse(await readFile(path.join(data, "sites.json"), "utf8")).sites.filter((site) => SITES.some((one) => one.id === site.id));
  assert.deepEqual(followed.map((site) => [site.publishedOffline, site.publishedScope]), SITES.map(() => [true, "anyone"]));
  await page.screenshot({ path: path.resolve("docs/evidence/desktop-site-review-states.png"), scale: "css" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, waitingSaid: true, rejectedSaid: true, heldSaid: true, republishWithheld: true, unrecordedPublishAdopted: true, paidCalls: 0 }));
} finally {
  await app?.close().catch(() => {});
  server.close(); server.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
