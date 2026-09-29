#!/usr/bin/env node
// Every test written at the top level of a test file ran. Reads what
// scripts/test-inventory-reporter.mjs recorded and compares it with every
// `test(` at the start of a line in test/*.test.js; a test that is written
// but did not run fails the check, whatever the pass count says.
//
//   node scripts/check-test-inventory.js <inventory.json> [test directory]
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

export function declaredTests(directory) {
  const declared = [];
  for (const name of readdirSync(directory).filter((entry) => /\.test\.(?:c|m)?js$/.test(entry)).sort()) {
    const lines = readFileSync(path.join(directory, name), "utf8").split("\n");
    lines.forEach((text, index) => { if (/^test(?:\.(?:skip|todo|only))?\(/.test(text)) declared.push({ file: path.join(directory, name), line: index + 1 }); });
  }
  return declared;
}

// The runner reports a file by its real path (/private/var/…); a directory named
// through a symlink (/var/… on macOS) must not look like different files.
const real = (file) => { try { return realpathSync(path.resolve(file)); } catch { return path.resolve(file); } };
export function missingTests(declared, ran) {
  const executed = new Set(ran.map((row) => `${real(row.file)}:${row.line}`));
  return declared.filter((row) => !executed.has(`${real(row.file)}:${row.line}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [inventory, directory = "test"] = process.argv.slice(2);
  if (!inventory) { process.stderr.write("用法：node scripts/check-test-inventory.js <inventory.json> [test 目录]\n"); process.exit(2); }
  const { ran } = JSON.parse(readFileSync(inventory, "utf8"));
  const declared = declaredTests(path.resolve(directory));
  const missing = missingTests(declared, ran);
  if (missing.length) {
    process.stderr.write(`写了却没有运行的测试 ${missing.length} 条（运行了 ${ran.length} 条顶层测试）：\n`);
    for (const row of missing) process.stderr.write(`  ${path.relative(process.cwd(), row.file)}:${row.line}\n`);
    process.exit(1);
  }
  process.stdout.write(`写在测试文件里的 ${declared.length} 条顶层测试都运行了（共运行 ${ran.length} 条）\n`);
}
