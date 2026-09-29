import { readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runProcess } from "../providers/process-runner.js";
import { HOST_GIT_FLAGS, declinedRepository, hostGit, repositoryCommands } from "./host-git.js";
import { diffReviewLines } from "./diff-lines.js";
export { diffReviewLines } from "./diff-lines.js";

// What a coding task's folder holds, for the two things Codex and Claude Code
// offer on top of the conversation (docs/coding-task-parity.md): `@` to name a
// file in the message (C6), and a view of everything changed in the working
// tree (C8, their `/diff`). Both only read.

// Directories nobody means when they type @: dependencies and build output.
const SKIPPED = new Set([".git", "node_modules", ".next", ".nuxt", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage", ".idea", ".vscode"]);
const MAX_FILES = 20_000;

// The files of a project, relative to its folder. A repository's own list when
// there is one -- tracked and untracked, minus what .gitignore leaves out --
// else a bounded walk that skips the usual heavy directories.
export async function listProjectFiles(cwd, { git = hostGit() } = {}) {
  const listed = await runProcess(git, [...HOST_GIT_FLAGS, "ls-files", "-co", "--exclude-standard", "-z"], { cwd, maxOutputBytes: 8 * 1024 * 1024 }).catch(() => null);
  if (listed?.code === 0) return listed.stdout.split("\0").filter(Boolean).slice(0, MAX_FILES);
  const files = [];
  const queue = [""];
  while (queue.length && files.length < MAX_FILES) {
    const relative = queue.shift();
    if (relative.split("/").length > 12) continue;
    let entries;
    try { entries = await readdir(path.join(cwd, relative), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIPPED.has(entry.name) && !entry.name.startsWith(".")) queue.push(name); }
      else if (entry.isFile() && entry.name !== ".DS_Store") files.push(name);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

// The files whose path fits what was typed after @, best first: a name that
// starts with it, then a name that contains it, then a path that does.
export function matchFiles(paths, query, max = 20) {
  const wanted = String(query ?? "").toLowerCase();
  const scored = [];
  for (const file of paths) {
    const lower = file.toLowerCase(), name = lower.slice(lower.lastIndexOf("/") + 1);
    const rank = !wanted ? 3 : name.startsWith(wanted) ? 0 : name.includes(wanted) ? 1 : lower.includes(wanted) ? 2 : -1;
    if (rank >= 0) scored.push([rank, file.length, file]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
  return scored.slice(0, max).map(([, , file]) => file);
}

const MAX_DIFF = 2 * 1024 * 1024;
const MAX_UNTRACKED = 200 * 1024;

// Everything changed in the working tree against the last commit, file by
// file, as `git diff HEAD` would show it plus the files git does not know yet.
// Not a repository: said so, since there is nothing to compare against.
const digest = (value) => createHash("sha256").update(value).digest("hex");
const diffResult = ({ scope, basis, files, ...rest }) => ({ scope, basis, revision: digest(JSON.stringify({ scope, basis, files })), files, ...rest });

// Outside the sandbox, in a folder the Agent can write to (host-git.js): no
// hooks, no fsmonitor, no textconv or external diff, and nothing at all run
// against the working tree of a repository that defines its own filters.
export async function projectDiff(cwd, { git = hostGit(), readText, scope = "working" } = {}) {
  if (scope !== "working") throw new Error("无效的改动范围");
  const inside = await runProcess(git, [...HOST_GIT_FLAGS, "rev-parse", "--is-inside-work-tree"], { cwd, maxOutputBytes: 1024 }).catch(() => null);
  if (inside?.code !== 0 || inside.stdout.trim() !== "true") return { repository: false, scope, basis: null, revision: null, files: [] };
  const commands = await repositoryCommands(cwd, { git });
  if (commands.length) return { repository: true, scope, basis: null, revision: null, files: [], unavailableReason: declinedRepository(commands) };
  const head = await runProcess(git, [...HOST_GIT_FLAGS, "rev-parse", "--verify", "-q", "HEAD"], { cwd, maxOutputBytes: 1024 }).catch(() => null);
  const base = head?.code === 0 ? "HEAD" : "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // the empty tree, before a first commit
  const diffed = await runProcess(git, [...HOST_GIT_FLAGS, "-c", "core.quotepath=off", "diff", base, "--no-color", "--no-ext-diff", "--no-textconv", "--relative", "--", "."], { cwd, maxOutputBytes: MAX_DIFF + 1 }).catch(() => null);
  const text = diffed?.code === 0 ? diffed.stdout : "";
  const files = splitDiff(text);
  const untracked = await runProcess(git, [...HOST_GIT_FLAGS, "-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z"], { cwd, maxOutputBytes: 1024 * 1024 }).catch(() => null);
  for (const file of (untracked?.code === 0 ? untracked.stdout.split("\0").filter(Boolean) : []).slice(0, 200)) {
    let content;
    try { content = readText ? await readText(file) : ""; } catch { files.push({ path: file, status: "added", untracked: true, diff: "", added: 0, removed: 0, readError: true }); continue; }
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    if (bytes.includes(0)) { files.push({ path: file, status: "added", untracked: true, diff: "", added: 0, removed: 0, binary: true }); continue; }
    const textContent = bytes.toString("utf8"), lines = bytes.length > MAX_UNTRACKED ? null : textContent.replace(/\n$/, "").split("\n");
    files.push({ path: file, status: "added", untracked: true, diff: lines ? lines.map((line) => `+${line}`).join("\n") : "", added: lines ? lines.length : 0, removed: 0, ...(lines ? {} : { tooLarge: true }) });
  }
  const basis = head?.code === 0 ? `HEAD ${head.stdout.trim()}` : "空仓库基准";
  return { repository: true, ...diffResult({ scope, basis, files, truncated: text.length > MAX_DIFF }) };
}

function turnMessage(task, turnKey) {
  if (typeof turnKey !== "string" || !turnKey || turnKey.length > 200) throw new Error("无效的本轮改动标识");
  const message = task?.messages?.find((row) => row?.id === turnKey && row.role === "user" && !row.steered);
  if (!message) throw new Error("找不到这一轮的改动记录");
  return message;
}

function partialTurnFiles(task, message) {
  const start = Number.isFinite(message.seq) ? message.seq : -Infinity;
  const next = task.messages.filter((row) => row?.role === "user" && !row.steered && Number.isFinite(row.seq) && row.seq > start)
    .reduce((value, row) => Math.min(value, row.seq), Infinity);
  return (task.activity ?? []).filter((row) => row?.type === "fileChange" && row.status !== "failed" && row.status !== "declined"
    && Number.isFinite(row.seq) && row.seq > start && row.seq < next).flatMap((row) => (row.changes ?? []).map((change) => {
      const stats = diffReviewLines(change.diff).reduce((sum, line) => ({ added: sum.added + Number(line.kind === "add"), removed: sum.removed + Number(line.kind === "remove") }), { added: 0, removed: 0 });
      const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
      return { path: change.path, status: kind === "add" ? "added" : kind === "delete" ? "deleted" : "modified", diff: String(change.diff ?? ""), ...stats, partial: true };
    }));
}

// A task-facing range switch. Historical turns are read only from the record
// captured for that turn; this function never substitutes today's git diff.
export async function taskProjectDiff(task, request = {}, options = {}) {
  const scope = request?.scope ?? "working";
  if (scope === "working") return projectDiff(task.cwd, { ...options, scope });
  if (scope !== "turn") throw new Error("无效的改动范围");
  const message = turnMessage(task, request.turnKey);
  const full = typeof message.turn?.diffText === "string" ? message.turn.diffText : null;
  const files = full === null ? partialTurnFiles(task, message) : splitDiff(full);
  const basis = full === null ? "本轮记录片段（非完整净差异）" : `Codex 本轮净差异 ${message.turn?.codexTurnId ?? message.id}`;
  const result = diffResult({ scope, basis, files,
    ...(full === null ? { unavailableReason: message.turn?.diffUnavailable || "这条历史轮次没有完整净差异；下面只显示当时记录的修改片段。" } : {}) });
  if (typeof options.readText === "function") result.files = await Promise.all(result.files.map(async (file) => {
    try { const value = await options.readText(file.path); return { ...file, currentRevision: digest(Buffer.isBuffer(value) ? value : Buffer.from(String(value))) }; }
    catch { return { ...file, currentRevision: null }; }
  }));
  return { repository: true, turnKey: message.id, ...result };
}


// What /review can be pointed at, as Codex's review presets offer it: the other
// branches to compare against (most recently committed first) and the latest
// commits. Read from git; nothing is changed.
export async function reviewTargets(cwd, { git = hostGit(), limit = 10 } = {}) {
  const run = async (args) => {
    const result = await runProcess(git, [...HOST_GIT_FLAGS, "-c", "core.quotepath=off", ...args], { cwd, maxOutputBytes: 256 * 1024 }).catch(() => null);
    return result?.code === 0 ? result.stdout : null;
  };
  if ((await run(["rev-parse", "--is-inside-work-tree"]))?.trim() !== "true") return { repository: false, branch: null, branches: [], commits: [] };
  const branch = (await run(["branch", "--show-current"]))?.trim() || null;
  const branches = ((await run(["for-each-ref", "--sort=-committerdate", `--count=${limit + 1}`, "--format=%(refname:short)", "refs/heads"])) ?? "")
    .split("\n").map((name) => name.trim()).filter((name) => name && name !== branch).slice(0, limit);
  // A repository with no commit yet has no log; that is no commits, not an error.
  const commits = ((await run(["log", `-n${limit}`, "--format=%H%x09%s"])) ?? "").split("\n").filter(Boolean)
    .map((line) => { const [sha, ...subject] = line.split("\t"); return { sha, title: subject.join("\t").slice(0, 200) }; })
    .filter((commit) => /^[0-9a-f]{40}$/.test(commit.sha));
  return { repository: true, branch, branches, commits };
}

// `git diff` output, one entry per file, with what each adds and removes.
export function splitDiff(text) {
  const files = [];
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) { current = { path: header[2], status: "modified", diff: "", added: 0, removed: 0 }; files.push(current); continue; }
    if (!current) continue;
    if (line.startsWith("new file mode")) { current.status = "added"; continue; }
    if (line.startsWith("deleted file mode")) { current.status = "deleted"; continue; }
    if (line.startsWith("rename to ")) { current.status = "renamed"; continue; }
    if (/^(index |similarity |rename from |old mode |new mode |--- |\+\+\+ )/.test(line)) continue;
    if (line.startsWith("Binary files")) { current.binary = true; continue; }
    current.diff += `${line}\n`;
    if (line.startsWith("+")) current.added += 1; else if (line.startsWith("-")) current.removed += 1;
  }
  for (const file of files) file.diff = file.diff.replace(/\n$/, "");
  return files;
}
