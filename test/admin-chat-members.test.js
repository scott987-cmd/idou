import test from "node:test";
import assert from "node:assert/strict";
import { chatMemberReader } from "../src/control-plane/admin-chat-members.js";

const feishu = { openApi: { origin: "https://open.feishu.cn" } };
const bot = { token: async () => "t-token" };
const answer = (payload) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });

test("it asks for members and nothing else, as the bot, and follows pages", async () => {
  const asked = [];
  const read = chatMemberReader({ bot, feishu, fetch: async (url, options) => {
    asked.push({ url, auth: options.headers.authorization });
    return asked.length === 1
      ? answer({ code: 0, data: { items: [{ member_id: "ou_a" }, { member_id: "ou_b" }], has_more: true, page_token: "p2" } })
      : answer({ code: 0, data: { items: [{ member_id: "ou_c" }], has_more: false } });
  } });
  assert.deepEqual(await read("oc_admins"), ["ou_a", "ou_b", "ou_c"]);
  assert.equal(asked.length, 2);
  assert.match(asked[0].url, /\/open-apis\/im\/v1\/chats\/oc_admins\/members\?member_id_type=open_id/);
  assert.match(asked[1].url, /page_token=p2/);
  assert.equal(asked[0].auth, "Bearer t-token");
  // Members, not profiles: nothing here asks Feishu about a person.
  assert.equal(asked.some(({ url }) => /contact|user_profiles|department/.test(url)), false);
});

test("the two failures worth telling apart are told apart", async () => {
  // Both would otherwise read as "this group is empty", which is
  // indistinguishable from nobody being an administrator.
  const missingScope = chatMemberReader({ bot, feishu, fetch: async () => answer({ code: 99991672, msg: "no permission" }) });
  await assert.rejects(() => missingScope("oc_x"), /没有读取群成员的权限/);
  const notMember = chatMemberReader({ bot, feishu, fetch: async () => answer({ code: 230002, msg: "bot not in chat" }) });
  await assert.rejects(() => notMember("oc_x"), /不在这个群里/);
  // Anything else is reported as it came: a friendlier cause hides a real one.
  const other = chatMemberReader({ bot, feishu, fetch: async () => answer({ code: 1234, msg: "something else" }) });
  await assert.rejects(() => other("oc_x"), /code=1234 something else/);
  const garbage = chatMemberReader({ bot, feishu, fetch: async () => new Response("<html>") });
  await assert.rejects(() => garbage("oc_x"), /无法解析/);
});

test("a group too big to be an administrator list is refused, not truncated", async () => {
  const read = chatMemberReader({ bot, feishu, pages: 2,
    fetch: async () => answer({ code: 0, data: { items: [{ member_id: "ou_a" }], has_more: true, page_token: "next" } }) });
  await assert.rejects(() => read("oc_everyone"), /不像是管理员群/);
});
