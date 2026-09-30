#!/usr/bin/env node
// One person's data on this server, listed; and, once they have left, let go.
// What goes, what is taken offline and what stays is person-data.js's.
//
//   node bin/forget-person.js --tenant <tenant_key> --user <open_id>           what there is
//   node bin/forget-person.js --tenant <tenant_key> --user <open_id> --apply   let it go
//
// Run it as the service account with the deployment file loaded, the way the
// server itself is started (docs/server-administration.md). --apply refuses
// while the coordinator answers on its port: it holds the sites and the model
// choices in memory and writes them back whole, which would put back what was
// just taken away. Stop it, apply, start it again; sessions are in the shared
// database, so nobody is signed out.
import "../src/adopt-legacy-env.js";
import { existsSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDataStore, loadFeishuProvider, loadSitesConfig } from "../src/control-plane/server-config.js";
import { forgetPerson, personInventory, storePlaces } from "../src/control-plane/person-data.js";

const TENANT = /^[A-Za-z0-9_-]{1,256}$/;
const OPEN_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;

function option(argv, name) {
  const at = argv.indexOf(name);
  const value = at < 0 ? undefined : argv[at + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

// Whether something answers on the coordinator's port on this machine.
function answering(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 1000 }, () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

// The stores this server keeps, opened as bin/server.js opens them; a store
// this deployment does not have is left out, and nothing is created where
// there was nothing.
export async function openStores(env = process.env) {
  const feishu = loadFeishuProvider(env);
  const places = storePlaces(env);
  const durable = loadDataStore(env) === "postgres";
  const opened = { closers: [] };
  let shared = null;
  if (durable) {
    const { loadDatabaseConfig, openSharedState } = await import("../src/control-plane/database.js");
    shared = await openSharedState(loadDatabaseConfig(env), { log: () => {} });
    opened.closers.push(() => shared.close());
  }
  if (env.IDOU_SCHEDULED_TASKS === "1") {
    if (durable) {
      const { PostgresScheduleStore } = await import("../src/control-plane/schedule-store-postgres.js");
      const { PostgresUnattendedCredentialStore } = await import("../src/control-plane/unattended-credential.js");
      opened.schedules = await PostgresScheduleStore.open({ pool: shared.pool, key: shared.key });
      opened.credentials = await PostgresUnattendedCredentialStore.open({ state: shared.state });
    } else {
      const file = path.join(places.scheduledTasks, "schedules.db");
      if (existsSync(file)) {
        const { ScheduleStore } = await import("../src/control-plane/schedule-store.js");
        opened.schedules = new ScheduleStore({ databaseFile: file });
        opened.closers.push(() => opened.schedules.close());
      }
      const directory = path.join(places.scheduledTasks, "unattended");
      if (existsSync(directory)) {
        const { UnattendedCredentialStore } = await import("../src/control-plane/unattended-credential.js");
        opened.credentials = await UnattendedCredentialStore.open({ directory });
      }
    }
  }
  const { ModelPreferences, PostgresModelPreferences } = await import("../src/control-plane/model-choice.js");
  opened.preferences = durable ? await PostgresModelPreferences.open({ state: shared.state }) : await ModelPreferences.open({ file: places.modelPreferences });
  const sitesConfig = loadSitesConfig(env);
  if (sitesConfig) {
    const { SiteRegistry, PostgresSiteStorage } = await import("../src/control-plane/site-registry.js");
    opened.sites = await SiteRegistry.open(places.sites(sitesConfig.directory),
      durable ? { storage: await PostgresSiteStorage.open({ pool: shared.pool, state: shared.state, key: shared.key }) } : {});
  }
  if (env.IDOU_DRIVE_CONFIG_FILE) {
    const { DriveBudget, PostgresDriveBudget } = await import("../src/control-plane/drive-budget.js");
    opened.ledger = durable ? await PostgresDriveBudget.fromConfig(env.IDOU_DRIVE_CONFIG_FILE, feishu, { pool: shared.pool })
      : await DriveBudget.fromConfig(env.IDOU_DRIVE_CONFIG_FILE, feishu);
    opened.closers.unshift(() => opened.ledger.close());
  }
  return opened;
}

function describe(found) {
  const lines = [];
  lines.push(found.tasks ? `  定时任务 ${found.tasks.schedules} 个，运行记录 ${found.tasks.runs} 条 → 删除` : "  定时任务：这个服务端没有开");
  lines.push(found.credential ? `  无人值守授权 1 份（${found.credential.state === "active" ? "有效" : "已结束"}） → 删除` : "  无人值守授权：没有");
  lines.push(found.model ? `  模型偏好：${found.model} → 删除` : "  模型偏好：没有");
  lines.push(found.reservations === null ? "  云盘额度账本：这个服务端没有开，或不管这个企业" : `  云盘额度账本 ${found.reservations} 条 → 删除（他在云盘里的文件归飞书处理）`);
  const online = found.sites.filter((site) => !site.offline);
  lines.push(found.sites.length ? `  发布的网站 ${found.sites.length} 个，其中在线 ${online.length} 个 → 下线，文件保留：${found.sites.map((site) => `「${site.name}」`).join("")}` : "  发布的网站：没有");
  lines.push("  用量计数 → 保留（企业的账目）");
  return lines.join("\n");
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; } })();
if (invoked) {
  const argv = process.argv.slice(2);
  const tenantId = option(argv, "--tenant"), userId = option(argv, "--user"), apply = argv.includes("--apply");
  let stores = null;
  try {
    if (!TENANT.test(tenantId ?? "") || !OPEN_ID.test(userId ?? "")) throw new Error("用法：node bin/forget-person.js --tenant <tenant_key> --user <open_id> [--apply]");
    const who = { tenantId, userId, appId: process.env.FEISHU_APP_ID ?? null };
    stores = await openStores();
    const found = await personInventory({ who, ...stores });
    process.stdout.write(`${tenantId} / ${userId} 在这个服务端上有：\n${describe(found)}\n`);
    if (!apply) process.stdout.write("加 --apply 执行（先停协调副本，做完再启动）。\n");
    else {
      const port = Number(process.env.IDOU_PORT || 3041);
      if (await answering(port)) throw new Error(`协调副本还在 ${port} 端口上运行：先停掉它（它在内存里留着网站和模型偏好，会把删掉的写回去），做完再启动。`);
      const done = await forgetPerson({ who, ...stores });
      process.stdout.write(`已处理：定时任务 ${done.tasks?.schedules ?? 0} 个、运行记录 ${done.tasks?.runs ?? 0} 条已删除；`
        + `无人值守授权${done.credential ? "已删除" : "本来就没有"}；模型偏好${done.model ? "已删除" : "本来就没有"}；`
        + `云盘额度账本 ${done.reservations ?? 0} 条已删除；下线网站 ${done.sitesOffline.length} 个${done.sitesOffline.length ? `：${done.sitesOffline.map((site) => `「${site.name}」`).join("")}` : ""}。用量计数保留。\n`);
    }
  } catch (error) {
    process.stderr.write(`没有处理：${error.message}\n`);
    process.exitCode = 1;
  } finally {
    for (const close of stores?.closers ?? []) { try { await close(); } catch { /* closing what is already closed */ } }
  }
}
