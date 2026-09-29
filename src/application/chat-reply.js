import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unknown = "回复可能已发送，回执未确认；请到飞书核查。本应用不会自动重发。";

// Account-local one-shot receipt journal. No chat or draft text is persisted.
// Entries are never silently evicted: forgetting an uncertain send permits duplicates.
export class ChatReply {
  constructor({ reader, provider, filename, cipher }) {
    Object.assign(this, { reader, provider, filename, cipher }); this.active = false;
  }
  async load() {
    if (!await this.cipher.available()) throw new Error("系统安全加密不可用，未发送回复。");
    try {
      if ((await stat(this.filename)).size > 2 * 1024 * 1024) throw new Error("oversize");
      const data = JSON.parse(await this.cipher.decrypt(await readFile(this.filename)));
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 5000 || data.entries.some(row =>
        !/^[a-f0-9]{64}$/.test(row?.fingerprint) || !/^[a-f0-9-]{36}$/.test(row.id) || !["dispatching", "acknowledged", "unknown"].includes(row.state)) ||
        new Set(data.entries.map(row => row.fingerprint)).size !== data.entries.length) throw new Error("invalid");
      return data.entries;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("回复回执文件无法安全读取；未覆盖旧文件，未发送。");
    }
  }
  async save(entries) {
    if (!await this.cipher.available()) throw new Error("系统安全加密不可用，未保存回执。");
    const bytes = await this.cipher.encrypt(JSON.stringify({ version: 1, entries }));
    if (bytes.length > 2 * 1024 * 1024) throw new Error("回复回执空间已满，未发送。");
    const directory = path.dirname(this.filename), temporary = `${this.filename}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let file;
    try {
      file = await open(temporary, "wx", 0o600); await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
      await rename(temporary, this.filename);
      const folder = await open(directory, "r"); try { await folder.sync(); } finally { await folder.close(); }
    } finally { await file?.close(); await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
  async send(handle, text, inThread, confirm) {
    if (this.active) throw new Error("已有回复正在处理，请等待回执。");
    if (typeof text !== "string" || !text.trim() || text.length > 2000 || /[<\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(text) || typeof inThread !== "boolean") throw new Error("请输入 1–2000 字纯文本；暂不支持提及标签或控制字符。");
    const draft = this.reader.captureMessage(handle);
    this.active = true;
    try {
      const entries = await this.load(); draft.current();
      // Deliberately excludes source revision: editing the original must not unblock a lost receipt.
      const fingerprint = hash([draft.identity.tenantKey, draft.identity.principal, draft.chat.id, draft.message.id, text, inThread]);
      const previous = entries.find(row => row.fingerprint === fingerprint);
      if (previous) throw new Error(previous.state === "acknowledged" ? "相同回复已有发送回执，未再次发送。" : unknown);
      if (entries.length >= 5000) throw new Error("本机回复回执已达 5000 条上限；请联系管理员，不自动清理或重发。");
      await this.provider.verifyReplyTarget(draft); draft.current();
      if (!await confirm(structuredClone({ chat: draft.chat, message: draft.message, identity: draft.identity, text, inThread }))) return { state: "canceled" };
      draft.current();
      const intent = { fingerprint, id: randomUUID(), state: "dispatching", createdAt: new Date().toISOString() };
      let dispatched = false;
      try {
        const receipt = await this.provider.reply({ ...draft, text, inThread, idempotencyKey: intent.id }, async () => {
          draft.current(); await this.save([...entries, intent]); draft.current(); dispatched = true;
        });
        intent.state = "acknowledged"; intent.receipt = receipt;
        await this.save([...entries, intent]);
        return { state: "acknowledged", ...receipt, message: "飞书已返回发送回执；不代表对方已读。" };
      } catch (error) {
        if (!dispatched) throw error;
        intent.state = "unknown"; delete intent.receipt;
        await this.save([...entries, intent]).catch(() => {});
        return { state: "unknown", message: unknown };
      }
    } finally { this.active = false; }
  }
}
