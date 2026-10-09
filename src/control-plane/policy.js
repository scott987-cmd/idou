// What each person may use, set by administrators (docs/admin-console.md §7):
// which models and which one by default, how many tokens a day and what to
// move to past that, and which features are on.
//
// A rule says who it is for -- everyone, a Feishu group, one person (and,
// with the organisation's structure, a department) -- and sets any of those
// fields. A person's effective policy is resolved field by field: for each
// field, the most specific rule that sets it decides (a person over a group
// over everyone). Rules at the same level that both apply are combined the
// cautious way: a feature is on only if all of them allow it, the models are
// those all of them allow, a quota is the smallest.
//
// The deployment's own settings are the ceiling. A feature the deployment
// has not turned on (scheduled tasks without IDOU_SCHEDULED_TASKS, a Feishu
// write the server does not offer) is off whatever a rule says; a rule can
// only take away. Rules from IDOU_MODEL_POLICY_FILE are read as they always
// were, as rules about models, beside the console's own.
//
// Asked on every model request and every outward action, so a person's
// effective policy is held for a minute, and everything is forgotten the
// moment any rule changes anywhere (the administration database announces it).
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export const FEATURES = Object.freeze({
  scheduledTasks: "定时任务",
  unattended: "无人值守运行",
  sitesPublish: "发布文档网站",
  sitesAnonymous: "网站免登录链接",
  mediaImage: "生成图片",
  mediaVideo: "生成视频",
  feishuDocument: "Agent 写飞书文档",
  feishuMessage: "Agent 发飞书消息",
  feishuDrive: "Agent 上传到云盘",
  feishuDelete: "Agent 删除飞书内容",
  fullAccess: "任务的「完全访问」",
});
export const FEATURE_KEYS = Object.freeze(Object.keys(FEATURES));
// The one switch the server cannot see being used: a desktop decides whether
// a write goes through a card or not. Enforced by the desktop; the console says so.
export const CLIENT_ENFORCED = Object.freeze(["fullAccess"]);
// The Feishu write capability a session carries (feishu-cli-write contract), by feature.
export const FEISHU_FEATURES = Object.freeze({ cliDocumentWrites: "feishuDocument", cliMessageWrites: "feishuMessage", cliDriveWrites: "feishuDrive", cliDestructiveWrites: "feishuDelete" });

export const POLICY_LIMITS = Object.freeze({ rules: 2000, noteChars: 200, cacheMs: 60_000, cached: 200_000, dailyTokensMax: 1e12, concurrencyMax: 64 });
const KINDS = Object.freeze(["user", "chat", "department", "everyone"]);
const RANK = Object.freeze({ user: 0, chat: 1, department: 2, everyone: 3 });
const TARGET_ID = Object.freeze({ user: /^ou_[A-Za-z0-9_-]{1,128}$/, chat: /^oc_[A-Za-z0-9_-]{1,128}$/, department: /^[A-Za-z0-9_-]{1,128}$/ });

// A rule's settings, checked against what this server actually offers. Every
// field optional; an absent field is "not said here".
export function policySettings(value, { models }) {
  const offered = new Set(models);
  const settings = {};
  const input = value && typeof value === "object" ? value : {};
  if (input.models !== undefined && input.models !== null) {
    const allowed = input.models.allowed === undefined || input.models.allowed === null ? null : input.models.allowed;
    if (allowed !== null && (!Array.isArray(allowed) || !allowed.length || allowed.some((model) => !offered.has(model)))) throw new Error("能用的模型要是这个服务端提供的模型，至少一个");
    const preferred = input.models.default ?? null;
    if (preferred !== null && (!offered.has(preferred) || (allowed && !allowed.includes(preferred)))) throw new Error("默认模型要在能用的模型里");
    if (allowed || preferred) settings.models = { ...(allowed ? { allowed: [...new Set(allowed)] } : {}), ...(preferred ? { default: preferred } : {}) };
  }
  if (input.quota !== undefined && input.quota !== null) {
    const { dailyTokens = null, downgradeTo = null, concurrency = null } = input.quota;
    if (dailyTokens !== null && (!Number.isSafeInteger(dailyTokens) || dailyTokens < 1 || dailyTokens > POLICY_LIMITS.dailyTokensMax)) throw new Error("每天的 token 额度要是正整数");
    if (downgradeTo !== null && !offered.has(downgradeTo)) throw new Error("超额后换用的模型要是这个服务端提供的模型");
    if (downgradeTo !== null && dailyTokens === null) throw new Error("设了超额后换用的模型，也要设每天的额度");
    if (concurrency !== null && (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > POLICY_LIMITS.concurrencyMax)) throw new Error(`同时进行的请求数要在 1 到 ${POLICY_LIMITS.concurrencyMax} 之间`);
    if (dailyTokens !== null || concurrency !== null) settings.quota = { ...(dailyTokens !== null ? { dailyTokens } : {}), ...(downgradeTo !== null ? { downgradeTo } : {}), ...(concurrency !== null ? { concurrency } : {}) };
  }
  if (input.features !== undefined && input.features !== null) {
    if (typeof input.features !== "object" || Array.isArray(input.features)) throw new Error("功能开关的格式不对");
    const features = {};
    for (const [key, on] of Object.entries(input.features)) {
      if (!FEATURE_KEYS.includes(key)) throw new Error(`没有「${key}」这个功能开关`);
      if (on === null || on === undefined) continue;
      if (typeof on !== "boolean") throw new Error(`「${FEATURES[key]}」只能是开或关`);
      features[key] = on;
    }
    if (Object.keys(features).length) settings.features = features;
  }
  return settings;
}

export function policyTarget(value) {
  const kind = String(value?.kind ?? "");
  if (!KINDS.includes(kind)) throw new Error("规则的对象只能是所有人、部门、群或某个人");
  if (kind === "everyone") return { kind, id: "" };
  const id = String(value?.id ?? "").trim();
  if (!TARGET_ID[kind].test(id)) throw new Error(kind === "user" ? "不是一个飞书 open_id" : kind === "chat" ? "不是一个飞书群 id（oc_ 开头）" : "部门 id 无效");
  return { kind, id };
}

export class PolicyStore extends EventEmitter {
  // `fileRules`: the rules from IDOU_MODEL_POLICY_FILE (model-visibility.js),
  // read as they always were -- models only, for every tenant, not editable here.
  static async open({ db, models, fileRules = null, now = Date.now, log = () => {} }) {
    if (!db?.dialect) throw new Error("策略需要管理库");
    await db.schema("admin-policies", `
      CREATE TABLE IF NOT EXISTS idou_admin_policies (
        id text NOT NULL PRIMARY KEY,
        tenant text NOT NULL,
        target_kind text NOT NULL,
        target_id text NOT NULL DEFAULT '',
        settings text NOT NULL,
        note text NOT NULL DEFAULT '',
        created_by text NOT NULL DEFAULT '', created_by_name text NOT NULL DEFAULT '', created_at bigint NOT NULL,
        updated_by text NOT NULL DEFAULT '', updated_by_name text NOT NULL DEFAULT '', updated_at bigint NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idou_admin_policies_tenant ON idou_admin_policies (tenant, target_kind, target_id);`);
    const store = new PolicyStore({ db, models, fileRules, now, log });
    await store.reload();
    store.onChange = ({ topic }) => { if (topic === "policy" || topic === "reset") void store.reload().catch(() => {}); };
    db.on("change", store.onChange);
    store.timer = setInterval(() => { void store.reload().catch(() => {}); }, 5 * 60_000);
    store.timer.unref?.();
    return store;
  }

  constructor({ db, models, fileRules, now, log }) {
    super();
    Object.assign(this, { db, models: [...models], now, log });
    this.held = [];
    this.revision = 0;
    // Rules from the deployment file: models only, every tenant, read-only.
    this.fileRules = (fileRules ?? []).map((rule, index) => Object.freeze({ id: `file-${index + 1}`, tenantId: "*", source: "file",
      target: { kind: rule.kind, id: rule.id ?? "" }, settings: { models: { allowed: [...rule.models] } }, note: "部署配置文件（IDOU_MODEL_POLICY_FILE）" }));
  }

  // Every rule that can apply in a tenant: the file's and the tenant's own.
  rules(tenantId) { return [...this.fileRules, ...this.held.filter((rule) => rule.tenantId === tenantId)]; }
  get(id) { return this.held.find((rule) => rule.id === id) ?? null; }
  get size() { return this.held.length; }

  async create({ tenantId, target, settings, note = "", by }) {
    const checked = { target: policyTarget(target), settings: policySettings(settings, { models: this.models }) };
    if (!Object.keys(checked.settings).length) throw new Error("规则什么都没设");
    if (this.held.length >= POLICY_LIMITS.rules) throw new Error(`规则最多 ${POLICY_LIMITS.rules} 条`);
    if (this.held.some((rule) => rule.tenantId === tenantId && rule.target.kind === checked.target.kind && rule.target.id === checked.target.id)) {
      throw new Error("这个对象已经有一条规则了，请修改那一条");
    }
    const id = randomUUID(), at = this.now();
    await this.db.run(`INSERT INTO idou_admin_policies (id, tenant, target_kind, target_id, settings, note, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, tenantId, checked.target.kind, checked.target.id, JSON.stringify(checked.settings), String(note ?? "").slice(0, POLICY_LIMITS.noteChars),
      String(by?.userId ?? ""), String(by?.name ?? "").slice(0, 64), at, String(by?.userId ?? ""), String(by?.name ?? "").slice(0, 64), at]);
    await this.#changed();
    return this.get(id);
  }

  async update(id, { tenantId, settings, note, by }) {
    const before = this.get(id);
    if (!before || before.tenantId !== tenantId) throw new Error("没有这条规则");
    const checked = policySettings(settings, { models: this.models });
    if (!Object.keys(checked).length) throw new Error("规则什么都没设；不要了可以删除它");
    await this.db.run("UPDATE idou_admin_policies SET settings = ?, note = ?, updated_by = ?, updated_by_name = ?, updated_at = ? WHERE id = ? AND tenant = ?",
      [JSON.stringify(checked), String(note ?? before.note ?? "").slice(0, POLICY_LIMITS.noteChars), String(by?.userId ?? ""), String(by?.name ?? "").slice(0, 64), this.now(), id, tenantId]);
    await this.#changed();
    return { before, after: this.get(id) };
  }

  async remove(id, { tenantId }) {
    const before = this.get(id);
    if (!before || before.tenantId !== tenantId) throw new Error("没有这条规则");
    await this.db.run("DELETE FROM idou_admin_policies WHERE id = ? AND tenant = ?", [id, tenantId]);
    await this.#changed();
    return before;
  }

  async #changed() { await this.reload(); await this.db.announce("policy", { revision: this.revision }); }

  async reload() {
    const rows = await this.db.all(`SELECT id, tenant, target_kind, target_id, settings, note, created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at
      FROM idou_admin_policies ORDER BY tenant, target_kind, target_id LIMIT ${POLICY_LIMITS.rules}`);
    const next = [];
    for (const row of rows) {
      let settings;
      // Checked again against what this process offers: a rule naming a
      // model this server no longer has keeps the rest of what it says.
      try { settings = JSON.parse(row.settings); } catch { continue; }
      if (settings?.models?.allowed) settings.models.allowed = settings.models.allowed.filter((model) => this.models.includes(model));
      if (settings?.models?.allowed && !settings.models.allowed.length) delete settings.models.allowed;
      if (settings?.models?.default && !this.models.includes(settings.models.default)) delete settings.models.default;
      if (settings?.models && !Object.keys(settings.models).length) delete settings.models;
      if (settings?.quota?.downgradeTo && !this.models.includes(settings.quota.downgradeTo)) delete settings.quota.downgradeTo;
      next.push(Object.freeze({ id: row.id, tenantId: row.tenant, source: "console", target: { kind: row.target_kind, id: row.target_id }, settings, note: row.note,
        created: { userId: row.created_by, name: row.created_by_name, at: Number(row.created_at) }, updated: { userId: row.updated_by, name: row.updated_by_name, at: Number(row.updated_at) } }));
    }
    this.held = next;
    this.revision += 1;
    this.emit("changed");
  }

  close() {
    clearInterval(this.timer);
    if (this.onChange) this.db.off("change", this.onChange);
  }
}

// Somebody's effective policy, and the questions every enforcement point asks.
export class PolicyEngine {
  // `ceilings`: what this deployment offers at all, { feature: boolean }.
  // `inChat(chatId, userId)` answers group membership; `org` (org-directory.js)
  // which departments a person is in, with those above, and how deep each is.
  // `defaultVisible`: IDOU_MODEL_DEFAULT_VISIBLE for whom no rule names models.
  constructor({ store, models, ceilings = {}, inChat = null, org = null, defaultVisible = "all", now = Date.now, log = () => {} }) {
    Object.assign(this, { store, models: [...models], ceilings, inChat, org, defaultVisible, now, log });
    this.cache = new Map();
    store.on("changed", () => this.cache.clear());
  }

  // Compatible with model-visibility.js: whether any rule names models.
  get enabled() { return this.store.fileRules.length > 0 || this.store.held.some((rule) => rule.settings.models); }
  get rules() { return this.store.fileRules.map((rule) => ({ kind: rule.target.kind, id: rule.target.id, models: rule.settings.models.allowed })); }

  async #matches(rule, who) {
    const { kind, id } = rule.target;
    if (kind === "everyone") return true;
    if (kind === "user") return id === who.userId;
    if (kind === "chat") {
      if (typeof this.inChat !== "function") return false;
      try { return await this.inChat(id, who.userId) === true; }
      catch (error) { this.log(`策略：读不到群 ${id}：${String(error?.message ?? error).slice(0, 160)}`); return false; }
    }
    if (kind === "department") {
      if (!this.org) return false;
      try { return (await this.org.departmentsOf(who)).includes(id); } catch { return false; }
    }
    return false;
  }

  // Field by field: the most specific level that says something decides;
  // several rules at that level are combined the cautious way. `sources` names
  // the rule behind each field, for the console's 「为什么」.
  async effective(who) {
    const key = `${who.tenantId}\n${who.userId}`, held = this.cache.get(key);
    if (held && held.until > this.now() && held.revision === this.store.revision) return held.value;
    const matched = [];
    for (const rule of this.store.rules(who.tenantId)) if (await this.#matches(rule, who)) matched.push(rule);
    matched.sort((a, b) => RANK[a.target.kind] - RANK[b.target.kind]);
    // The levels, most specific first: the person, their groups, their
    // departments from the nearest up, everyone. Two departments at the same
    // depth are one level, combined like two groups.
    const departmental = matched.filter((rule) => rule.target.kind === "department");
    const depths = departmental.length && this.org ? await this.org.depths(who.tenantId, departmental.map((rule) => rule.target.id)).catch(() => new Map()) : new Map();
    const levels = [matched.filter((rule) => rule.target.kind === "user"), matched.filter((rule) => rule.target.kind === "chat"),
      ...[...new Set(departmental.map((rule) => depths.get(rule.target.id) ?? 0))].sort((a, b) => b - a)
        .map((depth) => departmental.filter((rule) => (depths.get(rule.target.id) ?? 0) === depth)),
      matched.filter((rule) => rule.target.kind === "everyone")];
    const decide = (pick) => {
      for (const level of levels) {
        const setting = level.filter((rule) => pick(rule) !== undefined);
        if (setting.length) return { values: setting.map(pick), rules: setting };
      }
      return null;
    };
    const sources = {};
    // Models: allowed is the intersection at the deciding level; the default
    // is the first that level names which is still allowed.
    const allowedAt = decide((rule) => rule.settings.models?.allowed);
    let allowed = allowedAt ? this.models.filter((model) => allowedAt.values.every((list) => list.includes(model))) : null;
    if (allowedAt) sources.models = allowedAt.rules.map((rule) => rule.id);
    if (!allowedAt && this.defaultVisible === "none" && this.enabled) allowed = [];
    const defaultAt = decide((rule) => rule.settings.models?.default);
    const usable = allowed ?? this.models;
    let preferred = defaultAt ? defaultAt.values.find((model) => usable.includes(model)) ?? null : null;
    if (defaultAt) sources.defaultModel = defaultAt.rules.map((rule) => rule.id);
    if (!preferred) preferred = usable[0] ?? null;
    // Quota: the smallest at the deciding level; its move-to model with it.
    const tokensAt = decide((rule) => rule.settings.quota?.dailyTokens);
    let dailyTokens = null, downgradeTo = null;
    if (tokensAt) {
      const smallest = tokensAt.rules.reduce((best, rule) => (!best || rule.settings.quota.dailyTokens < best.settings.quota.dailyTokens ? rule : best), null);
      dailyTokens = smallest.settings.quota.dailyTokens; downgradeTo = smallest.settings.quota.downgradeTo ?? null;
      if (downgradeTo && !usable.includes(downgradeTo)) downgradeTo = null;
      sources.dailyTokens = tokensAt.rules.map((rule) => rule.id);
    }
    const concurrencyAt = decide((rule) => rule.settings.quota?.concurrency);
    const concurrency = concurrencyAt ? Math.min(...concurrencyAt.values) : null;
    if (concurrencyAt) sources.concurrency = concurrencyAt.rules.map((rule) => rule.id);
    // Features: on only if every rule at the deciding level allows it, and
    // the deployment offers it at all.
    const features = {};
    for (const feature of FEATURE_KEYS) {
      const at = decide((rule) => rule.settings.features?.[feature]);
      const offered = this.ceilings[feature] !== false;
      features[feature] = offered && (at ? at.values.every(Boolean) : true);
      if (at) sources[feature] = at.rules.map((rule) => rule.id);
    }
    const value = Object.freeze({ models: { allowed: allowed ? [preferred, ...allowed.filter((model) => model !== preferred)].filter(Boolean) : null, default: preferred },
      quota: { dailyTokens, downgradeTo, concurrency }, features, sources, matched: matched.map((rule) => rule.id) });
    if (this.cache.size >= POLICY_LIMITS.cached) this.cache.clear();
    this.cache.set(key, { value, until: this.now() + POLICY_LIMITS.cacheMs, revision: this.store.revision });
    return value;
  }

  // model-visibility.js's question: which models, default first; null when
  // nothing restricts them.
  async visible(who) {
    const policy = await this.effective(who);
    if (policy.models.allowed) return [...policy.models.allowed];
    return policy.sources.defaultModel ? [policy.models.default, ...this.models.filter((model) => model !== policy.models.default)] : null;
  }
  async allows(who, model) { const visible = await this.visible(who); return visible === null || visible.includes(model); }
  async permits(who, feature) {
    if (!FEATURE_KEYS.includes(feature)) throw new Error(`没有「${feature}」这个功能开关`);
    return (await this.effective(who)).features[feature] === true;
  }
  async quota(who) { return (await this.effective(who)).quota; }
}

// Tokens a person has used today, counted where the model is served: what the
// usage ledger said when this replica last asked (every ten minutes at most),
// plus what this replica has added since. A quota check then costs nothing on
// the way. Adding before the ledger was first read is not needed -- the read
// includes everything recorded until then (the SQLite ledger writes at once;
// the PostgreSQL one writes what it holds before it reads).
export class QuotaMeter {
  constructor({ ledger, now = Date.now, refreshMs = 10 * 60_000, held = 200_000 } = {}) {
    Object.assign(this, { ledger, now, refreshMs, limit: held });
    this.counts = new Map();
  }
  #day() { return new Date(this.now()).toISOString().slice(0, 10); }
  async used(who) {
    const key = `${who.tenantId}\n${who.userId}`, day = this.#day();
    const held = this.counts.get(key);
    if (held && held.day === day && this.now() - held.readAt < this.refreshMs) return held.base + held.added;
    let base = 0;
    try { base = Number((await this.ledger.today(who, { at: this.now() }))?.tokens ?? 0); } catch { base = held && held.day === day ? held.base + held.added : 0; }
    if (this.counts.size >= this.limit) this.counts.clear();
    this.counts.set(key, { day, base, added: 0, readAt: this.now() });
    return base;
  }
  add(who, tokens) {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const held = this.counts.get(`${who.tenantId}\n${who.userId}`);
    if (held && held.day === this.#day()) held.added += tokens;
  }
}

// What a person may use, for their own desktop to show (POST /v1/policy):
// which switches are off -- so it does not offer what the server will refuse --
// and today's quota as it stands. Their own session only; nobody else's.
export class PolicyService {
  constructor({ sessions, engine, meter = null, allowDevelopment = false }) {
    Object.assign(this, { sessions, engine, meter, allowDevelopment });
  }
  async handle(req, res) {
    if (req.url !== "/v1/policy") return false;
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.origin) { req.resume(); send(403, { error: "browser_origin_not_allowed" }); return true; }
      if (req.method !== "POST") { req.resume(); send(405, { error: "method_not_allowed" }); return true; }
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      const who = this.sessions.verify(token);
      req.resume();
      if (!who || who.audience !== "codex-model-gateway" || (who.authProvider !== "feishu" && !this.allowDevelopment)) { send(401, { error: "session_expired_or_invalid" }); return true; }
      const policy = await this.engine.effective(who);
      const used = policy.quota.dailyTokens && this.meter ? await this.meter.used(who) : null;
      send(200, { features: policy.features, clientEnforced: [...CLIENT_ENFORCED], models: policy.models,
        quota: { ...policy.quota, usedToday: used, exhausted: used !== null && used >= policy.quota.dailyTokens } });
    } catch { send(500, { error: "policy_unavailable" }); }
    return true;
  }
}
