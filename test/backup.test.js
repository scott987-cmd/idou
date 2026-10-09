// The server's data, backed up while it runs (bin/backup.js). Its databases run
// in WAL mode and what was last written sits in the -wal file -- 2.3 MB of the
// usage ledger on the server on 2026-09-26 -- so a copy of the main file alone
// loses it. Here a writer keeps its connection open with automatic
// checkpoints off, so every row it wrote is only in the WAL when the backup is
// taken, and the snapshot must still hold them.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const tool = fileURLToPath(new URL("../bin/backup.js", import.meta.url));

async function dataDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), backups = path.join(root, "backups");
  await mkdir(path.join(data, "scheduled-tasks", "runs", "run-1"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(data, "sites", "site-1"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(data, "skill-signing.pem"), "-----BEGIN PRIVATE KEY-----\nfixture\n", { mode: 0o600 });
  await writeFile(path.join(data, "sites", "site-1", "index.html"), "<p>站点</p>", { mode: 0o644 });
  await writeFile(path.join(data, "scheduled-tasks", "runs", "run-1", "task.json"), "{}");
  const writer = new DatabaseSync(path.join(data, "scheduled-tasks", "schedules.db"));
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE schedules (id TEXT PRIMARY KEY, title TEXT)");
  const insert = writer.prepare("INSERT INTO schedules VALUES (?, ?)");
  for (let index = 0; index < 200; index += 1) insert.run(`s${index}`, `任务 ${index}`);
  return { data, backups, writer };
}

test("a live database's snapshot holds what is still only in its WAL, and passes its check", { timeout: 60_000 }, async (t) => {
  const { data, backups } = await dataDirectory(t);
  const wal = await stat(path.join(data, "scheduled-tasks", "schedules.db-wal"));
  assert.ok(wal.size > 10_000, "the rows are in the WAL, not yet in the main file");
  const { stdout } = await run(process.execPath, [tool, "--data", data, "--to", backups, "--keep", "2"]);
  assert.match(stdout, /备份完成：.*3 个文件（其中 1 个数据库，都通过了完整性检查）/);
  const [snapshot] = await readdir(backups);
  assert.match(snapshot, /^(?:idou|mydoubao)-\d{8}T\d{9}Z$/);
  const at = path.join(backups, snapshot);
  assert.equal((await stat(at)).mode & 0o777, 0o700, "readable only by the user that made it");
  const copy = new DatabaseSync(path.join(at, "scheduled-tasks", "schedules.db"), { readOnly: true });
  t.after(() => copy.close());
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM schedules").get().n, 200, "every row, including those only in the WAL");
  const names = (await readdir(at, { recursive: true })).map((name) => name.split(path.sep).join("/")).sort();
  assert.ok(!names.some((name) => /-(wal|shm)$/.test(name)), "no side files: the snapshot is whole on its own");
  assert.ok(!names.some((name) => name.startsWith("scheduled-tasks/runs")), "run workspaces are transient and left out");
  assert.equal((await stat(path.join(at, "skill-signing.pem"))).mode & 0o777, 0o600, "a key keeps its mode");
  assert.equal(await readFile(path.join(at, "sites", "site-1", "index.html"), "utf8"), "<p>站点</p>");
  const manifest = JSON.parse(await readFile(path.join(at, "backup.json"), "utf8"));
  for (const file of manifest.files) {
    assert.equal(createHash("sha256").update(await readFile(path.join(at, file.path))).digest("hex"), file.sha256, `${file.path} is what the manifest says`);
  }
  assert.deepEqual(manifest.files.map((file) => [file.path, file.kind]), [["scheduled-tasks/schedules.db", "sqlite"], ["sites/site-1/index.html", "file"], ["skill-signing.pem", "file"]]);
});

test("only the newest are kept, and a backup that cannot be completed leaves nothing that looks like one", { timeout: 60_000 }, async (t) => {
  const { data, backups } = await dataDirectory(t);
  for (let index = 0; index < 3; index += 1) {
    await run(process.execPath, [tool, "--data", data, "--to", backups, "--keep", "2"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await readdir(backups)).filter((name) => /^(?:idou|mydoubao)-/.test(name)).length, 2);
  // A file it cannot read: the backup fails, says so, and leaves no partial snapshot.
  const locked = path.join(data, "locked.json");
  await writeFile(locked, "{}", { mode: 0o000 });
  t.after(() => chmod(locked, 0o600).catch(() => {}));
  if (process.getuid?.() !== 0) {
    const failed = await run(process.execPath, [tool, "--data", data, "--to", backups]).then(() => null, (error) => error);
    assert.ok(failed, "an unreadable file fails the backup");
    assert.match(failed.stderr, /备份失败/);
    assert.equal((await readdir(backups)).filter((name) => name.endsWith(".partial")).length, 0);
  }
  // And it refuses what would copy the data into itself, or a relative path.
  for (const args of [["--data", data, "--to", path.join(data, "inside")], ["--data", "relative", "--to", backups], ["--to", backups]]) {
    const refused = await run(process.execPath, [tool, ...args]).then(() => null, (error) => error);
    assert.match(refused?.stderr ?? "", /备份失败/, args.join(" "));
  }
});

// docs/service-status.md §4: each run says what it did beside the snapshots,
// for the server's 备份 check; a failure keeps when the last one worked.
test("each run writes what it did to status.json, and a failure keeps when the last one worked", { timeout: 60_000 }, async (t) => {
  const { data, backups } = await dataDirectory(t);
  await run(process.execPath, [tool, "--data", data, "--to", backups]);
  const first = JSON.parse(await readFile(path.join(backups, "status.json"), "utf8"));
  assert.equal(first.last.ok, true);
  assert.equal(first.lastSuccess.snapshot, first.last.snapshot);
  assert.deepEqual([first.last.files, first.last.databases, first.last.bytes > 0, first.last.sealed, first.last.shipped], [3, 1, true, false, false]);
  assert.equal((await stat(path.join(backups, "status.json"))).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(first).includes("任务"), "what was backed up is not in it");
  const failed = await run(process.execPath, [tool, "--data", path.join(data, "missing"), "--to", backups]).then(() => null, (error) => error);
  assert.match(failed?.stderr ?? "", /备份失败/);
  const second = JSON.parse(await readFile(path.join(backups, "status.json"), "utf8"));
  assert.equal(second.last.ok, false);
  assert.match(second.last.error, /ENOENT|不是目录|no such file/);
  assert.deepEqual(second.lastSuccess, first.lastSuccess);
  assert.equal((await readdir(backups)).filter((name) => name.includes(".partial")).length, 0);
});

// Found in review (2026-10-03): pg_dump got the database address -- password
// included -- on its command line, which every account on the machine can
// read, and when it was killed Node's error repeated the command line into
// status.json, the 备份 check, the console and the administrators' alerts.
test("the database password never reaches a command line or a backup record", { timeout: 60_000 }, async (t) => {
  const { postgresTarget, withoutCredentials } = await import("../bin/backup.js");
  assert.deepEqual(postgresTarget("postgresql://idou:S3cret%40pw@db.example:5432/idou?sslmode=require"),
    { dbname: "postgresql://idou@db.example:5432/idou?sslmode=require", env: { PGPASSWORD: "S3cret@pw" } });
  assert.deepEqual(postgresTarget("postgresql:///mydoubao?host=/var/run/postgresql"), { dbname: "postgresql:///mydoubao?host=/var/run/postgresql", env: {} });
  // Addresses libpq takes that a URL parser does not, passed on as written.
  assert.deepEqual(postgresTarget("postgresql://idou@/mydoubao?host=/var/run/postgresql"), { dbname: "postgresql://idou@/mydoubao?host=/var/run/postgresql", env: {} });
  assert.deepEqual(postgresTarget("postgresql://u:p@h1:5432,h2:5432/db"), { dbname: "postgresql://u@h1:5432,h2:5432/db", env: { PGPASSWORD: "p" } });
  // An unencoded "@" in the password, as the server's own client reads it: all of it moves.
  assert.deepEqual(postgresTarget("postgresql://user:p@ss@db.example/idou"), { dbname: "postgresql://user@db.example/idou", env: { PGPASSWORD: "p@ss" } });
  assert.deepEqual(postgresTarget("postgresql://u@h/db?sslmode=require&password=se%26cret&application_name=x"), { dbname: "postgresql://u@h/db?sslmode=require&application_name=x", env: { PGPASSWORD: "se&cret" } });
  assert.equal(withoutCredentials("Command failed: pg_dump --dbname postgres://idou:S3cret@db/idou"), "Command failed: pg_dump --dbname postgres://…");
  // A pg_dump that is killed before it says anything, as the 1-hour limit would.
  const { data, backups } = await dataDirectory(t);
  const bin = path.join(path.dirname(data), "pg-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "pg_dump"), "#!/bin/sh\necho \"$*\" > \"$(dirname \"$0\")/args\"\necho \"$PGPASSWORD\" > \"$(dirname \"$0\")/env\"\nkill -9 $$\n", { mode: 0o755 });
  const failed = await run(process.execPath, [tool, "--data", data, "--to", backups, "--postgres", "postgresql://idou:S3cret@db.example/idou", "--pg-bin", bin]).then(() => null, (error) => error);
  assert.match(failed?.stderr ?? "", /pg_dump 没有完成：被终止/);
  const written = await readFile(path.join(backups, "status.json"), "utf8");
  assert.equal(written.includes("S3cret"), false);
  assert.equal(failed.stderr.includes("S3cret"), false);
  assert.equal((await readFile(path.join(bin, "args"), "utf8")).includes("S3cret"), false, "not on its command line");
  assert.equal((await readFile(path.join(bin, "env"), "utf8")).trim(), "S3cret", "in its environment");
  // --postgres-env: the address read from a variable, on nobody's command line.
  const fromEnv = await new Promise((resolve) => execFile(process.execPath, [tool, "--data", data, "--to", backups, "--postgres-env", "IDOU_DATABASE_URL", "--pg-bin", bin],
    { env: { ...process.env, IDOU_DATABASE_URL: "postgresql://idou:Env0nly@db.example/idou" } }, (error, stdout, stderr) => resolve({ error, stderr })));
  assert.match(fromEnv.stderr, /pg_dump 没有完成/);
  assert.equal((await readFile(path.join(bin, "env"), "utf8")).trim(), "Env0nly");
  // A record from before -- or edited by hand -- is read without its credentials too.
  const { readBackupStatus } = await import("../src/control-plane/health-monitor.js");
  await writeFile(path.join(backups, "status.json"), JSON.stringify({ last: { ok: false, endedAt: new Date().toISOString(), error: "Command failed: pg_dump postgresql://idou:Old5ecret@db/idou" } }));
  assert.equal(JSON.stringify(await readBackupStatus(backups)).includes("Old5ecret"), false);
  await writeFile(path.join(backups, "status.json"), "{ not json");
  await assert.rejects(readBackupStatus(backups), (error) => error.code === "ECORRUPT");
});

// The product was renamed, and so are the snapshots it takes. The newest are
// kept by the time they were taken: named by the time alone, every idou- one
// sorts before every mydoubao- one, and the newest would be the ones removed.
test("snapshots from before the rename count among the newest by their time, not their name", { timeout: 60_000 }, async (t) => {
  const { data, backups } = await dataDirectory(t);
  const { mkdir } = await import("node:fs/promises");
  for (const name of ["idou-20260101T000000000Z", "mydoubao-20260102T000000000Z", "idou-20260103T000000000Z", "mydoubao-20260104T000000000Z"]) {
    await mkdir(path.join(backups, name), { recursive: true });
  }
  await mkdir(path.join(backups, "idou-20260105T000000000Z.partial"));
  await run(process.execPath, [tool, "--data", data, "--to", backups, "--keep", "3"]);
  // status.json beside them is the run's record (docs/service-status.md §4), not a snapshot.
  const left = (await readdir(backups)).filter((name) => name !== "status.json").sort();
  assert.equal(left.length, 3, left.join(" "));
  assert.ok(left.includes("idou-20260103T000000000Z") && left.includes("mydoubao-20260104T000000000Z"), left.join(" "));
  assert.ok(left.some((name) => /^(?:idou|mydoubao)-2\d{7}T\d{9}Z$/.test(name) && name.slice(-19) > "20260104T000000000Z"), "and the one just taken");
});

// As the server's timer runs it: through /opt/idou/app, a link to the
// release directory. Its first run there did nothing and exited 0 -- the tool
// did not recognise that it had been started (2026-09-26).
test("run through a link to its release, as the server's timer runs it, it backs up", { timeout: 60_000 }, async (t) => {
  const { data, backups } = await dataDirectory(t);
  const release = path.dirname(path.dirname(tool));
  const link = path.join(path.dirname(backups), "app");
  await symlink(release, link);
  const { stdout } = await run(process.execPath, [path.join(link, "bin", "backup.js"), "--data", data, "--to", backups]);
  assert.match(stdout, /备份完成/);
  assert.equal((await readdir(backups)).filter((name) => /^(?:idou|mydoubao)-/.test(name)).length, 1);
});
