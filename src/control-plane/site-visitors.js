// Who opened a site, for the person who published it (docs/sites-phase1.md
// §1.5): how many people and how many times, day by day; which departments
// they came from; whether they opened it in Feishu, from a QR code or
// directly. Not who: a visitor is kept as a digest keyed by the server -- the
// same person counts once a day, and nobody can read back who that was. A
// department with fewer than SMALLEST visitors in the period is shown with the
// others, so a team of one is not a name. Anonymous visitors of a public site
// are only counted.
//
// Counted in memory and written every half minute, like the console's
// counts (site-safety.js): a page opened a thousand times a minute is a
// thousand additions, not a thousand writes.
import { createHmac } from "node:crypto";

export const VISITOR_LIMITS = Object.freeze({ flushMs: 30_000, keepDays: 90, periodDays: 30, smallest: 3, pendingRows: 50_000 });
export const VISIT_SOURCES = Object.freeze(["feishu", "qr", "direct"]);
const ANONYMOUS = "-";

export class SiteVisitors {
  // `key`: a secret of the server's, for the visitor digests. `departmentOf(who)`:
  // the id of the visitor's own department (the deepest they are in), or null.
  // `named(tenantId, ids)`: department names, for the period's report.
  static async open({ db, key, departmentOf = null, named = null, now = Date.now }) {
    if (!db?.dialect) throw new Error("访问统计需要管理库");
    if (!key || key.length < 16) throw new Error("访问统计需要一把服务端密钥");
    await db.schema("site-visitors", `
      CREATE TABLE IF NOT EXISTS idou_site_visitors (
        tenant text NOT NULL, site_id text NOT NULL, day text NOT NULL, visitor text NOT NULL,
        department text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'direct', views bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant, site_id, day, visitor));
      CREATE INDEX IF NOT EXISTS idou_site_visitors_day ON idou_site_visitors (day);`);
    const visitors = new SiteVisitors({ db, key, departmentOf, named, now });
    visitors.timer = setInterval(() => { void visitors.flush().catch(() => {}); }, VISITOR_LIMITS.flushMs);
    visitors.timer.unref?.();
    return visitors;
  }

  constructor({ db, key, departmentOf, named, now }) {
    this.db = db; this.key = key; this.departmentOf = departmentOf; this.named = named; this.now = now;
    this.pending = new Map();   // "tenant\nsite\nday\nvisitor" -> { department, source, views }
    this.prunedOn = "";
  }

  #day() { return new Date(this.now()).toISOString().slice(0, 10); }
  #digest(tenantId, userId) { return createHmac("sha256", this.key).update(`site-visitor\n${tenantId}\n${userId}`).digest("base64url").slice(0, 22); }

  // One page opened. `visitor`: { tenantId, userId }, or null for somebody
  // not signed in (a public site).
  async view({ tenantId, siteId, visitor = null, source = "direct" }) {
    if (!tenantId || !siteId) return;
    if (this.pending.size >= VISITOR_LIMITS.pendingRows) await this.flush();
    const who = visitor?.userId ? this.#digest(visitor.tenantId ?? tenantId, visitor.userId) : ANONYMOUS;
    const slot = `${tenantId}\n${siteId}\n${this.#day()}\n${who}`;
    const held = this.pending.get(slot);
    if (held) { held.views += 1; return; }
    // The department is asked once a visitor a day, from the directory this
    // server keeps -- never from Feishu.
    let department = "";
    if (visitor?.userId && this.departmentOf) department = String(await this.departmentOf({ tenantId: visitor.tenantId ?? tenantId, userId: visitor.userId }).catch(() => null) ?? "");
    const again = this.pending.get(slot);
    if (again) { again.views += 1; return; }
    this.pending.set(slot, { department, source: VISIT_SOURCES.includes(source) ? source : "direct", views: 1 });
  }

  async flush() {
    const rows = [...this.pending]; this.pending.clear();
    for (const [slot, held] of rows) {
      const [tenantId, siteId, day, visitor] = slot.split("\n");
      await this.db.run(`INSERT INTO idou_site_visitors (tenant, site_id, day, visitor, department, source, views) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant, site_id, day, visitor) DO UPDATE SET views = idou_site_visitors.views + excluded.views`,
      [tenantId, siteId, day, visitor, held.department, held.source, held.views]);
    }
    // What is older than kept goes, once a day.
    const today = this.#day();
    if (this.prunedOn !== today) {
      this.prunedOn = today;
      const oldest = new Date(this.now() - VISITOR_LIMITS.keepDays * 86_400_000).toISOString().slice(0, 10);
      await this.db.run("DELETE FROM idou_site_visitors WHERE day < ?", [oldest]);
    }
  }

  // The last `days` days of one site: each day's views and people, the
  // departments people came from, and where they opened it.
  async stats(tenantId, siteId, days = VISITOR_LIMITS.periodDays) {
    await this.flush().catch(() => {});
    const since = new Date(this.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db.all("SELECT day, visitor, department, source, views FROM idou_site_visitors WHERE tenant = ? AND site_id = ? AND day >= ?", [tenantId, siteId, since]);
    const byDay = new Map(), people = new Set(), departments = new Map(), sources = Object.fromEntries(VISIT_SOURCES.map((source) => [source, 0]));
    let views = 0, anonymous = 0;
    for (const row of rows) {
      const count = Number(row.views) || 0;
      const day = byDay.get(row.day) ?? { day: row.day, views: 0, people: 0 };
      day.views += count; views += count;
      if (row.visitor === ANONYMOUS) anonymous += count;
      else {
        day.people += 1; people.add(row.visitor);
        if (row.department) departments.set(row.department, (departments.get(row.department) ?? new Set()).add(row.visitor));
      }
      sources[VISIT_SOURCES.includes(row.source) ? row.source : "direct"] += count;
      byDay.set(row.day, day);
    }
    // Every day of the period, the quiet ones too, oldest first.
    const series = [];
    for (let at = days - 1; at >= 0; at -= 1) {
      const day = new Date(this.now() - at * 86_400_000).toISOString().slice(0, 10);
      series.push(byDay.get(day) ?? { day, views: 0, people: 0 });
    }
    const counted = [...departments].map(([id, seen]) => ({ id, people: seen.size }));
    const shown = counted.filter((row) => row.people >= VISITOR_LIMITS.smallest).sort((a, b) => b.people - a.people).slice(0, 10);
    const names = this.named && shown.length ? new Map((await this.named(tenantId, shown.map((row) => row.id)).catch(() => [])).map((row) => [row.id, row.name])) : new Map();
    const others = counted.reduce((sum, row) => sum + row.people, 0) - shown.reduce((sum, row) => sum + row.people, 0);
    return {
      days: series, views, people: people.size, anonymous, sources,
      departments: [...shown.map((row) => ({ name: names.get(row.id) ?? "（已不在通讯录里的部门）", people: row.people })), ...(others ? [{ name: "其他部门", people: others, others: true }] : [])],
      smallest: VISITOR_LIMITS.smallest,
    };
  }

  close() { clearInterval(this.timer); }
}

// Where a visit came from: a QR code says so in its link (?from=qr); Feishu's
// own browser says so in its name.
export function visitSource({ userAgent = "", from = "" } = {}) {
  if (from === "qr") return "qr";
  if (/\b(?:Lark|Feishu)\b/i.test(String(userAgent))) return "feishu";
  return "direct";
}
