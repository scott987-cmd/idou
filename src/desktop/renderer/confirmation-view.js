// Display-only confirmation rules. Authorization remains in TaskService and
// main.js; this module only decides where a card may be drawn and how an office
// action is named without exposing a shell wrapper as the headline.

import { agentActions, larkShortcut, optionValue } from "./command-intent.js";

const same = (left, right) => typeof left === "string" && left !== "" && left === right;

export function approvalPlacement(approval, step) {
  if (!same(approval?.taskId, step?.taskId)) return "other-task";
  if (!same(approval?.turnKey, step?.turnKey) || !same(approval?.itemId, step?.itemId)) return "task";
  return "step";
}

export function confirmationVisibleForTask(confirmation, taskId) {
  if (!confirmation) return false;
  return !confirmation.taskId || confirmation.taskId === taskId;
}

const basename = (value) => String(value ?? "").split(/[\\/]/).filter(Boolean).at(-1) ?? "";

// The headline is what the command runs -- the person decides by it -- never a
// name it only mentions in a note or a heredoc (command-intent.js).
function workAction(command) {
  const invoked = agentActions(command), shortcut = larkShortcut(command);
  const has = (...names) => invoked.some((row) => names.includes(row.action));
  const option = (action, name) => optionValue(invoked.find((row) => row.action === action)?.rest, name);
  if (has("doc-create")) return ["创建飞书文档", basename(option("doc-create", "content-file"))];
  if (has("doc-replace", "doc-append")) return ["修改飞书文档", ""];
  if (has("doc-share-search")) return ["查找接收人", option("doc-share-search", "query")];
  if (has("doc-share-members")) return ["核对群成员", ""];
  if (has("doc-share")) return ["发送飞书文档", ""];
  if (has("media-create")) return [option("media-create", "kind") === "video" ? "生成视频" : "生成图片", ""];
  if (has("media-save")) return ["保存媒体到飞书云盘", ""];
  if (has("schedule-draft", "schedule-pause", "schedule-resume", "schedule-delete", "schedule-run-now")) return ["更新定时任务", ""];
  if (shortcut?.domain === "sheets") return ["处理飞书电子表格", ""];
  if (shortcut?.domain === "base") return ["处理飞书多维表格", ""];
  if (shortcut?.domain === "calendar") return ["处理飞书日程", ""];
  if (shortcut?.domain === "task") return ["处理飞书任务", ""];
  return ["处理任务", ""];
}

export function approvalPresentation(approval, mode) {
  const detail = approval?.kind === "file"
    ? (approval.changes ?? []).map((file) => `${file.path}\n${file.diff || ""}`).join("\n\n")
    : String(approval?.command ?? "");
  if (approval?.kind === "question") return { title: "Agent 想先问你", target: "", detail: "" };
  if (approval?.kind === "mcp") return { title: "确认 MCP 工具调用", target: approval.target ?? approval.cwd ?? "", detail };
  if (approval?.kind === "file") return { title: "确认修改文件", target: (approval.changes ?? []).map((file) => basename(file.path)).join("、"), detail };
  if (mode === "cowork") {
    const [action, target] = workAction(approval?.command);
    return { title: `确认${action}`, target, detail };
  }
  return { title: "确认执行命令", target: "", detail };
}
