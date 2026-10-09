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
//
// A site's table data was 8 MB until docs/sites-phase1.md §1.7, about 5,000
// rows of a dozen fields; 32 MB holds 20,000 of them with room. It is the most
// a site can hold, not what most do -- a table site is a few hundred rows.
export const SITE_LIMITS = Object.freeze({
  sites: 500,
  versionsKept: 3,
  dataBytes: 32 * 1024 * 1024,
});

const SITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A name for a site's address, /s/<name>/ (docs/sites-phase1.md §1.6): letters
// of any script, digits, - and _, two to forty of them. Nothing that could be a
// site's id or one of this server's own paths. Unique on this server, since
// the path is: one deployment may serve several organisations.
const ADDRESS = /^[\p{L}\p{N}][\p{L}\p{N}_-]{1,39}$/u;
const RESERVED_ADDRESSES = new Set(["admin", "demo", "auth", "api", "static", "assets", "login", "logout"]);
const addressKey = (value) => String(value).normalize("NFC").toLowerCase();
export function siteAddress(value) {
  const name = String(value ?? "").normalize("NFC").trim();
  if (!ADDRESS.test(name)) throw new Error("地址名要 2 到 40 个字，只能用文字、数字、- 和 _，并以文字或数字开头");
  if (/^[0-9a-f-]{36}$/i.test(name) || RESERVED_ADDRESSES.has(addressKey(name))) throw new Error("这个地址名不能用，换一个");
  return name;
}
// Earlier names of a site's address that still lead to it.
const ADDRESSES_KEPT = 5;
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
  // Every write is a new file renamed into place (put), so its inode moves even
  // when its size and its time do not.
  async dataStamp(siteId) {
    try { const held = await stat(path.join(this.#root, siteId, "data.json"), { bigint: true }); return `${held.ino}-${held.size}-${held.mtimeNs}`; }
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
  // The write's time to the microsecond, and its size: never the bytes.
  async dataStamp(siteId) {
    const { rows } = await this.#pool.query("SELECT extract(epoch FROM updated_at)::text AS at, octet_length(bytes) AS size FROM idou_site_data WHERE site = $1", [siteId]);
    return rows[0] ? `${rows[0].at}-${rows[0].size}` : null;
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
  #storage; #sites; #queue = Promise.resolve(); #digests = new Map();
  #writing = new Map();   // site → version → how many publishes are writing its files now
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
  // The site an address name leads to: its name now, or one it had.
  byAddress(name) {
    let key;
    try { key = addressKey(siteAddress(name)); } catch { return null; }
    return this.#sites.find((site) => [site.address, ...(site.addresses ?? [])].some((held) => held && addressKey(held) === key)) ?? null;
  }

  // Every change to the records, one after another, each made from the records
  // as they are when its turn comes -- not as they were when it was asked for.
  // A publish that waited minutes on its content check, an owner's withdraw, an
  // administrator's hold and a check again in the background each saved the
  // whole list from what it had read, and the last to save undid the others
  // (found in review before .270). `change(sites)` returns { sites, value }:
  // what to save, if anything, and what to answer.
  #update(change) {
    const turn = this.#queue.then(async () => {
      const { sites = null, value } = await change(this.#sites);
      if (sites) await this.#save(sites);
      return value;
    });
    this.#queue = turn.catch(() => {});
    return turn;
  }
  // Every change asked for so far has been made or refused.
  settled() { return this.#queue; }

  // A new version of a site, or a site's first. `blobs` are base64 as the
  // desktop collected them (app-candidates.js); every one is checked against
  // the manifest before a byte reaches the disk.
  // `review`: { checkId, reason } when this version must wait for an
  // administrator (site-safety.js): it is written offline and waiting in the
  // same save, so there is no moment it is served unreviewed.
  // `expect` (stampOf): the site as it was when the version was checked. The
  // check can take minutes; if the site changed meanwhile -- its owner took it
  // down, an administrator held it, another publish landed -- nothing is
  // written (SiteConflict). `allowed()`: asked again when the record is
  // written, false once the owner has been disabled.
  async publish({ siteId, ownerId, tenantId, name, manifest, blobs, share, source = null, anonymousAllowed = false, review = null, expect = undefined, allowed = null }) {
    if (typeof ownerId !== "string" || !ownerId || typeof tenantId !== "string" || !tenantId) throw new Error("发布需要已核验的用户身份");
    const checked = appManifest(manifest);
    const id = siteId ?? randomUUID();
    if (!SITE_ID.test(id)) throw new Error("网站标识无效");
    const before = this.get(id);
    if (before && before.ownerId !== ownerId) throw new Error("只有网站的所有者可以发布新版本");
    if (before?.held) throw new Error(heldText(before));
    if (!before && this.#sites.length >= SITE_LIMITS.sites) throw new Error(`这台服务器最多托管 ${SITE_LIMITS.sites} 个网站`);
    const parsed = parseShare(share, { anonymousAllowed });
    const files = new Map(blobsByPath(blobs));
    for (const file of checked.manifest.files) {
      const bytes = files.get(file.path);
      if (!bytes) throw new Error(`版本包缺少文件：${file.path}`);
      if (bytes.length !== file.bytes || appHash(bytes) !== file.sha256) throw new Error(`版本包与清单不一致：${file.path}`);
    }
    if (files.size !== checked.manifest.files.length) throw new Error("版本包里有清单之外的文件");

    // Refused already, before a byte is written, if the site changed during its check.
    if (expect !== undefined && stampOf(before) !== expect) throw new SiteConflict();
    if (allowed && !allowed()) throw new SiteRefused();

    const version = checked.digest;
    this.#writes(id, version, 1);
    let record, refused = false;
    try {
      for (const file of checked.manifest.files) await this.#storage.putFile(id, version, stored(file.path), files.get(file.path));
      await this.#storage.putFile(id, version, "manifest.json", Buffer.from(JSON.stringify(checked.manifest)));
      record = await this.#update((sites) => {
      const existing = sites.find((site) => site.id === id) ?? null;
      if (existing && existing.ownerId !== ownerId) throw new Error("只有网站的所有者可以发布新版本");
      if (existing?.held) throw new Error(heldText(existing));
      if (expect !== undefined && stampOf(existing) !== expect) throw new SiteConflict();
      if (allowed && !allowed()) throw new SiteRefused();
      if (!existing && sites.length >= SITE_LIMITS.sites) throw new Error(`这台服务器最多托管 ${SITE_LIMITS.sites} 个网站`);
      const written = {
        id, ownerId, tenantId,
        name: text(name, 80) || "未命名网站",
        version,
        entry: checked.manifest.entry,
        bytes: checked.totalBytes,
        share: { scope: parsed.scope, inherit: parsed.inherit, members: parsed.members.map((member) => ({ ...member })) },
        // A new version that names no table keeps the one the site follows: a
        // desktop that reads no table for it (a site downloaded onto it, or a
        // build from before that knew) took it off its table, and every
        // visitor let in through the table with it (review of phase 0).
        source: source ? { kind: source.kind, token: source.token, tableId: source.tableId ?? null, sheetId: source.sheetId ?? null } : existing?.source ?? null,
        publishedAt: Date.now(),
        offline: false, offlineAt: null,
        review: reviewState(existing?.review, review ? pending(review) : null),
        createdAt: existing?.createdAt ?? Date.now(),
        // Its address name stays with it from version to version.
        ...(existing?.address ? { address: existing.address } : {}), ...(existing?.addresses?.length ? { addresses: existing.addresses } : {}),
        history: [version, ...(existing?.history ?? []).filter((old) => old !== version)].slice(0, SITE_LIMITS.versionsKept),
      };
      written.versionAt = versionTimes(existing, written.history, version);
      const composed = compose(written, UP);
      return { sites: [...sites.filter((site) => site.id !== id), composed], value: composed };
      });
    } catch (error) {
      refused = true;
      throw error;
    } finally {
      this.#writes(id, version, -1);
      // Refused after its files were written: those no record names go again,
      // unless another publish of this site is writing them right now.
      if (refused) await this.#tidy(id).catch(() => {});
    }
    await this.#sweep(record);
    return describe(record);
  }

  #writes(siteId, version, by) {
    const versions = this.#writing.get(siteId) ?? new Map();
    const count = (versions.get(version) ?? 0) + by;
    if (count > 0) versions.set(version, count); else versions.delete(version);
    if (versions.size) this.#writing.set(siteId, versions); else this.#writing.delete(siteId);
  }
  #kept(site, siteId) { return [...(site?.history ?? []), ...(this.#writing.get(siteId)?.keys() ?? [])]; }
  // Files no record names and no publish is writing: a refused publish's.
  #tidy(siteId) {
    return this.#update(async (sites) => {
      const site = sites.find((item) => item.id === siteId);
      const keep = this.#kept(site, siteId);
      if (!site && !keep.length) await this.#storage.erase(siteId);
      else await this.#storage.sweep(siteId, keep);
      return {};
    });
  }

  // `review`: as for publish -- the site waits with its new audience. `null`:
  // checked and passed for it, so anything waiting or turned down is over.
  // Left out: not checked, and the review state stays exactly as it is -- a
  // sharing saved again must not end a wait. `expect`, `allowed`: as for publish.
  async setShare(siteId, share, { ownerId, anonymousAllowed = false, review = undefined, expect = undefined, allowed = null } = {}) {
    this.#owned(siteId, ownerId, { notHeld: true });
    const parsed = parseShare(share, { anonymousAllowed });
    return this.#update((sites) => {
      const site = owned(sites, siteId, ownerId, { notHeld: true });
      if (expect !== undefined && stampOf(site) !== expect) throw new SiteConflict();
      if (allowed && !allowed()) throw new SiteRefused();
      const changed = compose({ ...site, ...(review === undefined ? {} : { review: review ? { ...(site.review ?? {}), ...pending(review) } : cleared(site.review) }),
        share: { scope: parsed.scope, inherit: parsed.inherit, members: parsed.members.map((member) => ({ ...member })) } }, intent(site));
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: describe(changed) };
    });
  }

  // Taking a site offline: the link stops working at once, and that is the
  // point -- but the version and its data stay, so publishing it again is one
  // click and not a rebuild. Kimi 网页 does the same ("代码和数据会保留，你可随时
  // 重新发布"), and a person who took something down by mistake should not have
  // lost it.
  async withdraw(siteId, { ownerId } = {}) {
    this.#owned(siteId, ownerId);
    // Held by an administrator or waiting for review, it is offline already;
    // what changes is what a release or an approval returns it to: offline, as
    // its owner now wants -- every copy of that at once (compose).
    return this.#update((sites) => {
      const site = owned(sites, siteId, ownerId);
      const changed = compose(site, intent(site).offline ? intent(site) : { offline: true, at: Date.now() });
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: { withdrawn: true, kept: true } };
    });
  }

  // Publishing again what is already here, without sending the bytes twice.
  async republish(siteId, { ownerId, review = null, expect = undefined, allowed = null } = {}) {
    const first = this.#owned(siteId, ownerId, { notHeld: true });
    if (first.review?.state) throw new Error(reviewText(first));
    return this.#update((sites) => {
      const site = owned(sites, siteId, ownerId, { notHeld: true });
      if (site.review?.state) throw new Error(reviewText(site));
      if (expect !== undefined && stampOf(site) !== expect) throw new SiteConflict();
      if (allowed && !allowed()) throw new SiteRefused();
      if (!review && !site.offline) return { value: describe(site) };
      const changed = compose({ ...site, publishedAt: Date.now(), ...(review ? { review: { ...(site.review ?? {}), ...pending(review) } } : {}) }, UP);
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: describe(changed) };
    });
  }

  // Back to a version this site still keeps (docs/sites-phase0.md §0.6): the
  // same as publishing that version again -- checked by the caller under
  // today's rules, written up, sent to wait if the check says so -- without
  // sending its bytes twice. The version it replaces stays kept, so going back
  // is itself undone the same way. Its files are read and checked against its
  // manifest before anything changes: a kept version that no longer matches
  // is not put in front of anybody.
  // `review`, `expect`, `allowed`: as for publish.
  async revert(siteId, { ownerId, version, review = null, expect = undefined, allowed = null } = {}) {
    const first = this.#owned(siteId, ownerId, { notHeld: true });
    if (expect !== undefined && stampOf(first) !== expect) throw new SiteConflict();
    if (version === first.version) throw new Error("这已经是线上的版本");
    if (!first.history?.includes(version)) throw new Error("这个网站没有保留这一版：只保留最近 3 个版本");
    const { manifest, totalBytes } = await this.#intact(siteId, version);
    const record = await this.#update((sites) => {
      const site = owned(sites, siteId, ownerId, { notHeld: true });
      // Changed while it was checked -- another publish may have pushed this
      // version out -- is a conflict to refresh after, said before what it did.
      if (expect !== undefined && stampOf(site) !== expect) throw new SiteConflict();
      if (version === site.version) throw new Error("这已经是线上的版本");
      if (!site.history?.includes(version)) throw new Error("这个网站没有保留这一版：只保留最近 3 个版本");
      if (allowed && !allowed()) throw new SiteRefused();
      const history = [version, ...site.history.filter((old) => old !== version)];
      // When it was first published is what it keeps; one from before times
      // were kept stays without one rather than getting today's.
      const versionAt = versionTimes(site, history, null);
      if (versionAt[version] === undefined) versionAt[version] = null;
      const changed = compose({ ...site, version, entry: manifest.entry, bytes: totalBytes, publishedAt: Date.now(),
        review: reviewState(site.review, review ? pending(review) : null), history, versionAt }, UP);
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: changed };
    });
    return describe(record);
  }

  // The versions a site keeps, newest first: when each was first published, how
  // many files and how large, and which one is up.
  async versions(siteId) {
    const site = this.get(siteId);
    if (!site) throw new Error("找不到这个网站");
    const times = versionTimes(site, site.history ?? [site.version], null);
    const listed = [];
    for (const version of site.history ?? [site.version]) {
      let manifest;
      try { manifest = JSON.parse((await this.#storage.readFile(siteId, version, "manifest.json")).toString("utf8")); } catch { continue; }
      listed.push({ version, current: version === site.version, publishedAt: times[version] ?? null,
        files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) });
    }
    return listed;
  }

  // A kept version's manifest, with every one of its files present and as it says.
  async #intact(siteId, version) {
    let checked;
    try { checked = appManifest(JSON.parse((await this.#storage.readFile(siteId, version, "manifest.json")).toString("utf8"))); }
    catch { throw new Error("这一版的文件不全，不能回到这一版"); }
    if (checked.digest !== version) throw new Error("这一版的文件与发布时的清单不一致，不能回到这一版");
    const files = [];
    for (const file of checked.manifest.files) {
      const bytes = await this.#storage.readFile(siteId, version, stored(file.path)).catch(() => null);
      if (!bytes || bytes.length !== file.bytes || appHash(bytes) !== file.sha256) throw new Error("这一版的文件与发布时的清单不一致，不能回到这一版");
      files.push({ path: file.path, bytes });
    }
    return { manifest: checked.manifest, totalBytes: checked.totalBytes, files };
  }

  // A name for the site's address (docs/sites-phase1.md §1.6), or none
  // (`address` null). The name it had keeps leading to it, so a link already
  // sent on still opens; a name another site has, or had, is taken.
  async setAddress(siteId, { ownerId, address }) {
    this.#owned(siteId, ownerId, { notHeld: true });
    const wanted = address === null ? null : siteAddress(address);
    return this.#update((sites) => {
      const site = owned(sites, siteId, ownerId, { notHeld: true });
      if (wanted !== null) {
        const key = addressKey(wanted);
        const holder = sites.find((item) => item.id !== siteId && [item.address, ...(item.addresses ?? [])].some((held) => held && addressKey(held) === key));
        if (holder) throw new Error("这个地址名已经被别的网站用了，换一个");
      }
      if ((site.address ?? null) === wanted) return { value: describe(site) };
      const earlier = [site.address, ...(site.addresses ?? [])].filter((held) => held && held !== wanted && (wanted === null || addressKey(held) !== addressKey(wanted)));
      const changed = { ...site, address: wanted, addresses: [...new Set(earlier)].slice(0, ADDRESSES_KEPT) };
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: describe(changed) };
    });
  }

  // Removing it for good, bytes and all. Only ever asked for explicitly.
  async erase(siteId, { ownerId } = {}) {
    this.#owned(siteId, ownerId, { notHeld: true });
    await this.#update((sites) => { owned(sites, siteId, ownerId, { notHeld: true }); return { sites: sites.filter((site) => site.id !== siteId) }; });
    await this.#storage.erase(siteId);
    return { erased: true };
  }

  // An administrator taking a site down (docs/admin-console.md §9): its link
  // stops working at once, and its owner cannot bring it back, change who may
  // see it, publish over it or erase it until an administrator releases it.
  // The files stay. It is written as offline too, with the owner's own state
  // kept to return to -- so a build that does not know about holds still
  // keeps it down.
  async hold(siteId, { by, reason }) {
    return this.#update((sites) => {
      const site = sites.find((item) => item.id === siteId);
      if (!site) throw new Error("找不到这个网站");
      if (site.held) return { value: describe(site) };
      const changed = compose({ ...site, held: { at: Date.now(), by: { userId: text(by?.userId, 128), name: text(by?.name, 64) }, reason: text(reason, 200) } }, intent(site));
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: describe(changed) };
    });
  }

  async release(siteId) {
    return this.#update((sites) => {
      const site = sites.find((item) => item.id === siteId);
      if (!site) throw new Error("找不到这个网站");
      if (!site.held) return { value: describe(site) };
      const changed = compose({ ...site, held: null }, intent(site));
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: describe(changed) };
    });
  }

  // An administrator lets it through: what was found in it is remembered by
  // fingerprint (site-safety.js), so the same values do not wait again; if it
  // was waiting, it goes back to what its owner wanted -- online, unless
  // they took it down meanwhile, or an administrator holds it.
  // `checkId`: the check approved. Only the one the site waits on brings it
  // up; an older one -- refused data, say -- adds what it found to what is let
  // through and leaves a newer wait where it is.
  // `version`: the version the approved check was of -- not necessarily the one
  // up now: approving an older check must not mark a newer, unreviewed version
  // as reviewed (fourth review before .270).
  async approve(siteId, { by, fingerprints = [], aiDigest = null, checkId = null, version = null }) {
    return this.#update((sites) => {
      const site = sites.find((item) => item.id === siteId);
      if (!site) throw new Error("找不到这个网站");
      const before = site.review ?? {};
      // The version reviewed: the check's own -- unless that is an older one than a
      // version already approved here, which it must not take back (fifth review).
      const checked = version ?? site.version;
      const reviewedVersion = checked === site.version || !before.approved?.version ? checked : before.approved.version;
      // `versions`: every version let through that the site still keeps -- since
      // a site can go back to a version, "the newest approved" alone made one
      // already approved wait again (review of phase 0, 2026-10-03). `version`
      // stays as builds before it read it.
      const versions = [...new Set([checked, ...(before.approved?.versions ?? []), ...(before.approved?.version ? [before.approved.version] : [])])]
        .filter((kept) => (site.history ?? [site.version]).includes(kept));
      const approved = { fingerprints: [...new Set([...(before.approved?.fingerprints ?? []), ...fingerprints])].slice(-2000), aiDigest: aiDigest ?? before.approved?.aiDigest ?? null,
        version: reviewedVersion, versions, at: Date.now(), by: { userId: text(by?.userId, 128), name: text(by?.name, 64) } };
      // A site turned down stays turned down: only a new version brings it back (the console refuses a decided check too).
      const awaited = !before.state || (before.state === "pending" && checkId !== null && before.checkId === checkId);
      const changed = compose({ ...site, review: awaited ? { state: null, approved } : { ...site.review, approved } }, intent(site));
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: describe(changed) };
    });
  }

  // A site already up, found -- by checking it again -- to need an
  // administrator: offline and waiting, what its owner wanted kept underneath.
  // `still(site)`: whether it is still the version and audience that were
  // checked; `dataDigest`: the data that was. Either changed -- and the new
  // one was checked when it was put there -- it is left alone ({ stale: true }).
  // Anything else changed meanwhile (collaborators, taken down, held) does not
  // remove what was found: it waits, with that state kept underneath.
  async awaitReview(siteId, { checkId, reason, still = null, dataDigest = undefined }) {
    return this.#update(async (sites) => {
      const site = sites.find((item) => item.id === siteId);
      if (!site) throw new Error("找不到这个网站");
      // Turned down by an administrator: that stands; a check again does not
      // make it wait again, which an approval would then end (sixth review).
      if (site.review?.state === "rejected") return { value: { ...describe(site), stale: true } };
      const dataNow = dataDigest === undefined ? undefined : await this.dataDigest(siteId);
      if ((still && !still(site)) || dataNow !== dataDigest) return { value: { ...describe(site), stale: true } };
      const changed = compose({ ...site, review: { ...(site.review ?? {}), ...pending({ checkId, reason }) } }, intent(site));
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: describe(changed) };
    });
  }

  // An administrator turns it down: it stays offline, and its owner is told why.
  async reject(siteId, { by, reason }) {
    return this.#update((sites) => {
      const site = sites.find((item) => item.id === siteId);
      if (!site) throw new Error("找不到这个网站");
      if (site.review?.state !== "pending") throw new Error("这个网站没有在等待审核");
      const changed = compose({ ...site, review: { ...site.review, state: "rejected", reason: text(reason, 300), at: Date.now(), by: { userId: text(by?.userId, 128), name: text(by?.name, 64) } } }, intent(site));
      return { sites: sites.map((item) => item.id === siteId ? changed : item), value: describe(changed) };
    });
  }

  // The current version's files and the data, as a reader would get them: what
  // a check reads when the version itself does not change (sharing, data,
  // checking again under new rules). `version`: one of the others it keeps
  // instead -- what going back to it would put up, checked as it is read --
  // with its manifest, for the owner to look at before deciding.
  async contents(siteId, version = null) {
    const site = this.get(siteId);
    if (!site) throw new Error("找不到这个网站");
    if (version !== null && version !== site.version) {
      if (!site.history?.includes(version)) throw new Error("这个网站没有保留这一版：只保留最近 3 个版本");
      const { manifest, files } = await this.#intact(siteId, version);
      return { files, data: await this.data(siteId), version, manifest };
    }
    const manifest = JSON.parse((await this.#storage.readFile(siteId, site.version, "manifest.json")).toString("utf8"));
    const files = [];
    for (const file of manifest.files) files.push({ path: file.path, bytes: await this.#storage.readFile(siteId, site.version, stored(file.path)) });
    return { files, data: await this.data(siteId), version: site.version, manifest };
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
  // In turn with the records' changes: a check again compares the data it read
  // with what is there in the same turn it takes the site down.
  async putData(siteId, payload) {
    if (!this.get(siteId)) throw new Error("找不到这个网站");
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length > SITE_LIMITS.dataBytes) throw new Error("这个网站的数据超过了上限");
    return this.#update(async (sites) => {
      if (!sites.some((item) => item.id === siteId)) throw new Error("找不到这个网站");
      // Whether anything a visitor would see actually moved. Since the slice is
      // re-read on a clock, most writes carry the same numbers as the last one,
      // and telling every open page to fetch the whole payload again for that is
      // pure waste. The digest already covers exactly what is shown.
      const before = await this.dataDigest(siteId);
      const digest = payload?.snapshot?.digest ?? null;
      await this.#storage.putData(siteId, body);
      return { value: { bytes: body.length, digest, changed: digest === null || digest !== before } };
    });
  }
  async data(siteId) {
    const bytes = await this.#storage.readData(siteId);
    return bytes ? JSON.parse(bytes.toString("utf8")) : null;
  }
  // The data as stored, unparsed: what the site server sends on, wrapped,
  // without reading thousands of rows into objects and writing them out again
  // for every visitor.
  async dataBytes(siteId) { return this.#storage.readData(siteId); }
  // The digest of the data there now -- what every "is this new data?" asks --
  // read once per write rather than parsing 18 MB each time it is asked.
  async dataDigest(siteId) {
    const stamp = await this.#storage.dataStamp(siteId);
    if (stamp === null) return null;
    const held = this.#digests.get(siteId);
    if (held?.stamp === stamp) return held.digest;
    const digest = (await this.data(siteId))?.snapshot?.digest ?? null;
    if (this.#digests.size >= SITE_LIMITS.sites) this.#digests.clear();
    this.#digests.set(siteId, { stamp, digest });
    return digest;
  }
  // Which write of the data is there now, without reading it: a different
  // value after every write, null when there is none. What the site server
  // keeps what it compressed under, so that a visitor's request does not read
  // 18 MB to find it has already been sent them.
  async dataStamp(siteId) { return this.#storage.dataStamp(siteId); }

  #owned(siteId, ownerId, { notHeld = false } = {}) {
    const site = this.get(siteId);
    if (!site) throw new Error("找不到这个网站");
    if (ownerId && site.ownerId !== ownerId) throw new Error("只有网站的所有者可以改它的设置");
    if (notHeld && site.held) throw new Error(heldText(site));
    return site;
  }

  async #sweep(site) { await this.#storage.sweep(site.id, this.#kept(this.get(site.id) ?? site, site.id)); }

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

// The site as a change was checked against: its version, whether it is up, who
// may see it, what an administrator did to it. A change asked for after a check
// that took minutes is made only while this is still what there is.
// What a review or a hold returns it to is part of it: an owner's 取消发布 on a
// site waiting for review changes only that (fourth review before .270).
export const stampOf = (site) => site ? JSON.stringify([site.version, site.offline === true, site.offlineAt ?? null, site.held?.at ?? null, site.held?.wasOffline === true,
  site.review?.state ?? null, site.review?.checkId ?? null, site.review?.wasOffline === true, site.share ?? null]) : null;
export class SiteConflict extends Error {
  constructor() { super("这个网站在检查期间有了变化（比如取消了发布、管理员下线了它，或者另一次发布先到了），这次的改动没有生效。刷新网站列表后再试。"); this.code = "site_changed"; }
}
export class SiteRefused extends Error {
  constructor() { super("这个账号已经停用，不能再发布或公开网站。"); this.code = "owner_disabled"; }
}
// The records' own check of ownership, on the list a change is made from.
function owned(sites, siteId, ownerId, { notHeld = false } = {}) {
  const site = sites.find((item) => item.id === siteId);
  if (!site) throw new Error("找不到这个网站");
  if (ownerId && site.ownerId !== ownerId) throw new Error("只有网站的所有者可以改它的设置");
  if (notHeld && site.held) throw new Error(heldText(site));
  return site;
}
// A person's own words, set inside a sentence: without the stop they ended on.
const said = (words) => String(words ?? "").trim().replace(/[\s。．.！!？?；;，,、：:]+$/u, "");
const heldText = (site) => `管理员下线了这个网站${said(site.held?.reason) ? `（${said(site.held.reason)}）` : ""}，要恢复请联系管理员。`;
const reviewText = (site) => site.review?.state === "rejected"
  ? `管理员没有通过这个网站的审核${said(site.review.reason) ? `：${said(site.review.reason)}` : ""}。改好后发布新版本，会重新检查。`
  : `这个网站在等待管理员审核${said(site.review?.reason) ? `（${said(site.review.reason)}）` : ""}，通过后自动上线。`;

// When each kept version was first published. Written from this build on; a
// record from before it knows only when its current version went up, and the
// older ones it keeps are shown without a time rather than with a wrong one.
// `version`: the one going up now, at this moment if it has no time yet.
// `null` for one known to have no time: gone back to, it is not the version
// whose going up `publishedAt` says.
function versionTimes(site, history, version) {
  const known = { ...(site?.versionAt ?? {}) };
  if (site?.version && known[site.version] === undefined && typeof site.publishedAt === "number") known[site.version] = site.publishedAt;
  if (version && known[version] === undefined) known[version] = Date.now();
  return Object.fromEntries(history.filter((kept) => typeof known[kept] === "number" || known[kept] === null).map((kept) => [kept, known[kept]]));
}
// A review state, what was approved carried over from before.
const reviewState = (before, next) => (next || before?.approved ? { state: null, ...(before?.approved ? { approved: before.approved } : {}), ...(next ?? {}) } : undefined);
// Whether a site is up comes from three facts: what its owner last wanted,
// whether an administrator holds it, and whether it waits for review or was
// turned down. The record keeps what the owner wanted in a copy for each layer
// on top -- `offline` with nothing on top, `held.wasOffline` under a hold,
// `review.wasOffline` under a review -- because builds before .270 read those
// copies. Each change wrote the copies it thought of, and five rounds of review
// before .270 kept finding a pair that disagreed (a hold during a check again;
// 取消发布 on a held site that waits). So the owner's wish is read from the one
// live copy (intent) and every change is written through compose, which writes
// every copy the same; test/site-states.test.js walks thousands of sequences.
const UP = Object.freeze({ offline: false, at: null });
// The review's copy is the owner's wish whenever a review is open; the hold's
// copy says what a release returns the site to, and while a review is open
// that is down -- which is how .269's release reads it (a release there looks
// at nothing else). Written as the owner's wish under an open review, a
// rollback to .269 put a waiting or turned-down site up on release (sixth
// review before .270).
function intent(site) {
  const copy = site.review?.state ? site.review : site.held ? site.held : null;
  const offline = copy ? copy.wasOffline === true : site.offline === true;
  return { offline, at: offline ? (copy ? copy.wasOfflineAt : site.offlineAt) ?? null : null };
}
function compose(site, wanted, now = Date.now()) {
  const waits = Boolean(site.review?.state);
  const down = wanted.offline || Boolean(site.held) || waits;
  const wantedAt = wanted.offline ? wanted.at ?? now : null;
  const offlineAt = down ? (site.offline ? site.offlineAt ?? now : now) : null;
  const heldDown = wanted.offline || waits;
  return { ...site,
    offline: down, offlineAt,
    ...(site.held ? { held: { ...site.held, wasOffline: heldDown, wasOfflineAt: heldDown ? wantedAt ?? offlineAt : null } } : {}),
    ...(waits ? { review: { ...site.review, wasOffline: wanted.offline, wasOfflineAt: wantedAt } } : {}) };
}
// Whether the site's owner wants it up, whatever holds it down meanwhile.
export const ownerWantsUp = (site) => !intent(site).offline;
const pending = (review) => ({ state: "pending", checkId: review.checkId, reason: text(review.reason, 300), at: Date.now() });
// No longer waiting: what was let through is kept, the rest goes.
const cleared = (review) => review?.state ? { state: null, ...(review.approved ? { approved: review.approved } : {}) } : review;

const describe = (site) => ({
  id: site.id, name: site.name, ownerId: site.ownerId, tenantId: site.tenantId, version: site.version,
  offline: site.offline === true, offlineAt: site.offlineAt ?? null,
  // Taken down by an administrator: when and why. Who did it is the audit
  // trail's to say, and the console's to show.
  held: site.held ? { at: site.held.at, reason: site.held.reason } : null,
  // Waiting for an administrator, or turned down by one: when and why.
  review: site.review?.state ? { state: site.review.state, at: site.review.at ?? null, reason: site.review.reason ?? "" } : null,
  entry: site.entry, bytes: site.bytes, publishedAt: site.publishedAt, createdAt: site.createdAt,
  share: { scope: site.share.scope, inherit: site.share.inherit, members: site.share.members.map((member) => ({ ...member })) },
  source: site.source ? { ...site.source } : null,
  sourced: Boolean(site.source),
  address: site.address ?? null,
});

// A record written by another build, or by hand, is honoured only if this build
// would still accept every part of it.
function readable(site) {
  if (!SITE_ID.test(site?.id ?? "") || typeof site.ownerId !== "string" || !site.ownerId) return false;
  if (typeof site.tenantId !== "string" || !site.tenantId || typeof site.version !== "string" || !/^[0-9a-f]{64}$/.test(site.version)) return false;
  try { parseShare(site.share, { anonymousAllowed: true }); return true; } catch { return false; }
}

export { describe as describeSite };
