import test from "node:test";
import assert from "node:assert/strict";
import { contextPresentation, knowledgeScopeVisible, mediaResultPresentation, selectionReferencePresentation } from "../src/desktop/renderer/office-outcomes.js";

test("knowledge scope follows task mode instead of the page hosting the task", () => {
  assert.equal(knowledgeScopeVisible({ mode: "cowork" }), true);
  assert.equal(knowledgeScopeVisible({ mode: "coding" }), false);
  assert.equal(knowledgeScopeVisible(null), false);
});

test("selection labels keep the exact resource, scope and revision visible after navigation", () => {
  const current = selectionReferencePresentation({ resourceKind: "feishu-sheet", title: "预算表", scope: "Sheet2!A3:C8", revision: "revision-1234567890", state: "current" });
  assert.match(current.label, /飞书电子表格 · 预算表 · Sheet2!A3:C8 · revision-123456/);
  const stale = selectionReferencePresentation({ resourceKind: "feishu-document", title: "方案 A", url: "https://example.test/docx/a", revision: "12", selection: { startLine: 4, endLine: 7 }, state: "unavailable" });
  assert.match(stale.label, /飞书文档需重新核对 · 方案 A · 第 4–7 行 · 12/);
  assert.match(stale.detail, /docx\/a\n版本 12\n第 4–7 行/);
  assert.match(contextPresentation({ kind: "feishu-base", title: "客户表", offset: 20, sourceRevision: "digest-abc" }), /飞书多维表格 · 客户表 · 第 21 条起 · 版本 digest-abc/);
});

test("media cards never claim a temporary or uncertain result was saved", () => {
  assert.deepEqual(mediaResultPresentation({ kind: "video", state: "awaiting_acceptance", persisted: false, deliveryState: null }), {
    kind: "视频", state: "temporary", title: "视频临时成果", status: "可预览 · 尚未保存", detail: "临时结果不是云盘文件",
  });
  assert.equal(mediaResultPresentation({ kind: "image", state: "awaiting_acceptance", persisted: false, deliveryState: "verification_pending" }).status, "云盘保存结果待核对");
  assert.equal(mediaResultPresentation({ kind: "image", state: "awaiting_acceptance", persisted: true, deliveryState: "available" }).status, "已保存到飞书云盘");
});
