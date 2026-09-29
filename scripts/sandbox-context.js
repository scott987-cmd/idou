// The build context of a sandbox image: exactly what sandbox/Dockerfile copies,
// read from its COPY lines, cloned into a directory of its own for each build.
//
// A directory of its own, every time: BuildKit syncs a local context
// incrementally, keyed by the directory's path, and does not send again a file
// whose size and modification time match what it kept from the last build. npm
// stamps every file of a package with one time (1985-10-26), and a version bump
// of the same length leaves many files the same size -- so building Codex
// 0.157.0 for linux-x64 in the repository got 26 files of 0.155.0 out of the
// previous build's cache, and the image's own checksums refused it
// (2026-09-26). A fresh path has nothing kept under it; everything is sent.
//
// Read from the Dockerfile rather than listed again: the list the supply-chain
// smoke kept by hand had fallen two files behind it.
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export const DOCKERFILE = "sandbox/Dockerfile";

// The sources of every COPY, with ${SANDBOX_PLATFORM} filled in. A COPY that
// reads from another stage or a URL, or names a path outside the context, is
// refused rather than guessed at.
export function dockerfileSources(text, platform) {
  const lines = text.replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const sources = [];
  for (const line of lines) {
    const match = /^\s*(COPY|ADD)\s+(.*)$/i.exec(line);
    if (!match) continue;
    if (match[1].toUpperCase() === "ADD") throw new Error("sandbox/Dockerfile uses ADD; only COPY from the build context is supported");
    const words = match[2].trim().split(/\s+/).filter((word) => !word.startsWith("--chmod=") && !word.startsWith("--chown="));
    if (words.some((word) => word.startsWith("--"))) throw new Error(`a COPY this cannot follow: ${line.trim()}`);
    for (const word of words.slice(0, -1)) {
      const source = word.replaceAll("${SANDBOX_PLATFORM}", platform);
      if (source.includes("$") || path.isAbsolute(source) || source.split("/").includes("..")) throw new Error(`a COPY source outside the context: ${word}`);
      sources.push(source);
    }
  }
  if (!sources.length) throw new Error("sandbox/Dockerfile copies nothing");
  return [...new Set(sources)];
}

// A fresh context under $HOME (colima mounts nothing else), cloned where the
// filesystem can (APFS), so a few hundred megabytes of Codex cost nothing.
// Finder's .DS_Store is left out, as verifyTree leaves it out.
export async function prepareContext(root, platform, { parent = os.homedir(), mutate = null } = {}) {
  const directory = await mkdtemp(path.join(parent, ".idou-sandbox-context-"));
  const text = await readFile(path.join(root, DOCKERFILE), "utf8");
  for (const entry of [DOCKERFILE, ...dockerfileSources(text, platform)]) {
    await cp(path.join(root, entry), path.join(directory, entry), { recursive: true, preserveTimestamps: true, mode: constants.COPYFILE_FICLONE,
      filter: (source) => path.basename(source) !== ".DS_Store" });
  }
  if (mutate) await mutate(directory);
  return directory;
}
