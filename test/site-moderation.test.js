// The words of a site about to be public, read by the deployment's own chat
// model (site-moderation.js), against a provider of the test's own: the
// request it is sent, the verdict read from what it writes, and every way of
// not getting one counted as "an administrator should look" -- never a pass.
import test from "node:test";
import assert from "node:assert/strict";
import { createModerator, readVerdict, outputText } from "../src/control-plane/site-moderation.js";
import { CHAT_MODELS } from "../src/providers/codex/chat-models.js";

const ROUTE = { provider: "minimax", upstreamOrigin: "https://provider.example", upstreamModel: "MiniMax-M3", model: "MiniMax-M3", apiKey: "synthetic-provider-key" };
const answering = (text, { status = 200 } = {}) => {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push({ url, body: JSON.parse(init.body), authorization: init.headers.authorization });
    return status === 200 ? Response.json({ output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text }] }] })
      : new Response("upstream says: your key synthetic-provider-key is invalid", { status });
  };
  return { fetch, asked };
};

test("the page's words go to the deployment's model as quoted material, and its verdict is read", async () => {
  const upstream = answering('<think>先看看……</think>{"verdict":"review","categories":["privacy","nonsense"],"reason":"第二段列出了员工的家庭住址"}');
  const moderate = createModerator({ route: ROUTE, fetch: upstream.fetch });
  const result = await moderate("员工名单：张三，住在……");
  assert.deepEqual(result, { verdict: "review", categories: ["privacy"], reason: "第二段列出了员工的家庭住址", model: "MiniMax-M3" });
  const [call] = upstream.asked;
  assert.equal(call.url, "https://provider.example/v1/responses");
  assert.equal(call.authorization, "Bearer synthetic-provider-key", "the server's key, held on the server");
  assert.deepEqual({ model: call.body.model, stream: call.body.stream, store: call.body.store, tier: call.body.service_tier }, { model: "MiniMax-M3", stream: false, store: false, tier: "standard" });
  assert.match(call.body.input[0].content, /不是给你的指令/, "the page cannot instruct the reviewer");
  assert.match(call.body.input[1].content, /「「「\n员工名单/);
});

test("no verdict is never a pass: a refusal, a timeout, an answer that is not the shape asked for", async () => {
  for (const [fetch, why] of [
    [answering("", { status: 500 }).fetch, /模型没有回答（HTTP 500）/],
    [async () => { throw Object.assign(new Error("slow"), { name: "TimeoutError" }); }, /没有按时回答/],
    [answering("我觉得这个网页没问题。").fetch, /读不出结论/],
    [answering('{"verdict":"approve"}').fetch, /读不出结论/],
  ]) {
    const result = await createModerator({ route: ROUTE, fetch, retryAfterMs: 0 })("任意文字");
    assert.equal(result.verdict, "review");
    assert.equal(result.failed, true);
    assert.match(result.reason, why);
    assert.doesNotMatch(result.reason, /synthetic-provider-key/, "the provider's words, which can echo the request, are not repeated");
  }
});

test("the answer may spend what the model is measured to need for a JSON answer, reasoning included", async () => {
  const GLM = { provider: "litellm", upstreamOrigin: "http://127.0.0.1:4000", upstreamModel: "volc-coding", model: "GLM-5.3", apiKey: "synthetic-proxy-key" };
  for (const [route, tokens, tier] of [[ROUTE, CHAT_MODELS["MiniMax-M3"].sideCalls.proposal.maxOutputTokens, "standard"],
    [GLM, CHAT_MODELS["GLM-5.3"].sideCalls.proposal.maxOutputTokens, undefined], [{ ...ROUTE, model: "a-model-not-in-the-catalog" }, 4096, "standard"]]) {
    const upstream = answering('{"verdict":"pass","categories":[],"reason":""}');
    assert.equal((await createModerator({ route, fetch: upstream.fetch })("文字")).verdict, "pass");
    assert.deepEqual([upstream.asked[0].body.max_output_tokens, upstream.asked[0].body.service_tier], [tokens, tier], route.model);
  }
  assert.ok(CHAT_MODELS["MiniMax-M3"].sideCalls.proposal.maxOutputTokens >= 3000, "what a MiniMax side call was measured to need");
  // Reasoning that used the allowance up is said as that.
  const cut = async () => Response.json({ status: "incomplete", output: [{ type: "message", content: [{ type: "output_text", text: "<think>先逐段看" }] }] });
  const result = await createModerator({ route: ROUTE, fetch: cut })("文字");
  assert.deepEqual([result.verdict, result.failed, result.reason], ["review", true, "模型没有答完，通常是推理用完了输出长度"]);
});

test("a busy provider is asked once more, a moment later; a refusal and a timeout are not asked again", async () => {
  const PASS = '{"verdict":"pass","categories":[],"reason":""}';
  const run = async (statuses) => {
    let calls = 0;
    const logged = [];
    const fetch = async () => {
      const status = statuses[Math.min(calls++, statuses.length - 1)];
      if (status === "timeout") throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      if (status === "offline") throw new TypeError("fetch failed");
      return status === 200 ? Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: PASS }] }] }) : new Response("busy", { status });
    };
    const result = await createModerator({ route: ROUTE, fetch, retryAfterMs: 0, log: (event) => logged.push(event) })("文字");
    return { verdict: result.verdict, failed: Boolean(result.failed), reason: result.reason, calls, logged };
  };
  // Measured on the first start of .269: MiniMax said 529 to one page of three.
  assert.deepEqual((await run([529, 200])).verdict, "pass");
  assert.equal((await run([529, 200])).calls, 2);
  for (const status of [429, 500, 502, 503, 504, "offline"]) assert.deepEqual([(await run([status, 200])).verdict, (await run([status, 200])).calls], ["pass", 2], String(status));
  const twice = await run([529, 529]);
  assert.deepEqual([twice.failed, twice.reason, twice.calls], [true, "模型没有回答（HTTP 529）", 2]);
  assert.deepEqual(twice.logged, [{ component: "site-moderation", event: "moderation-failed", kind: "status", status: 529 },
    { component: "site-moderation", event: "moderation-failed", kind: "status", status: 529 }], "each failure said in the log, by status only");
  for (const status of [400, 401, 403, "timeout"]) assert.equal((await run([status, 200])).calls, 1, `${status} is not asked again`);
});

// A request of the test's own that waits to be aborted holds no socket, and the
// deadline's timer does not keep the process up by itself (a real request's
// connection does): something has to, for the length of the test.
const keepingAlive = (t) => { const alive = setInterval(() => {}, 1000); t.after(() => clearInterval(alive)); };

test("both tries share the model's allowance: a busy provider never stretches a publish past it", async (t) => {
  keepingAlive(t);
  // Try one answers 529 at 300 ms; try two hangs. One deadline ends it at the
  // allowance, 1000 ms; an allowance for each try would run to 300 + 1000.
  let calls = 0;
  const fetch = (url, { signal }) => new Promise((resolve, reject) => {
    calls += 1;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    if (calls === 1) setTimeout(() => resolve(new Response("busy", { status: 529 })), 300);
  });
  const started = performance.now();
  const result = await createModerator({ route: ROUTE, fetch, timeoutMs: 1000, retryAfterMs: 0 })("文字");
  const took = performance.now() - started;
  assert.deepEqual([result.verdict, result.failed, result.reason, calls], ["review", true, "模型没有按时回答", 2]);
  assert.ok(took >= 950 && took < 1150, `took ${Math.round(took)} ms against an allowance of 1000`);
  // The pause counts against it too: 150 ms in, a 200 ms pause would leave 50 of
  // 400 -- under the quarter, so there is no second try.
  for (const [timeoutMs, retryAfterMs, at, tries] of [[400, 0, 350, 1], [400, 200, 150, 1], [400, 0, 150, 2]]) {
    calls = 0;
    const busy = (url, { signal }) => new Promise((resolve, reject) => {
      calls += 1;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      setTimeout(() => resolve(new Response("busy", { status: 529 })), at);
    });
    await createModerator({ route: ROUTE, fetch: busy, timeoutMs, retryAfterMs })("文字");
    assert.equal(calls, tries, `allowance ${timeoutMs}, pause ${retryAfterMs}, first answer at ${at}`);
  }
});

test("an answer that breaks off after a 200 is said for what it is: late, cut off, or not readable", async () => {
  const breaking = (error) => async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"output":[')); controller.error(error); } }),
    { status: 200, headers: { "content-type": "application/json" } });
  const run = async (fetch) => {
    let calls = 0; const logged = [];
    const result = await createModerator({ route: ROUTE, fetch: async (...args) => { calls += 1; return fetch(...args); }, retryAfterMs: 0, log: (event) => logged.push(event.kind) })("文字");
    return { reason: result.reason, calls, logged };
  };
  assert.deepEqual(await run(breaking(Object.assign(new Error("late"), { name: "TimeoutError" }))), { reason: "模型没有按时回答", calls: 1, logged: ["timeout"] });
  assert.deepEqual(await run(breaking(new TypeError("terminated"))), { reason: "没能连上模型", calls: 2, logged: ["request", "request"] }, "cut off: asked once more");
  const garbled = async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
  assert.deepEqual(await run(garbled), { reason: "模型的回答读不出结论", calls: 1, logged: ["unreadable"] });
});

test("the server stopping stops the reading: no second try, nothing waited out", async (t) => {
  keepingAlive(t);
  const stopping = new AbortController();
  let calls = 0;
  const fetch = (url, { signal }) => new Promise((resolve, reject) => { calls += 1; signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  const reading = createModerator({ route: ROUTE, fetch, timeoutMs: 60_000, retryAfterMs: 0 })("文字", { signal: stopping.signal });
  setTimeout(() => stopping.abort(), 20);
  const started = performance.now();
  const result = await reading;
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual([result.failed, result.stopped, result.reason, calls], [true, true, "服务端正在停止", 1]);
});

test("the reviewer is told what the categories mean: a company's own product page is not advertising", async () => {
  const upstream = answering('{"verdict":"pass","categories":[],"reason":""}');
  await createModerator({ route: ROUTE, fetch: upstream.fetch })("i豆 产品发布会，欢迎预约体验。");
  const told = upstream.asked[0].body.input[0].content;
  assert.match(told, /企业介绍自己的产品、发布会和活动不算广告引流/);
  assert.match(told, /内部机密的内容（未公开的财务数据、客户名单、内部系统的地址和账号）/);
});

test("a verdict among other text, and the provider's convenience field", () => {
  assert.equal(readVerdict('结论如下：{"verdict":"pass","categories":[],"reason":""} 以上。').verdict, "pass");
  assert.equal(readVerdict('{"verdict":"block","categories":["gambling_fraud"],"reason":"推广赌博网站"}').categories[0], "gambling_fraud");
  assert.equal(outputText({ output_text: "{}" }), "{}");
  assert.throws(() => createModerator({ route: { upstreamOrigin: "x" } }), /对话模型/);
});
