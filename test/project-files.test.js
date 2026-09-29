import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { diffReviewLines, listProjectFiles, matchFiles, projectDiff, reviewTargets, splitDiff, taskProjectDiff } from "../src/application/project-files.js";

async function folder(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-project-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).toString();

test("@ offers a repository's own files, tracked or new, and nothing it ignores", async (t) => {
  const cwd = await folder(t);
  git(cwd, "init", "-q");
  await mkdir(path.join(cwd, "src")); await mkdir(path.join(cwd, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(cwd, ".gitignore"), "node_modules\n*.log\n");
  await writeFile(path.join(cwd, "src", "page.js"), "export const page = 1;\n");
  await writeFile(path.join(cwd, "node_modules", "left-pad", "index.js"), "x");
  await writeFile(path.join(cwd, "debug.log"), "x");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "init");
  await writeFile(path.join(cwd, "src", "pager.test.js"), "test\n");
  assert.deepEqual((await listProjectFiles(cwd)).sort(), [".gitignore", "src/page.js", "src/pager.test.js"]);
});

test("a folder that is not a repository is walked, past its dependencies and build output", async (t) => {
  const cwd = await folder(t);
  await mkdir(path.join(cwd, "lib")); await mkdir(path.join(cwd, "node_modules")); await mkdir(path.join(cwd, "dist")); await mkdir(path.join(cwd, ".hidden"));
  await writeFile(path.join(cwd, "lib", "a.py"), ""); await writeFile(path.join(cwd, "node_modules", "b.js"), "");
  await writeFile(path.join(cwd, "dist", "c.js"), ""); await writeFile(path.join(cwd, ".hidden", "d"), ""); await writeFile(path.join(cwd, "README.md"), "");
  assert.deepEqual((await listProjectFiles(cwd)).sort(), ["README.md", "lib/a.py"]);
});

test("what was typed after @ finds the likeliest file first", () => {
  const files = ["src/components/Pager.jsx", "src/page.js", "test/page.test.js", "docs/paging.md", "README.md"];
  assert.deepEqual(matchFiles(files, "page"), ["src/page.js", "test/page.test.js", "src/components/Pager.jsx"], "a name that starts with it, shortest first, then one that contains it");
  assert.deepEqual(matchFiles(files, "docs/"), ["docs/paging.md"], "a path matches too");
  assert.equal(matchFiles(files, "").length, 5);
  assert.deepEqual(matchFiles(files, "zzz"), []);
});

test("the working tree's changes, file by file, as git would show them", async (t) => {
  const cwd = await folder(t);
  git(cwd, "init", "-q");
  await writeFile(path.join(cwd, "a.js"), "one\ntwo\n"); await writeFile(path.join(cwd, "gone.js"), "bye\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "init");
  await writeFile(path.join(cwd, "a.js"), "one\n2\nthree\n");
  await rm(path.join(cwd, "gone.js"));
  await writeFile(path.join(cwd, "new.js"), "hello\nworld\n");
  const changed = await projectDiff(cwd, { readText: (file) => readFile(path.join(cwd, file), "utf8") });
  assert.equal(changed.repository, true);
  assert.equal(changed.scope, "working");
  assert.match(changed.basis, /^HEAD [0-9a-f]{40}$/);
  assert.match(changed.revision, /^[0-9a-f]{64}$/);
  assert.deepEqual(changed.files.map((file) => [file.path, file.status, file.added, file.removed]),
    [["a.js", "modified", 2, 1], ["gone.js", "deleted", 0, 1], ["new.js", "added", 2, 0]]);
  assert.match(changed.files[0].diff, /^@@ .* @@\n one\n-two\n\+2\n\+three$/);
  assert.equal(changed.files[2].untracked, true);
  assert.deepEqual(await projectDiff(await folder(t)), { repository: false, scope: "working", basis: null, revision: null, files: [] }, "nothing to compare against outside a repository");
});

test("a stored turn diff stays bound to that turn after later and manual changes", async (t) => {
  const cwd = await folder(t);
  git(cwd, "init", "-q");
  await writeFile(path.join(cwd, "a.js"), "one\n"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "init");
  const first = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-one\n+first\n";
  const task = { cwd, messages: [{ id: "turn-one", role: "user", seq: 1, turn: { codexTurnId: "codex-1", diffText: first } }], activity: [] };
  await writeFile(path.join(cwd, "a.js"), "manual later\n");
  const historical = await taskProjectDiff(task, { scope: "turn", turnKey: "turn-one" });
  const working = await taskProjectDiff(task, { scope: "working" }, { readText: (file) => readFile(path.join(cwd, file), "utf8") });
  assert.equal(historical.scope, "turn");
  assert.match(historical.basis, /codex-1/);
  assert.match(historical.files[0].diff, /\+first/);
  assert.doesNotMatch(historical.files[0].diff, /manual later/);
  assert.match(working.files[0].diff, /\+manual later/);
  assert.notEqual(historical.revision, working.revision);
});

test("an old turn exposes recorded fragments but never calls them a complete net diff", async () => {
  const task = { cwd: "/tmp/project", messages: [{ id: "old", role: "user", seq: 1, turn: { diff: { files: 1, added: 1, removed: 1 } } }], activity: [
    { id: "patch", seq: 2, type: "fileChange", status: "completed", changes: [{ path: "a.js", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }] },
  ] };
  const result = await taskProjectDiff(task, { scope: "turn", turnKey: "old" });
  assert.match(result.unavailableReason, /没有完整.*片段/);
  assert.equal(result.files[0].partial, true);
  assert.match(result.files[0].diff, /\+new/);
});

test("diff review lines preserve old and new line identities", () => {
  const rows = diffReviewLines("@@ -10,2 +20,3 @@ name\n same\n-old\n+new\n+more");
  assert.deepEqual(rows.map(({ kind, oldLine, newLine, side, line }) => [kind, oldLine, newLine, side, line]), [
    ["hunk", null, null, null, null], ["context", 10, 20, "new", 20], ["remove", 11, null, "old", 11], ["add", null, 21, "new", 21], ["add", null, 22, "new", 22],
  ]);
});

test("a repository with no commit yet compares against nothing", async (t) => {
  const cwd = await folder(t);
  git(cwd, "init", "-q");
  await writeFile(path.join(cwd, "a.js"), "x\n");
  git(cwd, "add", "a.js");
  const changed = await projectDiff(cwd, { readText: () => "" });
  assert.deepEqual(changed.files.map((file) => [file.path, file.status, file.added]), [["a.js", "added", 1]]);
});

test("untracked binary, oversized and unreadable files remain honest review rows", async (t) => {
  const cwd = await folder(t); git(cwd, "init", "-q");
  await writeFile(path.join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(cwd, "large.txt"), "x".repeat(200 * 1024 + 1));
  await writeFile(path.join(cwd, "gone.txt"), "gone");
  const result = await projectDiff(cwd, { readText: async (file) => {
    if (file === "gone.txt") throw new Error("vanished");
    return readFile(path.join(cwd, file));
  } });
  const by = Object.fromEntries(result.files.map((file) => [file.path, file]));
  assert.equal(by["binary.bin"].binary, true);
  assert.equal(by["large.txt"].tooLarge, true);
  assert.equal(by["gone.txt"].readError, true);
  assert.equal(by["gone.txt"].added, 0, "a failed read must not be presented as one blank added line");
});

test("a diff is split per file, headers left out", () => {
  const [one, two] = splitDiff("diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y b/y\nnew file mode 100644\n--- /dev/null\n+++ b/y\n@@ -0,0 +1 @@\n+c\n");
  assert.deepEqual([one.path, one.status, one.diff, one.added, one.removed], ["x", "modified", "@@ -1 +1 @@\n-a\n+b", 1, 1]);
  assert.deepEqual([two.path, two.status, two.added], ["y", "added", 1]);
});

test("what /review can be pointed at: the other branches and the latest commits, read from git", async (t) => {
  const cwd = await folder(t);
  assert.deepEqual(await reviewTargets(cwd), { repository: false, branch: null, branches: [], commits: [] });
  git(cwd, "init", "-q", "-b", "main");
  assert.deepEqual(await reviewTargets(cwd), { repository: true, branch: "main", branches: [], commits: [] }, "no commit yet: nothing to list, not an error");
  await writeFile(path.join(cwd, "a.js"), "1\n"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "first\tone");
  git(cwd, "checkout", "-q", "-b", "feature");
  await writeFile(path.join(cwd, "a.js"), "2\n"); git(cwd, "commit", "-qam", "second");
  const targets = await reviewTargets(cwd);
  assert.equal(targets.branch, "feature");
  assert.deepEqual(targets.branches, ["main"], "the branch it is on is not something to compare against");
  assert.deepEqual(targets.commits.map((commit) => commit.title), ["second", "first\tone"]);
  assert.ok(targets.commits.every((commit) => /^[0-9a-f]{40}$/.test(commit.sha)));
});
