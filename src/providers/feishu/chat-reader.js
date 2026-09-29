import { createHash, randomUUID } from "node:crypto";
import { parseSaasDocumentReference } from "./document-format.js";
import { FeishuRuntimeRefused } from "./bundled-runtime.js";

const hash = value => createHash("sha256").update(value).digest("hex");

const chatId = /^oc_[A-Za-z0-9_-]{1,128}$/, messageId = /^om_[A-Za-z0-9_-]{1,128}$/;
const failure = () => new Error("飞书消息读取失败，请检查当前 CLI 用户登录、消息权限与网络；未使用缓存替代授权。");
const label = (value, fallback = "") => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 300) : fallback;
function cursor(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw failure();
  return value;
}
function pagination(data) {
  if (typeof data?.has_more !== "boolean") throw failure();
  const next = data.has_more ? cursor(data.page_token) : null;
  if (data.has_more && !next) throw failure();
  return next;
}
function sameIdentity(a, b) {
  if (!a?.principal || !a.tenantKey || a.principal !== b?.principal || a.tenantKey !== b.tenantKey) throw new Error("飞书消息阅读身份已变化或缺少企业身份，请重新读取会话。");
}
function documentLinks(text) {
  const links = new Set();
  for (const match of text.matchAll(/https:\/\/[^\s<>"'\[\]()，。；！？、]+/g)) {
    try { links.add(parseSaasDocumentReference(match[0]).url); } catch { /* Not a supported document reference. */ }
    if (links.size === 20) break;
  }
  return [...links];
}
function messages(rows, depth = 0, budget = { remaining: 550 }) {
  if (!Array.isArray(rows) || rows.length > (depth ? 500 : 50)) throw failure();
  const seen = new Set();
  return rows.map(row => {
    if (--budget.remaining < 0 || !messageId.test(row?.message_id) || seen.has(row.message_id) || typeof row.deleted !== "boolean") throw failure();
    seen.add(row.message_id);
    if (!row.deleted && (typeof row.content !== "string" || Buffer.byteLength(row.content) > 64 * 1024)) throw failure();
    const text = row.deleted ? "此消息已撤回" : row.content;
    // CLI content is already a readable projection. Never interpret it as HTML,
    // Markdown media, card actions, shell commands, or executable resources.
    const result = { id: row.message_id, type: label(row.msg_type, "unknown"), text,
      sender: label(row.sender?.name, label(row.sender?.id, "未知发送者")), senderId: label(row.sender?.id),
      createdAt: label(row.create_time), deleted: row.deleted, edited: row.updated === true,
      documents: row.deleted ? [] : documentLinks(text), replies: [],
      threadPartial: row.thread_has_more === true || row.thread_replies_error === true };
    if (!depth && row.thread_replies !== undefined) result.replies = messages(row.thread_replies, 1, budget);
    if (depth && row.thread_replies?.length) result.threadPartial = true;
    return result;
  });
}

// SaaS-specific argv and response projection stay behind the replaceable provider.
export class SaasChatReader {
  constructor(provider) { this.provider = provider; }
  async request(args, expectedIdentity, { signal } = {}) {
    try {
      const identity = await this.provider.documentIdentity({ signal });
      sameIdentity(identity, expectedIdentity || identity);
      const result = await this.provider.invoke(["im", ...args, "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024, signal });
      if (result.code !== 0) throw failure();
      const payload = JSON.parse(result.stdout);
      if (payload.ok !== true || payload.identity !== "user" || !payload.data) throw failure();
      const current = await this.provider.documentIdentity({ signal }); sameIdentity(identity, current);
      return { data: payload.data, identity: current };
    } catch (error) {
      // The application refusing to run its own CLI is no login, permission or
      // network matter, and is not reported as one.
      throw error instanceof FeishuRuntimeRefused ? error : failure();
    }
  }
  async list(pageToken = null, identity) {
    const next = cursor(pageToken);
    const result = await this.request(["+chat-list", "--types", "p2p,group", "--sort", "active_time", "--page-size", "30", ...(next ? ["--page-token", next] : [])], identity);
    // Feishu returns null for an empty collection; that is "no chats", not a fault.
    const rows = result.data.chats ?? [];
    if (!Array.isArray(rows) || rows.length > 100) throw failure();
    const seen = new Set();
    const chats = rows.map(row => {
      if (!chatId.test(row?.chat_id) || seen.has(row.chat_id)) throw failure(); seen.add(row.chat_id);
      return { id: row.chat_id, name: label(row.name, row.chat_id), description: label(row.description),
        mode: ["p2p", "group", "topic"].includes(row.chat_mode) ? row.chat_mode : "unknown",
        external: typeof row.external === "boolean" ? row.external : null, status: label(row.chat_status, "unknown") };
    });
    return { chats, next: pagination(result.data), identity: result.identity };
  }
  async read(id, pageToken, identity, { signal, start, end } = {}) {
    if (!chatId.test(id)) throw failure(); const next = cursor(pageToken);
    const range = [];
    if (start !== undefined || end !== undefined) {
      if (![start, end].every(value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))) || Date.parse(start) >= Date.parse(end)) throw failure();
      range.push("--start", start, "--end", end);
    }
    const result = await this.request(["+chat-messages-list", "--chat-id", id, "--order", "desc", "--page-size", "30", "--no-reactions", ...range, ...(next ? ["--page-token", next] : [])], identity, { signal });
    if (result.data.chat_id !== undefined && result.data.chat_id !== id) throw failure();
    return { messages: messages(result.data.messages), next: pagination(result.data), identity: result.identity };
  }
  async resolveDocument(id, url, identity, { signal } = {}) {
    if (!messageId.test(id)) throw failure();
    const result = await this.request(["+messages-mget", "--message-ids", id, "--no-reactions"], identity, { signal });
    const rows = messages(result.data.messages);
    if (rows.length !== 1 || rows[0].id !== id || rows[0].deleted || !rows[0].documents.includes(url)) throw new Error("来源消息已撤回、修改或不可见，请重新读取消息。");
    return url;
  }
  async verifyReplyTarget({ chat, message, identity }) {
    if (!chatId.test(chat?.id) || !messageId.test(message?.id)) throw failure();
    const result = await this.request(["+messages-mget", "--message-ids", message.id, "--no-reactions"], identity);
    const rows = messages(result.data.messages), fresh = rows[0];
    const fields = ["id", "type", "text", "sender", "senderId", "createdAt", "deleted", "edited"];
    if (rows.length !== 1 || fresh.deleted || !["text", "post"].includes(fresh.type) || fields.some(key => fresh[key] !== message[key]) ||
      result.data.messages[0].chat_id !== undefined && result.data.messages[0].chat_id !== chat.id) throw new Error("回复来源已修改、撤回或不匹配，请刷新消息后重新确认。");
  }
  async reply({ chat, message, identity, text, inThread, idempotencyKey }, beforeDispatch) {
    if (!chatId.test(chat?.id) || !messageId.test(message?.id) || typeof text !== "string" || !text.trim() || text.length > 2000 || /[<\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(text) || typeof inThread !== "boolean" || !/^[A-Za-z0-9-]{1,50}$/.test(idempotencyKey)) throw new Error("回复参数无效；仅支持不含提及标签的纯文本。");
    await this.verifyReplyTarget({ chat, message, identity });
    // No retry, identity fallback, resource download, or markdown interpretation.
    await beforeDispatch();
    try {
      sameIdentity(identity, await this.provider.documentIdentity());
      const result = await this.provider.invoke(["im", "+messages-reply", "--message-id", message.id, "--text", text,
        ...(inThread ? ["--reply-in-thread"] : []), "--idempotency-key", idempotencyKey, "--as", "user", "--format", "json"], {
        timeoutMs: 30_000, maxOutputBytes: 256 * 1024,
        // Placement is part of the confirmation: a thread reply and a main-chat
        // reply are different granted requests.
        feishuWriteIntent: { action: "message.reply", operationId: randomUUID(), messageId: message.id,
          replyInThread: inThread, contentHash: hash(JSON.stringify({ text })), idempotencyKey },
      });
      const response = JSON.parse(result.stdout), data = response.data;
      if (result.code !== 0 || response.ok !== true || response.identity !== "user" || !messageId.test(data?.message_id) || data.chat_id !== chat.id || data.message_id === message.id) throw failure();
      return { messageId: data.message_id, chatId: data.chat_id };
    } catch { throw new Error("回复可能已发送，但回执未确认。请到飞书核查，不要重复发送。"); }
  }
}
