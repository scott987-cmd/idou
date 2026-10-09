// The sites a person keeps, in this account's own data. A site is not a task:
// it outlives the conversation that made it, and it is the thing that later
// gets published for other people. So it has its own list, its own folder and
// its own section, while the coding task stays what it is -- where the page
// itself is written.
//
// Two kinds, one shape. A site built on a table carries a slice, is re-read on
// a schedule, and its numbers follow the table (table-slice.js). A site that is
// just files -- a small game somebody wrote on a Sunday -- carries no slice at
// all and is never read from Feishu. Everything else about them is the same:
// a folder, a name, and eventually who may open it. Making the slice optional
// is what keeps the section from being two sections.
//
// Kept deliberately small. What a site *is* lives here; how a slice is read
// lives in table-snapshot.js, and what may be shown lives in table-slice.js.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { relocatedAccountPath } from "./account-paths.js";
import { parseSlice, sliceId } from "./table-slice.js";

const NAME = /^[^\u0000-\u001f\\/:*?"<>|]{1,80}$/;
export const SITE_LIMIT = 200;

const clean = (value, fallback) => {
  const name = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  return NAME.test(name) ? name : fallback;
};
// The name a site will be given, known before it is made: a table site's data is
// read first and carries this as its title (main.js site-create).
export const siteName = (name, title = "") => clean(name, clean(title, "未命名网站"));

export class SiteStore {
  #file; #root; #sites; #queue = Promise.resolve();
  constructor(file, root, sites) { this.#file = file; this.#root = root; this.#sites = sites; }

  static async open(file, root) {
    let sites = [];
    try {
      const stored = JSON.parse(await readFile(file, "utf8"));
      if (stored?.version === 1 && Array.isArray(stored.sites)) sites = stored.sites.filter(valid);
    } catch (error) { if (error?.code !== "ENOENT") sites = []; }
    // A site's folder inside the account's own data, recorded before the
    // account's directory was renamed: its refresh went on writing into a
    // recreated copy of the old directory (account-paths.js).
    let moved = false;
    for (const [index, site] of sites.entries()) {
      const folder = relocatedAccountPath(site.folder, path.dirname(file));
      if (!folder || !await stat(folder).then((entry) => entry.isDirectory(), () => false)) continue;
      sites[index] = { ...site, folder }; moved = true;
    }
    const store = new SiteStore(file, root, sites);
    // Kept so the next start does not have to work it out again; a write that
    // fails is only repeated then.
    if (moved) await store.#save(sites).catch(() => {});
    return store;
  }

  list() { return this.#sites.map(copy); }
  get(id) { const site = this.#sites.find((item) => item.id === id); if (!site) throw new Error("找不到这个网站"); return copy(site); }

  // A new site: its own folder under the account's data, so a coding task can
  // be opened on it later without anyone choosing a directory first. With no
  // slice it is a site made of files only, and nothing is ever read for it.
  // `at` adopts a directory that already exists instead of making one: a page
  // written in a coding task is already somewhere, and copying it would leave
  // two copies to keep in step -- the next turn of that task would edit one of
  // them and publish the other.
  async create({ name, slice = null, title = "", at = null }) {
    if (this.#sites.length >= SITE_LIMIT) throw new Error(`最多 ${SITE_LIMIT} 个网站，请先删掉不用的`);
    const parsed = slice ? parseSlice(slice) : null;
    const id = randomUUID();
    if (at !== null && (typeof at !== "string" || !path.isAbsolute(at))) throw new Error("网站目录要用绝对路径");
    if (at && this.#sites.some((site) => site.folder === at)) throw new Error("这个目录已经是一个网站了");
    // Named for the site as well as its id: a coding task on it shows its
    // folder's name as the project's, and an id alone read as noise there.
    const folder = at ?? path.join(this.#root, folderName(siteName(name, title), id));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const site = { id, name: siteName(name, title), folder,
      slice: parsed ? plain(parsed) : null, sliceId: parsed ? sliceId(parsed) : null,
      createdAt: Date.now(), lastReadAt: null, rowCount: 0, digest: null, truncated: false,
      publishedId: null, url: null, publishedScope: null, publishedInherit: false, publishedOffline: false, publishedAt: null };
    await this.#update((sites) => {
      if (sites.length >= SITE_LIMIT) throw new Error(`最多 ${SITE_LIMIT} 个网站，请先删掉不用的`);
      if (at && sites.some((item) => item.folder === at)) throw new Error("这个目录已经是一个网站了");
      return [...sites, site];
    });
    return { ...site };
  }

  // What one read of the slice left behind. Only ever facts about the read: a
  // site's definition is changed by the person, not by a refresh.
  // `probe` is what the table said of itself just before (table-snapshot.js
  // probeBaseSlice), for the next refresh to compare instead of reading again;
  // `probeBefore`, what it said before the read before; `probeMissed`, that it
  // once said nothing had moved when something had (site-refresh.js).
  // `key`: what the read wrote, schema and all (table-snapshot.js contractKey).
  // `reader`: which reader made it (table-snapshot.js READER).
  async recordRead(id, { readAt, rowCount, digest, key = null, truncated = false, probe = null, probeBefore = null, probeMissed = false, reader = null }) {
    const site = this.get(id);
    if (!site.slice) throw new Error("这个网站没有接表格，没有可记录的读取");
    const at = readAt ?? Date.now();
    const text = (value) => typeof value === "string" && value ? value : null;
    const read = { lastReadAt: at, fullReadAt: at, rowCount: Number(rowCount) || 0, digest: typeof digest === "string" ? digest : null, key: text(key),
      truncated: truncated === true, probe: text(probe), probeBefore: text(probeBefore), probeMissed: probeMissed === true,
      reader: Number.isSafeInteger(reader) ? reader : null };
    await this.#update((sites) => sites.map((item) => item.id === id ? { ...item, ...read } : item));
    return { ...site, ...read };
  }

  // A refresh that asked and found the table as it was: nothing read, so only
  // when it was last looked at moves -- the next one is due from here.
  async recordCheck(id, at = Date.now()) {
    const site = this.get(id);
    await this.#update((sites) => sites.map((item) => item.id === id ? { ...item, lastReadAt: at } : item));
    return { ...site, lastReadAt: at };
  }

  // What the server was last given of this site's data (its contractKey), so
  // the same data is not sent again -- and data that did not get there is.
  async recordPushed(id, key) {
    this.get(id);
    await this.#update((sites) => sites.map((item) => item.id === id ? { ...item, pushedKey: typeof key === "string" && key ? key : null } : item));
    return this.get(id);
  }

  // Where this site is published, and under what sharing. Kept here so the list
  // can show the link and the scope without asking the server on every draw.
  async recordPublish(id, { publishedId = null, url = null, scope = null, inherit = false, offline = false } = {}) {
    this.get(id);
    await this.#update((sites) => sites.map((item) => item.id !== id ? item
      : { ...item, publishedId: publishedId || null, url: url || null, publishedScope: scope || null, publishedInherit: inherit === true,
        publishedOffline: offline === true, publishedAt: publishedId ? Date.now() : null, publishingId: null }));
    return this.get(id);
  }

  // What the server says of a published site, written over what this desktop
  // last did to it: an administrator's approval or hold, a change whose answer
  // never came. Only these three; when it went up, and its link, stay.
  async recordServer(id, { offline, scope, inherit }) {
    this.get(id);
    await this.#update((sites) => sites.some((item) => item.id === id && (item.publishedOffline !== (offline === true) || item.publishedScope !== (scope ?? item.publishedScope) || item.publishedInherit !== (inherit === true)))
      ? sites.map((item) => item.id === id ? { ...item, publishedOffline: offline === true, publishedScope: scope ?? item.publishedScope, publishedInherit: inherit === true } : item) : null);
    return this.get(id);
  }

  // The id a first publish goes out under, chosen here and kept before it is
  // sent. A publish the app stopped waiting for -- it took too long, the app
  // quit -- may still have gone up; the next one then goes out under the same
  // id and updates that site instead of putting up a second, and the list
  // finds it on the server (main.js, "sites"). Cleared once it is known to be up.
  async recordPublishing(id) {
    this.get(id);
    await this.#update((sites) => sites.some((item) => item.id === id && !item.publishedId && !item.publishingId)
      ? sites.map((item) => item.id === id ? { ...item, publishingId: randomUUID() } : item) : null);
    return this.get(id);
  }

  async rename(id, name) {
    this.get(id);
    await this.#update((sites) => sites.map((item) => item.id === id ? { ...item, name: clean(name, item.name) } : item));
  }

  // Out of this computer's list while it stays up (docs/sites-phase0.md §0.5):
  // the record stays as it is -- folder, slice, published id -- so the site is
  // still refreshed and followed, and comes back exactly as it was. A build
  // that does not know the flag shows it again, which loses nothing.
  async setHidden(id, hidden) {
    const site = this.get(id);
    if (hidden === true && !site.publishedId) throw new Error("这个网站还没有发布：没有发布的网站直接「移出列表」。");
    await this.#update((sites) => sites.map((item) => {
      if (item.id !== id) return item;
      const { hidden: _was, ...rest } = item;
      return hidden === true ? { ...rest, hidden: true } : rest;
    }));
    return { hidden: hidden === true };
  }

  // Forgetting a site never deletes its folder: the page somebody wrote is
  // theirs, and a list entry is not the work.
  // The folder of a site this store made itself, or null: a folder directly
  // under the store's root, as both resolve on disk, and not a link. A site
  // joined from a folder of the person's own (create({ at })) has none --
  // deleting it would delete their project, so it can only be forgotten
  // (main.js site-delete).
  async ownedFolder(id) {
    const site = this.get(id);
    try {
      if ((await lstat(site.folder)).isSymbolicLink()) return null;
      const [root, folder] = await Promise.all([realpath(this.#root), realpath(site.folder)]);
      return path.dirname(folder) === root && folder !== root ? folder : null;
    } catch { return null; }
  }

  async forget(id) {
    this.get(id);
    await this.#update((sites) => sites.filter((item) => item.id !== id));
  }

  // One write after another, each from the list as it is when its turn comes:
  // two at once -- a refresh's record and a publish's id, say -- each wrote the
  // whole list from what it had read, and the later one lost the other's change
  // (found in review before .270: a first publish's kept id could be lost so).
  // `change(sites)` returns the new list, or null for nothing to write.
  #update(change) {
    const turn = this.#queue.then(async () => { const next = change(this.#sites); if (next) await this.#save(next); });
    this.#queue = turn.catch(() => {});
    return turn;
  }

  async #save(sites) {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, sites }), { mode: 0o600, flag: "wx" });
      await rename(temporary, this.#file);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    this.#sites = sites;
  }
}

// A folder name from a site's name: letters and digits of any script, - and _,
// at most 40 of them, and the start of its id so that two sites of one name
// are two folders. Never a name the file system treats specially.
const folderName = (name, id) => {
  const word = String(name).normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return word ? `${word}-${id.slice(0, 8)}` : id;
};

// A slice as it is stored: the parsed object without the frozen arrays, so a
// reload of the file produces exactly what was written.
const plain = (slice) => JSON.parse(JSON.stringify(slice));
const copy = (site) => ({ ...site, slice: site.slice ? { ...site.slice } : null });

// A record written by an older or a newer build, or by hand, is only honoured
// when it still names a slice this build would accept.
function valid(site) {
  if (typeof site?.id !== "string" || !site.id || typeof site.folder !== "string" || !path.isAbsolute(site.folder)) return false;
  if (typeof site.name !== "string" || !NAME.test(site.name)) return false;
  if (site.slice === null || site.slice === undefined) return true;
  try { parseSlice(site.slice); return true; } catch { return false; }
}
