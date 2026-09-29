import { wikiExact, wikiHash } from "./manifest.js";

export const SOURCE_ACCESS_SCOPE = "docs:permission.member:auth";
export function sourceAccessInput(value) {
  wikiExact(value, ["sources"]);
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 20) throw new Error("invalid_source_access_request");
  const sources = value.sources.map(source => {
    wikiExact(source, ["resourceType", "resourceId"]);
    if (source.resourceType !== "docx" || typeof source.resourceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(source.resourceId)) throw new Error("invalid_source_access_request");
    return { resourceType: "docx", resourceId: source.resourceId };
  }).sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0);
  if (new Set(sources.map(source => source.resourceId)).size !== sources.length) throw new Error("invalid_source_access_request");
  return { sources, sourceSetHash: wikiHash(sources) };
}
