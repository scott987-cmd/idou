#!/usr/bin/env node
// A snapshot of the control plane's data directory, taken while it runs.
//
//   node bin/backup.js --data /home/idou/.idou --to /home/idou/backups [--keep 14]
//     [--postgres <IDOU_DATABASE_URL>]   the shared database too (pg_dump)
//     [--postgres-env IDOU_DATABASE_URL] the same, the address read from that
//                                        variable: not on any command line
//     [--also /etc/idou/state.key]       a file from outside it (repeatable)
//     [--seal <operator's public key>]   and a sealed copy to take elsewhere
//     [--ship <executable>]              which that program is handed
//
//   node bin/backup.js --drill <snapshot directory | sealed file> [--key <private key>]
//   node bin/backup.js --open <sealed file> --key <private key> --into <new directory>
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
// user that runs this, the same boundary as the directory it copies. A copy on
// the same disk survives a mistake, not the disk. What leaves the machine is
// the sealed copy (--seal, backup-seal.js): the server holds only the
// operator's public key, so it cannot read back what it sealed, and neither can
// whoever holds the copy. Where it goes is the operator's --ship program's
// business -- a bucket, another machine -- so this knows no destination.
//
// A backup nobody has restored is a hope. --drill is the restore without the
// switch-over: on the machine with the private key, the sealed copy is opened
// into a temporary directory and every file checked against the manifest,
// every database opened and checked, the database dump listed.
import "../src/adopt-legacy-env.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { EITHER, WRITTEN } from "../src/product-names.js";
import { SEALED_SUFFIX, openSealed, readPem, sealDirectory } from "../src/control-plane/backup-seal.js";
import { BACKUP_STATUS } from "../src/control-plane/health-monitor.js";

const run = promisify(execFile);

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
function options(argv, name) {
  return argv.flatMap((value, at) => (value === name ? [argv[at + 1]] : [])).map((value) => {
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
    return value;
  });
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

// The shared database, as its own tool dumps it (custom format), and proof
// the dump reads back (its table of contents). Custom format so a restore can
// pick tables and run in parallel. Its rows stay sealed with the state key
// (state-store.js): a dump without that key restores ciphertext -- which is
// what --also is for.
// The address's password goes to pg_dump in its environment, never on its
// command line: an argument is visible to every account on the machine (ps),
// and Node puts the whole command line in the error when pg_dump is killed or
// times out -- which then went to status.json, the 备份 check, the console
// and the administrators' alerts (found in review, 2026-10-03).
// Taken apart by text, not by URL: libpq accepts addresses a URL parser does
// not (a user and a socket, `postgresql://idou@/db?host=/run/postgresql`;
// several hosts). Only the password moves -- from the user part or a
// `password=` parameter -- and everything else reaches pg_dump as written.
export function postgresTarget(url) {
  let dbname = String(url), password = null;
  // To the last "@" before the path: a password may hold an unencoded "@", as the server's client reads it.
  const inUser = /^(postgres(?:ql)?:\/\/[^:@/?#]*):([^/?#]*)@/i.exec(dbname);
  if (inUser) { password = inUser[2]; dbname = `${inUser[1]}@${dbname.slice(inUser[0].length)}`; }
  const inQuery = /([?&])password=([^&#]*)&?/i.exec(dbname);
  if (inQuery) {
    password = inQuery[2];
    dbname = `${dbname.slice(0, inQuery.index)}${inQuery[0].endsWith("&") ? inQuery[1] : ""}${dbname.slice(inQuery.index + inQuery[0].length)}`;
  }
  const decode = (value) => { try { return decodeURIComponent(value); } catch { return value; } };
  return { dbname, env: password ? { PGPASSWORD: decode(password) } : {} };
}
// What any error is allowed to say: no address with its credentials in it.
export const withoutCredentials = (text) => String(text ?? "").replace(/\b(postgres(?:ql)?:\/\/)[^\s"']*/gi, "$1…");
async function dumpPostgres(url, file, bin) {
  const tool = (name) => (bin ? path.join(bin, name) : name);
  const target = postgresTarget(url);
  try { await run(tool("pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", "--file", file, "--dbname", target.dbname], { timeout: 3_600_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...target.env } }); }
  catch (error) {
    const said = error?.stderr ? String(error.stderr) : error?.killed || error?.signal ? `被终止（${error.signal ?? "超时"}）` : error?.code === "ENOENT" ? "找不到 pg_dump" : `退出码 ${error?.code ?? "未知"}`;
    throw new Error(`pg_dump 没有完成：${withoutCredentials(said).trim().slice(0, 300)}`);
  }
  await listDump(file, bin);
}
async function listDump(file, bin) {
  try { await run(bin ? path.join(bin, "pg_restore") : "pg_restore", ["--list", file], { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("没有 pg_restore，核对不了数据库转储：装上 PostgreSQL 客户端，或用 --pg-bin 指向它");
    throw new Error(`数据库转储读不回来：${String(error?.stderr || error?.message).trim().slice(0, 300)}`);
  }
}

async function executable(file, what) {
  if (!path.isAbsolute(file)) throw new Error(`${what}要用绝对路径`);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error(`${what}不存在：${file}`);
  await access(file, fsConstants.X_OK).catch(() => { throw new Error(`${what}不可执行：${file}`); });
}

export async function backup({ data, to, keep = 14, now = new Date(), postgres = null, pgBin = null, also = [], seal = null, ship = null }) {
  if (typeof data !== "string" || typeof to !== "string") throw new Error("用法：node bin/backup.js --data <数据目录> --to <备份目录> [--keep 14]");
  if (!path.isAbsolute(data) || !path.isAbsolute(to)) throw new Error("--data 和 --to 都要用绝对路径");
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 365) throw new Error("--keep 只能是 1 到 365 之间的整数");
  const source = path.resolve(data), root = path.resolve(to);
  if (root === source || root.startsWith(`${source}${path.sep}`)) throw new Error("备份不能放在数据目录里面");
  if (!(await stat(source)).isDirectory()) throw new Error(`${source} 不是目录`);
  // Everything that can be wrong about the settings is found before anything is written.
  const extras = [];
  for (const file of also) {
    if (!path.isAbsolute(file)) throw new Error(`--also 要用绝对路径：${file}`);
    if (!(await lstat(file).catch(() => null))?.isFile()) throw new Error(`--also 指的不是普通文件：${file}`);
    if (extras.some((extra) => path.basename(extra) === path.basename(file))) throw new Error(`--also 有两个同名文件：${path.basename(file)}`);
    extras.push(file);
  }
  const publicKeyPem = seal ? await readPem(seal, "备份公钥") : null;
  if (ship && !seal) throw new Error("--ship 只送加密后的备份：同时要给 --seal");
  if (ship) await executable(ship, "--ship 指定的程序");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})/, "$1");
  const name = `${WRITTEN}-${stamp}`;
  if (!SNAPSHOT.test(name)) throw new Error(`unexpected snapshot name ${name}`);
  const partial = path.join(root, `${name}.partial`), final = path.join(root, name);
  await mkdir(partial, { mode: 0o700 });
  const files = [];
  try {
    await copyTree(source, "", partial, files);
    if (extras.length) {
      await mkdir(path.join(partial, "extra"), { mode: 0o700 });
      for (const file of extras) {
        const name = `extra/${path.basename(file)}`, copy = path.join(partial, name);
        await copyFile(file, copy);
        await chmod(copy, (await stat(file)).mode & 0o777);
        files.push({ path: name, kind: "file", from: file, bytes: (await stat(copy)).size, sha256: await digest(copy) });
      }
    }
    if (postgres) {
      const dump = path.join(partial, "postgres.dump");
      await dumpPostgres(postgres, dump, pgBin);
      await chmod(dump, 0o600);
      files.push({ path: "postgres.dump", kind: "postgres", bytes: (await stat(dump)).size, sha256: await digest(dump) });
    }
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
  // The sealed copy, kept beside the snapshots under the same rule, and handed
  // to the operator's program. A copy that could not be shipped fails the run
  // -- the timer's unit shows it -- and stays, as the snapshot does.
  let sealed = null;
  if (publicKeyPem) {
    const outbox = path.join(root, "sealed");
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    sealed = await sealDirectory({ root, name, publicKeyPem, file: path.join(outbox, `${name}${SEALED_SUFFIX}`), now });
    const kept = (await readdir(outbox)).filter((entry) => entry.endsWith(SEALED_SUFFIX) && SNAPSHOT.test(entry.slice(0, -SEALED_SUFFIX.length)))
      .sort((a, b) => SNAPSHOT.exec(a.slice(0, -SEALED_SUFFIX.length))[1].localeCompare(SNAPSHOT.exec(b.slice(0, -SEALED_SUFFIX.length))[1]));
    for (const entry of kept.slice(0, Math.max(0, kept.length - keep))) await rm(path.join(outbox, entry), { force: true });
    for (const entry of (await readdir(outbox)).filter((entry) => entry.endsWith(".partial"))) await rm(path.join(outbox, entry), { force: true });
    if (ship) {
      try { await run(ship, [sealed.file], { timeout: 3_600_000, maxBuffer: 8 * 1024 * 1024 }); }
      catch (error) { throw new Error(`备份已做好（${final}），加密副本也在（${sealed.file}），但送出去失败了：${String(error?.stderr || error?.message).trim().slice(0, 300)}`); }
    }
  }
  return { snapshot: final, files, removed, sealed, shipped: Boolean(sealed && ship) };
}

// What the last run did, beside the snapshots (status.json): when, whether it
// worked, how big, whether a sealed copy was made and sent, and why not. The
// server's 备份 check and the console's 服务状态 read it (health-monitor.js
// backupCheck). It holds nothing of what was backed up. The last success is
// kept across a failure, so "since when" survives one.
export async function writeBackupStatus(to, entry) {
  if (typeof to !== "string" || !path.isAbsolute(to) || !(await stat(to).catch(() => null))?.isDirectory()) return false;
  const file = path.join(to, BACKUP_STATUS);
  let previous = null;
  try { previous = JSON.parse(await readFile(file, "utf8")); } catch {}
  const status = { last: entry, lastSuccess: entry.ok ? entry : previous?.lastSuccess ?? null };
  const partial = `${file}.${process.pid}.partial`;
  await writeFile(partial, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  await rename(partial, file);
  return true;
}

// A snapshot, checked the way a restore would need it: every file the manifest
// names is there with its bytes, every database opens whole, the database dump
// reads back. What does not is named.
export async function verifySnapshot(directory, { pgBin = null } = {}) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(directory, "backup.json"), "utf8")); }
  catch { throw new Error(`${directory} 里没有可读的 backup.json`); }
  const problems = [];
  for (const file of manifest.files ?? []) {
    const at = path.join(directory, file.path);
    if (path.relative(directory, at).startsWith("..")) { problems.push(`${file.path}：路径越出了备份目录`); continue; }
    const info = await lstat(at).catch(() => null);
    if (!info?.isFile()) { problems.push(`${file.path}：不见了`); continue; }
    if (info.size !== file.bytes || await digest(at) !== file.sha256) { problems.push(`${file.path}：内容和清单不符`); continue; }
    if (file.kind === "sqlite") {
      try {
        const db = new DatabaseSync(at, { readOnly: true });
        try {
          const rows = db.prepare("PRAGMA quick_check").all().map((row) => Object.values(row)[0]);
          if (rows.length !== 1 || rows[0] !== "ok") problems.push(`${file.path}：数据库完整性检查没有通过`);
        } finally { db.close(); }
      } catch (error) { problems.push(`${file.path}：数据库打不开（${String(error?.message).slice(0, 120)}）`); }
    }
    if (file.kind === "postgres") await listDump(at, pgBin).catch((error) => problems.push(`${file.path}：${error.message}`));
  }
  if (problems.length) throw new Error(`备份有问题：\n${problems.join("\n")}`);
  return { createdAt: manifest.createdAt, files: manifest.files.length,
    databases: manifest.files.filter((file) => file.kind === "sqlite").length, postgres: manifest.files.some((file) => file.kind === "postgres"),
    bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) };
}

// A sealed copy opened for a restore, into a directory that did not exist,
// and checked before it is handed over.
export async function openForRestore({ file, key, into, pgBin = null }) {
  if (![file, key, into].every((value) => typeof value === "string" && path.isAbsolute(value))) throw new Error("--open、--key、--into 都要用绝对路径");
  if (await lstat(into).catch(() => null)) throw new Error(`${into} 已经存在：换一个还不存在的目录`);
  await mkdir(into, { recursive: true, mode: 0o700 });
  const { snapshot } = await openSealed({ file, privateKeyPem: await readPem(key, "备份私钥"), into });
  return { snapshot, ...(await verifySnapshot(snapshot, { pgBin })) };
}

// The restore, short of switching over to it: a sealed copy is opened into a
// directory of its own, which is removed afterwards; a snapshot is checked
// where it is.
export async function drill({ target, key = null, pgBin = null }) {
  if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("--drill 要用绝对路径");
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) return { ...(await verifySnapshot(target, { pgBin })), opened: false };
  if (!info?.isFile()) throw new Error(`${target} 不存在`);
  if (!key) throw new Error("演练加密备份需要 --key <备份私钥>");
  const into = await mkdtemp(path.join(os.tmpdir(), "idou-drill-"));
  try {
    const { snapshot, header } = await openSealed({ file: target, privateKeyPem: await readPem(key, "备份私钥"), into });
    return { ...(await verifySnapshot(snapshot, { pgBin })), opened: true, snapshot: header.snapshot };
  } finally { await rm(into, { recursive: true, force: true }); }
}

// Run as a command, compared by real path: on the server it is started as
// /opt/idou/app/bin/backup.js, and /opt/idou/app is a link to the
// release. Compared as written, the two paths differed, and the timer's first
// run did nothing and exited 0 (2026-09-26).
// --postgres <address>, or --postgres-env <variable>: the second keeps the
// address -- and any password in it -- off this program's own command line.
function postgresAddress(argv) {
  const variable = option(argv, "--postgres-env", null);
  if (variable === null) return option(argv, "--postgres", null);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(variable) || !process.env[variable]) throw new Error(`--postgres-env：环境变量 ${variable} 没有设置`);
  return process.env[variable];
}
const invoked = (() => { try { return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; } })();
if (invoked) {
  const argv = process.argv.slice(2);
  const pgBin = option(argv, "--pg-bin", null);
  if (argv.includes("--open")) {
    try {
      const result = await openForRestore({ file: option(argv, "--open"), key: option(argv, "--key"), into: option(argv, "--into"), pgBin });
      process.stdout.write(`已解开并核对：${result.snapshot}，${result.files} 个文件都和清单一致。恢复步骤见 docs/server-deployment.md §8。\n`);
    } catch (error) {
      process.stderr.write(`解开失败：${error.message}\n`);
      process.exitCode = 1;
    }
  } else if (argv.includes("--drill")) {
    try {
      const result = await drill({ target: option(argv, "--drill"), key: option(argv, "--key", null), pgBin });
      process.stdout.write(`恢复演练通过：${result.opened ? `加密备份 ${result.snapshot} 解开了，` : ""}${result.files} 个文件都和清单一致（其中 ${result.databases} 个数据库通过完整性检查${result.postgres ? "，数据库转储读得回来" : ""}），共 ${(result.bytes / 1048576).toFixed(1)} MB，备份时间 ${result.createdAt}。\n`);
    } catch (error) {
      process.stderr.write(`恢复演练失败：${error.message}\n`);
      process.exitCode = 1;
    }
  } else {
    const startedAt = new Date().toISOString();
    // Where its record goes, when the arguments say; a bad --to is the backup's own error to report.
    const recordIn = (() => { try { return option(argv, "--to", null); } catch { return null; } })();
    try {
      const keep = Number(option(argv, "--keep", "14"));
      const result = await backup({ data: option(argv, "--data"), to: option(argv, "--to"), keep, pgBin,
        postgres: postgresAddress(argv), also: options(argv, "--also"), seal: option(argv, "--seal", null), ship: option(argv, "--ship", null) });
      const databases = result.files.filter((file) => file.kind === "sqlite").length;
      const bytes = result.files.reduce((sum, file) => sum + file.bytes, 0);
      await writeBackupStatus(recordIn, { ok: true, startedAt, endedAt: new Date().toISOString(), snapshot: path.basename(result.snapshot),
        files: result.files.length, databases, bytes, sealed: Boolean(result.sealed), shipped: result.shipped })
        .catch((error) => process.stderr.write(`备份记录没有写成（${error.message}），备份本身完成了。\n`));
      const dumped = result.files.some((file) => file.kind === "postgres") ? "，共享数据库转储读得回来" : "";
      const sealed = result.sealed ? `；加密副本 ${result.sealed.file}（${(result.sealed.bytes / 1048576).toFixed(1)} MB）${result.shipped ? "已送出" : "留在本机"}` : "";
      process.stdout.write(`备份完成：${result.snapshot}，${result.files.length} 个文件（其中 ${databases} 个数据库，都通过了完整性检查${dumped}），共 ${(bytes / 1048576).toFixed(1)} MB；保留最近 ${keep} 份，删除了 ${result.removed.length} 份更早的${sealed}。\n`);
    } catch (error) {
      process.stderr.write(`备份失败：${error.message}\n`);
      process.exitCode = 1;
      await writeBackupStatus(recordIn, { ok: false, startedAt, endedAt: new Date().toISOString(), error: withoutCredentials(error.message).slice(0, 300) }).catch(() => {});
    }
  }
}
