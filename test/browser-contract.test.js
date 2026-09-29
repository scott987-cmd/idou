import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedNavigation } from "../src/browser/contracts.js";

test("allows HTTPS and configured localhost previews", () => {
  assert.equal(assertAllowedNavigation("https://example.feishu.cn/docx/1").protocol, "https:");
  assert.equal(assertAllowedNavigation("http://localhost:5173", [5173]).port, "5173");
});

test("blocks file URLs and unapproved local ports", () => {
  assert.throws(() => assertAllowedNavigation("file:///etc/passwd", [5173]), /not allowed/);
  assert.throws(() => assertAllowedNavigation("http://localhost:9000", [5173]), /not allowed/);
});

