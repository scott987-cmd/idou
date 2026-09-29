import { wikiDigest, wikiExact } from "./manifest.js";

export function publicationScope(value) {
  wikiExact(value, ["shardKey", "sourceIds", "folderReference"]);
  if (!wikiDigest(value.shardKey) || !Array.isArray(value.sourceIds) || !value.sourceIds.length || value.sourceIds.length > 200 || !value.sourceIds.every(wikiDigest) ||
    new Set(value.sourceIds).size !== value.sourceIds.length || typeof value.folderReference !== "string" || !value.folderReference || value.folderReference.length > 2048) throw new Error("自动发布范围无效。");
  return { shardKey: value.shardKey, sourceIds: [...value.sourceIds].sort(), folderReference: value.folderReference };
}
