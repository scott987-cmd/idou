import { applicationRoot, readReleaseManifest } from "../../src/providers/release-manifest.js";

// What an installed app or a server's release directory does is held to the
// signed release, so a test of it only means something against the source that
// release was signed from. In a checkout that has moved on since -- anyone
// working on the code (release-manifest.js) -- such a test is skipped, saying
// why; `npm run check:release`, which every release passes, runs it.
export async function requireSignedSource(t) {
  try {
    await readReleaseManifest(applicationRoot, { strict: true });
    return true;
  } catch {
    t.skip("源码在最近一次签名之后改过；这条测的是签名发布本身，npm run check:release 时运行");
    return false;
  }
}
