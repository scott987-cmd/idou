// Places a verified Codex for one platform in resources/codex/<platform>/, where
// the sandbox image build copies it from.
//
//   node scripts/bundle-codex.js linux-arm64 /absolute/path/to/vendor/aarch64-unknown-linux-musl
//
// The source is the `vendor/<target>` directory of an installed
// @openai/codex-<platform> package -- for a Linux platform, typically unpacked
// from `npm pack` on a machine allowed to download it. This script downloads
// nothing. It accepts the directory only if every file in it matches
// upstreams.lock.json and nothing else is there, and it never replaces a tree
// that is already in place: a mismatched one is reported for a person to move.
import { chmod, cp, lstat, mkdir, mkdtemp, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { applicationRoot, readPins, verifyTree } from "../src/providers/runtime-artifacts.js";

async function main() {
  const [platform, source] = process.argv.slice(2);
  if (!platform || !source || process.argv.length !== 4 || !path.isAbsolute(source)) {
    throw new Error("用法：node scripts/bundle-codex.js <平台，如 linux-arm64> </绝对路径/vendor/目标三元组>");
  }
  const lock = await readPins();
  const artifact = lock.codex.vendorArtifacts?.[platform];
  if (!artifact?.files) throw new Error(`upstreams.lock.json 没有 ${platform} 的 Codex 审核记录；先让新产物通过契约测试再写入锁文件`);
  await verifyTree(source, artifact.files);

  const resources = path.join(applicationRoot, "resources", "codex");
  const destination = path.join(resources, platform);
  const existing = await lstat(destination).catch(() => null);
  if (existing) {
    try {
      await verifyTree(destination, artifact.files);
      console.log(JSON.stringify({ platform, destination, version: lock.codex.version, files: Object.keys(artifact.files).length, already: true }, null, 2));
      return;
    } catch (error) {
      throw new Error(`${destination} 已存在且与锁文件不符（${error.message}）；请先把它移走，本脚本不会替你删除`);
    }
  }

  // Copied beside the destination and checked there before it takes the name,
  // so a failed or interrupted copy never looks like a finished one.
  await mkdir(resources, { recursive: true });
  const scratch = await mkdtemp(path.join(resources, `.${platform}-`));
  const staging = path.join(scratch, "tree");
  try {
    await cp(source, staging, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    // Permission bits decide whether the unprivileged sandbox user can run
    // these at all, so they are made to match the source rather than trusted.
    for (const name of Object.keys(artifact.files)) {
      await chmod(path.join(staging, name), (await lstat(path.join(source, name))).mode & 0o7777);
    }
    await verifyTree(staging, artifact.files);
    await rename(staging, destination);
    await rmdir(scratch);
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify({ platform, destination, version: lock.codex.version, files: Object.keys(artifact.files).length }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
