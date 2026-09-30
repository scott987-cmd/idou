// What an operator is told without having to look.
//
// Found in the long-running review (2026-09-29): /healthz said "ok" for as long
// as the process answered, and nothing else said anything. A certificate
// running out, a disk filling, every scheduled run failing because the sandbox
// broke, the bot losing its permission so that no result reached anybody --
// each was found, if at all, by somebody who happened to look.
//
// Here each of those is a check, run every few minutes on the coordinator. Its
// answer is ok, warning or critical, with a sentence for the administrator and
// usually a number. The answers are on the metrics listener (metrics.js, this
// machine only), where GET /health says 503 while anything is critical; and,
// when the operator turned it on (IDOU_ADMIN_ALERTS=1), each administrator is
// sent them through the bot: when a check turns bad, again each day it stays
// bad, and once when it is fine again. A check has to say the same twice in a
// row before anybody is told, so one slow answer is not an alert.
//
// /healthz stays what it was: the desktop reads which model this server runs
// from it, and it is answered by every replica, most of which know nothing of
// the coordinator's certificates or runs.
import { statfs } from "node:fs/promises";
import { connect as connectTls } from "node:tls";
import { LASTING_REASONS } from "./model-health.js";

export const HEALTH_LEVELS = Object.freeze({ ok: 0, warning: 1, critical: 2 });
const DAY_MS = 86400_000;
const CHECK_TIMEOUT_MS = 20_000;
// The same answer twice in a row, before anybody is told either way.
const CONFIRMATIONS = 2;

const ok = (summary, value = null) => ({ level: "ok", summary, value });
const worse = (a, b) => (HEALTH_LEVELS[a] >= HEALTH_LEVELS[b] ? a : b);
const said = (error) => String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 160);
const day = (at, timeZone) => new Intl.DateTimeFormat("zh-CN", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).format(at);

export class HealthMonitor {
  // `checks`: [{ name, label, run }] -- `run` answers { level, summary, value }.
  // `notify(text)` reaches the administrators and says whether anybody got it.
  constructor({ checks, notify = null, now = Date.now, repeatMs = DAY_MS, log = () => {} }) {
    if (!Array.isArray(checks) || !checks.length) throw new Error("健康检查需要至少一项检查");
    for (const check of checks) if (!/^[a-z][a-z0-9_]*$/.test(check?.name ?? "") || typeof check.run !== "function") throw new Error(`健康检查无效：${check?.name}`);
    Object.assign(this, { checks, notify, now, repeatMs, log });
    this.results = new Map();
    this.memory = new Map(checks.map((check) => [check.name, { seen: null, streak: 0, told: "ok", toldAt: 0 }]));
    this.sweeping = null;
  }

  // Every check once; what each said, and who was told. Collapsed: a timer and
  // a caller asking at the same moment make one sweep.
  sweep() {
    this.sweeping ??= this.#sweep().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  async #sweep() {
    await Promise.all(this.checks.map(async (check) => {
      let result;
      try {
        let timer;
        result = await Promise.race([Promise.resolve().then(() => check.run()),
          new Promise((resolve) => { timer = setTimeout(() => resolve({ level: "warning", summary: `${check.label}：检查 ${CHECK_TIMEOUT_MS / 1000} 秒没有答复。` }), CHECK_TIMEOUT_MS); timer.unref?.(); })])
          .finally(() => clearTimeout(timer));
      } catch (error) { result = { level: "warning", summary: `${check.label}：检查本身出错（${said(error)}）。` }; }
      if (!Object.hasOwn(HEALTH_LEVELS, result?.level)) result = { level: "warning", summary: `${check.label}：检查没有给出结论。` };
      this.results.set(check.name, { name: check.name, label: check.label, level: result.level, summary: result.summary, value: Number.isFinite(result.value) ? result.value : null, at: this.now() });
      await this.#tell(check, result);
    }));
    return this.status();
  }

  async #tell(check, result) {
    const memory = this.memory.get(check.name);
    memory.streak = memory.seen === result.level ? memory.streak + 1 : 1;
    memory.seen = result.level;
    if (memory.streak < CONFIRMATIONS) return;
    let text = null;
    if (result.level !== "ok") {
      const escalated = HEALTH_LEVELS[result.level] > HEALTH_LEVELS[memory.told];
      const repeat = memory.told !== "ok" && this.now() - memory.toldAt >= this.repeatMs;
      if (escalated || repeat) text = `i豆 服务端${result.level === "critical" ? "严重告警" : "告警"}${escalated ? "" : "（仍未解决）"}：${result.summary}`;
    } else if (memory.told !== "ok") text = `i豆 服务端已恢复：${result.summary}`;
    if (!text) return;
    this.log(JSON.stringify({ component: "health", check: check.name, level: result.level, summary: result.summary }));
    if (typeof this.notify !== "function") { memory.told = result.level; memory.toldAt = this.now(); return; }
    // Not marked as told unless somebody was: the next sweep tries again.
    const reached = await Promise.resolve().then(() => this.notify(text)).catch(() => false);
    if (reached) { memory.told = result.level; memory.toldAt = this.now(); }
  }

  // What the checks last said, worst first; `level` is the worst of them.
  status() {
    const checks = this.checks.map((check) => this.results.get(check.name)).filter(Boolean)
      .sort((a, b) => HEALTH_LEVELS[b.level] - HEALTH_LEVELS[a.level]);
    return { level: checks.reduce((level, check) => worse(level, check.level), "ok"), checks };
  }
}

// How near a certificate is to running out, for the administrator.
function expiry({ label, until, now, warnDays, criticalDays, remedy, timeZone = "Asia/Shanghai" }) {
  const left = until - now, days = Math.floor(left / DAY_MS), value = Math.round(left / 1000);
  if (left <= 0) return { level: "critical", summary: `${label}已经过期（${day(until, timeZone)}）。${remedy}`, value };
  if (days < warnDays) return { level: days < criticalDays ? "critical" : "warning", summary: `${label}还剩 ${days} 天到期（${day(until, timeZone)}）。${remedy}`, value };
  return ok(`${label}有效，到 ${day(until, timeZone)}。`, value);
}

// A certificate this server issues itself: `validTo` answers when it runs out.
export function certificateCheck({ name, label, validTo, remedy = "", now = Date.now, warnDays = 14, criticalDays = 3 }) {
  return { name, label, run: async () => expiry({ label, until: await validTo(), now: now(), warnDays, criticalDays, remedy }) };
}

// When the certificate a public address serves runs out, read from the address
// itself: whatever renews it (certbot, a load balancer) is not this program.
// One that does not verify -- expired, another host's, an unknown issuer -- is
// critical whatever its date says.
// `address` connects somewhere other than the name, still asking for the name
// (SNI) and judging the certificate against it: this machine's own listener.
export function servedCertificate(origin, { timeoutMs = 10_000, address = null } = {}) {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host: address ?? hostname, port: Number(port || 443), servername: hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const certificate = socket.getPeerCertificate();
      const answer = { validTo: Date.parse(certificate?.valid_to), authorized: socket.authorized, error: socket.authorizationError ? String(socket.authorizationError) : null };
      socket.end();
      if (!Number.isFinite(answer.validTo)) reject(new Error("没有读到证书"));
      else resolve(answer);
    });
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`${timeoutMs / 1000} 秒没有连上`)); });
    socket.once("error", reject);
  });
}

// Read from the address itself first. A server often cannot reach its own
// public address -- the cloud's security group lets in only certain sources,
// and the server's own address is not one (the first deployment, 2026-09-30:
// both addresses unreachable from the machine that serves them) -- and then
// the same name is asked of this machine's own listener, which serves the
// certificate everybody else is served.
export function publicCertificateCheck({ origin, now = Date.now, read = servedCertificate }) {
  const host = new URL(origin).host, label = `${host} 的 HTTPS 证书`;
  return { name: `public_certificate_${host.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`, label, run: async () => {
    let served, where = "";
    try { served = await read(origin); }
    catch (error) {
      try { served = await read(origin, { address: "127.0.0.1" }); where = "（从本机的监听读到）"; }
      catch { return { level: "warning", summary: `连不上 ${host} 读它的 HTTPS 证书（${said(error)}），本机的监听也没有答复。` }; }
    }
    if (!served.authorized) return { level: "critical", summary: `${label}不被信任（${served.error ?? "原因不明"}）${where}，用户会打不开。`, value: Math.round((served.validTo - now()) / 1000) };
    const verdict = expiry({ label, until: served.validTo, now: now(), warnDays: 21, criticalDays: 7, remedy: "请确认证书的自动续期（例如 certbot）在运行。" });
    return { ...verdict, summary: `${verdict.summary}${where}` };
  } };
}

// Free space where this server keeps its data.
export function diskCheck({ path, stat = statfs, warnRatio = 0.1, criticalRatio = 0.03, warnBytes = 2 * 1024 ** 3, criticalBytes = 512 * 1024 ** 2 }) {
  return { name: "disk", label: "数据盘", run: async () => {
    const info = await stat(path);
    const free = Number(info.bavail) * Number(info.bsize), total = Number(info.blocks) * Number(info.bsize);
    const ratio = total > 0 ? free / total : 0;
    const line = `${path} 所在的盘还剩 ${(free / 1024 ** 3).toFixed(1)} GB（${Math.round(ratio * 100)}%）`;
    if (free < criticalBytes || ratio < criticalRatio) return { level: "critical", summary: `${line}，快满了：写不进去时登录、定时任务和发布都会失败。`, value: free };
    if (free < warnBytes || ratio < warnRatio) return { level: "warning", summary: `${line}。`, value: free };
    return ok(`${line}。`, free);
  } };
}

// What happened in the last day, counted as it happens: runs, the results the
// bot pushed, the tasks suspended. In memory -- a restart starts the day over,
// which for an alert is only a delay.
export class EventTally {
  constructor({ now = Date.now, windowMs = DAY_MS } = {}) { Object.assign(this, { now, windowMs }); this.events = []; }
  record(kind, detail = null) { this.events.push({ kind, detail, at: this.now() }); this.#trim(); }
  #trim() { const since = this.now() - this.windowMs; while (this.events.length && this.events[0].at < since) this.events.shift(); }
  count(kind) { this.#trim(); return this.events.filter((event) => event.kind === kind).length; }
  last(kind) { this.#trim(); return this.events.findLast((event) => event.kind === kind) ?? null; }
}

// Most of the day's scheduled runs failing is the server's problem, not one
// task's: a broken sandbox, the egress, the model. Each person sees their own
// failures; this is for the one who can fix all of them. Counts only: what a
// run said is its owner's, and names their documents.
export function scheduledRunsCheck({ tally, least = 4 }) {
  return { name: "scheduled_runs", label: "定时任务", run: () => {
    const failed = tally.count("failed"), total = failed + tally.count("completed");
    const rate = total ? failed / total : 0;
    if (total >= least && failed === total) return { level: "critical", summary: `最近一天的 ${total} 次定时任务运行全部失败，原因见服务端日志。`, value: rate };
    if (total >= least && rate >= 0.5) return { level: "warning", summary: `最近一天的 ${total} 次定时任务运行有 ${failed} 次失败，原因见服务端日志。`, value: rate };
    return ok(`最近一天运行 ${total} 次，失败 ${failed} 次。`, rate);
  } };
}

// The bot not reaching owners: nearly always its permission (99991672), which
// only an administrator can grant.
export function pushCheck({ tally, least = 3 }) {
  return { name: "result_push", label: "结果推送", run: () => {
    const failed = tally.count("push_failed"), total = failed + tally.count("push_sent");
    const rate = total ? failed / total : 0;
    if (total >= least && rate >= 0.5) return { level: "warning", summary: `最近一天机器人推送定时任务结果 ${total} 次，${failed} 次没有送到。最近的原因：${tally.last("push_failed")?.detail ?? "见服务端日志"}`, value: rate };
    return ok(`最近一天推送 ${total} 次，没送到 ${failed} 次。`, rate);
  } };
}

// Each person is told when their own tasks are suspended (schedule-reminders.js).
// Many at once is something else: Feishu refusing renewals, a login provider
// change.
export function suspensionsCheck({ tally, many = 5 }) {
  return { name: "schedule_suspensions", label: "定时任务挂起", run: () => {
    const suspended = tally.count("suspended");
    if (suspended >= many) return { level: "warning", summary: `最近一天有 ${suspended} 个定时任务因为授权失效被挂起，可能是飞书续期出了问题。最近一次：${tally.last("suspended")?.detail ?? "见服务端日志"}`, value: suspended };
    return ok(`最近一天挂起 ${suspended} 个。`, suspended);
  } };
}

// The Drive ledger refuses every upload once full (drive-budget.js).
export function ledgerCheck({ size, capacity }) {
  return { name: "drive_ledger", label: "云盘额度账本", run: async () => {
    const rows = await size();
    const used = rows / capacity;
    const line = `云盘额度账本用了 ${rows} / ${capacity} 条（${Math.round(used * 100)}%）`;
    if (used >= 0.95) return { level: "critical", summary: `${line}，写满后所有报告和上传都会被拒。`, value: used };
    if (used >= 0.8) return { level: "warning", summary: `${line}。`, value: used };
    return ok(`${line}。`, used);
  } };
}

export function sandboxCheck({ ready }) {
  return { name: "sandbox", label: "定时任务沙箱", run: () => (ready()
    ? ok("定时任务沙箱可用。", 1)
    : { level: "critical", summary: "定时任务沙箱不可用，到点的任务都会记为失败（原因见服务端启动日志）。", value: 0 }) };
}

export function databaseCheck({ ping }) {
  return { name: "database", label: "共享数据库", run: async () => {
    try { await ping(); return ok("共享数据库可用。", 1); }
    catch (error) { return { level: "critical", summary: `共享数据库连不上（${said(error)}）。`, value: 0 }; }
  } };
}

// The model upstreams this server has been passing over (model-health.js):
// the default one is every conversation's; another is somebody's choice.
export function modelCheck({ health, defaultModel }) {
  return { name: "model_upstream", label: "模型上游", run: () => {
    const passed = health.unavailable();
    if (!passed.length) return ok("模型上游都可用。", 0);
    const words = passed.map((entry) => `${entry.model}（${LASTING_REASONS[entry.reason] ?? entry.reason}）`).join("、");
    const level = passed.some((entry) => entry.model === defaultModel) ? "critical" : "warning";
    return { level, summary: `这些模型暂时用不了：${words}。${level === "critical" ? "默认模型的请求正在转给其他模型。" : ""}`, value: passed.length };
  } };
}

// What the coordinator checks, from what this server has: its data disk and
// public addresses always; the egress certificate, sandbox, runs, pushes and
// suspensions with scheduled tasks; the ledger, the shared database and the
// model upstreams where there are any.
export function coordinatorChecks({ dataDirectory, origins = [], scheduled = null, tally = null, ledger = null, capacity = null,
  database = null, models = null, defaultModel = null, now = Date.now }) {
  const checks = [diskCheck({ path: dataDirectory })];
  const served = new Set(origins.filter((origin) => typeof origin === "string" && origin.startsWith("https:")).map((origin) => new URL(origin).origin));
  for (const origin of served) checks.push(publicCertificateCheck({ origin, now }));
  if (scheduled) {
    checks.push(
      // Re-issued at 14 days (egress-tls.js), looked at every six hours: past
      // ten days left the renewal is not working.
      certificateCheck({ name: "egress_certificate", label: "定时任务出口证书", now, warnDays: 10,
        validTo: async () => scheduled.egressCertificate().validTo,
        remedy: "它应在到期前 14 天自动续签，续签没有成功，原因见服务端日志；到期那天所有定时任务都会失败。" }),
      sandboxCheck({ ready: () => scheduled.sandboxReady }));
    if (tally) checks.push(scheduledRunsCheck({ tally }), pushCheck({ tally }), suspensionsCheck({ tally }));
  }
  if (ledger && capacity) checks.push(ledgerCheck({ size: () => ledger.size(), capacity }));
  if (database) checks.push(databaseCheck({ ping: () => database.query("SELECT 1") }));
  if (models && defaultModel) checks.push(modelCheck({ health: models, defaultModel }));
  return checks;
}

// Each administrator, through the bot, one at a time (feishu-bot.js takes open
// ids only). True when anybody got it; who did not, and why, goes to the log.
export function alertAdministrators({ directory, bot, log = () => {} }) {
  return async (text) => {
    let reached = 0;
    for (const openId of await directory.recipients()) {
      const answer = await bot.sendText({ openId, text }).catch((error) => ({ sent: false, reason: said(error) }));
      if (answer.sent) reached += 1;
      else log(JSON.stringify({ component: "health", event: "alert-not-sent", reason: answer.reason ?? null }));
    }
    return reached > 0;
  };
}
