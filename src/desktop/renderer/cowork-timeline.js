// A work task uses the same factual turn boundaries as a coding task, but its
// default language is for the person doing the work. Exact commands and raw
// output remain available as technical details; they never become the title.
import { taskTurns } from "./coding-timeline.js";
import { agentActions, larkShortcut, optionValue } from "./command-intent.js";

const basename = (value) => String(value ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";

// Titled by what the command runs, not by what it mentions (command-intent.js).
function commandIntent(command) {
  const invoked = agentActions(command), shortcut = larkShortcut(command);
  const has = (...names) => invoked.some((row) => names.includes(row.action));
  const option = (action, name) => optionValue(invoked.find((row) => row.action === action)?.rest, name);
  if (has("kb-search")) return ["检索知识库", option("kb-search", "query")];
  if (has("kb-read")) return ["读取知识资料", option("kb-read", "match") || option("kb-read", "doc")];
  if (has("doc-create")) return ["创建飞书文档", ""];
  if (has("doc-replace", "doc-append")) return ["修改飞书文档", ""];
  if (has("doc-share-search")) return ["查找接收人", option("doc-share-search", "query")];
  if (has("doc-share-members")) return ["核对群成员", ""];
  if (has("doc-share")) return ["发送飞书文档", ""];
  if (has("media-create")) return [option("media-create", "kind") === "video" ? "生成视频" : "生成图片", ""];
  if (has("media-status")) return ["查询媒体生成进度", ""];
  if (has("media-preview")) return ["预览媒体成果", ""];
  if (has("media-save")) return ["保存媒体到飞书云盘", ""];
  if (has("media-verify", "media-folder")) return ["核对云盘保存结果", ""];
  if (has("media-cancel")) return ["停止媒体生成", ""];
  if (has("schedule-list")) return ["读取定时任务", ""];
  if (has("schedule-draft")) return ["准备定时任务", ""];
  if (has("schedule-pause", "schedule-resume", "schedule-delete", "schedule-run-now")) return ["更新定时任务", ""];
  if (shortcut?.domain === "calendar" && ["agenda", "freebusy", "suggestion", "search-event", "get"].includes(shortcut.verb)) return ["读取飞书日程", ""];
  if (shortcut?.domain === "task" && ["get-my-tasks", "get-related-tasks", "search", "tasklist-search"].includes(shortcut.verb)) return ["读取飞书任务", ""];
  if (shortcut?.domain === "sheets") return ["处理飞书电子表格", ""];
  if (shortcut?.domain === "base") return ["处理飞书多维表格", ""];
  if (shortcut?.domain === "calendar") return ["处理飞书日程", ""];
  if (shortcut?.domain === "task") return ["处理飞书任务", ""];
  return ["处理任务", ""];
}

function workState(entry) {
  const failed = entry?.status === "failed" || (Number.isInteger(entry?.exitCode) && entry.exitCode !== 0);
  if (entry?.status === "inProgress") return { state: "进行中…", tone: "live" };
  if (entry?.status === "withdrawn") return { state: "已撤销", tone: "bad" };
  if (entry?.status === "declined") return { state: "已取消", tone: "bad" };
  if (failed) return { state: "失败", tone: "bad" };
  if (entry?.status === "completed") return { state: "已完成", tone: "ok" };
  return { state: "结果待核对", tone: "warn" };
}

export function workStepView(view) {
  const entry = view?.entry ?? {};
  const status = workState(entry);
  const details = {
    ...(view?.command ? { command: view.command } : {}),
    ...(typeof entry.output === "string" && entry.output ? { output: entry.output } : {}),
    ...(typeof entry.type === "string" ? { type: entry.type } : {}),
  };
  if (view?.kind === "command") {
    const [title, target] = commandIntent(view.command);
    return { title, target, ...status, automatic: entry.knowledgeRead === true, open: status.tone === "bad" || status.tone === "warn", details };
  }
  if (view?.kind === "explore") {
    const commands = view.commands ?? [], failed = commands.some((row) => workState(row).tone === "bad");
    return { title: commands.some((row) => row.knowledgeRead) ? "读取知识资料" : "查找资料", target: "", state: failed ? "失败" : commands.some((row) => row.status === "inProgress") ? "进行中…" : "已完成",
      tone: failed ? "bad" : commands.some((row) => row.status === "inProgress") ? "live" : "ok", automatic: commands.some((row) => row.knowledgeRead), open: failed,
      details: { commands: commands.map((row) => ({ command: row.command, output: row.output })) } };
  }
  if (view?.kind === "change") {
    const names = (view.files ?? []).map((row) => basename(row.path)).filter(Boolean);
    const added = (view.files ?? []).every((row) => row.kind === "add");
    return { title: added ? "生成文件" : "更新文件", target: names.join("、"), ...status, automatic: false, open: status.tone === "bad" || status.tone === "warn",
      details: { ...details, files: (view.files ?? []).map((row) => row.path) } };
  }
  if (view?.kind === "mcp") return { title: "使用工具", target: [entry.server, entry.tool].filter(Boolean).join(" · "), ...status, automatic: false, open: status.tone === "bad" || status.tone === "warn", details };
  if (view?.kind === "subagent") return { title: "协同处理", target: String(entry.agent ?? "").replace(/^\/root\//, ""), ...status, automatic: false, open: false, details };
  return { title: "早期执行步骤", target: "", ...status, automatic: false, open: status.tone !== "ok", details };
}

function turnResult(turn) {
  const files = [], deliverables = [];
  let verifiedWrites = 0, uncertainWrites = 0;
  for (const entry of turn.entries) {
    if (entry.kind === "change" && entry.entry?.status === "completed") {
      for (const file of entry.files ?? []) if (typeof file.path === "string" && !files.includes(file.path)) {
        files.push(file.path); deliverables.push({ kind: "local", state: "available", title: basename(file.path), detail: file.path });
      }
    }
    if (entry.kind !== "text") continue;
    for (const [kind, record] of [["飞书文档", entry.message?.documentEdit], ["飞书电子表格", entry.message?.sheetEdit], ["飞书多维表格", entry.message?.baseEdit]]) {
      if (!record) continue;
      if (record.state === "verified") { verifiedWrites += 1; deliverables.push({ kind: "feishu", state: "verified", title: kind, detail: "已写入并读回核验" }); }
      else if (["unknown", "mismatch", "conflict"].includes(record.state)) { uncertainWrites += 1; deliverables.push({ kind: "feishu", state: "needs-check", title: kind, detail: "写入结果待核对 · 不会自动重写" }); }
    }
  }
  return { files, verifiedWrites, uncertainWrites, deliverables };
}

export function coworkTurns(task) {
  return taskTurns(task).map((turn) => ({ ...turn,
    entries: turn.entries.map((entry) => ["command", "explore", "change", "mcp", "subagent", "legacy"].includes(entry.kind) ? { ...entry, work: workStepView(entry) } : entry),
    result: turn.legacy ? { files: [], verifiedWrites: 0, uncertainWrites: 0, deliverables: [] } : turnResult(turn),
  }));
}
