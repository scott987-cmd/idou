// Sending a document link to a colleague as a private message, driven the way a
// task's Agent drives it.
//
// The 发送到飞书 dialog is gone; doc-share-search / doc-share are the same three
// steps against the same DocumentDelivery application layer, so what has to hold
// is unchanged: two people with one name are told apart and one is picked
// explicitly, a recipient can only be a record the provider itself returned, the
// confirmation shows the exact bytes that would leave and who would be sending
// them, declining sends nothing, confirming sends once, the durable record is
// written as `dispatching` before the CLI is called and only then becomes
// `acknowledged`, and a second send of the same thing is refused -- after a
// restart too. Only the upstream CLI is synthetic; the shim, the loopback
// bridge, the action, the in-app confirmation and task persistence are the
// production ones.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { runAgentTool, answerConfirm, observeHumanChoice, presentHumanChoice, releaseHumanChoice, waitForConfirmationChoice } from "./fixtures/agent-harness.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-delivery-ui-"));
const work = path.join(directory, "agent"), evidence = path.resolve("docs/evidence");
await mkdir(work, { recursive: true }); await mkdir(evidence, { recursive: true });
const url = "https://test.feishu.cn/docx/SyntheticDelivery123";
const NOTE = "请确认研发排期，感谢。", SECOND = "请再确认一下联调时间。";
const ENGINEERING = "ou_synthetic_engineering";
let app, page, taskId; const errors = [];

async function launch() {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/document-delivery-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: directory } });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
}
// Every operation is the real child process with the environment this task's
// Agent is given. Content arrives as a file, the way the shim requires.
const agent = async (argv, note) => {
  if (note !== undefined) await writeFile(path.join(work, "note.txt"), note);
  return runAgentTool(app, taskId, argv, { cwd: work });
};
const search = () => agent(["doc-share-search", "--doc", url, "--query", "陈宁"]);
const share = (recipient, note) => agent(["doc-share", "--recipient", recipient, "--note-file", "note.txt"], note);
const pick = (found) => found.json.users.find(user => user.id === ENGINEERING).handle;
const card = () => page.locator("#confirmations .confirm-card");
const fixture = (read) => app.evaluate(read);
const sent = () => fixture(() => globalThis.documentDeliveryFixture.sent);
const stored = async () => {
  const files = (await readdir(path.join(directory, "tasks"))).filter(file => file.endsWith(".json"));
  return JSON.parse(await readFile(path.join(directory, "tasks", files[0]), "utf8"));
};
// An operation that never reached a decision must not have asked for one: the
// card is removed as soon as it is answered, so anything left is unanswered.
const unasked = async (what) => assert.equal(await card().count(), 0, `${what} must not have raised a confirmation`);

try {
  await launch();
  // Create and select the task through the visible work-task surface. A
  // task-scoped confirmation must never appear over some unrelated task.
  await page.locator("#open-files").click(); await page.locator("#files").waitFor();
  const tasks = (await page.evaluate(() => window.idou.snapshot())).tasks;
  assert.equal(tasks.length, 1); taskId = tasks[0].id;

  // Step one, and the only place a recipient can come from. Two people share a
  // name; what tells them apart is what the provider returned about each, and
  // neither of them is chosen for the Agent.
  const found = await search();
  assert.equal(found.code, 0, found.stderr);
  assert.equal(found.json.kind, "user");
  assert.equal(found.json.document.title, "本周交付计划（合成验收）");
  assert.equal(found.json.document.sourceUrl, url);
  assert.equal(found.json.hasMore, false); assert.equal(found.json.excluded, 0);
  assert.equal(found.json.users.length, 2);
  assert.deepEqual(found.json.users.map(user => user.name), ["陈宁", "陈宁"]);
  assert.deepEqual(found.json.users.map(user => user.department), ["产品设计部", "研发交付部"]);
  assert.deepEqual(found.json.users.map(user => user.email), ["chenning.product@example.test", "chenning.engineering@example.test"]);
  assert.deepEqual(found.json.users.map(user => user.id), ["ou_synthetic_product", ENGINEERING]);
  assert.equal(new Set(found.json.users.map(user => user.handle)).size, 2);
  const message = `${found.json.document.title}\n${found.json.document.sourceUrl}\n\n${NOTE}`;

  // The open_id is right there in the search result and still buys nothing: the
  // handle is what carries the choice, and only a live search issues one.
  const typed = await share(ENGINEERING, NOTE);
  assert.notEqual(typed.code, 0); assert.match(typed.stderr, /--recipient 需要一个来自搜索结果的 handle，不能自己拼 id/);
  await unasked("a typed open_id");
  const forged = await share(randomUUID(), NOTE);
  assert.notEqual(forged.code, 0); assert.match(forged.stderr, /请重新搜索并明确选择一位收件人/);
  await unasked("a handle nobody issued");
  assert.deepEqual(await sent(), []);

  // Declining. The card is the whole disclosure: the exact bytes that would be
  // sent, which of the two 陈宁 would receive them, who is sending, and what the
  // confirmation does not cover.
  let running = share(pick(found), NOTE);
  const declined = await answerConfirm(page, "取消");
  assert.ok(declined.includes(message), declined);
  assert.match(declined, /收件人：陈宁/);
  assert.match(declined, /部门：研发交付部/);
  assert.match(declined, /邮箱：chenning\.engineering@example\.test/);
  assert.match(declined, new RegExp(`标识：${ENGINEERING}`));
  assert.match(declined, /发送身份：当前飞书 CLI 用户（不是机器人）/);
  assert.match(declined, /租户：synthetic-tenant/);
  assert.match(declined, /身份指纹：[0-9a-f]{12}/);
  assert.match(declined, /不发送文档正文，不改变文档权限/);
  // The other 陈宁 is not named, and the body of the document is not in it.
  assert.doesNotMatch(declined, /产品设计部/);
  assert.doesNotMatch(declined, /文档正文不随链接发送/);
  let result = await running;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /用户取消了这次发送/);
  assert.deepEqual(await sent(), []);
  assert.deepEqual((await stored()).documentDeliveries ?? [], []);

  // Answering yes is not the last check. The source is re-read after the person
  // decides, so a document that moved under the confirmation sends nothing.
  let choice = observeHumanChoice(page, { detailText: NOTE, label: "确认发送私信" });
  running = share(pick(found), NOTE);
  await waitForConfirmationChoice(page, { detailText: NOTE, label: "确认发送私信" });
  await fixture(() => { globalThis.documentDeliveryFixture.revision++; });
  await presentHumanChoice(app, page, "i豆 M05 · 私信前版本变化");
  await choice;
  await releaseHumanChoice(app);
  result = await running;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /文档版本、权限或身份已变化/);
  assert.deepEqual(await sent(), []);
  assert.deepEqual((await stored()).documentDeliveries ?? [], []);
  // The reference goes with it, so nothing can still be sent against the
  // document that was reviewed.
  const stale = await share(pick(found), NOTE);
  assert.notEqual(stale.code, 0); assert.match(stale.stderr, /没有打开的飞书文档/);

  const again = await search();
  assert.equal(again.code, 0, again.stderr);
  // A new search retires the previous handles; the choice belongs to one search.
  const previous = await share(pick(found), NOTE);
  assert.notEqual(previous.code, 0); assert.match(previous.stderr, /请重新搜索并明确选择一位收件人/);
  await unasked("a handle from a superseded search");

  // Confirming. One message, to the person that was chosen, with the reviewed
  // text and nothing else.
  choice = observeHumanChoice(page, { detailText: NOTE, label: "确认发送私信" });
  running = share(pick(again), NOTE);
  await waitForConfirmationChoice(page, { detailText: NOTE, label: "确认发送私信" });
  // The specifics are disclosed in a box that scrolls, and the message is
  // longer than it. What the confirmation authorises and the buttons that
  // answer it stay on screen anyway -- the guarantee the dialog's pinned footer
  // used to carry. The evidence shot is taken at the bottom of that box, where
  // the message being authorised is.
  const detail = card().locator(":scope > pre"); // the disclosure itself, not the folded 核对信息
  assert.equal(await detail.evaluate(node => node.scrollHeight > node.clientHeight), true, "the disclosure must scroll rather than be cut off");
  await detail.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const onScreen = node => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth; };
  assert.equal(await card().locator(".confirm-boundary").evaluate(onScreen), true);
  assert.equal(await card().locator(".confirm-actions").evaluate(onScreen), true);
  // The answer that sends nothing is the one in hand: first in the row, and the
  // send action is not styled as a default. Ordinary cards do not steal the
  // person's typing focus; destructive cards separately focus their safe choice.
  const first = card().locator(".confirm-actions button").first();
  assert.equal((await first.innerText()).trim(), "取消");
  assert.equal(await card().locator("button.primary").count(), 0);
  await page.screenshot({ path: path.join(evidence, "desktop-document-delivery-preview-fixture.png"), scale: "css" });
  await presentHumanChoice(app, page, "i豆 M05 · 文档私信确认");
  const shown = (await choice).text;
  await releaseHumanChoice(app);
  result = await running;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.state, "acknowledged");
  assert.equal(result.json.messageId, "om_synthetic_1");
  assert.equal(result.json.recipient.id, ENGINEERING);
  assert.equal(result.json.text, message);
  // What the card showed is what the record kept: the same message, the same
  // sender tenant, the same principal fingerprint.
  assert.ok(shown.includes(result.json.text), shown);
  assert.ok(shown.includes(`租户：${result.json.sender.tenantKey}`), shown);
  assert.ok(shown.includes(`身份指纹：${result.json.sender.principal.slice(0, 12)}`), shown);
  let posted = await sent();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].userId, ENGINEERING);
  assert.equal(posted[0].text, message);
  // Observed from inside the send: the durable record already existed, and said
  // `dispatching`, at the moment the CLI was about to be called.
  assert.deepEqual(await fixture(() => globalThis.documentDeliveryFixture.dispatchStates), ["dispatching"]);
  let task = await stored();
  assert.deepEqual(task.documentDeliveries.map(row => row.state), ["acknowledged"]);
  assert.equal(task.documentDeliveries[0].text, message);
  assert.equal(task.documentDeliveries[0].recipient.id, ENGINEERING);
  assert.equal(task.documentDeliveries[0].messageId, "om_synthetic_1");

  // The same message a second time is refused by the record, without asking.
  const duplicate = await share(pick(again), NOTE);
  assert.notEqual(duplicate.code, 0); assert.match(duplicate.stderr, /已有发送记录/);
  await unasked("a repeat of a message already sent");
  assert.equal((await sent()).length, 1);

  // A send whose receipt never arrives stays `unknown` and is never retried,
  // although the message did leave.
  await fixture(() => { globalThis.documentDeliveryFixture.lost = true; });
  choice = observeHumanChoice(page, { detailText: SECOND, label: "确认发送私信" });
  running = share(pick(again), SECOND);
  await waitForConfirmationChoice(page, { detailText: SECOND, label: "确认发送私信" });
  await presentHumanChoice(app, page, "i豆 M05 · 私信回执未知");
  assert.ok((await choice).text.includes(SECOND));
  await releaseHumanChoice(app);
  result = await running;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /消息可能已发送，但回执未确认/);
  posted = await sent();
  assert.equal(posted.length, 2); assert.equal(posted[1].text, `${found.json.document.title}\n${url}\n\n${SECOND}`);
  const retry = await share(pick(again), SECOND);
  assert.notEqual(retry.code, 0); assert.match(retry.stderr, /已有发送记录/);
  await unasked("a retry of an unacknowledged send");
  assert.equal((await sent()).length, 2);
  task = await stored();
  assert.deepEqual(task.documentDeliveries.map(row => row.state), ["acknowledged", "unknown"]);
  assert.deepEqual(await fixture(() => globalThis.documentDeliveryFixture.dispatchStates), ["dispatching", "dispatching"]);
  // Nothing here went through a system alert, and nothing touched the document,
  // its permissions or the Drive.
  assert.equal(await fixture(() => globalThis.documentDeliveryFixture.dialogs.length), 0);
  const calls = await fixture(() => globalThis.documentDeliveryFixture.calls);
  assert.ok(calls.every(args => !args.includes("+update") && !args.includes("--yes") && args[0] !== "drive"));

  // Restarting is what a person does after an ambiguous result. It restores the
  // record, not the document reference, and it does not restore the ability to
  // send either message again.
  await app.close(); app = null; await launch();
  await page.waitForFunction(async id => (await window.idou.snapshot()).tasks.some(task => task.id === id), taskId);
  assert.deepEqual(await sent(), []);
  const closed = await share(pick(again), NOTE);
  assert.notEqual(closed.code, 0); assert.match(closed.stderr, /没有打开的飞书文档/);
  const reopened = await search();
  assert.equal(reopened.code, 0, reopened.stderr);
  for (const note of [NOTE, SECOND]) {
    const refused = await share(pick(reopened), note);
    assert.notEqual(refused.code, 0); assert.match(refused.stderr, /已有发送记录/);
  }
  await unasked("a duplicate after a restart");
  assert.deepEqual(await sent(), []);
  assert.deepEqual(await fixture(() => globalThis.documentDeliveryFixture.dispatchStates), []);
  await page.screenshot({ path: path.join(evidence, "desktop-document-delivery-restart-fixture.png"), scale: "css" });

  task = await stored();
  assert.deepEqual(task.documentDeliveries.map(row => row.state), ["acknowledged", "unknown"]);
  // The document was read four times over and never became a conversation turn:
  // no user message, no assistant answer, no thread, no model.
  assert.deepEqual(task.messages.filter(row => row.role !== "notice"), []);
  assert.equal(task.codexThreadId, null); assert.equal(task.activity.length, 0);
  // An ambiguous send is the one outcome nobody may miss, and the history list
  // that used to carry it went with the delivery dialog. It is said in the
  // conversation instead, naming the recipient and refusing to retry.
  const notices = task.messages.filter(row => row.role === "notice");
  assert.equal(notices.length, 1, "exactly one notice, for the one unknown result");
  assert.match(notices[0].text, /没有收到飞书回执/);
  assert.match(notices[0].text, /不会自动重试/);
  assert.equal(await fixture(() => globalThis.documentDeliveryFixture.dialogs.length), 0);
  assert.ok((await fixture(() => globalThis.documentDeliveryFixture.calls)).every(args => !args.includes("+update") && !args.includes("--yes") && args[0] !== "drive"));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, agentDriven: true, inAppConfirmation: true, syntheticCli: true, sameNameDistinguished: true, typedRecipientRefused: true, exactRecipientAndMessage: true, declinedSentNothing: true, changedSourceDenied: true, dispatchingBeforeCliCall: true, lostAcknowledgmentNoRetry: true, persistedAcrossRestart: true, syntheticMessages: 2, liveMessages: 0, docWrites: 0, aclChanges: 0, paidCalls: 0, rendererErrors: errors }));
} catch (error) {
  console.error(error?.stack ?? error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, "desktop-document-delivery-failure.png"), scale: "css" }).catch(() => {});
  throw error;
} finally { await app?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
