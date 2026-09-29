// Moving the durable data between this machine's files and the shared
// PostgreSQL (bin/migrate-data.js), as the operator runs it: a process, with
// the server's settings.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { ModelUsage, PostgresModelUsage } from "../src/control-plane/model-usage.js";
import { testPostgres } from "./helpers/postgres.js";

const entry = fileURLToPath(new URL("../bin/migrate-data.js", import.meta.url));
const DAY = Date.parse("2026-09-21T10:00:00Z");

async function setup(t) {
  // Its real path: the unattended credential store refuses a directory reached
  // through a link, and the temporary directory on macOS is one.
  const home = await (await import("node:fs/promises")).realpath(await mkdtemp(path.join(os.tmpdir(), "idou-migrate-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const keyFile = path.join(home, "state.key");
  await writeFile(keyFile, randomBytes(32).toString("base64url"), { mode: 0o600 }); await chmod(keyFile, 0o600);
  const server = await testPostgres(t), config = await server.database();
  const env = { PATH: "/usr/bin:/bin", HOME: home, LANG: "C",
    IDOU_DATABASE_URL: `postgresql:///${config.database}?host=${encodeURIComponent(server.host)}&port=${server.port}&user=${server.user}`, IDOU_STATE_KEY_FILE: keyFile };
  const run = (args, extra = {}) => spawnSync(process.execPath, [entry, ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
  const pool = new pg.Pool({ ...config, max: 4 }); pool.on("error", () => {});
  server.closeFirst(() => pool.end());
  const key = Buffer.from((await import("node:fs/promises").then(({ readFile }) => readFile(keyFile, "utf8"))).trim(), "base64url");
  const connect = async () => { const client = new pg.Client(config); await client.connect(); return client; };
  return { home, run, pool, key, connect };
}

test("the usage ledger goes to the shared database and back, the same rows both ways, however often it is run", { timeout: 120_000 }, async (t) => {
  const f = await setup(t);
  const local = await ModelUsage.open({ file: path.join(f.home, ".mydoubao", "model-usage.sqlite"), now: () => DAY });
  local.record({ who: { tenantId: "t1", userId: "ou_a" }, model: "MiniMax-M3", usage: { input_tokens: 10, output_tokens: 2 } });
  local.record({ who: { tenantId: "t1", userId: "ou_b" }, model: "GLM-5.3", usage: { input_tokens: 4, output_tokens: 4 } });
  const rows = local.rows(); local.close();
  for (let round = 0; round < 2; round += 1) {
    const moved = f.run(["--to", "postgres"]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, /模型用量账本：2 条已搬到共享数据库/);
  }
  const shared = await PostgresModelUsage.open({ pool: f.pool });
  t.after(() => shared.close());
  assert.deepEqual(await shared.rows(), rows);
  const elsewhere = path.join(f.home, "back", "model-usage.sqlite");
  const back = f.run(["--to", "files"], { IDOU_MODEL_USAGE_FILE: elsewhere });
  assert.equal(back.status, 0, back.stderr);
  const returned = await ModelUsage.open({ file: elsewhere });
  t.after(() => returned.close());
  assert.deepEqual(returned.rows(), rows);
});

test("it says what it cannot do, and does nothing", { timeout: 60_000 }, async (t) => {
  const f = await setup(t);
  for (const [args, extra, message] of [
    [[], {}, /用法/],
    [["--to", "somewhere"], {}, /--to 只能是 postgres 或 files/],
    [["--to", "postgres", "--only", "nonsense"], {}, /不认识的数据：nonsense/],
    [["--to", "postgres"], { IDOU_DATABASE_URL: "", IDOU_STATE_KEY_FILE: "" }, /没有设置 IDOU_DATABASE_URL/],
  ]) {
    const refused = f.run(args, extra);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, message);
  }
});

test("model choices, the skill shelf, published sites and unattended credentials go to the shared database and back", { timeout: 180_000 }, async (t) => {
  const f = await setup(t);
  const { mkdir, realpath } = await import("node:fs/promises");
  const { ModelPreferences, PostgresModelPreferences } = await import("../src/control-plane/model-choice.js");
  const { SkillRegistry, PostgresSkillRegistry } = await import("../src/control-plane/skill-registry.js");
  const { SiteRegistry, PostgresSiteStorage } = await import("../src/control-plane/site-registry.js");
  const { UnattendedCredentialStore, PostgresUnattendedCredentialStore } = await import("../src/control-plane/unattended-credential.js");
  const { PostgresStateStore } = await import("../src/control-plane/state-store.js");
  const { appHash } = await import("../src/apps/manifest.js");
  const home = await realpath(f.home), data = path.join(home, ".mydoubao");
  await mkdir(path.join(data, "scheduled-tasks"), { recursive: true, mode: 0o700 });
  // What a coordinator on this machine has written.
  const preferences = await ModelPreferences.open({ file: path.join(data, "model-preferences.json") });
  await preferences.set({ tenantId: "t1", userId: "ou_a" }, "GLM-5.3", 10);
  const shelfFile = path.join(data, "skill-registry.json");
  const shelf = await new SkillRegistry({ filename: shelfFile, administrators: ["ou_admin"] }).load();
  await shelf.publish({ userId: "ou_admin", tenantId: "tenant_a" }, { id: "enterprise-weekly", version: "1.0.0", title: "周报助手", description: "把一周记录整理成周报", publisher: "平台组",
    requiredTools: [], runtimeVersions: { codex: ["0.147.0"], feishu: [] }, files: [{ path: "SKILL.md", text: "---\nname: enterprise-weekly\ndescription: 周报\n---\n先读。" }] });
  const sites = await SiteRegistry.open(path.join(data, "sites"));
  const body = "<h1>published here</h1>";
  const site = await sites.publish({ ownerId: "ou_owner", tenantId: "t1", name: "看板", share: { scope: "invited" },
    manifest: { schemaVersion: 1, runtime: "static", network: "none", entry: "index.html", files: [{ path: "index.html", bytes: Buffer.byteLength(body), sha256: appHash(Buffer.from(body)) }] },
    blobs: [{ path: "index.html", base64: Buffer.from(body).toString("base64") }] });
  const unattended = await UnattendedCredentialStore.open({ directory: path.join(data, "scheduled-tasks", "unattended") });
  await unattended.write("t1", "ou_a", { sealed: unattended.seal({ appId: "cli_x", tenantId: "t1", userId: "ou_a", refreshToken: "REFRESH-FIXTURE", notAfter: Date.now() + 86_400_000 }), state: "active" });

  const moved = f.run(["--to", "postgres", "--only", "preferences,skills,sites,unattended"], { IDOU_SKILL_REGISTRY_FILE: shelfFile });
  assert.equal(moved.status, 0, moved.stderr);
  for (const what of ["模型偏好：1 条", "企业技能登记：1 条", "文档网站：1 条", "无人值守凭据：2 条"]) assert.match(moved.stdout, new RegExp(what));

  const state = await PostgresStateStore.open({ pool: f.pool, key: f.key, connect: f.connect });
  t.after(() => state.close());
  assert.equal((await PostgresModelPreferences.open({ state })).get({ tenantId: "t1", userId: "ou_a" }), "GLM-5.3");
  assert.deepEqual((await new PostgresSkillRegistry({ state }).load()).list("tenant_a").map((skill) => skill.id), ["enterprise-weekly"]);
  const shared = await SiteRegistry.open(null, { storage: await PostgresSiteStorage.open({ pool: f.pool, state, key: f.key }) });
  assert.equal((await shared.file(site.id, "/")).bytes.toString(), body);
  const credentials = await PostgresUnattendedCredentialStore.open({ state });
  assert.equal(credentials.deviceId, unattended.deviceId);
  assert.equal(credentials.unseal(await credentials.read("t1", "ou_a")).refreshToken, "REFRESH-FIXTURE");

  // And back, to another machine's directories: one with nothing of the
  // product's yet keeps it under the new name (install-names.js).
  const other = path.join(home, "other");
  const back = f.run(["--to", "files", "--only", "preferences,sites,unattended"], { HOME: other });
  assert.equal(back.status, 0, back.stderr);
  const otherData = path.join(await realpath(other), ".idou");
  assert.equal((await ModelPreferences.open({ file: path.join(otherData, "model-preferences.json") })).get({ tenantId: "t1", userId: "ou_a" }), "GLM-5.3");
  assert.equal((await (await SiteRegistry.open(path.join(otherData, "sites"))).file(site.id, "/")).bytes.toString(), body);
  const returned = await UnattendedCredentialStore.open({ directory: path.join(otherData, "scheduled-tasks", "unattended") });
  assert.equal(returned.unseal(await returned.read("t1", "ou_a")).refreshToken, "REFRESH-FIXTURE");
});

test("nothing is copied over the other side from an empty source, and credentials sealed under other keys are never overwritten", { timeout: 120_000 }, async (t) => {
  const f = await setup(t);
  const { mkdir, realpath } = await import("node:fs/promises");
  const { PostgresModelPreferences } = await import("../src/control-plane/model-choice.js");
  const { UnattendedCredentialStore, PostgresUnattendedCredentialStore } = await import("../src/control-plane/unattended-credential.js");
  const { PostgresStateStore } = await import("../src/control-plane/state-store.js");
  const state = await PostgresStateStore.open({ pool: f.pool, key: f.key, connect: f.connect });
  t.after(() => state.close());
  const kept = await PostgresModelPreferences.open({ state });
  await kept.set({ tenantId: "t1", userId: "ou_a" }, "MiniMax-M3");
  const absent = f.run(["--to", "postgres", "--only", "preferences"]);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /模型偏好：跳过（本机没有这份数据）/, "not there: nothing created here, nothing moved");
  const { ModelPreferences } = await import("../src/control-plane/model-choice.js");
  const local = await ModelPreferences.open({ file: path.join(f.home, ".mydoubao", "model-preferences.json") });
  await local.set({ tenantId: "t1", userId: "ou_b" }, "GLM-5.3"); await local.set({ tenantId: "t1", userId: "ou_b" }, null);
  const empty = f.run(["--to", "postgres", "--only", "preferences"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /模型偏好：来源里没有数据，跳过/, "there but empty: not copied over the database");
  assert.equal((await PostgresModelPreferences.open({ state })).get({ tenantId: "t1", userId: "ou_a" }), "MiniMax-M3", "what the database held is still there");
  // The database already holds a credential under keys of its own.
  const there = await PostgresUnattendedCredentialStore.open({ state });
  await there.write("t9", "ou_z", { sealed: there.seal({ appId: "cli_x", tenantId: "t9", userId: "ou_z", refreshToken: "THERE", notAfter: Date.now() + 86_400_000 }), state: "active" });
  const home = await realpath(f.home), directory = path.join(home, ".mydoubao", "scheduled-tasks", "unattended");
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const disk = await UnattendedCredentialStore.open({ directory });
  await disk.write("t1", "ou_a", { sealed: disk.seal({ appId: "cli_x", tenantId: "t1", userId: "ou_a", refreshToken: "HERE", notAfter: Date.now() + 86_400_000 }), state: "active" });
  const refused = f.run(["--to", "postgres", "--only", "unattended"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /用另一把密钥封存的无人值守凭据/);
  const still = await PostgresUnattendedCredentialStore.open({ state });
  assert.equal(still.unseal(await still.read("t9", "ou_z")).refreshToken, "THERE", "and they still open");
});

test("tasks and their runs go to the shared database and back, every field as it was", { timeout: 120_000 }, async (t) => {
  const f = await setup(t);
  const { ScheduleStore } = await import("../src/control-plane/schedule-store.js");
  const { PostgresScheduleStore } = await import("../src/control-plane/schedule-store-postgres.js");
  const { mkdir } = await import("node:fs/promises");
  const directory = path.join(f.home, ".mydoubao", "scheduled-tasks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let now = Date.parse("2026-09-16T00:00:00Z");
  const local = new ScheduleStore({ databaseFile: path.join(directory, "schedules.db"), now: () => now });
  const WHO = { tenantId: "t1", userId: "ou_a", familyId: "login-a" };
  const daily = { title: "每天汇总", prompt: "把昨天的群消息汇总成三条要点。", mode: "cowork", schedule: { frequency: "daily", time: "09:00", timeZone: "Asia/Shanghai" } };
  // Where its results also go travels with it, sealed on the way in and opened on the way out.
  const kept = local.create(WHO, { ...daily, deliveries: [{ kind: "chat", id: "oc_1234567890abcdef", label: "产品群" }] }), gone = local.create(WHO, { ...daily, title: "要删掉的" });
  now = kept.nextAt;
  const ran = local.claim(kept, now); local.finish(WHO.tenantId, ran.runId, "failed", "飞书读取失败");
  now += 1000;
  const orphan = local.claimNow(gone, now); local.finish(WHO.tenantId, orphan.runId, "completed");
  local.remove(WHO, gone.id);
  const rows = local.rows(); local.close();
  for (let round = 0; round < 2; round += 1) {
    const moved = f.run(["--to", "postgres", "--only", "schedules"]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.match(moved.stdout, /定时任务：3 条已搬到共享数据库/, "one task and two runs, however often it is run");
  }
  const shared = await PostgresScheduleStore.open({ pool: f.pool, key: f.key });
  assert.deepEqual(await shared.rows(), rows);
  assert.deepEqual((await shared.get(WHO, kept.id)).deliveries, [{ kind: "chat", id: "oc_1234567890abcdef", label: "产品群" }]);
  assert.equal((await shared.recentRuns(WHO, 10)).find((run) => run.id === orphan.runId).title, "要删掉的", "a deleted task's runs keep its name");
  const other = path.join(f.home, "elsewhere");
  const back = f.run(["--to", "files", "--only", "schedules"], { HOME: other });
  assert.equal(back.status, 0, back.stderr);
  const returned = new ScheduleStore({ databaseFile: path.join(other, ".idou", "scheduled-tasks", "schedules.db") });
  t.after(() => returned.close());
  assert.deepEqual(returned.rows(), rows);
});

test("the Drive budget ledger goes to the shared database and back, kept against the operator's policies", { timeout: 120_000 }, async (t) => {
  const f = await setup(t);
  const { DriveBudget, PostgresDriveBudget } = await import("../src/control-plane/drive-budget.js");
  const { SAAS_FEISHU } = await import("../src/providers/feishu/saas-definition.js");
  const policy = { authProvider: "feishu", tenantId: "tenant", appId: "cli_synthetic", providerId: "saas-cli", driveTenantKey: "drive-tenant", folderToken: "SyntheticFolder123", maxBytes: 100 };
  const who = { authProvider: "feishu", tenantId: "tenant", appId: "cli_synthetic", userId: "alice" };
  const configure = async (name) => {
    const file = path.join(f.home, `${name}.json`);
    await writeFile(file, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(f.home, name, "budget.sqlite"), tenants: [policy] }));
    return file;
  };
  const here = await configure("drive");
  const local = await DriveBudget.fromConfig(here, SAAS_FEISHU);
  const { randomUUID } = await import("node:crypto");
  for (const bytes of [10, 20]) local.reserve(who, { id: randomUUID(), policyDigest: local.snapshot(who).policyDigest, providerId: policy.providerId,
    driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken, bytes, sha256: "a".repeat(64) });
  const rows = local.rows(); local.close();
  const skipped = f.run(["--to", "postgres", "--only", "drive"]);
  assert.match(skipped.stdout, /云盘额度账本：跳过（没有设置 IDOU_DRIVE_CONFIG_FILE）/, "no policy file, nothing to go by");
  const moved = f.run(["--to", "postgres", "--only", "drive"], { IDOU_DRIVE_CONFIG_FILE: here });
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /云盘额度账本：2 条已搬到共享数据库/);
  const shared = await PostgresDriveBudget.open({ pool: f.pool, policies: [policy], feishu: SAAS_FEISHU });
  assert.deepEqual(await shared.rows(), rows);
  assert.equal((await shared.snapshot(who)).chargedBytes, 30, "what was spent is still spent");
  const elsewhere = await configure("elsewhere");
  const back = f.run(["--to", "files", "--only", "drive"], { IDOU_DRIVE_CONFIG_FILE: elsewhere });
  assert.equal(back.status, 0, back.stderr);
  const returned = await DriveBudget.fromConfig(elsewhere, SAAS_FEISHU);
  t.after(() => returned.close());
  assert.deepEqual(returned.rows(), rows);
});

test("it will not run beside a coordinator holding the shared data's lease, and runs once it is given up", { timeout: 60_000 }, async (t) => {
  const f = await setup(t);
  const { CoordinatorLease } = await import("../src/control-plane/coordinator-lease.js");
  const lease = await CoordinatorLease.open({ pool: f.pool, holder: "machine-a/1234/fixture" });
  assert.equal(await lease.take(), true);
  const refused = f.run(["--to", "postgres"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /协调副本 machine-a\/1234\/fixture 正在运行（持有共享数据库的租约）：先停掉它再搬/);
  assert.equal(await lease.release(), true);
  const allowed = f.run(["--to", "postgres"]);
  assert.equal(allowed.status, 0, allowed.stderr);
});
