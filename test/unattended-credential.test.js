import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { mkdtemp, chmod, lstat, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UnattendedCredentialStore } from "../src/control-plane/unattended-credential.js";
import { resumeSealingKey, sealResume } from "../src/control-plane/resume-credential.js";

const APP_SECRET = "synthetic-app-secret";
const REFRESH = "synthetic-refresh-token-value";
const WHO = { appId: "cli_fixture", tenantId: "tenant_fixture", userId: "ou_fixture" };

async function store(t) {
  // Resolved: on macOS /var is itself a symlink, and the store refuses a
  // directory whose realpath differs from its name -- which is the check doing
  // its job, not a thing to relax. The real data directory lives under $HOME.
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-unattended-")));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  return { directory, open: () => UnattendedCredentialStore.open({ directory }) };
}

const record = (sealed, over = {}) => ({ sealed, state: "active", grantedAt: 1, expiresAt: 2, notAfter: 3, lastUsedAt: null, reason: null, failures: 0, ...over });

test("the directory and both key files are private to this user", async (t) => {
  const { directory, open } = await store(t);
  await open();
  if (process.platform === "win32") return;
  assert.equal((await lstat(directory)).mode & 0o077, 0, "the directory is not readable by anyone else");
  for (const name of ["sealing.key", "device.key"]) {
    assert.equal((await lstat(path.join(directory, name))).mode & 0o077, 0, `${name} is not readable by anyone else`);
  }
});

test("reopening the same directory produces the same key and the same device", async (t) => {
  // A restart must be able to read what the last run sealed. Regenerating either
  // file would make every stored credential unopenable, with the failure landing
  // hours later on a schedule nobody was watching.
  const { open } = await store(t);
  const first = await open(), second = await open();
  assert.equal(first.deviceId, second.deviceId);
  assert.equal(first.devicePublicKey, second.devicePublicKey);
  assert.deepEqual(first.key, second.key);
  assert.equal(second.unseal(record(first.seal({ ...WHO, refreshToken: REFRESH, notAfter: Date.now() + 86400_000 }))).refreshToken, REFRESH);
});

test("the device id is derived the way a login derives it", async (t) => {
  // Computed here independently, because nothing in the running system would
  // notice this being wrong: `renewal.bind` only type-checks the key, so a
  // mis-derived id would sit in every record and only surface if the credential
  // were ever put through the desktop's own challenge.
  const { open } = await store(t);
  const it = await open();
  const spki = createPublicKey(it.devicePublicKey).export({ type: "spki", format: "der" }).toString("base64url");
  assert.equal(it.deviceId, createHash("sha256").update(spki).digest("base64url"),
    "the id hashes the base64url SPKI, not the raw DER");
  assert.match(it.deviceId, /^[A-Za-z0-9_-]{43}$/);
});

test("this store and the laptop store are revocable independently", async (t) => {
  // The point of not deriving this key from the application secret. Rotating one
  // must not sign everyone out of the other.
  const { open } = await store(t);
  const it = await open();
  const laptop = sealResume(resumeSealingKey(APP_SECRET, WHO.appId), { ...WHO, refreshToken: REFRESH,
    notAfter: Date.now() + 86400_000, deviceId: it.deviceId, devicePublicKey: it.devicePublicKey });
  assert.throws(() => it.unseal(record(laptop)), /Invalid resume credential/, "a laptop blob is not readable here");

  const other = await store(t);
  const elsewhere = await other.open();
  assert.throws(() => elsewhere.unseal(record(it.seal({ ...WHO, refreshToken: REFRESH, notAfter: Date.now() + 86400_000 }))),
    /Invalid resume credential/, "and one server's blob is not readable by another");
});

test("what lands on disk is neither the token nor the secret", async (t) => {
  const { directory, open } = await store(t);
  const it = await open();
  await it.write(WHO.tenantId, WHO.userId, record(it.seal({ ...WHO, refreshToken: REFRESH, notAfter: Date.now() + 86400_000 })));
  const grants = path.join(directory, "grants");
  const bytes = (await Promise.all((await readdir(grants)).map((name) => readFile(path.join(grants, name), "utf8")))).join("");
  assert.doesNotMatch(bytes, /synthetic-refresh-token-value|synthetic-app-secret/);
  assert.equal((await readdir(grants)).length, 1);
  if (process.platform !== "win32") {
    assert.equal((await lstat(path.join(grants, (await readdir(grants))[0]))).mode & 0o077, 0);
  }
});

test("a record round-trips, and replacing one leaves exactly one file behind", async (t) => {
  const { directory, open } = await store(t);
  const it = await open();
  const notAfter = Date.now() + 86400_000;
  await it.write(WHO.tenantId, WHO.userId, record(it.seal({ ...WHO, refreshToken: REFRESH, notAfter })));
  await it.write(WHO.tenantId, WHO.userId, record(it.seal({ ...WHO, refreshToken: "second-token", notAfter })));
  const read = await it.read(WHO.tenantId, WHO.userId);
  assert.equal(it.unseal(read).refreshToken, "second-token");
  const names = await readdir(path.join(directory, "grants"));
  assert.deepEqual(names.filter((name) => name.endsWith(".tmp")), [], "no temporary file survives");
  assert.equal(names.length, 1);
  assert.equal(await it.count(), 1);
});

test("two people do not share a record", async (t) => {
  const { open } = await store(t);
  const it = await open();
  const notAfter = Date.now() + 86400_000;
  await it.write("tenant_a", "ou_a", record(it.seal({ ...WHO, tenantId: "tenant_a", userId: "ou_a", refreshToken: "a-token", notAfter })));
  await it.write("tenant_a", "ou_b", record(it.seal({ ...WHO, tenantId: "tenant_a", userId: "ou_b", refreshToken: "b-token", notAfter })));
  assert.equal(it.unseal(await it.read("tenant_a", "ou_a")).refreshToken, "a-token");
  assert.equal(it.unseal(await it.read("tenant_a", "ou_b")).refreshToken, "b-token");
  assert.equal(await it.count(), 2);
});

test("a tampered seal is refused rather than half-read", async (t) => {
  const { open } = await store(t);
  const it = await open();
  const sealed = it.seal({ ...WHO, refreshToken: REFRESH, notAfter: Date.now() + 86400_000 });
  const flipped = `${sealed.slice(0, -4)}${sealed.slice(-4) === "AAAA" ? "BBBB" : "AAAA"}`;
  assert.throws(() => it.unseal(record(flipped)), /Invalid resume credential/);
});

test("a corrupt or foreign file reads as nothing, not as a usable record", async (t) => {
  const { directory, open } = await store(t);
  const it = await open();
  const name = createHash("sha256").update(`${WHO.tenantId}\n${WHO.userId}`).digest("hex");
  for (const contents of ["not json at all", JSON.stringify({ v: 2, sealed: "x", state: "active" }), JSON.stringify({ v: 1, state: "active" })]) {
    await writeFile(path.join(directory, "grants", `${name}.json`), contents, { mode: 0o600 });
    assert.equal(await it.read(WHO.tenantId, WHO.userId), null, `refused: ${contents.slice(0, 30)}`);
  }
});

test("reading, patching and removing something that is not there are all answers", async (t) => {
  const { open } = await store(t);
  const it = await open();
  assert.equal(await it.read("tenant_a", "ou_missing"), null);
  assert.equal(await it.patch("tenant_a", "ou_missing", { state: "needs_reauthorization" }), null,
    "patching a deleted record must not recreate it");
  assert.equal(await it.remove("tenant_a", "ou_missing"), false);
  await it.write(WHO.tenantId, WHO.userId, record(it.seal({ ...WHO, refreshToken: REFRESH, notAfter: Date.now() + 86400_000 })));
  assert.equal(await it.remove(WHO.tenantId, WHO.userId), true);
  assert.equal(await it.remove(WHO.tenantId, WHO.userId), false, "removing twice is not an error");
});

test("patching keeps the seal and changes only what it was asked to", async (t) => {
  const { open } = await store(t);
  const it = await open();
  const sealed = it.seal({ ...WHO, refreshToken: REFRESH, notAfter: Date.now() + 86400_000 });
  await it.write(WHO.tenantId, WHO.userId, record(sealed));
  await it.patch(WHO.tenantId, WHO.userId, { state: "needs_reauthorization", reason: "飞书拒绝了续期", failures: 3 });
  const read = await it.read(WHO.tenantId, WHO.userId);
  assert.equal(read.state, "needs_reauthorization");
  assert.equal(read.reason, "飞书拒绝了续期");
  assert.equal(read.sealed, sealed, "the credential itself is untouched");
});

test("a directory anyone can read is refused outright", async (t) => {
  if (process.platform === "win32") return;
  const { directory, open } = await store(t);
  await open();
  await chmod(directory, 0o755);
  await assert.rejects(open, /仅本人可读/);
});
