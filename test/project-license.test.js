import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The project's own LICENSE was once a copy of Codex's, appendix and all, so the
// repository told GitHub and every license scanner that OpenAI held its
// copyright (found in the pre-release review, 2026-10-06). The public snapshot's
// scan leaves LICENSE alone, so nothing else would notice.
test("the project's license is Apache-2.0 in its own name, not a copy of a dependency's", async () => {
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
  const [license, notice, codex, manifest] = await Promise.all([read("LICENSE"), read("NOTICE"), read("third_party/codex/LICENSE"), read("package.json")]);
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.equal(JSON.parse(manifest).license, "Apache-2.0");
  const holders = [...license.matchAll(/^Copyright (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(holders, ["2026 The idou Authors"], "the appendix names this project");
  assert.match(notice, /^Copyright 2026 The idou Authors$/mu, "and says what NOTICE says");
  assert.notEqual(license, codex, "not Codex's own LICENSE file");
});
