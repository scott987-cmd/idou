import "../src/adopt-legacy-env.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { createTaskRuntime } from "../src/application/task-runtime.js";
import { TaskService } from "../src/application/task-service.js";
import { TaskStore } from "../src/application/task-store.js";
import { codingEvalTasks, materialize } from "./fixtures/coding-eval/index.js";

// A coding evaluation through the product's own path. Each task is a coding task
// in the standard permission, created and sent through TaskService and run by the
// pinned Codex against a local instance of the product gateway, which calls the
// chat model the server is configured with. Every fixture repository is copied
// fresh; the Agent gets only the task's request, and the result is judged by
// tests it never saw, plus a check that tests it was told to keep are untouched.
// A person answering approvals is played by declining every one, which is also
// counted. Real model calls, so opt-in:
//
//   node scripts/eval-coding-agent.js --live [--only t1-paginate,t4-duration] [--label before]
//     [--minutes 20] [--out results.json] [--keep]
const args = process.argv.slice(2);
if (!args.includes("--live")) throw new Error("Pass --live to authorize real model calls for the coding evaluation");
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const only = option("--only")?.split(",").filter(Boolean);
const label = option("--label") ?? "run";
const turnLimitMs = Number(option("--minutes") ?? 20) * 60_000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const IN_PROGRESS = new Set(["running", "awaiting_approval", "stopping"]);

const tasks = (await codingEvalTasks()).filter(task => !only || only.includes(task.id));
if (!tasks.length) throw new Error("No evaluation task matches --only");
const chat = await loadChatModelConfig();
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-coding-eval-"));
const out = option("--out") ?? path.join(os.tmpdir(), `idou-coding-eval-${label}-${Date.now()}.json`);

const traffic = { provider: 0, providerStatus: {}, gatewayStatus: {} };
const bump = (table, key) => { table[key] = (table[key] ?? 0) + 1; };
const sessions = new SessionRegistry();
const server = createModelGateway({ ...chat, sessions,
  fetchImpl: async (url, request) => { traffic.provider += 1; const response = await fetch(url, request); bump(traffic.providerStatus, response.status); return response; },
  audit: event => bump(traffic.gatewayStatus, event.status) });
server.listen(0, "127.0.0.1");
await once(server, "listening");
const serverUrl = `http://127.0.0.1:${server.address().port}`;

// A session lasts at most 15 minutes; Codex's auth helper re-reads this file every
// minute, so a fresh one is written before each task and every ten minutes.
const sessionFile = path.join(directory, "session.json");
const issueSession = async () => {
  const session = sessions.issue({ tenantId: "development", userId: "coding-eval", deviceId: "local-eval" });
  await writeFile(sessionFile, JSON.stringify({ token: session.token, expiresAt: session.expiresAt, serverUrl }), { mode: 0o600 });
};
await issueSession();

const config = { controlPlane: { sessionFile }, codex: { binary: process.env.IDOU_CODEX_BIN || "codex", dataDir: path.join(directory, "codex") },
  feishu: { provider: "saas-cli", profile: null }, chatModel: chat.model, feishuBusinessLinked: false };
await mkdir(path.join(directory, "tasks"), { recursive: true });
const service = new TaskService({ store: new TaskStore(path.join(directory, "tasks")), runtimeFactory: task => createTaskRuntime(config, task) });
await service.init();

const digest = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const git = (cwd, ...rest) => spawnSync("git", ["-c", "user.name=coding-eval", "-c", "user.email=coding-eval@example.invalid", ...rest], { cwd, encoding: "utf8" });
const { NODE_TEST_CONTEXT: _parent, ...testEnv } = process.env;
// A file written from the shell: the command's own output redirected into a file
// (not a descriptor or /dev/null), tee, in-place sed or perl, or a script body that
// writes one. Only the first line is read for redirection, so the code of an inline
// `node - <<'EOF'` check (with its `=>` and `>`) is not mistaken for an edit.
const REDIRECT = /(^|[^0-9&>=\-])>{1,2}\s*(?!&|\/dev\/null)[^\s|;&>]+|\btee\s+(-a\s+)?[^\s|;&-]|\bsed\s+-i|\bperl\s+-p?i\b/;
const SCRIPT_WRITE = /writeFileSync|appendFileSync|\.write_text\(|open\([^)]*,\s*['"][wa]/;
const shellEdit = command => !/\bapply_patch\b/.test(command) && (REDIRECT.test(command.split("\n")[0]) || SCRIPT_WRITE.test(command));
const TEST_RUN = /\bnpm\s+(run\s+)?test\b|\bnode\s+--test\b/;
// None of the tasks needs anything installed or downloaded. Seen in a run: an Agent
// misled by "command not found: apply_patch" searched npm and installed an
// unvetted patch package into /tmp to work around it.
const INSTALL = /\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b|\bnpx\s|\bnpm\s+(view|search|pack)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcurl\s|\bwget\s/;
const codexVersion = spawnSync(config.codex.binary, ["--version"], { encoding: "utf8" }).stdout.trim();
// A test file the Agent may add to but not change: each of its original test
// cases has to still be there, word for word. (`lockedTests` may not change at all.)
const testCases = text => text.split(/\n(?=test\()/).slice(1).map(block => block.trim());

const results = [];
try {
  for (const spec of tasks) {
    const workspace = path.join(directory, spec.id);
    await materialize(spec, "repo", workspace);
    const repository = git(workspace, "init", "-q").status === 0 && git(workspace, "add", "-A").status === 0 && git(workspace, "commit", "-qm", "starting point").status === 0;
    const locked = Object.fromEntries(await Promise.all(spec.lockedTests.map(async file => [file, await digest(path.join(workspace, file))])));
    const preserved = Object.fromEntries(await Promise.all((spec.preservedTests ?? []).map(async file => [file, testCases(await readFile(path.join(workspace, file), "utf8"))])));
    await issueSession();
    const before = structuredClone(traffic), started = Date.now(), approvals = [];
    const refresh = setInterval(() => { void issueSession(); }, 10 * 60_000);
    let task, error = null, timedOut = false;
    try {
      const created = await service.create({ mode: "coding", cwd: workspace, permission: "standard" });
      await service.send(created.id, spec.prompt);
      for (;;) {
        for (const approval of [...service.approvals.values()].filter(item => item.public.taskId === created.id)) {
          approvals.push({ kind: approval.public.kind, command: approval.public.command?.slice(0, 300) ?? null });
          service.approve(approval.public.id, "decline");
        }
        task = service.get(created.id);
        if (!IN_PROGRESS.has(task.status)) break;
        if (Date.now() - started > turnLimitMs) { timedOut = true; service.stop(created.id); }
        await sleep(1000);
      }
      await service.active.get(created.id)?.done.promise;
      task = service.get(created.id);
    } catch (caught) { error = String(caught?.message ?? caught).slice(0, 500); }
    finally { clearInterval(refresh); }

    const tampered = [];
    for (const [file, hash] of Object.entries(locked)) if (await digest(path.join(workspace, file)).catch(() => null) !== hash) tampered.push(file);
    const changedTests = [];
    for (const [file, cases] of Object.entries(preserved)) {
      const now = await readFile(path.join(workspace, file), "utf8").catch(() => "");
      const missing = cases.filter(block => !now.includes(block)).length;
      if (missing) changedTests.push(`${file} (${missing} of ${cases.length})`);
    }
    await materialize(spec, "hidden", workspace);
    const tests = spawnSync(process.execPath, ["--test"], { cwd: workspace, encoding: "utf8", timeout: 180_000, env: testEnv });
    const count = name => Number(new RegExp(`^# ${name} (\\d+)`, "m").exec(tests.stdout ?? "")?.[1] ?? NaN);
    const activity = task?.activity ?? [];
    const commands = activity.filter(item => item.type === "commandExecution").map(item => String(item.command ?? ""));
    const fileChanges = activity.filter(item => item.type === "fileChange");
    const row = {
      task: spec.id, kind: spec.kind, passed: tests.status === 0 && !tampered.length && !changedTests.length && !error, tests: { exit: tests.status, pass: count("pass"), fail: count("fail") }, tampered, changedTests,
      status: task?.status ?? null, taskError: task?.error ?? null, error, timedOut, minutes: Math.round((Date.now() - started) / 600) / 100,
      requests: traffic.provider - before.provider,
      providerStatus: Object.fromEntries(Object.entries(traffic.providerStatus).map(([key, value]) => [key, value - (before.providerStatus[key] ?? 0)]).filter(([, value]) => value)),
      gatewayStatus: Object.fromEntries(Object.entries(traffic.gatewayStatus).map(([key, value]) => [key, value - (before.gatewayStatus[key] ?? 0)]).filter(([, value]) => value)),
      commands: commands.length, fileChanges: fileChanges.length, filesPatched: new Set(fileChanges.flatMap(item => (item.changes ?? []).map(change => change.path))).size,
      shellEdits: commands.filter(shellEdit).length, testRuns: commands.filter(command => TEST_RUN.test(command)).length, installs: commands.filter(command => INSTALL.test(command)).length,
      approvals, replyChars: task?.messages?.filter(message => message.role === "assistant").at(-1)?.text?.length ?? 0, repository,
      commandLog: commands.map(command => command.slice(0, 200)),
    };
    results.push(row);
    process.stdout.write(`${row.task.padEnd(16)} ${row.passed ? "PASS" : "FAIL"}  ${row.minutes} min  requests ${row.requests}  commands ${row.commands}  patches ${row.fileChanges}  shell-edits ${row.shellEdits}  test-runs ${row.testRuns}  installs ${row.installs}  approvals ${approvals.length}${tampered.length ? `  tampered ${tampered.join(",")}` : ""}${changedTests.length ? `  changed-tests ${changedTests.join(",")}` : ""}${row.taskError || error ? `  error ${String(row.taskError || error).slice(0, 160)}` : ""}\n`);
  }
} finally {
  await service.close().catch(() => {});
  server.close(); server.closeAllConnections();
  const summary = { label, model: chat.model, codex: codexVersion, finishedAt: new Date().toISOString(), passed: results.filter(row => row.passed).length, total: results.length, results };
  await writeFile(out, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ label, model: chat.model, codex: codexVersion, passed: summary.passed, total: summary.total, out })}\n`);
  if (!args.includes("--keep")) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else process.stdout.write(`kept ${directory}\n`);
}
