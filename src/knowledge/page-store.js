// How the local knowledge copy sits on disk.
//
// It used to be one encrypted file holding every page, so reading one new
// document rewrote the whole thing: at a thousand documents that is 18.5 MiB
// written to record one arrival, and it grows with the store. Now each document
// is its own encrypted file and a small manifest -- kept at the original path,
// so nothing else has to know where the pages went -- says which files count
// right now.
//
// Two properties are worth more than the saved bytes, and both are kept:
// a change becomes visible in one rename (the manifest), so a crash leaves the
// previous set intact rather than half of the next one; and removing a document
// takes its bytes off this disk, rather than leaving them inside a blob nobody
// rewrites until the next change.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from "node:fs/promises";
import path from "node:path";

// How many page files are read at once on startup. Beyond this the operating
// system is queueing anyway, and a thousand open files is not a courtesy.
const CONCURRENCY = 32;
const PAGE_FILE = /^[0-9a-f]{64}\.enc$/;
const fileFor = (owner) => `${createHash("sha256").update(String(owner)).digest("hex")}.enc`;
// The manifest is rewritten on every change, so it holds as little as it can:
// which documents are live, how big each one is, and a short digest of the state
// each was written at. The file name is not stored -- it is the owner's digest.
const stamp = (state) => createHash("sha256").update(String(state)).digest("hex").slice(0, 16);

async function eachLimited(items, limit, run) {
  const out = new Array(items.length);
  let at = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (at < items.length) { const index = at; at += 1; out[index] = await run(items[index]); }
  }));
  return out;
}

export class PageStore {
  constructor({ filename, cipher, maxBytes }) {
    this.filename = filename; this.directory = `${filename}.d`; this.cipher = cipher; this.maxBytes = maxBytes;
    // What is on disk right now, per page: its file, its encrypted size, and
    // the state it was written at -- which is how a save knows what it does not
    // have to write again.
    this.known = new Map();
    this.manifestBytes = 0;
  }
  pageFile(owner) { return path.join(this.directory, fileFor(owner)); }
  // The stored pages, or null when this machine holds none yet. A page file that
  // cannot be read is skipped and counted rather than failing the whole copy:
  // losing one document to a bad sector is a document to re-read, losing the
  // store is a person's whole knowledge copy.
  async read() {
    let manifest;
    try { manifest = await this.readManifest(); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (manifest.version === 1) {
      // The single-file layout this replaced. Its pages are returned as they
      // are; the caller writes them back in the new layout.
      if (!Array.isArray(manifest.pages)) throw new Error("Invalid knowledge format");
      return { pages: manifest.pages, unreadable: 0, legacy: true, gone: [] };
    }
    if (manifest.version !== 2 || !Array.isArray(manifest.pages)) throw new Error("Invalid knowledge format");
    const entries = manifest.pages.filter((entry) => typeof entry?.owner === "string" && entry.owner);
    if (entries.length !== manifest.pages.length) throw new Error("Invalid knowledge format");
    const read = await eachLimited(entries, CONCURRENCY, async (entry) => {
      try {
        const bytes = await readFile(this.pageFile(entry.owner));
        const page = JSON.parse(await this.cipher.decrypt(bytes));
        // The file says which document it is; the manifest only says which files
        // are live. A file that disagrees is not this page.
        if (page?.owner !== entry.owner) return null;
        return { page, bytes: bytes.length };
      } catch { return null; }
    });
    const pages = [];
    this.known.clear();
    let unreadable = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const found = read[index];
      if (!found) { unreadable += 1; continue; }
      pages.push(found.page);
      this.known.set(entries[index].owner, { file: fileFor(entries[index].owner), bytes: found.bytes, state: entries[index].state ?? null });
    }
    // What left the copy without the person removing it, kept with the set it
    // left, so a restart still says what happened.
    const gone = Array.isArray(manifest.gone) ? manifest.gone.filter((item) => item && typeof item.title === "string" && typeof item.reason === "string") : [];
    return { pages, unreadable, legacy: false, gone };
  }
  async readManifest() {
    const info = await stat(this.filename);
    if (info.size > this.maxBytes) throw new Error("Knowledge file exceeds budget");
    this.manifestBytes = info.size;
    return JSON.parse(await this.cipher.decrypt(await readFile(this.filename)));
  }
  // Persist exactly this set of pages. `stateOf` says what a stored page is, so
  // that a page nobody changed is not re-encrypted; `beforeCommit` runs in the
  // moment before the new set becomes visible, which is where a caller holding a
  // lease checks that it still holds it.
  // Returns the pages actually kept: the byte budget is enforced here, by
  // dropping from the end of the list the caller ordered.
  // `gone` is what the caller already knows is leaving and why; pages that do not
  // fit the byte budget are added to it here, where that is decided, so that the
  // record of what was dropped is committed by the same rename as the drop.
  async write(pages, { signal = null, beforeCommit = null, stateOf = () => "", gone = [], note = null } = {}) {
    signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const written = new Map(), kept = [];
    let total = 0;
    for (const page of pages) {
      const known = this.known.get(page.owner);
      const state = stateOf(page);
      const digest = stamp(state);
      let bytes = known && known.state === digest ? known.bytes : null;
      let body = null;
      if (bytes === null) {
        body = await this.cipher.encrypt(JSON.stringify(page));
        bytes = body.length;
      }
      // The budget covers the pages plus the manifest; passing it stops the
      // list here rather than dropping something in the middle, because the
      // caller ordered these by what it is willing to lose last.
      if (total + bytes + this.manifestEstimate(kept.length + 1) > this.maxBytes) break;
      total += bytes;
      kept.push(page);
      written.set(page.owner, { file: fileFor(page.owner), bytes, state: digest, body });
    }
    if (!kept.length && pages.length) throw new Error("本机知识配额不足");
    const record = [...gone];
    if (note) for (const page of pages.slice(kept.length)) record.push(note(page, "bytes"));
    // New and changed pages first: a page file that nothing points at yet is
    // invisible, while a manifest pointing at a file that is not there yet is a
    // broken store.
    for (const [owner, entry] of written) {
      if (!entry.body) continue;
      signal?.throwIfAborted();
      await this.replace(path.join(this.directory, entry.file), entry.body);
      entry.body = null;
      this.known.set(owner, { file: entry.file, bytes: entry.bytes, state: entry.state });
    }
    const manifest = await this.cipher.encrypt(JSON.stringify({ version: 2,
      pages: kept.map((page) => ({ owner: page.owner, bytes: written.get(page.owner).bytes, state: written.get(page.owner).state })),
      gone: record }));
    signal?.throwIfAborted();
    if (beforeCommit) await beforeCommit();
    await this.replace(this.filename, manifest);
    this.manifestBytes = manifest.length;
    // Whatever the new manifest no longer names is gone: its bytes leave this
    // disk now, not at some later rewrite.
    for (const owner of [...this.known.keys()]) {
      if (written.has(owner)) continue;
      const entry = this.known.get(owner);
      this.known.delete(owner);
      await unlink(path.join(this.directory, entry.file)).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    await this.sweep();
    return { kept, gone: record };
  }
  // A crash between writing a page file and committing the manifest leaves a
  // file nothing points at. It is removed the next time the store is written,
  // so an interrupted save costs disk space until then and never correctness.
  async sweep() {
    const live = new Set([...this.known.values()].map((entry) => entry.file));
    let names;
    try { names = await readdir(this.directory); } catch { return; }
    for (const name of names) {
      if (!PAGE_FILE.test(name) || live.has(name)) continue;
      await unlink(path.join(this.directory, name)).catch(() => {});
    }
  }
  async replace(target, body) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  // Roughly what the manifest costs, so the budget covers it before the pages
  // are written rather than after.
  manifestEstimate(count) { return 64 + count * 80; }
  // Everything this store owns, for a caller that has to say how much room the
  // copy takes.
  bytes() { return this.manifestBytes + [...this.known.values()].reduce((total, entry) => total + entry.bytes, 0); }
}
