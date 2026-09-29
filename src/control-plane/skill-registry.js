import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { MAX_CATALOG_BYTES, normalizeSkill, normalizeSkills, skillDigest } from "../skills/catalog-format.js";

// The enterprise skill shelf, as something an administrator can actually put
// skills on.
//
// It used to be a JSON file read once at boot, which meant the whole signed
// catalogue existed but nothing could ever be added to it -- and because no
// deployment ever configured that file, the shelf was empty everywhere. This
// owns the same shape, keeps it on disk, and lets a named administrator publish
// and withdraw entries.
//
// What it does NOT do: it never signs anything and never decides who may read.
// Signing stays with EnterpriseSkillCatalog and its key; this only decides what
// is on the shelf.
export const MAX_TENANT_SKILLS = 100;
export class RegistryError extends Error { constructor(status, message) { super(message); this.status = status; } }

const TENANT = /^[A-Za-z0-9_-]{1,256}$/;

// One tenant's shelf is the only thing an administrator of that tenant can
// change. A catalogue-wide administrator is deliberately not a concept: a
// person is an administrator because of the tenant they signed in to.
function requireTenant(tenantId) {
  if (typeof tenantId !== "string" || !TENANT.test(tenantId)) throw new RegistryError(400, "invalid_tenant");
  return tenantId;
}

export class SkillRegistry {
  // `administrators` is the set of Feishu user ids allowed to publish. Empty
  // means nobody can, which is the safe default for a deployment that has not
  // thought about it yet -- reading the shelf still works.
  constructor({ filename, administrators = [], now = Date.now }) {
    if (typeof filename !== "string" || !path.isAbsolute(filename)) throw new Error("Absolute skill registry file required");
    this.filename = filename; this.now = now;
    this.administrators = new Set(administrators.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()));
    this.state = { revision: 1, tenants: new Map() };
    this.queue = Promise.resolve();
  }
  administers(identity) { return Boolean(identity?.userId) && this.administrators.has(identity.userId); }
  // Serialised so two publishes cannot interleave a read-modify-write.
  serial(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => {}, () => {});
    return next;
  }
  async load() {
    let file, text = null;
    try {
      file = await open(this.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > 8 * MAX_CATALOG_BYTES) throw new Error("oversized");
      text = (await file.readFile()).toString("utf8");
    } catch (error) {
      // A shelf that has never been written is empty, not broken. Anything else
      // -- unreadable, malformed, oversized -- must stop the server rather than
      // silently serve an empty catalogue that looks like "no skills yet".
      if (error?.code !== "ENOENT") throw new Error(`Cannot read skill registry: ${this.filename}`);
    } finally { await file?.close(); }
    if (text === null) return this;
    let value; try { value = JSON.parse(text); } catch { throw new Error("Skill registry is not valid JSON"); }
    this.state = parseRegistry(value);
    return this;
  }
  snapshot() { return { revision: this.state.revision, tenants: this.state.tenants }; }
  list(tenantId) { return (this.state.tenants.get(requireTenant(tenantId)) ?? []).map(skill => ({ ...skill, digest: skillDigest(skill) })); }

  async publish(identity, value) {
    return this.serial(async () => {
      if (!this.administers(identity)) throw new RegistryError(403, "skill_publish_not_permitted");
      const tenantId = requireTenant(identity.tenantId);
      let skill; try { skill = normalizeSkill(value); } catch (error) { throw new RegistryError(400, `invalid_skill: ${String(error?.message ?? error).slice(0, 120)}`); }
      // The signed catalogue carries enterprise skills only; a locally imported
      // folder is admitted by its own person's confirmation, never by a server
      // signature. Publishing is exactly the step that changes provenance, so
      // the caller has to say so by giving it an enterprise identity.
      if (!skill.id.startsWith("enterprise-")) throw new RegistryError(400, "enterprise_skill_id_required");
      const current = this.state.tenants.get(tenantId) ?? [];
      const existing = current.find(item => item.id === skill.id);
      if (existing && existing.version === skill.version && skillDigest(existing) === skillDigest(skill)) throw new RegistryError(409, "skill_already_published");
      if (!existing && current.length >= MAX_TENANT_SKILLS) throw new RegistryError(409, "skill_shelf_full");
      const next = existing ? current.map(item => item.id === skill.id ? skill : item) : [...current, skill];
      await this.commit(tenantId, next);
      return { id: skill.id, version: skill.version, digest: skillDigest(skill), revision: this.state.revision, replaced: Boolean(existing) };
    });
  }
  async unpublish(identity, id) {
    return this.serial(async () => {
      if (!this.administers(identity)) throw new RegistryError(403, "skill_publish_not_permitted");
      const tenantId = requireTenant(identity.tenantId);
      const current = this.state.tenants.get(tenantId) ?? [];
      if (!current.some(item => item.id === id)) throw new RegistryError(404, "skill_not_published");
      await this.commit(tenantId, current.filter(item => item.id !== id));
      return { id, revision: this.state.revision };
    });
  }
  // Every change bumps the revision, so a client that has seen revision N can
  // tell that what it is holding is stale without comparing contents.
  async commit(tenantId, skills) {
    let normalized; try { normalized = normalizeSkills(skills); } catch (error) { throw new RegistryError(400, `invalid_shelf: ${String(error?.message ?? error).slice(0, 120)}`); }
    const tenants = new Map(this.state.tenants);
    if (normalized.length) tenants.set(tenantId, normalized); else tenants.delete(tenantId);
    const next = { revision: this.state.revision + 1, tenants };
    await this.write(next);
    this.state = next;
  }
  async write(state) {
    const value = serializeRegistry(state);
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 8 * MAX_CATALOG_BYTES) throw new RegistryError(413, "skill_registry_too_large");
    const temporary = `${this.filename}.${process.pid}.tmp`;
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
      await rename(temporary, this.filename);
    } finally {
      await file?.close();
      await unlink(temporary).catch(error => { if (error?.code !== "ENOENT") throw error; });
    }
  }
}

// The shelf as it is written down, in a file or in the shared database.
export const serializeRegistry = (state) => ({ schemaVersion: 1, revision: state.revision,
  tenants: [...state.tenants.entries()].map(([tenantId, skills]) => ({ tenantId, skills })) });

// The same shelf in the shared database (docs/scaling-plan.md §2.5), so a
// coordinator on another machine serves the same skills. One record, written
// only over the version this process read: a shelf changed elsewhere meanwhile
// is refused rather than overwritten.
const SHELF = ["skill-registry", "shelf"];
export class PostgresSkillRegistry extends SkillRegistry {
  constructor({ state, administrators = [], now = Date.now }) {
    super({ filename: "/postgres/skill-registry", administrators, now });
    this.store = state; this.version = null;
  }
  async load() {
    const record = await this.store.get(...SHELF);
    if (record) { this.state = parseRegistry(record.value); this.version = record.version; }
    return this;
  }
  async write(state) {
    const value = serializeRegistry(state);
    if (Buffer.byteLength(JSON.stringify(value)) > 8 * MAX_CATALOG_BYTES) throw new RegistryError(413, "skill_registry_too_large");
    const written = this.version === null ? await this.store.create(...SHELF, value) : await this.store.update(...SHELF, this.version, value);
    if (!written) throw new RegistryError(409, "skill_registry_changed_elsewhere");
    this.version = written.version;
  }
}

export function parseRegistry(value) {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      !Array.isArray(value.tenants) || value.tenants.length > 100 ||
      Object.keys(value).some(key => !["schemaVersion", "revision", "tenants"].includes(key))) throw new Error("Invalid skill registry");
  const tenants = new Map();
  for (const row of value.tenants) {
    if (!row || Object.keys(row).length !== 2 || !TENANT.test(row.tenantId ?? "") || tenants.has(row.tenantId)) throw new Error("Invalid skill registry tenant");
    tenants.set(row.tenantId, normalizeSkills(row.skills));
  }
  return { revision: value.revision, tenants };
}
