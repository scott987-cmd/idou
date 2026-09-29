#!/usr/bin/env node
// Explicit operator action. Saves only a short-lived, exact-version runtime
// capability; never forwards the parent/model token to the runtime node.
import "../src/adopt-legacy-env.js";
import { constants } from "node:fs";
import { lstat, realpath, open } from "node:fs/promises";
import path from "node:path";
import { readClientSession } from "../src/control-plane/client-session.js";
import { runtimeRequest } from "../src/apps/runtime-http.js";
import { runtimeBinding } from "../src/apps/runtime-grant.js";
import { appId, appDigest } from "../src/apps/manifest.js";

const [sessionPath, id, digest, output] = process.argv.slice(2);
if (process.argv.length !== 6 || !appId(id) || !appDigest(digest) || !path.isAbsolute(output || "")) throw new Error("Usage: node bin/app-runtime-grant.js /absolute/operator-session.json app-id manifest-sha256 /absolute/new-grant.json");
const directory = path.dirname(output), stat = await lstat(directory);
if (!stat.isDirectory() || await realpath(directory) !== directory || process.platform !== "win32" && ((stat.mode & 0o077) || stat.uid !== process.getuid())) throw new Error("Runtime grant output requires a private owned directory");
// Reserve an exclusive file before issuing: never overwrite another grant.
const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
try {
  const session = await readClientSession(sessionPath);
  const grant = await runtimeRequest(session.serverUrl, session.token, "/auth/app-runtime-token", { appId: id, digest });
  const binding = runtimeBinding(grant.binding);
  if (typeof grant.token !== "string") throw new Error("Invalid runtime token response");
  if (binding.appId !== id || binding.digest !== digest || grant.audience !== "app-runtime" || grant.deployed !== false || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() || grant.expiresAt > Math.min(session.expiresAt, Date.now() + 300000)) throw new Error("Invalid runtime grant response");
  await file.writeFile(JSON.stringify({ token: grant.token, audience: grant.audience, binding, expiresAt: grant.expiresAt, deployed: false })); await file.sync();
  console.log(JSON.stringify({ grantFile: output, expiresAt: grant.expiresAt, appId: id, digest, nodeId: binding.nodeId, deployed: false }));
} finally { await file.close(); }
