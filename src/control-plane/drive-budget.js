import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { namedDatabase } from "./database-names.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
const uuid = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export class DriveBudgetError extends Error { constructor(status, code) { super(code); this.status = status; } }
const deny = (status, code) => { throw new DriveBudgetError(status, code); };
function exact(value, keys) { if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !keys.includes(key))) deny(400, "invalid_drive_budget_request"); }
// A Feishu tenant is registered for one deployment: its app id has that
// deployment's shape and its Drive is that deployment's. A row naming another
// deployment is a configuration this server cannot honour, so it does not start.
export function drivePolicies(values, feishu) {
  if (!feishu?.ids) throw new Error("Drive tenant policies require the Feishu deployment they belong to");
  if (!Array.isArray(values) || !values.length || values.length > 1000) throw new Error("Explicit Drive tenant policies required");
  const seen = new Set();
  return values.map((value) => {
    exact(value, ["authProvider", "tenantId", "appId", "providerId", "driveTenantKey", "folderToken", "maxBytes"]);
    if (!["development", "feishu"].includes(value.authProvider) || !opaque(value.tenantId) || (value.authProvider === "feishu" ? !feishu.ids.app(value.appId) || value.providerId !== feishu.id : value.appId !== null) || !opaque(value.providerId) || !opaque(value.driveTenantKey) || !opaque(value.folderToken) || !Number.isSafeInteger(value.maxBytes) || value.maxBytes < 1 || value.maxBytes > 1099511627776) throw new Error("Invalid Drive tenant policy");
    const key = hash([value.authProvider, value.tenantId]);
    if (seen.has(key)) throw new Error("Duplicate Drive tenant policy"); seen.add(key);
    const config = Object.fromEntries(["authProvider", "tenantId", "appId", "providerId", "driveTenantKey", "folderToken", "maxBytes"].map((field) => [field, value[field]]));
    return Object.freeze({ ...config, key, policyDigest: hash(config) });
  });
}

// What a request must say before anything is read, and what a found row
// allows: the same for this file's ledger and the shared database's below, so
// the two cannot come to disagree about a budget.
//
// `own`: the bytes go to their owner's own Drive space instead of the policy's
// folder -- a scheduled task's report, since 2026-09-28
// (schedule-report-archive.js). The server chooses that destination itself and
// passes this in its own process; no route takes it, so a desktop still
// uploads only to the folder its administrator named. Charged to the tenant's
// budget as before, and the row binds where the bytes actually went.
const ownTarget = (policy, body, own) => own ? opaque(body.folderToken) : body.folderToken === policy.folderToken;
function reserveRequest(ledger, identity, body, { own = false } = {}) {
  exact(body, ["id", "policyDigest", "providerId", "driveTenantKey", "folderToken", "bytes", "sha256"]);
  const policy = ledger.policy(identity);
  if (!uuid(body.id) || !digest(body.sha256) || !Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > 104857600) deny(400, "invalid_drive_budget_request");
  if (body.policyDigest !== policy.policyDigest || ["providerId", "driveTenantKey"].some((key) => body[key] !== policy[key]) || !ownTarget(policy, body, own)) deny(409, "drive_policy_changed_or_target_mismatch");
  return { policy, owner: ledger.owner(identity), inputHash: hash([body.providerId, body.driveTenantKey, body.folderToken, body.bytes, body.sha256]) };
}
function reservedAgain(prior, owner, inputHash) {
  if (prior.owner !== owner || prior.input_hash !== inputHash) deny(409, "drive_reservation_conflict");
}
function reservationRequest(ledger, identity, body, { own = false } = {}) {
  exact(body, ["id", "policyDigest", "providerId", "driveTenantKey", "folderToken", "bytes", "sha256"]);
  const policy = ledger.policy(identity), owner = ledger.owner(identity);
  if (!uuid(body.id) || !digest(body.sha256) || !Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > 104857600 ||
      body.policyDigest !== policy.policyDigest || ["providerId", "driveTenantKey"].some(key => body[key] !== policy[key]) || !ownTarget(policy, body, own)) {
    deny(409, "drive_policy_changed_or_target_mismatch");
  }
  return { policy, owner, inputHash: hash([body.providerId, body.driveTenantKey, body.folderToken, body.bytes, body.sha256]) };
}
function reservationFound(row, { owner, inputHash, policy }, id) {
  if (!row || row.owner !== owner || row.input_hash !== inputHash || row.policy_hash !== policy.policyDigest) deny(404, "drive_reservation_not_found");
  return { id, state: row.state, fileToken: row.file_token ?? null };
}
function changeRequest(ledger, identity, body, dispatch) {
  exact(body, dispatch ? ["id", "policyDigest"] : ["id", "fileToken"]);
  if (!uuid(body.id) || (!dispatch && !opaque(body.fileToken))) deny(400, "invalid_drive_budget_request");
  const policy = ledger.policy(identity);
  if (dispatch && policy.policyDigest !== body.policyDigest) deny(409, "drive_policy_changed_or_target_mismatch");
  return { policy, owner: ledger.owner(identity) };
}
// Which state a found row moves to, or the refusal.
function changeFound(row, { policy, owner }, body, dispatch) {
  if (!row || row.owner !== owner) deny(404, "drive_reservation_not_found");
  if (dispatch) {
    if (row.policy_hash !== policy.policyDigest) deny(409, "drive_policy_changed_or_target_mismatch");
    if (row.state !== "reserved") deny(409, "drive_dispatch_already_claimed_review_required");
    return "dispatched";
  }
  if (row.state === "reserved" || (row.file_token && row.file_token !== body.fileToken)) deny(409, "drive_receipt_conflict");
  return "reported";
}
function reportedRequest(ledger, identity, body) {
  exact(body, ["id", "providerId", "driveTenantKey", "folderToken", "sha256", "bytes", "fileToken"]);
  const policy = ledger.policy(identity);
  if (!uuid(body.id) || !digest(body.sha256) || !opaque(body.fileToken) || !Number.isSafeInteger(body.bytes) || body.bytes < 1 || body.bytes > 104857600 ||
    ["providerId", "driveTenantKey", "folderToken"].some(key => body[key] !== policy[key])) deny(409, "drive_publication_target_mismatch");
  return { policy, owner: ledger.owner(identity) };
}
function reportedFound(row, owner, body) {
  if (!row || row.owner !== owner || row.state !== "reported" || row.file_token !== body.fileToken || row.input_hash !== hash([body.providerId, body.driveTenantKey, body.folderToken, body.bytes, body.sha256])) deny(409, "drive_reported_reservation_required");
  // This proves accounting ownership only, not remote bytes, encryption or ACL.
  return true;
}
const usageOf = (policy, charged) => ({ maxBytes: policy.maxBytes, chargedBytes: charged, remainingBytes: Math.max(0, policy.maxBytes - charged) });
const snapshotOf = (policy, charged) => ({ policyDigest: policy.policyDigest, providerId: policy.providerId, driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken, ...usageOf(policy, charged) });
// The whole ledger holds no more than this many reservations.
const LEDGER_CAPACITY = 100000;
// The columns a reservation is moved with (bin/migrate-data.js), either way.
const COLUMNS = ["tenant", "id", "owner", "input_hash", "policy_hash", "bytes", "state", "file_token", "created_at"];

// The operator's file: which tenants may save to which folder, and how much.
async function readDriveConfig(filename, feishu) {
  if (!path.isAbsolute(filename)) throw new Error("Drive policy file must be absolute");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let config;
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > 1048576) throw new Error("Invalid Drive policy file");
    config = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  exact(config, ["schemaVersion", "databaseFile", "tenants"]);
  if (config.schemaVersion !== 1 || typeof config.databaseFile !== "string" || !path.isAbsolute(config.databaseFile)) throw new Error("Invalid Drive budget configuration");
  drivePolicies(config.tenants, feishu);
  return config;
}

class DriveLedgerRules {
  constructor({ policies, feishu }) { this.feishu = feishu; this.policies = drivePolicies(policies, feishu); }
  policy(identity) {
    const policy = this.policies.find((item) => item.authProvider === identity.authProvider && item.tenantId === identity.tenantId && item.appId === identity.appId);
    if (!policy) deny(403, "drive_policy_not_configured"); return policy;
  }
  owner(identity) { return hash([identity.authProvider, identity.tenantId, identity.appId, identity.userId]); }
}

// Metadata only. All counted states retain their bytes; clients have no release
// endpoint. BEGIN IMMEDIATE serializes reservations across local DB connections.
export class DriveBudget extends DriveLedgerRules {
  constructor({ databaseFile, policies, feishu }) {
    super({ policies, feishu });
    this.db = new DatabaseSync(databaseFile, { timeout: 1000, allowExtension: false });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (![0, 1].includes(version)) throw new Error("Unsupported Drive ledger version");
      this.db.exec(`CREATE TABLE IF NOT EXISTS drive_reservations (
        tenant TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, input_hash TEXT NOT NULL, policy_hash TEXT NOT NULL,
        bytes INTEGER NOT NULL CHECK(bytes > 0 AND bytes <= 104857600),
        state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','reported')),
        file_token TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(tenant,id)
      ) STRICT; PRAGMA user_version=1;`);
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Invalid Drive ledger");
    } catch (error) { this.db.close(); throw error; }
  }
  static async fromConfig(filename, feishu) {
    if (!filename) return null;
    const config = await readDriveConfig(filename, feishu);
    const directory = path.dirname(config.databaseFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || await realpath(directory) !== directory || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error("Drive ledger requires a private non-symlink directory");
    let file;
    try { file = await open(config.databaseFile, "wx", 0o600); } catch (error) { if (error.code !== "EEXIST") throw error; }
    await file?.close();
    const info = await lstat(config.databaseFile);
    if (!info.isFile() || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw new Error("Drive ledger file must be private");
    return new DriveBudget({ databaseFile: config.databaseFile, policies: config.tenants, feishu });
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  #row(policy, id) { return this.db.prepare("SELECT * FROM drive_reservations WHERE tenant=? AND id=?").get(policy.key, id); }
  usage(policy) {
    const row = this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS charged, COUNT(*) AS count FROM drive_reservations WHERE tenant=?").get(policy.key);
    return usageOf(policy, row.charged);
  }
  snapshot(identity) {
    const policy = this.policy(identity);
    return snapshotOf(policy, this.usage(policy).chargedBytes);
  }
  reserve(identity, body, options) {
    const { policy, owner, inputHash } = reserveRequest(this, identity, body, options);
    return this.transaction(() => {
      const prior = this.#row(policy, body.id);
      if (prior) { reservedAgain(prior, owner, inputHash); return { id: body.id, state: prior.state, ...this.usage(policy) }; }
      const usage = this.usage(policy);
      if (body.bytes > usage.remainingBytes) deny(409, "drive_budget_exceeded");
      if (this.db.prepare("SELECT COUNT(*) AS count FROM drive_reservations").get().count >= LEDGER_CAPACITY) deny(503, "drive_ledger_capacity_reached");
      this.db.prepare("INSERT INTO drive_reservations VALUES (?,?,?,?,?,?,'reserved',NULL,?)").run(policy.key, body.id, owner, inputHash, policy.policyDigest, body.bytes, Date.now());
      return { id: body.id, state: "reserved", ...this.usage(policy) };
    });
  }
  reservation(identity, body, options) {
    const request = reservationRequest(this, identity, body, options);
    return reservationFound(this.#row(request.policy, body.id), request, body.id);
  }
  // Whether this identity's upload `id` was sent and never heard back from,
  // wherever it went: a replay stops there before anything else is asked.
  unresolved(identity, id) {
    if (!uuid(id)) return false;
    const row = this.#row(this.policy(identity), id);
    return Boolean(row && row.owner === this.owner(identity) && row.state === "dispatched");
  }
  change(identity, body, dispatch) {
    const request = changeRequest(this, identity, body, dispatch);
    return this.transaction(() => {
      const state = changeFound(this.#row(request.policy, body.id), request, body, dispatch);
      if (state === "dispatched") {
        this.db.prepare("UPDATE drive_reservations SET state='dispatched' WHERE tenant=? AND id=?").run(request.policy.key, body.id);
        return { id: body.id, state: "dispatched", granted: true };
      }
      this.db.prepare("UPDATE drive_reservations SET state='reported',file_token=? WHERE tenant=? AND id=?").run(body.fileToken, request.policy.key, body.id);
      return { id: body.id, state: "reported", ...this.usage(request.policy) };
    });
  }
  close() { this.db.close(); }
  assertReported(identity, body) {
    const { policy, owner } = reportedRequest(this, identity, body);
    return reportedFound(this.#row(policy, body.id), owner, body);
  }
  // Every reservation as stored, and reservations loaded as they are
  // (bin/migrate-data.js): loading one already here replaces it.
  rows() { return this.db.prepare(`SELECT ${COLUMNS.join(", ")} FROM drive_reservations ORDER BY tenant, id`).all().map((row) => ({ ...row })); }
  load(rows) {
    const insert = this.db.prepare(`INSERT OR REPLACE INTO drive_reservations (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(",")})`);
    this.transaction(() => { for (const row of rows) insert.run(...COLUMNS.map((name) => row[name] ?? null)); });
  }
}

// The same ledger in the shared PostgreSQL (docs/scaling-plan.md §2.5): the
// policies still come from the operator's file, the reservations from a table
// every coordinator reaches. It answers promises. A reservation takes one lock
// for the whole ledger, as BEGIN IMMEDIATE did: it checks the tenant's
// remaining budget and the ledger's size before it writes, and two at once
// must not both see room for one. Nothing here is a secret -- hashes, sizes
// and a Drive file token -- so nothing is sealed, as the file never was.
const DRIVE_SCHEMA = `CREATE TABLE IF NOT EXISTS idou_drive_reservations (
  tenant text NOT NULL, id text NOT NULL, owner text NOT NULL, input_hash text NOT NULL, policy_hash text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 104857600),
  state text NOT NULL CHECK (state IN ('reserved','dispatched','reported')),
  file_token text, created_at bigint NOT NULL, PRIMARY KEY (tenant, id))`;
const number = (value) => (value === null || value === undefined ? null : Number(value));
const plain = (row) => (row ? { ...row, bytes: number(row.bytes), created_at: number(row.created_at) } : row);

export class PostgresDriveBudget extends DriveLedgerRules {
  static async open({ pool, policies, feishu }) {
    ({ pool } = await namedDatabase({ pool }));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('idou:schema:drive-ledger'))");
      await client.query(DRIVE_SCHEMA);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
    return new PostgresDriveBudget({ pool, policies, feishu });
  }
  // The operator's file names the policies; its databaseFile is this machine's
  // ledger, which bin/migrate-data.js moves here.
  static async fromConfig(filename, feishu, { pool }) {
    if (!filename) return null;
    const config = await readDriveConfig(filename, feishu);
    return PostgresDriveBudget.open({ pool, policies: config.tenants, feishu });
  }
  constructor({ pool, policies, feishu }) { super({ policies, feishu }); this.pool = pool; }
  close() {}

  async #transaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work((sql, values) => client.query(sql, values));
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
  }
  async #usage(query, policy) {
    const { rows } = await query("SELECT COALESCE(SUM(bytes), 0)::bigint AS charged FROM idou_drive_reservations WHERE tenant = $1", [policy.key]);
    return usageOf(policy, Number(rows[0].charged));
  }
  async #row(query, policy, id, lock = false) {
    return plain((await query(`SELECT * FROM idou_drive_reservations WHERE tenant = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`, [policy.key, id])).rows[0]);
  }
  #read() { return (sql, values) => this.pool.query(sql, values); }

  async snapshot(identity) {
    const policy = this.policy(identity);
    return snapshotOf(policy, (await this.#usage(this.#read(), policy)).chargedBytes);
  }
  async reserve(identity, body, options) {
    const { policy, owner, inputHash } = reserveRequest(this, identity, body, options);
    return this.#transaction(async (query) => {
      await query("SELECT pg_advisory_xact_lock(hashtext('idou:drive-ledger'))");
      const prior = await this.#row(query, policy, body.id);
      if (prior) { reservedAgain(prior, owner, inputHash); return { id: body.id, state: prior.state, ...await this.#usage(query, policy) }; }
      const usage = await this.#usage(query, policy);
      if (body.bytes > usage.remainingBytes) deny(409, "drive_budget_exceeded");
      if (Number((await query("SELECT count(*) AS count FROM idou_drive_reservations")).rows[0].count) >= LEDGER_CAPACITY) deny(503, "drive_ledger_capacity_reached");
      await query("INSERT INTO idou_drive_reservations (tenant, id, owner, input_hash, policy_hash, bytes, state, file_token, created_at) VALUES ($1,$2,$3,$4,$5,$6,'reserved',NULL,$7)",
        [policy.key, body.id, owner, inputHash, policy.policyDigest, body.bytes, Date.now()]);
      return { id: body.id, state: "reserved", ...await this.#usage(query, policy) };
    });
  }
  async reservation(identity, body, options) {
    const request = reservationRequest(this, identity, body, options);
    return reservationFound(await this.#row(this.#read(), request.policy, body.id), request, body.id);
  }
  async unresolved(identity, id) {
    if (!uuid(id)) return false;
    const row = await this.#row(this.#read(), this.policy(identity), id);
    return Boolean(row && row.owner === this.owner(identity) && row.state === "dispatched");
  }
  async change(identity, body, dispatch) {
    const request = changeRequest(this, identity, body, dispatch);
    return this.#transaction(async (query) => {
      const state = changeFound(await this.#row(query, request.policy, body.id, true), request, body, dispatch);
      if (state === "dispatched") {
        await query("UPDATE idou_drive_reservations SET state = 'dispatched' WHERE tenant = $1 AND id = $2", [request.policy.key, body.id]);
        return { id: body.id, state: "dispatched", granted: true };
      }
      await query("UPDATE idou_drive_reservations SET state = 'reported', file_token = $1 WHERE tenant = $2 AND id = $3", [body.fileToken, request.policy.key, body.id]);
      return { id: body.id, state: "reported", ...await this.#usage(query, request.policy) };
    });
  }
  async assertReported(identity, body) {
    const { policy, owner } = reportedRequest(this, identity, body);
    return reportedFound(await this.#row(this.#read(), policy, body.id), owner, body);
  }
  async rows() {
    return (await this.pool.query(`SELECT ${COLUMNS.join(", ")} FROM idou_drive_reservations ORDER BY tenant, id`)).rows.map(plain);
  }
  async load(rows) {
    await this.#transaction(async (query) => {
      for (const row of rows) {
        await query(`INSERT INTO idou_drive_reservations (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((_, index) => `$${index + 1}`).join(",")})
          ON CONFLICT (tenant, id) DO UPDATE SET ${COLUMNS.filter((name) => name !== "tenant" && name !== "id").map((name) => `${name} = EXCLUDED.${name}`).join(", ")}`,
        COLUMNS.map((name) => row[name] ?? null));
      }
    });
  }
}

export class DriveBudgetService {
  constructor({ sessions, ledger, allowDevelopment = false }) { Object.assign(this, { sessions, ledger, allowDevelopment }); }
  async handle(req, res) {
    if (!["/auth/drive-token", "/v1/drive/policy", "/v1/drive/reserve", "/v1/drive/dispatch", "/v1/drive/report"].includes(req.url)) return false;
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.origin) deny(403, "browser_origin_not_allowed");
      if (req.method !== "POST") deny(405, "method_not_allowed");
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      const identity = this.sessions.verify(token);
      if (!identity) deny(401, "session_expired_or_invalid");
      if (identity.authProvider !== "feishu" && !this.allowDevelopment) deny(403, "verified_login_required");
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json" || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) deny(415, "json_required");
      const chunks = []; let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > 4096) deny(413, "drive_request_too_large"); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { deny(400, "invalid_json"); }
      if (!this.sessions.verify(token)) deny(401, "session_expired_or_invalid");
      if (req.url === "/auth/drive-token") {
        exact(body, []); if (identity.audience !== "codex-model-gateway") deny(403, "drive_scope_required");
        this.ledger.policy(identity);
        const child = this.sessions.issueForDrive(token);
        send(200, { token: child.token, expiresAt: child.expiresAt, audience: child.audience }); return true;
      }
      if (identity.audience !== "drive-budget" || !identity.scopes.includes("drive:reserve")) deny(403, "drive_scope_required");
      let value;
      if (req.url === "/v1/drive/policy") { exact(body, []); value = await this.ledger.snapshot(identity); }
      else if (req.url === "/v1/drive/reserve") value = await this.ledger.reserve(identity, body);
      else value = await this.ledger.change(identity, body, req.url === "/v1/drive/dispatch");
      send(200, value); return true;
    } catch (error) { send(error instanceof DriveBudgetError ? error.status : 503, { error: { code: error instanceof DriveBudgetError ? error.message : "drive_budget_unavailable" } }); req.resume(); return true; }
  }
}
