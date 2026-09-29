import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { applicationRoot, readReleaseManifest, readReleaseManifestSync } from "./release-manifest.js";

// What decides whether an executable is the reviewed one is its bytes. A version
// string is what the executable says about itself, so a replacement that prints
// the right version passes any check built on it -- which is exactly the
// replacement worth worrying about.
//
// `upstreams.lock.json` is the one place those bytes are written down. The
// desktop app, the packaging script and the sandbox image all read it, so a
// version bump is one edit and a mismatch anywhere is a refusal, not a drift.

export { applicationRoot };

// Runtime selection is made from the signed cross-component release, not from
// a mutable lock by itself. The lock remains the reviewed build input; signing
// proves which exact lock, app version, licenses and sandbox digests form one
// approved rollback unit.
export async function readPins(root) { return (await readReleaseManifest(root)).upstreams; }
export function readPinsSync() { return readReleaseManifestSync().upstreams; }

// Node's names (`linux-x64`), not Docker's (`linux/amd64`): the resources
// directory and the lock are keyed the way the runtime that reads them spells
// its own platform.
export const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

// Streamed: the Codex binary alone is 220 MB.
export async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// Finder drops these into any directory it has shown. They are never executed.
const IGNORED = new Set([".DS_Store"]);

// Every regular file under `root`. A symbolic link is refused rather than
// followed: it is a way to give a reviewed name to bytes nobody reviewed.
async function filesUnder(root, prefix = "") {
  const found = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await filesUnder(root, name));
    else if (entry.isFile()) found.push(name);
    else throw new Error(`${name} 不是普通文件`);
  }
  return found;
}

// The tree has to be exactly what the lock lists: nothing missing, nothing
// added. A library dropped beside a reviewed binary is loaded by it, so an extra
// file is as much a tampering as a changed one.
//
// `cache` remembers, per tree, the file metadata of the last run that hashed it.
// A later call hashes again only when some file's inode, size, mtime or ctime has
// moved -- and ctime cannot be set back by an ordinary process, so a write the
// cache would miss is not one this machine lets an unprivileged program make.
// That is what makes checking before every launch affordable.
export async function verifyTree(root, expected, { cache = null } = {}) {
  const wanted = Object.keys(expected ?? {}).sort();
  if (wanted.length === 0) throw new Error("发布清单没有列出任何文件");
  let present;
  try { present = (await filesUnder(root)).sort(); }
  catch (error) { throw new Error(error.code === "ENOENT" ? `${root} 不存在` : error.message); }
  const missing = wanted.filter((name) => !present.includes(name));
  if (missing.length) throw new Error(`缺少 ${missing.join("、")}`);
  const extra = present.filter((name) => !Object.hasOwn(expected, name));
  if (extra.length) throw new Error(`发布清单之外的文件 ${extra.join("、")}`);
  const fingerprint = (await Promise.all(wanted.map(async (name) => {
    const seen = await lstat(path.join(root, name));
    return [name, seen.dev, seen.ino, seen.size, seen.mtimeMs, seen.ctimeMs, seen.mode].join(":");
  }))).join("\n");
  if (cache?.get(root) === fingerprint) return wanted.length;
  for (const name of wanted) {
    if (await fileDigest(path.join(root, name)) !== expected[name]) throw new Error(`${name} 的摘要与发布清单不符`);
  }
  cache?.set(root, fingerprint);
  return wanted.length;
}
