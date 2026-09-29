import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, chmod, rm, mkdir, copyFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { applicationRoot, bundledBinaryPath, resolveFeishuRuntime, verifyBinary, feishuAgentEnvironment, FeishuRuntimeRefused } from "../src/providers/feishu/bundled-runtime.js";
import { runProcess } from "../src/providers/process-runner.js";

test("missing bundle fails instead of using the system CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-missing-"));
  try {
    await assert.rejects(resolveFeishuRuntime({}, { resourcesRoot: root, platform: "darwin", arch: "arm64" }), /Bundled lark-cli is missing/);
    await assert.rejects(resolveFeishuRuntime({ binary: "lark-cli" }), /absolute path/);
    await assert.rejects(resolveFeishuRuntime({}, { platform: "unsupported", arch: "unknown" }), /No validated/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("integrity validation rejects modified executable bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-integrity-"));
  const binary = path.join(root, "fixture");
  try {
    await writeFile(binary, "original");
    await chmod(binary, 0o755);
    const sha256 = createHash("sha256").update("original").digest("hex");
    assert.equal(await verifyBinary(binary, sha256), 8);
    await writeFile(binary, "modified");
    await assert.rejects(verifyBinary(binary, sha256), /checksum mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an agent subprocess can discover its CLI with an otherwise empty PATH", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mydoubao path with spaces "));
  try {
    // A shell fixture is enough to verify process environment propagation.
    if (process.platform === "win32") return;
    const binary = path.join(root, "lark-cli");
    await writeFile(binary, "#!/bin/sh\nprintf 'bundled-fixture'\n", { mode: 0o755 });
    const env = feishuAgentEnvironment(binary, { PATH: "" });
    const result = await runProcess("/bin/sh", ["-c", "lark-cli --version"], { env });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "bundled-fixture");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows resource naming does not require a JS wrapper", () => {
  assert.equal(path.basename(bundledBinaryPath("/resources", "win32", "x64")), "lark-cli.exe");
});

// A release runs what it shipped. An override is a development tool; in a
// packaged app it would be an unreviewed program holding the person's Feishu
// credential, selected by nothing more than an environment variable.
test("a packaged app refuses a Feishu CLI override, even one that exists", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-override-"));
  const other = path.join(root, "lark-cli");
  try {
    await writeFile(other, "#!/bin/sh\necho lark-cli version 1.0.78\n", { mode: 0o755 });
    await assert.rejects(resolveFeishuRuntime({ binary: other }, { packaged: true }), /Packaged app runs only its bundled lark-cli/);
    const development = await resolveFeishuRuntime({ binary: other }, { packaged: false });
    assert.deepEqual(development, { binary: other, source: "development-override", version: null });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The case a version check exists to miss: the forgery reports exactly the
// pinned version, and sits exactly where the bundled binary belongs.
test("a forged CLI that reports the pinned version is refused before it runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-forged-"));
  const binary = bundledBinaryPath(root, "darwin", "arm64");
  try {
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "#!/bin/sh\necho 'lark-cli version 1.0.78'\n", { mode: 0o755 });
    await writeFile(path.join(path.dirname(binary), "LICENSE"), "MIT License\n");
    const says = await runProcess(binary, ["--version"]);
    assert.equal(says.stdout.trim(), "lark-cli version 1.0.78", "the forgery really does claim the pinned version");
    await assert.rejects(resolveFeishuRuntime({}, { resourcesRoot: root, platform: "darwin", arch: "arm64", packaged: true }), /checksum mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// 2026-09-24: src/ had changed since the release was signed, so the release no
// longer verified and every Feishu call was refused before it ran. The chat
// reader reported that as "check the CLI login, message permissions and
// network", and a manual smoke was chased down those paths. The refusal is the
// application's own, and says so by its kind wherever it is caught.
test("a signed release that no longer matches its source refuses the runtime as such", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-stale-release-"));
  try {
    // The real signed release and the lock it names, beside source it was not signed for.
    await mkdir(path.join(root, "release"));
    for (const file of ["release/manifest.json", "release/manifest.sig.json", "upstreams.lock.json", "package.json", "package-lock.json"]) await copyFile(path.join(applicationRoot, file), path.join(root, file));
    for (const directory of ["src", "bin"]) { await mkdir(path.join(root, directory)); await writeFile(path.join(root, directory, "edited.js"), "// changed after signing\n"); }
    const refused = await resolveFeishuRuntime({}, { releaseRoot: root, platform: "darwin", arch: "arm64" }).then(() => null, (error) => error);
    assert.ok(refused instanceof FeishuRuntimeRefused, String(refused));
    assert.match(refused.message, /发布清单与应用源码或适配器协议不一致/);
    // What the renderer is handed, and takes "Error: " off before showing it.
    assert.equal(String(refused), `Error: ${refused.message}`);
    // Every other refusal is the same kind.
    for (const refusal of [() => resolveFeishuRuntime({}, { resourcesRoot: root, platform: "darwin", arch: "arm64" }), () => resolveFeishuRuntime({ binary: "lark-cli" }),
      () => resolveFeishuRuntime({ binary: path.join(root, "absent", "lark-cli") }), () => resolveFeishuRuntime({}, { platform: "unsupported", arch: "unknown" })]) await assert.rejects(refusal, FeishuRuntimeRefused);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// The licence travels with the binary it covers. Uses the real bundled binary
// for this machine, cloned, because only the reviewed bytes get as far as the
// licence check.
const HOST = { platform: process.platform, arch: process.arch };
const REAL = bundledBinaryPath(undefined, HOST.platform, HOST.arch);
test("the reviewed CLI without its licence, or with an empty one, is refused", { skip: !existsSync(REAL) && "resources/lark-cli is not bundled in this checkout" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-license-"));
  const binary = bundledBinaryPath(root, HOST.platform, HOST.arch);
  try {
    await mkdir(path.dirname(binary), { recursive: true });
    await copyFile(REAL, binary, constants.COPYFILE_FICLONE);
    await chmod(binary, 0o755);
    const options = { resourcesRoot: root, ...HOST, packaged: true };
    await assert.rejects(resolveFeishuRuntime({}, options), /Bundled lark-cli is missing/);
    await writeFile(path.join(path.dirname(binary), "LICENSE"), "  \n");
    await assert.rejects(resolveFeishuRuntime({}, options), /LICENSE is empty/);
    await writeFile(path.join(path.dirname(binary), "LICENSE"), "MIT License\n");
    const resolved = await resolveFeishuRuntime({}, options);
    assert.equal(resolved.source, "bundled");
    assert.equal(resolved.binary, binary);
  } finally { await rm(root, { recursive: true, force: true }); }
});
