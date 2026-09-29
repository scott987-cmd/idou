// The numbers an operator needs to size this server and to see it filling up,
// in the Prometheus text format, on a listener of its own that only this
// machine can reach (127.0.0.1, never behind nginx). Until this existed there
// was nothing to look at but the log: how close the server ran to its limits,
// and how often it turned somebody away, could not be known.
//
// Counts and limits only. Never a prompt, an answer, a person's name or id, a
// token, a path -- nothing here is keyed by anybody, so nothing can be.
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

const NAME = /^[a-z_][a-z0-9_]*$/;
const LOOP_RESOLUTION_MS = 10;
const escape = (value) => String(value).replace(/[\\"\n]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`));

// [{ name, help, type, values: [{ labels, value }] }] as exposition text.
export function renderMetrics(samples) {
  const lines = [];
  for (const { name, help, type, values } of samples) {
    if (!NAME.test(name) || !["gauge", "counter"].includes(type)) throw new Error(`Invalid metric ${name}`);
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const { labels = {}, value } of values) {
      const tags = Object.entries(labels).map(([key, text]) => {
        if (!NAME.test(key)) throw new Error(`Invalid metric label ${key}`);
        return `${key}="${escape(text)}"`;
      }).join(",");
      lines.push(`${name}${tags ? `{${tags}}` : ""} ${Number.isFinite(value) ? value : 0}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const gauge = (name, help, value, labels) => ({ name, help, type: "gauge", values: [{ labels, value }] });
const counter = (name, help, values) => ({ name, help, type: "counter", values });

// What this server is doing now. Each source is optional: a server without
// Feishu login has no CLI proxy, one without scheduled tasks no scheduler.
export function collectMetrics({ release = "unknown", role = "coordinator", startedAt, sessions = null, gateway = null, cliProxy = null, scheduler = null, sourceAccess = null, renewal = null, loop = null, now = Date.now }) {
  const memory = process.memoryUsage();
  const samples = [
    gauge("idou_release_info", "The signed release this server runs", 1, { release }),
    // coordinator | api (docs/scaling-plan.md §2.3)
    gauge("idou_role_info", "Which part of the control plane this process is", 1, { role }),
    gauge("idou_uptime_seconds", "Seconds since this server started", (now() - startedAt) / 1000),
    gauge("idou_resident_memory_bytes", "Resident memory of this process", memory.rss),
    gauge("idou_heap_used_bytes", "JavaScript heap in use", memory.heapUsed),
  ];
  if (loop) {
    // Since the previous scrape: a server that is busy computing, or blocked
    // on a synchronous database call, shows up here before anywhere else.
    samples.push({ name: "idou_event_loop_delay_seconds", help: "Event loop delay since the previous scrape", type: "gauge",
      // Node records the time between samples, the sampling interval included:
      // an idle process reads its resolution. That interval is taken off.
      values: [["0.5", loop.percentile(50)], ["0.99", loop.percentile(99)], ["1", loop.max]].map(([quantile, ns]) => ({ labels: { quantile }, value: Math.max(0, ns - (loop.resolutionMs ?? 0) * 1e6) / 1e9 })) });
  }
  if (sessions) {
    const by = new Map();
    const at = now();
    for (const session of sessions.sessions.values()) if (session.expiresAt > at) by.set(session.audience, (by.get(session.audience) ?? 0) + 1);
    samples.push({ name: "idou_sessions", help: "Sessions alive, by what they are for", type: "gauge",
      values: [...by].sort(([a], [b]) => a.localeCompare(b)).map(([audience, value]) => ({ labels: { audience }, value })) });
  }
  if (gateway) {
    const c = gateway.capacity();
    samples.push(
      gauge("idou_model_requests_active", "Model requests in flight", c.active),
      gauge("idou_model_requests_limit", "Model requests allowed in flight at once, for the whole server", c.maxConcurrent),
      gauge("idou_model_requests_limit_per_user", "Model requests one person may have in flight at once", c.maxConcurrentPerUser),
      gauge("idou_model_requests_per_minute_limit", "Model requests one session may make in a minute", c.requestsPerMinute),
      gauge("idou_model_people_active", "People with a model request in flight", c.people),
      counter("idou_model_requests_total", "Model requests that passed authentication", [{ value: c.requests }]),
      counter("idou_model_requests_rejected_total", "Model requests refused for capacity, by the limit that refused them",
        Object.entries(c.rejected).map(([reason, value]) => ({ labels: { reason }, value }))));
  }
  if (cliProxy) {
    const c = cliProxy.capacity();
    samples.push(
      gauge("idou_feishu_cli_calls_active", "Feishu calls in flight through the CLI proxy", c.active),
      gauge("idou_feishu_cli_calls_limit", "Feishu calls allowed in flight at once, for the whole server", c.maxConcurrent),
      gauge("idou_feishu_cli_calls_limit_per_user", "Feishu calls one person may have in flight at once", c.maxConcurrentPerUser),
      counter("idou_feishu_cli_calls_total", "Feishu calls that reached the capacity check", [{ value: c.calls }]),
      counter("idou_feishu_cli_calls_busy_total", "Feishu calls refused for capacity, by the limit that refused them",
        Object.entries(c.busy).map(([reason, value]) => ({ labels: { reason }, value }))));
  }
  if (scheduler) {
    samples.push(
      gauge("idou_schedule_runs_active", "Scheduled runs executing now", scheduler.running.size),
      gauge("idou_schedule_runs_limit", "Scheduled runs allowed at once", scheduler.maxConcurrent));
  }
  // The limits that were a pilot's constants (limits.js): how close the server
  // is to them is what says when it needs more.
  if (sourceAccess) {
    const c = sourceAccess.capacity();
    samples.push(
      gauge("idou_signed_in_sessions", "Sessions holding Feishu access, and sign-ins about to", c.signedIn),
      gauge("idou_signed_in_limit", "Signed-in sessions allowed, for the whole server", c.signedInLimit),
      gauge("idou_feishu_reads_active", "Feishu reads and checks in flight", c.reads),
      gauge("idou_feishu_reads_limit", "Feishu reads and checks allowed in flight at once, for the whole server", c.readsLimit));
  }
  if (renewal) {
    const c = renewal.capacity();
    samples.push(
      gauge("idou_renewals_active", "Online renewals in flight", c.renewals),
      gauge("idou_renewals_limit", "Online renewals allowed in flight at once, for the whole server", c.renewalsLimit));
  }
  return samples;
}

// GET /metrics on 127.0.0.1:<port>. The event loop delay is sampled from the
// moment this starts and reset at each scrape.
export async function startMetricsListener({ port, collect }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid metrics port");
  if (typeof collect !== "function") throw new Error("Metrics need a collector");
  const loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
  loop.resolutionMs = LOOP_RESOLUTION_MS;
  loop.enable();
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/metrics") { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("not found\n"); return; }
    let body;
    try { body = renderMetrics(collect(loop)); loop.reset(); }
    catch (error) {
      process.stderr.write(`${JSON.stringify({ component: "metrics", event: "collect-failed", message: String(error?.message ?? error).slice(0, 200) })}\n`);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); res.end("metrics unavailable\n"); return;
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });
  server.on("close", () => loop.disable());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}
