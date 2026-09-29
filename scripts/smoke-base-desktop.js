import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { openFeishuResource } from "./fixtures/open-document.js";
import { observeHumanChoice, bringToPerson } from "./fixtures/agent-harness.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-base-desktop-")), evidence = path.resolve("docs/evidence");
const BASE = "https://test.feishu.cn/base/SyntheticBaseToken0001?table=tblSyntheticTable1";
await mkdir(evidence, { recursive: true }); let app;
try {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/base-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory } });
  const page = await app.firstWindow(), errors = []; page.setDefaultTimeout(20000); page.on("pageerror", e => errors.push(e.message));
  await page.locator("#new-task").waitFor();
  // A Base opens through the same entry a person uses, as one typed page.
  await openFeishuResource(page, BASE, { kind: "base" });
  await page.locator("#base-grid").waitFor();
  assert.match(await page.locator("#base-grid caption").innerText(), /客户台账 · 第 1–2 条/);
  assert.equal(await page.locator('#base-grid td[data-record="recSynthetic002"][data-field="名称"]').innerText(), "探针二");
  assert.equal(await page.evaluate(() => typeof window.__basePwned), "undefined"); assert.equal(await page.locator("#base-grid img").count(), 0);
  assert.equal(await page.locator('#base-grid th[data-readonly="true"]').innerText(), "负责人");
  assert.match(await page.locator("#document-meta").innerText(), /可修改的字段：名称、数量/);
  // Analysis: the page goes with the question and nothing is written.
  await page.locator("#prompt").fill("这一页的数量加起来是多少"); await page.locator("#send").click(); await page.locator("#task-status").filter({ hasText: "已完成" }).waitFor();
  const prompt = await app.evaluate(() => globalThis.baseFixture.turns[0]); assert.match(prompt, /"record":"recSynthetic002"/); assert.match(prompt, /Do not write to Feishu/);
  // A proposal with typed values; its write card is opened, read and cancelled.
  await page.locator("#propose-base-edit").check(); await page.locator("#prompt").fill("把探针二的名称改成已核对，探针一的数量改成 5"); await page.locator("#send").click();
  await page.locator(".base-proposal").waitFor();
  assert.match(await page.locator('.base-proposal .sheet-change[data-record="recSynthetic002"]').innerText(), /文本："探针二"[\s\S]*文本："探针二（已核对）"/);
  assert.match(await page.locator('.base-proposal .sheet-change[data-record="recSynthetic001"]').innerText(), /数字：1[\s\S]*数字：5/);
  const proposalRequest = await app.evaluate(() => globalThis.baseFixture.proposals[0]); assert.deepEqual(proposalRequest.tools, []); assert.equal(proposalRequest.tool_choice, "none");
  const apply = page.locator(".apply-base-edit"); assert.equal(await apply.count(), 1); assert.equal(await apply.isEnabled(), true);
  await apply.click(); const card = page.locator("#confirmations .confirm-card"); await card.waitFor();
  assert.equal(await card.locator("strong").first().innerText(), "确认写入飞书多维表格");
  const detail = await card.locator("pre").innerText();
  assert.match(detail, /recSynthetic002（名称：探针二） ·「名称」  文本 "探针二"  →  文本 "探针二（已核对）"/);
  assert.match(detail, /recSynthetic001（名称：[^）]*） ·「数量」  数字 1  →  数字 5/);
  assert.match(await card.locator(".confirm-boundary").innerText(), /没有可用的版本号/);
  assert.deepEqual(await card.locator(".confirm-actions button").allInnerTexts(), ["取消", "确认写入多维表格"]);
  await page.screenshot({ path: path.join(evidence, "desktop-base-write-confirm-fixture.png"), scale: "css" });
  await card.getByRole("button", { name: "取消" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#confirmations .confirm-card").length === 0);
  assert.equal(await page.locator(".apply-base-edit").isEnabled(), true, "a cancelled card leaves no write record");
  const updates = await app.evaluate(() => globalThis.baseFixture.calls.filter(argv => argv[0] === "base" && argv[1] === "+record-batch-update"));
  assert.equal(updates.filter(argv => argv.includes("--dry-run")).length, 1, "the card was prepared from the CLI's own dry run");
  assert.equal(updates.filter(argv => !argv.includes("--dry-run") && !argv.includes("--help")).length, 0);

  // Repeat the same proposal and let the person approve it. The observer is
  // armed before the card can paint, so a quick human click is still recorded;
  // it never dispatches the affirmative action itself.
  const confirmed = observeHumanChoice(page, { detailText: "recSynthetic002", label: "确认写入多维表格" });
  await page.locator(".apply-base-edit").click();
  await card.waitFor();
  assert.match(await card.locator("pre").innerText(), /探针二（已核对）/);
  process.stdout.write("待人工操作：请核对两条多维表格修改并亲手点击“确认写入多维表格”\n");
  await bringToPerson(page, "确认写入多维表格");
  await confirmed;
  await page.locator(".sheet-edit-status").filter({ hasText: "已写入并逐条读回核验" }).waitFor({ timeout: 60_000 });
  await page.locator('#base-grid td[data-record="recSynthetic002"][data-field="名称"]').filter({ hasText: "探针二（已核对）" }).waitFor();
  assert.equal(await page.locator('#base-grid td[data-record="recSynthetic001"][data-field="数量"]').innerText(), "5");
  const finalUpdates = await app.evaluate(() => globalThis.baseFixture.calls.filter(argv => argv[0] === "base" && argv[1] === "+record-batch-update"));
  const writes = finalUpdates.filter(argv => !argv.includes("--dry-run") && !argv.includes("--help")).length;
  assert.equal(writes, 1, "exactly one confirmed Base write is dispatched");
  await page.screenshot({ path: path.join(evidence, "desktop-base-write-applied-fixture.png"), scale: "css" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectronAndNativeProvider: true, typedBasePage: true, inertMarkup: true, analysisTurn: true, typedProposal: true,
    cancelledWriteWritesNothing: true, confirmedWriteReadBack: true, baseWrites: writes, cliAndModelBoundary: "synthetic", liveFeishuCalls: 0, paidCalls: 0, rendererErrors: errors }));
} finally { if (app) await app.close().catch(() => {}); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
