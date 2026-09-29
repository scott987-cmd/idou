import "../src/adopt-legacy-env.js";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_KEY_ID, applicationSourceDigest, readReleaseManifest, verifyReleaseLicenses } from "../src/providers/release-manifest.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const value = name => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1]; };
// One --sandbox-record per platform the release approves an image for.
const values = name => process.argv.flatMap((argument, at) => argument === name ? [process.argv[at + 1]] : []);
const releaseId = value("--release-id");
const recordFiles = values("--sandbox-record");
const keyFile = process.env.IDOU_RELEASE_SIGNING_KEY_FILE;
if (!/^[A-Za-z0-9._-]{1,80}$/.test(releaseId ?? "")) throw new Error("Use --release-id with a stable release identifier");
if (!recordFiles.length || recordFiles.some(file => !file || !path.isAbsolute(file))) throw new Error("Use --sandbox-record with an absolute, reviewed build-record path, once per platform");
if (!keyFile || !path.isAbsolute(keyFile)) throw new Error("IDOU_RELEASE_SIGNING_KEY_FILE must name the server-only Ed25519 private key by absolute path");

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const [lockBytes, packageBytes, packageLockBytes, licenseBytes, noticeBytes, privateBytes, ...recordBytes] = await Promise.all([
  readFile(path.join(root, "upstreams.lock.json")), readFile(path.join(root, "package.json")), readFile(path.join(root, "package-lock.json")),
  readFile(path.join(root, "third_party", "codex", "LICENSE")), readFile(path.join(root, "third_party", "codex", "NOTICE")),
  readFile(keyFile), ...recordFiles.map(file => readFile(file)),
]);
const upstreams = JSON.parse(lockBytes), pkg = JSON.parse(packageBytes), records = recordBytes.map(bytes => JSON.parse(bytes));
const sandboxImages = {};
for (const record of records) {
  if (!/^linux-(arm64|x64)$/.test(record.platform ?? "") || Object.hasOwn(sandboxImages, record.platform) ||
      record.baseImage !== upstreams.sandbox.baseImage || record.codex?.version !== upstreams.codex.version ||
      JSON.stringify(record.codex.files) !== JSON.stringify(upstreams.codex.vendorArtifacts[record.platform]?.files) ||
      record.larkCli?.version !== upstreams.feishu.version || record.larkCli?.sha256 !== upstreams.feishu.bundledArtifacts[record.platform]?.sha256 ||
      !new RegExp(`^${upstreams.sandbox.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@sha256:[a-f0-9]{64}$`).test(record.digest ?? "") ||
      !/^sha256:[a-f0-9]{64}$/.test(record.id ?? "") || (record.classicId !== undefined && !/^sha256:[a-f0-9]{64}$/.test(record.classicId)) ||
      (record.releaseUpstreamsSha256 !== undefined && record.releaseUpstreamsSha256 !== sha(lockBytes))) {
    throw new Error(`Sandbox build record ${record.platform ?? "(no platform)"} does not match the reviewed upstream lock, or names a platform twice`);
  }
  // The classic-store ID rides along when the build recorded it: the name a
  // server whose Docker loaded the image, rather than pulled it, can pin.
  sandboxImages[record.platform] = { reference: record.digest, id: record.id, baseImage: record.baseImage, ...(record.classicId ? { classicId: record.classicId } : {}) };
}

const privateKey = createPrivateKey(privateBytes);
const publicDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
if (sha(publicDer) !== RELEASE_KEY_ID) throw new Error("Release private key does not match the product trust root");
const manifest = {
  schemaVersion: 1, releaseId, createdAt: new Date().toISOString(), keyId: RELEASE_KEY_ID,
  application: { name: pkg.name, version: pkg.version, sourceSha256: applicationSourceDigest(root), packageLockSha256: sha(packageLockBytes),
    adapterContracts: { codex: upstreams.codex.integrationBoundary, feishu: upstreams.feishu.integrationBoundary } },
  upstreamsSha256: sha(lockBytes), upstreams,
  licenses: { codex: { spdx: "Apache-2.0", source: `https://github.com/openai/codex/blob/rust-v${upstreams.codex.version}`,
    licenseFile: "third_party/codex/LICENSE", licenseSha256: sha(licenseBytes),
    noticeFile: "third_party/codex/NOTICE", noticeSha256: sha(noticeBytes) } },
  sandboxImages,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
const signature = { schemaVersion: 1, keyId: RELEASE_KEY_ID, algorithm: "Ed25519", signature: sign(null, manifestBytes, privateKey).toString("base64") };
const signatureBytes = Buffer.from(`${JSON.stringify(signature, null, 2)}\n`);
const release = path.join(root, "release"), history = path.join(release, "history", releaseId);
await mkdir(history, { recursive: true });
const historical = [path.join(history, "manifest.json"), path.join(history, "manifest.sig.json")];
if ((await Promise.all(historical.map(file => access(file).then(() => true, () => false)))).some(Boolean)) throw new Error(`Release history ${releaseId} already exists and is immutable`);
await writeFile(historical[0], manifestBytes, { mode: 0o644, flag: "wx" });
await writeFile(historical[1], signatureBytes, { mode: 0o644, flag: "wx" });
await writeFile(path.join(release, "manifest.json"), manifestBytes, { mode: 0o644 });
await writeFile(path.join(release, "manifest.sig.json"), signatureBytes, { mode: 0o644 });
const verified = await readReleaseManifest(root, { strict: true });
await verifyReleaseLicenses(verified, root);
console.log(JSON.stringify({ releaseId, keyId: RELEASE_KEY_ID, manifestSha256: sha(manifestBytes), sandbox: sandboxImages }, null, 2));
