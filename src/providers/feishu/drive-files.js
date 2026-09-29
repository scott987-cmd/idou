import { mkdtemp, writeFile, rm, open } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { successfulUserPayload } from "./document-errors.js";
import { cliApiGet } from "./openapi.js";
import { hostWithin, SAAS_RESOURCE_HOSTS } from "./saas-deployment.js";
import { DRIVE_REPLACE, DRIVE_SINGLE_SHOT_MAX_BYTES, DRIVE_UPLOAD, DRIVE_UPLOAD_CHUNKED } from "./cli-write-contract.js";
import { EITHER, sameFileName } from "../../product-names.js";

// The files this product puts in a person's Drive, under either spelling of its
// name (product-names.js).
const OWN_UPLOAD = new RegExp(`^${EITHER}-[a-f0-9-]{36}\\.(png|jpg|webp|mp4|app\\.json|wiki\\.bundle|schedule\\.md)$`);
const OWN_REPORT = new RegExp(`^${EITHER}-[a-f0-9-]{36}\\.schedule\\.md$`);

const token = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
// Read-only folder listing. Bound as a constant so the audited read path cannot
// be reshaped by a caller.
const FILES_PATH = "/open-apis/drive/v1/files";
// The person's own root folder, 我的空间: the one folder that has no link of its
// own to inspect. Read under drive:drive.metadata:readonly, already asked for.
const ROOT_PATH = "/open-apis/drive/explorer/v2/root_folder/meta";
export const OWN_SPACE_TITLE = "我的空间";
// Exactly what the four Drive paths in this file need, declared next to them so
// the consent ask stays tied to the code rather than to a hand-kept list.
//
// This replaced `drive:drive`, whose console name is 查看、评论、编辑和管理云空间中
// 所有文件 -- read, comment, edit and manage every file in the person's cloud
// space -- to back `drive +inspect` (metadata), one single-shot `drive +upload`,
// a folder listing and a download. Nothing here ever comments on, edits,
// deletes, moves or repermissions a file, so the umbrella was asking for powers
// no code path could spend. WIKI_BUNDLE_SCOPES already covers the same folder
// listing with space:document:retrieve + drive:file:download.
export const DRIVE_DELIVERY_SCOPES = Object.freeze(["drive:drive.metadata:readonly", "drive:file:upload", "drive:file:download"]);
// Where a Drive file's page is: /file/<token>, the address Feishu's own
// metadata and folder listings give and its web app opens (a folder's is
// /drive/folder/<token>). Until 2026-09-29 this product linked files as
// /drive/file/<token>, which Feishu answers with its 404 page, and its own
// tests used the same invented form, so every report, upload and saved image
// linked since then led nowhere (found by the person, clicking a report link in
// a Feishu message). Such links -- in run records and in messages already
// sent -- are still read as the file they name, and given back in the real form.
export const driveFileUrl = (origin, token) => `${origin}/file/${token}`;
const DRIVE_PATHS = Object.freeze({
  folder: /^\/drive\/folder\/([A-Za-z0-9_-]{8,128})\/?$/,
  file: /^\/(?:drive\/)?file\/([A-Za-z0-9_-]{8,128})\/?$/,
});
// A link in the form this product wrote until 2026-09-29, given back as the
// file's real page; any other link unchanged.
export function repairedDriveLink(value) {
  let url; try { url = new URL(value); } catch { return value; }
  if (!url.pathname.startsWith("/drive/file/")) return value;
  try { return driveReference(value, "file").url; } catch { return value; }
}
export function driveReference(value, kind) {
  let url; try { url = new URL(value); } catch { throw new Error("请输入完整的飞书云盘链接"); }
  const match = Object.hasOwn(DRIVE_PATHS, kind) ? DRIVE_PATHS[kind].exec(url.pathname) : null;
  if (typeof value !== "string" || value.length > 2048 || /[\\\x00-\x20]/.test(value) || url.protocol !== "https:" || url.port || url.username || url.password || !match || !hostWithin(url.hostname, SAAS_RESOURCE_HOSTS)) throw new Error("当前 SaaS 适配器需要明确的飞书云盘文件夹或文件链接");
  url.search = ""; url.hash = "";
  return { token: match[1], url: kind === "file" ? driveFileUrl(url.origin, match[1]) : url.href };
}

// A kept report that is provably no longer the report its receipt names: not in
// its folder (moved away, or deleted -- a file in the recycle bin still has its
// metadata, and `+inspect` still reports it with its title, measured
// 2026-09-22), renamed, or with other bytes. Thrown before anything is sent, so
// a caller may stop counting that receipt and try another. Any other failure is
// not proof of anything and must leave the receipt alone.
export class DriveFileNotIntact extends Error {
  constructor(message) { super(message); this.code = "drive_file_not_intact"; }
}

// Provider contract consumed by the product: resolveFolder, upload, verify, download,
// and optionally replace (rotating a scheduled task's kept reports; callers fall
// back to upload where a provider has none) and resolveRoot (the person's own
// space, where scheduled reports go; without it a deployment saves none).
// Private deployments can replace this object with their own CLI implementation.
export class SaasDriveFiles {
  constructor(provider) { this.provider = provider; }
  async identity({ signal } = {}) {
    const value = await this.provider.documentIdentity({ fresh: true, ...(signal ? { signal } : {}) });
    if (!value.tenantKey) throw new Error("云盘写入前必须确认 CLI 的企业身份");
    return value;
  }
  async unchanged(expected, { signal } = {}) {
    const current = await this.identity({ signal });
    if (current.principal !== expected.principal || current.tenantKey !== expected.tenantKey) throw new Error("飞书 CLI 身份已变化，未沿用原云盘授权");
    return current;
  }
  // `+inspect` is the CLI's supported lookup for a Drive URL and needs no raw API
  // metadata, so it works under the login bridge as well as an independent CLI.
  // A missing or unreadable target comes back successful with an empty title
  // rather than an error, so a non-empty title is the actual proof of access.
  async inspect(url, type, { signal } = {}) {
    const result = await this.provider.invoke(["drive", "+inspect", "--url", url, "--type", type, "--as", "user", "--format", "json"], { timeoutMs: 30000, maxOutputBytes: 262144, signal });
    const data = successfulUserPayload(result).data;
    if (data?.type !== type || typeof data.title !== "string" || !data.title || data.title.length > 300 || !token(data.token)) return null;
    return data;
  }
  // The person's own space as a destination: a folder like resolveFolder's,
  // marked `root`, with its token read from the explorer rather than from a
  // link. `origin` is the tenant's Drive origin, for the link it is shown as.
  async resolveRoot(origin, { signal } = {}) {
    const identity = await this.identity({ signal });
    const result = await this.provider.invoke([...cliApiGet(ROOT_PATH), "--as", "user", "--format", "json"], { timeoutMs: 30000, maxOutputBytes: 65536, signal });
    const data = successfulUserPayload(result).data;
    if (!token(data?.token)) throw new Error("无法确认你自己的云空间");
    await this.unchanged(identity, { signal });
    const { url } = driveReference(`${new URL(origin).origin}/drive/folder/${data.token}`, "folder");
    return { providerId: this.provider.id, token: data.token, url, title: OWN_SPACE_TITLE, root: true, identity };
  }
  // A destination as it is now: the same folder, found again the way it was
  // found the first time.
  #current(folder, signal) { return folder.root === true ? this.resolveRoot(folder.url, { signal }) : this.resolveFolder(folder.url, { signal }); }
  async resolveFolder(reference, { signal } = {}) {
    const parsed = driveReference(reference, "folder"), identity = await this.identity({ signal });
    const data = await this.inspect(parsed.url, "folder", { signal });
    // The response echoes the requested token, so it proves nothing on its own;
    // the title is what the server actually resolved.
    if (!data || data.token !== parsed.token) throw new Error("无法核验目标云盘文件夹");
    await this.unchanged(identity, { signal });
    // Keep the caller's canonical link rather than the CLI's rewritten one, so
    // persisted records and confirmations keep the tenant domain they were given.
    return { providerId: this.provider.id, token: parsed.token, url: parsed.url, title: data.title, identity };
  }
  async upload({ bytes, name, folder, confirmed, onDispatched, onUploaded, signal }) {
    if (confirmed !== true || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 104857600 || !OWN_UPLOAD.test(name)) throw new Error("云盘上传参数无效或尚未确认");
    if (folder?.providerId !== this.provider.id || driveReference(folder.url, "folder").token !== folder.token) throw new Error("云盘目标不属于当前适配器");
    // Above the measured single-shot boundary the CLI switches to its recorded
    // chunked sequence. Under the bridge that travels under its own action: one
    // grant admitting exactly that sequence (cli-write-sequence.js).
    const chunked = bytes.length > DRIVE_SINGLE_SHOT_MAX_BYTES;
    const current = await this.#current(folder, signal);
    if (current.token !== folder.token || current.title !== folder.title || current.identity.principal !== folder.identity.principal || current.identity.tenantKey !== folder.identity.tenantKey) throw new Error("确认后目标文件夹或身份已变化，请重新确认");
    const directory = await mkdtemp(path.join(os.tmpdir(), "idou-drive-upload-"));
    try {
      await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
      await this.unchanged(folder.identity, { signal }); await onDispatched();
      await this.unchanged(folder.identity, { signal }); // Budget/intent callbacks may await a remote service.
      // Exactly one new-file upload. Never overwrite, grant permissions, switch to
      // bot or retry a command after an ambiguous response.
      const result = await this.provider.invoke(["drive", "+upload", "--file", name, "--name", name, "--folder-token", folder.token, "--as", "user", "--format", "json"], {
        cwd: directory, timeoutMs: chunked ? 900000 : 180000, maxOutputBytes: 1048576, signal,
        // Bound to this folder, this name, this length and these exact bytes.
        feishuWriteIntent: { action: chunked ? DRIVE_UPLOAD_CHUNKED : DRIVE_UPLOAD, operationId: randomUUID(), folderToken: folder.token,
          fileName: name, byteLength: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") },
      });
      const data = successfulUserPayload(result).data;
      if (!token(data?.file_token)) throw new Error("上传响应缺少文件标识，请核查云盘；未自动重试");
      await onUploaded(data.file_token); await this.unchanged(folder.identity);
      return await this.verify({ folder, name, fileToken: data.file_token, signal });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  // One scheduled report overwritten in place, for the control plane's rotation
  // of a task's kept reports -- never something a task or a model asks for.
  // `previous` is that report as its receipt recorded it (name, token, length,
  // SHA-256). The file must still be exactly that, listed in this folder, or
  // nothing is sent; afterwards it keeps its token and carries the new name,
  // measured against Feishu. Single-shot only: reports are capped far below the
  // chunked boundary.
  async replace({ bytes, name, previous, folder, confirmed, onDispatched, onUploaded, signal }) {
    const report = OWN_REPORT;
    if (confirmed !== true || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > DRIVE_SINGLE_SHOT_MAX_BYTES || !report.test(name) ||
        !report.test(previous?.name ?? "") || !token(previous.fileToken) || !Number.isSafeInteger(previous.bytes) || previous.bytes < 1 ||
        previous.bytes > DRIVE_SINGLE_SHOT_MAX_BYTES || !/^[a-f0-9]{64}$/.test(previous.sha256 ?? "")) throw new Error("云盘覆盖参数无效或尚未确认");
    if (folder?.providerId !== this.provider.id || driveReference(folder.url, "folder").token !== folder.token) throw new Error("云盘目标不属于当前适配器");
    const current = await this.#current(folder, signal);
    if (current.token !== folder.token || current.title !== folder.title || current.identity.principal !== folder.identity.principal || current.identity.tenantKey !== folder.identity.tenantKey) throw new Error("确认后目标文件夹或身份已变化，请重新确认");
    await this.#intact({ folder, ...previous, signal });
    const fileToken = previous.fileToken;
    const directory = await mkdtemp(path.join(os.tmpdir(), "idou-drive-replace-"));
    try {
      await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
      await this.unchanged(folder.identity, { signal }); await onDispatched();
      await this.unchanged(folder.identity, { signal });
      // Exactly one overwrite of exactly this file. Never a retry after an
      // ambiguous response, never another file.
      const result = await this.provider.invoke(["drive", "+upload", "--file", name, "--name", name, "--folder-token", folder.token, "--file-token", fileToken, "--as", "user", "--format", "json"], {
        cwd: directory, timeoutMs: 180000, maxOutputBytes: 1048576, signal,
        feishuWriteIntent: { action: DRIVE_REPLACE, operationId: randomUUID(), folderToken: folder.token, fileToken,
          fileName: name, byteLength: bytes.length, contentHash: createHash("sha256").update(bytes).digest("hex") },
      });
      const data = successfulUserPayload(result).data;
      if (data?.file_token !== fileToken) throw new Error("覆盖响应的文件标识与原文件不符，请核查云盘；未自动重试");
      await onUploaded(fileToken); await this.unchanged(folder.identity);
      return await this.verify({ folder, name, fileToken, signal });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async verify({ folder, name, fileToken, signal }) {
    if (folder.providerId !== this.provider.id || !token(fileToken) || !token(folder.token) || driveReference(folder.url, "folder").token !== folder.token) throw new Error("待核验云盘资源无效");
    await this.unchanged(folder.identity, { signal });
    const link = driveReference(driveFileUrl(new URL(folder.url).origin, fileToken), "file");
    // Under the login bridge the destination folder, name, length and bytes were
    // bound by a server-issued one-shot grant and enforced before dispatch, so
    // the folder is already established. Confirm the file exists under the
    // confirmed name instead of re-deriving its parent from a folder listing,
    // which needs a scope the Drive delivery login does not ask for (above). An
    // independent CLI has no such grant, so it keeps the stronger listing check
    // below.
    if (this.provider.environment) {
      const data = await this.inspect(link.url, "file", { signal });
      if (!data || data.token !== fileToken || !sameFileName(data.title, name)) throw new Error("尚未在云盘核验到这个文件，请人工核查；未自动重传");
      await this.unchanged(folder.identity, { signal });
      return { fileToken, url: link.url, name, providerId: this.provider.id, verifiedAt: Date.now() };
    }
    const match = await this.#listed(folder, fileToken, signal);
    if (!match) throw new Error("尚未在目标文件夹中核验到上传文件，请稍后只读核查");
    // Listings report the file's `/file/<token>` link; it is rebuilt from the
    // confirmed folder's origin (above) rather than trusted from the row.
    if (match.type !== "file" || !sameFileName(match.name, name) || match.parent_token !== folder.token) throw new Error("云盘成果位置或名称已变化，需人工核查");
    await this.unchanged(folder.identity, { signal });
    return { fileToken, url: link.url, name, providerId: this.provider.id, verifiedAt: Date.now() };
  }
  // The row for this file in the folder's listing, or null once the whole
  // listing has been read without it. Read the exact destination, never
  // enterprise search or the user's root, through the read-only API passthrough,
  // which the login bridge also forwards -- given one of the listing's scopes
  // (space:document:retrieve, drive:drive:readonly or drive:drive).
  async #listed(folder, fileToken, signal) {
    let pageToken; const seen = new Set();
    while (true) {
      if (seen.size >= 100) throw new Error("云盘核验分页超限，请在原文件夹人工核查");
      const query = new URLSearchParams({ folder_token: folder.token, page_size: "200", ...(pageToken ? { page_token: pageToken } : {}) });
      const result = await this.provider.invoke([...cliApiGet(`${FILES_PATH}?${query}`), "--as", "user", "--format", "json"], { timeoutMs: 30000, maxOutputBytes: 1048576, signal });
      const data = successfulUserPayload(result).data;
      if (!Array.isArray(data?.files) || data.files.length > 200 || typeof data.has_more !== "boolean") throw new Error("云盘清单响应无效，未确认保存成功");
      const match = data.files.find((file) => file.token === fileToken);
      if (match) return match;
      if (!data.has_more) return null;
      if (typeof data.next_page_token !== "string" || !data.next_page_token || data.next_page_token.length > 4096 || seen.has(data.next_page_token)) throw new Error("云盘分页不完整，未确认保存成功");
      seen.add(data.next_page_token); pageToken = data.next_page_token;
    }
  }
  // Whether a kept report is still exactly what its receipt names, before it is
  // overwritten. Listed in its folder under its name -- metadata and +inspect
  // still show a file in the recycle bin, a listing does not -- and holding its
  // bytes: reports are small, and the download is what 参考上一次的结果 already
  // does. A file a person edited is theirs now, not a report to rotate. Read up
  // to the single-shot bound, so an edit that grew it still downloads and is
  // measured.
  async #intact({ folder, name, fileToken, bytes, sha256, signal }) {
    await this.unchanged(folder.identity, { signal });
    const match = await this.#listed(folder, fileToken, signal);
    if (!match) throw new DriveFileNotIntact("要替换的报告已不在目标文件夹里");
    if (match.type !== "file" || !sameFileName(match.name, name) || match.parent_token !== folder.token) throw new DriveFileNotIntact("要替换的报告已改名或移动");
    signal?.throwIfAborted();
    const held = await this.download({ folder, name, fileToken, maxBytes: DRIVE_SINGLE_SHOT_MAX_BYTES });
    if (held.length !== bytes || createHash("sha256").update(held).digest("hex") !== sha256) throw new DriveFileNotIntact("要替换的报告内容已被改动");
  }
  async download({ folder, name, fileToken, maxBytes }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 104857600) throw new Error("云盘下载大小限制无效");
    await this.verify({ folder, name, fileToken });
    const directory = await mkdtemp(path.join(os.tmpdir(), "idou-drive-download-")), filename = path.join(directory, "payload.bin");
    try {
      const result = await this.provider.invoke(["drive", "+download", "--file-token", fileToken, "--output", "payload.bin", "--as", "user", "--format", "json"], { cwd: directory, timeoutMs: 60000, maxOutputBytes: 262144, outputFileLimit: { path: filename, maxBytes } });
      successfulUserPayload(result); // Never trust an output path from the CLI envelope.
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes;
      try {
        const before = await handle.stat();
        if (!before.isFile() || !before.size || before.size > maxBytes || before.nlink !== 1) throw new Error("云盘下载文件无效或超过已确认包大小");
        const buffer = Buffer.alloc(before.size + 1); let used = 0;
        while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
        const after = await handle.stat();
        if (used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("下载文件在读取期间发生变化");
        bytes = Buffer.from(buffer.subarray(0, used));
      } finally { await handle.close(); }
      await this.verify({ folder, name, fileToken });
      return bytes;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
