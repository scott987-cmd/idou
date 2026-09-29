// Every custom property the renderer's styles use must be defined somewhere.
// An undefined one does not fail loudly: the declaration that uses it becomes
// invalid at computed-value time and the property quietly falls back, so a
// warning is drawn in the inherited text colour and nobody sees why. --ink was
// found that way on 2026-09-23 and fixed in the one rule that was looked at;
// three more uses of it, and --warn, --surface and --hover, stayed broken.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const renderer = path.resolve("src/desktop/renderer");

test("the renderer uses no custom property it never defines", async () => {
  const defined = new Set(), used = [];
  for (const name of await readdir(renderer)) {
    if (!/\.(css|html|js)$/.test(name)) continue;
    const text = await readFile(path.join(renderer, name), "utf8");
    for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]);
    for (const match of text.matchAll(/setProperty\(\s*["'`](--[\w-]+)/g)) defined.add(match[1]);
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      // var(--x, fallback) says what happens when --x is missing; var(--x) does not.
      if (!match[2]) used.push({ name: match[1], file: name, line: text.slice(0, match.index).split("\n").length });
    }
  }
  assert.ok(defined.size > 5 && used.length > 5, "the styles must be where this test looks");
  assert.deepEqual(used.filter((row) => !defined.has(row.name)).map((row) => `${row.file}:${row.line} ${row.name}`), []);
});
