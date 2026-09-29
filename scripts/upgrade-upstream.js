// Stages an upgrade of the two upstreams this application runs: the Feishu CLI
// (lark-cli) and Codex. See docs/upgrading-upstreams.md for the whole path.
//
//   node scripts/upgrade-upstream.js status
//   node scripts/upgrade-upstream.js stage-feishu --checkout /abs/larksuite-cli --version 1.0.96 [--date YYYY-MM-DD]
//        (a clean checkout of the version's tag; see the note on the API catalog in stageFeishu)
//   node scripts/upgrade-upstream.js stage-codex --version 0.150.0 --commit <reviewed rust-v tag commit>
//        --linux-arm64 /abs/vendor/aarch64-unknown-linux-musl [--darwin-arm64 /abs/vendor/aarch64-apple-darwin]
//        --darwin-integrity sha512-… --linux-arm64-integrity sha512-…   (a new version: what each tarball was checked against)
//   node scripts/upgrade-upstream.js add-linux-x64 [--checkout /abs/larksuite-cli]
//        [--codex /abs/vendor/x86_64-unknown-linux-musl --codex-integrity sha512-…]
//        (either upstream or both, at the versions the lock pins -- on its own, or inside the upgrade just staged)
//   node scripts/upgrade-upstream.js rollback
//
// Each upstream is upgraded on its own: stage one, add its linux-x64, build,
// sign and pass the gate, finish, and only then stage the other. Nothing here
// needs the other upstream's source or packages to do it.
//
// Why this exists: every runtime check verifies binaries against the signed
// release, and signing checks the sandbox image's record against the lock it
// signs. A new version therefore has to be staged -- built, hashed, written into
// the working tree's upstreams.lock.json and put in place -- before any of that
// can run, and nothing did that: the lock was edited by hand, and the build of
// lark-cli for the sandbox was a command copied out of the lock.
//
// Staging downloads nothing. The checkout, its fetched registry metadata and the
// Codex vendor trees are the operator's to obtain (with the person's permission);
// this only builds, hashes, checks and places what it is given. What it replaces
// is moved to resources/.upgrade-previous/ with a copy of the lock, never
// deleted, and `rollback` puts it back.
import "../src/adopt-legacy-env.js";
import { access, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileDigest, verifyTree } from "../src/providers/runtime-artifacts.js";
import { verifyBinary } from "../src/providers/feishu/bundled-runtime.js";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const LOCK = path.join(root, "upstreams.lock.json");
const RESOURCES = path.join(root, "resources");
const PREVIOUS = path.join(RESOURCES, ".upgrade-previous");
const [command, ...rest] = process.argv.slice(2);
const option = (name) => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; };
const say = (line) => process.stdout.write(`${line}\n`);
const exists = (file) => access(file).then(() => true, () => false);
const VERSION = /^\d+\.\d+\.\d+$/;

async function readLock() { return { bytes: await readFile(LOCK), lock: JSON.parse(await readFile(LOCK, "utf8")) }; }
async function writeLock(lock) { await writeFile(LOCK, `${JSON.stringify(lock, null, 2)}\n`); }

// One staged upgrade at a time: a second would overwrite the only copy of what
// the first replaced.
async function beginBackup(lockBytes) {
  if (await exists(PREVIOUS)) throw new Error(`${path.relative(root, PREVIOUS)} already holds an unfinished upgrade: finish it (commit and remove the folder by hand) or run rollback first`);
  await mkdir(PREVIOUS, { recursive: true });
  await writeFile(path.join(PREVIOUS, "upstreams.lock.json"), lockBytes);
}
async function moveAside(relative) {
  const from = path.join(RESOURCES, relative);
  if (!(await exists(from))) return false;
  const to = path.join(PREVIOUS, relative);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  return true;
}

// Files under a tree, as the lock names them: relative paths of regular files.
async function filesUnder(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await filesUnder(directory, name));
    else if (entry.isFile()) found.push(name);
    else throw new Error(`${name} is neither a file nor a directory; a vendor tree is only files`);
  }
  return found;
}
async function treeDigests(directory) {
  const files = {};
  for (const name of (await filesUnder(directory)).sort()) files[name] = await fileDigest(path.join(directory, name));
  if (!Object.keys(files).length) throw new Error(`${directory} holds no files`);
  return files;
}

// An ELF executable for a 64-bit Linux architecture, checked by its header
// (e_machine 183 is aarch64, 62 is x86-64): a Mach-O put in the sandbox's place
// cannot run in a Linux container at any architecture.
async function isLinuxElf(file, machine) {
  const header = (await readFile(file)).subarray(0, 20);
  return header.readUInt32BE(0) === 0x7f454c46 && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === machine;
}
const isLinuxArm64 = (file) => isLinuxElf(file, 183);
const isLinuxX64 = (file) => isLinuxElf(file, 62);

async function status() {
  const { lock } = await readLock();
  say(`lark-cli ${lock.feishu.version} (commit ${lock.feishu.inspectedCommit}, built ${lock.feishu.buildDate} with ${lock.feishu.goVersion})`);
  say(`codex    ${lock.codex.version} (commit ${lock.codex.inspectedCommit})`);
  for (const platform of Object.keys(lock.feishu.bundledArtifacts)) {
    const binary = path.join(RESOURCES, "lark-cli", platform, "lark-cli");
    const ok = await verifyBinary(binary, lock.feishu.bundledArtifacts[platform].sha256).then(() => "matches the lock", (error) => error.message);
    say(`  resources/lark-cli/${platform}: ${ok}`);
  }
  for (const platform of Object.keys(lock.codex.vendorArtifacts).filter((name) => name.startsWith("linux-"))) {
    const codexOk = await verifyTree(path.join(RESOURCES, "codex", platform), lock.codex.vendorArtifacts[platform].files).then(() => "matches the lock", (error) => error.message);
    say(`  resources/codex/${platform}: ${codexOk}`);
  }
  say(await exists(PREVIOUS) ? `an upgrade is staged; what it replaced is in ${path.relative(root, PREVIOUS)}` : "no upgrade staged");
}

async function stageFeishu() {
  const checkout = option("--checkout"), version = option("--version");
  if (!checkout || !path.isAbsolute(checkout) || !VERSION.test(version ?? "")) throw new Error("usage: stage-feishu --checkout /absolute/larksuite-cli --version X.Y.Z [--date YYYY-MM-DD]");
  const { bytes, lock } = await readLock();
  if (!/^module github\.com\/larksuite\/cli$/m.test(await readFile(path.join(checkout, "go.mod"), "utf8"))) throw new Error("not the official github.com/larksuite/cli source");
  const git = async (...args) => (await execute("git", args, { cwd: checkout })).stdout.trim();
  if (await git("status", "--porcelain")) throw new Error("the checkout has local changes; stage only a clean, reviewed commit");
  const commit = await git("rev-parse", "HEAD");
  const tags = (await git("tag", "--points-at", "HEAD")).split("\n").filter(Boolean);
  if (tags.length && !tags.includes(`v${version}`)) throw new Error(`HEAD is tagged ${tags.join(", ")}, not v${version}`);
  // Built from source on both platforms because the published releases leave
  // out the authsidecar tag, and without it the CLI refuses to run behind the
  // sandbox's credential sidecar at all.
  //
  // What API catalog the CLI carries is an input to the build, and it came two
  // ways. Up to about 1.0.8x the upstream's scripts/fetch_meta.py downloaded
  // internal/registry/meta_data.json from open.feishu.cn and nothing committed
  // it, so it was pinned by digest beside the commit -- two builds of one commit
  // behaved differently, which was measured. Later versions commit the catalog
  // (internal/registry/catalog) and embed it with its own integrity check, and
  // the commit alone decides it; its manifest's digest is recorded to say so.
  const catalogManifest = path.join(checkout, "internal", "registry", "catalog", "manifest.json");
  const fetchedMeta = path.join(checkout, "internal", "registry", "meta_data.json");
  let registry;
  if (await exists(catalogManifest)) {
    const tracked = await git("ls-files", "--error-unmatch", "internal/registry/catalog/manifest.json").then(() => true, () => false);
    if (!tracked) throw new Error("internal/registry/catalog/manifest.json exists but is not committed; stage only what the commit carries");
    registry = { registryCatalog: "committed at inspectedCommit and embedded in the binary", registryCatalogManifestSha256: await fileDigest(catalogManifest) };
  } else if (await exists(fetchedMeta)) {
    registry = { registryMetaSha256: await fileDigest(fetchedMeta) };
  } else {
    throw new Error("no API catalog: this version neither commits internal/registry/catalog nor has a fetched internal/registry/meta_data.json -- run the checkout's scripts/fetch_meta.py first (it downloads from open.feishu.cn)");
  }
  const goVersion = (await execute("go", ["env", "GOVERSION"])).stdout.trim();
  const buildDate = option("--date") ?? await git("show", "-s", "--format=%cs", "HEAD");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(buildDate)) throw new Error("--date must be YYYY-MM-DD");
  const ldflags = `-s -w -X github.com/larksuite/cli/internal/build.Version=${version} -X github.com/larksuite/cli/internal/build.Date=${buildDate}`;
  const command = (goos, goarch) => `CGO_ENABLED=0 GOOS=${goos} GOARCH=${goarch} go build -buildvcs=false -trimpath -tags authsidecar -ldflags '${ldflags}' -o lark-cli .`;

  const scratch = await mkdtemp(path.join(os.tmpdir(), "idou-upgrade-feishu-"));
  try {
    const built = {};
    for (const [platform, goos, goarch] of [["darwin-arm64", "darwin", "arm64"], ["linux-arm64", "linux", "arm64"]]) {
      const output = path.join(scratch, platform, "lark-cli");
      await mkdir(path.dirname(output), { recursive: true });
      say(`building ${platform} …`);
      await execute("go", ["build", "-buildvcs=false", "-trimpath", "-tags", "authsidecar", "-ldflags", ldflags, "-o", output, "."],
        { cwd: checkout, env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch }, maxBuffer: 16 << 20 });
      built[platform] = { file: output, sha256: await fileDigest(output) };
    }
    if (!(await isLinuxArm64(built["linux-arm64"].file))) throw new Error("the linux-arm64 build is not an arm64 ELF executable");
    // The one this machine can run is asked the two things the product relies
    // on at the boundary: its version, and that it serves its embedded skills.
    const probe = new SaasFeishuCliProvider({ binary: built["darwin-arm64"].file, environment: () => ({ LARKSUITE_CLI_AUTH_PROXY: "http://127.0.0.1:9",
      LARKSUITE_CLI_PROXY_KEY: "upgrade-probe", LARKSUITE_CLI_APP_ID: "cli_upgrade_probe", LARKSUITE_CLI_BRAND: "feishu", LARKSUITE_CLI_REMOTE_META: "off",
      LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1", LARKSUITE_CLI_CONFIG_DIR: scratch }) });
    if (await probe.version() !== version) throw new Error(`the build reports version ${await probe.version()}, not ${version}`);
    const skills = await probe.listSkills();
    if (!skills.length || !(await probe.readSkill(skills[0].name)).includes("name:")) throw new Error("the build does not serve its embedded skills");

    await beginBackup(bytes);
    for (const platform of Object.keys(built)) {
      await moveAside(path.join("lark-cli", platform));
      const destination = path.join(RESOURCES, "lark-cli", platform);
      await mkdir(destination, { recursive: true });
      await copyFile(built[platform].file, path.join(destination, "lark-cli"));
      await chmod(path.join(destination, "lark-cli"), 0o755);
      await copyFile(path.join(checkout, "LICENSE"), path.join(destination, "LICENSE"));
    }
    const previous = lock.feishu;
    // The x64 build is of the old commit once the commit moves: set aside with
    // the rest rather than carried into the new lock under the new version, and
    // added again for this commit with add-linux-x64.
    const xStale = previous.inspectedCommit !== commit && Boolean(previous.bundledArtifacts["linux-x64"]);
    if (xStale) await moveAside(path.join("lark-cli", "linux-x64"));
    const { "linux-x64": _x64, ...withoutX64 } = previous.bundledArtifacts;
    // Nothing about the old build may ride along: the catalog fields, the note
    // on why it was not reproducible, and the published archive it was compared
    // with all describe that version, not this one.
    const { registryMetaSha256: _meta, registryCatalog: _catalog, registryCatalogManifestSha256: _manifest, ...kept } = previous;
    const { registryMetaSha256: _builtMeta, registryCatalog: _builtCatalog, registryCatalogManifestSha256: _builtManifest,
      notByteReproducible: _note, publishedArchiveForReference: _archive, ...keptSource } = previous.bundledArtifacts["linux-arm64"].builtFromSource ?? {};
    lock.feishu = { ...kept, version, inspectedCommit: commit, buildDate, goVersion, ...registry,
      bundledArtifacts: {
        ...(xStale ? withoutX64 : previous.bundledArtifacts),
        "darwin-arm64": { ...previous.bundledArtifacts["darwin-arm64"], sha256: built["darwin-arm64"].sha256 },
        "linux-arm64": { ...previous.bundledArtifacts["linux-arm64"], sha256: built["linux-arm64"].sha256,
          builtFromSource: { ...keptSource, commit, command: command("linux", "arm64"), goVersion, ...registry,
            ...(registry.registryMetaSha256 ? { notByteReproducible: "the API catalog was downloaded at build time (scripts/fetch_meta.py) and is pinned by registryMetaSha256 instead of by the commit" } : {}),
            publishedArchiveForReference: { url: `https://github.com/larksuite/cli/releases/download/v${version}/lark-cli-${version}-linux-arm64.tar.gz`, unusable: "no authsidecar" } } },
      } };
    await writeLock(lock);
    for (const platform of Object.keys(built)) await verifyBinary(path.join(RESOURCES, "lark-cli", platform, "lark-cli"), lock.feishu.bundledArtifacts[platform].sha256);
    say(JSON.stringify({ staged: "lark-cli", from: previous.version, to: version, commit, buildDate, goVersion, ...registry, skills: skills.length,
      sha256: Object.fromEntries(Object.entries(built).map(([key, value]) => [key, value.sha256])),
      unchanged: Object.fromEntries(Object.entries(built).map(([key, value]) => [key, value.sha256 === previous.bundledArtifacts[key]?.sha256])),
      ...(xStale ? { setAside: "linux-x64 (built from the old commit)" } : {}) }, null, 2));
    if (xStale) say("linux-x64 was set aside: run add-linux-x64 for this version before building the x64 sandbox");
    say("next: node scripts/build-sandbox-image.js --candidate, then sign with the record it writes (docs/upgrading-upstreams.md)");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

async function stageCodex() {
  const version = option("--version"), commit = option("--commit"), linux = option("--linux-arm64");
  const usage = "usage: stage-codex --version X.Y.Z --commit <40-hex> --linux-arm64 /absolute/vendor/aarch64-unknown-linux-musl [--darwin-arm64 /absolute/vendor/aarch64-apple-darwin] [--darwin-integrity sha512-… --linux-arm64-integrity sha512-…]";
  if (!VERSION.test(version ?? "") || !/^[0-9a-f]{40}$/.test(commit ?? "") || !linux || !path.isAbsolute(linux)) throw new Error(usage);
  const { bytes, lock } = await readLock();
  // A new release is recorded as what it is: its own registry spec, and the
  // integrity its tarballs were checked against. The old release's -- and the
  // note on how that one was verified -- would otherwise ride along under the
  // new version as if they had been checked for it.
  const release = lock.codex.version !== version || lock.codex.inspectedCommit !== commit;
  const integrity = { "darwin-arm64": option("--darwin-integrity"), "linux-arm64": option("--linux-arm64-integrity") };
  if (release && !Object.values(integrity).every((value) => INTEGRITY.test(value ?? ""))) {
    throw new Error(`a new Codex release needs the registry integrity each tarball was checked against: --darwin-integrity and --linux-arm64-integrity (npm view @openai/codex@${version}-<platform> dist.integrity)\n${usage}`);
  }
  // The desktop's Codex is the local @openai/codex install, which packaging
  // copies from; found the way packaging finds it unless named.
  let darwin = option("--darwin-arm64");
  if (!darwin) {
    const launcher = process.env.IDOU_CODEX_LAUNCHER || (await execute("/bin/sh", ["-c", "command -v codex || true"])).stdout.trim();
    if (!launcher) throw new Error("no codex on PATH: install @openai/codex at the new version, or pass --darwin-arm64");
    const { realpath } = await import("node:fs/promises");
    darwin = path.join(path.dirname(path.dirname(await realpath(launcher))), "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin");
  }
  const reported = (await execute(path.join(darwin, "bin", "codex"), ["--version"])).stdout.trim();
  if (reported !== `codex-cli ${version}`) throw new Error(`${darwin} is ${reported}, not codex-cli ${version}`);
  for (const [platform, tree] of [["darwin-arm64", darwin], ["linux-arm64", linux]]) {
    const described = JSON.parse(await readFile(path.join(tree, "codex-package.json"), "utf8").catch(() => "{}"));
    if (described.version && described.version !== version) throw new Error(`${platform}: codex-package.json says ${described.version}, not ${version}`);
  }
  if (!(await isLinuxArm64(path.join(linux, "bin", "codex")))) throw new Error("the linux-arm64 tree's bin/codex is not an arm64 ELF executable");
  const destination = path.join(RESOURCES, "codex", "linux-arm64");
  if (path.resolve(linux) === destination) throw new Error("stage from a copy: the linux-arm64 source is the directory being replaced");
  const files = { "darwin-arm64": await treeDigests(darwin), "linux-arm64": await treeDigests(linux) };

  await beginBackup(bytes);
  await moveAside(path.join("codex", "linux-arm64"));
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(linux, destination, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  for (const name of Object.keys(files["linux-arm64"])) await chmod(path.join(destination, name), (await lstat(path.join(linux, name))).mode & 0o7777);
  const previous = lock.codex;
  // As with lark-cli: an x64 tree of another release is set aside, not carried
  // into the lock under the new version; add-linux-x64 --codex adds this release's.
  const xStale = release && Boolean(previous.vendorArtifacts["linux-x64"]);
  if (xStale) await moveAside(path.join("codex", "linux-x64"));
  const { "linux-x64": _x64, provenance: _provenance, ...kept } = previous.vendorArtifacts;
  if (xStale) say("linux-x64 was set aside: run add-linux-x64 --codex for this version before building the x64 sandbox");
  const entry = (platform) => ({ ...previous.vendorArtifacts[platform], files: files[platform],
    ...(release ? { registrySpec: `@openai/codex@${version}-${platform}`, integrity: integrity[platform] } : {}) });
  lock.codex = { ...previous, version, inspectedCommit: commit, vendorArtifacts: { ...(release ? kept : previous.vendorArtifacts),
    "darwin-arm64": entry("darwin-arm64"), "linux-arm64": entry("linux-arm64") } };
  if (release) say("the previous release's provenance note was dropped: record how these tarballs were verified in codex.vendorArtifacts.provenance before building the sandbox");
  await writeLock(lock);
  await verifyTree(destination, lock.codex.vendorArtifacts["linux-arm64"].files);
  await verifyTree(darwin, lock.codex.vendorArtifacts["darwin-arm64"].files);
  const same = (platform) => JSON.stringify(files[platform]) === JSON.stringify(previous.vendorArtifacts[platform]?.files);
  say(JSON.stringify({ staged: "codex", from: previous.version, to: version, commit, darwin, files: { "darwin-arm64": Object.keys(files["darwin-arm64"]).length, "linux-arm64": Object.keys(files["linux-arm64"]).length },
    unchanged: { "darwin-arm64": same("darwin-arm64"), "linux-arm64": same("linux-arm64") } }, null, 2));
  say(`next: replace third_party/codex/LICENSE and NOTICE with the rust-v${version} texts if they changed, then build the sandbox --candidate and sign (docs/upgrading-upstreams.md)`);
}

// Adds linux-x64 for a server that is not arm64, for either upstream or both,
// at the versions the lock pins: the pinned lark-cli commit built for amd64 with
// exactly the flags the lock records for arm64, and the x64 tree of the pinned
// Codex release. It runs on its own (as on 2026-09-22, both at once), or inside
// the upgrade just staged -- after stage-feishu or stage-codex set the old
// release's x64 aside -- and then asks nothing of the other upstream: a Codex
// upgrade needs no lark-cli checkout or Go, and a lark-cli upgrade no Codex
// package. Nothing already pinned changes, and a checkout, Go or catalog that is
// not the pinned one is refused rather than quietly upgrading.
async function addLinuxX64() {
  const checkout = option("--checkout"), tree = option("--codex"), integrity = option("--codex-integrity");
  if ((!checkout && !tree) || (checkout && !path.isAbsolute(checkout)) || (tree && !path.isAbsolute(tree)) || Boolean(tree) !== Boolean(integrity) || (integrity && !INTEGRITY.test(integrity))) {
    throw new Error("usage: add-linux-x64 [--checkout /absolute/larksuite-cli] [--codex /absolute/vendor/x86_64-unknown-linux-musl --codex-integrity sha512-<the registry integrity the tree's tarball was checked against>] -- either or both");
  }
  const { bytes, lock } = await readLock();
  const pinned = { "lark-cli": lock.feishu.bundledArtifacts, codex: lock.codex.vendorArtifacts };
  for (const component of [...(checkout ? ["lark-cli"] : []), ...(tree ? ["codex"] : [])]) {
    if (pinned[component]["linux-x64"]) throw new Error(`the lock already pins ${component} linux-x64`);
    if (await exists(path.join(RESOURCES, component, "linux-x64"))) throw new Error(`resources/${component}/linux-x64 already exists; move it away first`);
  }

  let ldflags = null, commandLine = null, arm = null;
  if (checkout) {
    if (!/^module github\.com\/larksuite\/cli$/m.test(await readFile(path.join(checkout, "go.mod"), "utf8"))) throw new Error("not the official github.com/larksuite/cli source");
    const git = async (...args) => (await execute("git", args, { cwd: checkout })).stdout.trim();
    if (await git("status", "--porcelain")) throw new Error("the checkout has local changes");
    if (await git("rev-parse", "HEAD") !== lock.feishu.inspectedCommit) throw new Error(`the checkout is not the pinned commit ${lock.feishu.inspectedCommit}`);
    const goVersion = (await execute("go", ["env", "GOVERSION"])).stdout.trim();
    if (goVersion !== lock.feishu.goVersion) throw new Error(`Go here is ${goVersion}; the pinned builds used ${lock.feishu.goVersion}`);
    if (lock.feishu.registryCatalogManifestSha256 &&
        await fileDigest(path.join(checkout, "internal", "registry", "catalog", "manifest.json")) !== lock.feishu.registryCatalogManifestSha256) throw new Error("the checkout's API catalog is not the pinned one");
    arm = lock.feishu.bundledArtifacts["linux-arm64"];
    ldflags = `-s -w -X github.com/larksuite/cli/internal/build.Version=${lock.feishu.version} -X github.com/larksuite/cli/internal/build.Date=${lock.feishu.buildDate}`;
    commandLine = (goarch) => `CGO_ENABLED=0 GOOS=linux GOARCH=${goarch} go build -buildvcs=false -trimpath -tags authsidecar -ldflags '${ldflags}' -o lark-cli .`;
    if (arm.builtFromSource?.command !== commandLine("arm64")) throw new Error("the lock's linux-arm64 build command is not the one this would repeat for amd64");
  }
  let files = null;
  if (tree) {
    const described = JSON.parse(await readFile(path.join(tree, "codex-package.json"), "utf8").catch(() => "{}"));
    if (described.version !== undefined && described.version !== lock.codex.version) throw new Error(`the Codex tree is ${described.version}, not the pinned ${lock.codex.version}`);
    if (!(await isLinuxX64(path.join(tree, "bin", "codex")))) throw new Error("the Codex tree's bin/codex is not an x86-64 ELF executable");
    files = await treeDigests(tree);
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), "idou-add-x64-"));
  try {
    let cli = null, sha256 = null;
    if (checkout) {
      const build = async (output, env = {}) => {
        await mkdir(path.dirname(output), { recursive: true });
        await execute("go", ["build", "-buildvcs=false", "-trimpath", "-tags", "authsidecar", "-ldflags", ldflags, "-o", output, "."],
          { cwd: checkout, env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: "amd64", ...env }, maxBuffer: 16 << 20 });
        return fileDigest(output);
      };
      say("building lark-cli linux-x64 …");
      cli = path.join(scratch, "first", "lark-cli");
      sha256 = await build(cli);
      if (!(await isLinuxX64(cli))) throw new Error("the linux-x64 build is not an x86-64 ELF executable");
      // The check the arm64 build had: a second build from an empty cache gives
      // the same bytes, so the digest names the source and not this machine.
      if (await build(path.join(scratch, "second", "lark-cli"), { GOCACHE: path.join(scratch, "gocache") }) !== sha256) throw new Error("a second build from an empty GOCACHE gave different bytes");
    }

    // Inside a staged upgrade the backup is already there: the lock from before
    // it, and the old release's x64 that the stage step set aside, which is
    // what rollback puts back. On its own this is an upgrade in its own right,
    // backed up like one.
    const inside = await exists(PREVIOUS);
    if (!inside) await beginBackup(bytes);
    if (checkout) {
      const cliDestination = path.join(RESOURCES, "lark-cli", "linux-x64");
      await mkdir(cliDestination, { recursive: true });
      await copyFile(cli, path.join(cliDestination, "lark-cli"));
      await chmod(path.join(cliDestination, "lark-cli"), 0o755);
      await copyFile(path.join(checkout, "LICENSE"), path.join(cliDestination, "LICENSE"));
      const { reproducible: _reproducible, upstreamSidecarSuites: _suites, ...source } = arm.builtFromSource;
      lock.feishu.bundledArtifacts["linux-x64"] = { sha256, purpose: arm.purpose,
        builtFromSource: { ...source, command: commandLine("amd64"),
          publishedArchiveForReference: { url: `https://github.com/larksuite/cli/releases/download/v${lock.feishu.version}/lark-cli-${lock.feishu.version}-linux-amd64.tar.gz`, unusable: "no authsidecar" },
          reproducible: `Verified ${new Date().toISOString().slice(0, 10)}: a second build of this commit with the same Go version, flags and an empty GOCACHE produced identical bytes (sha256 above).` } };
    }
    if (tree) {
      const codexDestination = path.join(RESOURCES, "codex", "linux-x64");
      await cp(tree, codexDestination, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
      for (const name of Object.keys(files)) await chmod(path.join(codexDestination, name), (await lstat(path.join(tree, name))).mode & 0o7777);
      lock.codex.vendorArtifacts["linux-x64"] = { package: "@openai/codex-linux-x64", target: "x86_64-unknown-linux-musl", files,
        registrySpec: `@openai/codex@${lock.codex.version}-linux-x64`, integrity };
    }
    await writeLock(lock);
    if (checkout) await verifyBinary(path.join(RESOURCES, "lark-cli", "linux-x64", "lark-cli"), sha256);
    if (tree) await verifyTree(path.join(RESOURCES, "codex", "linux-x64"), files);
    say(JSON.stringify({ added: "linux-x64", ...(inside ? { into: "the staged upgrade" } : {}),
      ...(checkout ? { larkCli: { version: lock.feishu.version, sha256 } } : {}),
      ...(tree ? { codex: { version: lock.codex.version, files: Object.keys(files).length } } : {}) }, null, 2));
    say(tree ? "next: record how the Codex tarball was verified in codex.vendorArtifacts.provenance, then build both sandbox images --candidate and sign with both records"
      : "next: build both sandbox images --candidate and sign with both records");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

// Puts back what a staged upgrade replaced. What it staged is moved aside into
// resources/.upgrade-rejected-<time>/, not deleted, so a failed upgrade can
// still be looked at.
async function rollback() {
  if (!(await exists(PREVIOUS))) throw new Error("no staged upgrade to roll back");
  const rejected = path.join(RESOURCES, `.upgrade-rejected-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const restored = [];
  for (const component of ["lark-cli", "codex"]) {
    const saved = path.join(PREVIOUS, component);
    if (!(await exists(saved))) continue;
    for (const platform of await readdir(saved)) {
      const live = path.join(RESOURCES, component, platform);
      if (await exists(live)) { await mkdir(path.join(rejected, component), { recursive: true }); await rename(live, path.join(rejected, component, platform)); }
      await rename(path.join(saved, platform), live);
      restored.push(`${component}/${platform}`);
    }
  }
  await copyFile(path.join(PREVIOUS, "upstreams.lock.json"), LOCK);
  // What the upgrade added without replacing anything -- an x64 added where
  // none was pinned -- has nothing in the backup to put back; the restored lock
  // does not pin it, so it goes with the rest of what was staged.
  const lock = JSON.parse(await readFile(LOCK, "utf8"));
  const pins = { "lark-cli": lock.feishu.bundledArtifacts, codex: lock.codex.vendorArtifacts };
  const removed = [];
  for (const component of ["lark-cli", "codex"]) {
    const live = path.join(RESOURCES, component);
    if (!(await exists(live))) continue;
    for (const platform of await readdir(live)) {
      if (!/^(?:darwin|linux)-(?:arm64|x64)$/.test(platform) || Object.hasOwn(pins[component], platform)) continue;
      await mkdir(path.join(rejected, component), { recursive: true });
      await rename(path.join(live, platform), path.join(rejected, component, platform));
      removed.push(`${component}/${platform}`);
    }
  }
  await rename(PREVIOUS, `${rejected}-lock-backup`);
  say(JSON.stringify({ restored, ...(removed.length ? { removed } : {}), lock: "upstreams.lock.json restored", stagedMovedTo: path.relative(root, rejected) }, null, 2));
  say("then: git checkout -- release/ third_party/ test/fixtures/ if the upgrade had changed them, and reinstall the previous global @openai/codex if Codex was staged");
}

const commands = { status, "stage-feishu": stageFeishu, "stage-codex": stageCodex, "add-linux-x64": addLinuxX64, rollback };
if (!commands[command]) { console.error(`usage: node scripts/upgrade-upstream.js ${Object.keys(commands).join(" | ")}`); process.exit(2); }
commands[command]().catch((error) => { console.error(error.message); process.exitCode = 1; });
