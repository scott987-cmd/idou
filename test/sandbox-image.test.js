import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_LABELS, approvedImageFaults, dockerPlatform, expectedImageLabels, imageFaults, imagePlatform, pinnedImage, sandboxImageTag } from "../src/control-plane/sandbox/sandbox-image.js";
import { readPins } from "../src/providers/runtime-artifacts.js";
import { readReleaseManifest } from "../src/providers/release-manifest.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pins = await readPins();
const release = await readReleaseManifest();
const DIGEST = "a".repeat(64);

test("the image tag is derived from the lock, not written down a second time", () => {
  assert.equal(sandboxImageTag(pins), `${pins.sandbox.repository}:${pins.codex.version}-${pins.feishu.version}`);
  const bumped = { ...pins, codex: { ...pins.codex, version: "0.200.0" } };
  assert.equal(sandboxImageTag(bumped), `${pins.sandbox.repository}:0.200.0-${pins.feishu.version}`, "a version bump moves the tag with it");
});

test("the labels a correct build carries come from the lock's digests", () => {
  const labels = expectedImageLabels(pins, "linux-arm64");
  assert.deepEqual(labels, {
    [IMAGE_LABELS.codex]: pins.codex.version,
    [IMAGE_LABELS.codexSha256]: pins.codex.vendorArtifacts["linux-arm64"].files["bin/codex"],
    [IMAGE_LABELS.larkCli]: pins.feishu.version,
    [IMAGE_LABELS.larkCliSha256]: pins.feishu.bundledArtifacts["linux-arm64"].sha256,
    [IMAGE_LABELS.platform]: "linux-arm64",
  });
});

// The platform matrix as the lock has it: both Linux architectures reviewed
// (x64 since 2026-09-22, for the x86 server), and nothing a build could be
// checked against for any other.
test("a platform without reviewed artifacts has no expected image at all", () => {
  assert.equal(expectedImageLabels(pins, "linux-x64")[IMAGE_LABELS.codexSha256], pins.codex.vendorArtifacts["linux-x64"].files["bin/codex"]);
  assert.notEqual(pins.codex.vendorArtifacts["linux-x64"].files["bin/codex"], pins.codex.vendorArtifacts["linux-arm64"].files["bin/codex"], "each architecture has its own binary");
  assert.equal(expectedImageLabels(pins, "linux-riscv64"), null);
  assert.equal(expectedImageLabels(pins, "darwin-arm64"), null, "a Mach-O CLI cannot run in a Linux image");
});

test("Docker's architecture names and the lock's are translated both ways", () => {
  assert.equal(imagePlatform("linux", "arm64"), "linux-arm64");
  assert.equal(imagePlatform("linux", "amd64"), "linux-x64");
  assert.equal(dockerPlatform("linux-x64"), "linux/amd64");
  assert.equal(dockerPlatform("linux-arm64"), "linux/arm64");
});

test("only a digest pins an image", () => {
  assert.equal(pinnedImage(`mydoubao/sandbox@sha256:${DIGEST}`), true);
  assert.equal(pinnedImage(`registry.example.com:5000/team/sandbox:1.0@sha256:${DIGEST}`), true);
  assert.equal(pinnedImage("mydoubao/sandbox:0.147.0-1.0.78"), false);
  assert.equal(pinnedImage(`mydoubao/sandbox@sha256:${"a".repeat(63)}`), false);
  assert.equal(pinnedImage(`mydoubao/sandbox@sha256:${DIGEST}:latest`), false);
  assert.equal(pinnedImage(undefined), false);
  // An image ID names bytes too: the digest of the config, which names every
  // layer. It is what a classic image store calls an image it loaded.
  assert.equal(pinnedImage(`sha256:${DIGEST}`), true);
  assert.equal(pinnedImage(`sha256:${"a".repeat(63)}`), false);
  assert.equal(pinnedImage(`SHA256:${DIGEST}`), false);
  assert.equal(pinnedImage(`sha256:${DIGEST}:latest`), false);
  assert.equal(pinnedImage(DIGEST), false, "a bare hex string is not a reference Docker resolves by digest");
});

test("an image is judged against the lock by what it says it was built from", () => {
  const good = { os: "linux", architecture: "arm64", labels: expectedImageLabels(pins, "linux-arm64") };
  assert.deepEqual(imageFaults(good, pins), []);

  const unlabeled = imageFaults({ os: "linux", architecture: "arm64", labels: {} }, pins);
  assert.equal(unlabeled.length, 1);
  assert.match(unlabeled[0], /没有版本标签/);

  const stale = imageFaults({ ...good, labels: { ...good.labels, [IMAGE_LABELS.codex]: "0.140.0" } }, pins);
  assert.equal(stale.length, 1);
  assert.match(stale[0], /com\.mydoubao\.codex 是 0\.140\.0，发布清单要求 /);

  const swapped = imageFaults({ ...good, labels: { ...good.labels, [IMAGE_LABELS.larkCliSha256]: DIGEST } }, pins);
  assert.match(swapped.join(), /lark-cli\.sha256/);

  // An arm64 build that says it is amd64 is judged by the x64 pins, and its
  // own labels give it away; an architecture nobody reviewed has nothing to be
  // judged by.
  assert.match(imageFaults({ os: "linux", architecture: "amd64", labels: good.labels }, pins).join(), /com\.mydoubao\.platform 是 linux-arm64，发布清单要求 linux-x64/);
  assert.match(imageFaults({ os: "linux", architecture: "riscv64", labels: good.labels }, pins).join(), /linux-riscv64 没有经过审核/);
});

test("an immutable image must also be the digest approved by the signed release", () => {
  const approved = release.sandboxImages["linux-arm64"];
  const image = { os: "linux", architecture: "arm64", id: approved.id,
    labels: expectedImageLabels(pins, "linux-arm64", release.upstreamsSha256) };
  assert.deepEqual(approvedImageFaults(approved.reference, image, release), []);
  assert.match(approvedImageFaults(`mydoubao/sandbox@sha256:${DIGEST}`, image, release).join(), /不是签名发布/);
  assert.match(approvedImageFaults(approved.reference, { ...image, id: `sha256:${DIGEST}` }, release).join(), /镜像 ID/);
  const stale = { ...image, labels: { ...image.labels, [IMAGE_LABELS.releaseUpstreamsSha256]: DIGEST } };
  assert.match(approvedImageFaults(approved.reference, stale, release).join(), /没有绑定当前签名上游组合/);
});

// A server whose Docker keeps images in the classic store loads the approved
// image rather than pulling it, and has no repository digest to call it by --
// only the ID, the digest of the config. The release approves that name beside
// the digest; either is accepted, and each only with its own ID.
test("on a classic image store the approved image is pinned by its ID, and only by the approved one", () => {
  const [DIGEST_A, CONFIG_B, OTHER_C] = ["a", "b", "c"].map((hex) => `sha256:${hex.repeat(64)}`);
  const signed = { ...release, sandboxImages: { "linux-x64": { reference: `mydoubao/sandbox@${DIGEST_A}`, id: DIGEST_A,
    baseImage: pins.sandbox.baseImage, classicId: CONFIG_B } } };
  const loaded = { os: "linux", architecture: "amd64", id: CONFIG_B, labels: expectedImageLabels(pins, "linux-x64", release.upstreamsSha256) };
  assert.deepEqual(approvedImageFaults(CONFIG_B, loaded, signed), [], "the ID a classic store gives the approved image");
  assert.deepEqual(approvedImageFaults(`mydoubao/sandbox@${DIGEST_A}`, { ...loaded, id: DIGEST_A }, signed), [], "the digest still works where the store has one");
  assert.match(approvedImageFaults(CONFIG_B, { ...loaded, id: OTHER_C }, signed).join(), /镜像 ID/, "the approved name must resolve to the approved image");
  assert.match(approvedImageFaults(CONFIG_B, { ...loaded, id: DIGEST_A }, signed).join(), /镜像 ID/, "each name only with its own ID");
  assert.match(approvedImageFaults(OTHER_C, { ...loaded, id: OTHER_C }, signed).join(), /不是签名发布/, "an ID the release did not approve");
  // A release that recorded no classic ID approves no bare ID, not even the
  // digest's own hex under the other name.
  const digestOnly = { ...signed, sandboxImages: { "linux-x64": { ...signed.sandboxImages["linux-x64"], classicId: undefined } } };
  delete digestOnly.sandboxImages["linux-x64"].classicId;
  assert.match(approvedImageFaults(DIGEST_A, { ...loaded, id: DIGEST_A }, digestOnly).join(), /不是签名发布/);
});

// What makes the lock the one source: nothing else may carry a version or a
// digest that could fall out of step with it.
test("the Dockerfile has no defaults to drift and downloads nothing", async () => {
  const dockerfile = await readFile(path.join(root, "sandbox", "Dockerfile"), "utf8");
  const instructions = dockerfile.split("\n").filter((line) => !line.trimStart().startsWith("#"));
  for (const line of instructions.filter((row) => /^ARG\s/.test(row))) {
    assert.doesNotMatch(line, /=/, `${line.trim()} has a default`);
  }
  const code = instructions.join("\n");
  assert.doesNotMatch(code, /npm (install|i|ci)\b|curl |wget |git clone|ADD\s+https?:/, "the image build fetches nothing");
  assert.doesNotMatch(code, new RegExp(pins.codex.version.replace(/\./g, "\\.")), "no Codex version in the Dockerfile");
  assert.doesNotMatch(code, new RegExp(pins.feishu.version.replace(/\./g, "\\.")), "no Feishu CLI version in the Dockerfile");
  assert.match(code, /sha256sum --strict -c/, "the whole Codex tree is checked inside the build");
  assert.match(code, /LARK_CLI_SHA256.*sha256sum -c/, "the Feishu CLI is checked by digest inside the build");
  assert.match(code, /third_party\/codex\/LICENSE/, "the Codex license is copied into the image");
  assert.match(code, /RELEASE_UPSTREAMS_SHA256/, "the image is bound to the signed upstream combination");
});

test("no source file or script repeats the image tag the lock implies", async () => {
  const tag = sandboxImageTag(pins);
  const offenders = [];
  for (const dir of ["src", "scripts", "bin"]) {
    for (const entry of await readdir(path.join(root, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(js|cjs|mjs)$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if ((await readFile(file, "utf8")).includes(tag)) offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
