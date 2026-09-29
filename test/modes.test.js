import assert from "node:assert/strict";
import test from "node:test";
import { getMode, listModes, getPermission, listPermissions, DEFAULT_PERMISSION } from "../src/modes.js";

test("exposes exactly the coding and cowork modes", () => {
  assert.deepEqual(listModes().map((mode) => mode.id), ["coding", "cowork"]);
});

test("cowork mode routes Feishu work through version-aligned skills", () => {
  const mode = getMode("cowork");
  assert.match(mode.developerInstructions, /lark-cli skills list/);
  assert.match(mode.developerInstructions, /lark-cli skills read/);
});

test("rejects an unknown mode", () => {
  assert.throws(() => getMode("chat"), /unknown mode/);
});


test("每个权限模式都落到运行时真正执行的沙箱与审批策略上", () => {
  assert.deepEqual(listPermissions().map(({ id, sandbox, approvalPolicy }) => [id, sandbox, approvalPolicy]), [
    ["plan", "read-only", "never"],
    ["manual", "read-only", "untrusted"],
    ["standard", "workspace-write", "on-request"],
    ["auto", "workspace-write", "never"],
    ["full", "danger-full-access", "never"],
  ]);
});

test("只有明确选择的完全访问模式才没有沙箱，且它绝不是缺省", () => {
  const unsandboxed = listPermissions().filter(({ sandbox }) => sandbox === "danger-full-access");
  assert.deepEqual(unsandboxed.map(({ id }) => id), ["full"]);
  assert.notEqual(DEFAULT_PERMISSION, "full");
  // 说明里必须写清代价，选择它的人不应当是被界面顺手带过去的。
  assert.match(getPermission("full").summary, /整台电脑/);
});

// Since the security review of 2026-09-27, 标准 -- the default -- has no network
// for commands either: only 自动, which the person picks to run unattended.
test("联网只开给自动模式，标准和只读模式的命令都没有网络", () => {
  for (const id of ["plan", "manual", "standard"]) assert.notEqual(getPermission(id).network, true, id);
  assert.equal(getPermission("auto").network, true);
});

test("只读的两个模式必须真的进只读沙箱，自动模式不得越出工作目录", () => {
  // The names promise something; these are the two facts that keep the promise.
  for (const id of ["plan", "manual"]) assert.equal(getPermission(id).sandbox, "read-only");
  assert.equal(getPermission("auto").sandbox, "workspace-write");
  assert.notEqual(getPermission("auto").sandbox, "danger-full-access");
});

test("缺省是标准模式，未知模式被拒绝", () => {
  assert.equal(getPermission(undefined).id, DEFAULT_PERMISSION);
  assert.equal(DEFAULT_PERMISSION, "standard");
  assert.throws(() => getPermission("god"), /unknown permission/);
});
