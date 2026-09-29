import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFeishuProvider } from "../providers/feishu/provider-registry.js";
import { runProcess } from "../providers/process-runner.js";
import { resolveCodexRuntime } from "../providers/codex/bundled-codex.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function runDoctor(config) {
  const checks = [];
  const lock = JSON.parse(await readFile(path.join(root, "upstreams.lock.json"), "utf8"));

  try {
    const codex = await resolveCodexRuntime(config.codex.binary);
    const result = await runProcess(codex.binary, ["--version"]);
    const version = result.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] || result.stdout.trim();
    checks.push({
      name: "codex-runtime",
      ok: result.code === 0,
      detail: `${codex.source}: ${version} (validated ${lock.codex.version})`,
      version,
    });
  } catch (error) {
    checks.push({ name: "codex-runtime", ok: false, detail: error.message });
  }

  try {
    // The deployment the configuration names, its own runtime and its own pin.
    const deployment = resolveFeishuProvider(config.feishu.provider);
    const pinned = lock[deployment.runtime.lock];
    const runtime = await deployment.runtime.resolve(config.feishu);
    const provider = deployment.client.create(config.feishu);
    const [version, skills] = await Promise.all([provider.version(), provider.listSkills()]);
    checks.push({
      name: "feishu-provider",
      ok: skills.length > 0 && version === pinned.version,
      detail: `${runtime.source}: ${provider.id} ${version}, ${skills.length} embedded skills (validated ${pinned.version})`,
      binary: runtime.binary,
      version,
      skillCount: skills.length,
    });
  } catch (error) {
    checks.push({ name: "feishu-provider", ok: false, detail: error.message });
  }

  return { ok: checks.every((check) => check.ok), checks };
}
