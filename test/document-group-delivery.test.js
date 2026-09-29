import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { DocumentService } from "../src/application/document-service.js";
import { DocumentDelivery } from "../src/application/document-delivery.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

const url = "https://test.feishu.cn/docx/SyntheticGroupDoc123";
async function fixture() {
  const state = { calls: [], saved: [], sent: [], revision: 1, user: "ou_sender", tenant: "tenant", partial: false,
    groups: [{ chat_id: "oc_one", name: "评审群", owner_id: "ou_owner", description: "产品评审", external: false, chat_status: "normal" }, { chat_id: "oc_two", name: "评审群", owner_id: "ou_owner", description: "研发评审", external: false, chat_status: "normal" }],
    info: { name: "评审群", owner_id: "ou_owner", description: "研发评审", external: false, tenant_key: "tenant", chat_status: "normal", chat_mode: "group", chat_type: "private", user_count: "3" },
    members: [{ member_id: "ou_alice", name: "陈宁", tenant_key: "tenant" }, { member_id: "ou_bob", name: "陈宁", tenant_key: "tenant" }, { member_id: "ou_carol", name: "李欣", tenant_key: "tenant" }] };
  const task = { id: randomUUID(), status: "idle", messages: [], activity: [] }, getTask = id => { assert.equal(id, task.id); return task; };
  const provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, async (binary, args) => {
    assert.equal(binary, STUB_CLI); state.calls.push(args);
    assert.equal(args.includes("--yes") || args.includes("--markdown") || args.includes("login"), false);
    const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }) });
    if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.user, tenantKey: state.tenant, tokenStatus: "valid" } } }) };
    assert.equal(args[args.indexOf("--as") + 1], "user");
    if (args[0] === "docs") { assert.equal(args[1], "+fetch"); return ok({ document: { document_id: "SyntheticGroupDoc123", revision_id: state.revision, content: `<title>交付计划</title><p>不发送此正文 ${state.revision}</p>` } }); }
    // The group's own record comes from the read-only API passthrough: the pinned
    // CLI has no `im chats` subcommand.
    if (args[0] === "api") {
      assert.equal(args[1], "GET");
      assert.match(args[2], /^\/open-apis\/im\/v1\/chats\/oc_[A-Za-z0-9_-]+$/);
      assert.deepEqual(args.slice(3, 5), ["--params", JSON.stringify({ user_id_type: "open_id" })], "the pinned CLI refuses a query in the path");
      return state.denied ? { code: 1, stdout: "" } : ok(state.info);
    }
    assert.equal(args[0], "im");
    if (args[1] === "+chat-search") { assert.equal(args[args.indexOf("--search-types") + 1], "private,public_joined"); return ok({ chats: state.groups, has_more: false }); }
    if (args[1] === "+chat-members-list") {
      assert.ok(args.includes("--page-all")); assert.equal(args[args.indexOf("--page-limit") + 1], "10"); assert.equal(args[args.indexOf("--member-types") + 1], "user");
      if (state.memberHook) await state.memberHook(args);
      return ok({ chat_id: state.wrongMembers ? "oc_wrong" : args[args.indexOf("--chat-id") + 1], users: state.members, has_more: state.partial, truncations: state.truncations || [] });
    }
    assert.equal(args[1], "+messages-send"); assert.equal(args.includes("--user-id"), false); assert.equal(args[args.indexOf("--msg-type") + 1], "post");
    const record = state.saved.at(-1).documentDeliveries.at(-1); assert.equal(record.state, "dispatching");
    const content = JSON.parse(args[args.indexOf("--content") + 1]), nodes = content.zh_cn.content.flat();
    assert.deepEqual(nodes.filter(node => node.tag === "at").map(node => node.user_id), record.mentions.map(user => user.id));
    assert.equal(nodes.filter(node => node.tag !== "at").map(node => node.text).join(""), record.text);
    assert.deepEqual(nodes.filter(node => node.tag === "a"), [{ tag: "a", href: record.sourceUrl, text: record.sourceUrl }]);
    assert.ok(nodes.every(node => ["at", "text", "a"].includes(node.tag))); assert.doesNotMatch(record.text, /不发送此正文/);
    state.sent.push({ chatId: args[args.indexOf("--chat-id") + 1], content, key: args[args.indexOf("--idempotency-key") + 1] });
    if (state.lost) throw new Error("protected remote response");
    return ok({ message_id: "om_sent", chat_id: state.wrongReceipt ? "oc_wrong" : state.sent.at(-1).chatId });
  });
  const documents = new DocumentService({ provider, getTask }), opened = await documents.open(task.id, url);
  const delivery = new DocumentDelivery({ documents, provider: provider.messages, getTask, saveTask: async task => { state.saved.push(structuredClone(task)); }, businessAccess: () => { if (state.blocked) throw new Error("CLI unlinked"); } });
  const search = () => delivery.search(task.id, opened.handle, "评审", "group");
  const prepare = async (indices = [1, 2]) => {
    const groups = await search(), group = groups.groups[1], members = await delivery.members(task.id, opened.handle, group.handle);
    return delivery.prepare(task.id, opened.handle, group.handle, "请核对排期。", indices.map(index => members.members[index].handle));
  };
  const send = preview => delivery.send(task.id, preview.id, async confirmed => { state.confirmed = confirmed; return true; });
  return { state, task, provider, documents, opened, delivery, getTask, search, prepare, send };
}
test("group delivery binds selected chat and explicit members to static at nodes and persisted preview, without @all or permissions", async () => {
  const f = await fixture(), preview = await f.prepare(); assert.equal(f.state.sent.length, 0);
  assert.equal(preview.recipient.id, "oc_two"); assert.deepEqual(preview.mentions.map(user => user.id), ["ou_bob", "ou_carol"]);
  preview.recipient.id = "oc_forged"; preview.mentions[0].id = "all";
  const result = await f.send(preview); assert.equal(result.state, "acknowledged"); assert.equal(result.chatId, "oc_two");
  assert.equal(f.state.sent.length, 1); assert.equal(f.state.sent[0].chatId, "oc_two");
  assert.deepEqual(f.state.sent[0].content.zh_cn.content[0], [{ tag: "at", user_id: "ou_bob" }, { tag: "at", user_id: "ou_carol" }]);
  assert.deepEqual(f.state.confirmed.mentions.map(user => user.id), ["ou_bob", "ou_carol"]);
  assert.equal(f.state.calls.some(args => args[0] === "drive" || args[1] === "+update"), false);
  await assert.rejects(f.send(preview), /失效/); await assert.rejects(f.prepare([2, 1]), /已有发送记录/);
});
test("group-only send contains no mention nodes; cancel sends nothing", async () => {
  const f = await fixture(), canceled = await f.prepare([]);
  assert.equal(await f.delivery.send(f.task.id, canceled.id, async () => false), null); assert.equal(f.state.sent.length, 0);
  await f.send(await f.prepare([])); assert.equal(f.state.sent[0].content.zh_cn.content.flat().filter(node => node.tag === "at").length, 0);
});
test("group hyperlink cannot differ from the canonical document URL shown in the confirmed preview", async () => {
  const f = await fixture(), preview = await f.prepare();
  for (const sourceUrl of ["https://evil.example/docx/Injected", "https://test.feishu.cn/docx/Different", "javascript:alert(1)"]) {
    await assert.rejects(f.provider.messages.send({ ...preview, identity: f.documents.opened.get(f.task.id).document.identity, sourceUrl, idempotencyKey: randomUUID() }, async () => assert.fail("must not persist a forged link")));
  }
  assert.equal(f.state.sent.length, 0);
});
test("group rename, owner, type, mode, count, tenant, external status, permission, sender and mention changes deny preflight", async () => {
  for (const change of [f => { f.state.info.name = "另一个群"; }, f => { f.state.info.owner_id = "ou_other"; }, f => { f.state.info.chat_type = "public"; }, f => { f.state.info.chat_mode = "p2p"; }, f => { f.state.info.user_count = "4"; }, f => { f.state.info.tenant_key = "other"; }, f => { f.state.info.external = true; }, f => { f.state.info.chat_status = "dissolved"; }, f => { f.state.denied = true; }, f => { f.state.user = "ou_other"; }, f => { f.state.members = f.state.members.filter(user => user.member_id !== "ou_bob"); }, f => { f.state.members[1].name = "新名字"; }, f => { f.state.members[1].tenant_key = "external"; }, f => { f.state.wrongMembers = true; }]) {
    const f = await fixture(), preview = await f.prepare(); change(f); await assert.rejects(f.send(preview)); assert.equal(f.state.sent.length, 0);
  }
});
test("incomplete member lists remain labelled partial, and only positively returned same-tenant members can be selected", async () => {
  const f = await fixture(); f.state.partial = true; f.state.truncations = [{ member_type: "user", limit: 100 }];
  f.state.members.push({ member_id: "ou_outsider", name: "外部", tenant_key: "other" }, { member_id: "all", name: "所有人", tenant_key: "tenant" });
  const group = (await f.search()).groups[1], result = await f.delivery.members(f.task.id, f.opened.handle, group.handle);
  assert.equal(result.partial, true); assert.equal(result.excluded, 2); assert.equal(result.members.length, 3);
  await assert.rejects(f.delivery.prepare(f.task.id, f.opened.handle, group.handle, "", ["ou_outsider"]), /不是本次/);
  const preview = await f.delivery.prepare(f.task.id, f.opened.handle, group.handle, "", [result.members[1].handle]);
  await f.send(preview); assert.equal(f.state.sent.length, 1);
});
test("member handles are bound to the selected group and cannot be reused, duplicated or replaced by arbitrary IDs", async () => {
  const f = await fixture(), groups = (await f.search()).groups;
  await assert.rejects(f.delivery.prepare(f.task.id, f.opened.handle, groups[1].handle, "", []), /先读取/);
  const one = await f.delivery.members(f.task.id, f.opened.handle, groups[0].handle);
  await f.delivery.members(f.task.id, f.opened.handle, groups[1].handle);
  for (const handles of [[one.members[0].handle], ["all"], ["ou_bob"], Array(11).fill("fake")]) await assert.rejects(f.delivery.prepare(f.task.id, f.opened.handle, groups[1].handle, "", handles));
  assert.equal(f.state.sent.length, 0);
});
test("late group-member reads cannot replace a newer group selection", async () => {
  const f = await fixture(), groups = (await f.search()).groups, entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.state.memberHook = async args => { if (args.includes("oc_one")) { entered.resolve(); await release.promise; } };
  const first = f.delivery.members(f.task.id, f.opened.handle, groups[0].handle); await entered.promise;
  const second = await f.delivery.members(f.task.id, f.opened.handle, groups[1].handle); release.resolve(); await assert.rejects(first, /群选择已变化/);
  const preview = await f.delivery.prepare(f.task.id, f.opened.handle, groups[1].handle, "", [second.members[0].handle]);
  await f.send(preview); assert.equal(f.state.sent[0].chatId, "oc_two");
});
test("lost acknowledgment and wrong-chat receipts stay unknown and block duplicate group mentions after restoration", async () => {
  for (const mode of ["lost", "wrongReceipt"]) {
    const f = await fixture(), preview = await f.prepare(); f.state[mode] = true;
    await assert.rejects(f.send(preview), /可能已发送/); assert.equal(f.state.sent.length, 1);
    const restored = f.state.saved.at(-1); assert.equal(restored.documentDeliveries[0].state, "unknown");
    const restarted = new DocumentDelivery({ documents: f.documents, provider: f.provider.messages, getTask: () => restored });
    const groups = await restarted.search(f.task.id, f.opened.handle, "评审", "group"), group = groups.groups[1];
    const members = await restarted.members(f.task.id, f.opened.handle, group.handle);
    await assert.rejects(restarted.prepare(f.task.id, f.opened.handle, group.handle, "请核对排期。", [members.members[2].handle, members.members[1].handle]), /已有发送记录/);
  }
});
test("group search filters external/dissolved results and group member operations obey enterprise linkage gate", async () => {
  const f = await fixture(); f.state.groups.push({ ...f.state.groups[0], chat_id: "oc_external", external: true }, { ...f.state.groups[0], chat_id: "oc_gone", chat_status: "dissolved" });
  const result = await f.search(); assert.equal(result.groups.length, 2); assert.equal(result.excluded, 2);
  f.state.blocked = true; await assert.rejects(f.delivery.members(f.task.id, f.opened.handle, result.groups[0].handle), /unlinked/);
  await assert.rejects(f.search(), /unlinked/); assert.equal(f.state.sent.length, 0);
});
test("an isolated cached-membership mutation is detected by the zero-send invariant for a removed member", async () => {
  const f = await fixture(), preview = await f.prepare();
  const cached = await f.provider.messages.groupMembers(preview.recipient, f.documents.opened.get(f.task.id).document.identity);
  f.state.members = f.state.members.filter(user => user.member_id !== "ou_bob");
  f.provider.messages.groupMembers = async () => cached; // deliberately unsafe, only this instance
  await f.send(preview);
  assert.throws(() => assert.equal(f.state.sent.length, 0), assert.AssertionError);
});
