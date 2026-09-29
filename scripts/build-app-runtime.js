// Explicit developer/admin operation, never run at desktop or server startup.
import { mkdtemp, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const docker = process.argv[2];
if (!docker || !path.isAbsolute(docker) || process.argv.length !== 3) throw new Error("Usage: node scripts/build-app-runtime.js /absolute/path/to/docker");
const context = await mkdtemp(path.join(os.tmpdir(), "idou-runtime-build-"));
try {
  const sources = fileURLToPath(new URL("../src/apps/", import.meta.url));
  for (const name of ["manifest.js", "archive.js", "runtime-frames.js", "runtime-worker.js"]) await copyFile(path.join(sources, name), path.join(context, name));
  await copyFile(path.join(sources, "runtime.Dockerfile"), path.join(context, "Dockerfile"));
  await writeFile(path.join(context, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // The build context contains only these six files, never workspace or secrets.
  await promisify(execFile)(docker, ["build", "--network", "none", "--iidfile", path.join(context, "image.id"), context], { timeout: 180000, maxBuffer: 1048576 });
  const imageId = (await readFile(path.join(context, "image.id"), "utf8")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Invalid runtime image receipt");
  console.log(JSON.stringify({ imageId, protocol: 1, baseImage: "node@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f" }));
} finally { await rm(context, { recursive: true, force: true }); }
