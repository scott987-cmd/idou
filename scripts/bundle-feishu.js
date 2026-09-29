import { mkdir, readFile, copyFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { applicationRoot, bundledBinaryPath, verifyBinary } from "../src/providers/feishu/bundled-runtime.js";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";

const execute = promisify(execFile);

// Build-time only: compile the exact reviewed upstream commit with its
// credential-isolating authsidecar tag. No config, credentials or caches enter
// the application bundle.
async function main() {
  const source = process.argv[2];
  if (!source || process.argv.length !== 3 || !path.isAbsolute(source)) {
    throw new Error("Usage: npm run bundle:feishu -- /absolute/path/to/larksuite-cli-checkout");
  }
  const lock = JSON.parse(await readFile(path.join(applicationRoot, "upstreams.lock.json"), "utf8"));
  const goMod = await readFile(path.join(source, "go.mod"), "utf8");
  if (!/^module github\.com\/larksuite\/cli$/m.test(goMod)) throw new Error("Expected the official github.com/larksuite/cli source checkout");
  const { stdout: commit } = await execute("git", ["rev-parse", "HEAD"], { cwd: source });
  if (commit.trim() !== lock.feishu.inspectedCommit) throw new Error(`Expected reviewed lark-cli commit ${lock.feishu.inspectedCommit}`);
  const { stdout: dirty } = await execute("git", ["status", "--porcelain"], { cwd: source });
  if (dirty.trim()) throw new Error("Refusing to bundle a modified lark-cli checkout");
  const { stdout: goVersion } = await execute("go", ["env", "GOVERSION"]);
  if (goVersion.trim() !== lock.feishu.goVersion) throw new Error(`Expected Go toolchain ${lock.feishu.goVersion}`);
  const target = `${process.platform}-${process.arch}`, artifact = lock.feishu.bundledArtifacts?.[target];
  if (!artifact || JSON.stringify(lock.feishu.buildTags) !== JSON.stringify(["authsidecar"])) throw new Error(`No reviewed authsidecar artifact checksum for ${target}`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "idou-lark-build-"));
  const built = path.join(temporary, path.basename(bundledBinaryPath()));
  try {
    const ldflags = `-s -w -X github.com/larksuite/cli/internal/build.Version=${lock.feishu.version} -X github.com/larksuite/cli/internal/build.Date=${lock.feishu.buildDate}`;
    await execute("go", ["build", "-buildvcs=false", "-trimpath", "-tags", lock.feishu.buildTags.join(","), "-ldflags", ldflags, "-o", built, "."],
      { cwd: source, env: { ...process.env, CGO_ENABLED: "0", GOOS: process.platform === "win32" ? "windows" : process.platform, GOARCH: process.arch === "x64" ? "amd64" : process.arch }, maxBuffer: 8 * 1024 * 1024 });
    await verifyBinary(built, artifact.sha256);
    const provider = new SaasFeishuCliProvider({ binary: built, environment: () => ({ LARKSUITE_CLI_AUTH_PROXY: "http://127.0.0.1:9", LARKSUITE_CLI_PROXY_KEY: "build-probe", LARKSUITE_CLI_APP_ID: "cli_build_probe", LARKSUITE_CLI_BRAND: "feishu", LARKSUITE_CLI_REMOTE_META: "off", LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1", LARKSUITE_CLI_CONFIG_DIR: temporary }) });
    if (await provider.version() !== lock.feishu.version) throw new Error("Native CLI version does not match the pin");
    const skills = await provider.listSkills();
    if (!skills.length || !(await provider.readSkill(skills[0].name)).includes("name:")) throw new Error("Embedded skill contract failed");
    const destination = bundledBinaryPath();
    await mkdir(path.dirname(destination), { recursive: true }); await copyFile(built, destination); await chmod(destination, 0o755);
    const license = await readFile(path.join(source, "LICENSE"), "utf8"); if (!license.trim()) throw new Error("Upstream LICENSE is empty");
    await copyFile(path.join(source, "LICENSE"), path.join(path.dirname(destination), "LICENSE"));
    const bytes = await verifyBinary(destination, artifact.sha256);
    console.log(JSON.stringify({ binary: destination, version: lock.feishu.version, commit: lock.feishu.inspectedCommit, goVersion: lock.feishu.goVersion, buildTags: lock.feishu.buildTags, target, bytes, skillCount: skills.length }, null, 2));
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
