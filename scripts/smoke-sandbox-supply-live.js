// What the sandbox supply chain refuses, asked of the real Docker daemon.
//
// Each case hands Docker something that must not become a running sandbox --
// bytes that print the right version and are not the reviewed ones, a file
// slipped in beside Codex, a build that skipped the script, an image nobody
// built, an image named by a movable tag in production -- and passes only when
// it is refused, and refused for that reason.
//
//   node scripts/smoke-sandbox-supply-live.js
//   node scripts/smoke-sandbox-supply-live.js --image mydoubao/sandbox:candidate
//
// The image under test defaults to the lock's tag; a candidate is named with
// --image before it replaces that tag.
//
// Nothing is downloaded: every build runs with --network none from a scratch
// copy of the build context, and every run uses --pull never. It leaves nothing
// behind: its scratch contexts are removed, and so are the untagged layers its
// refused builds committed on the way to being refused.
import "../src/adopt-legacy-env.js";
import { prepareContext } from "./sandbox-context.js";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../src/providers/process-runner.js";
import { readPins, verifyTree } from "../src/providers/runtime-artifacts.js";
import { readReleaseManifest } from "../src/providers/release-manifest.js";
import { DockerSandbox } from "../src/control-plane/sandbox/docker-sandbox.js";
import { sandboxJob } from "../src/control-plane/sandbox/job.js";
import { expectedImageLabels, imageFaults, imagePlatform, sandboxImageTag } from "../src/control-plane/sandbox/sandbox-image.js";
import { egressNetworkName } from "../src/control-plane/scheduled-tasks.js";

// The host's own sandbox network, as the server finds it.
const NETWORK = process.env.IDOU_SANDBOX_NETWORK || await egressNetworkName();

const root = fileURLToPath(new URL("..", import.meta.url));
const release = await readReleaseManifest();
const lock = await readPins();
const argument = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const docker = (args, timeoutMs = 600_000) => runProcess("docker", args, { cwd: root, timeoutMs, maxOutputBytes: 8 << 20 });

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
};

const daemon = await docker(["info", "--format", "{{.OSType}} {{.Architecture}}"], 30_000);
if (daemon.code !== 0) { console.log("Docker 不可用，本验收需要它。"); process.exit(1); }
const [daemonOs, daemonArch] = `${daemon.stdout}`.trim().split(/\s+/);
const platform = imagePlatform(daemonOs, { aarch64: "arm64", x86_64: "amd64" }[daemonArch] ?? daemonArch);
const cli = lock.feishu.bundledArtifacts[platform];
const codex = lock.codex.vendorArtifacts[platform];
if (!expectedImageLabels(lock, platform, release.upstreamsSha256)) { console.log(`锁文件没有 ${platform} 的产物，无从验收。`); process.exit(1); }
console.log(`platform ${platform}\n`);

// The files the Dockerfile copies, and nothing else, read from its COPY lines
// (scripts/sandbox-context.js): the list kept here by hand had fallen two
// files behind it. Cloned where the filesystem can (APFS), so 270 MB of Codex
// costs nothing per case.
const scratchRoot = await mkdtemp(path.join(os.homedir(), ".idou-supply-"));
const context = (mutate) => prepareContext(root, platform, { parent: scratchRoot, mutate });

const buildArgs = (overrides = {}) => Object.entries({
  BASE_IMAGE: lock.sandbox.baseImage,
  CODEX_VERSION: lock.codex.version,
  CODEX_SHA256: codex.files["bin/codex"],
  CODEX_FILES: Object.entries(codex.files).map(([name, digest]) => `${digest}  ${name}`).join(";"),
  LARK_CLI_VERSION: lock.feishu.version,
  LARK_CLI_SHA256: cli.sha256,
  RELEASE_UPSTREAMS_SHA256: release.upstreamsSha256,
  SANDBOX_PLATFORM: platform,
  ...overrides,
}).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]);

// Untagged images a refused build committed on its way to being refused, so
// they can be removed again. Only ids that did not exist before the build are
// candidates, only while they carry no tag, and always with --no-prune: without
// it Docker also deletes every untagged parent, and under the containerd image
// store that reached the build cache of images this script never made --
// measured, on the first run of this script.
const allImages = async () => new Set(`${(await docker(["images", "--all", "--quiet", "--no-trunc"], 60_000)).stdout}`.split("\n").filter(Boolean));
// --force-rm: a refused step leaves its container behind otherwise, and that
// container pins the layer it ran on.
const buildIn = (dir, args) => runProcess("docker", ["build", "--network", "none", "--force-rm", "--file", "sandbox/Dockerfile", ...args, "."], { cwd: dir, timeoutMs: 600_000, maxOutputBytes: 8 << 20 });

// Built from the scratch directory rather than the repository.
async function refusedBuild(label, dir, args, reason) {
  const before = await allImages();
  const result = await buildIn(dir, args).catch((error) => ({ code: -1, stdout: "", stderr: String(error.message) }));
  const out = `${result.stdout}\n${result.stderr}`;
  // Newest first, as Docker lists them, so a child goes before its parent.
  const created = [...await allImages()].filter((id) => !before.has(id));
  for (const id of created) {
    const tags = await docker(["image", "inspect", id, "--format", "{{len .RepoTags}}"], 30_000);
    if (`${tags.stdout}`.trim() === "0") await docker(["image", "rm", "--no-prune", id], 60_000).catch(() => {});
  }
  const matched = reason.test(out);
  check(label, result.code !== 0 && matched, result.code === 0 ? "the build SUCCEEDED" : (matched ? out.match(reason)[0] : out.trim().split("\n").slice(-3).join(" | ").slice(0, 300)));
}

try {
  console.log("构建：");

  // 1. The case a version check exists to miss.
  const fake = "#!/bin/sh\necho \"lark-cli version " + lock.feishu.version + "\"\n";
  const forged = await context(async (dir) => {
    const target = path.join(dir, "resources", "lark-cli", platform, "lark-cli");
    await writeFile(target, fake); await chmod(target, 0o755);
  });
  const says = await runProcess("/bin/sh", [path.join(forged, "resources", "lark-cli", platform, "lark-cli"), "--version"], { timeoutMs: 10_000 });
  check("the forged CLI really does report the pinned version", `${says.stdout}`.trim() === `lark-cli version ${lock.feishu.version}`, `${says.stdout}`.trim());
  await refusedBuild("a same-version forged Feishu CLI is refused by the build", forged, buildArgs(), /lark-cli: FAILED/);

  // 2. One of Codex's helpers, which run inside every task.
  const helper = await context(async (dir) => {
    const target = path.join(dir, "resources", "codex", platform, "codex-path", "rg");
    await writeFile(target, "#!/bin/sh\necho ripgrep 14.1.1\n"); await chmod(target, 0o755);
  });
  const hostCheck = await verifyTree(path.join(helper, "resources", "codex", platform), codex.files).then(() => "accepted", (error) => error.message);
  check("the build script's own check stops a replaced Codex helper before Docker", /codex-path\/rg/.test(hostCheck), hostCheck);
  await refusedBuild("a replaced Codex helper is refused by the build itself", helper, buildArgs(), /codex-path\/rg: FAILED/);

  // 3. Nothing changed, something added.
  const added = await context(async (dir) => {
    await writeFile(path.join(dir, "resources", "codex", platform, "bin", "libpreload.so"), "not reviewed");
  });
  const addedCheck = await verifyTree(path.join(added, "resources", "codex", platform), codex.files).then(() => "accepted", (error) => error.message);
  check("the build script's own check stops a file added beside Codex", /libpreload\.so/.test(addedCheck), addedCheck);
  await refusedBuild("a file added beside Codex is refused by the build itself", added, buildArgs(), /returned a non-zero code|exit code: 1|did not complete successfully/);

  // 4. The Dockerfile used on its own.
  const plain = await context(async () => {});
  await refusedBuild("a build that skipped the script is refused, with the reason", plain, buildArgs({ CODEX_FILES: undefined, LARK_CLI_SHA256: undefined }),
    /Build this image with scripts\/build-sandbox-image\.js/);
  await refusedBuild("a build with no base image named is refused", plain, [], /base name .*should not be blank|FROM requires|invalid reference format|failed to parse/i);

  console.log("\n运行：");
  const workspace = await mkdtemp(path.join(scratchRoot, "ws-"));
  const job = (image) => sandboxJob({ image, workspace, command: ["true"], network: { mode: "none" } });
  const verified = argument("--image") ?? sandboxImageTag(lock);
  const verifiedDigest = `${(await docker(["image", "inspect", verified, "--format", "{{join .RepoDigests \" \"}}"], 30_000)).stdout}`.trim().split(" ").find((entry) => entry.startsWith(`${lock.sandbox.repository}@`));
  if (!verifiedDigest) { check(`the lock's image ${verified} exists locally with a digest`, false, "build it first: npm run build:sandbox"); throw new Error("stop"); }

  // 5. Nothing is fetched to stand in for a missing image.
  const missing = `${lock.sandbox.repository}:never-built-${process.pid}`;
  const absent = await new DockerSandbox({ image: missing, pins: lock, gatewayNetwork: NETWORK }).available();
  check("a missing image is reported as missing", !absent.ok && /不在本机/.test(absent.reason ?? ""), absent.reason);
  const attempted = await new DockerSandbox({ image: missing, pins: lock }).execute(job(missing)).then((result) => `ran (${result.code})`, (error) => error.message);
  check("running it fails without pulling", /沙箱未能启动/.test(attempted), attempted.slice(0, 160));
  const stillAbsent = await docker(["image", "inspect", missing], 30_000);
  check("and nothing was pulled in its place", stillAbsent.code !== 0);

  // 6. The image that ran before this change.
  const previous = "mydoubao/sandbox@sha256:f7a2c6899113e25680cdc3560f44ece7b8f7669c1f22e16ee6ae8e05747bce8c";
  const hasPrevious = (await docker(["image", "inspect", previous], 30_000)).code === 0;
  if (hasPrevious) {
    const stale = await new DockerSandbox({ image: previous, pins: lock, gatewayNetwork: NETWORK }).available();
    check("an image built before the lock described images is named as unverifiable", (stale.faults ?? []).some((fault) => /没有版本标签/.test(fault)),
      (stale.faults ?? []).find((fault) => /镜像/.test(fault)));
  } else console.log("  SKIP  the pre-change image is no longer on this machine");

  // 7. The verified image, by digest.
  const current = await new DockerSandbox({ image: verifiedDigest, pins: lock, release, gatewayNetwork: NETWORK }).available();
  const imageComplaints = (current.faults ?? []).filter((fault) => /镜像/.test(fault));
  check("the verified image by digest raises no image fault", current.ok && imageComplaints.length === 0, imageComplaints.join("；") || verifiedDigest.slice(0, 40));
  const inspected = await new DockerSandbox({ image: verifiedDigest }).inspectImage();
  check("its labels are the lock's", imageFaults(inspected, lock).length === 0, `${Object.keys(inspected.labels ?? {}).length} labels`);

  // 8. Production, where the verdict has to stop the run and not only be printed.
  const launched = [];
  const watched = (command, args, options) => { if (args[0] === "run") launched.push(args); return runProcess(command, args, options); };
  const tagged = new DockerSandbox({ image: verified, pins: lock, release, gatewayNetwork: NETWORK, mode: "production", run: watched });
  const taggedVerdict = await tagged.available();
  check("production refuses an image named by tag", !taggedVerdict.ok && /按标签引用/.test(taggedVerdict.reason ?? ""), (taggedVerdict.reason ?? "").slice(0, 120));
  const blocked = await tagged.execute(job(verified)).then((result) => `ran (${result.code})`, (error) => error.message);
  check("and the run is stopped before any container starts", /生产模式拒绝执行/.test(blocked) && launched.length === 0, `${blocked.slice(0, 80)}; docker run calls: ${launched.length}`);

  const pinnedProd = new DockerSandbox({ image: verifiedDigest, pins: lock, release, gatewayNetwork: NETWORK, mode: "production", run: watched });
  const pinnedVerdict = await pinnedProd.available();
  const onThisMachine = (pinnedVerdict.faults ?? []).filter((fault) => !/镜像/.test(fault));
  check("by digest, production still refuses what this machine cannot isolate", !pinnedVerdict.ok && onThisMachine.length > 0 && !(pinnedVerdict.faults ?? []).some((fault) => /镜像/.test(fault)),
    onThisMachine.join("；").slice(0, 160));
  const stillBlocked = await pinnedProd.execute(job(verifiedDigest)).then((result) => `ran (${result.code})`, (error) => error.message);
  check("and that refusal also stops the run", /生产模式拒绝执行/.test(stillBlocked) && launched.length === 0, `docker run calls: ${launched.length}`);
} catch (error) {
  if (error.message !== "stop") { failures += 1; console.log(`  FAIL  ${error.stack ?? error}`); }
} finally {
  await rm(scratchRoot, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
