import { randomBytes, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { loadChatModelConfig } from "../../../src/control-plane/server-config.js";
import { createModelGateway } from "../../../src/control-plane/model-gateway.js";
import { getMode, getPermission } from "../../../src/modes.js";

// The product's model gateway for one Terminal-Bench run.
//
// Task containers inside colima reach a service on this Mac's loopback at
// 192.168.5.2 (measured), so the gateway listens on 127.0.0.1 only and nothing is
// exposed to the network. As in the control plane, the chat model's key stays in
// this process. Containers hold a random token that is valid only while this
// process runs, written to a 0600 file and never printed.
//
//   set -a; . <deployment file>; set +a
//   node scripts/benchmarks/terminal_bench/gateway.js --run-dir <directory> [--port 43210]
//
// The run directory also receives the product's developer instructions for a
// coding task with full access (the task container is the sandbox), for the agent
// to hand to Codex, and one audit line per model request.
const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const runDir = option("--run-dir");
if (!runDir) throw new Error("--run-dir is required");
const port = Number(option("--port", "43210"));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("--port must be a port number above 1023");

await mkdir(runDir, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString("base64url"), expected = Buffer.from(token);
await writeFile(path.join(runDir, "token"), token, { mode: 0o600 });
await writeFile(path.join(runDir, "developer-instructions.txt"), `${getMode("coding").developerInstructions}\n${getPermission("full").instruction}\n`);

const identity = Object.freeze({ id: "terminal-bench", tenantId: "benchmark", userId: "terminal-bench", deviceId: "benchmark",
  audience: "codex-model-gateway", scopes: Object.freeze(["models:responses"]) });
const sessions = { verify: (value) => {
  const given = Buffer.from(String(value ?? ""));
  return given.length === expected.length && timingSafeEqual(given, expected) ? identity : null;
} };
const statuses = {};
const auditFile = path.join(runDir, "gateway-audit.jsonl");
const chat = await loadChatModelConfig();
const server = createModelGateway({ ...chat, sessions, requestsPerMinute: 240, maxConcurrent: 4,
  audit: async (event) => { statuses[event.status] = (statuses[event.status] ?? 0) + 1; await appendFile(auditFile, `${JSON.stringify({ at: new Date().toISOString(), status: event.status })}\n`); } });
server.listen(port, "127.0.0.1");
await once(server, "listening");
await writeFile(path.join(runDir, "gateway.json"), `${JSON.stringify({ containerBaseUrl: `http://192.168.5.2:${port}/v1`, model: chat.model, startedAt: new Date().toISOString() }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ listening: `127.0.0.1:${port}`, containerBaseUrl: `http://192.168.5.2:${port}/v1`, model: chat.model, runDir })}\n`);

const stop = () => { process.stdout.write(`${JSON.stringify({ stopped: true, statuses })}\n`); server.close(); server.closeAllConnections(); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
