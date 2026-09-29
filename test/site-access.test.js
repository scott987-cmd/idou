import test from "node:test";
import assert from "node:assert/strict";
import { REASONS, SITE_SCOPES, decideSiteAccess, parseShare, refusalText } from "../src/control-plane/site-access.js";

const site = (share, extra = {}) => ({ ownerId: "ou_owner", tenantId: "t1", sourced: true, share: parseShare(share, { anonymousAllowed: true }), ...extra });
const visitor = (extra = {}) => ({ userId: "ou_visitor", tenantId: "t1", chats: [], departments: [], ...extra });
const decide = (one, who, options) => decideSiteAccess(one, who, { anonymousAllowed: true, ...options });

test("the share object is Feishu's vocabulary, and nothing else gets in", () => {
  assert.deepEqual(SITE_SCOPES, ["invited", "tenant", "anyone"]);
  const share = parseShare({ scope: "tenant", inherit: true, members: [{ type: "user", id: "ou_a" }, { type: "department", id: "od-1" }] });
  assert.equal(share.scope, "tenant");
  assert.equal(share.inherit, true);
  assert.deepEqual(share.members.map((member) => [member.type, member.id, member.perm]), [["user", "ou_a", "view"], ["department", "od-1", "view"]]);
  assert.equal(Object.isFrozen(share), true);
  assert.deepEqual(parseShare(undefined), { scope: "invited", inherit: false, members: [] });
  for (const bad of [{ scope: "public" }, { scope: "tenant", members: [{ type: "user" }] }, { scope: "tenant", members: [{ type: "robot", id: "x" }] },
    { members: [{ type: "user", id: "ou a" }] }, { members: [{ type: "user", id: "ou_a" }, { type: "user", id: "ou_a" }] },
    { members: Array.from({ length: 201 }, (_, i) => ({ type: "user", id: `ou_${i}` })) }]) {
    assert.throws(() => parseShare(bad), Error, JSON.stringify(bad));
  }
});

test("anonymous links exist only where the deployment allows them at all", async () => {
  assert.throws(() => parseShare({ scope: "anyone" }), /没有开放/);
  const open = site({ scope: "anyone" });
  assert.deepEqual(await decide(open, null), { allowed: true, reason: REASONS.anonymous, anonymous: true });
  // The same site, on a deployment that does not allow them: refused, not served.
  assert.deepEqual(await decideSiteAccess(open, visitor(), { anonymousAllowed: false }),
    { allowed: false, reason: REASONS.anonymousDisabled });
});

test("the owner, the collaborators, and nobody else", async () => {
  const invited = site({ scope: "invited", members: [{ type: "user", id: "ou_friend" }] });
  assert.equal((await decide(invited, visitor({ userId: "ou_owner" }))).reason, REASONS.owner);
  assert.equal((await decide(invited, visitor({ userId: "ou_friend" }))).reason, REASONS.member);
  assert.deepEqual(await decide(invited, visitor()), { allowed: false, reason: REASONS.notShared });
  assert.deepEqual(await decide(invited, null), { allowed: false, reason: REASONS.noSession });
});

test("a group or a department names people the site never listed one by one", async () => {
  const shared = site({ scope: "invited", members: [{ type: "chat", id: "oc_team" }, { type: "department", id: "od-sales" }] });
  assert.equal((await decide(shared, visitor({ chats: ["oc_other", "oc_team"] }))).reason, REASONS.member);
  assert.equal((await decide(shared, visitor({ departments: ["od-sales"] }))).reason, REASONS.member);
  assert.equal((await decide(shared, visitor({ chats: ["oc_other"], departments: ["od-ops"] }))).allowed, false);
  // Membership is what the caller learned from Feishu; a visitor claiming it is
  // simply a visitor whose session says so, which is the same thing said once.
  assert.equal((await decide(shared, visitor({ chats: "oc_team" }))).allowed, false, "不是数组就是没有");
});

test("组织内 lets the tenant in, and still stops at the tenant line", async () => {
  const inside = site({ scope: "tenant" });
  assert.equal((await decide(inside, visitor())).reason, REASONS.tenant);
  assert.deepEqual(await decide(inside, visitor({ tenantId: "t2" })), { allowed: false, reason: REASONS.otherTenant });
  // Even a collaborator from another tenant: a site belongs to one organisation.
  const named = site({ scope: "invited", members: [{ type: "user", id: "ou_outside" }] });
  assert.deepEqual(await decide(named, visitor({ userId: "ou_outside", tenantId: "t2" })), { allowed: false, reason: REASONS.otherTenant });
});

test("跟随表格权限: Feishu decides, and is asked only when it can change the answer", async () => {
  let asked = 0;
  const ask = (answer) => async () => { asked += 1; return answer; };
  const following = site({ scope: "invited", inherit: true });
  assert.deepEqual(await decide(following, visitor(), { readsSource: ask(true) }), { allowed: true, reason: REASONS.source });
  assert.deepEqual(await decide(following, visitor(), { readsSource: ask(false) }), { allowed: false, reason: REASONS.sourceDenied });
  assert.equal(asked, 2);
  // The owner, a collaborator and 组织内 are all decided before the round trip.
  await decide(following, visitor({ userId: "ou_owner" }), { readsSource: ask(true) });
  await decide(site({ scope: "tenant", inherit: true }), visitor(), { readsSource: ask(true) });
  await decide(site({ scope: "invited", inherit: true, members: [{ type: "user", id: "ou_visitor" }] }), visitor(), { readsSource: ask(true) });
  assert.equal(asked, 2, "能不问就不问");
  // A site with no table to ask about never asks, whatever it declared.
  assert.deepEqual(await decide(site({ scope: "invited", inherit: true }, { sourced: false }), visitor(), { readsSource: ask(true) }),
    { allowed: false, reason: REASONS.notShared });
  assert.equal(asked, 2);
});

test("the site's own scope can only narrow, never widen", async () => {
  // The table is open to everybody, but this link was meant for one person.
  const narrow = site({ scope: "invited", inherit: true, members: [{ type: "user", id: "ou_friend" }] });
  assert.equal((await decide(narrow, visitor({ userId: "ou_stranger" }), { readsSource: async () => true })).allowed, true,
    "跟随表格时，表格说可以就是可以");
  // ...but a visitor from another tenant is still out, and so is one with no session.
  assert.equal((await decide(narrow, visitor({ tenantId: "t2" }), { readsSource: async () => true })).allowed, false);
  assert.equal((await decide(narrow, null, { readsSource: async () => true })).allowed, false);
});

test("a refusal says what to do, and never who else may look", () => {
  for (const reason of [REASONS.noSession, REASONS.otherTenant, REASONS.notShared, REASONS.sourceDenied, REASONS.anonymousDisabled]) {
    const text = refusalText(reason);
    assert.ok(text.length > 4, reason);
    assert.equal(/ou_|oc_|od-|t1/.test(text), false, "拒绝理由里不能出现标识符");
  }
  assert.match(refusalText(REASONS.sourceDenied), /在飞书的表格里设置/);
  assert.equal(refusalText("nonsense"), "无法打开这个网站。");
});
