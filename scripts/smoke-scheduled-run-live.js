import "../src/adopt-legacy-env.js";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startScheduledTasks } from "../src/control-plane/scheduled-tasks.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { zonedInstant } from "../src/control-plane/schedule-spec.js";
import { WRITTEN } from "../src/product-names.js";

// A schedule firing, end to end, through the real assembly and the real Docker.
//
// What it cannot cover is Feishu: that needs a live OAuth login and a person
// clicking 授权, neither of which a script can do. So the session and the
// credential are stubbed and everything else is real -- the store on disk, the
// clock, the TLS certificate, the egress listener, the container, the run
// record. The seam this proves is the one that had never run: due → run token →
// container → output → history.
//
// The task inside the container will not reach a model (there is no gateway
// here), so the run is expected to FAIL. That is the point: a failure that
// carries the container's own words is the chain working. A run that "completed"
// with nothing in it would mean the opposite.
// Under $HOME, not os.tmpdir(): colima mounts only /Users/$USER into its Linux
// VM, so a /var/folders path does not exist from the daemon's side and every
// container refuses to start. This is the third time that has bitten here.
const directory = await mkdtemp(path.join(os.homedir(), ".idou-scheduled-run-"));
const ZONE = "Asia/Shanghai";
const EGRESS_PORT = Number(process.env.IDOU_SCHEDULED_TASKS_PORT ?? 8444);
if (!Number.isSafeInteger(EGRESS_PORT) || EGRESS_PORT < 1024 || EGRESS_PORT > 65535) throw new Error("IDOU_SCHEDULED_TASKS_PORT must be a non-privileged TCP port");
const WHO = { id: "s1", tenantId: "tenant-local", userId: "person-local", familyId: "login-local",
  authProvider: "feishu", audience: "codex-model-gateway", scopes: ["models:responses"], expiresAt: Date.now() + 15 * 60_000 };

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures += 1; console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`); };

// Enough of a session registry and a Feishu grant for the assembly to work.
const sessions = {
  prune() {}, verify: (token) => (token === "local" ? WHO : null),
  issueForSandboxRun: () => ({ token: "S".repeat(43), ...WHO, audience: "sandbox-run" }),
};
const sourceAccess = { feishu: SAAS_FEISHU, appId: "cli_smoketest", current: () => ({ who: WHO, grant: { token: Buffer.from("stub"), controller: new AbortController() } }) };

let tasks;
try {
  tasks = await startScheduledTasks({
    feishu: SAAS_FEISHU, sessions, sourceAccess, dataDir: directory, controlPlaneOrigin: "http://127.0.0.1:1",
    liveSession: () => ({ token: "local", expiresAt: WHO.expiresAt }),
    egressPort: EGRESS_PORT, log: (message) => console.log(`  · ${message}`),
  });
  check("the assembly starts", true, `egress on :${tasks.egressPort}, sandbox ${tasks.sandboxReady ? "ready" : "unavailable"}`);
  check("a certificate exists for the name the sandbox dials", tasks.certificate.hostname === "egress.idou.internal");
  if (!tasks.sandboxReady) { console.log("\nThe sandbox is not ready (Docker or the image; see above); the rest of this needs it."); process.exit(1); }

  // Due one minute from now, then the clock is moved forward rather than waited
  // out: the store and the scheduler both take an injected clock.
  const now = Date.now();
  const soon = new Date(now + 60_000);
  const at = zonedInstant({ year: soon.getFullYear(), month: soon.getMonth() + 1, day: soon.getDate(),
    hour: soon.getHours(), minute: soon.getMinutes() }, ZONE);
  const created = tasks.store.create(WHO, { title: "端到端验证", prompt: "回答一个词：就绪。", mode: "cowork",
    schedule: { frequency: "once", at, timeZone: ZONE } });
  check("a schedule is stored and reads back as a rule", /^单次 /.test(created.schedule), created.schedule);

  // Fire it. The store's own clock is what decides "due", so it is advanced.
  tasks.store.now = () => at + 1000;
  tasks.scheduler.now = () => at + 1000;
  tasks.runner.now = () => at + 1000;
  const due = tasks.store.due(at + 1000);
  check("it comes due at its moment", due.length === 1 && due[0].id === created.id);

  console.log("  · running the container …");
  await tasks.scheduler.tick();
  await Promise.all([...tasks.scheduler.running.values()]);

  const [run] = tasks.store.runs(WHO, created.id);
  check("a run was recorded", Boolean(run), run ? `outcome=${run.outcome}` : "none");

  // The distinction that matters, and that the first version of this script got
  // wrong: "the container ran and the task failed" against "the container never
  // started". A loose assertion -- detail is long and mentions an error -- was
  // satisfied by `沙箱未能启动`, so it reported ALL CHECKS PASSED while nothing
  // had run at all.
  const detail = run?.detail ?? "";
  check("the container actually started", !/沙箱未能启动|invalid mount config|No such image/.test(detail),
    detail.slice(0, 150).replace(/\n/g, " "));
  // Without a model gateway the task inside cannot finish, so a failure is the
  // expected shape -- but it has to be the task's own failure, from inside.
  check("and the failure is the task's own, from inside the container",
    run?.outcome === "failed" && /^任务失败，退出码 \d+$/.test(detail), detail.slice(0, 150).replace(/\n/g, " "));
  check("the schedule is finished, being a one-off", tasks.store.get(WHO, created.id).state === "paused");
  check("the run token did not outlive the run", tasks.runner.open.size === 0);
  const leftover = await tasks.runner.sandbox.run("docker", ["ps", "--quiet", "--filter", `label=${WRITTEN}.sandbox=1`], { timeoutMs: 15_000 });
  check("no container was left behind", leftover.stdout.trim() === "", leftover.stdout.trim());

  // The workspace contained the prompt and must not outlive the run. Durable
  // output is now the trusted Drive receipt, never this local task file.
  const workspace = path.join(directory, "runs", run.id);
  const task = await readFile(path.join(workspace, "task.json"), "utf8").catch(() => null);
  check("the task file and owned workspace were reclaimed", task === null, task ? "task.json remained" : "clean");
} finally {
  await tasks?.close().catch(() => {});
  // Its schedule store, egress certificate and run folders go with it; each run
  // used to leave another ~/.idou-scheduled-run-* behind.
  await rm(directory, { recursive: true, force: true }).catch((error) => console.log(`  (could not remove ${directory}: ${error.code ?? error.message})`));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED — a schedule fired, ran in a container, and was recorded" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
