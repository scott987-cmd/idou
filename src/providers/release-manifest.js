import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const applicationRoot = fileURLToPath(new URL("../../", import.meta.url));
export const RELEASE_KEY_ID = "dc9a5173c44fc9333d3c83893f5cc0d9d79709ad060c2e829842bb6d2792b1dd";
const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmZa8woOGMK7UQbAgaDEY1iRPLl4WryE4suc7prK9uec=
-----END PUBLIC KEY-----
`;

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// The installed desktop app: Electron's own process, not one started with
// `electron .` from a checkout. A Node process -- the server, a test, a child
// the app starts as plain Node -- is never this.
export const packagedApp = () => Boolean(process.resourcesPath && !process.defaultApp);

// How much a release has to prove, by who is running it.
//
// Strict is what every release always had to prove: the signed manifest names
// exactly this source tree, lock, licenses and sandbox images, or nothing
// runs. That is an installed app, a server's release directory (neither has a
// `.git`), production sandboxes, and every script that packages, signs or
// ships a release (they ask for it by name).
//
// A source checkout -- a `.git` beside the code, outside an installed app -- is
// someone working on it. The source changes with every edit and only the
// release owner holds the signing key, so the source tree is not held to the
// signature there. The binaries still are, by the digests in
// upstreams.lock.json, and what the signed release approved (its sandbox
// images, its licenses) still counts while the lock is the one it was signed
// with. IDOU_RELEASE_VERIFICATION=strict holds a checkout to the signature
// as well: `npm run check:release`, before a release is cut.
export function releaseVerification(root = applicationRoot, { env = process.env, packaged = packagedApp() } = {}) {
  if (packaged || env.IDOU_RELEASE_VERIFICATION === "strict" || env.IDOU_SANDBOX_MODE === "production") return "strict";
  return existsSync(path.join(root, ".git")) ? "development" : "strict";
}
const exact = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} 字段不符合发布契约`);
  }
};
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const safePath = value => typeof value === "string" && /^[A-Za-z0-9._/-]{1,256}$/.test(value) && !value.startsWith("/") && !value.split("/").includes("..");

function releaseSourceFiles(root) {
  const files = ["package.json", "package-lock.json"];
  const walk = prefix => {
    for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile() && lstatSync(path.join(root, name)).isFile()) files.push(name);
      else throw new Error(`${name} 不是可发布的普通文件`);
    }
  };
  walk("src"); walk("bin");
  return files.sort();
}

export function applicationSourceDigest(root = applicationRoot) {
  const hash = createHash("sha256");
  for (const name of releaseSourceFiles(root)) hash.update(name).update("\0").update(digest(readFileSync(path.join(root, name)))).update("\n");
  return hash.digest("hex");
}

// `source: false` checks everything the signature approved except the source
// tree it was signed from: what a checkout under development may reuse.
function validateRelease(manifest, signature, lockBytes, packageBytes, root, { source = true } = {}) {
  exact(signature, ["schemaVersion", "keyId", "algorithm", "signature"], "发布签名");
  if (signature.schemaVersion !== 1 || signature.keyId !== RELEASE_KEY_ID || signature.algorithm !== "Ed25519" ||
      typeof signature.signature !== "string" || !/^[A-Za-z0-9+/]{80,100}={0,2}$/.test(signature.signature)) throw new Error("发布签名格式无效");
  exact(manifest, ["schemaVersion", "releaseId", "createdAt", "keyId", "application", "upstreamsSha256", "upstreams", "licenses", "sandboxImages"], "发布清单");
  if (manifest.schemaVersion !== 1 || manifest.keyId !== RELEASE_KEY_ID || !/^[A-Za-z0-9._-]{1,80}$/.test(manifest.releaseId) ||
      !Number.isFinite(Date.parse(manifest.createdAt)) || !sha(manifest.upstreamsSha256) || manifest.upstreamsSha256 !== digest(lockBytes)) {
    throw new Error("发布清单标识或上游锁摘要无效");
  }
  const lock = JSON.parse(lockBytes);
  if (JSON.stringify(manifest.upstreams) !== JSON.stringify(lock)) throw new Error("发布清单中的上游组合与 upstreams.lock.json 不一致");
  const pkg = JSON.parse(packageBytes);
  exact(manifest.application, ["name", "version", "sourceSha256", "packageLockSha256", "adapterContracts"], "应用版本");
  exact(manifest.application.adapterContracts, ["codex", "feishu"], "适配器协议");
  // Under development only the lock decides what the signed approvals still
  // cover: the images and licenses are the lock's, whatever the package is called.
  if ((source && (manifest.application.name !== pkg.name || manifest.application.version !== pkg.version)) ||
      (source && manifest.application.sourceSha256 !== applicationSourceDigest(root)) ||
      (source && manifest.application.packageLockSha256 !== digest(readFileSync(path.join(root, "package-lock.json")))) ||
      manifest.application.adapterContracts.codex !== lock.codex.integrationBoundary ||
      manifest.application.adapterContracts.feishu !== lock.feishu.integrationBoundary) throw new Error("发布清单与应用源码或适配器协议不一致");
  exact(manifest.licenses, ["codex"], "许可证");
  exact(manifest.licenses.codex, ["spdx", "source", "licenseFile", "licenseSha256", "noticeFile", "noticeSha256"], "Codex 许可证");
  const license = manifest.licenses.codex;
  if (license.spdx !== "Apache-2.0" || !/^https:\/\/github\.com\/openai\/codex\/(blob|raw)\//.test(license.source) ||
      !safePath(license.licenseFile) || !sha(license.licenseSha256) || !safePath(license.noticeFile) || !sha(license.noticeSha256)) {
    throw new Error("Codex 许可证记录无效");
  }
  if (!manifest.sandboxImages || typeof manifest.sandboxImages !== "object" || Array.isArray(manifest.sandboxImages)) throw new Error("沙箱发布矩阵无效");
  for (const [platform, image] of Object.entries(manifest.sandboxImages)) {
    if (!/^linux-(arm64|x64)$/.test(platform)) throw new Error(`沙箱平台 ${platform} 无效`);
    // `classicId` is the same image's ID in Docker's classic image store, where a
    // loaded image has no repository digest (sandbox-image.js, pinnedImage).
    const classic = Object.hasOwn(image, "classicId");
    exact(image, classic ? ["reference", "id", "baseImage", "classicId"] : ["reference", "id", "baseImage"], `沙箱 ${platform}`);
    if (!/^[-A-Za-z0-9./:]+@sha256:[a-f0-9]{64}$/.test(image.reference) || !/^sha256:[a-f0-9]{64}$/.test(image.id) || image.baseImage !== lock.sandbox.baseImage ||
        (classic && !/^sha256:[a-f0-9]{64}$/.test(image.classicId))) {
      throw new Error(`沙箱 ${platform} 的批准产物无效`);
    }
  }
  return manifest;
}

function parseAndVerify(manifestBytes, signatureBytes, lockBytes, packageBytes, root, options) {
  let manifest, signature;
  try { manifest = JSON.parse(manifestBytes); signature = JSON.parse(signatureBytes); }
  catch { throw new Error("发布清单不是有效 JSON"); }
  if (!verify(null, manifestBytes, createPublicKey(RELEASE_PUBLIC_KEY), Buffer.from(signature.signature ?? "", "base64"))) {
    throw new Error("发布清单签名无效");
  }
  return validateRelease(manifest, signature, lockBytes, packageBytes, root, options);
}

// What a checkout under development runs as: the lock as it is on disk, and the
// signed release's approvals where they were given for this same lock --
// otherwise none, so a production sandbox refuses every image. Named after the
// release it grew from, so a log says which one.
function developmentRelease(root, lockBytes, packageBytes, signed) {
  const lock = JSON.parse(lockBytes), pkg = JSON.parse(packageBytes);
  const codex = (file) => path.join("third_party", "codex", file);
  const licenses = signed?.licenses ?? { codex: { spdx: "Apache-2.0", source: `https://github.com/openai/codex/blob/rust-v${lock.codex.version}`,
    licenseFile: codex("LICENSE"), licenseSha256: digest(readFileSync(path.join(root, codex("LICENSE")))),
    noticeFile: codex("NOTICE"), noticeSha256: digest(readFileSync(path.join(root, codex("NOTICE")))) } };
  return Object.freeze({ schemaVersion: 1, development: true, releaseId: `${signed?.releaseId ?? "unreleased"}+dev`,
    createdAt: signed?.createdAt ?? null, keyId: signed?.keyId ?? null,
    application: { name: pkg.name, version: pkg.version, sourceSha256: applicationSourceDigest(root),
      packageLockSha256: digest(readFileSync(path.join(root, "package-lock.json"))),
      adapterContracts: { codex: lock.codex.integrationBoundary, feishu: lock.feishu.integrationBoundary } },
    upstreamsSha256: digest(lockBytes), upstreams: lock, licenses, sandboxImages: signed?.sandboxImages ?? {} });
}

const locations = root => ({ manifest: path.join(root, "release", "manifest.json"), signature: path.join(root, "release", "manifest.sig.json"),
  lock: path.join(root, "upstreams.lock.json"), package: path.join(root, "package.json") });
// A release is immutable for the lifetime of a process. Upgrading the app or
// control plane requires a restart; caching its already verified source tree
// avoids hashing every loaded JS file before each CLI invocation. Custom roots
// used by verification/tests are never cached. `strict` is for the scripts that
// package, sign and ship: they hold a checkout to the signature too.
const currentRelease = new Map();
const settle = (root, mode, read) => {
  if (root === applicationRoot && currentRelease.has(mode)) return currentRelease.get(mode);
  const release = read(mode);
  if (root === applicationRoot) currentRelease.set(mode, release);
  return release;
};
const modeFor = (root, strict) => (strict ? "strict" : releaseVerification(root));

export async function readReleaseManifest(root = applicationRoot, { strict = false } = {}) {
  const mode = modeFor(root, strict);
  if (root === applicationRoot && currentRelease.has(mode)) return currentRelease.get(mode);
  const files = locations(root);
  const [lock, pkg] = await Promise.all([readFile(files.lock), readFile(files.package)]);
  const signed = await Promise.all([readFile(files.manifest), readFile(files.signature)]).then(
    ([manifest, signature]) => ({ manifest, signature }), (error) => { if (mode === "strict") throw error; return null; });
  return settle(root, mode, () => build(mode, signed, lock, pkg, root));
}

export function readReleaseManifestSync(root = applicationRoot, { strict = false } = {}) {
  const mode = modeFor(root, strict);
  return settle(root, mode, () => {
    const files = locations(root);
    const lock = readFileSync(files.lock), pkg = readFileSync(files.package);
    let signed = null;
    try { signed = { manifest: readFileSync(files.manifest), signature: readFileSync(files.signature) }; }
    catch (error) { if (mode === "strict") throw error; }
    return build(mode, signed, lock, pkg, root);
  });
}

function build(mode, signed, lock, pkg, root) {
  if (mode === "strict") return parseAndVerify(signed.manifest, signed.signature, lock, pkg, root);
  let approved = null;
  try { approved = signed ? parseAndVerify(signed.manifest, signed.signature, lock, pkg, root, { source: false }) : null; } catch { approved = null; }
  return developmentRelease(root, lock, pkg, approved);
}

export async function verifyReleaseLicenses(release, root = applicationRoot) {
  const codex = release.licenses.codex;
  for (const [file, expected] of [[codex.licenseFile, codex.licenseSha256], [codex.noticeFile, codex.noticeSha256]]) {
    if (digest(await readFile(path.join(root, file))) !== expected) throw new Error(`${file} 与签名发布清单不一致`);
  }
  return true;
}
