// Sending a document link to an internal group, with explicit @ mentions.
//
// The 发送到飞书 dialog this script used to drive is gone. The capability is
// three Agent operations now -- doc-share-search --kind group, then
// doc-share-members, then doc-share --mention -- and the decision is taken on
// the application's own confirmation card instead of a native message box.
// What has to be proved did not move: two groups with the same name stay
// distinguishable, an @ target has to be a handle the roster actually returned,
// an incomplete roster says so, the group audience disclosure is in front of
// the person who confirms, the wire content is only typed at/text/a nodes, and
// a member who leaves between preview and dispatch stops the send entirely.
import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import electronBinary from "electron";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { clientEnvironment } from "../src/providers/codex/gateway-config.js";
import { runAgentTool, answerConfirm, cardText, observeHumanChoice, presentHumanChoice, releaseHumanChoice, waitForConfirmationChoice } from "./fixtures/agent-harness.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-group-ui-"));
const data = path.join(directory, "app"), work = path.join(directory, "work");
const evidence = path.resolve("docs/evidence");
await mkdir(work, { recursive: true }); await mkdir(evidence, { recursive: true });
const url = "https://test.feishu.cn/docx/SyntheticDelivery123";
const NOTE = "请陈宁确认研发排期，周晓跟进评审。", RECHECK = "请核对最终联调时间。";
const ENGINEERING = "oc_synthetic_engineering", PRODUCT = "oc_synthetic_product";
const CHENNING = "ou_synthetic_engineering", ZHOUXIAO = "ou_synthetic_reviewer", NAMESAKE = "ou_synthetic_product";
const DISCLOSURE = "群聊可见范围内的人均可见消息；@ 只提醒选中的成员，不限制可见范围。";

let app, page, taskId; const errors = [];
async function launch() {
  app = await electron.launch({ executablePath: electronBinary, args: [path.resolve("scripts/fixtures/document-delivery-desktop-entry.js")], env: { ...clientEnvironment(), ...(process.env.IDOU_DESKTOP_BACKGROUND ? { IDOU_DESKTOP_BACKGROUND: "1" } : {}), IDOU_DESKTOP_DATA_DIR: data } });
  page = await app.firstWindow(); page.setDefaultTimeout(20_000); page.on("pageerror", error => errors.push(error.message));
  await page.locator("#new-task").waitFor();
}
// One Agent operation, run the way a task's Agent runs it: a real child process
// with the bridge environment this task was handed.
const ask = (...argv) => runAgentTool(app, taskId, argv, { cwd: work });
const noteFile = async (value) => { await writeFile(path.join(work, "note.txt"), value); };
const ok = (result) => { assert.equal(result.code, 0, result.stderr); return result.json; };
const search = async () => ok(await ask("doc-share-search", "--doc", url, "--query", "交付评审", "--kind", "group"));
const roster = async (recipient) => ok(await ask("doc-share-members", "--recipient", recipient));
const shareArgs = (recipient, mentions) => ["doc-share", "--recipient", recipient, "--note-file", "note.txt", ...(mentions.length ? ["--mention", mentions.join(",")] : [])];
const handleOf = (rows, id) => { const row = rows.find(item => item.id === id); assert.ok(row, `missing ${id}`); return row.handle; };
const sent = () => app.evaluate(() => globalThis.documentDeliveryFixture.sent);
const calls = () => app.evaluate(() => globalThis.documentDeliveryFixture.calls);
const card = () => page.locator("#confirmations .confirm-card");
const taskFile = async () => {
  const files = (await readdir(path.join(data, "tasks"))).filter(file => file.endsWith(".json"));
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(path.join(data, "tasks", files[0]), "utf8"));
};

try {
  await launch();
  // The task is created the way a person creates one -- opening its files --
  // so the application is in the state somebody actually confirms a send from,
  // with the task selected and its panel open.
  await page.locator("#open-files").click(); await page.locator("#files").waitFor();
  const tasks = (await page.evaluate(() => window.idou.snapshot())).tasks;
  assert.equal(tasks.length, 1); taskId = tasks[0].id;
  await noteFile(NOTE);

  // Two groups carry the same name. The search has to hand back both, each with
  // its own handle and enough beside the name to tell them apart -- picking one
  // is the user's decision, and nothing here may make it for them.
  const found = await search();
  assert.equal(found.kind, "group"); assert.equal(found.document.sourceUrl, url); assert.ok(found.document.title);
  assert.equal(found.groups.length, 2); assert.equal(found.excluded, 0); assert.equal(found.hasMore, false);
  assert.equal(new Set(found.groups.map(group => group.name)).size, 1);
  assert.equal(new Set(found.groups.map(group => group.handle)).size, 2);
  assert.deepEqual(found.groups.map(group => group.id).sort(), [ENGINEERING, PRODUCT]);
  assert.deepEqual(found.groups.map(group => group.description).sort(), ["产品评审与验收", "研发排期与联调"]);
  const engineering = handleOf(found.groups, ENGINEERING), product = handleOf(found.groups, PRODUCT);

  // A chat id typed out instead of chosen is not a choice. Neither operation
  // accepts one, so the group that gets the message is always one the provider
  // itself returned in this search.
  for (const argv of [["doc-share-members", "--recipient", ENGINEERING], shareArgs(ENGINEERING, [])]) {
    const refused = await ask(...argv);
    assert.notEqual(refused.code, 0); assert.match(refused.stderr, /来自搜索结果的 handle/);
  }

  // The roster is read from the group that was selected, and an incomplete read
  // is reported as incomplete rather than passed off as the whole membership.
  await app.evaluate(() => { globalThis.documentDeliveryFixture.partialMembers = true; });
  const partial = await roster(engineering);
  assert.equal(partial.partial, true); assert.equal(partial.group.id, ENGINEERING); assert.equal(partial.excluded, 0);
  assert.deepEqual(partial.members.map(member => member.id).sort(), [CHENNING, NAMESAKE, ZHOUXIAO].sort());
  // The flag follows the read, not the code path: the same roster read without
  // a truncated upstream page is reported as complete.
  await app.evaluate(() => { globalThis.documentDeliveryFixture.partialMembers = false; });
  assert.equal((await roster(engineering)).partial, false);
  // Reading the other group's roster does not carry over: the mention set is
  // bound to the group whose members were last read.
  const other = await roster(product);
  assert.equal(other.group.id, PRODUCT);
  const strayed = await ask(...shareArgs(engineering, [handleOf(other.members, ZHOUXIAO)]));
  assert.notEqual(strayed.code, 0); assert.match(strayed.stderr, /请先读取所选群的成员/);
  const members = await roster(engineering);
  const mentions = [handleOf(members.members, CHENNING), handleOf(members.members, ZHOUXIAO)];
  // The roster came from asking Feishu for this group's members, not from a
  // directory lookup or from the search result.
  assert.ok((await calls()).some(args => args[0] === "im" && args[1] === "+chat-members-list" && args[args.indexOf("--chat-id") + 1] === ENGINEERING));

  // An @ target has to be a handle from that roster. A typed open_id is refused
  // before anything is prepared, and a well-formed handle from nowhere is
  // refused against the roster itself.
  const typed = await ask(...shareArgs(engineering, [CHENNING]));
  assert.notEqual(typed.code, 0); assert.match(typed.stderr, /来自搜索结果的 handle/);
  const forged = await ask(...shareArgs(engineering, [randomUUID()]));
  assert.notEqual(forged.code, 0); assert.match(forged.stderr, /不是本次所选群的成员/);

  // Cancelling. The confirmation is the application's own card, and it is where
  // the audience disclosure has to be: @ looks like it narrows who can read the
  // message, and it does not.
  let running = ask(...shareArgs(engineering, mentions));
  await card().waitFor();
  // Nothing else may start for this task while a decision is outstanding.
  const concurrent = await ask("doc-share-search", "--doc", url, "--query", "交付评审", "--kind", "group");
  // A search is a read, answered beside a write that waits on its card
  // (e87c573); the delivery itself refuses a second flow while this one is out.
  assert.notEqual(concurrent.code, 0); assert.match(concurrent.stderr, /上一次发送还没结束/);
  const shown = await card().evaluate(cardText);
  assert.match(shown, /确认发送飞书群消息/);
  assert.ok(shown.includes(DISCLOSURE), shown);
  assert.match(shown, /群标识：oc_synthetic_engineering/); assert.match(shown, /内部私有群/); assert.match(shown, /用户数量：3/);
  // The mentioned 陈宁 carries enough of the id that will actually be mentioned
  // to tell them from the namesake in the same group; the full ids are in the
  // folded 核对信息, not in the body a person reads and records.
  assert.match(shown, /@陈宁（…ring）/); assert.doesNotMatch(shown, /@陈宁（…duct）/);
  assert.match(shown, /陈宁 ou_synthetic_engineering/); assert.doesNotMatch(shown, /ou_synthetic_product/);
  assert.match(shown, /@周晓（…ewer）/);
  assert.doesNotMatch(await card().locator(":scope > pre").innerText(), /\b(?:ou|oc)_[0-9a-z_]{6,}/, "no identifier in the card's body");
  assert.ok(shown.includes(found.document.title)); assert.ok(shown.includes(NOTE));
  assert.doesNotMatch(shown, /文档正文不随链接发送/);
  // Sending is never the pre-selected answer: 取消 stays first, no button is
  // styled as the one to press, and an ordinary send card does not steal focus
  // from the person's current task-file interaction.
  assert.equal((await card().locator(".confirm-actions button").first().innerText()).trim(), "取消");
  assert.equal(await card().getByRole("button", { name: "确认发送群消息", exact: true }).evaluate(node => node === document.activeElement), false);
  assert.equal(await card().locator("button.primary").count(), 0);
  await page.screenshot({ path: path.join(evidence, "desktop-document-group-preview-fixture.png"), scale: "css" });
  // However long the detail above it is, what is being authorised and the
  // buttons stay on screen in a small window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 700));
  const visible = node => { const rect = node.getBoundingClientRect(); return rect.top > 0 && rect.bottom <= innerHeight && rect.right <= innerWidth; };
  await page.waitForFunction(() => [".confirm-actions", ".confirm-boundary"].every(selector => {
    const rect = document.querySelector(`#confirmations ${selector}`)?.getBoundingClientRect();
    return rect && rect.top > 0 && rect.bottom <= innerHeight && rect.right <= innerWidth;
  }));
  assert.equal(await card().locator(".confirm-actions").evaluate(visible), true);
  assert.equal(await card().locator(".confirm-boundary").evaluate(visible), true);
  await page.screenshot({ path: path.join(evidence, "desktop-document-group-narrow-fixture.png"), scale: "css" });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1250, 840));
  await card().getByRole("button", { name: "取消" }).click();
  let result = await running;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /用户取消/);
  assert.equal((await sent()).length, 0);
  assert.equal(((await taskFile()).documentDeliveries || []).length, 0);

  // A member who leaves after the preview was built stops the send: the roster
  // and the selected identities are re-read immediately before dispatch, so a
  // stale mention is not silently dropped and the message is not sent without it.
  let choice = observeHumanChoice(page, { detailText: NOTE, label: "确认发送群消息" });
  running = ask(...shareArgs(engineering, mentions));
  await waitForConfirmationChoice(page, { detailText: NOTE, label: "确认发送群消息" });
  await app.evaluate(() => { const f = globalThis.documentDeliveryFixture; f.groupUsers = f.groupUsers.filter(user => user.member_id !== "ou_synthetic_engineering"); });
  await presentHumanChoice(app, page, "i豆 M05 · 群成员变化零发送");
  await choice;
  await releaseHumanChoice(app);
  result = await running;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /已离群/);
  assert.equal((await sent()).length, 0);
  assert.equal(((await taskFile()).documentDeliveries || []).length, 0);
  await app.evaluate(() => { globalThis.documentDeliveryFixture.groupUsers.splice(1, 0, { member_id: "ou_synthetic_engineering", name: "陈宁", tenant_key: "synthetic-tenant" }); });

  // The same selection, now that the member is back.
  choice = observeHumanChoice(page, { detailText: NOTE, label: "确认发送群消息" });
  running = ask(...shareArgs(engineering, mentions));
  await waitForConfirmationChoice(page, { detailText: NOTE, label: "确认发送群消息" });
  await presentHumanChoice(app, page, "i豆 M05 · 文档群消息确认");
  const confirmed = (await choice).text;
  await releaseHumanChoice(app);
  assert.ok(confirmed.includes(DISCLOSURE));
  const record = ok(await running);
  assert.equal(record.state, "acknowledged"); assert.equal(record.chatId, ENGINEERING);
  assert.deepEqual(record.mentions.map(user => user.id), [CHENNING, ZHOUXIAO]);
  // One post, to the chosen group, made of nothing but typed nodes: the @ list,
  // the title, one hyperlink whose text and href are both the canonical source,
  // and the note. No markup a person typed, no @all, no document body.
  const posted = await sent();
  assert.equal(posted.length, 1); assert.equal(posted[0].chat_id, ENGINEERING);
  const nodes = posted[0].content.zh_cn.content.flat();
  assert.deepEqual(posted[0].content.zh_cn.content[0], [{ tag: "at", user_id: CHENNING }, { tag: "at", user_id: ZHOUXIAO }]);
  assert.deepEqual(nodes.filter(node => node.tag === "a"), [{ tag: "a", href: url, text: url }]);
  assert.deepEqual([...new Set(nodes.map(node => node.tag))].sort(), ["a", "at", "text"]);
  assert.doesNotMatch(nodes.filter(node => node.tag === "text").map(node => node.text).join(""), /文档正文不随链接发送/);

  // The same document, message and mention set will not be submitted twice.
  const duplicate = await ask(...shareArgs(engineering, mentions));
  assert.notEqual(duplicate.code, 0); assert.match(duplicate.stderr, /已有发送记录/);
  assert.equal((await sent()).length, 1);

  // A lost acknowledgement is kept as unknown and never retried by itself.
  await noteFile(RECHECK);
  await app.evaluate(() => { globalThis.documentDeliveryFixture.lost = true; });
  choice = observeHumanChoice(page, { detailText: RECHECK, label: "确认发送群消息" });
  running = ask(...shareArgs(engineering, mentions));
  await waitForConfirmationChoice(page, { detailText: RECHECK, label: "确认发送群消息" });
  await presentHumanChoice(app, page, "i豆 M05 · 群消息回执未知");
  await choice;
  await releaseHumanChoice(app);
  result = await running;
  assert.notEqual(result.code, 0); assert.match(result.stderr, /可能已发送/);
  assert.equal((await sent()).length, 2);

  const before = await taskFile();
  assert.deepEqual(before.documentDeliveries.map(row => row.state), ["acknowledged", "unknown"]);
  assert.deepEqual(before.documentDeliveries.map(row => row.recipient.id), [ENGINEERING, ENGINEERING]);
  assert.ok(before.documentDeliveries.every(row => row.recipient.kind === "group" && row.recipient.name === "本周交付评审"));
  assert.ok(before.documentDeliveries.every(row => row.mentions.map(user => user.id).join() === `${CHENNING},${ZHOUXIAO}`));
  // Sending a link is not a turn in the conversation and writes nothing back.
  // A notice is not a turn either: it is the application telling the person
  // something, and only an ambiguous result produces one.
  assert.deepEqual(before.messages.filter(row => row.role !== "notice"), []);
  // One notice per ambiguous result, and none for any other outcome.
  assert.equal(before.messages.filter(row => row.role === "notice").length,
    before.documentDeliveries.filter(row => row.state === "unknown").length,
    "a notice exists exactly for a send whose result is unknown");
  assert.equal(before.activity.length, 0);
  // The confirmation happened inside the application; no native message box was
  // raised, and nothing on this path wrote to the document or its permissions.
  assert.equal(await app.evaluate(() => globalThis.documentDeliveryFixture.dialogs.length), 0);
  assert.ok((await calls()).every(args => !args.includes("--yes") && !args.includes("+update") && args[0] !== "drive"));

  // A restart does not resend, and the unknown record still blocks the message
  // it belongs to -- reversing the mention order does not make it a new one.
  await app.close(); app = null; await launch();
  await page.waitForFunction(async id => (await window.idou.snapshot()).tasks.some(task => task.id === id), taskId);
  assert.equal((await sent()).length, 0);
  const reopened = await search();
  const again = await roster(handleOf(reopened.groups, ENGINEERING));
  const reversed = [handleOf(again.members, ZHOUXIAO), handleOf(again.members, CHENNING)];
  const refused = await ask(...shareArgs(handleOf(reopened.groups, ENGINEERING), reversed));
  assert.notEqual(refused.code, 0); assert.match(refused.stderr, /已有发送记录/);
  assert.equal((await sent()).length, 0);
  assert.deepEqual((await taskFile()).documentDeliveries.map(row => row.state), ["acknowledged", "unknown"]);

  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, actualElectron: true, agentDriven: true, inAppConfirmation: true, syntheticCli: true,
    sameNameGroupsDistinguished: true, rosterBoundMentions: true, typedMentionRefused: true, partialRosterReported: true,
    groupAudienceDisclosed: true, removedMemberDenied: true, cancelZeroMessages: true, concurrentOperationRefused: true,
    narrowConfirmationVisible: true, restartNoResend: true, syntheticMessages: 2, liveMessages: 0, docWrites: 0, aclChanges: 0,
    modelCalls: 0, paidCalls: 0, nativeDialogs: 0, rendererErrors: errors }));
} catch (error) {
  console.error(error?.stack ?? error);
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, "desktop-document-group-failure.png"), scale: "css" }).catch(() => {});
  throw error;
} finally { await app?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
