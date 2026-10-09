import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventTally, HealthMonitor, certificateCheck, databaseCheck, diskCheck, ledgerCheck, modelCheck, publicCertificateCheck,
  pushCheck, sandboxCheck, scheduledRunsCheck, servedCertificate, suspensionsCheck } from "../src/control-plane/health-monitor.js";
import { ensureEgressCertificate } from "../src/control-plane/egress-tls.js";

// What an operator is told without having to look (health-monitor.js). Found in
// the long-running review (2026-09-29): /healthz said "ok" while the process
// answered, and a certificate running out, a full disk, every run failing or
// the bot losing its permission reached nobody.
const DAY = 86400_000;

function monitor(levels, { notify = true } = {}) {
  const clock = { at: Date.parse("2026-10-01T02:00:00Z") };
  const said = [];
  const state = { level: levels[0] };
  const check = { name: "disk", label: "数据盘", run: () => ({ level: state.level, summary: `数据盘：${state.level}` }) };
  const reach = { ok: true };
  const health = new HealthMonitor({ checks: [check], now: () => clock.at, log: () => {},
    notify: notify ? async (text) => { if (!reach.ok) return false; said.push(text); return true; } : null });
  return { health, clock, said, state, reach };
}

test("a check is told once it says the same twice, again each day it stays bad, and once when it is fine", async () => {
  const { health, clock, said, state } = monitor(["warning"]);
  await health.sweep();
  assert.deepEqual(said, [], "one answer is not an alert");
  await health.sweep();
  assert.deepEqual(said, ["i豆 服务端告警：数据盘：warning"]);
  await health.sweep();
  assert.equal(said.length, 1, "not every sweep");

  state.level = "critical";
  await health.sweep(); await health.sweep();
  assert.equal(said.at(-1), "i豆 服务端严重告警：数据盘：critical", "worse is told at once, after its two answers");

  clock.at += DAY;
  await health.sweep();
  assert.equal(said.at(-1), "i豆 服务端严重告警（仍未解决）：数据盘：critical", "and again the next day");
  assert.equal(said.length, 3);

  state.level = "ok";
  await health.sweep();
  assert.equal(said.length, 3, "one good answer is not a recovery");
  await health.sweep();
  assert.equal(said.at(-1), "i豆 服务端已恢复：数据盘：ok");
  await health.sweep();
  assert.equal(said.length, 4);
});

test("a problem nobody could be told about is tried again at the next sweep", async () => {
  const { health, said, reach } = monitor(["critical"]);
  reach.ok = false;
  await health.sweep(); await health.sweep();
  assert.deepEqual(said, []);
  reach.ok = true;
  await health.sweep();
  assert.deepEqual(said, ["i豆 服务端严重告警：数据盘：critical"]);
});

test("a check that throws, hangs or answers nonsense is a warning of its own, never a crash", async () => {
  const health = new HealthMonitor({ checks: [
    { name: "broken", label: "坏的检查", run: () => { throw new Error("boom"); } },
    { name: "nonsense", label: "乱答的检查", run: () => ({ level: "fine" }) },
  ] });
  const status = await health.sweep();
  assert.equal(status.level, "warning");
  assert.deepEqual(status.checks.map((check) => check.summary).sort(), ["乱答的检查：检查没有给出结论。", "坏的检查：检查本身出错（boom）。"]);
});

test("certificates: fine far from the end, a warning within two weeks, critical within days and once expired", async () => {
  const now = Date.parse("2026-10-01T02:00:00Z");
  const level = async (days) => (await certificateCheck({ name: "egress_certificate", label: "出口证书", now: () => now, validTo: async () => now + days * DAY }).run()).level;
  assert.equal(await level(60), "ok");
  assert.equal(await level(10), "warning");
  assert.equal(await level(2), "critical");
  assert.equal(await level(-1), "critical");
  const said = await certificateCheck({ name: "egress_certificate", label: "出口证书", now: () => now, validTo: async () => now + 2.5 * DAY, remedy: "自动续签没有成功。" }).run();
  assert.equal(said.summary, "出口证书还剩 2 天到期（2026/10/3）。自动续签没有成功。");
});

test("a public address's certificate is read from the address, and one that does not verify is critical", async (t) => {
  const now = Date.parse("2026-10-01T02:00:00Z");
  const read = (answer) => async () => answer;
  const check = (answer, at = now) => publicCertificateCheck({ origin: "https://idou.example.com", now: () => at, read: read(answer) }).run();
  assert.equal((await check({ validTo: now + 90 * DAY, authorized: true })).level, "ok");
  assert.equal((await check({ validTo: now + 14 * DAY, authorized: true })).level, "warning", "three weeks for a public one: certbot renews at 30 days");
  assert.equal((await check({ validTo: now + 90 * DAY, authorized: false, error: "Hostname/IP does not match certificate's altnames" })).level, "critical");
  assert.match((await publicCertificateCheck({ origin: "https://idou.example.com", read: async () => { throw new Error("ECONNREFUSED"); } }).run()).summary,
    /连不上 idou\.example\.com 读它的 HTTPS 证书（ECONNREFUSED），本机的监听也没有答复/);
  // A server that cannot reach its own public address -- a security group
  // letting in only certain sources, as on the first deployment -- asks its own
  // listener for the same name, and says so.
  const asked = [];
  const local = await publicCertificateCheck({ origin: "https://idou.example.com", now: () => now, read: async (origin, options = {}) => {
    asked.push(options.address ?? null);
    if (!options.address) throw new Error("10 秒没有连上");
    return { validTo: now + 90 * DAY, authorized: true };
  } }).run();
  assert.deepEqual(asked, [null, "127.0.0.1"]);
  assert.equal(local.level, "ok");
  assert.match(local.summary, /有效，到 .*（从本机的监听读到）/);

  // And the reading itself, against a real TLS listener.
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-health-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const issued = await ensureEgressCertificate({ directory });
  const server = createServer({ key: issued.key, cert: issued.cert }, (req, res) => res.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const served = await servedCertificate(`https://127.0.0.1:${server.address().port}`);
  assert.ok(served.validTo > Date.now() + 80 * DAY, "the date the certificate says");
  assert.equal(served.authorized, false, "issued by a CA this process does not trust");
  const byAddress = await servedCertificate(`https://egress.idou.internal:${server.address().port}`, { address: "127.0.0.1" });
  assert.equal(byAddress.validTo, served.validTo, "the same listener, reached by address and asked for the name");
});

test("disk: a warning under 10% or 2 GB free, critical under 3% or 512 MB", async () => {
  const GB = 1024 ** 3;
  const stat = (free, total) => async () => ({ bavail: free / 4096, bsize: 4096, blocks: total / 4096 });
  const level = async (free, total) => (await diskCheck({ path: "/var/lib/idou", stat: stat(free, total) }).run()).level;
  assert.equal(await level(50 * GB, 100 * GB), "ok");
  assert.equal(await level(8 * GB, 100 * GB), "warning");
  assert.equal(await level(1.5 * GB, 10 * GB), "warning");
  assert.equal(await level(2 * GB, 100 * GB), "critical");
  assert.equal(await level(0.25 * GB, 4 * GB), "critical");
});

test("runs, pushes and suspensions are counted over the last day, and only a pattern is an alert", async () => {
  const clock = { at: 0 };
  const tally = new EventTally({ now: () => clock.at });
  const runs = scheduledRunsCheck({ tally }), push = pushCheck({ tally }), suspensions = suspensionsCheck({ tally });
  for (let i = 0; i < 3; i += 1) tally.record("failed");
  assert.equal((await runs.run()).level, "ok", "three runs are too few to say anything");
  tally.record("failed");
  assert.equal((await runs.run()).level, "critical", "every run failing");
  tally.record("completed"); tally.record("completed"); tally.record("completed");
  assert.equal((await runs.run()).level, "warning", "most of them failing");
  tally.record("failed", "没有追加到文档《季度预算》：飞书拒绝");
  assert.doesNotMatch((await runs.run()).summary, /季度预算/, "never a run's own words: they are its owner's");
  for (let i = 0; i < 4; i += 1) tally.record("completed");
  assert.equal((await runs.run()).level, "ok");

  tally.record("push_failed", "400 code=99991672 Access denied"); tally.record("push_failed", "400 code=99991672 Access denied"); tally.record("push_sent");
  assert.equal((await push.run()).level, "warning");
  assert.match((await push.run()).summary, /最近的原因：400 code=99991672/);

  for (let i = 0; i < 4; i += 1) tally.record("suspended", "无人值守授权已到期");
  assert.equal((await suspensions.run()).level, "ok");
  tally.record("suspended", "飞书拒绝续期");
  assert.equal((await suspensions.run()).level, "warning");

  clock.at += DAY + 1;
  assert.deepEqual([(await runs.run()).level, (await push.run()).level, (await suspensions.run()).level], ["ok", "ok", "ok"], "a day later it has all passed");
});

test("the ledger, the sandbox, the database and the model upstreams", async () => {
  assert.equal((await ledgerCheck({ size: async () => 500, capacity: 1000 }).run()).level, "ok");
  assert.equal((await ledgerCheck({ size: async () => 850, capacity: 1000 }).run()).level, "warning");
  assert.equal((await ledgerCheck({ size: async () => 960, capacity: 1000 }).run()).level, "critical");
  assert.equal((await sandboxCheck({ ready: () => true }).run()).level, "ok");
  assert.equal((await sandboxCheck({ ready: () => false }).run()).level, "critical");
  assert.equal((await databaseCheck({ ping: async () => {} }).run()).level, "ok");
  assert.match((await databaseCheck({ ping: async () => { throw new Error("ECONNREFUSED"); } }).run()).summary, /共享数据库连不上（ECONNREFUSED）/);
  const passed = (entries) => ({ unavailable: () => entries });
  assert.equal((await modelCheck({ health: passed([]), defaultModel: "MiniMax-M3" }).run()).level, "ok");
  assert.equal((await modelCheck({ health: passed([{ model: "glm-5.3", reason: "billing" }]), defaultModel: "MiniMax-M3" }).run()).level, "warning");
  const down = await modelCheck({ health: passed([{ model: "MiniMax-M3", reason: "subscription" }]), defaultModel: "MiniMax-M3" }).run();
  assert.equal(down.level, "critical");
  assert.match(down.summary, /MiniMax-M3（上游订阅无效或已过期）/);
});

test("an alert goes to each administrator through the bot, and counts as told when anybody got it", async () => {
  const { alertAdministrators } = await import("../src/control-plane/health-monitor.js");
  const sent = [], logged = [];
  const bot = { sendText: async ({ openId, text }) => { if (openId === "ou_gone") return { sent: false, reason: "400 code=230013 user not found" }; sent.push({ openId, text }); return { sent: true }; } };
  const notify = alertAdministrators({ directory: { recipients: async () => ["ou_one", "ou_gone"] }, bot, log: (line) => logged.push(line) });
  assert.equal(await notify("i豆 服务端告警：数据盘还剩 1.2 GB（3%）。"), true);
  assert.deepEqual(sent, [{ openId: "ou_one", text: "i豆 服务端告警：数据盘还剩 1.2 GB（3%）。" }]);
  assert.match(logged[0], /alert-not-sent.*230013/);
  const nobody = alertAdministrators({ directory: { recipients: async () => ["ou_gone"] }, bot });
  assert.equal(await nobody("x"), false, "nobody reached: tried again at the next sweep");
  // Each one sent is kept for the console's list, with how many got it.
  const kept = [];
  const listed = alertAdministrators({ directory: { recipients: async () => ["ou_one", "ou_gone"] }, bot, sent: (entry) => kept.push(entry) });
  await listed("i豆 服务端严重告警：备份失败", { level: "critical" });
  assert.deepEqual(kept, [{ text: "i豆 服务端严重告警：备份失败", level: "critical", recipients: 2, reached: 1 }]);
});

// docs/service-status.md §3: every sweep is kept, so the page can say since when.
test("every sweep's answers are handed on to be kept, and failing to keep them fails nothing", async () => {
  const kept = [], logged = [];
  const check = { name: "disk", label: "数据盘", run: () => ({ level: "warning", summary: "数据盘还剩 1.5 GB" }) };
  const health = new HealthMonitor({ checks: [check], record: (status) => kept.push(status), log: (line) => logged.push(line) });
  await health.sweep();
  assert.deepEqual(kept.map((status) => status.checks.map((entry) => [entry.name, entry.level])), [[["disk", "warning"]]]);
  const broken = new HealthMonitor({ checks: [check], record: () => { throw new Error("database gone"); }, log: (line) => logged.push(line) });
  assert.equal((await broken.sweep()).level, "warning");
  assert.match(logged.at(-1), /history-not-kept/);
});

// docs/service-status.md §4: the last backup, from what bin/backup.js wrote beside it.
test("backup: fine within a day and a half of one that worked, then a warning, then critical; one that failed is critical", async () => {
  const { backupCheck } = await import("../src/control-plane/health-monitor.js");
  const at = Date.parse("2026-10-03T08:00:00Z");
  const success = (hoursAgo) => ({ ok: true, endedAt: new Date(at - hoursAgo * 3600_000).toISOString(), files: 41, bytes: 52 * 1048576, sealed: true, shipped: true });
  const level = async (status) => backupCheck({ dir: "/home/idou/backups", now: () => at, read: async () => status }).run();
  const none = await level(null);
  assert.equal(none.level, "warning");
  assert.match(none.summary, /还没有备份记录/);
  const fine = await level({ last: success(20), lastSuccess: success(20) });
  assert.deepEqual([fine.level, fine.value], ["ok", 20 * 3600]);
  assert.match(fine.summary, /20 小时前，41 个文件，52\.0 MB，加密副本已送出/);
  assert.equal((await level({ last: success(40), lastSuccess: success(40) })).level, "warning");
  assert.equal((await level({ last: success(80), lastSuccess: success(80) })).level, "critical");
  const failed = await level({ last: { ok: false, endedAt: new Date(at).toISOString(), error: "pg_dump 没有完成" }, lastSuccess: success(2) });
  assert.equal(failed.level, "critical");
  assert.match(failed.summary, /最近一次备份失败了（pg_dump 没有完成），最近一次成功是 2 小时前/);
  const coordinator = (await import("../src/control-plane/health-monitor.js")).coordinatorChecks({ dataDirectory: "/var/lib/idou", backupDir: "/home/idou/backups" });
  assert.deepEqual(coordinator.map((check) => check.name), ["disk", "backup"]);
});

test("the coordinator checks what this server has, and nothing it does not", async () => {
  const { coordinatorChecks } = await import("../src/control-plane/health-monitor.js");
  const names = (options) => coordinatorChecks({ dataDirectory: "/var/lib/idou", ...options }).map((check) => check.name);
  assert.deepEqual(names({ origins: [null, "http://127.0.0.1:3041"] }), ["disk"], "a loopback origin has no certificate to read");
  assert.deepEqual(names({ origins: ["https://idou.example.com", "https://idou.example.com/", "https://sites.example.com:8443"] }),
    ["disk", "public_certificate_idou_example_com", "public_certificate_sites_example_com_8443"], "each address once");
  const scheduled = { egressCertificate: () => ({ validTo: Date.now() + 80 * DAY }), sandboxReady: true };
  assert.deepEqual(names({ scheduled, tally: new EventTally(), ledger: { size: async () => 1 }, capacity: 10, database: { query: async () => {} },
    models: { unavailable: () => [] }, defaultModel: "MiniMax-M3" }),
  ["disk", "egress_certificate", "sandbox", "scheduled_runs", "result_push", "schedule_suspensions", "drive_ledger", "database", "model_upstream"]);
});
