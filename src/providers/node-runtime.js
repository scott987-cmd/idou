import { readFileSync } from "node:fs";
import path from "node:path";
import { packagedApp } from "./release-manifest.js";
import { platformKey, verifyTree } from "./runtime-artifacts.js";

// The program that runs the application's own Node scripts: the model
// gateway's token helper (bin/agent-token.js, which Codex runs for every
// request), the built-in connectors (bin/mcp/*.js), the Agent's tool
// (bin/agent.js) and the Agent's `node` on a machine that has none.
//
// In development that is the process's own runtime: Node itself, or the
// desktop's Electron told to act as Node (ELECTRON_RUN_AS_NODE). A packaged app
// cannot do the latter. Its Electron has the RunAsNode fuse turned off
// (scripts/package-mac.js), because a signed application that runs whatever
// script it is handed lends whoever hands it one its identity: its Keychain
// item, the privacy permissions macOS granted it. So it carries a Node of its
// own, Resources/node/bin/node -- the official build, pinned by digest in
// node-pin.json -- and every file of it is checked before each Codex launch
// (verifyBundledNode, from app-server-client.js).
const packagedResources = () => (packagedApp() ? process.resourcesPath : null);
export const NODE_PIN = Object.freeze(JSON.parse(readFileSync(new URL("./node-pin.json", import.meta.url), "utf8")));

export function bundledNodeBinary(resourcesRoot = packagedResources()) {
  return resourcesRoot ? path.join(resourcesRoot, "node", "bin", "node") : null;
}

// How to run a script on the application's Node: `command`, and what `env`
// that command needs added to its environment -- nothing else.
export function nodeRuntime({ resourcesRoot = packagedResources(), execPath = process.execPath, electron = Boolean(process.versions.electron) } = {}) {
  const bundled = bundledNodeBinary(resourcesRoot);
  if (bundled) return Object.freeze({ command: bundled, env: Object.freeze({}) });
  return Object.freeze({ command: execPath, env: Object.freeze(electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) });
}

const verified = new Map();

// In a packaged app, the Node it carries is the one the signed release pins,
// file for file: a changed, missing or added file is refused. Outside one there
// is nothing to check (null). Hashed again only when the files' metadata moved.
export async function verifyBundledNode({ resourcesRoot = packagedResources(), platform = process.platform, arch = process.arch, pins = NODE_PIN } = {}) {
  if (!resourcesRoot) return null;
  const artifact = pins?.[platformKey(platform, arch)];
  if (!artifact?.files) throw new Error(`没有为 ${platformKey(platform, arch)} 审核过的 Node，这个平台还不能运行任务`);
  const root = path.join(resourcesRoot, "node");
  try { await verifyTree(root, artifact.files, { cache: verified }); }
  catch (error) { throw new Error(`应用内置的 Node 与发布清单不符（${error.message}），请重新安装应用`); }
  return path.join(root, "bin", "node");
}
