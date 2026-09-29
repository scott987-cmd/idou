import { resolveFeishuRuntime } from "../src/providers/feishu/bundled-runtime.js";
import { readReleaseManifest, verifyReleaseLicenses } from "../src/providers/release-manifest.js";
const release = await readReleaseManifest(undefined, { strict: true });
await verifyReleaseLicenses(release);
const runtime = await resolveFeishuRuntime();
console.log(`Verified release ${release.releaseId}, Codex notices, and bundled Feishu CLI ${runtime.version}: ${runtime.binary}`);
