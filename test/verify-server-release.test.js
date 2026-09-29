import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { requireSignedSource } from "./helpers/signed-release.js";

const repository = path.resolve(import.meta.dirname, "..");
const script = path.join(repository, "scripts", "verify-server-release.js");
const target = `${process.platform}-${process.arch}`;
const run = (root) => promisify(execFile)(process.execPath, [script, root]).then(({ stdout }) => ({ ok: true, output: stdout }), (error) => ({ ok: false, output: error.stderr }));

// What docs/server-deployment.md ships, and what it used to ship: until
// 2026-09-25 every server release lacked resources/lark-cli, and scheduled runs
// failed at the end without anything saying so at deploy time.
test("a release without its platform's lark-cli is refused before it is switched to", async (t) => {
  // A server's release directory: held to the signed release.
  if (!(await requireSignedSource(t))) return;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-server-release-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["src", "bin", "release", "package.json", "package-lock.json", "upstreams.lock.json"]) await cp(path.join(repository, name), path.join(root, name), { recursive: true });

  const missing = await run(root);
  assert.equal(missing.ok, false);
  assert.match(missing.output, new RegExp(`lark-cli is missing for ${target}`));
  assert.match(missing.output, new RegExp(`resources/lark-cli/${target}`), "it names what the package has to carry");

  await mkdir(path.join(root, "resources", "lark-cli", target), { recursive: true });
  for (const file of ["lark-cli", "LICENSE"]) await copyFile(path.join(repository, "resources", "lark-cli", target, file), path.join(root, "resources", "lark-cli", target, file), constants.COPYFILE_FICLONE);
  const present = await run(root);
  assert.equal(present.ok, true, present.output);
  assert.match(present.output, /lark-cli version/, "the binary was run, not only hashed");
});
