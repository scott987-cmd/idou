import assert from "node:assert/strict";
import test from "node:test";
import { FeishuDriveKnowledgeStore } from "../src/knowledge/feishu-drive-store.js";

function fakeProvider(calls) {
  return { invoke: async (args) => (calls.push(args), { code: 0, stdout: "{}", stderr: "" }) };
}

test("pushes wiki artifacts without remote deletion", async () => {
  const calls = [];
  const store = new FeishuDriveKnowledgeStore(fakeProvider(calls), {
    folderToken: "fld_1",
    maxBytes: 1_000,
  });
  await store.push(".mydoubao/knowledge/publish");
  assert.deepEqual(calls[0], [
    "drive",
    "+push",
    "--as",
    "user",
    "--folder-token",
    "fld_1",
    "--local-dir",
    ".mydoubao/knowledge/publish",
    "--if-exists",
    "smart",
    "--on-duplicate-remote",
    "fail",
    "--json",
  ]);
  assert.equal(calls[0].includes("--delete-remote"), false);
});

test("enforces the configured Drive budget and reserve", () => {
  const store = new FeishuDriveKnowledgeStore(fakeProvider([]), {
    folderToken: "fld_1",
    maxBytes: 1_000,
    reserveBytes: 100,
  });
  store.assertBudget({ committedBytes: 700, pendingBytes: 200 });
  assert.throws(
    () => store.assertBudget({ committedBytes: 700, pendingBytes: 201 }),
    /exceed the configured Feishu Drive budget/,
  );
});

