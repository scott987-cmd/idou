#!/usr/bin/env node
// Can this release run on this machine? Run on the server inside a freshly
// extracted release, before `app` is pointed at it:
//
//   cd /opt/idou/releases/<发布号> && sudo -u idou node scripts/verify-server-release.js
//
// It checks what the control plane will check when it first needs Feishu: the
// signed manifest against the source on disk, and the bundled lark-cli for this
// platform against its pinned digest -- and then that the service user can run it.
//
// 2026-09-25: no release deployed since 9-22 carried resources/lark-cli -- the
// deploy copied src, bin and release but not resources -- and every scheduled
// run failed at its very end, saving its report ("Bundled lark-cli is missing
// for linux-x64"), until someone ran one by hand three days later.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveFeishuRuntime } from "../src/providers/feishu/bundled-runtime.js";
import { readReleaseManifest } from "../src/providers/release-manifest.js";

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const target = `${process.platform}-${process.arch}`;
try {
  // Held to the signature even where it is run from a checkout: this is the
  // check a release passes before a server runs it.
  await readReleaseManifest(root, { strict: true });
  const runtime = await resolveFeishuRuntime({}, { releaseRoot: root, resourcesRoot: path.join(root, "resources"), packaged: false });
  const { stdout } = await promisify(execFile)(runtime.binary, ["--version"], { timeout: 20_000, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1" } });
  process.stdout.write(`这个发布可以在这台机器上运行：源码与签名清单一致，${target} 的 lark-cli ${runtime.version} 摘要一致，${stdout.trim()}。\n`);
} catch (error) {
  process.stderr.write(`这个发布不能在这台机器上运行：${error?.message ?? error}\n` +
    `打包时要带上 resources/lark-cli/${target}（docs/server-deployment.md「发布新版本」）。\n`);
  process.exit(1);
}
