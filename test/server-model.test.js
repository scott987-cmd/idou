import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { fetchServerModel, modelFields, modelRefused, probeServerModel, ServerModel, MODEL_UNCONFIRMED, modelProblem, turnRefused } from "../src/providers/codex/server-model.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { DocumentProposalModel } from "../src/application/document-proposal-model.js";
import { GatewayWikiSynthesizer, sessionBinding } from "../src/knowledge/synthesis.js";
import { evidencePage } from "../src/knowledge/local-wiki.js";
import { chatModelLabel } from "../src/providers/codex/chat-models.js";

// A loopback server the test controls; nothing leaves this machine.
async function serve(t, handler) {
  const requests = [], server = createServer((req, res) => { requests.push({ method: req.method, url: req.url, headers: req.headers }); handler(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
const json = (value, status = 200, type = "application/json") => (_req, res) => { res.writeHead(status, { "content-type": type }); res.end(typeof value === "string" ? value : JSON.stringify(value)); };

test("the server's enforced model is learned from /healthz with a plain GET that carries nothing", async t => {
  for (const model of ["MiniMax-M3", "GLM-5.3"]) {
    const f = await serve(t, json({ status: "ok", provider: "whatever", model }));
    assert.equal(await fetchServerModel(f.url), model);
    assert.deepEqual(f.requests.map(({ method, url }) => ({ method, url })), [{ method: "GET", url: "/healthz" }]);
    assert.equal(f.requests[0].headers.authorization, undefined); assert.equal(f.requests[0].headers.cookie, undefined);
  }
  let init; await fetchServerModel("https://gateway.example", { fetchImpl: async (url, options) => { init = { url, ...options }; return Response.json({ model: "GLM-5.3" }); } });
  assert.equal(init.url, "https://gateway.example/healthz"); assert.equal(init.redirect, "error"); assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
});

test("an unknown slug, a non-JSON or oversized answer, or an error status is not learned", async t => {
  for (const handler of [json({ model: "gpt-5" }), json({ model: "volc-coding" }), json({ model: "__proto__" }), json({ status: "ok" }), json({ model: ["GLM-5.3"] }), json("null"), json("[]"),
    json("GLM-5.3", 200, "text/plain"), json("<html>GLM-5.3</html>", 200, "text/html"), json("{not json"), json({ model: "GLM-5.3" }, 500), json({ model: "GLM-5.3" }, 404),
    json({ model: "GLM-5.3", padding: "x".repeat(5000) })]) {
    const f = await serve(t, handler);
    assert.equal(await fetchServerModel(f.url), null);
  }
});

test("a redirect is refused, never followed, even to a same-server answer that would be valid", async t => {
  const f = await serve(t, (req, res) => {
    if (req.url === "/healthz") { res.writeHead(302, { location: "/elsewhere" }); res.end(); return; }
    json({ model: "GLM-5.3" })(req, res);
  });
  assert.equal(await fetchServerModel(f.url), null);
  assert.deepEqual(f.requests.map(request => request.url), ["/healthz"]);
});

test("a server that does not answer, or stalls mid-body, costs at most the short timeout", async t => {
  const silent = await serve(t, () => {});
  let started = Date.now(); assert.equal(await fetchServerModel(silent.url, { timeoutMs: 150 }), null); assert.ok(Date.now() - started < 2000);
  const stalled = await serve(t, (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"model":'); });
  started = Date.now(); assert.equal(await fetchServerModel(stalled.url, { timeoutMs: 150 }), null); assert.ok(Date.now() - started < 2000);
  const closed = createServer(); closed.listen(0, "127.0.0.1"); await once(closed, "listening");
  const port = closed.address().port; closed.close(); await once(closed, "close");
  assert.equal(await fetchServerModel(`http://127.0.0.1:${port}`, { timeoutMs: 1000 }), null, "connection refused");
});

test("only a control-plane origin is asked: no plain HTTP off loopback, no credentials, paths or queries", async () => {
  let requested = 0;
  for (const url of ["http://gateway.example", "http://localhost:5000", "https://user:secret@gateway.example", "https://gateway.example/api", "https://gateway.example/?x=1", "https://gateway.example/#x", "file:///tmp/x", "not a url", "", null, undefined]) {
    assert.equal(await fetchServerModel(url, { fetchImpl: async () => { requested++; return Response.json({ model: "GLM-5.3" }); } }), null, String(url));
  }
  assert.equal(requested, 0);
  // A trailing slash is still the bare origin the rest of the product accepts.
  assert.equal(await fetchServerModel("https://gateway.example/", { fetchImpl: async url => { assert.equal(url, "https://gateway.example/healthz"); return Response.json({ model: "MiniMax-M3" }); } }), "MiniMax-M3");
});

test("the product gateway's own /healthz names the model the desktop must use, whichever provider serves it", async t => {
  const start = async options => {
    const server = createModelGateway({ apiKey: "synthetic-key-fixture", sessions: { verify: () => null }, fetchImpl: () => assert.fail("no model call"), ...options });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.close(); server.closeAllConnections(); });
    return `http://127.0.0.1:${server.address().port}`;
  };
  assert.equal(await fetchServerModel(await start({})), "MiniMax-M3");
  assert.equal(await fetchServerModel(await start({ provider: "litellm", upstreamOrigin: "http://127.0.0.1:4000", model: "GLM-5.3", upstreamModel: "volc-coding" })), "GLM-5.3");
});

test("only the gateway's own model_not_allowed refusal reads as a model mismatch", async () => {
  const refusal = (code, status = 403, type = "application/json") => new Response(JSON.stringify({ error: { code, message: code, request_id: "r" } }), { status, headers: { "content-type": type } });
  assert.equal(await modelRefused(refusal("model_not_allowed")), true);
  for (const response of [refusal("scope_required"), refusal("model_not_allowed", 400), refusal("model_not_allowed", 403, "text/plain"), new Response("model_not_allowed", { status: 403 }),
    new Response(JSON.stringify({ error: { code: "model_not_allowed" }, padding: "x".repeat(5000) }), { status: 403, headers: { "content-type": "application/json" } }), Response.json({ status: "completed" })]) {
    assert.equal(await modelRefused(response), false);
  }
});

test("the probe tells a model this build ships from a well-formed slug it does not know from no usable answer", async t => {
  for (const [body, expected] of [[{ model: "GLM-5.3" }, { model: "GLM-5.3", models: ["GLM-5.3"] }], [{ model: "GLM-6" }, { unknown: "GLM-6" }], [{ model: "gpt-5" }, { unknown: "gpt-5" }]]) {
    const f = await serve(t, json({ status: "ok", ...body }));
    assert.deepEqual(await probeServerModel(f.url), expected);
  }
  // Anything that is not a plain slug is no answer at all, so none of it can reach the screen.
  for (const handler of [json({ model: "__proto__" }), json({ model: "GLM 6" }), json({ model: "<b>GLM-6</b>" }), json({ model: "GLM-6\u202e" }), json({ model: "模型六" }), json({ model: "x".repeat(65) }),
    json({ model: "" }), json({ model: 6 }), json({ status: "ok" }), json({ model: "GLM-6" }, 500), json("GLM-6", 200, "text/plain"), json({ model: "GLM-6", padding: "x".repeat(5000) })]) {
    const f = await serve(t, handler);
    assert.deepEqual(await probeServerModel(f.url), { unreachable: true });
  }
  assert.deepEqual(await probeServerModel("http://gateway.example"), { unreachable: true });
  // The model-only answer still names nothing but a shipped model.
  assert.equal(await fetchServerModel((await serve(t, json({ model: "GLM-6" }))).url), null);
});

test("a slow first /healthz no longer pins the default for the scope: nothing is named, and it is asked again after 10 s", async t => {
  // The reviewers' reproduction: the first answer comes 3.5 s late, past the 3 s limit.
  let answered = 0;
  const f = await serve(t, (req, res) => { const late = answered++ === 0; setTimeout(() => { if (!res.destroyed) json({ status: "ok", model: "GLM-5.3" })(req, res); }, late ? 3500 : 0); });
  let clock = 0; const known = new ServerModel({ serverUrl: async () => f.url, now: () => clock });
  known.learn();
  assert.deepEqual(await known.current(), { unreachable: true }, "unconfirmed, never the default");
  clock = 9_999; assert.deepEqual(await known.current(), { unreachable: true }); assert.equal(f.requests.length, 1, "not asked again inside 10 s");
  clock = 10_000; assert.deepEqual(await known.current(), { model: "GLM-5.3", models: ["GLM-5.3"] }); assert.equal(f.requests.length, 2);
  clock = 60_000; assert.deepEqual(await known.current(), { model: "GLM-5.3", models: ["GLM-5.3"] }); assert.equal(f.requests.length, 2, "a learned model is not asked about again");
});

test("a model_not_allowed refusal has the server asked at once, and a refused model is not kept when no answer comes", async t => {
  let model = "MiniMax-M3", up = true;
  const f = await serve(t, (req, res) => (up ? json({ status: "ok", model }) : json({ error: "down" }, 503))(req, res));
  const known = new ServerModel({ serverUrl: async () => f.url, now: () => 0 });
  known.learn(); assert.deepEqual(await known.current(), { model: "MiniMax-M3", models: ["MiniMax-M3"] });
  model = "GLM-5.3"; known.refused();
  assert.deepEqual(await known.current(), { model: "GLM-5.3", models: ["GLM-5.3"] }); assert.equal(f.requests.length, 2, "asked at once, inside the 10 s");
  up = false; known.refused(); assert.deepEqual(await known.current(), { unreachable: true }, "the refused model is no longer named");
  up = true; model = "GLM-6"; known.refused(); assert.deepEqual(await known.current(), { unknown: "GLM-6" });
});

test("a question already on its way answers a refusal too, and a new connection's question supersedes an older one", async () => {
  const asked = [], settle = () => new Promise(setImmediate);
  let url = "https://one.example";
  const known = new ServerModel({ serverUrl: async () => url, probe: async value => new Promise(resolve => asked.push({ url: value, resolve })), now: () => 0 });
  known.learn(); await settle(); known.refused(); known.refused(); await settle();
  assert.deepEqual(asked.map(item => item.url), ["https://one.example"], "refusals while asking start nothing new");
  const waiting = known.current();
  url = "https://two.example"; known.learn(); await settle();
  asked[1].resolve({ model: "GLM-5.3" }); asked[0].resolve({ model: "MiniMax-M3" });
  assert.deepEqual(await waiting, { model: "GLM-5.3" }, "never the superseded connection's answer");
  assert.deepEqual(await known.current(), { model: "GLM-5.3" });
  // No server to ask, or no usable session, is simply unconfirmed.
  for (const serverUrl of [async () => null, async () => { throw new Error("no session"); }]) {
    let probed = 0; const none = new ServerModel({ serverUrl, probe: async () => { probed++; return { model: "MiniMax-M3" }; }, now: () => 0 });
    none.learn(); assert.deepEqual(await none.current(), { unreachable: true }); assert.equal(probed, 0, "nothing to ask");
  }
});

test("with no confirmed model nothing is named: an unknown slug says update the app, anything else that it will be asked again", () => {
  assert.equal(MODEL_UNCONFIRMED, "模型未确认");
  assert.match(modelProblem({ unknown: "GLM-6" }), /GLM-6.*请更新应用/); assert.doesNotMatch(modelProblem({ unknown: "GLM-6" }), /重新连接/);
  for (const known of [{ unreachable: true }, {}, null, { unknown: "<script>" }, { unknown: "GLM 6" }, { unknown: "x".repeat(65) }]) {
    const text = modelProblem(known);
    assert.match(text, /尚未确认/); assert.doesNotMatch(text, /MiniMax|GLM|script|x{65}|更新应用/);
  }
});

test("the renderer is handed a name only for a model the server confirmed; otherwise 模型未确认 and the reason", () => {
  assert.deepEqual(modelFields({ model: "GLM-5.3" }), { model: "GLM-5.3", modelLabel: "GLM-5.3", modelVendor: "智谱 GLM（火山方舟，经服务端本机 LiteLLM）", modelConfirmed: true, modelSynthesisTokens: 8192 });
  // The synthesis consent states the output cap of the model it names.
  assert.equal(modelFields({ model: "MiniMax-M3" }).modelLabel, "MiniMax-M3"); assert.equal(modelFields({ model: "MiniMax-M3" }).modelSynthesisTokens, 2400);
  for (const known of [{ unreachable: true }, {}, null, undefined, { model: "gpt-5" }, { unknown: "GLM-6" }, { unknown: "<b>x</b>" }]) {
    const fields = modelFields(known);
    assert.equal(fields.model, null); assert.equal(fields.modelLabel, "模型未确认"); assert.equal(fields.modelVendor, ""); assert.equal(fields.modelConfirmed, false);
    assert.doesNotMatch(JSON.stringify(fields), /MiniMax|<b>/, JSON.stringify(known));
    assert.equal(fields.modelUnsupported, known?.unknown === "GLM-6"); assert.equal(fields.modelNotice, modelProblem(known));
  }
});

test("a turn or proposal asks for the confirmed model, the default only while unconfirmed, and nothing under a model this build does not ship", async () => {
  const scope = known => new ServerModel({ serverUrl: async () => "https://gateway.example", probe: async () => known, now: () => 0 });
  const glm = scope({ model: "GLM-5.3" }); glm.learn(); assert.equal(await glm.requestModel(), "GLM-5.3");
  // The gateway refuses any other model before its upstream, and that refusal has the server asked again.
  const quiet = scope({ unreachable: true }); quiet.learn(); assert.equal(await quiet.requestModel(), "MiniMax-M3");
  const newer = scope({ unknown: "GLM-6" }); newer.learn();
  await assert.rejects(newer.requestModel(), error => /GLM-6 本版本不支持，请更新应用；本次未发送/.test(error.message) && !/重新连接/.test(error.message));
  // A connection check sends no model request, so it still starts.
  assert.equal(await newer.requestModel({ sending: false }), "MiniMax-M3");
});

test("a proposal, synthesis or Codex turn the gateway refuses for its model has the server asked again at once", async t => {
  // The product gateway on loopback enforces GLM-5.3; the scope still believes the MiniMax-M3 it learned before the server changed.
  const sessions = new SessionRegistry(), issued = sessions.issue({ tenantId: "tenant", userId: "alice", deviceId: "device" });
  let upstream = 0;
  const server = createModelGateway({ sessions, apiKey: "synthetic-key-fixture", provider: "litellm", upstreamOrigin: "http://127.0.0.1:4000", model: "GLM-5.3", upstreamModel: "volc-coding",
    fetchImpl: async () => { upstream++; throw new Error("no upstream call"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.close(); server.closeAllConnections(); });
  const session = { token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` };
  const stale = () => { let asked = 0; const known = new ServerModel({ serverUrl: async () => session.serverUrl, now: () => 0, probe: async url => ++asked === 1 ? { model: "MiniMax-M3" } : probeServerModel(url) });
    known.learn(); return { known, asked: () => asked }; };
  // Each starts out believing MiniMax-M3, settled before anything is refused.
  const proposal = stale(); assert.equal(await proposal.known.requestModel(), "MiniMax-M3");
  await assert.rejects(new DocumentProposalModel({ getSession: async () => session, model: "MiniMax-M3", fetchImpl: proposal.known.watching() }).generate("prompt"), /不一致/);
  // The clock never moves, so only the refusal can have had the server asked again.
  assert.equal(await proposal.known.requestModel(), "GLM-5.3"); assert.equal(proposal.asked(), 2);
  const synthesis = stale(); assert.deepEqual(await synthesis.known.current(), { model: "MiniMax-M3" });
  const page = evidencePage({ providerId: "fixture", resourceId: "Doc", sourceUrl: "https://test.feishu.cn/docx/Doc", sourceRevision: "1", contentHash: "h", title: "t", text: "下周交付采购报告。", partial: false, warnings: [], identity: { principal: "alice", tenantKey: "tenant", verifiedAt: 1 } }, 2);
  await assert.rejects(new GatewayWikiSynthesizer({ getSession: async () => session, model: "MiniMax-M3", fetchImpl: synthesis.known.watching() }).generate(page, { binding: sessionBinding(session, "MiniMax-M3") }), error => error.modelMismatch === true);
  assert.deepEqual(await synthesis.known.current(), { model: "GLM-5.3", models: ["GLM-5.3"] }); assert.equal(synthesis.asked(), 2);
  assert.equal(upstream, 0, "every refusal came before the upstream");
  // The caller still reads the refusal itself, and any other 403 or answer asks nothing.
  const other = stale(); await other.known.current();
  const watched = other.known.watching(async () => new Response(JSON.stringify({ error: { code: "scope_required" } }), { status: 403, headers: { "content-type": "application/json" } }));
  assert.equal((await (await watched("https://gateway.example/v1/responses")).json()).error.code, "scope_required");
  await other.known.watching(async () => Response.json({ status: "completed" }))("https://gateway.example/v1/responses");
  assert.deepEqual(await other.known.current(), { model: "MiniMax-M3" }); assert.equal(other.asked(), 1);
  // A Codex turn reports it as a notification on its app-server client.
  const turn = stale(), client = turn.known.watchTurns(new EventEmitter()); await turn.known.current();
  client.emit("notification", { method: "item/agentMessage/delta", params: { delta: "model_not_allowed" } });
  assert.deepEqual(await turn.known.current(), { model: "MiniMax-M3" }); assert.equal(turn.asked(), 1);
  client.emit("notification", { method: "turn/completed", params: { turn: { status: "failed", error: { message: 'unexpected status 403 Forbidden: {"error":{"code":"model_not_allowed"}}' } } } });
  assert.deepEqual(await turn.known.current(), { model: "GLM-5.3", models: ["GLM-5.3"] }); assert.equal(turn.asked(), 2);
});

test("a Codex turn the gateway refused for its model is recognised by the gateway's code and nothing else", () => {
  const refusal = 'unexpected status 403 Forbidden: {"error":{"code":"model_not_allowed","message":"model_not_allowed","request_id":"r"}}';
  assert.equal(turnRefused({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "failed", error: { message: refusal } } } }), true);
  assert.equal(turnRefused({ method: "error", params: { error: { message: refusal }, willRetry: false } }), true);
  assert.equal(turnRefused({ method: "error", params: { error: { message: "stream disconnected", additionalDetails: refusal } } }), true);
  for (const message of [{ method: "turn/completed", params: { turn: { status: "failed", error: { message: "unexpected status 401: session_expired_or_invalid" } } } },
    { method: "turn/completed", params: { turn: { status: "completed", error: null } } }, { method: "item/agentMessage/delta", params: { delta: "model_not_allowed" } },
    { method: "error", params: { error: { message: "model_not_allowed_elsewhere" } } }, { method: "error" }, {}, null]) assert.equal(turnRefused(message), false);
});

test("offers the server's model set and requestModel honours a valid choice", async t => {
  const f = await serve(t, json({ status: "ok", model: "GLM-5.3", models: ["GLM-5.3", "MiniMax-M3"] }));
  const known = new ServerModel({ serverUrl: async () => f.url, now: () => 0 });
  known.learn();
  assert.deepEqual([...(await known.current()).models].sort(), ["GLM-5.3", "MiniMax-M3"]);
  assert.equal(await known.requestModel(), "GLM-5.3", "the default until a choice is made");
  assert.equal(known.options().default, "GLM-5.3");
  assert.deepEqual(known.options().available.map(option => option.slug).sort(), ["GLM-5.3", "MiniMax-M3"]);
  // A choice among the offered set takes effect and is persisted.
  const persisted = [];
  const picked = new ServerModel({ serverUrl: async () => f.url, now: () => 0, persist: async model => persisted.push(model) });
  picked.learn();
  await picked.choose("MiniMax-M3");
  assert.equal(await picked.requestModel(), "MiniMax-M3");
  assert.equal(picked.options().current, "MiniMax-M3");
  assert.deepEqual(persisted, ["MiniMax-M3"]);
  await assert.rejects(picked.choose("gpt-5"), /不可选/, "a model the server does not offer is refused");
  // A restored choice the server no longer offers falls back to the default.
  const restored = new ServerModel({ serverUrl: async () => f.url, now: () => 0, choice: "claude-opus-5" });
  restored.learn();
  assert.equal(await restored.requestModel(), "GLM-5.3");
});

// The server keeps each person's model now (model-choice.js). While it answers,
// its word is final and a choice saved on this desktop is not consulted.
test("the server's record of the person's model decides, and a choice is kept there", async () => {
  let record = { available: ["MiniMax-M3", "GLM-5.3"], default: "MiniMax-M3", choice: null, current: "MiniMax-M3", unavailable: [] };
  const sent = [];
  const remote = { options: async () => record, choose: async (model) => { sent.push(model); record = { ...record, choice: model, current: model ?? record.default }; return record; } };
  const known = new ServerModel({ serverUrl: async () => "https://gateway.example", probe: async () => ({ model: "MiniMax-M3", models: ["MiniMax-M3", "GLM-5.3"] }),
    now: () => 0, choice: "GLM-5.3", remote });
  known.learn();
  await known.current();
  assert.equal(await known.requestModel(), "MiniMax-M3", "a choice saved on this desktop no longer decides");
  assert.equal(known.options().kept, "server");
  assert.equal(known.options().choice, null, "following the default");
  assert.equal((await known.choose("GLM-5.3")).current, "GLM-5.3");
  assert.equal(await known.requestModel(), "GLM-5.3");
  assert.equal((await known.choose(null)).choice, null, "and back to following the default");
  assert.deepEqual(sent, ["GLM-5.3", null]);
});

test("a model the server passes over is named, with why, in the person's words", async () => {
  const remote = { options: async () => ({ available: ["MiniMax-M3", "GLM-5.3"], default: "MiniMax-M3", choice: "GLM-5.3", current: "MiniMax-M3",
    unavailable: [{ model: "GLM-5.3", reason: "subscription", since: 1_789_766_000_000, retryAt: 1_789_766_600_000 }, { model: "<script>", reason: "x" }] }), choose: async () => null };
  const known = new ServerModel({ serverUrl: async () => "https://gateway.example", probe: async () => ({ model: "MiniMax-M3", models: ["MiniMax-M3", "GLM-5.3"] }), now: () => 0, remote });
  known.learn();
  await known.current();
  assert.equal(await known.requestModel(), "MiniMax-M3", "the pick is kept, the work goes where an answer comes from");
  const options = known.options();
  assert.equal(options.choice, "GLM-5.3");
  assert.deepEqual(options.unavailable, [{ slug: "GLM-5.3", label: chatModelLabel("GLM-5.3"), reason: "上游订阅无效或已过期", since: 1_789_766_000_000 }]);
  // Whether each can see a pasted image, as Codex decides it from the catalog.
  assert.deepEqual(options.available.map((model) => [model.slug, model.images]), [["MiniMax-M3", true], ["GLM-5.3", false]]);
});

test("an older server keeps the desktop's own choice, and a slow one is not waited on", { timeout: 10_000 }, async () => {
  const persisted = [];
  const older = new ServerModel({ serverUrl: async () => "https://gateway.example", probe: async () => ({ model: "MiniMax-M3", models: ["MiniMax-M3", "GLM-5.3"] }),
    now: () => 0, choice: "GLM-5.3", persist: async (model) => persisted.push(model), remote: { options: async () => null, choose: async () => null } });
  older.learn();
  await older.current();
  assert.equal(await older.requestModel(), "GLM-5.3", "as before");
  assert.equal(older.options().kept, "local");
  await older.choose("MiniMax-M3");
  assert.deepEqual(persisted, ["MiniMax-M3"]);
  await assert.rejects(older.choose(null), /版本较旧/);

  let clock = 0;
  const slow = new ServerModel({ serverUrl: async () => "https://gateway.example", probe: async () => ({ model: "MiniMax-M3", models: ["MiniMax-M3"] }),
    now: () => clock, remoteWaitMs: 50, remote: { options: () => new Promise(() => {}), choose: async () => null } });
  slow.learn();
  const started = Date.now();
  await slow.current();
  assert.ok(Date.now() - started < 1_000, "a question that does not come back holds nothing up");
  assert.equal(await slow.requestModel(), "MiniMax-M3", "the server's default meanwhile");
});

// current() is on the path of every label and status. Waiting there on a slow
// server slowed all of them, and held 退出此账号 while any was out (the renewal
// smoke, twice). Only a turn about to go, or the picker, waits -- and briefly.
test("a label never waits on the server's record; a turn waits only before the first answer", { timeout: 10_000 }, async () => {
  let release;
  const hanging = new ServerModel({ serverUrl: async () => "https://gateway.example", probe: async () => ({ model: "MiniMax-M3", models: ["MiniMax-M3", "GLM-5.3"] }),
    now: () => 0, remoteWaitMs: 300, remote: { options: () => new Promise((resolve) => { release = resolve; }), choose: async () => null } });
  hanging.learn();
  let started = Date.now();
  for (let i = 0; i < 5; i += 1) await hanging.current();
  assert.ok(Date.now() - started < 100, `five labels, no wait: ${Date.now() - started} ms`);
  started = Date.now();
  assert.equal(await hanging.requestModel(), "MiniMax-M3");
  assert.ok(Date.now() - started >= 250, "a turn gives the first answer a moment");
  release({ available: ["MiniMax-M3", "GLM-5.3"], default: "MiniMax-M3", choice: "GLM-5.3", current: "GLM-5.3", unavailable: [] });
  await new Promise((resolve) => setImmediate(resolve));
  started = Date.now();
  assert.equal(await hanging.requestModel(), "GLM-5.3", "and uses it once it comes");
  assert.ok(Date.now() - started < 100);
});

test("an answer for a connection since replaced is dropped", async () => {
  const pending = [];
  const known = new ServerModel({ serverUrl: async () => "https://gateway.example", probe: async () => ({ model: "MiniMax-M3", models: ["MiniMax-M3", "GLM-5.3"] }),
    now: () => 0, remoteWaitMs: 10, remote: { options: () => new Promise((resolve) => pending.push(resolve)), choose: async () => null } });
  known.learn();
  known.learn(); // the connection changed while the first question was out
  const record = (choice) => ({ available: ["MiniMax-M3", "GLM-5.3"], default: "MiniMax-M3", choice, current: choice ?? "MiniMax-M3", unavailable: [] });
  pending[1](record(null));
  await new Promise((resolve) => setImmediate(resolve));
  pending[0](record("GLM-5.3")); // the old account's answer, late
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await known.requestModel(), "MiniMax-M3");
  assert.equal(known.options().choice, null, "the late answer did not land");
});

// Measured live: the gateway passed GLM over and answered from MiniMax, and
// the picker still said GLM, from an answer cached before it happened.
test("the picker asks again, so a model passed over a moment ago is shown as such", async () => {
  let record = { available: ["MiniMax-M3", "GLM-5.3"], default: "MiniMax-M3", choice: "GLM-5.3", current: "GLM-5.3", unavailable: [] };
  let asked = 0;
  const known = new ServerModel({ serverUrl: async () => "https://gateway.example", probe: async () => ({ model: "MiniMax-M3", models: ["MiniMax-M3", "GLM-5.3"] }),
    now: () => 0, remote: { options: async () => { asked += 1; return record; }, choose: async () => null } });
  known.learn();
  assert.equal(await known.requestModel(), "GLM-5.3");
  record = { ...record, current: "MiniMax-M3", unavailable: [{ model: "GLM-5.3", reason: "subscription", since: 1 }] };
  await known.current();
  assert.equal(known.options().unavailable.length, 0, "a label keeps the cached answer");
  await known.settled({ fresh: true });
  assert.equal(known.options().current, "MiniMax-M3");
  assert.equal(known.options().unavailable[0].slug, "GLM-5.3");
  assert.equal(asked, 2, "asked once more, for the picker");
});

