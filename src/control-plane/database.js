// The PostgreSQL the replicas of the control plane share (docs/scaling-plan.md).
//
//   IDOU_DATABASE_URL     e.g. postgresql:///idou?host=/var/run/postgresql
//                             (the Unix socket, peer authentication: no password
//                             in the URL or anywhere else)
//   IDOU_STATE_KEY_FILE   32 random bytes, base64url, mode 0600: the key the
//                             shared state is sealed with (state-store.js). Every
//                             replica reads the same file; the database never
//                             holds it.
//
// Unset, there is no database: one process, state in memory, as before.
//
// A worker of the execution pool is given less (loadWorkerDatabaseConfig): the
//
//   IDOU_RUN_QUEUE_KEY_FILE  the queue's own key, made from the sealing key
//                                with bin/run-queue-key.js
//
// and a database role that reaches the queue and nothing else
// (deploy/server/worker-role.sql).
import { createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { PostgresStateStore } from "./state-store.js";

function checkedUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("IDOU_DATABASE_URL 不是合法的地址"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("IDOU_DATABASE_URL 必须是 postgresql:// 地址");
  // Neither as user:password@ nor as ?password=, which the driver also reads.
  if (parsed.password || parsed.searchParams.has("password")) throw new Error("IDOU_DATABASE_URL 不能带密码：请用本地套接字和系统身份认证（host=/var/run/postgresql）");
  return url;
}

export function loadDatabaseConfig(env = process.env) {
  const url = env.IDOU_DATABASE_URL;
  if (url === undefined || url === "") {
    if (env.IDOU_STATE_KEY_FILE) throw new Error("IDOU_STATE_KEY_FILE 需要同时设置 IDOU_DATABASE_URL");
    return null;
  }
  checkedUrl(url);
  const keyFile = env.IDOU_STATE_KEY_FILE;
  if (!keyFile || !path.isAbsolute(keyFile)) throw new Error("使用 IDOU_DATABASE_URL 时需要 IDOU_STATE_KEY_FILE（绝对路径）");
  return Object.freeze({ url, keyFile });
}

// A worker's: the database, and the queue's key. Given the sealing key instead
// -- a development machine, or a worker set up before 2026-09-28 -- it makes
// the queue's key from it; a production worker refuses that key (bin/server.js).
export function loadWorkerDatabaseConfig(env = process.env) {
  const url = env.IDOU_DATABASE_URL;
  if (url === undefined || url === "") return null;
  checkedUrl(url);
  for (const name of ["IDOU_RUN_QUEUE_KEY_FILE", "IDOU_STATE_KEY_FILE"]) {
    const file = env[name];
    if (!file) continue;
    if (!path.isAbsolute(file)) throw new Error(`${name} 必须是绝对路径`);
    return Object.freeze(name === "IDOU_RUN_QUEUE_KEY_FILE" ? { url, queueKeyFile: file } : { url, stateKeyFile: file });
  }
  throw new Error("执行节点需要 IDOU_RUN_QUEUE_KEY_FILE（绝对路径）：用 bin/run-queue-key.js 从共享库密钥生成");
}

// The key the execution pool's queue is sealed with (run-queue.js). Made from
// the sealing key, as the route key is, so the operator still keeps one
// secret; and one-way, so a worker holding it can open the runs it is to run
// and nothing the sealing key protects -- sessions, Feishu grants, schedules,
// unattended credentials.
export const runQueueKey = (stateKey) => createHmac("sha256", stateKey).update("mydoubao run queue v1").digest();

export async function readRunQueueKey({ queueKeyFile, stateKeyFile }) {
  return queueKeyFile ? readStateKey(queueKeyFile) : runQueueKey(await readStateKey(stateKeyFile));
}

// The sealing key: exactly 32 bytes, readable by nobody else.
export async function readStateKey(file) {
  const info = await stat(file);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error(`${file} 必须是只有本账号能读的文件（0600）`);
  const key = Buffer.from((await readFile(file, "utf8")).trim(), "base64url");
  if (key.length !== 32) throw new Error(`${file} 里应当是 32 字节的 base64url 密钥`);
  return key;
}

// A pool for queries, and a way to open a connection of one's own (LISTEN,
// locks). A connection that fails while idle is logged and dropped, never an
// unhandled error: a database restart must not take the server down with it.
export function openDatabase({ url, log = (line) => process.stderr.write(`${line}\n`), max = 10 }) {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, application_name: "idou" });
  pool.on("error", (error) => log(JSON.stringify({ component: "database", event: "idle-client-error", message: String(error?.message ?? error).slice(0, 200) })));
  const connect = async () => {
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, application_name: "idou" });
    client.on("error", () => { /* the owner of the connection decides; see state-store.js */ });
    await client.connect();
    return client;
  };
  return { pool, connect, close: () => pool.end() };
}

// The shared state on this database, and the key a person's route code is
// made with (sessions.js). The route key is derived from the sealing key: one
// secret for the operator to keep, not two.
export async function openSharedState({ url, keyFile }, { log } = {}) {
  const key = await readStateKey(keyFile);
  const database = openDatabase({ url, log });
  try {
    const state = await PostgresStateStore.open({ pool: database.pool, connect: database.connect, key });
    const routeKey = createHmac("sha256", key).update("mydoubao session route v1").digest();
    // The pool, a way to connect and the key, for the other tables the
    // replicas share (run-queue.js); the database is closed last.
    const extras = [];
    return { state, routeKey, pool: database.pool, connect: database.connect, key,
      closeWith(closing) { extras.push(closing); },
      close: async () => { for (const closing of extras) await closing().catch(() => {}); await state.close(); await database.close(); } };
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}
