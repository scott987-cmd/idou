import { copyFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { convert } from "officeparser";

// A work task is a folder on this machine. Files are attached by copying them
// in, results are written beside them, and the person can open the folder in
// Finder and see both. Nothing here is an "attachment" in a database somewhere:
// what the Agent works on is what is in the directory.
//
// The one thing the Agent cannot do for itself is open a spreadsheet or a deck —
// its shell reads text. So attaching one of those also writes a Markdown copy
// next to it, produced by officeparser, and the Agent reads that.

const READABLE = /\.(?:txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|ts|js|mjs|cjs|py|sh|sql|ini|toml|log)$/i;
const CONVERTIBLE = /\.(?:xlsx|xlsm|xls|docx|doc|pptx|ppt|odt|ods|odp|pdf|rtf|epub)$/i;
const MAX_ATTACH_BYTES = 100 * 1024 * 1024;
export const READABLE_SUFFIX = ".读取版.md";

// A converted copy sits beside the original and is derived, not authored, so it
// is listed as belonging to its source rather than as a file of its own.
export const isDerived = (name) => name.endsWith(READABLE_SUFFIX);
const derivedName = (name) => `${name}${READABLE_SUFFIX}`;

export function attachmentKind(name) {
  if (isDerived(name)) return "derived";
  if (CONVERTIBLE.test(name)) return "convertible";
  if (READABLE.test(name)) return "text";
  if (/\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return "image";
  return "other";
}

// Rejected rather than sanitised: a file that arrived under a different name
// than it had is worse than being told to rename it first.
function safeName(source) {
  const name = path.basename(source);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error("这个文件名无法使用，请先重命名");
  if (name.startsWith(".")) throw new Error("不接受以点开头的隐藏文件");
  if (isDerived(name)) throw new Error("这是自动生成的读取版文件，不需要再添加一次");
  if (Buffer.byteLength(name) > 200) throw new Error("文件名太长，请先重命名");
  return name;
}

// The converted copy is best-effort: a file that could not be converted is
// still attached, and the person is told why rather than losing the file.
//
// The file can come from anywhere, and a PDF is parsed by pdf.js right here in
// the desktop main process. officeparser pins a pdf.js from before the
// CVE-2026-16633 fix, so package.json overrides it; test/task-files.test.js
// fails if the override stops holding or is no longer needed.
async function writeReadableCopy(directory, name) {
  const full = path.join(directory, name);
  try {
    const result = await convert(full, "markdown");
    const text = typeof result === "string" ? result : result?.value ?? "";
    if (!text.trim()) return { converted: false, reason: "这个文件里没有读到文字内容" };
    await writeFile(path.join(directory, derivedName(name)), `<!-- 由 ${name} 自动转换，供 Agent 阅读；请以原文件为准 -->\n\n${text}\n`, { mode: 0o600 });
    return { converted: true };
  } catch (error) {
    return { converted: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

export async function attachFiles(directory, sources) {
  if (!Array.isArray(sources) || !sources.length) throw new Error("请先选择要添加的文件");
  const added = [];
  for (const source of sources) {
    if (typeof source !== "string" || !path.isAbsolute(source)) throw new Error("只能添加本机文件");
    const info = await stat(source);
    if (!info.isFile()) throw new Error("只能添加文件，不能添加文件夹");
    if (info.size > MAX_ATTACH_BYTES) throw new Error(`「${path.basename(source)}」超过 100 MB，暂不支持`);
    const name = safeName(source);
    const target = path.join(directory, name);
    // `wx` refuses to overwrite, so an existing file in the task folder — which
    // may be the Agent's own output — is never silently replaced.
    await copyFile(source, target, 1 /* COPYFILE_EXCL */)
      .catch((error) => { throw error?.code === "EEXIST" ? new Error(`任务里已经有一个叫「${name}」的文件了`) : error; });
    const kind = attachmentKind(name);
    added.push({ name, kind, ...(kind === "convertible" ? await writeReadableCopy(directory, name) : { converted: false }) });
  }
  return added;
}

export async function listTaskFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => entry.name);
  const derived = new Set(names.filter(isDerived));
  const rows = [];
  for (const name of names.filter((item) => !isDerived(item)).sort((a, b) => a.localeCompare(b))) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (!info) continue;
    rows.push({ name, kind: attachmentKind(name), bytes: info.size, modifiedAt: info.mtimeMs,
      readableCopy: derived.has(derivedName(name)) ? derivedName(name) : null });
  }
  return rows;
}

export async function removeTaskFile(directory, name) {
  const safe = safeName(name);
  await unlink(path.join(directory, safe));
  // A converted copy has no meaning without its source.
  await unlink(path.join(directory, derivedName(safe))).catch(() => {});
  return listTaskFiles(directory);
}

// What the model is told about the folder. Names and sizes only: the contents
// are the Agent's to read with its own tools, from the directory it is already
// allowed to work in.
export function taskFilesPrompt(rows) {
  if (!rows.length) return "";
  const lines = rows.map((row) => {
    const size = row.bytes > 1024 * 1024 ? `${(row.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(row.bytes / 1024))} KB`;
    return row.readableCopy
      ? `- ${row.name}（${size}）— 二进制文件，读同目录下的 ${row.readableCopy} 获取其文字内容`
      : `- ${row.name}（${size}）`;
  });
  return `这个任务的工作目录里有以下文件，都是本人放进来的：\n${lines.join("\n")}\n`
    + "在这个目录里直接读写即可；产出也写在这个目录下，用清楚的中文文件名。"
    + "以「.读取版.md」结尾的是自动转换出来的文字副本，只用于阅读，不要改它，也不要把它当成交付物。";
}
