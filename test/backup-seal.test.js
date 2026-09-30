// The sealed copy that leaves the server (bin/backup.js --seal, backup-seal.js),
// what it is handed to (--ship), and the restore drill (--drill). Found in the
// long-running review (2026-09-29): every backup was on the disk it protects,
// the shared database was not in it at all, and none had ever been restored.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { backup, drill, verifySnapshot } from "../bin/backup.js";
import { openSealed, recipient, sealDirectory } from "../src/control-plane/backup-seal.js";
import { postgresBin, testPostgres } from "./helpers/postgres.js";

const run = promisify(execFile);
const tool = fileURLToPath(new URL("../bin/backup.js", import.meta.url));
const keys = (bits = 3072) => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  return { publicPem: publicKey.export({ type: "spki", format: "pem" }), privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) };
};
const OPERATOR = keys(), STRANGER = keys();
const stops = [];
after(async () => { for (const stop of stops.splice(0).reverse()) await stop(); });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "idou-seal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), backups = path.join(root, "backups"), keysDir = path.join(root, "keys");
  await mkdir(path.join(data, "scheduled-tasks"), { recursive: true, mode: 0o700 });
  await mkdir(keysDir, { mode: 0o700 });
  await writeFile(path.join(data, "unattended-sealing.key"), "synthetic-sealing-key", { mode: 0o600 });
  const db = new DatabaseSync(path.join(data, "scheduled-tasks", "schedules.db"));
  db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY, title TEXT)");
  db.prepare("INSERT INTO schedules VALUES (?, ?)").run("s1", "每天汇总");
  db.close();
  const publicKey = path.join(keysDir, "backup-public.pem"), privateKey = path.join(keysDir, "backup-private.pem");
  await writeFile(publicKey, OPERATOR.publicPem); await writeFile(privateKey, OPERATOR.privatePem, { mode: 0o600 });
  const stateKey = path.join(keysDir, "state.key");
  await writeFile(stateKey, "synthetic-state-key-bytes", { mode: 0o600 });
  return { root, data, backups, publicKey, privateKey, stateKey };
}

test("a sealed copy holds nothing readable, opens only with the operator's key, and the drill restores it whole", async (t) => {
  const { root, data, backups, publicKey, privateKey, stateKey } = await fixture(t);
  const result = await backup({ data, to: backups, seal: publicKey, also: [stateKey] });
  assert.ok(result.sealed.file.endsWith(".idou-backup"));
  assert.equal((await stat(result.sealed.file)).mode & 0o777, 0o600);
  const bytes = await readFile(result.sealed.file);
  for (const secret of ["synthetic-sealing-key", "synthetic-state-key-bytes", "每天汇总"]) {
    assert.equal(bytes.includes(Buffer.from(secret)), false, `${secret} is not in the sealed copy`);
  }
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["extra/state.key", "scheduled-tasks/schedules.db", "unattended-sealing.key"]);

  const drills = async () => (await readdir(os.tmpdir())).filter((name) => name.startsWith("idou-drill-")).sort();
  const before = await drills();
  const drilled = await drill({ target: result.sealed.file, key: privateKey });
  assert.deepEqual({ opened: drilled.opened, files: drilled.files, databases: drilled.databases }, { opened: true, files: 3, databases: 1 });
  assert.deepEqual(await drills(), before, "what it opened is removed again: it holds every secret the server has");

  const stranger = path.join(root, "keys", "other.pem");
  await writeFile(stranger, STRANGER.privatePem);
  await assert.rejects(drill({ target: result.sealed.file, key: stranger }), /这个私钥打不开这份备份/);
  await assert.rejects(drill({ target: result.sealed.file }), /需要 --key/);

  // One byte changed anywhere after the header, and nothing is unpacked.
  const tampered = path.join(root, "tampered.idou-backup");
  const altered = Buffer.from(bytes); altered[altered.length - 40] ^= 0x01;
  await writeFile(tampered, altered);
  await assert.rejects(drill({ target: tampered, key: privateKey }), /被改动过或不完整/);
  // The header is bound too: a different snapshot name is not the same file.
  const renamed = path.join(root, "renamed.idou-backup");
  await writeFile(renamed, Buffer.from(bytes.toString("latin1").replace(/"snapshot":"([a-z]+)-(\d{8})T/, '"snapshot":"$1-20000101T'), "latin1"));
  await assert.rejects(drill({ target: renamed, key: privateKey }), /被改动过或不完整/);
});

test("the drill finds a file that changed, one that is gone, and a database that does not open whole", async (t) => {
  const { data, backups } = await fixture(t);
  const { snapshot } = await backup({ data, to: backups });
  assert.equal((await verifySnapshot(snapshot)).files, 2);
  await writeFile(path.join(snapshot, "unattended-sealing.key"), "changed");
  await writeFile(path.join(snapshot, "scheduled-tasks", "schedules.db"), "not a database");
  await assert.rejects(drill({ target: snapshot }), (error) => /unattended-sealing\.key：内容和清单不符/.test(error.message) && /schedules\.db：内容和清单不符/.test(error.message));
  await rm(path.join(snapshot, "unattended-sealing.key"));
  await assert.rejects(verifySnapshot(snapshot), /unattended-sealing\.key：不见了/);
});

test("the sealed copy is handed to the operator's program, and one it could not ship fails the run and stays", async (t) => {
  const { root, data, backups, publicKey } = await fixture(t);
  const shipped = path.join(root, "offsite");
  await mkdir(shipped);
  const ship = path.join(root, "ship.sh");
  await writeFile(ship, `#!/bin/sh\ncp "$1" "${shipped}/"\n`); await chmod(ship, 0o755);
  const { stdout } = await run(process.execPath, [tool, "--data", data, "--to", backups, "--seal", publicKey, "--ship", ship]);
  assert.match(stdout, /加密副本 .*\.idou-backup（.* MB）已送出/);
  assert.equal((await readdir(shipped)).length, 1);

  const failing = path.join(root, "fail.sh");
  await writeFile(failing, "#!/bin/sh\necho 'bucket refused' >&2\nexit 3\n"); await chmod(failing, 0o755);
  const refused = await run(process.execPath, [tool, "--data", data, "--to", backups, "--seal", publicKey, "--ship", failing]).then(() => null, (error) => error);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /备份已做好.*加密副本也在.*送出去失败了：bucket refused/);
  assert.equal((await readdir(path.join(backups, "sealed"))).filter((name) => name.endsWith(".idou-backup")).length, 2, "it stays for the next attempt, or a person");

  await assert.rejects(backup({ data, to: backups, ship }), /--ship 只送加密后的备份/);
  await assert.rejects(backup({ data, to: backups, seal: publicKey, ship: "relative.sh" }), /要用绝对路径/);
  const weak = path.join(root, "weak.pem");
  await writeFile(weak, keys(2048).publicPem);
  await assert.rejects(backup({ data, to: backups, seal: weak }), /至少要 3072 位/);
});

test("only the newest sealed copies are kept, as with the snapshots", async (t) => {
  const { data, backups, publicKey } = await fixture(t);
  for (const at of ["2026-10-01T03:30:00Z", "2026-10-02T03:30:00Z", "2026-10-03T03:30:00Z"]) {
    await backup({ data, to: backups, keep: 2, seal: publicKey, now: new Date(at) });
  }
  const sealed = (await readdir(path.join(backups, "sealed"))).sort();
  assert.equal(sealed.length, 2);
  assert.match(sealed[0], /-20261002T/);
});

// Sealed, not signed: anybody with the public key can make one. Opening it
// never lets the archive put anything outside the snapshot's directory.
test("a sealed file whose archive holds a link, or reaches outside its snapshot, is refused before anything is unpacked", async (t) => {
  const { root, privateKey } = await fixture(t);
  const name = "idou-20261001T033000000Z";
  const made = path.join(root, "made");
  await mkdir(path.join(made, name), { recursive: true });
  await symlink("/etc/hosts", path.join(made, name, "hosts"));
  const file = path.join(root, "link.idou-backup");
  await sealDirectory({ root: made, name, publicKeyPem: OPERATOR.publicPem, file });
  const into = path.join(root, "into");
  await assert.rejects(openSealed({ file, privateKeyPem: await readFile(privateKey, "utf8"), into }), /不该有的条目：idou-20261001T033000000Z\/hosts/);
  assert.deepEqual(await readdir(into), [], "nothing was unpacked");
  assert.equal(recipient(OPERATOR.publicPem).fingerprint.length, 64);
});

test("the shared database is dumped into the backup, read back, and checked again by the drill", async (t) => {
  const server = await testPostgres({ after: (stop) => stops.push(stop) });
  const database = await server.database();
  const pool = new pg.Pool({ ...database, max: 1 });
  await pool.query("CREATE TABLE idou_schedules (id text PRIMARY KEY, title bytea)");
  await pool.query("INSERT INTO idou_schedules VALUES ('s1', '\\x0102')");
  await pool.end();
  const url = `postgresql:///${database.database}?host=${encodeURIComponent(database.host)}&port=${database.port}&user=${database.user}`;
  const { data, backups, publicKey, privateKey } = await fixture(t);
  const result = await backup({ data, to: backups, postgres: url, pgBin: postgresBin(), seal: publicKey });
  const dump = result.files.find((file) => file.kind === "postgres");
  assert.ok(dump?.bytes > 0);
  const drilled = await drill({ target: result.sealed.file, key: privateKey, pgBin: postgresBin() });
  assert.equal(drilled.postgres, true);
  await assert.rejects(backup({ data, to: backups, postgres: url.replace(database.database, "no_such_database"), pgBin: postgresBin() }), /pg_dump 没有完成/);
});

test("a sealed copy is opened for a restore only into a directory that did not exist, and checked", async (t) => {
  const { root, data, backups, publicKey, privateKey } = await fixture(t);
  const { sealed } = await backup({ data, to: backups, seal: publicKey });
  const into = path.join(root, "restore");
  const { stdout } = await run(process.execPath, [tool, "--open", sealed.file, "--key", privateKey, "--into", into]);
  assert.match(stdout, /已解开并核对：.*restore\/(idou|mydoubao)-\d{8}T\d{9}Z，2 个文件都和清单一致/);
  const [name] = await readdir(into);
  assert.equal(await readFile(path.join(into, name, "unattended-sealing.key"), "utf8"), "synthetic-sealing-key");
  const again = await run(process.execPath, [tool, "--open", sealed.file, "--key", privateKey, "--into", into]).then(() => null, (error) => error);
  assert.match(again.stderr, /已经存在：换一个还不存在的目录/);
});
