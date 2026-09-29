// Which models a person may use.
//
// Two things have to agree, and only one of them is what anybody sees:
//
//   model-choice.js   the list somebody is offered, and the one their work
//                     falls back to. This is the visible half.
//   model-gateway.js  whether a request naming a model is answered. This is
//                     the half that decides. `model` is a field the client
//                     sends, and an agent in a sandbox can put anything in it,
//                     so filtering the list alone is a lock hung on the door
//                     without being locked.
//
// A rule says who, and which models, in the order they should be offered:
//
//   [ { "who": { "kind": "user", "id": "ou_…" },  "models": ["GLM-5.3"] },
//     { "who": { "kind": "chat", "id": "oc_…" },  "models": ["MiniMax-M3", "GLM-5.3"] },
//     { "who": { "kind": "everyone" },            "models": ["MiniMax-M3"] } ]
//
// The most specific rule that matches wins outright -- user, then chat, then
// everyone -- and rules are not merged. Merging reads well until somebody has
// to work out why a person can see a model, and then it is the worst kind of
// policy: one nobody can hold in their head.
//
// Nothing matched is decided by the deployment, not by this file, and the
// default is **everything**. A release that quietly left every person with no
// model would be an outage dressed as a security improvement.
import { readFile } from "node:fs/promises";
import path from "node:path";

const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/;
const KINDS = ["user", "chat", "everyone"];

export const VISIBILITY_LIMITS = Object.freeze({ rules: 200, cacheMs: 60_000 });

// Parsed once, at startup, against the models this server actually offers: a
// rule naming a model that does not exist is a rule whose author believes
// something untrue, and finding out at request time helps nobody.
export function modelPolicy(value, { models }) {
  if (value === null || value === undefined || value === "") return null;
  const offered = new Set(models ?? []);
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  const rules = Array.isArray(parsed) ? parsed : parsed?.rules;
  if (!Array.isArray(rules)) throw new Error("模型可见性策略应当是一组规则");
  if (rules.length > VISIBILITY_LIMITS.rules) throw new Error(`规则太多（最多 ${VISIBILITY_LIMITS.rules} 条）`);
  return Object.freeze(rules.map((rule, at) => {
    const where = `第 ${at + 1} 条规则`;
    const kind = rule?.who?.kind;
    if (!KINDS.includes(kind)) throw new Error(`${where}的 who.kind 只能是 user / chat / everyone`);
    const id = kind === "everyone" ? null : String(rule.who.id ?? "");
    if (kind === "user" && !OPEN_ID.test(id)) throw new Error(`${where}的 who.id 不是一个飞书 open_id`);
    if (kind === "chat" && !CHAT_ID.test(id)) throw new Error(`${where}的 who.id 不是一个飞书群 id`);
    if (!Array.isArray(rule.models) || !rule.models.length) throw new Error(`${where}没有列出任何模型`);
    for (const model of rule.models) {
      if (typeof model !== "string" || !offered.has(model)) throw new Error(`${where}里的「${model}」不是这个服务端提供的模型`);
    }
    return Object.freeze({ kind, id, models: Object.freeze([...new Set(rule.models)]) });
  }));
}

export class ModelVisibility {
  // `models` is the server's own order, which is what "everything" means and
  // what an unlisted person gets when the deployment says so.
  // `inChat(chatId, userId)` answers group membership, or throws.
  constructor({ rules = null, models, defaultVisible = "all", inChat = null, log = () => {} } = {}) {
    if (!Array.isArray(models) || !models.length) throw new Error("模型可见性需要服务端自己的模型列表");
    if (!["all", "none"].includes(defaultVisible)) throw new Error("defaultVisible 只能是 all 或 none");
    Object.assign(this, { rules, models: [...models], defaultVisible, inChat, log });
  }

  // Off entirely when no rules were configured: then this answers `null`
  // everywhere, and every caller treats null as "no restriction" so the code
  // path a deployment without a policy takes is the one it took before.
  get enabled() { return Array.isArray(this.rules) && this.rules.length > 0; }

  // The models this person may use, in the server's own order. `null` means no
  // restriction at all.
  async visible(who) {
    if (!this.enabled) return null;
    const userId = String(who?.userId ?? "");
    for (const kind of KINDS) {
      for (const rule of this.rules) {
        if (rule.kind !== kind) continue;
        if (kind === "user" && rule.id !== userId) continue;
        if (kind === "chat") {
          // A group that cannot be read does not match. The person then falls
          // through to the next rule -- usually `everyone` -- so what happens
          // when Feishu is unreachable is whatever the deployment already said
          // should happen to somebody unlisted, rather than a separate answer
          // invented here.
          let member = false;
          try { member = typeof this.inChat === "function" && await this.inChat(rule.id, userId); }
          catch (error) { this.log(`模型可见性：读不到群 ${rule.id}：${String(error?.message ?? error).slice(0, 160)}`); }
          if (!member) continue;
        }
        // Kept in the server's order, not the rule's: the order models are
        // offered in is the server's decision and one list should not reorder
        // another. The rule says which, not which first.
        return this.models.filter((model) => rule.models.includes(model));
      }
    }
    return this.defaultVisible === "all" ? [...this.models] : [];
  }

  // What the gateway asks, once per request. Kept separate so the hot path
  // reads as the question it is.
  async allows(who, model) {
    const visible = await this.visible(who);
    return visible === null || visible.includes(model);
  }
}

// Group membership, cached, shared by everything that needs it. One cache so
// that removing somebody from a group takes the same time to matter wherever it
// is asked about.
export function chatMembership({ readChatMembers, cacheMs = VISIBILITY_LIMITS.cacheMs, now = Date.now }) {
  const held = new Map();     // chatId -> { members:Set, until, failed }
  const reading = new Map();
  return {
    async members(chatId) {
      const cached = held.get(chatId);
      if (cached && cached.until > now()) { if (cached.failed) throw new Error(cached.why); return cached.members; }
      if (reading.has(chatId)) return reading.get(chatId);
      const work = (async () => {
        try {
          const members = new Set(await readChatMembers(chatId));
          held.set(chatId, { members, until: now() + cacheMs, failed: false });
          return members;
        } catch (error) {
          // A refusal is held as long as a success, or an upstream that is
          // saying no becomes something this asks on every single request.
          held.set(chatId, { members: new Set(), until: now() + cacheMs, failed: true, why: String(error?.message ?? error) });
          throw error;
        } finally { reading.delete(chatId); }
      })();
      reading.set(chatId, work);
      return work;
    },
    async has(chatId, userId) { return (await this.members(chatId)).has(userId); },
  };
}

// Read from the file an operator names, against the models this server offers.
// Parsed at startup so a rule naming a model that does not exist, or a group id
// that is not one, stops the server rather than surfacing per request.
export async function loadModelPolicy(filename, { models }) {
  if (!filename) return null;
  if (!path.isAbsolute(filename)) throw new Error("模型可见性策略需要一个绝对路径");
  let text;
  try { text = await readFile(filename, "utf8"); }
  catch (error) { throw new Error(`读不到模型可见性策略 ${filename}：${error.message}`); }
  try { return modelPolicy(text, { models }); }
  catch (error) { throw new Error(`模型可见性策略无效（${filename}）：${error.message}`); }
}

export function defaultVisibleFrom(value) {
  const text = String(value ?? "").trim();
  if (!text) return "all";
  if (!["all", "none"].includes(text)) throw new Error("IDOU_MODEL_DEFAULT_VISIBLE 只能是 all 或 none");
  return text;
}
