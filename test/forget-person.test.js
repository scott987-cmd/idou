// Letting go of one person's data when they leave (bin/forget-person.js,
// src/control-plane/person-data.js). Found in the long-running review
// (2026-09-29): nothing could take a person's data off the server. What goes,
// what is taken offline and what stays was decided by the operator on
// 2026-09-30, and is what this checks -- against real stores, in a home of the
// test's own, with a colleague's data beside it that must not be touched.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ScheduleStore } from "../src/control-plane/schedule-store.js";
import { UnattendedCredentialStore } from "../src/control-plane/unattended-credential.js";
import { ModelPreferences } from "../src/control-plane/model-choice.js";
import { SiteRegistry } from "../src/control-plane/site-registry.js";
import { DriveBudget } from "../src/control-plane/drive-budget.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { appHash } from "../src/apps/manifest.js";

const run = promisify(execFile);
const tool = fileURLToPath(new URL("../bin/forget-person.js", import.meta.url));
const TENANT = "tenant_fixture", APP = "cli_a1b2c3d4e5f60718";
const LEAVER = { tenantId: TENANT, userId: "ou_leaver", familyId: "login-l" }, COLLEAGUE = { tenantId: TENANT, userId: "ou_colleague", familyId: "login-c" };
const daily = (title) => ({ title, prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork", schedule: { frequency: "daily", time: "09:00", timeZone: "Asia/Shanghai" } });
const page = (body) => { const bytes = Buffer.from(body); return { manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: bytes.length, sha256: appHash(bytes) }] }, blobs: [{ path: "index.html", base64: bytes.toString("base64") }] }; };

async function server(t) {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-forget-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const scheduled = path.join(home, "scheduled"), sites = path.join(home, "sites"), ledgerDir = path.join(home, "drive");
  await mkdir(scheduled, { mode: 0o700 }); await mkdir(ledgerDir, { mode: 0o700 });
  const driveConfig = path.join(home, "drive.json");
  await writeFile(driveConfig, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(ledgerDir, "ledger.sqlite"),
    tenants: [{ authProvider: "feishu", tenantId: TENANT, appId: APP, providerId: SAAS_FEISHU.id, driveTenantKey: TENANT, folderToken: "FolderFixture01", maxBytes: 1048576 }] }), { mode: 0o600 });
  // What the leaver and a colleague each have here.
  const schedules = new ScheduleStore({ databaseFile: path.join(scheduled, "schedules.db") });
  for (const who of [LEAVER, COLLEAGUE]) {
    const task = schedules.create(who, daily(`${who.userId} 的日报`));
    const claimed = schedules.claimNow(task, Date.now()); schedules.finish(TENANT, claimed.runId, "completed");
  }
  const gone = schedules.create(LEAVER, daily("已删除的任务"));
  schedules.finish(TENANT, schedules.claimNow(gone, Date.now()).runId, "failed"); schedules.remove(LEAVER, gone.id);
  schedules.close();
  const credentials = await UnattendedCredentialStore.open({ directory: path.join(scheduled, "unattended") });
  for (const who of [LEAVER, COLLEAGUE]) {
    await credentials.write(TENANT, who.userId, { sealed: credentials.seal({ appId: APP, tenantId: TENANT, userId: who.userId, refreshToken: "synthetic", notAfter: Date.now() + 86400_000 }),
      state: "active", expiresAt: Date.now() + 86400_000, reason: null, failures: 0 });
  }
  const preferences = await ModelPreferences.open({ file: path.join(home, ".idou", "model-preferences.json") });
  for (const who of [LEAVER, COLLEAGUE]) await preferences.set(who, "GLM-5.3");
  const registry = await SiteRegistry.open(sites);
  for (const [who, name] of [[LEAVER, "离职者的看板"], [COLLEAGUE, "同事的看板"]]) {
    await registry.publish({ ownerId: who.userId, tenantId: TENANT, name, ...page(`<h1>${name}</h1>`), share: { scope: "tenant" } });
  }
  const ledger = await DriveBudget.fromConfig(driveConfig, SAAS_FEISHU);
  const policy = ledger.policy({ authProvider: "feishu", tenantId: TENANT, appId: APP });
  for (const who of [LEAVER, LEAVER, COLLEAGUE]) {
    ledger.db.prepare("INSERT INTO drive_reservations (tenant, id, owner, input_hash, policy_hash, bytes, state, file_token, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(policy.key, crypto.randomUUID(), ledger.owner({ authProvider: "feishu", tenantId: TENANT, appId: APP, userId: who.userId }), "a".repeat(64), "b".repeat(64), 10, "reported", "FileTok", Date.now());
  }
  ledger.close();
  const port = await new Promise((resolve) => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const { port: free } = probe.address(); probe.close(() => resolve(free)); }); });
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), LANG: process.env.LANG ?? "C",
    IDOU_SCHEDULED_TASKS: "1", IDOU_SCHEDULED_TASKS_DIR: scheduled, IDOU_DRIVE_CONFIG_FILE: driveConfig, FEISHU_APP_ID: APP,
    IDOU_SITES: "1", IDOU_SITES_URL: "http://127.0.0.1:1", IDOU_SITES_DIR: sites, IDOU_PORT: String(port) };
  return { home, env, port, scheduled, sites, driveConfig };
}

const forget = (f, ...extra) => run(process.execPath, [tool, "--tenant", TENANT, "--user", LEAVER.userId, ...extra], { env: f.env }).then(({ stdout }) => ({ stdout, code: 0 }), (error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));

test("it lists what there is, refuses to apply while the coordinator answers, then lets it go -- and nobody else's", async (t) => {
  const f = await server(t);
  const listed = await forget(f);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /定时任务 1 个，运行记录 2 条 → 删除/, "their task, and the run of the one already deleted too");
  assert.match(listed.stdout, /无人值守授权 1 份（有效） → 删除/);
  assert.match(listed.stdout, /模型偏好：GLM-5\.3 → 删除/);
  assert.match(listed.stdout, /云盘额度账本 2 条 → 删除/);
  assert.match(listed.stdout, /发布的网站 1 个，其中在线 1 个 → 下线，文件保留：「离职者的看板」/);
  assert.match(listed.stdout, /用量计数 → 保留/);
  assert.match(listed.stdout, /加 --apply 执行/);

  const coordinator = createServer(); await new Promise((resolve) => coordinator.listen(f.port, "127.0.0.1", resolve));
  const refused = await forget(f, "--apply");
  await new Promise((resolve) => coordinator.close(resolve));
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /协调副本还在 \d+ 端口上运行：先停掉它/);

  const applied = await forget(f, "--apply");
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(applied.stdout, /定时任务 1 个、运行记录 2 条已删除；无人值守授权已删除；模型偏好已删除；云盘额度账本 2 条已删除；下线网站 1 个：「离职者的看板」。用量计数保留/);

  // What is left: nothing of theirs but the offline site; everything of the colleague's.
  const schedules = new ScheduleStore({ databaseFile: path.join(f.scheduled, "schedules.db") });
  t.after(() => schedules.close());
  assert.deepEqual(schedules.ownerData(TENANT, LEAVER.userId), { schedules: 0, runs: 0 });
  assert.deepEqual(schedules.ownerData(TENANT, COLLEAGUE.userId), { schedules: 1, runs: 1 });
  const credentials = await UnattendedCredentialStore.open({ directory: path.join(f.scheduled, "unattended") });
  assert.equal(await credentials.read(TENANT, LEAVER.userId), null);
  assert.equal((await credentials.read(TENANT, COLLEAGUE.userId)).state, "active");
  const preferences = await ModelPreferences.open({ file: path.join(f.home, ".idou", "model-preferences.json") });
  assert.equal(preferences.get(LEAVER), null);
  assert.equal(preferences.get(COLLEAGUE), "GLM-5.3");
  const registry = await SiteRegistry.open(f.sites);
  const bySite = Object.fromEntries(registry.list().map((site) => [site.name, site.offline]));
  assert.deepEqual(bySite, { 离职者的看板: true, 同事的看板: false }, "taken offline, not erased; the colleague's still up");
  const offline = registry.list().find((site) => site.name === "离职者的看板");
  assert.equal((await registry.file(offline.id, "/")).bytes.toString(), "<h1>离职者的看板</h1>", "its files are kept for an administrator to decide about");
  const ledger = await DriveBudget.fromConfig(f.driveConfig, SAAS_FEISHU);
  t.after(() => ledger.close());
  assert.equal(ledger.ownerRows({ authProvider: "feishu", tenantId: TENANT, appId: APP, userId: LEAVER.userId }), 0);
  assert.equal(ledger.ownerRows({ authProvider: "feishu", tenantId: TENANT, appId: APP, userId: COLLEAGUE.userId }), 1);

  const again = await forget(f);
  assert.match(again.stdout, /定时任务 0 个，运行记录 0 条/);
  assert.match(again.stdout, /发布的网站 1 个，其中在线 0 个/);
});

test("a malformed person or tenant is refused before anything is opened", async (t) => {
  const f = await server(t);
  for (const argv of [["--tenant", TENANT, "--user", "not-an-open-id"], ["--tenant", "bad tenant", "--user", "ou_x"], []]) {
    const result = await run(process.execPath, [tool, ...argv], { env: f.env }).then(() => ({ code: 0 }), (error) => ({ code: error.code, stderr: error.stderr }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /用法：node bin\/forget-person\.js/);
  }
});
