import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundledCodexBinary, resolveCodexRuntime } from "../src/providers/codex/bundled-codex.js";
import { CodexAppServerClient } from "../src/providers/codex/app-server-client.js";
import { CodexExtensions } from "../src/skills/codex-extensions.js";
import { requireSignedSource } from "./helpers/signed-release.js";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const FILES = { "bin/codex": "#!/bin/sh\necho 'codex-cli 0.147.0'\n", "codex-path/rg": "rg", "codex-package.json": "{}" };
const platform = process.platform, arch = process.arch;
const pins = { codex: { version: "0.147.0", vendorArtifacts: { [`${platform}-${arch}`]: {
  files: Object.fromEntries(Object.entries(FILES).map(([name, content]) => [name, sha(content)])),
} } } };

// A packaged app's Resources directory, holding the bundled Codex.
async function packaged(t, files = FILES) {
  const resourcesRoot = await mkdtemp(path.join(os.tmpdir(), "idou-resources-"));
  t.after(() => rm(resourcesRoot, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(resourcesRoot, "codex", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { mode: 0o755 });
  }
  return { resourcesRoot, binary: path.join(resourcesRoot, "codex", "bin", "codex") };
}

test("a packaged app finds its own Codex where it put it; anywhere else there is none", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-bundled-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(bundledCodexBinary(root), null, "nothing bundled yet");
  await mkdir(path.join(root, "codex", "bin"), { recursive: true });
  await writeFile(path.join(root, "codex", "bin", "codex"), "");
  assert.equal(bundledCodexBinary(root), path.join(root, "codex", "bin", "codex"));
  // A plain node process has no resources path: it is not a packaged app.
  assert.equal(bundledCodexBinary(), null);
});

test("a development run uses whatever Codex was configured, as before", async () => {
  assert.deepEqual(await resolveCodexRuntime("/opt/dev/codex", { resourcesRoot: null }), { binary: "/opt/dev/codex", source: "development", version: null });
  assert.equal((await resolveCodexRuntime(undefined, { resourcesRoot: null })).binary, "codex");
});

test("a packaged app runs its bundled Codex once every file matches the lock", async (t) => {
  const { resourcesRoot, binary } = await packaged(t);
  assert.deepEqual(await resolveCodexRuntime(binary, { resourcesRoot, pins }), { binary, source: "bundled", version: "0.147.0" });
  assert.equal((await resolveCodexRuntime(undefined, { resourcesRoot, pins })).binary, binary, "unconfigured means the bundled one");
});

// IDOU_CODEX_BIN is honoured by the config loader in every build, so this is
// the check that keeps it a development tool.
test("a packaged app refuses any other Codex, even one that exists", async (t) => {
  const { resourcesRoot } = await packaged(t);
  await assert.rejects(resolveCodexRuntime("/usr/local/bin/codex", { resourcesRoot, pins }), /只运行内置的 Codex/);
  await assert.rejects(resolveCodexRuntime("codex", { resourcesRoot, pins }), /只运行内置的 Codex/);
});

test("a same-version forged Codex is refused before it is launched", async (t) => {
  const { resourcesRoot, binary } = await packaged(t, { ...FILES, "bin/codex": "#!/bin/sh\necho 'codex-cli 0.147.0' # forged\n" });
  await assert.rejects(resolveCodexRuntime(binary, { resourcesRoot, pins }), /与发布清单不一致（bin\/codex 的摘要与发布清单不符）/);
});

test("a replaced helper, or a file added beside Codex, is refused too", async (t) => {
  const helper = await packaged(t, { ...FILES, "codex-path/rg": "forged rg" });
  await assert.rejects(resolveCodexRuntime(helper.binary, { resourcesRoot: helper.resourcesRoot, pins }), /codex-path\/rg/);
  const added = await packaged(t, { ...FILES, "bin/libpreload.dylib": "not reviewed" });
  await assert.rejects(resolveCodexRuntime(added.binary, { resourcesRoot: added.resourcesRoot, pins }), /bin\/libpreload\.dylib/);
});

test("a packaged app without its Codex, or on a platform nobody reviewed, says so", async (t) => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "idou-resources-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await assert.rejects(resolveCodexRuntime(undefined, { resourcesRoot: empty, pins }), /内置的 Codex 缺失/);
  const { resourcesRoot, binary } = await packaged(t);
  await assert.rejects(resolveCodexRuntime(binary, { resourcesRoot, pins: { codex: { version: "0.147.0", vendorArtifacts: {} } } }), /没有为 .* 审核过的 Codex/);
});

// The launch sites themselves ask, so no caller can reach a spawn with an
// unverified binary. Pretending to be a packaged app is two properties on
// `process`; the forged tree below does not match the real lock.
test("every place that launches Codex refuses a forged one before spawning it", async (t) => {
  // An installed app, simulated: held to the signed release.
  if (!(await requireSignedSource(t))) return;
  const { resourcesRoot, binary } = await packaged(t);
  const saved = { resourcesPath: process.resourcesPath, defaultApp: process.defaultApp };
  process.resourcesPath = resourcesRoot;
  delete process.defaultApp;
  t.after(() => {
    if (saved.resourcesPath === undefined) delete process.resourcesPath; else process.resourcesPath = saved.resourcesPath;
    if (saved.defaultApp !== undefined) process.defaultApp = saved.defaultApp;
  });
  const client = new CodexAppServerClient({ binary });
  await assert.rejects(client.start(), /与发布清单不一致/);
  assert.equal(client.child, null, "nothing was spawned");
  const extensions = new CodexExtensions({ binary, writeConfig: async () => ({ status: "ok" }) });
  await assert.rejects(extensions.listMcp(), /与发布清单不一致/);
  const override = new CodexAppServerClient({ binary: "/usr/local/bin/codex" });
  await assert.rejects(override.start(), /只运行内置的 Codex/);
  assert.equal(override.child, null);
});
