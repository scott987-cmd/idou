import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileReferencesPrompt, normalizeFileReferences, prepareFileReferences } from "../src/application/message-references.js";
import { readWorkspaceFile } from "../src/application/workspace-files.js";

test("file references are bounded identities and gain a send-time revision", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-reference-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.js"), "export const a = 1;\n");
  const normalized = normalizeFileReferences([{ kind: "file", path: "a.js", title: "a.js" }, { kind: "file", path: "a.js" }]);
  assert.equal(normalized.length, 1);
  const [prepared] = await prepareFileReferences(root, normalized);
  assert.match(prepared.revision, /^[a-f0-9]{64}$/);
  assert.match(fileReferencesPrompt([prepared]), /a\.js · revision/);
});

test("file reference validation rejects paths that could escape the task", () => {
  assert.throws(() => normalizeFileReferences([{ kind: "file", path: "../secret" }]), /无效/);
  assert.throws(() => normalizeFileReferences(Array.from({ length: 21 }, (_, index) => ({ kind: "file", path: `${index}.js` }))), /最多/);
});

test("diff feedback is bound to scope, side, line and revision at send time", async () => {
  const revision = "a".repeat(64);
  const normalized = normalizeFileReferences([{ kind: "diff", path: "src/a.js", scope: "turn", turnKey: "turn-1", side: "new", startLine: 21, endLine: 21,
    revision, fileRevision: "missing", comment: "这里要处理空值", excerpt: "new" }]);
  const prepared = await prepareFileReferences("/unused", normalized, { resolveDiff: async () => ({ revision, files: [{ path: "src/a.js", diff: "@@ -10,2 +20,2 @@\n same\n-old\n+new" }] }) });
  assert.equal(prepared[0].comment, "这里要处理空值");
  assert.match(fileReferencesPrompt(prepared), /src\/a\.js · 新侧第 21 行[\s\S]*这里要处理空值/);
  await assert.rejects(prepareFileReferences("/unused", normalized, { resolveDiff: async () => ({ revision: "b".repeat(64), files: [] }) }), /差异已变化/);
  await assert.rejects(prepareFileReferences("/unused", normalized, { resolveDiff: async () => ({ revision, files: [{ path: "src/a.js", currentRevision: "c".repeat(64), diff: "@@ -10 +20 @@\n+new" }] }) }), /当前文件已变化/);
});

test("diff feedback rejects invented paths, lines and arbitrary scopes", () => {
  const base = { kind: "diff", path: "a.js", scope: "working", side: "old", startLine: 1, endLine: 1, revision: "a".repeat(64), comment: "意见" };
  assert.throws(() => normalizeFileReferences([{ ...base, scope: "branch" }]), /差异引用无效/);
  assert.throws(() => normalizeFileReferences([{ ...base, path: "../a.js" }]), /差异引用无效/);
  assert.throws(() => normalizeFileReferences([{ ...base, side: "new", startLine: 0 }]), /差异引用无效/);
});

test("a preview-page reference is bound to one HTML file version", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-page-reference-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(path.join(cwd, "index.html"), "<title>成果一</title><h1>one</h1>");
  const file = await readWorkspaceFile(cwd, "index.html");
  const normalized = normalizeFileReferences([{ kind: "page", path: "index.html", revision: file.revision, title: "成果一", address: "forged" }]);
  assert.deepEqual(normalized[0], { kind: "page", path: "index.html", revision: file.revision, title: "成果一", address: "/index.html" });
  assert.deepEqual(await prepareFileReferences(cwd, normalized), normalized);
  assert.match(fileReferencesPrompt(normalized), /当前预览页面：成果一 · 地址 \/index\.html/);
  await writeFile(path.join(cwd, "index.html"), "<title>成果二</title>");
  await assert.rejects(prepareFileReferences(cwd, normalized), /预览页面已变化/);
  assert.throws(() => normalizeFileReferences([{ kind: "page", path: "run.js", revision: file.revision, title: "脚本" }]), /页面引用无效/);
});

test("only an explicit bounded terminal selection becomes message context", async () => {
  const key = "terminal:11111111-1111-4111-8111-111111111111:1720000000000";
  const normalized = normalizeFileReferences([{ kind: "terminal", key, title: "终端输出 · demo", excerpt: "npm test\n2 tests passed" }]);
  assert.deepEqual(await prepareFileReferences("/unused", normalized), normalized);
  assert.match(fileReferencesPrompt(normalized), /人在本任务终端里显式选中[\s\S]*2 tests passed/);
  assert.throws(() => normalizeFileReferences([{ kind: "terminal", key, title: "终端", excerpt: "x".repeat(8_001) }]), /终端输出引用无效/);
  assert.throws(() => normalizeFileReferences([{ kind: "terminal", key: "forged", title: "终端", excerpt: "secret" }]), /终端输出引用无效/);
});
