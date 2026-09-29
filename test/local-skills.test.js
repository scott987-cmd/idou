import test from "node:test";
import assert from "node:assert/strict";
import { buildLocalSkill, localSkillId, readFrontMatter, withSkillName } from "../src/skills/local-skills.js";
import { normalizeSkills } from "../src/skills/catalog-format.js";

const skillMd = (extra = "") => `---\nname: 周报助手\ndescription: 按固定格式整理周报\n${extra}---\n\n# 周报助手\n\n先读最近一周的记录。`;

test("从文件夹导入：拿到 SKILL.md 的名称和说明，生成本机技能标识", () => {
  const skill = buildLocalSkill({ folderName: "weekly", files: [{ path: "SKILL.md", text: skillMd() }] });
  assert.match(skill.id, /^local-/);
  assert.equal(skill.title, "周报助手");
  assert.equal(skill.description, "按固定格式整理周报");
  assert.equal(skill.publisher, "本机导入");
  assert.match(skill.digest, /^[a-f0-9]{64}$/);
});

test("存下来的 SKILL.md 里的 name 会被改写成技能标识，否则 Codex 认不出来", () => {
  const skill = buildLocalSkill({ folderName: "weekly", files: [{ path: "SKILL.md", text: skillMd() }] });
  const main = skill.files.find((file) => file.path === "SKILL.md");
  assert.match(main.text, new RegExp(`^---\\nname: ${skill.id}\\n`));
  assert.match(main.text, /description: 按固定格式整理周报/);
  // The body must survive the rewrite intact.
  assert.match(main.text, /先读最近一周的记录。/);
});

test("没有 SKILL.md 就不是技能", () => {
  assert.throws(() => buildLocalSkill({ folderName: "x", files: [{ path: "README.md", text: "hi" }] }), /没有 SKILL\.md/);
});

test("不认识的文件类型被丢掉，而不是整包拒绝", () => {
  const skill = buildLocalSkill({ folderName: "weekly", files: [
    { path: "SKILL.md", text: skillMd() }, { path: "notes.txt", text: "备注" },
    { path: "evil.exe", text: "x" }, { path: "../escape.md", text: "x" }] });
  assert.deepEqual(skill.files.map((file) => file.path).sort(), ["SKILL.md", "notes.txt"]);
});

test("本机技能不声明任何工具，即使 SKILL.md 里写了", () => {
  const skill = buildLocalSkill({ folderName: "weekly", files: [
    { path: "SKILL.md", text: skillMd("requiredTools: mcp:anything:run\n") }] });
  assert.deepEqual(skill.requiredTools, []);
});

test("签名目录拒绝本机技能，本机技能进不了企业目录", () => {
  const skill = buildLocalSkill({ folderName: "weekly", files: [{ path: "SKILL.md", text: skillMd() }] });
  const { digest, compatible, source, ...bundle } = skill;
  assert.throws(() => normalizeSkills([bundle]), /only enterprise skills/);
});

test("标识按候选顺序取第一个可用的，全中文的名字会退到文件夹名", () => {
  assert.equal(localSkillId("Weekly Report"), "local-weekly-report");
  assert.equal(localSkillId("周报 helper 2"), "local-helper-2");
  assert.equal(localSkillId("周报助手", "weekly-report"), "local-weekly-report", "中文名不该挡住导入");
  assert.throws(() => localSkillId("周报助手", "。。。"), /无法从技能名或文件夹名生成标识/);
});

test("没有 front matter 也能导入，正文原样保留", () => {
  const skill = buildLocalSkill({ folderName: "plain-notes", files: [{ path: "SKILL.md", text: "just a body" }] });
  assert.equal(skill.id, "local-plain-notes");
  assert.match(skill.files[0].text, /just a body/);
  assert.deepEqual(readFrontMatter("no front matter").fields, {});
  assert.match(withSkillName("body", "local-x"), /^---\nname: local-x\n---\nbody$/);
});
