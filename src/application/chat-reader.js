import { randomUUID } from "node:crypto";

// Ephemeral account-local view, never an authorization cache or a Wiki record.
export class ChatReader {
  constructor({ provider, businessAccess = () => {}, now = Date.now }) {
    this.provider = provider; this.businessAccess = businessAccess; this.now = now; this.epoch = 0; this.close();
  }
  close() { clearTimeout(this.timer); this.epoch++; this.session = null; }
  requireSession() {
    this.businessAccess();
    if (!this.session || this.now() >= this.session.expiresAt) { this.close(); throw new Error("消息阅读会话已失效，请刷新会话列表。"); }
    return this.session;
  }
  async operation(fn) {
    const epoch = ++this.epoch;
    const current = () => { this.businessAccess(); if (epoch !== this.epoch) throw new Error("消息页面已变化，未使用旧结果。"); };
    try { this.businessAccess(); return await fn(current); }
    catch (error) { if (epoch === this.epoch) this.close(); throw error; }
  }
  async list(nextHandle = null) {
    return this.operation(async current => {
      const session = nextHandle ? this.requireSession() : null;
      if (nextHandle && (nextHandle !== session.next?.handle || session.chats.size >= 500)) throw new Error("会话分页已失效或达到本次 500 个会话上限，请刷新。");
      if (!nextHandle) { clearTimeout(this.timer); this.session = null; }
      const result = await this.provider.list(session?.next?.token, session?.identity); current();
      if (session) this.requireSession();
      const active = session || { identity: result.identity, expiresAt: this.now() + 300_000, chats: new Map(), selected: null };
      active.next = result.next ? { handle: randomUUID(), token: result.next } : null;
      const chats = [];
      for (const row of result.chats) {
        const existing = [...active.chats.entries()].find(([, chat]) => chat.id === row.id);
        if (existing) continue;
        if (active.chats.size >= 500) break;
        const handle = randomUUID(); active.chats.set(handle, row); chats.push({ ...row, handle });
      }
      this.session = active;
      if (!session) { this.timer = setTimeout(() => this.close(), 300_000); this.timer.unref?.(); }
      return { chats, next: active.chats.size < 500 ? active.next?.handle || null : null, limited: active.chats.size >= 500 && Boolean(active.next), expiresAt: active.expiresAt };
    });
  }
  async read(handle, nextHandle = null) {
    return this.operation(async current => {
      const session = this.requireSession(), chat = session.chats.get(handle);
      if (!chat) throw new Error("请从当前会话列表选择聊天。");
      const previous = session.selected;
      if (nextHandle && (previous?.handle !== handle || previous.next?.handle !== nextHandle)) throw new Error("消息分页已失效，请重新读取。");
      session.selected = null;
      const result = await this.provider.read(chat.id, nextHandle ? previous.next.token : null, session.identity); current(); this.requireSession();
      const selected = { handle, links: new Map(), messages: new Map(), next: result.next ? { handle: randomUUID(), token: result.next } : null };
      const project = row => {
        const replyHandle = !row.deleted && ["text", "post"].includes(row.type) ? randomUUID() : null;
        if (replyHandle) selected.messages.set(replyHandle, structuredClone(row));
        return { ...row, replyHandle, documents: row.documents.map(url => {
        const linkHandle = randomUUID(); selected.links.set(linkHandle, { messageId: row.id, url }); return { handle: linkHandle, url };
      }), replies: row.replies.map(project) }; };
      const rows = result.messages.map(project); session.selected = selected;
      return { chat, messages: rows, next: selected.next?.handle || null, expiresAt: session.expiresAt };
    });
  }
  async document(handle) {
    return this.operation(async current => {
      const session = this.requireSession(), link = session.selected?.links.get(handle);
      if (!link) throw new Error("来源消息链接已失效，请重新选择。");
      const url = await this.provider.resolveDocument(link.messageId, link.url, session.identity); current(); this.requireSession();
      return { url };
    });
  }
  captureSelection(handle) {
    const session = this.requireSession(), chat = session.chats.get(handle);
    if (!chat || session.selected?.handle !== handle) throw new Error("请先读取要自动整理的会话。");
    return { chat: structuredClone(chat), identity: structuredClone(session.identity), current: () => {
      if (this.requireSession() !== session || session.selected?.handle !== handle) throw new Error("会话选择已变化，请重新确认自动整理范围。");
    } };
  }
  captureMessage(handle) {
    const session = this.requireSession(), selected = session.selected, message = selected?.messages.get(handle);
    if (!message) throw new Error("回复目标已失效，请重新读取消息。");
    return { chat: structuredClone(session.chats.get(selected.handle)), message: structuredClone(message), identity: structuredClone(session.identity), current: () => {
      if (this.requireSession() !== session || session.selected !== selected) throw new Error("消息页面已变化，未发送回复。");
    } };
  }
}
