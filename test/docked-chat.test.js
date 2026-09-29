import assert from "node:assert/strict";
import test from "node:test";
import { DockedChat, NAME_FRESH_MS } from "../src/desktop/docked-chat.js";
import { UNBOUND_CHAT, chatContext } from "../src/desktop/feishu-chat-context.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const VERIFIED = { state: "verified" }, UNVERIFIED = { state: "unverified" }, CHECKING = { state: "checking" }, CONFLICT = { state: "conflict" };
const id = (tail) => `oc_${String(tail).padStart(16, "0")}`;

// A chat list served in pages of `per`, a store that records what was saved, and
// a clock the test moves.
function harness({ chats = [], per = 30, stored = null, failList = false } = {}) {
  let clock = 1_000_000;
  const calls = [], saved = [];
  const docked = new DockedChat({
    now: () => clock, isChat: SAAS_FEISHU.ids.chat,
    listChats: async (token, identity) => {
      calls.push({ token, identity });
      if (failList) throw new Error("飞书暂时不可用");
      const start = token ? Number(token) : 0;
      return { chats: chats.slice(start, start + per), next: start + per < chats.length ? String(start + per) : null, identity: "principal-a" };
    },
    load: async () => stored,
    save: async (value) => { saved.push(structuredClone(value)); stored = value; },
  });
  return { docked, calls, saved, at: () => clock, advance: (ms) => { clock += ms; } };
}

test("one chat by the page's name is a candidate: its conversation, but no chat id for the Agent", async () => {
  const { docked, at } = harness({ chats: [{ id: id(1), name: "项目组" }, { id: id(2), name: "周会" }] });
  const state = await docked.state({ name: "项目组", at: at(), identity: VERIFIED });
  assert.equal(state.binding, "candidate");
  assert.equal(state.key, id(1), "the conversation shown is this chat's");
  assert.equal(state.remembers, true);
  const said = chatContext({ name: state.name, binding: state.binding, id: state.chat.id }, null, { isChat: SAAS_FEISHU.ids.chat });
  assert.doesNotMatch(said, /oc_/, "the Agent is not handed the chat");
  assert.match(said, /先请用户在侧边栏确认/);
});

test("a confirmation made while the web pages are verified is remembered, and used only while they still are", async () => {
  const { docked, saved, at } = harness({ chats: [{ id: id(1), name: "项目组" }] });
  const bound = await docked.confirm({ name: "项目组", at: at(), identity: VERIFIED, chatId: id(1) });
  assert.equal(bound.binding, "bound");
  assert.equal(bound.by, "confirmed");
  assert.match(chatContext({ name: bound.name, binding: bound.binding, id: bound.chat.id }, null, { isChat: SAAS_FEISHU.ids.chat }), new RegExp(`chat_id ${id(1)}`));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].version, 1);
  assert.deepEqual(Object.keys(saved[0].chats), [id(1)]);

  // The web pages sign in again: until they are verified again the remembered
  // confirmation does not apply.
  docked.reset();
  for (const identity of [UNVERIFIED, CHECKING]) {
    const state = await docked.state({ name: "项目组", at: at(), identity });
    assert.equal(state.binding, "candidate", identity.state);
    assert.equal(state.remembers, false);
  }
  assert.equal((await docked.state({ name: "项目组", at: at(), identity: VERIFIED })).binding, "bound");
});

// Acceptance: web signed in as B while the application is A.
test("web pages signed in as someone else match nothing, and a pick is kept for this page only", async () => {
  const { docked, saved, at } = harness({ chats: [{ id: id(1), name: "项目组" }, { id: id(2), name: "周会" }] });
  const state = await docked.state({ name: "项目组", at: at(), identity: CONFLICT });
  assert.equal(state.binding, "unbound");
  assert.equal(state.reason, "web_conflict");
  assert.equal(state.key, UNBOUND_CHAT);
  assert.match(chatContext({ name: state.name, binding: state.binding, reason: state.reason }), /不是当前账号/);

  const picked = await docked.confirm({ name: "项目组", at: at(), identity: CONFLICT, chatId: id(2) });
  assert.equal(picked.binding, "bound");
  assert.equal(picked.by, "picked");
  assert.equal(picked.chat.id, id(2), "the person may pick any chat of their own");
  assert.equal(saved.length, 0, "and nothing is remembered");
  docked.reset();
  assert.equal((await docked.state({ name: "项目组", at: at(), identity: CONFLICT })).binding, "unbound", "a change to the web session drops it");
});

// Acceptance: the same name, different ids.
test("two chats with the page's name are ambiguous, and a pick between them is never remembered", async () => {
  const { docked, saved, at } = harness({ chats: [{ id: id(1), name: "项目组", mode: "group" }, { id: id(2), name: "项目组", mode: "p2p" }] });
  const state = await docked.state({ name: "项目组", at: at(), identity: VERIFIED });
  assert.equal(state.binding, "ambiguous");
  assert.deepEqual(state.options.map((option) => option.id), [id(1), id(2)]);
  assert.equal(state.key, UNBOUND_CHAT);
  const picked = await docked.confirm({ name: "项目组", at: at(), identity: VERIFIED, chatId: id(2) });
  assert.equal(picked.by, "picked");
  assert.equal(saved.length, 0, "a name that fits two chats cannot be remembered as meaning one");
});

test("a duplicate further down the list still makes a name ambiguous", async () => {
  const chats = Array.from({ length: 75 }, (_, index) => ({ id: id(index + 1), name: `会话${index + 1}` }));
  chats[70] = { id: id(71), name: "会话1" };
  const { docked, calls, at } = harness({ chats });
  const state = await docked.state({ name: "会话1", at: at(), identity: VERIFIED });
  assert.equal(state.binding, "ambiguous");
  assert.equal(calls.length, 3, "three pages were read");
  assert.equal(calls[1].identity, "principal-a", "later pages are read as the same identity");
});

test("more chats than are read makes a match incomplete, and says so", async () => {
  const chats = Array.from({ length: 95 }, (_, index) => ({ id: id(index + 1), name: `会话${index + 1}` }));
  const { docked, at } = harness({ chats });
  const state = await docked.state({ name: "会话1", at: at(), identity: VERIFIED });
  assert.equal(state.binding, "candidate");
  assert.equal(state.complete, false);
});

// Acceptance: an expired page event.
test("a name the page stopped reporting is no name at all", async () => {
  const { docked, at, advance } = harness({ chats: [{ id: id(1), name: "项目组" }] });
  const reported = at();
  advance(NAME_FRESH_MS + 1);
  const state = await docked.state({ name: "项目组", at: reported, identity: VERIFIED });
  assert.equal(state.binding, "none");
  assert.equal(state.key, UNBOUND_CHAT);
  await assert.rejects(docked.confirm({ name: "项目组", at: reported, identity: VERIFIED, chatId: id(1) }), /没有打开会话/);
  for (const at of [undefined, null, Number.NaN]) assert.equal((await docked.state({ name: "项目组", at, identity: VERIFIED })).binding, "none");
});

test("only a chat this account's list returned can be confirmed", async () => {
  const { docked, at } = harness({ chats: [{ id: id(1), name: "项目组" }] });
  await assert.rejects(docked.confirm({ name: "项目组", at: at(), identity: VERIFIED, chatId: id(9) }), /从会话列表里选择/);
  await assert.rejects(docked.confirm({ name: "项目组", at: at(), identity: VERIFIED, chatId: "ou_1234567890abcdef" }), /从会话列表里选择/);
});

test("a web session that changes while a confirmation is being checked voids it", async () => {
  const { docked, at } = harness({ chats: [{ id: id(1), name: "项目组" }] });
  const original = docked.listChats;
  docked.listChats = async (...args) => { docked.reset(); return original(...args); };
  await assert.rejects(docked.confirm({ name: "项目组", at: at(), identity: VERIFIED, chatId: id(1) }), /重新确认/);
});

test("a renamed chat has to be confirmed again", async () => {
  const chats = [{ id: id(1), name: "项目组" }];
  const { docked, at } = harness({ chats });
  await docked.confirm({ name: "项目组", at: at(), identity: VERIFIED, chatId: id(1) });
  chats[0] = { id: id(1), name: "项目组（新）" };
  docked.reset();
  const state = await docked.state({ name: "项目组（新）", at: at(), identity: VERIFIED });
  assert.equal(state.binding, "candidate");
});

test("\"not this one\" drops the remembered confirmation", async () => {
  const { docked, saved, at } = harness({ chats: [{ id: id(1), name: "项目组" }] });
  await docked.confirm({ name: "项目组", at: at(), identity: VERIFIED, chatId: id(1) });
  const state = await docked.forget({ name: "项目组", at: at(), identity: VERIFIED });
  assert.equal(state.binding, "candidate");
  assert.deepEqual(saved.at(-1).chats, {});
});

test("an unreadable chat list leaves the page unbound rather than guessing", async () => {
  const { docked, at } = harness({ failList: true });
  const state = await docked.state({ name: "项目组", at: at(), identity: VERIFIED });
  assert.equal(state.binding, "unbound");
  assert.equal(state.reason, "list_unavailable");
  assert.equal(chatContext({ name: state.name, binding: state.binding, reason: state.reason }), "（当前打开的飞书会话：项目组）");
});

test("a stored file of another shape is ignored, not trusted", async () => {
  for (const stored of [{ version: 2, chats: { [id(1)]: { name: "项目组", at: 1 } } }, { version: 1, chats: { "not-an-id": { name: "项目组", at: 1 } } }, { version: 1, chats: { [id(1)]: { name: "", at: 1 } } }, "junk"]) {
    const { docked, at } = harness({ chats: [{ id: id(1), name: "项目组" }], stored });
    assert.equal((await docked.state({ name: "项目组", at: at(), identity: VERIFIED })).binding, "candidate", JSON.stringify(stored));
  }
  const { docked, at } = harness({ chats: [{ id: id(1), name: "项目组" }], stored: { version: 1, chats: { [id(1)]: { name: "项目组", at: 5 } } } });
  assert.equal((await docked.state({ name: "项目组", at: at(), identity: VERIFIED })).binding, "bound", "a well-formed one is used");
});

test("the list is read once for several questions, and again after a reset", async () => {
  const { docked, calls, at } = harness({ chats: [{ id: id(1), name: "项目组" }] });
  await Promise.all([docked.state({ name: "项目组", at: at(), identity: VERIFIED }), docked.state({ name: "项目组", at: at(), identity: VERIFIED }), docked.options()]);
  assert.equal(calls.length, 1);
  docked.reset();
  await docked.state({ name: "项目组", at: at(), identity: VERIFIED });
  assert.equal(calls.length, 2);
});
