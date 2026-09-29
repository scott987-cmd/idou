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
    // a different decision, and it is not this one.
    return Object.freeze({ type, id, perm: "view" });
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
export async function decideSiteAccess(site, visitor, { readsSource = null, anonymousAllowed = false } = {}) {
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
  if (share.inherit && site.sourced && typeof readsSource === "function") {
    return await readsSource() ? { allowed: true, reason: REASONS.source } : { allowed: false, reason: REASONS.sourceDenied };
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
});
export const refusalText = (reason) => REFUSAL[reason] ?? "无法打开这个网站。";
