// A real Electron acceptance for the per-task document-write policy.
//
// The person explicitly selects full access before creating this work task.
// Applying a Base proposal must then run without a second confirmation card,
// while still using the production plan, exact one-shot write grant, write-time
// value check and read-back verification. Only the provider and model are
// synthetic; no live Feishu or paid model call is possible.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { openFeishuResource } from "./fixtures/open-document.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-full-document-"));
const evidence = path.resolve("docs/evidence");
const BASE = "https://test.feishu.cn/base/SyntheticBaseToken0001?table=tblSyntheticTable1";
await mkdir(evidence, { recursive: true });
let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/base-desktop-entry.js")], env: {
    ...clientEnvironment(), IDOU_DESKTOP_DATA_DIR: directory,
  } });
  const page = await app.firstWindow(), errors = [];
  page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();

  // Full access is selected for this draft only. The task record, not a global
  // preference or a previous task, is what authorises the write below.
  await page.locator("#permission-toggle").click();
  await page.locator('#permission-menu [data-permission="full"]').click();
  assert.match(await page.locator("#permission-toggle").innerText(), /完全访问/);
  await openFeishuResource(page, BASE, { kind: "base" });
  await page.locator("#base-grid").waitFor();
  const [task] = (await page.evaluate(() => window.idou.snapshot())).tasks;
  assert.equal(task.permission, "full");

  await page.locator("#propose-base-edit").check();
  await page.locator("#prompt").fill("把探针二的名称改成已核对，探针一的数量改成 5");
  await page.locator("#send").click();
  await page.locator(".base-proposal").waitFor();
  assert.equal(await page.locator("#confirmations .confirm-card").count(), 0);

  await page.locator(".apply-base-edit").click();
  await page.locator(".sheet-edit-status").filter({ hasText: "已写入并逐条读回核验" }).waitFor({ timeout: 60_000 });
  assert.equal(await page.locator("#confirmations .confirm-card").count(), 0, "full access must not raise a document-write card");
  assert.equal(await page.locator('#base-grid td[data-record="recSynthetic002"][data-field="名称"]').innerText(), "探针二（已核对）");
  assert.equal(await page.locator('#base-grid td[data-record="recSynthetic001"][data-field="数量"]').innerText(), "5");

  const calls = await app.evaluate(() => globalThis.baseFixture.calls.filter(argv => argv[0] === "base" && argv[1] === "+record-batch-update"));
  assert.equal(calls.filter(argv => argv.includes("--dry-run")).length, 1);
  assert.equal(calls.filter(argv => !argv.includes("--dry-run") && !argv.includes("--help")).length, 1);
  await page.screenshot({ path: path.join(evidence, "desktop-full-access-document-fixture.png"), scale: "css" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, taskPermission: task.permission, confirmationCards: 0,
    syntheticDocumentWrites: 1, readBackVerified: true, liveFeishuCalls: 0, paidCalls: 0, rendererErrors: errors }));
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
