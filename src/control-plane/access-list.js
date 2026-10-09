// Who may not use this deployment right now: people an administrator has
// disabled, and people signed out of every device at a given moment
// (docs/admin-console.md §5).
//
// Asked on every request -- SessionRegistry.verify calls `refusal` before it
// accepts a session, and every mint asks before it issues one -- so the answer
// is held in memory in every process and never read from the database on the
// way. A change is written to the administration database and announced; each
// process reads the rows it was told about, and everything once in a while
// regardless, in case an announcement was missed.
//
// Two facts per person, kept apart because they mean different things:
//   disabled       no session, no sign-in, no resume, no unattended run, until
//                  an administrator enables them again;
//   signed out at  every session and every stored sign-in credential issued
//                  before this moment is refused. A new sign-in after it works.
//                  This is what makes "sign out of every device" hold against
//                  a desktop that would otherwise sign itself back in with the
//                  credential it keeps (feishu-login.js resume).
//
// The table only ever holds people somebody did something to; everybody else
// is simply absent, which means allowed.
import { EventEmitter } from "node:events";

export const ACCESS_REFUSALS = Object.freeze({
  account_disabled: "你的 i豆 账号已被管理员停用。需要恢复请联系管理员。",
  signed_out: "管理员已让你的账号在所有设备上退出，请重新登录。",
});

export const ACCESS_LIMITS = Object.freeze({
  // Everything is read again this often, whatever was announced.
  refreshMs: 5 * 60_000,
  // Announced by name up to this many people; past it, "read everything".
  namedPerNotice: 40,
  reasonChars: 200,
  // One bulk action at most.
  bulk: 1000,
});

const PERSON = /^[A-Za-z0-9_-]{1,128}$/;
const keyOf = (tenantId, userId) => `${tenantId}\n${userId}`;
const valid = (tenantId, userId) => typeof tenantId === "string" && PERSON.test(tenantId) && typeof userId === "string" && PERSON.test(userId);

export class AccessRefused extends Error {
  constructor(code) { super(ACCESS_REFUSALS[code] ?? code); this.code = code; }
}

export class AccessList extends EventEmitter {
  static async open({ db, now = Date.now, log = () => {} }) {
    if (!db?.dialect) throw new Error("访问名单需要管理库");
    const list = new AccessList({ db, now, log });
    await db.schema("admin-access", `
      CREATE TABLE IF NOT EXISTS idou_admin_access (
        tenant text NOT NULL,
        user_id text NOT NULL,
        disabled integer NOT NULL DEFAULT 0,
        signed_out_at bigint NOT NULL DEFAULT 0,
        reason text NOT NULL DEFAULT '',
        changed_by text NOT NULL DEFAULT '',
        changed_by_name text NOT NULL DEFAULT '',
        changed_at bigint NOT NULL,
        PRIMARY KEY (tenant, user_id)
      );
      CREATE INDEX IF NOT EXISTS idou_admin_access_disabled ON idou_admin_access (tenant, disabled, changed_at);`);
    await list.reload();
    list.onChange = (change) => list.#heard(change);
    db.on("change", list.onChange);
    list.timer = setInterval(() => { void list.reload().catch((error) => log({ component: "access", event: "access-reload-failed", message: String(error?.message ?? error).slice(0, 200) })); }, ACCESS_LIMITS.refreshMs);
    list.timer.unref?.();
    return list;
  }

  constructor({ db, now, log }) {
    super();
    this.db = db; this.now = now; this.log = log;
    this.entries = new Map();
    this.closed = false;
  }

  // The answer every request waits on. `issuedAt` is when the session's login
  // began (sessions.js) or when a stored credential was sealed; one with no
  // such time is as old as can be.
  refusal(tenantId, userId, issuedAt = 0) {
    const entry = this.entries.get(keyOf(tenantId, userId));
    if (!entry) return null;
    if (entry.disabled) return "account_disabled";
    if (entry.signedOutAt && !(Number(issuedAt) > entry.signedOutAt)) return "signed_out";
    return null;
  }

  isDisabled(tenantId, userId) { return this.entries.get(keyOf(tenantId, userId))?.disabled === true; }
  get(tenantId, userId) { return this.entries.get(keyOf(tenantId, userId)) ?? null; }

  // Disabling signs out too -- once, when it happens: disabling somebody
  // already disabled changes nothing. Signing out always moves the moment.
  async disable(people, { reason = "", by }) { return this.#change(people, by, { disabled: 1, signOut: "on-disable", reason }); }
  async enable(people, { by }) { return this.#change(people, by, { disabled: 0, signOut: "never", reason: "" }); }
  async signOut(people, { by }) { return this.#change(people, by, { disabled: null, signOut: "always", reason: null }); }

  // One statement per person, in one transaction, announced once. `people` is
  // [{ tenantId, userId }]; `by` the administrator { userId, name }. Returns
  // the people whose state actually changed.
  async #change(people, by, { disabled, signOut, reason }) {
    const list = Array.isArray(people) ? people : [people];
    if (!list.length || list.length > ACCESS_LIMITS.bulk) throw new Error(`一次最多处理 ${ACCESS_LIMITS.bulk} 人`);
    for (const who of list) if (!valid(who?.tenantId, who?.userId)) throw new Error("人员标识无效");
    const at = this.now(), byId = String(by?.userId ?? "").slice(0, 128), byName = String(by?.name ?? "").slice(0, 64);
    const why = reason === null ? null : String(reason ?? "").slice(0, ACCESS_LIMITS.reasonChars);
    const changed = [];
    await this.db.transaction(async (tx) => {
      for (const { tenantId, userId } of list) {
        const before = await tx.get("SELECT disabled, signed_out_at, reason FROM idou_admin_access WHERE tenant = ? AND user_id = ?", [tenantId, userId]);
        const wasDisabled = Number(before?.disabled ?? 0) === 1;
        const restamp = signOut === "always" || (signOut === "on-disable" && !wasDisabled);
        const next = {
          disabled: disabled === null ? Number(before?.disabled ?? 0) : disabled,
          signedOutAt: restamp ? at : Number(before?.signed_out_at ?? 0),
          reason: why === null ? String(before?.reason ?? "") : why,
        };
        if (before && Number(before.disabled) === next.disabled && !restamp && String(before.reason) === next.reason) continue;
        if (!before && !next.disabled && !restamp) continue;
        await tx.run(`INSERT INTO idou_admin_access (tenant, user_id, disabled, signed_out_at, reason, changed_by, changed_by_name, changed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant, user_id) DO UPDATE SET disabled = excluded.disabled, signed_out_at = excluded.signed_out_at,
            reason = excluded.reason, changed_by = excluded.changed_by, changed_by_name = excluded.changed_by_name, changed_at = excluded.changed_at`,
        [tenantId, userId, next.disabled, next.signedOutAt, next.reason, byId, byName, at]);
        changed.push({ tenantId, userId, before: before ? { disabled: Number(before.disabled) === 1, signedOutAt: Number(before.signed_out_at) } : null,
          after: { disabled: next.disabled === 1, signedOutAt: next.signedOutAt } });
      }
    });
    // Here first, so the request that made the change sees it at once.
    await this.#read(changed.map(({ tenantId, userId }) => ({ tenantId, userId })));
    if (changed.length) await this.db.announce("access", changed.length <= ACCESS_LIMITS.namedPerNotice
      ? { people: changed.map(({ tenantId, userId }) => [tenantId, userId]) } : { all: true });
    return changed;
  }

  // How many are disabled in a tenant, from the index.
  async disabledCount(tenantId) {
    return Number((await this.db.get("SELECT count(*) AS n FROM idou_admin_access WHERE tenant = ? AND disabled = 1", [tenantId])).n);
  }

  // The disabled, newest first, for the console: a page at a time.
  async disabled({ tenantId, limit = 50, before = null } = {}) {
    const size = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = await this.db.all(`SELECT tenant, user_id, reason, changed_by, changed_by_name, changed_at FROM idou_admin_access
      WHERE tenant = ? AND disabled = 1 ${before ? "AND changed_at < ?" : ""} ORDER BY changed_at DESC LIMIT ?`,
    before ? [tenantId, before, size] : [tenantId, size]);
    return rows.map((row) => ({ tenantId: row.tenant, userId: row.user_id, reason: row.reason, by: { userId: row.changed_by, name: row.changed_by_name }, at: row.changed_at }));
  }

  #heard({ topic, detail }) {
    if (this.closed) return;
    if (topic === "reset" || (topic === "access" && (detail?.all || !Array.isArray(detail?.people)))) { void this.reload().catch(() => {}); return; }
    if (topic !== "access") return;
    const people = detail.people.filter((pair) => Array.isArray(pair) && valid(pair[0], pair[1])).map(([tenantId, userId]) => ({ tenantId, userId }));
    void this.#read(people).catch(() => { void this.reload().catch(() => {}); });
  }

  async #read(people) {
    if (!people.length) return;
    for (let at = 0; at < people.length; at += 200) {
      const slice = people.slice(at, at + 200);
      const rows = await this.db.all(`SELECT tenant, user_id, disabled, signed_out_at, reason, changed_by, changed_by_name, changed_at FROM idou_admin_access
        WHERE ${slice.map(() => "(tenant = ? AND user_id = ?)").join(" OR ")}`, slice.flatMap(({ tenantId, userId }) => [tenantId, userId]));
      const found = new Map(rows.map((row) => [keyOf(row.tenant, row.user_id), row]));
      for (const { tenantId, userId } of slice) this.#hold(keyOf(tenantId, userId), found.get(keyOf(tenantId, userId)) ?? null);
    }
    this.emit("changed", people);
  }

  // Everything again: at start, after a missed announcement, and on a timer.
  async reload() {
    const seen = new Set();
    let after = ["", ""];
    for (;;) {
      const rows = await this.db.all(`SELECT tenant, user_id, disabled, signed_out_at, reason, changed_by, changed_by_name, changed_at FROM idou_admin_access
        WHERE (tenant > ? OR (tenant = ? AND user_id > ?)) ORDER BY tenant, user_id LIMIT 5000`, [after[0], after[0], after[1]]);
      for (const row of rows) { const key = keyOf(row.tenant, row.user_id); seen.add(key); this.#hold(key, row); }
      if (rows.length < 5000) break;
      after = [rows.at(-1).tenant, rows.at(-1).user_id];
    }
    for (const key of [...this.entries.keys()]) if (!seen.has(key)) this.entries.delete(key);
    this.emit("changed", null);
  }

  #hold(key, row) {
    if (!row || (!Number(row.disabled) && !Number(row.signed_out_at))) { this.entries.delete(key); return; }
    this.entries.set(key, Object.freeze({ disabled: Number(row.disabled) === 1, signedOutAt: Number(row.signed_out_at) || 0,
      reason: row.reason ?? "", by: { userId: row.changed_by ?? "", name: row.changed_by_name ?? "" }, at: Number(row.changed_at) }));
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.onChange) this.db.off("change", this.onChange);
  }
}
