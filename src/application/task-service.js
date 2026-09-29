import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { redactor } from "./redact-secrets.js";
import { getMode, getPermission, DEFAULT_PERMISSION } from "../modes.js";
import { executionPermissionForTask, isExecutionPermission } from "../permissions.js";
import { runTurn } from "./turn.js";
import { validateTaskId } from "./task-store.js";
import { prepareTaskContext, contextualPrompt } from "./task-context.js";
import { knowledgeScope, knowledgeEvidence, knowledgePrompt, knowledgeSources } from "../knowledge/task-scope.js";
import { listTaskFiles, taskFilesPrompt } from "./task-files.js";
import { skillReference, registerTaskSkill } from "./task-skill.js";
import { knowledgeCommand } from "./knowledge-commands.js";
import { mcpApprovalPolicy, mcpGrant, mcpToolName } from "./mcp-approval-policy.js";
import { sheetEditProposal } from "./sheet-proposal.js";
import { baseEditProposal } from "./base-proposal.js";
import { mentionsPrompt, normalizeMentions } from "./mentions.js";
import { fileReferencesPrompt, normalizeFileReferences, prepareFileReferences } from "./message-references.js";
import { taskProjectDiff } from "./project-files.js";
import { readWorkspaceFile } from "./workspace-files.js";
import { taskQueueConfigRevision } from "./task-queue.js";

const RUNNING = new Set(["running", "awaiting_approval", "stopping"]);
const UNCERTAIN_RESULTS = new Set(["unknown", "mismatch", "conflict", "verification_pending", "upload_unknown"]);
function currentTurnHasUncertainResult(task) {
  if ((task.documentDeliveries ?? []).some(record => record.state === "unknown" || record.state === "dispatching")) return true;
  const opened = task.messages.findLast((message) => message.role === "user" && !message.steered);
  const floor = Number.isFinite(opened?.seq) ? opened.seq : -Infinity;
  return task.messages.some((message) => (!Number.isFinite(message.seq) || message.seq > floor)
    && [message.documentEdit, message.sheetEdit, message.baseEdit].some(record => record && UNCERTAIN_RESULTS.has(record.state)));
}
async function requireTaskDirectory(cwd) {
  try { if ((await stat(cwd)).isDirectory()) return; } catch { /* one stable product error below */ }
  throw new Error("目录已移动或不可用，请重新选择目录");
}

// The name of a task is what was asked. Cutting at a sentence boundary keeps it
// readable in a narrow list instead of stopping mid-word at a fixed count.
const TITLE_LIMIT = 24;
export function taskTitle(text) {
  const line = String(text).replace(/\s+/g, " ").trim();
  if (!line) return "新任务";
  // Prefer the first clause: it is usually the request, and what follows is
  // usually detail. A boundary in the first few characters is skipped so the
  // name does not come out as 好 or 你好.
  const boundary = line.slice(0, TITLE_LIMIT + 1).search(/[，。；：！？!?,.;:]/);
  if (boundary >= 6) return line.slice(0, boundary);
  if (line.length <= TITLE_LIMIT) return line;
  return `${line.slice(0, TITLE_LIMIT)}…`;
}
const clone = (value) => structuredClone(value);

// The Agent's questions (Codex's request_user_input), as far as a card can show
// them: a few short questions, each with at most a handful of labelled options.
// A question without options, or one that allows it, takes the person's own words.
const shortText = (value, max) => typeof value === "string" && value.trim() !== "" && value.length <= max;
function userQuestions(value) {
  if (!Array.isArray(value) || !value.length || value.length > 5) return null;
  const ids = new Set();
  const questions = value.map((item) => {
    const options = item?.options ?? [];
    if (!shortText(item?.id, 100) || ids.has(item.id) || typeof item.header !== "string" || item.header.length > 120 || !shortText(item.question, 2000)) return null;
    if (!Array.isArray(options) || options.length > 8 || options.some((option) => !shortText(option?.label, 200) || (option.description != null && typeof option.description !== "string"))) return null;
    ids.add(item.id);
    return { id: item.id, header: item.header, question: item.question, options: options.map((option) => ({ label: option.label, description: String(option.description ?? "").slice(0, 500) })),
      isOther: item.isOther === true || !options.length, isSecret: item.isSecret === true };
  });
  return questions.every(Boolean) ? questions : null;
}
const emptyAnswers = (questions) => Object.fromEntries(questions.map((question) => [question.id, { answers: [] }]));
// The end of a command's output -- where errors and test summaries are -- kept
// so the person can see what the Agent saw. Bounded: a task runs hundreds.
const OUTPUT_TAIL = 2000;
// Which of this turn's MCP steps went through without a card, and why: an
// answer given at once is queued by (server, tool) and claimed by the first
// step of that tool seen after it. A step seen before its answer is looked at
// again when it completes.
function mcpAllowedNote(execution, id, item) {
  if (!execution) return null;
  const claimed = (execution.mcpAllowedItems ??= new Map());
  if (claimed.has(id)) return claimed.get(id);
  const queue = execution.mcpAllowed ?? [];
  const index = queue.findIndex((row) => row.server === item.server && row.tool === item.tool);
  if (index < 0) return null;
  const [row] = queue.splice(index, 1);
  claimed.set(id, row.note);
  return row.note;
}
const outputTail = (value) => typeof value !== "string" || !value ? null : value.length > OUTPUT_TAIL ? `…${value.slice(-OUTPUT_TAIL)}` : value;

// The order things happened in a task, one counter for its messages and its
// record together, so a turn can be laid out as it went: what the Agent said,
// then what it read, ran and changed, then what it said next.
function nextSeq(task) {
  task.seq = (Number.isSafeInteger(task.seq) ? task.seq : 0) + 1;
  return task.seq;
}
// A task written before there was an order keeps its entries unassigned. The
// counter starts after their array positions so new ordered events cannot sort
// into the middle of that legacy record, but no invented seq claims which old
// turn an activity belonged to.
function backfillOrder(task) {
  if (Number.isSafeInteger(task.seq)) return;
  const known = [...(task.messages ?? []), ...(task.activity ?? [])].map((row) => row?.seq).filter(Number.isSafeInteger);
  task.seq = Math.max((task.messages?.length ?? 0) + (task.activity?.length ?? 0), 0, ...known);
}
// An item id is only unique inside the turn/thread that produced it. Find an
// existing entry after the current turn opened, so started/completed/replayed
// events update one row while an upstream reusing the id next turn cannot
// overwrite history.
function turnActivity(task, id) {
  const opened = task.messages.findLast((message) => message.role === "user" && !message.steered);
  const floor = Number.isFinite(opened?.seq) ? opened.seq : -Infinity;
  // An unsequenced legacy row can never be evidence that it belongs to the
  // current turn. Even a reused id must create a new ordered row beside it.
  return task.activity.findLast((row) => row.id === id && Number.isFinite(row.seq) && row.seq > floor);
}
// An entry takes its place when first seen in this turn and keeps it as it updates.
function placeActivity(task, entry) {
  const current = turnActivity(task, entry.id);
  if (!current) task.activity.push({ ...entry, seq: nextSeq(task) });
  else Object.assign(current, entry, { seq: current.seq ?? nextSeq(task) });
}
// Files, lines added and lines removed in a unified diff, headers not counted.
function diffNumbers(text) {
  let files = 0, added = 0, removed = 0;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { files, added, removed };
}
const MAX_STORED_TURN_DIFF = 2 * 1024 * 1024;
const PROJECT_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}){0,15}$/;
// A few upstream failures are ordinary situations wearing Codex's own English.
// Left alone they reach the person as "stream disconnected before completion:
// Incomplete response returned, reason: max_output_tokens", which says nothing
// about what to do -- and what to do is simply to carry on, because the thread
// and every file already written are still there. Anything not listed here
// passes through as it came: inventing a friendlier sentence for a failure
// nobody has read yet is how a real cause gets hidden.
export const UPSTREAM_FAILURES = Object.freeze([
  [/max_output_tokens/, "这一轮写得太长，超过了模型单次输出的上限，被从中间截断。已经改好的文件都还在，"
    + "直接说「继续」就能接着写。如果是在写一个很长的文件，让它分几次写。"],
  [/context[_ ]length|context window/i, "对话太长，模型装不下了。用下面的「压缩对话」收一收再继续。"],
  // Codex cannot find the file it keeps this conversation in. Seen when the
  // account's directory had been renamed under Codex's index (2026-09-23; the
  // index is now brought along, account-paths.js), shown as a raw sentence with
  // the machine's paths in it. Codex words it one of two ways (measured on
  // 0.155.0, test/codex-background-command.test.js).
  [/failed to resolve rollout path|no rollout found for thread id/, "找不到这段对话的记录文件，没法接着它继续。账号的数据目录被移动过时会这样：退出 i豆（⌘Q）再打开会自动找回。"
    + "还是不行的话，新建一个任务，把要做的事重新说一遍。"],
]);
export const upstreamFailure = (message) => {
  const text = String(message ?? "");
  return UPSTREAM_FAILURES.find(([pattern]) => pattern.test(text))?.[1] ?? text;
};

// How full the model's context is, as Codex reports it after each response:
// the last response's tokens (what the conversation now holds, not the
// thread's running total) and the model's window, when Codex knows it.
function contextUsage(usage) {
  const tokens = usage?.last?.totalTokens, window = usage?.modelContextWindow;
  if (!Number.isSafeInteger(tokens) || tokens < 0) return null;
  return { tokens, window: Number.isSafeInteger(window) && window > 0 ? window : null };
}
// What /review looks at, as Codex's review/start takes it: the uncommitted
// changes, the changes against a branch, one commit, or the person's own
// instructions. Checked here because Codex hands the branch and the commit to
// git: one that reads as an option, or is not a ref at all, is refused.
function reviewTarget(value) {
  if (value?.type === "uncommittedChanges") return { type: "uncommittedChanges" };
  if (value?.type === "baseBranch" && typeof value.branch === "string" && /^(?!-)[^\s~^:?*[\\\x00-\x1f\x7f]{1,200}$/.test(value.branch) && !value.branch.includes("..")) {
    return { type: "baseBranch", branch: value.branch };
  }
  if (value?.type === "commit" && typeof value.sha === "string" && /^[0-9a-f]{7,40}$/.test(value.sha)) {
    return { type: "commit", sha: value.sha, title: typeof value.title === "string" ? value.title.slice(0, 200) : null };
  }
  if (value?.type === "custom" && typeof value.instructions === "string" && value.instructions.trim() && value.instructions.length <= 10_000) {
    return { type: "custom", instructions: value.instructions.trim() };
  }
  throw new Error("无效的审查对象");
}
// Images pasted with a message. The desktop checks the bytes and writes them
// into its own folder (src/desktop/pasted-images.js); what reaches here is
// which images they are and where, and Codex sends them with the message.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function pastedImages(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 5 || value.some((image) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(image?.id ?? "")
    || !IMAGE_TYPES.has(image.type) || typeof image.path !== "string" || !path.isAbsolute(image.path))) throw new Error("无效的图片");
  return value.map((image) => ({ id: image.id, type: image.type, path: image.path }));
}
// Codex's own reading of a command, bounded: a read of a file, a listing, a
// search, or unknown. Paths and queries are the Agent's, shown as text.
function commandActions(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const text = (item, max) => (typeof item === "string" ? item.slice(0, max) : null);
  return value.slice(0, 20).filter((item) => ["read", "listFiles", "search", "unknown"].includes(item?.type))
    .map((item) => ({ type: item.type, ...(text(item.path, 400) ? { path: text(item.path, 400) } : {}), ...(text(item.name, 200) ? { name: text(item.name, 200) } : {}),
      ...(text(item.query, 200) ? { query: text(item.query, 200) } : {}), ...(item.type === "unknown" && text(item.command, 300) ? { command: text(item.command, 300) } : {}) }));
}

export class TaskService extends EventEmitter {
  // `checkpoints` ({ take(cwd), changes(cwd, commit), restore(cwd, commit), release(cwd, commit) },
  // checkpoints.js): a coding turn's folder before it starts, so taking the turn
  // back can put the files back too. Absent, a turn is taken back as before.
  constructor({ store, runtimeFactory, skillResolver = null, proposalGenerator = null, knowledgeResolver = null, contextResolver = (task, input) => prepareTaskContext(task.cwd, input), checkpoints = null, approvalRules = null,
    queue = null, queueConfigRevision = task => taskQueueConfigRevision(task), canDispatchQueued = () => true, writesSettled = () => Promise.resolve(false) }) {
    super(); this.store = store; this.runtimeFactory = runtimeFactory; this.contextResolver = contextResolver; this.skillResolver = skillResolver; this.knowledgeResolver = knowledgeResolver;
    this.checkpoints = checkpoints;
    // Commands a coding project may run without asking again (approval-rules.js).
    // When this task's write through the Agent bridge is done, and whether
    // there was one to wait for (agent-bridge.js).
    this.writesSettled = writesSettled;
    this.approvalRules = approvalRules;
    this.tasks = new Map(); this.active = new Map(); this.starting = new Set(); this.approvals = new Map(); this.closing = false;
    this.queue = queue; this.queueConfigRevision = queueConfigRevision; this.canDispatchQueued = canDispatchQueued; this.queueDraining = new Map(); this.queueDispatching = new Map();
    this.proposalGenerator = proposalGenerator;
  }
  async init() {
    await this.queue?.init();
    const { tasks, warnings } = await this.store.load();
    this.warnings = warnings;
    for (const task of tasks) {
      backfillOrder(task);
      let migrated = false;
      // Older planning records kept their future execution permission in the
      // effective permission field. That made a legacy `full` preference look
      // inheritable. Make the actual read-only state explicit and give records
      // without a task-owned target the safe fallback.
      if (task.mode === "coding" && task.stage === "planning") {
        if (task.permission !== "plan") { task.permission = "plan"; migrated = true; }
        if (!isExecutionPermission(task.executionPermission)) { task.executionPermission = DEFAULT_PERMISSION; migrated = true; }
        if (!task.planningKind) { task.planningKind = "initial"; migrated = true; }
        if (!Number.isSafeInteger(task.planningAfterSeq)) { task.planningAfterSeq = 0; migrated = true; }
      } else if (task.mode === "coding" && task.permission === "plan") {
        task.stage = "planning";
        task.executionPermission = DEFAULT_PERMISSION;
        task.planningKind = "explicit";
        task.planningAfterSeq = 0;
        migrated = true;
      }
      if (RUNNING.has(task.status)) {
        task.status = "interrupted"; task.error = "应用已退出，上次任务未完成；可继续对话。";
        migrated = true;
      }
      if (migrated) await this.store.save(task);
      this.tasks.set(task.id, task);
    }
  }
  snapshot() {
    return { tasks: [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((task) => {
      const execution = this.active.get(task.id);
      return { ...clone(task), ...(this.queue ? { queue: this.queue.snapshot(task.id) } : {}), runtime: { canSteer: task.status === "running" && Boolean(execution?.client && execution.turnId) } };
    }), approvals: [...this.approvals.values()].map((item) => clone(item.public)), warnings: [...this.warnings, ...(this.queue?.warnings ?? [])] };
  }
  get(id) {
    const task = this.tasks.get(validateTaskId(id));
    if (!task) throw new Error("找不到这个任务");
    return task;
  }
  changed() { this.emit("changed", this.snapshot()); }
  async releaseCheckpoints(task, messages, retained = task.messages) {
    if (!this.checkpoints?.release) return;
    const stillUsed = new Set(retained.map((message) => message?.turn?.checkpoint).filter(Boolean));
    const discarded = [...new Set(messages.map((message) => message?.turn?.checkpoint).filter((checkpoint) => checkpoint && !stillUsed.has(checkpoint)))];
    await Promise.allSettled(discarded.map((checkpoint) => this.checkpoints.release(task.cwd, checkpoint)));
  }
  async create({ mode, cwd, permission = DEFAULT_PERMISSION, enterpriseSkill, mcpConnection }) {
    if (this.closing) throw new Error("应用正在退出");
    getMode(mode); getPermission(permission);
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("请选择有效的工作目录");
    await requireTaskDirectory(cwd);
    const executionPermission = isExecutionPermission(permission) ? permission : DEFAULT_PERMISSION;
    const task = { schemaVersion: 1, id: randomUUID(), mode, cwd, permission: mode === "coding" ? "plan" : permission, title: mode === "coding" ? "新编程任务" : "新工作任务",
      status: "idle", createdAt: Date.now(), updatedAt: Date.now(), messages: [], activity: [], seq: 0, codexThreadId: null, error: null,
      // A coding task looks before it touches anything, the way Codex and
      // Claude Code do. It stays here until the person says 开始做; a work task
      // has no repository to plan against and starts building straight away.
      ...(mode === "coding" ? { stage: "planning", planningKind: "initial", planningAfterSeq: 0, executionPermission } : {}),
      ...(enterpriseSkill ? { enterpriseSkill: { ...skillReference(enterpriseSkill), confirmedAt: Date.now() } } : {}),
      ...(mcpConnection ? { mcpConnection: clone(mcpConnection) } : {}) };
    await this.store.save(task); this.tasks.set(task.id, task); this.changed(); return clone(task);
  }
  // The person read the plan and said go. From here the task uses the
  // permission they chose, and every later turn builds -- Codex and Claude Code
  // plan once per task too, not once per message.
  //
  // It is a normal turn, so it stops at the same approvals and shows the same
  // diff; the only thing that changed is that a read-only stage ended, which is
  // why this and nothing else may end it.
  async startBuilding(id, { send } = {}) {
    const task = this.get(id);
    if (task.mode !== "coding") throw new Error("只有编程任务有方案这一步");
    if (this.starting.has(id)) throw new Error("这个任务正在开始执行");
    if (this.queueDispatching.has(id)) throw new Error("下一轮消息正在派发，请稍候");
    if (task.stage !== "planning") throw new Error("这个任务已经在做了");
    if (RUNNING.has(task.status)) throw new Error("请等这一轮结束");
    const after = Number.isSafeInteger(task.planningAfterSeq) ? task.planningAfterSeq : -1;
    if (!task.messages.some((message) => message.role === "assistant" && (!Number.isSafeInteger(message.seq) || message.seq > after))) throw new Error("还没有方案可以开始");
    const previous = clone(task), next = clone(task);
    next.permission = executionPermissionForTask(task);
    next.stage = "building";
    delete next.planningKind;
    delete next.planningAfterSeq;
    next.updatedAt = Date.now();
    this.starting.add(id);
    try {
      await this.queue?.pause(id, "任务从规划切换为执行；请核对排队内容后继续", { ifPresent: true });
      // Persist before the runtime can start. The in-memory snapshot changes
      // only after that write succeeds, so a disk error cannot silently widen
      // a planning task.
      await this.store.save(next);
      this.tasks.set(id, next); this.changed();
      try {
        // Not authored by the person, so ↑ in the box never offers it back.
        if (send !== false) {
          const plannedAction = task.messages.findLast((message) => message.role === "user" && !message.steered
            && message.planningAction === "init" && (!Number.isSafeInteger(message.seq) || message.seq > after));
          const instruction = plannedAction
            ? "按上面的方案生成或更新 AGENTS.md。现在开始执行，可以按本任务原先选择的权限写文件；不要只重复计划。"
            : "按上面的方案开始做。";
          await this.send(id, instruction, undefined, { authored: false });
        }
      } catch (error) {
        // `send` only rejects before a turn has been dispatched. Restore the
        // plan so the one visible button can be retried, and keep the reason.
        if (!this.active.has(id)) {
          const restored = { ...previous, error: `开始执行失败：${String(error.message).slice(0, 1900)}`, updatedAt: Date.now() };
          await this.store.save(restored);
          this.tasks.set(id, restored); this.changed();
        }
        throw error;
      }
      return clone(this.get(id));
    } finally { this.starting.delete(id); }
  }

  // A task is named after what was asked, and the name is the person's to
  // change afterwards. Renaming touches nothing the model sees.
  async rename(id, title) {
    if (this.closing) throw new Error("应用正在退出");
    const task = this.get(id);
    const clean = String(title ?? "").replace(/\s+/g, " ").trim();
    if (!clean) throw new Error("请输入任务名称");
    if (clean.length > 60) throw new Error("任务名称最多 60 个字");
    task.title = clean; task.updatedAt = Date.now();
    await this.store.save(task); this.changed();
    return clone(task);
  }

  // Removes the record of the conversation. The working directory is left
  // alone: it holds the files the person attached and the results that were
  // produced, and deleting those is a separate decision they make in Finder.
  async remove(id) {
    if (this.closing) throw new Error("应用正在退出");
    const task = this.get(id);
    if (this.active.has(id)) throw new Error("这个任务正在执行，停止后才能删除");
    await this.store.remove(id);
    await this.queue?.removeTask(id);
    this.tasks.delete(id);
    for (const [approvalId, approval] of this.approvals) if (approval.public.taskId === id) this.approvals.delete(approvalId);
    await this.releaseCheckpoints(task, task.messages, []);
    this.changed();
    return { id, cwd: task.cwd };
  }

  // A long conversation eventually costs more in context than it is worth.
  // Codex can summarise its own history; this asks it to, waits for that to
  // finish, and records that it happened — the messages on screen are the
  // person's record and are not rewritten.
  async compact(id) {
    if (this.closing) throw new Error("应用正在退出");
    const task = this.get(id);
    if (this.active.has(id)) throw new Error("这个任务正在执行，停止后才能压缩");
    if (!task.codexThreadId) throw new Error("这个任务还没有开始对话，不需要压缩");
    await this.withThread(task, async (client) => {
      // `thread/compact/start` is itself the turn, so this waits for that turn
      // rather than starting another one the way an ordinary message would.
      const finished = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { done(new Error("压缩超过 5 分钟没有完成")); }, 5 * 60_000);
        const onNotification = (message) => {
          if (message.method === "turn/completed" && message.params?.threadId === task.codexThreadId) done(null, message.params.turn);
        };
        const onStopped = (error) => done(error || new Error("Codex 运行时已退出"));
        function done(error, turn) {
          clearTimeout(timer);
          client.off("notification", onNotification); client.off("stopped", onStopped);
          if (error) reject(error); else resolve(turn);
        }
        client.on("notification", onNotification); client.on("stopped", onStopped);
      });
      await client.request("thread/compact/start", { threadId: task.codexThreadId });
      const turn = await finished.catch((error) => { throw new Error(`压缩未完成：${error.message}`); });
      if (turn?.status && turn.status !== "completed") throw new Error(`压缩未完成：${turn.error?.message || turn.status}`);
    });
    // Smaller now; the next response says by how much.
    task.compactedAt = Date.now(); task.contextUsage = null; task.updatedAt = Date.now();
    await this.store.save(task); this.changed();
    return clone(task);
  }

  // Undo the last exchanges: Codex drops them from what the model will see, and
  // the transcript here is trimmed to match so the two do not disagree. Files
  // already written are not reverted — the working directory is not a snapshot.
  // What taking back the last `turns` turns would do to the files: the
  // snapshot from before the earliest of them, compared with the folder now.
  // For the confirmation, which names every file before anything happens.
  async undoPreview(id, turns = 1) {
    const task = this.get(id);
    const opened = task.messages.filter((message) => message.role === "user" && !message.steered);
    const first = opened[opened.length - turns];
    const checkpoint = first?.turn?.checkpoint;
    if (!checkpoint || !this.checkpoints) return { restorable: false, reason: task.mode !== "coding" ? "work" : "none" };
    return { restorable: true, files: await this.checkpoints.changes(task.cwd, checkpoint) };
  }

  async rollback(id, turns = 1, { restoreFiles = false } = {}) {
    if (this.closing) throw new Error("应用正在退出");
    const task = this.get(id);
    if (this.active.has(id)) throw new Error("这个任务正在执行，停止后才能回退");
    if (!Number.isInteger(turns) || turns < 1 || turns > 50) throw new Error("回退轮数必须是 1 到 50 之间的整数");
    // A turn begins with what the person asked; words added mid-turn belong to
    // it and go with it, as Codex drops the whole turn.
    const userMessages = task.messages.filter((message) => message.role === "user" && !message.steered);
    if (userMessages.length < turns) throw new Error("这个任务还没有那么多轮对话");
    if (!task.codexThreadId) throw new Error("这个任务还没有开始对话");
    const opened = task.messages.filter((message) => message.role === "user" && !message.steered);
    const first = opened[opened.length - turns];
    const checkpoint = first?.turn?.checkpoint;
    if (restoreFiles && (!checkpoint || !this.checkpoints)) throw new Error("这一轮之前没有文件快照，无法恢复文件");
    // The conversation: a fork of the thread from before the first turn taken
    // back -- what the pinned Codex supports; `thread/rollback` is deprecated and
    // refuses paginated threads ("paginated threads do not support
    // thread/rollback", measured on 0.155.0). The fork leaves the old thread as
    // it was, so nothing is lost if the files cannot be put back next. A turn
    // from before turn ids were kept can only be rolled back the old way.
    let thread = task.codexThreadId;
    await this.withThread(task, async (client) => {
      if (typeof first?.turn?.codexTurnId === "string") {
        const forked = await client.request("thread/fork", { threadId: task.codexThreadId, beforeTurnId: first.turn.codexTurnId, excludeTurns: true });
        if (typeof forked?.thread?.id !== "string") throw new Error("Codex 没有返回分叉后的对话");
        thread = forked.thread.id;
      } else {
        if (restoreFiles) await this.checkpoints.restore(task.cwd, checkpoint);
        await client.request("thread/rollback", { threadId: task.codexThreadId, numTurns: turns });
      }
    }, { experimental: typeof first?.turn?.codexTurnId === "string" });
    // Then the files. Only once both are done does the task move to the fork.
    if (restoreFiles && thread !== task.codexThreadId) await this.checkpoints.restore(task.cwd, checkpoint);
    task.codexThreadId = thread;
    const cut = task.messages.indexOf(userMessages[userMessages.length - turns]);
    // What the earlier turns did stays in their record; only what came from the
    // turns taken back goes with them.
    const cutSeq = task.messages[cut].seq, discarded = task.messages.slice(cut);
    task.messages = task.messages.slice(0, cut);
    task.activity = Number.isSafeInteger(cutSeq) ? task.activity.filter((row) => Number.isSafeInteger(row.seq) && row.seq < cutSeq) : [];
    task.plan = null; task.error = null; task.contextUsage = null; task.updatedAt = Date.now();
    await this.store.save(task);
    await this.releaseCheckpoints(task, discarded);
    this.changed();
    return clone(task);
  }

  async enqueue(id, { clientRequestId, text, context = null, options = null } = {}) {
    if (!this.queue) throw new Error("当前版本没有启用下一轮队列");
    if (this.closing) throw new Error("应用正在退出");
    const task = this.get(id);
    if (!RUNNING.has(task.status) && !this.queue.snapshot(id).paused) throw new Error("当前任务已经空闲，请直接发送这一轮");
    const mentions = normalizeMentions(options?.mentions), references = normalizeFileReferences(options?.references), images = pastedImages(options?.images);
    const review = options?.review === undefined || options?.review === null ? null : reviewTarget(options.review);
    const commandInput = options?.command;
    if (commandInput !== undefined && commandInput !== null && (!PROJECT_COMMAND_NAME.test(commandInput?.name ?? "")
      || typeof commandInput.source !== "string" || !commandInput.source || commandInput.source.length > 300)) throw new Error("无效的项目命令");
    const command = commandInput ? { name: commandInput.name, source: commandInput.source } : null;
    if (review && task.mode !== "coding") throw new Error("只有编程任务可以排队代码审查");
    if (references.some(reference => reference.kind === "diff") && task.mode !== "coding") throw new Error("只有编程任务可以引用代码差异");
    if (references.some(reference => reference.kind === "page") && task.mode !== "coding") throw new Error("只有编程任务可以引用网页预览");
    if (images.length && (task.mode !== "coding" || review)) throw new Error("图片只能随编程任务的下一轮消息发送");
    if (command && (task.mode !== "coding" || review)) throw new Error("项目命令只能在编程任务里用");
    const capturedConfigRevision = await this.queueConfigRevision(task);
    const entry = await this.queue.enqueue(id, { clientRequestId, text,
      ...(context ? { context: clone(context) } : {}), ...((mentions.length || references.length || images.length || review || command) ? { options: {
        ...(mentions.length ? { mentions } : {}), ...(references.length ? { references } : {}), ...(images.length ? { images } : {}), ...(review ? { review } : {}), ...(command ? { command } : {}),
      } } : {}) }, capturedConfigRevision);
    this.changed();
    if (!this.active.has(id) && task.status === "completed" && !task.error) void this.drainQueue(id);
    return clone(entry);
  }

  async updateQueued(id, queueId, expectedRevision, value) {
    if (!this.queue) throw new Error("当前版本没有启用下一轮队列");
    this.get(id);
    const current = this.queue.snapshot(id).entries.find(entry => entry.id === queueId);
    if (!current) throw new Error("找不到这条下一轮记录");
    const entry = await this.queue.update(id, queueId, expectedRevision, { ...current.payload, text: value?.text }); this.changed(); return entry;
  }

  async removeQueued(id, queueId, expectedRevision) {
    if (!this.queue) throw new Error("当前版本没有启用下一轮队列");
    this.get(id); const entry = await this.queue.remove(id, queueId, expectedRevision); this.changed(); return entry;
  }

  async setQueuePaused(id, paused) {
    if (!this.queue || typeof paused !== "boolean") throw new Error("下一轮队列操作无效");
    const task = this.get(id);
    if (paused) { const result = await this.queue.pause(id, "你暂停了下一轮队列"); this.changed(); return result; }
    if (this.active.has(id) || this.starting.has(id) || RUNNING.has(task.status)) throw new Error("请等当前轮结束或先停止，再继续队列");
    const revision = await this.queueConfigRevision(task), result = await this.queue.resume(id, revision); this.changed();
    void this.drainQueue(id, { manual: true }); return result;
  }

  async pauseQueues(reason) {
    if (!this.queue) return;
    if (this.queueDispatching.size) throw new Error("下一轮消息正在派发，请稍候再更改模型");
    await this.queue.pauseAll(reason); this.changed();
  }

  drainQueue(id, { manual = false } = {}) {
    if (!this.queue || this.closing) return Promise.resolve();
    const prior = this.queueDraining.get(id); if (prior) return prior;
    const run = (async () => {
      const task = this.get(id);
      if (this.active.has(id) || this.starting.has(id) || this.queueDispatching.has(id)) return;
      let token = null, accepted = false, entry = null;
      try {
        if (!manual && (task.status !== "completed" || task.error)) return;
        if (currentTurnHasUncertainResult(task)) { await this.queue.pause(id, "上一轮写入结果待核对；确认结果前不会自动启动下一轮"); this.changed(); return; }
        const permitted = await this.canDispatchQueued(task);
        if (permitted !== true) { await this.queue.pause(id, typeof permitted === "string" ? permitted : "仍有确认或结果待核对；下一轮队列已暂停"); this.changed(); return; }
        token = Symbol(id); this.queueDispatching.set(id, token);
        const revision = await this.queueConfigRevision(task); entry = await this.queue.begin(id, revision); this.changed(); if (!entry) return;
        await this.send(id, entry.payload.text, entry.payload.context, entry.payload.options ?? {}, token); accepted = true;
        const turnKey = this.get(id).messages.findLast(message => message.role === "user" && !message.steered)?.id;
        await this.queue.dispatched(id, entry.id, turnKey); this.changed();
      } catch (error) {
        if (!accepted) {
          if (entry) await this.queue.failed(id, entry.id, `派发前检查失败：${String(error.message).slice(0, 420)}`, { unknown: false }).catch(() => {});
          else await this.queue.pause(id, `派发前检查失败：${String(error.message).slice(0, 420)}`).catch(() => {});
        } else await this.queue.pause(id, "下一轮已交给运行时，但本地回执保存失败；不会自动重试").catch(() => {});
        this.changed();
      } finally { if (token && this.queueDispatching.get(id) === token) this.queueDispatching.delete(id); }
    })().finally(() => { if (this.queueDraining.get(id) === run) this.queueDraining.delete(id); });
    this.queueDraining.set(id, run); return run;
  }

  // Adding to a turn that is already running, instead of stopping it and losing
  // what it has done. Codex delivers the text to the model mid-turn.
  async steer(id, text) {
    const clean = String(text ?? "").trim();
    if (!clean) throw new Error("请输入要补充的内容");
    const task = this.get(id);
    const execution = this.active.get(id);
    if (!execution?.client || !task.codexThreadId) throw new Error("这个任务没有正在执行的对话");
    if (task.status !== "running") throw new Error(task.status === "awaiting_approval" ? "请先处理当前确认；补充内容仍保留在草稿中" : "这个任务当前不能补充；内容仍保留在草稿中");
    // Codex needs the exact turn being steered, so a message meant for one turn
    // can never land in the next one.
    if (!execution.turnId) throw new Error("这一轮还没开始，请等一下再补充");
    await execution.client.request("turn/steer", { threadId: task.codexThreadId, expectedTurnId: execution.turnId,
      input: [{ type: "text", text: clean, text_elements: [] }] });
    task.messages.push({ id: randomUUID(), role: "user", text: clean, steered: true, createdAt: Date.now(), seq: nextSeq(task) });
    task.updatedAt = Date.now();
    await this.store.save(task); this.changed();
    return clone(task);
  }

  // One short-lived runtime for an operation on a task that is not running.
  // Whatever happens, the process is stopped again.
  async withThread(task, run, { experimental = false } = {}) {
    const { client, params } = await this.runtimeFactory(task, null);
    if (experimental) client.capabilities = { experimentalApi: true };
    await client.start();
    try {
      // The conversation has to be loaded before anything can be done to it;
      // a fresh runtime knows nothing about a thread from an earlier session.
      await client.request("thread/resume", { ...params, threadId: task.codexThreadId });
      return await run(client);
    } finally { await client.stop().catch(() => {}); }
  }

  async setKnowledgeScope(id, value) {
    if (this.closing) throw new Error("应用正在退出");
    const task = this.get(id);
    if (task.mode !== "cowork") throw new Error("知识范围属于工作任务");
    const scope = knowledgeScope(value);
    if (this.active.has(id) || this.queueDispatching.has(id)) throw new Error("这个任务正在执行，停止后才能改知识范围");
    await this.queue?.pause(id, "知识范围已变化；请核对排队内容后继续", { ifPresent: true });
    task.knowledgeScope = scope.mode === "off" ? null : scope;
    task.updatedAt = Date.now();
    await this.store.save(task); this.changed(); return clone(task);
  }
  async setPermission(id, permission) {
    if (this.closing) throw new Error("应用正在退出");
    const task = this.get(id);
    getPermission(permission);
    // Refused while the task is running: a turn must finish under the rules it
    // was started with, or an approval already on screen would mean something
    // different by the time it is answered.
    if (this.active.has(id) || this.starting.has(id) || this.queueDispatching.has(id)) throw new Error("这个任务正在执行，停止后才能改权限模式");
    const next = clone(task);
    if (task.mode === "coding") {
      if (permission === "plan") {
        // Re-selecting plan must not replace the task-owned target with plan or
        // with a preference chosen in some other task.
        if (task.stage === "planning") return clone(task);
        next.executionPermission = isExecutionPermission(task.permission) ? task.permission : DEFAULT_PERMISSION;
        next.permission = "plan";
        next.stage = "planning";
        next.planningKind = "explicit";
        next.planningAfterSeq = Number.isSafeInteger(task.seq) ? task.seq : 0;
      } else if (task.stage === "planning") {
        next.executionPermission = permission;
        next.permission = "plan";
      } else {
        if (task.permission === permission) return clone(task);
        next.permission = permission;
        next.executionPermission = permission;
      }
    } else {
      if (task.permission === permission) return clone(task);
      next.permission = permission;
    }
    await this.queue?.pause(id, "权限模式已变化；旧的排队内容不会自动扩大权限", { ifPresent: true });
    next.updatedAt = Date.now();
    await this.store.save(next);
    this.tasks.set(id, next); this.changed(); return clone(next);
  }
  async send(id, text, contextInput, { mentions: mentionInput, references: referenceInput, review: reviewInput, images: imageInput, command: commandInput, planningAction: planningActionInput, authored = true } = {}, queueToken = null) {
    if (this.closing) throw new Error("应用正在退出");
    if (typeof text !== "string" || !text.trim() || text.length > 100_000) throw new Error("请输入 1–100000 字的任务内容");
    // Checked before anything starts, so a malformed pick fails the send
    // outright instead of half-starting a turn.
    const mentions = normalizeMentions(mentionInput);
    const requestedReferences = normalizeFileReferences(referenceInput);
    const review = reviewInput === undefined || reviewInput === null ? null : reviewTarget(reviewInput);
    const images = pastedImages(imageInput);
    // A project's own slash command the message came from, to say so beside it.
    if (commandInput !== undefined && commandInput !== null && (!PROJECT_COMMAND_NAME.test(commandInput?.name ?? "")
      || typeof commandInput.source !== "string" || !commandInput.source || commandInput.source.length > 300)) throw new Error("无效的项目命令");
    const command = commandInput ? { name: commandInput.name, source: commandInput.source } : null;
    const task = this.get(id);
    if (planningActionInput !== undefined && planningActionInput !== null && planningActionInput !== "init") throw new Error("规划操作无效");
    const planningAction = planningActionInput ?? null;
    if (this.queueDispatching.has(id) && this.queueDispatching.get(id) !== queueToken) throw new Error("下一轮消息正在派发，请稍候");
    if (review && task.mode !== "coding") throw new Error("只有编程任务可以审查代码");
    if (requestedReferences.some((reference) => reference.kind === "diff") && task.mode !== "coding") throw new Error("只有编程任务可以引用代码差异");
    if (requestedReferences.some((reference) => reference.kind === "page") && task.mode !== "coding") throw new Error("只有编程任务可以引用网页预览");
    if (requestedReferences.some((reference) => reference.kind === "terminal") && task.mode !== "coding") throw new Error("只有编程任务可以引用终端输出");
    if (images.length && (task.mode !== "coding" || review)) throw new Error("图片只能随编程任务的消息发送");
    if (command && (task.mode !== "coding" || review)) throw new Error("项目命令只能在编程任务里用");
    if (planningAction && (task.mode !== "coding" || task.stage !== "planning" || review)) throw new Error("只有编程任务的规划阶段可以准备此操作");
    if (this.active.has(id)) throw new Error(this.active.get(id).awaitingWrite ? "这个任务还有一张确认卡片等你处理：点确认或取消之后再发送" : "这个任务仍在执行，请等待或停止后再发送");
    if (this.active.size >= 3) throw new Error("最多同时运行 3 个任务");
    const previous = clone(task);
    const execution = { controller: new AbortController(), client: null, promise: null, done: Promise.withResolvers(), ...(review ? { review } : {}), ...(images.length ? { images } : {}) };
    this.active.set(id, execution);
    let context;
    let references;
    try {
      // This check belongs behind the single-flight marker: otherwise the stat
      // await opens a window where a second send or a permission change can
      // start against the same task. It is still before message persistence,
      // context reads, runtime startup or any other work.
      await requireTaskDirectory(task.cwd);
      references = await prepareFileReferences(task.cwd, requestedReferences, { resolveDiff: (request) => taskProjectDiff(task, request, {
        readText: async (file) => (await readWorkspaceFile(task.cwd, file)).text,
      }) });
      context = await this.contextResolver(task, contextInput, { signal: execution.controller.signal });
      if (context?.intent === "propose-edit" && ["feishu-document", "feishu-sheet", "feishu-base"].includes(context.kind)) {
        if (!this.proposalGenerator) throw new Error("当前连接不支持无工具修改建议");
        execution.proposalInput = clone(contextInput);
        execution.proposalContext = clone(context);
      }
      // A proposal turn is a closed, tool-free rewrite of one selection; adding
      // unrelated documents to it would only invite the model to drift.
      // Retrieval re-reads documents over the network, so it fails the way a
      // network does. The question is the person's, not the knowledge copy's:
      // a failed search costs this turn its excerpts and says so, in the record
      // and to the model, instead of refusing to send what they typed.
      if (task.knowledgeScope && this.knowledgeResolver && !execution.proposalInput) {
        try {
          execution.knowledge = await this.knowledgeResolver(task.knowledgeScope, text.trim(), { signal: execution.controller.signal });
        } catch (error) {
          if (execution.controller.signal.aborted) throw error;
          execution.knowledge = { evidence: [], unavailable: 0, failed: String(error?.message ?? "").slice(0, 200) };
        }
      }
      if (task.enterpriseSkill && !execution.proposalInput && !review) {
        if (!this.skillResolver) throw new Error("当前连接不能使用此企业技能");
        execution.skill = await this.skillResolver(task.enterpriseSkill, execution.controller.signal, task.mcpConnection);
      }
      // What is in the task folder is read fresh every turn: the person may have
      // added a spreadsheet since the last message, and the Agent may have
      // written a result the turn before. A proposal turn is a closed rewrite
      // of one selection, so it is left alone. A coding task's folder is a
      // repository the Agent explores with its own tools: calling its top level
      // files the person handed over, whose outputs want Chinese names, would be
      // wrong there.
      if (!execution.proposalInput && task.mode !== "coding") execution.taskFiles = await listTaskFiles(task.cwd).catch(() => []);
      if (execution.controller.signal.aborted) throw new Error("发送已取消");
    } catch (error) {
      await execution.skill?.close().catch(() => {});
      // Restore content/state, but surface this rejected attempt's diagnostic.
      // Otherwise a snapshot re-render can hide a fresh source denial behind an
      // older proposal error. No rejected prompt/context is retained or executed.
      previous.error = String(error.message).slice(0, 2000);
      this.tasks.set(id, previous); this.active.delete(id); execution.done.resolve(); this.changed(); throw error;
    }
    task.messages.push({ id: randomUUID(), role: "user", text: text.trim(), ...(authored ? {} : { authored: false }), ...(context ? { context } : {}), ...(mentions.length ? { mentions } : {}), ...(references.length ? { references } : {}), ...(execution.skill ? { skill: execution.skill.reference } : {}), ...(review ? { review } : {}), ...(planningAction ? { planningAction } : {}),
      ...(images.length ? { images: images.map((image) => ({ id: image.id, type: image.type })) } : {}), ...(command ? { command } : {}),
      // Which documents went with the question, so the answer can be checked
      // against them instead of taken on trust.
      ...(execution.knowledge ? { knowledge: { documents: execution.knowledge.evidence?.length ?? 0, unavailable: execution.knowledge.unavailable ?? 0,
        sources: knowledgeSources(execution.knowledge.evidence), ...(execution.knowledge.failed ? { failed: execution.knowledge.failed } : {}) } } : {}), createdAt: Date.now(),
      // Where it stands in the turn's record, and when the turn ran: what the
      // conversation lays out in order, and closes with how long it took.
      seq: nextSeq(task), turn: { startedAt: Date.now() } });
    if (task.messages.length === 1) task.title = taskTitle(text);
    // When this turn started, so the interface can say how long it has been
    // going. `updatedAt` moves with every streamed token and would report a
    // silent turn as if it had just begun.
    task.status = "running"; task.error = null; task.plan = null; task.startedAt = Date.now(); task.updatedAt = Date.now();
    if (task.mcpConnection) task.mcpStatus = [];
    try { await this.store.save(task); }
    catch (error) { await execution.skill?.close().catch(() => {}); this.tasks.set(id, previous); this.active.delete(id); execution.done.resolve(); throw error; }
    this.changed();
    const files = taskFilesPrompt(execution.taskFiles ?? []);
    const body = [text.trim(), mentionsPrompt(mentions), fileReferencesPrompt(references), files].filter(Boolean).join("\n\n");
    const prompt = knowledgePrompt(contextualPrompt(body, context), execution.knowledge?.evidence, { unavailable: execution.knowledge?.unavailable ?? 0, failed: execution.knowledge?.failed });
    execution.promise = this.execute(task, prompt, execution).finally(() => execution.done.resolve());
    return clone(task);
  }
  async execute(task, text, execution) {
    let checkpoint;
    let persistenceFailure;
    const saveCheckpoint = () => this.store.save(task).catch((error) => { persistenceFailure = error; execution.controller.abort(); });
    try {
      if (execution.controller.signal.aborted) return;
      if (execution.proposalInput) {
        let answer = await this.proposalGenerator(text, execution.controller.signal, execution.proposalContext);
        await this.contextResolver(task, execution.proposalInput, { signal: execution.controller.signal });
        execution.controller.signal.throwIfAborted();
        if (execution.proposalContext.kind === "feishu-sheet") answer = JSON.stringify(sheetEditProposal(answer, execution.proposalContext));
        else if (execution.proposalContext.kind === "feishu-base") answer = JSON.stringify(baseEditProposal(answer, execution.proposalContext));
        this.upsertMessage(task, randomUUID(), answer); task.status = "completed"; return;
      }
      // The folder as it is before the Agent can touch it. A folder that is not
      // a repository, or a snapshot that fails, leaves this turn without one --
      // it still runs; taking it back then leaves the files as they are.
      if (task.mode === "coding" && this.checkpoints) {
        const checkpoint = await this.checkpoints.take(task.cwd).catch(() => null);
        const opened = task.messages.findLast((message) => message.role === "user" && !message.steered);
        if (checkpoint && opened?.turn) opened.turn = { ...opened.turn, checkpoint };
        if (execution.controller.signal.aborted) return;
      }
      const { client, params, prepare, mcpConnectionIds, builtinConnections, secrets } = await this.runtimeFactory(task, execution.skill);
      execution.client = client;
      execution.redact = redactor(secrets);
      // Which MCP servers may legitimately raise an elicitation this turn: the
      // task's own bound connection plus any app-owned built-in connectors.
      execution.mcpConnectionIds = mcpConnectionIds ?? [];
      // Which of them are the app's own, by id, with the name 技能中心 gives
      // them: what one answer to a card may cover depends on it
      // (mcp-approval-policy.js).
      execution.builtinConnections = new Map((builtinConnections ?? []).filter((row) => typeof row?.id === "string").map((row) => [row.id, typeof row.title === "string" && row.title ? row.title : row.id]));
      if (execution.controller.signal.aborted) return;
      client.on("notification", (message) => this.notification(task, message));
      client.on("serverRequest", (request) => this.requestApproval(task, execution, request));
      await client.start();
      if (execution.controller.signal.aborted) return;
      const skillInput = execution.skill ? await registerTaskSkill(client, task.cwd, execution.skill) : null;
      if (execution.controller.signal.aborted) return;
      // A review is Codex's own long look at the changes. At high effort MiniMax-M3
      // thought past its output limit on a three-file diff once, and for ten
      // minutes the next time (measured 2026-09-19); at medium it answers. Codex
      // gives its review whatever effort the thread has (measured on 0.155.0).
      const threadParams = execution.review ? { ...params, config: { ...(params?.config ?? {}), model_reasoning_effort: "medium" } } : params;
      const started = await client.request(task.codexThreadId ? "thread/resume" : "thread/start", {
        ...threadParams, ...(task.codexThreadId ? { threadId: task.codexThreadId } : {}),
      });
      task.codexThreadId = started.thread.id;
      // Every thread this turn may legitimately speak on: the task's own, plus
      // any subagent thread it spawns. It lives on the execution, so it dies
      // with the turn and a later turn never inherits a stale child id.
      execution.threads = new Set([task.codexThreadId]);
      if (prepare) { task.mcpStatus = await prepare(client, task.codexThreadId); this.changed(); }
      await this.store.save(task);
      checkpoint = setInterval(saveCheckpoint, 1000);
      if (execution.skill) await execution.skill.beforeTurn();
      // A skill the person picked for this one task, through a confirmation that
      // named it, is invoked: named in the message and its SKILL.md sent with it,
      // which is what they asked for. A shelf skill is switched on once in
      // 技能中心 and rides along on every task of its kind, so it is only
      // offered, the way Codex and Claude Code offer every skill they have:
      // registered above, it is in the list of skills the model reads each turn
      // -- name, description, and where its SKILL.md is -- and the model opens
      // it when a request is what it describes. Sending its SKILL.md along was
      // invoking it all the same (the <skill> item is what Codex itself adds for
      // `$name`): a 周报摘要助手 whose instructions open every answer with a
      // banner opened a question about a budget with it (measured on Codex
      // 0.155.0, 2026-09-21).
      const invoked = Boolean(skillInput) && !skillInput.name.startsWith("local-");
      const input = [{ type: "text", text: invoked ? `$${skillInput.name}\n${text}` : text, text_elements: [] },
        ...(execution.images ?? []).map((image) => ({ type: "localImage", path: image.path })), ...(invoked ? [skillInput] : [])];
      const turn = await runTurn(client, { threadId: task.codexThreadId, input, signal: execution.controller.signal,
        // /review is Codex's own review of the changes -- its guidelines, its
        // prioritised findings -- run as a turn on this thread.
        ...(execution.review ? { start: () => client.request("review/start", { threadId: task.codexThreadId, target: execution.review, delivery: "inline" }) } : {}),
        relatedThreads: execution.threads, onTurn: (turnId) => {
          execution.turnId = turnId;
          // Kept on the turn, so taking it back can fork the thread before it.
          // A review's is the one it starts with instead (turn/started below).
          const opened = task.messages.findLast((message) => message.role === "user" && !message.steered);
          if (opened?.turn && typeof turnId === "string" && !execution.review) opened.turn = { ...opened.turn, codexTurnId: turnId };
          // This volatile readiness is part of the input contract. Publishing it
          // immediately keeps text entered during startup from being presented
          // as a steer before Codex has returned the exact turn identity.
          this.changed();
        } });
      for (const item of turn.items || []) if (item.type === "agentMessage") this.upsertMessage(task, item.id, item.text);
      if (turn.status !== "completed") throw new Error(turn.error?.message || `任务${turn.status === "interrupted" ? "已停止" : "未完成"}`);
      task.status = "completed";
    } catch (error) {
      task.status = execution.controller.signal.aborted ? "interrupted" : "failed";
      task.error = persistenceFailure ? "任务记录保存失败，已停止执行。" : (execution.controller.signal.aborted ? "任务已停止，可继续对话。" : upstreamFailure(error.message).slice(0, 2000));
    } finally {
      clearInterval(checkpoint);
      if (RUNNING.has(task.status)) { task.status = "interrupted"; task.error = "任务已停止，可继续对话。"; }
      for (const [approvalId, approval] of this.approvals) if (approval.public.taskId === task.id) this.approvals.delete(approvalId);
      // A turn can end while a write it started is still waiting on the
      // person's card: the Agent was told to wait for it and did not. Stopping
      // Codex now would end the command that asked, and that withdrew the card
      // before the person could answer (2026-09-23, a document sent to a chat).
      // Codex keeps such a command running after the turn and reports its end
      // (measured on 0.155.0), so Codex stays up until the write is done --
      // answered, or at most the card's own five minutes -- and what it did is
      // recorded. Stopping the task still ends it at once.
      if (task.status === "completed" && !execution.controller.signal.aborted) {
        execution.awaitingWrite = true; this.changed();
        // The write is over once the bridge has answered; the command that
        // asked ends a moment later, and Codex reports it after that. Stopping
        // Codex the moment the write settled lost the report: the step stayed
        // 进行中 in the record although the message had gone (2026-09-23).
        if (await this.writesSettled(task.id).catch(() => false)) await this.turnCommandsSettled(task, execution);
        // Stopped while waiting: that withdrew the card; the turn itself had
        // already finished.
        if (task.status === "stopping") task.status = "completed";
      }
      await this.stopClient(execution);
      if (execution.client?.cleanupWarning) task.error = execution.client.cleanupWarning;
      try { await execution.skill?.close(); } catch { task.error = "任务已结束，但技能临时文件清理未完成；请联系管理员。"; }
      task.updatedAt = Date.now();
      const opened = task.messages.findLast((message) => message.role === "user" && !message.steered);
      if (opened?.turn && !opened.turn.finishedAt) opened.turn = { ...opened.turn, finishedAt: Date.now(), status: task.status };
      try { await this.store.save(task); } catch { task.error = "任务记录未能保存，请勿关闭应用。"; task.status = "failed"; }
      this.active.delete(task.id); this.changed();
      if (this.queue) {
        if (task.status === "completed" && !task.error) void this.drainQueue(task.id);
        else void this.queue.pause(task.id, task.status === "interrupted" ? "任务已停止；下一轮队列已暂停" : "上一轮未正常完成；下一轮队列已暂停", { ifPresent: true }).then(() => this.changed()).catch(() => {});
      }
    }
  }
  // An answer is looked for in the turn now running only: an upstream that
  // reuses an item id from turn to turn (the synthetic one does, "msg_fixture")
  // must not have one turn's answer overwrite the last one's.
  turnMessage(task, id) {
    const opened = task.messages.findLast((message) => message.role === "user" && !message.steered);
    const floor = Number.isFinite(opened?.seq) ? opened.seq : -Infinity;
    return task.messages.find((message) => message.role === "assistant" && message.id === id && (Number.isFinite(message.seq) ? message.seq : Infinity) > floor);
  }
  upsertMessage(task, id, text, agent = null) {
    let item = this.turnMessage(task, id);
    if (!item) { item = { id, role: "assistant", text: "", createdAt: Date.now(), seq: nextSeq(task), ...(agent ? { agent } : {}) }; task.messages.push(item); }
    // The whole text each time, so a value that arrived split across two
    // pieces is caught once they meet.
    const redact = this.active.get(task.id)?.redact;
    item.text = redact ? redact(text) : text;
  }
  notification(task, message) {
    // This task's own thread, plus any subagent thread the running turn spawned.
    // A thread from anywhere else is still not this task's business.
    const threadId = message.params?.threadId;
    const execution = this.active.get(task.id);
    if (threadId !== task.codexThreadId && !execution?.threads?.has(threadId)) return;
    // What a subagent says and does is shown as the subagent's, never as this
    // task's own Agent speaking: its items carry the agent's task path, and their
    // ids are qualified by its thread, because two threads' item ids can repeat.
    const agent = threadId === task.codexThreadId ? null : execution?.agents?.get(threadId) ?? "/root/subagent";
    const own = (id) => agent ? `${threadId}:${id}` : id;
    if (message.method === "item/agentMessage/delta") {
      const { itemId, delta } = message.params;
      const prior = this.turnMessage(task, own(itemId))?.text || "";
      this.upsertMessage(task, own(itemId), prior + delta, agent);
    } else if (["item/started", "item/completed"].includes(message.method)) {
      const item = message.params.item;
      // A subagent runs on a thread of its own, announced on this one. Learning
      // that id is what lets its output — and its approval cards — reach this
      // task, instead of being dropped as coming from a thread nobody knows.
      if (item.type === "subAgentActivity" && typeof item.agentThreadId === "string" && execution?.threads) {
        execution.threads.add(item.agentThreadId);
        const path = typeof item.agentPath === "string" && /^\/root(?:\/[A-Za-z0-9_.-]{1,64}){1,16}$/.test(item.agentPath) ? item.agentPath : "/root/subagent";
        (execution.agents ??= new Map()).set(item.agentThreadId, path);
        const entry = { id: own(item.id), type: "subAgentActivity", status: typeof item.kind === "string" ? item.kind.slice(0, 40) : "started", agent: path };
        placeActivity(task, entry);
      }
      if (item.type === "agentMessage" && message.method === "item/completed") this.upsertMessage(task, own(item.id), item.text, agent);
      if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
        const redact = execution?.redact ?? ((text) => text);
        const allowedNote = item.type === "mcpToolCall" ? mcpAllowedNote(execution, own(item.id), item) : null;
        const entry = { id: own(item.id), type: item.type, status: item.status, command: redact(item.command),
          exitCode: item.exitCode, changes: item.changes?.map((change) => ({ path: change.path, kind: change.kind, diff: change.diff })),
          ...(item.type === "mcpToolCall" ? { server: item.server, tool: item.tool, ...(allowedNote ? { allowed: allowedNote } : {}) } : {}),
          ...(item.type === "commandExecution" && outputTail(item.aggregatedOutput) ? { output: outputTail(redact(item.aggregatedOutput)) } : {}),
          // What Codex parsed the command as -- a read, a listing, a search --
          // so browsing the code reads as browsing, the way Codex shows it.
          ...(item.type === "commandExecution" && commandActions(item.commandActions) ? { actions: commandActions(item.commandActions) } : {}),
          ...(Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {}), ...(agent ? { agent } : {}),
          ...(execution?.ruled?.has(own(item.id)) ? { ruled: true } : {}),
          ...(execution?.reads?.has(own(item.id)) ? { knowledgeRead: true } : {}) };
        placeActivity(task, entry);
      }
    } else if (message.method === "turn/started" && threadId === task.codexThreadId && execution?.review) {
      // A review runs as a turn of its own whose id is not the one review/start
      // answers with; only this one can be forked before -- Codex refuses the
      // other ("does not have a persisted start boundary", measured on 0.155.0).
      const opened = task.messages.findLast((row) => row.role === "user" && !row.steered);
      if (opened?.turn && !opened.turn.codexTurnId && typeof message.params.turn?.id === "string") opened.turn = { ...opened.turn, codexTurnId: message.params.turn.id };
    } else if (message.method === "turn/diff/updated" && threadId === task.codexThreadId) {
      // The turn's whole change, net: what a file ended up as against what it
      // was before the turn, as Codex sums a turn up. Keep the bounded source
      // as well as its totals so a later review never substitutes today's git
      // diff for this historical turn.
      const opened = task.messages.findLast((row) => row.role === "user" && !row.steered);
      if (opened?.turn && typeof message.params.diff === "string") opened.turn = { ...opened.turn, diff: diffNumbers(message.params.diff),
        ...(Buffer.byteLength(message.params.diff) <= MAX_STORED_TURN_DIFF ? { diffText: message.params.diff, diffUnavailable: undefined }
          : { diffText: undefined, diffUnavailable: "本轮净差异超过 2 MB，只保留了统计和当时的修改片段。" }) };
    } else if (message.method === "thread/tokenUsage/updated" && threadId === task.codexThreadId) {
      // For 上下文剩余 and /status, as Codex's footer shows it.
      const usage = contextUsage(message.params.tokenUsage);
      if (usage) task.contextUsage = usage;
    } else if (message.method === "turn/plan/updated") {
      // The Agent's own plan for the turn, replaced whenever it updates it, so
      // the person can see where it is without reading every step.
      const steps = Array.isArray(message.params.plan) ? message.params.plan.filter((row) => typeof row?.step === "string" && ["pending", "inProgress", "completed"].includes(row.status))
        .slice(0, 20).map((row) => ({ step: row.step.slice(0, 300), status: row.status })) : [];
      const explanation = typeof message.params.explanation === "string" ? message.params.explanation.slice(0, 500) : null;
      // The pinned, current plan belongs to the parent Agent. A child plan is
      // still part of the turn record, labelled as that child, but cannot
      // replace what the top-level task says it is doing.
      if (!agent) task.plan = { turnId: message.params.turnId ?? null, explanation, steps };
      // And in the record, where the turn first made it: one entry per turn,
      // kept up to date, as Codex's "Updated Plan" and Claude Code's todos.
      if (steps.length) placeActivity(task, { id: own(`plan:${message.params.turnId ?? "turn"}`), type: "plan", steps, explanation, ...(agent ? { agent } : {}) });
    } else if (message.method === "serverRequest/resolved") {
      for (const [id, approval] of this.approvals) if (approval.public.taskId === task.id && approval.requestId === message.params.requestId) {
        // The upstream withdrew or resolved the request somewhere else. Keep a
        // factual terminal step when there is an exact item association, so a
        // disappearing card does not look like silent success. With no item id
        // there is nothing trustworthy to attach this record to.
        const activity = approval.public.itemId ? turnActivity(task, approval.public.itemId) : null;
        if (activity && activity.status === "inProgress") activity.status = "withdrawn";
        this.approvals.delete(id);
      }
      if (task.status === "awaiting_approval" && ![...this.approvals.values()].some((item) => item.public.taskId === task.id)) task.status = "running";
    } else return;
    this.changed();
  }
  requestApproval(task, execution, request) {
    // Display association is evidence, not authorization. The current user
    // message is the turn boundary this running execution opened; a child
    // thread's item id is qualified exactly like its activity record. If an
    // upstream request has no item id (for example a general question), the
    // card stays at task level instead of being guessed onto the nearest step.
    const params = request.params ?? {};
    const opened = task.messages.findLast((message) => message.role === "user" && !message.steered);
    const child = params.threadId !== task.codexThreadId;
    const itemId = typeof params.itemId === "string" && params.itemId
      ? (child ? `${params.threadId}:${params.itemId}` : params.itemId) : null;
    const display = {
      ...(typeof opened?.id === "string" && opened.id ? { turnKey: opened.id } : {}),
      ...(typeof params.turnId === "string" && params.turnId ? { turnId: params.turnId } : typeof execution?.turnId === "string" ? { turnId: execution.turnId } : {}),
      ...(itemId ? { itemId } : {}),
      ...(child && execution?.agents?.get(params.threadId) ? { agent: execution.agents.get(params.threadId) } : {}),
    };
    if (request.method === "mcpServer/elicitation/request") {
      const rendered = params?._meta && Object.hasOwn(params._meta, "tool_params") ? JSON.stringify(params._meta.tool_params, null, 2) : "运行时未提供参数明细；如需核对参数，请拒绝本次调用。";
      const schema = params?.requestedSchema;
      if (execution.controller.signal.aborted || (params?.threadId !== task.codexThreadId && !execution.threads?.has(params?.threadId)) || !params.turnId || !execution.mcpConnectionIds?.includes(params.serverName) || params.mode !== "form" || params._meta?.codex_approval_kind !== "mcp_tool_call" || schema?.type !== "object" || !schema.properties || Object.keys(schema.properties).length || (schema.required?.length ?? 0) || typeof params.message !== "string" || params.message.length > 4000 || rendered.length > 24000) {
        execution.client.respond(request.id, { action: "decline", content: null, _meta: null }); return;
      }
      // Whether this call needs the person at all, by the turn's permission:
      // 完全访问 never asks, 标准 and 自动 ask once per grant, the rest every time.
      const tool = mcpToolName(params.message), builtin = execution.builtinConnections?.get(params.serverName);
      const grant = tool ? mcpGrant({ server: params.serverName, tool, params: params._meta?.tool_params, builtin: Boolean(builtin), title: builtin ?? params.serverName }) : null;
      const policy = mcpApprovalPolicy(task.permission);
      const allowed = policy === "never" ? "完全访问，自动允许"
        : policy === "grant" && grant?.free ? "只列出应用，自动允许"
        : policy === "grant" && grant && execution.mcpGrants?.has(grant.key) ? "本轮已允许，自动执行" : null;
      if (allowed) {
        execution.client.respond(request.id, { action: "accept", content: null, _meta: null });
        (execution.mcpAllowed ??= []).push({ server: params.serverName, tool, note: allowed });
        return;
      }
      const offer = policy === "grant" && grant?.label ? grant : null;
      const id = randomUUID();
      this.approvals.set(id, { requestId: request.id, client: execution.client, ...(offer ? { grant: offer.key, tool } : {}),
        public: { id, taskId: task.id, kind: "mcp", reason: params.message, command: rendered, cwd: params.serverName, changes: [], ...display,
          ...(grant?.target ? { target: grant.target } : {}), ...(offer ? { grant: offer.label } : {}) } });
      task.status = "awaiting_approval"; this.changed(); return;
    }
    // Nothing reaches the model until the person answers. A question marked
    // secret is answered empty at once: the application never carries a
    // password or a key into the model's context. Codex sends the question here
    // outside Plan mode only because gateway-config.js turns on
    // features.default_mode_request_user_input, and it waits for this answer
    // (measured, scripts/smoke-coding-task-desktop.js).
    if (request.method === "item/tool/requestUserInput") {
      const questions = userQuestions(request.params?.questions);
      if (execution.controller.signal.aborted || (request.params?.threadId !== task.codexThreadId && !execution.threads?.has(request.params?.threadId)) || !questions) {
        execution.client.respondError(request.id, -32602, "This desktop client cannot show this question"); return;
      }
      if (questions.some((question) => question.isSecret)) { execution.client.respond(request.id, { answers: emptyAnswers(questions) }); return; }
      const id = randomUUID();
      this.approvals.set(id, { requestId: request.id, client: execution.client,
        public: { id, taskId: task.id, kind: "question", reason: "Agent 需要你的回答才能继续", questions, command: null, cwd: task.cwd, changes: [], ...display } });
      task.status = "awaiting_approval"; this.changed(); return;
    }
    const methods = { "item/commandExecution/requestApproval": "command", "item/fileChange/requestApproval": "file" };
    const kind = methods[request.method];
    if (!kind || execution.controller.signal.aborted || (request.params?.threadId !== task.codexThreadId && !execution.threads?.has(request.params?.threadId))) {
      execution.client.respondError(request.id, -32601, "This desktop client cannot handle this request"); return;
    }
    // The Agent's own reads of the knowledge copy change nothing, so asking to
    // run one outside the sandbox is answered at once (knowledge-commands.js).
    // Only a new command, never input for one already running.
    if (kind === "command" && (request.params.kind ?? "command") === "command" && !request.params.networkApprovalContext && knowledgeCommand(request.params.command)) {
      execution.client.respond(request.id, { decision: "accept" });
      (execution.reads ??= new Set()).add(request.params.threadId === task.codexThreadId ? request.params.itemId : `${request.params.threadId}:${request.params.itemId}`);
      return;
    }
    // A command this coding project has been told to run without asking is let
    // through at once, and the record says so (approval-rules.js).
    const coding = task.mode === "coding" && kind === "command" && this.approvalRules;
    if (coding && this.approvalRules.allows(task.cwd, request.params)) {
      execution.client.respond(request.id, { decision: "accept" });
      (execution.ruled ??= new Set()).add(request.params.threadId === task.codexThreadId ? request.params.itemId : `${request.params.threadId}:${request.params.itemId}`);
      return;
    }
    const id = randomUUID();
    const publicRequest = { id, taskId: task.id, kind, reason: request.params.reason || "需要你的确认",
      command: (execution.redact ?? ((text) => text))(request.params.command) || null, cwd: request.params.cwd || task.cwd, ...display,
      // What the card can offer to remember for this project, if anything.
      ...(coding ? { remember: this.approvalRules.offer(request.params) } : {}),
      changes: (itemId ? turnActivity(task, itemId) : null)?.changes || [] };
    if (kind === "file" && !publicRequest.changes.length) {
      execution.client.respond(request.id, { decision: "decline" });
      task.error = "未收到可供确认的文件差异，已拒绝这次修改。"; this.changed(); return;
    }
    this.approvals.set(id, { public: publicRequest, requestId: request.id, client: execution.client });
    task.status = "awaiting_approval"; this.changed();
  }
  // `acceptForSession` lets Codex run the same kind of command, or change the
  // same files, again without asking -- for the rest of this turn only, since
  // every turn runs in its own Codex process. An MCP call is confirmed one at a time.
  // A request may list fewer answers (an escalated command offers accept, a
  // persistent command rule and cancel), but the pinned Codex honours decline and
  // acceptForSession there as well (measured): decline fails that one command and
  // the Agent carries on, where cancel would end the whole turn.
  // `acceptAndRemember` also tells this project to run commands like it from now
  // on without asking; it is answered at once, and the promise is the keeping.
  approve(id, decision) {
    if (!["accept", "acceptForSession", "acceptAndRemember", "decline"].includes(decision)) throw new Error("无效的确认选项");
    const approval = this.approvals.get(id);
    if (!approval) throw new Error("确认请求已失效");
    if (approval.public.kind === "question" || (approval.public.kind === "mcp" && decision === "acceptForSession" && !approval.grant)
      || (decision === "acceptAndRemember" && !approval.public.remember)) throw new Error("无效的确认选项");
    const task = this.get(approval.public.taskId);
    if (!this.active.has(task.id) || task.status === "stopping") throw new Error("任务已停止");
    approval.client.respond(approval.requestId, approval.public.kind === "mcp" ? { action: decision === "decline" ? "decline" : "accept", content: null, _meta: null }
      : { decision: decision === "acceptAndRemember" ? "accept" : decision });
    this.approvals.delete(id);
    // An MCP grant covers the rest of this turn: the calls already waiting on
    // the same one go through with it, and later ones are answered at once.
    if (approval.public.kind === "mcp" && decision === "acceptForSession") {
      const execution = this.active.get(task.id);
      (execution.mcpGrants ??= new Set()).add(approval.grant);
      for (const [otherId, other] of [...this.approvals]) {
        if (other.public.taskId !== task.id || other.public.kind !== "mcp" || other.grant !== approval.grant) continue;
        other.client.respond(other.requestId, { action: "accept", content: null, _meta: null });
        (execution.mcpAllowed ??= []).push({ server: other.public.cwd, tool: other.tool, note: "本轮已允许，自动执行" });
        this.approvals.delete(otherId);
      }
    }
    task.status = [...this.approvals.values()].some((item) => item.public.taskId === task.id) ? "awaiting_approval" : "running";
    this.changed();
    return decision === "acceptAndRemember" ? this.approvalRules.remember(task.cwd, approval.public.remember) : undefined;
  }
  // The person's answers to the Agent's questions: a chosen option's label, or
  // their own words where the question allows them. A question left blank is
  // sent back unanswered, and the Agent carries on without it.
  answer(id, answers) {
    const approval = this.approvals.get(id);
    if (!approval || approval.public.kind !== "question") throw new Error("提问已失效");
    const task = this.get(approval.public.taskId);
    if (!this.active.has(task.id) || task.status === "stopping") throw new Error("任务已停止");
    const result = {};
    for (const question of approval.public.questions) {
      const value = answers?.[question.id];
      if (value === undefined || value === null || value === "") { result[question.id] = { answers: [] }; continue; }
      if (typeof value !== "string" || value.length > 4000) throw new Error("回答无效");
      if (!question.isOther && !question.options.some((option) => option.label === value)) throw new Error("请选择给出的选项之一");
      result[question.id] = { answers: [value] };
    }
    approval.client.respond(approval.requestId, { answers: result });
    this.approvals.delete(id);
    task.status = [...this.approvals.values()].some((item) => item.public.taskId === task.id) ? "awaiting_approval" : "running";
    this.changed();
  }
  stop(id) {
    const task = this.get(id), execution = this.active.get(id);
    const pausing = this.queue?.pause(id, "任务已停止；下一轮队列已暂停", { ifPresent: true }).then(() => this.changed());
    if (!execution) return pausing;
    task.status = "stopping";
    for (const [approvalId, approval] of this.approvals) if (approval.public.taskId === id) {
      try { approval.client.respond(approval.requestId, approval.public.kind === "mcp" ? { action: "decline", content: null, _meta: null }
        : approval.public.kind === "question" ? { answers: emptyAnswers(approval.public.questions) } : { decision: "decline" }); } catch {}
      this.approvals.delete(approvalId);
    }
    execution.controller.abort(); void this.stopClient(execution); this.changed(); return pausing;
  }
  // Until no command of the turn now ending is still running, as far as Codex
  // has said, or `ms` have passed.
  async turnCommandsSettled(task, execution, ms = 5_000) {
    const opened = task.messages.findLast((message) => message.role === "user" && !message.steered);
    const floor = Number.isFinite(opened?.seq) ? opened.seq : -Infinity;
    const running = () => task.activity.some((entry) => entry?.type === "commandExecution" && entry.status === "inProgress" && Number.isFinite(entry.seq) && entry.seq > floor);
    for (const until = Date.now() + ms; running() && Date.now() < until && !execution.controller.signal.aborted;) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  stopClient(execution) {
    if (!execution.client) return Promise.resolve();
    return execution.stopPromise ||= Promise.resolve().then(() => execution.client.stop()).catch(() => {});
  }
  async close() {
    this.closing = true;
    const running = [...this.active.entries()];
    for (const [id] of running) this.stop(id);
    await Promise.allSettled(running.map(([, entry]) => entry.done.promise));
    await this.queue?.pauseAll("应用已退出；请重新核对下一轮队列").catch(() => {});
    await Promise.all([this.store.flush(), this.queue?.flush()]);
  }
}
