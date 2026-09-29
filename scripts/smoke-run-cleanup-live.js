import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScheduledRunner } from "../src/control-plane/scheduled-run.js";
import { DockerSandbox } from "../src/control-plane/sandbox/docker-sandbox.js";
import { sandboxImageTag } from "../src/control-plane/sandbox/sandbox-image.js";

// Real Docker + real workspace cleanup; no model, Feishu, pull, or shared state.
const directory = await mkdtemp(path.join(os.homedir(), ".idou-cleanup-test-"));
const owner = createHash("sha256").update(directory).digest("hex").slice(0, 16);
const box = new DockerSandbox({ owner }), image = sandboxImageTag();
let cleaned = false;
try {
  for (const [name, command, expected] of [
    ["success", "require('fs').writeFileSync('/workspace/report.txt','SYNTHETIC-PRIVATE'); console.log('done')", null],
    ["failure", "require('fs').writeFileSync('/workspace/report.txt','SYNTHETIC-PRIVATE'); process.exit(3)", /退出码 3/],
    ["timeout", "require('fs').writeFileSync('/workspace/report.txt','SYNTHETIC-PRIVATE'); setInterval(()=>{},1000)", /超过/],
    ["abort", "setInterval(()=>{},1000)", /CLI operation canceled/],
  ]) {
    const tokens = new Set(), runId = randomUUID(), controller = new AbortController();
    const runner = new ScheduledRunner({ image, workspaceRoot: path.join(directory, "runs"),
      workspaceFor: ({ runId }) => path.join(directory, "runs", runId), gateway: "http://unused.invalid",
      egress: { open: () => { tokens.add("fixture"); return "fixture"; }, close: token => tokens.delete(token) },
      sandbox: { execute: (job, options) => box.execute({ ...job, command: ["node", "-e", command], network: { mode: "none" } }, options) },
      limits: { timeoutMs: 10_000 } });
    const claim = { runId, signal: controller.signal, dueAt: Date.now(), schedule: { title: "fixture", mode: "cowork", prompt: "SYNTHETIC-PROMPT" } };
    const timer = name === "abort" ? setTimeout(() => controller.abort(), 1500) : null;
    try {
      if (expected) await assert.rejects(runner.run(claim), expected);
      else assert.match((await runner.run(claim)).detail, /done/);
    } finally { clearTimeout(timer); }
    assert.equal(tokens.size, 0);
    assert.deepEqual((await readdir(path.join(directory, "runs"))).filter(name => name !== ".run-owners"), []);
    assert.deepEqual(await readdir(path.join(directory, "runs/.run-owners")), []);
    assert.equal(await box.sweep(), 0, "the run must have already removed its own container");
    console.log(`PASS ${name}: token revoked, container removed, workspace and ownership record gone`);
  }
  cleaned = true;
} finally {
  // Only erase the fixture after the daemon confirms its containers are gone.
  try { await box.sweep(); cleaned = true; } catch { cleaned = false; }
  if (cleaned) await rm(directory, { recursive: true, force: true });
  else console.error(`Docker cleanup unconfirmed; fixture retained at ${directory}`);
}
