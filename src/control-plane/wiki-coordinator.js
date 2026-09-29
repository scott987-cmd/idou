import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { readCatalogConfigFile } from "./skill-catalog.js";
import { wikiHash, wikiDigest, wikiUuid, wikiOpaque, wikiExact, wikiManifest } from "../knowledge/manifest.js";
import { DriveBudgetError } from "./drive-budget.js";
import { sourceDeclaration } from "../knowledge/source-declaration.js";

class WikiError extends Error { constructor(status, code) { super(code); this.status = status; } }
const fail = (status, code) => { throw new WikiError(status, code); };
const tenantKey = who => wikiHash([who.authProvider, who.tenantId, who.appId]);
const nodeKey = who => wikiHash([tenantKey(who), who.userId, who.deviceId]);
const generation = value => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
export const WIKI_LIMITS = Object.freeze({ leaseMs: 120000, maxShards: 10000, maxLeases: 100000 });

// SQLite on one control-plane host arbitrates multiple independent clients.
// No document/title/query/key/bundle is accepted or stored in this database.
export class WikiCoordinator {
  // A Feishu tenant row's app id must belong to the deployment the Drive budget
  // was loaded for.
  constructor({ databaseFile, tenants, budget, now = Date.now }) {
    if (!budget?.feishu || !Array.isArray(tenants) || !tenants.length || tenants.length > 1000) throw new Error("Wiki coordination requires tenant grants and Drive budget");
    const feishu = budget.feishu;
    const seen = new Set();
    this.tenants = tenants.map(row => {
      wikiExact(row, ["authProvider", "tenantId", "appId", "members"]);
      if (!["development", "feishu"].includes(row.authProvider) || !wikiOpaque(row.tenantId) ||
        (row.authProvider === "feishu" ? !feishu.ids.app(row.appId) : row.appId !== null) ||
        !Array.isArray(row.members) || !row.members.length || row.members.length > 1000 || !row.members.every(wikiOpaque) || new Set(row.members).size !== row.members.length || seen.has(tenantKey(row))) throw new Error("Invalid Wiki tenant grant");
      seen.add(tenantKey(row)); budget.policy(row); return { ...row, members: [...row.members] };
    });
    this.budget = budget; this.now = now;
    this.db = new DatabaseSync(databaseFile, { timeout: 1000, allowExtension: false });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1, 2].includes(version)) throw new Error("Unsupported Wiki coordinator schema");
      this.db.exec(`CREATE TABLE IF NOT EXISTS wiki_heads (
        tenant TEXT NOT NULL, shard TEXT NOT NULL, generation INTEGER NOT NULL, fence INTEGER NOT NULL,
        lease_id TEXT, publication TEXT, PRIMARY KEY(tenant,shard)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS wiki_leases (
        tenant TEXT NOT NULL, request_id TEXT NOT NULL, id TEXT NOT NULL UNIQUE, shard TEXT NOT NULL,
        node TEXT NOT NULL, fence INTEGER NOT NULL, base_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        policy TEXT NOT NULL, publication TEXT, PRIMARY KEY(tenant,request_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS wiki_source_declarations (
        lease_id TEXT PRIMARY KEY, source_hash TEXT NOT NULL, sources TEXT NOT NULL, registered_at INTEGER NOT NULL
      ) STRICT; PRAGMA user_version=2;`);
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Invalid Wiki coordinator database");
    } catch (error) { this.db.close(); throw error; }
  }
  static async fromConfig(filename, budget) {
    const config = JSON.parse(await readCatalogConfigFile(filename, 1048576)); wikiExact(config, ["schemaVersion", "databaseFile", "tenants"]);
    if (config.schemaVersion !== 1 || typeof config.databaseFile !== "string" || !path.isAbsolute(config.databaseFile)) throw new Error("Invalid Wiki coordinator configuration");
    const directory = path.dirname(config.databaseFile); await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || await realpath(directory) !== directory || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw new Error("Wiki coordinator requires a private non-symlink directory");
    try { const file = await open(config.databaseFile, "wx", 0o600); await file.close(); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(config.databaseFile);
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error("Wiki coordinator requires a private database");
    return new WikiCoordinator({ ...config, budget });
  }
  authorize(who) {
    if (!this.tenants.some(row => tenantKey(row) === tenantKey(who) && row.members.includes(who.userId))) fail(403, "wiki_membership_required");
    if (!wikiOpaque(who.deviceId) || !Number.isSafeInteger(who.expiresAt) || who.expiresAt <= this.now()) fail(401, "wiki_session_expired");
    return this.budget.snapshot(who);
  }
  transaction(fn) { this.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  status(who, body) { wikiExact(body, []); const policy = this.authorize(who); return { nodeId: nodeKey(who), policy, limits: WIKI_LIMITS }; }
  head(who, body) {
    wikiExact(body, ["shardKey"]); this.authorize(who); if (!wikiDigest(body.shardKey)) fail(400, "invalid_wiki_shard");
    const row = this.db.prepare("SELECT publication FROM wiki_heads WHERE tenant=? AND shard=?").get(tenantKey(who), body.shardKey);
    return { shardKey: body.shardKey, publication: row?.publication ? JSON.parse(row.publication) : null };
  }
  publicLease(row) { return { id: row.id, shardKey: row.shard, nodeId: row.node, fence: row.fence, expectedGeneration: row.base_generation, expiresAt: row.expires_at,
    state: row.publication ? "committed" : row.expires_at <= this.now() ? "expired" : "active", publication: row.publication ? JSON.parse(row.publication) : null }; }
  acquire(who, body) {
    wikiExact(body, ["shardKey", "requestId", "expectedGeneration"]); const policy = this.authorize(who);
    if (!wikiDigest(body.shardKey) || !wikiUuid(body.requestId) || !generation(body.expectedGeneration)) fail(400, "invalid_wiki_claim");
    const tenant = tenantKey(who), node = nodeKey(who);
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM wiki_leases WHERE tenant=? AND request_id=?").get(tenant, body.requestId);
      if (prior) {
        if (prior.node !== node || prior.shard !== body.shardKey || prior.base_generation !== body.expectedGeneration) fail(409, "wiki_claim_conflict");
        if (prior.policy !== policy.policyDigest) fail(409, "wiki_drive_policy_changed");
        // Lost responses reuse the exact lease; they never extend or reacquire it.
        return this.publicLease(prior);
      }
      const head = this.db.prepare("SELECT * FROM wiki_heads WHERE tenant=? AND shard=?").get(tenant, body.shardKey);
      if ((head?.generation || 0) !== body.expectedGeneration) fail(409, "wiki_generation_changed");
      const active = head?.lease_id && this.db.prepare("SELECT * FROM wiki_leases WHERE id=?").get(head.lease_id);
      if (active && !active.publication && active.expires_at > this.now()) fail(409, "wiki_shard_busy");
      if ((!head && this.db.prepare("SELECT COUNT(*) AS n FROM wiki_heads WHERE tenant=?").get(tenant).n >= WIKI_LIMITS.maxShards) || this.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n >= WIKI_LIMITS.maxLeases) fail(503, "wiki_coordinator_capacity");
      const fence = (head?.fence || 0) + 1; if (!generation(fence)) fail(503, "wiki_fence_exhausted");
      const row = { tenant, request_id: body.requestId, id: randomUUID(), shard: body.shardKey, node, fence, base_generation: body.expectedGeneration, expires_at: Math.min(who.expiresAt, this.now() + WIKI_LIMITS.leaseMs), policy: policy.policyDigest, publication: null };
      this.db.prepare("INSERT INTO wiki_leases VALUES (?,?,?,?,?,?,?,?,?,NULL)").run(tenant, row.request_id, row.id, row.shard, node, fence, row.base_generation, row.expires_at, row.policy);
      this.db.prepare("INSERT INTO wiki_heads VALUES (?,?,?,?,?,NULL) ON CONFLICT(tenant,shard) DO UPDATE SET fence=excluded.fence,lease_id=excluded.lease_id").run(tenant, row.shard, row.base_generation, fence, row.id);
      return this.publicLease(row);
    });
  }
  lease(who, body, policy) {
    if (!wikiDigest(body.shardKey) || !wikiUuid(body.leaseId) || !generation(body.fence) || body.fence < 1) fail(400, "invalid_wiki_lease");
    const row = this.db.prepare("SELECT * FROM wiki_leases WHERE tenant=? AND id=? AND shard=? AND node=?").get(tenantKey(who), body.leaseId, body.shardKey, nodeKey(who));
    if (!row || row.fence !== body.fence) fail(409, "wiki_lease_mismatch");
    if (row.policy !== policy.policyDigest) fail(409, "wiki_drive_policy_changed");
    return row;
  }
  current(row) {
    const head = this.db.prepare("SELECT * FROM wiki_heads WHERE tenant=? AND shard=?").get(row.tenant, row.shard);
    if (row.publication || row.expires_at <= this.now() || head?.fence !== row.fence || head.lease_id !== row.id || head.generation !== row.base_generation) fail(409, "wiki_lease_expired_or_superseded");
  }
  renew(who, body) {
    wikiExact(body, ["shardKey", "leaseId", "fence"]); const policy = this.authorize(who);
    return this.transaction(() => {
      const row = this.lease(who, body, policy); this.current(row);
      row.expires_at = Math.min(who.expiresAt, this.now() + WIKI_LIMITS.leaseMs);
      this.db.prepare("UPDATE wiki_leases SET expires_at=? WHERE id=?").run(row.expires_at, row.id); return this.publicLease(row);
    });
  }
  publish(who, body) {
    wikiExact(body, ["shardKey", "leaseId", "fence", "expectedGeneration", "manifest"]); const policy = this.authorize(who);
    if (!generation(body.expectedGeneration) || body.manifest === undefined) fail(400, "invalid_wiki_publication");
    const manifest = body.manifest === null ? null : wikiManifest(body.manifest);
    return this.transaction(() => {
      const row = this.lease(who, body, policy);
      const declared = this.db.prepare("SELECT source_hash,sources FROM wiki_source_declarations WHERE lease_id=?").get(row.id);
      if (declared && manifest && (declared.source_hash !== manifest.sourceSetHash || JSON.parse(declared.sources).length !== manifest.sourceCount)) fail(409, "wiki_source_declaration_mismatch");
      if (row.base_generation !== body.expectedGeneration) fail(409, "wiki_generation_changed");
      const publication = { generation: row.base_generation + 1, fence: row.fence, nodeId: row.node, manifest, manifestHash: wikiHash(manifest), state: manifest ? "published" : "tombstone", clientReported: true };
      if (row.publication) {
        if (row.publication !== JSON.stringify(publication)) fail(409, "wiki_immutable_publication");
        return publication; // Idempotent readback never moves the current head backwards.
      }
      this.current(row);
      if (manifest) this.budget.assertReported(who, { id: manifest.reservationId, providerId: manifest.providerId, driveTenantKey: manifest.driveTenantKey,
        folderToken: manifest.folderToken, sha256: manifest.ciphertextSha256, bytes: manifest.bytes, fileToken: manifest.fileToken });
      const json = JSON.stringify(publication);
      this.db.prepare("UPDATE wiki_leases SET publication=? WHERE id=?").run(json, row.id);
      this.db.prepare("UPDATE wiki_heads SET generation=?,publication=? WHERE tenant=? AND shard=?").run(publication.generation, json, row.tenant, row.shard);
      return publication;
    });
  }
  declarationTarget(who, input) {
    wikiExact(input, ["shardKey", "leaseId", "fence", "sources"]);
    const policy = this.authorize(who), row = this.lease(who, input, policy); this.current(row);
    const declaration = sourceDeclaration(input.sources);
    if (declaration.sources.some(source => source.providerId !== policy.providerId || source.tenantId !== policy.driveTenantKey)) fail(403, "wiki_source_destination_mismatch");
    return { row, declaration };
  }
  registerSources(who, input) {
    return this.transaction(() => {
      const { row, declaration } = this.declarationTarget(who, input), json = JSON.stringify(declaration.sources);
      const old = this.db.prepare("SELECT * FROM wiki_source_declarations WHERE lease_id=?").get(row.id);
      if (old && (old.source_hash !== declaration.sourceSetHash || old.sources !== json)) fail(409, "wiki_source_declaration_immutable");
      if (!old) this.db.prepare("INSERT INTO wiki_source_declarations VALUES (?,?,?,?)").run(row.id, declaration.sourceSetHash, json, this.now());
      return { shardKey: row.shard, leaseId: row.id, fence: row.fence, generation: row.base_generation + 1,
        sourceSetHash: declaration.sourceSetHash, sourceCount: declaration.sourceCount, provenance: "publisher-declared", contentVerified: false };
    });
  }
  leaseSources(who, input) {
    wikiExact(input, ["shardKey", "leaseId", "fence"]);
    const policy = this.authorize(who), row = this.lease(who, input, policy); this.current(row);
    const saved = this.db.prepare("SELECT source_hash,sources FROM wiki_source_declarations WHERE lease_id=?").get(row.id);
    if (!saved) fail(409, "wiki_source_declaration_missing");
    const declaration = sourceDeclaration(JSON.parse(saved.sources));
    if (saved.source_hash !== declaration.sourceSetHash || declaration.sources.some(source => source.providerId !== policy.providerId || source.tenantId !== policy.driveTenantKey)) fail(409, "wiki_source_declaration_mismatch");
    return { lease: this.publicLease(row), ...declaration };
  }
  publishedSources(who, shardKey) {
    const policy = this.authorize(who);
    const head = this.head(who, { shardKey }).publication;
    if (!head || head.state !== "published") fail(409, "wiki_current_publication_required");
    if (head.manifest.providerId !== policy.providerId || head.manifest.driveTenantKey !== policy.driveTenantKey || head.manifest.folderToken !== policy.folderToken) fail(409, "wiki_source_destination_mismatch");
    const lease = this.db.prepare("SELECT id FROM wiki_leases WHERE tenant=? AND shard=? AND fence=? AND node=? AND publication=?").get(tenantKey(who), shardKey, head.fence, head.nodeId, JSON.stringify(head));
    const row = lease && this.db.prepare("SELECT source_hash,sources FROM wiki_source_declarations WHERE lease_id=?").get(lease.id);
    if (!row) fail(409, "wiki_source_declaration_missing");
    const declaration = sourceDeclaration(JSON.parse(row.sources));
    if (row.source_hash !== declaration.sourceSetHash || declaration.sourceSetHash !== head.manifest.sourceSetHash || declaration.sourceCount !== head.manifest.sourceCount) fail(409, "wiki_source_declaration_mismatch");
    return { publication: head, ...declaration };
  }
  close() { this.db.close(); }
}

export class WikiCoordinatorService {
  constructor({ sessions, coordinator, allowDevelopment = false }) { Object.assign(this, { sessions, coordinator, allowDevelopment }); }
  async handle(req, res) {
    const action = /^\/v1\/wiki\/(status|head|acquire|renew|publish)$/.exec(req.url)?.[1];
    if (!action && req.url !== "/auth/wiki-token") return false;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.origin) fail(403, "browser_origin_not_allowed"); if (req.method !== "POST") fail(405, "method_not_allowed");
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "", who = this.sessions.verify(token);
      if (!who) fail(401, "session_expired_or_invalid");
      if (who.authProvider !== "feishu" && !this.allowDevelopment) fail(403, "verified_login_required");
      this.coordinator.authorize(who);
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json" || req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") fail(415, "json_required");
      let length = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > 4096) fail(413, "wiki_metadata_too_large"); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { fail(400, "invalid_json"); }
      if (!this.sessions.verify(token)) fail(401, "session_expired_or_invalid");
      if (!action) {
        wikiExact(body, []); if (who.audience !== "codex-model-gateway") fail(403, "wiki_scope_required");
        const lease = this.sessions.issueForWiki(token); send(200, { token: lease.token, audience: lease.audience, expiresAt: lease.expiresAt }); return true;
      }
      if (who.audience !== "wiki-coordinator" || !who.scopes.includes("wiki:coordinate")) fail(403, "wiki_scope_required");
      send(200, this.coordinator[action](who, body)); return true;
    } catch (error) {
      const invalid = ["invalid_wiki_metadata", "invalid_wiki_manifest"].includes(error.message);
      const known = error instanceof WikiError || error instanceof DriveBudgetError;
      send(known ? error.status : invalid ? 400 : 503, { error: { code: known || invalid ? error.message : "wiki_coordinator_unavailable" } }); req.resume(); return true;
    }
  }
}
