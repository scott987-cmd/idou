import { createHash } from "node:crypto";

export const wikiHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const wikiDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const wikiUuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const wikiOpaque = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
export function wikiExact(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some(key => !fields.includes(key))) throw new Error("invalid_wiki_metadata");
}
// This is a reference to an encrypted artifact, never its bytes or a source ACL.
export function wikiManifest(value) {
  const fields = ["format", "providerId", "driveTenantKey", "folderToken", "fileToken", "reservationId", "ciphertextSha256", "bytes", "keyId", "sourceSetHash", "sourceCount"];
  wikiExact(value, fields);
  if (value.format !== "wiki-aes256gcm-v1" || ![value.providerId, value.driveTenantKey, value.folderToken, value.fileToken].every(wikiOpaque) ||
    !wikiUuid(value.reservationId) || ![value.ciphertextSha256, value.keyId, value.sourceSetHash].every(wikiDigest) ||
    !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 10485760 || !Number.isSafeInteger(value.sourceCount) || value.sourceCount < 1 || value.sourceCount > 200) throw new Error("invalid_wiki_manifest");
  return Object.fromEntries(fields.map(key => [key, value[key]]));
}
