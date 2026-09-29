import { resolveFeishuRuntime } from "../../src/providers/feishu/bundled-runtime.js";

// The binary a stub runner stands in for. The provider still resolves a runtime
// before every call (bundled-runtime.js); outside the installed app an explicit
// binary is a development override, which only has to exist -- and a stub
// runner never executes it. So a test of the provider's own logic does not need
// the 135 MB lark-cli that is not in the repository.
export const STUB_CLI = process.execPath;

// A test that runs the real bundled lark-cli -- its wire shapes, its sidecar,
// its skills -- skips where it has not been built, and says how to build it.
export async function requireBundledCli(t) {
  try {
    await resolveFeishuRuntime({});
    return true;
  } catch (error) {
    t.skip(`需要内置的 lark-cli（${String(error?.message ?? error).slice(0, 80)}）：按 upstreams.lock.json 构建，npm run bundle:feishu`);
    return false;
  }
}
