import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileDigest, platformKey, readPins, verifyTree } from "../src/providers/runtime-artifacts.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");

// A tree as the lock would describe it: relative path -> digest.
async function tree(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content, { mode: 0o755 });
  }
  return { root, expected: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha(content)])) };
}

test("a tree is accepted only when it is exactly what the lock lists", async (t) => {
  const { root, expected } = await tree(t, { "bin/codex": "reviewed binary", "codex-path/rg": "reviewed rg", "codex-package.json": "{}" });
  assert.equal(await verifyTree(root, expected), 3);
});

test("a replaced file of the same size is refused, and the message names it", async (t) => {
  const { root, expected } = await tree(t, { "bin/codex": "reviewed binary", "codex-path/rg": "reviewed rg" });
  await writeFile(path.join(root, "codex-path/rg"), "forged!! rg");
  await assert.rejects(verifyTree(root, expected), /codex-path\/rg 的摘要与发布清单不符/);
});

test("a missing file is refused", async (t) => {
  const { root, expected } = await tree(t, { "bin/codex": "reviewed binary" });
  await assert.rejects(verifyTree(root, { ...expected, "bin/codex-code-mode-host": sha("helper") }), /缺少 bin\/codex-code-mode-host/);
});

// A library dropped beside a reviewed binary is loaded by it, so an addition is
// as much a tampering as a change.
test("a file the lock does not list is refused", async (t) => {
  const { root, expected } = await tree(t, { "bin/codex": "reviewed binary" });
  await writeFile(path.join(root, "bin/libpreload.so"), "not reviewed");
  await assert.rejects(verifyTree(root, expected), /发布清单之外的文件 bin\/libpreload\.so/);
});

test("a symbolic link is refused rather than followed", async (t) => {
  const { root, expected } = await tree(t, { "bin/codex": "reviewed binary" });
  await symlink("/bin/sh", path.join(root, "bin/sh"));
  await assert.rejects(verifyTree(root, expected), /bin\/sh 不是普通文件/);
});

test("Finder's .DS_Store is not mistaken for an added file", async (t) => {
  const { root, expected } = await tree(t, { "bin/codex": "reviewed binary" });
  await writeFile(path.join(root, ".DS_Store"), "finder");
  await writeFile(path.join(root, "bin/.DS_Store"), "finder");
  assert.equal(await verifyTree(root, expected), 1);
});

test("an empty manifest verifies nothing, so it is refused", async (t) => {
  const { root } = await tree(t, { "bin/codex": "reviewed binary" });
  await assert.rejects(verifyTree(root, {}), /没有列出任何文件/);
  await assert.rejects(verifyTree(root, undefined), /没有列出任何文件/);
});

test("a directory that does not exist is named, not reported as a stack trace", async () => {
  await assert.rejects(verifyTree("/nonexistent/mydoubao/codex", { "bin/codex": sha("x") }), /\/nonexistent\/mydoubao\/codex 不存在/);
});

// The cache is what makes checking before every launch affordable, so it must
// never be what lets a tampered binary through. A same-size rewrite with the
// modification time put back is the case a naive (size, mtime) cache misses.
test("the cache does not hide a same-size rewrite whose mtime was put back", async (t) => {
  const { root, expected } = await tree(t, { "bin/codex": "reviewed binary" });
  const file = path.join(root, "bin/codex");
  // Whole seconds, so the forger can put the time back exactly.
  const SECONDS = 1_700_000_000;
  await utimes(file, SECONDS, SECONDS);
  const cache = new Map();
  assert.equal(await verifyTree(root, expected, { cache }), 1);
  assert.ok(cache.has(root), "a verified tree is remembered");
  const before = await stat(file);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(file, "forged  binary!");
  await utimes(file, SECONDS, SECONDS);
  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, "the forgery put the modification time back");
  assert.equal(after.size, before.size, "and kept the size");
  assert.equal(after.ino, before.ino, "and the inode");
  await assert.rejects(verifyTree(root, expected, { cache }), /bin\/codex 的摘要与发布清单不符/);
});

test("a refused tree is not remembered as verified", async (t) => {
  const { root, expected } = await tree(t, { "bin/codex": "reviewed binary" });
  await writeFile(path.join(root, "bin/codex"), "forged binary!!");
  const cache = new Map();
  await assert.rejects(verifyTree(root, expected, { cache }));
  assert.equal(cache.has(root), false);
});

test("the digest is the SHA-256 of the file's bytes, streamed", async (t) => {
  const { root } = await tree(t, { big: "x".repeat(300_000) });
  assert.equal(await fileDigest(path.join(root, "big")), sha("x".repeat(300_000)));
});

test("the lock describes Codex per file for every platform it pins, keyed the way Node names platforms", async () => {
  const pins = await readPins();
  const platforms = Object.keys(pins.codex.vendorArtifacts).filter((key) => key !== "provenance");
  assert.ok(platforms.includes(platformKey("darwin", "arm64")));
  assert.ok(platforms.includes("linux-arm64"));
  for (const platform of platforms) {
    assert.match(platform, /^(darwin|linux|win32)-(arm64|x64)$/, `${platform} is not a Node platform name`);
    const files = pins.codex.vendorArtifacts[platform].files;
    assert.ok(files["bin/codex"], `${platform} pins the Codex binary itself`);
    for (const [name, digest] of Object.entries(files)) {
      assert.match(digest, /^[a-f0-9]{64}$/, `${platform} ${name}`);
      assert.match(name, /^[A-Za-z0-9._/-]+$/, `${platform} ${name} could not be passed through a build argument`);
    }
  }
  for (const platform of Object.keys(pins.feishu.bundledArtifacts)) assert.match(platform, /^(darwin|linux|win32)-(arm64|x64)$/);
  assert.match(pins.sandbox.baseImage, /@sha256:[a-f0-9]{64}$/, "the base image is named by digest");
});
