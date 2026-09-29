import { createHash } from "node:crypto";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { applicationRoot, readPins } from "../runtime-artifacts.js";
import { packagedApp } from "../release-manifest.js";

export { applicationRoot };

// A packaged app is a release: what it runs is what was reviewed and shipped
// inside it. A development run is a person working on this code, who may point
// it at another build on purpose.
// One answer to "is this the installed app", shared with the release check.
export { packagedApp };

export function bundledBinaryPath(resourcesRoot = packagedApp() ? process.resourcesPath : path.join(applicationRoot, "resources"), platform = process.platform, arch = process.arch) {
  return path.join(resourcesRoot, "lark-cli", `${platform}-${arch}`, platform === "win32" ? "lark-cli.exe" : "lark-cli");
}

export async function verifyBinary(binary, expectedSha256) {
  const bytes = await readFile(binary);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) throw new Error("Bundled lark-cli checksum mismatch; repair the application runtime");
  await access(binary, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  return bytes.length;
}

// The application will not run its Feishu CLI: the signed release does not
// verify against the source beside it, the binary is missing or not the
// reviewed bytes, or an override was refused. Every Feishu call fails this way
// until the application is repaired -- or, in development, re-signed -- and no
// login, permission or network would change that. So the readers that turn a
// failed call into a message of their own (chat-reader.js,
// feishu-account-verifier.js) pass this one on as it is. They did not: a
// manual smoke (M10) run on source the manifest had not been re-signed for
// reported a chat list that could not be read, "check the CLI login, message
// permissions and network", and was chased down those paths (2026-09-24).
//
// Its name stays "Error": Electron hands a rejection to the renderer as
// "…: <name>: <message>", and the renderer takes "Error: " off before the
// sentence reaches the screen.
export class FeishuRuntimeRefused extends Error {}

// Checked before every execution, not once: the bytes are hashed against the
// lock each time, so a binary replaced while the app runs -- even one that
// reports the same version -- fails here instead of running.
//
// `releaseRoot` is where the signed release is read from: this application's
// own, unless a test names another.
export async function resolveFeishuRuntime(config = {}, options = {}) {
  try { return await resolveRuntime(config, options); }
  catch (error) { throw error instanceof FeishuRuntimeRefused ? error : new FeishuRuntimeRefused(error?.message ?? String(error), { cause: error }); }
}

async function resolveRuntime(config, { resourcesRoot, platform = process.platform, arch = process.arch, packaged = packagedApp(), releaseRoot } = {}) {
  const bundled = bundledBinaryPath(resourcesRoot, platform, arch);
  if (config.binary && config.binary !== bundled) {
    // An override in a release would be an unreviewed binary holding the
    // person's Feishu credential, reached through nothing more than an
    // environment variable. It is a development tool and only works as one.
    if (packaged) throw new Error("Packaged app runs only its bundled lark-cli; the configured override was refused");
    if (!path.isAbsolute(config.binary)) throw new Error("Feishu CLI override must be an absolute path; system PATH lookup is disabled");
    await access(config.binary);
    return { binary: config.binary, source: "development-override", version: null };
  }
  const lock = await readPins(releaseRoot);
  const target = `${platform}-${arch}`;
  const artifact = lock.feishu.bundledArtifacts?.[target];
  if (!artifact) throw new Error(`No validated bundled lark-cli for ${target}; build a runtime package for this target`);
  try {
    await verifyBinary(bundled, artifact.sha256);
    // Present and not empty: the licence travels with the binary it covers.
    if (!(await readFile(path.join(path.dirname(bundled), "LICENSE"), "utf8")).trim()) throw new Error("Bundled lark-cli LICENSE is empty; repair the application runtime");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Bundled lark-cli is missing for ${target}; run npm run bundle:feishu on the build machine`);
    throw error;
  }
  return { binary: bundled, source: "bundled", version: lock.feishu.version };
}

export function feishuAgentEnvironment(binary, env = process.env, providerEnvironment = {}) {
  if (!providerEnvironment || typeof providerEnvironment !== "object" || Array.isArray(providerEnvironment) || Object.entries(providerEnvironment).some(([key, value]) => !/^LARKSUITE_CLI_[A-Z0-9_]+$/.test(key) || typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid Feishu CLI provider environment");
  return { ...env, ...providerEnvironment, PATH: [path.dirname(binary), env.PATH].filter(Boolean).join(path.delimiter) };
}
