// Images pasted into a coding task's input box, as Codex and Claude Code take
// them. The page hands over only the image itself (a data URL), never a path:
// a path chosen by the page could point Codex at any file on the disk. This
// process checks what the bytes are, writes them into the account's own
// attachments folder, and gives the task service those paths, which Codex
// sends to the model as the images of that message (`localImage`).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Each type by the bytes it starts with, not by what the page says it is.
const TYPES = Object.freeze({
  "image/png": { extension: "png", is: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { extension: "jpg", is: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/gif": { extension: "gif", is: (bytes) => ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")) },
  "image/webp": { extension: "webp", is: (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP" },
});
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The folder a task's pasted images live in, under the account's own data.
export const imageFolder = (root, taskId) => path.join(root, "attachments", taskId);

// Checks every image before writing any, so a bad one sends none of them.
export async function savePastedImages(folder, images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length > MAX_IMAGES) throw new Error(`一次最多发 ${MAX_IMAGES} 张图片`);
  const checked = images.map((image) => {
    const type = typeof image?.type === "string" ? image.type : "";
    const kind = TYPES[type];
    const prefix = `data:${type};base64,`;
    if (!kind || typeof image.data !== "string" || !image.data.startsWith(prefix)) throw new Error("只能粘贴 PNG、JPEG、GIF 或 WebP 图片");
    if ((image.data.length - prefix.length) * 3 / 4 > MAX_IMAGE_BYTES + 3) throw new Error("图片超过 10 MB");
    const bytes = Buffer.from(image.data.slice(prefix.length), "base64");
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error("图片超过 10 MB");
    if (!kind.is(bytes)) throw new Error("图片内容和它的类型对不上");
    return { id: ID.test(image.id ?? "") ? image.id : randomUUID(), type, bytes, extension: kind.extension };
  });
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const saved = [];
  for (const image of checked) {
    const file = path.join(folder, `${image.id}.${image.extension}`);
    try { await writeFile(file, image.bytes, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST" || !(await readFile(file)).equals(image.bytes)) throw error;
    }
    saved.push({ id: image.id, type: image.type, path: file });
  }
  return saved;
}

// One saved image as a data URL, for the conversation to show it.
export async function readPastedImage(folder, image) {
  if (!ID.test(image?.id ?? "") || !TYPES[image.type]) throw new Error("找不到这张图片");
  const bytes = await readFile(path.join(folder, `${image.id}.${TYPES[image.type].extension}`));
  return `data:${image.type};base64,${bytes.toString("base64")}`;
}

// With the task, its images go too.
export const removePastedImages = (folder) => rm(folder, { recursive: true, force: true });
