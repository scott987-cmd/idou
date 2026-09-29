import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { wikiDigest, wikiUuid, wikiOpaque, wikiExact, wikiManifest } from "./manifest.js";

const MAX_BYTES = 2 * 1024 * 1024;
export function publicationRecord(row) {
  wikiExact(row, ["id", "owner", "shardKey", "expectedGeneration", "sourceIds", "folder", "lease", "package", "policyDigest", "fileToken", "state", "contentDigest"]);
  if (row.contentDigest !== undefined && !wikiDigest(row.contentDigest)) throw new Error("invalid publication content digest");
  if (!wikiUuid(row.id) || ![row.owner, row.shardKey].every(wikiDigest) || !Number.isSafeInteger(row.expectedGeneration) || row.expectedGeneration < 0 || row.expectedGeneration >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(row.sourceIds) || !row.sourceIds.length || row.sourceIds.length > 200 || !row.sourceIds.every(wikiDigest) || new Set(row.sourceIds).size !== row.sourceIds.length ||
    !["created", "prepared", "dispatching", "recorded", "publishing", "published"].includes(row.state)) throw new Error("invalid publication record");
  const f = row.folder; wikiExact(f, ["providerId", "token", "url", "title", "identity"]); wikiExact(f.identity, ["principal", "tenantKey", "verifiedAt"]);
  if (![f.providerId, f.token, f.identity.tenantKey].every(wikiOpaque) || !wikiDigest(f.identity.principal) || !Number.isFinite(f.identity.verifiedAt) || typeof f.title !== "string" || !f.title || f.title.length > 300 ||
    typeof f.url !== "string" || f.url.length > 2048 || new URL(f.url).protocol !== "https:" || new URL(f.url).username || new URL(f.url).password) throw new Error("invalid publication folder");
  if (row.lease !== null) {
    wikiExact(row.lease, ["id", "fence", "nodeId"]);
    if (!wikiUuid(row.lease.id) || !wikiDigest(row.lease.nodeId) || !Number.isSafeInteger(row.lease.fence) || row.lease.fence < 1) throw new Error("invalid publication lease");
  }
  if (row.package !== null) {
    // 'pending' validates the package metadata shape only; it is never published.
    wikiExact(row.package, ["format", "providerId", "driveTenantKey", "folderToken", "reservationId", "ciphertextSha256", "bytes", "keyId", "sourceSetHash", "sourceCount"]);
    const m = wikiManifest({ ...row.package, fileToken: row.fileToken ?? "pending" });
    if (m.reservationId !== row.id || m.providerId !== f.providerId || m.driveTenantKey !== f.identity.tenantKey || m.folderToken !== f.token || m.sourceCount !== row.sourceIds.length) throw new Error("publication target mismatch");
  }
  if ((row.fileToken !== null && !wikiOpaque(row.fileToken)) || (row.policyDigest !== null && !wikiDigest(row.policyDigest)) ||
    (row.state !== "created" && (!row.lease || !row.package || !row.policyDigest)) ||
    (["recorded", "publishing", "published"].includes(row.state) !== (row.fileToken !== null))) throw new Error("publication state mismatch");
  return row;
}

// One native publisher process per account directory. Entries are never evicted:
// forgetting an ambiguous upload would let a scheduler create duplicate effects.
export class PublicationJournal {
  constructor({ filename, cipher }) { this.filename = path.resolve(filename); this.cipher = cipher; }
  validate(entries) {
    if (!Array.isArray(entries) || entries.length > 1000 || new Set(entries.map(row => row.id)).size !== entries.length) throw new Error("publication journal capacity/format");
    entries.forEach(publicationRecord); return entries;
  }
  async load() {
    if (!await this.cipher.available()) throw new Error("系统加密不可用，未准备知识发布。");
    let file;
    try {
      file = await open(this.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || (process.platform !== "win32" && (info.mode & 0o077))) throw new Error("invalid journal file");
      const value = JSON.parse(await this.cipher.decrypt(await file.readFile())); wikiExact(value, ["version", "entries"]);
      if (![1, 2].includes(value.version)) throw new Error("unknown journal"); return this.validate(value.entries);
    } catch (error) { if (error.code === "ENOENT") return []; throw new Error("知识发布记录无法安全读取，未覆盖旧文件。"); }
    finally { await file?.close(); }
  }
  async save(entries) {
    this.validate(entries); if (!await this.cipher.available()) throw new Error("系统加密不可用。");
    const bytes = await this.cipher.encrypt(JSON.stringify({ version: 2, entries }));
    if (bytes.length > MAX_BYTES) throw new Error("知识发布记录已满；不自动清理。");
    const directory = path.dirname(this.filename), temporary = `${this.filename}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 }); let file;
    try {
      file = await open(temporary, "wx", 0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
      await rename(temporary, this.filename);
      const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
    } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
}
