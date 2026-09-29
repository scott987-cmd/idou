import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applicationRoot, readReleaseManifest, releaseVerification, verifyReleaseLicenses } from "../src/providers/release-manifest.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const entry of ["package.json", "package-lock.json", "upstreams.lock.json", "release", "third_party", "src", "bin"]) {
    await cp(path.join(applicationRoot, entry), path.join(root, entry), { recursive: true });
  }
  return root;
}

test("the current release signature binds the app, upstreams, licenses and approved sandbox", async () => {
  const release = await readReleaseManifest();
  assert.equal(release.application.name, "idou");
  // The signed release carries the lock itself, not a version someone typed:
  // a fixed version here failed on every upgrade and proved nothing between.
  const lock = JSON.parse(await readFile(new URL("../upstreams.lock.json", import.meta.url), "utf8"));
  assert.deepEqual(release.upstreams, lock);
  assert.match(release.sandboxImages["linux-arm64"].reference, /@sha256:[a-f0-9]{64}$/);
  assert.equal(await verifyReleaseLicenses(release), true);
});

test("changing the signed manifest is refused", async t => {
  const root = await fixture(t);
  const file = path.join(root, "release", "manifest.json");
  const manifest = JSON.parse(await readFile(file));
  manifest.upstreams.codex.version = "0.147.1";
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(readReleaseManifest(root), /签名无效/);
});

test("a signed manifest cannot be paired with a different mutable lock", async t => {
  const root = await fixture(t);
  const file = path.join(root, "upstreams.lock.json");
  const lock = JSON.parse(await readFile(file));
  lock.codex.version = "0.147.1";
  await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(readReleaseManifest(root), /上游锁摘要无效/);
});

test("license bytes are verified separately from their presence", async t => {
  const root = await checkout(t), release = await readReleaseManifest(root);
  await writeFile(path.join(root, release.licenses.codex.noticeFile), "replacement notice\n");
  await assert.rejects(verifyReleaseLicenses(release, root), /NOTICE 与签名发布清单不一致/);
});

// Who is running decides how much the release proves (release-manifest.js). A
// checkout -- a `.git` beside the code -- is someone working on it: an edit must
// not stop the tests, the app or the development server, and nobody outside the
// release owner can sign. Everything that ships stays strict.
async function checkout(t) {
  const root = await fixture(t);
  await mkdir(path.join(root, ".git"));
  // As a contributor's machine runs it, whatever the run of these tests was
  // asked to be (npm run check:release sets IDOU_RELEASE_VERIFICATION=strict).
  const saved = process.env.IDOU_RELEASE_VERIFICATION;
  delete process.env.IDOU_RELEASE_VERIFICATION;
  t.after(() => { if (saved !== undefined) process.env.IDOU_RELEASE_VERIFICATION = saved; });
  return root;
}
const touch = (root) => writeFile(path.join(root, "src", "a-contributors-edit.js"), "export const edited = true;\n");

test("a checkout whose source moved on runs as a development release of the signed one", async t => {
  const root = await checkout(t), signed = JSON.parse(await readFile(path.join(root, "release", "manifest.json"), "utf8"));
  await touch(root);
  const release = await readReleaseManifest(root);
  assert.equal(release.development, true);
  assert.equal(release.releaseId, `${signed.releaseId}+dev`, "named after what it grew from");
  assert.deepEqual(release.upstreams, signed.upstreams, "the binaries are still the reviewed ones");
  assert.deepEqual(release.sandboxImages, signed.sandboxImages, "the same lock keeps the sandbox approvals");
  assert.equal(await verifyReleaseLicenses(release, root), true);
  await assert.rejects(readReleaseManifest(root, { strict: true }), /与应用源码或适配器协议不一致/, "releasing it still needs a signature");
});

test("a checkout with its own lock keeps the lock's binaries and none of the signed approvals", async t => {
  const root = await checkout(t);
  const file = path.join(root, "upstreams.lock.json");
  const lock = JSON.parse(await readFile(file, "utf8"));
  lock.feishu.version = `${lock.feishu.version}-local`;
  await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`);
  const release = await readReleaseManifest(root);
  assert.equal(release.development, true);
  assert.equal(release.upstreams.feishu.version, lock.feishu.version, "what is on disk is what is pinned");
  assert.deepEqual(release.sandboxImages, {}, "no image was approved for this lock, so a production sandbox runs none");
});

test("a checkout without a signed release, or with a forged one, approves nothing", async t => {
  const bare = await checkout(t);
  await rm(path.join(bare, "release"), { recursive: true, force: true });
  const unreleased = await readReleaseManifest(bare);
  assert.equal(unreleased.releaseId, "unreleased+dev");
  assert.deepEqual(unreleased.sandboxImages, {});
  assert.equal(await verifyReleaseLicenses(unreleased, bare), true, "the licenses it carries are the ones beside it");

  const forged = await checkout(t);
  const file = path.join(forged, "release", "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.sandboxImages["linux-x64"].reference = `${manifest.sandboxImages["linux-x64"].reference.split("@")[0]}@sha256:${"0".repeat(64)}`;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  const release = await readReleaseManifest(forged);
  assert.deepEqual(release.sandboxImages, {}, "an image named by a manifest the signature does not cover is not approved");
  assert.equal(release.releaseId, "unreleased+dev");
});

test("a release directory, an installed app and a strict run are held to the signature, checkout or not", async t => {
  const directory = await fixture(t);
  await touch(directory);
  await assert.rejects(readReleaseManifest(directory), /与应用源码或适配器协议不一致/, "no .git: what a server runs from");
  const root = await checkout(t);
  assert.equal(releaseVerification(root, { env: {}, packaged: false }), "development");
  assert.equal(releaseVerification(root, { env: {}, packaged: true }), "strict", "the installed app, whatever sits beside it");
  assert.equal(releaseVerification(root, { env: { IDOU_RELEASE_VERIFICATION: "strict" }, packaged: false }), "strict", "npm run check:release");
  assert.equal(releaseVerification(root, { env: { IDOU_SANDBOX_MODE: "production" }, packaged: false }), "strict", "a production sandbox");
  assert.equal(releaseVerification(directory, { env: {}, packaged: false }), "strict");
});
