import { UNBOUND_CHAT, chatName } from "./feishu-chat-context.js";
import { WEB_IDENTITY } from "../application/web-identity.js";

// Which Feishu conversation the docked Agent may treat as the one on screen.
//
// The embedded messenger never says which conversation is open. Its header
// names one, and a name is a label: two chats can carry it, a person's name can
// also be a group's, and the page may not even be signed in as the account the
// Agent acts as. So a name is turned into one of these, decided here in the
// main process rather than by whatever the renderer believes:
//
//   bound      the person confirmed this chat, or picked it from their own
//              list. Only now does the Agent get its chat id.
//   candidate  exactly one chat in the account's list has this name. Its
//              conversation is shown, but the Agent is told to ask first.
//   ambiguous  several chats have it; the person picks one.
//   unbound    none does, the list cannot be read, or the web pages are signed
//              in as somebody else.
//   none       no current name from the page.
//
// A confirmation is remembered only when the web pages were verified to be the
// signed-in person at the time, and it is used again only while they still are
// and the name still matches exactly one chat. A pick made without that is kept
// for this page only, until anything about the web session changes.
const LIST_MS = 5 * 60_000;
const PAGES = 3;
// The page reports its header every two seconds and at least every ten even
// when nothing changed. A name older than this is from a page that stopped
// speaking -- a closed conversation, a renamed header -- and is not used.
export const NAME_FRESH_MS = 15_000;
const KEEP = 500;

const brief = (chat) => ({ id: chat.id, name: chatName(chat.name) || chat.id, mode: chat.mode ?? "unknown" });

export class DockedChat {
  // listChats(pageToken, identity) -> { chats: [{ id, name, mode }], next, identity }
  // load() -> stored confirmations or null; save(value) persists them.
  // isChat(id) -> whether the deployment would call this a chat id.
  constructor({ listChats, isChat, load = async () => null, save = async () => {}, now = Date.now }) {
    if (typeof listChats !== "function") throw new Error("停靠会话需要会话列表");
    if (typeof isChat !== "function") throw new Error("停靠会话需要知道飞书会话 ID 的格式");
    Object.assign(this, { listChats, isChat, load, save, now });
    this.cache = null;
    this.loading = null;
    this.sticky = new Map();
    this.confirmed = null;
    this.generation = 0;
  }

  // Anything about the web session or the account changed: picks made for the
  // old page and the list read for it no longer describe anything.
  reset() {
    this.generation += 1;
    this.sticky.clear();
    this.cache = null;
    this.loading = null;
  }

  async #confirmations() {
    if (this.confirmed) return this.confirmed;
    const stored = await this.load().catch(() => null);
    const entries = stored?.version === 1 && stored.chats && typeof stored.chats === "object" ? Object.entries(stored.chats) : [];
    this.confirmed = new Map(entries.filter(([id, value]) => this.isChat(id) && chatName(value?.name) && Number.isFinite(value?.at)));
    return this.confirmed;
  }

  // Up to three pages: a name that is unique among thirty chats may not be among
  // ninety, and a false "exactly one" is the mistake this exists to avoid.
  async #list() {
    if (this.cache && this.now() - this.cache.at < LIST_MS) return this.cache;
    if (this.loading) return this.loading;
    const generation = this.generation;
    this.loading = (async () => {
      const chats = new Map();
      let page = await this.listChats(null), pages = 1;
      for (const chat of page?.chats ?? []) if (this.isChat(chat?.id)) chats.set(chat.id, chat);
      while (page?.next && pages < PAGES) {
        page = await this.listChats(page.next, page.identity);
        pages += 1;
        for (const chat of page?.chats ?? []) if (this.isChat(chat?.id)) chats.set(chat.id, chat);
      }
      const listed = { at: this.now(), chats: [...chats.values()], complete: !page?.next };
      if (generation === this.generation) this.cache = listed;
      return listed;
    })().finally(() => { if (generation === this.generation) this.loading = null; });
    return this.loading;
  }

  async state({ name: raw, at, identity }) {
    const name = chatName(raw);
    const fresh = Boolean(name) && Number.isFinite(at) && this.now() - at <= NAME_FRESH_MS;
    const web = identity?.state ?? WEB_IDENTITY.UNVERIFIED;
    const base = { name: fresh ? name : "", identity: web };
    if (!fresh) return { ...base, binding: "none", key: UNBOUND_CHAT };
    const picked = this.sticky.get(name);
    if (picked) return { ...base, binding: "bound", by: "picked", chat: picked, key: picked.id };
    // Signed in as someone else, the page's name says nothing about this
    // account's chats. Nothing is matched; the person can still pick one of
    // their own.
    if (web === WEB_IDENTITY.CONFLICT) return { ...base, binding: "unbound", reason: "web_conflict", key: UNBOUND_CHAT };
    let listed;
    try { listed = await this.#list(); }
    catch { return { ...base, binding: "unbound", reason: "list_unavailable", key: UNBOUND_CHAT }; }
    const matches = listed.chats.filter((chat) => chatName(chat.name) === name);
    if (matches.length > 1) return { ...base, binding: "ambiguous", options: matches.map(brief), key: UNBOUND_CHAT, complete: listed.complete };
    if (matches.length === 0) return { ...base, binding: "unbound", reason: "no_match", key: UNBOUND_CHAT, complete: listed.complete };
    const [only] = matches;
    const chat = brief(only);
    const remembered = (await this.#confirmations()).get(only.id);
    if (web === WEB_IDENTITY.VERIFIED && remembered?.name === name) return { ...base, binding: "bound", by: "confirmed", chat, key: only.id };
    // The conversation shown is this chat's -- local history, the person's own
    // -- but the Agent is not handed the chat until it is confirmed.
    return { ...base, binding: "candidate", chat, key: only.id, complete: listed.complete, remembers: web === WEB_IDENTITY.VERIFIED };
  }

  // Everything the person may pick from: their own chats, as read here.
  async options() {
    const listed = await this.#list();
    return { chats: listed.chats.map(brief), complete: listed.complete };
  }

  // The person says which chat the page shows. `name` is the main process's own
  // current name for the page, never one supplied by the renderer, and the chat
  // must be one this account's list returned.
  async confirm({ name: raw, at, identity, chatId }) {
    const name = chatName(raw);
    if (!name || !Number.isFinite(at) || this.now() - at > NAME_FRESH_MS) throw new Error("左侧没有打开会话，无法确认");
    if (!this.isChat(chatId)) throw new Error("请从会话列表里选择");
    const generation = this.generation;
    const listed = await this.#list();
    if (generation !== this.generation) throw new Error("网页登录状态刚刚变化，请重新确认");
    const chat = listed.chats.find((entry) => entry.id === chatId);
    if (!chat) throw new Error("请从会话列表里选择");
    const matches = listed.chats.filter((entry) => chatName(entry.name) === name);
    const lasting = identity?.state === WEB_IDENTITY.VERIFIED && matches.length === 1 && matches[0].id === chatId;
    if (lasting) {
      const confirmed = await this.#confirmations();
      confirmed.delete(chatId);
      confirmed.set(chatId, { name, at: this.now() });
      while (confirmed.size > KEEP) confirmed.delete(confirmed.keys().next().value);
      this.sticky.delete(name);
      await this.save({ version: 1, chats: Object.fromEntries(confirmed) });
    } else {
      this.sticky.set(name, brief(chat));
    }
    return this.state({ name, at, identity });
  }

  // "Not this one": whatever tied the name to a chat is dropped, the remembered
  // confirmation included.
  async forget({ name: raw, at, identity }) {
    const name = chatName(raw);
    if (name) {
      this.sticky.delete(name);
      const confirmed = await this.#confirmations();
      let changed = false;
      for (const [id, value] of confirmed) if (value.name === name) { confirmed.delete(id); changed = true; }
      if (changed) await this.save({ version: 1, chats: Object.fromEntries(confirmed) });
    }
    return this.state({ name, at, identity });
  }
}
