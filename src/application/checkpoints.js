import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../providers/process-runner.js";
import { HOST_GIT_FLAGS, declinedRepository, hostGit, repositoryCommands } from "./host-git.js";
import { SPELLINGS, WRITTEN } from "../product-names.js";

// The working tree as it was before a turn, so taking the turn back also puts
// the code back -- Codex's /undo, Claude Code's rewind (docs/coding-task-
// parity.md, C9). Taking a turn back used to remove it from the conversation
// and leave every file it had written in place.
//
// In a git repository the snapshot is a commit of the folder's files --
// tracked and new, not what .gitignore leaves out -- written through a
// temporary index, so the person's own index, branches, stash and HEAD are
// never touched. A private refs/<name>/checkpoints/<UUID> keeps the commit
// alive until its task record no longer refers to it. Only the task's folder is
// snapshotted and only it is restored;
// the rest of a repository it sits in is left alone.
//
// A folder that is in no repository gets the same, as Claude Code's rewind
// does without git, when the caller gives it somewhere of its own to keep them
// (`shadowRoot`): a repository per folder whose work tree is the folder, so
// nothing is ever written into the folder itself. Only a folder the size of a
// project is snapshotted, dependency and build folders are left out, and so
// are files that usually hold secrets -- those are neither copied nor put back.
// Such a retained snapshot is `shadow:<UUID>:<hash>` (legacy `shadow:<hash>`
// records remain readable), and is always read from where it was kept, even
// once the folder has become a repository of its own.
const SHADOW_EXCLUDES = ["node_modules/", ".venv/", "venv/", "__pycache__/", "dist/", "build/", ".next/", "target/", ".gradle/", "coverage/",
  ".DS_Store", ".env", ".env.*", "*.pem", "*.key", "*.p12", "id_rsa*", "id_ed25519*", ".npmrc", ".netrc"];
const SHADOW_LIMITS = Object.freeze({ files: 2000, bytes: 50 * 1024 * 1024 });
// A folder found too big is not walked again on every turn.
const oversized = new Map();
const IDENTITY = { GIT_AUTHOR_NAME: "idou", GIT_AUTHOR_EMAIL: "checkpoint@idou.local", GIT_COMMITTER_NAME: "idou", GIT_COMMITTER_EMAIL: "checkpoint@idou.local" };
const HASH = /^[0-9a-f]{40,64}$/;
const CHECKPOINT = /^(git|shadow):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{40,64})$/;
// Kept under refs/<name>/, the product's name as product-names.js spells it: a
// checkpoint made before the rename is under refs/mydoubao/, and is released
// from wherever it is.
const checkpointRef = (id, name = WRITTEN) => `refs/${name}/checkpoints/${id}`;

// Outside the sandbox, in a folder the Agent can write to: see host-git.js.
async function gitIn(cwd, args, { git, env = {}, timeoutMs = 20_000 } = {}) {
  const result = await runProcess(git, [...HOST_GIT_FLAGS, ...args], { cwd, env: { ...process.env, ...IDENTITY, ...env }, timeoutMs, maxOutputBytes: 8 * 1024 * 1024 });
  if (result.code !== 0) throw new Error(`git ${args[0]} 失败：${(result.stderr || result.stdout).trim().slice(0, 200)}`);
  return result.stdout;
}

// The folder's own repository kept for it under `shadowRoot`, made on first use.
async function shadowFor(cwd, shadowRoot, git) {
  const folder = path.resolve(cwd);
  const directory = path.join(shadowRoot, `${createHash("sha256").update(folder).digest("hex").slice(0, 32)}.git`);
  if (!(await access(path.join(directory, "HEAD")).then(() => true, () => false))) {
    await mkdir(shadowRoot, { recursive: true, mode: 0o700 });
    await gitIn(shadowRoot, ["init", "--bare", "-q", directory], { git });
    await writeFile(path.join(directory, "info", "exclude"), `${SHADOW_EXCLUDES.join("\n")}\n`);
  }
  return { GIT_DIR: directory, GIT_WORK_TREE: folder };
}
const kept = (checkpoint) => {
  const value = String(checkpoint ?? ""), durable = CHECKPOINT.exec(value);
  if (durable) return { shadow: durable[1] === "shadow", id: durable[2], commit: durable[3], ref: checkpointRef(durable[2]) };
  const shadow = /^shadow:([0-9a-f]{40,64})$/.exec(value);
  return { shadow: Boolean(shadow), commit: shadow ? shadow[1] : value, ref: null };
};

async function keep(cwd, commit, { git, env, shadow, durable }) {
  if (!durable) return shadow ? `shadow:${commit}` : commit;
  const id = randomUUID();
  await gitIn(cwd, ["update-ref", checkpointRef(id), commit], { git, env });
  return `${shadow ? "shadow" : "git"}:${id}:${commit}`;
}

// A snapshot in the folder's own shadow repository, or null when it is too big.
async function takeShadowCheckpoint(cwd, { git, shadowRoot, timeoutMs, durable }) {
  const folder = path.resolve(cwd);
  if ((oversized.get(folder) ?? 0) > Date.now()) return null;
  const directory = path.join(os.tmpdir(), `idou-checkpoint-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { ...(await shadowFor(folder, shadowRoot, git)), GIT_INDEX_FILE: path.join(directory, "index") };
  try {
    // Everything that would go in, before any of it is copied.
    const listed = (await gitIn(folder, ["ls-files", "--others", "--exclude-standard", "-z"], { git, env, timeoutMs: Math.min(timeoutMs, 10_000) })).split("\0").filter(Boolean);
    let bytes = 0;
    for (const file of listed) bytes += (await lstat(path.join(folder, file)).catch(() => null))?.size ?? 0;
    if (listed.length > SHADOW_LIMITS.files || bytes > SHADOW_LIMITS.bytes) { oversized.set(folder, Date.now() + 10 * 60_000); return null; }
    await gitIn(folder, ["add", "-A", "--", "."], { git, env, timeoutMs });
    const tree = (await gitIn(folder, ["write-tree"], { git, env, timeoutMs })).trim();
    const commit = (await gitIn(folder, ["commit-tree", tree, "-m", "idou checkpoint"], { git, env, timeoutMs })).trim();
    return HASH.test(commit) ? keep(folder, commit, { git, env, shadow: true, durable }) : null;
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

// A commit of the folder as it is now, or null when it is not in a repository
// and there is nowhere of our own to keep one, or it is too big (or git cannot
// say in time). Never changes the working tree.
//
// A repository whose own configuration runs commands (host-git.js) is not
// worked in: its snapshot goes to the shadow repository instead.
export async function takeCheckpoint(cwd, { git = hostGit(), timeoutMs = 20_000, shadowRoot = null, shadow = false, durable = true } = {}) {
  const inside = shadow ? null : await runProcess(git, [...HOST_GIT_FLAGS, "rev-parse", "--is-inside-work-tree"], { cwd, timeoutMs: 5_000, maxOutputBytes: 1024 }).catch(() => null);
  const own = !shadow && inside?.code === 0 && inside.stdout.trim() === "true" && !(await repositoryCommands(cwd, { git })).length;
  if (!own) return shadowRoot ? takeShadowCheckpoint(cwd, { git, shadowRoot, timeoutMs, durable }) : null;
  const directory = path.join(os.tmpdir(), `idou-checkpoint-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const env = { GIT_INDEX_FILE: path.join(directory, "index") };
  try {
    const head = await runProcess(git, [...HOST_GIT_FLAGS, "rev-parse", "--verify", "-q", "HEAD"], { cwd, timeoutMs: 5_000, maxOutputBytes: 1024 }).catch(() => null);
    const parent = head?.code === 0 ? head.stdout.trim() : null;
    // From the last commit's tree, so files outside the folder stay as they
    // were committed and unchanged files cost nothing.
    if (parent) await gitIn(cwd, ["read-tree", parent], { git, env, timeoutMs });
    await gitIn(cwd, ["add", "-A", "--", "."], { git, env, timeoutMs });
    const tree = (await gitIn(cwd, ["write-tree"], { git, env, timeoutMs })).trim();
    const commit = (await gitIn(cwd, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "idou checkpoint"], { git, env, timeoutMs })).trim();
    return HASH.test(commit) ? keep(cwd, commit, { git, env, shadow: false, durable }) : null;
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

// What going back to `checkpoint` would change in the folder, file by file:
// `restore` to its content then, `remove` because it did not exist then.
export async function checkpointChanges(cwd, checkpoint, { git = hostGit(), shadowRoot = null } = {}) {
  const { shadow, commit } = kept(checkpoint);
  if (!HASH.test(commit) || (shadow && !shadowRoot)) throw new Error("这个快照无效");
  // Comparing against, and restoring into, the repository itself runs its own
  // filters; one that has taken to defining some is not worked in.
  if (!shadow) { const keys = await repositoryCommands(cwd, { git }); if (keys.length) throw new Error(declinedRepository(keys)); }
  const now = kept(await takeCheckpoint(cwd, { git, shadowRoot, shadow, durable: false }));
  if (!now.commit || now.shadow !== shadow) throw new Error(shadow ? "这个目录现在太大，无法对照快照恢复文件" : "这个目录已经不是 Git 仓库，无法恢复文件");
  const env = shadow ? await shadowFor(cwd, shadowRoot, git) : {};
  const listed = await gitIn(cwd, ["diff", "--name-status", "--no-renames", "--relative", "-z", commit, now.commit, "--", "."], { git, env });
  const parts = listed.split("\0").filter(Boolean), changes = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index], file = parts[index + 1];
    changes.push({ path: file, action: status === "A" ? "remove" : "restore", status });
  }
  return changes;
}

// Removes exactly the application-owned ref encoded in a retained task record,
// under whichever spelling of the product's name it was made. Legacy hash-only
// checkpoints have no ref to remove. A ref that holds a different commit -- a
// newer one with the same name -- is left alone.
export async function releaseCheckpoint(cwd, checkpoint, { git = hostGit(), shadowRoot = null } = {}) {
  const retained = kept(checkpoint);
  if (!retained.ref || !HASH.test(retained.commit) || (retained.shadow && !shadowRoot)) return false;
  const env = retained.shadow ? await shadowFor(cwd, shadowRoot, git) : {};
  let released = false;
  for (const name of SPELLINGS) {
    const ref = checkpointRef(retained.id, name);
    const held = await runProcess(git, [...HOST_GIT_FLAGS, "rev-parse", "--verify", "-q", ref], { cwd, env: { ...process.env, ...env }, timeoutMs: 5_000, maxOutputBytes: 1024 }).catch(() => null);
    if (held?.code !== 0 || held.stdout.trim() !== retained.commit) continue;
    await gitIn(cwd, ["update-ref", "-d", ref, retained.commit], { git, env });
    released = true;
  }
  return released;
}

// Puts the folder back as it was at `checkpoint`: every file changed since
// gets its content from then, every file created since is removed. Returns
// what it did. The person's index is left as it was.
export async function restoreCheckpoint(cwd, checkpoint, { git = hostGit(), shadowRoot = null } = {}) {
  const changes = await checkpointChanges(cwd, checkpoint, { git, shadowRoot });
  const { shadow, commit } = kept(checkpoint);
  const env = shadow ? await shadowFor(cwd, shadowRoot, git) : {};
  const root = path.resolve(cwd);
  const inside = (file) => { const target = path.resolve(root, file); return target.startsWith(`${root}${path.sep}`) ? target : null; };
  const restore = changes.filter((change) => change.action === "restore").map((change) => change.path);
  if (restore.length) {
    // `git restore --source --worktree` changes the files and nothing else.
    const list = path.join(os.tmpdir(), `idou-restore-${randomUUID()}`);
    await writeFile(list, restore.map((file) => `${file}\0`).join(""), { mode: 0o600 });
    try { await gitIn(cwd, ["restore", `--source=${commit}`, "--worktree", "--pathspec-file-nul", `--pathspec-from-file=${list}`], { git, env }); }
    finally { await rm(list, { force: true }).catch(() => {}); }
  }
  for (const change of changes.filter((row) => row.action === "remove")) {
    const target = inside(change.path);
    if (target) await unlink(target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
  return changes;
}
