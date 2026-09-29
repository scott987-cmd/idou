const ACTIVE = new Set(["running", "awaiting_approval", "stopping"]);

export function composerState({ task = null, submitting = false, submittingAction = null, stopPending = false, text = "", imageCount = 0, imageModel = null, invalidDirectory = false } = {}) {
  const status = task?.status ?? "idle";
  const active = ACTIVE.has(status);
  const canSteer = status === "running" && task?.runtime?.canSteer === true;
  const hasText = typeof text === "string" && text.trim().length > 0;
  const queueAvailable = Boolean(task?.queue) && task.queue.readOnly !== true;
  const queueDisabled = invalidDirectory || !hasText || !queueAvailable;

  if (submitting) return {
    action: submittingAction ?? (canSteer ? "steer" : active ? "blocked" : "send"),
    label: submittingAction === "queue" ? "正在排队…" : canSteer ? "补充中…" : "发送中…",
    disabled: true,
    reason: "请求正在提交",
    queueVisible: canSteer, queueDisabled: true,
  };
  if (status === "stopping") return { action: "blocked", label: "停止中…", disabled: true, reason: "任务正在停止；可以继续编辑草稿", queueVisible: false, queueDisabled: true };
  // One button where 发送 is, as in WorkBuddy: while a turn runs it stops it when
  // nothing is typed, and sends what is typed otherwise. A 停止 beside 发送 was
  // the one hit by mistake (2026-09-23, while recording): with a sentence typed
  // there is now no stop button next to the send one.
  if (active && !hasText && imageCount === 0) return {
    action: "stop", label: "停止", disabled: stopPending,
    reason: stopPending ? "正在停止…" : "停止这一轮；也可以连按两下 Esc",
    queueVisible: false, queueDisabled: true,
  };
  if (status === "awaiting_approval" || (status === "running" && !canSteer) || (canSteer && imageCount > 0)) return {
    action: "queue", label: "下一轮发送 ↑", disabled: queueDisabled,
    reason: !queueAvailable ? "下一轮队列当前不可用" : invalidDirectory ? "目录已移动或不可用，请重新选择" : !hasText ? "请输入下一轮内容"
      : status === "awaiting_approval" ? "当前确认不会被替代；这条内容将在本轮正常完成后发送" : "这条内容将在本轮正常完成后发送",
    queueVisible: false, queueDisabled,
  };
  if (!canSteer && imageCount > 0 && imageModel?.sees === false) return { action: "send", label: "发送 ↑", disabled: true, reason: `当前模型 ${imageModel.label || ""} 不支持图片；图片和文字都已保留`, queueVisible: false, queueDisabled: true };
  return {
    action: canSteer ? "steer" : "send",
    label: canSteer ? "补充 ↑" : "发送 ↑",
    disabled: invalidDirectory || !hasText,
    reason: invalidDirectory ? "目录已移动或不可用，请重新选择" : !hasText ? "请输入任务内容" : canSteer ? "把这句补充给正在执行的这一轮" : "",
    queueVisible: canSteer && queueAvailable, queueDisabled,
  };
}

export function dispatchError({ action, imageCount = 0, imageModel = null } = {}) {
  if (action === "blocked") return "当前状态不能发送；文字和引用仍保留在草稿中";
  if (action === "steer" && imageCount > 0) return "正在执行时不能补充图片；图片和文字都已保留，请等本轮结束";
  if (action === "send" && imageCount > 0 && imageModel?.sees === false) return `当前模型 ${imageModel.label || ""} 不支持图片；请更换模型或移除图片后再发送`;
  return null;
}

export function draftReferenceKey(reference) {
  if (!reference || typeof reference !== "object") return null;
  if (["user", "group"].includes(reference.kind)) return `${reference.kind}:${reference.email || reference.name || ""}`;
  if (reference.kind === "file") return `file:${reference.path || ""}`;
  if (reference.kind === "diff") return `diff:${reference.scope || ""}:${reference.turnKey || ""}:${reference.path || ""}:${reference.side || ""}:${reference.startLine || ""}:${reference.endLine || ""}:${reference.revision || ""}:${reference.fileRevision || ""}`;
  if (reference.kind === "page") return `page:${reference.path || ""}:${reference.revision || ""}`;
  if (reference.kind === "terminal") return reference.key || null;
  if (reference.kind === "selection") return `selection:${reference.resourceKey || reference.path || ""}:${reference.revision || ""}:${reference.selection?.start ?? ""}:${reference.selection?.end ?? ""}`;
  return null;
}

export function referenceContext(reference) {
  if (reference?.kind !== "selection" || reference.state !== "current") return null;
  if (reference.resourceKind === "workspace-file") return { path: reference.path, revision: reference.revision, selection: reference.selection };
  if (["feishu-document", "feishu-sheet", "feishu-base"].includes(reference.resourceKind) && reference.handle) {
    return { kind: reference.resourceKind, handle: reference.handle, ...(reference.selection ? { selection: reference.selection } : {}), ...(reference.intent ? { intent: reference.intent } : {}) };
  }
  return null;
}
