import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { evidencePage } from "./local-wiki.js";
import { SYNTHESIS_RECIPE, validateFacts } from "./synthesis.js";
import { isChatModel } from "../providers/codex/chat-models.js";
import { wikiDigest, wikiExact, wikiHash, wikiManifest, wikiOpaque } from "./manifest.js";

const MAGIC = Buffer.from("MDBWIKI1"), MAX_BYTES = 10485760;
export const bundleDigest = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => new Error("知识包格式、完整性或加密校验失败；未使用包内内容。");

// No publisher ACL or owner is portable authority. Recipients reconstruct it.
export function portableSource(value) {
  wikiExact(value, ["tenantId", "providerId", "resourceId", "sourceUrl", "revision", "contentHash", "title", "text", "synthesis"]);
  const page = evidencePage({ ...value, sourceRevision: value.revision, partial: false,
    identity: { principal: "untrusted-portable-source", tenantKey: value.tenantId, verifiedAt: 0 } }, 0);
  const record = Object.fromEntries(["tenantId", "providerId", "resourceId", "sourceUrl", "revision", "contentHash", "title", "text"].map(key => [key, value[key]]));
  if (value.synthesis !== undefined) {
    wikiExact(value.synthesis, ["recipe", "model", "facts"]);
    // Publisher and recipient may run different chat models. The record keeps
    // the name of the one that produced it; only a model this product knows is
    // accepted, and the citations are re-verified against the text either way.
    if (value.synthesis.recipe !== SYNTHESIS_RECIPE || !isChatModel(value.synthesis.model)) throw fail();
    record.synthesis = { recipe: SYNTHESIS_RECIPE, model: value.synthesis.model, facts: validateFacts(value.synthesis, page) };
  }
  return record;
}
export function portablePage(page) {
  return portableSource({ tenantId: page.tenantId, providerId: page.providerId, resourceId: page.resourceId, sourceUrl: page.sourceUrl,
    revision: page.revision, contentHash: page.contentHash, title: page.title, text: page.chunks.map(chunk => chunk.text).join(""),
    ...(page.synthesis?.state === "complete" ? { synthesis: { recipe: page.synthesis.recipe, model: page.synthesis.model, facts: page.synthesis.facts } } : {}) });
}
function sources(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 200) throw fail();
  const seen = new Set(); let size = 0;
  const records = values.map(value => {
    const record = portableSource(value), id = wikiHash([record.tenantId, record.providerId, record.resourceId]);
    if (seen.has(id)) throw fail(); seen.add(id);
    size += Buffer.byteLength(JSON.stringify(record)); if (size > MAX_BYTES - 4096) throw fail();
    return { record, id };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return records.map(item => item.record);
}
function sourceSetHash(records) {
  return wikiHash(records.map(record => [record.tenantId, record.providerId, record.resourceId, record.revision, record.contentHash, bundleDigest(Buffer.from(record.text))]));
}
export const bundleSourceSetHash = values => sourceSetHash(sources(values));
// Stable across nonce/device/time changes, but includes titles, canonical URLs
// and cited synthesis as well as source versions. Never sent as plaintext.
export const bundleContentDigest = values => wikiHash(["wiki-content-v1", sources(values)]);
function context(value) {
  const fields = ["shardKey", "generation", "fence", "nodeId", "keyId", "providerId", "driveTenantKey", "folderToken"];
  wikiExact(value, fields);
  if (![value.shardKey, value.nodeId, value.keyId].every(wikiDigest) || ![value.providerId, value.driveTenantKey, value.folderToken].every(wikiOpaque) ||
    ![value.generation, value.fence].every(number => Number.isSafeInteger(number) && number > 0)) throw fail();
  return Object.fromEntries(fields.map(field => [field, value[field]]));
}
function keyBytes(value) { if (!Buffer.isBuffer(value) || value.length !== 32) throw fail(); return Buffer.from(value); }

export function sealWikiBundle(values, binding, key) {
  let secret, plaintext;
  try {
    const records = sources(values), bound = context(binding);
    if (records.some(record => record.tenantId !== bound.driveTenantKey || record.providerId !== bound.providerId)) throw fail();
    secret = keyBytes(key);
    const metadata = { format: "wiki-aes256gcm-v1", ...bound, sourceSetHash: sourceSetHash(records), sourceCount: records.length };
    const header = Buffer.from(JSON.stringify(metadata)), length = Buffer.alloc(4); length.writeUInt32BE(header.length);
    if (header.length > 2048) throw fail();
    const aad = Buffer.concat([MAGIC, length, header]), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv, { authTagLength: 16 });
    cipher.setAAD(aad); plaintext = Buffer.from(JSON.stringify({ version: 1, records }));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const bytes = Buffer.concat([aad, iv, cipher.getAuthTag(), ciphertext]);
    if (bytes.length > MAX_BYTES) throw fail();
    return { bytes, metadata: { ...metadata, bytes: bytes.length, ciphertextSha256: bundleDigest(bytes) } };
  } catch { throw fail(); }
  finally { secret?.fill(0); plaintext?.fill(0); }
}

export function openWikiBundle(bytes, { shardKey, publication, key }) {
  let secret, plaintext, partial;
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 41 || bytes.length > MAX_BYTES || publication?.state !== "published" || publication.clientReported !== true) throw fail();
    const manifest = wikiManifest(publication.manifest);
    if (publication.manifestHash !== wikiHash(manifest) || manifest.bytes !== bytes.length || bundleDigest(bytes) !== manifest.ciphertextSha256) throw fail();
    const bound = context({ shardKey, generation: publication.generation, fence: publication.fence, nodeId: publication.nodeId,
      keyId: manifest.keyId, providerId: manifest.providerId, driveTenantKey: manifest.driveTenantKey, folderToken: manifest.folderToken });
    const expected = Buffer.from(JSON.stringify({ format: manifest.format, ...bound, sourceSetHash: manifest.sourceSetHash, sourceCount: manifest.sourceCount }));
    const headerLength = bytes.readUInt32BE(8), offset = 12 + headerLength;
    if (!bytes.subarray(0, 8).equals(MAGIC) || headerLength > 2048 || offset + 28 >= bytes.length || !bytes.subarray(12, offset).equals(expected)) throw fail();
    secret = keyBytes(key);
    const decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(offset, offset + 12), { authTagLength: 16 });
    decipher.setAAD(bytes.subarray(0, offset)); decipher.setAuthTag(bytes.subarray(offset + 12, offset + 28));
    partial = decipher.update(bytes.subarray(offset + 28));
    plaintext = Buffer.concat([partial, decipher.final()]); // Never parse update() output before final authentication.
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)); wikiExact(data, ["version", "records"]);
    if (data.version !== 1) throw fail(); const records = sources(data.records);
    if (records.length !== manifest.sourceCount || sourceSetHash(records) !== manifest.sourceSetHash || records.some(record => record.tenantId !== bound.driveTenantKey || record.providerId !== bound.providerId)) throw fail();
    return records;
  } catch { throw fail(); }
  finally { secret?.fill(0); plaintext?.fill(0); partial?.fill(0); }
}
