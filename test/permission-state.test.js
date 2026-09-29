import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PERMISSION,
  executionPermissionForTask,
  isSafeDefaultPermission,
  normalizeDefaultExecutionPermission,
  permitsUnattendedActions,
} from "../src/permissions.js";

test("legacy or unsafe machine defaults never grant plan or full access to a new task", () => {
  for (const value of ["full", "plan", "unknown", "", null, undefined]) {
    assert.equal(normalizeDefaultExecutionPermission(value), DEFAULT_PERMISSION);
  }
  for (const value of ["manual", "standard", "auto"]) {
    assert.equal(normalizeDefaultExecutionPermission(value), value);
    assert.equal(isSafeDefaultPermission(value), true);
  }
  assert.equal(isSafeDefaultPermission("full"), false);
});

test("a planning task reads only its own execution target and legacy records fall back safely", () => {
  assert.equal(executionPermissionForTask({ stage: "planning", permission: "plan", executionPermission: "auto" }), "auto");
  assert.equal(executionPermissionForTask({ stage: "planning", permission: "full" }), "standard");
  assert.equal(executionPermissionForTask({ stage: "building", permission: "full" }), "full");
});

test("only the current task's effective full permission skips document-write cards", () => {
  assert.equal(permitsUnattendedActions({ stage: "building", permission: "full" }), true);
  assert.equal(permitsUnattendedActions({ mode: "cowork", permission: "full" }), true);
  for (const task of [
    { stage: "planning", permission: "plan", executionPermission: "full" },
    { stage: "building", permission: "auto" },
    { stage: "building", permission: "standard" },
    null,
  ]) assert.equal(permitsUnattendedActions(task), false);
});
