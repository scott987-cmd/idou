import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";

async function setup(t, options = {}) {
  const sessions = new SessionRegistry();
  const session = sessions.issue({ tenantId: "t1", userId: "u1", deviceId: "d1" });
  const seen = [];
  const audits = [];
  const server = createModelGateway({ apiKey: "provider-secret-fixture", sessions,
    fetchImpl: async (url, request) => {
      seen.push({ url, ...request });
      return new Response(JSON.stringify({ output_text: "fixture reply" }), { headers: { "content-type": "application/json", "set-cookie": "upstream-secret" } });
    }, audit: (event) => audits.push(event), ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { model: "MiniMax-M3", input: "private-prompt-fixture" }, headers = {}) => fetch(`${url}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}`, ...headers }, body: JSON.stringify(body),
  });
  return { post, session, sessions, seen, audits, url };
}

test("gateway authenticates locally, forwards only server credentials and returns native output", async (t) => {
  const { post, seen, session, audits } = await setup(t);
  const response = await post({ model: "MiniMax-M3", input: "private-prompt-fixture", client_metadata: { local_path: "private-device-metadata" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).output_text, "fixture reply");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.minimaxi.com/v1/responses");
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[0].headers.authorization, "Bearer provider-secret-fixture");
  assert.equal(JSON.stringify(seen).includes(session.token), false);
  assert.equal(JSON.stringify(seen).includes("private-device-metadata"), false);
  const forwarded = JSON.parse(seen[0].body);
  // upstreamModel defaults to the client slug: MiniMax is asked for MiniMax-M3.
  assert.equal(forwarded.model, "MiniMax-M3");
  assert.equal(forwarded.store, false);
  assert.equal(forwarded.service_tier, "standard");
  assert.equal(forwarded.max_output_tokens, 16384);
  assert.equal(JSON.stringify(audits).includes("private-prompt-fixture"), false);
  assert.equal(JSON.stringify(audits).includes("provider-secret-fixture"), false);
});

test("invalid, expired, revoked and browser-origin sessions never call the provider", async (t) => {
  const { post, seen, session, sessions } = await setup(t);
  assert.equal((await post(undefined, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post(undefined, { origin: "https://attacker.example" })).status, 403);
  sessions.revoke(session.token);
  assert.equal((await post()).status, 401);
  assert.equal(seen.length, 0);
  let now = 1;
  const registry = new SessionRegistry({ now: () => now });
  const issued = registry.issue({ tenantId: "a", userId: "b", deviceId: "c", ttlMs: 10 });
  now = 11;
  assert.equal(registry.verify(issued.token), null);
});

test("policy rejects unsupported models, provider storage, premium tiers and caller routing", async (t) => {
  const { post, seen } = await setup(t);
  for (const [patch, status] of [[{ model: "other" }, 403], [{ store: true }, 400], [{ service_tier: "priority" }, 403],
    [{ base_url: "https://attacker.example" }, 400], [{ tools: [{ type: "web_search" }] }, 400], [{ max_output_tokens: 999999 }, 400]]) {
    assert.equal((await post({ model: "MiniMax-M3", input: "x", ...patch })).status, status);
  }
  assert.equal(seen.length, 0);
});

test("tenant cache keys differ and rate limits do not admit excess provider calls", async (t) => {
  const { post, sessions, seen } = await setup(t, { requestsPerMinute: 1 });
  const body = { model: "MiniMax-M3", input: "x", prompt_cache_key: "shared-input" };
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 429);
  const other = sessions.issue({ tenantId: "t2", userId: "u1", deviceId: "d1" });
  assert.equal((await post(body, { authorization: `Bearer ${other.token}` })).status, 200);
  assert.notEqual(JSON.parse(seen[0].body).prompt_cache_key, JSON.parse(seen[1].body).prompt_cache_key);
});

test("oversized input is rejected, provider errors do not disclose echoed secrets", async (t) => {
  const small = await setup(t, { maxBodyBytes: 100 });
  assert.equal((await small.post({ model: "MiniMax-M3", input: "x".repeat(1000) })).status, 413);
  assert.equal(small.seen.length, 0);
  const failed = await setup(t, { fetchImpl: async () => new Response("provider-secret-fixture private-prompt-fixture", { status: 401 }) });
  const response = await failed.post();
  assert.equal(response.status, 502);
  const error = await response.text();
  assert.match(error, /provider_request_failed/);
  assert.doesNotMatch(error, /fixture/);
});

test("SSE remains a live stream and disconnect cancels the upstream fetch", async (t) => {
  let signal;
  const fixture = "event: response.created\ndata: {\"type\":\"response.created\"}\n\n";
  const { post } = await setup(t, { fetchImpl: async (_, request) => {
    signal = request.signal;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(fixture));
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const response = await post({ model: "MiniMax-M3", input: "x", stream: true });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), fixture);
  const cancelled = once(signal, "abort");
  await reader.cancel();
  await cancelled;
  assert.equal(signal.aborted, true);
});

// Recorded live (2026-09-11): MiniMax closed a tool call with empty arguments
// and sent them afterwards, so Codex received every call empty. The gateway
// releases the closing events with the arguments filled in.
test("a tool call the provider closes before its arguments reaches the client complete", async (t) => {
  const args = '{"cmd":"lark-cli skills list"}';
  const call = value => ({ type: "function_call", id: "fc_0", call_id: "call_0", name: "exec_command", arguments: value });
  const upstream = [
    { type: "response.output_item.added", output_index: 0, item: call("") },
    { type: "response.function_call_arguments.done", item_id: "fc_0", output_index: 0, arguments: "" },
    { type: "response.output_item.done", output_index: 0, item: call("") },
    { type: "response.function_call_arguments.delta", item_id: "fc_0", output_index: 0, delta: args },
    { type: "response.completed", response: { status: "completed", output: [call(args)] } },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const { post } = await setup(t, { fetchImpl: async () => new Response(upstream, { headers: { "content-type": "text/event-stream" } }) });
  const response = await post({ model: "MiniMax-M3", input: "x", stream: true });
  const received = (await response.text()).split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data:")).slice(5)));
  assert.equal(received.find(event => event.type === "response.output_item.done").item.arguments, args);
  assert.deepEqual(received.map(event => event.type), ["response.output_item.added", "response.function_call_arguments.delta",
    "response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
});

test("timeout cancels the provider and fails instead of completing an empty answer", async (t) => {
  const { post } = await setup(t, { timeoutMs: 40, fetchImpl: async (_, request) => {
    await once(request.signal, "abort");
    throw request.signal.reason;
  } });
  const response = await post();
  assert.equal(response.status, 504);
});

test("an unapproved upstream is rejected before any credential can be sent", () => {
  assert.throws(() => createModelGateway({ apiKey: "fixture", sessions: new SessionRegistry(), upstreamOrigin: "https://attacker.example" }), /approved/);
});

test("HTTP gateway flattens MCP namespaces for the provider and restores JSON tool routing", async (t) => {
  let forwarded;
  const { post } = await setup(t, { fetchImpl: async (_url, request) => {
    forwarded = JSON.parse(request.body);
    return Response.json({ output: [{ type: "function_call", call_id: "call", name: forwarded.tools[0].name, arguments: '{"text":"synthetic"}' }] });
  } });
  const tools = [{ type: "namespace", name: "mcp__demo", tools: [{ type: "function", name: "echo", parameters: { type: "object" } }] }];
  const response = await post({ model: "MiniMax-M3", input: "synthetic", tools }); assert.equal(response.status, 200);
  assert.equal(forwarded.tools[0].type, "function"); assert.match(forwarded.tools[0].name, /^idou_mcp_/);
  const result = await response.json(); assert.equal(result.output[0].namespace, "mcp__demo"); assert.equal(result.output[0].name, "echo");
  assert.equal((await post({ model: "MiniMax-M3", input: "synthetic", tools: [{ ...tools[0], tools: [{ type: "web_search" }] }] })).status, 400);
});

// Codex's own subagent tools cross the gateway under their own names -- no MCP
// alias, no MCP origin line -- and a call in the answer goes back into their
// namespace. Only that namespace name and its known tools are admitted.
test("HTTP gateway passes Codex's collaboration tools under their own names and restores their namespace", async (t) => {
  let forwarded;
  const { post } = await setup(t, { fetchImpl: async (_url, request) => {
    forwarded = JSON.parse(request.body);
    return Response.json({ output: [{ type: "function_call", call_id: "call", name: "spawn_agent", arguments: '{"task_name":"child","message":"synthetic"}' }] });
  } });
  const tools = [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent", description: "Spawns an agent.", parameters: { type: "object" } }, { type: "function", name: "wait_agent", parameters: { type: "object" } }] }];
  const response = await post({ model: "MiniMax-M3", input: "synthetic", tools }); assert.equal(response.status, 200);
  assert.deepEqual(forwarded.tools.map((tool) => [tool.type, tool.name, tool.description]), [["function", "spawn_agent", "Spawns an agent."], ["function", "wait_agent", undefined]]);
  const result = await response.json(); assert.equal(result.output[0].namespace, "collaboration"); assert.equal(result.output[0].name, "spawn_agent");
  assert.equal((await post({ model: "MiniMax-M3", input: "synthetic", tools: [{ ...tools[0], tools: [{ type: "function", name: "run_anything" }] }] })).status, 400);
  assert.equal((await post({ model: "MiniMax-M3", input: "synthetic", tools: [{ ...tools[0], name: "agents" }] })).status, 400);
});

test("disconnect also cancels an upstream stream routed through the MCP namespace transformer", async (t) => {
  let signal;
  const { post } = await setup(t, { fetchImpl: async (_url, request) => {
    signal = request.signal;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('event: response.created\ndata: {"type":"response.created"}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const response = await post({ model: "MiniMax-M3", input: "synthetic", stream: true, tools: [{ type: "namespace", name: "mcp__demo", tools: [{ type: "function", name: "echo" }] }] });
  const reader = response.body.getReader(); assert.match(new TextDecoder().decode((await reader.read()).value), /response.created/);
  const cancelled = once(signal, "abort"); await reader.cancel(); await cancelled; assert.equal(signal.aborted, true);
});

// --- LiteLLM on this machine's loopback (GLM-5.3) ------------------------------

const GLM = { provider: "litellm", model: "GLM-5.3", upstreamModel: "volc-coding", upstreamOrigin: "http://127.0.0.1:4000", maxOutputTokens: 32768 };
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const parseSse = text => text.split("\n\n").filter(Boolean).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data:")).slice(5)));

test("the LiteLLM route asks the proxy for its model group and leaves out MiniMax's tier", async (t) => {
  const { post, seen, session } = await setup(t, GLM);
  const response = await post({ model: "GLM-5.3", input: "private-prompt-fixture", service_tier: "standard", prompt_cache_key: "shared", client_metadata: { local_path: "private-device-metadata" } });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://127.0.0.1:4000/v1/responses");
  assert.equal(seen[0].redirect, "error");
  assert.equal(seen[0].headers.authorization, "Bearer provider-secret-fixture");
  const forwarded = JSON.parse(seen[0].body);
  assert.equal(forwarded.model, "volc-coding");
  assert.equal("service_tier" in forwarded, false);
  assert.equal(forwarded.store, false);
  assert.equal(forwarded.max_output_tokens, 32768);
  assert.match(forwarded.prompt_cache_key, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(seen).includes("private-device-metadata"), false);
  assert.equal(JSON.stringify(seen).includes(session.token), false);
});

test("the LiteLLM route still enforces the client-facing model, tier and output limits", async (t) => {
  const { post, seen } = await setup(t, GLM);
  // The proxy's own group name is not a model a client may ask for.
  for (const [patch, status] of [[{ model: "volc-coding" }, 403], [{ model: "MiniMax-M3" }, 403], [{ service_tier: "priority" }, 403],
    [{ store: true }, 400], [{ max_output_tokens: 32769 }, 400], [{ tools: [{ type: "web_search" }] }, 400]]) {
    assert.equal((await post({ model: "GLM-5.3", input: "x", ...patch })).status, status, JSON.stringify(patch));
  }
  assert.equal(seen.length, 0);
});

test("a JSON answer names the client's model, and one that already does comes back byte for byte", async (t) => {
  const answer = { id: "resp_1", object: "response", model: "volc-coding", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "好" }] }] };
  const rewritten = await setup(t, { ...GLM, fetchImpl: async () => Response.json(answer) });
  const response = await rewritten.post({ model: "GLM-5.3", input: "x" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...answer, model: "GLM-5.3" });

  const exact = `{ "model": "GLM-5.3",  "output": [] }`;
  const same = await setup(t, { ...GLM, fetchImpl: async () => new Response(exact, { headers: { "content-type": "application/json" } }) });
  assert.equal(await (await same.post({ model: "GLM-5.3", input: "x" })).text(), exact);
});

test("an SSE answer is normalised frame by frame over a real loopback upstream", async (t) => {
  const events = [
    { type: "response.created", response: { id: "r", model: "volc-coding", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs" } },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "m", role: "assistant" } },
    { type: "response.output_text.delta", item_id: "m", output_index: 1, content_index: 0, delta: "你好" },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc", call_id: "c", name: "exec_command" } },
    { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 2, delta: "{\"cmd\":\"ls\"}" },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc", call_id: "c", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" } },
    { type: "response.completed", response: { id: "r", model: "volc-coding", status: "completed", output: [] } },
  ];
  const received = [];
  const upstream = (await import("node:http")).createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Dribbled out in odd-sized pieces, the way a proxy may flush.
    const bytes = Buffer.from(sse(events));
    for (let at = 0; at < bytes.length; at += 13) res.write(bytes.subarray(at, at + 13));
    res.end();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.close(); upstream.closeAllConnections(); });
  const { post } = await setup(t, { ...GLM, upstreamOrigin: `http://127.0.0.1:${upstream.address().port}`, fetchImpl: fetch });
  const response = await post({ model: "GLM-5.3", input: "x", stream: true });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(received.length, 1);
  assert.equal(received[0].url, "/v1/responses");
  assert.equal(received[0].authorization, "Bearer provider-secret-fixture");
  assert.equal(received[0].body.model, "volc-coding");
  assert.equal("service_tier" in received[0].body, false);

  const out = parseSse(text);
  assert.deepEqual(out.map(event => event.type), events.map(event => event.type));
  assert.doesNotMatch(text, /volc-coding/);
  assert.equal(out[0].response.model, "GLM-5.3");
  assert.equal(out.at(-1).response.model, "GLM-5.3");
  assert.deepEqual(out[1].item.summary, []);
  assert.deepEqual(out[2].item.content, []);
  assert.equal(out[4].item.arguments, "");
  // Frames that needed nothing are exactly the upstream's bytes.
  for (const index of [3, 5, 6]) assert.ok(text.includes(sse([events[index]])), events[index].type);
});

test("the LiteLLM stream goes through repair, then normalisation, then MCP name restoration", async (t) => {
  let alias;
  const { post } = await setup(t, { ...GLM, fetchImpl: async (_url, request) => {
    alias = JSON.parse(request.body).tools[0].name;
    const call = args => ({ type: "function_call", id: "fc", call_id: "c", name: alias, ...(args === undefined ? {} : { arguments: args }) });
    return new Response(sse([
      { type: "response.created", response: { model: "volc-coding", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: call(undefined) },
      { type: "response.function_call_arguments.done", item_id: "fc", output_index: 0, arguments: "" },
      { type: "response.output_item.done", output_index: 0, item: call("") },
      { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 0, delta: "{\"text\":\"hi\"}" },
      { type: "response.completed", response: { model: "volc-coding", output: [call("{\"text\":\"hi\"}")] } },
    ]), { headers: { "content-type": "text/event-stream" } });
  } });
  const tools = [{ type: "namespace", name: "mcp__demo", tools: [{ type: "function", name: "echo", parameters: { type: "object" } }] }];
  const response = await post({ model: "GLM-5.3", input: "x", stream: true, tools });
  assert.equal(response.status, 200);
  const out = parseSse(await response.text());
  const added = out.find(event => event.type === "response.output_item.added");
  assert.equal(added.item.arguments, "", "defaulted, so Codex keeps the call open for its deltas");
  assert.equal(added.item.namespace, "mcp__demo"); assert.equal(added.item.name, "echo");
  const done = out.find(event => event.type === "response.output_item.done");
  assert.equal(done.item.arguments, "{\"text\":\"hi\"}", "the repair still fills the late arguments in");
  assert.equal(done.item.namespace, "mcp__demo");
  assert.equal(out.at(-1).response.model, "GLM-5.3");
});

test("an upstream that is not this machine's loopback IP is refused before a key can be sent", () => {
  const sessions = new SessionRegistry();
  const make = (patch) => () => createModelGateway({ apiKey: "fixture", sessions, ...GLM, ...patch });
  for (const upstreamOrigin of ["http://localhost:4000", "https://127.0.0.1:4000", "http://10.0.0.5:4000", "http://127.0.0.2:4000",
    "http://127.0.0.1", "http://127.0.0.1:4000/", "http://127.0.0.1:4000/v1", "http://user:pass@127.0.0.1:4000", "http://127.0.0.1:4000?x=1",
    "http://[::1]:4000/", "http://127.0.0.1:0", "http://127.0.0.1:65536", "https://api.minimaxi.com", "https://litellm.example"]) {
    assert.throws(make({ upstreamOrigin }), /approved/, upstreamOrigin);
  }
  assert.doesNotThrow(make({ upstreamOrigin: "http://127.0.0.1:4000" }));
  assert.doesNotThrow(make({ upstreamOrigin: "http://[::1]:4000" }));
  // Neither provider accepts the other's upstream, and there is no third one.
  assert.throws(() => createModelGateway({ apiKey: "fixture", sessions, upstreamOrigin: "http://127.0.0.1:4000" }), /approved/);
  assert.throws(() => createModelGateway({ apiKey: "fixture", sessions, provider: "openai", upstreamOrigin: "https://api.openai.com" }), /approved/);
  // The missing-key error no longer names one provider's setting.
  assert.throws(() => createModelGateway({ apiKey: " ", sessions, ...GLM }), error => /key/i.test(error.message) && !/MINIMAX/.test(error.message));
});

test("/healthz names the provider kind and the client slug, never the proxy address, group or key", async (t) => {
  const glm = await setup(t, GLM);
  const health = await fetch(`${glm.url}/healthz`);
  const text = await health.text();
  assert.deepEqual(JSON.parse(text), { status: "ok", provider: "litellm-loopback", model: "GLM-5.3", models: ["GLM-5.3"] });
  assert.doesNotMatch(text, /127\.0\.0\.1|4000|volc-coding|provider-secret-fixture/);
  const minimax = await setup(t);
  assert.deepEqual(await (await fetch(`${minimax.url}/healthz`)).json(), { status: "ok", provider: "minimax-cn", model: "MiniMax-M3", models: ["MiniMax-M3"] });
});

test("serves several models, routing each slug to its own upstream and key; an unconfigured model is refused", async (t) => {
  const f = await setup(t, { models: [
    { provider: "minimax", model: "MiniMax-M3", upstreamOrigin: "https://api.minimaxi.com", apiKey: "minimax-key-fixture" },
    { provider: "litellm", model: "GLM-5.3", upstreamModel: "volc-coding", upstreamOrigin: "http://127.0.0.1:4000", apiKey: "glm-key-fixture", maxOutputTokens: 32768 },
  ] });
  assert.deepEqual([...(await (await fetch(`${f.url}/healthz`)).json()).models].sort(), ["GLM-5.3", "MiniMax-M3"]);
  await f.post({ model: "MiniMax-M3", input: "x" });
  assert.equal(f.seen.at(-1).url, "https://api.minimaxi.com/v1/responses");
  assert.equal(f.seen.at(-1).headers.authorization, "Bearer minimax-key-fixture");
  await f.post({ model: "GLM-5.3", input: "x" });
  assert.equal(f.seen.at(-1).url, "http://127.0.0.1:4000/v1/responses");
  assert.equal(f.seen.at(-1).headers.authorization, "Bearer glm-key-fixture");
  assert.equal(JSON.parse(f.seen.at(-1).body).model, "volc-coding", "the GLM slug is sent upstream under its LiteLLM model name");
  assert.equal((await f.post({ model: "gpt-5", input: "x" })).status, 403);
});

// --- pinned by review (2026-09-11): mutations here used to survive ------------

const dribble = (text, size) => new ReadableStream({ start(controller) {
  const bytes = Buffer.from(text);
  for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.subarray(at, at + size));
  controller.close();
} });
const frames = text => parseSse(text.split("\n\n").filter(block => block && block !== "data: [DONE]").join("\n\n"));

// The MiniMax route has no normalisation step. Normalising it anyway, or
// defaulting upstreamModel to anything but the slug, passed every test.
test("the MiniMax route is never normalised: a body or frame it would change comes back byte for byte", async (t) => {
  const body = `{ "model": "MiniMax-M3-x",  "output": [] }`;
  const json = await setup(t, { fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }) });
  assert.equal(await (await json.post()).text(), body);

  // An added message without content: the LiteLLM route would default it.
  const stream = sse([
    { type: "response.created", response: { model: "MiniMax-M3-x", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant" } },
    { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "好" },
  ]);
  const streamed = await setup(t, { fetchImpl: async () => new Response(dribble(stream, 7), { headers: { "content-type": "text/event-stream" } }) });
  assert.equal(await (await streamed.post({ model: "MiniMax-M3", input: "x", stream: true })).text(), stream);
});

// Measured live against LiteLLM 1.96.0: data-only frames, a top-level model on
// every event, response.model "glm-5.3", and a closing "data: [DONE]". With MCP
// connected every GLM turn runs repair -> normalise -> MCP restore; dropping the
// [DONE] guard from the last stage ended each such turn with zero frames.
test("a recorded-shape GLM stream ending in [DONE] crosses the whole pipeline with MCP names restored", async (t) => {
  let forwarded;
  const { post } = await setup(t, { ...GLM, fetchImpl: async (_url, request) => {
    forwarded = JSON.parse(request.body);
    const alias = forwarded.tools[0].name, call = args => ({ type: "function_call", id: "fc", call_id: "c", name: alias, ...(args === undefined ? {} : { arguments: args }), status: "completed" });
    const events = [
      { type: "response.created", response: { id: "r", model: "glm-5.3", status: "in_progress", output: [] } },
      { type: "response.in_progress", response: { id: "r", model: "glm-5.3", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: call(undefined) },
      { type: "response.function_call_arguments.delta", item_id: "fc", output_index: 0, delta: "{\"text\":\"hi\"}" },
      { type: "response.function_call_arguments.done", item_id: "fc", output_index: 0, arguments: "{\"text\":\"hi\"}" },
      { type: "response.output_item.done", output_index: 0, item: call("{\"text\":\"hi\"}") },
      { type: "response.completed", response: { id: "r", model: "glm-5.3", status: "completed", output: [call("{\"text\":\"hi\"}")] } },
    ].map(event => ({ ...event, model: "glm-5.3" }));
    const upstream = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(dribble(upstream, 11), { headers: { "content-type": "text/event-stream" } });
  } });
  const tools = [{ type: "namespace", name: "mcp__demo", tools: [{ type: "function", name: "echo", parameters: { type: "object" } }] }];
  const response = await post({ model: "GLM-5.3", input: "x", stream: true, tools });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.endsWith("data: [DONE]\n\n"), "the client still sees the stream end");
  assert.doesNotMatch(text, /glm-5\.3|volc-coding|idou_mcp_/);
  const out = frames(text);
  assert.deepEqual(out.map(event => event.type), ["response.created", "response.in_progress", "response.output_item.added",
    "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.output_item.done", "response.completed"]);
  assert.ok(out.every(event => event.model === "GLM-5.3"));
  const added = out[2].item, done = out[5].item, completed = out[6].response.output[0];
  assert.equal(added.arguments, "", "defaulted, so Codex keeps the call open for its deltas");
  for (const item of [added, done, completed]) { assert.equal(item.namespace, "mcp__demo"); assert.equal(item.name, "echo"); }
  assert.equal(done.arguments, "{\"text\":\"hi\"}");
  assert.equal(out[6].response.model, "GLM-5.3");
});

// LiteLLM copies the request's tools into response.created (read in its 1.81.10
// source; OpenAI-shaped answers carry them in response.completed too), and the
// gateway accepts 8 MiB of them. Past 1 MiB the MCP stage used to cut the socket
// before a single byte reached Codex.
test("a GLM stream echoing more than 1 MiB of MCP tool definitions reaches the client whole", async (t) => {
  let echoed;
  const { post } = await setup(t, { ...GLM, fetchImpl: async (_url, request) => {
    const { tools } = JSON.parse(request.body); echoed = tools;
    const call = { type: "function_call", id: "fc", call_id: "c", name: tools[0].name, arguments: "{}" };
    const upstream = [
      { type: "response.created", model: "glm-5.3", response: { model: "glm-5.3", tools, output: [] } },
      { type: "response.output_item.done", model: "glm-5.3", output_index: 0, item: call },
      { type: "response.completed", model: "glm-5.3", response: { model: "glm-5.3", tools, output: [call] } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(dribble(upstream, 16384), { headers: { "content-type": "text/event-stream" } });
  } });
  const schema = { type: "object", properties: { query: { type: "string", description: "说明".repeat(200 * 1024) } } };
  const tools = [{ type: "namespace", name: "mcp__big", tools: [{ type: "function", name: "lookup", parameters: schema }] }];
  const response = await post({ model: "GLM-5.3", input: "x", stream: true, tools });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(Buffer.byteLength(JSON.stringify(echoed)) > 1024 * 1024);
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  const out = frames(text);
  assert.deepEqual(out.map(event => event.type), ["response.created", "response.output_item.done", "response.completed"]);
  assert.deepEqual(out[0].response.tools, echoed, "echoed definitions pass through untouched");
  assert.equal(out[1].item.namespace, "mcp__big"); assert.equal(out[2].response.output[0].name, "lookup");
});

// --- measured live (2026-09-14): the client hangs up once it has the answer ----

// Codex stops reading at the answer's terminal event and hangs up; LiteLLM's
// closing "[DONE]" and end of body can come after that. In three GLM evaluation
// runs every provider answer was 200 and every task completed, yet 14 of 39, 23
// of 94 and 17 of 45 requests were audited 504 request_cancelled. The pinned
// Codex hung up the same way against a synthetic upstream that held its body
// open after response.completed.
const answer = [
  { type: "response.created", response: { id: "r", model: "glm-5.3", status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
  { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "好" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "好" }] } },
  { type: "response.completed", response: { id: "r", model: "glm-5.3", status: "completed", output: [] } },
];

// The upstream sends `events` up to and including `through`, then holds its body
// open: the rest, "[DONE]" and the end come only five seconds later. The client
// reads through that event's frame and hangs up.
async function hangUpAfter(t, options, request, events, through) {
  let upstream, recorded;
  const audited = new Promise(resolve => { recorded = resolve; });
  // LiteLLM sends data-only frames; MiniMax names each event.
  const render = list => options.provider === "litellm" ? list.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") : sse(list);
  const { post } = await setup(t, { ...options, audit: event => recorded(event), fetchImpl: async (_url, init) => {
    const sent = events.findIndex(event => event.type === through) + 1;
    upstream = { signal: init.signal, released: false, ended: false };
    let late;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(render(events.slice(0, sent))));
        late = setTimeout(() => { upstream.ended = true; controller.enqueue(Buffer.from(`${render(events.slice(sent))}data: [DONE]\n\n`)); controller.close(); }, 5000);
      },
      cancel() { clearTimeout(late); upstream.released = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  } });
  const reader = (await post({ ...request, input: "x", stream: true })).body.getReader(), decoder = new TextDecoder();
  for (let text = ""; !text.split("\n\n").slice(0, -1).some(frame => frame.includes(`"type":"${through}"`));) {
    const { value, done } = await reader.read();
    assert.equal(done, false, `the stream ended before ${through}`);
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return { status: (await audited).status, upstream };
}

test("a client that hangs up once the answer has ended was served; one that hangs up before it cancelled", async (t) => {
  const tools = [{ type: "namespace", name: "mcp__demo", tools: [{ type: "function", name: "echo", parameters: { type: "object" } }] }];
  for (const [route, options, request] of [["MiniMax", {}, { model: "MiniMax-M3" }], ["GLM", GLM, { model: "GLM-5.3" }], ["GLM with MCP", GLM, { model: "GLM-5.3", tools }]]) {
    // Mid-answer is observed at the text: a message's close is held until the
    // next event shows whether the answer goes on (message-coalesce.js), so a
    // client cannot see it before whatever follows -- here, the end.
    for (const [through, status] of [["response.created", 504], ["response.output_text.delta", 504], ["response.completed", 200]]) {
      const { status: audited, upstream } = await hangUpAfter(t, options, request, answer, through);
      assert.equal(audited, status, `${route}, hung up after ${through}`);
      // Either way the provider is let go at once, not held until its "[DONE]".
      assert.deepEqual([upstream.signal.aborted, upstream.released, upstream.ended], [true, true, false], `${route}, hung up after ${through}`);
    }
  }
  // An answer can also end incomplete or failed; the client then has all of it too.
  for (const type of ["response.incomplete", "response.failed"]) {
    const ended = [...answer.slice(0, -1), { type, response: { id: "r", model: "glm-5.3", status: type.slice("response.".length), output: [] } }];
    assert.equal((await hangUpAfter(t, GLM, { model: "GLM-5.3" }, ended, type)).status, 200, type);
  }
});

// The pipeline tears the response down after a provider failure, which also ends
// in "close". Taking every close for a hang-up recorded this one as served.
test("a provider that fails after the terminal event, while the client still reads, is not recorded as served", async (t) => {
  let recorded;
  const audited = new Promise(resolve => { recorded = resolve; });
  const { post } = await setup(t, { ...GLM, audit: event => recorded(event), fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(answer.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")));
    setTimeout(() => controller.error(new Error("upstream reset")), 20);
  } }), { headers: { "content-type": "text/event-stream" } }) });
  const response = await post({ model: "GLM-5.3", input: "x", stream: true });
  await assert.rejects(response.text(), "the client's connection is cut");
  assert.notEqual((await audited).status, 200);
});

test("the end watch fires when the terminal frame is whole, whatever the pieces or line ending, and changes no byte", async () => {
  const { responseEndWatch } = await import("../src/control-plane/model-gateway.js");
  // A delta that merely quotes the event does not end the answer.
  const quoted = { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: 'data: {"type":"response.completed"}\n\n' };
  const events = [...answer.slice(0, 3), quoted, ...answer.slice(3)];
  for (const newline of ["\n", "\r\n"]) {
    const bytes = Buffer.from(`${events.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join("")}data: [DONE]${newline}${newline}`);
    const end = bytes.indexOf("data: [DONE]");
    for (const size of [1, 2, 3, 7, bytes.length]) {
      let fed = 0;
      const fired = [], out = [];
      const watch = responseEndWatch(() => fired.push(fed));
      watch.on("data", chunk => out.push(chunk));
      for (let at = 0; at < bytes.length; at += size) {
        const piece = bytes.subarray(at, at + size); fed = at + piece.length;
        await new Promise((resolve, reject) => watch.write(piece, error => error ? reject(error) : resolve()));
      }
      watch.end(); await once(watch, "end");
      const label = `${JSON.stringify(newline)} in pieces of ${size}`;
      assert.deepEqual(fired, [Math.min(Math.ceil(end / size) * size, bytes.length)], label);
      assert.ok(Buffer.concat(out).equals(bytes), label);
    }
  }
});

test("a model this person may not use is refused, and cannot be fallen into either", async (t) => {
  // The half that decides. `model` is a field the client sends and an agent in
  // a sandbox can put anything in it, so filtering the list somebody is offered
  // is only the visible half of model visibility.
  const { ModelVisibility, modelPolicy } = await import("../src/control-plane/model-visibility.js");
  const models = [
    { provider: "minimax", upstreamOrigin: "https://api.minimaxi.com", model: "MiniMax-M3", upstreamModel: "MiniMax-M3", apiKey: "k" },
    { provider: "minimax", upstreamOrigin: "https://api.minimaxi.com", model: "GLM-5.3", upstreamModel: "GLM-5.3", apiKey: "k" },
  ];
  const offered = models.map((entry) => entry.model);
  const visibility = new ModelVisibility({ models: offered,
    rules: modelPolicy([{ who: { kind: "everyone" }, models: ["MiniMax-M3"] }], { models: offered }) });
  const { post } = await setup(t, { models, visibility });

  assert.equal((await post({ model: "MiniMax-M3", input: "x" })).status, 200);
  const refused = await post({ model: "GLM-5.3", input: "x" });
  assert.equal(refused.status, 403);
  // The same code a model that is not configured at all gets: an error should
  // not teach anybody which models exist but are withheld.
  assert.equal((await refused.json()).error.code, "model_not_allowed");
  assert.equal((await (await post({ model: "does-not-exist", input: "x" })).json()).error.code, "model_not_allowed");
});

test("falling over when a model stops answering does not fall into a forbidden one", async (t) => {
  // model-health picks a replacement by health alone. Without checking each
  // candidate again, the refusal above would only hold while everything works.
  const { ModelVisibility, modelPolicy } = await import("../src/control-plane/model-visibility.js");
  const { ModelHealth } = await import("../src/control-plane/model-health.js");
  const models = [
    { provider: "minimax", upstreamOrigin: "https://api.minimaxi.com", model: "MiniMax-M3", upstreamModel: "MiniMax-M3", apiKey: "k" },
    { provider: "minimax", upstreamOrigin: "https://api.minimaxi.com", model: "GLM-5.3", upstreamModel: "GLM-5.3", apiKey: "k" },
  ];
  const offered = models.map((entry) => entry.model);
  const health = new ModelHealth({ order: offered });
  const visibility = new ModelVisibility({ models: offered,
    rules: modelPolicy([{ who: { kind: "everyone" }, models: ["MiniMax-M3"] }], { models: offered }) });
  const asked = [];
  const { post } = await setup(t, { models, health, visibility,
    fetchImpl: async (url, request) => {
      asked.push(JSON.parse(request.body).model);
      // The only model this person may use has stopped answering for good --
      // a 401 is what model-health calls lasting, which is what makes it look
      // for another model instead of giving up on the spot.
      return new Response(JSON.stringify({ error: { code: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json" } });
    } });
  const answer = await post({ model: "MiniMax-M3", input: "x" });
  assert.equal(answer.status, 502, "没有别的模型可用时就该失败，而不是掉进一个没授权的");
  assert.deepEqual([...new Set(asked)], ["MiniMax-M3"], "不该去试 GLM-5.3");
});

test("what an answer cost is counted, and only when a provider answered", async (t) => {
  const { ModelUsage } = await import("../src/control-plane/model-usage.js");
  const usage = new ModelUsage();
  t.after(() => usage.close());
  const { post } = await setup(t, { usage,
    fetchImpl: async () => new Response(JSON.stringify({ output_text: "reply", usage: { input_tokens: 40, output_tokens: 8, total_tokens: 48 } }),
      { headers: { "content-type": "application/json" } }) });
  assert.equal((await post({ model: "MiniMax-M3", input: "x" })).status, 200);
  const who = { tenantId: "t1", userId: "u1" };
  assert.deepEqual(usage.today(who), { tokens: 48, requests: 1 });

  // A refused request cost nothing, and counting it would overstate everybody.
  assert.equal((await post({ model: "does-not-exist", input: "x" })).status, 403);
  assert.deepEqual(usage.today(who), { tokens: 48, requests: 1 });
});

test("a streamed answer's cost is read off the terminal event, without touching the stream", async (t) => {
  const { ModelUsage } = await import("../src/control-plane/model-usage.js");
  const usage = new ModelUsage();
  t.after(() => usage.close());
  const frames = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":11,"output_tokens":3,"total_tokens":14}}}\n\n',
  ].join("");
  const { post } = await setup(t, { usage,
    fetchImpl: async () => new Response(frames, { headers: { "content-type": "text/event-stream" } }) });
  const answer = await post({ model: "MiniMax-M3", input: "x", stream: true });
  assert.equal(answer.status, 200);
  // Byte for byte what the provider sent: the watch reads, it does not rewrite.
  assert.equal(await answer.text(), frames);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(usage.today({ tenantId: "t1", userId: "u1" }), { tokens: 14, requests: 1 });
});

// How full one server gets is a setting now (loadCapacity), and so is a
// person's share of it: before, the only limit was 8 requests for everybody
// together, and one busy account could hold all of them.
// Bounded: without the share the same person's second request is let through
// to an upstream that never answers, and the test must fail, not hang.
test("a person's share of the gateway keeps one account from holding every slot, and the server's own limit still holds", { timeout: 10_000 }, async (t) => {
  const held = [];
  const { post, sessions, url, seen } = await setup(t, { maxConcurrent: 2, maxConcurrentPerUser: 1,
    fetchImpl: (url, request) => {
      seen.push({ url, ...request });
      // Answers only when released, so the requests stay in flight.
      return new Promise((resolve) => held.push(() => resolve(new Response(JSON.stringify({ output_text: "ok" }), { headers: { "content-type": "application/json" } }))));
    } });
  const as = (session) => (body = { model: "MiniMax-M3", input: "x" }) => fetch(`${url}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify(body) });
  // Bounded too, and everything still held is let go at the end: a wait that
  // outlives a failed test keeps the process from ever exiting.
  const until = async (count) => {
    for (const end = Date.now() + 3000; held.length < count;) {
      if (Date.now() > end) throw new Error(`expected ${count} requests at the provider, saw ${held.length}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  t.after(() => { for (const release of held) release(); });
  const first = post();                                                   // u1, in flight
  await until(1);
  // The same person again -- another of their sessions, as a scheduled run is -- is refused.
  const sameTenantUser = sessions.issue({ tenantId: "t1", userId: "u1", deviceId: "d2" });
  assert.equal((await as(sameTenantUser)()).status, 429);
  // Somebody else is let in.
  const second = as(sessions.issue({ tenantId: "t1", userId: "u2", deviceId: "d3" }))();
  await until(2);
  // And now the server is full: a third person is refused too.
  assert.equal((await as(sessions.issue({ tenantId: "t1", userId: "u3", deviceId: "d4" }))()).status, 429);
  for (const release of held) release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  // Released, the first person may ask again.
  const again = as(sameTenantUser)();
  await until(3); held[2]();
  assert.equal((await again).status, 200);
  assert.equal(seen.length, 3, "a refused request never reached the provider");
});

test("a person's share cannot exceed the server's, and neither can be zero", () => {
  const sessions = new SessionRegistry();
  assert.throws(() => createModelGateway({ apiKey: "k", sessions, maxConcurrent: 2, maxConcurrentPerUser: 3 }), /cannot exceed/);
  assert.throws(() => createModelGateway({ apiKey: "k", sessions, maxConcurrent: 0 }), /Invalid model gateway maxConcurrent/);
  const server = createModelGateway({ apiKey: "k", sessions });
  assert.deepEqual(server.capacity(), { active: 0, maxConcurrent: 8, maxConcurrentPerUser: 8, requestsPerMinute: 90, people: 0, sessions: 0, requests: 0,
    rejected: { perMinute: 0, server: 0, person: 0 } }, "unset, it is what the server did before");
});
