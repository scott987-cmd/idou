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
import { appReady } from "./fixtures/app-ready.js";

// Who a site is shared with, in the actual Electron application
// (docs/sites-phase0.md §0.4). Found in the 2026-10-03 benchmark: 仅邀请的人
// let in the owner alone -- the panel had no way to name anybody else. Here a
// person, a group and a department are found and added, the panel says how
// many, and the confirmation card that follows names them; the card is then
// cancelled -- nobody but the person answers it. Synthetic Feishu, no network,
// no model.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-site-share-"));
const evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
let app, control = null;
try {
  const published = await SiteRegistry.open(path.join(directory, "published"));
  const sessions = new SessionRegistry();
  const departments = { search: async (_tenant, text) => (text.includes("张") || text.includes("销售") ? [{ id: "od-synthetic-sales", name: "销售部", trail: ["合成总部", "销售部"], memberCount: 8 }] : []) };
  const groups = { members: async () => new Set(["ou_synthetic_zhang"]) };
  const service = new SiteService({ sessions, registry: published, origin: "https://sites.test", notify: () => {}, departments, groups });
  control = createServer(async (req, res) => { if (!await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  control.listen(0, "127.0.0.1"); await once(control, "listening");
  const session = sessions.issue({ tenantId: "synthetic", userId: "ou_owner", deviceId: "d1", authProvider: "feishu", appId: "cli_smoke", deviceProof: "ed25519-login" });
  const sessionFile = path.join(directory, "session.json");
  await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: `http://127.0.0.1:${control.address().port}` }), { mode: 0o600 });
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/site-share-desktop-entry.js")],
    env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile },
    timeout: 30_000 });
  const page = await app.firstWindow(); page.setDefaultTimeout(30_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await appReady(page);
  await page.locator('[data-section="sites"]').click();
  await page.locator("#site-new").click();
  await page.locator('.template-dialog .template-card[data-template="game"] .template-pick').click();
  await page.locator("#ask-input").fill("贪吃蛇");
  await page.locator("#ask-ok").click();
  await page.locator(".site-row").first().waitFor();

  await page.locator(".site-row .site-publish").first().click();
  const share = page.locator(".share-dialog");
  await share.waitFor();
  const people = share.locator("#share-members");
  // 仅邀请的人 is the default for a site with no table, and with it who else may open it.
  assert.equal(await share.locator("#share-invited").isChecked(), true);
  assert.equal(await people.isVisible(), true);
  assert.match(await people.innerText(), /只有你自己/);
  await share.locator("#share-member-search").fill("张");
  const results = share.locator(".share-member-result");
  await results.nth(2).waitFor();
  assert.deepEqual((await results.locator("small").allInnerTexts()).map((text) => text.split(" · ")[0]), ["人", "群", "部门"]);
  for (let at = 0; at < 3; at += 1) {
    await share.locator("#share-member-search").fill("张");
    await results.nth(at).waitFor();
    await results.nth(at).click();
  }
  const chips = share.locator(".share-member-chip");
  assert.equal(await chips.count(), 3);
  // Taken off, and the same one again is not two.
  await chips.nth(0).locator("button").click();
  assert.equal(await chips.count(), 2);
  await share.locator("#share-member-search").fill("张");
  await results.first().waitFor(); await results.first().click();
  await share.locator("#share-member-search").fill("张");
  await results.first().waitFor(); await results.first().click();
  assert.equal(await chips.count(), 3, "the same person added twice is one collaborator");
  // Another scope has no collaborators; back to 仅邀请的人, they are as they were.
  await share.locator("#share-tenant").check();
  assert.equal(await people.isVisible(), false);
  await share.locator("#share-invited").check();
  assert.equal(await chips.count(), 3);
  // Looked at, as it is: whether it reads.
  const box = await share.boundingBox();
  assert.ok(box && box.width > 300 && box.height > 200, JSON.stringify(box));
  await page.screenshot({ path: path.join(evidence, "desktop-site-share-members.png"), clip: box });
  await share.locator("#share-confirm").click();
  const card = page.locator("#confirmations .confirm-card");
  await card.waitFor();
  assert.match(await card.innerText(), /另加 3 位协作者/);
  // The card is the person's to answer. Cancelled here; nothing went out.
  await card.getByRole("button", { name: "取消" }).click();
  await card.waitFor({ state: "detached" }).catch(() => {});
  assert.equal(published.list({ ownerId: "ou_owner", tenantId: "synthetic" }).length, 0, "cancelled: nothing published");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, syntheticFeishu: true, paidCalls: 0, collaborators: 3, cardCancelled: true }));
} finally {
  await app?.close();
  control?.close(); control?.closeAllConnections?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
