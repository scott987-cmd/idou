import { createHash, randomUUID } from "node:crypto";
import { parseSaasDocumentReference } from "./document-format.js";
import { cliApiGet } from "./openapi.js";

const hash = value => createHash("sha256").update(value).digest("hex");

const USER_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
// Read-only group record. Bound as a constant so the audited read path cannot be
// reshaped by a caller.
const CHAT_PATH = "/open-apis/im/v1/chats";
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/;
const UNSAFE_TEXT = /[<\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/;
const label = (value, fallback = "", limit = 200) => typeof value === "string" && value ? value.slice(0, limit).replace(/</g, "＜").replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, " ") : fallback;
function payload(result) {
  let value;
  try { value = JSON.parse(result.stdout); } catch {}
  if (result.code !== 0 || value?.ok !== true || value.identity !== "user" || !value.data) throw new Error("飞书联系人或消息操作未确认成功，请检查当前用户权限；不会切换身份或自动重试。");
  return value.data;
}
// Feishu returns null for an empty collection. That is "no results", not an
// incompatible response, and treating it as a failure made every empty search
// look like a broken integration.
function rows(value, limit) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) throw new Error("飞书响应格式不兼容");
  return value;
}
function recipient(user) {
  if (!USER_ID.test(user?.open_id) || user.is_cross_tenant !== false || user.is_activated !== true) return null;
  const clean = (value, limit) => typeof value === "string" && value.length <= limit && !UNSAFE_TEXT.test(value) && !/[\n\t]/.test(value) ? value : "";
  return { id: user.open_id, name: clean(user.localized_name, 200) || user.open_id, department: clean(user.department, 500), email: clean(user.enterprise_email || user.email, 320) };
}
export function sameSender(a, b) { return Boolean(a?.principal && a?.tenantKey && a.principal === b?.principal && a.tenantKey === b?.tenantKey); }
export class SaasMessageDelivery {
  constructor(cli) { this.cli = cli; }
  async search(query) {
    if (typeof query !== "string" || !query.trim() || [...query].length > 50 || UNSAFE_TEXT.test(query) || /[\n\t]/.test(query)) throw new Error("请输入 1–50 字的姓名或邮箱");
    const identity = await this.cli.documentIdentity();
    if (!identity.tenantKey) throw new Error("尚未确认飞书租户，不能选择收件人");
    const data = payload(await this.cli.invoke(["contact", "+search-user", "--query", query.trim(), "--exclude-external-users", "--page-size", "20", "--lang", "zh_cn", "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }));
    if (typeof data.has_more !== "boolean") throw new Error("飞书联系人响应格式不兼容");
    const found = rows(data.users, 30), users = found.map(recipient).filter(Boolean);
    if (new Set(users.map(user => user.id)).size !== users.length) throw new Error("飞书联系人标识重复，请重新搜索");
    if (!sameSender(identity, await this.cli.documentIdentity())) throw new Error("搜索期间飞书身份已变化");
    return { identity, users, hasMore: data.has_more, excluded: found.length - users.length };
  }
  async searchGroups(query) {
    if (typeof query !== "string" || !query.trim() || [...query].length > 64 || UNSAFE_TEXT.test(query) || /[\n\t]/.test(query)) throw new Error("请输入 1–64 字的群名称");
    const identity = await this.cli.documentIdentity();
    if (!identity.tenantKey) throw new Error("尚未确认飞书租户，不能选择群聊");
    const data = payload(await this.cli.invoke(["im", "+chat-search", "--query", query.trim(), "--search-types", "private,public_joined", "--disable-search-by-user", "--page-size", "20", "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }));
    if (typeof data.has_more !== "boolean") throw new Error("飞书群搜索响应格式不兼容");
    const found = rows(data.chats, 100), groups = found.filter(chat => CHAT_ID.test(chat?.chat_id) && chat.external === false && chat.chat_status === "normal").map(chat => ({ kind: "group", id: chat.chat_id, name: label(chat.name, chat.chat_id), ownerId: label(chat.owner_id), description: label(chat.description, "", 500) }));
    if (new Set(groups.map(group => group.id)).size !== groups.length) throw new Error("飞书群标识重复，请重新搜索");
    if (!sameSender(identity, await this.cli.documentIdentity())) throw new Error("群搜索期间飞书身份已变化");
    return { identity, groups, hasMore: data.has_more, excluded: found.length - groups.length };
  }
  async groupMembers(target, identity) {
    if (!CHAT_ID.test(target?.id) || target.kind !== "group") throw new Error("群选择无效");
    if (!sameSender(identity, await this.cli.documentIdentity())) throw new Error("飞书身份已变化，未读取群成员");
    // The group's own record, read through the read-only API passthrough the
    // login bridge already permits.
    const info = payload(await this.cli.invoke([...cliApiGet(`${CHAT_PATH}/${target.id}?user_id_type=open_id`), "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }));
    if (info.chat_id !== undefined && info.chat_id !== target.id || info.external !== false || info.tenant_key !== identity.tenantKey || info.chat_status !== "normal" || !["group", "topic"].includes(info.chat_mode) || !["private", "public"].includes(info.chat_type)) throw new Error("群已失效、跨租户或资料不完整，未发送");
    const group = { kind: "group", id: target.id, name: label(info.name, target.id), ownerId: label(info.owner_id), description: label(info.description, "", 500),
      tenantKey: info.tenant_key, chatType: info.chat_type, chatMode: info.chat_mode,
      memberCount: /^(0|[1-9]\d*)$/.test(String(info.user_count)) && Number.isSafeInteger(Number(info.user_count)) ? Number(info.user_count) : null };
    if (group.name !== target.name || group.ownerId !== target.ownerId || target.chatType && JSON.stringify(group) !== JSON.stringify(target)) throw new Error("群名称、群主或群资料已变化，请重新选择群聊");
    const data = payload(await this.cli.invoke(["im", "+chat-members-list", "--chat-id", target.id, "--member-types", "user", "--member-id-type", "open_id", "--page-size", "100", "--page-all", "--page-limit", "10", "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 }));
    if (data.chat_id !== target.id || typeof data.has_more !== "boolean" || data.truncations !== undefined && data.truncations !== null && !Array.isArray(data.truncations)) throw new Error("群成员响应目标或格式不兼容");
    const listed = rows(data.users, 1000), members = listed.filter(user => USER_ID.test(user?.member_id) && user.tenant_key === identity.tenantKey).map(user => ({ id: user.member_id, name: label(user.name, user.member_id), tenantKey: user.tenant_key }));
    if (new Set(members.map(user => user.id)).size !== members.length) throw new Error("群成员标识重复，请重新读取");
    if (!sameSender(identity, await this.cli.documentIdentity())) throw new Error("读取群成员期间飞书身份已变化");
    return { group, members, partial: data.has_more || Boolean(data.truncations?.length), excluded: listed.length - members.length };
  }
  async send({ identity, recipient: target, text, sourceUrl, idempotencyKey, mentions = [] }, beforeDispatch) {
    const group = target?.kind === "group";
    if (!(group ? CHAT_ID : USER_ID).test(target?.id) || typeof text !== "string" || !text || text.length > 4000 || UNSAFE_TEXT.test(text) || !/^[A-Za-z0-9-]{1,50}$/.test(idempotencyKey) || !Array.isArray(mentions) || mentions.length > 10 || !group && mentions.length || mentions.some(user => !USER_ID.test(user?.id)) || new Set(mentions.map(user => user.id)).size !== mentions.length) throw new Error("消息发送参数无效");
    if (group && (parseSaasDocumentReference(sourceUrl).url !== sourceUrl || text.split("\n")[1] !== sourceUrl)) throw new Error("群消息链接与文档预览不一致，未发送");
    if (!sameSender(identity, await this.cli.documentIdentity({ fresh: true }))) throw new Error("飞书发送身份已变化，未发送");
    let args, wireContent;
    if (group) {
      const current = await this.groupMembers(target, identity);
      if (mentions.some(user => !current.members.some(member => JSON.stringify(member) === JSON.stringify(user)))) throw new Error("选中的 @ 成员已离群、改名或不再可见，请重新选择，未发送");
      // Static post nodes, never user-authored markup or @all. The recipient is the group, not only the mentioned people.
      const content = [];
      if (mentions.length) content.push(mentions.map(user => ({ tag: "at", user_id: user.id })));
      const prefix = `${text.split("\n")[0]}\n`, suffix = text.slice(prefix.length + sourceUrl.length);
      // Explicit hyperlink, bound to the canonical source, rather than relying on text auto-linking.
      content.push([{ tag: "text", text: prefix }, { tag: "a", href: sourceUrl, text: sourceUrl }, ...(suffix ? [{ tag: "text", text: suffix }] : [])]);
      // The CLI forwards this string verbatim as the message `content` field.
      wireContent = JSON.stringify({ zh_cn: { content } });
      args = ["--chat-id", target.id, "--msg-type", "post", "--content", wireContent];
    } else {
    const data = payload(await this.cli.invoke(["contact", "+search-user", "--user-ids", target.id, "--exclude-external-users", "--lang", "zh_cn", "--as", "user", "--format", "json"], { timeoutMs: 30_000, maxOutputBytes: 256 * 1024 }));
    if (!Array.isArray(data.users) || data.users.length !== 1 || JSON.stringify(recipient(data.users[0])) !== JSON.stringify(target)) throw new Error("收件人资料或租户状态已变化，请重新选择，未发送");
      wireContent = JSON.stringify({ text });
      args = ["--user-id", target.id, "--text", text];
    }
    if (!sameSender(identity, await this.cli.documentIdentity({ fresh: true }))) throw new Error("飞书发送身份已变化，未发送");
    // The application persists the exact one-shot intent and rechecks its reader here.
    await beforeDispatch();
    try {
      const sent = payload(await this.cli.invoke(["im", "+messages-send", ...args, "--idempotency-key", idempotencyKey, "--as", "user", "--format", "json"], {
        timeoutMs: 30_000, maxOutputBytes: 256 * 1024,
        // Bound to this recipient, this exact payload and this idempotency key.
        feishuWriteIntent: { action: "message.send", operationId: randomUUID(), receiveIdType: group ? "chat_id" : "open_id",
          receiveId: target.id, msgType: group ? "post" : "text", contentHash: hash(wireContent), idempotencyKey },
      }));
      if (!/^om_[A-Za-z0-9_-]{1,128}$/.test(sent.message_id) || !CHAT_ID.test(sent.chat_id) || group && sent.chat_id !== target.id) throw new Error("missing or mismatched receipt");
      return { messageId: sent.message_id, chatId: sent.chat_id };
    } catch { throw new Error("消息可能已发送，但回执未确认。请到飞书核查；本应用不会重试这次发送。"); }
  }
}
