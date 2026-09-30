import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneReleases } from "../bin/prune-releases.js";

// Old release directories on a server (bin/prune-releases.js). Found
// in the long-running review (2026-09-29): each deployment unpacked a release
// with its own node_modules and none was ever removed.
async function server(t, releases, current) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-releases-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of releases) {
    await mkdir(path.join(root, "releases", name, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "releases", name, "package.json"), "{}");
  }
  await symlink(path.join(root, "releases", current), path.join(root, "app"));
  return root;
}

test("the current release and the newest others up to --keep stay; the rest go only with --apply", async (t) => {
  const root = await server(t, ["0.1.0-20260926.221", "0.1.0-20260930.258", "0.1.0-20260930.263", "0.1.0-20260930.264", "0.1.0-20260922.176"], "0.1.0-20260930.258");
  await mkdir(path.join(root, "releases", "notes"));
  await mkdir(path.join(root, "releases", "0.1.0-20260930.264.partial"));
  const dry = await pruneReleases({ root, keep: 3 });
  assert.deepEqual(dry, { current: "0.1.0-20260930.258", kept: ["0.1.0-20260930.264", "0.1.0-20260930.263", "0.1.0-20260930.258"],
    removed: ["0.1.0-20260926.221", "0.1.0-20260922.176"], applied: false }, "the current one stays even when it is not among the newest");
  assert.equal((await readdir(path.join(root, "releases"))).length, 7, "nothing removed without --apply");
  await pruneReleases({ root, keep: 3, apply: true });
  assert.deepEqual((await readdir(path.join(root, "releases"))).sort(),
    ["0.1.0-20260930.258", "0.1.0-20260930.263", "0.1.0-20260930.264", "0.1.0-20260930.264.partial", "notes"], "and what is not a release id is somebody else's");
});

test("a sequence that grows a digit still sorts after the one before it", async (t) => {
  const root = await server(t, ["0.1.0-20261231.999", "0.1.0-20261231.1000", "0.1.0-20261231.998"], "0.1.0-20261231.1000");
  assert.deepEqual((await pruneReleases({ root, keep: 2 })).removed, ["0.1.0-20261231.998"]);
});

test("without an app link into releases, or asked to keep fewer than two, nothing is removed", async (t) => {
  const root = await server(t, ["0.1.0-20260930.264"], "0.1.0-20260930.264");
  await assert.rejects(pruneReleases({ root, keep: 1, apply: true }), /2 到 50/);
  await rm(path.join(root, "app"));
  await symlink(os.tmpdir(), path.join(root, "app"));
  await assert.rejects(pruneReleases({ root, keep: 3, apply: true }), /没有指向/);
  await assert.rejects(pruneReleases({ root: "relative", keep: 3 }), /绝对路径/);
});

test("run through a link to its release, as it is on a server, it runs", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const root = await server(t, ["0.1.0-20260930.263", "0.1.0-20260930.264"], "0.1.0-20260930.264");
  const tool = fileURLToPath(new URL("../bin/prune-releases.js", import.meta.url));
  const linked = path.join(root, "linked-bin");
  await symlink(path.dirname(tool), linked);
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(linked, "prune-releases.js"), "--root", root, "--keep", "2"]);
  assert.match(stdout, /当前发布 0\.1\.0-20260930\.264；保留 0\.1\.0-20260930\.264、0\.1\.0-20260930\.263；没有要删的。/);
});
