import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readWorkspaceFile } from "../src/application/workspace-files.js";
import { prepareTaskContext, contextualPrompt } from "../src/application/task-context.js";

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-context-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "notes.md"), "第一行\n第二行，待修改\n第三行");
  return { cwd, file: await readWorkspaceFile(cwd, "notes.md") };
}

test("context is resolved from actual task files and persisted revision, not renderer text", async (t) => {
  const { cwd, file } = await fixture(t);
  assert.match(file.revision, /^[a-f0-9]{64}$/);
  const context = await prepareTaskContext(cwd, { path: file.path, revision: file.revision, selection: { start: 4, end: 11 }, text: "forged" });
  assert.equal(context.selection.text, "第二行，待修改");
  assert.equal(context.selection.startLine, 2);
  assert.equal(context.selection.endLine, 2);
  assert.equal(context.revision, file.revision);
  assert.match(contextualPrompt("改成已完成", context), /第二行，待修改/);
  assert.doesNotMatch(contextualPrompt("改成已完成", context), /forged/);
  assert.equal(contextualPrompt("不附加文件", null), "不附加文件");
});

test("stale context and out-of-scope paths fail before model execution", async (t) => {
  const { cwd, file } = await fixture(t);
  await writeFile(path.join(cwd, "notes.md"), "外部编辑后的内容");
  await assert.rejects(prepareTaskContext(cwd, { path: file.path, revision: file.revision }), /文件已变化/);
  await assert.rejects(prepareTaskContext(cwd, { path: "../secret", revision: file.revision }), /路径/);
  await assert.rejects(prepareTaskContext(cwd, { path: "notes.md" }), /版本/);
});

test("selection boundaries and token cost are bounded; whole file is not silently attached", async (t) => {
  const { cwd, file } = await fixture(t);
  const base = { path: file.path, revision: file.revision };
  for (const selection of [{ start: -1, end: 2 }, { start: 2, end: 1 }, { start: 0, end: 999 }, { start: 0.5, end: 2 }]) {
    await assert.rejects(prepareTaskContext(cwd, { ...base, selection }), /选区/);
  }
  const context = await prepareTaskContext(cwd, base);
  assert.equal(context.selection, undefined);
  assert.doesNotMatch(contextualPrompt("修改文件", context), /第一行/);
  await writeFile(path.join(cwd, "large.md"), "a".repeat(9000));
  const large = await readWorkspaceFile(cwd, "large.md");
  await assert.rejects(prepareTaskContext(cwd, { path: large.path, revision: large.revision, selection: { start: 0, end: 9000 } }), /8000/);
});

test("Windows line endings use the same selection offsets as the read-only textarea", async (t) => {
  const { cwd } = await fixture(t);
  await writeFile(path.join(cwd, "windows.txt"), "一行\r\n二行\r\n三行");
  const file = await readWorkspaceFile(cwd, "windows.txt");
  assert.equal(file.text, "一行\n二行\n三行");
  const context = await prepareTaskContext(cwd, { path: file.path, revision: file.revision, selection: { start: 3, end: 5 } });
  assert.equal(context.selection.text, "二行"); assert.equal(context.selection.startLine, 2);
});
