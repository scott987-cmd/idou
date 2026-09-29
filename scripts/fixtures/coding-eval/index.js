import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The coding evaluation's tasks: small repositories, each with a request, tests
// the Agent never sees until it has finished (`hidden`), and a reference change
// (`solution`) proving the request can be met as written.
//
// Every fixture file carries a `.fixture` suffix, so no test runner, syntax
// check or package tool in this repository mistakes one for its own; the suffix
// comes off when a task is copied out.
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const SUFFIX = ".fixture";

async function walk(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

export async function codingEvalTasks() {
  return JSON.parse(await readFile(path.join(ROOT, "tasks.json"), "utf8"));
}

// Copies one part of a task (`repo`, `hidden` or `solution`) into `target`. A
// repository without its own package.json gets the one every task shares.
export async function materialize(task, part, target) {
  const source = path.join(ROOT, task.id, part);
  const exists = await stat(source).then(info => info.isDirectory(), () => false);
  const files = exists ? await walk(source) : [];
  for (const relative of files) {
    if (!relative.endsWith(SUFFIX)) throw new Error(`Fixture file without ${SUFFIX}: ${task.id}/${part}/${relative}`);
    const destination = path.join(target, relative.slice(0, -SUFFIX.length));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, relative), destination);
  }
  if (part === "repo") {
    const manifest = path.join(target, "package.json");
    if (!await stat(manifest).then(() => true, () => false)) {
      await writeFile(manifest, `${JSON.stringify({ name: task.id, private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`);
    }
  }
  return files.map(relative => relative.slice(0, -SUFFIX.length));
}

// The reference change: files that replace the task's own, or, for a rename, the
// old identifier replaced by the new one in every file.
export async function applySolution(task, target) {
  if (!task.solution?.rename) return materialize(task, "solution", target);
  const [from, to] = task.solution.rename;
  for (const relative of await walk(target)) {
    const file = path.join(target, relative), text = await readFile(file, "utf8");
    if (text.includes(from)) await writeFile(file, text.replaceAll(from, to));
  }
  return [];
}
