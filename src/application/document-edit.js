const RUNNING = new Set(["running", "awaiting_approval", "stopping"]);
export function editProposal(message) {
  if (typeof message !== "string" || message.length > 16000) throw new Error("修改建议格式无效");
  let value; try { value = JSON.parse(message.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, "$1")); } catch { throw new Error("Agent 尚未返回可应用的结构化修改建议，请重新生成"); }
  if (!value || Object.keys(value).sort().join(",") !== "kind,replacement" || value.kind !== "feishu-text-edit" || typeof value.replacement !== "string" || value.replacement.length > 2000 || /[\x00-\x1f\x7f]/.test(value.replacement)) throw new Error("修改建议仅支持最多 2000 字的行内纯文本替换");
  return value.replacement;
}
export class DocumentEdits {
  constructor({ documents, getTask, provider, businessAccess = () => {}, saveTask = async () => {} }) { Object.assign(this, { documents, getTask, provider, businessAccess, saveTask }); this.drafts = new WeakMap(); this.active = new Set(); this.resources = new Set(); }
  entry(taskId, context) {
    this.businessAccess(); const task = this.getTask(taskId), entry = this.documents.opened.get(taskId);
    if (RUNNING.has(task.status)) throw new Error("请等待当前任务结束后再应用修改");
    if (!entry || entry.expiresAt <= this.documents.now() || ["providerId", "resourceId", "sourceUrl", "sourceRevision", "contentHash"].some(key => entry.document[key] !== context[key]) || entry.document.identity.principal !== context.principal || entry.document.identity.tenantKey !== context.tenantKey) throw new Error("修改建议对应的文档或身份已失效，请重新打开并生成建议");
    return entry;
  }
  async prepare(taskId, messageId) {
    if (this.active.has(taskId)) throw new Error("文档修改仍在执行，请先核查结果");
    const task = this.getTask(taskId), index = task.messages.findIndex(item => item.id === messageId && item.role === "assistant");
    if (index < 0) throw new Error("找不到当前任务的 Agent 修改建议");
    if (task.messages[index].documentEdit) throw new Error("这条建议已有写入记录，请核查原结果，不会重复提交");
    const user = task.messages.slice(0, index).findLast(item => item.role === "user"), context = user?.context;
    if (context?.kind !== "feishu-document" || context.intent !== "propose-edit" || !context.selection || context.selection.text !== context.text) throw new Error("这条回复没有经过用户选择的文档修改请求");
    const entry = this.entry(taskId, context), pattern = context.selection.text, replacement = editProposal(task.messages[index].text);
    if (entry.document.text.slice(context.selection.start, context.selection.end) !== pattern) throw new Error("修改选区与原文不一致");
    const prepared = await this.provider.prepare(entry.document, pattern, replacement);
    if (this.entry(taskId, context) !== entry) throw new Error("准备期间文档已切换");
    const draft = Object.freeze({ title: entry.document.title, sourceUrl: entry.document.sourceUrl, revision: entry.document.sourceRevision, pattern, replacement });
    this.drafts.set(draft, { taskId, context, entry, prepared, message: task.messages[index] }); return draft;
  }
  async apply(draft) {
    const saved = this.drafts.get(draft); this.drafts.delete(draft);
    if (!saved) throw new Error("修改确认已使用或失效");
    const { taskId, context, entry, prepared, message } = saved;
    if (message.documentEdit) throw new Error("这条建议已有写入记录，不会重复提交");
    const key = JSON.stringify([context.providerId, context.principal, context.resourceId]);
    if (this.active.has(taskId) || this.resources.has(key)) throw new Error("此文档已有修改正在执行，未重复提交");
    this.active.add(taskId); this.resources.add(key);
    try {
    const document = await this.provider.apply(prepared, async () => {
      if (this.entry(taskId, context) !== entry) throw new Error("确认期间文档已切换，未写入");
      message.documentEdit = { state: "dispatching", sourceRevision: context.sourceRevision };
      this.documents.close(taskId); // Invalidate before dispatch, including unknown outcomes.
      await this.saveTask(this.getTask(taskId)); // Persist one-shot intent before the CLI write.
    });
    message.documentEdit = { state: "verified", sourceRevision: context.sourceRevision, revision: document.sourceRevision };
    try { await this.saveTask(this.getTask(taskId)); }
    catch { throw new Error("飞书写回已读取核验，但本机回执保存未确认；请核查原文档，不要重试。"); }
    // Do not resurrect a reader the user navigated away from during the write.
    return { verified: true, sourceUrl: document.sourceUrl, revision: document.sourceRevision };
    } catch (error) {
      if (message.documentEdit?.state === "dispatching") {
        message.documentEdit.state = "unknown";
        await this.saveTask(this.getTask(taskId)).catch(() => {});
      }
      throw error;
    } finally { this.active.delete(taskId); this.resources.delete(key); }
  }
}
