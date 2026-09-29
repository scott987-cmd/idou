import { createHash } from "node:crypto";
export const appHash = (value) => createHash("sha256").update(value).digest("hex");
export const appId = (value) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const appDigest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
// A path a static version may carry. The refusal names the file: a folder with
// one stray notes.txt in it used to fail with a sentence that did not say which
// file, which is a sentence nobody can act on.
export const APP_FILE_TYPES = "html, css, js, mjs, json, png, jpg, jpeg, webp, svg, woff2, mp4, webm";
export const APP_FILE_PATTERN = /\.(html?|css|m?js|json|png|jpe?g|webp|svg|woff2|mp4|webm)$/;
// What each of those is served as -- one table for every place that serves a
// version's files (the published site, the local previews, the review preview,
// the single-file export), so a type allowed in one is served right in all.
export const APP_CONTENT_TYPES = Object.freeze({
  ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".mp4": "video/mp4", ".webm": "video/webm",
});
const VIDEO = /\.(mp4|webm)$/i;
export function appPath(value) {
  const shown = typeof value === "string" ? value.slice(0, 120) : String(value).slice(0, 120);
  if (typeof value !== "string" || !value || value.length > 200 || /[\\\u0000-\u001f\u007f:?#%]/.test(value)) throw new Error(`文件名不能用在网站里：${shown}`);
  if (value.split("/").some((part) => !part || part.startsWith(".") || ["node_modules", "vendor"].includes(part))) throw new Error(`这个位置不会被发布：${shown}`);
  if (!APP_FILE_PATTERN.test(value)) throw new Error(`网站里不能包含这种文件：${shown}（只支持 ${APP_FILE_TYPES}）`);
  return value;
}
// What a version may weigh, enforced here and by the collector (app-candidates.js).
// A video may be larger than any other file -- two mebibytes is a few seconds of
// it -- while the version as a whole stays within the same ten.
export const APP_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, videoBytes: 8 * 1024 * 1024, files: 128, totalBytes: 10 * 1024 * 1024 });
export const appFileLimit = (file) => VIDEO.test(String(file)) ? APP_LIMITS.videoBytes : APP_LIMITS.fileBytes;

// The same rules, told to a coding task working on a site's folder. It used to
// learn them only when 发布 refused the whole version: on 2026-09-23 a task
// asked to put a video on the product page copied an .mp4 and wrote a faq.md
// into the site, and publishing failed at the end on files it had been asked
// to add. Told up front, it converts or leaves out what cannot be published.
export function siteRulesInstruction(name) {
  const site = typeof name === "string" && name.trim() ? `"${name.trim().slice(0, 80)}"` : "a website";
  const mib = (bytes) => `${bytes / 1024 / 1024} MiB`;
  return `This working directory is the folder of ${site}, which i豆 publishes as a static website for other people to open. `
    + `Publishing takes every file in this folder except names that start with "." and the node_modules and vendor folders, and it refuses the whole version if any of those files breaks these rules: `
    + `only ${APP_FILE_TYPES} files (also htm); at most ${mib(APP_LIMITS.videoBytes)} for an mp4 or webm video and ${mib(APP_LIMITS.fileBytes)} for any other file, ${APP_LIMITS.files} files and ${mib(APP_LIMITS.totalBytes)} in all; no symbolic links. `
    + `A video goes in as a <video> of its own file, compressed to fit (H.264 mp4 plays everywhere). Audio, Markdown, plain text, GIF, mov and every other type cannot be published. `
    + `Do not add such files to this folder: convert what the page needs into an allowed type (notes into the HTML itself, a GIF into a WebP or an mp4) or keep it outside this folder, `
    + `and tell the person what you converted or left out and why.`;
}
export function appManifest(value) {
  if (!value || Object.keys(value).some((key) => !["schemaVersion", "runtime", "network", "entry", "files"].includes(key)) || value.schemaVersion !== 1 || value.runtime !== "static" || value.network !== "none" || !Array.isArray(value.files) || !value.files.length || value.files.length > APP_LIMITS.files || !/\.html?$/.test(value.entry)) throw new Error("应用版本清单无效");
  const entry = appPath(value.entry), paths = new Set(); let totalBytes = 0;
  const files = value.files.map((file) => {
    if (!file || Object.keys(file).some((key) => !["path", "bytes", "sha256"].includes(key)) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !appDigest(file.sha256)) throw new Error("应用文件清单无效");
    const path = appPath(file.path), folded = path.toLowerCase().normalize("NFC");
    if (file.bytes > appFileLimit(path)) throw new Error("应用文件清单无效");
    if (paths.has(folded)) throw new Error("应用文件名冲突"); paths.add(folded); totalBytes += file.bytes;
    return { path, bytes: file.bytes, sha256: file.sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (totalBytes > APP_LIMITS.totalBytes || !files.some((file) => file.path === entry && file.bytes > 0)) throw new Error("应用入口缺失或产物超过 10 MiB");
  const manifest = { schemaVersion: 1, runtime: "static", network: "none", entry, files };
  return { manifest, totalBytes, digest: appHash(JSON.stringify(manifest)) };
}
