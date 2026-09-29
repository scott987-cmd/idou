// 测试里怎么看磁盘上的知识副本。
//
// 副本从「一个加密大文件」改成「一篇文档一个加密文件 + 一份清单」之后，断言要看的
// 还是同一件事：存了哪些页、页上写着什么、以及正文有没有以明文落在任何一个文件里。
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// 清单此刻认账的那些页，顺序与清单一致。
export async function storedPages(cipher, filename) {
  let manifest;
  try { manifest = JSON.parse(cipher.decrypt(await readFile(filename))); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (manifest.version === 1) return manifest.pages;
  const pages = [];
  for (const entry of manifest.pages ?? []) {
    const file = `${createHash("sha256").update(String(entry.owner)).digest("hex")}.enc`;
    pages.push(JSON.parse(cipher.decrypt(await readFile(path.join(`${filename}.d`, file)))));
  }
  return pages;
}

// 副本目录下所有文件的字节：用来断言某段正文没有以明文落盘。
export async function storedBytes(filename) {
  const parts = [];
  try { parts.push(await readFile(filename)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let names = [];
  try { names = await readdir(`${filename}.d`); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const name of names.sort()) parts.push(await readFile(path.join(`${filename}.d`, name)));
  return Buffer.concat(parts);
}
