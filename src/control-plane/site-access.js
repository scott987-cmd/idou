// Who may open a published site.
//
// The model is Feishu's, deliberately: a person who has shared a document knows
// this vocabulary already, and a second vocabulary for the same idea is how two
// permission systems drift apart. A site has collaborators (people, groups,
// departments) and a link scope, exactly as a document does:
//
//   invited  仅邀请的人可访问      -- the owner and the collaborators, nobody else
//   tenant   组织内获得链接的人可阅读 -- anyone signed in from the same tenant
//   anyone   互联网上获得链接的人可阅读 -- no sign-in at all
//
// And for a site built on a table there is one more, which is the honest default:
//
//   inherit  跟随表格权限          -- whoever Feishu says may read that table
//
// `inherit` is not a fourth scope but a question asked of Feishu about this
// visitor. It is the only mode where revoking access in Feishu revokes the site
// too, with no second list to remember; the others keep a list here, and a list
// here is a second place the truth can live.
//
// Two rules hold whatever the mode:
//   - The site's own scope can only narrow. A site that inherits still refuses
//     a visitor its scope excludes, so a link that was meant for one department
//     does not widen because the table is open to the company.
//   - `anyone` exists only where the operator has allowed anonymous links at all
//     (IDOU_SITES_ANONYMOUS). In a private deployment that is a tenant
//     policy decision, not a per-site one.
//
// This module decides and explains; it reads nothing and calls nobody. The
// Feishu question is asked by the caller and handed in as `readsSource`, so the
// decision is testable without a network and the audit line is the same shape
// however it was reached.

export const SITE_SCOPES = Object.freeze(["invited", "tenant", "anyone"]);
export const MEMBER_TYPES = Object.freeze(["user", "chat", "department"]);
// Why a visitor was let in or turned away. The site's audit records the reason,
// never the identifiers it was decided from.
export const REASONS = Object.freeze({
  owner: "owner",
  member: "member",
  tenant: "tenant",
  anonymous: "anonymous",
  source: "source",
  noSession: "no_session",
  otherTenant: "other_tenant",
  notShared: "not_shared",
  sourceDenied: "source_denied",
  anonymousDisabled: "anonymous_disabled",
  // An administrator disabled this visitor's account (access-list.js).
  disabled: "account_disabled",
  // The question needed this visitor's own Feishu credential and there was
  // none, or it had run out: they are asked to sign in again, not refused.
  signInAgain: "sign_in_again",
  // Which groups or departments the visitor is in could not be read just now
  // (the bot's read failed, the directory did not answer): not a refusal.
  membersUnavailable: "members_unavailable",
  // Feishu did not answer the question: not a refusal either.
  sourceUnavailable: "source_unavailable",
});

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function parseShare(input, { anonymousAllowed = false } = {}) {
  const scope = input?.scope ?? "invited";
  if (!SITE_SCOPES.includes(scope)) throw new Error("分享范围无效");
  if (scope === "anyone" && !anonymousAllowed) throw new Error("这个部署没有开放「互联网上获得链接的人可阅读」");
  const inherit = input?.inherit === true;
  const members = Array.isArray(input?.members) ? input.members : [];
  if (members.length > 200) throw new Error("协作者最多 200 个");
  const seen = new Set();
  const parsed = members.map((member) => {
    const type = member?.type, id = member?.id;
    if (!MEMBER_TYPES.includes(type) || typeof id !== "string" || !ID.test(id)) throw new Error("协作者无效");
    const key = `${type}:${id}`;
    if (seen.has(key)) throw new Error("协作者重复");
    seen.add(key);
    // Only reading, for now. A site that could be written to through a link is
    // a different decision, and it is not this one. The name is what the owner
    // saw when they added them, for showing; access is decided by the id.
    const name = typeof member.name === "string" ? member.name.replace(/\s+/g, " ").trim().slice(0, 64) : "";
    return Object.freeze({ type, id, perm: "view", ...(name ? { name } : {}) });
  });
  return Object.freeze({ scope, inherit, members: Object.freeze(parsed) });
}

// Whether this visitor is one of the collaborators: themselves, or through a
// group or a department they belong to. Membership is what the caller learned
// from Feishu, never what a visitor claimed.
function named(share, visitor) {
  const groups = new Set(Array.isArray(visitor?.chats) ? visitor.chats : []);
  const departments = new Set(Array.isArray(visitor?.departments) ? visitor.departments : []);
  return share.members.some((member) => member.type === "user" ? member.id === visitor?.userId
    : member.type === "chat" ? groups.has(member.id)
    : departments.has(member.id));
}

// The decision. `visitor` is null when nobody is signed in.
//
//   site      { ownerId, tenantId, share, sourced }
//   visitor   { userId, tenantId, chats, departments } or null
//   readsSource  () => Promise<boolean>, asked only when it can change the answer
export async function decideSiteAccess(site, visitor, options = {}) {
  const verdict = await decided(site, visitor, options);
  // Turned away while who is in the site's groups or departments was not known:
  // that is no answer, not a no (review of phase 0, 2026-10-03 -- a failed read
  // of a group told everybody in it "not shared", and was kept 90 seconds).
  if (!verdict.allowed && visitor?.membershipUnknown === true && ![REASONS.noSession, REASONS.otherTenant, REASONS.disabled].includes(verdict.reason)
    && site.share.members.some((member) => member.type !== "user")) return { allowed: false, reason: REASONS.membersUnavailable };
  return verdict;
}
async function decided(site, visitor, { readsSource = null, anonymousAllowed = false } = {}) {
  const share = site.share;
  // Anonymous first: it is the only path that does not need a visitor, and a
  // site that is open to the internet should not send people through a login
  // only to let them in anyway.
  if (share.scope === "anyone") {
    if (!anonymousAllowed) return { allowed: false, reason: REASONS.anonymousDisabled };
    return { allowed: true, reason: REASONS.anonymous, anonymous: true };
  }
  if (!visitor?.userId) return { allowed: false, reason: REASONS.noSession };
  // A site belongs to one tenant. Nothing below may cross that line.
  if (site.tenantId && visitor.tenantId && site.tenantId !== visitor.tenantId) return { allowed: false, reason: REASONS.otherTenant };
  if (visitor.userId === site.ownerId) return { allowed: true, reason: REASONS.owner };
  if (named(share, visitor)) return { allowed: true, reason: REASONS.member };
  if (share.scope === "tenant") return { allowed: true, reason: REASONS.tenant };
  // Only now is Feishu asked, and only for a site that has a table to ask
  // about: the question costs a round trip, and the answers above did not need it.
  // Feishu's answer is yes or no; "relogin" and "unavailable" are no answer
  // at all, and a visitor is never told "no permission" for those.
  if (share.inherit && site.sourced && typeof readsSource === "function") {
    const answer = await readsSource();
    if (answer === true) return { allowed: true, reason: REASONS.source };
    if (answer === "relogin") return { allowed: false, reason: REASONS.signInAgain };
    if (answer === "unavailable") return { allowed: false, reason: REASONS.sourceUnavailable };
    return { allowed: false, reason: REASONS.sourceDenied };
  }
  return { allowed: false, reason: REASONS.notShared };
}

// What to tell somebody who was turned away. Never why somebody else would be
// let in, and never whether the site exists in a way that maps the tenant.
export const REFUSAL = Object.freeze({
  [REASONS.noSession]: "请先登录后再打开这个网站。",
  [REASONS.otherTenant]: "这个网站属于另一个组织。",
  [REASONS.notShared]: "你还没有这个网站的访问权限，请向分享给你的人申请。",
  [REASONS.sourceDenied]: "你没有这个网站所用表格的权限。权限在飞书的表格里设置，请向表格的拥有者申请。",
  [REASONS.anonymousDisabled]: "这个部署不允许未登录访问。",
  [REASONS.disabled]: "你的 i豆 账号已被管理员停用，不能打开这个网站。",
  [REASONS.signInAgain]: "需要重新登录，确认你还能看这个网站所用的表格。",
  [REASONS.sourceUnavailable]: "暂时没能向飞书确认你能不能看这个网站所用的表格，请过一会儿刷新。",
  [REASONS.membersUnavailable]: "暂时没能向飞书确认你在不在分享给的群或部门里，请过一会儿刷新。",
});
export const refusalText = (reason) => REFUSAL[reason] ?? "无法打开这个网站。";
