// @requires live: 一次真实付费模型调用，读本机真实的部署文件
import "../src/adopt-legacy-env.js";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScheduleClient } from "../src/application/schedule-client.js";
import { readClientSession } from "../src/control-plane/client-session.js";
import { localEnvFile } from "../src/install-names.js";

// A scheduled task, actually running.
//
// Everything else about this feature has been proven in pieces: the clock, the
// container, the egress, the UI. What had never happened is the whole thing
// end to end -- a schedule left alone until its moment, firing by itself,
// reaching the model through the proxy, and coming back with an answer a person
// would read in 运行记录.
//
// This makes ONE REAL PAID MODEL CALL. It is the only way to prove the last hop,
// and the prompt is deliberately a single word's worth of work.
//
// Feishu is the one hop still not covered: that needs an OAuth login and a
// person clicking 授权 in the app, neither of which a script can do. The task
// here is one that needs no Feishu.
// Asked for by name: the default acceptance run once made this paid call
// because nothing here said it would (2026-09-25).
if (!process.argv.includes("--live")) throw new Error("Pass --live: this makes one real paid model call with the deployment file in ~/.idou (or ~/.mydoubao)");
const directory = await mkdtemp(path.join(os.homedir(), ".idou-e2e-"));
const CONFIG = process.env.MINIMAX_CONFIG_FILE || localEnvFile();
const PORT = process.env.IDOU_SCHEDULED_TASKS_PORT || "8455";

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, ["bin/server.js", "--dev"], { cwd: process.cwd(),
  env: { ...process.env, MINIMAX_CONFIG_FILE: CONFIG, IDOU_SCHEDULED_TASKS: "1",
    IDOU_SCHEDULED_TASKS_PORT: PORT, IDOU_SCHEDULED_TASKS_DIR: path.join(directory, "scheduled") },
  stdio: ["ignore", "pipe", "pipe"] });

try {
  const sessionFile = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`the control plane never reported a session file:\n${out}`)), 60_000);
    const look = (chunk) => {
      out += chunk;
      process.stdout.write(String(chunk).split("\n").filter((line) => line.startsWith("Scheduled tasks")).map((line) => `  · ${line}\n`).join(""));
      const found = out.match(/Client connection file: (.+)/);
      if (found) { clearTimeout(timer); resolve(found[1].trim()); }
    };
    server.stdout.on("data", look); server.stderr.on("data", (chunk) => { out += chunk; });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`the control plane exited (${code}):\n${out.slice(-1500)}`)); });
  });

  const session = () => readClientSession(sessionFile);
  const client = new ScheduleClient({ session, timeoutMs: 20_000 });

  // The identity the run acts as, handed over the way the app hands it over.
  const authorized = await client.authorize();
  check("the run has an identity to act as", authorized.authorized === true);

  // Far enough ahead that the scheduler has to wake for it on its own rather
  // than finding it already overdue when it starts.
  const at = Date.now() + 70_000;
  const created = await client.create({ title: "端到端真跑", mode: "cowork",
    prompt: "只回答两个字，不要解释，不要使用任何工具：就绪",
    schedule: { frequency: "once", at, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  check("a schedule was created and is waiting", created.schedule.state === "active", created.schedule.schedule);

  console.log(`  · waiting for ${new Date(at).toLocaleTimeString()} …`);
  let run = null;
  for (let attempt = 0; attempt < 90 && !run?.finishedAt; attempt += 1) {
    await wait(5000);
    run = (await client.runs(created.schedule.id)).runs?.[0] ?? null;
    if (run && !run.finishedAt) process.stdout.write("  · running …\n");
  }

  check("it fired by itself, without being poked", Boolean(run), run ? `due ${new Date(run.dueAt).toLocaleTimeString()}` : "never ran");
  check("and finished", Boolean(run?.finishedAt), run?.outcome ?? "still running");
  // The judgement that matters: not that a run exists, but that the model's own
  // answer came back through the container and the proxy and was recorded.
  check("the model answered, through the sandbox and the proxy",
    run?.outcome === "completed", `${run?.outcome}: ${(run?.detail ?? "").slice(0, 200).replace(/\s+/g, " ")}`);
  check("and the answer is in the run record a person reads",
    /就绪/.test(run?.detail ?? ""), (run?.detail ?? "").slice(-160).replace(/\s+/g, " "));

  const after = (await client.list()).schedules.find((row) => row.id === created.schedule.id);
  check("the one-off is finished rather than due forever", after?.state === "paused");

  const history = (await client.runs()).runs ?? [];
  check("运行记录 shows it across every schedule", history.some((row) => row.id === run?.id && row.title === "端到端真跑"));
} finally {
  server.kill("SIGTERM");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED — a scheduled task ran by itself and answered" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
