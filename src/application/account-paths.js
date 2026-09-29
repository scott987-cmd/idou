import { realpath } from "node:fs/promises";
import path from "node:path";

// Where a path that named this account's directory under an earlier name is
// now.
//
// adoptAccountData (desktop/account-migration.js) renames an account's
// directory when the name it is kept under changes. What it moves is a folder;
// records inside that folder that hold absolute paths -- a task's working
// folder, a site's folder, Codex's index of its own conversations -- went on
// naming the old place. Every conversation started before the rename then
// failed to continue ("failed to resolve rollout path … file does not exist",
// 360 of 361 on the first machine it happened to, 2026-09-23), and a site's
// refresh wrote its data into a recreated copy of the old directory.
//
// So a path into a sibling account directory is read as the same place in this
// one. Only a sibling: any other path is left as it is, and the caller uses the
// answer only when something is actually there.
const NAME = /^[0-9a-f]{64}$/;

export function relocatedAccountPath(value, root) {
  if (typeof value !== "string" || !path.isAbsolute(value) || typeof root !== "string" || !path.isAbsolute(root)) return null;
  if (!NAME.test(path.basename(root))) return null;
  const relative = path.relative(path.dirname(root), value);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const [name, ...rest] = relative.split(path.sep);
  if (!NAME.test(name) || name === path.basename(root) || !rest.length) return null;
  return path.join(root, ...rest);
}

// The same, for a record written by something that names the account's
// directory by its real path: Codex resolves CODEX_HOME before it indexes a
// conversation, so a data directory reached through a link (/var is /private/var
// on macOS) is recorded under the other name.
export async function accountRelocator(root) {
  const real = await realpath(root).catch(() => root);
  return (value) => relocatedAccountPath(value, root) ?? (real === root ? null : relocatedAccountPath(value, real));
}
