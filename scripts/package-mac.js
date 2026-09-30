import "../src/adopt-legacy-env.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFeishuRuntime } from "../src/providers/feishu/bundled-runtime.js";
import { verifyTree } from "../src/providers/runtime-artifacts.js";
import { NODE_PIN } from "../src/providers/node-runtime.js";
import { readReleaseManifest, verifyReleaseLicenses } from "../src/providers/release-manifest.js";
import { validateServerUrl } from "../src/control-plane/client-session.js";
import { rememberedServerFile } from "../src/desktop/remembered-server.js";
import { BUNDLE_ID, LEGACY_BUNDLE_ID, desktopProfileName } from "../src/install-names.js";

const run = promisify(execFile);

// Builds dist/i豆.app: the desktop app as a macOS application with an
// identity of its own, signed, so what macOS grants it -- Accessibility and Screen
// Recording for computer control -- is granted to this app rather than to the
// generic com.github.Electron that every Electron development build shares.
//
// Nothing is downloaded. It reuses the Electron.app already in node_modules, the
// reviewed lark-cli in resources/ (checked against upstreams.lock.json first),
// the Codex from the local @openai/codex install -- refused unless every one of
// its files matches the digests the lock records, which a matching version
// string alone does not show -- laid out the way its npm package lays it out,
// and the pinned Node in resources/node (scripts/bundle-node.js, checked against
// src/providers/node-pin.json). Each is checked again once it is inside the
// bundle, because what was verified and what was shipped are only the same if
// someone looks.
//
// The Electron it is built on gives up three of its switches (fuses) before it
// is signed: RunAsNode, with which the signed application runs any script it is
// handed as Node -- and with it the application's identity, its Keychain item
// and the privacy permissions macOS granted it -- and NODE_OPTIONS and
// --inspect, which reach the same through the environment and the command line.
// What the application itself runs as Node it runs on the Node it carries
// (src/providers/node-runtime.js).
// No browser is bundled: the browser connector uses Playwright's Chromium where
// this machine has one, and the system Chrome otherwise.
//
//   npm run package:mac                              signs with the first "Apple Development" identity
//   IDOU_SIGN_IDENTITY=<sha1 or name> npm run package:mac
//   IDOU_SIGN_IDENTITY=- npm run package:mac     ad hoc: it runs, but a rebuild is a new identity to macOS
//
// Signing uses the private key in the login keychain, and macOS may ask you to allow that.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
// The bundle identifier is what macOS knows the application by: its privacy
// permissions (Accessibility, Screen Recording, notifications) and the
// Keychain item its secrets are sealed with belong to it. A machine that
// already runs the application from before the product was renamed keeps the
// identifier it has (install-names.js), or it would lose all of those; so do
// the machines of an organisation whose people have it installed, by setting
// IDOU_BUNDLE_ID to it when building for them.
const APP_ID = process.env.IDOU_BUNDLE_ID
  || (desktopProfileName({ appData: path.join(os.homedir(), "Library", "Application Support") }) === "我的豆包" ? LEGACY_BUNDLE_ID : BUNDLE_ID);
const EXECUTABLE = "idou";
const APP = path.join(ROOT, "dist", "i豆.app");
const RESOURCES = path.join(APP, "Contents", "Resources");
const MARKER = path.join(RESOURCES, "idou-build.json");
// A build of this script's from before the rename.
const EARLIER_MARKER = path.join(RESOURCES, "mydoubao-build.json");
// Imported by the shipped code, yet listed in package.json for development only:
// the browser connector drives Chromium through Playwright.
const RUNTIME_EXTRAS = ["playwright", "playwright-core"];
const TERMINAL_PACKAGES = Object.freeze({ "node-pty": "1.1.0", "@xterm/xterm": "6.0.0", "@xterm/addon-fit": "0.11.0" });

if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("package-mac builds the Apple silicon app and has to run on one");
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(ROOT, "upstreams.lock.json"), "utf8"));
const lockfile = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));

// The pinned Codex, found through the codex launcher on PATH (or IDOU_CODEX_LAUNCHER).
async function codexVendor() {
  const launcher = process.env.IDOU_CODEX_LAUNCHER || (await run("/bin/sh", ["-c", "command -v codex || true"])).stdout.trim();
  if (!launcher) throw new Error(`No codex on PATH: install @openai/codex@${lock.codex.version}, or set IDOU_CODEX_LAUNCHER`);
  const packageRoot = path.dirname(path.dirname(await realpath(launcher)));
  const vendor = path.join(packageRoot, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin");
  const binary = path.join(vendor, "bin", "codex");
  if (!existsSync(binary)) throw new Error(`The Codex install at ${packageRoot} carries no Apple silicon binary`);
  const artifact = lock.codex.vendorArtifacts?.["darwin-arm64"];
  if (!artifact?.files) throw new Error("upstreams.lock.json records no reviewed Codex for darwin-arm64");
  // The bytes first, and only then is anything executed: running a binary to
  // ask its version is running it.
  try { await verifyTree(vendor, artifact.files); }
  catch (error) { throw new Error(`The Codex at ${vendor} is not the reviewed ${lock.codex.version}: ${error.message}`); }
  const version = (await run(binary, ["--version"], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } })).stdout.trim();
  if (version !== `codex-cli ${lock.codex.version}`) throw new Error(`The local Codex is ${version}; this app is pinned to ${lock.codex.version}`);
  return { vendor, version: lock.codex.version, files: artifact.files };
}

async function signingIdentity() {
  if (process.env.IDOU_SIGN_IDENTITY) return process.env.IDOU_SIGN_IDENTITY;
  const { stdout } = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  const match = stdout.split("\n").map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"Apple Development:/)).find(Boolean);
  if (!match) throw new Error('No "Apple Development" signing identity; set IDOU_SIGN_IDENTITY, or "-" for an ad hoc build');
  return match[1];
}

// Of node_modules, only what the app runs on: every installed package the
// lockfile does not mark development-only, and RUNTIME_EXTRAS. Electron, its
// downloader and the type definitions stay out; the bundle already is Electron.
function runtimePackages() {
  for (const extra of RUNTIME_EXTRAS) if (!existsSync(path.join(ROOT, "node_modules", extra))) throw new Error(`${extra} is not installed; run npm ci first`);
  return Object.entries(lockfile.packages)
    .filter(([key, entry]) => /^node_modules\/(@[^/]+\/)?[^/]+$/.test(key) && (!entry.dev || RUNTIME_EXTRAS.includes(key.slice("node_modules/".length))))
    .map(([key]) => key)
    .filter((key) => existsSync(path.join(ROOT, key)));
}

async function verifyTerminalRuntime(root, { repairHelper = false } = {}) {
  for (const [name, version] of Object.entries(TERMINAL_PACKAGES)) {
    const packageRoot = path.join(root, "node_modules", name), metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (metadata.version !== version || metadata.license !== "MIT") throw new Error(`${name} must be the reviewed ${version} MIT package`);
    if (!(await stat(path.join(packageRoot, "LICENSE"))).isFile()) throw new Error(`${name} carries no LICENSE`);
  }
  const native = path.join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "pty.node");
  const helper = path.join(root, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
  if (repairHelper) { const info = await stat(helper); await chmod(helper, info.mode | 0o100); }
  if (!((await stat(helper)).mode & 0o100)) throw new Error("node-pty spawn-helper is not executable");
  const format = (await run("/usr/bin/file", [native])).stdout;
  if (!/Mach-O 64-bit bundle arm64/.test(format)) throw new Error(`node-pty native module has the wrong platform: ${format.trim()}`);
  return { ...TERMINAL_PACKAGES, nativeSha256: createHash("sha256").update(await readFile(native)).digest("hex") };
}

// The Node the app carries, as scripts/bundle-node.js placed it.
async function nodeRuntimeFiles() {
  const artifact = NODE_PIN["darwin-arm64"];
  const source = path.join(ROOT, "resources", "node", "darwin-arm64");
  try { await verifyTree(source, artifact.files); }
  catch (error) { throw new Error(`${source} is not the pinned Node ${NODE_PIN.version} (${error.message}): node scripts/bundle-node.js darwin-arm64 <the unpacked official archive>`); }
  return { source, version: NODE_PIN.version, files: artifact.files };
}
const FUSES_OFF = ["RunAsNode", "EnableNodeOptionsEnvironmentVariable", "EnableNodeCliInspectArguments"];

// Checked before anything is built, so a bad input never leaves half an app behind.
const codex = await codexVendor();
const node = await nodeRuntimeFiles();
const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options, FuseState } = await import("@electron/fuses");
// A release is packaged only as it was signed, checkout or not.
const release = await readReleaseManifest(ROOT, { strict: true });
await verifyReleaseLicenses(release, ROOT);
await resolveFeishuRuntime({}, { resourcesRoot: path.join(ROOT, "resources") });
const packages = runtimePackages();
const terminalRuntime = await verifyTerminalRuntime(ROOT, { repairHelper: true });
const identity = await signingIdentity();

// Only this script's own earlier build is ever replaced.
if (existsSync(APP)) {
  if (!existsSync(MARKER) && !existsSync(EARLIER_MARKER)) throw new Error(`${APP} exists but was not built by this script; move it away first`);
  await rm(APP, { recursive: true, force: true });
}
await mkdir(path.dirname(APP), { recursive: true });

// Electron itself, under this app's name and identity. The executable is renamed
// as well: Electron tells a packaged app from a development run by the
// executable's name, and one still called Electron reports app.isPackaged false.
await run("/usr/bin/ditto", [path.join(ROOT, "node_modules", "electron", "dist", "Electron.app"), APP]);
await rename(path.join(APP, "Contents", "MacOS", "Electron"), path.join(APP, "Contents", "MacOS", EXECUTABLE));
// Written into the framework binary, so before the signature seals it.
await flipFuses(APP, { version: FuseVersion.V1, resetAdHocDarwinSignature: false, ...Object.fromEntries(FUSES_OFF.map((name) => [FuseV1Options[name], false])) });
const plist = path.join(APP, "Contents", "Info.plist");
for (const [key, value] of [["CFBundleExecutable", EXECUTABLE], ["CFBundleIdentifier", APP_ID], ["CFBundleName", "i豆"], ["CFBundleDisplayName", "i豆"],
  ["CFBundleShortVersionString", pkg.version], ["CFBundleVersion", pkg.version],
  ["NSAppleEventsUsageDescription", "电脑操作需要控制你在任务里指定的应用。"]]) {
  await run("/usr/bin/plutil", ["-replace", key, "-string", value, plist]);
}
await rm(path.join(RESOURCES, "default_app.asar"), { force: true });

// The application's own icon. Electron ships its own (electron.icns) and the
// bundle pointed at it, so every build so far wore Electron's icon in the Dock
// and in Finder -- assets/icon.icns existed and was never installed.
await run("/usr/bin/ditto", [path.join(ROOT, "assets", "icon.icns"), path.join(RESOURCES, "icon.icns")]);
await rm(path.join(RESOURCES, "electron.icns"), { force: true });
await run("/usr/bin/plutil", ["-replace", "CFBundleIconFile", "-string", "icon", plist]);

// The application's code and what it runs on.
const appDir = path.join(RESOURCES, "app");
await mkdir(appDir, { recursive: true });
for (const entry of ["package.json", "package-lock.json", "upstreams.lock.json", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "release", "third_party", "src", "bin", ...packages]) await run("/usr/bin/ditto", [path.join(ROOT, entry), path.join(appDir, entry)]);
// Electron's and Chromium's own licenses travel with the runtime they cover.
for (const [from, to] of [["LICENSE", "LICENSE.electron.txt"], ["LICENSES.chromium.html", "LICENSES.chromium.html"]]) {
  await run("/usr/bin/ditto", [path.join(ROOT, "node_modules", "electron", "dist", from), path.join(RESOURCES, to)]);
}
// A build for one organisation can carry its control plane's address, so a
// machine that has never signed in opens straight to its sign-in (see main.js).
// Only what the desktop itself accepts as a control plane, read back the way
// the desktop will read it; sealed with the rest by the signature below.
const packagedServer = process.env.IDOU_PACKAGE_SERVER_URL ? validateServerUrl(process.env.IDOU_PACKAGE_SERVER_URL) : null;
if (packagedServer) {
  const deployment = path.join(appDir, "deployment.json");
  await writeFile(deployment, `${JSON.stringify({ serverUrl: packagedServer })}\n`);
  if (await rememberedServerFile(deployment) !== packagedServer) throw new Error("Packaged control-plane address does not read back");
}

// lark-cli where a packaged app looks for it -- this platform's only; the Linux
// build is for the sandbox image and cannot run here -- and Codex in its npm
// layout. Then both are checked where they landed.
await run("/usr/bin/ditto", [path.join(ROOT, "resources", "lark-cli", "darwin-arm64"), path.join(RESOURCES, "lark-cli", "darwin-arm64")]);
await run("/usr/bin/ditto", [codex.vendor, path.join(RESOURCES, "codex")]);
await run("/usr/bin/ditto", [node.source, path.join(RESOURCES, "node")]);
const shipped = await resolveFeishuRuntime({}, { resourcesRoot: RESOURCES, platform: "darwin", arch: "arm64", packaged: true });
await verifyTree(path.join(RESOURCES, "codex"), codex.files);
await verifyTree(path.join(RESOURCES, "node"), node.files);
const shippedRelease = await readReleaseManifest(appDir, { strict: true });
await verifyReleaseLicenses(shippedRelease, appDir);
const shippedTerminalRuntime = await verifyTerminalRuntime(appDir);
if (shippedTerminalRuntime.nativeSha256 !== terminalRuntime.nativeSha256) throw new Error("Packaged node-pty native module differs from the reviewed input");

// What went in is recorded inside the bundle before the signature seals it.
await writeFile(MARKER, `${JSON.stringify({ identifier: APP_ID, executable: EXECUTABLE, version: pkg.version, electron: pkg.devDependencies.electron,
  codex: codex.version, codexFiles: codex.files, larkCli: shipped.version, larkCliSha256: lock.feishu.bundledArtifacts["darwin-arm64"].sha256,
  node: node.version, nodeFiles: node.files, fusesOff: FUSES_OFF,
  releaseId: shippedRelease.releaseId, releaseKeyId: shippedRelease.keyId, upstreamsSha256: shippedRelease.upstreamsSha256,
  terminalRuntime: shippedTerminalRuntime, nodePackages: packages.length, serverUrl: packagedServer }, null, 2)}\n`);
try {
  await run("/usr/bin/codesign", ["--force", "--deep", "--timestamp=none", "--sign", identity, APP], { timeout: 10 * 60_000 });
} catch (error) {
  throw new Error(`Signing failed${error.killed ? " (timed out -- was a keychain prompt left unanswered?)" : ""}: ${String(error.stderr || error.message).trim().split("\n").at(-1)}`);
}
await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", APP]);
// Read back from the signed bundle: the switches are off, and signing did not
// touch the Node, which is resources to the app's signature, not nested code.
const wire = await getCurrentFuseWire(APP);
const stillOn = FUSES_OFF.filter((name) => wire[FuseV1Options[name]] !== FuseState.DISABLE);
if (stillOn.length) throw new Error(`Electron fuses still on after signing: ${stillOn.join(", ")}`);
await verifyTree(path.join(RESOURCES, "node"), node.files);
const described = await run("/usr/bin/codesign", ["-d", "-r-", APP]);
const requirement = (`${described.stdout}${described.stderr}`.match(/designated => (.+)/)?.[1] ?? "").trim();
const size = (await run("/usr/bin/du", ["-sm", APP])).stdout.trim().split(/\s+/)[0];
console.log(JSON.stringify({ built: path.relative(ROOT, APP), identifier: APP_ID, executable: EXECUTABLE, signedWith: identity === "-" ? "ad hoc" : identity,
  designatedRequirement: requirement, releaseId: shippedRelease.releaseId, codex: codex.version, larkCli: lock.feishu.version, node: node.version, fusesOff: FUSES_OFF,
  nodePackages: packages.length, sizeMB: Number(size) }, null, 2));
