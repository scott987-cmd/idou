// Local protocol fixture, not a model generation or paid provider response.
// `totalTokens` is the usage the response reports, for a check of what the
// client does with it.
export function syntheticResponseStream(text, { totalTokens = 2 } = {}) {
  const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: "resp_fixture", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item], usage: { input_tokens: totalTokens - 1, output_tokens: 1, total_tokens: totalTokens } } },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

// The agent tool as the application told the Agent to run it, read from a
// request's developer instructions: a scripted model runs what a real one would
// be told to (task-runtime.js, providers/codex/tool-rules.js), not a form that
// no longer reaches the application from 标准's sandbox.
export function agentCommand(body) {
  const said = /run `([^`\s]+) --help`/.exec(JSON.stringify(body).replaceAll("\\\\", "\\").replaceAll('\\"', '"'));
  if (!said) throw new Error("the request does not say how to run the agent tool");
  return said[1];
}
