// Places the pinned Node for one platform in resources/node/<platform>/, where
// scripts/package-mac.js takes it into the application bundle.
//
//   node scripts/bundle-node.js darwin-arm64 /absolute/path/to/node-v<version>-darwin-arm64
//
// The source is the official archive from nodejs.org, unpacked -- downloaded
// and checked by whoever builds: its SHASUMS256.txt against the Node.js release
// keys, the archive against that file (src/providers/node-pin.json records how
// the pinned one was). This script downloads nothing. It takes only bin/node
// and LICENSE, and only if each matches the digest node-pin.json records; it
// never replaces a tree that is already in place, and a mismatched one is
// reported for a person to move.
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { applicationRoot, fileDigest, verifyTree } from "../src/providers/runtime-artifacts.js";
import { NODE_PIN } from "../src/providers/node-runtime.js";

async function main() {
  const [platform, source] = process.argv.slice(2);
  if (!platform || !source || process.argv.length !== 4 || !path.isAbsolute(source)) {
    throw new Error("用法：node scripts/bundle-node.js <平台，如 darwin-arm64> </绝对路径/node-v版本-平台>");
  }
  const artifact = NODE_PIN[platform];
  if (!artifact?.files) throw new Error(`src/providers/node-pin.json 没有 ${platform} 的 Node 审核记录`);
  for (const [name, expected] of Object.entries(artifact.files)) {
    const file = path.join(source, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`${source} 里没有 ${name}（或它不是普通文件）`);
    if (await fileDigest(file) !== expected) throw new Error(`${file} 不是审核过的 Node ${NODE_PIN.version}：摘要不符`);
  }

  const resources = path.join(applicationRoot, "resources", "node");
  const destination = path.join(resources, platform);
  if (await lstat(destination).catch(() => null)) {
    try {
      await verifyTree(destination, artifact.files);
      console.log(JSON.stringify({ platform, destination, version: NODE_PIN.version, already: true }, null, 2));
      return;
    } catch (error) {
      throw new Error(`${destination} 已存在且与 node-pin.json 不符（${error.message}）；请先把它移走，本脚本不会替你删除`);
    }
  }

  // Copied beside the destination and checked there before it takes the name,
  // so a failed or interrupted copy never looks like a finished one.
  await mkdir(resources, { recursive: true });
  const staging = await mkdtemp(path.join(resources, `.${platform}-`));
  try {
    for (const name of Object.keys(artifact.files)) {
      await mkdir(path.dirname(path.join(staging, name)), { recursive: true });
      await copyFile(path.join(source, name), path.join(staging, name));
    }
    await chmod(path.join(staging, "bin", "node"), 0o755);
    // mkdtemp makes it 0700; inside an application bundle it is read by whoever runs the app.
    await chmod(staging, 0o755);
    await verifyTree(staging, artifact.files);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  console.log(JSON.stringify({ platform, destination, version: NODE_PIN.version, files: Object.keys(artifact.files) }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
