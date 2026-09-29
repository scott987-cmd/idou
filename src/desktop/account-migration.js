import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { legacyAccountNamespace } from "../application/desktop-auth.js";

// An account's data, found under a name it had before and moved to the one it
// has now. Account directories used to be named with the control plane's
// address in them (desktop-auth.js, accountNamespace), so a deployment that
// moved -- 127.0.0.1 to a domain, a new machine -- left every account's tasks,
// knowledge copy and skills under a name the application no longer looked for.
//
// The move is a rename: nothing is copied, nothing deleted. It happens only
// when nothing is at the new name yet, so an account that already has data
// under its current name keeps exactly that. A failure is thrown rather than
// swallowed: activating anyway would create an empty directory at the new name,
// and that directory would then stop every later attempt.
//
// Absolute paths recorded inside the directory still name the old one after
// the rename; each store that keeps such a path reads it as the same place
// under the new name (application/account-paths.js).
const NAME = /^[0-9a-f]{64}$/;
const exists = (target) => stat(target).then(() => true, () => false);

// The earlier names that can be proven to be this account's: the one the
// resumed pointer named, the one it had at this address, and the one the last
// signed-in account had at its own address. That last one is proven by
// recomputing it from this identity, so a pointer another account left behind
// is never taken.
export function previousAccountNames({ serverUrl, identity, pointer = null, previous = null }) {
  const names = [];
  if (typeof previous === "string") names.push(previous);
  try { names.push(legacyAccountNamespace({ serverUrl, identity })); } catch { /* not a Feishu identity */ }
  try {
    if (typeof pointer?.namespace === "string" && typeof pointer?.serverUrl === "string"
      && legacyAccountNamespace({ serverUrl: pointer.serverUrl, identity }) === pointer.namespace) names.push(pointer.namespace);
  } catch { /* an unreadable pointer proves nothing */ }
  return [...new Set(names)].filter((name) => NAME.test(name));
}

// The embedded Feishu pages' sign-in belongs to the account too: either the
// partition it claimed from before accounts had their own (the claim file names
// the account) or the one named after it. Both follow the account.
async function moveFeishuSignIn(dataRoot, from, to) {
  const claimFile = path.join(dataRoot, "feishu-web-legacy.json");
  let claim = null;
  try { claim = JSON.parse(await readFile(claimFile, "utf8")); } catch { /* nothing claimed */ }
  if (claim?.namespace === from) {
    const temporary = `${claimFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ namespace: to }), { mode: 0o600, flag: "wx" });
      await rename(temporary, claimFile);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  const partitions = path.join(dataRoot, "Partitions");
  const own = path.join(partitions, `feishu-web-${from}`), next = path.join(partitions, `feishu-web-${to}`);
  if (await exists(own) && !(await exists(next))) await rename(own, next);
}

// Moves the first earlier name that exists to `to`, and returns it; null when
// there was nothing to move or something is already at `to`. `active` is the
// directory in use right now, which is never moved from under itself.
export async function adoptAccountData({ dataRoot, to, from, active = null, resumeStore = null }) {
  if (!NAME.test(to)) throw new Error("Invalid account namespace");
  const accounts = path.join(dataRoot, "accounts"), target = path.join(accounts, to);
  if (await exists(target)) return null;
  for (const name of from) {
    if (name === to || !NAME.test(name)) continue;
    const source = path.join(accounts, name);
    if (source === active || !(await exists(source))) continue;
    await rename(source, target);
    await moveFeishuSignIn(dataRoot, name, to);
    // A credential kept under the old name was sealed for the old address or
    // has just been spent; either way nothing can use it any more.
    await resumeStore?.clear(name).catch(() => {});
    return name;
  }
  return null;
}
