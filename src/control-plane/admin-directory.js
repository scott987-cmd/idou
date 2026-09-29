// Who may administer this deployment.
//
// Two sources, on purpose:
//
//   IDOU_ADMIN_CHAT   a Feishu group. Whoever is in it is an administrator,
//                         so adding and removing one is done in Feishu, where
//                         the operator already manages people, and takes effect
//                         here within a minute. This is the one meant for daily
//                         use.
//   IDOU_ADMIN_USERS  a few open_ids in the deployment file. Changing it
//                         needs a restart, which is the point: it is the way
//                         back in when the group has been deleted, the bot
//                         removed from it, or Feishu cannot be reached. An
//                         escape hatch, not a roster.
//
// A group is used rather than a department because a department is an HR
// structure, not an access group -- and because the identity call this server
// already makes returns no department at all (measured 2026-09-21), so reading
// one would need a scope nobody has verified. A group's members are readable by
// the application's own bot, provided somebody has added that bot to the group.
//
// **Fail closed.** If the group cannot be read -- Feishu down, scope missing,
// bot removed -- nobody is an administrator by way of the group. A deployment
// that opened its console because an upstream was unreachable would be worse
// than one that locked its operator out for a minute, and the escape hatch
// above is exactly what they use meanwhile. What is never done is guessing.
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/;

export const ADMIN_LIMITS = Object.freeze({
  // Long enough that a console page does not become a load test on Feishu,
  // short enough that removing somebody in Feishu takes effect while the person
  // who did it is still watching.
  cacheMs: 60_000,
  // A group big enough to need paging is not an administrator list; refusing to
  // read further is better than pretending the first page is the whole of it.
  members: 500,
});

export function adminUsers(value) {
  const written = String(value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  for (const id of written) if (!OPEN_ID.test(id)) throw new Error(`不是一个飞书 open_id：${id}`);
  return Object.freeze([...new Set(written)]);
}

export function adminChat(value) {
  const id = String(value ?? "").trim();
  if (!id) return null;
  if (!CHAT_ID.test(id)) throw new Error(`不是一个飞书群 id：${id}`);
  return id;
}

export class AdminDirectory {
  // `readChatMembers(chatId)` returns the open_ids in that group, or throws.
  // Injected rather than built here so this file never learns how to talk to
  // Feishu -- and so a test can hold the upstream still.
  constructor({ users = [], chatId = null, readChatMembers = null, now = Date.now, log = () => {} } = {}) {
    this.users = new Set(users);
    this.chatId = chatId;
    this.readChatMembers = readChatMembers;
    this.now = now;
    this.log = log;
    this.cached = null;      // { members: Set, until, failed }
    this.reading = null;
  }

  // Whether this deployment can name an administrator at all. A console with
  // neither source configured is not locked down, it is unreachable, and the
  // difference has to be said out loud at startup rather than discovered.
  get configured() { return this.users.size > 0 || Boolean(this.chatId); }

  async #members() {
    if (this.cached && this.cached.until > this.now()) return this.cached;
    if (this.reading) return this.reading;
    this.reading = (async () => {
      try {
        const ids = await this.readChatMembers(this.chatId);
        const members = new Set((Array.isArray(ids) ? ids : []).slice(0, ADMIN_LIMITS.members).filter((id) => OPEN_ID.test(id)));
        this.cached = { members, until: this.now() + ADMIN_LIMITS.cacheMs, failed: false };
      } catch (error) {
        // Held for the same moment as a success: a Feishu that is refusing must
        // not be asked once per request either.
        this.cached = { members: new Set(), until: this.now() + ADMIN_LIMITS.cacheMs, failed: true,
          why: String(error?.message ?? error).slice(0, 200) };
        this.log(`管理员名单读不到（群 ${this.chatId}）：${this.cached.why}`);
      } finally { this.reading = null; }
      return this.cached;
    })();
    return this.reading;
  }

  // Is this person an administrator, and how do we know. The answer carries its
  // own reason so the console can say "你在管理员群里" rather than only yes.
  async decide(who) {
    const userId = String(who?.userId ?? "");
    if (!OPEN_ID.test(userId)) return { admin: false, reason: "no-identity" };
    if (this.users.has(userId)) return { admin: true, reason: "configured" };
    if (!this.chatId || typeof this.readChatMembers !== "function") {
      return { admin: false, reason: this.configured ? "not-listed" : "no-administrators" };
    }
    const held = await this.#members();
    if (held.failed) return { admin: false, reason: "directory-unreadable", why: held.why };
    return held.members.has(userId) ? { admin: true, reason: "chat-member" } : { admin: false, reason: "not-in-chat" };
  }

  // What the console shows about itself: how many, from where, and whether the
  // group is answering. Never the ids -- a page that lists every administrator
  // is a page worth stealing.
  async status() {
    const from = { configured: this.users.size, chat: this.chatId ? null : 0 };
    let unreadable = null;
    if (this.chatId && typeof this.readChatMembers === "function") {
      const held = await this.#members();
      from.chat = held.failed ? null : held.members.size;
      if (held.failed) unreadable = held.why;
    }
    return { configured: this.configured, chatId: this.chatId, counts: from, ...(unreadable ? { unreadable } : {}) };
  }
}

export const ADMIN_REFUSALS = Object.freeze({
  "no-identity": "请先登录。",
  "no-administrators": "这个部署还没有设置管理员：在部署配置里写 IDOU_ADMIN_CHAT 或 IDOU_ADMIN_USERS。",
  "not-listed": "你不是这个部署的管理员。",
  "not-in-chat": "你不在管理员群里。加入那个群之后最多一分钟生效。",
  "directory-unreadable": "读不到管理员群，暂时无法确认你的身份。请检查应用机器人是否还在那个群里。",
});
export const adminRefusal = (reason) => ADMIN_REFUSALS[reason] ?? ADMIN_REFUSALS["not-listed"];
