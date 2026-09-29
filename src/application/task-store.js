import { mkdir, readdir, readFile, writeFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { listPermissions } from "../modes.js";
import { isExecutionPermission } from "../permissions.js";
import { relocatedAccountPath } from "./account-paths.js";
import { redactAssignments } from "./redact-secrets.js";

// Taken from the modes themselves rather than repeated here: a hard-coded list
// silently made every task saved under a newly added mode unreadable, so the
// record would come back as "无法读取任务记录" after a restart.
const PERMISSION_IDS = new Set(listPermissions().map((permission) => permission.id));

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateTaskId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid task identity");
  return id;
}

function scrub(task) {
  let changed = false;
  const clean = (holder, key) => { const next = redactAssignments(holder[key]); if (next !== holder[key]) { holder[key] = next; changed = true; } };
  for (const entry of task.activity) { if (entry && typeof entry === "object") { clean(entry, "output"); clean(entry, "command"); } }
  for (const message of task.messages) { if (message && typeof message === "object") clean(message, "text"); }
  return changed;
}

export class TaskStore {
  constructor(directory) { this.directory = directory; this.pending = new Map(); }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const tasks = [], warnings = [], moved = [];
    for (const filename of await readdir(this.directory)) {
      if (!filename.endsWith(".json")) continue;
      try {
        const task = JSON.parse(await readFile(path.join(this.directory, filename), "utf8"));
        validateTaskId(task.id);
        if (filename !== `${task.id}.json` || task.schemaVersion !== 1 || !["coding", "cowork"].includes(task.mode) ||
            // Records written before permission modes existed simply have none,
            // and the default applies when the task next runs.
            (task.permission !== undefined && !PERMISSION_IDS.has(task.permission)) ||
            (task.executionPermission !== undefined && !isExecutionPermission(task.executionPermission)) ||
            !path.isAbsolute(task.cwd) || !Array.isArray(task.messages) || !Array.isArray(task.activity)) throw new Error();
        // A working folder inside the account's own data, recorded before the
        // account's directory was renamed (account-paths.js).
        const cwd = relocatedAccountPath(task.cwd, path.dirname(this.directory));
        if (cwd && await stat(cwd).then((entry) => entry.isDirectory(), () => false)) { task.cwd = cwd; moved.push(task); }
        // A credential an Agent printed before records hid them
        // (redact-secrets.js): a work task's `env` kept the write bridge's key.
        if (scrub(task) && !moved.includes(task)) moved.push(task);
        tasks.push(task);
      } catch { warnings.push(`无法读取任务记录：${filename}，原文件未修改。`); }
    }
    // Kept so the next start does not have to work it out again; a write that
    // fails is only repeated then.
    await Promise.all(moved.map((task) => this.save(task).catch(() => {})));
    return { tasks, warnings };
  }
  // Waits for any in-flight write of this record before unlinking, so a
  // checkpoint that is still landing cannot recreate the file after deletion.
  async remove(id) {
    validateTaskId(id);
    await (this.pending.get(id) || Promise.resolve()).catch(() => {});
    this.pending.delete(id);
    await unlink(path.join(this.directory, `${id}.json`)).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
  save(task) {
    validateTaskId(task.id);
    const bytes = JSON.stringify(task);
    const prior = this.pending.get(task.id) || Promise.resolve();
    const next = prior.catch(() => {}).then(async () => {
      const temporary = path.join(this.directory, `${task.id}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, path.join(this.directory, `${task.id}.json`));
      } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    });
    this.pending.set(task.id, next);
    next.finally(() => { if (this.pending.get(task.id) === next) this.pending.delete(task.id); }).catch(() => {});
    return next;
  }
  async flush() { await Promise.all(this.pending.values()); }
}
