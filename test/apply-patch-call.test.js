import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { once } from "node:events";
import { applyPatchCallTransform, patchCallRewriteApplies, patchCommand } from "../src/control-plane/apply-patch-call.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";

// What MiniMax-M3 sent on 2026-09-19, fixing a one-line bug: a call named
// apply_patch, the patch as a heredoc command, no "*** Begin Patch" line.
const MEASURED = JSON.stringify({ cmd: "apply_patch <<'EOF'\n*** Update File: src/sum.js\n@@ export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch\nEOF", workdir: "/tmp/repo" });
const PATCH = "*** Begin Patch\n*** Update File: src/sum.js\n@@ export function sum(a, b) {\n-  return a - b;\n+  return a + b;\n }\n*** End Patch";

test("the patch the model framed is given back as the one command Codex takes", () => {
  assert.deepEqual(JSON.parse(patchCommand(MEASURED)), { cmd: `apply_patch <<'EOF'\n${PATCH}\nEOF`, workdir: "/tmp/repo" }, "its envelope completed, its directory kept");
  assert.equal(JSON.parse(patchCommand(JSON.stringify({ input: PATCH }))).cmd, `apply_patch <<'EOF'\n${PATCH}\nEOF`, "the patch itself, under input");
  assert.equal(JSON.parse(patchCommand(JSON.stringify({ patch: "*** Add File: a.js\n+x" }))).cmd, "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.js\n+x\n*** End Patch\nEOF");
  assert.equal(patchCommand(JSON.stringify({ cmd: "npm test" })), null, "not a patch: left alone");
  assert.equal(patchCommand("{not json"), null);
});

test("only a request that offers exec_command and no apply_patch of its own", () => {
  assert.equal(patchCallRewriteApplies([{ type: "function", name: "exec_command" }, { type: "function", name: "write_stdin" }]), true);
  assert.equal(patchCallRewriteApplies([{ type: "function", name: "exec_command" }, { type: "function", name: "apply_patch" }]), false);
  assert.equal(patchCallRewriteApplies([{ type: "function", name: "shell" }]), false);
  assert.equal(patchCallRewriteApplies([{ type: "namespace", name: "tools", tools: [{ name: "exec_command" }] }]), true);
  assert.equal(patchCallRewriteApplies(undefined), false);
});

const sse = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
async function through(text, size = 7) {
  const chunks = []; for (let at = 0; at < text.length; at += size) chunks.push(Buffer.from(text.slice(at, at + size)));
  const out = []; const transform = applyPatchCallTransform();
  Readable.from(chunks).pipe(transform);
  for await (const chunk of transform) out.push(chunk.toString());
  return out.join("");
}
const events = (text) => text.split("\n\n").filter(Boolean).map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data:")).slice(5)));

test("a call named apply_patch reaches Codex as exec_command, whole, under the same call id", async () => {
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "" };
  const stream = sse([
    { type: "response.created", response: { id: "r", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: MEASURED.slice(0, 20) },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: MEASURED.slice(20) },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: MEASURED },
    { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: MEASURED, status: "completed" } },
    { type: "response.completed", response: { id: "r", output: [{ ...item, arguments: MEASURED, status: "completed" }] } },
  ]);
  const out = events(await through(stream));
  assert.deepEqual(out.map((event) => event.type), ["response.created", "response.output_item.added", "response.function_call_arguments.done", "response.output_item.done", "response.completed"],
    "the pieces of the wrong call are held back and given whole");
  assert.equal(out[1].item.name, "exec_command");
  const expected = patchCommand(MEASURED);
  assert.equal(out[2].arguments, expected);
  assert.deepEqual([out[3].item.name, out[3].item.call_id, out[3].item.arguments], ["exec_command", "call_1", expected]);
  assert.deepEqual([out[4].response.output[0].name, out[4].response.output[0].arguments], ["exec_command", expected]);
});

test("a stream without such a call passes through byte for byte", async () => {
  const item = { type: "function_call", id: "fc_2", call_id: "call_2", name: "exec_command", arguments: "" };
  const args = JSON.stringify({ cmd: "npm test" });
  const stream = sse([
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 0, delta: args },
    { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args } },
    { type: "response.output_text.delta", item_id: "m", output_index: 1, delta: "好" },
  ]);
  assert.equal(await through(stream, 5), stream);
});

test("through the gateway: Codex is sent the call it can take", async (t) => {
  const sessions = new SessionRegistry();
  const session = sessions.issue({ tenantId: "t1", userId: "u1", deviceId: "d1" });
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "apply_patch", arguments: "" };
  const upstream = sse([
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: MEASURED },
    { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: MEASURED } },
    { type: "response.completed", response: { id: "r", status: "completed", output: [{ ...item, arguments: MEASURED }] } },
  ]);
  const server = createModelGateway({ apiKey: "k", sessions, fetchImpl: async () => new Response(upstream, { headers: { "content-type": "text/event-stream" } }) });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const ask = (tools) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ model: "MiniMax-M3", input: "修 bug", stream: true, tools }) }).then((response) => response.text());
  const rewritten = events(await ask([{ type: "function", name: "exec_command", parameters: { type: "object" } }]));
  assert.equal(rewritten.find((event) => event.type === "response.output_item.done").item.name, "exec_command");
  const kept = events(await ask([{ type: "function", name: "exec_command", parameters: { type: "object" } }, { type: "function", name: "apply_patch", parameters: { type: "object" } }]));
  assert.equal(kept.find((event) => event.type === "response.output_item.done").item.name, "apply_patch", "a request that offers apply_patch gets it as called");
});
