// Trusted static worker. Application scripts are served as bytes, never imported,
// evaluated, spawned or extracted. Docker provides the server-side OS boundary.
import { appPackage, MAX_APP_PACKAGE_BYTES } from "./archive.js";
import { appId, appDigest, appHash } from "./manifest.js";
import { readFrames, writeFrame } from "./runtime-frames.js";

let loaded = false, files = new Map(), expiresAt = 0;
let timer = setTimeout(() => process.exit(1), 30000);
process.on("SIGTERM", () => process.exit(0));
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === "object" && Object.keys(value).every(key => keys.includes(key));
try {
  for await (const value of readFrames(process.stdin, () => loaded ? 4096 : 4 * Math.ceil(MAX_APP_PACKAGE_BYTES / 3) + 4096)) {
    if (!loaded) {
      if (!exact(value, ["kind", "protocol", "digest", "sha256", "expiresAt", "package"]) || value.kind !== "load" || value.protocol !== 1 || !appDigest(value.digest) || !appDigest(value.sha256) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 300000 || typeof value.package !== "string") throw new Error();
      const bytes = Buffer.from(value.package, "base64");
      if (bytes.length > MAX_APP_PACKAGE_BYTES || bytes.toString("base64") !== value.package || appHash(bytes) !== value.sha256) throw new Error();
      const pkg = appPackage(bytes, value.digest); expiresAt = value.expiresAt;
      files = new Map(pkg.blobs.map(blob => [blob.path, Buffer.from(blob.base64, "base64")]));
      loaded = true; clearTimeout(timer); timer = setTimeout(() => process.exit(0), Math.max(0, expiresAt - Date.now()));
      await writeFrame(process.stdout, { kind: "ready", protocol: 1, digest: pkg.digest, sha256: pkg.sha256, manifest: pkg.manifest });
    } else {
      if (Date.now() >= expiresAt || !exact(value, ["kind", "id", "path"]) || value.kind !== "read" || !appId(value.id) || typeof value.path !== "string" || value.path.length > 200) throw new Error();
      const bytes = files.get(value.path);
      await writeFrame(process.stdout, bytes ? { kind: "file", id: value.id, path: value.path, base64: bytes.toString("base64") } : { kind: "missing", id: value.id });
    }
  }
} catch {
  // Do not interpolate the package, exception, path, environment or stderr.
  await writeFrame(process.stdout, { kind: "error", code: "runtime_input_rejected" }).catch(() => {}); process.exitCode = 1;
} finally { clearTimeout(timer); files.clear(); }
