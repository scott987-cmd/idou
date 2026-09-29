import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalSkillStore } from "../src/skills/local-skill-store.js";

const SKILL = `---\nname: 周报助手\ndescription: 按固定格式整理周报\n---\n\n先读最近一周的记录。`;

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "idou-skills-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = new LocalSkillStore({ filename: path.join(base, "store", "local-skills.json") });
  const folder = async (name, files) => {
    const dir = path.join(base, name);
    for (const [relative, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
      await writeFile(path.join(dir, relative), text);
    }
    return dir;
  };
  return { base, store, folder };
}

test("导入一个文件夹，列表里出现它，默认未启用", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL, "notes.txt": "备注" });
  const imported = await f.store.importDirectory(dir);
  assert.equal(imported.id, "local-weekly-report");
  assert.equal(imported.enabled, false);
  const rows = await f.store.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "周报助手");
  assert.deepEqual(rows[0].files.map((file) => file.path).sort(), ["SKILL.md", "notes.txt"]);
  if (process.platform !== "win32") assert.equal((await stat(f.store.filename)).mode & 0o077, 0, "技能记录不得对其他用户可读");
});

test("重启后仍在：换一个 store 实例读同一份文件", async (t) => {
  const f = await setup(t);
  await f.store.importDirectory(await f.folder("weekly-report", { "SKILL.md": SKILL }));
  await f.store.setEnabled("local-weekly-report", true);
  const reopened = new LocalSkillStore({ filename: f.store.filename });
  const rows = await reopened.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].enabled, true);
  assert.equal((await reopened.enabled()).id, "local-weekly-report");
});

test("同一时间只有一个启用；启用另一个会把前一个关掉", async (t) => {
  const f = await setup(t);
  await f.store.importDirectory(await f.folder("alpha", { "SKILL.md": SKILL }));
  await f.store.importDirectory(await f.folder("beta", { "SKILL.md": SKILL.replace("周报助手", "另一个") }));
  await f.store.setEnabled("local-alpha", true);
  await f.store.setEnabled("local-beta", true);
  const rows = await f.store.list();
  assert.deepEqual(rows.filter((row) => row.enabled).map((row) => row.id), ["local-beta"]);
  await f.store.setEnabled("local-beta", false);
  assert.equal(await f.store.enabled(), null);
});

test("read() 只接受版本和摘要都对得上的引用", async (t) => {
  const f = await setup(t);
  const imported = await f.store.importDirectory(await f.folder("weekly-report", { "SKILL.md": SKILL }));
  const good = await f.store.read({ id: imported.id, version: imported.version, digest: imported.digest });
  assert.equal(good.id, imported.id);
  await assert.rejects(f.store.read({ id: imported.id, version: imported.version, digest: "0".repeat(64) }), /已变更/);
  await assert.rejects(f.store.read({ id: "local-missing", version: "1.0.0", digest: imported.digest }), /找不到/);
});

// This used to keep the skill enabled, which meant re-importing a folder under
// an enabled skill's name swapped the instructions every new task receives
// without anyone confirming them. Enabling is where those are read and agreed
// to, so changed content now comes back switched off, and says so.
test("重新导入改过内容的已启用技能：内容更新，但先停用等重新确认", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  const first = await f.store.importDirectory(dir);
  await f.store.setEnabled(first.id, true, ["coding"]);
  await writeFile(path.join(dir, "SKILL.md"), SKILL.replace("先读最近一周的记录。", "改成先读两周。"));
  const second = await f.store.importDirectory(dir);
  assert.equal(second.replaced, true);
  assert.equal(second.enabled, false, "新内容不能不经确认就生效");
  assert.equal(second.switchedOffForReview, true);
  assert.notEqual(second.digest, first.digest);
  const rows = await f.store.list();
  assert.equal(rows.length, 1, "不该出现两份");
  assert.deepEqual(rows[0].modes, ["coding"], "任务类型是人选的，重新导入不该把它重置成工作任务");
});
test("原样重新导入已启用的技能：什么都不变，仍然启用", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  const first = await f.store.importDirectory(dir);
  await f.store.setEnabled(first.id, true, ["coding"]);
  const again = await f.store.importDirectory(dir);
  assert.equal(again.enabled, true);
  assert.equal(again.switchedOffForReview, false);
  assert.equal((await f.store.enabled("coding"))?.id, first.id);
});
test("回滚保留任务类型，不会悄悄改成工作任务", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  const first = await f.store.importDirectory(dir);
  await writeFile(path.join(dir, "SKILL.md"), SKILL.replace("先读最近一周的记录。", "第二版。"));
  await f.store.importDirectory(dir);
  await f.store.setEnabled(first.id, true, ["coding"]);
  await f.store.rollback(first.id, first.digest);
  assert.equal((await f.store.enabled("coding"))?.id, first.id, "回滚后编程任务仍然用它");
  assert.equal(await f.store.enabled("cowork"), null, "也不会跑到工作任务里去");
});

test("移除之后就用不了了", async (t) => {
  const f = await setup(t);
  const imported = await f.store.importDirectory(await f.folder("weekly-report", { "SKILL.md": SKILL }));
  assert.deepEqual(await f.store.remove(imported.id), { removed: true });
  assert.deepEqual(await f.store.list(), []);
  await assert.rejects(f.store.read({ id: imported.id, version: imported.version, digest: imported.digest }), /找不到/);
});

test("符号链接不跟进，导入的文件夹碰不到外面", { skip: process.platform === "win32" }, async (t) => {
  const f = await setup(t);
  const secret = path.join(f.base, "outside.md");
  await writeFile(secret, "不该被读到的内容");
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  await symlink(secret, path.join(dir, "linked.md"));
  const imported = await f.store.importDirectory(dir);
  assert.deepEqual(imported.files.map((file) => file.path), ["SKILL.md"]);
  assert.doesNotMatch(JSON.stringify(imported), /不该被读到的内容/);
});

test("没有 SKILL.md 的文件夹导入失败，也不会留下半条记录", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("not-a-skill", { "README.md": "hi" });
  await assert.rejects(f.store.importDirectory(dir), /没有 SKILL\.md/);
  assert.deepEqual(await f.store.list(), []);
});

test("重新导入会把上一版留下来，可以回滚回去", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  const first = await f.store.importDirectory(dir);
  await writeFile(path.join(dir, "SKILL.md"), SKILL.replace("先读最近一周的记录。", "第二版正文。"));
  const second = await f.store.importDirectory(dir);
  assert.notEqual(second.digest, first.digest);

  const [row] = await f.store.list();
  assert.equal(row.digest, second.digest);
  assert.deepEqual(row.history.map((item) => item.digest), [first.digest]);

  const back = await f.store.rollback(row.id, first.digest);
  assert.equal(back.digest, first.digest);
  assert.match(back.files.find((file) => file.path === "SKILL.md").text, /先读最近一周的记录。/);
  // The version that was current becomes undoable in turn.
  const [after] = await f.store.list();
  assert.equal(after.digest, first.digest);
  assert.deepEqual(after.history.map((item) => item.digest), [second.digest]);
});

test("回滚不改变启用状态", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  const first = await f.store.importDirectory(dir);
  await writeFile(path.join(dir, "SKILL.md"), SKILL.replace("先读", "改了先读"));
  await f.store.importDirectory(dir);
  // Enabled after the re-import: changed content arrives switched off.
  await f.store.setEnabled(first.id, true);
  await f.store.rollback(first.id, first.digest);
  assert.equal((await f.store.enabled()).digest, first.digest);
});

test("原样重新导入不会往历史里塞重复版本", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  await f.store.importDirectory(dir);
  await f.store.importDirectory(dir);
  assert.deepEqual((await f.store.list())[0].history, []);
});

test("历史有上限，最旧的被丢掉", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  const digests = [];
  for (let round = 0; round < 8; round += 1) {
    await writeFile(path.join(dir, "SKILL.md"), SKILL.replace("先读最近一周的记录。", `第 ${round} 版。`));
    digests.push((await f.store.importDirectory(dir)).digest);
  }
  const [row] = await f.store.list();
  assert.equal(row.history.length, 5);
  assert.deepEqual(row.history.map((item) => item.digest), digests.slice(2, 7).reverse());
});

test("回滚只接受真实存在的历史版本", async (t) => {
  const f = await setup(t);
  const imported = await f.store.importDirectory(await f.folder("weekly-report", { "SKILL.md": SKILL }));
  await assert.rejects(f.store.rollback(imported.id, "0".repeat(64)), /找不到这个历史版本/);
  await assert.rejects(f.store.rollback("local-missing", imported.digest), /找不到这个本机技能/);
});

test("历史在重启后还在", async (t) => {
  const f = await setup(t);
  const dir = await f.folder("weekly-report", { "SKILL.md": SKILL });
  const first = await f.store.importDirectory(dir);
  await writeFile(path.join(dir, "SKILL.md"), SKILL.replace("先读", "二版先读"));
  await f.store.importDirectory(dir);
  const reopened = new LocalSkillStore({ filename: f.store.filename });
  assert.deepEqual((await reopened.list())[0].history.map((item) => item.digest), [first.digest]);
});

test("技能只对它被启用的任务类型生效，旧记录一律按工作任务处理", async (t) => {
  const f = await setup(t);
  await f.store.importDirectory(await f.folder("weekly-report", { "SKILL.md": SKILL }));

  // Default: the shelf is an office-work shelf, so an unqualified enable means
  // 工作任务 only. A coding task asking for a skill gets none.
  await f.store.setEnabled("local-weekly-report", true);
  assert.equal((await f.store.enabled("cowork"))?.id, "local-weekly-report");
  assert.equal(await f.store.enabled("coding"), null,
    "an office skill must not attach itself to a coding task at all");
  assert.deepEqual((await f.store.list())[0].modes, ["cowork"]);

  // Chosen explicitly, it reaches exactly the kinds chosen.
  await f.store.setEnabled("local-weekly-report", true, ["coding"]);
  assert.equal(await f.store.enabled("cowork"), null);
  assert.equal((await f.store.enabled("coding"))?.id, "local-weekly-report");
  await f.store.setEnabled("local-weekly-report", true, ["cowork", "coding"]);
  assert.equal((await f.store.enabled("cowork"))?.id, "local-weekly-report");
  assert.equal((await f.store.enabled("coding"))?.id, "local-weekly-report");

  // No kinds at all is a mistake, not "applies everywhere".
  await assert.rejects(f.store.setEnabled("local-weekly-report", true, []), /至少选择一种/);
  await assert.rejects(f.store.enabled("nonsense"), /未知的任务类型/);
  // Asking without a mode still means "whatever is enabled", for callers that
  // only want to know whether a shelf entry is on.
  assert.equal((await f.store.enabled())?.id, "local-weekly-report");

  // Applicability survives a restart, and a record written before it existed
  // must not silently gain coding tasks.
  const reopened = new LocalSkillStore({ filename: f.store.filename });
  await reopened.setEnabled("local-weekly-report", true, ["coding"]);
  assert.equal((await new LocalSkillStore({ filename: f.store.filename }).enabled("coding"))?.id, "local-weekly-report");
  const raw = JSON.parse(await readFile(f.store.filename, "utf8"));
  delete raw.skills[0].modes;
  await writeFile(f.store.filename, JSON.stringify(raw));
  const legacy = new LocalSkillStore({ filename: f.store.filename });
  assert.equal((await legacy.enabled("cowork"))?.id, "local-weekly-report");
  assert.equal(await legacy.enabled("coding"), null);
});

test("停用不会因为没勾任务类型而失败", async (t) => {
  const f = await setup(t);
  await f.store.importDirectory(await f.folder("weekly-report", { "SKILL.md": SKILL }));
  await f.store.setEnabled("local-weekly-report", true, ["cowork"]);
  await f.store.setEnabled("local-weekly-report", false, []);
  assert.equal(await f.store.enabled("cowork"), null);
});
