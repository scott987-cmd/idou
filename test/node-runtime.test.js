import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NODE_PIN, bundledNodeBinary, nodeRuntime, verifyBundledNode } from "../src/providers/node-runtime.js";

// The Node the application runs its own scripts on (node-runtime.js): the one a
// packaged app carries, since its Electron can no longer act as Node (the
// RunAsNode fuse, scripts/package-mac.js), or the process's own runtime in
// development.

test("a packaged app runs its scripts on the Node it carries, and needs nothing added for it", () => {
  const resources = "/Applications/i豆.app/Contents/Resources";
  const runtime = nodeRuntime({ resourcesRoot: resources, execPath: "/Applications/i豆.app/Contents/MacOS/idou", electron: true });
  assert.equal(runtime.command, path.join(resources, "node", "bin", "node"));
  assert.deepEqual(runtime.env, {}, "no ELECTRON_RUN_AS_NODE: the application's Electron would not honour it");
  assert.equal(bundledNodeBinary(resources), runtime.command);
});

test("in development the process's own runtime is the Node: Electron told to act as one, or Node itself", () => {
  const electron = nodeRuntime({ resourcesRoot: null, execPath: "/w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", electron: true });
  assert.deepEqual({ ...electron, env: { ...electron.env } }, { command: "/w/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", env: { ELECTRON_RUN_AS_NODE: "1" } });
  const node = nodeRuntime({ resourcesRoot: null, execPath: "/usr/local/bin/node", electron: false });
  assert.deepEqual({ ...node, env: { ...node.env } }, { command: "/usr/local/bin/node", env: {} });
  assert.equal(bundledNodeBinary(null), null);
  // This test runs under plain Node, outside any packaged app.
  assert.equal(nodeRuntime().command, process.execPath);
});

const sha = (text) => createHash("sha256").update(text).digest("hex");
async function resources(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-node-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, "node", name)), { recursive: true });
    await writeFile(path.join(root, "node", name), text, { mode: 0o755 });
  }
  return root;
}
const pinsFor = (files) => ({ "darwin-arm64": { files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha(text)])) } });
const REVIEWED = { "bin/node": "reviewed node", LICENSE: "MIT" };

test("the Node a packaged app carries is used only while every file of it is the one the release pins", async (t) => {
  const root = await resources(t, REVIEWED), options = { resourcesRoot: root, platform: "darwin", arch: "arm64", pins: pinsFor(REVIEWED) };
  assert.equal(await verifyBundledNode(options), path.join(root, "node", "bin", "node"));

  await writeFile(path.join(root, "node", "bin", "node"), "a node someone swapped in");
  await assert.rejects(verifyBundledNode(options), /应用内置的 Node 与发布清单不符.*bin\/node 的摘要/);

  const added = await resources(t, { ...REVIEWED, "lib/libinjected.dylib": "loaded beside it" });
  await assert.rejects(verifyBundledNode({ ...options, resourcesRoot: added }), /发布清单之外的文件 lib\/libinjected\.dylib/);

  const missing = await resources(t, { "bin/node": REVIEWED["bin/node"] });
  await assert.rejects(verifyBundledNode({ ...options, resourcesRoot: missing }), /缺少 LICENSE/);

  await assert.rejects(verifyBundledNode({ ...options, platform: "linux", arch: "x64" }), /没有为 linux-x64 审核过的 Node/);
});

test("outside a packaged app there is no bundled Node to check", async () => {
  assert.equal(await verifyBundledNode({ resourcesRoot: null }), null);
});

// What is pinned is a whole, official build: its version, where it came from
// and how that was checked, and the two files that ship.
test("the pinned Node names its source, its provenance and exactly the files a packaged app ships", () => {
  assert.match(NODE_PIN.version, /^\d+\.\d+\.\d+$/);
  assert.equal(NODE_PIN.source, `https://nodejs.org/dist/v${NODE_PIN.version}/`);
  assert.match(NODE_PIN.provenance, /SHASUMS256\.txt.*signature/);
  const artifact = NODE_PIN["darwin-arm64"];
  assert.equal(artifact.archive, `node-v${NODE_PIN.version}-darwin-arm64.tar.gz`);
  assert.deepEqual(Object.keys(artifact.files).sort(), ["LICENSE", "bin/node"]);
  for (const digest of [artifact.archiveSha256, ...Object.values(artifact.files)]) assert.match(digest, /^[a-f0-9]{64}$/);
});
