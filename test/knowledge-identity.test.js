import assert from "node:assert/strict";
import test from "node:test";
import { chunkId, documentId } from "../src/knowledge/identity.js";

const source = {
  tenantId: "tenant-a",
  providerId: "feishu",
  resourceType: "docx",
  resourceId: "doc-1",
};

test("document identity is stable across source revisions", () => {
  assert.equal(documentId(source), documentId({ ...source, revision: "ignored" }));
});

test("tenant isolation is part of document identity", () => {
  assert.notEqual(documentId(source), documentId({ ...source, tenantId: "tenant-b" }));
});

test("chunk identity changes with source revision", () => {
  const stableDocumentId = documentId(source);
  assert.notEqual(
    chunkId({ documentId: stableDocumentId, revision: "1", ordinal: 0, text: "hello" }),
    chunkId({ documentId: stableDocumentId, revision: "2", ordinal: 0, text: "hello" }),
  );
});

