// What a send card says in its body is what a person reads -- and shares and
// records. Feishu's identifiers (the recipient's open_id, the group's and its
// owner's, the tenant, the sender's fingerprint) are for checking, and go in
// the card's folded 核对信息; the promo had to blur every frame that showed
// them (2026-09-25). A mentioned member still carries enough of their id to
// tell two people of the same name apart.
import test from "node:test";
import assert from "node:assert/strict";
import { deliveryConfirmation } from "../src/application/delivery-confirmation.js";

const IDENTIFIER = /\b(?:ou|on|oc|cli)_[0-9a-z_]{6,}/i;
const sender = { principal: "d2fcb1eb2357aa", tenantKey: "synthetic-tenant" };

test("a private send card names the recipient in its body and keeps the identifiers for checking", () => {
  const shown = deliveryConfirmation({ recipient: { kind: "user", id: "ou_46d524fd9f471a9bc76b3d77d0d39e67", name: "陈宁", department: "研发交付部", email: "chenning@example.test" }, sender, text: "请核对本周交付安排。" });
  assert.doesNotMatch(shown.detail, IDENTIFIER);
  assert.doesNotMatch(shown.detail, /synthetic-tenant|d2fcb1eb2357/);
  for (const line of ["收件人：陈宁", "部门：研发交付部", "邮箱：chenning@example.test", "请核对本周交付安排。"]) assert.ok(shown.detail.includes(line), line);
  for (const line of ["收件人标识：ou_46d524fd9f471a9bc76b3d77d0d39e67", "租户：synthetic-tenant", "身份指纹：d2fcb1eb2357"]) assert.ok(shown.technical.includes(line), line);
});

test("a group send card tells two members of the same name apart without their full ids", () => {
  const shown = deliveryConfirmation({ recipient: { kind: "group", id: "oc_synthetic_engineering", name: "交付评审", chatType: "private", memberCount: 3, ownerId: "ou_synthetic_owner" },
    mentions: [{ id: "ou_synthetic_engineering", name: "陈宁" }, { id: "ou_synthetic_reviewer", name: "周晓" }], sender, text: "请看" });
  assert.doesNotMatch(shown.detail, IDENTIFIER);
  assert.ok(shown.detail.includes("@陈宁（…ring）") && shown.detail.includes("@周晓（…ewer）"), shown.detail);
  for (const line of ["群标识：oc_synthetic_engineering", "群主标识：ou_synthetic_owner", "陈宁 ou_synthetic_engineering", "周晓 ou_synthetic_reviewer"]) assert.ok(shown.technical.includes(line), line);
});
