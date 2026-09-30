#!/usr/bin/env node
// Old release directories on a server, let go after a deployment.
//
//   node /opt/idou/app/bin/prune-releases.js [--root /opt/idou] [--keep 3] [--apply]
//
// Every deployment unpacks a release into <root>/releases/<id> with its own
// node_modules (docs/server-deployment.md), and nothing ever removed one: at a
// few hundred megabytes each, a server deployed every day fills its disk in
// months. This keeps the one <root>/app points at and the newest others up to
// --keep in all -- the one before is what a rollback switches back to -- and
// removes the rest. Without --apply it only says what it would remove.
//
// Only directories directly under releases/ whose name is a release id are
// ever considered; anything else there is somebody's, and left alone. Run as
// the user that owns them (root on the server).
import "../src/adopt-legacy-env.js";
import { realpathSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = /^\d+\.\d+\.\d+-(\d{8})\.(\d+)$/;

function option(argv, name, fallback) {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} 需要一个值`);
  return value;
}

// Newest first, by the date and sequence in the id: a sequence that grows a
// digit (.999, .1000) still sorts after the one before it.
const newestFirst = (a, b) => {
  const [, dayA, seqA] = RELEASE.exec(a), [, dayB, seqB] = RELEASE.exec(b);
  return dayB.localeCompare(dayA) || Number(seqB) - Number(seqA);
};

export async function pruneReleases({ root, keep = 3, apply = false }) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("--root 要用绝对路径");
  if (!Number.isSafeInteger(keep) || keep < 2 || keep > 50) throw new Error("--keep 只能是 2 到 50 之间的整数：当前的那个和回退用的上一个都要留");
  // Both resolved: the link names its target by the path it was made with.
  const releases = await realpath(path.join(root, "releases")).catch(() => null);
  if (!releases) throw new Error(`${path.join(root, "releases")} 不存在`);
  const current = await realpath(path.join(root, "app")).catch(() => null);
  if (!current || path.dirname(current) !== releases) throw new Error(`${path.join(root, "app")} 没有指向 ${releases} 里的某个发布：不清理`);
  const names = [];
  for (const name of await readdir(releases)) {
    if (!RELEASE.test(name)) continue;
    const info = await lstat(path.join(releases, name));
    if (info.isDirectory() && !info.isSymbolicLink()) names.push(name);
  }
  const ordered = names.sort(newestFirst);
  const kept = new Set([path.basename(current), ...ordered.filter((name) => name !== path.basename(current)).slice(0, keep - 1)]);
  const removed = ordered.filter((name) => !kept.has(name));
  if (apply) for (const name of removed) await rm(path.join(releases, name), { recursive: true, force: true });
  return { current: path.basename(current), kept: ordered.filter((name) => kept.has(name)), removed, applied: apply };
}

// By real path, as bin/backup.js: run through /opt/idou/app, the two paths differ as written.
const invoked = (() => { try { return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; } })();
if (invoked) {
  const argv = process.argv.slice(2);
  try {
    const result = await pruneReleases({ root: option(argv, "--root", "/opt/idou"), keep: Number(option(argv, "--keep", "3")), apply: argv.includes("--apply") });
    process.stdout.write(`当前发布 ${result.current}；保留 ${result.kept.join("、")}；`
      + (result.removed.length ? `${result.applied ? "已删除" : "可以删除（加 --apply 才会删）"} ${result.removed.join("、")}。\n` : "没有要删的。\n"));
  } catch (error) {
    process.stderr.write(`没有清理：${error.message}\n`);
    process.exitCode = 1;
  }
}
