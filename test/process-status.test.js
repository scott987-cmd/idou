// What 服务状态 knows of the whole server (process-status.js,
// docs/service-status.md): every process's heartbeat, what its model requests
// did, the self-checks and alerts kept, read back as the page shows them. On
// SQLite and on PostgreSQL.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { LATENCY_BOUNDS, OVER, ProcessStatus, STATUS_LIMITS, StatusHistory, TrafficMeter, WorkerHeartbeat, conditionOf, processesCheck, quantile,
  readProcesses, readServiceStatus } from "../src/control-plane/process-status.js";
import { testPostgres } from "./helpers/postgres.js";

const KINDS = ["sqlite", "postgres"];
const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });
let server = null;
const postgres = () => (server ??= testPostgres({ after: (stop) => stops.push(stop) }));
const START = Date.UTC(2026, 9, 3, 8, 0);

async function setup(t, kind) {
  let db;
  if (kind === "postgres") {
    const settings = await (await postgres()).database();
    const pool = new pg.Pool({ ...settings, max: 4 }); pool.on("error", () => {});
    const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
    db = await openAdminDatabase({ pool, connect });
    t.after(async () => { await db.close(); await pool.end(); });
  } else { db = await openAdminDatabase(); t.after(() => db.close()); }
  const clock = { at: START };
  return { db, clock, now: () => clock.at };
}

test("a process's model requests, by five-minute bucket and model, kept until written", () => {
  const clock = { at: START + 60_000 };
  const meter = new TrafficMeter({ now: () => clock.at });
  meter.record({ model: "MiniMax-M3", outcome: "ok", firstMs: 800 });
  meter.record({ model: "MiniMax-M3", outcome: "ok", firstMs: 4_000 });
  meter.record({ model: "MiniMax-M3", outcome: "upstream" });
  meter.record({ model: "", outcome: "limited", refusal: "server" });
  meter.record({ model: "x", outcome: "nonsense" });
  const first = meter.pending();
  assert.equal(first.length, 2);
  const minimax = JSON.parse(first.find((entry) => entry.model === "MiniMax-M3").counts);
  assert.deepEqual([minimax.requests, minimax.ok, minimax.upstream, minimax.latency[1], minimax.latency[4]], [3, 2, 1, 1, 1], "800 ms under 1 s, 4 s under 5 s");
  assert.equal(JSON.parse(first.find((entry) => entry.model === "").counts).refused.server, 1);
  meter.written(first);
  assert.equal(meter.pending().length, 0);
  meter.record({ model: "MiniMax-M3", outcome: "cancelled" });
  assert.equal(JSON.parse(meter.pending()[0].counts).requests, 4, "the bucket as it stands, not what came since");
  // A request that ends while its bucket is being written is not lost with the write.
  const writing = meter.pending();
  meter.record({ model: "MiniMax-M3", outcome: "ok", firstMs: 300 });
  clock.at += STATUS_LIMITS.bucketMs;
  meter.written(writing);
  assert.equal(JSON.parse(meter.pending()[0].counts).requests, 5, "still to be written, with the one that came during the write");
  meter.written(meter.pending());
  assert.equal(meter.buckets.size, 0, "a bucket that has ended is let go once written");
  const cells = (filled) => Object.assign(new Array(LATENCY_BOUNDS.length + 1).fill(0), filled);
  assert.equal(quantile(cells({ 0: 1, 2: 1 }), 0.5), LATENCY_BOUNDS[0]);
  assert.equal(quantile(cells({ [LATENCY_BOUNDS.length]: 2 }), 0.95), OVER, "past the last bound, which is not the same as nothing");
  assert.equal(quantile(cells({}), 0.5), null);
});

for (const kind of KINDS) test(`${kind}: every process's heartbeat and traffic, read back as the page shows them`, async (t) => {
  const { db, clock, now } = await setup(t, kind);
  const coordinatorTraffic = new TrafficMeter({ now }), replicaTraffic = new TrafficMeter({ now });
  const coordinator = await ProcessStatus.open({ db, role: "coordinator", name: "coordinator", release: "0.1.0-20261003.271", startedAt: START, traffic: coordinatorTraffic, now,
    sample: () => ({ sessions: 12, model: { active: 3, limit: 8, people: 2 }, unavailable: [] }) });
  const replica = await ProcessStatus.open({ db, role: "api", name: "api-3043", release: "0.1.0-20261003.271", startedAt: START, traffic: replicaTraffic, now,
    sample: () => ({ sessions: 30, model: { active: 7, limit: 8, people: 6 }, unavailable: [{ model: "GLM-5.3", reason: "billing", retryAt: START + 600_000 }] }) });
  for (let n = 0; n < 18; n += 1) replicaTraffic.record({ model: "MiniMax-M3", outcome: "ok", firstMs: n < 15 ? 700 : 12_000 });
  replicaTraffic.record({ model: "MiniMax-M3", outcome: "upstream" });
  replicaTraffic.record({ model: "", outcome: "limited", refusal: "server" });
  coordinatorTraffic.record({ model: "GLM-5.3", outcome: "client" });
  await coordinator.beat(); await replica.beat();
  // Written again with more in the same bucket: replaced, not added twice.
  replicaTraffic.record({ model: "MiniMax-M3", outcome: "ok", firstMs: 500 });
  await replica.beat();
  const status = await readServiceStatus({ db, now, queue: async () => ({ queued: 0 }) });
  assert.deepEqual(status.processes.map((process) => [process.role, process.name, process.condition, process.state.sessions]), [["api", "api-3043", "online", 30], ["coordinator", "coordinator", "online", 12]]);
  const minimax = status.traffic.models.find((row) => row.model === "MiniMax-M3");
  assert.deepEqual([minimax.day.requests, minimax.day.ok, minimax.day.errors, minimax.hour.requests], [20, 19, 1, 20]);
  assert.deepEqual([minimax.day.p50, minimax.day.p95], [1_000, 20_000]);
  assert.equal(status.traffic.models.find((row) => row.model === "GLM-5.3").day.errors, 1);
  assert.equal(status.traffic.refused.server, 1);
  assert.equal(status.traffic.hours.at(-1).requests, 22);
  assert.deepEqual(status.unavailable.map((entry) => [entry.model, entry.process]), [["GLM-5.3", "api-3043"]]);
  assert.deepEqual(status.capacity.model, { active: 10, limit: 16, people: 8 });
  assert.equal(status.advice[0].kind, "model", "turned away for capacity in the last hour");
  assert.match(status.advice[0].text, /建议加一个模型副本/);
  assert.equal(status.mixed, false);

  // A replica that stops answering, then is started again under its name.
  const check = () => processesCheck({ read: () => readProcesses({ db, now }) }).run();
  clock.at += 90_000;
  await coordinator.beat();
  assert.equal((await readProcesses({ db, now })).processes.find((process) => process.name === "api-3043").condition, "stale");
  assert.equal((await check()).level, "warning");
  clock.at += 120_000;
  await coordinator.beat();
  const lost = await check();
  assert.equal(lost.level, "critical");
  assert.match(lost.summary, /api-3043 超过 3 分钟没有心跳/);
  const again = await ProcessStatus.open({ db, role: "api", name: "api-3043", release: "0.1.0-20261003.272", startedAt: clock.at, now, sample: () => ({}) });
  await again.beat();
  const restarted = await readProcesses({ db, now });
  assert.deepEqual(restarted.processes.filter((process) => process.name === "api-3043").map((process) => process.condition), ["online"], "restarted, not lost");
  assert.equal(restarted.restarted.length, 1, "counted: it had not stopped cleanly");
  assert.equal(restarted.mixed, true, "two releases at once: half way through an upgrade");
  assert.equal((await check()).level, "ok");

  // Stopped cleanly: said so, and back within a restart's time is fine.
  await coordinator.close();
  assert.equal((await readProcesses({ db, now })).processes.find((process) => process.name === "coordinator").condition, "stopped");
  assert.equal((await check()).level, "ok", "a restart takes a moment");
  const back = await ProcessStatus.open({ db, role: "coordinator", name: "coordinator", release: "0.1.0-20261003.272", startedAt: clock.at + 1, now, sample: () => ({}) });
  clock.at += 2000; await back.beat();
  const after = await readProcesses({ db, now });
  assert.deepEqual(after.processes.filter((process) => process.name === "coordinator").map((process) => process.condition), ["online"]);
  assert.equal(after.restarted.length, 1, "a clean restart is not counted as an unexpected one");
  // Stopped and never back -- a release that cannot start: said, after the time a restart takes.
  await again.close();
  clock.at += 60_000; await back.beat();
  assert.equal((await check()).level, "ok");
  clock.at += STATUS_LIMITS.goneMs; await back.beat();
  const away = await check();
  assert.equal(away.level, "warning");
  assert.match(away.summary, /api-3043 停止后没有再启动/);
  // A namesake that started earlier is no successor: two with one name hide a lost one, and that is said.
  const twin = await ProcessStatus.open({ db, role: "coordinator", name: "coordinator", release: "0.1.0-20261003.272", startedAt: START, now, sample: () => ({}) });
  await twin.beat();
  assert.match((await check()).summary, /api-3043 停止后没有再启动/, "the stopped one stays reported");
  const restartedEarlier = await ProcessStatus.open({ db, role: "api", name: "api-3043", release: "0.1.0-20261003.272", startedAt: START, now, sample: () => ({}) });
  await restartedEarlier.beat();
  assert.match((await check()).summary, /api-3043 停止后没有再启动/, "started before it stopped: not its successor");
  await restartedEarlier.close(); await back.close(); await twin.close(); await replica.close();
  assert.equal((await readServiceStatus({ db, now })).traffic.models.find((row) => row.model === "MiniMax-M3").day.requests, 20, "its traffic kept");
});

test("two live processes with one name on one machine are said to be a problem; on two machines they are not", async () => {
  const at = START;
  const live = (name, role = "api", host = "h") => ({ role, name, host, condition: "online", beatAt: at, startedAt: at - 1000, release: "r", state: {} });
  const result = await processesCheck({ read: async () => ({ at, processes: [live("api-1"), live("api-1"), live("coordinator", "coordinator")], releases: ["r"], mixed: false }) }).run();
  assert.equal(result.level, "warning");
  assert.match(result.summary, /同一台机器上有几个进程同名（api-1）/);
  const apart = await processesCheck({ read: async () => ({ at, processes: [live("worker-1", "worker", "a"), live("worker-1", "worker", "b")], releases: ["r"], mixed: false }) }).run();
  assert.equal(apart.level, "ok");
});

// Found in the second review (2026-10-03): a crash restarted by systemd five
// seconds later looked, for a minute, like two processes with one name; a
// coordinator that took over on another machine left the first one lost for a
// day; a beat from the future stood in for a dead worker; a day-old row was
// still listed until the next prune.
for (const kind of KINDS) test(`${kind}: a successor is recognised at once, a coordinator's on any machine, and a day-old row is forgotten`, async (t) => {
  const { db, clock, now } = await setup(t, kind);
  await StatusHistory.open({ db, now });
  const open = (role, name, host) => ProcessStatus.open({ db, role, name, release: "r", startedAt: clock.at, now, host, sample: () => ({}) });
  const crashed = await open("api", "api-3043", "a");
  await crashed.beat();
  clock.at += 5_000;
  const restarted = await open("api", "api-3043", "a");
  await restarted.beat();
  const read = await readProcesses({ db, now });
  assert.deepEqual(read.processes.map((process) => [process.name, process.condition]), [["api-3043", "online"]], "the crashed one is replaced at once");
  assert.equal((await processesCheck({ read: () => readProcesses({ db, now }) }).run()).level, "ok", "no twins");
  // A coordinator on machine a, then the one that took over on machine b.
  const first = await open("coordinator", "coordinator", "a");
  await first.beat();
  clock.at += 30_000;
  const second = await open("coordinator", "coordinator", "b");
  await second.beat();
  clock.at += 5 * 60_000; await second.beat(); await restarted.beat();
  assert.equal((await processesCheck({ read: () => readProcesses({ db, now }) }).run()).level, "ok", "the first coordinator is not lost");
  // Forgotten after a day, whatever the pruning schedule.
  await restarted.close();
  clock.at += STATUS_LIMITS.forgetMs + 60_000; await second.beat();
  assert.deepEqual((await readProcesses({ db, now })).processes.map((process) => process.name), ["coordinator"]);
  // A worker row from the future is nobody's.
  const future = await readProcesses({ db, now, workers: async () => [{ worker: "w", name: "worker-1", host: "a", pid: 1, release: "r", startedAt: clock.at, beatAt: clock.at + 3_600_000, state: {} }] });
  assert.equal(future.processes.some((process) => process.role === "worker"), false);
});

test("a worker row is taken only in the shape a worker writes it", async (t) => {
  const { db, now } = await setup(t, "sqlite");
  await StatusHistory.open({ db, now });
  const rows = [
    { worker: "worker-1-a", name: "worker-1", host: "h", pid: 1, release: "r", startedAt: START, beatAt: START, state: { runs: { active: 1, limit: 2 }, rss: 5, extra: "x".repeat(10_000) } },
    { worker: "forged", name: "攻击者写的字<b>", host: "h", pid: 2, release: "r", startedAt: START, beatAt: START, state: {} },
  ];
  const read = await readProcesses({ db, now, workers: async () => rows });
  assert.deepEqual(read.processes.map((process) => process.name), ["worker-1"], "a name no worker can have is dropped");
  assert.deepEqual(read.processes[0].state, { runs: { active: 1, limit: 2 }, rss: 5, heapUsed: null });
});

for (const kind of KINDS) test(`${kind}: the self-checks of a day as a strip, the week's incidents, the alerts sent`, async (t) => {
  const { db, clock, now } = await setup(t, kind);
  const history = await StatusHistory.open({ db, now });
  const sweep = async (levels) => {
    await history.recordSweep({ checks: Object.entries(levels).map(([name, level]) => ({ name, label: name === "disk" ? "数据盘" : "备份", level, summary: `${name} ${level}`, at: clock.at })) });
    clock.at += 5 * 60_000;
  };
  await sweep({ disk: "ok", backup: "ok" });
  await sweep({ disk: "warning", backup: "ok" });
  await sweep({ disk: "critical", backup: "ok" });
  await sweep({ disk: "ok", backup: "warning" });
  await sweep({ disk: "ok", backup: "warning" });
  await history.recordAlert({ level: "critical", text: "i豆 服务端严重告警：数据盘快满了", recipients: 3, reached: 2 });
  clock.at += 1000;
  await history.recordAlert({ level: "ok", text: "测试告警", recipients: 1, reached: 1, test: true });
  const status = await readServiceStatus({ db, now });
  const disk = status.health.strips.find((strip) => strip.name === "disk");
  assert.equal(disk.cells.length, 48);
  assert.equal(disk.cells.filter(Boolean).length >= 1, true);
  assert.ok(disk.cells.includes("critical"), "a half hour at its worst");
  assert.deepEqual(status.health.incidents.map((incident) => [incident.name, incident.level, incident.to === null]), [["backup", "warning", true], ["disk", "critical", false]]);
  assert.equal(status.health.incidents[1].to - status.health.incidents[1].from, 10 * 60_000);
  assert.deepEqual(status.alerts.map((alert) => [alert.level, alert.reached, alert.recipients, alert.test]), [["ok", 1, 1, true], ["critical", 2, 3, false]], "newest first");
  // Kept 30 days; a silent process a day.
  clock.at += (STATUS_LIMITS.healthDays + 1) * 86_400_000;
  await history.prune();
  assert.equal((await readServiceStatus({ db, now })).health.incidents.length, 0);
  assert.equal(conditionOf(clock.at - 10_000, clock.at), "online");
});

test("a worker's heartbeat goes through the queue, says once when it is refused, and keeps trying", async () => {
  const written = [], logged = [];
  let refuse = true;
  const queue = { beat: async (row) => { if (refuse) { const error = new Error("permission denied"); error.code = "42501"; throw error; } written.push(row); } };
  const heartbeat = new WorkerHeartbeat({ queue, name: "worker-1", release: "r", startedAt: START, sample: () => ({ runs: { active: 1, limit: 3 } }), log: (line) => logged.push(line) });
  await heartbeat.beat(); await heartbeat.beat();
  assert.equal(logged.filter((line) => line.event === "heartbeat-refused").length, 1, "said once");
  assert.match(logged[0].message, /worker-role\.sql/);
  refuse = false;
  await heartbeat.beat();
  assert.deepEqual([written.length, written[0].name, written[0].state.runs], [1, "worker-1", { active: 1, limit: 3 }]);
  await heartbeat.close();
  assert.deepEqual([written.length, written.at(-1).state.stopped], [2, true], "stopped: said so in its row, which the coordinator keeps a day");
});

test("where the backups are and what a process is called are settings, each checked", async () => {
  const { loadBackupDir, loadProcessName } = await import("../src/control-plane/server-config.js");
  assert.equal(loadBackupDir({}), null, "unset: no 备份 check");
  assert.equal(loadBackupDir({ IDOU_BACKUP_DIR: "/home/idou/backups/" }), "/home/idou/backups");
  assert.throws(() => loadBackupDir({ IDOU_BACKUP_DIR: "backups" }), /绝对路径/);
  assert.equal(loadProcessName("api", 3043, {}), "api-3043");
  assert.equal(loadProcessName("coordinator", null, {}), "coordinator");
  assert.equal(loadProcessName("api", 3043, { IDOU_PROCESS_NAME: "api-1" }), "api-1");
  assert.throws(() => loadProcessName("api", 3043, { IDOU_PROCESS_NAME: "API 1" }), /IDOU_PROCESS_NAME/);
});
