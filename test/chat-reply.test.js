import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { ChatReader } from "../src/application/chat-reader.js";
import { ChatReply } from "../src/application/chat-reply.js";
import { chatFixture, chatResponse } from "../scripts/fixtures/chat-data.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-reply-")), state = chatFixture(), cipher = fixtureCipher(randomBytes(32));
  const filename = path.join(directory, "reply.enc"); state.writes = []; state.now = Date.now();
  const provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, async (binary, args) => {
    assert.equal(binary, STUB_CLI);
    if (args[1] !== "+messages-reply") return chatResponse(state, args);
    state.writes.push(args);
    const ledger = JSON.parse(cipher.decrypt(await readFile(filename)));
    assert.equal(ledger.entries.at(-1).state, "dispatching", "intent must be durably readable before the external effect");
    assert.equal(args.includes("--markdown") || args.includes("--yes") || args.includes("--download-resources"), false);
    assert.equal(args[args.indexOf("--as") + 1], "user");
    assert.equal(args[args.indexOf("--idempotency-key") + 1], ledger.entries.at(-1).id);
    if (state.onWrite) await state.onWrite();
    if (state.lost) throw new Error("SECRET transport timeout");
    return { code: 0, stdout: JSON.stringify({ ok: true, identity: state.replyIdentity || "user", data: { message_id: "om_sent", chat_id: state.receiptChat || "oc_delivery" } }), stderr: "" };
  });
  const reader = new ChatReader({ provider: provider.chatReader, now: () => state.now, businessAccess: () => { if (state.blocked) throw new Error("unlinked"); } });
  const service = () => new ChatReply({ reader, provider: provider.chatReader, filename, cipher });
  const reply = service();
  const open = async () => { const list = await reader.list(); return (await reader.read(list.chats[0].handle)).messages[0].replyHandle; };
  t.after(async () => { reader.close(); await rm(directory, { recursive: true, force: true }); });
  return { state, provider, reader, reply, open, service, filename, cipher };
}

test("reply uses exact native message, plain argv, consent and encrypted durable intent before one dispatch", async t => {
  const f = await setup(t), handle = await f.open();
  const result = await f.reply.send(handle, "收到\n  保留缩进", true, draft => {
    assert.equal(draft.message.id, "om_plan"); assert.equal(draft.chat.id, "oc_delivery");
    assert.equal(draft.text, "收到\n  保留缩进"); draft.chat.id = "oc_tampered"; draft.text = "tampered"; return true;
  });
  assert.equal(result.state, "acknowledged"); assert.equal(result.chatId, "oc_delivery");
  const args = f.state.writes[0]; assert.equal(args[args.indexOf("--message-id") + 1], "om_plan");
  assert.equal(args[args.indexOf("--text") + 1], "收到\n  保留缩进"); assert.ok(args.includes("--reply-in-thread"));
  const bytes = await readFile(f.filename); assert.equal(bytes.includes(Buffer.from("收到")), false);
  assert.doesNotMatch(f.cipher.decrypt(bytes), /收到|交付计划|ou_chen/);
  assert.equal((await stat(f.filename)).mode & 0o777, 0o600);
  await assert.rejects(f.service().send(handle, "收到\n  保留缩进", true, () => true), /已有发送回执/);
  assert.equal(f.state.writes.length, 1);
});

test("cancel and invalid handles/content never dispatch or persist an intent", async t => {
  const f = await setup(t), handle = await f.open();
  assert.equal((await f.reply.send(handle, "草稿", false, () => false)).state, "canceled");
  for (const text of ["", " ", "x".repeat(2001), '<at user_id="all"></at>', "bad\u202e"]) await assert.rejects(f.reply.send(handle, text, false, () => true));
  await assert.rejects(f.reply.send("om_plan", "草稿", false, () => true), /目标已失效/);
  assert.equal(f.state.writes.length, 0); await assert.rejects(readFile(f.filename), { code: "ENOENT" });
});

test("edited/recalled/wrong-chat/identity changes during native confirmation refuse the write", async t => {
  for (const kind of ["edit", "recall", "chat", "identity", "blocked", "expiry", "navigation", "same-chat-refresh"]) {
    const f = await setup(t), handle = await f.open();
    await assert.rejects(f.reply.send(handle, "待发送", false, async () => {
      if (kind === "edit") f.state.rows[0].content = "changed";
      if (kind === "recall") f.state.rows[0].deleted = true;
      if (kind === "chat") f.state.rows[0].chat_id = "oc_wrong";
      if (kind === "identity") f.state.user = "ou_other";
      if (kind === "blocked") f.state.blocked = true;
      if (kind === "expiry") f.state.now += 300_001;
      if (kind === "navigation") f.reader.close();
      if (kind === "same-chat-refresh") await f.open();
      return true;
    }), undefined, kind);
    assert.equal(f.state.writes.length, 0, kind);
  }
});

test("lost, wrong-chat and wrong-identity receipts survive restart and source edits as non-retryable", async t => {
  for (const kind of ["lost", "wrong-chat", "bot"]) {
    const f = await setup(t), handle = await f.open();
    f.state.lost = kind === "lost"; f.state.receiptChat = kind === "wrong-chat" ? "oc_other" : null; f.state.replyIdentity = kind === "bot" ? "bot" : "user";
    const result = await f.reply.send(handle, "唯一回复", false, () => true);
    assert.equal(result.state, "unknown"); assert.doesNotMatch(result.message, /SECRET/);
    f.state.rows[0].content = "原文已更新"; const fresh = await f.open();
    await assert.rejects(f.service().send(fresh, "唯一回复", false, () => true), /可能已发送/);
    assert.equal(f.state.writes.length, 1);
  }
});

test("journal unavailable/corrupt/full and pre-dispatch save failure fail closed", async t => {
  for (const kind of ["cipher", "corrupt", "full", "save"]) {
    const f = await setup(t), handle = await f.open();
    if (kind === "cipher") f.cipher.available = () => false;
    if (kind === "corrupt") await writeFile(f.filename, "do-not-overwrite");
    if (kind === "full") f.reply.load = async () => Array.from({ length: 5000 }, () => ({ fingerprint: "different" }));
    if (kind === "save") f.reply.save = async () => { throw new Error("disk full"); };
    await assert.rejects(f.reply.send(handle, "test", false, () => true));
    assert.equal(f.state.writes.length, 0);
    if (kind === "corrupt") assert.equal(await readFile(f.filename, "utf8"), "do-not-overwrite");
  }
});

test("post-send receipt-save failure leaves restart-visible dispatching intent, not a retry", async t => {
  const f = await setup(t), handle = await f.open();
  f.state.onWrite = () => { f.reply.save = async () => { throw new Error("disk full"); }; };
  assert.equal((await f.reply.send(handle, "exactly once", false, () => true)).state, "unknown");
  assert.equal(JSON.parse(f.cipher.decrypt(await readFile(f.filename))).entries[0].state, "dispatching");
  await assert.rejects(f.service().send(handle, "exactly once", false, () => true), /可能已发送/);
  assert.equal(f.state.writes.length, 1);
});

test("concurrent sends are rejected while confirmation is pending", async t => {
  const f = await setup(t), handle = await f.open(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const pending = f.reply.send(handle, "first", false, () => new Promise(resolve => { release = resolve; entered(); }));
  await ready; await assert.rejects(f.reply.send(handle, "second", false, () => true), /正在处理/);
  release(false); await pending; assert.equal(f.state.writes.length, 0); assert.equal(f.reply.active, false);
});

test("navigation during durable reservation prevents dispatch but conservatively preserves dedup intent", async t => {
  const f = await setup(t), handle = await f.open(), save = f.reply.save.bind(f.reply);
  f.reply.save = async entries => { await save(entries); f.reader.close(); };
  await assert.rejects(f.reply.send(handle, "reserved", false, () => true), /会话已失效/);
  assert.equal(f.state.writes.length, 0);
  await assert.rejects(f.service().send(await f.open(), "reserved", false, () => true), /可能已发送/);
});

test("identity change during disk reservation prevents the external reply", async t => {
  const f = await setup(t), handle = await f.open(), save = f.reply.save.bind(f.reply);
  f.reply.save = async entries => { await save(entries); f.state.user = "ou_changed_on_disk"; };
  assert.equal((await f.reply.send(handle, "reserved identity", false, () => true)).state, "unknown");
  assert.equal(f.state.writes.length, 0);
});
