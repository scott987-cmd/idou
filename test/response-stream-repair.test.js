import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { functionCallRepairTransform } from "../src/control-plane/response-stream-repair.js";

const frame = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
async function run(text, chunk = 0) {
  const pieces = chunk ? text.match(new RegExp(`[\\s\\S]{1,${chunk}}`, "g")) : [text];
  const out = [];
  for await (const part of Readable.from(pieces.map(piece => Buffer.from(piece))).pipe(functionCallRepairTransform())) out.push(part.toString());
  return out.join("");
}
const events = text => text.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data:")).slice(5)));

// The order recorded live from MiniMax-M3 (2026-09-11): each call is closed
// with empty arguments first, then its arguments arrive as deltas, and the
// completed response holds the full calls.
const FC0 = '{"cmd":"lark-cli skills list","justification":"List skills."}';
const FC1 = '{"cmd":"node agent.js task-delete --task-id 61ef00b1-063b-4cf0-8cb5-e81f4bf73624"}';
const call = (index, args) => ({ type: "function_call", id: `r_fc_${index}`, call_id: `call_${index}`, name: "exec_command", arguments: args, status: "completed" });
const OUT_OF_ORDER = [
  { type: "response.created", response: { id: "r", status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "r_rs", summary: [] } },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "r_rs", summary: [] } },
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "r_msg", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "r_msg", output_index: 1, delta: "我先列出技能。" },
  { type: "response.output_item.done", output_index: 1, item: { type: "message", id: "r_msg", role: "assistant", content: [{ type: "output_text", text: "我先列出技能。" }] } },
  { type: "response.output_item.added", output_index: 2, item: call(0, "") },
  { type: "response.function_call_arguments.done", item_id: "r_fc_0", output_index: 2, arguments: "" },
  { type: "response.output_item.done", output_index: 2, item: call(0, "") },
  { type: "response.function_call_arguments.delta", item_id: "r_fc_0", output_index: 2, delta: FC0.slice(0, 30) },
  { type: "response.function_call_arguments.delta", item_id: "r_fc_0", output_index: 2, delta: FC0.slice(30) },
  { type: "response.output_item.added", output_index: 3, item: call(1, "") },
  { type: "response.function_call_arguments.done", item_id: "r_fc_1", output_index: 3, arguments: "" },
  { type: "response.output_item.done", output_index: 3, item: call(1, "") },
  { type: "response.function_call_arguments.delta", item_id: "r_fc_1", output_index: 3, delta: FC1 },
  { type: "response.completed", response: { id: "r", status: "completed", output: [call(0, FC0), call(1, FC1)] } },
];

test("a call closed before its arguments is released with them, after its deltas, in a valid order", async () => {
  for (const chunk of [0, 1, 7, 64]) {
    const out = events(await run(OUT_OF_ORDER.map(frame).join(""), chunk));
    // Every closing event now carries the model's own arguments.
    const closed = out.filter(event => event.type === "response.output_item.done" && event.item.type === "function_call");
    assert.deepEqual(closed.map(event => event.item.arguments), [FC0, FC1], `chunk ${chunk}`);
    assert.deepEqual(out.filter(event => event.type === "response.function_call_arguments.done").map(event => event.arguments), [FC0, FC1]);
    // And comes after that call's deltas, before the next item starts.
    const order = out.map(event => `${event.type}:${event.item_id ?? event.item?.id ?? ""}`);
    const at = name => order.indexOf(name);
    assert.ok(at("response.function_call_arguments.delta:r_fc_0") < at("response.output_item.done:r_fc_0"));
    assert.ok(at("response.output_item.done:r_fc_0") < at("response.output_item.added:r_fc_1"));
    assert.ok(at("response.function_call_arguments.delta:r_fc_1") < at("response.output_item.done:r_fc_1"));
    assert.ok(at("response.output_item.done:r_fc_1") < at("response.completed:"));
    // Nothing else is lost, added or reordered.
    assert.equal(out.length, OUT_OF_ORDER.length);
    assert.deepEqual(out.filter(event => !/function_call|output_item\.done/.test(event.type) || event.item?.type !== "function_call" && !event.type.includes("function_call")).map(event => event.type),
      OUT_OF_ORDER.filter(event => !/function_call|output_item\.done/.test(event.type) || event.item?.type !== "function_call" && !event.type.includes("function_call")).map(event => event.type));
  }
});

test("a stream already in the documented order passes through byte for byte", async () => {
  const inOrder = [
    OUT_OF_ORDER[0],
    { type: "response.output_item.added", output_index: 0, item: call(0, "") },
    { type: "response.function_call_arguments.delta", item_id: "r_fc_0", output_index: 0, delta: FC0 },
    { type: "response.function_call_arguments.done", item_id: "r_fc_0", output_index: 0, arguments: FC0 },
    { type: "response.output_item.done", output_index: 0, item: call(0, FC0) },
    { type: "response.completed", response: { id: "r", status: "completed", output: [call(0, FC0)] } },
  ].map(frame).join("");
  for (const chunk of [0, 3, 50]) assert.equal(await run(inOrder, chunk), inOrder);
  const text = [OUT_OF_ORDER[0], OUT_OF_ORDER[3], OUT_OF_ORDER[4], OUT_OF_ORDER[5], { type: "response.completed", response: { id: "r", output: [] } }].map(frame).join("") + "data: [DONE]\n\n";
  assert.equal(await run(text, 5), text, "text and [DONE] are untouched");
});

test("with no deltas the arguments come from the completed response; with none anywhere nothing is invented", async () => {
  const fromCompleted = [OUT_OF_ORDER[6], OUT_OF_ORDER[7], OUT_OF_ORDER[8], { type: "response.completed", response: { output: [call(0, FC0)] } }].map(frame).join("");
  const out = events(await run(fromCompleted));
  assert.equal(out.find(event => event.type === "response.output_item.done").item.arguments, FC0);
  const nothing = [OUT_OF_ORDER[6], OUT_OF_ORDER[7], OUT_OF_ORDER[8], { type: "response.completed", response: { output: [call(0, "")] } }].map(frame).join("");
  assert.equal(events(await run(nothing)).find(event => event.type === "response.output_item.done").item.arguments, "");
  // A stream cut off before completing still releases what it held, with the deltas it had.
  const cut = [OUT_OF_ORDER[6], OUT_OF_ORDER[7], OUT_OF_ORDER[8], OUT_OF_ORDER[9], OUT_OF_ORDER[10]].map(frame).join("");
  const partial = events(await run(cut));
  assert.equal(partial.find(event => event.type === "response.output_item.done").item.arguments, FC0);
  assert.equal(partial.length, 5);
});

test("CRLF framing and an oversized frame are handled", async () => {
  const crlf = OUT_OF_ORDER.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const out = events((await run(crlf, 9)).replaceAll("\r", ""));
  assert.deepEqual(out.filter(event => event.type === "response.output_item.done" && event.item.type === "function_call").map(event => event.item.arguments), [FC0, FC1]);
  const transform = functionCallRepairTransform({ maxBytes: 1024 });
  await assert.rejects(async () => { for await (const _ of Readable.from([Buffer.from("x".repeat(4096))]).pipe(transform)) { /* drain */ } }, /too large/);
});
