// The line under the composer's model menu: what the list above it is. Kept
// beside 设置's own wording for the same states -- with nothing confirmed there
// is no "this one model" (review, 2026-10-09).
export function modelMenuNote(options) {
  const available = options?.available ?? [];
  if (!available.length) return "服务端尚未确认可用模型。";
  if (available.length < 2) return "服务端当前只提供这一个模型。";
  return options.kept === "server" ? "保存在服务端，下一轮生效；之后的任务和定时任务都用它。" : "本连接使用，下一轮生效。";
}
