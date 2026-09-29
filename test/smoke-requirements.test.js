// No smoke may reach real money, a real account or the real machine in the
// default acceptance run. Each says what it needs in its own header
// (scripts/fixtures/smoke-requirements.js), and this reads every smoke's source
// for the plain signs of needing more than it says.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { declaredRequirements, evidentRequirements } from "../scripts/fixtures/smoke-requirements.js";

const scripts = path.resolve("scripts");

test("every smoke declares what the default run must not give it", async () => {
  const names = (await readdir(scripts)).filter((name) => /^smoke-.*\.js$/.test(name)).sort();
  assert.ok(names.length > 40, "the smokes must be where this test looks");
  const undeclared = [];
  for (const name of names) {
    const source = await readFile(path.join(scripts, name), "utf8");
    const declared = declaredRequirements(source);
    for (const [kind, why] of evidentRequirements(source)) if (!declared.has(kind)) undeclared.push(`${name}: ${why}，却没有声明 // @requires ${kind}: …`);
  }
  assert.deepEqual(undeclared, []);
});

test("the plain signs are recognised, and an optional --live is not one", () => {
  assert.ok(evidentRequirements(`if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live");`).has("live"));
  assert.ok(evidentRequirements(`const DATA = path.join(os.homedir(), "Library", "Application Support", "我的豆包");`).has("live"));
  assert.ok(evidentRequirements(`const CONFIG = path.join(os.homedir(), ".mydoubao", "mydoubao.env");`).has("live"));
  // The same places, found the way the product finds them since its rename (install-names.js).
  assert.ok(evidentRequirements(`const DATA = process.env.IDOU_DESKTOP_DATA_DIR || desktopProfileDir();`).has("live"));
  assert.ok(evidentRequirements(`const CONFIG = process.env.MINIMAX_CONFIG_FILE || localEnvFile();`).has("live"));
  assert.ok(evidentRequirements(`const DATA = path.join(os.homedir(), "Library", "Application Support", "i豆");`).has("live"));
  assert.equal(evidentRequirements(`const LIVE = localEnvFile();\nconst live = process.env.IDOU_SMOKE_NO_LIVE !== "1";`).size, 0);
  assert.equal(evidentRequirements(`const LIVE = path.join(os.homedir(), ".mydoubao", "mydoubao.env");\nconst live = process.env.IDOU_SMOKE_NO_LIVE !== "1";`).size, 0, "one that gives the real file up on IDOU_SMOKE_NO_LIVE=1 is fine");
  assert.equal(evidentRequirements(`const live = process.argv.includes("--live");`).size, 0, "an optional live mode is fine");
  assert.deepEqual([...declaredRequirements("#!/usr/bin/env node\n// @requires live: 真实付费模型调用\n").keys()], ["live"]);
});
