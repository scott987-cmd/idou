import { homedir, tmpdir } from "node:os";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../providers/process-runner.js";

// Codex's `workspace-write` sandbox makes the task directory and the temporary
// directory writable and nothing else. That is the correct default for a
// throwaway command, and the wrong default for development: every package
// manager keeps its cache under the home directory, so `npm install`,
// `pip install` and `cargo build` fail on a denied write to a cache path the
// person never asked about and cannot see. These are the caches those tools
// use — each one is a build artefact store the tool itself creates and prunes,
// never a place where documents, credentials or configuration live.
//
// Deliberately absent: ~/.ssh, ~/.aws, ~/.config, ~/.gitconfig, ~/Library
// (beyond the caches named below), and the home directory itself. A task that
// genuinely needs to write there must either ask for approval or run in 完全访问.
//
// And, since 2026-09-27, anything that is run from later, outside the sandbox:
// all of ~/Library/Caches was here, and the browser the browser connector
// launches outside the sandbox lives in ~/Library/Caches/ms-playwright; ~/.deno
// and ~/.yarn hold bin directories that are on the person's PATH. Now only the
// caches themselves: each tool's own folder under ~/Library/Caches, Yarn's
// berry cache, and none of the places programs are installed to.
const TOOL_CACHE_PATHS = [
  ".npm", ".yarn/berry", ".pnpm-store", ".bun/install/cache",      // JavaScript
  ".cache",                                                        // pip, uv, pre-commit, many Linux-style tools
  ...["pip", "pypoetry", "Yarn", "pnpm", "deno", "node-gyp", "typescript", "go-build", "Homebrew", "CocoaPods", "org.swift.swiftpm"]
    .map((tool) => `Library/Caches/${tool}`),                      // the macOS equivalent of ~/.cache, tool by tool
  ".cargo/registry", ".cargo/git",                                 // Rust
  ".m2/repository", ".gradle/caches",                              // JVM
  "go/pkg/mod",                                                    // Go
];

// Only the temporary directory and the tool caches are added. The task
// directory is already writable, and adding it again would hide a mistake in
// how the task's own directory was resolved.
export function toolCacheRoots(home = homedir(), temp = tmpdir()) {
  const roots = TOOL_CACHE_PATHS.map((relative) => path.join(home, relative));
  // TMPDIR is writable by default, but naming it keeps the set explicit rather
  // than depending on a default that a future Codex version may narrow.
  return [...new Set([temp, ...roots])];
}

// Inside a writable workspace, Codex still refuses every write under `.git` —
// so `git init`, `git add` and `git commit` all die on `Operation not
// permitted`, which is not a state anyone can write code in. Naming the task's
// own repository as a writable root lifts that one carve-out and nothing else:
// it is the repository the person pointed this task at, it is already inside
// the workspace, and no `.git` anywhere else becomes writable.
export function repositoryRoot(cwd) {
  return typeof cwd === "string" && path.isAbsolute(cwd) ? [path.join(cwd, ".git")] : [];
}

// True when `child` is `parent` or sits underneath it.
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// The directory a git directory belongs to: `.../<root>/.git` and a worktree's
// `.../<root>/.git/worktrees/<name>` both belong to `<root>`. Returns null when
// the path has no `.git` component, which a real git directory always does.
function gitDirectoryOwner(gitDir) {
  const parts = gitDir.split(path.sep);
  const index = parts.indexOf(".git");
  return index <= 0 ? null : parts.slice(0, index).join(path.sep);
}

// The repository a task's folder belongs to is not always the folder's own
// `.git`: a task opened on a package inside a monorepo commits to a `.git` above
// it, and a linked worktree keeps its objects in the checkout it came from. Git
// says where it writes; this asks it, and falls back to the folder's own `.git`
// so a repository created later through the application still works.
//
// But `.git` is a writable root, so an agent could plant a `.git/commondir` that
// points git at an unrelated repository and make that repository's `.git`
// writable on the next turn. So a git directory is only trusted when it belongs
// to the folder or one of its ancestors (the monorepo case); a `.git` that
// points anywhere else is dropped and the folder's own `.git` is used instead.
// A genuine linked worktree is the one legitimate exception where git points
// outside the folder — and there the folder's `.git` is a gitfile that git, not
// the agent, wrote (turning it into a directory would destroy the checkout), so
// that case is trusted as git reports it.
export async function repositoryDirectories(cwd, { git = "git", run = runProcess } = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return [];
  const result = await run(git, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd, maxOutputBytes: 8192 }).catch(() => null);
  const directories = result?.code === 0 ? result.stdout.split("\n").map((line) => line.trim()).filter((line) => path.isAbsolute(line)) : [];
  if (!directories.length) return [...new Set(repositoryRoot(cwd))];
  const worktree = await stat(path.join(cwd, ".git")).then((entry) => entry.isFile()).catch(() => false);
  const scoped = worktree ? directories : directories.filter((dir) => {
    const owner = gitDirectoryOwner(dir);
    return isInside(cwd, dir) || (owner !== null && isInside(owner, cwd));
  });
  return [...new Set(scoped.length ? scoped : repositoryRoot(cwd))];
}

// Only `workspace-write` reads these keys. Returning nothing for the other
// sandboxes keeps a read-only turn from carrying settings that would look like
// they loosened it.
export function sandboxOverrides(permission, { cwd, home = homedir(), temp = tmpdir(), repository = repositoryRoot(cwd) } = {}) {
  if (permission.sandbox !== "workspace-write") return {};
  return {
    "sandbox_workspace_write.writable_roots": [...toolCacheRoots(home, temp), ...repository],
    "sandbox_workspace_write.network_access": permission.network === true,
  };
}

// A project's own Codex folder -- rules that run commands outside the sandbox,
// settings, hooks -- is loaded for any project nobody marked (measured on
// 0.157: a repository's .codex/rules allowing curl let curl out of 标准's
// sandbox, from a folder under the home directory and under /tmp alike). Codex
// skips it for a project marked untrusted, and the person never chose to trust a
// folder here; so a project that has one is marked so. Untrusted also leaves the
// project's AGENTS.md unsent, so a project without a .codex folder is left as
// it is -- and a sandboxed command cannot make one (Codex refuses writes to
// .codex as it does to .git), so one that has none when a turn starts has none
// while it runs. Looked for from the repository's root down to the folder,
// where Codex looks.
export async function projectTrustOverrides(cwd, repository = []) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return {};
  const roots = [...new Set(repository.map((dir) => gitDirectoryOwner(dir)).filter((owner) => owner && isInside(owner, cwd)))];
  const folders = new Set([cwd]);
  for (const root of roots) {
    for (let at = cwd; isInside(root, at); at = path.dirname(at)) { folders.add(at); if (at === root || at === path.dirname(at)) break; }
  }
  const found = await Promise.all([...folders].map((folder) => lstat(path.join(folder, ".codex")).then(() => true, () => false)));
  if (!found.some(Boolean)) return {};
  // Named as given and as the file system resolves it: /tmp is /private/tmp.
  const projects = {};
  for (const folder of new Set([cwd, ...roots])) {
    projects[folder] = { trust_level: "untrusted" };
    const real = await realpath(folder).catch(() => folder);
    projects[real] = { trust_level: "untrusted" };
  }
  return { projects };
}
