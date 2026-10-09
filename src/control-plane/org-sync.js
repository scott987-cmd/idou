// Reading the organisation's structure from Feishu's address book, as the
// application itself (docs/admin-console.md §8): the department tree, and for
// everybody who has used i豆, which departments they are in and whether they
// still work there.
//
// Needs the application to have been given the address book: the scopes in
// CONTACT_SCOPES, and a contact range (通讯录权限范围) that covers the people.
// Without the scopes Feishu refuses (HTTP 400, 99991672) and this records that
// as it is -- the scopes to ask for -- rather than an empty organisation. The
// range is read first (/contact/v3/scopes, then the root if it does not say;
// see #range): the whole organisation is walked from the root, a range of some
// departments department by department -- the root itself answers 40004 then
// (HTTP 403, measured 2026-10-02 on a range of one person) -- and what the
// range leaves out is said, not hidden. Feishu also
// leaves out fields the application has no scope for, without an error: a
// person with no department_ids at all, when the tree is not empty, is said to
// be that, not taken for somebody in no department.
//
// Somebody Feishu says has left (status.is_resigned) is disabled here at once,
// and listed for an administrator to clean up; nothing is deleted by this. An
// administrator who enables them again after that has the last word: the
// next run leaves them as they are.
//
// Paced: one call at a time, and no more than PACE a second. A hundred
// thousand people are two thousand calls of fifty, a few minutes, once a day.
export const CONTACT_SCOPES = Object.freeze([
  ["contact:contact.base:readonly", "获取通讯录基本信息"],
  ["contact:user.base:readonly", "获取用户基本信息"],
  ["contact:user.department:readonly", "获取用户组织架构信息"],
  ["contact:department.base:readonly", "获取部门基础信息"],
]);
export const SYNC_LIMITS = Object.freeze({ pageSize: 50, batch: 50, perSecond: 10, departments: 200_000, pages: 5000 });
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
const DEPARTMENT = /^[A-Za-z0-9_-]{1,128}$/;

export class OrgSyncError extends Error {
  constructor(code, message, detail = {}) { super(message); this.code = code; this.detail = detail; }
}

export class OrgSync {
  // `bot`: the application's own token (feishu-bot.js). `feishu`: the
  // deployment's OpenAPI (provider-definition.js), never a URL written here.
  constructor({ feishu, bot, org, people, access, audit = () => {}, fetch: fetchImpl = fetch, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {} }) {
    if (!feishu?.openApi || !bot?.token || !org || !people || !access) throw new Error("组织架构同步需要飞书应用、组织目录、成员目录和访问名单");
    Object.assign(this, { feishu, bot, org, people, access, audit, fetch: fetchImpl, now, sleep, log });
    this.running = null;
    this.lastCall = 0;
  }

  // One run at a time; asking during one waits for it.
  sync(tenantId) {
    if (!this.running) this.running = this.#run(tenantId).finally(() => { this.running = null; });
    return this.running;
  }

  async #call(path) {
    const wait = this.lastCall + 1000 / SYNC_LIMITS.perSecond - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCall = this.now();
    const token = await this.bot.token();
    const response = await this.fetch(this.feishu.openApi.url(path), { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || body?.code !== 0) {
      const code = Number(body?.code ?? response.status);
      // The scopes Feishu names as missing, from its own message.
      const named = /\[([^\]]+)\]/.exec(String(body?.msg ?? ""))?.[1]?.split(",").map((scope) => scope.trim()).filter(Boolean) ?? [];
      if (code === 99991672 || code === 99991679) throw new OrgSyncError("missing_scopes", "应用还没有通讯录权限", { code, named });
      if (code === 40004) throw new OrgSyncError("missing_range", "应用的通讯录权限范围不包含要读的部门", { code });
      throw new OrgSyncError("feishu_refused", `飞书拒绝了（${code}${body?.msg ? ` ${String(body.msg).slice(0, 80)}` : ""}）`, { code });
    }
    return body.data ?? {};
  }

  // Never rejects: it runs from a timer, where a rejection nobody waits for
  // would take the whole process down.
  async #run(tenantId) {
    try {
      await this.org.recordSync(tenantId, "running", {}, { started: true });
      const range = await this.#range();
      const departments = await this.#departments(range);
      await this.org.replaceDepartments(tenantId, departments);
      const result = await this.#people(tenantId, departments.length > 0);
      const detail = { departments: departments.length, range: { all: range.all, departments: range.departments.length, users: range.users }, ...result };
      await this.org.recordSync(tenantId, "ok", detail);
      await this.org.announce();
      this.audit({ category: "system", action: "system.org-sync", outcome: "ok", tenant: tenantId, source: "org-sync", actor: { kind: "system" }, target: {}, detail });
      return { ok: true, ...detail };
    } catch (error) {
      const state = error instanceof OrgSyncError ? error.code : "failed";
      const detail = { message: String(error?.message ?? error).slice(0, 200), ...(error instanceof OrgSyncError ? error.detail : {}) };
      await this.org.recordSync(tenantId, state, detail).catch(() => {});
      this.audit({ category: "system", action: "system.org-sync", outcome: ["missing_scopes", "missing_range"].includes(state) ? "refused" : "failed", tenant: tenantId, source: "org-sync", actor: { kind: "system" }, target: {}, detail: { reason: state } });
      this.log({ component: "org-sync", event: "org-sync-failed", state, message: detail.message });
      return { ok: false, state, ...detail };
    }
  }

  // What the application may read of the address book: the whole
  // organisation ("0" among its departments), or some departments and people.
  async #range() {
    const departments = [];
    let users = 0, token = "";
    for (let page = 0; page < SYNC_LIMITS.pages; page += 1) {
      const query = new URLSearchParams({ department_id_type: "open_department_id", user_id_type: "open_id", page_size: "100", ...(token ? { page_token: token } : {}) });
      const data = await this.#call(`/open-apis/contact/v3/scopes?${query}`);
      departments.push(...(data.department_ids ?? []).map(String));
      users += (data.user_ids ?? []).length;
      if (!data.has_more || !data.page_token) break;
      token = data.page_token;
    }
    // Everybody is not said outright. For a range of 全部成员 Feishu answers
    // the root's first-level departments and the people directly under it,
    // never the root itself (its docs, contact-v3 scope/list; measured
    // 2026-10-05 on an organisation of two people and no departments: no
    // departments, two people -- read before as a range of two). The root is
    // readable only then -- a range of some departments or people is refused
    // it (40004, measured 2026-10-02) -- so it is asked. "0" is still taken
    // as everybody if Feishu ever says so.
    const all = departments.includes("0") || await this.#rootReadable();
    return { all, departments: [...new Set(departments.filter((id) => id !== "0" && DEPARTMENT.test(id)))], users };
  }

  async #rootReadable() {
    try {
      await this.#call("/open-apis/contact/v3/departments/0?department_id_type=open_department_id&user_id_type=open_id");
      return true;
    } catch (error) {
      if (error instanceof OrgSyncError && error.code === "missing_range") return false;
      throw error;
    }
  }

  // The tree within the range: from the root, every level in one paged
  // listing; or each department in the range, itself and all under it.
  async #departments(range) {
    const raw = [], seen = new Set();
    const keep = (item) => {
      const id = String(item.open_department_id ?? item.department_id ?? "");
      if (!DEPARTMENT.test(id) || item.status?.is_deleted || seen.has(id)) return;
      seen.add(id);
      raw.push({ id, parentId: String(item.parent_department_id ?? "0"), name: String(item.name ?? ""), memberCount: Number(item.member_count ?? 0), order: Number(item.order ?? 0) || 0 });
      if (raw.length > SYNC_LIMITS.departments) throw new OrgSyncError("too_large", `部门超过 ${SYNC_LIMITS.departments} 个`);
    };
    const under = async (parent) => {
      let token = "";
      for (let page = 0; page < SYNC_LIMITS.pages; page += 1) {
        const query = new URLSearchParams({ department_id_type: "open_department_id", user_id_type: "open_id", fetch_child: "true", page_size: String(SYNC_LIMITS.pageSize), ...(token ? { page_token: token } : {}) });
        const data = await this.#call(`/open-apis/contact/v3/departments/${encodeURIComponent(parent)}/children?${query}`);
        for (const item of data.items ?? []) keep(item);
        if (!data.has_more || !data.page_token) break;
        token = data.page_token;
      }
    };
    if (range.all) await under("0");
    else {
      for (const id of range.departments) {
        if (seen.has(id)) continue;   // already read, under a department above it
        const data = await this.#call(`/open-apis/contact/v3/departments/${encodeURIComponent(id)}?department_id_type=open_department_id&user_id_type=open_id`);
        if (data.department) keep(data.department);
        await under(id);
      }
    }
    // The root ("0") is not a department of its own here: its children are the top.
    const byId = new Map(raw.map((item) => [item.id, item]));
    const pathOf = (item, seen = new Set()) => {
      if (item.path) return item.path;
      if (seen.has(item.id)) return `/${item.id}/`;   // a cycle Feishu should never give; cut, not looped
      seen.add(item.id);
      const parent = byId.get(item.parentId);
      item.path = `${parent ? pathOf(parent, seen) : "/"}${item.id}/`;
      return item.path;
    };
    for (const item of raw) {
      item.path = pathOf(item);
      item.depth = item.path.split("/").filter(Boolean).length;
      item.parentId = byId.has(item.parentId) ? item.parentId : "";
    }
    return raw;
  }

  // Everybody in the directory, fifty at a time.
  async #people(tenantId, treeHasDepartments) {
    let checked = 0, departed = 0, disabled = 0, withoutDepartments = 0, unknown = 0;
    let cursor = null;
    do {
      const page = await this.people.list({ tenantId, sort: "first", cursor, limit: SYNC_LIMITS.batch });
      const ids = page.people.map((person) => person.userId).filter((id) => OPEN_ID.test(id));
      if (ids.length) {
        const query = new URLSearchParams({ user_id_type: "open_id", department_id_type: "open_department_id" });
        for (const id of ids) query.append("user_ids", id);
        const data = await this.#call(`/open-apis/contact/v3/users/batch?${query}`);
        const found = new Map((data.items ?? []).map((item) => [String(item.open_id ?? ""), item]));
        const records = [];
        for (const userId of ids) {
          const item = found.get(userId);
          // Outside the application's contact range, or gone from the
          // organisation altogether: not answered. Not taken as having left --
          // a narrowed range would otherwise disable everybody outside it.
          if (!item) { unknown += 1; continue; }
          const resigned = item.status?.is_resigned === true || item.status?.is_exited === true;
          const departments = Array.isArray(item.department_ids) ? item.department_ids.map(String).filter((id) => DEPARTMENT.test(id) && id !== "0") : [];
          if (!departments.length && !Array.isArray(item.department_ids) && treeHasDepartments) withoutDepartments += 1;
          records.push({ userId, employment: resigned ? "resigned" : "active", departments });
          if (resigned) departed += 1;
        }
        const departedAt = await this.org.recordPeople(tenantId, records);
        checked += records.length;
        // Left, per Feishu: disabled here, once, and said who decided --
        // unless an administrator has enabled them since.
        const leaving = records.filter((record) => {
          if (record.employment !== "resigned") return false;
          const entry = this.access.get(tenantId, record.userId);
          if (entry?.disabled) return false;
          return !(entry && Number(entry.at) >= (departedAt.get(record.userId) ?? Infinity));
        });
        if (leaving.length) {
          const changed = await this.access.disable(leaving.map((record) => ({ tenantId, userId: record.userId })), { reason: "飞书显示已离职（自动）", by: { userId: "", name: "组织架构同步" } });
          disabled += changed.length;
          const names = await this.people.names(tenantId, changed.map((entry) => entry.userId));
          for (const entry of changed) {
            this.audit({ category: "admin", action: "admin.person.disable", outcome: "ok", tenant: tenantId, source: "org-sync", actor: { kind: "system", name: "组织架构同步" },
              target: { kind: "person", id: entry.userId, name: names.get(entry.userId) ?? "" }, detail: { reason: "飞书显示已离职（自动）" } });
          }
        }
      }
      cursor = page.next;
    } while (cursor);
    // A person checked with no department_ids at all, in an organisation that
    // has departments: Feishu left the field out -- the scope for it is missing.
    return { checked, departed, disabled, unknown, ...(withoutDepartments === checked && checked > 0 ? { missingField: "contact:user.department:readonly" } : {}) };
  }
}
