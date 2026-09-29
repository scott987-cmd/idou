import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TaskUiStore } from "../src/application/task-ui-store.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const cipher = {
  available: () => true,
  encrypt: text => Buffer.from(text, "utf8").map(byte => byte ^ 0xa5),
  decrypt: bytes => Buffer.from(bytes).map(byte => byte ^ 0xa5).toString("utf8"),
};

async function opened(t, name = "account-a") {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-task-ui-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  return { root, store: await TaskUiStore.open(path.join(root, `${name}.enc`), cipher) };
}

test("task UI state is encrypted, revisioned and isolated by account file", async t => {
  const { root, store } = await opened(t);
  const saved = await store.save(A, {
    draft: { text: "账号 A 的草稿", references: [{ kind: "file", key: "src/a.js", title: "a.js" }, { kind: "selection", key: "workspace:src/a.js", resourceKind: "workspace-file", resourceKey: "workspace:src/a.js", path: "src/a.js", revision: "r1", state: "current", selection: { start: 2, end: 8, text: "secret" } },
      { kind: "diff", key: "diff:working:a.js:new:2", path: "a.js", scope: "working", side: "new", startLine: 2, endLine: 2, revision: "a".repeat(64), comment: "保留这个意见", excerpt: "+new", state: "current" },
      { kind: "page", key: "page:index.html:r2", path: "index.html", revision: "r2", title: "成果页", address: "/index.html", state: "current" },
      { kind: "terminal", key: `terminal:${A}:1720000000000`, title: "终端输出 · demo", excerpt: "x".repeat(2_000) }], imageIds: [] },
    panel: { kind: "files", relativePath: "src/a.js", resourceRevision: "rev-1", width: 480, collapsed: false,
      selection: { start: 2, end: 8, startLine: 1, endLine: 2, text: "secret" } },
    scroll: { messageKey: "m-1", offset: 12, followLatest: false }, expanded: { "turn:a": true },
  }, 0);
  assert.equal(saved.revision, 1);
  assert.equal((await store.get(A)).draft.text, "账号 A 的草稿");
  assert.deepEqual((await store.get(A)).draft.references[1].selection, { start: 2, end: 8, text: "secret" });
  assert.deepEqual((await store.get(A)).draft.references[2], { kind: "diff", key: "diff:working:a.js:new:2", path: "a.js", revision: "a".repeat(64), state: "current", scope: "working", side: "new", startLine: 2, endLine: 2, comment: "保留这个意见", excerpt: "+new" });
  assert.deepEqual((await store.get(A)).draft.references[3], { kind: "page", key: "page:index.html:r2", path: "index.html", revision: "r2", title: "成果页", address: "/index.html", state: "current" });
  assert.equal((await store.get(A)).draft.references[4].excerpt.length, 2_000);
  assert.deepEqual((await store.get(A)).panel.selection, { start: 2, end: 8, startLine: 1, endLine: 2, text: "secret" });
  assert.doesNotMatch(await readFile(path.join(root, "account-a.enc"), "utf8"), /账号 A 的草稿/);

  const other = await TaskUiStore.open(path.join(root, "account-b.enc"), cipher);
  assert.equal((await other.get(A)).draft.text, "");
  await assert.rejects(store.save(A, { draft: { text: "旧窗口", references: [], imageIds: [] } }, 0), /其他窗口.*更新/);
});

test("task UI metadata supports pin/archive without deleting task state", async t => {
  const { store } = await opened(t);
  await store.save(A, { draft: { text: "保留", references: [], imageIds: [] } }, 0);
  await store.setMetadata(A, { pinned: true });
  await store.setMetadata(B, { archived: true });
  await store.save("draft:coding", { draft: { text: "未发送", references: [], imageIds: [] } }, 0);
  assert.deepEqual(await store.metadata(), [
    { taskId: A, pinned: true, archived: false },
    { taskId: B, pinned: false, archived: true },
  ]);
  assert.equal((await store.get(A)).draft.text, "保留");
  await store.remove(A);
  assert.equal((await store.get(A)).draft.text, "");
});

test("media is a durable workbench panel kind", async t => {
  const { store } = await opened(t);
  const saved = await store.save(A, { draft: {}, panel: { kind: "media", collapsed: false }, scroll: {}, expanded: {} }, 0);
  assert.equal(saved.panel.kind, "media");
  assert.equal((await store.get(A)).panel.kind, "media");
});

test("an unavailable keychain keeps the in-memory draft and never writes plaintext", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-task-ui-locked-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const store = await TaskUiStore.open(path.join(root, "state.enc"), { ...cipher, available: () => false });
  await assert.rejects(store.save(A, { draft: { text: "只在内存", references: [], imageIds: [] } }, 0), /草稿尚未保存.*安全加密/);
  assert.equal((await store.get(A)).draft.text, "只在内存");
  await assert.rejects(readFile(path.join(root, "state.enc")), { code: "ENOENT" });
});
