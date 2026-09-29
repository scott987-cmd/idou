import { existsSync } from "node:fs";
import path from "node:path";
import { platformKey, readPins, verifyTree } from "../runtime-artifacts.js";

// A packaged app carries the pinned Codex, laid out the way its npm package lays
// it out -- bin/codex beside codex-package.json, codex-path/ and codex-resources/
// -- because an app started from Finder has no `codex` on its PATH. The binary
// reads that layout itself: it puts codex-path, its own ripgrep, on the PATH of
// the Agent's commands, as scripts/smoke-packaged-app.js checks. Outside a
// packaged app there is none, and the configured `codex`, or the one on PATH, is
// used as before.
const packagedResources = () => (process.resourcesPath && !process.defaultApp ? process.resourcesPath : null);

export function bundledCodexBinary(resourcesRoot = packagedResources()) {
  if (!resourcesRoot) return null;
  const binary = path.join(resourcesRoot, "codex", "bin", process.platform === "win32" ? "codex.exe" : "codex");
  return existsSync(binary) ? binary : null;
}

const verified = new Map();

// What actually gets executed, asked immediately before each launch.
//
// In a development run that is whatever was configured, as before: the version
// check where it matters stays with the caller. In a packaged app it is the
// bundled Codex and nothing else, and only once every file of it -- the binary,
// its helper, its ripgrep and its shell -- matches the lock. A release that ran
// any `codex` an environment variable named would be running an unreviewed
// program with the person's model credential in its environment.
//
// Hashing 270 MB before every task would be felt, so a tree is hashed again only
// when its files' metadata has moved (see verifyTree).
export async function resolveCodexRuntime(binary, { resourcesRoot = packagedResources(), platform = process.platform, arch = process.arch, pins = null } = {}) {
  if (!resourcesRoot) return { binary: binary || "codex", source: "development", version: null };
  const bundled = bundledCodexBinary(resourcesRoot);
  if (!bundled) throw new Error("应用内置的 Codex 缺失，请重新安装应用");
  if (binary && binary !== bundled) throw new Error("打包应用只运行内置的 Codex，已拒绝配置的替代程序");
  const lock = pins ?? await readPins();
  const artifact = lock.codex.vendorArtifacts?.[platformKey(platform, arch)];
  if (!artifact) throw new Error(`没有为 ${platformKey(platform, arch)} 审核过的 Codex，这个平台还不能运行任务`);
  try { await verifyTree(path.join(resourcesRoot, "codex"), artifact.files, { cache: verified }); }
  catch (error) { throw new Error(`应用内置的 Codex 与发布清单不一致（${error.message}），请重新安装应用`); }
  return { binary: bundled, source: "bundled", version: lock.codex.version };
}
