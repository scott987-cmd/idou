import { statSync } from "node:fs";
import path from "node:path";
import { runProcess } from "../providers/process-runner.js";
import { toolCacheRoots } from "./sandbox-roots.js";

// Git that the application runs itself -- outside the Agent's sandbox -- in a
// folder the Agent can write to: checkpoints before each turn, the changes
// view, a new repository. The task's own `.git` is writable from the sandbox
// (sandbox-roots.js, so the Agent can commit), and until 2026-09-27 these ran
// with whatever that `.git` asked for: a hook planted there, an fsmonitor
// command or a clean filter ran as the person, outside every sandbox, at the
// next checkpoint. Measured on this machine: a filter a repository includes
// from another file runs on a plain `git add`; a reference-transaction hook
// runs on a plain `git update-ref`.
//
//   - Hooks and fsmonitor are switched off on every call. Configuration given
//     on the command line outranks the repository's own.
//   - A clean or smudge filter, a textconv or external diff driver cannot be
//     switched off that way -- the repository names its own drivers -- so a
//     repository that defines one in its own configuration (or a file that
//     includes) is not worked in by anything that would run it: checkpoints go
//     to the application's own shadow repository, and a restore or a diff
//     against the working tree is declined with the reason.
//   - `git` itself is looked for on a PATH with every directory the sandbox can
//     write taken out, so one planted in ~/.yarn/bin is not the one run.
export const HOST_GIT_FLAGS = Object.freeze(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"]);

// Keys in a repository's own configuration that make git run a command, which
// the flags above cannot switch off.
const RUNS_A_COMMAND = [/^filter\.[^=]+\.(clean|smudge|process)=/i, /^diff\.external=/i, /^diff\.[^=]+\.(command|textconv)=/i, /^merge\.[^=]+\.driver=/i];

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// PATH without the directories the sandbox can write, or anything under them.
export function trustedPath(value = process.env.PATH ?? "", writable = toolCacheRoots()) {
  return String(value).split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry) && !writable.some((root) => inside(path.resolve(root), path.resolve(entry)))).join(path.delimiter);
}

// The first `git` on that PATH, as an absolute path; /usr/bin/git failing that.
export function hostGit({ pathValue = process.env.PATH ?? "", writable = toolCacheRoots() } = {}) {
  for (const directory of trustedPath(pathValue, writable).split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "git");
    try { const info = statSync(candidate); if (info.isFile() && (info.mode & 0o111)) return candidate; } catch { /* not here */ }
  }
  return "/usr/bin/git";
}

// The keys (never their values) in the repository's own configuration that
// make git run a command; empty for a repository that has none, or a folder
// that is not one. A configuration git cannot read is taken as having some:
// whatever it holds, it is not something to run git over.
export async function repositoryCommands(cwd, { git = hostGit(), timeoutMs = 5_000 } = {}) {
  const listed = await runProcess(git, [...HOST_GIT_FLAGS, "config", "--show-scope", "--includes", "--list"], { cwd, timeoutMs, maxOutputBytes: 512 * 1024 }).catch(() => null);
  if (!listed || listed.code !== 0) return ["(unreadable configuration)"];
  const keys = new Set();
  for (const line of listed.stdout.split("\n")) {
    const tab = line.indexOf("\t"), scope = line.slice(0, tab), entry = line.slice(tab + 1);
    if ((scope === "local" || scope === "worktree") && RUNS_A_COMMAND.some((pattern) => pattern.test(entry))) keys.add(entry.slice(0, entry.indexOf("=")));
  }
  return [...keys];
}

// What a person is told when a repository is not worked in.
export const declinedRepository = (keys) => `这个仓库自己的配置里有会执行命令的设置（${keys.slice(0, 3).join("、")}${keys.length > 3 ? " 等" : ""}），为了安全，i豆 不在这里运行会触发它们的 Git 操作。`;
