import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { wikiDigest, wikiExact, wikiHash, wikiManifest, wikiOpaque } from "../knowledge/manifest.js";

const fail = () => { throw new Error("wiki_key_custody_unavailable"); };
const OPEN = Symbol("validated-vault-path");
const contextFields = ["tenant", "shardKey", "generation", "fence", "nodeId", "providerId", "driveTenantKey", "folderToken", "sourceSetHash", "sourceCount"];
export function wikiKeyContext(value) {
  wikiExact(value, contextFields);
  if (![value.tenant, value.shardKey, value.nodeId, value.sourceSetHash].every(wikiDigest) ||
    ![value.providerId, value.driveTenantKey, value.folderToken].every(wikiOpaque) ||
    ![value.generation, value.fence, value.sourceCount].every(n => Number.isSafeInteger(n) && n > 0) || value.sourceCount > 200) fail();
  return Object.fromEntries(contextFields.map(field => [field, value[field]]));
}
const privateFile = info => info.isFile() && info.nlink === 1 && (process.platform === "win32" || !(info.mode & 0o077) && info.uid === process.getuid());

// Content keys only, not model/OAuth credentials. No HTTP interface, import,
// plaintext persistence, default root key or automatic root-key generation.
export class WikiKeyVault {
  #db; #root; #id; #closed = false; #active = new Map();
  static async open({ databaseFile, wrappingKey }) {
    if (!Buffer.isBuffer(wrappingKey) || wrappingKey.length !== 32 || typeof databaseFile !== "string" || !path.isAbsolute(databaseFile) || path.normalize(databaseFile) !== databaseFile) fail();
    const directory = path.dirname(databaseFile); await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || await realpath(directory) !== directory || process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid())) fail();
    let file;
    try { file = await open(databaseFile, "wx", 0o600); } catch (error) { if (error.code !== "EEXIST") throw error; } finally { await file?.close(); }
    for (const name of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
      try { if (!privateFile(await lstat(name))) fail(); } catch (error) { if (error.code !== "ENOENT" || name === databaseFile) throw error; }
    }
    return new WikiKeyVault(databaseFile, wrappingKey, OPEN);
  }
  static async fromFiles({ databaseFile, wrappingKeyFile }) {
    let file, key;
    try {
      if (typeof wrappingKeyFile !== "string" || !path.isAbsolute(wrappingKeyFile) || await realpath(wrappingKeyFile) !== wrappingKeyFile) fail();
      file = await open(wrappingKeyFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat(); if (!privateFile(info) || info.size !== 32) fail();
      key = await file.readFile(); if (key.length !== 32) fail();
      return await WikiKeyVault.open({ databaseFile, wrappingKey: key });
    } catch { fail(); } finally { key?.fill(0); await file?.close(); }
  }
  constructor(databaseFile, wrappingKey, permission) {
    if (permission !== OPEN || !Buffer.isBuffer(wrappingKey) || wrappingKey.length !== 32) fail();
    this.#root = Buffer.from(wrappingKey);
    try {
      this.#db = new DatabaseSync(databaseFile, { timeout: 1000, allowExtension: false });
      this.#db.exec("PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const version = this.#db.prepare("PRAGMA user_version").get().user_version;
        if (![0, 1].includes(version)) fail();
        if (version === 0) {
          if (this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) fail();
          this.#db.exec(`CREATE TABLE wiki_vault_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, check_key BLOB NOT NULL) STRICT;
            CREATE TABLE wiki_keys (slot TEXT PRIMARY KEY, key_id TEXT UNIQUE NOT NULL, context TEXT NOT NULL, package TEXT, sealed BLOB, revoked INTEGER NOT NULL CHECK(revoked IN (0,1))) STRICT;
            PRAGMA user_version=1;`);
          this.#id = randomUUID(); const probe = Buffer.alloc(32);
          this.#db.prepare("INSERT INTO wiki_vault_meta VALUES (1,?,?)").run(this.#id, this.#seal(probe, "root-check"));
        } else {
          const meta = this.#db.prepare("SELECT id,check_key FROM wiki_vault_meta WHERE singleton=1").get(); if (!meta) fail();
          this.#id = meta.id; const probe = this.#open(meta.check_key, "root-check");
          try { if (!probe.equals(Buffer.alloc(32))) fail(); } finally { probe.fill(0); }
        }
        if (this.#db.prepare("PRAGMA quick_check").get().quick_check !== "ok") fail();
        this.#db.exec("COMMIT");
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    } catch { this.#db?.close(); this.#root.fill(0); this.#closed = true; fail(); }
  }
  #current() { if (this.#closed) fail(); }
  #aad(value) { return Buffer.from(JSON.stringify(["mydoubao-wiki-key-v1", this.#id, value])); }
  #seal(key, binding) {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#root, nonce, { authTagLength: 16 });
    cipher.setAAD(this.#aad(binding)); const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  }
  #open(sealed, binding) {
    this.#current(); let partial;
    try {
      if (!(sealed instanceof Uint8Array) || sealed.length !== 60) fail();
      const decipher = createDecipheriv("aes-256-gcm", this.#root, sealed.subarray(0, 12), { authTagLength: 16 });
      decipher.setAAD(this.#aad(binding)); decipher.setAuthTag(sealed.subarray(12, 28));
      partial = decipher.update(sealed.subarray(28));
      return Buffer.concat([partial, decipher.final()]);
    } catch { fail(); } finally { partial?.fill(0); }
  }
  #binding(row) { return [row.key_id, row.context, row.package]; }
  #row(context) {
    this.#current(); const normalized = wikiKeyContext(context), json = JSON.stringify(normalized);
    const slot = wikiHash([normalized.tenant, normalized.shardKey, normalized.fence]);
    const row = this.#db.prepare("SELECT * FROM wiki_keys WHERE slot=?").get(slot);
    if (row && (row.context !== json || row.revoked !== 0 || !row.sealed)) fail();
    return { row, slot, json, normalized };
  }
  #transaction(work) {
    this.#current(); this.#db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.#db.exec("COMMIT"); return result; } catch { this.#db.exec("ROLLBACK"); fail(); }
  }
  #package(context, keyId, value) {
    wikiExact(value, ["format", "providerId", "driveTenantKey", "folderToken", "reservationId", "ciphertextSha256", "bytes", "keyId", "sourceSetHash", "sourceCount"]);
    const { fileToken, ...metadata } = wikiManifest({ ...value, fileToken: "pending" });
    if (metadata.keyId !== keyId || ["providerId", "driveTenantKey", "folderToken", "sourceSetHash", "sourceCount"].some(field => metadata[field] !== context[field])) fail();
    return JSON.stringify(metadata);
  }
  // Idempotent only while unbound. An existing bound package is resumed through
  // assertBound, never by handing out its publisher key to encrypt a new payload.
  async prepare(context, use) {
    if (typeof use !== "function") fail();
    const row = this.#transaction(() => {
      const existing = this.#row(context); if (existing.row) { if (existing.row.package !== null) fail(); return existing.row; }
      if (this.#db.prepare("SELECT COUNT(*) AS n FROM wiki_keys").get().n >= 100000) fail();
      const row = { slot: existing.slot, key_id: randomBytes(32).toString("hex"), context: existing.json, package: null }, key = randomBytes(32);
      try { row.sealed = this.#seal(key, this.#binding(row)); } finally { key.fill(0); }
      this.#db.prepare("INSERT INTO wiki_keys VALUES (?,?,?,?,?,0)").run(row.slot, row.key_id, row.context, null, row.sealed); return row;
    });
    return this.#use(row, use);
  }
  bind(context, keyId, metadata) {
    return this.#transaction(() => {
      const { row, normalized } = this.#row(context); if (!row || row.key_id !== keyId) fail();
      const bound = this.#package(normalized, keyId, metadata);
      if (row.package !== null) { if (row.package !== bound) fail(); this.assertBound(context, keyId, metadata); return; }
      const key = this.#open(row.sealed, this.#binding(row));
      try { row.package = bound; const sealed = this.#seal(key, this.#binding(row)); this.#db.prepare("UPDATE wiki_keys SET package=?,sealed=? WHERE slot=?").run(bound, sealed, row.slot); }
      finally { key.fill(0); }
    });
  }
  assertBound(context, keyId, metadata) {
    const { row, normalized } = this.#row(context);
    if (!row || row.key_id !== keyId || row.package !== this.#package(normalized, keyId, metadata)) fail();
    const key = this.#open(row.sealed, this.#binding(row)); key.fill(0);
  }
  assertAvailable(context, keyId) {
    const { row } = this.#row(context); if (!row || row.key_id !== keyId) fail();
    const key = this.#open(row.sealed, this.#binding(row)); key.fill(0);
  }
  async withKey(context, manifest, use) {
    const { fileToken, ...metadata } = wikiManifest(manifest);
    this.assertBound(context, manifest.keyId, metadata);
    return this.#use(this.#row(context).row, use);
  }
  async #use(row, use) {
    if (typeof use !== "function") fail(); const key = this.#open(row.sealed, this.#binding(row)); this.#active.set(key, row.key_id);
    try {
      const value = await use(key, row.key_id); this.#current();
      const latest = this.#db.prepare("SELECT revoked FROM wiki_keys WHERE slot=? AND key_id=?").get(row.slot, row.key_id);
      if (latest?.revoked !== 0) fail(); return value;
    } finally { key.fill(0); this.#active.delete(key); }
  }
  revoke(keyId) {
    this.#current(); if (!wikiDigest(keyId)) fail();
    const changed = this.#db.prepare("UPDATE wiki_keys SET revoked=1,sealed=NULL WHERE key_id=? AND revoked=0").run(keyId).changes === 1;
    for (const [key, id] of this.#active) if (id === keyId) key.fill(0);
    return changed;
  }
  close() {
    if (this.#closed) return; this.#closed = true;
    for (const key of this.#active.keys()) key.fill(0); this.#active.clear(); this.#root.fill(0); this.#db.close();
  }
}
