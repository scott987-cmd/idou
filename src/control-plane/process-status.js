// What the console's 服务状态 page knows of the whole server, not only of the
// process that answers it (docs/service-status.md).
//
// Until this existed the page showed the coordinator's own memory: its last
// self-check and whether a model answered. The two model replicas and the
// workers were invisible, and a restart wiped everything, so "since when" and
// "how often" could not be answered.
//
// Here each process writes a heartbeat to the shared database every 20
// seconds -- what it is, what it holds, how close it is to its limits, which
// models it has stopped asking -- and, beside it, what its model requests did
// in five-minute buckets: how many, how they ended, how long the model took to
// start answering. The coordinator keeps every self-check it makes and every
// alert it sends. The page reads all of it back (readServiceStatus).
//
// Counts and limits only, as metrics.js: never a prompt, an answer, a person.
// A bucket is keyed by process and model, never by anybody.
import os from "node:os";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { HEALTH_LEVELS } from "./health-monitor.js";
import { LASTING_REASONS } from "./model-health.js";

export const STATUS_LIMITS = Object.freeze({
  beatMs: 20_000,
  // Past these a process is no longer taken at its word: 卡住了, then 掉线.
  staleMs: 60_000,
  goneMs: 180_000,
  // A process silent for a day is forgotten; one stopped cleanly removes itself.
  forgetMs: 86_400_000,
  bucketMs: 300_000,
  trafficDays: 30,
  healthDays: 30,
  alertDays: 90,
});
// How long the model took to start answering, in cells: under 0.5 s, 1 s, 2 s,
// 3 s, 5 s, 10 s, 20 s, 30 s, 60 s, and longer. Fine where answers usually
// start, coarse where only "slow" matters.
export const LATENCY_BOUNDS = Object.freeze([500, 1_000, 2_000, 3_000, 5_000, 10_000, 20_000, 30_000, 60_000]);
export const OUTCOMES = Object.freeze(["ok", "cancelled", "client", "limited", "upstream"]);
// The gateway's own refusals (model-gateway.js counters.rejected).
export const REFUSALS = Object.freeze(["perMinute", "server", "person", "quota"]);
const ROLES = ["coordinator", "api", "worker"];
const DAY = 86_400_000, HOUR = 3_600_000;
const STRIP_CELL = 30 * 60_000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS idou_admin_processes (id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL,
    pid INTEGER NOT NULL, release TEXT NOT NULL, started_at BIGINT NOT NULL, beat_at BIGINT NOT NULL, state TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS idou_admin_traffic (bucket BIGINT NOT NULL, process TEXT NOT NULL, model TEXT NOT NULL, counts TEXT NOT NULL,
    PRIMARY KEY (bucket, process, model));
  CREATE INDEX IF NOT EXISTS idou_admin_traffic_bucket ON idou_admin_traffic (bucket);
  CREATE TABLE IF NOT EXISTS idou_admin_health (name TEXT NOT NULL, at BIGINT NOT NULL, label TEXT NOT NULL, level TEXT NOT NULL, summary TEXT NOT NULL,
    PRIMARY KEY (name, at));
  CREATE INDEX IF NOT EXISTS idou_admin_health_at ON idou_admin_health (at);
  CREATE TABLE IF NOT EXISTS idou_admin_alerts (id TEXT PRIMARY KEY, at BIGINT NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL,
    recipients INTEGER NOT NULL, reached INTEGER NOT NULL, test INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idou_admin_alerts_at ON idou_admin_alerts (at);`;

const fresh = () => ({ requests: 0, ...Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])),
  refused: Object.fromEntries(REFUSALS.map((reason) => [reason, 0])), latency: new Array(LATENCY_BOUNDS.length + 1).fill(0) });
const cellOf = (ms) => { const index = LATENCY_BOUNDS.findIndex((bound) => ms < bound); return index < 0 ? LATENCY_BOUNDS.length : index; };
const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const said = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 200);

// One process's model requests since it started, by five-minute bucket and
// model, kept until written. Only this process writes its rows, so each
// write is the bucket as it stands now, not an increment.
export class TrafficMeter {
  constructor({ now = Date.now, bucketMs = STATUS_LIMITS.bucketMs } = {}) {
    Object.assign(this, { now, bucketMs });
    this.buckets = new Map();
    // key -> how many times it changed: a write that was under way when it
    // changed again leaves it pending.
    this.dirty = new Map();
    this.changes = 0;
  }

  // One model request that got past authentication. `model` is "" when it was
  // refused before one was chosen; `firstMs` how long the model took to start
  // answering, when it did.
  record({ model = "", outcome, firstMs = null, refusal = null }) {
    if (!OUTCOMES.includes(outcome)) return;
    const bucket = Math.floor(this.now() / this.bucketMs) * this.bucketMs;
    const key = `${bucket}\n${String(model).slice(0, 80)}`;
    const counts = this.buckets.get(key) ?? fresh();
    counts.requests += 1;
    counts[outcome] += 1;
    if (REFUSALS.includes(refusal)) counts.refused[refusal] += 1;
    if (outcome === "ok" && Number.isFinite(firstMs) && firstMs >= 0) counts.latency[cellOf(firstMs)] += 1;
    this.buckets.set(key, counts);
    this.dirty.set(key, this.changes += 1);
  }

  // What changed since it was last written.
  pending() {
    return [...this.dirty].map(([key, change]) => { const [bucket, model] = key.split("\n"); return { key, change, bucket: Number(bucket), model, counts: JSON.stringify(this.buckets.get(key)) }; });
  }

  // Written: no longer pending; every bucket that has ended and has nothing
  // left to write is let go.
  written(entries) {
    const current = Math.floor(this.now() / this.bucketMs) * this.bucketMs;
    for (const { key, change } of entries) if (this.dirty.get(key) === change) this.dirty.delete(key);
    for (const key of this.buckets.keys()) if (!this.dirty.has(key) && Number(key.split("\n")[0]) < current) this.buckets.delete(key);
  }
}

// This process's heartbeat. `sample()` answers what it holds now:
// { sessions, model: { active, limit, people }, cli: { active, limit },
//   runs: { active, limit }, unavailable: [{ model, reason, retryAt }] } --
// each part only where the process has it.
export class ProcessStatus {
  static async open({ db, role, name, release, startedAt, sample = () => ({}), traffic = null, now = Date.now, host = os.hostname(),
    pid = process.pid, beatMs = STATUS_LIMITS.beatMs, log = () => {} }) {
    if (!db) throw new Error("进程心跳需要管理库");
    if (!ROLES.includes(role) || role === "worker") throw new Error(`进程心跳的角色无效：${role}`);
    await db.schema("process-status", SCHEMA);
    return new ProcessStatus({ db, role, name, release, startedAt, sample, traffic, now, host, pid, beatMs, log });
  }

  constructor({ db, role, name, release, startedAt, sample, traffic, now, host, pid, beatMs, log }) {
    Object.assign(this, { db, role, name: String(name || role).slice(0, 80), release: String(release || "unknown"), startedAt, sample, traffic, now,
      host: String(host).slice(0, 120), pid, beatMs, log });
    this.id = randomUUID();
    this.timer = null; this.beating = null; this.closed = false; this.loop = null; this.failing = false;
  }

  start() {
    this.loop = monitorEventLoopDelay({ resolution: 20 });
    this.loop.enable();
    void this.beat();
    this.timer = setInterval(() => { void this.beat(); }, this.beatMs);
    this.timer.unref?.();
    return this;
  }

  // Collapsed: a beat still writing when the next is due is the next.
  beat() {
    this.beating ??= this.#beat().finally(() => { this.beating = null; });
    return this.beating;
  }

  async #beat() {
    try {
      const memory = process.memoryUsage();
      let held = {};
      try { held = (await this.sample()) ?? {}; } catch (error) { held = { sampleError: said(error) }; }
      const state = { ...held, rss: memory.rss, heapUsed: memory.heapUsed,
        loopP99Ms: this.loop ? Math.max(0, this.loop.percentile(99) / 1e6 - 20) : null, ...(this.closed ? { stopped: true } : {}) };
      this.loop?.reset();
      await this.db.run(`INSERT INTO idou_admin_processes (id, role, name, host, pid, release, started_at, beat_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at, state = excluded.state`,
      [this.id, this.role, this.name, this.host, this.pid, this.release, this.startedAt, this.now(), JSON.stringify(state)]);
      const pending = this.traffic?.pending() ?? [];
      for (const entry of pending) {
        await this.db.run(`INSERT INTO idou_admin_traffic (bucket, process, model, counts) VALUES (?, ?, ?, ?)
          ON CONFLICT (bucket, process, model) DO UPDATE SET counts = excluded.counts`, [entry.bucket, this.id, entry.model, entry.counts]);
      }
      this.traffic?.written(pending);
      if (this.failing) { this.failing = false; this.log({ component: "process-status", event: "beat-recovered" }); }
    } catch (error) {
      // Said once, not every 20 seconds; the page shows this process as silent.
      if (!this.failing) this.log({ component: "process-status", event: "beat-failed", message: said(error) });
      this.failing = true;
    }
  }

  // The last of its traffic written, and its row marked stopped -- not
  // removed: one that does not come back is how a release that cannot start
  // is noticed (processesCheck).
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.beating;
    await this.beat();
    this.loop?.disable();
  }
}

// A worker's heartbeat, through the run queue (RunQueue.beat): its database
// role reaches the queue's tables and nothing of the administration's.
export class WorkerHeartbeat {
  constructor({ queue, name, release, startedAt, sample = () => ({}), now = Date.now, host = os.hostname(), pid = process.pid,
    beatMs = STATUS_LIMITS.beatMs, log = () => {} }) {
    if (!queue?.beat) throw new Error("执行节点的心跳需要执行池队列");
    Object.assign(this, { queue, name: String(name).slice(0, 80), release: String(release || "unknown"), startedAt, sample, now, host: String(host).slice(0, 120), pid, beatMs, log });
    this.id = `${this.name}-${randomUUID()}`;
    this.timer = null; this.beating = null; this.refused = false; this.closed = false;
  }

  start() {
    void this.beat();
    this.timer = setInterval(() => { void this.beat(); }, this.beatMs);
    this.timer.unref?.();
    return this;
  }

  beat() {
    this.beating ??= this.#beat().finally(() => { this.beating = null; });
    return this.beating;
  }

  async #beat() {
    const memory = process.memoryUsage();
    let held = {};
    try { held = (await this.sample()) ?? {}; } catch {}
    try {
      await this.queue.beat({ worker: this.id, name: this.name, host: this.host, pid: this.pid, release: this.release, startedAt: this.startedAt,
        state: { ...held, rss: memory.rss, heapUsed: memory.heapUsed, ...(this.closed ? { stopped: true } : {}) } });
      if (this.refused) this.log({ component: "run-worker", event: "heartbeat-allowed" });
      this.refused = false;
    } catch (error) {
      // Said once; it keeps trying, so granting the table is enough.
      if (!this.refused) this.log({ component: "run-worker", event: "heartbeat-refused", code: error?.code ?? null,
        message: error?.code === "42501" || error?.code === "42P01" ? "执行节点写不了心跳表：在服务器上执行一次 deploy/server/worker-role.sql（协调副本要先启动过新版本）" : said(error) });
      this.refused = true;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.beating;
    await this.beat();
  }
}

// What the coordinator keeps of its own checks and alerts.
export class StatusHistory {
  static async open({ db, now = Date.now, log = () => {} }) {
    if (!db) throw new Error("服务状态历史需要管理库");
    await db.schema("process-status", SCHEMA);
    return new StatusHistory({ db, now, log });
  }

  constructor({ db, now, log }) { Object.assign(this, { db, now, log }); }

  // One sweep of health-monitor.js: each check's answer at the moment it gave it.
  async recordSweep(status) {
    for (const check of status?.checks ?? []) {
      if (!Object.hasOwn(HEALTH_LEVELS, check.level)) continue;
      await this.db.run(`INSERT INTO idou_admin_health (name, at, label, level, summary) VALUES (?, ?, ?, ?, ?) ON CONFLICT (name, at) DO NOTHING`,
        [check.name, check.at ?? this.now(), String(check.label).slice(0, 80), check.level, String(check.summary).slice(0, 400)]);
    }
  }

  // An alert as sent: to how many, and how many got it. Its words are the
  // check's summary, which names no person.
  async recordAlert({ level, text, recipients, reached, test = false }) {
    await this.db.run("INSERT INTO idou_admin_alerts (id, at, level, text, recipients, reached, test) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), this.now(), Object.hasOwn(HEALTH_LEVELS, level) ? level : "warning", String(text).slice(0, 500), recipients | 0, reached | 0, test ? 1 : 0]);
  }

  async prune() {
    const at = this.now();
    await this.db.run("DELETE FROM idou_admin_health WHERE at < ?", [at - STATUS_LIMITS.healthDays * DAY]);
    await this.db.run("DELETE FROM idou_admin_traffic WHERE bucket < ?", [at - STATUS_LIMITS.trafficDays * DAY]);
    await this.db.run("DELETE FROM idou_admin_alerts WHERE at < ?", [at - STATUS_LIMITS.alertDays * DAY]);
    await this.db.run("DELETE FROM idou_admin_processes WHERE beat_at < ?", [at - STATUS_LIMITS.forgetMs]);
  }
}

// Whether a process is to be believed: 在线, 可能卡住, 掉线.
export function conditionOf(beatAt, at) {
  const silent = at - beatAt;
  return silent <= STATUS_LIMITS.staleMs ? "online" : silent <= STATUS_LIMITS.goneMs ? "stale" : "gone";
}

// The p-th share of what fell in the latency cells, as the upper bound of the
// cell it falls in; OVER past the last bound ("more than 60 s"); null when
// nothing fell anywhere.
export const OVER = -1;
export function quantile(cells, share) {
  const total = cells.reduce((sum, count) => sum + count, 0);
  if (!total) return null;
  let seen = 0;
  for (const [index, count] of cells.entries()) {
    seen += count;
    if (seen >= share * total) return index < LATENCY_BOUNDS.length ? LATENCY_BOUNDS[index] : OVER;
  }
  return OVER;
}

const add = (into, counts) => {
  into.requests += counts.requests ?? 0;
  for (const outcome of OUTCOMES) into[outcome] += counts[outcome] ?? 0;
  for (const reason of REFUSALS) into.refused[reason] += counts.refused?.[reason] ?? 0;
  (counts.latency ?? []).forEach((count, index) => { if (index < into.latency.length) into.latency[index] += count; });
  return into;
};
const summary = (counts) => ({ requests: counts.requests, ok: counts.ok, cancelled: counts.cancelled, errors: counts.client + counts.upstream, upstream: counts.upstream,
  limited: counts.limited, refused: counts.refused, p50: quantile(counts.latency, 0.5), p95: quantile(counts.latency, 0.95), latency: counts.latency });

// Every process that has said anything in the last day, as the page and the
// processes check see them. `workers` answers the workers' heartbeats
// (RunQueue.workers) where the deployment has an execution pool.
export async function readProcesses({ db, workers = null, now = Date.now }) {
  const at = now();
  // A day without a word and it is forgotten -- here, not only when the rows are pruned.
  const rows = await db.all("SELECT id, role, name, host, pid, release, started_at, beat_at, state FROM idou_admin_processes WHERE beat_at >= ? ORDER BY role, name, started_at",
    [at - STATUS_LIMITS.forgetMs]);
  const processes = rows.map((row) => ({ id: row.id, role: row.role, name: row.name, host: row.host, pid: row.pid, release: row.release,
    startedAt: row.started_at, beatAt: row.beat_at, condition: conditionOf(row.beat_at, at), state: parse(row.state, {}) }));
  let workerRows = null, workerError = null;
  if (workers) {
    try { workerRows = await workers(); } catch (error) { workerError = said(error); }
    // A worker's row is written by the worker's own database role, which every
    // worker shares: taken only in the shape a worker writes it, so a forged one
    // cannot put words of its choosing into the page or an alert.
    for (const row of [...(workerRows ?? [])].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      // A beat far in the future is no worker's: it would stand in for a dead
      // one. Ten minutes leave room for a machine whose clock runs ahead.
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(row.name)) || !Number.isFinite(row.beatAt) || row.beatAt > at + 10 * 60_000) continue;
      const runs = row.state?.runs;
      processes.push({ id: String(row.worker).slice(0, 80), role: "worker", name: row.name, host: String(row.host).slice(0, 120), pid: Number(row.pid) || 0,
        release: String(row.release).slice(0, 40), startedAt: Number(row.startedAt) || 0, beatAt: row.beatAt, condition: conditionOf(row.beatAt, at),
        state: { runs: runs && Number.isFinite(runs.active) && Number.isFinite(runs.limit) ? { active: runs.active, limit: runs.limit } : null,
          rss: Number.isFinite(row.state?.rss) ? row.state.rss : null, heapUsed: Number.isFinite(row.state?.heapUsed) ? row.state.heapUsed : null,
          ...(row.state?.stopped === true ? { stopped: true } : {}) } });
    }
  }
  // Stopped cleanly: said so, and kept until it is replaced.
  for (const process of processes) if (process.state?.stopped === true) process.condition = "stopped";
  // One started again under the same name on the same machine -- after this
  // one last spoke -- replaced it, whatever this one looks like yet (a crash is
  // still "online" for a minute): not shown; counted when it had not stopped
  // cleanly. A namesake that started earlier is no successor. There is one
  // coordinator at a time, so another machine's takes over from it.
  const succeeds = (other, old) => other !== old && other.role === old.role && other.name === old.name && (other.host === old.host || old.role === "coordinator") && other.startedAt > old.beatAt;
  const replaced = processes.filter((old) => processes.some((other) => succeeds(other, old)));
  for (const old of replaced) processes.splice(processes.indexOf(old), 1);
  const restarted = replaced.filter((old) => old.condition !== "stopped");
  const live = processes.filter((process) => ["online", "stale"].includes(process.condition));
  const releases = [...new Set(live.map((process) => process.release))];
  return { at, processes, live, releases, mixed: releases.length > 1,
    restarted: restarted.map((process) => ({ name: process.name, role: process.role, at: process.beatAt })),
    workers: workers ? { reporting: (workerRows ?? []).length, error: workerError } : null };
}

// Everything the page shows, read back; `queue` answers how many runs wait.
export async function readServiceStatus({ db, workers = null, queue = null, now = Date.now }) {
  const { at, processes, live, releases, mixed, restarted, workers: workerBeats } = await readProcesses({ db, workers, now });

  // Traffic: the last day, by model and by hour.
  const since = at - DAY;
  const rows = await db.all("SELECT bucket, model, counts FROM idou_admin_traffic WHERE bucket >= ? ORDER BY bucket", [since - STATUS_LIMITS.bucketMs]);
  const byModel = new Map(), lastHour = new Map(), hours = Array.from({ length: 24 }, (_, index) => ({ at: Math.floor(at / HOUR) * HOUR - (23 - index) * HOUR, requests: 0, errors: 0, limited: 0 }));
  const refusedDay = fresh(), refusedHour = fresh();
  // Every request of the last hour, those refused before a model was chosen included.
  for (const row of rows) {
    const counts = parse(row.counts, null);
    if (!counts || row.bucket < since - STATUS_LIMITS.bucketMs) continue;
    if (row.model) add(byModel.get(row.model) ?? byModel.set(row.model, fresh()).get(row.model), counts);
    add(refusedDay, counts);
    if (row.bucket >= at - HOUR) {
      if (row.model) add(lastHour.get(row.model) ?? lastHour.set(row.model, fresh()).get(row.model), counts);
      add(refusedHour, counts);
    }
    const hour = hours.find((cell) => row.bucket >= cell.at && row.bucket < cell.at + HOUR);
    if (hour) { hour.requests += counts.requests ?? 0; hour.errors += (counts.client ?? 0) + (counts.upstream ?? 0); hour.limited += counts.limited ?? 0; }
  }
  const models = [...byModel].map(([model, counts]) => ({ model, day: summary(counts), hour: summary(lastHour.get(model) ?? fresh()) }))
    .sort((a, b) => b.day.requests - a.day.requests);
  // Which models some live process has stopped asking, by whom and why.
  const unavailable = [];
  for (const process of live) for (const entry of process.state?.unavailable ?? []) unavailable.push({ ...entry, reasonText: LASTING_REASONS[entry.reason] ?? entry.reason, process: process.name });

  // Self-checks: a strip of the last day, half-hour cells at their worst, and
  // the times in the last week something stopped being fine.
  const healthRows = await db.all("SELECT name, at, label, level, summary FROM idou_admin_health WHERE at >= ? ORDER BY name, at", [at - 7 * DAY]);
  const strips = new Map(), incidents = [];
  let open = null;
  // 48 half hours, the last of them the one now.
  const stripStart = Math.floor(at / STRIP_CELL) * STRIP_CELL - 47 * STRIP_CELL;
  for (const row of healthRows) {
    if (open && open.name !== row.name) { incidents.push(open); open = null; }
    if (row.at >= stripStart) {
      const strip = strips.get(row.name) ?? strips.set(row.name, { name: row.name, label: row.label, cells: new Array(48).fill(null) }).get(row.name);
      strip.label = row.label;
      const index = Math.floor((row.at - stripStart) / STRIP_CELL);
      if (index < 48 && (strip.cells[index] === null || HEALTH_LEVELS[row.level] > HEALTH_LEVELS[strip.cells[index]])) strip.cells[index] = row.level;
    }
    if (row.level !== "ok") {
      if (!open) open = { name: row.name, label: row.label, level: row.level, from: row.at, to: null, summary: row.summary };
      else if (HEALTH_LEVELS[row.level] > HEALTH_LEVELS[open.level]) Object.assign(open, { level: row.level, summary: row.summary });
    } else if (open) { open.to = row.at; incidents.push(open); open = null; }
  }
  if (open) incidents.push(open);
  incidents.sort((a, b) => b.from - a.from);
  const alerts = (await db.all("SELECT at, level, text, recipients, reached, test FROM idou_admin_alerts ORDER BY at DESC LIMIT 20"))
    .map((row) => ({ at: row.at, level: row.level, text: row.text, recipients: row.recipients, reached: row.reached, test: row.test === 1 || row.test === true }));

  // Capacity, from the live processes' latest beats.
  const sum = (pick) => live.reduce((total, process) => total + (Number(pick(process.state ?? {})) || 0), 0);
  // Sessions are not added up: a replica holds the ones it has served, and
  // the same session is in several. Each process's own count is on its row.
  const capacity = {
    model: { active: sum((state) => state.model?.active), limit: sum((state) => state.model?.limit), people: sum((state) => state.model?.people) },
    runs: { active: sum((state) => state.runs?.active), limit: sum((state) => state.runs?.limit) },
    queued: queue ? await queue().then((counts) => counts?.queued ?? 0, () => null) : null,
    refusedHour: refusedHour.refused, refusedDay: refusedDay.refused,
  };
  const advice = [];
  const replicas = live.filter((process) => process.role !== "worker" && process.state?.model?.limit);
  if (capacity.refusedHour.server > 0 || (capacity.model.limit && capacity.model.active / capacity.model.limit >= 0.8)) {
    advice.push({ kind: "model", text: capacity.refusedHour.server > 0
      ? `近 1 小时有 ${capacity.refusedHour.server} 个模型请求因为服务器同时在答的已满被拒（${replicas.length} 个进程共 ${capacity.model.limit} 个名额）：建议加一个模型副本，或调高 IDOU_MODEL_MAX_CONCURRENT。`
      : `正在答的模型请求已到上限的 ${Math.round(capacity.model.active / capacity.model.limit * 100)}%：持续这样时建议加一个模型副本。` });
  }
  if (capacity.queued && capacity.runs.limit && capacity.queued >= capacity.runs.limit) {
    advice.push({ kind: "runs", text: `有 ${capacity.queued} 个定时任务运行在排队，超过执行节点同时能跑的 ${capacity.runs.limit} 个：建议加一个执行节点。` });
  }
  if (capacity.refusedHour.person > 20) advice.push({ kind: "person", text: `近 1 小时有 ${capacity.refusedHour.person} 个请求因为个人同时在答的已满被拒：多半是少数人并发很高，可以在「模型、额度与功能」里看谁在用。` });

  return {
    at, processes, releases, mixed, workers: workerBeats,
    traffic: { models, hours, refused: refusedDay.refused, bounds: LATENCY_BOUNDS,
      lastHour: { requests: refusedHour.requests, errors: refusedHour.client + refusedHour.upstream, limited: refusedHour.limited } },
    unavailable,
    restarted,
    health: { strips: [...strips.values()], cellMs: STRIP_CELL, stripStart, incidents: incidents.slice(0, 50) },
    alerts, capacity, advice,
  };
}

// A check on the processes themselves: a model replica or a worker that has
// gone silent is somebody's requests or somebody's runs not happening. `read`
// answers as readProcesses.
export function processesCheck({ read }) {
  return { name: "processes", label: "服务进程", run: async () => {
    const status = await read();
    const at = status.at ?? Date.now();
    const silent = status.processes.filter((process) => process.condition === "gone");
    const stuck = status.processes.filter((process) => process.condition === "stale");
    // Stopped and not back after the time a restart takes: a release that
    // cannot start, or a unit somebody stopped.
    const away = status.processes.filter((process) => process.condition === "stopped" && at - process.beatAt > STATUS_LIMITS.goneMs);
    const live = status.processes.filter((process) => ["online", "stale"].includes(process.condition));
    // Two live with one name on one machine: one of them going silent would not show.
    const twins = [...new Set(live.map((process) => `${process.role}\n${process.name}\n${process.host}`).filter((key, index, all) => all.indexOf(key) !== index))].map((key) => key.split("\n")[1]);
    const names = (list) => list.map((process) => process.name).join("、");
    if (silent.length) return { level: "critical", summary: `${names(silent)} 超过 3 分钟没有心跳：可能已经退出，看 systemctl status 和它的日志。`, value: silent.length };
    if (away.length) return { level: "warning", summary: `${names(away)} 停止后没有再启动：新版本可能起不来，看 systemctl status 和它的日志（有意停掉的，一天后不再提示）。`, value: away.length };
    if (stuck.length) return { level: "warning", summary: `${names(stuck)} 超过 1 分钟没有心跳：可能卡住了。`, value: stuck.length };
    if (twins.length) return { level: "warning", summary: `同一台机器上有几个进程同名（${twins.join("、")}）：一个掉线时看不出来。模型副本和协调副本各设不同的 IDOU_PROCESS_NAME（或者不设），执行节点各设不同的 IDOU_WORKER_NAME。`, value: twins.length };
    return { level: "ok", summary: `${live.length} 个进程在线${status.mixed ? `，版本不一致（${status.releases.join("、")}）：升级到一半时正常，长时间这样就是有进程没重启` : ""}。`, value: 0 };
  } };
}
