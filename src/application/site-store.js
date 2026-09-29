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
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { relocatedAccountPath } from "./account-paths.js";
import { parseSlice, sliceId } from "./table-slice.js";

const NAME = /^[^\u0000-\u001f\\/:*?"<>|]{1,80}$/;
export const SITE_LIMIT = 200;

const clean = (value, fallback) => {
  const name = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  return NAME.test(name) ? name : fallback;
};

export class SiteStore {
  #file; #root; #sites;
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
    const folder = at ?? path.join(this.#root, id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const site = { id, name: clean(name, clean(title, "未命名网站")), folder,
      slice: parsed ? plain(parsed) : null, sliceId: parsed ? sliceId(parsed) : null,
      createdAt: Date.now(), lastReadAt: null, rowCount: 0, digest: null, truncated: false,
      publishedId: null, url: null, publishedScope: null, publishedInherit: false, publishedOffline: false, publishedAt: null };
    await this.#save([...this.#sites, site]);
    return { ...site };
  }

  // What one read of the slice left behind. Only ever facts about the read: a
  // site's definition is changed by the person, not by a refresh.
  async recordRead(id, { readAt, rowCount, digest, truncated = false }) {
    const site = this.get(id);
    if (!site.slice) throw new Error("这个网站没有接表格，没有可记录的读取");
    await this.#save(this.#sites.map((item) => item.id === id
      ? { ...item, lastReadAt: readAt ?? Date.now(), rowCount: Number(rowCount) || 0, digest: typeof digest === "string" ? digest : null, truncated: truncated === true }
      : item));
    return { ...site, lastReadAt: readAt ?? Date.now(), rowCount, digest, truncated };
  }

  // Where this site is published, and under what sharing. Kept here so the list
  // can show the link and the scope without asking the server on every draw.
  async recordPublish(id, { publishedId = null, url = null, scope = null, inherit = false, offline = false } = {}) {
    this.get(id);
    await this.#save(this.#sites.map((item) => item.id !== id ? item
      : { ...item, publishedId: publishedId || null, url: url || null, publishedScope: scope || null, publishedInherit: inherit === true,
        publishedOffline: offline === true, publishedAt: publishedId ? Date.now() : null }));
    return this.get(id);
  }

  async rename(id, name) {
    const site = this.get(id);
    await this.#save(this.#sites.map((item) => item.id === id ? { ...item, name: clean(name, site.name) } : item));
  }

  // Forgetting a site never deletes its folder: the page somebody wrote is
  // theirs, and a list entry is not the work.
  async forget(id) {
    this.get(id);
    await this.#save(this.#sites.filter((item) => item.id !== id));
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
