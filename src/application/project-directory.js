import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../providers/process-runner.js";
import { HOST_GIT_FLAGS, hostGit } from "./host-git.js";

// A coding task is a directory on this machine, and the directory's own name is
// the project's name — there is no second name that could drift out of step
// with it. Choosing or creating the folder is the operating system's file
// dialog; the only thing left for the application is the repository, because
// the Agent cannot do it: Codex's sandbox refuses writes under `.git` unless
// this process names that path, so an Agent asked to run `git init` can only
// fail or ask to escalate.

export async function isGitRepository(cwd) {
  try { return (await stat(path.join(cwd, ".git"))).isDirectory(); } catch { return false; }
}

// `git init` on a directory that is already inside a repository would quietly
// create a nested one, so the caller is told instead of being surprised later.
export async function initGitRepository(cwd, { git = hostGit() } = {}) {
  if (await isGitRepository(cwd)) return { created: false, reason: "already" };
  const inside = await runProcess(git, [...HOST_GIT_FLAGS, "rev-parse", "--show-toplevel"], { cwd, maxOutputBytes: 4096 }).catch(() => null);
  if (inside?.code === 0 && inside.stdout.trim()) return { created: false, reason: "nested", parent: inside.stdout.trim() };
  // A missing `git` rejects rather than exiting non-zero, and either way the
  // person needs the same sentence: it did not happen, and here is why.
  const init = await runProcess(git, [...HOST_GIT_FLAGS, "init", "-q"], { cwd, maxOutputBytes: 8192 })
    .catch((error) => ({ code: 1, stderr: error?.code === "ENOENT" ? `找不到 git 命令（${git}）` : error.message, stdout: "" }));
  if (init.code !== 0) throw new Error(`初始化 Git 仓库失败：${(init.stderr || init.stdout).trim().slice(0, 200) || "未知错误"}`);
  return { created: true, reason: "created" };
}

// Shown next to the chosen directory so the state of the project is visible
// before the first message, rather than discovered when a commit fails.
export async function describeProjectDirectory(cwd) {
  const repository = await isGitRepository(cwd);
  let entries = 0, empty = false;
  try { const names = await readdir(cwd); entries = names.length; empty = names.every((name) => name === ".DS_Store"); }
  catch { /* unreadable is reported by the picker itself */ }
  return { path: cwd, name: path.basename(cwd), repository, entries, empty };
}
