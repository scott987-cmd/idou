import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { applySolution, codingEvalTasks, materialize } from "../scripts/fixtures/coding-eval/index.js";

// 编程评测的分数只有在题目本身可靠时才有意义：原样交付的仓库必须过不了隐藏测试，
// 按参考改动之后必须全部通过；锁定的测试文件必须真实存在。这里不调用任何模型。
const { NODE_TEST_CONTEXT: _parent, ...childEnv } = process.env;
const runTests = cwd => spawnSync(process.execPath, ["--test"], { cwd, encoding: "utf8", timeout: 120_000, env: childEnv });

for (const task of await codingEvalTasks()) {
  test(`编程评测 ${task.id}：原样过不了隐藏测试，参考改动后全部通过`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "idou-coding-eval-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const starting = path.join(root, "starting"), solved = path.join(root, "solved");
    for (const target of [starting, solved]) { await materialize(task, "repo", target); await materialize(task, "hidden", target); }
    await applySolution(task, solved);
    for (const file of [...task.lockedTests, ...(task.preservedTests ?? [])]) assert.ok(existsSync(path.join(starting, file)), `${file} exists`);
    assert.notEqual(runTests(starting).status, 0, "the task is not already solved");
    const result = runTests(solved);
    assert.equal(result.status, 0, result.stdout.slice(-3000));
  });
}
