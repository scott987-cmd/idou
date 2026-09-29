import test from "node:test";
import assert from "node:assert/strict";
import { previewPageReference, textLineNumbers } from "../src/desktop/renderer/task-preview.js";

test("text line numbers stay aligned with the read-only file content", () => {
  assert.equal(textLineNumbers("one\ntwo\nthree"), "1\n2\n3");
  assert.equal(textLineNumbers(""), "1");
  assert.equal(textLineNumbers("one\n"), "1\n2");
});

test("the current preview becomes a task-owned, versioned page reference", () => {
  const revision = "a".repeat(64);
  assert.deepEqual(previewPageReference({ path: "dist/index.html", revision, title: "成果页" }), {
    kind: "page", key: `page:dist/index.html:${revision}`, path: "dist/index.html", revision, title: "成果页", address: "/dist/index.html", state: "current",
  });
  assert.throws(() => previewPageReference(null), /没有加载完成/);
});
