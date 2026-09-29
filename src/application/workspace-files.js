import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { APP_CONTENT_TYPES } from "../apps/manifest.js";
import { byteRange } from "../apps/byte-range.js";

const HIDDEN = /(^|\/)(\.|node_modules(?:\/|$)|vendor(?:\/|$))/;
// What a preview serves is what a published site may hold (APP_CONTENT_TYPES):
// an mp4 on the page was a 404 here, and the preview showed an empty player.
const PREVIEW_TYPES = APP_CONTENT_TYPES;
const RASTER_TYPES = new Map([[".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".bmp", "image/bmp"]]);
const OFFICE_TYPES = new Set([".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".xlsm", ".odt", ".ods", ".odp", ".pdf", ".rtf", ".epub"]);
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function safeRelative(relative) {
  if (typeof relative !== "string" || relative.includes("\\") || relative.includes("\0") || path.isAbsolute(relative) || HIDDEN.test(relative) || relative.split("/").includes("..")) throw new Error("不允许访问这个文件路径");
  return relative.split("/").filter(Boolean);
}

export async function workspacePath(cwd, relative) {
  const parts = safeRelative(relative);
  let root;
  try { root = await realpath(cwd); }
  catch { throw new Error("任务目录已移动或不可用"); }
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let info;
    try { info = await lstat(cursor); }
    catch (error) { if (error?.code === "ENOENT") throw new Error("文件已不在原位置"); throw error; }
    if (info.isSymbolicLink()) throw new Error("符号链接不在任务可打开范围内");
  }
  let full;
  try { full = await realpath(cursor); }
  catch (error) { if (error?.code === "ENOENT") throw new Error("文件已不在原位置"); throw error; }
  const inside = path.relative(root, full);
  if (inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside) || HIDDEN.test(inside)) throw new Error("文件不在任务可预览范围内");
  return full;
}

export async function listWorkspaceFiles(cwd, relative = "") {
  const full = await workspacePath(cwd, relative);
  const entries = await readdir(full, { withFileTypes: true });
  return entries.filter((entry) => !entry.isSymbolicLink() && !HIDDEN.test(entry.name)).slice(0, 500).map((entry) => ({
    name: entry.name, path: [relative, entry.name].filter(Boolean).join("/"), directory: entry.isDirectory(),
  })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

export async function readWorkspaceFile(cwd, relative) {
  const full = await workspacePath(cwd, relative);
  const info = await stat(full);
  if (!info.isFile() || info.size > MAX_TEXT_BYTES) throw new Error("仅预览 512 KB 以内的文本文件");
  const bytes = await readFile(full);
  if (bytes.length > MAX_TEXT_BYTES) throw new Error("仅预览 512 KB 以内的文本文件");
  if (bytes.includes(0)) throw new Error("此文件不是可预览的文本");
  // Textareas normalize CRLF/CR to LF. Keep display/selection offsets aligned,
  // while the revision still identifies the original bytes on disk.
  return { path: relative, text: bytes.toString("utf8").replace(/\r\n?/g, "\n"), revision: createHash("sha256").update(bytes).digest("hex"), canPreview: /\.html?$/i.test(relative) };
}

const metadataRevision = info => createHash("sha256").update(`${info.size}:${info.mtimeMs}:${info.ctimeMs}`).digest("hex");

// The file panel has more honest states than the Agent's text reader. Images
// stay images, Office files stay files, and an unsupported binary is a card
// with a reason rather than a failed attempt to decode it as UTF-8.
export async function inspectWorkspaceFile(cwd, relative) {
  const full = await workspacePath(cwd, relative), info = await stat(full);
  if (!info.isFile()) throw new Error("只能打开任务里的文件");
  const extension = path.extname(relative).toLowerCase(), base = { path: relative, bytes: info.size, modifiedAt: info.mtimeMs, revision: metadataRevision(info), canPreview: false };
  if (RASTER_TYPES.has(extension)) {
    if (info.size > MAX_IMAGE_BYTES) return { ...base, kind: "image", canSystemOpen: true, reason: "图片超过 20 MB，应用内不直接加载；可以用系统应用打开" };
    const bytes = await readFile(full);
    if (bytes.length > MAX_IMAGE_BYTES) return { ...base, kind: "image", canSystemOpen: true, reason: "图片超过 20 MB，应用内不直接加载；可以用系统应用打开" };
    return { ...base, kind: "image", revision: createHash("sha256").update(bytes).digest("hex"), mediaType: RASTER_TYPES.get(extension), dataUrl: `data:${RASTER_TYPES.get(extension)};base64,${bytes.toString("base64")}`, canSystemOpen: true };
  }
  if (OFFICE_TYPES.has(extension)) return { ...base, kind: "office", extension: extension.slice(1).toUpperCase(), canSystemOpen: true };
  if (info.size > MAX_TEXT_BYTES) return { ...base, kind: "binary", reason: "文件超过 512 KB，应用内不直接作为文本加载" };
  const bytes = await readFile(full);
  if (bytes.length > MAX_TEXT_BYTES) return { ...base, kind: "binary", reason: "文件超过 512 KB，应用内不直接作为文本加载" };
  if (bytes.includes(0)) return { ...base, kind: "binary", revision: createHash("sha256").update(bytes).digest("hex"), reason: "这是二进制文件，不能显示为文本" };
  return { ...base, kind: "text", text: bytes.toString("utf8").replace(/\r\n?/g, "\n"), revision: createHash("sha256").update(bytes).digest("hex"), canPreview: /\.html?$/i.test(relative) };
}

export async function workspaceOpenTarget(cwd, relative, { system = false } = {}) {
  const file = await inspectWorkspaceFile(cwd, relative);
  if (system && !file.canSystemOpen) throw new Error("为避免执行脚本或网页，这类文件只能在应用内查看或显示所在位置");
  return { file, full: await workspacePath(cwd, relative) };
}

export async function createArtifactServer(cwd) {
  const secretPath = randomBytes(24).toString("base64url");
  let origin, prefix;
  const relativeOf = value => {
    try {
      const target = new URL(value);
      if (target.origin !== origin || !target.pathname.startsWith(prefix)) return null;
      return target.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    } catch { return null; }
  };
  const server = createServer(async (req, res) => {
    try {
      if (!["GET", "HEAD"].includes(req.method)) throw new Error();
      const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (!pathname.startsWith(`/${secretPath}/`)) throw new Error();
      const relative = pathname.slice(secretPath.length + 2);
      const full = await workspacePath(cwd, relative);
      const mime = PREVIEW_TYPES[path.extname(full).toLowerCase()];
      const info = await stat(full);
      if (!mime || !info.isFile() || info.size > 20 * 1024 * 1024) throw new Error();
      const bytes = req.method === "HEAD" ? undefined : await readFile(full);
      if (bytes && bytes.length > 20 * 1024 * 1024) throw new Error();
      const contentType = /^(?:text\/|application\/json)/.test(mime) ? `${mime}; charset=utf-8` : mime;
      const headers = { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes",
        "content-security-policy": "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'" };
      // A video is asked for in pieces, as the published site answers them.
      const range = byteRange(req.headers.range, info.size);
      if (range === "unsatisfiable") { res.writeHead(416, { ...headers, "content-range": `bytes */${info.size}` }); res.end(); return; }
      if (range) {
        res.writeHead(206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${info.size}`, "content-length": String(range.end - range.start + 1) });
        res.end(bytes?.subarray(range.start, range.end + 1));
        return;
      }
      res.writeHead(200, headers);
      res.end(bytes);
    } catch { if (!res.headersSent) { res.writeHead(404); res.end("Not found"); } else res.destroy(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`; prefix = `/${secretPath}/`;
  return { origin, url: (relative) => `${origin}/${secretPath}/${relative.split("/").map(encodeURIComponent).join("/")}`,
    allows: value => relativeOf(value) !== null, relative: relativeOf,
    close: () => { server.close(); server.closeAllConnections(); } };
}
