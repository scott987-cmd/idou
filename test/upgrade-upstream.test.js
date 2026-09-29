// Each upstream is upgraded on its own (docs/upgrading-upstreams.md): stage
// one, add its linux-x64, build, sign, pass the gate, finish -- and only then
// the other. From the day the server's linux-x64 was added (2026-09-22) neither
// could be. add-linux-x64 wanted both upstreams at once, refused while either
// still pinned an x64, and refused to run inside the upgrade that had just set
// the old x64 aside, so the documented order could not be followed for any new
// version; stage-codex also carried the old release's registry spec, integrity
// and provenance note into the new release's entries. Found on 2026-09-26 by
// asking whether Codex and lark-cli really upgrade independently.
//
// Hermetic: the staging tool runs against a scratch copy of the repository's
// layout, with a stand-in `go` that "builds" bytes depending only on the
// checkout's commit, the flags and the target, and a stand-in lark-cli that
// answers the staging probe. Nothing is downloaded or compiled.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = path.resolve(".");
const integrity = (tag) => `sha512-${createHash("sha512").update(tag).digest("base64")}`;
const COMMIT_155 = "f0a1b8f0849d90960bc406b848f32e5a129b0457", COMMIT_157 = "ac21625ddf7f9dd5f34b2802212cf20295fdff95";

// "go env GOVERSION", and "go build … -ldflags <flags> -o <out> ." for the
// target in GOOS/GOARCH. A darwin build is a stand-in CLI that answers the
// probe stage-feishu makes; a linux build is an ELF header for GOARCH and a line
// naming what was built. GOCACHE changes nothing, as with a reproducible build.
const FAKE_GO = `#!${process.execPath}
const { execFileSync } = require("node:child_process");
const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "env" && args[1] === "GOVERSION") { process.stdout.write("go1.24.3\\n"); process.exit(0); }
if (args[0] !== "build") { process.stderr.write("stand-in go: " + args.join(" ") + "\\n"); process.exit(2); }
const out = args[args.indexOf("-o") + 1], version = /build\\.Version=(\\S+)/.exec(args[args.indexOf("-ldflags") + 1])[1];
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
mkdirSync(path.dirname(out), { recursive: true });
if (process.env.GOOS === "darwin") {
  writeFileSync(out, ["#!/bin/sh", 'case "$1 $2" in',
    '  "--version ") echo "lark-cli version ' + version + '" ;;',
    "  \\"skills list\\") echo '{\\"ok\\":true,\\"skills\\":[{\\"name\\":\\"lark-doc\\",\\"description\\":\\"docs\\"}]}' ;;",
    '  "skills read") printf -- "---\\\\nname: lark-doc\\\\n---\\\\n" ;;',
    "  *) exit 2 ;;", "esac", "# " + commit, ""].join("\\n"));
} else {
  const header = Buffer.alloc(64); header.writeUInt32BE(0x7f454c46, 0); header[4] = 2; header[5] = 1;
  header.writeUInt16LE(process.env.GOARCH === "amd64" ? 62 : 183, 18);
  writeFileSync(out, Buffer.concat([header, Buffer.from("lark-cli " + version + " " + commit + " " + process.env.GOARCH + "\\n")]));
}
chmodSync(out, 0o755);
`;

async function codexTree(directory, version, platform) {
  await mkdir(path.join(directory, "bin"), { recursive: true });
  await writeFile(path.join(directory, "codex-package.json"), `${JSON.stringify({ version })}\n`);
  if (platform === "darwin-arm64") await writeFile(path.join(directory, "bin", "codex"), `#!/bin/sh\necho "codex-cli ${version}"\n`, { mode: 0o755 });
  else {
    const header = Buffer.alloc(64); header.writeUInt32BE(0x7f454c46, 0); header[4] = 2; header[5] = 1;
    header.writeUInt16LE(platform === "linux-x64" ? 62 : 183, 18);
    await writeFile(path.join(directory, "bin", "codex"), Buffer.concat([header, Buffer.from(`codex ${version} ${platform}\n`)]), { mode: 0o755 });
  }
  await writeFile(path.join(directory, "codex-resources.txt"), `resources of codex ${version} for ${platform}\n`);
  return directory;
}

// Every file under resources/ and its digest, to say what an upgrade touched.
async function digests(directory, prefix = "") {
  const found = {};
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true }).catch(() => [])) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(found, await digests(directory, name));
    else found[name] = createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex");
  }
  return found;
}
const only = (files, component) => Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(`${component}/`)));

// A scratch repository pinned the way this one is: lark-cli 1.0.96 and Codex
// 0.155.0 on darwin-arm64, linux-arm64 and linux-x64, reached through the tool
// itself so the pins are exactly what it writes.
async function pinnedRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "scripts"));
  await copyFile(path.join(repository, "scripts", "upgrade-upstream.js"), path.join(root, "scripts", "upgrade-upstream.js"));
  await symlink(path.join(repository, "src"), path.join(root, "src"));
  const bin = path.join(root, "toolchain");
  await mkdir(bin);
  await writeFile(path.join(bin, "go"), FAKE_GO, { mode: 0o755 });
  const withGo = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const withoutGo = { ...process.env, PATH: "/usr/bin:/bin" };
  const tool = async (args, env = withGo) => (await execute(process.execPath, [path.join(root, "scripts", "upgrade-upstream.js"), ...args], { cwd: root, env })).stdout;
  const git = (...args) => execute("git", ["-c", "user.name=stand-in", "-c", "user.email=stand-in@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: checkout });

  const checkout = path.join(root, "larksuite-cli");
  await mkdir(path.join(checkout, "internal", "registry", "catalog"), { recursive: true });
  await writeFile(path.join(checkout, "go.mod"), "module github.com/larksuite/cli\n\ngo 1.24\n");
  await writeFile(path.join(checkout, "LICENSE"), "MIT License (stand-in)\n");
  await writeFile(path.join(checkout, "internal", "registry", "catalog", "manifest.json"), "{\"catalog\":\"1.0.96\"}\n");
  await git("init", "-q"); await git("add", "."); await git("commit", "-q", "-m", "v1.0.96"); await git("tag", "v1.0.96");

  const trees = path.join(root, "packages");
  const tree = (version, platform) => codexTree(path.join(trees, version, platform), version, platform);
  await writeFile(path.join(root, "upstreams.lock.json"), `${JSON.stringify({
    schemaVersion: 1,
    codex: { distribution: "@openai/codex", version: "0.0.0", integrationBoundary: "app-server-jsonrpc-v2", source: "https://github.com/openai/codex", inspectedCommit: "0".repeat(40),
      vendorArtifacts: { "darwin-arm64": { package: "@openai/codex-darwin-arm64", target: "aarch64-apple-darwin" }, "linux-arm64": { package: "@openai/codex-linux-arm64", target: "aarch64-unknown-linux-musl" } } },
    sandbox: { repository: "mydoubao/sandbox", baseImage: "node:22-bookworm-slim@sha256:" + "0".repeat(64) },
    feishu: { provider: "saas-cli", binary: "lark-cli", version: "0.0.0", inspectedCommit: "", buildTags: ["authsidecar"], buildDate: "2026-01-01", goVersion: "go1.24.3", integrationBoundary: "feishu-cli-v1",
      bundledArtifacts: { "darwin-arm64": { sha256: "0".repeat(64) }, "linux-arm64": { sha256: "0".repeat(64), purpose: "sandbox", builtFromSource: { reason: "authsidecar", repository: "https://github.com/larksuite/cli" } } } },
  }, null, 2)}\n`);
  const finish = (name) => rename(path.join(root, "resources", ".upgrade-previous"), path.join(root, "resources", `.upgrade-accepted-${name}`));
  await tool(["stage-feishu", "--checkout", checkout, "--version", "1.0.96"]); await finish("lark-cli-1.0.96");
  await tool(["stage-codex", "--version", "0.155.0", "--commit", COMMIT_155, "--linux-arm64", await tree("0.155.0", "linux-arm64"), "--darwin-arm64", await tree("0.155.0", "darwin-arm64"),
    "--darwin-integrity", integrity("0.155.0 darwin"), "--linux-arm64-integrity", integrity("0.155.0 linux-arm64")]);
  const pinned = JSON.parse(await readFile(path.join(root, "upstreams.lock.json"), "utf8"));
  pinned.codex.vendorArtifacts.provenance = "Verified before pinning 0.155.0 (stand-in).";
  await writeFile(path.join(root, "upstreams.lock.json"), `${JSON.stringify(pinned, null, 2)}\n`);
  await finish("codex-0.155.0");
  // The server's x64 for both, at the pinned versions, as on 2026-09-22.
  await tool(["add-linux-x64", "--checkout", checkout, "--codex", await tree("0.155.0", "linux-x64"), "--codex-integrity", integrity("0.155.0 linux-x64")]);
  await finish("linux-x64");

  const lockBytes = await readFile(path.join(root, "upstreams.lock.json"));
  const resources = await digests(path.join(root, "resources"));
  const status = await tool(["status"]);
  assert.match(status, /lark-cli 1\.0\.96/); assert.match(status, /codex {4}0\.155\.0/);
  assert.equal(status.match(/matches the lock/g)?.length, 5, `the pinned repository is whole:\n${status}`);
  return { root, checkout, tool, git, tree, withoutGo, lockBytes, lock: JSON.parse(lockBytes), resources,
    current: async () => ({ lock: JSON.parse(await readFile(path.join(root, "upstreams.lock.json"), "utf8")), bytes: await readFile(path.join(root, "upstreams.lock.json")),
      resources: await digests(path.join(root, "resources")) }) };
}

const whole = (status) => {
  const lines = status.split("\n").filter((line) => line.startsWith("  resources/"));
  return lines.length === 5 && lines.every((line) => line.endsWith("matches the lock"));
};
// What a rollback leaves: the lock byte for byte and every pinned file as it was.
async function assertRolledBack(repo) {
  const output = await repo.tool(["rollback"]);
  const now = await repo.current();
  assert.deepEqual(now.bytes, repo.lockBytes, "the lock is back byte for byte");
  const live = Object.fromEntries(Object.entries(now.resources).filter(([name]) => !name.startsWith(".upgrade-")));
  const before = Object.fromEntries(Object.entries(repo.resources).filter(([name]) => !name.startsWith(".upgrade-")));
  assert.deepEqual(live, before, `every pinned file is back:\n${output}`);
  const status = await repo.tool(["status"]);
  assert.ok(whole(status) && /no upgrade staged/.test(status), status);
}

test("Codex upgrades on its own: no lark-cli source, no Go, and the CLI's pins untouched", { timeout: 60_000 }, async (t) => {
  const repo = await pinnedRepository(t);
  const staged = await repo.tool(["stage-codex", "--version", "0.157.0", "--commit", COMMIT_157,
    "--linux-arm64", await repo.tree("0.157.0", "linux-arm64"), "--darwin-arm64", await repo.tree("0.157.0", "darwin-arm64"),
    "--darwin-integrity", integrity("0.157.0 darwin"), "--linux-arm64-integrity", integrity("0.157.0 linux-arm64")]);
  assert.match(staged, /linux-x64 was set aside/);
  // Its own x64, inside the upgrade just staged, with no Go on PATH and no checkout.
  const added = await repo.tool(["add-linux-x64", "--codex", await repo.tree("0.157.0", "linux-x64"), "--codex-integrity", integrity("0.157.0 linux-x64")], repo.withoutGo);
  assert.match(added, /"into": "the staged upgrade"/);
  const status = await repo.tool(["status"]);
  assert.ok(whole(status) && /an upgrade is staged/.test(status), status);

  const now = await repo.current();
  assert.deepEqual(now.lock.feishu, repo.lock.feishu, "lark-cli's pins are untouched");
  assert.deepEqual(only(now.resources, "lark-cli"), only(repo.resources, "lark-cli"), "and so are its files");
  assert.equal(now.lock.codex.version, "0.157.0");
  assert.equal(now.lock.codex.inspectedCommit, COMMIT_157);
  for (const platform of ["darwin-arm64", "linux-arm64", "linux-x64"]) {
    const entry = now.lock.codex.vendorArtifacts[platform];
    assert.equal(entry.registrySpec, `@openai/codex@0.157.0-${platform}`, `${platform} names the release it holds`);
    assert.equal(entry.integrity, integrity(`0.157.0 ${platform === "darwin-arm64" ? "darwin" : platform}`), `${platform} records what its tarball was checked against`);
    assert.notDeepEqual(entry.files, repo.lock.codex.vendorArtifacts[platform].files);
  }
  assert.equal(now.lock.codex.vendorArtifacts.provenance, undefined, "the old release's provenance note does not ride along");

  await assertRolledBack(repo);
});

test("lark-cli upgrades on its own: no Codex package, and Codex's pins untouched", { timeout: 60_000 }, async (t) => {
  const repo = await pinnedRepository(t);
  await writeFile(path.join(repo.checkout, "internal", "registry", "catalog", "manifest.json"), "{\"catalog\":\"1.0.97\"}\n");
  await repo.git("commit", "-q", "-am", "v1.0.97"); await repo.git("tag", "v1.0.97");
  const staged = await repo.tool(["stage-feishu", "--checkout", repo.checkout, "--version", "1.0.97"]);
  assert.match(staged, /linux-x64 was set aside/);
  const added = await repo.tool(["add-linux-x64", "--checkout", repo.checkout]);
  assert.match(added, /"into": "the staged upgrade"/);
  const status = await repo.tool(["status"]);
  assert.ok(whole(status) && /lark-cli 1\.0\.97/.test(status) && /an upgrade is staged/.test(status), status);

  const now = await repo.current();
  assert.deepEqual(now.lock.codex, repo.lock.codex, "Codex's pins are untouched");
  assert.deepEqual(only(now.resources, "codex"), only(repo.resources, "codex"), "and so are its files");
  for (const platform of ["darwin-arm64", "linux-arm64", "linux-x64"]) {
    assert.notEqual(now.lock.feishu.bundledArtifacts[platform].sha256, repo.lock.feishu.bundledArtifacts[platform].sha256, `${platform} is the new build`);
  }
  assert.match(now.lock.feishu.bundledArtifacts["linux-x64"].builtFromSource.command, /GOARCH=amd64 .*build\.Version=1\.0\.97/);

  await assertRolledBack(repo);
});

test("an x64 added where none was pinned is taken away again by rollback", { timeout: 60_000 }, async (t) => {
  const repo = await pinnedRepository(t);
  // A lock without Codex's x64, as before the server existed.
  const lock = structuredClone(repo.lock); delete lock.codex.vendorArtifacts["linux-x64"];
  await writeFile(path.join(repo.root, "upstreams.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  await rename(path.join(repo.root, "resources", "codex", "linux-x64"), path.join(repo.root, "codex-x64-before"));
  const without = await repo.current();
  await repo.tool(["add-linux-x64", "--codex", await repo.tree("0.155.0", "linux-x64"), "--codex-integrity", integrity("0.155.0 linux-x64")], repo.withoutGo);
  assert.ok(whole(await repo.tool(["status"])));
  await repo.tool(["rollback"]);
  const after = await repo.current();
  assert.deepEqual(after.bytes, without.bytes);
  assert.equal(Object.keys(after.resources).some((name) => name.startsWith("codex/linux-x64/")), false, "the added tree is not left behind");
});
