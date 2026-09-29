// The check that every test written at the top level of a test file ran
// (scripts/check-test-inventory.js) catches the way tests went missing on
// 2026-09-24: under --test-force-exit, a test registered after a top-level
// await never ran, and the run still ended green.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { declaredTests, missingTests } from "../scripts/check-test-inventory.js";

const run = promisify(execFile);
const reporter = path.resolve("scripts/test-inventory-reporter.mjs");

test("a test written after a top-level await that --test-force-exit never ran is named", { timeout: 60_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-inventory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "sample.test.js"), [
    'import test from "node:test";',
    'test("before", () => {});',
    "// Keeps the process busy past the first test; force-exit ends it here.",
    "setTimeout(() => {}, 10_000);",
    "await new Promise((resolve) => setTimeout(resolve, 300));",
    'test("after", () => {});',
    "",
  ].join("\n"));
  const inventory = path.join(directory, "inventory.json");
  const flags = ["--test", "--test-reporter=tap", "--test-reporter-destination=/dev/null", `--test-reporter=${reporter}`, `--test-reporter-destination=${inventory}`];
  const check = async (extra) => {
    // Without NODE_TEST_CONTEXT, which the runner running this test sets: with it
    // the child reports to its parent over stdout and ignores --test-reporter.
    const { NODE_TEST_CONTEXT: _parent, ...env } = process.env;
    await run(process.execPath, [...flags, ...extra, path.join(directory, "sample.test.js")], { cwd: directory, timeout: 30_000, env }).catch((error) => error);
    return missingTests(declaredTests(directory), JSON.parse(await readFile(inventory, "utf8")).ran).map((row) => row.line);
  };
  assert.deepEqual(declaredTests(directory).map((row) => row.line), [2, 6]);
  assert.deepEqual(await check([]), [], "run normally, both tests ran");
  const lost = await check(["--test-force-exit"]);
  // Whether this Node drops it or not, the check reports exactly what did not run.
  assert.ok(lost.length === 0 || (lost.length === 1 && lost[0] === 6), `only the test after the await can go missing: ${lost}`);
});

test("what ran is matched by file and line, so a missing one is named", () => {
  const declared = [{ file: "/x/a.test.js", line: 3 }, { file: "/x/a.test.js", line: 9 }, { file: "/x/b.test.js", line: 1 }];
  const ran = [{ file: "/x/a.test.js", line: 3 }, { file: "/x/a.test.js", line: 3 }, { file: "/x/b.test.js", line: 1 }];
  assert.deepEqual(missingTests(declared, ran), [{ file: "/x/a.test.js", line: 9 }]);
});
