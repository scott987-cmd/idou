import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { DocumentProposalModel } from "../src/application/document-proposal-model.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
const session = () => ({ token: "synthetic-only-token", serverUrl: "http://127.0.0.1:12345", expiresAt: Date.now() + 60000 });
const envelope = () => ({ status: "completed", model: "MiniMax-M3", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: '{"kind":"feishu-text-edit","replacement":"新内容"}' }] }] });
test("document proposals send no tools, do not store content upstream, and return only validated plain replacement data", async () => {
  let calls = 0; const model = new DocumentProposalModel({ getSession: async () => session(), fetchImpl: async (url, init) => {
    calls++; assert.equal(url, "http://127.0.0.1:12345/v1/responses"); assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false); assert.equal(body.stream, false); assert.equal(body.input, "synthetic prompt");
    return Response.json(envelope());
  } });
  assert.equal(JSON.parse(await model.generate("synthetic prompt")).replacement, "新内容"); assert.equal(calls, 1);
});
test("tool output, oversized response, refusal, malformed output and HTTP errors are never executed, echoed or retried, and each says which it was", async () => {
  for (const [response, reason] of [
    [Response.json({ ...envelope(), output: [{ type: "function_call", name: "write_document", arguments: "protected" }] }), /不允许的内容/],
    [Response.json({ ...envelope(), status: "incomplete" }), /没有答完就停了/],
    [new Response("x".repeat(131073), { headers: { "content-type": "application/json" } }), /长度上限/],
    [new Response("protected error", { status: 500 }), /HTTP 500/],
    [Response.json({ ...envelope(), output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "protected malformed text" }] }] }), /不符合支持的修改格式/],
  ]) {
    let calls = 0; const model = new DocumentProposalModel({ getSession: async () => session(), fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(model.generate("prompt"), error => !error.message.includes("protected") && /超出当前支持范围/.test(error.message) && /不会自动重试/.test(error.message) && reason.test(error.message));
    assert.equal(calls, 1);
  }
});
test("account changes and cancellation cannot accept late model output", async () => {
  let reads = 0; const model = new DocumentProposalModel({ getSession: async () => ({ ...session(), token: ++reads === 1 ? "one" : "two" }), fetchImpl: async () => Response.json(envelope()) });
  await assert.rejects(model.generate("prompt"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(new DocumentProposalModel({ getSession: async () => session(), fetchImpl: () => assert.fail("cancelled request dispatched") }).generate("prompt", controller.signal), /已取消/);
});
test("model timeout aborts its request without a retry", async () => {
  let calls = 0, aborted = false;
  const model = new DocumentProposalModel({ getSession: async () => session(), timeoutMs: 10, fetchImpl: async (_url, init) => {
    calls++; return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("protected provider error")); }, { once: true }));
  } });
  await assert.rejects(model.generate("prompt"), error => /不会自动重试/.test(error.message) && /10 毫秒内没有答完/.test(error.message)); assert.equal(calls, 1); assert.equal(aborted, true);
});
test("proposals ask for the model the server enforces and accept an answer only from that model", async () => {
  const bodies = [], answer = model => ({ ...envelope(), model });
  const client = (model, answered) => new DocumentProposalModel({ getSession: async () => session(), ...(model ? { model } : {}), fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json(answer(answered)); } });
  assert.equal(JSON.parse(await client(undefined, "MiniMax-M3").generate("prompt")).replacement, "新内容"); assert.equal(bodies.at(-1).model, "MiniMax-M3"); assert.equal(bodies.at(-1).max_output_tokens, 3000);
  assert.equal(JSON.parse(await client("GLM-5.3", "GLM-5.3").generate("prompt")).replacement, "新内容");
  const glm = bodies.at(-1); assert.equal(glm.model, "GLM-5.3"); assert.deepEqual(glm.tools, []); assert.equal(glm.tool_choice, "none"); assert.equal(glm.store, false); assert.equal(glm.stream, false); assert.equal(glm.max_output_tokens, 8192);
  // An answer naming any other model is not this server's answer to this request.
  const before = bodies.length;
  await assert.rejects(client("GLM-5.3", "MiniMax-M3").generate("prompt"), /不会自动重试/);
  await assert.rejects(client("MiniMax-M3", "GLM-5.3").generate("prompt"), /不会自动重试/);
  assert.equal(bodies.length, before + 2, "no retry");
  for (const model of ["gpt-5", "", null, "volc-coding"]) assert.throws(() => new DocumentProposalModel({ getSession: async () => session(), model }), /Unsupported chat model/);
});
test("a gateway enforcing another model yields a readable reconnect message, not its body, and no retry", async () => {
  let calls = 0; const model = new DocumentProposalModel({ getSession: async () => session(), model: "GLM-5.3", fetchImpl: async () => { calls++;
    return new Response(JSON.stringify({ error: { code: "model_not_allowed", message: "model_not_allowed", request_id: "protected-request-id" } }), { status: 403, headers: { "content-type": "application/json" } }); } });
  await assert.rejects(model.generate("prompt"), error => /服务端要求的模型与本机不一致，请重新连接/.test(error.message) && /不会自动重试/.test(error.message) && !error.message.includes("protected"));
  assert.equal(calls, 1);
  // Any other refusal keeps the generic message.
  const other = new DocumentProposalModel({ getSession: async () => session(), fetchImpl: async () => new Response(JSON.stringify({ error: { code: "scope_required" } }), { status: 403, headers: { "content-type": "application/json" } }) });
  await assert.rejects(other.generate("prompt"), error => !/不一致/.test(error.message) && /不会自动重试/.test(error.message));
});
// GLM-5.3 reasons inside max_output_tokens, so MiniMax's budget can end an answer
// "incomplete" before its JSON starts, after it was billed. MiniMax keeps its own.
test("each model gets its own proposal budget: MiniMax 3000 tokens and 90 s, GLM 8192 tokens and 180 s; an explicit timeout still wins", async t => {
  for (const [model, tokens, timeoutMs, override] of [["MiniMax-M3", 3000, 90_000], ["GLM-5.3", 8192, 180_000], ["GLM-5.3", 8192, 25, 25]]) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let body, aborted = false; const dispatched = Promise.withResolvers();
    const client = new DocumentProposalModel({ model, ...(override ? { timeoutMs: override } : {}), getSession: async () => session(), fetchImpl: (_url, init) => { body = JSON.parse(init.body); dispatched.resolve();
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("protected provider error")); }, { once: true })); } });
    const settled = assert.rejects(client.generate("prompt"), error => /不会自动重试/.test(error.message) && !error.message.includes("protected"));
    await dispatched.promise; assert.equal(body.max_output_tokens, tokens, model);
    t.mock.timers.tick(timeoutMs - 1); assert.equal(aborted, false, `${model} must not give up before ${timeoutMs} ms`);
    t.mock.timers.tick(1); assert.equal(aborted, true, `${model} gives up at ${timeoutMs} ms`); await settled;
    t.mock.timers.reset();
  }
});
// The gateway answers 400 to a max_output_tokens above its own cap, so each
// budget must fit the route the server builds for that model (32768 on GLM).
test("each route's real gateway accepts its model's proposal budget and forwards it as sent", async t => {
  for (const env of [{ MINIMAX_API_KEY: "synthetic-only-key" }, { IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_MODEL: "volc-agent", IDOU_LITELLM_API_KEY: "synthetic-only-key" }]) {
    const config = await loadChatModelConfig(env), upstream = [], sessions = new SessionRegistry(), issued = sessions.issue({ tenantId: "t", userId: "u", deviceId: "d" });
    // The upstream is this stub, never MiniMax or a proxy; it answers in its own model name.
    const gateway = createModelGateway({ ...config, sessions, fetchImpl: async (_url, init) => { upstream.push(JSON.parse(init.body)); return Response.json({ ...envelope(), model: config.upstreamModel }); } });
    gateway.listen(0, "127.0.0.1"); await once(gateway, "listening"); t.after(() => { gateway.close(); gateway.closeAllConnections(); });
    const client = new DocumentProposalModel({ model: config.model, getSession: async () => ({ token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${gateway.address().port}` }) });
    assert.equal(JSON.parse(await client.generate("prompt")).replacement, "新内容", config.model);
    assert.equal(upstream.length, 1); assert.equal(upstream[0].max_output_tokens, { "MiniMax-M3": 3000, "GLM-5.3": 8192 }[config.model]);
  }
});
