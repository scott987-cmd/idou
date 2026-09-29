#!/usr/bin/env node
// Explicit, bounded development validation on a separately operated runtime node.
// This is not a publication endpoint and never accepts an Agent/model credential.
import "../src/adopt-legacy-env.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { createIsolatedStaticApp } from "../src/apps/isolated-static-app.js";
import { createAuthorizedStaticApp } from "../src/apps/authorized-runtime.js";
import { MAX_APP_PACKAGE_BYTES } from "../src/apps/archive.js";

async function privateFile(filename, limit) {
  if (!path.isAbsolute(filename || "")) throw new Error("Runtime inputs require absolute paths");
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit || (process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid()))) throw new Error("Runtime input must be an owned private regular file within its size limit");
    const data = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < data.length) { const part = await file.read(data, used, data.length - used, null); if (!part.bytesRead) break; used += part.bytesRead; }
    const after = await file.stat(); if (used !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Runtime input changed while reading");
    return data.subarray(0, used);
  } finally { await file.close(); }
}
const authorized = process.argv[2] === "--authorized";
if (authorized ? process.argv.length !== 6 : process.argv[2] !== "--development" || process.argv.length !== 7) throw new Error("Usage: node bin/app-runtime.js --development /absolute/config.json /absolute/package.json manifest-sha256 package-sha256 OR --authorized /absolute/node-config.json /absolute/package.json /absolute/grant.json");
const config = JSON.parse(await privateFile(process.argv[3], 4096)), bytes = await privateFile(process.argv[4], MAX_APP_PACKAGE_BYTES);
const instance = authorized ? await createAuthorizedStaticApp({ config, bytes, grant: JSON.parse(await privateFile(process.argv[5], 4096)) }) : await createIsolatedStaticApp({ config, bytes, digest: process.argv[5], sha256: process.argv[6], expiresAt: Date.now() + 300000 });
const stop = () => { void instance.close().catch(() => { process.exitCode = 1; }); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
console.log(JSON.stringify({ developmentOnly: !authorized, authorizedValidation: authorized, deployed: false, url: instance.entryUrl, expiresAt: instance.expiresAt, containerId: instance.containerId, digest: instance.digest }));
try { await instance.closed; } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
