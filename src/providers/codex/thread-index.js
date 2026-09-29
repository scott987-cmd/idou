import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Codex keeps an index of its conversations in CODEX_HOME/state_<n>.sqlite,
// and each row names its conversation's file by absolute path. When the folder
// holding CODEX_HOME is renamed -- an account's data adopted under its new name
// -- every row goes on naming the old place, and resuming any earlier
// conversation fails with "failed to resolve rollout path … file does not
// exist" although the file is right there. Codex looks in its sessions folder
// for a conversation it has no row for, but not for one whose row names a
// missing file (both measured on Codex 0.155.0, 2026-09-23).
//
// `relocate` says where an indexed path would be now, or null. A row is changed
// only when its file is actually there, so the index never names a file that
// is not. Returns how many rows changed.
const STATE = /^state_\d+\.sqlite$/;
const isFile = (file) => stat(file).then((entry) => entry.isFile(), () => false);

export async function relinkThreadIndex(home, relocate) {
  let names;
  try { names = await readdir(home); } catch { return 0; }
  let changed = 0;
  for (const name of names.filter((each) => STATE.test(each)).sort()) {
    const db = new DatabaseSync(path.join(home, name));
    try {
      // Codex may have the same file open; wait for its writes rather than fail.
      db.exec("PRAGMA busy_timeout = 5000");
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get()) continue;
      const moves = [];
      for (const row of db.prepare("SELECT id, rollout_path FROM threads").all()) {
        const next = relocate(row.rollout_path);
        if (next && next !== row.rollout_path && await isFile(next)) moves.push([next, row.id, row.rollout_path]);
      }
      if (!moves.length) continue;
      const update = db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ? AND rollout_path = ?");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const move of moves) changed += Number(update.run(...move).changes);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  }
  return changed;
}
