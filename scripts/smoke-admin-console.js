// The administration console, stood up for real at the scale it is designed
// for, and looked at (docs/admin-console.md §12).
//
//   node scripts/smoke-admin-console.js [--people 100000] [--serve] [--postgres]
//
// Everything here is the production code -- the listener, the routes, the
// stores, the page -- on a SQLite administration database in a temporary
// directory (or, with --postgres, a PostgreSQL of its own), filled with a
// synthetic organisation: a hundred thousand people
// with made-up names and open_ids, their usage over a month, a month of audit
// events. The one thing held still is Feishu's sign-in, which answers as the
// synthetic owner. Nothing is sent anywhere; no paid call is made.
//
// It times the queries every page makes, then opens every page in a headless
// Chromium, checks that nothing failed and nothing spills sideways, and
// writes screenshots to docs/evidence/admin-console/. With --serve it keeps
// running so a person can look at it: the address is printed.
import "../src/adopt-legacy-env.js";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { openAdminDatabase } from "../src/control-plane/admin-db.js";
import { AccessList } from "../src/control-plane/access-list.js";
import { AuditLog } from "../src/control-plane/audit-log.js";
import { PeopleDirectory } from "../src/control-plane/people-directory.js";
import { AdminRoles } from "../src/control-plane/admin-roles.js";
import { AdminDirectory } from "../src/control-plane/admin-directory.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { ModelUsage, utcDay } from "../src/control-plane/model-usage.js";
import { createAdminServer, loadAdminAssets } from "../src/control-plane/admin-server.js";
import { createAdminApi } from "../src/control-plane/admin-api.js";
import { systemState } from "../src/control-plane/admin-console.js";
import { PolicyStore, PolicyEngine } from "../src/control-plane/policy.js";
import { OrgDirectory } from "../src/control-plane/org-directory.js";
import { ScheduleStore } from "../src/control-plane/schedule-store.js";
import { SiteSafety, scheduleRescans } from "../src/control-plane/site-safety.js";
import { SkillRegistry } from "../src/control-plane/skill-registry.js";
import { SkillGovernance } from "../src/control-plane/skill-governance.js";
import { ProcessStatus, StatusHistory, TrafficMeter, processesCheck, readProcesses, readServiceStatus } from "../src/control-plane/process-status.js";
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";

const argument = (name, fallback) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : fallback; };
const COUNT = Number(argument("--people", 100_000));
const SERVE = process.argv.includes("--serve");
// --postgres: the administration database on a PostgreSQL of this run's own
// (test/helpers/postgres.js -- a temporary directory, a Unix socket, nobody
// else's server), as a deployment with IDOU_DATABASE_URL has it. The usage
// ledger stays on SQLite here.
const POSTGRES = process.argv.includes("--postgres");
const TENANT = "tenant_synthetic";
const OWNER = "ou_synthetic_owner";
const DAY = 86_400_000;
const now = Date.now();
const evidence = path.resolve("docs/evidence/admin-console");
const root = await mkdtemp(path.join(os.tmpdir(), "idou-admin-smoke-"));

// A made-up organisation. Deterministic, so two runs look the same.
// mulberry32: 32-bit arithmetic throughout. A textbook LCG written with
// ordinary multiplication loses its low bits past 2^53 and repeats within a few
// hundred draws -- every day of a person's usage came out the same height.
let seed = 20261002;
const random = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const SURNAMES = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤".split("");
const GIVEN = "伟芳娜敏静丽强磊军洋勇艳杰涛明超秀霞平刚桂英华建国志红晓梅辉鹏飞宇浩然欣怡子轩梓涵一诺雨桐思远嘉怡俊杰文博天佑若曦晨阳".split("");
const name = () => SURNAMES[Math.floor(random() * SURNAMES.length)] + GIVEN[Math.floor(random() * GIVEN.length)] + (random() < 0.6 ? GIVEN[Math.floor(random() * GIVEN.length)] : "");
const openId = (index) => `ou_${createHash("sha256").update(`synthetic-${index}`).digest("hex").slice(0, 30)}`;
const timed = async (label, work) => { const start = performance.now(); const value = await work(); const ms = performance.now() - start; return { label, ms, value }; };

let server = null, browser = null;
const closers = [];
try {
  let db;
  if (POSTGRES) {
    const { testPostgres } = await import("../test/helpers/postgres.js");
    const { default: pg } = await import("pg");
    // Stopped last: the closers run in reverse, and this is the first.
    const postgres = await testPostgres({ after: (stop) => closers.push(stop) });
    const settings = await postgres.database();
    const pool = new pg.Pool({ ...settings, max: 8 }); pool.on("error", () => {});
    const connect = async () => { const client = new pg.Client(settings); client.on("error", () => {}); await client.connect(); return client; };
    db = await openAdminDatabase({ pool, connect });
    closers.push(async () => { await db.close(); await pool.end(); });
  } else {
    db = await openAdminDatabase({ file: path.join(root, "admin.sqlite") });
    closers.push(() => db.close());
  }
  const access = await AccessList.open({ db }); closers.push(() => access.close());
  const audit = await AuditLog.open({ db }); closers.push(() => audit.close());
  const people = await PeopleDirectory.open({ db }); closers.push(() => people.close());
  const usage = await ModelUsage.open({ file: path.join(root, "model-usage.sqlite") }); closers.push(() => usage.close());

  // ---------------------------------------------------------------- seed
  const seeding = performance.now();
  const ids = Array.from({ length: COUNT }, (_, index) => openId(index));
  const names = ids.map(() => name());
  await db.transaction(async (tx) => {
    for (let at = 0; at < COUNT; at += 500) {
      const rows = [];
      for (let index = at; index < Math.min(COUNT, at + 500); index += 1) {
        const first = now - Math.floor(random() * 300) * DAY - Math.floor(random() * DAY);
        // Most people were here recently; a long tail has not been for months.
        const last = Math.min(now - 60_000, Math.max(first, now - Math.floor(-Math.log(1 - random() * 0.999) * 6 * DAY)));
        rows.push(TENANT, ids[index], names[index], names[index], first, last, `0.1.0-202609${random() < 0.8 ? "30.266" : "28.254"}`, 1 + Math.floor(random() * 80), now);
      }
      await tx.run(`INSERT INTO idou_admin_people (tenant, user_id, name, name_key, first_seen_at, last_seen_at, client, sign_ins, updated_at)
        VALUES ${Array.from({ length: rows.length / 9 }, () => "(?,?,?,?,?,?,?,?,?)").join(",")}`, rows);
    }
  });
  // The owner, by name, so the page greets somebody.
  people.seen({ tenantId: TENANT, userId: OWNER, name: "林管理", client: "0.1.0-20261002.267", signIn: true });
  await people.flush();
  // About one in a hundred has left and been disabled; a few were signed out.
  const disabled = ids.filter(() => random() < 0.012).map((userId) => ({ tenantId: TENANT, userId }));
  for (let at = 0; at < disabled.length; at += 1000) await access.disable(disabled.slice(at, at + 1000), { reason: random() < 0.8 ? "离职" : "账号异常，安全排查中", by: { userId: OWNER, name: "林管理" } });
  await access.signOut(ids.slice(5, 25).map((userId) => ({ tenantId: TENANT, userId })), { by: { userId: OWNER, name: "林管理" } });
  // A month of usage for the people active in it.
  const ledger = usage.db;
  const insert = ledger.prepare(`INSERT INTO model_usage (person, tenant, user_id, model, day, requests, input_tokens, output_tokens, total_tokens, downgraded, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(person, model, day) DO NOTHING`);
  let usageRows = 0;
  ledger.exec("BEGIN");
  for (let day = 0; day < 31; day += 1) {
    const at = now - day * DAY, weekend = [0, 6].includes(new Date(at).getUTCDay());
    const active = Math.floor(COUNT * (weekend ? 0.06 : 0.17) * (0.9 + random() * 0.2));
    for (let n = 0; n < active; n += 1) {
      const index = Math.floor(random() ** 1.6 * COUNT), userId = ids[index];
      const person = createHash("sha256").update(`${TENANT}\n${userId}`).digest("hex");
      for (const model of random() < 0.35 ? ["MiniMax-M3", "GLM-5.3"] : [random() < 0.7 ? "MiniMax-M3" : "GLM-5.3"]) {
        const requests = 1 + Math.floor(random() * 40), input = requests * Math.floor(2000 + random() * 9000), output = requests * Math.floor(300 + random() * 1500);
        insert.run(person, TENANT, userId, model, utcDay(at), requests, input, output, input + output, random() < 0.03 ? 1 : 0, at - Math.floor(random() * 8 * 3600_000));
        usageRows += 1;
      }
    }
  }
  ledger.exec("COMMIT");
  // A month of the audit trail.
  const ACTIONS = [["auth", "auth.resume", 30], ["auth", "auth.sign-in", 6], ["auth", "auth.sign-out", 1], ["feishu", "feishu.write", 18], ["feishu", "feishu.send", 6],
    ["feishu", "feishu.delete", 1], ["schedule", "schedule.run", 9], ["schedule", "schedule.create", 1], ["site", "site.publish", 1], ["media", "media.image", 2]];
  const weights = ACTIONS.reduce((sum, [, , weight]) => sum + weight, 0);
  const pick = () => { let roll = random() * weights; for (const action of ACTIONS) { roll -= action[2]; if (roll <= 0) return action; } return ACTIONS[0]; };
  const auditCount = Math.min(300_000, COUNT * 3);
  for (let n = 0; n < auditCount; n += 1) {
    const [category, action] = pick(), index = Math.floor(random() ** 1.4 * COUNT);
    const refused = action === "auth.resume" && random() < 0.01;
    audit.record({ at: now - Math.floor(random() * 30 * DAY), tenant: TENANT, category, action, outcome: refused ? "refused" : random() < 0.004 ? "failed" : "ok", source: category,
      actor: { kind: "person", id: ids[index], name: names[index] }, target: category === "feishu" ? { kind: "document", id: `doxcn${randomBytes(6).toString("hex")}`, name: "" } : {},
      detail: refused ? { reason: "signed_out" } : category === "feishu" ? { kind: action.split(".")[1] } : {} });
    if (audit.pending >= 5000) await audit.flush();
  }
  await audit.flush();
  for (const [index, userId] of disabled.slice(0, 40).entries()) {
    await audit.write({ at: now - index * 3_600_000, tenant: TENANT, category: "admin", action: "admin.person.disable", source: "admin-console", address: "10.8.0.12",
      actor: { kind: "admin", id: OWNER, name: "林管理" }, target: { kind: "person", id: userId.userId, name: names[ids.indexOf(userId.userId)] }, detail: { reason: "离职", role: "owner" } });
  }
  const seconds = ((performance.now() - seeding) / 1000).toFixed(1);
  process.stdout.write(`${POSTGRES ? "管理库在 PostgreSQL（用量账本仍在 SQLite）。" : "管理库在 SQLite。"}合成数据：${COUNT.toLocaleString()} 人，${disabled.length.toLocaleString()} 人已停用，用量 ${usageRows.toLocaleString()} 行，审计 ${(auditCount + 40).toLocaleString()} 条（${seconds} 秒）\n`);

  // ---------------------------------------------------------------- serve
  const directory = new AdminDirectory({ users: [OWNER] });
  const roles = await AdminRoles.open({ db, directory, access }); closers.push(() => roles.close());
  await roles.grant({ tenantId: TENANT, userId: ids[1], role: "admin", by: { userId: OWNER, name: "林管理" }, note: "人力资源部" });
  await roles.grant({ tenantId: TENANT, userId: ids[2], role: "auditor", by: { userId: OWNER, name: "林管理" }, note: "安全部，负责季度审计" });
  const sessions = new SessionRegistry({ access });
  for (const deviceId of ["a1b2c3d4e5f6", "f6e5d4c3b2a1"]) sessions.issue({ tenantId: TENANT, userId: ids[0], deviceId, authProvider: "feishu", appId: "cli_synthetic", deviceProof: "ed25519-login" });
  // Sites: what a registry answers, in memory, holds included (site-registry.js).
  const siteRecords = [
    { id: "6f0d2c1e-0000-4000-8000-000000000001", name: "销售周报看板", ownerId: ids[3], tenantId: TENANT, share: { scope: "tenant" }, source: { kind: "base" }, bytes: 48_211, createdAt: now - 3 * DAY, publishedAt: now - 3 * DAY },
    { id: "6f0d2c1e-0000-4000-8000-000000000002", name: "新人入职指南", ownerId: ids[4], tenantId: TENANT, share: { scope: "anyone" }, bytes: 120_400, createdAt: now - 12 * DAY, publishedAt: now - 2 * DAY },
    { id: "6f0d2c1e-0000-4000-8000-000000000003", name: "Q3 项目复盘", ownerId: ids[0], tenantId: TENANT, share: { scope: "invited" }, offline: true, bytes: 9_800, createdAt: now - 40 * DAY, publishedAt: now - 40 * DAY },
    { id: "6f0d2c1e-0000-4000-8000-000000000004", name: "客户联系表", ownerId: ids[7], tenantId: TENANT, share: { scope: "anyone" }, bytes: 31_200, createdAt: now - 5 * DAY, publishedAt: now - 5 * DAY,
      offline: true, held: { at: now - 4 * DAY, by: { userId: OWNER, name: "林管理" }, reason: "包含客户手机号，公开链接不合适", wasOffline: false } },
  ];
  const sites = {
    list: () => siteRecords.map((site) => ({ ...site, offline: site.offline === true, held: site.held ? { at: site.held.at, reason: site.held.reason } : null,
      review: site.review?.state ? { state: site.review.state, at: site.review.at, reason: site.review.reason } : null })),
    get: (id) => siteRecords.find((site) => site.id === id) ?? null,
    approve: async (id) => { const site = siteRecords.find((item) => item.id === id); site.review = { state: null }; site.offline = false; return {}; },
    reject: async (id, { reason }) => { const site = siteRecords.find((item) => item.id === id); site.review = { ...site.review, state: "rejected", reason }; return {}; },
    hold: async (id, { by, reason }) => { const site = siteRecords.find((item) => item.id === id); site.held = { at: Date.now(), by, reason, wasOffline: site.offline === true }; site.offline = true; },
    release: async (id) => { const site = siteRecords.find((item) => item.id === id); site.offline = site.held.wasOffline; site.held = null; return { offline: site.offline }; },
  };
  const checks = { level: "warning", checks: [
    { name: "public_certificate", label: "管理后台地址的 HTTPS 证书", level: "warning", summary: "证书还剩 12 天到期（2026-10-14），续签后自动恢复。", at: now - 120_000 },
    { name: "disk", label: "数据盘", level: "ok", summary: "/home/idou/.idou 所在的盘还剩 175.2 GB（89%）。", at: now - 120_000 },
    { name: "sandbox", label: "定时任务沙箱", level: "ok", summary: "沙箱可用（gVisor）。", at: now - 120_000 },
    { name: "schedules", label: "定时任务", level: "ok", summary: "最近一小时 1,284 次运行，失败 3 次。", at: now - 120_000 },
    { name: "models", label: "模型上游", level: "ok", summary: "MiniMax-M3、GLM-5.3 都能答。", at: now - 120_000 },
  ] };
  // A made-up organisation chart: five centres, their departments and teams,
  // everybody in one team; those disabled as having left, marked so.
  const org = await OrgDirectory.open({ db }); closers.push(() => org.close());
  const CENTRES = { 研发中心: ["平台部", "应用部", "数据部", "测试部", "运维部"], 销售中心: ["华东区", "华北区", "华南区", "西部区"], 市场部: ["品牌组", "增长组"], 财务部: ["核算组", "资金组"], 人力资源部: ["招聘组", "薪酬组"] };
  const departments = [], leaves = [];
  let order = 0;
  for (const [centre, units] of Object.entries(CENTRES)) {
    const centreId = `od-${createHash("sha256").update(centre).digest("hex").slice(0, 10)}`;
    departments.push({ id: centreId, parentId: "", name: centre, path: `/${centreId}/`, depth: 1, memberCount: 0, order: order += 1 });
    for (const unit of units) {
      const unitId = `od-${createHash("sha256").update(`${centre}/${unit}`).digest("hex").slice(0, 10)}`;
      departments.push({ id: unitId, parentId: centreId, name: unit, path: `/${centreId}/${unitId}/`, depth: 2, memberCount: 0, order: order += 1 });
      for (let team = 1; team <= 3; team += 1) {
        const teamId = `od-${createHash("sha256").update(`${centre}/${unit}/${team}`).digest("hex").slice(0, 10)}`;
        departments.push({ id: teamId, parentId: unitId, name: `${unit}${["一", "二", "三"][team - 1]}组`, path: `/${centreId}/${unitId}/${teamId}/`, depth: 3, memberCount: 0, order: order += 1 });
        leaves.push(teamId);
      }
    }
  }
  const placed = ids.map(() => leaves[Math.floor(random() * leaves.length)]);
  for (const department of departments) department.memberCount = placed.filter((leaf) => departments.find((d) => d.id === leaf).path.startsWith(department.path)).length;
  await org.replaceDepartments(TENANT, departments);
  const gone = new Set(disabled.map((entry) => entry.userId));
  await db.transaction(async (tx) => {
    for (let at = 0; at < COUNT; at += 400) {
      const slice = ids.slice(at, at + 400);
      // Of those who have left, three in five already cleaned up after.
      await tx.run(`INSERT INTO idou_admin_org_people (tenant, user_id, employment, departments, checked_at, departed_at, cleaned_at) VALUES ${slice.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",")}`,
        slice.flatMap((userId, index) => {
          const departedAt = gone.has(userId) ? now - Math.floor(random() * 20) * DAY - DAY : 0;
          return [TENANT, userId, gone.has(userId) ? "resigned" : "active", JSON.stringify([placed[at + index]]), now - 3_600_000, departedAt, departedAt && (at + index) % 5 < 3 ? departedAt + DAY / 2 : 0];
        }));
      await tx.run(`INSERT INTO idou_admin_org_membership (tenant, department_id, user_id) VALUES ${slice.map(() => "(?, ?, ?)").join(",")}`,
        slice.flatMap((userId, index) => [TENANT, placed[at + index], userId]));
    }
  });
  await org.recordSync(TENANT, "ok", { departments: departments.length, range: { all: true, departments: 0, users: 0 }, checked: COUNT, departed: gone.size, disabled: gone.size, unknown: 0 });
  // A few rules an organisation would write: a default for everybody, a group
  // that may not delete or send, an intern who may only use the cheaper model.
  const MODELS = ["MiniMax-M3", "GLM-5.3"];
  const policyStore = await PolicyStore.open({ db, models: MODELS }); closers.push(() => policyStore.close());
  const engine = new PolicyEngine({ store: policyStore, models: MODELS, ceilings: { mediaVideo: true, sitesAnonymous: false }, org,
    inChat: async (chatId, userId) => chatId === "oc_synthetic_finance" && ids.indexOf(userId) % 10 === 3 });
  await policyStore.create({ tenantId: TENANT, target: { kind: "everyone" }, settings: { models: { default: "MiniMax-M3" }, quota: { dailyTokens: 3_000_000, downgradeTo: "GLM-5.3" }, features: { mediaVideo: false } }, note: "全员默认", by: { userId: OWNER, name: "林管理" } });
  await policyStore.create({ tenantId: TENANT, target: { kind: "chat", id: "oc_synthetic_finance" }, settings: { quota: { dailyTokens: 1_000_000 }, features: { feishuDelete: false, feishuMessage: false } }, note: "财务部：不让 Agent 删东西、发消息", by: { userId: OWNER, name: "林管理" } });
  await policyStore.create({ tenantId: TENANT, target: { kind: "user", id: ids[0] }, settings: { models: { allowed: ["GLM-5.3"] }, features: { fullAccess: false } }, note: "实习生", by: { userId: OWNER, name: "林管理" } });
  await policyStore.create({ tenantId: TENANT, target: { kind: "department", id: departments[0].id }, settings: { quota: { dailyTokens: 8_000_000, downgradeTo: "GLM-5.3" } }, note: "研发中心额度高一些", by: { userId: OWNER, name: "林管理" } });
  const tasks = new ScheduleStore({ databaseFile: path.join(root, "schedules.db"), now: () => now });
  closers.push(() => tasks.close?.());
  const plan = { title: "合成任务", prompt: "这是合成的提示词，后台不该显示它。", mode: "cowork", schedule: { frequency: "daily", time: "09:00", timeZone: "Asia/Shanghai" } };
  for (let index = 10; index < Math.min(COUNT, 2010); index += 1) {
    const who = { tenantId: TENANT, userId: ids[index], familyId: `f${index}` };
    for (let made = 0; made < 1 + (index % 3); made += 1) {
      const task = await tasks.create(who, plan);
      if (index % 11 === 0) await tasks.setState(who, task.id, "paused");
      else if (index % 13 === 0) await tasks.suspend(TENANT, task.id);
      else if (index % 4 === 0) await tasks.finish(TENANT, (await tasks.claimNow(task, now - 3_600_000)).runId, index % 8 === 0 ? "failed" : "completed");
    }
  }
  const unattended = new Map(ids.slice(10, 2010).filter((_, index) => index % 3 === 0).map((userId, index) => [userId, { state: index % 10 === 0 ? "needs_reauthorization" : "active", expiresAt: now + 30 * DAY }]));
  // Enterprise skills: the real shelf and its governance -- three up, versions
  // behind them, two waiting for review, one turned down, a month of use.
  const skillClock = { at: now - 29 * DAY };
  const skills = await new SkillRegistry({ filename: path.join(root, "skills.json"), administrators: [ids[7]] }).load();
  const skillGovernance = await SkillGovernance.open({ db, key: "synthetic-server-key-thirty-two-b", now: () => skillClock.at }); closers.push(() => skillGovernance.close());
  const skillBundle = (id, version, title, description, publisher, body, requiredTools = [], extra = []) => ({ id, version, title, description, publisher, requiredTools, runtimeVersions: { codex: [], feishu: [] },
    files: [{ path: "SKILL.md", text: `---\nname: ${id}\ndescription: ${description}\n---\n${body}` }, ...extra] });
  const WEEKLY = (version, body) => skillBundle("enterprise-weekly-report", version, "周报助手", "把本周群聊和文档里的进展整理成周报，按项目分节。", "IT 部", body, ["feishu.read"]);
  const CONTRACT = (version, body, tools = ["feishu.read"]) => skillBundle("enterprise-contract-review", version, "合同初审", "对照法务清单检查合同条款，列出需要人工确认的地方。", "法务部", body, tools,
    [{ path: "checklist.md", text: "# 合同初审清单\n\n1. 付款条件与账期\n2. 违约责任是否对等\n3. 保密条款的期限\n4. 管辖法院与适用法律\n" }]);
  const MINUTES = skillBundle("enterprise-meeting-minutes", "0.9.0", "会议纪要", "从会议录音转写里提取决定、负责人和截止时间。", "行政部", "# 会议纪要\n\n只写会上定下来的事：决定、负责人、截止时间。没有定下的写进「待定」。\n");
  const PUBLISHER = { userId: ids[7], name: names[7] }, REVIEWER = { userId: OWNER, name: "林管理" };
  const weeklyText = ["# 周报助手\n\n1. 读本周加入的群和本人编辑过的文档。\n2. 按项目分节，每节写进展、风险、下周计划。", "\n3. 风险写明负责人。", "\n4. 不写个人绩效评价。"];
  for (const [index, version] of ["1.2.0", "1.3.0", "1.4.0"].entries()) {
    const bundle = WEEKLY(version, weeklyText.slice(0, index + 1).join(""));
    await skills.place(TENANT, bundle);
    await skillGovernance.recordVersion(TENANT, bundle, { publishedBy: PUBLISHER, approvedBy: index ? REVIEWER : null, source: index ? "approve" : "publish" });
    skillClock.at += 4 * DAY;
  }
  const contractLive = CONTRACT("2.0.1", "# 合同初审\n\n按 checklist.md 逐条检查，只列出问题和原文位置，不改合同。\n");
  await skills.place(TENANT, contractLive);
  await skillGovernance.recordVersion(TENANT, contractLive, { publishedBy: PUBLISHER, approvedBy: REVIEWER, source: "approve" });
  await skills.place(TENANT, MINUTES);
  await skillGovernance.recordVersion(TENANT, MINUTES, { publishedBy: { userId: ids[8], name: names[8] }, approvedBy: REVIEWER, source: "approve" });
  await skillGovernance.setVisibility(TENANT, "enterprise-contract-review", { departments: [departments.find((department) => department.name === "财务部").id] }, REVIEWER);
  // One that went up and was taken down again: kept, to bring back.
  const onboarding = skillBundle("enterprise-onboarding", "1.1.0", "入职向导", "回答新人关于报到、权限申请和常用系统的问题。", "人力资源部", "# 入职向导\n\n只回答清单里有的问题，其余转给 HRBP。\n");
  await skills.place(TENANT, onboarding);
  await skillGovernance.keepLive(TENANT, skills.list(TENANT).find((item) => item.id === "enterprise-onboarding"));
  await skills.withdraw(TENANT, "enterprise-onboarding");
  await skillGovernance.addPublisher(TENANT, { userId: ids[8], name: names[8] }, REVIEWER);
  // A month of use: a few dozen people a day, some every day.
  for (let day = 0; day < 30; day += 1) {
    skillClock.at = now - (29 - day) * DAY;
    for (let use = 0; use < 20 + Math.floor(random() * 30); use += 1) {
      const skillId = ["enterprise-weekly-report", "enterprise-weekly-report", "enterprise-contract-review", "enterprise-meeting-minutes"][Math.floor(random() * 4)];
      await skillGovernance.recordUse(TENANT, { skillId, version: "1", userId: ids[10 + Math.floor(random() * 400)] });
    }
  }
  skillClock.at = now - 3 * 3_600_000;
  const turnedDown = await skillGovernance.submit(TENANT, skillBundle("enterprise-meeting-minutes", "1.0.0", "会议纪要", "从会议录音转写里提取决定、负责人和截止时间。", "行政部", "# 会议纪要\n\n把纪要发到会议群里。\n"), { userId: ids[8], name: names[8] });
  await skillGovernance.decide(TENANT, turnedDown.id, { decision: "rejected", by: REVIEWER, reason: "会自动发到群里：应当先给本人看" });
  skillClock.at = now - 2 * 3_600_000;
  await skillGovernance.submit(TENANT, CONTRACT("2.1.0", "# 合同初审\n\n按 checklist.md 逐条检查，只列出问题和原文位置，不改合同。\n对方是老客户时，先查 CRM 里的历史合同。\n", ["feishu.read", "mcp:crm:lookup"]), PUBLISHER);
  skillClock.at = now - 40 * 60_000;
  await skillGovernance.submit(TENANT, skillBundle("enterprise-expense-check", "1.0.0", "报销单检查", "检查报销单的发票、金额和审批人是否齐全。", "财务部", "# 报销单检查\n\n读本人指定的报销单，逐项对照差旅标准，只列出缺的和超的。\n", ["cli:local-files"]), { userId: ids[8], name: names[8] });
  skillClock.at = now;
  // 服务状态 (docs/service-status.md): a day of the real modules' records --
  // a coordinator and two model replicas answering, a worker through its
  // queue table, every sweep kept, a disk that filled for an hour last night,
  // the alerts that went out, a backup record.
  const statusClock = { at: now - DAY };
  const statusNow = () => statusClock.at;
  const statusHistory = await StatusHistory.open({ db, now: statusNow });
  const replicas = [];
  for (const [role, name, active, limit, pid] of [["coordinator", "coordinator", 2, 8, 70311], ["api", "api-1", 6, 8, 70346], ["api", "api-2", 5, 8, 70352]]) {
    const traffic = new TrafficMeter({ now: statusNow });
    const status = await ProcessStatus.open({ db, role, name, release: "0.1.0-20261003.271", startedAt: now - 3 * DAY, traffic, now: statusNow, host: "idou-prod-1", pid,
      sample: () => ({ sessions: role === "coordinator" ? 1840 : 620, model: { active, limit, people: active }, ...(role === "coordinator" ? { cli: { active: 3, limit: 32 } } : {}),
        unavailable: name === "api-2" ? [{ model: "GLM-5.3", reason: "billing", since: now - 1_800_000, retryAt: now + 600_000 }] : [] }) });
    replicas.push({ name, traffic, status });
  }
  for (let step = 0; statusClock.at < now; step += 1, statusClock.at += 5 * 60_000) {
    const hour = new Date(statusClock.at).getHours(), busy = hour >= 9 && hour <= 20 ? 1 : 0.15;
    for (const { name, traffic } of replicas) {
      for (let request = 0; request < Math.round((name === "coordinator" ? 8 : 40) * busy * (0.7 + random() * 0.6)); request += 1) {
        const glm = random() < 0.25, roll = random();
        traffic.record({ model: glm ? "GLM-5.3" : "MiniMax-M3", outcome: roll < 0.012 ? "upstream" : roll < 0.02 ? "cancelled" : roll < 0.026 ? "client" : "ok",
          firstMs: 400 + random() * (glm ? 6000 : 2500) + (random() < 0.03 ? 25_000 : 0) });
      }
      if (busy === 1 && random() < 0.08) traffic.record({ model: "", outcome: "limited", refusal: random() < 0.7 ? "perMinute" : "person" });
    }
    if (step % 1 === 0) for (const { status } of replicas) await status.beat();
    const diskBad = statusClock.at > now - 15 * 3_600_000 && statusClock.at < now - 14 * 3_600_000;
    await statusHistory.recordSweep({ checks: checks.checks.map((check) => ({ ...check, at: statusClock.at,
      ...(check.name === "disk" && diskBad ? { level: "warning", summary: "/home/idou/.idou 所在的盘还剩 1.8 GB（4%）。" } : {}),
      ...(check.name === "public_certificate" && statusClock.at < now - 6 * 3_600_000 ? { level: "ok", summary: "证书有效，到 2026-10-14。" } : {}) })) });
  }
  statusClock.at = now;
  await statusHistory.recordAlert({ level: "warning", text: "i豆 服务端告警：/home/idou/.idou 所在的盘还剩 1.8 GB（4%）。", recipients: 3, reached: 3 });
  await statusHistory.recordAlert({ level: "warning", text: "i豆 服务端告警：管理后台地址的 HTTPS 证书还剩 12 天到期（2026-10-14），续签后自动恢复。", recipients: 3, reached: 2 });
  for (const { status } of replicas) await status.beat();
  closers.push(async () => { for (const { status } of replicas) await status.close(); });
  // A third replica stopped for the release and not back yet.
  const third = await ProcessStatus.open({ db, role: "api", name: "api-3", release: "0.1.0-20261003.271", startedAt: now - DAY, now: () => now - 10 * 60_000, host: "idou-prod-1", pid: 70400,
    sample: () => ({ sessions: 0, model: { active: 0, limit: 8, people: 0 } }) });
  await third.beat(); await third.close();
  const worker = { worker: "worker-1-fixture", name: "worker-1", host: "idou-prod-1", pid: 4242, release: "0.1.0-20261003.271", startedAt: now - 3 * DAY, beatAt: now - 8_000,
    state: { runs: { active: 2, limit: 4 }, rss: 96 * 1048576 } };
  const backupRecord = { configured: true, last: { ok: true, endedAt: new Date(now - 7 * 3_600_000).toISOString(), files: 214, bytes: 389 * 1048576, sealed: true, shipped: true } };
  backupRecord.lastSuccess = backupRecord.last;
  // The processes check, read from the same records, as the coordinator's sweep would.
  checks.checks.push({ ...(await processesCheck({ read: () => readProcesses({ db, workers: async () => [worker] }) }).run()), name: "processes", label: "服务进程", at: now });
  checks.level = checks.checks.some((check) => check.level === "critical") ? "critical" : checks.checks.some((check) => check.level === "warning") ? "warning" : "ok";
  const serviceStatus = {
    read: async () => ({ ...await readServiceStatus({ db, workers: async () => [worker], queue: async () => ({ queued: 1, running: 2 }) }), backup: backupRecord }),
    alerts: { enabled: true, users: 2, chat: true, bot: true },
    testAlert: async () => ({ sent: true }),
  };
  // Content safety: checks of the synthetic sites, one of them waiting.
  // The model, of the smoke's own: it reads each page as fine, but did not answer for the first version of the guide.
  const moderate = async (text) => text.includes("欢迎加入") ? { verdict: "review", categories: [], reason: "模型没有按时回答", failed: true } : { verdict: "pass", categories: [], reason: "" };
  const safety = await SiteSafety.open({ db, key: "synthetic-server-key-thirty-two-b", moderate }); closers.push(() => safety.close());
  const pageOf = (text) => [{ path: "index.html", bytes: Buffer.from(`<html><body>${text}</body></html>`) }];
  const waitingSite = siteRecords[1];
  // Checked again at start, before its second version: the model did not answer, and the site stayed up.
  await safety.assess({ tenantId: TENANT, site: { id: waitingSite.id, name: waitingSite.name, ownerId: waitingSite.ownerId }, audience: "public",
    files: pageOf("<h1>新人入职指南</h1><p>欢迎加入。</p>"), trigger: "rescan", version: "v1" });
  const waitingCheck = await safety.assess({ tenantId: TENANT, site: { id: waitingSite.id, name: waitingSite.name, ownerId: waitingSite.ownerId }, audience: "public",
    files: pageOf("<h1>新人入职指南</h1><p>入职当天联系行政 13812345678，或发邮件到 onboarding@example.com。</p><p>报到时带好身份证原件。</p>"), trigger: "publish", version: "v2" });
  Object.assign(waitingSite, { offline: true, review: { state: "pending", checkId: waitingCheck.id, reason: waitingCheck.reason, at: now - 2 * 3_600_000, wasOffline: false } });
  await safety.assess({ tenantId: TENANT, site: { id: siteRecords[0].id, name: siteRecords[0].name, ownerId: siteRecords[0].ownerId }, audience: "internal",
    files: pageOf("<p>华东区负责人 13900001111</p>"), trigger: "data", version: "v1" });
  await safety.assess({ tenantId: TENANT, site: { id: siteRecords[0].id, name: siteRecords[0].name, ownerId: siteRecords[0].ownerId }, audience: "public",
    files: pageOf("<script>const key = 'sk-a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5'</script>"), trigger: "share", version: "v1" });
  for (let n = 0; n < 40; n += 1) safety.countVisit(TENANT, siteRecords[2].id, { anonymous: n % 3 === 0 });
  await safety.flushVisits();
  // The server's re-reads, wired as the server wires them; their timers never fire here.
  const rescans = scheduleRescans({ registry: sites, safety, timers: { set: () => null, clear: () => {} } });
  const api = createAdminApi({ people, access, roles, audit, usage: usage.reports, sessions, sites, appId: "cli_synthetic", skills, skillGovernance, safety, rescans, status: serviceStatus,
    tasks: { store: tasks, unattended: { store: { read: async (tenant, userId) => unattended.get(userId) ?? null }, revoke: async (who) => unattended.delete(who.userId) } },
    policy: { store: policyStore, engine, models: MODELS, ceilings: engine.ceilings }, org,
    system: async () => systemState({ release: "0.1.0-20261003.271", checks,
      deployment: { sitesOrigin: "https://sites.example.cn", anonymous: true, allowlist: ["10.0.0.0/8"], unattended: true, sandboxMode: "production" },
      models: [{ id: "MiniMax-M3", provider: "minimax", isDefault: true }, { id: "GLM-5.3", provider: "litellm" }],
      health: { usable: () => true },
      visibility: { enabled: true, defaultVisible: "all", rules: [{ kind: "chat", id: "oc_synthetic_rnd", models: new Set(["MiniMax-M3", "GLM-5.3"]) }, { kind: "everyone", id: null, models: new Set(["MiniMax-M3"]) }] } }),
    personData: async () => ({ tasks: { schedules: 3, runs: 214 }, credential: { state: "active", expiresAt: now + 21 * DAY }, model: "MiniMax-M3",
      sites: [{ id: "x", name: "销售周报看板", offline: false }], reservations: [] }),
    // Synthetic: says what it would have let go, lets go of nothing.
    offboard: async () => ({ tasks: { schedules: 3, runs: 214 }, credential: true, model: true, reservations: 0, sitesOffline: [], sessions: 1 }) });
  let origin = "http://127.0.0.1:0";
  let signInAs = { userId: OWNER, name: "林管理" };
  const oauth = { authorizationUrl: ({ state }) => `${origin}/_auth/callback?state=${state}&code=signed-in`, probeIdentity: async () => ({ ...signInAs, tenantId: TENANT }) };
  server = createAdminServer({ origin: "http://127.0.0.1:0", cookieKey: randomBytes(32), oauth, roles, api, assets: await loadAdminAssets(), audit: (event) => audit.record(event) });
  // The origin is only known once listening; the server checks it on every change.
  server.listen(Number(argument("--port", 0)), "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  server.close(); await once(server, "close");
  server = createAdminServer({ origin, cookieKey: randomBytes(32), oauth, roles, api, assets: await loadAdminAssets(), audit: (event) => audit.record(event) });
  server.listen(Number(origin.split(":").at(-1)), "127.0.0.1"); await once(server, "listening");

  // ---------------------------------------------------------------- time
  const admin = { userId: OWNER, tenantId: TENANT, name: "林管理", role: "owner", source: "configured", csrf: "x", address: "127.0.0.1" };
  // Through the API's own dispatch, as a request would go: the role, the
  // scope, then the route.
  const call = async (path, query = "", who = admin) => {
    let answer = null;
    await api.handle({ method: "GET", path, query: new URLSearchParams(query), body: {}, admin: who, req: {}, res: { headersSent: false },
      json: (status, value) => { answer = { status, value }; }, send: () => {} });
    if (answer?.status !== 200) throw new Error(`${path}?${query}：${answer?.status} ${JSON.stringify(answer?.value).slice(0, 200)}`);
    return answer.value;
  };
  // A 部门管理员 for one centre: everything they read is narrowed to it.
  const leadIndex = ids.findIndex((id, index) => index >= 5 && !disabled.some((entry) => entry.userId === id));
  const centreAdmin = { ...admin, userId: ids[leadIndex], name: names[leadIndex], role: "admin", source: "granted", scope: [departments[0].id] };
  const timings = [];
  for (const [label, path, query, person = admin] of [
    ["成员第一页（最近在线）", "/admin/api/people", ""],
    ["成员按姓名搜索「王」", "/admin/api/people", "q=王"],
    ["成员：已停用", "/admin/api/people", "status=disabled"],
    ["成员：30 天没有在线", "/admin/api/people", "active=inactive30d"],
    ["成员按姓名排序", "/admin/api/people", "sort=name"],
    ["成员：一个中心（含下级）", "/admin/api/people", `department=${departments[0].id}`],
    ["成员：一个小组", "/admin/api/people", `department=${departments.at(-1).id}`],
    ["一个人的详情", `/admin/api/people/${ids[0]}`, ""],
    ["组织架构（含待清理名单）", "/admin/api/org", ""],
    ["定时任务第一页（2000 人 4000 个任务）", "/admin/api/tasks", ""],
    ["文档网站", "/admin/api/sites", ""],
    ["企业技能（含近 30 天用量）", "/admin/api/skills", ""],
    ["服务状态（三个进程一天的流量和自检）", "/admin/api/system", ""],
    ["一个企业技能的详情", "/admin/api/skills/enterprise-weekly-report", ""],
    ["离职清理预览 50 人", "/admin/api/people/offboard", `ids=${disabled.slice(0, 50).map((entry) => entry.userId).join(",")}`],
    ["概览", "/admin/api/overview", ""],
    ["用量 30 天（要把每天加总一次）", "/admin/api/usage", "days=30"],
    ["审计 7 天第一页", "/admin/api/audit", ""],
    ["审计：只看登录", "/admin/api/audit", "category=auth"],
    ["审计：只看一个人", "/admin/api/audit", `actor=${ids[0]}&from=${now - 30 * DAY}&to=${now + 60_000}`],
    ["部门管理员：概览", "/admin/api/overview", "", centreAdmin],
    ["部门管理员：成员第一页", "/admin/api/people", "", centreAdmin],
    ["部门管理员：搜索「王」", "/admin/api/people", "q=王", centreAdmin],
    ["部门管理员：审计 7 天", "/admin/api/audit", "", centreAdmin],
    ["部门管理员：组织架构", "/admin/api/org", "", centreAdmin],
  ]) {
    // Twice: the first read of a file the database has not touched yet costs
    // what a server just started pays once; the second is every read after.
    const cold = await timed(label, () => call(path, query, person)), warm = await timed(label, () => call(path, query, person));
    timings.push({ label, cold: cold.ms, warm: warm.ms });
  }
  process.stdout.write(`  ${"".padEnd(22, "　")}     第一次      之后\n${timings.map((entry) => `  ${entry.label.padEnd(22, "　")} ${entry.cold.toFixed(1).padStart(8)} ms ${entry.warm.toFixed(1).padStart(8)} ms`).join("\n")}\n`);

  // ---------------------------------------------------------------- look
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "zh-CN" });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`页面出错：${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") problems.push(`控制台报错：${message.text()}`); });
  // What a program left in the page instead of words: a value that was not there.
  const leftovers = async (name, on = page) => {
    const found = await on.evaluate(() => {
      const text = [...document.querySelectorAll("body *")].filter((node) => node.checkVisibility?.() ?? true)
        .flatMap((node) => [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent)).join("\n");
      return text.match(/\b(null|undefined|NaN)\b|\[object Object\]/)?.[0] ?? null;
    });
    if (found) problems.push(`${name}：页面上出现了「${found}」`);
  };
  const settle = async (on = page) => { await on.waitForLoadState("networkidle"); await on.waitForSelector("#content .page-head, #content .profile-head, #content .error-banner"); };
  const look = async (name, hash, on = page) => {
    // The same address again is no navigation at all: load it afresh, or the
    // picture is of what was there before.
    if (on.url() === `${origin}/admin${hash}`) await on.reload(); else await on.goto(`${origin}/admin${hash}`);
    await settle(on);
    const wide = await on.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (wide > 1) problems.push(`${name}：横向溢出 ${wide}px`);
    const failed = await on.locator("#content .error-banner").count();
    if (failed) problems.push(`${name}：页面显示错误「${await on.locator("#content .error-banner").first().innerText()}」`);
    await leftovers(name, on);
    // The first screen, as somebody opening the page sees it.
    await on.screenshot({ path: path.join(evidence, `${name}.png`) });
  };
  await page.goto(`${origin}/admin`);   // signs in: /admin → "Feishu" → callback → /admin
  await settle();
  await look("overview", "#/overview");
  await look("people", "#/people");
  await look("people-disabled", "#/people?status=disabled");
  await look("people-search", `#/people?q=${encodeURIComponent("王")}&sort=name`);
  await look("person", `#/people/${ids[0]}`);
  await look("person-disabled", `#/people/${disabled[0].userId}`);
  await look("admins", "#/admins");
  await look("usage", "#/usage?days=30");
  await look("audit", "#/audit");
  await look("audit-admin", "#/audit?category=admin&days=30");
  await look("sites", "#/sites");
  await look("policy", "#/policy");
  await look("tasks", "#/tasks");
  await look("site-safety", "#/site-safety");
  await look("skills", "#/skills");
  await look("skill", "#/skills/enterprise-weekly-report");
  await look("skill-departments", "#/skills/enterprise-contract-review");
  await look("org", "#/org");
  await look("people-department", `#/people?department=${departments[1].id}`);
  await look("system", "#/system");
  // What a person does: the search at the top, ticking rows, the confirmation.
  await page.goto(`${origin}/admin#/people`); await settle();
  await page.fill("#search input", "张");
  await page.waitForSelector("#search .search-results a");
  await leftovers("search"); await page.screenshot({ path: path.join(evidence, "search.png") });
  await page.keyboard.press("Escape");
  await page.locator("tbody td.check input").nth(0).check();
  await page.locator("tbody td.check input").nth(2).check();
  await page.waitForSelector(".bulkbar:not(.hidden)");
  await leftovers("people-selected"); await page.screenshot({ path: path.join(evidence, "people-selected.png") });
  // The first row is the owner themself, who is offered nothing to do to themself.
  assert.equal(await page.locator("tbody tr").first().getByRole("button", { name: "停用", exact: true }).count(), 0);
  await page.locator("tbody tr").nth(1).getByRole("button", { name: "停用", exact: true }).click();
  await page.waitForSelector("dialog.modal[open]");
  await leftovers("disable-dialog"); await page.screenshot({ path: path.join(evidence, "disable-dialog.png") });
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  await page.click("#content tbody tr:nth-child(2) td:nth-child(3)");
  await page.waitForSelector("#content .profile-head");
  await page.goto(`${origin}/admin#/people/${ids[3]}`); await settle();
  await page.getByRole("button", { name: "离职清理", exact: true }).click();
  await page.waitForSelector("dialog.modal[open]");
  await leftovers("offboard-dialog"); await page.screenshot({ path: path.join(evidence, "offboard-dialog.png") });
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  // A check looked at: masked samples, the masked excerpt.
  await page.goto(`${origin}/admin#/site-safety`); await settle();
  await page.locator("#content tbody tr").filter({ hasText: "新人入职指南" }).first().getByRole("button", { name: "查看", exact: true }).click();
  await page.waitForSelector("dialog.modal[open] .excerpt");
  await leftovers("site-safety-detail"); await page.screenshot({ path: path.join(evidence, "site-safety-detail.png") });
  if ((await page.locator("dialog.modal").innerText()).includes("13812345678")) problems.push("检查详情里出现了没打码的手机号");
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  // A check the model did not answer: said as that, not as a doubt about the words.
  await page.locator("#content tbody tr").filter({ hasText: "AI 没读完" }).first().click();
  await page.waitForSelector("dialog.modal[open]");
  if (!(await page.locator("#content").innerText()).includes("次模型没读完")) problems.push("「AI 审核公开网站」没说最近有模型没读完");
  const unread = await page.locator("dialog.modal").innerText();
  if (!unread.includes("AI 审核：没有完成——模型没有按时回答") || !unread.includes("网站照常在线")) problems.push(`AI 没读完的检查写成了：${unread.replace(/\s+/g, " ").slice(0, 200)}`);
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  // A version waiting for review, read before it is let through: what it adds, line by line.
  await page.goto(`${origin}/admin#/skills`); await settle();
  await page.locator("#content tbody tr").filter({ hasText: "合同初审" }).filter({ hasText: "2.1.0" }).getByRole("button", { name: "审核", exact: true }).click();
  await page.waitForSelector("dialog.modal[open] .diff-line.add");
  await leftovers("skill-review"); await page.screenshot({ path: path.join(evidence, "skill-review.png") });
  const reviewing = await page.locator("dialog.modal").innerText();
  for (const expected of ["mcp:crm:lookup", "先查 CRM 里的历史合同", "通过并上线", "线上是 2.0.1", "上线后谁能看见", "财务部"]) if (!reviewing.includes(expected)) problems.push(`审核对话框里没有「${expected}」`);
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  if (await page.locator("dialog.modal[open]").count()) problems.push("审核对话框取消后还开着");
  await page.locator("#content tbody tr").filter({ hasText: "报销单检查" }).getByRole("button", { name: "不通过", exact: true }).click();
  await page.waitForSelector("dialog.modal[open] textarea");
  await page.locator("dialog.modal textarea").fill("会读本机文件：先说清读哪个目录");
  await leftovers("skill-reject-dialog"); await page.screenshot({ path: path.join(evidence, "skill-reject-dialog.png") });
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  if ((await skillGovernance.pendingCount(TENANT)) !== 2) problems.push("取消之后等待审核的版本数变了");
  await page.goto(`${origin}/admin#/system`); await settle();
  await page.screenshot({ path: path.join(evidence, "system-full.png"), fullPage: true });
  for (const expected of ["api-1", "worker-1", "故障时间线", "数据盘", "发送测试告警", "389 MB", "api-3 停止后没有再启动"]) if (!(await page.locator("#content").innerText()).includes(expected)) problems.push(`服务状态页没有「${expected}」`);
  // The whole of both pages: who may publish, the rule, the decisions; versions and the record.
  await page.screenshot({ path: path.join(evidence, "skills-full.png"), fullPage: true });
  await page.goto(`${origin}/admin#/skills/enterprise-contract-review`); await settle();
  await page.screenshot({ path: path.join(evidence, "skill-full.png"), fullPage: true });
  await page.goto(`${origin}/admin#/skills/enterprise-onboarding`); await settle();
  if (!(await page.locator("#content").innerText()).includes("重新上线这个版本")) problems.push("已下架的技能页上没有「重新上线这个版本」");
  await page.screenshot({ path: path.join(evidence, "skill-withdrawn.png"), fullPage: true });
  // Taking a site down: the dialog with its reason.
  await page.goto(`${origin}/admin#/sites`); await settle();
  await page.locator("#content tbody tr").filter({ hasText: "新人入职指南" }).getByRole("button", { name: "下线", exact: true }).click();
  await page.waitForSelector("dialog.modal[open]");
  await page.locator("dialog.modal textarea").fill("面向全网公开，但内容只该给新员工看");
  await leftovers("site-hold-dialog"); await page.screenshot({ path: path.join(evidence, "site-hold-dialog.png") });
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  // Who has left: tick three on the waiting list, open the cleanup, cancel.
  await page.goto(`${origin}/admin#/org`); await settle();
  for (const index of [0, 1, 2]) await page.locator("#content tbody td.check input").nth(index).check();
  await page.waitForSelector(".bulkbar:not(.hidden)");
  await page.getByRole("button", { name: "离职清理", exact: true }).click();
  await page.waitForSelector("dialog.modal[open]");
  await leftovers("org-offboard-dialog"); await page.screenshot({ path: path.join(evidence, "org-offboard-dialog.png") });
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  await page.goto(`${origin}/admin#/audit`); await settle();
  // On the time, not the middle of the row: the person in it is a link of its own.
  await page.locator("#content tbody tr").first().locator("td").first().click();
  await page.waitForSelector("tr.detail-row");
  await leftovers("audit-detail"); await page.screenshot({ path: path.join(evidence, "audit-detail.png") });
  // The policy: try it on somebody, and open the editor.
  await page.goto(`${origin}/admin#/policy`); await settle();
  await page.fill(".picker input", names[3].slice(0, 2));
  await page.locator(".pick").first().click();
  await page.waitForSelector("#content .kv");
  await leftovers("policy-explained"); await page.screenshot({ path: path.join(evidence, "policy-explained.png"), fullPage: true });
  await page.getByRole("button", { name: "新建规则", exact: true }).click();
  await page.waitForSelector("dialog.modal[open]");
  await leftovers("policy-editor"); await page.screenshot({ path: path.join(evidence, "policy-editor.png") });
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  // A 部门管理员, signed in: one centre's people, nothing of the tenant's.
  // Granting it, as the owner sees it: the dialog with a department picked, then the list.
  await page.goto(`${origin}/admin#/admins`); await settle();
  await page.getByRole("button", { name: "授予角色", exact: true }).click();
  await page.waitForSelector("dialog.modal[open]");
  await page.locator("dialog.modal .picker input").fill(departments[1].name.slice(0, 2));
  await page.locator("dialog.modal .pick").first().click();
  await page.waitForSelector("dialog.modal .chips .tag");
  await leftovers("grant-dialog"); await page.screenshot({ path: path.join(evidence, "grant-dialog.png") });
  await page.locator("dialog.modal").getByRole("button", { name: "取消", exact: true }).click();
  await roles.grant({ tenantId: TENANT, userId: centreAdmin.userId, role: "admin", scope: centreAdmin.scope, by: { userId: OWNER, name: "林管理" }, note: `${departments[0].name}的管理员` });
  await look("admins-scoped", "#/admins");
  signInAs = { userId: centreAdmin.userId, name: centreAdmin.name };
  const leadContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "zh-CN" });
  const leadPage = await leadContext.newPage();
  leadPage.on("pageerror", (error) => problems.push(`部门管理员页面出错：${error.message}`));
  await leadPage.goto(`${origin}/admin`); await settle(leadPage);
  await look("scoped-overview", "#/overview", leadPage);
  await look("scoped-people", "#/people", leadPage);
  await look("scoped-org", "#/org", leadPage);
  await look("scoped-policy", "#/policy", leadPage);
  const navText = await leadPage.locator("#nav").innerText();
  if (/用量|服务状态/.test(navText)) problems.push("部门管理员的导航里不该有「用量」「服务状态」");
  if (!(await leadPage.locator("#whoami").innerText()).includes(departments[0].name)) problems.push("部门管理员的顶栏应当写出他管理的部门");
  // Asked for somebody outside the centre, the page says so rather than showing them.
  const outsider = ids.find((id, index) => placed[index] && !departments.find((d) => d.id === placed[index]).path.startsWith(departments[0].path));
  await leadPage.goto(`${origin}/admin#/people/${outsider}`); await settle(leadPage);
  const refusal = await leadPage.locator("#content .error-banner").first().innerText().catch(() => "");
  if (!refusal.includes("不在你管理的部门里")) problems.push(`部门管理员打开范围外的人，应当被告知不在他的范围里（看到的是「${refusal.slice(0, 60)}」）`);
  await leftovers("scoped-outsider", leadPage);
  await leadPage.screenshot({ path: path.join(evidence, "scoped-outsider.png") });
  await leadContext.close();
  signInAs = { userId: OWNER, name: "林管理" };
  // An application whose contact range is one person, as the production one's
  // was when first switched on: what is synced, and how to widen it.
  await org.recordSync(TENANT, "ok", { departments: 0, range: { all: false, departments: 0, users: 1 }, checked: 1, departed: 0, disabled: 0, unknown: 0 });
  await look("org-partial-range", "#/org");
  await org.recordSync(TENANT, "ok", { departments: departments.length, range: { all: true, departments: 0, users: 0 }, checked: COUNT, departed: gone.size, disabled: gone.size, unknown: 0 });
  // Narrow, and dark.
  await page.setViewportSize({ width: 390, height: 844 });
  await look("overview-phone", "#/overview");
  await look("people-phone", "#/people");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await look("overview-dark", "#/overview");
  await look("person-dark", `#/people/${ids[0]}`);

  process.stdout.write(`截图在 ${path.relative(process.cwd(), evidence)}/\n`);
  if (problems.length) { process.stdout.write(`问题：\n${problems.map((line) => `  ${line}`).join("\n")}\n`); process.exitCode = 1; }
  else process.stdout.write("没有发现问题：没有页面错误、控制台报错、横向溢出，也没有残留的 null、undefined、NaN。\n");
  if (SERVE) {
    process.stdout.write(`\n管理后台（合成数据）在 ${origin}/admin ，Ctrl-C 结束。\n`);
    await browser.close(); browser = null;
    await new Promise((resolve) => process.once("SIGINT", resolve));
  }
} finally {
  await browser?.close().catch(() => {});
  if (server) { server.close(); server.closeAllConnections(); }
  for (const close of closers.reverse()) await Promise.resolve(close()).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
