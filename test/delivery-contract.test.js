import assert from "node:assert/strict";
import test from "node:test";
import { createDeliveryIntent } from "../src/delivery/contracts.js";

test("creates a stable per-delivery idempotency key", () => {
  const intent = createDeliveryIntent({
    id: "delivery-1",
    kind: "link",
    recipients: [{ openId: "ou_1" }],
    resource: { url: "https://example.feishu.cn/docx/1" },
  });
  assert.equal(intent.idempotencyKey.length, 40);
  assert.equal(intent.permissionPolicy, "keep");
});

test("permission grants are explicit in delivery intent", () => {
  const intent = createDeliveryIntent({
    kind: "link",
    recipients: [{ openId: "ou_1" }],
    resource: { url: "https://example.feishu.cn/docx/1" },
    permissionPolicy: "grant-view",
  });
  assert.equal(intent.permissionPolicy, "grant-view");
});

