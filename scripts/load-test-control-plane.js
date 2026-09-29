#!/usr/bin/env node
// How much our own control plane carries, without anybody's model account in
// the way: the model gateway as the server builds it, in its own process,
// against a stand-in upstream that streams each answer over a few seconds the
// way a model does. People are simulated as distinct sessions, each asking for
// one answer after another, as an agent turn does; the level is how many
// answers stream at once.
//
//   node scripts/load-test-control-plane.js [--levels 100,300,1000] [--seconds 20] [--stream-ms 3000]
//
// Reported per level: answers a second, time per answer and what the gateway
// added to the upstream's own time (p50/p99), refusals and errors, the
// gateway's event loop delay (p99/max), CPU and memory. Nothing here reaches a
// paid model or Feishu. Run on the machine whose capacity is the question: a
// laptop's numbers are not a 4-core server's.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (name, fallback) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : fallback; };
const levels = option("--levels", "100,300,1000").split(",").map(Number);
const seconds = Number(option("--seconds", "20"));
const streamMs = Number(option("--stream-ms", "3000"));
const perUser = Number(option("--per-user", "4"));
const free = () => new Promise((resolve) => { const probe = createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN;

function start(script, config) {
  const child = spawn(process.execPath, ["--no-warnings", path.join(here, "fixtures", "load-test", script), JSON.stringify(config)], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => { buffer += chunk; const line = buffer.split("\n")[0]; if (buffer.includes("\n")) resolve({ child, ...JSON.parse(line) }); });
    child.once("exit", (code) => reject(new Error(`${script} exited ${code}`)));
  });
}

async function sample(pid) {
  const { stdout } = await promisify(execFile)("ps", ["-o", "%cpu=,rss=", "-p", String(pid)]);
  const [cpu, rss] = stdout.trim().split(/\s+/).map(Number);
  return { cpu, rssMb: rss / 1024 };
}

const directory = await mkdtemp(path.join(os.tmpdir(), "idou-load-"));
const children = [];
try {
  const users = Math.max(...levels);
  const upstream = await start("upstream.js", { durationMs: streamMs, chunks: 30 }); children.push(upstream.child);
  const metricsPort = await free();
  const gateway = await start("gateway.js", { upstreamPort: upstream.port, users, maxConcurrent: 4096, maxConcurrentPerUser: perUser,
    usageFile: path.join(directory, "usage.sqlite"), tokensFile: path.join(directory, "tokens.json"), metricsPort }); children.push(gateway.child);
  const tokens = JSON.parse(await readFile(path.join(directory, "tokens.json"), "utf8"));
  const url = `http://127.0.0.1:${gateway.port}/v1/responses`;
  const body = JSON.stringify({ model: "GLM-5.3", input: "压测", stream: true });
  process.stdout.write(`gateway pid ${gateway.child.pid}; each answer streams for ${streamMs} ms; per-person limit ${perUser}; ${seconds} s per level\n\n`);
  process.stdout.write("同时流式回答  每秒完成  单次耗时p50/p99(ms)  网关附加p50/p99(ms)  429  其它错误  事件循环p99/max(ms)  网关CPU%  内存MB\n");
  for (const level of levels) {
    await fetch(`http://127.0.0.1:${metricsPort}/metrics`).then((r) => r.text()); // reset the loop histogram
    const times = []; let refused = 0, failed = 0, done = 0;
    const until = Date.now() + seconds * 1000;
    const cpu = [];
    const sampler = setInterval(() => { void sample(gateway.child.pid).then((s) => cpu.push(s)).catch(() => {}); }, 2000);
    // Started over two seconds, not at once: a burst beyond the listen backlog
    // measures the kernel, not the gateway.
    await Promise.all(Array.from({ length: level }, async (_, index) => {
      await new Promise((resolve) => setTimeout(resolve, (index / level) * 2000));
      while (Date.now() < until) {
        const began = Date.now();
        try {
          const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tokens[index]}`, "content-type": "application/json" }, body });
          if (response.status === 429) { refused += 1; await response.body?.cancel(); await new Promise((resolve) => setTimeout(resolve, 200)); continue; }
          const text = await response.text();
          if (response.status !== 200 || !text.includes("response.completed")) { failed += 1; continue; }
          times.push(Date.now() - began); done += 1;
        } catch { failed += 1; }
      }
    }));
    clearInterval(sampler);
    const metrics = await (await fetch(`http://127.0.0.1:${metricsPort}/metrics`)).text();
    const loop = (quantile) => Number(new RegExp(`^idou_event_loop_delay_seconds\\{quantile="${quantile}"\\} (\\S+)$`, "m").exec(metrics)?.[1] ?? NaN) * 1000;
    const sorted = times.sort((a, b) => a - b);
    const peak = cpu.reduce((best, s) => (s.cpu > best.cpu ? s : best), { cpu: 0, rssMb: 0 });
    const avgCpu = cpu.length ? cpu.reduce((sum, s) => sum + s.cpu, 0) / cpu.length : NaN;
    process.stdout.write(`${String(level).padStart(12)}  ${(done / seconds).toFixed(1).padStart(8)}  ${`${percentile(sorted, 0.5)}/${percentile(sorted, 0.99)}`.padStart(19)}  ${`${percentile(sorted, 0.5) - streamMs}/${percentile(sorted, 0.99) - streamMs}`.padStart(19)}  ${String(refused).padStart(3)}  ${String(failed).padStart(8)}  ${`${loop("0.99").toFixed(1)}/${loop("1").toFixed(1)}`.padStart(19)}  ${`${avgCpu.toFixed(0)}(峰${peak.cpu.toFixed(0)})`.padStart(8)}  ${peak.rssMb.toFixed(0).padStart(6)}\n`);
  }
} finally {
  for (const child of children) child.kill("SIGTERM");
  await rm(directory, { recursive: true, force: true });
}
