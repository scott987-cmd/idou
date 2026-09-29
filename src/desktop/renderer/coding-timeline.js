// A coding task's conversation, laid out the way Codex and Claude Code lay out
// a turn (docs/coding-task-parity.md, C1-C3, C10): what the Agent said, then
// what it read, ran and changed, then what it said next -- each step where it
// happened -- and at the end how long the turn took and what it changed.
//
// Pure: it takes the task record and returns the turns to draw. The page does
// the drawing, so this can be checked without one.
import { joinSplitAnswers } from "../../application/split-answers.js";

// `/bin/zsh -lc 'npm test'` is how Codex runs a command, not what the Agent
// ran. Codex shows the inner command; so does this. Anything that is not one
// wrapped command is shown as it is.
export function displayCommand(command) {
  const text = String(command ?? "").trim();
  const wrapped = /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(text);
  if (!wrapped) return text;
  const inner = wrapped[1].trim();
  if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'") && !inner.slice(1, -1).includes("'")) return inner.slice(1, -1);
  if (inner.length >= 2 && inner.startsWith("\"") && inner.endsWith("\"")) return inner.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  // Codex quotes an inner single quote as '"'"'; undo exactly that.
  if (inner.startsWith("'") && inner.endsWith("'")) return inner.slice(1, -1).replaceAll(`'"'"'`, "'");
  return inner;
}

// Lines added and removed in a unified diff, headers not counted.
export function diffStats(diff) {
  let added = 0, removed = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1; else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

// A new file's diff may come as its whole content with no +; a deleted file's
// as nothing. Codex counts those as the file's lines; so does this.
function fileStats(change) {
  const stats = diffStats(change.diff);
  const kind = typeof change.kind === "string" ? change.kind : change.kind?.type;
  if (!stats.added && !stats.removed && change.diff) {
    const lines = String(change.diff).replace(/\n$/, "").split("\n").length;
    if (kind === "add") return { added: lines, removed: 0 };
    if (kind === "delete") return { added: 0, removed: lines };
  }
  return stats;
}

const EXPLORING = new Set(["read", "listFiles", "search"]);
// A command Codex read as browsing the code: every action a read, a listing
// or a search, and at least one of them. A failed or declined read is still a
// command whose output matters; calling it “已浏览” would turn failure into a
// success claim and hide the diagnostic.
const exploring = (entry) => entry.type === "commandExecution" && !["failed", "declined"].includes(entry.status)
  && (!Number.isInteger(entry.exitCode) || entry.exitCode === 0) && Array.isArray(entry.actions) && entry.actions.length > 0
  && entry.actions.every((action) => EXPLORING.has(action.type));

export function planSummary(plan) {
  const marks = { completed: "✓", inProgress: "▸", pending: "○" };
  const steps = Array.isArray(plan?.steps) ? plan.steps.filter((row) => typeof row?.step === "string").map((row) => {
    const status = Object.hasOwn(marks, row.status) ? row.status : "pending";
    return { step: row.step, status, mark: marks[status] };
  }) : [];
  return { completed: steps.filter((row) => row.status === "completed").length, total: steps.length, steps };
}

export function knowledgeStatus(knowledge) {
  if (!knowledge || typeof knowledge !== "object") return null;
  const documents = Number.isSafeInteger(knowledge.documents) && knowledge.documents > 0 ? knowledge.documents : 0;
  const unavailable = Number.isSafeInteger(knowledge.unavailable) && knowledge.unavailable > 0 ? knowledge.unavailable : 0;
  if (knowledge.failed) return `企业知识检索失败：${String(knowledge.failed)}。本次回答未使用知识库资料。`;
  if (!documents && unavailable) return `${unavailable} 篇资料这次无法重新核验，本次回答未使用这些资料。`;
  if (!documents) return "没有检索到相关企业知识，本次回答未引用知识库资料。";
  if (unavailable) return `已使用 ${documents} 篇资料；另有 ${unavailable} 篇这次无法重新核验，未参与回答。`;
  return null;
}

export function elapsedText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(seconds, 1)} 秒`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
}

// How much of the model's context is left, in percent, the way Codex's footer
// counts it (TokenUsage::percent_of_context_window_remaining): the last
// response's tokens against the window, both less the 12,000 tokens that are
// always there -- instructions, tools, room to compact -- so a fresh thread
// reads 100% and a full one 0%. Null until Codex has said.
const BASELINE_TOKENS = 12_000;
export function contextLeft(usage) {
  const tokens = usage?.tokens, window = usage?.window;
  if (!Number.isFinite(tokens) || !Number.isFinite(window)) return null;
  if (window <= BASELINE_TOKENS) return 0;
  const effective = window - BASELINE_TOKENS;
  const remaining = Math.max(0, effective - Math.max(0, tokens - BASELINE_TOKENS));
  return Math.round(Math.min(100, (remaining / effective) * 100));
}

// 950, 12.3K, 486K, 1.2M: three figures at most, short enough for a status line.
export function tokenCount(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1000) return String(Math.round(value));
  for (const [size, unit] of [[1e3, "K"], [1e6, "M"], [1e9, "G"]]) {
    const scaled = value / size;
    const text = scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2);
    if (Number(text) < 1000 || unit === "G") return `${text.includes(".") ? text.replace(/\.?0+$/, "") : text}${unit}`;
  }
}

// The task's record as turns: each opened by what the person asked (the
// Agent's words, the steps and anything added mid-turn following in order)
// and closed, once it ended, with how long it took and what it changed.
function stepView(entry) {
  if (entry.type === "commandExecution") return exploring(entry)
    ? { kind: "explore", commands: [entry] }
    : { kind: "command", entry, command: displayCommand(entry.command) };
  if (entry.type === "fileChange") return { kind: "change", entry, files: (entry.changes ?? []).map((change) => ({ ...change, ...fileStats(change),
    kind: typeof change.kind === "string" ? change.kind : change.kind?.type ?? "update", movedTo: change.kind?.move_path ?? null })) };
  if (entry.type === "plan") return { kind: "plan", entry };
  if (entry.type === "mcpToolCall") return { kind: "mcp", entry };
  if (entry.type === "subAgentActivity") return { kind: "subagent", entry };
  return { kind: "legacy", entry };
}

export function taskTurns(task) {
  // An answer sent in pieces reads as one block of words, not as a run of them
  // (split-answers.js).
  const messages = joinSplitAnswers(task?.messages ?? [], task?.activity ?? []).map((message, index) => ({ at: Number.isFinite(message.seq) ? message.seq : index + 0.5, index, kind: "message", message }));
  const steps = (task?.activity ?? []).filter((entry) => Number.isFinite(entry.seq))
    .map((entry, index) => ({ at: entry.seq, index: 100_000 + index, kind: "step", entry }));
  const legacy = (task?.activity ?? []).filter((entry) => !Number.isFinite(entry.seq));
  const ordered = [...messages, ...steps].sort((a, b) => a.at - b.at || a.index - b.index);

  const turns = [];
  let turn = null;
  const open = (message) => { turn = { key: `${message?.id ?? "orphan"}:${message?.seq ?? "legacy"}:${turns.length}`, message, knowledge: message?.knowledge ?? null, entries: [] }; turns.push(turn); };
  for (const row of ordered) {
    if (row.kind === "message" && row.message.role === "user" && !row.message.steered) { open(row.message); continue; }
    if (!turn) open(null);
    const entries = turn.entries;
    if (row.kind === "message") { entries.push({ kind: row.message.role === "user" ? "steer" : row.message.role === "notice" ? "notice" : "text", message: row.message }); continue; }
    const view = stepView(row.entry);
    if (view.kind === "explore") {
      const previous = entries.at(-1);
      if (previous?.kind === "explore") previous.commands.push(...view.commands); else entries.push(view);
      continue;
    }
    entries.push(view);
  }
  for (const each of turns) {
    const changes = each.entries.filter((entry) => entry.kind === "change").flatMap((entry) => entry.files);
    const paths = new Set(changes.map((file) => file.path));
    const timing = each.message?.turn;
    // Codex's own net diff of the turn when it sent one; else the patches
    // added up, which counts a file patched more than once more than once.
    const net = timing?.diff && Number.isInteger(timing.diff.files) ? timing.diff : null;
    each.summary = timing?.finishedAt ? { elapsed: timing.finishedAt - timing.startedAt, status: timing.status,
      files: net ? net.files : paths.size, added: net ? net.added : changes.reduce((sum, file) => sum + file.added, 0),
      removed: net ? net.removed : changes.reduce((sum, file) => sum + file.removed, 0) } : null;
  }
  // Steps recorded before steps were numbered are older than anything that is:
  // they go after the turns of that time and before the first numbered one.
  // At the very end they sat under the newest turn, and a conversation carried
  // on from those days opened on its old steps, with the answer just given
  // scrolled out of sight above them.
  if (legacy.length) {
    const numbered = turns.findIndex((each) => Number.isFinite(each.message?.seq)
      || each.entries.some((entry) => Number.isFinite(entry.message?.seq ?? entry.entry?.seq ?? entry.commands?.[0]?.seq)));
    turns.splice(numbered === -1 ? turns.length : numbered, 0, { key: "legacy", legacy: true, message: null, knowledge: null, entries: legacy.map(stepView), summary: null });
  }
  return turns;
}

// Kept for callers and plugins that imported the original coding-only name.
export const codingTurns = taskTurns;

// What a group of browsing commands did, in a line: 读取 3 个文件 · 搜索 2 次.
export function exploreSummary(commands) {
  const actions = commands.flatMap((command) => command.actions ?? []);
  const reads = new Set(actions.filter((action) => action.type === "read").map((action) => action.path ?? action.name));
  const lists = actions.filter((action) => action.type === "listFiles").length;
  const searches = actions.filter((action) => action.type === "search").length;
  return [reads.size ? `读取 ${reads.size} 个文件` : "", lists ? `列出 ${lists} 个目录` : "", searches ? `搜索 ${searches} 次` : ""].filter(Boolean).join(" · ");
}

// One line per browsing action, the way Codex lists them under "Explored".
export function exploreLines(commands) {
  return commands.flatMap((command) => (command.actions ?? []).map((action) => action.type === "read" ? `读取 ${action.path ?? action.name}`
    : action.type === "listFiles" ? `列出 ${action.path ?? "."}`
      : `搜索 ${action.query ? `“${action.query}”` : ""}${action.path ? ` 在 ${action.path}` : ""}`.trim()));
}
