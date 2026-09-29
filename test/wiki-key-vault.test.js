import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, chmod, symlink, realpath } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { WikiKeyVault } from "../src/control-plane/wiki-key-vault.js";
import { wikiHash } from "../src/knowledge/manifest.js";

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wiki-key-vault-"))), databaseFile = path.join(directory, "keys.sqlite"), wrappingKey = randomBytes(32), opened = [];
  t.after(async () => { for (const item of opened) item.close(); wrappingKey.fill(0); await rm(directory, { recursive: true, force: true }); });
  const open = async () => { const vault = await WikiKeyVault.open({ databaseFile, wrappingKey }); opened.push(vault); return vault; };
  const context = { tenant: wikiHash("tenant"), shardKey: wikiHash("shard"), generation: 1, fence: 1, nodeId: wikiHash("node"), providerId: "saas-cli", driveTenantKey: "tenant", folderToken: "Folder123", sourceSetHash: wikiHash("sources"), sourceCount: 1 };
  const vault = await open();
  const metadata = keyId => ({ format: "wiki-aes256gcm-v1", providerId: context.providerId, driveTenantKey: context.driveTenantKey, folderToken: context.folderToken,
    reservationId: randomUUID(), ciphertextSha256: wikiHash("ciphertext"), bytes: 1000, keyId, sourceSetHash: context.sourceSetHash, sourceCount: 1 });
  return { directory, databaseFile, wrappingKey, opened, open, vault, context, metadata };
}

test("server vault survives restart with encrypted per-package keys and never stores its root or plaintext keys", async t => {
  const f = await fixture(t); let keyId, expected, callbackKey;
  await f.vault.prepare(f.context, (key, id) => { callbackKey = key; expected = Buffer.from(key); keyId = id; });
  assert.deepEqual(callbackKey, Buffer.alloc(32));
  const metadata = f.metadata(keyId); f.vault.bind(f.context, keyId, metadata);
  for (const filename of [f.databaseFile, `${f.databaseFile}-wal`]) {
    const bytes = await readFile(filename); assert.equal(bytes.includes(expected), false); assert.equal(bytes.includes(f.wrappingKey), false);
  }
  f.vault.close(); const restored = await f.open();
  await restored.withKey(f.context, { ...metadata, fileToken: "File123" }, key => { assert.deepEqual(key, expected); callbackKey = key; });
  assert.deepEqual(callbackKey, Buffer.alloc(32)); expected.fill(0);
  await assert.rejects(WikiKeyVault.open({ databaseFile: f.databaseFile, wrappingKey: randomBytes(32) }), /custody/);
  restored.assertBound(f.context, keyId, metadata);
});

test("vault preparation is idempotent per lease generation and cannot reissue a bound publisher key", async t => {
  const f = await fixture(t), second = await f.open(); let expected, keyId;
  await f.vault.prepare(f.context, (key, id) => { expected = Buffer.from(key); keyId = id; });
  await second.prepare(f.context, (key, id) => { assert.deepEqual(key, expected); assert.equal(id, keyId); });
  const metadata = f.metadata(keyId); second.bind(f.context, keyId, metadata); f.vault.bind(f.context, keyId, metadata);
  await assert.rejects(f.vault.prepare(f.context, () => assert.fail("bound key reissued")));
  assert.throws(() => f.vault.bind(f.context, keyId, { ...metadata, ciphertextSha256: wikiHash("different") }));
  assert.throws(() => f.vault.bind(f.context, keyId, { ...metadata, sourceSetHash: wikiHash("different") }));
  await second.prepare({ ...f.context, generation: 2, fence: 2 }, (key, id) => { assert.notDeepEqual(key, expected); assert.notEqual(id, keyId); });
  expected.fill(0);
});

test("tenant, node, sources, destination and generation substitutions cannot open an existing slot", async t => {
  const f = await fixture(t); let keyId;
  await f.vault.prepare(f.context, (_, id) => { keyId = id; });
  const metadata = f.metadata(keyId); f.vault.bind(f.context, keyId, metadata);
  for (const field of ["tenant", "shardKey", "nodeId", "sourceSetHash", "providerId", "driveTenantKey", "folderToken", "sourceCount", "generation", "fence"]) {
    const changed = { ...f.context, [field]: typeof f.context[field] === "number" ? f.context[field] + 1 : ["tenant", "shardKey", "nodeId", "sourceSetHash"].includes(field) ? wikiHash("other") : "other" };
    let calls = 0;
    await assert.rejects(f.vault.withKey(changed, { ...metadata, fileToken: "File123" }, () => { calls++; })); assert.equal(calls, 0);
  }
  await assert.rejects(f.vault.withKey(f.context, { ...metadata, fileToken: "File123", keyId: wikiHash("wrong-key") }, () => assert.fail()));
});

test("database ciphertext, package and record substitution fail authenticated unwrap without plaintext callbacks", async t => {
  for (const kind of ["ciphertext", "package", "key-id"]) {
    const f = await fixture(t); let keyId;
    await f.vault.prepare(f.context, (_, id) => { keyId = id; });
    const metadata = f.metadata(keyId); f.vault.bind(f.context, keyId, metadata);
    const db = new DatabaseSync(f.databaseFile);
    if (kind === "ciphertext") { const row = db.prepare("SELECT sealed FROM wiki_keys").get(); row.sealed[30] ^= 1; db.prepare("UPDATE wiki_keys SET sealed=?").run(row.sealed); }
    if (kind === "package") {
      const row = db.prepare("SELECT package FROM wiki_keys").get(), changed = JSON.parse(row.package); changed.ciphertextSha256 = metadata.ciphertextSha256 = wikiHash("attacker-package");
      db.prepare("UPDATE wiki_keys SET package=?").run(JSON.stringify(changed));
    }
    if (kind === "key-id") { metadata.keyId = wikiHash("attacker-id"); db.prepare("UPDATE wiki_keys SET key_id=?").run(metadata.keyId); }
    db.close();
    let calls = 0;
    await assert.rejects(f.vault.withKey(f.context, { ...metadata, fileToken: "File123" }, () => { calls++; })); assert.equal(calls, 0);
  }
});

test("revocation persists across restart and clears active callback buffers even before their await finishes", async t => {
  const f = await fixture(t); let keyId, active, enter, release;
  await f.vault.prepare(f.context, (_, id) => { keyId = id; });
  const metadata = f.metadata(keyId); f.vault.bind(f.context, keyId, metadata);
  const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const pending = f.vault.withKey(f.context, { ...metadata, fileToken: "File123" }, async key => { active = key; enter(); await wait; }); await entered;
  assert.equal(f.vault.revoke(keyId), true); assert.deepEqual(active, Buffer.alloc(32)); assert.equal(f.vault.revoke(keyId), false);
  release(); await assert.rejects(pending); f.vault.close(); const restored = await f.open();
  await assert.rejects(restored.withKey(f.context, { ...metadata, fileToken: "File123" }, () => assert.fail("revoked")));
  await assert.rejects(restored.prepare(f.context, () => assert.fail("recreated revoked slot")));
});

test("callback failures and vault shutdown clear owned buffers without mutating the caller root", async t => {
  const f = await fixture(t), root = Buffer.from(f.wrappingKey); let held;
  await assert.rejects(f.vault.prepare(f.context, key => { held = key; throw new Error("consumer failure"); }));
  assert.deepEqual(held, Buffer.alloc(32));
  await assert.rejects(f.vault.prepare(f.context, key => { held = key; f.vault.close(); assert.deepEqual(key, Buffer.alloc(32)); }));
  assert.deepEqual(f.wrappingKey, root); assert.deepEqual(held, Buffer.alloc(32)); root.fill(0);
});

test("vault refuses unsafe storage, symlinked secrets, absent roots and unsupported database schemas", async t => {
  const f = await fixture(t);
  await assert.rejects(WikiKeyVault.open({ databaseFile: path.join(f.directory, "no-key.sqlite") }));
  assert.throws(() => new WikiKeyVault(f.databaseFile, f.wrappingKey));
  const secretFile = path.join(f.directory, "root.key"); await writeFile(secretFile, f.wrappingKey, { mode: 0o600 });
  const loaded = await WikiKeyVault.fromFiles({ databaseFile: f.databaseFile, wrappingKeyFile: secretFile }); f.opened.push(loaded);
  const link = path.join(f.directory, "root-link.key"); await symlink(secretFile, link);
  await assert.rejects(WikiKeyVault.fromFiles({ databaseFile: f.databaseFile, wrappingKeyFile: link }));
  await chmod(secretFile, 0o644); await assert.rejects(WikiKeyVault.fromFiles({ databaseFile: f.databaseFile, wrappingKeyFile: secretFile }));
  await chmod(f.databaseFile, 0o644); await assert.rejects(f.open()); await chmod(f.databaseFile, 0o600);
  const db = new DatabaseSync(f.databaseFile); db.exec("PRAGMA user_version=99"); db.close(); await assert.rejects(f.open());
});

test("a fresh server process unwraps the same bound package using only its configured root file", async t => {
  const f = await fixture(t); let keyId, expected;
  await f.vault.prepare(f.context, (key, id) => { keyId = id; expected = wikiHash([...key]); });
  const metadata = f.metadata(keyId); f.vault.bind(f.context, keyId, metadata); f.vault.close();
  const rootFile = path.join(f.directory, "root.key"); await writeFile(rootFile, f.wrappingKey, { mode: 0o600 });
  const script = `import { WikiKeyVault } from ${JSON.stringify(new URL("../src/control-plane/wiki-key-vault.js", import.meta.url).href)};
    import { wikiHash } from ${JSON.stringify(new URL("../src/knowledge/manifest.js", import.meta.url).href)};
    const [databaseFile, wrappingKeyFile, context, manifest] = process.argv.slice(1);
    const vault = await WikiKeyVault.fromFiles({ databaseFile, wrappingKeyFile });
    try { await vault.withKey(JSON.parse(context), JSON.parse(manifest), key => process.stdout.write(wikiHash([...key]))); } finally { vault.close(); }`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, f.databaseFile, rootFile, JSON.stringify(f.context), JSON.stringify({ ...metadata, fileToken: "File123" })], { timeout: 10000 });
  assert.equal(stdout, expected); // Only a synthetic key's digest, never the key, crosses stdout.
});
