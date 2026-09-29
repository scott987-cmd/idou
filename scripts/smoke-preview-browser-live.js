import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createArtifactServer } from "../src/application/workspace-files.js";

// The preview boundary, proved with a real headless Chromium rather than by
// asserting on a pure function: the coding agent can open its own task's build
// output, and a second loopback server on another port — standing in for the
// model gateway / control plane / LiteLLM, which really do live there — stays
// unreachable, with its content never appearing in any reply.
// No model calls and no internet: everything here is loopback.
const root = await mkdtemp(path.join(os.tmpdir(), "idou-preview-live-"));
const workspace = path.join(root, "workspace");
await mkdir(workspace);
await writeFile(path.join(workspace, "index.html"), "<h1>PREVIEW_MARKER_OK</h1>");
// A hyphen in the name: the path guard once rejected these, so keep it covered.
await writeFile(path.join(workspace, "my-app.html"), "<h1>HYPHEN_MARKER_OK</h1>");

const artifact = await createArtifactServer(workspace);
const decoy = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>GATEWAY_SECRET_LEAKED</h1>"); });
decoy.listen(0, "127.0.0.1"); await once(decoy, "listening");
const decoyOrigin = `http://127.0.0.1:${decoy.address().port}`;

const server = spawn(process.execPath, [fileURLToPath(new URL("../bin/mcp/browser.js", import.meta.url)), "--preview-base", artifact.url("")], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
const transcript = [];
let buffer = "";
server.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (let index; (index = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    transcript.push(line);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  }
});
const call = (id, method, params, timeoutMs = 90_000) => {
  const reply = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`no reply for ${method} in ${timeoutMs}ms`)); }, timeoutMs).unref?.();
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return reply;
};
const text = (message) => message.result?.content?.map((part) => part.text ?? "").join("\n") ?? "";

try {
  await call(1, "initialize", { protocolVersion: "2025-06-18" });
  const tools = (await call(2, "tools/list")).result.tools.map((tool) => tool.name);
  assert.ok(tools.includes("browser_preview"), "browser_preview must be offered");

  // 1. The task's own output opens (this launches Chromium for real).
  const preview = await call(3, "tools/call", { name: "browser_preview", arguments: {} });
  assert.notEqual(preview.result.isError, true, `browser_preview failed: ${text(preview)}`);
  assert.match(text(preview), /PREVIEW_MARKER_OK/);

  // 2. A hyphenated filename still resolves (regression: the old guard rejected it).
  const hyphen = await call(4, "tools/call", { name: "browser_preview", arguments: { path: "my-app.html" } });
  assert.notEqual(hyphen.result.isError, true, `hyphenated name refused: ${text(hyphen)}`);
  assert.match(text(hyphen), /HYPHEN_MARKER_OK/);

  // 3. Another port on the same loopback host stays refused.
  const gateway = await call(5, "tools/call", { name: "browser_navigate", arguments: { url: `${decoyOrigin}/` } });
  assert.equal(gateway.result.isError, true, "a second loopback port must not be reachable");
  assert.match(text(gateway), /内网|私有|本机/);

  // 4. Traversal out of the workspace is refused by the path guard.
  const escape = await call(6, "tools/call", { name: "browser_preview", arguments: { path: "../outside.html" } });
  assert.equal(escape.result.isError, true, "traversal must be refused");

  // 5. Nothing the decoy serves ever reached the agent.
  assert.equal(transcript.join("\n").includes("GATEWAY_SECRET_LEAKED"), false, "decoy content leaked into a reply");

  // 6. Nor did the preview server's secret path, although every reply above
  //    names the page it opened: the URL is scrubbed on the way out.
  const secretPath = new URL(artifact.url("")).pathname.split("/").find(Boolean);
  assert.equal(transcript.join("\n").includes(secretPath), false, "the preview server's secret path reached a reply");
  assert.match(text(preview), /本任务成果\/index\.html/, "the reply should still say which page it opened");

  console.log(JSON.stringify({ passed: true, tools: tools.length, previewOpened: true, hyphenatedNameOpened: true,
    otherLoopbackPortRefused: true, traversalRefused: true, decoyNeverLeaked: true, secretPathNeverInReplies: true, actualChromium: true, paidCalls: 0 }));
} finally {
  server.kill();
  artifact.close();
  decoy.close(); decoy.closeAllConnections();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
