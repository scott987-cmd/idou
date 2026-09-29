import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { SandboxEgressService, CLI_PROXY_ROUTE, MODEL_ROUTE } from "../src/control-plane/sandbox-egress.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const SCHEDULE = { tenant: "tenant-a", id: "sched-1", owner: "person-a" };
const WHO = { tenantId: "tenant-a", userId: "person-a" };
const PARENT = "parent-session-token";
const MODEL_TOKEN = "M".repeat(43);

function response() {
  const out = { status: 0, headers: {}, body: "", headersSent: false, destroyed: false, listeners: {} };
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? {}; out.headersSent = true; };
  out.write = (chunk) => { out.body += Buffer.from(chunk).toString("utf8"); return true; };
  out.end = (chunk) => { if (chunk !== undefined) out.body += Buffer.from(chunk).toString("utf8"); };
  out.once = (event, fn) => { out.listeners[event] = fn; };
  out.off = () => {}; out.destroy = () => { out.destroyed = true; };
  return out;
}
// A request that is also an async iterable, the way the service reads bodies.
function request(url, headers = {}, { method = "POST", body = "" } = {}) {
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(stream, { method, url, headers, resume() {} });
}

function service({ current, upstream, sessions = { issueForSandboxRun: () => ({ token: MODEL_TOKEN }) } } = {}) {
  const sent = [];
  const grant = { token: Buffer.from("real-feishu-credential"), controller: new AbortController() };
  const made = new SandboxEgressService({
    sourceAccess: { feishu: SAAS_FEISHU, current: current ?? (() => ({ who: WHO, grant })) },
    sessions, controlPlaneOrigin: "https://control.invalid",
    fetchImpl: async (url, options) => {
      sent.push({ url, headers: options.headers, method: options.method, body: options.body?.toString?.("utf8") });
      const answer = upstream?.(url) ?? {};
      return { status: answer.status ?? 200, redirected: false,
        headers: new Map(Object.entries(answer.headers ?? { "content-type": "application/json" })),
        body: Readable.from([Buffer.from(answer.text ?? "{\"ok\":true}")]) };
    } });
  return { egress: made, sent };
}
const open = (egress) => egress.open({ parentToken: PARENT, schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });

test("the CLI route swaps the run token for the person's own session", async () => {
  const { egress, sent } = service();
  const token = open(egress);
  const res = response();
  assert.equal(await egress.handle(request(CLI_PROXY_ROUTE, { "x-mydoubao-run": token,
    "x-mydoubao-feishu-target": "https://open.feishu.cn", "x-mydoubao-feishu-path": "/open-apis/im/v1/chats",
    "content-type": "application/json" }, { body: "{}" }), res), true);
  assert.equal(res.status, 200);
  const [call] = sent;
  assert.equal(call.url, `https://control.invalid${CLI_PROXY_ROUTE}`);
  assert.equal(call.headers.authorization, `Bearer ${PARENT}`, "the upstream sees the session, never the run token");
  assert.ok(!JSON.stringify(call.headers).includes(token), "and the run token does not travel onward");
  // Sent by an image from before the rename, carried on under today's name, once.
  assert.equal(call.headers["x-idou-feishu-path"], "/open-apis/im/v1/chats", "the sidecar's own headers are carried");
  assert.equal(call.headers["x-mydoubao-feishu-path"], undefined, "and not under both names, which could say two things");
});

test("the CLI route takes the run token as a Bearer, the way the sidecar sends it", async () => {
  // The sidecar being reused inside the sandbox talks to the control plane's CLI
  // proxy with `Authorization: Bearer <token>`. Accepting that here is what lets
  // it be reused without editing a line of it -- and the swap still happens, so
  // what leaves is the person's session, not the run token that arrived.
  const { egress, sent } = service();
  const token = open(egress);
  const res = response();
  await egress.handle(request(CLI_PROXY_ROUTE, { authorization: `Bearer ${token}`,
    "x-mydoubao-feishu-path": "/open-apis/im/v1/chats" }, { body: "{}" }), res);
  assert.equal(res.status, 200);
  assert.equal(sent[0].headers.authorization, `Bearer ${PARENT}`, "swapped, not passed through");

  // A Bearer that is not a live run token is still refused.
  const bogus = response();
  await egress.handle(request(CLI_PROXY_ROUTE, { authorization: `Bearer ${"Z".repeat(43)}`,
    "x-mydoubao-feishu-path": "/open-apis/im/v1/chats" }, { body: "{}" }), bogus);
  assert.equal(bogus.status, 403);
  assert.equal(sent.length, 1, "and it never reached the control plane");
  // Said in Feishu's own envelope: the CLI's SDK parses nothing else, and a bare
  // {"error": ...} reached the task as "SDK returned an invalid JSON response".
  const said = JSON.parse(bogus.body);
  assert.equal(said.code, 403);
  assert.match(said.msg, /^sandbox_/);
  assert.equal("error" in said, false, "`error` would have to be an object for the SDK");
});

test("the model route also takes the run token as a Bearer, the way Codex sends it", async () => {
  // Codex's auth command prints the run token and Codex presents it as a
  // Bearer. Reading only the header meant every real model call came back
  // 403 sandbox_run_token_required.
  const { egress, sent } = service();
  const token = open(egress);
  const res = response();
  await egress.handle(request(MODEL_ROUTE, { authorization: `Bearer ${token}`, "content-type": "application/json" },
    { body: JSON.stringify({ model: "glm", input: [] }) }), res);
  assert.equal(res.status, 200);
  assert.equal(sent[0].headers.authorization, `Bearer ${MODEL_TOKEN}`, "and is still swapped for the run's own credential");

  // The model route is read by Codex, not the CLI, and keeps the shape it had.
  const bogus = response();
  await egress.handle(request(MODEL_ROUTE, { authorization: `Bearer ${"Z".repeat(43)}`, "content-type": "application/json" },
    { body: JSON.stringify({ model: "glm", input: [] }) }), bogus);
  assert.equal(bogus.status, 403);
  assert.equal(typeof JSON.parse(bogus.body).error, "string");
});

test("the model route uses the run's own credential, not the person's session", async () => {
  const { egress, sent } = service();
  const token = open(egress);
  const res = response();
  await egress.handle(request(MODEL_ROUTE, { "x-mydoubao-run": token, "content-type": "application/json" },
    { body: JSON.stringify({ model: "glm", input: [] }) }), res);
  assert.equal(res.status, 200);
  const [call] = sent;
  assert.equal(call.headers.authorization, `Bearer ${MODEL_TOKEN}`, "the sandbox credential, so the desktop keeps its own rate-limit bucket");
  assert.notEqual(call.headers.authorization, `Bearer ${PARENT}`);
  assert.equal(call.body, JSON.stringify({ model: "glm", input: [] }), "the body is relayed unchanged");
});

test("a sandbox cannot smuggle its own authorization past the swap", async () => {
  const { egress, sent } = service();
  const token = open(egress);
  await egress.handle(request(CLI_PROXY_ROUTE, { "x-mydoubao-run": token,
    authorization: "Bearer stolen-token", "x-mydoubao-feishu-path": "/open-apis/im/v1/chats" }, { body: "{}" }), response());
  assert.equal(sent[0].headers.authorization, `Bearer ${PARENT}`, "the header the sandbox sent is replaced, not merged");
  assert.ok(!JSON.stringify(sent[0].headers).includes("stolen-token"));
});

test("a run whose login has lapsed is retired at once, on both routes", async () => {
  // The entry carries its own map key so it can be dropped from a path that
  // holds the entry but not the token -- the first version deleted nothing.
  let live = true;
  const { egress, sent } = service({ current: () => { if (!live) throw new Error("gone"); return { who: WHO, grant: { token: Buffer.from("c"), controller: new AbortController() } }; } });
  const token = open(egress);
  live = false;
  const first = response();
  await egress.handle(request(CLI_PROXY_ROUTE, { "x-mydoubao-run": token, "x-mydoubao-feishu-path": "/open-apis/im/v1/chats" }, { body: "{}" }), first);
  assert.equal(first.status, 403);
  assert.match(first.body, /login_gone/);

  const second = response();
  await egress.handle(request(MODEL_ROUTE, { "x-mydoubao-run": token }, { body: "{}" }), second);
  assert.equal(second.status, 403, "the run is gone, not merely refused once");
  assert.match(second.body, /token_invalid/);
  assert.equal(sent.length, 0, "and nothing reached the control plane");
});

test("a body larger than the route's cap is refused before it is buffered", async () => {
  const { egress, sent } = service();
  const token = open(egress);
  const res = response();
  // readBody did not exist at all in the first version of these routes: every
  // call would have thrown ReferenceError, and no existing test touched them.
  await egress.handle(request(MODEL_ROUTE, { "x-mydoubao-run": token }, { body: "x".repeat(2 * 1024 * 1024) }), res);
  assert.equal(res.status, 413);
  assert.match(res.body, /request_too_large/);
  assert.equal(sent.length, 0);
});

test("each route has its own concurrency, so one cannot starve the other", async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { egress } = service();
  // Only the model route is held. Holding every route deadlocked the test: the
  // CLI request below also goes through this fetch, so awaiting it inside the
  // try meant waiting for a release that only happens in the finally -- each
  // waiting on the other. That is what the "promise still pending" failure was,
  // and it had nothing to do with the code under test.
  egress.fetch = async (url) => {
    if (String(url).endsWith(MODEL_ROUTE)) await held;
    return { status: 200, redirected: false, headers: new Map(), body: Readable.from([]) };
  };
  const token = open(egress);
  const busy = Array.from({ length: 4 }, () => egress.handle(request(MODEL_ROUTE, { "x-mydoubao-run": token }, { body: "{}" }), response()));
  // Let the four reach their await before asking for a fifth.
  await new Promise((resolve) => setImmediate(resolve));
  try {
    const overflow = response();
    await egress.handle(request(MODEL_ROUTE, { "x-mydoubao-run": token }, { body: "{}" }), overflow);
    assert.equal(overflow.status, 429, "the model route is full");

    const cli = response();
    await egress.handle(request(CLI_PROXY_ROUTE, { "x-mydoubao-run": token, "x-mydoubao-feishu-path": "/open-apis/im/v1/chats" }, { body: "{}" }), cli);
    assert.notEqual(cli.status, 429, "but Feishu reads still get through");
  } finally {
    release();
    await Promise.all(busy);
  }
});

test("a streamed answer is relayed chunk by chunk, and backpressure is honoured", async () => {
  // A model answer arrives as server-sent events; buffering it would make a task
  // look hung until the last token. The drain branch had no coverage at all --
  // the response stub always claimed the socket was ready.
  const { egress } = service();
  egress.fetch = async () => ({ status: 200, redirected: false,
    headers: new Map([["content-type", "text/event-stream"]]),
    body: Readable.from([Buffer.from("data: one\n\n"), Buffer.from("data: two\n\n"), Buffer.from("data: [DONE]\n\n")]) });
  const token = open(egress);
  const res = response();
  let full = 0;
  res.write = (chunk) => { res.body += Buffer.from(chunk).toString("utf8"); full += 1; return full !== 1; };
  res.once = (event, fn) => { if (event === "drain") setImmediate(fn); else res.listeners[event] = fn; };

  await egress.handle(request(MODEL_ROUTE, { "x-mydoubao-run": token }, { body: "{}" }), res);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream", "the event-stream type survives the relay");
  assert.equal(res.body, "data: one\n\ndata: two\n\ndata: [DONE]\n\n", "every chunk arrives, in order");
  assert.equal(full, 3, "written as three chunks rather than one buffered blob");
});

test("without a control plane configured the routes refuse rather than guess", async () => {
  const bare = new SandboxEgressService({ sourceAccess: { feishu: SAAS_FEISHU, current: () => ({ who: WHO, grant: {} }) } });
  const token = bare.open({ parentToken: PARENT, schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  for (const route of [CLI_PROXY_ROUTE, MODEL_ROUTE]) {
    const res = response();
    await bare.handle(request(route, { "x-mydoubao-run": token }, { body: "{}" }), res);
    assert.equal(res.status, 503, `${route} must refuse`);
  }
});

test("a run with no model credential is told so, rather than reaching the model unauthenticated", async () => {
  const { egress, sent } = service({ sessions: null });
  const token = open(egress);
  const res = response();
  await egress.handle(request(MODEL_ROUTE, { "x-mydoubao-run": token }, { body: "{}" }), res);
  assert.equal(res.status, 403);
  assert.match(res.body, /model_not_available/);
  assert.equal(sent.length, 0);
});

test("only POST reaches the model route", async () => {
  const { egress, sent } = service();
  const token = open(egress);
  for (const method of ["GET", "DELETE", "PUT"]) {
    const res = response();
    await egress.handle(request(MODEL_ROUTE, { "x-mydoubao-run": token }, { method }), res);
    assert.equal(res.status, 405, `${method} must be refused`);
  }
  assert.equal(sent.length, 0);
});
