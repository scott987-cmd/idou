import { createHash } from "node:crypto";

function requirePart(name, value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    throw new Error(`${name} must be a non-empty string without NUL bytes`);
  }
  return value;
}

export function documentId({ tenantId, providerId, resourceType, resourceId }) {
  const identity = [
    requirePart("tenantId", tenantId),
    requirePart("providerId", providerId),
    requirePart("resourceType", resourceType),
    requirePart("resourceId", resourceId),
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function chunkId({ documentId: stableDocumentId, revision, ordinal, text }) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("ordinal must be a non-negative integer");
  const identity = [
    requirePart("documentId", stableDocumentId),
    requirePart("revision", revision),
    ordinal,
    requirePart("text", text),
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

