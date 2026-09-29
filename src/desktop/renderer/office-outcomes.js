const RESOURCE_LABELS = {
  "workspace-file": "本地文件",
  "feishu-document": "飞书文档",
  "feishu-sheet": "飞书电子表格",
  "feishu-base": "飞书多维表格",
};

const shortRevision = value => typeof value === "string" && value ? value.slice(0, 16) : "版本未记录";

export function knowledgeScopeVisible(task) {
  return task?.mode === "cowork";
}

export function selectionReferencePresentation(reference) {
  const kind = RESOURCE_LABELS[reference?.resourceKind] ?? "内容";
  const title = reference?.title || reference?.path || "未命名内容";
  const scope = reference?.scope || (reference?.selection?.startLine
    ? `第 ${reference.selection.startLine}${reference.selection.endLine && reference.selection.endLine !== reference.selection.startLine ? `–${reference.selection.endLine}` : ""} 行`
    : "当前内容");
  const revision = shortRevision(reference?.revision);
  const current = reference?.state === "current";
  return {
    label: `${current ? kind : `${kind}需重新核对`} · ${title} · ${scope} · ${revision}`,
    detail: [reference?.url || reference?.path || reference?.resourceKey, `版本 ${reference?.revision || "未记录"}`, scope].filter(Boolean).join("\n"),
    current,
  };
}

export function contextPresentation(context) {
  if (!context) return "";
  const kind = RESOURCE_LABELS[context.kind] ?? (context.path ? "本地文件" : "内容");
  const title = context.title || context.path || "未命名内容";
  const scope = context.kind === "feishu-sheet" ? context.range
    : context.kind === "feishu-base" ? `第 ${context.offset + 1} 条起`
      : context.selection ? `第 ${context.selection.startLine}–${context.selection.endLine} 行` : "当前内容";
  const revision = context.sourceRevision || context.revision;
  return `引用：${kind} · ${title}${scope ? ` · ${scope}` : ""}${revision ? ` · 版本 ${shortRevision(revision)}` : ""}`;
}

export function mediaResultPresentation(row) {
  const kind = row?.kind === "video" ? "视频" : "图片";
  if (row?.persisted && row?.deliveryState === "available") return { kind, state: "saved", title: `${kind}成果`, status: "已保存到飞书云盘", detail: "云盘回执已核验" };
  if (["upload_unknown", "verification_pending"].includes(row?.deliveryState)) return { kind, state: "needs-check", title: `${kind}成果`, status: "云盘保存结果待核对", detail: "不会自动重传" };
  if (row?.deliveryState === "uploading") return { kind, state: "working", title: `${kind}成果`, status: "正在保存到飞书云盘", detail: "尚未取得完整回执" };
  if (row?.state === "awaiting_acceptance") return { kind, state: "temporary", title: `${kind}临时成果`, status: "可预览 · 尚未保存", detail: "临时结果不是云盘文件" };
  if (["running", "unresolved", "submission_unknown"].includes(row?.state)) return { kind, state: "working", title: `正在生成${kind}`, status: "生成中或结果待查询", detail: "不会自动重复生成" };
  if (row?.state === "failed") return { kind, state: "failed", title: `${kind}生成失败`, status: "未生成可交付成果", detail: "不会自动重试" };
  if (["canceled", "expired"].includes(row?.state)) return { kind, state: "ended", title: `${kind}任务已结束`, status: row.state === "expired" ? "临时成果已过期" : "已停止", detail: "未保存到飞书云盘" };
  return { kind, state: "needs-check", title: `${kind}任务`, status: "状态待核对", detail: "不会把临时结果标为已保存" };
}
