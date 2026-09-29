// Git the application runs outside the Agent's sandbox, in a repository the
// Agent can write to (src/application/host-git.js). Found 2026-09-27: a hook,
// an fsmonitor command or a filter planted in the task's `.git` ran as the
// person, outside every sandbox, at the next checkpoint. These use real git on
// real repositories; every planted command, if it ran, leaves a file behind.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreCheckpoint, takeCheckpoint } from "../src/application/checkpoints.js";
import { projectDiff } from "../src/application/project-files.js";
import { hostGit, repositoryCommands, trustedPath } from "../src/application/host-git.js";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...process.env, ...IDENTITY }, stdio: ["ignore", "pipe", "pipe"] }).toString();

// A committed repository, and somewhere its planted commands would leave a
// mark: `ran()` lists what did run.
async function repository(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-host-git-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), marks = path.join(root, "marks"), shadow = path.join(root, "shadow");
  await mkdir(repo); await mkdir(marks);
  git(repo, "init", "-q");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "first");
  const command = async (name) => {
    const script = path.join(root, `${name}.sh`);
    await writeFile(script, `#!/bin/sh\ntouch "${path.join(marks, name)}"\ncat\n`); await chmod(script, 0o755);
    return script;
  };
  return { repo, shadow, command, ran: async () => (await readdir(marks)).sort() };
}

test("a checkpoint runs no hook and no fsmonitor the repository asks for", async (t) => {
  const f = await repository(t);
  for (const hook of ["reference-transaction", "post-index-change", "pre-commit"]) {
    await writeFile(path.join(f.repo, ".git", "hooks", hook), `#!/bin/sh\ntouch "${path.join(path.dirname(f.shadow), "marks", hook)}"\n`);
    await chmod(path.join(f.repo, ".git", "hooks", hook), 0o755);
  }
  git(f.repo, "config", "core.fsmonitor", await f.command("fsmonitor"));
  await writeFile(path.join(f.repo, "a.txt"), "two\n");
  const checkpoint = await takeCheckpoint(f.repo, { shadowRoot: f.shadow });
  assert.match(checkpoint, /^git:/, "taken in the repository itself");
  assert.deepEqual(await f.ran(), [], "and nothing the repository asked for ran");
});

test("a repository that defines its own filter is snapshotted in the shadow repository, and not restored into", async (t) => {
  const f = await repository(t);
  await writeFile(path.join(f.repo, "a.txt"), "two\n");
  const before = await takeCheckpoint(f.repo, { shadowRoot: f.shadow });
  assert.match(before, /^git:/);
  // As an Agent would plant it: a filter from a file the configuration includes.
  const extra = path.join(path.dirname(f.repo), "extra.config");
  await writeFile(extra, `[filter "evil"]\n\tclean = ${await f.command("clean")}\n\tsmudge = ${await f.command("smudge")}\n`);
  git(f.repo, "config", "include.path", extra);
  await writeFile(path.join(f.repo, ".gitattributes"), "* filter=evil\n");
  assert.deepEqual(await repositoryCommands(f.repo), ["filter.evil.clean", "filter.evil.smudge"]);
  const after = await takeCheckpoint(f.repo, { shadowRoot: f.shadow });
  assert.match(after, /^shadow:/, "snapshotted in the application's own shadow repository");
  await assert.rejects(restoreCheckpoint(f.repo, before, { shadowRoot: f.shadow }), /会执行命令的设置（filter\.evil\.clean/);
  assert.deepEqual(await f.ran(), [], "no filter ran on the way");
});

test("the changes view runs no textconv, and says why it shows nothing for a repository with its own filter", async (t) => {
  const f = await repository(t);
  git(f.repo, "config", "diff.x.textconv", await f.command("textconv"));
  await writeFile(path.join(f.repo, ".gitattributes"), "*.txt diff=x\n");
  await writeFile(path.join(f.repo, "a.txt"), "two\n");
  const diff = await projectDiff(f.repo);
  assert.equal(diff.files.length, 0, "a repository with a diff driver of its own is not diffed");
  assert.match(diff.unavailableReason, /diff\.x\.textconv/);
  git(f.repo, "config", "--unset", "diff.x.textconv");
  const plain = await projectDiff(f.repo);
  assert.equal(plain.files.find((file) => file.path === "a.txt")?.status, "modified", "one without is, as before");
  assert.deepEqual(await f.ran(), []);
});

test("git is never taken from a directory the sandbox can write", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-host-path-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writable = path.join(root, "home", ".yarn"), planted = path.join(writable, "bin"), trusted = path.join(root, "usr", "bin");
  for (const directory of [planted, trusted]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "git"), "#!/bin/sh\n"); await chmod(path.join(directory, "git"), 0o755);
  }
  const pathValue = [planted, trusted].join(path.delimiter);
  assert.equal(trustedPath(pathValue, [writable]), trusted);
  assert.equal(hostGit({ pathValue, writable: [writable] }), path.join(trusted, "git"), "the planted one first on PATH is passed over");
  assert.equal(hostGit({ pathValue: planted, writable: [writable] }), "/usr/bin/git", "and with nothing else, the system's own");
});
