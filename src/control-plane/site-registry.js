// The published sites this control plane serves.
//
// A published site is an immutable version -- the same manifest the application
// catalogue already uses (src/apps/manifest.js): every file named, sized and
// hashed, nothing outside the list, and an HTML entry. Publishing again makes a
// new version beside the old one rather than changing it, so a link that worked
// a minute ago still serves the bytes it served then until the new version is
// the current one, and a rollback is naming an earlier digest.
//
// What is stored next to a version is small and deliberate:
//   share    who may open it (site-access.js)
//   source   the slice it follows, if any, so a refresh knows what to re-read
//   data     the snapshot the page is given, written by the refresher
//
// Bytes are verified on the way in and again on the way out. On the way in
// because a manifest that does not match its files is a broken site; on the way
// out because this process serves those bytes to other people's browsers, and
// "it was right when we wrote it" is not the same claim as "it is right now".
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { openBytes, sealBytes } from "./state-store.js";
import path from "node:path";
import { appHash, appManifest, APP_CONTENT_TYPES } from "../apps/manifest.js";
import { parseShare } from "./site-access.js";
import { namedDatabase } from "./database-names.js";

// Set for a tenant, not for a demo: a hundred sites of ten megabytes each is
// already a gigabyte of somebody's disk, and a control plane that fills a disk
// takes the scheduled tasks and the login with it.
export const SITE_LIMITS = Object.freeze({
  sites: 500,
  versionsKept: 3,
  dataBytes: 8 * 1024 * 1024,
});

const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Served as the one table says (APP_CONTENT_TYPES), with text in UTF-8.
export const siteContentType = (file) => {
  const type = APP_CONTENT_TYPES[path.extname(String(file)).toLowerCase()];
  return !type ? "application/octet-stream" : /^(text\/|application\/json)/.test(type) ? `${type}; charset=utf-8` : type;
};

const text = (value, cap) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, cap);

// Where a registry keeps what it holds: the records, each version's files, and
// each site's data. On this machine's disk (FileSiteStorage), or in the shared
// database (PostgresSiteStorage), which lets a coordinator on another machine
// serve the same sites (docs/scaling-plan.md §2.5). The registry itself is the
// same either way.
export class FileSiteStorage {
  #root;
  constructor(root) { this.#root = root; }
  async loadSites() {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await readFile(path.join(this.#root, "sites.json"), "utf8"));
      return stored?.version === 1 && Array.isArray(stored.sites) ? stored.sites : [];
    } catch { return []; }
  }
  async saveSites(sites) {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await put(path.join(this.#root, "sites.json"), Buffer.from(JSON.stringify({ version: 1, sites })));
  }
  async putFile(siteId, version, name, bytes) {
    const folder = path.join(this.#root, siteId, version);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await put(path.join(folder, name), bytes);
  }
  readFile(siteId, version, name) { return readFile(path.join(this.#root, siteId, version, name)); }
  async putData(siteId, bytes) { await mkdir(path.join(this.#root, siteId), { recursive: true, mode: 0o700 }); await put(path.join(this.#root, siteId, "data.json"), bytes); }
  async readData(siteId) {
    try { return await readFile(path.join(this.#root, siteId, "data.json")); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }
  // Versions beyond the few kept are removed once the new one is the current
  // one, so a site that is republished every hour does not grow without bound.
  async sweep(siteId, keep) {
    const folder = path.join(this.#root, siteId);
    let entries = [];
    try { entries = await readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.includes(entry.name)) continue;
      await rm(path.join(folder, entry.name), { recursive: true, force: true });
    }
  }
  async erase(siteId) { await rm(path.join(this.#root, siteId), { recursive: true, force: true }); }
}

const SITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS idou_site_files (site text NOT NULL, version text NOT NULL, name text NOT NULL, bytes bytea NOT NULL,
    PRIMARY KEY (site, version, name));
  CREATE TABLE IF NOT EXISTS idou_site_data (site text PRIMARY KEY, bytes bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());`;
// A version's files never change, so what was read once is kept, within this.
const SITE_CACHE_BYTES = 64 * 1024 * 1024;

export class PostgresSiteStorage {
  #pool; #state; #key; #saved = new Map(); #cache = new Map(); #cached = 0;
  // `state`: the shared state store (records); `pool` and `key`: the database
  // and the key the replicas share (files and data, sealed and bound to their
  // site, version and name).
  static async open({ pool, state, key }) {
    ({ pool } = await namedDatabase({ pool }));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('idou:schema:sites'))");
      await client.query(SITE_SCHEMA);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
    return new PostgresSiteStorage({ pool, state, key });
  }
  constructor({ pool, state, key }) { this.#pool = pool; this.#state = state; this.#key = key; }
  async loadSites() {
    const sites = [];
    for (let after = null; ;) {
      const page = await this.#state.list("site", { after, limit: 1000 });
      for (const row of page) { sites.push(row.value); this.#saved.set(row.key, JSON.stringify(row.value)); }
      if (page.length < 1000) break;
      after = page.at(-1).key;
    }
    return sites;
  }
  // Only what changed: one record written, or removed.
  async saveSites(sites) {
    const next = new Map(sites.map((site) => [site.id, JSON.stringify(site)]));
    for (const site of sites) if (this.#saved.get(site.id) !== next.get(site.id)) await this.#state.put("site", site.id, site);
    for (const id of this.#saved.keys()) if (!next.has(id)) await this.#state.delete("site", id);
    this.#saved = next;
  }
  async putFile(siteId, version, name, bytes) {
    await this.#pool.query(`INSERT INTO idou_site_files (site, version, name, bytes) VALUES ($1, $2, $3, $4)
      ON CONFLICT (site, version, name) DO UPDATE SET bytes = EXCLUDED.bytes`, [siteId, version, name, sealBytes(this.#key, "site-file", `${siteId}/${version}/${name}`, bytes)]);
  }
  async readFile(siteId, version, name) {
    const slot = `${siteId}/${version}/${name}`;
    const cached = this.#cache.get(slot);
    if (cached) { this.#cache.delete(slot); this.#cache.set(slot, cached); return cached; }
    const { rows } = await this.#pool.query("SELECT bytes FROM idou_site_files WHERE site = $1 AND version = $2 AND name = $3", [siteId, version, name]);
    if (!rows[0]) throw Object.assign(new Error(`网站文件不存在：${slot}`), { code: "ENOENT" });
    const bytes = openBytes(this.#key, "site-file", slot, rows[0].bytes);
    this.#cache.set(slot, bytes); this.#cached += bytes.length;
    for (const [oldest, value] of this.#cache) { if (this.#cached <= SITE_CACHE_BYTES) break; this.#cache.delete(oldest); this.#cached -= value.length; }
    return bytes;
  }
  async putData(siteId, bytes) {
    await this.#pool.query(`INSERT INTO idou_site_data (site, bytes, updated_at) VALUES ($1, $2, now())
      ON CONFLICT (site) DO UPDATE SET bytes = EXCLUDED.bytes, updated_at = now()`, [siteId, sealBytes(this.#key, "site-data", siteId, bytes)]);
  }
  async readData(siteId) {
    const { rows } = await this.#pool.query("SELECT bytes FROM idou_site_data WHERE site = $1", [siteId]);
    return rows[0] ? openBytes(this.#key, "site-data", siteId, rows[0].bytes) : null;
  }
  async sweep(siteId, keep) {
    await this.#pool.query("DELETE FROM idou_site_files WHERE site = $1 AND NOT (version = ANY($2::text[]))", [siteId, keep]);
    for (const slot of [...this.#cache.keys()]) if (slot.startsWith(`${siteId}/`) && !keep.includes(slot.split("/")[1])) { this.#cached -= this.#cache.get(slot).length; this.#cache.delete(slot); }
  }
  async erase(siteId) {
    await this.#pool.query("DELETE FROM idou_site_files WHERE site = $1", [siteId]);
    await this.#pool.query("DELETE FROM idou_site_data WHERE site = $1", [siteId]);
    for (const slot of [...this.#cache.keys()]) if (slot.startsWith(`${siteId}/`)) { this.#cached -= this.#cache.get(slot).length; this.#cache.delete(slot); }
  }
  // Every file of a site, for moving it between storages (bin/migrate-data.js).
  async files(siteId) {
    const { rows } = await this.#pool.query("SELECT version, name, bytes FROM idou_site_files WHERE site = $1 ORDER BY version, name", [siteId]);
    return rows.map((row) => ({ version: row.version, name: row.name, bytes: openBytes(this.#key, "site-file", `${siteId}/${row.version}/${row.name}`, row.bytes) }));
  }
}

export class SiteRegistry {
  #storage; #sites;
  constructor(storage, sites) { this.#storage = storage; this.#sites = sites; }

  // `root` is where a disk-backed registry lives; with a `storage` given (the
  // shared database's), that is where everything is instead.
  static async open(root, { storage = null } = {}) {
    const store = storage ?? new FileSiteStorage(root);
    return new SiteRegistry(store, (await store.loadSites()).filter(readable));
  }
  get storage() { return this.#storage; }

  list({ ownerId = null, tenantId = null } = {}) {
    return this.#sites
      .filter((site) => (!ownerId || site.ownerId === ownerId) && (!tenantId || site.tenantId === tenantId))
      .map(describe);
  }
  get(siteId) { return this.#sites.find((site) => site.id === siteId) ?? null; }

  // A new version of a site, or a site's first. `blobs` are base64 as the
  // desktop collected them (app-candidates.js); every one is checked against
  // the manifest before a byte reaches the disk.
  async publish({ siteId, ownerId, tenantId, name, manifest, blobs, share, source = null, anonymousAllowed = false }) {
    if (typeof ownerId !== "string" || !ownerId || typeof tenantId !== "string" || !tenantId) throw new Error("发布需要已核验的用户身份");
    const checked = appManifest(manifest);
    const id = siteId ?? randomUUID();
    if (!SITE_ID.test(id)) throw new Error("网站标识无效");
    const existing = this.get(id);
    if (existing && existing.ownerId !== ownerId) throw new Error("只有网站的所有者可以发布新版本");
    if (!existing && this.#sites.length >= SITE_LIMITS.sites) throw new Error(`这台服务器最多托管 ${SITE_LIMITS.sites} 个网站`);
    const parsed = parseShare(share, { anonymousAllowed });
    const files = new Map(blobsByPath(blobs));
    for (const file of checked.manifest.files) {
      const bytes = files.get(file.path);
      if (!bytes) throw new Error(`版本包缺少文件：${file.path}`);
      if (bytes.length !== file.bytes || appHash(bytes) !== file.sha256) throw new Error(`版本包与清单不一致：${file.path}`);
    }
    if (files.size !== checked.manifest.files.length) throw new Error("版本包里有清单之外的文件");

    const version = checked.digest;
    for (const file of checked.manifest.files) await this.#storage.putFile(id, version, stored(file.path), files.get(file.path));
    await this.#storage.putFile(id, version, "manifest.json", Buffer.from(JSON.stringify(checked.manifest)));

    const record = {
      id, ownerId, tenantId,
      name: text(name, 80) || "未命名网站",
      version,
      entry: checked.manifest.entry,
      bytes: checked.totalBytes,
      share: { scope: parsed.scope, inherit: parsed.inherit, members: parsed.members.map((member) => ({ ...member })) },
      source: source ? { kind: source.kind, token: source.token, tableId: source.tableId ?? null, sheetId: source.sheetId ?? null } : null,
      publishedAt: Date.now(),
      offline: false, offlineAt: null,
      createdAt: existing?.createdAt ?? Date.now(),
      history: [version, ...(existing?.history ?? []).filter((old) => old !== version)].slice(0, SITE_LIMITS.versionsKept),
    };
    await this.#save([...this.#sites.filter((site) => site.id !== id), record]);
    await this.#sweep(record);
    return describe(record);
  }

  async setShare(siteId, share, { ownerId, anonymousAllowed = false } = {}) {
    const site = this.#owned(siteId, ownerId);
    const parsed = parseShare(share, { anonymousAllowed });
    await this.#save(this.#sites.map((item) => item.id !== siteId ? item
      : { ...item, share: { scope: parsed.scope, inherit: parsed.inherit, members: parsed.members.map((member) => ({ ...member })) } }));
    return describe(this.get(siteId));
  }

  // Taking a site offline: the link stops working at once, and that is the
  // point -- but the version and its data stay, so publishing it again is one
  // click and not a rebuild. Kimi 网页 does the same ("代码和数据会保留，你可随时
  // 重新发布"), and a person who took something down by mistake should not have
  // lost it.
  async withdraw(siteId, { ownerId } = {}) {
    this.#owned(siteId, ownerId);
    await this.#save(this.#sites.map((site) => site.id !== siteId ? site : { ...site, offline: true, offlineAt: Date.now() }));
    return { withdrawn: true, kept: true };
  }

  // Publishing again what is already here, without sending the bytes twice.
  async republish(siteId, { ownerId } = {}) {
    const site = this.#owned(siteId, ownerId);
    if (!site.offline) return describe(site);
    await this.#save(this.#sites.map((item) => item.id !== siteId ? item : { ...item, offline: false, offlineAt: null, publishedAt: Date.now() }));
    return describe(this.get(siteId));
  }

  // Removing it for good, bytes and all. Only ever asked for explicitly.
  async erase(siteId, { ownerId } = {}) {
    this.#owned(siteId, ownerId);
    await this.#save(this.#sites.filter((site) => site.id !== siteId));
    await this.#storage.erase(siteId);
    return { erased: true };
  }

  // One file of the current version, checked against the manifest as it is read.
  async file(siteId, requested) {
    const site = this.get(siteId);
    if (!site) return null;
    const manifest = JSON.parse((await this.#storage.readFile(siteId, site.version, "manifest.json")).toString("utf8"));
    const wanted = !requested || requested === "/" ? manifest.entry : requested.replace(/^\/+/, "");
    const entry = manifest.files.find((file) => file.path === wanted);
    if (!entry) return null;
    const bytes = await this.#storage.readFile(siteId, site.version, stored(entry.path));
    if (bytes.length !== entry.bytes || appHash(bytes) !== entry.sha256) throw new Error("网站文件与发布时的清单不一致，已拒绝提供");
    return { path: entry.path, bytes, contentType: siteContentType(entry.path), version: site.version };
  }

  // What the page is given when it asks for its data. Written by whatever
  // refreshes the slice; served as it was written, never rebuilt here.
  async putData(siteId, payload) {
    const site = this.get(siteId);
    if (!site) throw new Error("找不到这个网站");
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length > SITE_LIMITS.dataBytes) throw new Error("这个网站的数据超过了上限");
    // Whether anything a visitor would see actually moved. Since the slice is
    // re-read on a clock, most writes carry the same numbers as the last one,
    // and telling every open page to fetch the whole payload again for that is
    // pure waste. The digest already covers exactly what is shown.
    const before = (await this.data(siteId))?.snapshot?.digest ?? null;
    const digest = payload?.snapshot?.digest ?? null;
    await this.#storage.putData(siteId, body);
    return { bytes: body.length, digest, changed: digest === null || digest !== before };
  }
  async data(siteId) {
    const bytes = await this.#storage.readData(siteId);
    return bytes ? JSON.parse(bytes.toString("utf8")) : null;
  }

  #owned(siteId, ownerId) {
    const site = this.get(siteId);
    if (!site) throw new Error("找不到这个网站");
    if (ownerId && site.ownerId !== ownerId) throw new Error("只有网站的所有者可以改它的设置");
    return site;
  }

  async #sweep(site) { await this.#storage.sweep(site.id, site.history); }

  async #save(sites) {
    await this.#storage.saveSites(sites);
    this.#sites = sites;
  }

  // Everything, as the storage holds it: for moving a registry between
  // storages (bin/migrate-data.js). Records as written, with each site's data
  // and the files of every version it keeps.
  async dump() {
    const sites = [];
    for (const site of this.#sites) {
      const files = [];
      for (const version of site.history ?? [site.version]) {
        let manifest;
        try { manifest = JSON.parse((await this.#storage.readFile(site.id, version, "manifest.json")).toString("utf8")); } catch { continue; }
        files.push({ version, name: "manifest.json", bytes: await this.#storage.readFile(site.id, version, "manifest.json") });
        for (const file of manifest.files) files.push({ version, name: stored(file.path), bytes: await this.#storage.readFile(site.id, version, stored(file.path)) });
      }
      sites.push({ record: site, files, data: await this.#storage.readData(site.id) });
    }
    return sites;
  }
  async restore(dumped) {
    for (const { record, files, data } of dumped) {
      for (const file of files) await this.#storage.putFile(record.id, file.version, file.name, file.bytes);
      if (data) await this.#storage.putData(record.id, data);
    }
    const kept = new Map(this.#sites.map((site) => [site.id, site]));
    for (const { record } of dumped) kept.set(record.id, record);
    await this.#save([...kept.values()].filter(readable));
  }
}

// One file per manifest path, named by a hash of that path: a published name
// never becomes a path on this disk, so no manifest can write outside its own
// folder however it spells its files.
const stored = (name) => `${createHash("sha256").update(name).digest("hex")}.blob`;

function blobsByPath(blobs) {
  if (!Array.isArray(blobs) || !blobs.length || blobs.length > 128) throw new Error("版本包无效");
  return blobs.map((blob) => {
    if (typeof blob?.path !== "string" || typeof blob?.base64 !== "string" || blob.base64.length > 4 * 1024 * 1024) throw new Error("版本包文件无效");
    return [blob.path, Buffer.from(blob.base64, "base64")];
  });
}

async function put(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

const describe = (site) => ({
  id: site.id, name: site.name, ownerId: site.ownerId, tenantId: site.tenantId, version: site.version,
  offline: site.offline === true, offlineAt: site.offlineAt ?? null,
  entry: site.entry, bytes: site.bytes, publishedAt: site.publishedAt, createdAt: site.createdAt,
  share: { scope: site.share.scope, inherit: site.share.inherit, members: site.share.members.map((member) => ({ ...member })) },
  source: site.source ? { ...site.source } : null,
  sourced: Boolean(site.source),
});

// A record written by another build, or by hand, is honoured only if this build
// would still accept every part of it.
function readable(site) {
  if (!SITE_ID.test(site?.id ?? "") || typeof site.ownerId !== "string" || !site.ownerId) return false;
  if (typeof site.tenantId !== "string" || !site.tenantId || typeof site.version !== "string" || !/^[0-9a-f]{64}$/.test(site.version)) return false;
  try { parseShare(site.share, { anonymousAllowed: true }); return true; } catch { return false; }
}

export { describe as describeSite };
