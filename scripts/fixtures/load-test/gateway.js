// The model gateway as the server builds it, alone in a process, for the load
// test: the real createModelGateway, a real usage ledger on disk (its
// synchronous write per answer is part of what is measured), `users` distinct
// people each with a session, and the metrics listener for the event loop.
import { writeFile } from "node:fs/promises";
import { SessionRegistry } from "../../../src/control-plane/sessions.js";
import { createModelGateway } from "../../../src/control-plane/model-gateway.js";
import { ModelUsage } from "../../../src/control-plane/model-usage.js";
import { collectMetrics, startMetricsListener } from "../../../src/control-plane/metrics.js";

const { upstreamPort, users, maxConcurrent, maxConcurrentPerUser, usageFile, tokensFile, metricsPort } = JSON.parse(process.argv[2]);
const sessions = new SessionRegistry();
const tokens = Array.from({ length: users }, (_, index) => sessions.issue({ tenantId: "tenant_load", userId: `user-${index}`, deviceId: `device-${index}` }).token);
await writeFile(tokensFile, JSON.stringify(tokens), { mode: 0o600 });
const usage = await ModelUsage.open({ file: usageFile });
const gateway = createModelGateway({ sessions, usage, maxConcurrent, maxConcurrentPerUser, requestsPerMinute: 100_000, timeoutMs: 180_000,
  models: [{ provider: "litellm", model: "GLM-5.3", upstreamModel: "volc-coding", upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, apiKey: "load-test-key", maxOutputTokens: 32768 }] });
const startedAt = Date.now();
await startMetricsListener({ port: metricsPort, collect: (loop) => collectMetrics({ startedAt, sessions, gateway, loop }) });
gateway.listen(0, "127.0.0.1", 4096, () => process.stdout.write(`${JSON.stringify({ port: gateway.address().port })}\n`));
