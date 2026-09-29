// A PostgreSQL of the test's own: initdb into a temporary directory, started
// on a Unix socket in that directory and no TCP port, stopped and removed when
// the test file is done. Nothing touches a server anybody else uses -- not the
// Homebrew service on this Mac, not the production one.
//
//   const pg = await testPostgres(t)          // one per test file is enough
//   const database = await pg.database()      // a fresh, empty database
//   await pg.restart({ downMs })              // the database goes away and comes back
//
// The binaries come from IDOU_POSTGRES_BIN, else `pg_config --bindir`,
// else the usual Homebrew and Debian places. None found, the tests that need it
// fail with that sentence rather than skip: a check that quietly did not run
// reads exactly like one that passed.
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// With a Chinese (or any non-C) locale in the environment, postgres on macOS
// stops at startup: "postmaster became multithreaded during startup", its
// hint being LC_ALL. Every command here runs in the C locale.
const env = { ...process.env, LC_ALL: "C", LANG: "C" };

export function postgresBin() {
  const candidates = [process.env.IDOU_POSTGRES_BIN];
  try { candidates.push(execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim()); } catch { /* not on PATH */ }
  candidates.push("/opt/homebrew/opt/postgresql@16/bin", "/usr/local/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin");
  const found = candidates.find((dir) => dir && existsSync(path.join(dir, "initdb")) && existsSync(path.join(dir, "pg_ctl")));
  if (!found) throw new Error("没有找到 PostgreSQL（initdb / pg_ctl）：装一个，或用 IDOU_POSTGRES_BIN 指向它的 bin 目录");
  return found;
}

let counter = 0;
export async function testPostgres(t) {
  const bin = postgresBin();
  // Short: a Unix socket path must fit in about 100 bytes.
  const root = await mkdtemp(path.join(os.tmpdir(), "mdb-pg-"));
  const data = path.join(root, "data");
  await run(path.join(bin, "initdb"), ["-D", data, "-U", "mydoubao", "-A", "trust", "-E", "UTF8", "--locale=C", "--no-sync"], { timeout: 60_000, env });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const options = `-p ${port} -k ${root} -c listen_addresses= -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=200`;
  await run(path.join(bin, "pg_ctl"), ["-D", data, "-o", options, "-l", path.join(root, "log"), "-w", "-t", "30", "start"], { timeout: 60_000, env });
  // node:test runs after-hooks in the order they were registered, and this
  // one is registered before anything that connects. So the connections are
  // closed here, first -- whatever the test handed to closeFirst -- and only
  // then is the server stopped; stopped first, every open client failed with
  // "Connection terminated unexpectedly".
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close().catch(() => {});
    await run(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"], { timeout: 30_000, env }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const base = { host: root, port, user: "mydoubao" };
  return {
    ...base,
    closeFirst(close) { closers.push(close); },
    // Stopped, and started again `downMs` later: what the replicas see when
    // the database restarts. Every connection is cut.
    async restart({ downMs = 0 } = {}) {
      await run(path.join(bin, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"], { timeout: 30_000, env });
      await new Promise((resolve) => setTimeout(resolve, downMs));
      await run(path.join(bin, "pg_ctl"), ["-D", data, "-o", options, "-l", path.join(root, "log"), "-w", "-t", "30", "start"], { timeout: 60_000, env });
    },
    // A database no other test has seen.
    async database() {
      const name = `t${process.pid}_${counter += 1}`;
      await run(path.join(bin, "createdb"), ["-h", root, "-p", String(port), "-U", "mydoubao", name], { timeout: 30_000, env });
      return { ...base, database: name };
    },
  };
}
