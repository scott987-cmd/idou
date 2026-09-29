import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../src/providers/process-runner.js";

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-process-limit-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, output: path.join(directory, "payload.bin"), pid: path.join(directory, "pid.txt") };
}
const child = `const fs=require("node:fs"); fs.writeFileSync("pid.txt",String(process.pid)); process.on("SIGTERM",()=>{}); `;
async function assertDead(pidfile) { const pid = Number(await readFile(pidfile, "utf8")); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); }
test("subprocess timeout waits for a TERM-ignoring child to exit before rejecting", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runProcess(process.execPath, ["-e", child + "setInterval(()=>{},1000)"], { cwd: f.directory, timeoutMs: 1000 }), /timed out/);
  await assertDead(f.pid);
});
test("file watchdog terminates an oversized download and output overflow also waits for exit", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runProcess(process.execPath, ["-e", child + 'fs.writeFileSync("payload.bin",Buffer.alloc(2048)); setInterval(()=>{},1000)'], { cwd: f.directory, timeoutMs: 5000, outputFileLimit: { path: f.output, maxBytes: 1024 } }), /file limit/);
  await assertDead(f.pid);
  await assert.rejects(runProcess(process.execPath, ["-e", child + 'process.stdout.write("x".repeat(2048)); setInterval(()=>{},1000)'], { cwd: f.directory, timeoutMs: 5000, maxOutputBytes: 1024 }), /bytes of output/);
  await assertDead(f.pid);
});
test("bounded subprocess preserves normal JSON output and rejects unsafe monitor configuration before spawn", async (t) => {
  const f = await fixture(t);
  const result = await runProcess(process.execPath, ["-e", 'require("node:fs").writeFileSync("payload.bin","bytes"); console.log(JSON.stringify({ok:true}))'], { cwd: f.directory, outputFileLimit: { path: f.output, maxBytes: 10 } });
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).ok, true);
  await assert.rejects(runProcess(process.execPath, [], { cwd: f.directory, outputFileLimit: { path: path.join(f.directory, "outside", "file"), maxBytes: 10 } }), /Invalid/);
  await assert.rejects(runProcess(path.join(f.directory, "missing-binary"), []), { code: "ENOENT" });
});
test("aborted reads wait for the child to exit and pre-aborted calls never spawn", async t => {
  const f = await fixture(t), controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", child + "setInterval(()=>{},1000)"], { cwd: f.directory, signal: controller.signal });
  const failed = assert.rejects(running, /canceled/);
  for (let i = 0; i < 100; i++) { try { await readFile(f.pid); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  controller.abort(); await failed; await assertDead(f.pid);
  await assert.rejects(runProcess(path.join(f.directory, "must-not-spawn"), [], { signal: controller.signal }), /canceled/);
});
