import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { expandCommand, listProjectCommands, parseCommand, PRODUCT_COMMANDS, projectCommand } from "../src/application/project-commands.js";

async function project(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-commands-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a command file: its description and argument hint, and the text after them", () => {
  assert.deepEqual(parseCommand("---\ndescription: \"补测试\"\nargument-hint: <函数名>\nallowed-tools: Bash\n---\n给 $ARGUMENTS 补测试。\n"),
    { description: "补测试", argumentHint: "<函数名>", body: "给 $ARGUMENTS 补测试。" });
  assert.deepEqual(parseCommand("只有正文"), { description: "", argumentHint: "", body: "只有正文" });
  assert.deepEqual(parseCommand("\uFEFF---\r\ndescription: x\r\n---\r\nbody"), { description: "x", argumentHint: "", body: "body" });
});

test("what follows the command fills $ARGUMENTS and $1 to $9, and is added at the end when nothing asks for it", () => {
  assert.equal(expandCommand("修复 issue #$ARGUMENTS，写上测试。", " 123 "), "修复 issue #123，写上测试。");
  assert.equal(expandCommand("把 $1 改名为 $2，$3 不存在", "old new"), "把 old 改名为 new， 不存在");
  assert.equal(expandCommand("跑一遍测试", "只跑 unit"), "跑一遍测试\n\n只跑 unit");
  assert.equal(expandCommand("跑一遍测试", ""), "跑一遍测试");
  assert.equal(expandCommand("$ARGUMENTS", "a $1 b"), "a $1 b", "what the person typed is not expanded again");
});

test("a project's commands come from .claude/commands (and below it) and .codex/prompts; the product's own names win", async (t) => {
  const cwd = await project(t);
  await mkdir(path.join(cwd, ".claude", "commands", "frontend"), { recursive: true });
  await mkdir(path.join(cwd, ".codex", "prompts"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "commands", "add-test.md"), "---\ndescription: 补测试\nargument-hint: <函数>\n---\n给 $ARGUMENTS 补测试。");
  await writeFile(path.join(cwd, ".claude", "commands", "frontend", "component.md"), "写一个组件。");
  await writeFile(path.join(cwd, ".claude", "commands", "review.md"), "不会被用到：/review 是产品自己的");
  await writeFile(path.join(cwd, ".claude", "commands", "empty.md"), "---\ndescription: 只有头\n---\n");
  await writeFile(path.join(cwd, ".claude", "commands", "bad name.md"), "名字里有空格");
  await writeFile(path.join(cwd, ".codex", "prompts", "add-test.md"), "同名的，第一份为准");
  await writeFile(path.join(cwd, ".codex", "prompts", "explain.md"), "解释 $1");
  const commands = await listProjectCommands(cwd, { reserved: ["review", "undo"] });
  assert.deepEqual(commands.map((command) => [command.name, command.source, command.takesArguments, command.aliases]), [
    ["add-test", path.join(".claude", "commands", "add-test.md"), true, []],
    ["explain", path.join(".codex", "prompts", "explain.md"), true, []],
    ["frontend/component", path.join(".claude", "commands", "frontend", "component.md"), false, ["component"]],
  ]);
  assert.equal(commands[0].description, "补测试"); assert.equal(commands[0].argumentHint, "<函数>");
  assert.deepEqual(await projectCommand(cwd, "ADD-TEST", "greet", { reserved: ["review"] }),
    { name: "add-test", source: path.join(".claude", "commands", "add-test.md"), text: "给 greet 补测试。" });
  assert.equal((await projectCommand(cwd, "component", "", { reserved: ["review"] })).name, "frontend/component");
  await assert.rejects(projectCommand(cwd, "review", "", { reserved: ["review"] }), /没有 \/review 这个命令/);
  assert.deepEqual(await listProjectCommands(path.join(cwd, ".codex")), [], "a folder without commands has none");
});

test("deep commands use relative names, unique old basenames stay aliases, and ambiguous ones list candidates", async (t) => {
  const cwd = await project(t);
  await mkdir(path.join(cwd, ".claude", "commands", "frontend", "components", "forms", "fields"), { recursive: true });
  await mkdir(path.join(cwd, ".claude", "commands", "backend"), { recursive: true });
  await mkdir(path.join(cwd, ".claude", "commands", "ops"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "commands", "frontend", "components", "forms", "fields", "validate.md"), "校验 $ARGUMENTS");
  await writeFile(path.join(cwd, ".claude", "commands", "frontend", "build.md"), "构建前端");
  await writeFile(path.join(cwd, ".claude", "commands", "backend", "build.md"), "构建后端");
  await writeFile(path.join(cwd, ".claude", "commands", "ops", "review.md"), "复核运维");

  const commands = await listProjectCommands(cwd, { reserved: PRODUCT_COMMANDS });
  assert.deepEqual(commands.map((command) => [command.name, command.aliases]), [
    ["backend/build", []],
    ["frontend/build", []],
    ["frontend/components/forms/fields/validate", ["validate"]],
    ["ops/review", []],
  ]);
  assert.equal((await projectCommand(cwd, "validate", "email", { reserved: PRODUCT_COMMANDS })).text, "校验 email", "the unique old basename remains usable");
  assert.equal((await projectCommand(cwd, "frontend/components/forms/fields/validate", "name", { reserved: PRODUCT_COMMANDS })).text, "校验 name");
  assert.equal((await projectCommand(cwd, "ops/review", "", { reserved: PRODUCT_COMMANDS })).text, "复核运维", "a reserved basename does not hide a namespaced command");
  await assert.rejects(projectCommand(cwd, "build", "", { reserved: PRODUCT_COMMANDS }), /多个候选.*backend\/build.*frontend\/build/);
});

test("an exact root command keeps its old meaning when a nested basename matches", async (t) => {
  const cwd = await project(t);
  await mkdir(path.join(cwd, ".claude", "commands", "frontend"), { recursive: true });
  await writeFile(path.join(cwd, ".claude", "commands", "build.md"), "原来的根命令");
  await writeFile(path.join(cwd, ".claude", "commands", "frontend", "build.md"), "前端命令");
  assert.equal((await projectCommand(cwd, "build", "")).text, "原来的根命令");
  assert.equal((await projectCommand(cwd, "frontend/build", "")).text, "前端命令");
});

test("a command file that leads out of the project, or is too big, is not read", async (t) => {
  const cwd = await project(t), outside = await project(t);
  await mkdir(path.join(cwd, ".claude", "commands"), { recursive: true });
  await writeFile(path.join(outside, "secret.md"), "项目外面的文件");
  await symlink(path.join(outside, "secret.md"), path.join(cwd, ".claude", "commands", "secret.md"));
  await writeFile(path.join(cwd, ".claude", "commands", "huge.md"), "x".repeat(65 * 1024));
  assert.deepEqual(await listProjectCommands(cwd), []);
  await assert.rejects(projectCommand(cwd, "secret", ""), /没有 \/secret 这个命令/);
});

test("the names left to the product are exactly the slash commands the page offers", async () => {
  const page = await readFile(new URL("../src/desktop/renderer/app.js", import.meta.url), "utf8");
  const offered = [...page.slice(page.indexOf("const SLASH_COMMANDS"), page.indexOf("]);", page.indexOf("const SLASH_COMMANDS"))).matchAll(/name: "([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...PRODUCT_COMMANDS].sort(), offered.sort());
});
