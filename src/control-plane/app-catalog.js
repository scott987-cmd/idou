import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { appManifest, appHash, appId, appDigest } from "../apps/manifest.js";
import { readCatalogConfigFile } from "./skill-catalog.js";
import { archiveInput, archiveRecord, archiveInputKey } from "../apps/archive.js";
import { reviewInput, reviewRecord, reviewCursor } from "../apps/review.js";
import { runtimePolicy, runtimeBinding } from "../apps/runtime-grant.js";

class CatalogError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, code) => { throw new CatalogError(status, code); };
function exact(value, keys) { if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some((key) => !keys.includes(key))) fail(400, "invalid_app_catalog_request"); }
const identityKey = (who) => appHash(JSON.stringify([who.authProvider, who.tenantId, who.appId]));
const ownerKey = (who) => appHash(JSON.stringify([who.authProvider, who.tenantId, who.appId, who.userId]));
export class AppCatalog {
  // `feishu` is the deployment a Feishu tenant row's app id must belong to.
  constructor({ databaseFile, tenants, feishu }) {
    if (!feishu?.ids) throw new Error("App catalog requires the Feishu deployment it serves");
    if (!Array.isArray(tenants) || !tenants.length || tenants.length > 100) throw new Error("App catalog requires explicit tenant grants");
    const seen = new Set();
    this.tenants = tenants.map((row) => {
      exact(row, ["authProvider", "tenantId", "appId", "publishers", "reviewers", "runtime"]);
      if (!["development", "feishu"].includes(row.authProvider) || !/^[A-Za-z0-9_-]{1,256}$/.test(row.tenantId) || (row.authProvider === "development" ? row.appId !== null : !feishu.ids.app(row.appId)) || !Array.isArray(row.publishers) || !row.publishers.length || row.publishers.length > 1000 || row.publishers.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) || seen.has(identityKey(row))) throw new Error("Invalid app catalog grant");
      const reviewers = row.reviewers === undefined ? [] : row.reviewers;
      if (!Array.isArray(reviewers) || reviewers.length > 1000 || reviewers.some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) || new Set(reviewers).size !== reviewers.length) throw new Error("Invalid app reviewer grant");
      seen.add(identityKey(row)); return { ...row, publishers: [...row.publishers], reviewers: [...reviewers], runtime: runtimePolicy(row.runtime) };
    });
    this.db = new DatabaseSync(databaseFile, { timeout: 1000 });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
      const version = this.db.prepare("PRAGMA user_version").get().user_version; if (![0, 1, 2, 3].includes(version)) throw new Error("Unsupported application catalog schema");
      this.db.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS application_candidates (
        tenant TEXT NOT NULL, app_id TEXT NOT NULL, owner TEXT NOT NULL, digest TEXT NOT NULL,
        title TEXT NOT NULL, manifest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('submitted','withdrawn')),
        created_at INTEGER NOT NULL, PRIMARY KEY(tenant,app_id,digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS application_archives (
        tenant TEXT NOT NULL, app_id TEXT NOT NULL, digest TEXT NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY(tenant,app_id,digest)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS application_reviews (
        tenant TEXT NOT NULL, app_id TEXT NOT NULL, digest TEXT NOT NULL, reviewer TEXT NOT NULL, record TEXT NOT NULL,
        PRIMARY KEY(tenant,app_id,digest)
      ) STRICT; PRAGMA user_version=3; COMMIT;`);
      if (this.db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Invalid application catalog database");
    } catch (error) { this.db.close(); throw error; }
  }
  static async fromConfig(filename, feishu) {
    if (!filename) return null;
    const config = JSON.parse(await readCatalogConfigFile(filename, 1048576)); exact(config, ["schemaVersion", "databaseFile", "tenants"]);
    if (config.schemaVersion !== 1 || typeof config.databaseFile !== "string" || !path.isAbsolute(config.databaseFile)) throw new Error("Invalid application catalog configuration");
    const directory = path.dirname(config.databaseFile); await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || await realpath(directory) !== directory || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw new Error("App catalog requires a private directory");
    try { const file = await open(config.databaseFile, "wx", 0o600); await file.close(); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(config.databaseFile);
    if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error("App catalog requires a private database");
    return new AppCatalog({ ...config, feishu });
  }
  authorize(who, role = "publishers") { if (!this.tenants.some((row) => identityKey(row) === identityKey(who) && row[role]?.includes(who.userId))) fail(403, "app_catalog_not_authorized"); }
  reviewRecord(row) {
    const saved = this.db.prepare("SELECT record FROM application_reviews WHERE tenant=? AND app_id=? AND digest=?").get(row.tenant, row.app_id, row.digest);
    return saved ? reviewRecord(JSON.parse(saved.record)) : null;
  }
  runtimePolicy(who) {
    const policy = this.tenants.find(row => identityKey(row) === identityKey(who))?.runtime;
    if (!policy?.operators.includes(who.userId)) fail(403, "app_runtime_not_authorized");
    return policy;
  }
  runtimeCandidate(who, body) {
    exact(body, ["appId", "digest"]);
    if (!appId(body.appId) || !appDigest(body.digest)) fail(400, "invalid_runtime_candidate");
    const policy = this.runtimePolicy(who);
    const row = this.db.prepare("SELECT * FROM application_candidates WHERE tenant=? AND app_id=? AND digest=?").get(identityKey(who), body.appId, body.digest);
    if (!row || row.state !== "submitted") fail(404, "runtime_candidate_unavailable");
    const candidate = this.public(row);
    if (candidate.review?.decision !== "approved" || candidate.archive?.state !== "listed") fail(409, "runtime_candidate_not_ready");
    return { binding: runtimeBinding({ appId: row.app_id, digest: row.digest, archiveId: candidate.archive.id, reviewId: candidate.review.id, sha256: candidate.archive.input.sha256, bytes: candidate.archive.input.bytes, nodeId: policy.nodeId, imageId: policy.imageId }), manifest: appManifest(JSON.parse(row.manifest)).manifest };
  }
  runtimeList(who, body) {
    this.runtimePolicy(who); exact(body, ["cursor"]);
    let cursor; try { cursor = reviewCursor(body.cursor ?? null); } catch { fail(400, "invalid_runtime_cursor"); }
    const [afterApp, afterDigest] = cursor?.split(":") ?? ["", ""];
    const rows = this.db.prepare(`SELECT c.* FROM application_candidates c
      JOIN application_reviews r USING(tenant,app_id,digest) JOIN application_archives a USING(tenant,app_id,digest)
      WHERE c.tenant=? AND c.state='submitted' AND json_extract(r.record,'$.decision')='approved' AND json_extract(a.record,'$.state')='listed'
      AND (c.app_id,c.digest)>(?,?) ORDER BY c.app_id,c.digest LIMIT 11`).all(identityKey(who), afterApp, afterDigest);
    const page = rows.slice(0, 10);
    return { candidates: page.map(row => ({ appId: row.app_id, digest: row.digest, title: row.title, createdAt: row.created_at })), nextCursor: rows.length > 10 ? `${page.at(-1).app_id}:${page.at(-1).digest}` : null };
  }
  runtimeDetail(who, body) {
    const candidate = this.runtimeCandidate(who, body);
    const row = this.db.prepare("SELECT title,created_at FROM application_candidates WHERE tenant=? AND app_id=? AND digest=?").get(identityKey(who), body.appId, body.digest);
    return { ...candidate, title: row.title, createdAt: row.created_at };
  }
  transaction(fn) { this.db.exec("BEGIN IMMEDIATE"); try { const value = fn(); this.db.exec("COMMIT"); return value; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  public(row) {
    const { manifest, totalBytes } = appManifest(JSON.parse(row.manifest));
    const saved = this.db.prepare("SELECT record FROM application_archives WHERE tenant=? AND app_id=? AND digest=?").get(row.tenant, row.app_id, row.digest);
    return { appId: row.app_id, digest: row.digest, title: row.title, entry: manifest.entry, totalBytes, fileCount: manifest.files.length, createdAt: row.created_at, state: row.state, deployed: false, archive: saved ? archiveRecord(JSON.parse(saved.record)) : null, review: this.reviewRecord(row) };
  }
  reviewCandidate(who, body) {
    this.authorize(who, "reviewers"); exact(body, ["appId", "digest"]);
    if (!appId(body.appId) || !appDigest(body.digest)) fail(400, "invalid_app_candidate");
    const row = this.db.prepare("SELECT * FROM application_candidates WHERE tenant=? AND app_id=? AND digest=?").get(identityKey(who), body.appId, body.digest);
    if (!row || row.owner === ownerKey(who)) fail(404, "review_candidate_not_found");
    return { appId: row.app_id, digest: row.digest, title: row.title, manifest: appManifest(JSON.parse(row.manifest)).manifest, state: row.state, deployed: false, createdAt: row.created_at, review: this.reviewRecord(row) };
  }
  reviewList(who, body) {
    this.authorize(who, "reviewers"); exact(body, ["cursor"]);
    let cursor; try { cursor = reviewCursor(body.cursor ?? null); } catch { fail(400, "invalid_review_cursor"); }
    const [afterApp, afterDigest] = cursor?.split(":") ?? ["", ""];
    const rows = this.db.prepare(`SELECT c.* FROM application_candidates c WHERE c.tenant=? AND c.owner<>? AND c.state='submitted'
      AND (c.app_id,c.digest)>(?,?) AND NOT EXISTS (SELECT 1 FROM application_reviews r WHERE r.tenant=c.tenant AND r.app_id=c.app_id AND r.digest=c.digest)
      ORDER BY c.app_id,c.digest LIMIT 11`).all(identityKey(who), ownerKey(who), afterApp, afterDigest);
    const page = rows.slice(0, 10);
    return { candidates: page.map(row => ({ appId: row.app_id, digest: row.digest, title: row.title, createdAt: row.created_at })), nextCursor: rows.length > 10 ? `${page.at(-1).app_id}:${page.at(-1).digest}` : null };
  }
  review(who, body) {
    this.authorize(who, "reviewers"); let input; try { input = reviewInput(body); } catch { fail(400, "invalid_app_review"); }
    return this.transaction(() => {
      const candidate = this.reviewCandidate(who, { appId: input.appId, digest: input.digest });
      if (candidate.state !== "submitted") fail(409, "review_candidate_withdrawn");
      const existing = this.db.prepare("SELECT * FROM application_reviews WHERE tenant=? AND app_id=? AND digest=?").get(identityKey(who), input.appId, input.digest);
      if (existing) {
        const saved = reviewRecord(JSON.parse(existing.record));
        if (existing.reviewer !== ownerKey(who) || saved.decision !== input.decision || saved.note !== input.note) fail(409, "application_already_reviewed");
        return { ...candidate, review: saved };
      }
      const record = { id: randomUUID(), decision: input.decision, note: input.note, reviewedAt: Date.now() };
      this.db.prepare("INSERT INTO application_reviews VALUES (?,?,?,?,?)").run(identityKey(who), input.appId, input.digest, ownerKey(who), JSON.stringify(record));
      return { ...candidate, review: record };
    });
  }
  archive(who, action, body) {
    this.authorize(who); exact(body, ["appId", "digest", ...(action === "prepare" ? ["input"] : action === "dispatch" ? ["id"] : ["id", "fileToken"])]);
    if (!appId(body.appId) || !appDigest(body.digest)) fail(400, "invalid_app_candidate");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM application_candidates WHERE tenant=? AND app_id=? AND digest=? AND owner=?").get(identityKey(who), body.appId, body.digest, ownerKey(who));
      if (!row) fail(404, "application_candidate_not_found");
      let record = this.public(row).archive;
      if (action === "prepare") {
        if (row.state !== "submitted") fail(409, "application_candidate_withdrawn");
        let input; try { input = archiveInput(body.input); } catch { fail(400, "invalid_archive_input"); }
        if (record) {
          // Verification timestamps change between confirmations, ownership and
          // target do not. Never allocate a second upload id for this revision.
          if (record.state !== "prepared" || archiveInputKey(record.input) !== archiveInputKey(input)) fail(409, "application_archive_already_started");
        } else record = { id: randomUUID(), state: "prepared", input, fileToken: null };
      } else {
        if (!record || body.id !== record.id) fail(409, "application_archive_mismatch");
        if (action === "dispatch") {
          if (row.state !== "submitted" || record.state !== "prepared") fail(409, "application_archive_already_started_or_withdrawn");
          record.state = "uploading";
        } else {
          if (!["receipt", "verify"].includes(action) || typeof body.fileToken !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.fileToken) || (record.fileToken && record.fileToken !== body.fileToken) || record.state === "prepared" || (action === "verify" && !record.fileToken)) fail(409, "application_archive_receipt_mismatch");
          // Finishing metadata after a concurrent withdrawal does not restore
          // the candidate. This is client-reported evidence, not server proof.
          record.fileToken = body.fileToken;
          if (record.state !== "listed") record.state = action === "verify" ? "listed" : "recorded";
        }
      }
      archiveRecord(record);
      this.db.prepare("INSERT INTO application_archives VALUES (?,?,?,?) ON CONFLICT(tenant,app_id,digest) DO UPDATE SET record=excluded.record").run(row.tenant, row.app_id, row.digest, JSON.stringify(record));
      return { archive: record, ...(action === "dispatch" ? { granted: true } : {}) };
    });
  }
  submit(who, body) {
    this.authorize(who); exact(body, ["appId", "title", "manifest"]);
    if (!appId(body.appId) || typeof body.title !== "string" || !body.title.trim() || body.title.length > 80 || /[\x00-\x1f\x7f]/.test(body.title)) fail(400, "invalid_app_candidate");
    let checked; try { checked = appManifest(body.manifest); } catch { fail(400, "invalid_app_manifest"); }
    const tenant = identityKey(who), owner = ownerKey(who);
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM application_candidates WHERE tenant=? AND app_id=?").all(tenant, body.appId);
      if (prior.some((row) => row.owner !== owner)) fail(409, "application_owned_by_another_user");
      const same = prior.find((row) => row.digest === checked.digest);
      if (same) return this.public(same); // Lost-response recovery never creates another revision or un-withdraws it.
      if (prior.length >= 30 || this.db.prepare("SELECT COUNT(*) AS count FROM application_candidates").get().count >= 10000) fail(409, "application_catalog_limit");
      const row = { tenant, app_id: body.appId, owner, digest: checked.digest, title: body.title.trim(), manifest: JSON.stringify(checked.manifest), state: "submitted", created_at: Date.now() };
      this.db.prepare("INSERT INTO application_candidates VALUES (?,?,?,?,?,?,?,?)").run(row.tenant, row.app_id, row.owner, row.digest, row.title, row.manifest, row.state, row.created_at);
      return this.public(row);
    });
  }
  list(who, body) {
    this.authorize(who); exact(body, ["appId"]); if (!appId(body.appId)) fail(400, "invalid_app_id");
    return { releases: this.db.prepare("SELECT * FROM application_candidates WHERE tenant=? AND app_id=? AND owner=? ORDER BY created_at DESC,digest ASC").all(identityKey(who), body.appId, ownerKey(who)).map((row) => this.public(row)) };
  }
  withdraw(who, body) {
    this.authorize(who); exact(body, ["appId", "digest"]); if (!appId(body.appId) || !appDigest(body.digest)) fail(400, "invalid_app_candidate");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM application_candidates WHERE tenant=? AND app_id=? AND digest=? AND owner=?").get(identityKey(who), body.appId, body.digest, ownerKey(who));
      if (!row) fail(404, "application_candidate_not_found");
      this.db.prepare("UPDATE application_candidates SET state='withdrawn' WHERE tenant=? AND app_id=? AND digest=?").run(row.tenant, row.app_id, row.digest);
      return this.public({ ...row, state: "withdrawn" });
    });
  }
  close() { this.db.close(); }
}
export class AppCatalogService {
  constructor({ sessions, catalog, allowDevelopment = false }) { Object.assign(this, { sessions, catalog, allowDevelopment }); }
  async handle(req, res) {
    const archiveAction = /^\/v1\/apps\/archive-(prepare|dispatch|receipt|verify)$/.exec(req.url)?.[1];
    const reviewRoute = ["/auth/app-review-token", "/v1/apps/review-list", "/v1/apps/review-get", "/v1/apps/review"].includes(req.url);
    if (!archiveAction && !reviewRoute && !["/auth/apps-token", "/v1/apps/submit", "/v1/apps/list", "/v1/apps/withdraw"].includes(req.url)) return false;
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.origin) fail(403, "browser_origin_not_allowed"); if (req.method !== "POST") fail(405, "method_not_allowed");
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "", who = this.sessions.verify(token);
      if (!who) fail(401, "session_expired_or_invalid");
      if (who.authProvider !== "feishu" && !this.allowDevelopment) fail(403, "verified_login_required");
      this.catalog.authorize(who, reviewRoute ? "reviewers" : "publishers");
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json" || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) fail(415, "json_required");
      let length = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > 65536) fail(413, "app_manifest_too_large"); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { fail(400, "invalid_json"); }
      if (!this.sessions.verify(token)) fail(401, "session_expired_or_invalid");
      if (["/auth/apps-token", "/auth/app-review-token"].includes(req.url)) {
        exact(body, []); if (who.audience !== "codex-model-gateway") fail(403, "app_catalog_scope_required");
        this.catalog.authorize(who, reviewRoute ? "reviewers" : "publishers");
        const lease = reviewRoute ? this.sessions.issueForAppReview(token) : this.sessions.issueForApps(token); send(200, { token: lease.token, expiresAt: lease.expiresAt, audience: lease.audience }); return true;
      }
      if (reviewRoute) {
        if (who.audience !== "app-review" || !who.scopes.includes("apps:review")) fail(403, "app_review_scope_required");
        send(200, req.url === "/v1/apps/review-list" ? this.catalog.reviewList(who, body) : req.url === "/v1/apps/review-get" ? this.catalog.reviewCandidate(who, body) : this.catalog.review(who, body)); return true;
      }
      if (who.audience !== "app-catalog" || !who.scopes.includes("apps:candidates")) fail(403, "app_catalog_scope_required");
      const result = archiveAction ? this.catalog.archive(who, archiveAction, body) : req.url === "/v1/apps/submit" ? this.catalog.submit(who, body) : req.url === "/v1/apps/list" ? this.catalog.list(who, body) : this.catalog.withdraw(who, body);
      send(200, result); return true;
    } catch (error) { send(error instanceof CatalogError ? error.status : 503, { error: { code: error instanceof CatalogError ? error.message : "app_catalog_unavailable" } }); req.resume(); return true; }
  }
}
