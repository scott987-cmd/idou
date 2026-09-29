import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { once } from "node:events";
import { coalesceOutput, messageCoalesceTransform } from "../src/control-plane/message-coalesce.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
async function through(text, size = 11) {
  const chunks = []; for (let at = 0; at < text.length; at += size) chunks.push(Buffer.from(text.slice(at, at + size)));
  const out = []; const transform = messageCoalesceTransform();
  Readable.from(chunks).pipe(transform);
  for await (const chunk of transform) out.push(chunk.toString());
  return out.join("");
}
const events = (text) => text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5)));
// A message as the Responses stream carries it, at `index`, in `pieces`.
const message = (id, index, pieces, extra = {}) => {
  const item = { type: "message", id, role: "assistant", status: "in_progress", content: [], ...extra };
  const text = pieces.join("");
  return [{ type: "response.output_item.added", output_index: index, item },
    { type: "response.content_part.added", item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    ...pieces.map((delta) => ({ type: "response.output_text.delta", item_id: id, output_index: index, content_index: 0, delta })),
    { type: "response.output_text.done", item_id: id, output_index: index, content_index: 0, text },
    { type: "response.content_part.done", item_id: id, output_index: index, content_index: 0, part: { type: "output_text", text, annotations: [] } },
    { type: "response.output_item.done", output_index: index, item: { ...item, status: "completed", content: [{ type: "output_text", text, annotations: [] }] } }];
};
const call = (id, index) => [{ type: "response.output_item.added", output_index: index, item: { type: "function_call", id, call_id: `c_${id}`, name: "exec_command", arguments: "" } },
  { type: "response.output_item.done", output_index: index, item: { type: "function_call", id, call_id: `c_${id}`, name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } }];
const completed = (output) => ({ type: "response.completed", response: { id: "r", status: "completed", output } });
const finalItem = (event) => event.item;

test("an answer split into consecutive messages reaches the client as one", async () => {
  const parts = [message("m1", 0, ["{\"findings\": [", "1"]), message("m2", 1, [", 2]"]), message("m3", 2, [", \"ok\": true}"])];
  const stream = sse([...parts.flat(), ...call("f1", 3), completed([...parts.map((part) => finalItem(part.at(-1))), call("f1", 3).at(-1).item])]);
  const out = events(await through(stream));
  const added = out.filter((event) => event.type === "response.output_item.added");
  assert.deepEqual(added.map((event) => [event.item.id, event.output_index]), [["m1", 0], ["f1", 1]], "one message, and the call after it moves up");
  const deltas = out.filter((event) => event.type === "response.output_text.delta");
  assert.deepEqual(deltas.map((event) => [event.item_id, event.output_index, event.content_index]), Array(4).fill(["m1", 0, 0]));
  assert.equal(deltas.map((event) => event.delta).join(""), "{\"findings\": [1, 2], \"ok\": true}");
  const done = out.filter((event) => event.type === "response.output_item.done");
  assert.deepEqual(done.map((event) => [event.item.id, event.output_index]), [["m1", 0], ["f1", 1]]);
  assert.equal(done[0].item.content[0].text, "{\"findings\": [1, 2], \"ok\": true}", "the message closes with its whole text");
  assert.equal(out.find((event) => event.type === "response.output_text.done").text, "{\"findings\": [1, 2], \"ok\": true}");
  assert.equal(out.filter((event) => event.type === "response.output_text.done").length, 1);
  assert.equal(out.filter((event) => event.type === "response.content_part.added").length, 1);
  const summary = out.find((event) => event.type === "response.completed").response.output;
  assert.deepEqual(summary.map((item) => [item.type, item.id]), [["message", "m1"], ["function_call", "f1"]]);
  assert.equal(summary[0].content[0].text, "{\"findings\": [1, 2], \"ok\": true}");
});

test("a keep-alive or a progress event between the pieces does not keep them apart", async () => {
  const [first, second] = [message("m1", 0, ["前半"]), message("m2", 1, ["后半"])];
  const stream = `${sse(first)}: keep-alive\n\n${sse([{ type: "response.in_progress", response: { id: "r", status: "in_progress" } }, ...second, completed([])])}data: [DONE]\n\n`;
  const out = await through(stream);
  const parsed = out.split("\n\n").filter((frame) => frame.includes("data: {")).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5)));
  assert.deepEqual(parsed.filter((event) => event.type === "response.output_item.done").map((event) => [event.item.id, event.item.content[0].text]), [["m1", "前半后半"]]);
  assert.ok(out.includes(": keep-alive\n\n") && out.endsWith("data: [DONE]\n\n"), "and passes on as it was");
});

// The gap is the one measured on 2026-09-21: after two tool results MiniMax-M3
// sent its answer as 10 pieces, 0.56-1.24 s apart. With the old 300 ms window
// every piece went out as an answer of its own, and the application showed the
// last one.
test("pieces a second apart, as MiniMax sends them after a tool call, are still one answer", async () => {
  const transform = messageCoalesceTransform(), seen = [];
  transform.on("data", (chunk) => seen.push(...events(chunk.toString())));
  transform.write(sse(message("m1", 0, ["唐雨桐这趟最多可报 "])));
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.ok(!seen.some((event) => event.type === "response.output_item.done"), "the close waits for what comes next");
  assert.equal(seen.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""), "唐雨桐这趟最多可报 ",
    "while the text itself has already gone out");
  transform.end(sse([...message("m2", 1, ["1,750 元。"]), ...call("f1", 2), completed([])]));
  await once(transform, "end");
  const done = seen.filter((event) => event.type === "response.output_item.done");
  assert.deepEqual(done.map((event) => [event.item.id, event.item.content?.[0]?.text ?? event.item.type]), [["m1", "唐雨桐这趟最多可报 1,750 元。"], ["f1", "function_call"]]);
});

test("a stream that goes silent altogether still gets its close", async () => {
  const transform = messageCoalesceTransform({ holdMs: 30 }), seen = [];
  transform.on("data", (chunk) => seen.push(...events(chunk.toString())));
  transform.write(sse(message("m1", 0, ["先看看。"])));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(seen.at(-1)?.type, "response.output_item.done", "released once the stream went quiet");
  transform.end(sse([...message("m2", 1, ["看完了。"]), completed([])]));
  await once(transform, "end");
  assert.deepEqual(seen.filter((event) => event.type === "response.output_item.done").map((event) => event.item.id), ["m1", "m2"], "and what comes after that is its own");
});

test("messages apart, or of different kinds, stay as they are -- byte for byte", async () => {
  const apart = sse([...message("m1", 0, ["先看看。"]), ...call("f1", 1), ...message("m2", 2, ["看完了。"]), completed([])]);
  assert.equal(await through(apart, 7), apart);
  const kinds = sse([...message("m1", 0, ["说明"], { phase: "commentary" }), ...message("m2", 1, ["答案"], { phase: "final_answer" }), completed([])]);
  assert.equal(await through(kinds), kinds);
  const single = sse([...message("m1", 0, ["一", "段", "话"]), completed([finalItem(message("m1", 0, ["一段话"]).at(-1))])]);
  assert.equal(await through(single, 5), single);
});

test("a completed response lists runs of messages as one", () => {
  const item = (id, text, phase) => ({ type: "message", id, role: "assistant", ...(phase ? { phase } : {}), content: [{ type: "output_text", text, annotations: [] }] });
  assert.deepEqual(coalesceOutput([item("a", "x"), item("b", "y"), { type: "function_call", id: "f" }, item("c", "z"), item("d", "w", "final_answer")]).map((row) => [row.id, row.content?.[0]?.text]),
    [["a", "xy"], ["f", undefined], ["c", "z"], ["d", "w"]]);
});

test("through the gateway: Codex is sent the answer whole", async (t) => {
  const sessions = new SessionRegistry();
  const session = sessions.issue({ tenantId: "t1", userId: "u1", deviceId: "d1" });
  const split = sse([...message("m1", 0, ["Review comment:\n"]), ...message("m2", 1, ["- [P1] greet drops the name"]), completed([])]);
  const server = createModelGateway({ apiKey: "k", sessions, fetchImpl: async () => new Response(split, { headers: { "content-type": "text/event-stream" } }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const answer = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ model: "MiniMax-M3", input: "审查", stream: true }) }).then((response) => response.text());
  const done = events(answer).filter((event) => event.type === "response.output_item.done");
  assert.deepEqual(done.map((event) => [event.item.id, event.item.content[0].text]), [["m1", "Review comment:\n- [P1] greet drops the name"]]);
});
