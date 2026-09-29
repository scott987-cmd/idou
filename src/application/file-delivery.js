import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DriveBudgetClient } from "./drive-budget-client.js";
import { DRIVE_CHUNKED_MAX_BYTES } from "../providers/feishu/cli-write-contract.js";
import { ownFileName } from "../product-names.js";

// Sending one finished file to Feishu Drive. Everything a generated image
// already goes through applies unchanged here — the destination folder is
// resolved and re-checked, the bytes are charged against the tenant's quota,
// and the CLI is dispatched under a grant bound to this folder, this name, this
// length and these exact bytes (one request up to 20 MB, the recorded chunked
// sequence above it). The only new thing is that the file came from disk
// instead of from the media service.
//
// The upload contract accepts these types and no others, so the check happens
// here with a sentence rather than at dispatch with a pattern mismatch.
const TYPES = Object.freeze({ ".png": "png", ".jpg": "jpg", ".jpeg": "jpg", ".webp": "webp", ".mp4": "mp4" });
export const uploadableTypes = () => [...new Set(Object.values(TYPES))];

export class FileDelivery {
  constructor({ media, provider, businessAccess, budget = new DriveBudgetClient(media) }) {
    Object.assign(this, { media, provider, businessAccess, budget });
    this.queue = Promise.resolve();
  }

  // Reads the file and resolves the destination, so the confirmation can name
  // every part of what is about to happen. Nothing has left the machine yet.
  async prepare(filePath, folderUrl) {
    this.businessAccess();
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("请选择要上传的本机文件");
    const original = path.basename(filePath);
    const extension = TYPES[path.extname(original).toLowerCase()];
    if (!extension) throw new Error(`云盘上传目前只支持 ${uploadableTypes().join("、")}；「${original}」不在其中。`);
    const info = await stat(filePath);
    if (!info.isFile() || !info.size) throw new Error("这个文件是空的或者不是一个文件");
    if (info.size > DRIVE_CHUNKED_MAX_BYTES) throw new Error(`单个文件限 ${Math.floor(DRIVE_CHUNKED_MAX_BYTES / 1048576)} MB 以内，「${original}」有 ${(info.size / 1048576).toFixed(1)} MB。`);
    const bytes = await readFile(filePath);
    if (bytes.length !== info.size) throw new Error("读取过程中文件发生了变化，请重试");

    const session = await this.media.session();
    const folder = await this.provider.resolveFolder(folderUrl);
    const policy = await this.budget.policy(session, folder, bytes.length);
    return {
      id: randomUUID(), session, folder, policy, bytes,
      originalName: original,
      // The upload contract fixes the shape of a name it will accept; the
      // original name is kept beside it so the person still recognises the file.
      name: ownFileName(`${randomUUID()}.${extension}`),
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  // One at a time: a second upload starting while the first holds a grant would
  // race the ledger.
  send(draft) {
    const next = this.queue.then(() => this.dispatch(draft), () => this.dispatch(draft));
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  async dispatch(draft) {
    this.businessAccess();
    await this.media.unchanged(draft.session);
    const delivery = { folder: draft.folder, bytes: draft.byteLength, sha256: draft.sha256 };
    return this.provider.upload({
      bytes: draft.bytes, name: draft.name, folder: draft.folder, confirmed: true,
      onDispatched: async () => {
        await this.budget.reserve(draft.session, draft.id, delivery, draft.policy.policyDigest);
        await this.budget.dispatch(draft.session, draft.id, draft.policy.policyDigest);
      },
      onUploaded: async (fileToken) => { draft.fileToken = fileToken; },
    }).then(async (receipt) => {
      // The ledger is told what actually landed, so the quota reflects reality
      // rather than what was reserved.
      await this.budget.report(draft.session, draft.id, draft.fileToken);
      return { ...receipt, name: draft.name, originalName: draft.originalName, byteLength: draft.byteLength };
    });
  }
}
