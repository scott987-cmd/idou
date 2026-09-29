import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalWiki, evidencePage } from "../src/knowledge/local-wiki.js";
import { GatewayWikiSynthesizer, sessionBinding, synthesisInput, validateFacts } from "../src/knowledge/synthesis.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { storedPages, storedBytes } from "../scripts/fixtures/wiki-store.js";

const document = () => ({ providerId: "fixture", resourceId: "doc-synthetic", sourceUrl: "https://test.feishu.cn/docx/Document123", sourceRevision: "1", contentHash: "hash1", title: "合成计划", text: "九月十八日试运行。仅向采购组开放。外部供应商暂不接入。", partial: false, warnings: [], identity: { principal: "alice", tenantKey: "tenant1", verifiedAt: 1000 } });
const session = () => ({ serverUrl: "http://127.0.0.1:12345", token: "a".repeat(43), expiresAt: Date.now() + 60_000 });
const factsFor = (page) => ({ facts: [{ text: "首轮仅面向采购组。", evidence: [{ chunkId: page.chunks[0].id, quote: "仅向采购组开放。" }] }] });
const response = (page, changes = {}) => ({ object: "response", model: "MiniMax-M3", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(factsFor(page)) }] }], ...changes });

// `model` is the one the stub's server enforces; setModel() is the server switching it.
async function setup(t, generate, { model = "MiniMax-M3" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-synthesis-")); t.after(() => rm(directory, { recursive: true, force: true }));
  let doc = document(), identity = doc.identity, calls = 0, denied = false, currentModel = model;
  const cipher = fixtureCipher(), filename = path.join(directory, "wiki.enc"), currentSession = session();
  const provider = { documentIdentity: async () => identity, readDocument: async () => { if (denied) throw new Error("denied"); return structuredClone(doc); } };
  const synthesizer = { binding: async () => sessionBinding(currentSession, currentModel), generate: async (page, options) => { calls++; return generate ? generate(page, options) : factsFor(page); } };
  const create = () => new LocalWiki({ filename, provider, cipher, synthesizer });
  return { wiki: create(), create, provider, synthesizer, currentSession, cipher, filename, doc: () => doc, calls: () => calls,
    stored: async () => await storedPages(cipher, filename), setModel: (value) => { currentModel = value; },
    change: (patch) => { doc = { ...doc, ...patch }; }, login: (patch) => { identity = { ...identity, ...patch }; }, deny: () => { denied = true; } };
}

test("model client uses only bound gateway session, no tools/storage/retry, and validates exact evidence", async () => {
  const page = evidencePage(document(), 1000), auth = session(), calls = [];
  const client = new GatewayWikiSynthesizer({ getSession: async () => auth, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return Response.json(response(page)); } });
  const result = await client.generate(page, { binding: await client.binding() });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, `${auth.serverUrl}/v1/responses`); assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].headers.authorization, `Bearer ${auth.token}`);
  const body = JSON.parse(calls[0].body); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 2400);
  assert.doesNotMatch(body.input, /alice|tenant1|doc-synthetic|https:/);
  assert.equal(result.facts[0].evidence[0].quote, page.chunks[0].text.slice(result.facts[0].evidence[0].start, result.facts[0].evidence[0].end));
  auth.token = "b".repeat(43);
  await assert.rejects(client.generate(page, { binding: sessionBinding(session()) }), /连接已变化/); assert.equal(calls.length, 1);
});

test("invalid citations, unknown chunks, unbounded facts and quotes outside sent coverage are rejected", () => {
  const page = evidencePage(document(), 1000);
  for (const value of [{ facts: [] }, { facts: Array(7).fill(factsFor(page).facts[0]) }, { facts: [{ text: "编造", evidence: [{ chunkId: page.chunks[0].id, quote: "全部供应商已开放" }] }] }, { facts: [{ text: "编造", evidence: [{ chunkId: "other", quote: "仅向采购组开放。" }] }] }]) assert.throws(() => validateFacts(value, page));
  const long = evidencePage({ ...document(), text: "长文资料。".repeat(5000) }, 1000), input = synthesisInput(long);
  assert.ok(input.coverage.characters <= 12_000); assert.ok(input.coverage.includedChunks < input.coverage.totalChunks);
  assert.throws(() => validateFacts({ facts: [{ text: "未提供部分", evidence: [{ chunkId: long.chunks.at(-1).id, quote: "长文资料。" }] }] }, long));
});

test("model protocol errors, provider failures and cancellation never expose response bodies or retry", async () => {
  const page = evidencePage(document(), 1000);
  for (const payload of [response(page, { status: "incomplete" }), response(page, { model: "other" }), response(page, { output: [{ type: "function_call", arguments: "SECRET" }] }), response(page, { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "SECRET invalid json" }] }] })]) {
    let calls = 0; const client = new GatewayWikiSynthesizer({ getSession: async () => session(), fetchImpl: async () => { calls++; return Response.json(payload); } });
    await assert.rejects(client.generate(page, { binding: await client.binding() }), (error) => !error.message.includes("SECRET")); assert.equal(calls, 1);
  }
  let calls = 0; const client = new GatewayWikiSynthesizer({ getSession: async () => session(), fetchImpl: async () => { calls++; return new Response("SECRET", { status: 502 }); } });
  await assert.rejects(client.generate(page, { binding: await client.binding() }), /不会自动重试/); assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.generate(page, { binding: await client.binding(), signal: controller.signal }), /取消/); assert.equal(calls, 1);
});

test("automatic synthesis is opt-in, persists verified facts, deduplicates and survives restart without another call", async (t) => {
  const f = await setup(t); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 0);
  await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc()); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 1);
  assert.equal((await f.wiki.search("采购")).hits[0].synthesis.facts[0].text, "首轮仅面向采购组。");
  const bytes = await readFile(f.filename); assert.equal(bytes.includes(Buffer.from("首轮")), false);
  await f.wiki.close(); const restored = f.create(); assert.equal(restored.status().synthesis.enabled, false);
  await restored.enableSynthesis(); await restored.observe(f.doc()); assert.equal(f.calls(), 1);
  assert.equal((await restored.search("采购")).hits[0].synthesis.state, "complete");
});

test("oversized responses and even an abort-ignoring late transport cannot produce accepted facts", async () => {
  const page = evidencePage(document(), 1000);
  const oversized = new GatewayWikiSynthesizer({ getSession: async () => session(), fetchImpl: async () => new Response("x".repeat(256 * 1024 + 1), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(oversized.generate(page, { binding: await oversized.binding() }), /归纳失败/);
  const late = new GatewayWikiSynthesizer({ getSession: async () => session(), timeoutMs: 1, fetchImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return Response.json(response(page)); } });
  await assert.rejects(late.generate(page, { binding: await late.binding() }), /取消或超时/);
});

test("source changes and revoked reads discard model results rather than assigning them to a newer revision", async (t) => {
  for (const change of ["revision", "denied"]) {
    const gate = Promise.withResolvers(), started = Promise.withResolvers();
    const f = await setup(t, async (page) => { started.resolve(); await gate.promise; return factsFor(page); });
    await f.wiki.enableSynthesis(); const observing = f.wiki.observe(f.doc()); await started.promise;
    if (change === "revision") f.change({ sourceRevision: "2", contentHash: "hash2" }); else f.deny();
    gate.resolve(); await observing;
    const stored = { pages: await storedPages(f.cipher, f.filename) }; assert.equal(stored.pages[0].synthesis.state, "failed"); assert.equal(stored.pages[0].synthesis.facts, undefined);
    const result = await f.wiki.search("采购"); assert.ok(!result.hits[0]?.synthesis);
  }
});

test("failed and interrupted attempts remain reserved across restart and never silently rebill a retained revision", async (t) => {
  let reservationSeen = false;
  const f = await setup(t, async () => {
    reservationSeen = (await storedPages(f.cipher, f.filename))[0].synthesis.state === "reserved";
    throw new Error("ambiguous provider completion SECRET");
  });
  await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 1); assert.doesNotMatch(f.wiki.status().message, /SECRET/);
  assert.equal(reservationSeen, true, "durable reservation must precede provider dispatch");
  await f.wiki.close(); const restored = f.create(); await restored.enableSynthesis(); await restored.observe(f.doc()); assert.equal(f.calls(), 1);
  assert.equal((await restored.search("采购")).hits[0].synthesis, undefined);
});

test("persisted in-flight reservation is not replayed after crash-like restoration", async (t) => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  const f = await setup(t, async (page) => { started.resolve(); await gate.promise; return factsFor(page); });
  await f.wiki.enableSynthesis(); const observing = f.wiki.observe(f.doc()); await started.promise;
  // A separate reader sees the crash-recovery bytes before the original request
  // completes. No second model call may occur for that retained reservation.
  const restored = f.create(); await restored.enableSynthesis(); await restored.observe(f.doc());
  assert.equal(f.calls(), 1); assert.equal((await restored.search("采购")).hits[0].synthesis, undefined);
  gate.resolve(); await observing; await restored.close();
});

test("disable aborts in-flight model work; late enable and account/connection changes cannot re-enable it", async (t) => {
  const started = Promise.withResolvers();
  const f = await setup(t, async (_page, { signal }) => { started.resolve(); await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); throw new Error("aborted"); });
  await f.wiki.enableSynthesis(); const observing = f.wiki.observe(f.doc()); await started.promise; f.wiki.disableSynthesis(); await observing;
  assert.equal(f.wiki.status().synthesis.enabled, false); assert.equal((await f.wiki.search("采购")).hits[0].synthesis, undefined);
  const gate = Promise.withResolvers(); f.synthesizer.binding = () => gate.promise;
  const enabling = f.wiki.enableSynthesis(); f.wiki.disableSynthesis(); gate.resolve(sessionBinding(f.currentSession)); await assert.rejects(enabling, /已切换/);
});

test("identity/connection binding and six-attempt startup ceiling limit automatic model calls", async (t) => {
  const f = await setup(t); await f.wiki.enableSynthesis();
  f.change({ identity: { ...f.doc().identity, principal: "bob" } }); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 0); assert.equal(f.wiki.status().synthesis.enabled, false);
  f.change({ identity: document().identity }); await f.wiki.enableSynthesis(); f.currentSession.token = "changed";
  await f.wiki.observe(f.doc()); assert.equal(f.calls(), 0); assert.equal(f.wiki.status().synthesis.enabled, false);
  await f.wiki.enableSynthesis();
  for (let i = 0; i < 8; i++) { f.change({ sourceRevision: String(i), contentHash: `h${i}` }); await f.wiki.observe(f.doc()); }
  assert.equal(f.calls(), 6); assert.equal(f.wiki.status().synthesis.remaining, 0);
  f.wiki.disableSynthesis(); await f.wiki.enableSynthesis(); assert.equal(f.wiki.status().synthesis.remaining, 0);
});

test("online checkpoint rebinds opted-in synthesis to the same account without resetting its call budget", async t => {
  const f = await setup(t); await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc());
  const firstExpiry = f.wiki.synthesisPolicy.expiresAt;
  const result = await f.wiki.withSynthesisCheckpoint(async () => {
    f.currentSession.token = "b".repeat(43); f.currentSession.expiresAt = firstExpiry + 60000; return "rotated";
  });
  assert.equal(result, "rotated"); assert.equal(f.wiki.status().synthesis.enabled, true); assert.equal(f.wiki.status().synthesis.remaining, 5);
  assert.notEqual(f.wiki.synthesisPolicy.sessionHash, sessionBinding(session()).sessionHash);
  assert.equal(f.wiki.synthesisPolicy.expiresAt, firstExpiry + 60000); assert.match(f.wiki.status().message, /仍剩 5 次/);
  f.change({ sourceRevision: "2", contentHash: "hash2" }); await f.wiki.observe(f.doc());
  assert.equal(f.calls(), 2); assert.equal(f.wiki.status().synthesis.remaining, 4);
});

test("checkpoint waits for an in-flight paid call and only rotates after its durable result", async t => {
  const started = Promise.withResolvers(), gate = Promise.withResolvers(), trace = [];
  const f = await setup(t, async page => { trace.push("model-start"); started.resolve(); await gate.promise; trace.push("model-result"); return factsFor(page); });
  await f.wiki.enableSynthesis(); const observing = f.wiki.observe(f.doc()); await started.promise;
  const oldToken = f.currentSession.token;
  const checkpoint = f.wiki.withSynthesisCheckpoint(async () => { trace.push("rotate"); f.currentSession.token = "b".repeat(43); f.currentSession.expiresAt += 60000; });
  await Promise.resolve(); assert.deepEqual(trace, ["model-start"]); assert.equal(f.currentSession.token, oldToken);
  gate.resolve(); await Promise.all([observing, checkpoint]);
  assert.deepEqual(trace, ["model-start", "model-result", "rotate"]); assert.equal(f.calls(), 1); assert.equal(f.wiki.status().synthesis.remaining, 5);
  assert.equal((await f.wiki.search("采购")).hits[0].synthesis.state, "complete");
});

test("checkpoint never reenables explicit disable or retries a reserved/failed revision", async t => {
  const started = Promise.withResolvers(), gate = Promise.withResolvers();
  const f = await setup(t, async () => { started.resolve(); await gate.promise; throw new Error("unknown provider completion"); });
  await f.wiki.enableSynthesis(); const observing = f.wiki.observe(f.doc()); await started.promise;
  const checkpoint = f.wiki.withSynthesisCheckpoint(async () => { f.currentSession.token = "b".repeat(43); f.currentSession.expiresAt += 60000; });
  f.wiki.disableSynthesis(); gate.resolve(); await Promise.all([observing, checkpoint]);
  assert.equal(f.wiki.status().synthesis.enabled, false); assert.equal(f.calls(), 1);
  await f.wiki.observe(f.doc()); assert.equal(f.calls(), 1); assert.equal((await f.wiki.search("采购")).hits[0].synthesis, undefined);
});

test("changed CLI identity or invalid successor model binding disables synthesis without failing login rotation", async t => {
  for (const kind of ["identity", "server", "same-token", "shorter"]) {
    const f = await setup(t); await f.wiki.enableSynthesis(); const old = { ...f.wiki.synthesisPolicy };
    const result = await f.wiki.withSynthesisCheckpoint(async () => {
      f.currentSession.token = kind === "same-token" ? f.currentSession.token : "b".repeat(43);
      f.currentSession.expiresAt = kind === "shorter" ? old.expiresAt : old.expiresAt + 60000;
      if (kind === "identity") f.login({ principal: "bob" });
      if (kind === "server") f.currentSession.serverUrl = "http://127.0.0.1:54321";
      return "login-renewed";
    });
    assert.equal(result, "login-renewed"); assert.equal(f.wiki.status().synthesis.enabled, false);
    assert.match(f.wiki.status().message, /手动重新开启/); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 0);
  }
});

test("failed login checkpoint clears synthesis and cannot spend or revive it", async t => {
  const f = await setup(t); await f.wiki.enableSynthesis();
  await assert.rejects(f.wiki.withSynthesisCheckpoint(async () => { throw new Error("renewal failed"); }), /renewal failed/);
  assert.equal(f.wiki.status().synthesis.enabled, false); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 0);
});

test("expired consent is not extended even if a successor login is otherwise valid", async t => {
  const f = await setup(t); await f.wiki.enableSynthesis(); f.wiki.synthesisPolicy.expiresAt = Date.now() - 1;
  await f.wiki.withSynthesisCheckpoint(async () => { f.currentSession.token = "b".repeat(43); f.currentSession.expiresAt = Date.now() + 60000; });
  assert.equal(f.wiki.status().synthesis.enabled, false); assert.equal(f.calls(), 0);
});

test("a GLM synthesizer asks for GLM, binds consent to it, and accepts only a GLM answer", async () => {
  const page = evidencePage(document(), 1000), auth = session(), calls = [];
  let answered = "GLM-5.3";
  const client = new GatewayWikiSynthesizer({ model: "GLM-5.3", getSession: async () => auth, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return Response.json(response(page, { model: answered })); } });
  const binding = await client.binding(); assert.equal(binding.model, "GLM-5.3"); assert.deepEqual(binding, sessionBinding(auth, "GLM-5.3"));
  const result = await client.generate(page, { binding });
  assert.equal(result.model, "GLM-5.3"); assert.equal(result.facts[0].text, "首轮仅面向采购组。");
  const body = JSON.parse(calls[0].body); assert.equal(body.model, "GLM-5.3"); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false); assert.equal(body.stream, false); assert.equal(body.max_output_tokens, 8192);
  answered = "MiniMax-M3"; await assert.rejects(client.generate(page, { binding }), /归纳失败/); assert.equal(calls.length, 2, "no retry");
  // Consent given for one model is not consent for another: refused before any request.
  await assert.rejects(client.generate(page, { binding: sessionBinding(auth, "MiniMax-M3") }), /连接已变化/); assert.equal(calls.length, 2);
  assert.equal((await new GatewayWikiSynthesizer({ getSession: async () => auth }).binding()).model, "MiniMax-M3");
  for (const model of ["gpt-5", "", null]) assert.throws(() => new GatewayWikiSynthesizer({ getSession: async () => auth, model }), /Unsupported chat model/);
});

// GLM-5.3 reasons inside max_output_tokens: live on 2026-09-11/12 the smoke's
// 103-character source used 1851 total tokens on GLM against 840 on MiniMax, so
// 2400 leaves a real page no room and ends "incomplete" after the call was billed.
test("each model gets its own synthesis budget: MiniMax 2400 tokens and 90 s, GLM 8192 tokens and 180 s; an explicit timeout still wins", async t => {
  const page = evidencePage(document(), 1000);
  for (const [model, tokens, timeoutMs, override] of [["MiniMax-M3", 2400, 90_000], ["GLM-5.3", 8192, 180_000], ["GLM-5.3", 8192, 25, 25]]) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let body, aborted = false; const dispatched = Promise.withResolvers();
    const client = new GatewayWikiSynthesizer({ model, ...(override ? { timeoutMs: override } : {}), getSession: async () => session(), fetchImpl: (_url, init) => { body = JSON.parse(init.body); dispatched.resolve();
      return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("SECRET provider error")); }, { once: true })); } });
    const settled = assert.rejects(client.generate(page, { binding: await client.binding() }), error => /取消或超时/.test(error.message) && !error.message.includes("SECRET"));
    await dispatched.promise; assert.equal(body.max_output_tokens, tokens, model);
    t.mock.timers.tick(timeoutMs - 1); assert.equal(aborted, false, `${model} must not give up before ${timeoutMs} ms`);
    t.mock.timers.tick(1); assert.equal(aborted, true, `${model} gives up at ${timeoutMs} ms`); await settled;
    t.mock.timers.reset();
  }
});

// The gateway answers 400 to a max_output_tokens above its own cap, so each
// budget must fit the route the server builds for that model (32768 on GLM).
test("each route's real gateway accepts its model's synthesis budget and forwards it as sent", async t => {
  const page = evidencePage(document(), 1000);
  for (const env of [{ MINIMAX_API_KEY: "synthetic-only-key" }, { IDOU_MODEL_PROVIDER: "litellm", IDOU_LITELLM_MODEL: "volc-agent", IDOU_LITELLM_API_KEY: "synthetic-only-key" }]) {
    const config = await loadChatModelConfig(env), upstream = [], sessions = new SessionRegistry(), issued = sessions.issue({ tenantId: "t", userId: "u", deviceId: "d" });
    // The upstream is this stub, never MiniMax or a proxy; it answers in its own model name.
    const gateway = createModelGateway({ ...config, sessions, fetchImpl: async (_url, init) => { upstream.push(JSON.parse(init.body)); return Response.json(response(page, { model: config.upstreamModel })); } });
    gateway.listen(0, "127.0.0.1"); await once(gateway, "listening"); t.after(() => { gateway.close(); gateway.closeAllConnections(); });
    const client = new GatewayWikiSynthesizer({ model: config.model, getSession: async () => ({ token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${gateway.address().port}` }) });
    assert.equal((await client.generate(page, { binding: await client.binding() })).model, config.model);
    assert.equal(upstream.length, 1); assert.equal(upstream[0].max_output_tokens, { "MiniMax-M3": 2400, "GLM-5.3": 8192 }[config.model]);
  }
});

test("a gateway enforcing another model is reported as a mismatch without its body or a retry", async () => {
  const page = evidencePage(document(), 1000); let calls = 0;
  const client = new GatewayWikiSynthesizer({ model: "GLM-5.3", getSession: async () => session(), fetchImpl: async () => { calls++;
    return new Response(JSON.stringify({ error: { code: "model_not_allowed", message: "model_not_allowed", request_id: "SECRET" } }), { status: 403, headers: { "content-type": "application/json" } }); } });
  await assert.rejects(client.generate(page, { binding: await client.binding() }), error => /不一致，请重新连接/.test(error.message) && /不会自动重试/.test(error.message) && !error.message.includes("SECRET"));
  assert.equal(calls, 1);
});

test("a GLM desktop records GLM on the reservation and the verified synthesis", async (t) => {
  let reserved;
  const f = await setup(t, async (page) => { reserved = (await f.stored())[0].synthesis; return factsFor(page); }, { model: "GLM-5.3" });
  await f.wiki.enableSynthesis(); assert.equal(f.wiki.status().synthesis.model, "GLM-5.3");
  await f.wiki.observe(f.doc()); assert.equal(f.calls(), 1);
  assert.deepEqual({ state: reserved.state, model: reserved.model }, { state: "reserved", model: "GLM-5.3" });
  assert.equal((await f.stored())[0].synthesis.model, "GLM-5.3");
  const hit = (await f.wiki.search("采购")).hits[0]; assert.equal(hit.synthesis.model, "GLM-5.3"); assert.equal(hit.synthesis.state, "complete");
  f.wiki.disableSynthesis(); assert.equal(f.wiki.status().synthesis.model, null);
});

test("a synthesis made by one model is kept, never discarded or paid for again, by a desktop on the other", async (t) => {
  for (const [made, now] of [["GLM-5.3", "MiniMax-M3"], ["MiniMax-M3", "GLM-5.3"]]) {
    const f = await setup(t, undefined, { model: made });
    await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 1);
    await f.wiki.close(); f.setModel(now);
    const restored = f.create(); await restored.enableSynthesis(); assert.equal(restored.status().synthesis.model, now);
    await restored.observe(f.doc()); await restored.observe(f.doc());
    assert.equal(f.calls(), 1, `${now} must not rebill a revision ${made} already summarised`);
    const hit = (await restored.search("采购")).hits[0];
    assert.equal(hit.synthesis.state, "complete"); assert.equal(hit.synthesis.model, made); assert.equal(hit.synthesis.facts[0].text, "首轮仅面向采购组。");
    assert.equal((await f.stored())[0].synthesis.model, made);
    // A new revision is new work, for the model in force now.
    f.change({ sourceRevision: "2", contentHash: "hash2" }); await restored.observe(f.doc()); assert.equal(f.calls(), 2);
    assert.equal((await f.stored())[0].synthesis.model, now);
    await restored.close();
  }
});

test("a failed or interrupted attempt under one model is not retried by the other", async (t) => {
  const f = await setup(t, async () => { throw new Error("ambiguous provider completion"); }, { model: "GLM-5.3" });
  await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 1);
  assert.deepEqual((({ state, model }) => ({ state, model }))((await f.stored())[0].synthesis), { state: "failed", model: "GLM-5.3" });
  await f.wiki.close(); f.setModel("MiniMax-M3");
  const restored = f.create(); await restored.enableSynthesis(); await restored.observe(f.doc());
  assert.equal(f.calls(), 1); assert.equal((await restored.search("采购")).hits[0].synthesis, undefined);
  await restored.close();
});

test("the server switching model after consent turns synthesis off before anything is reserved or billed", async (t) => {
  const f = await setup(t); await f.wiki.enableSynthesis(); f.setModel("GLM-5.3");
  await f.wiki.observe(f.doc());
  assert.equal(f.calls(), 0); assert.equal(f.wiki.status().synthesis.enabled, false); assert.equal((await f.stored())[0].synthesis, undefined);
  // Consent for the new model is a fresh, explicit opt-in.
  await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 1); assert.equal((await f.stored())[0].synthesis.model, "GLM-5.3");
});

test("an online renewal onto another model is not adopted", async (t) => {
  const f = await setup(t); await f.wiki.enableSynthesis(); const old = { ...f.wiki.synthesisPolicy };
  const result = await f.wiki.withSynthesisCheckpoint(async () => { f.currentSession.token = "b".repeat(43); f.currentSession.expiresAt = old.expiresAt + 60000; f.setModel("GLM-5.3"); return "renewed"; });
  assert.equal(result, "renewed"); assert.equal(f.wiki.status().synthesis.enabled, false); assert.match(f.wiki.status().message, /手动重新开启/);
  await f.wiki.observe(f.doc()); assert.equal(f.calls(), 0);
});

test("a synthesizer naming no model is the MiniMax one it predates; one naming an unknown model is refused", async (t) => {
  const f = await setup(t); f.synthesizer.binding = async () => { const { model: _model, ...legacy } = sessionBinding(f.currentSession); return legacy; };
  await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc()); assert.equal(f.calls(), 1); assert.equal((await f.stored())[0].synthesis.model, "MiniMax-M3");
  const g = await setup(t); g.synthesizer.binding = async () => ({ ...sessionBinding(g.currentSession), model: "gpt-5" });
  await assert.rejects(g.wiki.enableSynthesis(), /开启归纳需要/); assert.equal(g.wiki.status().synthesis.enabled, false);
});

test("a gateway refusing the agreed model turns synthesis off after one refused page, without replaying it", async (t) => {
  const f = await setup(t); let calls = 0;
  f.wiki.synthesizer = new GatewayWikiSynthesizer({ getSession: async () => f.currentSession, fetchImpl: async () => { calls++;
    return new Response(JSON.stringify({ error: { code: "model_not_allowed", message: "model_not_allowed" } }), { status: 403, headers: { "content-type": "application/json" } }); } });
  await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc());
  assert.equal(calls, 1); assert.equal(f.wiki.status().synthesis.enabled, false); assert.match(f.wiki.status().message, /不一致，请重新连接/);
  // The gateway refuses before its upstream, so nothing was billed: the page is
  // released rather than kept "failed", and is summarised only after a fresh opt-in.
  assert.equal((await f.stored())[0].synthesis, undefined);
  await f.wiki.observe(f.doc()); f.change({ sourceRevision: "2", contentHash: "hash2" }); await f.wiki.observe(f.doc()); assert.equal(calls, 1);
});
