import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { normalizeResponse, responseNormalizeTransform } from "../src/control-plane/response-normalize.js";

const MODEL = "GLM-5.3";
const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
// Splits at byte offsets, so a multi-byte character can land across two chunks.
const split = (bytes, size) => {
  if (!size) return [bytes];
  const pieces = [];
  for (let at = 0; at < bytes.length; at += size) pieces.push(bytes.subarray(at, at + size));
  return pieces;
};
async function run(input, { chunk = 0, streaming = true, maxBytes } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const out = [];
  for await (const part of Readable.from(split(bytes, chunk)).pipe(responseNormalizeTransform({ model: MODEL, streaming, ...(maxBytes ? { maxBytes } : {}) }))) out.push(part);
  return Buffer.concat(out);
}
const events = text => text.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data:")).slice(5)));
// Deterministic "random" chunk boundaries, so a failure is reproducible.
function jagged(bytes, seed) {
  const pieces = []; let at = 0, state = seed;
  while (at < bytes.length) { state = (state * 1103515245 + 12345) % 2147483648; const size = 1 + state % 23; pieces.push(bytes.subarray(at, at + size)); at += size; }
  return pieces;
}

// What LiteLLM sends for a GLM turn: its own model group name, and output items
// opened without the fields Codex needs to accept them.
const UPSTREAM = [
  { type: "response.created", sequence_number: 0, response: { id: "resp_1", model: "volc-coding", status: "in_progress", output: [] } },
  { type: "response.in_progress", sequence_number: 1, response: { id: "resp_1", model: "volc-coding", status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "想一想" },
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress" } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "你好，世界 👋" },
  { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "你好，世界 👋" }] } },
  { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: "{\"cmd\":\"ls\"}" },
  { type: "response.completed", sequence_number: 9, response: { id: "resp_1", model: "volc-coding", status: "completed", output: [] } },
];

test("the upstream model name becomes the client's slug and opened items get their required fields", () => {
  const created = structuredClone(UPSTREAM[0]);
  assert.equal(normalizeResponse(created, MODEL), true);
  assert.equal(created.response.model, MODEL);
  const body = { id: "resp_1", object: "response", model: "volc-coding", output: [] };
  assert.equal(normalizeResponse(body, MODEL), true);
  assert.equal(body.model, MODEL);

  for (const [item, field, value] of [[{ type: "message", role: "assistant" }, "content", []], [{ type: "reasoning" }, "summary", []],
    [{ type: "function_call", call_id: "c", name: "n" }, "arguments", ""], [{ type: "message", content: null }, "content", []]]) {
    const event = { type: "response.output_item.added", output_index: 0, item: { ...item } };
    assert.equal(normalizeResponse(event, MODEL), true, item.type);
    assert.deepEqual(event.item[field], value);
  }
  // Two items never share one default list.
  const first = { type: "response.output_item.added", item: { type: "message" } }, second = structuredClone(first);
  normalizeResponse(first, MODEL); normalizeResponse(second, MODEL);
  assert.notEqual(first.item.content, second.item.content);

  // Nothing the model actually said is touched, and nothing else is defaulted.
  for (const unchanged of [
    { type: "response.output_item.added", item: { type: "message", content: [{ type: "output_text", text: "x" }] } },
    { type: "response.output_item.added", item: { type: "function_call", arguments: "{\"a\":1}" } },
    { type: "response.output_item.done", item: { type: "message" } },
    { type: "response.output_item.added", item: { type: "web_search_call" } },
    { type: "response.created", response: { model: MODEL } },
    { type: "response.created", response: { model: null } },
    { model: 42 }, [], null, "text",
  ]) {
    const before = JSON.stringify(unchanged);
    assert.equal(normalizeResponse(unchanged, MODEL), false, before);
    assert.equal(JSON.stringify(unchanged), before);
  }
});

test("a stream is rewritten the same way whatever its chunk boundaries", async () => {
  const input = Buffer.from(UPSTREAM.map(frame).join(""));
  const whole = await run(input);
  const out = events(whole.toString());
  assert.equal(out.length, UPSTREAM.length, "no frame merged, split, dropped or invented");
  assert.deepEqual(out.map(event => event.type), UPSTREAM.map(event => event.type));
  assert.ok(out.filter(event => event.response).every(event => event.response.model === MODEL));
  assert.deepEqual(out[2].item, { type: "reasoning", id: "rs_1", summary: [] });
  assert.deepEqual(out[4].item.content, []);
  assert.equal(out[7].item.arguments, "");
  assert.doesNotMatch(whole.toString(), /volc-coding/);
  // Byte-level splits land inside "\n\n", inside "👋" and inside JSON strings.
  for (const chunk of [1, 2, 3, 5, 7, 64, 1000]) assert.deepEqual(await run(input, { chunk }), whole, `chunk ${chunk}`);
  for (const seed of [1, 7, 42, 2026]) {
    const out = [];
    for await (const part of Readable.from(jagged(input, seed)).pipe(responseNormalizeTransform({ model: MODEL, streaming: true }))) out.push(part);
    assert.deepEqual(Buffer.concat(out), whole, `seed ${seed}`);
  }
});

test("a frame that needs nothing passes through byte for byte", async () => {
  const untouched = [
    frame(UPSTREAM[3]), frame(UPSTREAM[5]), frame(UPSTREAM[6]),
    // CRLF framing, a comment, an id line, keys in an unusual order and spacing.
    "event: response.output_text.delta\r\nid: 7\r\ndata:  {\"delta\":\"x\", \"type\":\"response.output_text.delta\"}\r\n\r\n",
    ": keep-alive\n\n",
    "data: [DONE]\n\n",
    // Not JSON: left for the client to judge rather than repaired or dropped.
    "data: {not json\n\n",
    // A data line spread over two lines is one event, and needs nothing.
    "data: {\"type\":\"response.output_text.delta\",\ndata: \"delta\":\"y\"}\n\n",
  ];
  const input = Buffer.from(untouched.join(""));
  for (const chunk of [0, 1, 2, 3, 9]) assert.deepEqual(await run(input, { chunk }), input, `chunk ${chunk}`);
  // Bytes that are not valid UTF-8 are not "corrected" on their way through.
  const raw = Buffer.concat([Buffer.from("data: {\"type\":\"x\",\"v\":\""), Buffer.from([0xff, 0xfe]), Buffer.from("\"}\n\n")]);
  for (const chunk of [0, 1, 4]) assert.deepEqual(await run(raw, { chunk }), raw);

  // Changed and unchanged frames interleave; the unchanged ones keep their bytes.
  const mixed = [frame(UPSTREAM[0]), untouched[3], frame(UPSTREAM[4]), untouched[4]].join("");
  const out = (await run(Buffer.from(mixed), { chunk: 3 })).toString();
  assert.ok(out.includes(untouched[3]) && out.includes(untouched[4]));
  assert.equal(out.indexOf(untouched[3]) < out.indexOf("msg_1"), true, "order is kept");
  assert.doesNotMatch(out, /volc-coding/);
});

test("an unterminated tail is returned as it was, and an oversized frame fails the stream", async () => {
  const tail = "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"model\":\"volc-coding\"}}";
  const out = await run(Buffer.from(frame(UPSTREAM[0]) + tail), { chunk: 5 });
  assert.ok(out.toString().endsWith(tail), "completing a cut-off event here would make it look whole");
  await assert.rejects(run(Buffer.from(`data: ${"x".repeat(200)}`), { maxBytes: 100 }), /too large/);
  await assert.rejects(run(Buffer.from(`data: {"model":"${"x".repeat(200)}"}\n\n`), { maxBytes: 100, chunk: 7 }), /too large/);
});

test("a JSON body is buffered within a bound and rewritten only when it has to be", async () => {
  const body = { id: "resp_1", object: "response", model: "volc-coding", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "好的 ✓" }] }] };
  const text = JSON.stringify(body);
  for (const chunk of [0, 1, 3, 17]) {
    const out = JSON.parse((await run(Buffer.from(text), { streaming: false, chunk })).toString());
    assert.deepEqual(out, { ...body, model: MODEL }, `chunk ${chunk}`);
  }
  // Already the client's model, odd spacing and all: the same bytes come back.
  const same = Buffer.from(`{ "model" : "${MODEL}",\n  "output": [] }`);
  assert.deepEqual(await run(same, { streaming: false, chunk: 2 }), same);
  // Not JSON, or not an object: passed on for the client to reject.
  for (const other of ["not json", "[1,2]", "\"text\"", ""]) assert.equal((await run(Buffer.from(other), { streaming: false })).toString(), other);
  await assert.rejects(run(Buffer.from(JSON.stringify({ model: "volc-coding", pad: "x".repeat(500) })), { streaming: false, maxBytes: 100, chunk: 50 }), /too large/);
  assert.throws(() => responseNormalizeTransform({ model: "", streaming: true }), /model/);
});
