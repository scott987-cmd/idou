import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { unreadFromTitle, watchFeishuUnread, unreadReporter } from "../src/desktop/feishu-unread.js";

// Every title here was measured from the real client: "消息 - 飞书 (9)" while nine
// are unread, "消息 - 飞书" once they are read, and both in one boot as it synced.
test("the unread count comes from the title, and a number inside a name is not one", () => {
  assert.deepEqual(unreadFromTitle("消息 - 飞书 (9)"), { count: 9, label: "9" });
  assert.deepEqual(unreadFromTitle("消息 - 飞书 (10)"), { count: 10, label: "10" });
  assert.deepEqual(unreadFromTitle("消息 - 飞书"), { count: 0, label: "" }, "nothing unread, nothing to show");
  assert.deepEqual(unreadFromTitle("(99+) 消息 - 飞书"), { count: 99, label: "99+" }, "kept as Feishu writes it");
  assert.deepEqual(unreadFromTitle("消息 - 飞书 （3）"), { count: 3, label: "3" }, "full-width brackets too");
  assert.deepEqual(unreadFromTitle("产品评审 (2026) - 飞书"), { count: 0, label: "" }, "a year in a chat's name is not a count");
  assert.deepEqual(unreadFromTitle("消息 - 飞书 (0)"), { count: 0, label: "" });
  for (const value of [undefined, null, "", "   ", "飞书", "(x) 飞书"]) assert.deepEqual(unreadFromTitle(value), { count: 0, label: "" });
});

// A fake view whose title the test moves, and fake timers so the settling wait is
// a step in the test rather than a delay.
function view(title) {
  const contents = new EventEmitter();
  contents.getTitle = () => title;
  let waiting = null;
  const timers = { schedule: (fn) => { waiting = fn; return 1; }, cancel: () => { waiting = null; } };
  return {
    contents, timers,
    set: (value) => { title = value; contents.emit("page-title-updated", {}, value); },
    load: () => contents.emit("did-finish-load"),
    settle: () => { const fire = waiting; waiting = null; fire?.(); },
    waiting: () => waiting !== null,
  };
}

test("a view reports the count it already has, then only what changes", () => {
  const page = view("消息 - 飞书 (2)");
  const seen = [];
  const stop = watchFeishuUnread(page.contents, (value) => seen.push(value.label), page.timers);
  page.set("消息 - 飞书 (2)");
  page.set("消息 - 飞书 (5)");
  page.load();
  stop();
  page.set("消息 - 飞书 (7)");
  assert.deepEqual(seen, ["2", "5"], "the first look, then each change, and nothing after it is stopped");
  assert.equal(page.contents.listenerCount("page-title-updated"), 0);
});

// Measured on the real client, twice: the count vanishes from the title for a
// moment mid-sync and comes back larger. Taken at face value the badge blinks.
test("a count that vanishes for a moment while the client syncs does not blink the badge", () => {
  const page = view("消息 - 飞书 (9)");
  const seen = [];
  watchFeishuUnread(page.contents, (value) => seen.push(value.label), page.timers);
  page.set("消息 - 飞书");
  assert.deepEqual(seen, ["9"], "an unconfirmed zero is not passed on");
  assert.equal(page.waiting(), true);
  page.set("消息 - 飞书 (10)");
  assert.deepEqual(seen, ["9", "10"], "and a message arriving is passed on at once");
  assert.equal(page.waiting(), false, "the wait was called off");
});

test("a count that really is gone clears once it holds", () => {
  const page = view("消息 - 飞书 (4)");
  const seen = [];
  watchFeishuUnread(page.contents, (value) => seen.push(value.label), page.timers);
  page.set("消息 - 飞书");
  page.settle();
  assert.deepEqual(seen, ["4", ""], "read everywhere else, and the tab follows");
});

test("a view whose contents are gone reports nothing unread rather than throwing", () => {
  const contents = new EventEmitter(); contents.getTitle = () => { throw new Error("Object has been destroyed"); };
  const seen = [];
  watchFeishuUnread(contents, (value) => seen.push(value));
  assert.deepEqual(seen, [{ count: 0, label: "" }]);
});

test("the count reaches the sidebar and the Dock, and clearing it reaches both", () => {
  const sent = [], badges = [];
  const unread = unreadReporter({ send: (value) => sent.push(value), badge: (count) => badges.push(count) });
  assert.deepEqual(unread.current(), { count: 0, label: "" }, "before any view exists there is nothing to show");
  unread.report({ count: 9, label: "9" });
  assert.deepEqual(unread.current(), { count: 9, label: "9" }, "a renderer that starts late can ask");
  unread.clear();
  assert.deepEqual(sent, [{ count: 9, label: "9" }, { count: 0, label: "" }]);
  assert.deepEqual(badges, [9, 0], "signing out or quitting must not leave a number on the Dock");
});
