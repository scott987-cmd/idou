// Who administers this deployment, and how much each of them may do
// (docs/admin-console.md §3).
//
//   超级管理员  owner    everything, including granting and taking back roles.
//                        IDOU_ADMIN_USERS are owners, always -- the way back in
//                        when everything else is broken, changed only by
//                        editing the deployment file and restarting.
//   管理员      admin    people, policies, content. The members of
//                        IDOU_ADMIN_CHAT are administrators, as before.
//   审计员      auditor  reads everything, exports the audit trail and usage,
//                        changes nothing.
//
// A role granted in the console may be limited to some departments (and those
// under them): a 部门管理员 manages only the people there, and a scoped
// auditor reads only about them. An owner always has the whole tenant, and so
// do the configured owners and the administrator group's members.
//
// A role granted in the console is stored per tenant in the administration
// database and held in memory in every process; the group's members come from
// AdminDirectory (admin-directory.js), read through the shared cache. Asked on
// every console request: taking somebody out of the group or taking a role
// back takes effect within a minute, without waiting for a cookie to expire.
import { EventEmitter } from "node:events";

export const ROLES = Object.freeze(["owner", "admin", "auditor"]);
export const ROLE_NAMES = Object.freeze({ owner: "超级管理员", admin: "管理员", auditor: "审计员" });
const RANK = Object.freeze({ auditor: 1, admin: 2, owner: 3 });

// What each role may do. Every console route names the one it needs.
export const PERMISSIONS = Object.freeze({
  owner: Object.freeze(["view", "people.manage", "offboard", "roles.manage", "policy.manage", "content.manage", "audit.export"]),
  admin: Object.freeze(["view", "people.manage", "offboard", "policy.manage", "content.manage", "audit.export"]),
  auditor: Object.freeze(["view", "audit.export"]),
});
export const can = (role, permission) => Boolean(role && PERMISSIONS[role]?.includes(permission));
export const ROLE_LIMITS = Object.freeze({ scopeDepartments: 20 });

const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
const TENANT = /^[A-Za-z0-9_-]{1,128}$/;
const DEPARTMENT = /^[A-Za-z0-9_-]{1,128}$/;
const scopeOf = (text) => { try { const ids = JSON.parse(text); return Array.isArray(ids) && ids.length ? ids.filter((id) => DEPARTMENT.test(String(id))) : null; } catch { return null; } };

export class AdminRoles extends EventEmitter {
  // `directory`: an AdminDirectory (IDOU_ADMIN_USERS and IDOU_ADMIN_CHAT), or
  // null when neither is set. `access`: the access list, so a disabled person
  // is nobody's administrator.
  static async open({ db, directory = null, access = null, now = Date.now, log = () => {} }) {
    if (!db?.dialect) throw new Error("管理员角色需要管理库");
    await db.schema("admin-roles", `
      CREATE TABLE IF NOT EXISTS idou_admin_roles (
        tenant text NOT NULL,
        user_id text NOT NULL,
        role text NOT NULL,
        granted_by text NOT NULL DEFAULT '',
        granted_by_name text NOT NULL DEFAULT '',
        granted_at bigint NOT NULL,
        note text NOT NULL DEFAULT '',
        scope text NOT NULL DEFAULT '[]',
        PRIMARY KEY (tenant, user_id)
      );`);
    const roles = new AdminRoles({ db, directory, access, now, log });
    await roles.reload();
    roles.onChange = ({ topic }) => { if (topic === "roles" || topic === "reset") void roles.reload().catch(() => {}); };
    db.on("change", roles.onChange);
    roles.timer = setInterval(() => { void roles.reload().catch(() => {}); }, 5 * 60_000);
    roles.timer.unref?.();
    return roles;
  }

  constructor({ db, directory, access, now, log }) {
    super();
    this.db = db; this.directory = directory; this.access = access; this.now = now; this.log = log;
    this.granted = new Map();
  }

  get configured() { return [...(this.directory?.users ?? [])]; }
  get chatId() { return this.directory?.chatId ?? null; }

  // Is this person an administrator, which kind, how do we know, and over
  // whom: `scope` is the departments they are limited to, or null for the
  // whole tenant.
  async decide(visitor) {
    const userId = String(visitor?.userId ?? ""), tenantId = String(visitor?.tenantId ?? "");
    if (!OPEN_ID.test(userId) || !TENANT.test(tenantId)) return { role: null, reason: "no-identity" };
    // The way back in: never refused here, not even by the access list.
    if (this.directory?.users?.has(userId)) return { role: "owner", source: "configured", scope: null };
    if (this.access?.isDisabled(tenantId, userId)) return { role: null, reason: "disabled" };
    const entry = this.granted.get(`${tenantId}\n${userId}`) ?? null, stored = entry?.role ?? null;
    let fromChat = null, unreadable = null;
    if (this.directory?.chatId && typeof this.directory.readChatMembers === "function") {
      const verdict = await this.directory.decide({ userId });
      if (verdict.admin) fromChat = "admin";
      else if (verdict.reason === "directory-unreadable") unreadable = verdict.why ?? "unreadable";
    }
    // The group's administrators have the whole tenant: as wide as a granted
    // role limited to some departments, and wider.
    if (fromChat && (!stored || stored === "auditor" || (stored === "admin" && entry.scope))) return { role: "admin", source: "chat", scope: null };
    if (stored) return { role: stored, source: "granted", scope: entry.scope };
    if (unreadable) return { role: null, reason: "directory-unreadable", why: unreadable };
    return { role: null, reason: this.directory?.chatId ? "not-in-chat" : this.configured.length || this.granted.size ? "not-listed" : "no-administrators" };
  }

  list(tenantId) {
    return [...this.granted.values()].filter((entry) => entry.tenantId === tenantId)
      .sort((a, b) => RANK[b.role] - RANK[a.role] || b.grantedAt - a.grantedAt);
  }

  // Given in the console by an owner. Recorded with who gave it; the caller
  // writes the audit line. `scope`: department ids the role is limited to,
  // none for the whole tenant; an owner's never is.
  async grant({ tenantId, userId, role, by, note = "", scope = [] }) {
    if (!TENANT.test(String(tenantId)) || !OPEN_ID.test(String(userId))) throw new Error("人员标识无效");
    if (!ROLES.includes(role)) throw new Error("没有这个角色");
    if (this.directory?.users?.has(userId)) throw new Error("这位是配置文件里的超级管理员，在后台里改不了");
    const departments = [...new Set(Array.isArray(scope) ? scope.map(String) : [])];
    if (departments.some((id) => !DEPARTMENT.test(id))) throw new Error("部门无效");
    if (departments.length > ROLE_LIMITS.scopeDepartments) throw new Error(`管理范围最多 ${ROLE_LIMITS.scopeDepartments} 个部门`);
    if (role === "owner" && departments.length) throw new Error("超级管理员管理整个组织，不能限定部门");
    const before = this.granted.get(`${tenantId}\n${userId}`) ?? null;
    await this.db.run(`INSERT INTO idou_admin_roles (tenant, user_id, role, granted_by, granted_by_name, granted_at, note, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant, user_id) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, granted_by_name = excluded.granted_by_name,
        granted_at = excluded.granted_at, note = excluded.note, scope = excluded.scope`,
    [tenantId, userId, role, String(by?.userId ?? "").slice(0, 128), String(by?.name ?? "").slice(0, 64), this.now(), String(note ?? "").slice(0, 200), JSON.stringify(departments)]);
    await this.reload();
    await this.db.announce("roles", null);
    return { before: before?.role ?? null, after: role, beforeScope: before?.scope ?? null, afterScope: departments.length ? departments : null };
  }

  async revoke({ tenantId, userId }) {
    const before = this.granted.get(`${tenantId}\n${userId}`) ?? null;
    if (!before) return { before: null, after: null };
    await this.db.run("DELETE FROM idou_admin_roles WHERE tenant = ? AND user_id = ?", [tenantId, userId]);
    await this.reload();
    await this.db.announce("roles", null);
    return { before: before.role, after: null };
  }

  async reload() {
    const rows = await this.db.all("SELECT tenant, user_id, role, granted_by, granted_by_name, granted_at, note, scope FROM idou_admin_roles ORDER BY tenant, user_id LIMIT 10000");
    const next = new Map();
    for (const row of rows) {
      if (!ROLES.includes(row.role)) continue;
      next.set(`${row.tenant}\n${row.user_id}`, Object.freeze({ tenantId: row.tenant, userId: row.user_id, role: row.role,
        grantedBy: { userId: row.granted_by, name: row.granted_by_name }, grantedAt: Number(row.granted_at), note: row.note,
        scope: row.role === "owner" ? null : scopeOf(row.scope) }));
    }
    this.granted = next;
    this.emit("changed");
  }

  close() {
    clearInterval(this.timer);
    if (this.onChange) this.db.off("change", this.onChange);
  }
}

export const ROLE_REFUSALS = Object.freeze({
  "no-identity": "请先登录。",
  "no-administrators": "这个部署还没有设置管理员：在部署配置里写 IDOU_ADMIN_USERS 或 IDOU_ADMIN_CHAT。",
  "not-listed": "你不是这个部署的管理员。",
  "not-in-chat": "你不是这个部署的管理员。管理员群里的人和被授予角色的人才能打开管理后台。",
  "directory-unreadable": "读不到管理员群，暂时无法确认你的身份。请检查应用机器人是否还在那个群里。",
  disabled: "你的账号已被停用。",
});
export const roleRefusal = (reason) => ROLE_REFUSALS[reason] ?? ROLE_REFUSALS["not-listed"];
