// Builds the scheduled-task sandbox image and checks it from the inside.
//
//   node scripts/build-sandbox-image.js                       tag from upstreams.lock.json
//   node scripts/build-sandbox-image.js --tag mydoubao/sandbox:candidate
//   IDOU_SANDBOX_PLATFORM=linux-x64 node scripts/build-sandbox-image.js
//   node scripts/build-sandbox-image.js --candidate            an upgrade, before it is signed
//
// Everything that goes in is checked against upstreams.lock.json before Docker
// sees it -- the Feishu CLI and every file of Codex by digest, the base image by
// digest -- and the build runs with no network, so nothing can be fetched in
// their place. After it is built, the same digests are read back out of the
// image itself: what a build was given and what it produced are two different
// claims, and only the second one is what runs.
//
// A platform the lock has no reviewed artifacts for is refused before anything
// else happens. Nothing is downloaded to fill the gap.
import "../src/adopt-legacy-env.js";
import { runProcess } from "../src/providers/process-runner.js";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { verifyBinary } from "../src/providers/feishu/bundled-runtime.js";
import { readPins, verifyTree } from "../src/providers/runtime-artifacts.js";
import { readReleaseManifest, verifyReleaseLicenses } from "../src/providers/release-manifest.js";
import { dockerPlatform, expectedImageLabels, imagePlatform, sandboxImageTag } from "../src/control-plane/sandbox/sandbox-image.js";
import { prepareContext } from "./sandbox-context.js";

const root = fileURLToPath(new URL("..", import.meta.url));
// An upgrade builds from a lock nobody has signed yet, and cannot do otherwise:
// signing checks this build's record against the lock it signs, so the image
// has to exist first. Checked against the signed release, as a plain build is,
// the new artifacts are refused and the upgrade can never be signed -- which is
// how every version change was blocked once releases were signed.
// `--candidate` checks what goes in against the working tree's
// upstreams.lock.json instead, and labels the image with that lock's digest:
// the digest the release will carry once signed with this record. What runs is
// unchanged -- an image is accepted at runtime only when a signed release names
// it -- and the Codex license texts are left to signing, which digests them.
const candidate = process.argv.includes("--candidate");
const release = candidate ? null : await readReleaseManifest(undefined, { strict: true });
if (release) await verifyReleaseLicenses(release);
const lockBytes = candidate ? await readFile(path.join(root, "upstreams.lock.json")) : null;
const lock = candidate ? JSON.parse(lockBytes) : await readPins();
const upstreamsSha256 = candidate ? createHash("sha256").update(lockBytes).digest("hex") : release.upstreamsSha256;
const argument = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
const tag = argument("--tag") ?? sandboxImageTag(lock);

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
};
const stop = (message) => { console.log(`\n${message}`); process.exit(1); };

const docker = (args, timeoutMs = 600_000) => runProcess("docker", args, { cwd: root, timeoutMs, maxOutputBytes: 8 << 20 });

// The ID a classic-store Docker gives this image when it loads it: the sha256 of
// the image config, which `docker save` names by that digest in the archive's
// manifest.json -- the one member read here. The whole archive still streams
// through, so neither side of the pipe is cut off.
function classicImageId(reference) {
  return new Promise((resolve, reject) => {
    const save = spawn("docker", ["save", reference], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-xOf", "-", "manifest.json"], { stdio: ["pipe", "pipe", "pipe"] });
    let manifest = "", errors = "";
    save.stdout.pipe(tar.stdin);
    tar.stdout.setEncoding("utf8").on("data", (chunk) => { manifest += chunk; });
    for (const stream of [save.stderr, tar.stderr]) stream.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
    const exited = (child) => new Promise((done) => { child.once("error", reject); child.once("close", done); });
    Promise.all([exited(save), exited(tar)]).then(([saved, extracted]) => {
      if (saved !== 0 || extracted !== 0) return reject(new Error(`docker save | tar exited ${saved}/${extracted}: ${errors.slice(-300)}`));
      let entries;
      try { entries = JSON.parse(manifest); } catch { return reject(new Error("docker save wrote no readable manifest.json")); }
      const config = Array.isArray(entries) && entries.length === 1 ? String(entries[0]?.Config ?? "") : "";
      const hex = /(?:^|\/)([a-f0-9]{64})(?:\.json)?$/.exec(config)?.[1];
      return hex ? resolve(`sha256:${hex}`) : reject(new Error(`manifest.json does not name exactly one image config (${Array.isArray(entries) ? entries.length : typeof entries})`));
    });
  });
}

// The daemon's own platform unless told otherwise: on this Mac that is arm64
// inside colima, on an x86 server it is x64.
const daemon = await docker(["info", "--format", "{{.OSType}} {{.Architecture}}"], 30_000);
if (daemon.code !== 0) stop(`Docker 不可用：${`${daemon.stderr}`.trim().slice(0, 300)}`);
const [daemonOs, daemonArch] = `${daemon.stdout}`.trim().split(/\s+/);
const native = imagePlatform(daemonOs, { aarch64: "arm64", x86_64: "amd64" }[daemonArch] ?? daemonArch);
const platform = process.env.IDOU_SANDBOX_PLATFORM ?? native;

const expected = expectedImageLabels(lock, platform, upstreamsSha256);
const cli = lock.feishu.bundledArtifacts?.[platform];
const codex = lock.codex.vendorArtifacts?.[platform];
if (!expected) {
  stop(`upstreams.lock.json 里没有 ${platform} 的审核产物（飞书 CLI：${cli ? "有" : "无"}；Codex：${codex ? "有" : "无"}）。`
    + "\n这个平台还不能构建沙箱镜像。构建不会自己下载替代品：先按锁文件记录的方式产出并验证二进制，再把摘要写进锁文件。");
}
const baseImage = lock.sandbox?.baseImage;
if (!/@sha256:[a-f0-9]{64}$/.test(baseImage ?? "")) stop("upstreams.lock.json 的 sandbox.baseImage 必须按摘要固定");

console.log(`building ${tag} for ${platform}`);

// The inputs, before Docker sees them.
const larkCli = path.join(root, "resources", "lark-cli", platform, "lark-cli");
const codexTree = path.join(root, "resources", "codex", platform);
try {
  await verifyBinary(larkCli, cli.sha256);
  if (!(await readFile(path.join(path.dirname(larkCli), "LICENSE"), "utf8")).trim()) throw new Error("LICENSE 是空的");
  check("the Feishu CLI in resources/ matches the lock", true, cli.sha256.slice(0, 12));
} catch (error) {
  check("the Feishu CLI in resources/ matches the lock", false, error.message);
  stop(`飞书 CLI 未通过校验，不构建。按 upstreams.lock.json 里 ${platform} 的构建方式产出后放到 resources/lark-cli/${platform}/。`);
}
try {
  const count = await verifyTree(codexTree, codex.files);
  check("every Codex file in resources/ matches the lock", true, `${count} files`);
} catch (error) {
  check("every Codex file in resources/ matches the lock", false, error.message);
  stop(`Codex 未通过校验，不构建。用 node scripts/bundle-codex.js ${platform} <已安装的 ${codex.package} 目录> 放置经过校验的文件。`);
}
const base = await docker(["image", "inspect", baseImage, "--format", "{{.Id}}"], 30_000);
if (base.code !== 0) {
  stop(`基础镜像 ${baseImage} 不在本机。构建不联网，也不会替你下载；需要的话请自己执行 docker pull ${baseImage}（这是一次下载）。`);
}

// `sha256sum -c` input, one line per file, joined for a build argument. The
// names come from the lock; one that could break the line is refused, not quoted.
function codexManifest(files) {
  return Object.entries(files).map(([name, digest]) => {
    if (!/^[A-Za-z0-9._/-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) stop(`锁文件里的 Codex 条目不合法：${name}`);
    return `${digest}  ${name}`;
  }).join(";");
}

const args = ["build", "--network", "none", "--file", "sandbox/Dockerfile",
  "--build-arg", `BASE_IMAGE=${baseImage}`,
  "--build-arg", `CODEX_VERSION=${lock.codex.version}`, "--build-arg", `CODEX_SHA256=${codex.files["bin/codex"]}`,
  "--build-arg", `CODEX_FILES=${codexManifest(codex.files)}`,
  "--build-arg", `LARK_CLI_VERSION=${lock.feishu.version}`, "--build-arg", `LARK_CLI_SHA256=${cli.sha256}`,
  "--build-arg", `RELEASE_UPSTREAMS_SHA256=${upstreamsSha256}`,
  "--build-arg", `SANDBOX_PLATFORM=${platform}`,
  // Only when it differs: building for another architecture needs emulation,
  // and saying the native one out loud changes nothing.
  ...(platform === native ? [] : ["--platform", dockerPlatform(platform)]),
  "--tag", tag, "."];
// The command that runs this one step. Building for another architecture needs
// BuildKit: the legacy builder, under the containerd image store, loses the
// platform of its own intermediate images and stops at the first COPY ("was
// found but does not provide the specified platform"), measured building
// linux-x64 on this Mac. BuildKit needs the buildx plugin on the client, which
// this Mac's docker lacks and colima's VM has, so the step can run there
// against the same daemon, in the same directory (colima mounts $HOME):
//   IDOU_SANDBOX_BUILD_COMMAND='["colima","ssh","--","env","BUILDX_NO_DEFAULT_ATTESTATIONS=1","docker"]'
// (no attestation manifest, so the result is one image and its ID one digest).
// Everything before and after -- every check -- stays with the local client.
const buildCommand = process.env.IDOU_SANDBOX_BUILD_COMMAND ? JSON.parse(process.env.IDOU_SANDBOX_BUILD_COMMAND) : ["docker"];
if (!Array.isArray(buildCommand) || !buildCommand.length || !buildCommand.every((part) => typeof part === "string" && part)) stop("IDOU_SANDBOX_BUILD_COMMAND 必须是命令及其参数组成的 JSON 数组");
// From a context of its own, never the repository: see scripts/sandbox-context.js.
const context = await prepareContext(root, platform);
let built;
try { built = await runProcess(buildCommand[0], [...buildCommand.slice(1), ...args], { cwd: context, timeoutMs: 1_800_000, maxOutputBytes: 8 << 20 }); }
finally { await rm(context, { recursive: true, force: true }); }
if (built.code !== 0) {
  console.log(`${built.stdout}`.slice(-2000));
  console.log(`${built.stderr}`.slice(-3000));
  stop("BUILD FAILED");
}
console.log("built\n");

// One `docker run` against the built image, as the same unprivileged user and
// with the same hardening the runtime applies.
async function inside(command, extra = []) {
  const result = await docker(["run", "--rm", "--pull", "never", "--network", "none", "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "65534:65534", "--memory", "512m", "--pids-limit", "128", "--init",
    // Said outright for another architecture: left implicit, Docker prints a
    // platform-mismatch warning into the very output these checks compare.
    ...(platform === native ? [] : ["--platform", dockerPlatform(platform)]),
    ...extra, "--entrypoint", "sh", tag, "-c", command], 120_000);
  return { code: result.code, out: `${result.stdout}${result.stderr}`.trim() };
}

// What the image says about itself, and whether it says what the lock says.
const looked = await docker(["image", "inspect", tag, "--format", "{{json .}}"], 30_000);
const image = JSON.parse(`${looked.stdout}`.trim());
const labels = image.Config?.Labels ?? {};
const wrong = Object.entries(expected).filter(([key, value]) => labels[key] !== value).map(([key]) => key);
check("the image's labels match the lock", wrong.length === 0, wrong.length ? `mismatched: ${wrong.join(", ")}` : `${Object.keys(expected).length} labels`);
check(`the image is ${platform}`, imagePlatform(image.Os, image.Architecture) === platform, `${image.Os}/${image.Architecture}`);

// The bytes that will actually run, read out of the image rather than trusted
// from what the build was handed.
const tree = await inside("cd /opt/codex && find . -type f | LC_ALL=C sort | xargs sha256sum");
const inImage = Object.fromEntries(tree.out.split("\n").filter(Boolean).map((line) => {
  const [digest, name] = line.split(/\s+/);
  return [name.replace(/^\.\//, ""), digest];
}));
const codexWrong = [...new Set([...Object.keys(codex.files), ...Object.keys(inImage)])].filter((name) => codex.files[name] !== inImage[name]);
check("every Codex file inside the image matches the lock", tree.code === 0 && codexWrong.length === 0,
  codexWrong.length ? `differs: ${codexWrong.join(", ")}` : `${Object.keys(inImage).length} files`);
const larkInImage = await inside("sha256sum /usr/local/bin/lark-cli");
check("the Feishu CLI inside the image matches the lock", larkInImage.out.split(/\s+/)[0] === cli.sha256, larkInImage.out.split(/\s+/)[0]?.slice(0, 12));

const which = await inside("command -v codex");
check("codex on PATH is the verified one", which.out === "/opt/codex/bin/codex", which.out);

const codexVersion = await inside("codex --version");
check(`codex is ${lock.codex.version}`, codexVersion.out.includes(`codex-cli ${lock.codex.version}`), codexVersion.out.split("\n")[0]);

const lark = await inside("lark-cli --version");
check(`lark-cli is ${lock.feishu.version}`, lark.out.includes(`lark-cli version ${lock.feishu.version}`), lark.out.split("\n")[0]);

const notices = await inside("test -s /usr/local/share/codex/LICENSE && test -s /usr/local/share/codex/NOTICE");
check("Codex LICENSE and NOTICE are inside the image", notices.code === 0);

const node = await inside("node -e 'process.stdout.write(process.version)'");
check("node runs", /^v\d+\./.test(node.out), node.out.split("\n")[0]);

const who = await inside("id -u; id -g");
check("runs as nobody", who.out.replace(/\s+/g, " ") === "65534 65534", who.out.replace(/\s+/g, " "));

const rootfs = await inside("touch /etc/nope 2>&1 || echo REFUSED");
check("image filesystem is read-only", /REFUSED|Read-only/.test(rootfs.out));

const scratch = await mkdtemp(path.join(os.homedir(), ".idou-sandbox-build-"));
try {
  const workspace = await inside("echo written > /workspace/probe && cat /workspace/probe",
    ["--mount", `type=bind,source=${scratch},target=/workspace`]);
  check("the workspace is writable", workspace.out.includes("written"), workspace.out.split("\n")[0]);
} finally { await rm(scratch, { recursive: true, force: true }); }

// Nothing that looks like a credential may be baked into the image: the whole
// design is that a stolen sandbox yields nothing, which stops being true if a
// key rides along inside it.
const secrets = await inside("env | grep -icE 'token|secret|password|_key=' || true");
check("no credential-shaped variables in the image", secrets.out.trim() === "0", `matched ${secrets.out.trim()}`);

const files = await inside("ls /opt/mydoubao/bin/sandbox/");
check("the sandbox entry point is present", files.out.includes("feishu.js"), files.out.split("\n").join(" "));

// What was built, written down. Three names, three jobs:
//   - the tag given (by default the lock's): what a developer's control plane
//     runs, and it moves with every build;
//   - a build tag carrying the image id: never moved, so an older build stays
//     named -- under the containerd image store an image whose only tag moved
//     away becomes dangling, loses its `repository@sha256` form, and is the
//     first thing `docker image prune` removes, which is the rollback gone;
//   - the digest: what production pins.
// The repository is the tag without its `:name` -- not everything before the
// first colon, which for `registry:5000/...` would be the host.
const repository = tag.replace(/:[^/:]+$/, "");
const buildTag = `${repository}:${lock.codex.version}-${lock.feishu.version}-${String(image.Id).replace(/^sha256:/, "").slice(0, 12)}`;
if (failures === 0) {
  const tagged = await docker(["tag", tag, buildTag], 30_000);
  check("the build keeps a tag of its own", tagged.code === 0, buildTag);
}
const named = JSON.parse(`${(await docker(["image", "inspect", tag, "--format", "{{json .RepoDigests}}"], 30_000)).stdout}`.trim() || "[]");
const digest = (named ?? []).find((entry) => entry.startsWith(`${repository}@`)) ?? null;
// What a Docker with the classic image store will call this image once it is
// `docker load`ed there: its ID, which that store takes to be the digest of the
// image config. Such a store records no repository digest for a loaded image,
// so on a server like that the ID is the only immutable name to pin, and the
// release approves it beside the digest (sandbox-image.js, approvedImageFaults).
// Read from the archive `docker save` produces, the same one that is moved.
const classicId = failures === 0 ? await classicImageId(tag).catch((error) => { check("the image's classic-store ID is known", false, error.message); return null; }) : null;
const record = { image: tag, buildTag, id: image.Id, digest, ...(classicId ? { classicId } : {}), platform, baseImage, builtAt: new Date().toISOString(),
  releaseId: release?.releaseId ?? null, releaseUpstreamsSha256: upstreamsSha256, ...(candidate ? { candidate: true } : {}),
  codex: { version: lock.codex.version, files: codex.files }, larkCli: { version: lock.feishu.version, sha256: cli.sha256 } };
if (failures === 0) {
  const releases = path.join(root, "dist", "sandbox-releases");
  await mkdir(releases, { recursive: true });
  const file = path.join(releases, `${platform}-${String(image.Id).replace(/^sha256:/, "").slice(0, 12)}.json`);
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nrecord: ${path.relative(root, file)}`);
  console.log(digest
    ? `pin it: IDOU_SANDBOX_IMAGE=${digest}`
    : "这个 Docker 没有给本地镜像记录仓库摘要（经典镜像存储）；生产部署请用下面的镜像 ID 固定。");
  if (classicId) console.log(`on a classic image store, after docker load: IDOU_SANDBOX_IMAGE=${classicId}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
