import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, access, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { takeCheckpoint, checkpointChanges, releaseCheckpoint, restoreCheckpoint } from "../src/application/checkpoints.js";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString();
const exists = (file) => access(file).then(() => true, () => false);
async function repository(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-checkpoint-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, "init", "-q");
  await writeFile(path.join(cwd, ".gitignore"), "*.log\n");
  await writeFile(path.join(cwd, "a.js"), "one\n"); await writeFile(path.join(cwd, "b.js"), "keep me\n");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "init");
  return cwd;
}

test("taking a turn back puts the files back, and touches nothing of the person's own", async (t) => {
  const cwd = await repository(t);
  await writeFile(path.join(cwd, "draft.js"), "not committed yet\n"); // new before the turn: part of the snapshot
  await writeFile(path.join(cwd, "a.js"), "one, staged by the person\n"); git(cwd, "add", "a.js");
  const refs = git(cwd, "for-each-ref", "refs/heads", "refs/tags"), head = git(cwd, "rev-parse", "HEAD"), staged = git(cwd, "diff", "--cached");
  const checkpoint = await takeCheckpoint(cwd);
  assert.match(checkpoint, /^git:[0-9a-f-]{36}:[0-9a-f]{40,64}$/);
  assert.match(git(cwd, "for-each-ref", "refs/idou/checkpoints"), /refs\/idou\/checkpoints\//, "an application ref keeps it alive");
  assert.equal(git(cwd, "for-each-ref", "refs/heads", "refs/tags"), refs, "the person's refs are unchanged");
  assert.equal(git(cwd, "diff", "--cached"), staged, "and the person's index is as it was");

  // The turn: changes a file, deletes one, adds one, and touches an ignored file.
  await writeFile(path.join(cwd, "a.js"), "changed by the Agent\n");
  await rm(path.join(cwd, "b.js"));
  await mkdir(path.join(cwd, "lib")); await writeFile(path.join(cwd, "lib", "new.js"), "made by the Agent\n");
  await writeFile(path.join(cwd, "run.log"), "ignored\n");

  assert.deepEqual((await checkpointChanges(cwd, checkpoint)).map((change) => [change.path, change.action]).sort(),
    [["a.js", "restore"], ["b.js", "restore"], ["lib/new.js", "remove"]], "what going back would change, said before it is done");
  await restoreCheckpoint(cwd, checkpoint);
  assert.equal(await readFile(path.join(cwd, "a.js"), "utf8"), "one, staged by the person\n");
  assert.equal(await readFile(path.join(cwd, "b.js"), "utf8"), "keep me\n");
  assert.equal(await readFile(path.join(cwd, "draft.js"), "utf8"), "not committed yet\n");
  assert.equal(await exists(path.join(cwd, "lib", "new.js")), false);
  assert.equal(await readFile(path.join(cwd, "run.log"), "utf8"), "ignored\n", "an ignored file is not the checkpoint's to change");
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "diff", "--cached"), staged, "the person's staged change survives the restore");
  assert.equal(git(cwd, "for-each-ref", "refs/heads", "refs/tags"), refs);
});

test("a repository checkpoint survives immediate GC without changing the user's HEAD, branch or index", async (t) => {
  const cwd = await repository(t);
  await writeFile(path.join(cwd, "a.js"), "staged before checkpoint\n");
  git(cwd, "add", "a.js");
  const head = git(cwd, "rev-parse", "HEAD"), branch = git(cwd, "symbolic-ref", "HEAD"), staged = git(cwd, "diff", "--cached");
  const checkpoint = await takeCheckpoint(cwd);
  await writeFile(path.join(cwd, "a.js"), "changed after checkpoint\n");

  // This is deliberately destructive and is allowed only because `repository`
  // always creates an isolated mkdtemp fixture removed with this test.
  git(cwd, "gc", "--prune=now");
  assert.deepEqual((await checkpointChanges(cwd, checkpoint)).map((change) => [change.path, change.action]), [["a.js", "restore"]]);
  await restoreCheckpoint(cwd, checkpoint);
  assert.equal(await readFile(path.join(cwd, "a.js"), "utf8"), "staged before checkpoint\n");
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "symbolic-ref", "HEAD"), branch);
  assert.equal(git(cwd, "diff", "--cached"), staged);
  assert.equal(await releaseCheckpoint(cwd, checkpoint), true);
  assert.equal(git(cwd, "for-each-ref", "refs/mydoubao/checkpoints"), "");
  assert.equal(git(cwd, "for-each-ref", "refs/idou/checkpoints"), "");
});

// A checkpoint is kept by a ref named with the product's name, and the product
// was renamed: one made under either spelling is released, and nothing else is.
test("a checkpoint is released under whichever spelling of the product's name kept it", async (t) => {
  const cwd = await repository(t);
  for (const name of ["idou", "mydoubao"]) {
    const checkpoint = await takeCheckpoint(cwd);
    const [, id, commit] = checkpoint.split(":");
    const made = git(cwd, "for-each-ref", "--format=%(refname)", "refs/").split("\n").filter((ref) => ref.endsWith(`/checkpoints/${id}`));
    assert.equal(made.length, 1);
    if (!made[0].startsWith(`refs/${name}/`)) { git(cwd, "update-ref", `refs/${name}/checkpoints/${id}`, commit); git(cwd, "update-ref", "-d", made[0]); }
    // A ref of the other spelling holding some other commit is not this checkpoint's.
    const other = name === "idou" ? "mydoubao" : "idou";
    git(cwd, "update-ref", `refs/${other}/checkpoints/${id}`, git(cwd, "rev-parse", "HEAD").trim());
    assert.equal(await releaseCheckpoint(cwd, checkpoint), true, name);
    assert.equal(git(cwd, "for-each-ref", `refs/${name}/checkpoints`), "", `the ${name} ref is gone`);
    assert.match(git(cwd, "for-each-ref", `refs/${other}/checkpoints`), new RegExp(id), "the other one is left alone");
    git(cwd, "update-ref", "-d", `refs/${other}/checkpoints/${id}`);
    assert.equal(await releaseCheckpoint(cwd, checkpoint), false, "and there is nothing more to release");
  }
});

test("only the task's folder is put back, not the rest of the repository it sits in", async (t) => {
  const root = await repository(t);
  await mkdir(path.join(root, "pkg")); await writeFile(path.join(root, "pkg", "x.js"), "x\n");
  git(root, "add", "."); git(root, "commit", "-qm", "pkg");
  const cwd = path.join(root, "pkg");
  await writeFile(path.join(root, "a.js"), "uncommitted, outside the folder\n");
  const checkpoint = await takeCheckpoint(cwd);
  assert.equal(git(root, "show", `${checkpoint.split(":").at(-1)}:a.js`), "one\n", "the snapshot holds the folder's files; outside it, what was committed");
  await writeFile(path.join(cwd, "x.js"), "changed\n");
  await writeFile(path.join(root, "a.js"), "changed outside the folder\n");
  assert.deepEqual((await checkpointChanges(cwd, checkpoint)).map((change) => change.path), ["x.js"]);
  await restoreCheckpoint(cwd, checkpoint);
  assert.equal(await readFile(path.join(cwd, "x.js"), "utf8"), "x\n");
  assert.equal(await readFile(path.join(root, "a.js"), "utf8"), "changed outside the folder\n");
});

test("a repository with no commit yet, and a folder that is not one", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "idou-checkpoint-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  assert.equal(await takeCheckpoint(cwd), null, "no repository: no checkpoint, and nothing written");
  assert.deepEqual(execFileSync("ls", ["-A", cwd]).toString(), "");
  git(cwd, "init", "-q");
  await writeFile(path.join(cwd, "first.js"), "1\n");
  const checkpoint = await takeCheckpoint(cwd);
  await writeFile(path.join(cwd, "first.js"), "2\n"); await writeFile(path.join(cwd, "second.js"), "2\n");
  await restoreCheckpoint(cwd, checkpoint);
  assert.equal(await readFile(path.join(cwd, "first.js"), "utf8"), "1\n");
  assert.equal(await exists(path.join(cwd, "second.js")), false);
  await assert.rejects(checkpointChanges(cwd, "not-a-hash"), /无效/);
  // A repository's snapshot, once the repository is gone, is not looked for elsewhere.
  await rm(path.join(cwd, ".git"), { recursive: true, force: true });
  const shadowRoot = await mkdtemp(path.join(os.tmpdir(), "idou-checkpoint-shadow-"));
  t.after(() => rm(shadowRoot, { recursive: true, force: true }));
  await assert.rejects(checkpointChanges(cwd, checkpoint, { shadowRoot }), /已经不是 Git 仓库/);
});

async function folder(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a folder in no repository is put back from one kept elsewhere, and nothing is written into it", async (t) => {
  const cwd = await folder(t, "idou-checkpoint-plain-"), shadowRoot = await folder(t, "idou-checkpoint-shadow-");
  await writeFile(path.join(cwd, "a.js"), "one\n");
  await mkdir(path.join(cwd, "node_modules", "dep"), { recursive: true }); await writeFile(path.join(cwd, "node_modules", "dep", "index.js"), "dep\n");
  await writeFile(path.join(cwd, ".env"), "SECRET=1\n");
  const checkpoint = await takeCheckpoint(cwd, { shadowRoot });
  assert.match(checkpoint, /^shadow:[0-9a-f-]{36}:[0-9a-f]{40,64}$/);
  assert.deepEqual((await readdir(cwd)).sort(), [".env", "a.js", "node_modules"], "no .git, nothing at all, written into the folder");
  // The turn changes a file, adds one, and touches a secret and a dependency.
  await writeFile(path.join(cwd, "a.js"), "two\n"); await writeFile(path.join(cwd, "b.js"), "new\n");
  await writeFile(path.join(cwd, ".env"), "SECRET=2\n"); await writeFile(path.join(cwd, "node_modules", "dep", "index.js"), "changed\n");
  assert.deepEqual((await checkpointChanges(cwd, checkpoint, { shadowRoot })).map((change) => [change.path, change.action]).sort(), [["a.js", "restore"], ["b.js", "remove"]]);
  await restoreCheckpoint(cwd, checkpoint, { shadowRoot });
  assert.equal(await readFile(path.join(cwd, "a.js"), "utf8"), "one\n");
  assert.equal(await exists(path.join(cwd, "b.js")), false);
  assert.equal(await readFile(path.join(cwd, ".env"), "utf8"), "SECRET=2\n", "a secret was never copied, so it is not put back either");
  assert.equal(await readFile(path.join(cwd, "node_modules", "dep", "index.js"), "utf8"), "changed\n", "nor is a dependency folder");
  // Once the folder is a repository of its own, the snapshot is still read from where it was kept.
  git(cwd, "init", "-q"); git(cwd, "add", "a.js"); git(cwd, "commit", "-qm", "a repository now");
  await writeFile(path.join(cwd, "a.js"), "three\n");
  await restoreCheckpoint(cwd, checkpoint, { shadowRoot });
  assert.equal(await readFile(path.join(cwd, "a.js"), "utf8"), "one\n");
  await assert.rejects(checkpointChanges(cwd, checkpoint), /无效/, "without where it was kept, it is not guessed at");
});

test("a folder too big to be a project is not copied at all", async (t) => {
  const cwd = await folder(t, "idou-checkpoint-big-"), shadowRoot = await folder(t, "idou-checkpoint-shadow-");
  await Promise.all(Array.from({ length: 2001 }, (_, index) => writeFile(path.join(cwd, `f${index}.txt`), "x")));
  assert.equal(await takeCheckpoint(cwd, { shadowRoot }), null);
  const [kept] = await readdir(shadowRoot);
  assert.equal(git(cwd, "--git-dir", path.join(shadowRoot, kept), "count-objects").trim(), "0 objects, 0 kilobytes", "nothing of it was copied");
});
