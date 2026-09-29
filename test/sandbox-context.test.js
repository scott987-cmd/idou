// A sandbox image is built from a context of its own, holding exactly what
// sandbox/Dockerfile copies (scripts/sandbox-context.js). Built from the
// repository, BuildKit kept the previous build's files by path and reused the
// ones whose size and modification time had not changed: Codex 0.157.0 for
// linux-x64 came up with 26 files of 0.155.0, refused by the image's own
// checksums (2026-09-26). And the supply-chain smoke's hand-kept copy of the
// list had fallen two files behind the Dockerfile.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DOCKERFILE, dockerfileSources, prepareContext } from "../scripts/sandbox-context.js";

const root = path.resolve(".");

async function filesUnder(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await filesUnder(directory, name));
    else found.push(name);
  }
  return found.sort();
}
const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");

// The build context is made from the Linux binaries in resources/, which are
// built for the sandbox and not kept in the repository. Where they have not
// been built, the tests that read them skip and say so.
async function requireSandboxInputs(t) {
  for (const platform of ["linux-arm64", "linux-x64"]) {
    try { await stat(path.join(root, "resources", "lark-cli", platform, "lark-cli")); await stat(path.join(root, "resources", "codex", platform)); }
    catch { t.skip(`需要 resources/ 里 ${platform} 的 lark-cli 和 Codex（沙箱镜像的构建输入，不在仓库里）：见 docs/upgrading-upstreams.md`); return false; }
  }
  return true;
}

// The image holds a named list of this product's files, not src/. A file on
// the list that imports one left off it builds fine and fails the first real
// run with "Cannot find module". Every relative import of every script the image
// copies has to be copied too, and nothing may need a package from node_modules.
test("everything the image's own scripts import is in the image", async () => {
  const text = await readFile(path.join(root, DOCKERFILE), "utf8");
  const copied = new Set();
  for (const source of dockerfileSources(text, "linux-x64").filter((entry) => !entry.startsWith("resources/"))) {
    const info = await stat(path.join(root, source));
    for (const file of info.isDirectory() ? (await filesUnder(path.join(root, source))).map((name) => path.posix.join(source, name)) : [source]) copied.add(path.posix.normalize(file));
  }
  const scripts = [...copied].filter((file) => /\.(?:c|m)?js$/.test(file));
  assert.ok(scripts.includes("bin/sandbox/run.js") && scripts.includes("src/providers/feishu/cli-sidecar.js"), "the list is the one the image is built from");
  const missing = [];
  for (const file of scripts) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const [, specifier] of source.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^import\s*["']([^"']+)["']/gm).map((m) => [m[0], m[1] ?? m[2] ?? m[3]])) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) { missing.push(`${file} imports the package ${specifier}, and the image has no node_modules`); continue; }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (!copied.has(target)) missing.push(`${file} imports ${target}, which the image does not copy`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the context is what the Dockerfile copies, read from its COPY lines", async (t) => {
  if (!(await requireSandboxInputs(t))) return;
  const text = await readFile(path.join(root, DOCKERFILE), "utf8");
  for (const platform of ["linux-arm64", "linux-x64"]) {
    const sources = dockerfileSources(text, platform);
    for (const wanted of [`resources/codex/${platform}/`, `resources/lark-cli/${platform}/lark-cli`, `resources/lark-cli/${platform}/LICENSE`,
      "third_party/codex/LICENSE", "third_party/codex/NOTICE", "bin/sandbox/", "src/providers/feishu/cli-sidecar.js",
      "src/providers/feishu/openapi.js", "src/providers/feishu/saas-deployment.js", "src/control-plane/client-session.js", "src/providers/codex/model-catalog.json"]) {
      assert.ok(sources.includes(wanted), `${platform}: ${wanted} is copied`);
    }
    for (const source of sources) await stat(path.join(root, source));
  }
  // What it cannot follow, it refuses rather than guesses at.
  assert.throws(() => dockerfileSources("FROM x\nADD https://example.com/a /a\n", "linux-x64"), /ADD/);
  assert.throws(() => dockerfileSources("FROM x\nCOPY --from=build /a /a\n", "linux-x64"), /cannot follow/);
  assert.throws(() => dockerfileSources("FROM x\nCOPY ../secret /a\n", "linux-x64"), /outside the context/);
  assert.throws(() => dockerfileSources("FROM x\nCOPY ${OTHER}/a /a\n", "linux-x64"), /outside the context/);
  assert.deepEqual(dockerfileSources("FROM x\nCOPY a \\\n  b /d/\nCOPY --chmod=0755 c /e\n", "linux-x64"), ["a", "b", "c"]);
});

test("each build gets a new context directory holding exactly those files", { timeout: 60_000 }, async (t) => {
  if (!(await requireSandboxInputs(t))) return;
  const parent = await mkdtemp(path.join(os.tmpdir(), "idou-sandbox-context-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const first = await prepareContext(root, "linux-arm64", { parent });
  const second = await prepareContext(root, "linux-arm64", { parent });
  assert.notEqual(first, second, "never the same path twice: BuildKit keeps what it synced by path");
  assert.equal(path.dirname(first), parent);

  const text = await readFile(path.join(root, DOCKERFILE), "utf8");
  const expected = [DOCKERFILE];
  for (const source of dockerfileSources(text, "linux-arm64")) {
    const info = await stat(path.join(root, source));
    if (info.isDirectory()) expected.push(...(await filesUnder(path.join(root, source))).filter((name) => !name.endsWith(".DS_Store")).map((name) => path.posix.join(source, name)));
    else expected.push(source);
  }
  const present = await filesUnder(first);
  assert.deepEqual(present, [...new Set(expected)].sort(), "exactly what the Dockerfile copies, and nothing else");
  for (const name of [DOCKERFILE, "resources/lark-cli/linux-arm64/lark-cli", "src/providers/feishu/cli-sidecar.js"]) {
    assert.equal(await digest(path.join(first, name)), await digest(path.join(root, name)), `${name} is the repository's bytes`);
  }
});

test("the image build and the supply-chain smoke both build from such a context", async () => {
  const build = await readFile(path.join(root, "scripts", "build-sandbox-image.js"), "utf8");
  assert.match(build, /const context = await prepareContext\(root, platform\)/);
  assert.match(build, /runProcess\(buildCommand\[0\], \[\.\.\.buildCommand\.slice\(1\), \.\.\.args\], \{ cwd: context,/);
  const smoke = await readFile(path.join(root, "scripts", "smoke-sandbox-supply-live.js"), "utf8");
  assert.match(smoke, /prepareContext\(root, platform, \{ parent: scratchRoot, mutate \}\)/);
  assert.doesNotMatch(smoke, /const CONTEXT = \[/, "no second list of what the Dockerfile copies");
});
