import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, sign, verify } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile, rm, chmod, symlink, link, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DeviceIdentityStore } from "../src/application/device-identity.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
const origin = "https://enterprise.example";
const publicKey = key => createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64url");
async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "idou-device-test-")), cipher = fixtureCipher();
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, cipher, make: () => new DeviceIdentityStore({ directory, cipher }), filename: async () => path.join(directory, (await readdir(directory)).find(name => name.endsWith(".enc"))) };
}
test("device key survives new store instances encrypted at rest and differs across servers", async t => {
  const f = await setup(t), first = await f.make().key(origin), second = await f.make().key(origin);
  assert.equal(publicKey(first), publicKey(second));
  const message = Buffer.from("fresh challenge"), signature = sign(null, message, second); assert.equal(verify(null, message, createPublicKey(first), signature), true);
  const bytes = await readFile(await f.filename());
  assert.equal(bytes.includes(first.export({ format: "der", type: "pkcs8" })), false);
  assert.equal(bytes.includes(Buffer.from(first.export({ format: "der", type: "pkcs8" }).toString("base64url"))), false);
  assert.equal(bytes.includes(Buffer.from(origin)), false); assert.equal((await stat(await f.filename())).mode & 0o777, 0o600);
  assert.notEqual(publicKey(await f.make().key("https://other.example")), publicKey(first));
  assert.equal(publicKey(await f.make().key(`${origin}/`)), publicKey(first));
});
test("parallel store instances do not replace the first durable device key", async t => {
  const f = await setup(t), keys = await Promise.all(Array.from({ length: 8 }, () => f.make().key(origin)));
  assert.equal(new Set(keys.map(publicKey)).size, 1); assert.equal((await readdir(f.directory)).length, 1);
});
test("unavailable or failing encryption prevents creating an identity without plaintext fallback", async t => {
  for (const kind of ["unavailable", "encrypt", "decrypt"]) {
    const f = await setup(t);
    if (kind === "unavailable") f.cipher.available = () => false;
    if (kind === "encrypt") f.cipher.encrypt = () => { throw new Error("SECRET"); };
    if (kind === "decrypt") { await f.make().key(origin); f.cipher.decrypt = () => { throw new Error("SECRET"); }; }
    await assert.rejects(f.make().key(origin), error => /未重置/.test(error.message) && !error.message.includes("SECRET"));
    if (kind !== "decrypt") assert.deepEqual(await readdir(f.directory), []);
  }
});
test("corrupt, cross-server and unsafe existing device files are never silently regenerated", async t => {
  for (const kind of ["corrupt", "origin", "extra", "wrong-key", "permissions", "hardlink", "symlink", "empty", "oversize"]) {
    const f = await setup(t); await f.make().key(origin); const filename = await f.filename();
    if (["origin", "extra", "wrong-key"].includes(kind)) {
      const value = JSON.parse(f.cipher.decrypt(await readFile(filename)));
      if (kind === "origin") value.serverUrl = "https://foreign.example";
      if (kind === "extra") value.token = "SECRET";
      if (kind === "wrong-key") value.privateKey = "A".repeat(64);
      await writeFile(filename, f.cipher.encrypt(JSON.stringify(value)));
    }
    if (kind === "corrupt") await writeFile(filename, "SECRET-corrupted");
    if (kind === "empty") await writeFile(filename, "");
    if (kind === "oversize") await writeFile(filename, Buffer.alloc(8193));
    if (kind === "permissions") await chmod(filename, 0o644);
    if (kind === "hardlink") await link(filename, path.join(f.directory, "duplicate"));
    if (kind === "symlink") { const bytes = await readFile(filename); const target = path.join(f.directory, "original"); await writeFile(target, bytes, { mode: 0o600 }); await rm(filename); await symlink(target, filename); }
    const before = await readFile(filename); await assert.rejects(f.make().key(origin), /未重置/, kind);
    assert.deepEqual(await readFile(filename), before);
  }
});
test("unsafe identity directory is rejected before key material is generated", async t => {
  const f = await setup(t); await chmod(f.directory, 0o755); await assert.rejects(f.make().key(origin), /未重置/); assert.deepEqual(await readdir(f.directory), []);
});
