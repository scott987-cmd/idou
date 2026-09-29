import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import path from "node:path";
import { MAX_CATALOG_BYTES, normalizeSkills, publicSigningKey, signingMessage } from "../skills/catalog-format.js";
import { PostgresSkillRegistry, SkillRegistry, RegistryError } from "./skill-registry.js";
import { validateServerUrl } from "./client-session.js";

class CatalogError extends Error { constructor(status, message) { super(message); this.status = status; } }
export async function readCatalogConfigFile(filename, maxBytes, secret = false) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) throw new Error("Absolute skill configuration file required");
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes || (secret && process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid()))) throw new Error();
    const bytes = await file.readFile(); if (bytes.length > maxBytes) throw new Error(); return bytes.toString("utf8");
  } catch { throw new Error("Cannot read trusted skill configuration file"); } finally { await file?.close(); }
}
function normalizeCatalog(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.tenants) || value.tenants.length > 100 || Object.keys(value).some((key) => !["schemaVersion", "revision", "tenants"].includes(key))) throw new Error("Invalid server skill catalog");
  const tenants = new Map();
  for (const row of value.tenants) {
    if (!row || Object.keys(row).length !== 2 || typeof row.tenantId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(row.tenantId) || tenants.has(row.tenantId)) throw new Error("Invalid skill tenant");
    tenants.set(row.tenantId, normalizeSkills(row.skills));
  }
  return { revision: value.revision, tenants };
}
export class EnterpriseSkillCatalog {
  // `registry` is the writable shelf; `catalog` is the older read-only form and
  // stays supported so an existing deployment keeps working unchanged.
  constructor({ origin, sessions, privateKey, catalog, registry = null, now = Date.now }) {
    this.origin = validateServerUrl(origin); this.sessions = sessions; this.now = now;
    this.privateKey = createPrivateKey(privateKey);
    if (this.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 catalog signing key required");
    this.keyId = publicSigningKey(createPublicKey(this.privateKey).export({ format: "pem", type: "spki" })).keyId;
    this.registry = registry;
    this.catalog = registry ? null : normalizeCatalog(catalog);
    this.buckets = new Map();
  }
  // `state`: the shared database, when the durable data lives there
  // (IDOU_DATA_STORE=postgres); the registry file setting still says the
  // shelf is writable at all.
  static async fromConfig({ origin, sessions, env = process.env, state = null }) {
    const writable = env.IDOU_SKILL_REGISTRY_FILE;
    if (!writable && !env.IDOU_SKILL_CATALOG_FILE && !env.IDOU_SKILL_SIGNING_KEY_FILE) return null;
    // The signing key is required either way: an unsigned shelf is not a shelf
    // this product will serve.
    const privateKey = await readCatalogConfigFile(env.IDOU_SKILL_SIGNING_KEY_FILE, 8192, true)
      .catch(() => { throw new Error("Invalid server skill catalog/signing configuration"); });
    if (writable) {
      const administrators = String(env.IDOU_SKILL_ADMINS || "").split(",").map(value => value.trim()).filter(Boolean);
      const registry = await (state ? new PostgresSkillRegistry({ state, administrators }) : new SkillRegistry({ filename: writable, administrators })).load();
      return new EnterpriseSkillCatalog({ origin, sessions, privateKey, registry });
    }
    try {
      const catalog = await readCatalogConfigFile(env.IDOU_SKILL_CATALOG_FILE, 8 * MAX_CATALOG_BYTES);
      return new EnterpriseSkillCatalog({ origin, sessions, privateKey, catalog: JSON.parse(catalog) });
    } catch { throw new Error("Invalid server skill catalog/signing configuration"); }
  }
  shelf() { return this.registry ? this.registry.snapshot() : this.catalog; }
  // A static catalogue that does not list a tenant has no shelf for it, and
  // that is refused. A writable shelf is different: the deployment chose to run
  // one, so every tenant that can sign in has a shelf -- empty until its first
  // publish, and empty again after its last withdrawal (the registry drops the
  // key then). Refusing those made the first publish unreachable from the UI
  // and told everyone else 目录不可用 when the truth was 还没有上架.
  tenantSkills(tenantId) { return this.shelf().tenants.get(tenantId) ?? (this.registry ? [] : undefined); }
  signedCatalog(identity, nonce) {
    const shelf = this.shelf(), skills = this.tenantSkills(identity.tenantId);
    if (!skills) throw new CatalogError(403, "skill_catalog_not_available");
    const issuedAt = this.now(), expiresAt = Math.min(issuedAt + 60000, identity.expiresAt);
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: shelf.revision, serverUrl: this.origin,
      tenantId: identity.tenantId, appId: identity.appId, nonce, issuedAt, expiresAt, skills }));
    if (bytes.length > MAX_CATALOG_BYTES) throw new CatalogError(503, "skill_catalog_too_large");
    return { keyId: this.keyId, payload: bytes.toString("base64url"), signature: sign(null, signingMessage(bytes), this.privateKey).toString("base64url") };
  }
  async handle(req, res) {
    // Reading the shelf and changing it are different routes with different
    // audiences: a skill-center token may only read.
    const MANAGE = ["/v1/skills/manage", "/v1/skills/publish", "/v1/skills/unpublish"];
    if (![...MANAGE, "/auth/skills-token", "/v1/skills/catalog"].includes(req.url)) return false;
    const manage = MANAGE.includes(req.url);
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" }); res.end(JSON.stringify(value)); };
    try {
      if (req.method !== "POST") throw new CatalogError(405, "method_not_allowed");
      if (req.headers.origin) throw new CatalogError(403, "native_client_required");
      const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
      const identity = this.sessions.verify(token);
      if (!identity || identity.authProvider !== "feishu") throw new CatalogError(401, "feishu_session_required");
      const exchange = req.url === "/auth/skills-token";
      // Management rides the parent session, like the token exchange: a
      // skill-center token is read-only by construction.
      const readOnly = !exchange && !manage;
      if (identity.audience !== (readOnly ? "skill-center" : "codex-model-gateway") || !identity.scopes.includes(readOnly ? "skills:read" : "models:responses")) throw new CatalogError(403, "skill_audience_required");
      if (manage && !this.registry) throw new CatalogError(501, "skill_registry_not_configured");
      const now = this.now(); for (const [key, value] of this.buckets) if (value.until <= now) this.buckets.delete(key);
      const key = identity.parentKey || identity.id, bucket = this.buckets.get(key) || { count: 0, until: now + 60000 };
      if (++bucket.count > 60) throw new CatalogError(429, "skill_request_limit"); this.buckets.set(key, bucket);
      if (req.headers["content-type"]?.split(";")[0] !== "application/json" || (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) throw new CatalogError(415, "json_required");
      // A published bundle carries its own files, so management needs room for
      // one skill; every other route stays at a single small JSON object.
      const maxBytes = manage ? 8 * MAX_CATALOG_BYTES : 1024;
      let length = 0; const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > maxBytes) throw new CatalogError(413, "request_too_large"); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CatalogError(400, "invalid_json"); }
      if (!body || Array.isArray(body) || typeof body !== "object") throw new CatalogError(400, "invalid_skill_request");
      if (!manage && (exchange ? Object.keys(body).length !== 0 : Object.keys(body).length !== 1 || typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.nonce))) throw new CatalogError(400, "invalid_skill_request");
      if (this.sessions.verify(token) !== identity) throw new CatalogError(401, "session_expired_or_invalid");
      // Must report the route as handled: returning undefined makes the caller
      // treat it as unmatched and write a second response onto a sent one.
      if (manage) { await this.manage(req.url, identity, body, send); return true; }
      if (exchange) {
        if (!this.tenantSkills(identity.tenantId)) throw new CatalogError(403, "skill_catalog_not_available");
        const child = this.sessions.issueForSkills(token); send(200, { token: child.token, expiresAt: child.expiresAt, audience: child.audience });
      } else send(200, this.signedCatalog(identity, body.nonce));
    } catch (error) {
      const known = error instanceof CatalogError || error instanceof RegistryError;
      send(known ? error.status : 503, { error: known ? error.message : "skill_catalog_unavailable" }); req.resume();
    }
    return true;
  }
  // Who may change the shelf is the registry's decision, not this class's; it
  // only routes and reports. Publishing is always to the caller's own tenant.
  async manage(url, identity, body, send) {
    if (url === "/v1/skills/manage") {
      if (Object.keys(body).length) throw new CatalogError(400, "invalid_skill_request");
      const shelf = this.shelf();
      return send(200, { revision: shelf.revision, administrator: this.registry.administers(identity),
        tenantId: identity.tenantId, skills: this.registry.list(identity.tenantId) });
    }
    if (url === "/v1/skills/publish") {
      if (Object.keys(body).length !== 1 || !body.skill) throw new CatalogError(400, "invalid_skill_request");
      return send(200, await this.registry.publish(identity, body.skill));
    }
    if (Object.keys(body).length !== 1 || typeof body.id !== "string") throw new CatalogError(400, "invalid_skill_request");
    return send(200, await this.registry.unpublish(identity, body.id));
  }
}
