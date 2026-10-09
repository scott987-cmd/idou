// A site's link sent to a Feishu group, as the person (docs/sites-phase1.md
// §1.4): the post is exactly the title, the link and their note; the group is
// read again before it goes; the write is bound to that content.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

const LINK = `https://sites.example/s/${encodeURIComponent("销售周报")}/`;
function fixture() {
  const state = { sent: [], calls: [], intents: [],
    group: { chat_id: "oc_sales", name: "销售群", owner_id: "ou_owner", description: "", external: false, chat_status: "normal" },
    info: { name: "销售群", owner_id: "ou_owner", description: "", external: false, tenant_key: "tenant", chat_status: "normal", chat_mode: "group", chat_type: "private", user_count: "12" } };
  // The write intent goes to the sidecar's environment, which grants this one send.
  const provider = new SaasFeishuCliProvider({ binary: STUB_CLI, environment: async (intent) => { if (intent) state.intents.push(intent); return {}; } }, async (_binary, args) => {
    state.calls.push(args);
    const ok = (data) => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }) });
    if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: "ou_sender", tenantKey: "tenant", tokenStatus: "valid" } } }) };
    if (args[0] === "api" && args[2] === "/open-apis/authen/v1/user_info") return ok({ open_id: "ou_sender", tenant_key: "tenant" });
    if (args[0] === "api") return ok(state.info);
    if (args[1] === "+chat-search") return ok({ chats: [state.group], has_more: false });
    if (args[1] === "+chat-members-list") return ok({ chat_id: "oc_sales", users: [{ member_id: "ou_a", name: "甲", tenant_key: "tenant" }], has_more: false });
    assert.equal(args[1], "+messages-send");
    state.sent.push({ args, intent: state.intents.at(-1) });
    return ok({ message_id: "om_site", chat_id: args[args.indexOf("--chat-id") + 1] });
  });
  return { state, provider };
}

test("the post is the title, the link as a link, and the note -- bound to its content", async () => {
  const { state, provider } = fixture();
  const found = await provider.messages.searchGroups("销售");
  const receipt = await provider.messages.sendLink({ identity: found.identity, recipient: found.groups[0], title: "销售周报", url: LINK, note: "本周数据已更新\n请看第二页", idempotencyKey: randomUUID() }, async () => {});
  assert.deepEqual(receipt, { messageId: "om_site", chatId: "oc_sales" });
  const [{ args, intent }] = state.sent;
  const content = JSON.parse(args[args.indexOf("--content") + 1]);
  assert.deepEqual(content, { zh_cn: { content: [[{ tag: "text", text: "销售周报\n" }, { tag: "a", href: LINK, text: LINK }], [{ tag: "text", text: "本周数据已更新\n请看第二页" }]] } });
  assert.deepEqual([intent.action, intent.receiveIdType, intent.receiveId, intent.msgType], ["message.send", "chat_id", "oc_sales", "post"]);
  assert.ok(state.calls.some((call) => call[1] === "+chat-members-list"), "the group was read again before sending");
});

test("nothing goes for a forged group, a link that is not one, or markup in the words", async () => {
  const { state, provider } = fixture();
  const found = await provider.messages.searchGroups("销售");
  const send = (change) => provider.messages.sendLink({ identity: found.identity, recipient: found.groups[0], title: "销售周报", url: LINK, idempotencyKey: randomUUID(), ...change }, async () => {});
  await assert.rejects(send({ recipient: { ...found.groups[0], id: "ou_person" } }), /参数无效/);
  await assert.rejects(send({ recipient: { ...found.groups[0], name: "别的群" } }), /已变化/);
  for (const url of ["javascript:alert(1)", "https://user:pass@sites.example/s/x/", "not a link", "https://sites.example/s/x/ "]) await assert.rejects(send({ url }), /参数无效/, url);
  await assert.rejects(send({ title: "<b>周报</b>" }), /参数无效/);
  await assert.rejects(send({ title: "两\n行" }), /参数无效/);
  state.info.tenant_key = "other";
  await assert.rejects(send({}), /跨租户/);
  assert.equal(state.sent.length, 0);
});
