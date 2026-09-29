import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { DocumentService } from "../src/application/document-service.js";
import { DocumentDelivery, linkMessage } from "../src/application/document-delivery.js";
import { TaskStore } from "../src/application/task-store.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

const url = "https://test.feishu.cn/docx/SyntheticDelivery123";
const alice = { open_id: "ou_alice", localized_name: "张三", department: "研发", enterprise_email: "alice@example.test", is_cross_tenant: false, is_activated: true };
const bob = { ...alice, open_id: "ou_bob", department: "销售", enterprise_email: "bob@example.test" };
async function fixture() {
  const state = { now: Date.now(), revision: 1, user: "ou_sender", tenant: "tenant", calls: [], sent: [], saved: [], users: [alice, bob], confirmations: [] };
  const task = { id: randomUUID(), schemaVersion: 1, mode: "cowork", cwd: os.tmpdir(), status: "idle", messages: [], activity: [] };
  const provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, async (binary, args) => {
    assert.equal(binary, STUB_CLI); state.calls.push(args);
    assert.equal(args.includes("--yes") || args.includes("--markdown"), false);
    const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: state.envelopeIdentity || "user", data }) });
    if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.user, tenantKey: state.tenant, tokenStatus: "valid" } } }) };
    assert.equal(args[args.indexOf("--as") + 1], "user");
    if (args[0] === "docs") {
      assert.equal(args[1], "+fetch");
      if (state.denied) return { code: 1, stdout: "", stderr: '{"ok":false,"error":{"type":"authorization"}}' };
      return ok({ document: { document_id: "SyntheticDelivery123", revision_id: state.revision, content: `<title>交付计划 &lt;at user_id="all"&gt;</title><p>不可外发的文档正文。版本 ${state.revision}</p>` } });
    }
    if (args[0] === "contact") {
      assert.equal(args[1], "+search-user"); assert.ok(args.includes("--exclude-external-users"));
      if (state.afterContact) await state.afterContact(args);
      return ok({ users: args.includes("--user-ids") ? state.users.filter(user => user.open_id === args[args.indexOf("--user-ids") + 1]) : state.users, has_more: false });
    }
    assert.equal(args[0], "im"); assert.equal(args[1], "+messages-send");
    const record = state.saved.at(-1)?.documentDeliveries?.at(-1);
    assert.equal(record?.state, "dispatching", "durable intent must precede external send");
    const sent = { id: `om_${state.sent.length + 1}`, recipient: args[args.indexOf("--user-id") + 1], text: args[args.indexOf("--text") + 1], key: args[args.indexOf("--idempotency-key") + 1] };
    assert.equal(sent.text, record.text); assert.equal(sent.key, record.idempotencyKey);
    state.sent.push(sent);
    if (state.lost) throw new Error("secret upstream response must not leak");
    return ok(state.malformed ? {} : { message_id: sent.id, chat_id: "oc_direct" });
  });
  const getTask = id => { assert.equal(id, task.id); return task; };
  const documents = new DocumentService({ provider, getTask, now: () => state.now });
  const opened = await documents.open(task.id, url);
  const delivery = new DocumentDelivery({ documents, provider: provider.messages, getTask,
    businessAccess: () => { if (state.blocked) throw new Error("enterprise CLI unlinked"); }, editing: () => state.editing,
    saveTask: async value => { if (state.saveFailed || state.failReceipt && value.documentDeliveries.at(-1).state === "acknowledged") throw new Error("disk failed"); state.saved.push(structuredClone(value)); if (state.afterSave) await state.afterSave(); } });
  const search = () => delivery.search(task.id, documents.opened.get(task.id)?.handle, "张三");
  const prepare = async (index = 1, note = "请帮忙确认。") => { const result = await search(); return delivery.prepare(task.id, documents.opened.get(task.id).handle, result.users[index].handle, note); };
  const send = preview => delivery.send(task.id, preview.id, async draft => { state.confirmations.push(draft); return true; });
  return { state, task, provider, documents, opened, delivery, search, prepare, send };
}
test("specific same-name selection sends the exact preview as the CLI user, after durable intent, without disclosing body or granting ACL", async () => {
  const f = await fixture(), preview = await f.prepare(); assert.equal(f.state.sent.length, 0);
  assert.equal(preview.recipient.id, "ou_bob"); assert.match(preview.text, /＜at/); assert.doesNotMatch(preview.text, /<at|不可外发/);
  preview.text = "forged renderer content"; preview.recipient.id = "ou_alice";
  const result = await f.send(preview);
  assert.equal(result.state, "acknowledged"); assert.equal(f.state.sent.length, 1); assert.equal(f.state.sent[0].recipient, "ou_bob");
  assert.equal(f.state.sent[0].text, f.state.confirmations[0].text); assert.equal(result.messageId, f.state.sent[0].id);
  assert.equal(f.state.saved.at(-1).documentDeliveries[0].state, "acknowledged");
  assert.equal(f.state.calls.some(args => args[0] === "drive" || args.includes("+update")), false);
  await assert.rejects(f.send(preview), /失效/); await assert.rejects(f.prepare(), /已有发送记录/); assert.equal(f.state.sent.length, 1);
});
test("cancel, missing selection and forged recipient handles never send", async () => {
  const f = await fixture(); await f.search();
  await assert.rejects(f.delivery.prepare(f.task.id, f.opened.handle, "ou_bob", ""), /明确选择/);
  const preview = await f.prepare(); assert.equal(await f.delivery.send(f.task.id, preview.id, async () => false), null);
  assert.equal(f.state.sent.length, 0); assert.equal(f.task.documentDeliveries, undefined);
  await f.send(await f.prepare()); assert.equal(f.state.sent.length, 1);
});
test("changed source, sender, tenant, recipient, authorization, TTL and activity reject confirmed drafts before dispatch", async () => {
  for (const change of [f => f.state.revision++, f => { f.state.user = "ou_other"; }, f => { f.state.tenant = "other"; }, f => { f.state.users = [alice, { ...bob, department: "changed" }]; }, f => { f.state.users = [alice, { ...bob, is_cross_tenant: true }]; }, f => { f.state.denied = true; }, f => { f.state.now += 6 * 60_000; }, f => { f.state.blocked = true; }, f => { f.state.editing = true; }, f => { f.task.status = "running"; }, f => f.documents.close(f.task.id)]) {
    const f = await fixture(), preview = await f.prepare(); change(f); await assert.rejects(f.send(preview)); assert.equal(f.state.sent.length, 0);
  }
});
test("source revocation during recipient preflight and navigation during persistence prevent sending", async () => {
  for (const phase of ["contact", "save"]) {
    const f = await fixture(), preview = await f.prepare();
    if (phase === "contact") f.state.afterContact = async () => { f.state.denied = true; };
    else f.state.afterSave = async () => f.documents.close(f.task.id);
    await assert.rejects(f.send(preview)); assert.equal(f.state.sent.length, 0);
    if (phase === "save") assert.equal(f.state.saved.at(-1).documentDeliveries[0].state, "not-sent");
  }
});
test("lost or malformed acknowledgment stays unknown and blocks repeat submission even after service recreation", async () => {
  for (const mode of ["lost", "malformed"]) {
    const f = await fixture(), preview = await f.prepare(); f.state[mode] = true;
    await assert.rejects(f.send(preview), error => /可能已发送/.test(error.message) && !error.message.includes("secret"));
    assert.equal(f.state.sent.length, 1); assert.equal(f.state.saved.at(-1).documentDeliveries[0].state, "unknown");
    const restored = f.state.saved.at(-1), restarted = new DocumentDelivery({ documents: f.documents, provider: f.provider.messages, getTask: () => restored });
    const users = await restarted.search(f.task.id, f.opened.handle, "张三");
    await assert.rejects(restarted.prepare(f.task.id, f.opened.handle, users.users[1].handle, "请帮忙确认。"), /已有发送记录/);
  }
});
test("failed intent persistence sends nothing; failed receipt persistence never retries an accepted message", async () => {
  const first = await fixture(), preview = await first.prepare(); first.state.saveFailed = true;
  await assert.rejects(first.send(preview), /未调用飞书发送/); assert.equal(first.state.sent.length, 0);
  const second = await fixture(), next = await second.prepare(); second.state.failReceipt = true;
  await assert.rejects(second.send(next), /已返回消息回执/); assert.equal(second.state.sent.length, 1);
  assert.equal(second.state.saved.at(-1).documentDeliveries[0].state, "dispatching");
  await assert.rejects(second.prepare(), /已有发送记录/);
});
test("parallel sends and new previews during native confirmation cannot duplicate or replace the confirmed request", async () => {
  const f = await fixture(), preview = await f.prepare(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const running = f.delivery.send(f.task.id, preview.id, async () => { entered.resolve(); return release.promise; });
  await entered.promise; await assert.rejects(f.send(preview), /正在发送/); await assert.rejects(f.prepare(), /上一次发送还没结束/);
  assert.equal(f.delivery.busy(f.task.id), true, "busy while its card waits");
  release.resolve(true); await running; assert.equal(f.state.sent.length, 1);
  assert.equal(f.delivery.busy(f.task.id), false, "and not once it is over");
});
test("canceled searches and canceled native confirmations cannot reuse stale recipients or drafts", async () => {
  const f = await fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.state.afterContact = async () => { entered.resolve(); await release.promise; };
  const searching = f.search(); await entered.promise; f.delivery.discard(f.task.id); release.resolve(); await assert.rejects(searching, /已变化/);
  f.state.afterContact = null; const preview = await f.prepare();
  await assert.rejects(f.delivery.send(f.task.id, preview.id, async () => { f.delivery.discard(f.task.id); return true; }), /取消或失效/);
  assert.equal(f.state.sent.length, 0);
});
test("contact results exclude external and inactive accounts, reject incompatible identity and unsafe message markup", async () => {
  const f = await fixture(); f.state.users = [alice, { ...bob, is_cross_tenant: true }, { ...bob, open_id: "ou_inactive", is_activated: false }];
  const results = await f.search(); assert.deepEqual(results.users.map(user => user.id), ["ou_alice"]); assert.equal(results.excluded, 2);
  f.state.envelopeIdentity = "bot"; await assert.rejects(f.search(), /未确认成功/);
  for (const note of ['<at user_id="all">', "hello\u202eevil", "x".repeat(1001)]) assert.throws(() => linkMessage({ title: "title", sourceUrl: url }, note));
  await assert.rejects(f.provider.messages.search("x".repeat(51)), /1–50/);
});
test("durable task store restores accepted receipt and ambiguous intent without producing external effects", async () => {
  const f = await fixture(), directory = await mkdtemp(path.join(os.tmpdir(), "idou-delivery-store-"));
  try {
    const store = new TaskStore(directory); await store.load();
    f.delivery.saveTask = async task => { await store.save(task); f.state.saved.push(structuredClone(task)); };
    await f.send(await f.prepare());
    const restored = (await new TaskStore(directory).load()).tasks[0];
    assert.equal(restored.documentDeliveries[0].messageId, f.state.sent[0].id); assert.equal(restored.documentDeliveries[0].recipient.id, "ou_bob");
    assert.equal(f.state.sent.length, 1); assert.equal(restored.messages.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("a controlled missing-journal mutation is detected at the external send boundary", async () => {
  const f = await fixture(), preview = await f.prepare(); f.delivery.saveTask = async () => {};
  await assert.rejects(f.send(preview), /可能已发送/);
  assert.equal(f.state.sent.length, 0); // fixture assertion rejects the unsafe side effect before accepting it
});

// Sending moved into the conversation, and the Agent asks from inside its own
// turn -- so its task is running by definition. The wait-for-the-task-to-settle
// check refused every such request with 请等待当前任务和文档修改结束后再发送, and
// sending had no working path at all. Found by a real send to a real group.
test("the Agent can send from inside its own running turn; a person still waits, and an edit in flight blocks both", async () => {
  const f = await fixture();
  f.task.status = "running";
  const handleOf = () => f.documents.opened.get(f.task.id).handle;

  // A person asking while the task runs is still told to wait.
  await assert.rejects(f.delivery.search(f.task.id, handleOf(), "张三"), /请等待当前任务和文档修改结束后再发送/);

  // The Agent's own flow goes through, and still gets the full protection: the
  // same confirmation, and the re-read that happens right before dispatch.
  const found = await f.delivery.search(f.task.id, handleOf(), "张三", "user", { origin: "agent" });
  const preview = await f.delivery.prepare(f.task.id, handleOf(), found.users[1].handle, "请帮忙确认。");
  const record = await f.send(preview);
  assert.equal(f.state.sent.length, 1, "sent exactly once");
  assert.equal(f.state.confirmations.length, 1, "still confirmed by the person");
  assert.equal(record.state, "acknowledged");

  // The origin is fixed by the search that started the flow. A document that
  // changed after preview is still refused before anything leaves.
  const g = await fixture(); g.task.status = "running";
  const again = await g.delivery.search(g.task.id, g.documents.opened.get(g.task.id).handle, "张三", "user", { origin: "agent" });
  const stale = await g.delivery.prepare(g.task.id, g.documents.opened.get(g.task.id).handle, again.users[1].handle, "x");
  g.state.revision++;
  await assert.rejects(g.send(stale)); assert.equal(g.state.sent.length, 0, "a changed document is never sent");

  // An edit still being applied blocks the Agent as well.
  const h = await fixture(); h.task.status = "running"; h.state.editing = true;
  await assert.rejects(h.delivery.search(h.task.id, h.documents.opened.get(h.task.id).handle, "张三", "user", { origin: "agent" }), /请等待/);
});
