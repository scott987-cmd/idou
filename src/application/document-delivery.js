import { createHash, randomUUID } from "node:crypto";
import { createDeliveryIntent } from "../delivery/contracts.js";

// A send is out -- waiting on its card, or on its way -- and nothing else may
// start for this task until it is over (see agent-delivery-actions.js).
export const DELIVERY_BUSY = "这个任务的上一次发送还没结束（在等你确认，或正在发送），结束后再操作";

const RUNNING = new Set(["running", "awaiting_approval", "stopping"]);
const sameIdentity = (a, b) => Boolean(a?.principal && a?.tenantKey && a.principal === b?.principal && a.tenantKey === b?.tenantKey);
export function linkMessage(document, note = "") {
  if (typeof note !== "string" || note.length > 1000 || /[<\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(note)) throw new Error("附言最多 1000 字，不支持 < 标记、@ 提醒语法或控制字符");
  const title = (document.title || "飞书文档").slice(0, 300).replace(/</g, "＜").replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ");
  return `${title}\n${document.sourceUrl}${note.trim() ? `\n\n${note.trim()}` : ""}`;
}
export class DocumentDelivery {
  constructor({ documents, provider, getTask, saveTask, businessAccess = () => {}, editing = () => false }) {
    Object.assign(this, { documents, provider, getTask, saveTask, businessAccess, editing });
    this.choices = new Map(); this.previews = new Map(); this.active = new Set();
    documents.on("invalidated", ({ taskId }) => this.discard(taskId));
  }
  discard(taskId) { this.choices.delete(taskId); this.previews.delete(taskId); }
  // A notice belongs to the conversation, not to a panel: it is the only place
  // left that the person reads. It is not a turn -- it never reaches the model.
  notify(taskId, text) {
    try {
      const task = this.getTask(taskId);
      (task.messages ||= []).push({ id: randomUUID(), role: "notice", text, createdAt: Date.now() });
    } catch { /* the task went away; the durable record still carries the state */ }
  }
  // `origin` is who asked. A person sending from outside the conversation must
  // wait for the task to settle, because the Agent may still be changing the
  // document. The Agent asking from inside its own turn *is* the running task,
  // so that wait could never end: every doc-share from the conversation was
  // refused with this message, and sending had no working path at all. What
  // actually protects the send -- the document re-read and compared right
  // before dispatch (fresh), and the in-app confirmation -- applies to both,
  // and an edit still in flight blocks both.
  entry(taskId, handle, origin = "person") {
    this.businessAccess(); const task = this.getTask(taskId), entry = this.documents.opened.get(taskId);
    if ((origin !== "agent" && RUNNING.has(task.status)) || this.editing(taskId)) throw new Error("请等待当前任务和文档修改结束后再发送");
    if (!entry || entry.handle !== handle || entry.expiresAt <= this.documents.now()) throw new Error("文档引用已失效，请重新打开后发送");
    return entry;
  }
  async fresh(taskId, entry, origin = "person") {
    if (this.entry(taskId, entry.handle, origin) !== entry) throw new Error("文档已切换，未发送");
    let fresh;
    try { fresh = await this.documents.provider.readDocument(entry.document.sourceUrl); }
    catch (error) { if (this.documents.opened.get(taskId) === entry) this.documents.close(taskId); throw error; }
    if (this.entry(taskId, entry.handle, origin) !== entry) throw new Error("文档已切换，未发送");
    if (["providerId", "resourceId", "sourceUrl", "sourceRevision", "contentHash"].some(key => fresh[key] !== entry.document[key]) || !sameIdentity(fresh.identity, entry.document.identity)) {
      this.documents.close(taskId); throw new Error("文档版本、权限或身份已变化，请重新打开并确认发送内容");
    }
    return fresh;
  }
  // Whether a send of this task is out: waiting on its card, or on its way.
  busy(taskId) { return this.active.has(taskId); }
  async search(taskId, handle, query, kind = "user", { origin = "person" } = {}) {
    if (!["user", "group"].includes(kind)) throw new Error("请选择私信或群聊");
    if (this.active.has(taskId)) throw new Error(DELIVERY_BUSY);
    // The origin is fixed by the search that starts a flow and carried with
    // it, so a later step cannot claim a different one.
    const entry = this.entry(taskId, handle, origin), slot = { entry, kind, origin, users: new Map(), expiresAt: this.documents.now() + 5 * 60_000 };
    this.discard(taskId); this.choices.set(taskId, slot);
    const result = kind === "group" ? await this.provider.searchGroups(query) : await this.provider.search(query);
    if (this.choices.get(taskId) !== slot || this.entry(taskId, handle, origin) !== entry || !sameIdentity(entry.document.identity, result.identity)) throw new Error("搜索或登录身份已变化，请重新搜索");
    const users = (kind === "group" ? result.groups : result.users).map(user => { const handle = randomUUID(); slot.users.set(handle, structuredClone(user)); return { ...user, handle }; });
    return { [kind === "group" ? "groups" : "users"]: users, hasMore: result.hasMore, excluded: result.excluded };
  }
  async members(taskId, handle, recipientHandle) {
    if (this.active.has(taskId)) throw new Error(DELIVERY_BUSY);
    const slot = this.choices.get(taskId), entry = this.entry(taskId, handle, slot?.origin), target = slot?.users.get(recipientHandle);
    if (slot?.kind !== "group" || !target || slot.entry !== entry || slot.expiresAt <= this.documents.now()) throw new Error("请重新搜索并选择群聊");
    this.previews.delete(taskId);
    const selection = { handle: recipientHandle, members: new Map() }; slot.selection = selection;
    const result = await this.provider.groupMembers(target, entry.document.identity);
    if (this.choices.get(taskId) !== slot || slot.selection !== selection || this.entry(taskId, handle, slot.origin) !== entry) throw new Error("群选择已变化，请重新读取成员");
    selection.group = result.group;
    const members = result.members.map(user => { const handle = randomUUID(); selection.members.set(handle, structuredClone(user)); return { ...user, handle }; });
    return { group: structuredClone(result.group), members, partial: result.partial, excluded: result.excluded };
  }
  async prepare(taskId, handle, recipientHandle, note, mentionHandles = []) {
    if (this.active.has(taskId)) throw new Error(DELIVERY_BUSY);
    const slot = this.choices.get(taskId), entry = this.entry(taskId, handle, slot?.origin);
    let target = slot?.users.get(recipientHandle), mentions = [];
    if (!target || slot.entry !== entry || slot.expiresAt <= this.documents.now()) throw new Error("请重新搜索并明确选择一位收件人");
    if (!Array.isArray(mentionHandles) || mentionHandles.length > 10 || new Set(mentionHandles).size !== mentionHandles.length) throw new Error("最多选择 10 位不同的 @ 成员");
    const selection = slot.selection;
    if (slot.kind === "group") {
      if (selection?.handle !== recipientHandle || !selection.group) throw new Error("请先读取所选群的成员，再预览消息");
      target = selection.group;
      mentions = mentionHandles.map(handle => selection.members.get(handle));
      if (mentions.some(user => !user)) throw new Error("@ 成员不是本次所选群的成员，请重新选择");
      mentions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    } else if (mentionHandles.length) throw new Error("私信不能附加群成员提醒");
    this.previews.delete(taskId);
    const document = await this.fresh(taskId, entry, slot.origin), text = linkMessage(document, note);
    if (this.choices.get(taskId) !== slot || slot.selection !== selection) throw new Error("收件人搜索或群选择已变化，请重新选择");
    const fingerprint = createHash("sha256").update(JSON.stringify([document.providerId, document.identity.principal, document.resourceId, target.id, text, ...(slot.kind === "group" ? ["group", mentions.map(user => user.id)] : [])])).digest("hex");
    const task = this.getTask(taskId);
    if ((task.documentDeliveries || []).some(row => row.fingerprint === fingerprint)) throw new Error("此文档和消息已有发送记录，请先核查记录；不会重复提交");
    if ((task.documentDeliveries || []).length >= 100) throw new Error("此任务已达到 100 条发送记录上限，请保留记录并使用新任务");
    const intent = createDeliveryIntent({ kind: "link", resource: { url: document.sourceUrl }, recipients: [target], permissionPolicy: "keep" });
    const preview = { id: intent.id, text, recipient: structuredClone(target), sourceUrl: document.sourceUrl, sourceRevision: document.sourceRevision,
      sender: { principal: document.identity.principal, tenantKey: document.identity.tenantKey }, permissionPolicy: "keep", ...(slot.kind === "group" ? { mentions: structuredClone(mentions) } : {}) };
    this.previews.set(taskId, { preview, entry, origin: slot.origin, fingerprint, idempotencyKey: intent.idempotencyKey, expiresAt: this.documents.now() + 5 * 60_000 });
    return structuredClone(preview);
  }
  async send(taskId, previewId, confirm) {
    const saved = this.previews.get(taskId);
    if (!saved || saved.preview.id !== previewId || saved.expiresAt <= this.documents.now()) throw new Error("发送预览已失效，请重新预览");
    if (this.active.has(taskId)) throw new Error("此任务正在发送，不会重复提交");
    this.active.add(taskId);
    let record;
    try {
      this.entry(taskId, saved.entry.handle, saved.origin);
      if (!await confirm(structuredClone(saved.preview))) return null;
      await this.fresh(taskId, saved.entry, saved.origin);
      if (this.previews.get(taskId) !== saved || saved.expiresAt <= this.documents.now()) throw new Error("发送预览已取消或失效，未发送");
      const task = this.getTask(taskId);
      if ((task.documentDeliveries || []).some(row => row.fingerprint === saved.fingerprint)) throw new Error("已有发送记录，不会重复提交");
      const receipt = await this.provider.send({ identity: saved.entry.document.identity, recipient: saved.preview.recipient, text: saved.preview.text, sourceUrl: saved.preview.sourceUrl, idempotencyKey: saved.idempotencyKey, mentions: saved.preview.mentions || [] }, async () => {
        await this.fresh(taskId, saved.entry, saved.origin);
        if (this.entry(taskId, saved.entry.handle, saved.origin) !== saved.entry || this.previews.get(taskId) !== saved || saved.expiresAt <= this.documents.now()) throw new Error("发送预览已失效，未发送");
        record = { ...structuredClone(saved.preview), fingerprint: saved.fingerprint, idempotencyKey: saved.idempotencyKey, state: "dispatching", createdAt: Date.now() };
        (task.documentDeliveries ||= []).push(record);
        try { await this.saveTask(task); }
        catch { record.state = "not-sent"; throw new Error("本机发送记录保存失败，未调用飞书发送；请先检查存储状态"); }
        // Recheck after asynchronous persistence too; cancellation/navigation is still reversible here.
        try {
          if (this.entry(taskId, saved.entry.handle, saved.origin) !== saved.entry || this.previews.get(taskId) !== saved) throw new Error();
        } catch { record.state = "not-sent"; await this.saveTask(task).catch(() => {}); throw new Error("记录保存期间文档或预览已切换，未发送"); }
      });
      record.state = "acknowledged"; Object.assign(record, receipt);
      try { await this.saveTask(task); }
      catch { throw new Error("飞书已返回消息回执，但本机保存未确认；请到飞书核查，不要重试"); }
      return structuredClone(record);
    } catch (error) {
      if (record?.state === "dispatching") {
        record.state = "unknown";
        // An ambiguous send is the one outcome nobody may miss. The history list
        // that used to carry it is gone with the delivery dialog, so it is said
        // in the conversation, where the person is actually looking.
        this.notify(taskId, `已向「${record.recipient?.name ?? "收件人"}」发出，但没有收到飞书回执。请到飞书核查是否已送达；本应用不会自动重试，也不会重复发送。`);
        await this.saveTask(this.getTask(taskId)).catch(() => {});
      }
      throw error;
    } finally { this.active.delete(taskId); if (this.previews.get(taskId) === saved) this.previews.delete(taskId); }
  }
}
