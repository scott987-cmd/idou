import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { ModelHealth, lastingFailure, COOLING_OFF_MS } from "../src/control-plane/model-health.js";

// The answer LiteLLM gave for the GLM route on 2026-09-19, trimmed: the
// upstream's own refusal, carried inside a 400.
const LAPSED = JSON.stringify({ error: { message: "litellm.BadRequestError: OpenAIException - {\"error\":{\"code\":\"InvalidSubscription\",\"message\":\"Your account (2000006222) does not have a valid AgentPlan subscription, or your subscription has expired.\"}}", type: null, param: null, code: "400" } });

test("only a failure that will not go away by itself marks a model", () => {
  assert.equal(lastingFailure(400, LAPSED), "subscription", "the measured answer");
  assert.equal(lastingFailure(401, ""), "auth");
  assert.equal(lastingFailure(403, "anything"), "auth");
  assert.equal(lastingFailure(402, ""), "billing");
  assert.equal(lastingFailure(400, '{"error":{"code":"insufficient_quota"}}'), "billing");
  assert.equal(lastingFailure(500, LAPSED), "subscription", "a proxy may put the account problem in any status");
  for (const [status, text] of [[429, "rate limited"], [500, "internal"], [502, ""], [503, "overloaded"], [504, ""], [408, ""],
    [400, '{"error":{"code":"invalid_request","message":"bad tool schema"}}'], [200, LAPSED]]) {
    assert.equal(lastingFailure(status, text), null, `${status} ${text}`);
  }
});

test("a marked model is passed over for its cooling-off period, then tried again", () => {
  let now = 1_000;
  const logged = [];
  const health = new ModelHealth({ order: ["MiniMax-M3", "GLM-5.3"], now: () => now, log: (line) => logged.push(JSON.parse(line)) });
  assert.equal(health.route("GLM-5.3"), "GLM-5.3");
  health.fail("GLM-5.3", "subscription");
  assert.equal(health.route("GLM-5.3"), "MiniMax-M3", "the next in the server's order");
  assert.equal(health.route("MiniMax-M3"), "MiniMax-M3");
  assert.deepEqual(health.unavailable(), [{ model: "GLM-5.3", reason: "subscription", since: 1_000, retryAt: 1_000 + COOLING_OFF_MS }]);
  now += COOLING_OFF_MS - 1;
  health.fail("GLM-5.3", "subscription");
  assert.equal(health.unavailable()[0].since, 1_000, "still unavailable since it first failed");
  now += COOLING_OFF_MS;
  assert.equal(health.route("GLM-5.3"), "GLM-5.3", "given one real request again");
  health.succeed("GLM-5.3");
  assert.deepEqual(health.unavailable(), []);
  assert.deepEqual(logged.map((line) => [line.kind, line.model]), [["model_unavailable", "GLM-5.3"], ["model_available", "GLM-5.3"]], "each change said once");
  // Nothing usable: the model asked for is as good a try as any.
  health.fail("GLM-5.3", "auth"); health.fail("MiniMax-M3", "auth");
  assert.equal(health.route("GLM-5.3"), "GLM-5.3");
  assert.equal(health.next(new Set(["GLM-5.3"])), null);
});

async function gateway(t, answer, now = Date.now) {
  const sessions = new SessionRegistry();
  const session = sessions.issue({ tenantId: "t1", userId: "u1", deviceId: "d1" });
  const seen = [], audits = [], logged = [];
  const health = new ModelHealth({ order: ["GLM-5.3", "MiniMax-M3"], now, log: (line) => logged.push(JSON.parse(line)) });
  const server = createModelGateway({ sessions, health, audit: (event) => audits.push(event),
    models: [
      { provider: "litellm", model: "GLM-5.3", upstreamModel: "volc-coding", upstreamOrigin: "http://127.0.0.1:4000", apiKey: "glm-key-fixture" },
      { provider: "minimax", model: "MiniMax-M3", upstreamOrigin: "https://api.minimaxi.com", apiKey: "minimax-key-fixture" },
    ],
    fetchImpl: async (url, request) => { seen.push({ url, body: JSON.parse(request.body) }); return answer(url); } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  const post = (model) => fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` }, body: JSON.stringify({ model, input: "private-prompt-fixture" }) });
  return { post, seen, audits, health, logged };
}
const reply = () => new Response(JSON.stringify({ output_text: "fixture reply" }), { headers: { "content-type": "application/json" } });

test("a lapsed upstream is passed over at once, and the answer comes from the next model", async (t) => {
  const f = await gateway(t, (url) => url.startsWith("http://127.0.0.1:4000") ? new Response(LAPSED, { status: 400 }) : reply());
  const first = await f.post("GLM-5.3");
  assert.equal(first.status, 200, "the person's turn is answered, not failed");
  assert.equal(first.headers.get("x-idou-model"), "MiniMax-M3");
  assert.equal(first.headers.get("x-idou-model-requested"), "GLM-5.3");
  const text = await first.text();
  assert.doesNotMatch(text, /InvalidSubscription|2000006222/, "the upstream's words never reach the client");
  assert.deepEqual(f.seen.map((call) => [call.url.slice(0, 22), call.body.model]), [["http://127.0.0.1:4000/", "volc-coding"], ["https://api.minimaxi.c", "MiniMax-M3"]]);
  assert.deepEqual(f.health.unavailable().map((row) => [row.model, row.reason]), [["GLM-5.3", "subscription"]]);

  // Every request after that goes straight to the model that can answer.
  const second = await f.post("GLM-5.3");
  assert.equal(second.status, 200);
  assert.equal(f.seen.length, 3, "the lapsed upstream is not asked again during its cooling-off");
  assert.equal(f.seen.at(-1).body.model, "MiniMax-M3");
  assert.deepEqual(f.audits.map((row) => [row.status, row.model, row.requested]), [[200, "MiniMax-M3", "GLM-5.3"], [200, "MiniMax-M3", "GLM-5.3"]]);
  assert.doesNotMatch(JSON.stringify(f.audits), /InvalidSubscription|2000006222|private-prompt/);
});

test("weather is not a reason to switch: a 5xx or a rate limit fails as it always did", async (t) => {
  for (const [status, expected] of [[500, 502], [503, 502], [429, 429]]) {
    const f = await gateway(t, (url) => url.startsWith("http://127.0.0.1:4000") ? new Response("upstream busy", { status }) : reply());
    const response = await f.post("GLM-5.3");
    assert.equal(response.status, expected, `${status}`);
    assert.equal(f.seen.length, 1, `${status}: no second model asked`);
    assert.deepEqual(f.health.unavailable(), []);
  }
});

test("when every model is lapsed the request fails, and says nothing of why", async (t) => {
  const f = await gateway(t, () => new Response(LAPSED, { status: 400 }));
  const response = await f.post("GLM-5.3");
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /InvalidSubscription|2000006222/);
  assert.equal(f.seen.length, 2, "each model tried once");
  assert.deepEqual(f.health.unavailable().map((row) => row.model).sort(), ["GLM-5.3", "MiniMax-M3"]);
  assert.equal((await f.post("MiniMax-M3")).status, 502, "and the next request is tried rather than refused unasked");
});

test("once its cooling-off ends a lapsed model gets a real request, and is back when it answers", async (t) => {
  let clock = 0, lapsed = true;
  const f = await gateway(t, (url) => url.startsWith("http://127.0.0.1:4000") && lapsed ? new Response(LAPSED, { status: 400 }) : reply(), () => clock);
  assert.equal((await f.post("GLM-5.3")).headers.get("x-idou-model"), "MiniMax-M3");
  lapsed = false; // the subscription is renewed
  clock += COOLING_OFF_MS;
  const retried = await f.post("GLM-5.3");
  assert.equal(retried.headers.get("x-idou-model"), "GLM-5.3", "tried again, and answered");
  assert.equal(retried.headers.get("x-idou-model-requested"), null);
  assert.deepEqual(f.health.unavailable(), []);
  assert.deepEqual(f.logged.map((line) => [line.kind, line.model]), [["model_unavailable", "GLM-5.3"], ["model_available", "GLM-5.3"]],
    "the operator's log says it is back, not only that it went");
  clock += 1;
  assert.equal((await f.post("GLM-5.3")).headers.get("x-idou-model"), "GLM-5.3", "and stays back");
});

