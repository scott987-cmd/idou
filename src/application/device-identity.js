import { createHash, createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, link, unlink } from "node:fs/promises";
import path from "node:path";
import { validateServerUrl } from "../control-plane/client-session.js";

const pending = new Map(), MAX_BYTES = 8192;
const privateMode = info => process.platform === "win32" || info.uid === process.getuid() && !(info.mode & 0o077);
const failure = () => new Error("设备身份无法安全读取或保存，请检查系统加密与本机存储；未重置设备密钥。");

// The application's own device signing key, NOT a Feishu/app/model credential.
// Bound to one server origin. Logout revokes sessions but retains this identity.
// Missing storage creates a new device; corrupt existing storage never rotates it.
export class DeviceIdentityStore {
  constructor({ directory, cipher }) { this.directory = path.resolve(directory); this.cipher = cipher; }
  async read(filename, origin) {
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || !privateMode(before) || before.size < 1 || before.size > MAX_BYTES) throw failure();
      const buffer = Buffer.alloc(MAX_BYTES + 1); let used = 0;
      while (used < buffer.length) { const part = await file.read(buffer, used, buffer.length - used, null); if (!part.bytesRead) break; used += part.bytesRead; }
      const after = await file.stat();
      if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || !privateMode(after) || after.nlink !== 1) throw failure();
      const record = JSON.parse(await this.cipher.decrypt(buffer.subarray(0, used)));
      if (!record || Array.isArray(record) || Object.keys(record).sort().join() !== "privateKey,serverUrl,version" || record.version !== 1 || record.serverUrl !== origin ||
        typeof record.privateKey !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(record.privateKey)) throw failure();
      const der = Buffer.from(record.privateKey, "base64url");
      try {
        const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
        if (key.asymmetricKeyType !== "ed25519" || key.export({ format: "der", type: "pkcs8" }).toString("base64url") !== record.privateKey) throw failure();
        return key;
      } finally { der.fill(0); }
    } finally { await file.close(); }
  }
  async key(serverUrl) {
    const origin = validateServerUrl(serverUrl), name = `${createHash("sha256").update(origin).digest("hex")}.enc`, id = path.join(this.directory, name);
    // Serialize filesystem creation in this process, without retaining key objects
    // between login attempts. Cross-process creation uses non-replacing links.
    const previous = pending.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      try {
        if (!await this.cipher.available()) throw failure();
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const info = await lstat(this.directory); if (!info.isDirectory() || !privateMode(info)) throw failure();
        const directory = await realpath(this.directory), filename = path.join(directory, name);
        try { return await this.read(filename, origin); } catch (error) { if (error.code !== "ENOENT") throw error; }
        const key = generateKeyPairSync("ed25519").privateKey, der = key.export({ format: "der", type: "pkcs8" }); let bytes;
        try { bytes = await this.cipher.encrypt(JSON.stringify({ version: 1, serverUrl: origin, privateKey: der.toString("base64url") })); }
        finally { der.fill(0); }
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES || !await this.cipher.available()) throw failure();
        const temporary = path.join(directory, `.${randomUUID()}.tmp`); let file;
        try {
          file = await open(temporary, "wx", 0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
          if (await realpath(this.directory) !== directory) throw failure();
          try { await link(temporary, filename); } catch (error) { if (error.code !== "EEXIST") throw error; }
        } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        const dir = await open(directory, "r"); try { await dir.sync(); } finally { await dir.close(); }
        // Read the winner, not our candidate: another process may have created it.
        return await this.read(filename, origin);
      } catch { throw failure(); }
    });
    pending.set(id, operation);
    try { return await operation; } finally { if (pending.get(id) === operation) pending.delete(id); }
  }
}
