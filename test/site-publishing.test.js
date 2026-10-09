import test from "node:test";
import assert from "node:assert/strict";
import { siteShareCard, sitePublishCard, widensShare } from "../src/application/site-publishing.js";

// Found reviewing phase 0 (2026-10-03): changing who may open a published site
// -- groups, departments and the internet included -- raised no card.
test("only a sharing that lets somebody new in asks first", () => {
  const invited = { scope: "invited", inherit: false, members: [{ type: "user", id: "ou_a" }] };
  assert.equal(widensShare(invited, { ...invited, scope: "tenant" }), true);
  assert.equal(widensShare({ ...invited, scope: "tenant" }, { ...invited, scope: "anyone" }), true);
  assert.equal(widensShare(invited, { ...invited, inherit: true }), true, "following the table lets its readers in");
  assert.equal(widensShare(invited, { ...invited, members: [...invited.members, { type: "chat", id: "oc_b" }] }), true);
  assert.equal(widensShare(invited, { ...invited, members: [{ type: "department", id: "ou_a" }] }), true, "the same id as another kind is somebody else");
  assert.equal(widensShare({ ...invited, scope: "tenant" }, invited), false, "fewer people is not held up");
  assert.equal(widensShare(invited, { ...invited, members: [] }), false);
  assert.equal(widensShare({ ...invited, inherit: true }, invited), false);
  assert.equal(widensShare(invited, invited), false);
});

test("the cards say what changes, for whom", () => {
  const card = siteShareCard({ name: "看板", sliced: true, before: { scope: "invited", members: [] },
    after: { scope: "invited", inherit: true, members: [{ type: "chat", id: "oc_b", name: "销售群" }] } });
  assert.equal(card.title, "确认让更多人打开这个网站");
  assert.match(card.detail, /谁能打开：仅邀请的人可访问 → 跟随表格权限/);
  assert.match(card.detail, /新加的协作者：销售群（群）/);
  assert.match(siteShareCard({ name: "看板", before: { scope: "tenant" }, after: { scope: "anyone" } }).detail, /内容安全检查/);
  const update = sitePublishCard({ name: "看板", files: 3, bytes: 4096, share: { scope: "tenant" }, updating: true, task: "做销售看板" });
  assert.equal(update.title, "确认更新线上版本");
  assert.match(update.detail, /^任务「做销售看板」里的智能体要更新这个网站。/);
  assert.match(update.detail, /谁能打开：组织内获得链接的人可阅读（不变）/);
  assert.match(update.detail, /「历史版本」/);
});
