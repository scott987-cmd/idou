import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { reclaimSupersededReports, reportReleaser, startScheduledTasks } from "../src/control-plane/scheduled-tasks.js";
import { ScheduleStore } from "../src/control-plane/schedule-store.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

// A report a scheduled task no longer keeps gives back the Drive budget it was
// charged, as its owner (scheduled-tasks.js, drive-budget.js release): right
// after it is superseded, and on start for every one superseded before this.

test("a superseded report is given back as its owner, and not without a ledger", async () => {
  const asked = [];
  const release = reportReleaser({ driveBudget: { release: async (identity, id) => { asked.push({ identity, id }); return true; } }, appId: "cli_a1b2c3d4e5f60718" });
  assert.equal(await release({ tenant: "tenant-a", owner: "ou_owner", runId: "run-1" }), true);
  assert.deepEqual(asked, [{ identity: { authProvider: "feishu", tenantId: "tenant-a", appId: "cli_a1b2c3d4e5f60718", userId: "ou_owner" }, id: "run-1" }]);
  assert.equal(await reportReleaser({ driveBudget: null, appId: "cli_a1b2c3d4e5f60718" })({ tenant: "t", owner: "o", runId: "r" }), false);
  assert.equal(await reportReleaser({ driveBudget: { release: async () => true }, appId: null })({ tenant: "t", owner: "o", runId: "r" }), false);
});

test("every superseded report is looked at once, a page at a time, and one that fails does not stop the rest", async () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({ tenant: "tenant-a", runId: `run-${index}`, owner: "ou_owner" }));
  const store = { supersededReports: async ({ after, limit }) => rows.filter((row) => !after || row.runId > after.runId).slice(0, limit) };
  const seen = [];
  const given = await reclaimSupersededReports({ store, pageSize: 3, release: async (row) => {
    seen.push(row.runId);
    if (row.runId === "run-2") throw new Error("database away");
    return row.runId !== "run-4"; // already given back
  } });
  assert.deepEqual(seen, rows.map((row) => row.runId));
  assert.equal(given, 5);
});

// And the daily prune (scheduled-tasks.js, schedule-store.js pruneRuns) hands
// every row it lets go to the same giving back, before the row goes: a run gone
// can no longer be found to give its reservation back.
test("the prune at start gives an overwritten report's reservation back while its run is still there, then lets the run go", async (t) => {
  const DAY = 86_400_000, clock = { at: Date.parse("2026-06-01T01:00:00Z") };
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "idou-drive-reclaim-"));
  let tasks = null;
  // close before rm: a throwing rm must not skip closing the listener.
  t.after(async () => { await tasks?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const store = new ScheduleStore({ databaseFile: path.join(dataDir, "schedules.db"), now: () => clock.at });
  const WHO = { tenantId: "tenant-a", userId: "ou_0f1e2d3c4b5a69788796a5b4c3d2e1f0", familyId: "login-a" };
  const task = store.create(WHO, { title: "每天汇总", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork", schedule: { frequency: "daily", time: "09:00", timeZone: "Asia/Shanghai" } });
  const run = store.claimNow(task, clock.at);
  store.finish(WHO.tenantId, run.runId, "completed", null, { state: "verified", providerId: "saas-cli", fileToken: "FileOverwritten1",
    url: "https://x.feishu.cn/file/FileOverwritten1", name: `idou-${run.runId}.schedule.md`, bytes: 10, sha256: "f".repeat(64), archivedAt: clock.at });
  store.supersedeReport(WHO.tenantId, run.runId);
  store.remove(WHO, task.id);
  clock.at += 100 * DAY;

  const released = [];
  const driveBudget = { release: async (identity, id) => {
    released.push({ identity, id, runStillThere: Boolean(store.db.prepare("SELECT 1 FROM schedule_runs WHERE id = ?").get(id)) });
    return true;
  } };
  const sessions = { prune() {}, verify: () => null, issueForSandboxRun: () => null };
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  tasks = await startScheduledTasks({ feishu: SAAS_FEISHU, sessions, sourceAccess: { feishu: SAAS_FEISHU, appId: "cli_a1b2c3d4e5f60718" },
    driveBudget, openStore: async () => store, dataDir, controlPlaneOrigin: "http://127.0.0.1:1", docker: "false", egressPort: port, gatewayAddress: "127.0.0.1",
    now: () => clock.at, log: () => {} });
  assert.deepEqual(released[0], { identity: { authProvider: "feishu", tenantId: WHO.tenantId, appId: "cli_a1b2c3d4e5f60718", userId: WHO.userId },
    id: run.runId, runStillThere: true });
  assert.equal(store.db.prepare("SELECT 1 FROM schedule_runs WHERE id = ?").get(run.runId), undefined, "and then the run went");
});
