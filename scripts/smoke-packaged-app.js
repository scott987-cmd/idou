import "../src/adopt-legacy-env.js";
import { _electron as electron } from "playwright";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { syntheticResponseStream } from "./fixtures/model-response.js";
import { rememberedServerFile } from "../src/desktop/remembered-server.js";
import { readReleaseManifest, verifyReleaseLicenses } from "../src/providers/release-manifest.js";
import { BUNDLE_ID, LEGACY_BUNDLE_ID } from "../src/install-names.js";

const run = promisify(execFile);

// The packaged app (npm run package:mac), started the way Finder starts it: with
// launchd's bare PATH, on which there is no `codex`, no node and no rg. Against a
// scripted model -- no paid call -- a coding task runs one command, and the run
// shows what the package is for:
// - it is the packaged app, under its own identity, reading its own resources;
// - it read the person's PATH from their login shell;
// - the turn ran at all, which here only the Codex inside the bundle can do, and
//   the task started, which needs the bundle's lark-cli to pass its checksum;
// - the Agent's shell reaches the bundle's own rg;
// - with no node on its PATH but the fallback, the Agent still runs the product's
//   document tool, on the Node the application carries, and the file it writes
//   is real;
// - with every built-in connector switched on, Codex starts each one on that
//   Node and completes its handshake -- a connector is required, so the task
//   could not start otherwise (2026-09-23 it could not: the packaged binary,
//   given a script, started the application again);
// - the built app's Electron has its RunAsNode, NODE_OPTIONS and --inspect
//   switches (fuses) off.
//
// Driving an app needs one of those: Playwright reaches the main process
// through --inspect. So the build is checked as it is, and then a copy of it
// with that one switch turned back on is what runs -- the same bundle in every
// other byte, signed again by the identity that signed the build. Not ad hoc:
// the app reads its Keychain item as it starts, and macOS asks a person before
// a differently signed program may -- a prompt nobody was there to answer, and
// a first run of this smoke that waited on it with no window.
const BUILT = path.resolve("dist/i豆.app");
if (!existsSync(path.join(BUILT, "Contents", "MacOS", "idou"))) throw new Error("Build the app first: npm run package:mac");
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const COMMAND = [
  `printf '%s\\n' "$PATH" | tr ':' '\\n' | grep -E '/(codex-path|agent-shell)$' | sed 's/^/AGENT_PATH_ENTRY=/'`,
  `tools=$(printf '%s\\n' "$PATH" | tr ':' '\\n' | grep '/agent-shell$' | head -n 1)`,
  `printf '# 打包版\\n\\n- 自带运行时\\n' > smoke.md`,
  `PATH="$tools:/usr/bin:/bin" node -e 'console.log("AGENT_NODE=" + (process.versions.electron ? "electron" : process.execPath))'`,
  `PATH="$tools:/usr/bin:/bin" node "$tools/../doc-tool.js" docx smoke.md smoke.docx && test -s smoke.docx && echo DOCX_BUILT`,
  // 标准 gives commands no network (modes.js); the application's own tools reach it by rule.
  "/usr/bin/curl -s -m 5 -o /dev/null https://example.com; echo SANDBOX_NETWORK_EXIT=$?",
  "echo PACKAGED_SMOKE_DONE",
].join("\n");
// The identity that signed the build, as this machine's keychain names it, or
// "-" for an ad hoc build.
async function buildIdentity(app) {
  const described = await run("/usr/bin/codesign", ["-dvv", app]);
  const authority = /^Authority=(.+)$/m.exec(`${described.stdout}${described.stderr}`)?.[1];
  if (!authority) return "-";
  const { stdout } = await run("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  const found = stdout.split("\n").find((line) => line.includes(`"${authority}"`))?.match(/\b([0-9A-F]{40})\b/)?.[1];
  if (!found) throw new Error(`The build was signed by ${authority}, which this machine's keychain does not hold`);
  return found;
}
// By its real path: the app reports where it runs from with /var resolved to
// /private/var, and the copy runs from in here.
const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-packaged-app-")));
const workspace = path.join(directory, "workspace"), evidence = path.resolve("docs/evidence");
await mkdir(workspace); await mkdir(evidence, { recursive: true });
const { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options, FuseState } = await import("@electron/fuses");
const FUSES_OFF = ["RunAsNode", "EnableNodeOptionsEnvironmentVariable", "EnableNodeCliInspectArguments"];
const APP = path.join(directory, "i豆.app");
const RESOURCES = path.join(APP, "Contents", "Resources");
const EXECUTABLE = path.join(APP, "Contents", "MacOS", "idou");
const BUNDLED_NODE = path.join(RESOURCES, "node", "bin", "node");
const sessions = new SessionRegistry(), session = sessions.issue({ tenantId: "synthetic", userId: "synthetic", deviceId: "synthetic" });
let app, requests = 0, commandOutput = null;

const call = (name, args) => {
  const item = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name, arguments: JSON.stringify(args), status: "completed" };
  const events = [{ type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};
const server = createModelGateway({ apiKey: "synthetic-no-paid-key", sessions, fetchImpl: async (_url, options) => {
  const body = JSON.parse(options.body); requests += 1;
  // A coding task plans first, read-only; the command writes files, so it
  // belongs to the turn after 开始做.
  if (requests === 1) return syntheticResponseStream("PACKAGED_PLAN_DONE 我来检查一遍工具。");
  if (requests === 2) return call("exec_command", { cmd: COMMAND, yield_time_ms: 30_000 });
  const output = body.input?.find((item) => item.call_id === "call_2" && /output/.test(item.type ?? ""))?.output;
  commandOutput = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return syntheticResponseStream("PACKAGED_APP_OK");
} });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionFile = path.join(directory, "session.json");
await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl: origin }), { mode: 0o600 });

try {
  const built = await getCurrentFuseWire(BUILT);
  assert.deepEqual(FUSES_OFF.filter((name) => built[FuseV1Options[name]] !== FuseState.DISABLE), [], "the built app's RunAsNode, NODE_OPTIONS and --inspect are off");
  await run("/usr/bin/ditto", [BUILT, APP]);
  await flipFuses(APP, { version: FuseVersion.V1, resetAdHocDarwinSignature: false, [FuseV1Options.EnableNodeCliInspectArguments]: true });
  await run("/usr/bin/codesign", ["--force", "--deep", "--timestamp=none", "--sign", await buildIdentity(BUILT), APP], { timeout: 10 * 60_000 });
  const release = await readReleaseManifest(path.join(RESOURCES, "app"), { strict: true });
  await verifyReleaseLicenses(release, path.join(RESOURCES, "app"));
  // The licenses ship with what they cover: the project's, the npm packages', and Electron's and Chromium's.
  for (const file of [path.join(RESOURCES, "app", "LICENSE"), path.join(RESOURCES, "app", "NOTICE"), path.join(RESOURCES, "app", "THIRD_PARTY_NOTICES.md"),
    path.join(RESOURCES, "LICENSE.electron.txt"), path.join(RESOURCES, "LICENSES.chromium.html")]) {
    assert.ok((await readFile(file, "utf8")).trim().length > 100, `${path.relative(RESOURCES, file)} ships with the app`);
  }
  const marker = JSON.parse(await readFile(path.join(RESOURCES, "idou-build.json"), "utf8"));
  assert.deepEqual(marker.fusesOff, FUSES_OFF, "the build records which switches it turned off");
  assert.ok(marker.node && Object.keys(marker.nodeFiles ?? {}).includes("bin/node"), "and the Node it carries");
  assert.deepEqual({ nodePty: marker.terminalRuntime?.["node-pty"], xterm: marker.terminalRuntime?.["@xterm/xterm"], fit: marker.terminalRuntime?.["@xterm/addon-fit"] },
    { nodePty: "1.1.0", xterm: "6.0.0", fit: "0.11.0" });
  // A build made for one organisation carries its control plane's address
  // (IDOU_PACKAGE_SERVER_URL); when it does, it must be one the desktop
  // accepts and the one the build recorded. This run's explicit setting wins.
  const deployment = path.join(RESOURCES, "app", "deployment.json");
  const packagedServer = existsSync(deployment) ? await rememberedServerFile(deployment) : null;
  assert.equal(packagedServer, marker.serverUrl ?? null, "the packaged address is the one the build recorded, and a real control plane");
  const terminalHelper = path.join(RESOURCES, "app", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
  assert.ok((await stat(terminalHelper)).mode & 0o100, "the packaged PTY helper must remain executable");
  const identifier = (await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", path.join(BUILT, "Contents", "Info.plist")])).stdout.trim();
  assert.ok([BUNDLE_ID, LEGACY_BUNDLE_ID].includes(identifier) && identifier === marker.identifier, `the package must carry its own identity, not Electron's: ${identifier}`);
  const signature = await run("/usr/bin/codesign", ["-d", "-r-", BUILT]);
  const requirement = (`${signature.stdout}${signature.stderr}`.match(/designated => (.+)/)?.[1] ?? "").trim();

  // Switched on as a person would in 技能中心 -> 连接器.
  await mkdir(path.join(directory, "data"), { recursive: true });
  await writeFile(path.join(directory, "data", "builtin-connectors.json"), JSON.stringify({ enabled: ["browser", "computer", "web-fetch"] }), { mode: 0o600 });
  app = await electron.launch({ executablePath: EXECUTABLE, args: [], timeout: 60_000,
    env: { HOME: os.homedir(), USER: os.userInfo().username, SHELL: process.env.SHELL || "/bin/zsh", PATH: BARE_PATH, TMPDIR: os.tmpdir(), LANG: process.env.LANG || "en_US.UTF-8",
      IDOU_DESKTOP_DATA_DIR: path.join(directory, "data"), IDOU_SESSION_FILE: sessionFile, IDOU_SERVER_URL: origin } });
  const page = await app.firstWindow(); page.setDefaultTimeout(60_000);
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#new-task").waitFor();
  // Read once the person can act: by then the PATH must be the login shell's.
  const info = await app.evaluate(({ app: electronApp }) => ({ packaged: electronApp.isPackaged, resources: process.resourcesPath, path: process.env.PATH }));
  assert.equal(info.packaged, true, "this must be the packaged app, not a development Electron");
  assert.equal(info.resources, RESOURCES, "it must read its own resources");
  assert.notEqual(info.path, BARE_PATH, "the login shell's PATH was never read");
  for (const entry of BARE_PATH.split(":")) assert.ok(info.path.split(":").includes(entry), `launchd's ${entry} must stay on the PATH`);
  await page.locator('[data-section="coding"]').click();
  await app.evaluate(({ dialog }, cwd) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [cwd] }); }, workspace);
  await page.locator("#pick-workspace").click();
  await page.locator("#project-path").filter({ hasText: workspace }).waitFor();
  await page.locator("#prompt").fill("检查一下工具。"); await page.locator("#send").click();
  await page.locator("#messages").filter({ hasText: "PACKAGED_PLAN_DONE" }).waitFor({ timeout: 120_000 });
  await page.locator("#workbench-terminal").click();
  await page.locator("#terminal-status").filter({ hasText: "运行中" }).waitFor();
  await page.locator("#terminal-screen .xterm-helper-textarea").focus();
  await page.keyboard.type("/usr/bin/printf 'PACKAGED_TERMINAL_OK\\n'"); await page.keyboard.press("Enter");
  await page.locator("#terminal-screen").filter({ hasText: "PACKAGED_TERMINAL_OK" }).waitFor();
  await page.locator("#start-building").click();
  await page.waitForFunction(() => !["已完成", "执行失败"].includes(document.querySelector("#task-status").textContent), null, { polling: 100 });
  await page.locator("#task-status").filter({ hasText: /^(已完成|执行失败)$/ }).waitFor({ timeout: 120_000 });
  assert.equal(await page.locator("#task-status").innerText(), "已完成", await page.locator("#error-banner").innerText());
  assert.equal(requests, 3, "the plan, then the command and the answer");
  const output = commandOutput ?? "";
  assert.match(output, /PACKAGED_SMOKE_DONE/, "the Agent's command must have run to its end");
  const entries = [...output.matchAll(/^AGENT_PATH_ENTRY=(.+)$/gm)].map((match) => match[1].trim());
  assert.ok(entries.includes(path.join(RESOURCES, "app", "bin", "agent-shell")), `the product's shell tools must be on the Agent's PATH: ${JSON.stringify(entries)}`);
  assert.ok(entries.includes(path.join(RESOURCES, "codex", "codex-path")), `the bundle's own rg must be on the Agent's PATH: ${JSON.stringify(entries)}`);
  assert.equal(/^AGENT_NODE=(.+)$/m.exec(output)?.[1], BUNDLED_NODE, "with no node of its own, the Agent's node must be the Node the application carries");
  assert.match(output, /^DOCX_BUILT$/m, "the document tool must run on that Node");
  assert.equal((await readFile(path.join(workspace, "smoke.docx"))).subarray(0, 2).toString("latin1"), "PK", "and write a real .docx");
  assert.notEqual(/^SANDBOX_NETWORK_EXIT=(\d+)$/m.exec(output)?.[1] ?? "0", "0", "a command of 标准 reaches nothing on the network");
  // The rules that let the bundle's own tools reach it, written before Codex started (tool-rules.js).
  const rulesFile = (await readdir(path.join(directory, "data"), { recursive: true })).find((entry) => entry.endsWith(path.join("codex", "rules", "idou.rules")));
  assert.ok(rulesFile, "the task's Codex home has the application's rules");
  const rules = await readFile(path.join(directory, "data", rulesFile), "utf8");
  const allowed = [...rules.matchAll(/prefix_rule\(pattern = \[("[^"]+")\], decision = "allow"\)/g)].map((match) => JSON.parse(match[1]));
  assert.ok(allowed.includes(path.join(RESOURCES, "lark-cli", "darwin-arm64", "lark-cli")), `the bundle's Feishu CLI, by its own path: ${JSON.stringify(allowed)}`);
  const launcher = allowed.find((entry) => entry.endsWith("/idou-agent"));
  assert.ok(launcher, `and the agent tool's launcher: ${JSON.stringify(allowed)}`);
  const launches = await readFile(launcher, "utf8");
  assert.ok(launches.includes(`exec '${BUNDLED_NODE}' '${path.join(RESOURCES, "app", "bin", "agent.js")}'`), `which runs the bundle's agent.js on the Node it carries: ${launches}`);
  assert.doesNotMatch(launches, /ELECTRON_RUN_AS_NODE/, "and asks nothing of Electron");
  assert.match(await page.locator("#messages").innerText(), /PACKAGED_APP_OK/);
  await page.screenshot({ path: path.join(evidence, "desktop-packaged-app.png"), scale: "css" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, packaged: true, identifier, packagedServer, designatedRequirement: requirement, releaseId: release.releaseId,
    resources: path.relative(process.cwd(), info.resources), loginShellPathEntries: info.path.split(":").length, launchdPathEntries: BARE_PATH.split(":").length,
    agentPathEntries: entries.map((entry) => path.relative(APP, entry)), agentNode: path.relative(APP, BUNDLED_NODE), fusesOff: FUSES_OFF, humanPty: true, docxBuilt: true, modelRequests: requests, paidCalls: 0 }));
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => null);
    console.error(JSON.stringify({ reason: String(error?.message ?? error).split("\n")[0], requests, commandOutput: String(commandOutput ?? "").slice(0, 1200),
      status: await page?.locator("#task-status").innerText().catch(() => "unavailable"), error: await page?.locator("#error-banner").innerText().catch(() => "unavailable") }));
  }
  throw error;
} finally {
  // An app stuck before its window (a prompt, a hung start) never answers a
  // close: give it ten seconds, then end it, so the smoke itself ends.
  const child = app?.process();
  await Promise.race([app?.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]).catch(() => {});
  if (child && child.exitCode === null) child.kill("SIGKILL");
  sessions.revoke(session.token); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
