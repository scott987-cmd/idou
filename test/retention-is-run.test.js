// A retention that nothing runs is a promise the code does not keep.
//
// Found in review (2026-10-03): SkillGovernance.pruneSubmissions -- decided
// submissions kept 180 days, as the design and the changelog said -- was
// written and tested, and never called; the table would have grown for ever.
// Every prune method the control plane defines has to be called somewhere
// other than where it is defined.
import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function sources(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const at = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sources(at));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(at);
  }
  return out;
}

test("every prune method the control plane defines is called by something", async () => {
  const files = [...await sources(path.resolve("src")), ...await sources(path.resolve("bin"))];
  const text = new Map(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")])));
  const defined = [];
  for (const [file, body] of text) {
    if (!file.includes(`${path.sep}control-plane${path.sep}`)) continue;
    for (const [, name] of body.matchAll(/^\s+(?:async\s+)?(prune[A-Za-z]*)\s*\(/gm)) defined.push({ file, name });
  }
  assert.ok(defined.some((entry) => entry.name === "pruneSubmissions"), "the patterns still find the methods");
  // Called by anything -- a timer in bin/server.js, or the class itself before it reads.
  const uncalled = defined.filter(({ name }) => ![...text.values()].some((body) => new RegExp(`\\.${name}\\(`).test(body)));
  assert.deepEqual(uncalled.map(({ file, name }) => `${path.relative(process.cwd(), file)} ${name}`), [], "prune methods nothing runs");
});
