import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, lstat, realpath, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 16384;
const privateMode = info => process.platform === "win32" || info.uid === process.getuid() && !(info.mode & 0o077);

// The durable half of a login, as the client sees it: an opaque string the
// server sealed to itself. This machine cannot read it, so what is stored here
// is not a Feishu token — but it is still the thing that lets this device come
// back without a browser, so it is encrypted at rest by the operating system's
// keystore and kept private to this user, exactly like the device key.
//
// Anything unreadable, oversized, world-readable or foreign is discarded rather
// than repaired: the cost of a wrong resume credential is one sign-in.
export class ResumeStore {
  constructor({ directory, cipher }) { this.directory = path.resolve(directory); this.cipher = cipher; this.queue = Promise.resolve(); this.lastError = null; }
  // Which check rejected the stored credential. A short fixed code, never the
  // credential itself, so a refusal can be explained instead of just happening.
  reject(code) { this.lastError = code; return null; }
  serial(operation) { const next = this.queue.catch(() => {}).then(operation); this.queue = next.catch(() => {}); return next; }
  file(namespace) {
    if (typeof namespace !== "string" || !/^[a-f0-9]{64}$/.test(namespace)) throw new Error("Invalid account namespace");
    return path.join(this.directory, `${namespace}.enc`);
  }
  async read(namespace, serverUrl) {
    return this.serial(async () => {
      let file;
      try {
        this.lastError = null;
        if (!await this.cipher.available()) return this.reject("系统加密不可用");
        file = await open(this.file(namespace), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || !privateMode(info) || info.size < 1 || info.size > MAX_BYTES) return this.reject("凭据文件权限或大小异常");
        const buffer = Buffer.alloc(info.size);
        let used = 0;
        while (used < buffer.length) { const part = await file.read(buffer, used, buffer.length - used, null); if (!part.bytesRead) break; used += part.bytesRead; }
        if (used !== info.size) return this.reject("凭据文件读取不完整");
        let record;
        try { record = JSON.parse(await this.cipher.decrypt(buffer.subarray(0, used))); } catch { return this.reject("凭据无法解密"); }
        if (!record || Array.isArray(record) || Object.keys(record).sort().join() !== "credential,namespace,serverUrl,version" || record.version !== 1) return this.reject("凭据格式不兼容");
        if (record.namespace !== namespace) return this.reject("凭据属于另一个账号");
        if (record.serverUrl !== serverUrl) return this.reject("凭据属于另一个服务端");
        if (typeof record.credential !== "string" || !record.credential || record.credential.length > MAX_BYTES) return this.reject("凭据内容无效");
        return record.credential;
      } catch (error) { return this.reject(error.code === "ENOENT" ? "本机还没有保存过登录凭据" : "凭据无法读取"); }
      finally { await file?.close(); }
    });
  }
  async write(namespace, serverUrl, credential) {
    return this.serial(async () => {
      let file;
      try {
        if (typeof credential !== "string" || !credential || credential.length > MAX_BYTES || !await this.cipher.available()) return false;
        const filename = this.file(namespace);
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const info = await lstat(this.directory);
        if (!info.isDirectory() || !privateMode(info)) return false;
        const directory = await realpath(this.directory);
        const bytes = await this.cipher.encrypt(JSON.stringify({ version: 1, namespace, serverUrl, credential }));
        if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTES) return false;
        const temporary = path.join(directory, `.${randomUUID()}.tmp`);
        try {
          file = await open(temporary, "wx", 0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
          // Replacing, unlike the device key: a newer credential supersedes the
          // one it was minted from, and keeping the old one would only leave a
          // credential around that no longer works.
          await rename(temporary, filename);
        } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        return true;
      } catch { return false; }
    });
  }
  async clear(namespace) {
    return this.serial(async () => {
      try { await unlink(this.file(namespace)); return true; }
      catch (error) { return error.code === "ENOENT"; }
    });
  }
}
