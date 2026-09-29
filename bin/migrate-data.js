#!/usr/bin/env node
// Moves the control plane's durable data between this machine's files and the
// shared PostgreSQL (docs/scaling-plan.md §2.5), either way:
//
//   node bin/migrate-data.js --to postgres     before setting IDOU_DATA_STORE=postgres
//   node bin/migrate-data.js --to files        to go back
//   node bin/migrate-data.js --to postgres --only usage,schedules
//
// Reads the same settings the server does (IDOU_DATABASE_URL,
// IDOU_STATE_KEY_FILE, the data file locations), so run it with the
// server's configuration loaded and the coordinator stopped: data written
// while it copies would be missed. It copies what is there, replacing what the
// destination holds under the same keys -- so running it twice is the same as
// running it once -- then reads both sides back and stops with an error if
// they differ. The source is never changed.
import "../src/adopt-legacy-env.js";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadDatabaseConfig, openSharedState } from "../src/control-plane/database.js";
import { dataHome } from "../src/install-names.js";

const home = () => dataHome();

// Each store: how to open it on either side, how to read everything it holds,
// and how to load that into the other side.
export function stores(env = process.env) {
  const usageFile = env.IDOU_MODEL_USAGE_FILE ?? path.join(home(), "model-usage.sqlite");
  const scheduled = env.IDOU_SCHEDULED_TASKS_DIR || path.join(home(), "scheduled-tasks");
  const sites = String(env.IDOU_SITES_DIR ?? "").trim() || path.join(home(), "sites");
  return {
    usage: {
      what: "模型用量账本",
      // Whether this machine has it at all: moving out of files, one that is
      // not there is skipped rather than created empty.
      here: () => existsSync(usageFile),
      async files() { const { ModelUsage } = await import("../src/control-plane/model-usage.js"); return ModelUsage.open({ file: usageFile }); },
      async postgres(shared) { const { PostgresModelUsage } = await import("../src/control-plane/model-usage.js"); return PostgresModelUsage.open({ pool: shared.pool }); },
      read: async (store) => store.rows(),
      write: async (store, rows) => store.load(rows),
    },
    preferences: {
      what: "模型偏好",
      here: () => existsSync(path.join(home(), "model-preferences.json")),
      async files() { const { ModelPreferences } = await import("../src/control-plane/model-choice.js"); return ModelPreferences.open({ file: path.join(home(), "model-preferences.json") }); },
      async postgres(shared) { const { PostgresModelPreferences } = await import("../src/control-plane/model-choice.js"); return PostgresModelPreferences.open({ state: shared.state }); },
      read: async (store) => store.entries(),
      write: async (store, entries) => store.load(entries),
    },
    skills: {
      what: "企业技能登记",
      here: () => existsSync(env.IDOU_SKILL_REGISTRY_FILE),
      // Only where the shelf is writable at all.
      skip: () => !env.IDOU_SKILL_REGISTRY_FILE && "没有设置 IDOU_SKILL_REGISTRY_FILE",
      async files() { const { SkillRegistry } = await import("../src/control-plane/skill-registry.js"); return new SkillRegistry({ filename: env.IDOU_SKILL_REGISTRY_FILE }).load(); },
      async postgres(shared) { const { PostgresSkillRegistry } = await import("../src/control-plane/skill-registry.js"); return new PostgresSkillRegistry({ state: shared.state }).load(); },
      read: async (store) => { const { serializeRegistry } = await import("../src/control-plane/skill-registry.js"); return store.state.tenants.size ? [serializeRegistry(store.state)] : []; },
      write: async (store, [shelf]) => { const { parseRegistry } = await import("../src/control-plane/skill-registry.js"); const state = parseRegistry(shelf); await store.write(state); store.state = state; },
    },
    sites: {
      what: "文档网站",
      here: () => existsSync(path.join(sites, "sites.json")),
      async files() { const { SiteRegistry } = await import("../src/control-plane/site-registry.js"); return SiteRegistry.open(sites); },
      async postgres(shared) {
        const { SiteRegistry, PostgresSiteStorage } = await import("../src/control-plane/site-registry.js");
        return SiteRegistry.open(null, { storage: await PostgresSiteStorage.open({ pool: shared.pool, state: shared.state, key: shared.key }) });
      },
      read: async (store) => store.dump(),
      write: async (store, dumped) => store.restore(dumped),
    },
    schedules: {
      what: "定时任务",
      here: () => existsSync(path.join(scheduled, "schedules.db")),
      async files() {
        const { ScheduleStore } = await import("../src/control-plane/schedule-store.js");
        mkdirSync(scheduled, { recursive: true, mode: 0o700 });
        return new ScheduleStore({ databaseFile: path.join(scheduled, "schedules.db") });
      },
      async postgres(shared) { const { PostgresScheduleStore } = await import("../src/control-plane/schedule-store-postgres.js"); return PostgresScheduleStore.open({ pool: shared.pool, key: shared.key }); },
      // Tasks and their runs, each row marked with its table, tasks first: a run
      // is only ever loaded beside the task it may still belong to.
      read: async (store) => { const { schedules, runs } = await store.rows(); return [...schedules.map((row) => ({ table: "schedules", ...row })), ...runs.map((row) => ({ table: "runs", ...row }))]; },
      write: async (store, rows) => {
        const of = (table) => rows.filter((row) => row.table === table).map(({ table: _table, ...row }) => row);
        await store.load({ schedules: of("schedules"), runs: of("runs") });
      },
    },
    drive: {
      what: "云盘额度账本",
      // The operator's policy file names this machine's ledger and the policies
      // it is kept against.
      skip: () => !env.IDOU_DRIVE_CONFIG_FILE && "没有设置 IDOU_DRIVE_CONFIG_FILE",
      here: () => { try { return existsSync(JSON.parse(readFileSync(env.IDOU_DRIVE_CONFIG_FILE, "utf8")).databaseFile); } catch { return false; } },
      async files() {
        const [{ DriveBudget }, { loadFeishuProvider }] = await Promise.all([import("../src/control-plane/drive-budget.js"), import("../src/control-plane/server-config.js")]);
        return DriveBudget.fromConfig(env.IDOU_DRIVE_CONFIG_FILE, loadFeishuProvider(env));
      },
      async postgres(shared) {
        const [{ PostgresDriveBudget }, { loadFeishuProvider }] = await Promise.all([import("../src/control-plane/drive-budget.js"), import("../src/control-plane/server-config.js")]);
        return PostgresDriveBudget.fromConfig(env.IDOU_DRIVE_CONFIG_FILE, loadFeishuProvider(env), { pool: shared.pool });
      },
      read: async (store) => store.rows(),
      write: async (store, rows) => store.load(rows),
    },
    unattended: {
      what: "无人值守凭据",
      here: () => existsSync(path.join(scheduled, "unattended", "sealing.key")),
      async files() { const { UnattendedCredentialStore } = await import("../src/control-plane/unattended-credential.js"); return UnattendedCredentialStore.open({ directory: path.join(scheduled, "unattended") }); },
      async postgres(shared) { const { PostgresUnattendedCredentialStore } = await import("../src/control-plane/unattended-credential.js"); return PostgresUnattendedCredentialStore.open({ state: shared.state }); },
      // The keys first, then one entry a record: what the records were sealed
      // with travels with them.
      read: async (store) => { const dumped = await store.dump(); return dumped.records.length ? [{ keys: { sealing: dumped.sealing, device: dumped.device } }, ...dumped.records] : []; },
      write: async (store, [{ keys }, ...records]) => {
        const there = await store.dump();
        // Records sealed under other keys would never open again.
        if (there.records.length && there.sealing !== keys.sealing) throw new Error("目标那边已有用另一把密钥封存的无人值守凭据，搬过去会让它们再也打不开，已停止");
        await store.restore({ ...keys, records });
      },
    },
  };
}

export async function migrate({ to, only = null, env = process.env, log = (line) => process.stdout.write(`${line}\n`) }) {
  if (!["postgres", "files"].includes(to)) throw new Error("--to 只能是 postgres 或 files");
  const config = loadDatabaseConfig(env);
  if (!config) throw new Error("没有设置 IDOU_DATABASE_URL：没有共享数据库可以搬进搬出");
  const all = stores(env);
  const names = only ?? Object.keys(all);
  for (const name of names) if (!all[name]) throw new Error(`不认识的数据：${name}（有 ${Object.keys(all).join("、")}）`);
  const shared = await openSharedState(config);
  const moved = {};
  try {
    // A coordinator on the shared data holds its lease (§2.6): what it writes
    // while this copies would be missed, or copied over.
    const { CoordinatorLease } = await import("../src/control-plane/coordinator-lease.js");
    const holding = await CoordinatorLease.current(shared.pool);
    if (holding?.live) throw new Error(`协调副本 ${holding.holder} 正在运行（持有共享数据库的租约）：先停掉它再搬，否则搬的过程中它写进来的数据会漏掉或被覆盖`);
    for (const name of names) {
      const store = all[name];
      const skipped = store.skip?.() || (to === "postgres" && !store.here() && "本机没有这份数据");
      if (skipped) { log(`${store.what}：跳过（${skipped}）。`); continue; }
      const from = to === "postgres" ? await store.files() : await store.postgres(shared);
      const into = to === "postgres" ? await store.postgres(shared) : await store.files();
      try {
        const rows = await store.read(from);
        // Nothing there is not an empty set to copy over what the other side holds.
        if (!rows.length) { log(`${store.what}：来源里没有数据，跳过。`); moved[name] = { rows: 0, destination: null }; continue; }
        await store.write(into, rows);
        const back = await store.read(into);
        // What the destination holds under the keys it was given must be what
        // was read; anything else it held before is left, and said.
        const keyOf = (row) => JSON.stringify(row);
        const landed = new Set(back.map(keyOf));
        const missing = rows.filter((row) => !landed.has(keyOf(row)));
        if (missing.length) throw new Error(`${store.what}：搬过去以后读回来少了 ${missing.length} 条，已停止`);
        moved[name] = { rows: rows.length, destination: back.length };
        log(`${store.what}：${rows.length} 条已搬到${to === "postgres" ? "共享数据库" : "本机文件"}${back.length > rows.length ? `（那边原来还有 ${back.length - rows.length} 条，保留未动）` : ""}。`);
      } finally {
        await Promise.resolve(from.close?.()).catch(() => {});
        await Promise.resolve(into.close?.()).catch(() => {});
      }
    }
  } finally { await shared.close(); }
  return moved;
}

async function main() {
  const args = process.argv.slice(2);
  const toAt = args.indexOf("--to"), onlyAt = args.indexOf("--only");
  const to = toAt >= 0 ? args[toAt + 1] : null;
  const only = onlyAt >= 0 ? String(args[onlyAt + 1] ?? "").split(",").filter(Boolean) : null;
  if (!to) throw new Error("用法：node bin/migrate-data.js --to postgres|files [--only usage,...]");
  await migrate({ to, only });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`migrate-data: ${error.message}\n`); process.exit(1); });
}
