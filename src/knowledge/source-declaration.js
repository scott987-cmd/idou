import { wikiDigest, wikiExact, wikiHash, wikiOpaque } from "./manifest.js";

// Metadata declaration, NOT proof that a publisher included no other content.
export function sourceDeclaration(values) {
  if (!Array.isArray(values) || !values.length || values.length > 200) throw new Error("invalid_source_declaration");
  const seen = new Set();
  const sources = values.map(value => {
    wikiExact(value, ["tenantId", "providerId", "resourceId", "revision", "contentHash", "textSha256"]);
    if (![value.tenantId, value.providerId, value.resourceId].every(wikiOpaque) || value.resourceId.length > 128 ||
      typeof value.revision !== "string" || !/^(0|[1-9]\d{0,15})$/.test(value.revision) || !Number.isSafeInteger(Number(value.revision)) ||
      !wikiDigest(value.contentHash) || !wikiDigest(value.textSha256)) throw new Error("invalid_source_declaration");
    const id = wikiHash([value.tenantId, value.providerId, value.resourceId]);
    if (seen.has(id)) throw new Error("invalid_source_declaration"); seen.add(id);
    return { id, value: Object.fromEntries(["tenantId", "providerId", "resourceId", "revision", "contentHash", "textSha256"].map(field => [field, value[field]])) };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(row => row.value);
  const sourceSetHash = wikiHash(sources.map(row => [row.tenantId, row.providerId, row.resourceId, row.revision, row.contentHash, row.textSha256]));
  return { sources, sourceSetHash, sourceCount: sources.length };
}
