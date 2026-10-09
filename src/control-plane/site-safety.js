// Content safety for published sites (docs/site-content-safety.md): what an
// organisation's rules say to do with what content-scan.js finds and what the
// model says of a public site's words (site-moderation.js); a record of every
// check; and how often each site is opened, by day.
//
// Kept in the administration database, beside the rest of the console's
// (admin-db.js). A check record holds where things were found, masked
// samples, keyed fingerprints and a masked excerpt -- never a value, never a
// whole page. The site's own state -- waiting for an administrator, turned
// down, approved -- lives on the site record (site-registry.js), because that
// is what decides whether the site is served.
import { createHmac, randomUUID } from "node:crypto";
import { scanSiteInTurns, cleanKeywords, countsText, maskedText, SCAN_CATEGORIES } from "./content-scan.js";
import { moderationText } from "./site-moderation.js";

export const SAFETY_ACTIONS = Object.freeze(["block", "review", "record"]);
export const ACTION_NAMES = Object.freeze({ block: "拦截", review: "送管理员审核", record: "只记录" });
export const OUTCOMES = Object.freeze(["pass", "record", "review", "block"]);
export const TRIGGERS = Object.freeze({ publish: "发布", update: "更新版本", share: "改分享范围", republish: "重新发布", data: "数据刷新", rescan: "补查", rollback: "回到旧版本" });
// Who will be able to read it: anybody on the internet, or people of the organisation.
export const audienceOf = (share) => (share?.scope === "anyone" ? "public" : "internal");
export const DEFAULT_RULES = Object.freeze({
  actions: Object.freeze({
    secret: Object.freeze({ public: "block", internal: "block" }),
    idcard: Object.freeze({ public: "block", internal: "record" }),
    bankcard: Object.freeze({ public: "block", internal: "record" }),
    phone: Object.freeze({ public: "review", internal: "record" }),
    email: Object.freeze({ public: "review", internal: "record" }),
    keyword: Object.freeze({ public: "review", internal: "record" }),
  }),
  keywords: Object.freeze([]),
  ai: true,               // the model reads public sites' words
  reviewAllPublic: false, // every public site waits for an administrator, findings or not
});
export const SAFETY_LIMITS = Object.freeze({ excerptChars: 3000, aiEveryMs: 60 * 60_000, pageMax: 100, visitsFlushMs: 30_000 });

// Rules as an administrator may write them, checked; what is not said keeps
// the default.
export function checkRules(input) {
  const actions = {};
  for (const category of Object.keys(SCAN_CATEGORIES)) {
    actions[category] = {};
    for (const audience of ["public", "internal"]) {
      const value = input?.actions?.[category]?.[audience] ?? DEFAULT_RULES.actions[category][audience];
      if (!SAFETY_ACTIONS.includes(value)) throw new Error(`「${SCAN_CATEGORIES[category]}」的处理方式无效`);
      actions[category][audience] = value;
    }
  }
  if (actions.secret.public !== "block") throw new Error("公开网站里的密钥或凭据只能拦截");
  return { actions, keywords: cleanKeywords(input?.keywords ?? DEFAULT_RULES.keywords),
    ai: input?.ai === undefined ? DEFAULT_RULES.ai : input.ai === true, reviewAllPublic: input?.reviewAllPublic === true };
}

export class SiteSafety {
  // `key`: a secret of the server's, for fingerprints. `moderate(text)`: the
  // model's reading (site-moderation.js), or null when the deployment has none.
  static async open({ db, key, moderate = null, now = Date.now, log = () => {} }) {
    if (!db?.dialect) throw new Error("内容安全需要管理库");
    if (!key || key.length < 16) throw new Error("内容安全需要一把服务端密钥");
    await db.schema("admin-site-safety", `
      CREATE TABLE IF NOT EXISTS idou_admin_site_rules (
        tenant text NOT NULL PRIMARY KEY, rules text NOT NULL, updated_by text NOT NULL DEFAULT '', updated_by_name text NOT NULL DEFAULT '', updated_at bigint NOT NULL);
      CREATE TABLE IF NOT EXISTS idou_admin_site_checks (
        id text NOT NULL PRIMARY KEY, tenant text NOT NULL, at bigint NOT NULL,
        site_id text NOT NULL, site_name text NOT NULL DEFAULT '', owner_id text NOT NULL DEFAULT '', version text NOT NULL DEFAULT '', data_digest text NOT NULL DEFAULT '',
        audience text NOT NULL, trigger text NOT NULL, outcome text NOT NULL, counts text NOT NULL DEFAULT '{}', findings text NOT NULL DEFAULT '[]',
        ai text NOT NULL DEFAULT '', text_digest text NOT NULL DEFAULT '', excerpt text NOT NULL DEFAULT '', reason text NOT NULL DEFAULT '',
        decision text NOT NULL DEFAULT '', decided_by text NOT NULL DEFAULT '', decided_by_name text NOT NULL DEFAULT '', decided_at bigint NOT NULL DEFAULT 0, decision_reason text NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS idou_admin_site_checks_time ON idou_admin_site_checks (tenant, at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idou_admin_site_checks_site ON idou_admin_site_checks (tenant, site_id, at DESC);
      CREATE INDEX IF NOT EXISTS idou_admin_site_checks_outcome ON idou_admin_site_checks (tenant, outcome, at DESC);
      CREATE TABLE IF NOT EXISTS idou_admin_site_visits (
        tenant text NOT NULL, site_id text NOT NULL, day text NOT NULL, visits bigint NOT NULL DEFAULT 0, anonymous bigint NOT NULL DEFAULT 0, refused bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, site_id, day));`);
    const safety = new SiteSafety({ db, key, moderate, now, log });
    await safety.reload();
    safety.onChange = ({ topic }) => { if (topic === "site-rules" || topic === "reset") void safety.reload().catch(() => {}); };
    db.on("change", safety.onChange);
    safety.timer = setInterval(() => { void safety.flushVisits().catch(() => {}); }, SAFETY_LIMITS.visitsFlushMs);
    safety.timer.unref?.();
    return safety;
  }

  constructor({ db, key, moderate, now, log }) {
    Object.assign(this, { db, key, moderate, now, log });
    this.held = new Map();      // tenant → rules
    this.read = new Map();      // site → { digest, at, result }: the model's last reading of it
    this.counted = new Map();   // "tenant\nsite\nday" → { visits, anonymous, refused }: not yet written
    this.lastData = new Map();  // site → what its last recorded data check found
    this.owedData = new Set();  // sites whose data was held back because the model did not read it
    this.lastAt = 0;            // checks are stamped in the order they are made, never two alike
  }

  async reload() {
    const rows = await this.db.all("SELECT tenant, rules, updated_by, updated_by_name, updated_at FROM idou_admin_site_rules");
    const next = new Map();
    for (const row of rows) {
      try { next.set(row.tenant, { ...checkRules(JSON.parse(row.rules)), updated: { by: { userId: row.updated_by, name: row.updated_by_name }, at: Number(row.updated_at) } }); }
      catch (error) { this.log({ component: "site-safety", event: "rules-unreadable", message: String(error?.message ?? error).slice(0, 120) }); }
    }
    this.held = next;
  }

  rules(tenantId) { return this.held.get(tenantId) ?? { ...checkRules({}), updated: null }; }

  async setRules(tenantId, input, by) {
    const checked = checkRules(input);
    const before = this.rules(tenantId);
    await this.db.run(`INSERT INTO idou_admin_site_rules (tenant, rules, updated_by, updated_by_name, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant) DO UPDATE SET rules = excluded.rules, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = excluded.updated_at`,
    [tenantId, JSON.stringify(checked), String(by?.userId ?? "").slice(0, 128), String(by?.name ?? "").slice(0, 64), this.now()]);
    await this.reload();
    await this.db.announce("site-rules", null);
    return { before, after: this.rules(tenantId) };
  }

  // A key per tenant from the server's, so fingerprints from one organisation
  // say nothing about another's.
  #key(tenantId) { return createHmac("sha256", this.key).update(`idou site-safety fingerprint\n${tenantId}`).digest(); }

  // One check. `site`: { id, name, ownerId }; `audience`: "public" or
  // "internal"; `files`/`data` what will be shown; `approved`: what an
  // administrator already let through for this site ({ fingerprints, aiDigest }).
  // Returns the outcome -- pass, record, review or block -- with what was found
  // and a sentence for the person who published it, and records it.
  async assess({ tenantId, site, audience, files = [], data = null, trigger, version = "", dataDigest = "", approved = null, ai: aiWanted = true, signal = null }) {
    if (!TRIGGERS[trigger]) throw new Error("没有这种检查");
    const rules = this.rules(tenantId);
    const scan = await scanSiteInTurns({ files, data, keywords: rules.keywords, key: this.#key(tenantId) });
    const letThrough = new Set(approved?.fingerprints ?? []);
    const findings = scan.findings.map((finding) => {
      const action = rules.actions[finding.category]?.[audience] ?? "record";
      return { ...finding, action: action === "review" && letThrough.has(finding.fingerprint) ? "approved" : action };
    });
    // A category counted beyond the findings kept still decides: what is not
    // listed is not therefore let through.
    const unlisted = (category) => (scan.counts[category] ?? 0) - findings.filter((finding) => finding.category === category).length;
    const blocked = Object.keys(scan.counts).filter((category) => rules.actions[category]?.[audience] === "block");
    const toReview = Object.keys(scan.counts).filter((category) => rules.actions[category]?.[audience] === "review"
      && (findings.some((finding) => finding.category === category && finding.action === "review") || unlisted(category) > 0));
    // The model reads what anybody on the internet would.
    let ai = null;
    if (audience === "public" && rules.ai && this.moderate && aiWanted && scan.text) ai = await this.#read(site.id, scan, trigger, signal);
    const aiApproved = Boolean(ai && approved?.aiDigest && approved.aiDigest === scan.textDigest);
    // A model that did not answer is no doubt about the words. Before they go
    // up it still stops them, for a person to look; a site already up, checked
    // again, is not taken down for it -- the rules above still decide -- and is
    // read again at the next check (rescanSites).
    const unreadWhileUp = trigger === "rescan" && Boolean(ai?.failed);
    const aiAsks = ai?.verdict === "review" && !aiApproved && !unreadWhileUp;
    // "Every public site waits": once for each version -- data read into an
    // approved version is not a new version.
    // Every version an administrator let through counts, not only the last:
    // going back to one already approved does not make it wait again.
    const waits = audience === "public" && rules.reviewAllPublic && approved?.version !== version && !(approved?.versions ?? []).includes(version);
    const outcome = blocked.length || ai?.verdict === "block" ? "block" : toReview.length || aiAsks || waits ? "review" : scan.total ? "record" : "pass";
    // What it was stopped for: found in the files, found in the data, the
    // model, every public site waiting. A check again uses it to tell whether
    // new data put up meanwhile -- checked when it was put there -- leaves
    // anything of what was found (fifth review before .270). Findings past the
    // ones kept are not placed: counted as in the files.
    const acting = findings.filter((finding) => finding.action === "review" || finding.action === "block");
    const inData = (finding) => finding.from === "data";
    const because = { files: acting.some((finding) => !inData(finding)) || [...blocked, ...toReview].some((category) => unlisted(category) > 0),
      data: acting.some(inData), model: ai?.verdict === "block" || aiAsks, everyPublic: Boolean(waits) };
    const reason = this.#reason({ outcome, audience, scan, blocked, toReview, ai, aiAsks, waits, trigger, unreadWhileUp });
    const result = { outcome, counts: scan.counts, findings, ai, reason, because, textDigest: scan.textDigest,
      fingerprints: findings.filter((finding) => finding.action === "review" || finding.action === "approved").map((finding) => finding.fingerprint) };
    // A table read on a clock: data with nothing in it is not a record, and the
    // same findings again are not a new one.
    if (trigger === "data" && (outcome === "pass" || outcome === "record")) {
      const seen = outcome === "pass" ? "" : findings.map((finding) => finding.fingerprint).sort().join(",");
      if (outcome === "pass" || this.lastData.get(site.id) === seen) return { id: null, ...result };
      this.lastData.set(site.id, seen);
    }
    const id = randomUUID();
    // Strictly later than the last: "newest first" is the order they were
    // made in, even within one millisecond.
    this.lastAt = Math.max(this.now(), this.lastAt + 1);
    await this.db.run(`INSERT INTO idou_admin_site_checks (id, tenant, at, site_id, site_name, owner_id, version, data_digest, audience, trigger, outcome, counts, findings, ai, text_digest, excerpt, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, tenantId, this.lastAt, String(site.id ?? ""), String(site.name ?? "").slice(0, 80), String(site.ownerId ?? ""), String(version ?? ""), String(dataDigest ?? ""),
      audience, trigger, outcome, JSON.stringify(scan.counts), JSON.stringify(findings), ai ? JSON.stringify(ai) : "", scan.textDigest,
      audience === "public" || outcome === "review" || outcome === "block" ? maskedText(scan.text, SAFETY_LIMITS.excerptChars) : "", reason]);
    return { id, ...result };
  }

  // The model's reading, once per text: the same words are not read twice,
  // and a site's data, which can change every few minutes, at most hourly.
  //
  // Data the model was asked about and did not answer for was held back, and is
  // owed a reading: until it gets one the hour does not apply. Otherwise any
  // other reading of the site in between -- a check again of what is up, which
  // reads the old data -- would let the held-back data through unread.
  async #read(siteId, scan, trigger, signal = null) {
    const held = siteId ? this.read.get(siteId) : null;
    if (held?.digest === scan.textDigest) return { ...held.result, reused: true };
    if (trigger === "data" && held && !this.owedData.has(siteId) && this.now() - held.at < SAFETY_LIMITS.aiEveryMs) return null;
    const result = await this.moderate(scan.truncated ? `${scan.text}\n（以下内容过长，已截断）` : scan.text, { signal });
    if (siteId && !result.failed) this.read.set(siteId, { digest: scan.textDigest, at: this.now(), result });
    if (siteId && trigger === "data") { if (result.failed) this.owedData.add(siteId); else this.owedData.delete(siteId); }
    return result;
  }

  // What the person who published it reads. The model's words are set inside
  // these sentences, so whatever it ended them with is taken off first: it
  // wrote "……建议人工复核。" and the reason read "……建议人工复核。。等管理员……".
  #reason({ outcome, audience, scan, blocked, toReview, ai, aiAsks, waits, trigger, unreadWhileUp }) {
    const where = audience === "public" ? "公开网站" : "网站";
    const said = clause(ai?.reason);
    const found = (categories) => categories.map((category) => `${scan.counts[category]} 处${SCAN_CATEGORIES[category]}`).join("、");
    const first = (categories) => scan.findings.find((finding) => categories.includes(finding.category))?.where;
    if (outcome === "block") {
      // A site already up is not refused but taken down (rescanSites).
      const after = { data: "这次的数据没有更新到线上", rescan: "网站已下线，等管理员审核" }[trigger] ?? "没有发布";
      if (blocked.length) return `${where}不允许包含${blocked.map((category) => SCAN_CATEGORIES[category]).join("、")}（发现 ${found(blocked)}${first(blocked) ? `，例如 ${first(blocked)}` : ""}），${after}。去掉这些内容后${trigger === "rescan" ? "点「更新线上」会重新检查" : "再试"}。`;
      return `AI 审核认为内容不适合公开（${moderationText(ai) || "违规内容"}${said ? `：${said}` : ""}），${after}。`;
    }
    if (outcome === "review") {
      const why = [toReview.length ? `发现 ${found(toReview)}` : "",
        aiAsks ? (ai.failed ? `AI 审核没有完成（${said}）` : `AI 审核：${said || moderationText(ai) || "需要人工判断"}`) : "",
        !toReview.length && !aiAsks && waits ? "公开网站都要管理员审核" : ""].filter(Boolean).join("；");
      // Data held back only because the model did not answer: the next refresh asks it again.
      if (trigger === "data" && ai?.failed && !toReview.length && !waits) return `${why}，这次的数据没有更新到线上，下次刷新时会再试。`;
      return trigger === "data" ? `${why}。按管理员的规则要审核后才能上线，这次的数据没有更新到线上；可以去掉这些内容，或请管理员放行。`
        : `${why}。等管理员审核通过后才会上线，在那之前链接打不开。`;
    }
    const unread = unreadWhileUp ? `补查时 AI 审核没有完成（${said}），网站照常在线，下次补查时再读。` : "";
    if (outcome === "record") return `发现 ${countsText(scan.counts)}，已记录。${unread}`;
    return unread;
  }

  // An administrator's decision on a check: approved or rejected, with who and why.
  async decide(tenantId, checkId, { decision, by, reason = "" }) {
    if (!["approved", "rejected"].includes(decision)) throw new Error("没有这种决定");
    const { changes } = await this.db.run(`UPDATE idou_admin_site_checks SET decision = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, decision_reason = ?
      WHERE tenant = ? AND id = ?`, [decision, String(by?.userId ?? ""), String(by?.name ?? "").slice(0, 64), this.now(), String(reason).slice(0, 200), tenantId, checkId]);
    return changes > 0;
  }

  async check(tenantId, checkId) {
    const row = await this.db.get("SELECT * FROM idou_admin_site_checks WHERE tenant = ? AND id = ?", [tenantId, checkId]);
    return row ? present(row) : null;
  }

  // Checks, newest first, a page at a time. `siteId`, `outcome` narrow them;
  // `siteIds` (an administrator's scope) limits them to those sites.
  async checks({ tenantId, siteId = null, outcome = null, siteIds = null, cursor = null, limit = 50 }) {
    const size = Math.max(1, Math.min(SAFETY_LIMITS.pageMax, Number(limit) || 50));
    const where = ["tenant = ?"], params = [tenantId];
    if (siteId) { where.push("site_id = ?"); params.push(siteId); }
    if (outcome) { if (!OUTCOMES.includes(outcome)) throw new Error("没有这种结果"); where.push("outcome = ?"); params.push(outcome); }
    if (siteIds) { if (!siteIds.length) return { checks: [], next: null }; where.push(`site_id IN (${siteIds.map(() => "?").join(",")})`); params.push(...siteIds); }
    if (cursor) {
      const [at, id] = String(cursor).split(".");
      if (!/^[0-9]{1,16}$/.test(at ?? "") || !/^[0-9a-f-]{36}$/.test(id ?? "")) throw new Error("翻页位置无效");
      where.push("(at < ? OR (at = ? AND id < ?))"); params.push(Number(at), Number(at), id);
    }
    const rows = await this.db.all(`SELECT * FROM idou_admin_site_checks WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`, [...params, size + 1]);
    const page = rows.slice(0, size).map(present);
    return { checks: page, next: rows.length > size ? `${page.at(-1).at}.${page.at(-1).id}` : null };
  }

  // The latest check of each of these sites.
  async latest(tenantId, siteIds) {
    const out = new Map();
    for (const siteId of [...new Set(siteIds)].slice(0, 500)) {
      const row = await this.db.get("SELECT * FROM idou_admin_site_checks WHERE tenant = ? AND site_id = ? ORDER BY at DESC, id DESC LIMIT 1", [tenantId, siteId]);
      if (row) out.set(siteId, present(row));
    }
    return out;
  }

  // ---------------------------------------------------------------- visits
  // Counted in memory and written every half minute: a public page opened a
  // thousand times a minute is a thousand additions, not a thousand writes.
  countVisit(tenantId, siteId, { anonymous = false, allowed = true } = {}) {
    if (!tenantId || !siteId) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const key = `${tenantId}\n${siteId}\n${day}`;
    const held = this.counted.get(key) ?? { visits: 0, anonymous: 0, refused: 0 };
    if (allowed) { held.visits += 1; if (anonymous) held.anonymous += 1; } else held.refused += 1;
    this.counted.set(key, held);
  }

  async flushVisits() {
    const pending = [...this.counted]; this.counted.clear();
    for (const [key, held] of pending) {
      const [tenantId, siteId, day] = key.split("\n");
      await this.db.run(`INSERT INTO idou_admin_site_visits (tenant, site_id, day, visits, anonymous, refused) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant, site_id, day) DO UPDATE SET visits = idou_admin_site_visits.visits + excluded.visits,
          anonymous = idou_admin_site_visits.anonymous + excluded.anonymous, refused = idou_admin_site_visits.refused + excluded.refused`,
      [tenantId, siteId, day, held.visits, held.anonymous, held.refused]);
    }
  }

  // The last `days` days of these sites: totals and each day.
  async visits(tenantId, siteIds, days = 7) {
    const out = new Map();
    const ids = [...new Set(siteIds)].slice(0, 500);
    if (!ids.length) return out;
    const since = new Date(this.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db.all(`SELECT site_id, day, visits, anonymous, refused FROM idou_admin_site_visits WHERE tenant = ? AND day >= ? AND site_id IN (${ids.map(() => "?").join(",")})`,
      [tenantId, since, ...ids]);
    for (const row of rows) {
      const held = out.get(row.site_id) ?? { visits: 0, anonymous: 0, refused: 0, days: [] };
      held.visits += Number(row.visits); held.anonymous += Number(row.anonymous); held.refused += Number(row.refused);
      held.days.push({ day: row.day, visits: Number(row.visits) });
      out.set(row.site_id, held);
    }
    return out;
  }

  async close() {
    clearInterval(this.timer);
    if (this.onChange) this.db.off("change", this.onChange);
    await this.flushVisits().catch(() => {});
  }
}

// Sites checked again: at start, those published before checks existed (no
// check of them yet) and those whose last check the model did not answer; or
// -- `all` -- every site of a tenant, when its rules have changed. As if
// published now: one that would have had to wait, or been refused, is taken
// down to wait for an administrator. A model that does not answer takes none
// down (assess). One at a time, so the model is asked one page after another.
export async function rescanSites({ registry, safety, tenantId = null, all = false, signal = null, log = () => {} }) {
  const sites = registry.list().filter((site) => (!tenantId || site.tenantId === tenantId) && !site.held && !site.review);
  let checked = 0, waiting = 0, unread = 0;
  for (const site of sites) {
    if (signal?.aborted) break;
    try {
      // Checked once already -- unless the model did not answer then.
      const last = all ? null : (await safety.latest(site.tenantId, [site.id])).get(site.id);
      if (last && !last.ai?.failed) continue;
      // What is checked: taken down only if that version, that audience and
      // that data are still what is there (registry.awaitReview).
      const { files, data, version } = await registry.contents(site.id);
      const audience = audienceOf(registry.get(site.id)?.share ?? site.share);
      const still = (now) => now.version === version && audienceOf(now.share) === audience;
      const check = await safety.assess({ tenantId: site.tenantId, site: { id: site.id, name: site.name, ownerId: site.ownerId }, audience,
        files, data, trigger: "rescan", version, dataDigest: data?.snapshot?.digest ?? "", approved: registry.get(site.id)?.review?.approved ?? null, signal });
      checked += 1;
      if (check.ai?.failed) unread += 1;
      if (check.outcome === "review" || check.outcome === "block") {
        // New data meanwhile makes this stale only when the data is all it was
        // stopped for; what is in the files, or the model's reading, stands.
        const dataOnly = check.because?.data && !check.because.files && !check.because.model && !check.because.everyPublic;
        const taken = await registry.awaitReview(site.id, { checkId: check.id, reason: check.outcome === "block" ? `补查发现问题：${check.reason}` : check.reason,
          still, ...(dataOnly ? { dataDigest: data?.snapshot?.digest ?? null } : {}) });
        if (!taken?.stale) waiting += 1;
      }
    } catch (error) {
      log({ component: "site-safety", event: "rescan-failed", site: site.id, message: String(error?.message ?? error).slice(0, 160) });
    }
  }
  return { checked, waiting, unread };
}

// The server's own: a few minutes after it starts, and -- while the model left
// pages unread -- again every half hour, at most six more times. On the first
// start of .269 MiniMax was busy for one page of three; without another pass
// that public site would have gone unread by the model until the next restart.
// `run()`: the console's 全部重新检查, made here so that what it leaves unread
// is read on the same clock and the server stopping stops it too. `again()`
// arriving while a pass is under way is kept until that pass ends: that pass may
// already have gone by the pages it was asked about. `stop()`, at shutdown,
// stops every pass under way, between sites and inside the model's reading.
export function scheduleRescans({ registry, safety, log = () => {}, firstAfterMs = 3 * 60_000, againAfterMs = 30 * 60_000, passes = 7, timers = { set: setTimeout, clear: clearTimeout } }) {
  const stopping = new AbortController();
  // `budget`: how many passes the armed one may still lead to -- read when it fires,
  // so that again() can raise it for a pass already armed.
  let timer = null, budget = 0, busy = false, owed = false;
  // The pass's promise is handed back -- it never rejects -- so a caller with its own timers can wait for it.
  const arm = (ms, left) => { budget = left; timer = timers.set(() => { timer = null; return pass(budget); }, ms); timer?.unref?.(); };
  const again = () => {
    if (stopping.signal.aborted) return;
    if (busy) owed = true;
    else if (timer) budget = Math.max(budget, passes - 1);
    else arm(againAfterMs, passes - 1);
  };
  const pass = async (left) => {
    busy = true;
    let done = null;
    try {
      done = await rescanSites({ registry, safety, signal: stopping.signal, log });
      if (!stopping.signal.aborted) log({ component: "site-safety", event: "rescanned", ...done });
    } catch (error) {
      if (!stopping.signal.aborted) log({ component: "site-safety", event: "rescan-failed", message: String(error?.message ?? error).slice(0, 160) });
    } finally { busy = false; }
    const asked = owed;
    owed = false;
    if (stopping.signal.aborted || timer) return;
    if (asked) arm(againAfterMs, Math.max(left - 1, passes - 1));
    else if (done?.unread && left > 1) arm(againAfterMs, left - 1);
  };
  arm(firstAfterMs, passes);
  return {
    again,
    async run({ tenantId = null, all = false } = {}) {
      const done = await rescanSites({ registry, safety, tenantId, all, signal: stopping.signal, log });
      if (done.unread) again();
      return done;
    },
    stop() { stopping.abort(); if (timer) { timers.clear(timer); timer = null; } },
  };
}

// Words to set inside a sentence of ours: one line, without the stop it ended on.
const clause = (words) => String(words ?? "").replace(/\s+/g, " ").trim().replace(/[\s。．.！!？?；;，,、：:]+$/u, "");

function present(row) {
  const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
  return { id: row.id, at: Number(row.at), siteId: row.site_id, siteName: row.site_name, ownerId: row.owner_id, version: row.version, dataDigest: row.data_digest,
    audience: row.audience, trigger: row.trigger, outcome: row.outcome, counts: parse(row.counts, {}), findings: parse(row.findings, []), ai: parse(row.ai, null),
    textDigest: row.text_digest, excerpt: row.excerpt, reason: row.reason,
    decision: row.decision ? { decision: row.decision, by: { userId: row.decided_by, name: row.decided_by_name }, at: Number(row.decided_at), reason: row.decision_reason } : null };
}
