import test from "node:test";
import assert from "node:assert/strict";
import { AdminDirectory, ADMIN_LIMITS, adminChat, adminUsers, adminRefusal } from "../src/control-plane/admin-directory.js";

const ONE = "ou_one", TWO = "ou_two", CHAT = "oc_admins";

test("the configuration is read strictly, because a typo here is a lock or a hole", () => {
  assert.deepEqual(adminUsers("ou_a, ou_b , ou_a"), ["ou_a", "ou_b"]);
  assert.deepEqual(adminUsers(""), []);
  assert.throws(() => adminUsers("ou_a, nonsense"), /open_id/);
  assert.equal(adminChat(""), null);
  assert.equal(adminChat(" oc_x "), "oc_x");
  assert.throws(() => adminChat("ou_x"), /群 id/);
});

test("a group is the daily roster and a Feishu change reaches here within the minute", async () => {
  let members = [ONE], reads = 0, clock = 1000;
  const directory = new AdminDirectory({ chatId: CHAT,
    readChatMembers: async (id) => { assert.equal(id, CHAT); reads += 1; return members; },
    now: () => clock });

  assert.deepEqual(await directory.decide({ userId: ONE }), { admin: true, reason: "chat-member" });
  assert.deepEqual(await directory.decide({ userId: TWO }), { admin: false, reason: "not-in-chat" });
  assert.equal(reads, 1, "一分钟之内不该反复去问飞书");

  // Removed in Feishu: still in while the answer is held, out once it is not.
  members = [];
  assert.equal((await directory.decide({ userId: ONE })).admin, true);
  clock += ADMIN_LIMITS.cacheMs + 1;
  assert.equal((await directory.decide({ userId: ONE })).admin, false);
  assert.equal(reads, 2);

  // Two requests arriving together ask Feishu once.
  clock += ADMIN_LIMITS.cacheMs + 1;
  const both = await Promise.all([directory.decide({ userId: ONE }), directory.decide({ userId: TWO })]);
  assert.deepEqual(both.map((one) => one.admin), [false, false]);
  assert.equal(reads, 3);
});

test("an unreadable group makes nobody an administrator, and says which", async () => {
  let clock = 1000, reads = 0;
  const said = [];
  const directory = new AdminDirectory({ chatId: CHAT, log: (message) => said.push(message),
    readChatMembers: async () => { reads += 1; throw new Error("机器人不在这个群里"); }, now: () => clock });
  // Failing open would be a console opened by an upstream being down.
  assert.deepEqual(await directory.decide({ userId: ONE }),
    { admin: false, reason: "directory-unreadable", why: "机器人不在这个群里" });
  assert.match(adminRefusal("directory-unreadable"), /机器人是否还在那个群里/);
  // A refusing Feishu is not asked once per request either.
  await directory.decide({ userId: TWO });
  assert.equal(reads, 1);
  assert.equal(said.length, 1);
  assert.match(said[0], /管理员名单读不到/);
  // …and the escape hatch still works while it is down.
  const withHatch = new AdminDirectory({ users: [TWO], chatId: CHAT,
    readChatMembers: async () => { throw new Error("down"); }, now: () => clock });
  assert.deepEqual(await withHatch.decide({ userId: TWO }), { admin: true, reason: "configured" });
  assert.equal((await withHatch.decide({ userId: ONE })).admin, false);
});

test("a deployment with no administrators says so rather than looking locked down", async () => {
  const none = new AdminDirectory({});
  assert.equal(none.configured, false);
  assert.deepEqual(await none.decide({ userId: ONE }), { admin: false, reason: "no-administrators" });
  assert.match(adminRefusal("no-administrators"), /IDOU_ADMIN_CHAT/);
  assert.deepEqual(await none.decide({ userId: "not-an-id" }), { admin: false, reason: "no-identity" });
  assert.deepEqual(await none.status(), { configured: false, chatId: null, counts: { configured: 0, chat: 0 } });
});

test("the status says how many and from where, never who", async () => {
  const directory = new AdminDirectory({ users: [ONE], chatId: CHAT, readChatMembers: async () => [ONE, TWO] });
  const status = await directory.status();
  assert.deepEqual(status, { configured: true, chatId: CHAT, counts: { configured: 1, chat: 2 } });
  // A page listing every administrator is a page worth stealing.
  assert.equal(JSON.stringify(status).includes(TWO), false);
});
