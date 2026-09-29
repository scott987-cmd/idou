import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { sealResume, openResume } from "./resume-credential.js";

// Where a durable unattended credential lives on the control plane's own disk.
//
// This changes what a breach of this machine is worth, and the change is the
// whole point of the feature, so it is stated here rather than discovered
// later. Before this existed, the control plane's disk held nothing: the
// session registry keeps only digests and refresh tokens lived in memory. This
// directory holds a sealing key and, beside it, one sealed Feishu refresh token
// per person who authorized unattended runs -- so filesystem access to it is
// full access to those people's Feishu accounts for the length of their window.
// A 0700 directory and 0600 files are what stands between the two, exactly as
// the egress TLS private key is protected (egress-tls.js). If that is not
// enough for a deployment, the honest next steps are an operator-supplied key
// path outside the data directory, or the host's own keystore; both are real,
// neither is implemented here.
//
// The sealing key is deliberately NOT `resumeSealingKey(appSecret, appId)`,
// which is what seals the blobs on people's laptops. Those two stores must be
// revocable independently: rotating this key must kill every credential this
// server holds without signing the whole company out of their desktops, and
// rotating FEISHU_APP_SECRET must do the reverse.
//
// The private half of the device key is kept even though only the public half
// is used today. `renewal.bind` type-checks the key and never verifies a
// signature from it, so this is attributability, not device binding -- but a
// record that names a device whose private key exists nowhere would be a lie
// about what it says, and the key is what lets this credential later be proven
// through the same challenge a desktop answers.
const KEY_BYTES = 32;
const FILES = Object.freeze({ sealing: "sealing.key", device: "device.key", grants: "grants" });
const STATES = Object.freeze(["active", "needs_reauthorization"]);
const MAX_RECORD_BYTES = 16384;

const digest = (value) => createHash("sha256").update(value).digest("base64url");
const nameFor = (tenantId, userId) => createHash("sha256").update(`${tenantId}\n${userId}`).digest("hex");

// Created once and never replaced: `wx` means a second process racing to open
// the same directory loses and reads what the winner wrote, rather than
// silently replacing a key that every stored credential depends on.
async function createOnce(file, contents) {
  let handle = null;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  } finally { await handle?.close(); }
  return readFile(file);
}

export class UnattendedCredentialStore {
  constructor({ directory, key, privateKey, publicKey, now }) {
    Object.assign(this, { directory, key, privateKey, publicKey, now });
    this.deviceId = digest(publicKey.export({ type: "spki", format: "der" }).toString("base64url"));
    this.devicePublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  static async open({ directory, now = Date.now } = {}) {
    if (!directory || !path.isAbsolute(directory)) throw new Error("无人值守凭据目录必须是绝对路径");
    await mkdir(path.join(directory, FILES.grants), { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    // The same check the application catalog makes of its own directory: a
    // symlinked or group-readable directory defeats every file mode below it.
    if (!info.isDirectory() || await realpath(directory) !== directory
      || (process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid()))) {
      throw new Error(`无人值守凭据需要一个仅本人可读的目录：${directory}`);
    }
    const sealing = await createOnce(path.join(directory, FILES.sealing), `${randomBytes(KEY_BYTES).toString("base64url")}\n`);
    const key = Buffer.from(`${sealing}`.trim(), "base64url");
    if (key.length !== KEY_BYTES) throw new Error("无人值守凭据的封装密钥无效");
    const pem = await createOnce(path.join(directory, FILES.device),
      generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    const privateKey = createPrivateKey(`${pem}`);
    return new UnattendedCredentialStore({ directory, key, privateKey, publicKey: createPublicKey(privateKey), now });
  }

  #file(tenantId, userId) { return path.join(this.directory, FILES.grants, `${nameFor(tenantId, userId)}.json`); }

  // Seals a refresh token into a record for this person. The caller supplies the
  // token through a function so it never becomes a value held out here either.
  seal({ appId, tenantId, userId, refreshToken, notAfter }) {
    return sealResume(this.key, { appId, tenantId, userId, refreshToken, notAfter,
      deviceId: this.deviceId, devicePublicKey: this.devicePublicKey });
  }

  // Every use re-opens the seal. The `notAfter` written in the clear beside it is
  // for `status()` to show and nothing else -- a record whose clear copy says one
  // thing and whose sealed copy says another must be believed on the sealed one.
  unseal(record) { return openResume(this.key, record.sealed); }

  async read(tenantId, userId) {
    let raw;
    try { raw = await readFile(this.#file(tenantId, userId), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (raw.length > MAX_RECORD_BYTES) return null;
    let record; try { record = JSON.parse(raw); } catch { return null; }
    if (record?.v !== 1 || typeof record.sealed !== "string" || !STATES.includes(record.state)) return null;
    return record;
  }

  async write(tenantId, userId, record) {
    const file = this.#file(tenantId, userId);
    const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
    let handle = null;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ v: 1, ...record }));
      await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, file);
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    return record;
  }

  // Read-modify-write for the fields that are not the credential: state, reason,
  // failure count, last use. Returns null when there is nothing to patch, so a
  // caller never resurrects a record it has just deleted.
  async patch(tenantId, userId, fields) {
    const record = await this.read(tenantId, userId);
    if (!record) return null;
    return this.write(tenantId, userId, { ...record, ...fields });
  }

  async remove(tenantId, userId) {
    try { await unlink(this.#file(tenantId, userId)); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }

  // How many credentials this server is holding -- for one line at startup, so an
  // operator can see the blast radius without opening anything.
  async count() {
    try { return (await readdir(path.join(this.directory, FILES.grants))).filter((name) => name.endsWith(".json")).length; }
    catch { return 0; }
  }

  // The keys and every record, for moving them between stores
  // (bin/migrate-data.js). Restoring replaces the keys, which is only right
  // into a store whose records are the ones being restored.
  async dump() {
    const records = [];
    for (const file of (await readdir(path.join(this.directory, FILES.grants))).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort()) {
      try {
        const record = JSON.parse(await readFile(path.join(this.directory, FILES.grants, file), "utf8"));
        if (record?.v === 1 && typeof record.sealed === "string") records.push({ name: file.slice(0, -5), record });
      } catch { /* unreadable: not a record */ }
    }
    return { sealing: this.key.toString("base64url"), device: this.privateKey.export({ type: "pkcs8", format: "pem" }), records };
  }
  async restore({ sealing, device, records }) {
    for (const [name, contents] of [[FILES.sealing, `${sealing}\n`], [FILES.device, device]]) {
      const file = path.join(this.directory, name), temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    }
    for (const { name, record } of records) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const file = path.join(this.directory, FILES.grants, `${name}.json`), temporary = path.join(this.directory, FILES.grants, `.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    }
    adopt(this, sealing, device);
  }
}

// The same credentials in the shared database (docs/scaling-plan.md §2.5), so a
// coordinator on another machine can go on running a person's scheduled tasks.
// What a breach is worth moves with it: the sealing key and every sealed
// refresh token are in the database, themselves sealed under the key the
// replicas share (state-store.js), so the database alone opens nothing -- the
// state key file on a coordinator's disk plus the database opens everything.
//
// The two keys are made once for all coordinators: whichever creates them first
// wins, in one statement, and the rest read what it made. The file store's
// `wx` does the same for processes on one disk.
const GRANTS = "unattended-grant", KEYS = "unattended-key";
// A store that was just given other keys uses them from then on.
function adopt(store, sealing, device) {
  store.key = Buffer.from(sealing, "base64url");
  store.privateKey = createPrivateKey(String(device));
  store.publicKey = createPublicKey(store.privateKey);
  store.deviceId = digest(store.publicKey.export({ type: "spki", format: "der" }).toString("base64url"));
  store.devicePublicKey = store.publicKey.export({ type: "spki", format: "pem" }).toString();
}
export class PostgresUnattendedCredentialStore {
  static async open({ state, now = Date.now }) {
    await state.create(KEYS, "sealing", { key: randomBytes(KEY_BYTES).toString("base64url") });
    await state.create(KEYS, "device", { pem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) });
    const key = Buffer.from(String((await state.get(KEYS, "sealing"))?.value?.key ?? ""), "base64url");
    if (key.length !== KEY_BYTES) throw new Error("无人值守凭据的封装密钥无效");
    const privateKey = createPrivateKey(String((await state.get(KEYS, "device"))?.value?.pem ?? ""));
    return new PostgresUnattendedCredentialStore({ state, key, privateKey, publicKey: createPublicKey(privateKey), now });
  }

  constructor({ state, key, privateKey, publicKey, now }) {
    Object.assign(this, { state, key, privateKey, publicKey, now, directory: "postgres" });
    this.deviceId = digest(publicKey.export({ type: "spki", format: "der" }).toString("base64url"));
    this.devicePublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
  }

  seal({ appId, tenantId, userId, refreshToken, notAfter }) {
    return sealResume(this.key, { appId, tenantId, userId, refreshToken, notAfter, deviceId: this.deviceId, devicePublicKey: this.devicePublicKey });
  }
  unseal(record) { return openResume(this.key, record.sealed); }

  static #valid(record) { return record?.v === 1 && typeof record.sealed === "string" && STATES.includes(record.state) ? record : null; }
  async read(tenantId, userId) { return PostgresUnattendedCredentialStore.#valid((await this.state.get(GRANTS, nameFor(tenantId, userId)))?.value); }
  async write(tenantId, userId, record) { await this.state.put(GRANTS, nameFor(tenantId, userId), { v: 1, ...record }); return record; }
  // Over the version it read, tried again when another write came between.
  async patch(tenantId, userId, fields) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await this.state.get(GRANTS, nameFor(tenantId, userId));
      const record = PostgresUnattendedCredentialStore.#valid(current?.value);
      if (!record) return null;
      const next = { ...record, ...fields };
      if (await this.state.update(GRANTS, nameFor(tenantId, userId), current.version, next)) return next;
    }
    throw new Error("无人值守凭据正被同时修改，请稍后再试");
  }
  async remove(tenantId, userId) { return this.state.delete(GRANTS, nameFor(tenantId, userId)); }
  async count() { return this.state.count(GRANTS); }

  // The keys and every record, for moving them between stores (bin/migrate-data.js).
  async dump() {
    const records = [];
    for (let after = null; ;) {
      const page = await this.state.list(GRANTS, { after, limit: 1000 });
      records.push(...page.map((row) => ({ name: row.key, record: row.value })));
      if (page.length < 1000) break;
      after = page.at(-1).key;
    }
    return { sealing: this.key.toString("base64url"), device: this.privateKey.export({ type: "pkcs8", format: "pem" }), records };
  }
  async restore({ sealing, device, records }) {
    await this.state.put(KEYS, "sealing", { key: sealing });
    await this.state.put(KEYS, "device", { pem: device });
    for (const { name, record } of records) await this.state.put(GRANTS, name, record);
    adopt(this, sealing, device);
  }
}
