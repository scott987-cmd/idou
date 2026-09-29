#!/usr/bin/env node
// A snapshot of the control plane's data directory, taken while it runs.
//
//   node bin/backup.js --data /home/idou/.idou --to /home/idou/backups [--keep 14]
//
// Until this existed the server's data -- scheduled tasks, usage, published
// sites, the keys that sign skills and seal unattended credentials -- was one
// copy on one disk. Copying the files is not a backup of it: the databases run
// in WAL mode, and what was last written sits in their -wal files (2.3 MB of
// the usage ledger, on the server on 2026-09-26), so a copy of the main file
// alone loses it, and a copy of both can be torn mid-write. Each database is
// therefore snapshotted by SQLite itself (VACUUM INTO, one consistent read) and
// the snapshot is checked (quick_check) before the backup counts. Everything
// else is copied with its mode.
//
// A snapshot is written as <name>.partial and renamed when complete, so one cut
// short never looks like a backup. Only the newest --keep are kept.
//
// What is in it is what is in the data directory, secrets included (the
// unattended credentials and the keys beside them): it is created 0700 for the
// user that runs this, the same boundary as the directory it copies. Taking it
// off this machine is the operator's decision, and it should be encrypted first
// (docs/server-deployment.md).
import "../src/adopt-legacy-env.js";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { EITHER, WRITTEN } from "../src/product-names.js";

// Named with the product's name (product-names.js) and the time it was taken;
// those from before the rename count among the newest --keep like any other,
// by their time and not their name.
const SNAPSHOT = new RegExp(`^${EITHER}-(\\d{8}T\\d{9}Z)$`);
const PARTIAL = new RegExp(`^${EITHER}-\\d{8}T\\d{9}Z\\.partial$`);
// Sandbox workspaces of runs in progress: transient, and a run is not resumed
// from them.
const EXCLUDED = new Set(["scheduled-tasks/runs"]);
const SIDE_FILES = /-(?:wal|shm|journal)$/;

function option(argv, name, fallback) {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return value;
}

async function isSqlite(file) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, 16, 0);
    return bytesRead === 16 && header.toString("latin1") === "SQLite format 3\u0000";
  } finally { await handle.close(); }
}

async function digest(file) {
  const hash = createHash("sha256");
  const handle = await open(file, "r");
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); } finally { await handle.close().catch(() => {}); }
  return hash.digest("hex");
}

// One consistent read of a live database, then proof the copy opens whole.
function snapshotDatabase(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true, timeout: 10_000 });
  try { db.prepare("VACUUM INTO ?").run(destination); } finally { db.close(); }
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const rows = copy.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
    if (rows.length !== 1 || rows[0] !== "ok") throw new Error(`${source} 的快照没有通过完整性检查：${rows.join("；").slice(0, 200)}`);
  } finally { copy.close(); }
}

async function copyTree(root, relative, target, files) {
  for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (EXCLUDED.has(name)) continue;
    const from = path.join(root, name), to = path.join(target, name);
    const info = await lstat(from);
    if (info.isDirectory()) {
      await mkdir(to, { mode: info.mode & 0o777 });
      await copyTree(root, name, target, files);
    } else if (info.isFile()) {
      if (SIDE_FILES.test(entry.name)) continue;
      if (await isSqlite(from)) snapshotDatabase(from, to);
      else await copyFile(from, to);
      await chmod(to, info.mode & 0o777);
      files.push({ path: name, kind: (await isSqlite(to)) ? "sqlite" : "file", bytes: (await stat(to)).size, sha256: await digest(to) });
    }
    // A socket, a fifo or a link is not data this directory keeps; it is left out.
  }
}

export async function backup({ data, to, keep = 14, now = new Date() }) {
  if (typeof data !== "string" || typeof to !== "string") throw new Error("用法：node bin/backup.js --data <数据目录> --to <备份目录> [--keep 14]");
  if (!path.isAbsolute(data) || !path.isAbsolute(to)) throw new Error("--data 和 --to 都要用绝对路径");
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 365) throw new Error("--keep 只能是 1 到 365 之间的整数");
  const source = path.resolve(data), root = path.resolve(to);
  if (root === source || root.startsWith(`${source}${path.sep}`)) throw new Error("备份不能放在数据目录里面");
  if (!(await stat(source)).isDirectory()) throw new Error(`${source} 不是目录`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})/, "$1");
  const name = `${WRITTEN}-${stamp}`;
  if (!SNAPSHOT.test(name)) throw new Error(`unexpected snapshot name ${name}`);
  const partial = path.join(root, `${name}.partial`), final = path.join(root, name);
  await mkdir(partial, { mode: 0o700 });
  const files = [];
  try {
    await copyTree(source, "", partial, files);
    await writeFile(path.join(partial, "backup.json"), `${JSON.stringify({ createdAt: now.toISOString(), source, files }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(partial, final);
  } catch (error) { await rm(partial, { recursive: true, force: true }); throw error; }
  // The newest `keep` stay. Only this tool's own directories are ever removed,
  // and a partial one only if it is not the snapshot just made.
  const entries = await readdir(root);
  const snapshots = entries.filter((entry) => SNAPSHOT.test(entry))
    .sort((a, b) => SNAPSHOT.exec(a)[1].localeCompare(SNAPSHOT.exec(b)[1]) || a.localeCompare(b));
  const removed = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const entry of [...removed, ...entries.filter((entry) => PARTIAL.test(entry))]) await rm(path.join(root, entry), { recursive: true, force: true });
  return { snapshot: final, files, removed };
}

// Run as a command, compared by real path: on the server it is started as
// /opt/idou/app/bin/backup.js, and /opt/idou/app is a link to the
// release. Compared as written, the two paths differed, and the timer's first
// run did nothing and exited 0 (2026-09-26).
const invoked = (() => { try { return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; } })();
if (invoked) {
  const argv = process.argv.slice(2);
  try {
    const keep = Number(option(argv, "--keep", "14"));
    const result = await backup({ data: option(argv, "--data"), to: option(argv, "--to"), keep });
    const databases = result.files.filter((file) => file.kind === "sqlite").length;
    const bytes = result.files.reduce((sum, file) => sum + file.bytes, 0);
    process.stdout.write(`备份完成：${result.snapshot}，${result.files.length} 个文件（其中 ${databases} 个数据库，都通过了完整性检查），共 ${(bytes / 1048576).toFixed(1)} MB；保留最近 ${keep} 份，删除了 ${result.removed.length} 份更早的。\n`);
  } catch (error) {
    process.stderr.write(`备份失败：${error.message}\n`);
    process.exitCode = 1;
  }
}
