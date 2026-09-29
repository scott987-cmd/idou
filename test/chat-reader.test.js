import test from "node:test";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import os from "node:os";
import path from "node:path";
import { FeishuRuntimeRefused } from "../src/providers/feishu/bundled-runtime.js";
import { ChatReader } from "../src/application/chat-reader.js";
import { chatFixture, chatResponse, chatDocumentUrl } from "../scripts/fixtures/chat-data.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

function fixture() {
  const state = chatFixture(); state.now = Date.now();
  const provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, async (binary, args, options) => {
    assert.equal(binary, STUB_CLI);
    assert.equal(args.includes("--yes") || args.includes("--download-resources"), false);
    if (args[0] !== "auth") {
      assert.equal(args[args.indexOf("--as") + 1], "user");
      assert.ok(["+chat-list", "+chat-messages-list", "+messages-mget"].includes(args[1]));
      assert.equal(options.maxOutputBytes, 2 * 1024 * 1024);
    }
    return chatResponse(state, args);
  });
  const reader = new ChatReader({ provider: provider.chatReader, now: () => state.now,
    businessAccess: () => { if (state.blocked) throw new Error("unlinked enterprise identity"); } });
  const open = async () => { const list = await reader.list(); return reader.read(list.chats[0].handle); };
  return { state, provider, reader, open };
}
test("pinned user reader lists p2p/groups and paginates with native-owned cursors", async t => {
  const f = fixture(); t.after(() => f.reader.close());
  const page = await f.reader.list(); assert.equal(page.chats[1].mode, "p2p"); assert.notEqual(page.next, "chats:next");
  const next = await f.reader.list(page.next); assert.equal(next.chats[0].external, true); assert.equal(next.next, null);
  const calls = f.state.calls.filter(args => args[1] === "+chat-list");
  assert.equal(calls[0][calls[0].indexOf("--types") + 1], "p2p,group"); assert.equal(calls[0][calls[0].indexOf("--sort") + 1], "active_time");
  assert.equal(calls[1][calls[1].indexOf("--page-token") + 1], "chats:next");
});
test("message projection retains inert text/replies, strips recalled body, exposes only validated document links", async t => {
  const f = fixture(); t.after(() => f.reader.close()); const result = await f.open();
  assert.match(result.messages[1].text, /<script>/); assert.equal(result.messages[1].sender, "ou_bot");
  assert.equal(result.messages[1].documents.length, 0); assert.equal(result.messages[2].documents.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /RECALLED_SECRET/); assert.equal(result.messages[0].threadPartial, true);
  assert.equal(result.messages[0].replies[0].id, "om_reply"); assert.equal(result.messages[0].documents[0].url, chatDocumentUrl);
  const args = f.state.calls.find(args => args[1] === "+chat-messages-list"); assert.ok(args.includes("--no-reactions"));
  assert.equal(args[args.indexOf("--order") + 1], "desc");
});
test("opening a document re-reads exactly its source message before returning URL", async t => {
  const f = fixture(); t.after(() => f.reader.close()); const result = await f.open();
  const document = await f.reader.document(result.messages[0].documents[0].handle); assert.deepEqual(document, { url: chatDocumentUrl });
  const args = f.state.calls.find(args => args[1] === "+messages-mget"); assert.equal(args[args.indexOf("--message-ids") + 1], "om_plan");
});
test("missing, recalled, changed and wrong source messages invalidate document navigation", async () => {
  for (const kind of ["missing", "recalled", "changed", "wrong"]) {
    const f = fixture(), result = await f.open();
    if (kind === "missing") f.state.mgetRows = [];
    if (kind === "recalled") f.state.rows[0].deleted = true;
    if (kind === "changed") f.state.rows[0].content = "link removed";
    if (kind === "wrong") f.state.mgetRows = [{ ...f.state.rows[0], message_id: "om_wrong" }];
    await assert.rejects(f.reader.document(result.messages[0].documents[0].handle), /来源消息/); assert.equal(f.reader.session, null);
  }
});
test("identity switch before read and during an in-flight read cannot expose stale data", async () => {
  const f = fixture(), page = await f.reader.list(); f.state.user = "ou_other";
  await assert.rejects(f.reader.read(page.chats[0].handle), /读取失败/); assert.equal(f.reader.session, null);
  assert.equal(f.state.calls.filter(args => args[1] === "+chat-messages-list").length, 0);
  f.state.afterRead = () => { f.state.user = "ou_changed_during_read"; };
  await assert.rejects(f.reader.list(), /读取失败/); assert.equal(f.reader.session, null);
});
test("unlinked enterprise, missing tenant and bot envelopes never become a reader session", async () => {
  const f = fixture(); f.state.blocked = true; await assert.rejects(f.reader.list(), /unlinked/); assert.equal(f.state.calls.length, 0);
  f.state.blocked = false; f.state.tenant = null; await assert.rejects(f.reader.list(), /读取失败/);
  f.state.tenant = "tenant"; f.state.envelopeIdentity = "bot"; await assert.rejects(f.reader.list(), /读取失败/);
  assert.equal(f.reader.session, null);
});
test("forged and cross-conversation cursors/links are refused before dispatch", async () => {
  const f = fixture(), list = await f.reader.list(), page = await f.reader.read(list.chats[0].handle), count = f.state.calls.length;
  await assert.rejects(f.reader.read(list.chats[1].handle, page.next), /分页已失效/); assert.equal(f.state.calls.length, count);
  await f.reader.list(); const count2 = f.state.calls.length;
  await assert.rejects(f.reader.document(page.messages[0].documents[0].handle), /链接已失效/); assert.equal(f.state.calls.length, count2);
  await f.reader.list(); const count3 = f.state.calls.length;
  await assert.rejects(f.reader.read("oc_delivery"), /当前会话列表/); assert.equal(f.state.calls.length, count3);
});
test("page transition invalidates old message links while passing only its stored pagination token", async t => {
  const f = fixture(); t.after(() => f.reader.close()); const list = await f.reader.list(), page = await f.reader.read(list.chats[0].handle);
  const next = await f.reader.read(list.chats[0].handle, page.next); assert.equal(next.messages[0].text, "较早的讨论内容");
  assert.equal(next.next, null); assert.equal(f.state.calls.filter(args => args[1] === "+chat-messages-list").at(-1).includes("messages:next"), true);
  await assert.rejects(f.reader.document(page.messages[0].documents[0].handle), /链接已失效/);
});
test("expired views reject before network work and close clears native capabilities", async () => {
  const f = fixture(), page = await f.open(); f.state.now += 300_001; const count = f.state.calls.length;
  await assert.rejects(f.reader.document(page.messages[0].documents[0].handle), /会话已失效/); assert.equal(f.state.calls.length, count);
  const list = await f.reader.list(); f.reader.close(); await assert.rejects(f.reader.read(list.chats[0].handle), /会话已失效/);
});
test("late success cannot overwrite a newer list; close rejects an in-flight document resolution", async t => {
  const f = fixture(); t.after(() => f.reader.close()); let release, reached;
  const started = new Promise(resolve => { reached = resolve; });
  f.state.afterRead = async () => { f.state.afterRead = null; reached(); await new Promise(resolve => { release = resolve; }); };
  const old = f.reader.list(); const rejection = assert.rejects(old, /页面已变化/); await started;
  const fresh = await f.reader.list(); release(); await rejection; assert.ok(f.reader.session.chats.has(fresh.chats[0].handle));
  const page = await f.reader.read(fresh.chats[0].handle);
  f.state.afterRead = () => f.reader.close();
  await assert.rejects(f.reader.document(page.messages[0].documents[0].handle), /页面已变化/); assert.equal(f.reader.session, null);
});
test("authorization failure clears previously visible message authority without leaking upstream details", async () => {
  const f = fixture(), page = await f.open(); f.state.denied = true;
  await assert.rejects(f.reader.document(page.messages[0].documents[0].handle), error => /读取失败/.test(error.message) && !/SECRET_DETAIL/.test(error.message)); assert.equal(f.reader.session, null);
});
test("malformed pagination, duplicate ids, ambiguous recalled state and oversized messages fail closed", async () => {
  for (const data of [{ chats: [], has_more: true }, { chats: [], has_more: "false" }, { chats: [chatFixture().chats[0], chatFixture().chats[0]], has_more: false }]) {
    const f = fixture(); f.state.override = data; await assert.rejects(f.reader.list()); assert.equal(f.reader.session, null);
  }
  for (const row of [{ ...chatFixture().rows[0], deleted: undefined }, { ...chatFixture().rows[0], content: "x".repeat(65537) }]) {
    const f = fixture(), list = await f.reader.list(); f.state.override = { messages: [row], has_more: false };
    await assert.rejects(f.reader.read(list.chats[0].handle)); assert.equal(f.reader.session, null);
  }
});
// 2026-09-24: the docked Agent's chat list could not be read because the
// application refused to run its own CLI (src/ had changed since the release was
// signed), and this reader said to check the CLI login, message permissions and
// network. A refusal of the runtime is reported as that, and nothing runs.
test("a CLI the application refuses to run is named, not reported as a login, permission or network failure", async t => {
  const ran = [], provider = new SaasFeishuCliProvider({ binary: path.join(os.tmpdir(), `idou-absent-cli-${process.pid}`, "lark-cli") }, async (...args) => { ran.push(args); throw new Error("ran"); });
  const reader = new ChatReader({ provider: provider.chatReader }); t.after(() => reader.close());
  await assert.rejects(reader.list(), error => error instanceof FeishuRuntimeRefused && !/读取失败/.test(error.message));
  assert.deepEqual(ran, []); assert.equal(reader.session, null);
});
