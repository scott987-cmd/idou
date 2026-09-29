// Synthetic upstream only. Real production main, provider adapters, IPC and persistence.
import "../../src/adopt-legacy-env.js";
import { dialog } from "electron";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { exposeBridge } from "./agent-harness.js";
// `dispatchStates` is what the durable record said at the moment the CLI was
// about to be called -- observed from inside the send rather than reconstructed
// afterwards, which is the only place that ordering is visible.
const f = globalThis.documentDeliveryFixture = { revision: 1, user: "ou_synthetic_sender", sent: [], calls: [], dialogs: [], dispatchStates: [], confirmation: 0,
  users: [
    { open_id: "ou_synthetic_product", localized_name: "陈宁", department: "产品设计部", enterprise_email: "chenning.product@example.test", is_cross_tenant: false, is_activated: true },
    { open_id: "ou_synthetic_engineering", localized_name: "陈宁", department: "研发交付部", enterprise_email: "chenning.engineering@example.test", is_cross_tenant: false, is_activated: true },
  ] };
f.groups = [
  { chat_id: "oc_synthetic_product", name: "本周交付评审", owner_id: "ou_synthetic_owner", description: "产品评审与验收", external: false, chat_status: "normal" },
  { chat_id: "oc_synthetic_engineering", name: "本周交付评审", owner_id: "ou_synthetic_owner", description: "研发排期与联调", external: false, chat_status: "normal" },
];
f.groupUsers = [...f.users.map(user => ({ member_id: user.open_id, name: user.localized_name, tenant_key: "synthetic-tenant" })), { member_id: "ou_synthetic_reviewer", name: "周晓", tenant_key: "synthetic-tenant" }];
const original = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  f.calls.push(args);
  const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }) });
  if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: f.user, tenantKey: "synthetic-tenant", tokenStatus: "valid" } } }) };
  if (args[0] === "docs") {
    assert.equal(args[1], "+fetch");
    return ok({ document: { document_id: "SyntheticDelivery123", revision_id: f.revision, content: `<title>本周交付计划（合成验收）</title><h1>安排与分工</h1><p>文档正文不随链接发送。</p><p>周三进行内部评审，周五提交验收版本。</p><p>版本 ${f.revision} · 所有内容均为合成数据。</p>` } });
  }
  if (args[0] === "contact") {
    assert.equal(args[1], "+search-user");
    return ok({ users: args.includes("--user-ids") ? f.users.filter(user => user.open_id === args[args.indexOf("--user-ids") + 1]) : f.users, has_more: false });
  }
  // The group record is read through the API passthrough, its query as --params:
  // lark-cli 1.0.96 refuses one in the path, and this fixture used to strip it.
  if (args[0] === "api" && args[1] === "GET" && args[2].startsWith("/open-apis/im/v1/chats/")) {
    assert.doesNotMatch(args[2], /[?#]/); assert.deepEqual(args.slice(3, 5), ["--params", JSON.stringify({ user_id_type: "open_id" })]);
    const id = args[2].slice("/open-apis/im/v1/chats/".length);
    const group = f.groups.find(group => group.chat_id === id); assert.ok(group);
    return ok({ ...group, tenant_key: "synthetic-tenant", chat_mode: "group", chat_type: "private", user_count: "3" });
  }
  if (args[0] === "im") {
    if (args[1] === "+chat-search") return ok({ chats: f.groups, has_more: false });
    if (args[1] === "+chat-members-list") return ok({ chat_id: args[args.indexOf("--chat-id") + 1], users: f.groupUsers, has_more: Boolean(f.partialMembers), truncations: [] });
    assert.equal(args[1], "+messages-send"); assert.equal(args[args.indexOf("--as") + 1], "user");
    const directory = path.join(process.env.IDOU_DESKTOP_DATA_DIR, "tasks"), files = (await readdir(directory)).filter(file => file.endsWith(".json"));
    const tasks = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(directory, file), "utf8"))));
    const key = args[args.indexOf("--idempotency-key") + 1], record = tasks.flatMap(task => task.documentDeliveries || []).find(row => row.idempotencyKey === key);
    f.dispatchStates.push(record?.state); assert.equal(record?.state, "dispatching");
    let text, userId, content, chatId = "oc_synthetic_direct";
    if (args.includes("--chat-id")) {
      assert.equal(args.includes("--user-id"), false); assert.equal(args.includes("--text"), false); assert.equal(args[args.indexOf("--msg-type") + 1], "post");
      chatId = args[args.indexOf("--chat-id") + 1]; content = JSON.parse(args[args.indexOf("--content") + 1]);
      const nodes = content.zh_cn.content.flat(); text = nodes.filter(node => node.tag !== "at").map(node => node.text).join("");
      assert.deepEqual(nodes.filter(node => node.tag === "at").map(node => node.user_id), record.mentions.map(user => user.id));
      assert.deepEqual(nodes.filter(node => node.tag === "a"), [{ tag: "a", href: record.sourceUrl, text: record.sourceUrl }]);
      assert.ok(nodes.every(node => ["at", "text", "a"].includes(node.tag))); assert.equal(chatId, record.recipient.id);
    } else { text = args[args.indexOf("--text") + 1]; userId = args[args.indexOf("--user-id") + 1]; assert.equal(userId, record.recipient.id); }
    assert.equal(text, record.text); assert.doesNotMatch(text, /文档正文不随链接发送/);
    const message = { message_id: `om_synthetic_${f.sent.length + 1}`, chat_id: chatId, userId, text, content, key };
    if (f.sendGate) await f.sendGate.promise;
    f.sent.push(message); if (f.lost) throw new Error("synthetic lost acknowledgment"); return ok(message);
  }
  // Only local version/skill metadata falls back to the pinned executable.
  assert.ok(args[0] === "skills" || args[0] === "--version"); return original.call(this, args, options);
};
dialog.showMessageBox = async (_win, options) => {
  f.dialogs.push(options);
  if (f.changeOnConfirm) { f.changeOnConfirm = false; f.revision++; }
  if (f.removeMentionOnConfirm) { f.removeMentionOnConfirm = false; f.groupUsers = f.groupUsers.filter(user => user.member_id !== "ou_synthetic_engineering"); }
  return { response: f.confirmation };
};
await exposeBridge();
await import("../../src/desktop/main.js");
