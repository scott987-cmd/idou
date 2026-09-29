// A stand-in model upstream for the load test: answers /v1/responses the way
// the LiteLLM route does, streaming an answer over `durationMs` in `chunks`
// frames and ending with token usage, so the gateway records usage as it would
// for a real answer. Runs in its own process so its work is not the gateway's.
import { createServer } from "node:http";

const { durationMs = 3000, chunks = 30 } = JSON.parse(process.argv[2] ?? "{}");
const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* drain the request */ }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(frame({ type: "response.created", response: { id: "r", model: "volc-coding", status: "in_progress", output: [] } }));
  res.write(frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant" } }));
  let sent = 0;
  const timer = setInterval(() => {
    if (res.destroyed) { clearInterval(timer); return; }
    res.write(frame({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "这是一段用来压测的模型输出。" }));
    if (++sent < chunks) return;
    clearInterval(timer);
    res.end(frame({ type: "response.completed", response: { id: "r", model: "volc-coding", status: "completed", output: [],
      usage: { input_tokens: 1200, output_tokens: 300, total_tokens: 1500 } } }));
  }, durationMs / chunks);
});
server.keepAliveTimeout = 60_000;
server.listen(0, "127.0.0.1", () => process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`));
