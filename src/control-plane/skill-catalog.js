import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";
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
    this.governance = null; this.departmentsOf = null; this.audit = () => {}; this.log = () => {};
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
  // What the organisation decided beyond the shelf (skill-governance.js), once
  // the administration database is open: review before a version goes up,
  // publishers added in the console, who sees which skill, who used which.
  // `departmentsOf(who)`: every department a person is in, with those above
  // (org-directory.js). `audit(event, context)`: the console's trail.
  govern({ governance = null, departmentsOf = null, audit = () => {}, log = () => {} } = {}) {
    Object.assign(this, { governance, departmentsOf, audit, log });
    if (this.registry && governance) this.registry.alsoAdministers = (identity) => governance.isPublisher(identity.tenantId, identity.userId);
  }
  // A secret of the server's for the usage record's summaries of people: from
  // the signing key, which only this server holds and which does not change.
  usageKey() { return createHmac("sha256", this.privateKey.export({ format: "der", type: "pkcs8" })).update("idou skill-usage key").digest(); }
  // A static catalogue that does not list a tenant has no shelf for it, and
  // that is refused. A writable shelf is different: the deployment chose to run
  // one, so every tenant that can sign in has a shelf -- empty until its first
  // publish, and empty again after its last withdrawal (the registry drops the
  // key then). Refusing those made the first publish unreachable from the UI
  // and told everyone else 目录不可用 when the truth was 还没有上架.
  tenantSkills(tenantId) { return this.shelf().tenants.get(tenantId) ?? (this.registry ? [] : undefined); }
  // Only what this person may see: a skill for named departments is not in
  // anybody else's catalogue -- nor in the management view, nor counted as
  // used by them -- so no task of theirs can use it either.
  async visible(identity) {
    const all = this.tenantSkills(identity.tenantId);
    if (!all) return null;
    return this.governance ? this.governance.visibleTo(identity, all, this.departmentsOf) : all;
  }
  async signedCatalog(identity, nonce) {
    const shelf = this.shelf(), skills = await this.visible(identity);
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
    const MANAGE = ["/v1/skills/manage", "/v1/skills/publish", "/v1/skills/unpublish", "/v1/skills/used"];
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
      const maxBytes = req.url === "/v1/skills/publish" ? 8 * MAX_CATALOG_BYTES : 1024;
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
      } else send(200, await this.signedCatalog(identity, body.nonce));
    } catch (error) {
      const known = error instanceof CatalogError || error instanceof RegistryError;
      send(known ? error.status : 503, { error: known ? error.message : "skill_catalog_unavailable" }); req.resume();
    }
    return true;
  }
  // Who may change the shelf is the registry's decision, not this class's; it
  // only routes and reports. Publishing is always to the caller's own tenant.
  async manage(url, identity, body, send) {
    const context = (name) => ({ who: identity, name });
    if (url === "/v1/skills/manage") {
      if (Object.keys(body).length) throw new CatalogError(400, "invalid_skill_request");
      const shelf = this.shelf(), administrator = this.registry.administers(identity);
      // A publisher's own submissions and what became of them: shown in their skill center.
      const submissions = administrator && this.governance
        ? (await this.governance.submissions(identity.tenantId, { state: null, submittedBy: identity.userId, limit: 20 })).filter((row) => row.state !== "superseded")
          .map(({ id, skillId, version, title, at, state, decision }) => ({ id, skillId, version, title, at, state, reason: state === "rejected" ? decision?.reason ?? "" : "" }))
        : [];
      // What is up, as names and versions: a publisher manages all of it, anybody
      // else is shown what their own catalogue holds. The files travel only
      // in the signed catalogue.
      const listed = administrator ? this.registry.list(identity.tenantId) : await this.visible(identity) ?? [];
      const skills = listed.map(({ id, version, title, description, publisher, requiredTools, digest }) => ({ id, version, title, description, publisher, requiredTools, digest }));
      return send(200, { revision: shelf.revision, administrator, tenantId: identity.tenantId, skills,
        review: { required: this.governance ? this.governance.settings(identity.tenantId).reviewRequired : false }, submissions });
    }
    if (url === "/v1/skills/used") {
      // A task started with an enterprise skill (desktop main.js): counted, by whom kept as a summary.
      // Only a skill this person can see now, at the version that is up.
      if (Object.keys(body).some((key) => !["id", "version"].includes(key)) || typeof body.id !== "string") throw new CatalogError(400, "invalid_skill_request");
      const used = (await this.visible(identity) ?? []).find((skill) => skill.id === body.id);
      if (!used || !this.governance) return send(200, { ok: false });
      await this.governance.recordUse(identity.tenantId, { skillId: used.id, version: used.version, userId: identity.userId });
      return send(200, { ok: true });
    }
    if (url === "/v1/skills/publish") {
      if (Object.keys(body).length !== 1 || !body.skill) throw new CatalogError(400, "invalid_skill_request");
      if (!this.registry.administers(identity)) throw new RegistryError(403, "skill_publish_not_permitted");
      // Waits for an administrator unless the organisation turned review off
      // (docs/enterprise-skill-governance.md §2): the shelf does not change yet.
      if (this.governance?.settings(identity.tenantId).reviewRequired) {
        const skill = this.registry.admissible(identity.tenantId, body.skill);
        const submitted = await this.governance.submit(identity.tenantId, skill, identity);
        this.audit({ event: "skill-submitted", skillId: skill.id, version: skill.version, digest: submitted.digest }, context(skill.title));
        return send(200, { pending: true, submission: submitted.id, id: skill.id, version: skill.version, digest: submitted.digest });
      }
      // What is up now is kept before it is replaced (skill-governance.js keepLive).
      if (this.governance) await this.governance.keepLive(identity.tenantId, this.registry.list(identity.tenantId).find((item) => item.id === body.skill?.id) ?? null);
      const placed = await this.registry.publish(identity, body.skill);
      // The shelf's own record, without the digest the listing adds.
      const { digest: _digest, ...skill } = this.registry.list(identity.tenantId).find((item) => item.id === placed.id) ?? {};
      // It is up: a version history that could not be written is said, not
      // turned into a failure the publisher would retry.
      if (this.governance && skill.id) await this.governance.recordVersion(identity.tenantId, skill, { publishedBy: identity, source: "publish" })
        .catch((error) => this.log({ component: "skills", event: "version-not-recorded", skillId: skill.id, message: String(error?.message ?? error).slice(0, 200) }));
      this.audit({ event: "skill-published", skillId: placed.id, version: placed.version, digest: placed.digest }, context(skill.title ?? ""));
      return send(200, placed);
    }
    if (Object.keys(body).length !== 1 || typeof body.id !== "string") throw new CatalogError(400, "invalid_skill_request");
    const before = this.registry.list(identity.tenantId).find((item) => item.id === body.id);
    // Kept first, so the console can bring it back -- and only for a publisher.
    if (!this.registry.administers(identity)) throw new RegistryError(403, "skill_publish_not_permitted");
    if (this.governance && before) await this.governance.keepLive(identity.tenantId, before);
    const removed = await this.registry.unpublish(identity, body.id);
    this.audit({ event: "skill-unpublished", skillId: body.id, version: before?.version ?? "", digest: before?.digest ?? "" }, context(before?.title ?? ""));
    return send(200, removed);
  }
}
