import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describeProjectDirectory, initGitRepository, isGitRepository } from "../src/application/project-directory.js";

const newDir = () => mkdtemp(path.join(os.tmpdir(), "idou-project-"));

test("初始化后目录里真的有仓库，状态如实上报", async () => {
  const cwd = await newDir();
  assert.equal((await describeProjectDirectory(cwd)).repository, false);
  assert.deepEqual(await initGitRepository(cwd), { created: true, reason: "created" });
  assert.equal(await isGitRepository(cwd), true);
  const described = await describeProjectDirectory(cwd);
  assert.equal(described.repository, true);
  assert.equal(described.name, path.basename(cwd));
  assert.equal(described.path, cwd);
});

test("已经是仓库时重复初始化不做任何事", async () => {
  const cwd = await newDir();
  await initGitRepository(cwd);
  assert.deepEqual(await initGitRepository(cwd), { created: false, reason: "already" });
});

test("不会在已有仓库里再套一个仓库", async () => {
  const outer = await newDir();
  await initGitRepository(outer);
  const inner = path.join(outer, "packages", "inner");
  await mkdir(inner, { recursive: true });
  const result = await initGitRepository(inner);
  assert.equal(result.created, false);
  assert.equal(result.reason, "nested");
  assert.equal(await isGitRepository(inner), false);
});

test("git 不可用时如实报错，不会假装建好了", async () => {
  const cwd = await newDir();
  await assert.rejects(() => initGitRepository(cwd, { git: path.join(cwd, "definitely-not-git") }), /初始化 Git 仓库失败/);
  assert.equal(await isGitRepository(cwd), false);
});

test("目录里已有内容时如实上报，初始化不会动这些内容", async () => {
  const cwd = await newDir();
  await writeFile(path.join(cwd, "keep.txt"), "重要内容");
  const before = await describeProjectDirectory(cwd);
  assert.equal(before.empty, false);
  assert.equal(before.entries, 1);
  await initGitRepository(cwd);
  assert.equal(await readFileText(path.join(cwd, "keep.txt")), "重要内容");
});

const readFileText = (file) => import("node:fs/promises").then(({ readFile }) => readFile(file, "utf8"));
