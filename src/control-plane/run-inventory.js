import { createHash } from "node:crypto";
import { lstat, readdir, mkdir, rename } from "node:fs/promises";
import path from "node:path";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = value => createHash("sha256").update(value).digest("hex");

// Metadata only: never open task.json, reports, credentials, or symlink targets.
// A size/time/inode fingerprint detects changes between review and quarantine.
async function measure(directory) {
  let bytes = 0, files = 0, entries = 0;
  const digest = createHash("sha256");
  const walk = async relative => {
    if (++entries > 100_000) throw new Error("inventory_entry_limit");
    const stat = await lstat(path.join(directory, relative));
    digest.update(JSON.stringify([relative, stat.mode, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]));
    if (stat.isDirectory()) {
      for (const name of (await readdir(path.join(directory, relative))).sort()) await walk(path.join(relative, name));
    } else { files++; bytes += stat.size; }
  };
  await walk("");
  return { bytes, files, fingerprint: digest.digest("hex") };
}

export async function inventoryRuns({ dataDir, records = [], now = Date.now }) {
  if (!path.isAbsolute(dataDir) || path.resolve(dataDir) === path.parse(dataDir).root) throw new Error("explicit_data_directory_required");
  const root = path.join(path.resolve(dataDir), "runs");
  const exists = await lstat(root).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (exists && !exists.isDirectory()) throw new Error("run_root_not_directory");
  const rows = [];
  for (const entry of exists ? await readdir(root, { withFileTypes: true }) : []) {
    if (entry.name === ".run-owners") continue;
    const target = path.join(root, entry.name), stat = await lstat(target);
    const record = records.find(row => row.id === entry.name);
    const attribution = record ? { scheduleId: record.schedule_id,
      ownerHash: hash(`${record.tenant}\n${record.owner ?? ""}`), finishedAt: record.finished_at } : null;
    const marked = await lstat(path.join(root, ".run-owners", `${entry.name}.json`)).then(() => true, error => {
      if (error.code === "ENOENT") return false; throw error;
    });
    rows.push({ path: target, runId: entry.name, kind: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
      modifiedAt: stat.mtimeMs, attribution,
      eligible: UUID.test(entry.name) && stat.isDirectory() && !marked && Boolean(record?.finished_at) && Boolean(record?.owner),
      ...(await measure(target)) });
  }
  return { version: 1, dataDir: path.resolve(dataDir), root, observedAt: now(), entries: rows.sort((a, b) => a.path.localeCompare(b.path)) };
}

// No deletion. The operator explicitly names reviewed run IDs, stops the
// control plane, and supplies a fresh inventory. Changed or unowned paths fail
// closed; a same-filesystem rename keeps the only copy recoverable.
export async function quarantineRuns({ plan, current, runIds, verifyOffline }) {
  if (plan?.version !== 1 || current?.version !== 1 || plan.dataDir !== current.dataDir || plan.root !== current.root
      || !Array.isArray(runIds) || !runIds.length || new Set(runIds).size !== runIds.length || typeof verifyOffline !== "function") {
    throw new Error("invalid_quarantine_plan");
  }
  const selected = runIds.map(runId => {
    const old = plan.entries.find(row => row.runId === runId), fresh = current.entries.find(row => row.runId === runId);
    if (!UUID.test(runId) || !old?.eligible || !fresh?.eligible || old.path !== path.join(current.root, runId)
      || fresh.path !== old.path || fresh.fingerprint !== old.fingerprint
      || JSON.stringify(old.attribution) !== JSON.stringify(fresh.attribution)) throw new Error("quarantine_review_stale_or_unowned");
    return fresh;
  });
  await verifyOffline();
  const destination = path.join(current.dataDir, "run-quarantine");
  await mkdir(destination, { mode: 0o700, recursive: true });
  if (!(await lstat(destination)).isDirectory()) throw new Error("quarantine_not_directory");
  const moved = [];
  for (const row of selected) {
    await verifyOffline();
    if ((await measure(row.path)).fingerprint !== row.fingerprint) throw new Error("quarantine_review_stale");
    const target = path.join(destination, row.runId);
    const exists = await lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (exists) throw new Error("quarantine_destination_exists");
    await rename(row.path, target);
    moved.push({ from: row.path, to: target });
  }
  return { moved, recoverable: true };
}
