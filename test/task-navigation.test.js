import test from "node:test";
import assert from "node:assert/strict";
import { reconcileNavigationOrder, taskNavigation } from "../src/desktop/renderer/task-navigation.js";

const task = (id, mode, cwd, extra = {}) => ({ id, mode, cwd, title: extra.title ?? id, status: extra.status ?? "completed", updatedAt: extra.updatedAt ?? 1, messages: extra.messages ?? [{ role: "user", text: "x" }] });

test("navigation groups coding tasks by project and separates pinned and archived rows", () => {
  const rows = [task("a", "coding", "/one/app"), task("b", "coding", "/two/app"), task("c", "coding", "/one/app")];
  const current = taskNavigation(rows, [{ taskId: "a", pinned: true }, { taskId: "c", archived: true }], { section: "coding", order: ["a", "b", "c"] });
  assert.deepEqual(current.groups.map(group => [group.label, group.tasks.map(row => row.id)]), [["置顶任务", ["a"]], ["app", ["b"]]]);
  const archived = taskNavigation(rows, [{ taskId: "c", archived: true }], { section: "coding", showArchived: true, order: ["c", "a", "b"] });
  assert.deepEqual(archived.groups.flatMap(group => group.tasks.map(row => row.id)), ["c"]);
});

test("search is account-local input over title and project path and is bounded", () => {
  const rows = [task("a", "coding", "/研发/星河", { title: "登录修复" }), task("b", "cowork", "/work", { title: "周报" })];
  assert.deepEqual(taskNavigation(rows, [], { section: "coding", query: "星河" }).groups[0].tasks.map(row => row.id), ["a"]);
  assert.equal(taskNavigation(rows, [], { section: "coding", query: "x".repeat(201) }).query.length, 200);
});

test("streaming snapshots do not reorder rows until a user-visible navigation event", () => {
  const before = [task("a", "coding", "/a", { updatedAt: 10, status: "running" }), task("b", "coding", "/b", { updatedAt: 9 })];
  const token = [{ ...before[1], updatedAt: 20 }, { ...before[0], updatedAt: 21 }];
  assert.deepEqual(reconcileNavigationOrder(["a", "b"], before, token), ["a", "b"]);
  const complete = token.map(row => row.id === "a" ? { ...row, status: "completed", updatedAt: 30 } : row);
  assert.deepEqual(reconcileNavigationOrder(["a", "b"], token, complete), ["a", "b"]);
  const renamed = complete.map(row => row.id === "b" ? { ...row, title: "新标题", updatedAt: 40 } : row);
  assert.deepEqual(reconcileNavigationOrder(["a", "b"], complete, renamed), ["b", "a"]);
});
