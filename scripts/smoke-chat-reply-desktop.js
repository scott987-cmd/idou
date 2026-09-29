import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { fixtureCipher } from "./fixtures/wiki-cipher.js";
import { answerConfirm, observeHumanChoice, presentHumanChoice, releaseHumanChoice, waitForConfirmationChoice } from "./fixtures/agent-harness.js";
// 飞书消息 is Feishu's own embedded page now, so the reader list and the reply
// composer this app used to draw are gone. What they drove is not: reading a
// conversation and replying to one message are still the application's own
// operations, and they are reached the way the panel reached them -- over the
// preload bridge, against real main-process code. The consent that used to be a
// native dialog is the in-app confirmation card, answered by its button label.
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-reply-ui-")), evidence = path.resolve("docs/evidence");
await mkdir(evidence, { recursive: true });
const REPLY = "确认范围后，我会更新交付计划。\n这是一条合成测试回复。", LOST = "回执未知测试";
let app, page; const errors = [];
async function launch() {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/chat-reply-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory } });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
}
// Reads the conversation and returns the reply handle of every message on the
// page, keyed by message id. A message the application refuses to make
// repliable has no handle at all, which is the only way a reply can be aimed.
async function open() {
  return page.evaluate(async () => {
    const list = await window.idou.listChats();
    const chat = list.chats.find(row => row.id === "oc_delivery");
    const view = await window.idou.readChat(chat.handle);
    return Object.fromEntries(view.messages.flatMap(row => [row, ...row.replies]).map(row => [row.id, row.replyHandle]));
  });
}
const reply = (handle, text, inThread) => page.evaluate(([value, body, thread]) => window.idou.replyChatMessage(value, body, thread)
  .then(result => ({ ok: true, ...result }), error => ({ ok: false, message: String(error?.message ?? error) })), [handle, text, inThread]);
const writes = () => app.evaluate(() => globalThis.replyFixture.writes.length);
const cards = () => page.locator("#confirmations .confirm-card").count();
// The card is what the person reads before an irreversible send, so it has to
// be readable and answerable in a narrow window -- the composer check this
// script used to make, against the control that replaced it.
try {
  await launch();
  const handles = await open();
  // Recalled messages and cards carry no reply capability at all.
  assert.equal(handles.om_recalled, null); assert.equal(handles.om_script, null);
  assert.ok(handles.om_plan); assert.ok(handles.om_reply, "an expanded thread reply stays repliable");

  // Cancelling writes nothing.
  let running = reply(handles.om_plan, "收到，先核对验收范围，再整理行动项。", false);
  await answerConfirm(page, "取消");
  let result = await running;
  assert.equal(result.ok, true); assert.equal(result.state, "canceled");
  assert.equal(await writes(), 0);

  let choice = observeHumanChoice(page, { detailText: "合成测试回复", label: "确认发送回复" });
  running = reply(handles.om_plan, REPLY, true);
  await waitForConfirmationChoice(page, { detailText: "合成测试回复", label: "确认发送回复" });
  await page.screenshot({ path: path.join(evidence, "desktop-chat-reply-fixture.png"), scale: "css" });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 700));
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize()))[0] < 900);
  await page.screenshot({ path: path.join(evidence, "desktop-chat-reply-narrow-fixture.png"), scale: "css" });
  await presentHumanChoice(app, page, "i豆 M05 · 聊天回复确认");
  const observed = await choice;
  await releaseHumanChoice(app);
  assert.deepEqual(observed.labels, ["取消", "确认发送回复"]);
  assert.equal(observed.primary, 0, "cancel must stay the default answer");
  assert.equal(observed.layout?.overflow, false); assert.equal(observed.layout?.cardInside, true); assert.equal(observed.layout?.buttonsReachable, true);
  for (const text of ["oc_delivery", "om_plan", "当前 CLI 用户（非机器人）", "合成测试回复", "话题内回复", "不是仅发给原发送者"]) assert.ok(observed.text.includes(text), text);
  result = await running;
  assert.equal(result.state, "acknowledged"); assert.match(result.message, /已返回发送回执/);
  const sent = await app.evaluate(() => globalThis.replyFixture.writes);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("--reply-in-thread"));
  assert.equal(sent[0][sent[0].indexOf("--message-id") + 1], "om_plan");
  assert.equal(sent[0][sent[0].indexOf("--text") + 1], REPLY);

  // The same reply again is refused from the durable receipt, without asking.
  result = await reply(handles.om_plan, REPLY, true);
  assert.equal(result.ok, false); assert.match(result.message, /已有发送回执/);
  assert.equal(await cards(), 0); assert.equal(await writes(), 1);

  await app.evaluate(() => { globalThis.replyFixture.lost = true; });
  choice = observeHumanChoice(page, { detailText: LOST, label: "确认发送回复" });
  running = reply(handles.om_plan, LOST, false);
  await waitForConfirmationChoice(page, { detailText: LOST, label: "确认发送回复" });
  await presentHumanChoice(app, page, "i豆 M05 · 聊天回复回执未知");
  await choice;
  await releaseHumanChoice(app);
  result = await running;
  assert.equal(result.state, "unknown"); assert.match(result.message, /可能已发送/);
  assert.equal(await writes(), 2);

  const bytes = await readFile(path.join(directory, "chat/reply-receipts.enc"));
  assert.equal(bytes.includes(Buffer.from(LOST)), false);
  const journal = JSON.parse(fixtureCipher(createHash("sha256").update("synthetic-chat-reader-key").digest()).decrypt(bytes));
  assert.deepEqual(journal.entries.map(row => row.state), ["acknowledged", "unknown"]);
  assert.doesNotMatch(JSON.stringify(journal), /交付计划|回执未知测试|ou_chen/);

  await app.close(); app = null; await launch();
  const restarted = await open();
  result = await reply(restarted.om_plan, LOST, false);
  assert.equal(result.ok, false); assert.match(result.message, /可能已发送/);
  assert.equal(await cards(), 0, "an uncertain reply is not even offered again");
  assert.equal(await writes(), 0, "restart must not resend uncertain reply");

  // A reply aimed from a page the reader has retired never reaches Feishu. The
  // source re-read is held open, the reading session ends underneath it the way
  // leaving the messages view ends it, and the send dies before the confirmation.
  const stale = await open();
  await app.evaluate(() => { globalThis.chatFixture.afterRead = async () => { globalThis.chatFixture.afterRead = null; await new Promise(resolve => { globalThis.chatFixture.release = resolve; }); }; });
  running = reply(stale.om_plan, "离开页面不发送", false);
  for (let i = 0; i < 200 && await app.evaluate(() => typeof globalThis.chatFixture.release) !== "function"; i++) await page.waitForTimeout(20);
  assert.equal(await app.evaluate(() => typeof globalThis.chatFixture.release), "function");
  await page.evaluate(() => window.idou.closeChatReader());
  await app.evaluate(() => globalThis.chatFixture.release());
  result = await running;
  assert.equal(result.ok, false); assert.match(result.message, /消息(页面|阅读会话)已(变化|失效)/);
  assert.equal(await cards(), 0, "a retired page never even asks");
  assert.equal(await writes(), 0);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, syntheticFeishu: true, inAppConfirmation: true, canceledZeroWrites: true, exactReplyTarget: true, durableEncryptedReceipt: true, restartPreventsResend: true, staleReaderZeroWrites: true, narrowWindowAnswerable: true, liveMessages: 0, modelCalls: 0, paidCalls: 0 }));
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, "desktop-chat-reply-failure.png"), scale: "css" });
  throw error;
} finally { await app?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
