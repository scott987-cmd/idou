import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EITHER, ownHeader, ownHeaderName, ownFileName, sameFileName, SPELLINGS, WRITTEN } from "../src/product-names.js";

// Labels inside sealed and signed formats carry the product's old name, and
// renaming one would make everything already sealed or signed with it
// unreadable: sessions a desktop resumes with, sign-in and renewal proofs,
// Wiki keys, skill catalogs, the run queue's key and the route codes replicas
// share. A rename sweep has to leave these alone; this fails if one did.
const FROZEN = [
  ["src/control-plane/database.js", ['"mydoubao run queue v1"', '"mydoubao session route v1"']],
  ["src/control-plane/login-proof.js", ['"mydoubao-feishu-login-v1"', '"mydoubao-feishu-renewal-v1"']],
  ["src/control-plane/resume-credential.js", ['"mydoubao-feishu-resume-v1"']],
  ["src/control-plane/wiki-key-vault.js", ['"mydoubao-wiki-key-v1"']],
  ["src/skills/catalog-format.js", ['"mydoubao-skill-catalog-v1\\0"']],
];

test("the labels of sealed and signed formats keep the product's old name", async () => {
  for (const [file, labels] of FROZEN) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    for (const label of labels) assert.ok(source.includes(label), `${file} must still say ${label}`);
  }
});

test("our own headers are read under either spelling, and two that disagree are refused", () => {
  assert.deepEqual(SPELLINGS, ["idou", "mydoubao"]);
  assert.ok(SPELLINGS.includes(WRITTEN));
  assert.equal(ownHeaderName("run"), `x-${WRITTEN}-run`);
  assert.equal(ownHeader({ "x-idou-run": "a" }, "run"), "a");
  assert.equal(ownHeader({ "x-mydoubao-run": "a" }, "run"), "a");
  assert.equal(ownHeader({ "x-idou-run": "a", "x-mydoubao-run": "a" }, "run"), "a");
  assert.equal(ownHeader({}, "run"), undefined);
  assert.throws(() => ownHeader({ "x-idou-run": "a", "x-mydoubao-run": "b" }, "run"), /sent twice with different values/);
  assert.throws(() => ownHeader({ "x-idou-feishu-path": "/x", "x-mydoubao-feishu-path": "/y" }, "feishu-path"));
});

test("a file of ours is the same file under either spelling, and only then", () => {
  const id = "0f8b5c0e-1111-4222-8333-444455556666";
  assert.equal(ownFileName(`${id}.schedule.md`), `${WRITTEN}-${id}.schedule.md`);
  assert.equal(sameFileName(`mydoubao-${id}.schedule.md`, `idou-${id}.schedule.md`), true);
  assert.equal(sameFileName(`idou-${id}.schedule.md`, `mydoubao-${id}.schedule.md`), true);
  assert.equal(sameFileName(`idou-${id}.schedule.md`, `idou-${id}.app.json`), false, "a different kind");
  assert.equal(sameFileName(`other-${id}.schedule.md`, `idou-${id}.schedule.md`), false, "not ours");
  assert.equal(sameFileName("report.md", "report.md"), true, "a name that is not ours is compared as it is");
  assert.equal(sameFileName(undefined, undefined), false);
  const pattern = new RegExp(`^${EITHER}-x$`);
  assert.ok(pattern.test("idou-x") && pattern.test("mydoubao-x"));
  assert.ok(!pattern.test("i-x") && !pattern.test("xidou-x") && !pattern.test("idoux-x"));
});
