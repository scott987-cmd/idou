// Safe U11 desktop evidence: exercises the human-facing document delivery flow
// through preview and cancellation only. It never clicks an affirmative action.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { answerConfirm } from "./fixtures/agent-harness.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-office-ui-"));
const evidence = path.resolve("docs/evidence/task-ui"); await mkdir(evidence, { recursive: true });
const url = "https://test.feishu.cn/docx/SyntheticDelivery123";
let app, page;
async function launch() {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/document-delivery-desktop-entry.js")], env: {
    ...clientEnvironment(), IDOU_DESKTOP_BACKGROUND: "1", IDOU_DESKTOP_DATA_DIR: directory,
  } });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000); await page.locator("#new-task").waitFor();
}
try {
  await launch();
  const created = await page.evaluate(() => window.idou.createTask({ mode: "cowork" }));
  await app.close(); app = null;
  const file = (await readdir(path.join(directory, "tasks"))).find(name => name.endsWith(".json")); assert.ok(file);
  const record = JSON.parse(await readFile(path.join(directory, "tasks", file), "utf8"));
  record.messages.push({ id: randomUUID(), role: "user", text: "准备交付测试文档", createdAt: Date.now(), seq: 1, turn: { startedAt: Date.now(), finishedAt: Date.now(), status: "completed" } });
  record.seq = 1; record.status = "completed"; await writeFile(path.join(directory, "tasks", file), JSON.stringify(record));
  await launch();
  const task = page.locator("#recent-tasks .recent-row>button").first();
  await task.waitFor(); assert.equal((await task.innerText()).includes(created.title), true);
  await task.click();
  await page.locator("#workbench-files").click();
  await page.locator("#file-menu-toggle").click(); await page.locator("#show-document-url").click();
  await page.locator("#document-url").fill(url); await page.locator("#document-url-form").evaluate(form => form.requestSubmit());
  await page.locator("#send-document").waitFor(); await page.locator("#send-document").click();
  await page.locator("#document-recipient-query").fill("陈宁"); await page.locator("#document-recipient-search").evaluate(form => form.requestSubmit());
  const engineering = page.locator(".document-recipient", { hasText: "研发交付部" }); await engineering.click();
  assert.match(await page.locator("#document-delivery-selection").innerText(), /已选择收件人：陈宁.*研发交付部.*尚未发送/);
  assert.deepEqual(await app.evaluate(() => globalThis.documentDeliveryFixture.sent), []);
  await page.locator("#document-delivery-note").fill("请核对本周交付安排。"); await page.locator("#prepare-document-delivery").click();
  await page.locator("#send-document-delivery").waitFor();
  assert.match(await page.locator("#document-delivery-status").innerText(), /尚未发送.*未改变文档权限/);
  assert.match(await page.locator("#document-delivery-preview").innerText(), /本周交付计划[\s\S]*请核对本周交付安排/);
  await page.locator("#send-document-delivery").click();
  const card = page.locator("#confirmations .confirm-card"); await card.waitFor();
  assert.match(await card.innerText(), /不发送文档正文，不改变文档权限/);
  await page.screenshot({ path: path.join(evidence, "u11-document-delivery-cancel.png"), scale: "css" });
  await answerConfirm(page, "取消");
  await page.locator("#document-delivery-status").filter({ hasText: "已取消，未发送" }).waitFor();
  assert.deepEqual(await app.evaluate(() => globalThis.documentDeliveryFixture.sent), []);
  const calls = await app.evaluate(() => globalThis.documentDeliveryFixture.calls);
  assert.ok(calls.every(args => args[0] !== "drive" && !args.includes("+update")), "cancel must not upload, edit, grant permissions or send");
  console.log(JSON.stringify({ ok: true, screenshot: "docs/evidence/task-ui/u11-document-delivery-cancel.png", sent: 0 }));
} finally {
  await app?.close().catch(() => {}); await rm(directory, { recursive: true, force: true });
}
