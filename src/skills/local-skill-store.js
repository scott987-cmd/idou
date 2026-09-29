import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildLocalSkill } from "./local-skills.js";
import { skillDigest } from "./catalog-format.js";

const MAX_SKILLS = 30;
// How many superseded versions of one skill are kept. Enough to undo a bad
// edit; not so many that the store becomes an archive.
const MAX_HISTORY = 5;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 65536;
const ALLOWED = /\.(?:md|txt|json|js|py|sh)$/i;

// Skills a person imported themselves, kept with their account. Plain JSON at
// 0600: this is the person's own instruction text, not a credential — the file
// is private to them, and nothing here is treated as trusted because it is on
// disk. Every read re-validates and re-digests before a skill can be staged.
// The task kinds a skill shelf entry may apply to. Kept here rather than in
// modes.js so the store has no dependency on the application layer.
const TASK_MODES = Object.freeze(["cowork", "coding"]);
const normalizeModes = (value) => TASK_MODES.filter((mode) => Array.isArray(value) && value.includes(mode));
// Absent on records written before applicability existed; those were all office
// skills, so they stay office skills rather than silently gaining coding tasks.
const skillModes = (row) => { const chosen = normalizeModes(row.modes); return chosen.length ? chosen : ["cowork"]; };

export class LocalSkillStore {
  constructor({ filename }) { this.filename = filename; this.rows = null; this.queue = Promise.resolve(); }
  serial(operation) { const next = this.queue.catch(() => {}).then(operation); this.queue = next.catch(() => {}); return next; }
  async load() {
    if (this.rows) return this.rows;
    try {
      const value = JSON.parse(await readFile(this.filename, "utf8"));
      if (value?.schemaVersion !== 1 || !Array.isArray(value.skills)) throw new Error();
      // A record that no longer validates is dropped rather than repaired: the
      // cost is re-importing a folder, and staging a half-valid skill is worse.
      this.rows = value.skills
        .filter((row) => { try { return skillDigest(row.skill) === row.digest; } catch { return false; } })
        .map((row) => ({ ...row, history: (Array.isArray(row.history) ? row.history : [])
          .filter((item) => { try { return skillDigest(item.skill) === item.digest; } catch { return false; } })
          .slice(0, MAX_HISTORY) }))
        .slice(0, MAX_SKILLS);
    } catch { this.rows = []; }
    return this.rows;
  }
  async save() {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, skills: this.rows }), "utf8");
    if (bytes.length > MAX_BYTES) throw new Error("本机技能总量超过上限，请先移除一些");
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    let file;
    try { file = await open(temporary, "wx", 0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = null; await rename(temporary, this.filename); }
    finally { await file?.close(); await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  async list() {
    return this.serial(async () => (await this.load()).map((row) => ({ ...row.skill, digest: row.digest, enabled: row.enabled === true, modes: skillModes(row), importedAt: row.importedAt, source: "local",
      history: (row.history ?? []).map((item) => ({ version: item.skill.version, digest: item.digest, importedAt: item.importedAt, files: item.skill.files.length })) })));
  }
  // The shape TaskSkillRunner expects, so a local skill stages and re-verifies
  // through exactly the same path as a signed one.
  async read(reference) {
    return this.serial(async () => {
      const row = (await this.load()).find((item) => item.skill.id === reference.id);
      if (!row) throw new Error("找不到这个本机技能，可能已被移除");
      if (row.digest !== reference.digest || row.skill.version !== reference.version) throw new Error("本机技能已变更，请重新选择");
      if (skillDigest(row.skill) !== row.digest) throw new Error("本机技能内容与记录不一致，已拒绝使用");
      return { ...row.skill, digest: row.digest, compatible: true, source: "local" };
    });
  }
  // Which kinds of task a skill is for. It lives on the store row rather than
  // inside the bundle: the bundle is digested, so a new field there would make
  // load() drop every skill imported before this change as a digest mismatch,
  // and would alter the payload the signed enterprise catalog is verified over.
  // A record written before this existed means 工作任务, which is what the
  // shelf was for and what every existing skill was written against.
  async enabled(mode) {
    if (mode !== undefined && !TASK_MODES.includes(mode)) throw new Error("未知的任务类型");
    return (await this.list()).find((skill) => skill.enabled && (mode === undefined || skill.modes.includes(mode))) ?? null;
  }
  async importDirectory(directory, { now = Date.now } = {}) {
    const root = path.resolve(directory);
    const info = await stat(root);
    if (!info.isDirectory()) throw new Error("请选择一个技能文件夹");
    const files = [];
    const walk = async (relative) => {
      const entries = await readdir(path.join(root, relative), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const next = relative ? `${relative}/${entry.name}` : entry.name;
        // Symlinks are not followed: an imported folder must not be able to
        // reach outside itself.
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { if (next.split("/").length < 4) await walk(next); continue; }
        if (!entry.isFile() || !ALLOWED.test(entry.name) || files.length >= 64) continue;
        const filename = path.join(root, next);
        const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const size = (await handle.stat()).size;
          if (size > MAX_FILE_BYTES) continue;
          files.push({ path: next, text: await handle.readFile("utf8") });
        } finally { await handle.close(); }
      }
    };
    await walk("");
    const skill = buildLocalSkill({ files, folderName: path.basename(root) });
    return this.serial(async () => {
      const rows = await this.load();
      if (!rows.some((row) => row.skill.id === skill.id) && rows.length >= MAX_SKILLS) throw new Error(`最多保存 ${MAX_SKILLS} 个本机技能`);
      const { digest, compatible, source, ...bundle } = skill;
      const previous = rows.find((row) => row.skill.id === skill.id);
      // Re-importing supersedes rather than erases: the version being replaced
      // is kept so a bad edit can be undone. An identical re-import changes
      // nothing and must not push a duplicate into the history.
      const history = previous && previous.digest !== digest
        ? [{ skill: previous.skill, digest: previous.digest, importedAt: previous.importedAt }, ...(previous.history ?? [])].slice(0, MAX_HISTORY)
        : previous?.history ?? [];
      // New content under an enabled skill's name is new instructions for every
      // new task. Enabling is where a person reads and confirms those, so a
      // changed skill comes back switched off and goes through that again;
      // carrying `enabled` across used to swap the instructions silently. An
      // identical re-import changes nothing and keeps its state. Task kinds are
      // the person's choice, not the bundle's, so they survive either way.
      const changed = Boolean(previous) && previous.digest !== digest;
      const enabled = previous?.enabled === true && !changed;
      this.rows = [...rows.filter((row) => row.skill.id !== skill.id),
        { skill: bundle, digest, enabled, importedAt: now(), history, ...(previous?.modes ? { modes: previous.modes } : {}) }];
      await this.save();
      return { ...skill, enabled, replaced: Boolean(previous), supersededVersions: history.length,
        switchedOffForReview: previous?.enabled === true && changed };
    });
  }
  async setEnabled(id, enabled, modes = ["cowork"]) {
    return this.serial(async () => {
      const rows = await this.load();
      if (!rows.some((row) => row.skill.id === id)) throw new Error("找不到这个本机技能");
      const chosen = normalizeModes(modes);
      if (enabled === true && !chosen.length) throw new Error("请至少选择一种任务类型");
      // One at a time: a task binds a single skill, so enabling means "this is
      // the one new tasks use" rather than adding to a pile.
      this.rows = rows.map((row) => row.skill.id === id
        ? { ...row, enabled: enabled === true, modes: chosen }
        : { ...row, enabled: false });
      await this.save();
      return this.rows.filter((row) => row.enabled).map((row) => row.skill.id);
    });
  }
  // Rolling back swaps a stored version into place; the version it replaces
  // takes its turn in the history, so a rollback can itself be undone.
  async rollback(id, digest, { now = Date.now } = {}) {
    return this.serial(async () => {
      const rows = await this.load();
      const row = rows.find((item) => item.skill.id === id);
      if (!row) throw new Error("找不到这个本机技能");
      const target = (row.history ?? []).find((item) => item.digest === digest);
      if (!target) throw new Error("找不到这个历史版本，可能已被覆盖");
      if (skillDigest(target.skill) !== target.digest) throw new Error("历史版本内容与记录不一致，已拒绝回滚");
      const history = [{ skill: row.skill, digest: row.digest, importedAt: row.importedAt },
        ...(row.history ?? []).filter((item) => item.digest !== digest)].slice(0, MAX_HISTORY);
      this.rows = rows.map((item) => item.skill.id === id
        // Rollback is confirmed in the main process before it gets here; the
        // task kinds it applies to are kept, not reset to 工作任务.
        ? { skill: target.skill, digest: target.digest, enabled: item.enabled === true, importedAt: now(), history, ...(item.modes ? { modes: item.modes } : {}) }
        : item);
      await this.save();
      return { ...target.skill, digest: target.digest, enabled: row.enabled === true, source: "local" };
    });
  }
  async remove(id) {
    return this.serial(async () => {
      const rows = await this.load();
      this.rows = rows.filter((row) => row.skill.id !== id);
      if (this.rows.length !== rows.length) await this.save();
      return { removed: this.rows.length !== rows.length };
    });
  }
}
