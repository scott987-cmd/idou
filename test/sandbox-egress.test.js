import test from "node:test";
import assert from "node:assert/strict";
import { SandboxEgressService, EGRESS_ROUTE } from "../src/control-plane/sandbox-egress.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const SCHEDULE = { tenant: "tenant-a", id: "sched-1", owner: "person-a" };
const WHO = { tenantId: "tenant-a", userId: "person-a" };

// A response object that records what was written, standing in for http.ServerResponse.
function response() {
  const out = { status: 0, headers: {}, body: "", headersSent: false, destroyed: false, listeners: {} };
  out.writeHead = (status, headers) => { out.status = status; out.headers = headers ?? {}; out.headersSent = true; };
  out.end = (body) => { out.body = body === undefined ? "" : String(body); };
  out.once = (event, fn) => { out.listeners[event] = fn; };
  out.off = () => {};
  out.destroy = () => { out.destroyed = true; };
  return out;
}
const request = (headers = {}, { method = "GET", url = EGRESS_ROUTE } = {}) => ({ method, url, headers, resume() {} });

function service({ fetchImpl, current, audit, schedules, sessions, controlPlaneOrigin } = {}) {
  const calls = [];
  const grant = { token: Buffer.from("real-feishu-credential"), controller: new AbortController() };
  const sourceAccess = { feishu: SAAS_FEISHU, current: current ?? (() => ({ who: WHO, grant })) };
  const egress = new SandboxEgressService({ sourceAccess, audit, schedules, sessions, controlPlaneOrigin,
    fetchImpl: fetchImpl ?? (async (url, options) => {
      calls.push({ url, authorization: options.headers.authorization });
      return { ok: true, status: 200, redirected: false, body: {}, headers: new Map([["content-type", "application/json"]]),
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ data: { items: [] } })).buffer };
    }) });
  return { egress, calls, grant };
}
const READ = "/open-apis/im/v1/chats?page_size=20";

test("a run token buys reads during the run, and the credential never leaves the server", async () => {
  const { egress, calls } = service();
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const res = response();
  assert.equal(await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res), true);
  assert.equal(res.status, 200);
  assert.match(res.body, /items/);
  assert.equal(calls[0].url, `https://open.feishu.cn${READ}`);
  assert.equal(calls[0].authorization, "Bearer real-feishu-credential", "attached here, on the way out");
  assert.ok(!token.includes("real-feishu-credential"), "and nothing the sandbox holds resembles it");
});

test("the token dies with the run and cannot be replayed afterwards", async () => {
  const { egress } = service();
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  egress.close(token);
  const res = response();
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res);
  assert.equal(res.status, 403);
  assert.match(res.body, /sandbox_run_token_invalid/);
});

test("a live token is never held or compared in the clear", async () => {
  const { egress } = service();
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  // Only the digest is kept, so there is no stored copy to leak and no byte of a
  // live token to compare against -- which is why no timing-safe comparison is
  // needed here, rather than one having been forgotten.
  assert.ok(!egress.runs.has(token), "the token itself is not a key");
  assert.equal(egress.runs.size, 1);
  for (const key of egress.runs.keys()) {
    assert.match(key, /^[a-f0-9]{64}$/, "what is stored is a hash");
    assert.notEqual(key, token);
  }
  assert.ok(!JSON.stringify([...egress.runs.values()]).includes(token), "and no entry carries it either");

  // A token of the right shape that was never issued is refused like any other.
  const res = response();
  await egress.handle(request({ "x-mydoubao-run": "A".repeat(43), "x-mydoubao-feishu-path": READ }), res);
  assert.equal(res.status, 403);
  assert.match(res.body, /sandbox_run_token_invalid/);
});

test("a run token that has outlived its window stops working on its own", async () => {
  let at = 1_000_000_000_000;
  const { egress } = service();
  egress.now = () => at;
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 60_000 });
  at += 61_000;
  const res = response();
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res);
  assert.equal(res.status, 403);
});

test("nothing can be written through it, whatever the path says", async () => {
  const { egress, calls } = service();
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = response();
    await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": "/open-apis/im/v1/messages" }, { method }), res);
    assert.equal(res.status, 405, `${method} must be refused`);
  }
  // And a read-shaped request at a write-only endpoint is refused too: the
  // allowlist is what may be reached, not merely which verb is used.
  for (const path of ["/open-apis/docs_ai/v1/documents", "/open-apis/drive/v1/medias/upload_all", "/open-apis/im/v1/messages/x/urgent_app"]) {
    const res = response();
    await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": path }), res);
    assert.equal(res.status, 405, `${path} must be refused`);
  }
  assert.equal(calls.length, 0, "not one of them reached Feishu");
});

test("a path that could be read two ways is refused rather than normalised", async () => {
  const { egress, calls } = service();
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  for (const path of ["", "open-apis/im/v1/chats", "//evil.example.com/open-apis/im/v1/chats",
    "/open-apis/../../etc/passwd", "/open-apis/im/v1/chats\\..", "/open-apis/%2e%2e/admin", "/open-apis/im/v1/chats\n"]) {
    const res = response();
    await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": path }), res);
    assert.ok([400, 405].includes(res.status), `${JSON.stringify(path)} must be refused, got ${res.status}`);
  }
  assert.equal(calls.length, 0);
});

test("a login that lapses mid-run stops the next call and spends the token", async () => {
  let live = true;
  const { egress, calls } = service({ current: () => { if (!live) throw new Error("gone"); return { who: WHO, grant: { token: Buffer.from("c"), controller: new AbortController() } }; } });
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const first = response();
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), first);
  assert.equal(first.status, 200);

  live = false;
  const second = response();
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), second);
  assert.equal(second.status, 403);
  assert.match(second.body, /login_gone/);
  assert.equal(calls.length, 1, "the lapsed call never reached Feishu");
});

test("a run cannot borrow an identity that is not its schedule's owner", async () => {
  const { egress, calls } = service({ current: () => ({ who: { tenantId: "tenant-a", userId: "someone-else" }, grant: { token: Buffer.from("c"), controller: new AbortController() } }) });
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const res = response();
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res);
  assert.equal(res.status, 403);
  assert.match(res.body, /login_mismatch/);
  assert.equal(calls.length, 0);
});

test("a credential rotated mid-flight does not get to return a body", async () => {
  let checks = 0;
  const grant = { token: Buffer.from("c"), controller: new AbortController() };
  const { egress } = service({ current: (token, expected) => { checks += 1; if (expected && expected !== grant) throw new Error("rotated"); return { who: WHO, grant }; } });
  // The second check passes the grant object back; a service that rotated it
  // would fail there, after the fetch and before anything is written out.
  const ok = response();
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), ok);
  assert.equal(ok.status, 200);
  assert.equal(checks, 2, "checked before the call and again after it");
});

test("a browser is never the caller, and only this route is claimed", async () => {
  const { egress } = service();
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const res = response();
  await egress.handle(request({ origin: "https://example.com", "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res);
  assert.equal(res.status, 403);
  assert.equal(await egress.handle(request({}, { url: "/healthz" }), response()), false, "another route is left to the next service");
});

test("one run cannot make unlimited calls, and the audit says what it reached without what it read", async () => {
  const seen = [];
  const { egress } = service({ audit: (entry) => seen.push(entry) });
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  for (let index = 0; index < 200; index += 1) await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), response());
  const over = response();
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), over);
  assert.equal(over.status, 429);
  assert.equal(seen.length, 200);
  assert.equal(seen[0].path, "/open-apis/im/v1/chats", "the query string is not kept");
  assert.equal(seen[0].runId, "run-1");
  assert.ok(seen[0].scheduleHash && !seen[0].scheduleHash.includes("sched-1"), "the schedule is hashed, not named");
  assert.ok(!JSON.stringify(seen[0]).includes("items"), "and nothing that was read is recorded");
});

// R6: a run's authority is asked about again on every call, not decided once.
// The store that knows whether a schedule still exists was injected into this
// service and never consulted, so the run entry's snapshot was the only word.
const living = (state) => ({ get: (who, id) => (state.gone || id !== SCHEDULE.id ? null : { id, suspendedAt: state.suspended ?? null }) });

test("deleting a schedule stops the run that is still going", async () => {
  // Before this it kept reading the person's documents until it finished. The
  // decision to delete it had no effect on the thing it was deleting.
  const state = {};
  const { egress } = service({ schedules: living(state) });
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const read = async () => { const res = response(); await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res); return res; };

  assert.equal((await read()).status, 200, "it works while the schedule is there");
  state.gone = true;
  const after = await read();
  assert.equal(after.status, 403);
  assert.match(after.body, /schedule_revoked/);
});

test("suspending a schedule stops it too, without waiting for the run to end", async () => {
  const state = {};
  const { egress } = service({ schedules: living(state) });
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const read = async () => { const res = response(); await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res); return res; };

  assert.equal((await read()).status, 200);
  state.suspended = 1_700_000_000_000;
  const after = await read();
  assert.equal(after.status, 403);
  assert.match(after.body, /schedule_suspended/);
});

test("with no store to ask, a run behaves exactly as it did before", async () => {
  // The check must not become a way for a missing dependency to stop every run.
  const { egress } = service();
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const res = response();
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res);
  assert.equal(res.status, 200);
});

test("the model route has a budget of its own, not only a concurrency limit", async () => {
  // Every call on this route is a paid one. Concurrency was capped and the count
  // was not, so a task caught in a loop could spend without any limit at all.
  // The model route needs somewhere to forward to and a minted model token, so
  // the two it actually depends on are supplied rather than stubbed away.
  const { egress } = service({ controlPlaneOrigin: "http://127.0.0.1:9999",
    sessions: { issueForSandboxRun: () => ({ token: "model-turn-token" }) } });
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const ask = async () => {
    const res = response();
    await egress.handle(Object.assign(request({ "x-mydoubao-run": token, "content-type": "application/json" },
      { method: "POST", url: "/v1/responses" }), { [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); } }), res);
    return res.status;
  };
  let last = 0;
  for (let attempt = 0; attempt < 121; attempt += 1) last = await ask();
  assert.equal(last, 429, "the 121st call is refused");
});

// A task's own limit is the one enforced, the refusal that ends a run is in the
// audit, and the runner can ask afterwards whether that is what happened.
test("a task's model limit is enforced, audited when it refuses, and reported to the runner", async () => {
  const seen = [];
  const { egress } = service({ controlPlaneOrigin: "http://127.0.0.1:9999", audit: (entry) => seen.push(entry),
    sessions: { issueForSandboxRun: () => ({ token: "model-turn-token" }) },
    fetchImpl: async () => ({ ok: true, status: 200, redirected: false, body: null, headers: new Map([["content-type", "text/event-stream"]]) }) });
  const token = egress.open({ parentToken: "session", schedule: { ...SCHEDULE, capability: { limits: { modelCalls: 3 } } }, runId: "run-1", ttlMs: 600_000 });
  const ask = async () => {
    const res = response();
    await egress.handle(Object.assign(request({ "x-mydoubao-run": token, "content-type": "application/json" },
      { method: "POST", url: "/v1/responses" }), { [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); } }), res);
    return res.status;
  };
  assert.deepEqual([await ask(), await ask(), await ask()], [200, 200, 200]);
  assert.deepEqual(egress.usage(token), { modelCalls: 3, modelBudget: 3, modelBudgetSpent: false });
  assert.equal(await ask(), 429, "the fourth is refused");
  assert.deepEqual(egress.usage(token), { modelCalls: 4, modelBudget: 3, modelBudgetSpent: true });
  assert.deepEqual(seen.map((entry) => [entry.path, entry.status, entry.modelCalls]), [["/v1/responses", 200, 1], ["/v1/responses", 200, 2], ["/v1/responses", 200, 3], ["/v1/responses", 429, 4]]);
  egress.close(token);
  assert.equal(egress.usage(token), null, "a closed run has no usage to report");
  assert.equal(egress.usage(undefined), null);
});

// With the tasks in the shared database, asking about a run is a query, and a
// model answer streams in hundreds of pieces. It is asked again at most once a
// second while it streams -- so deleting the task still cuts the answer off,
// within that second, and the database is not read for every piece.
test("a task deleted while an answer streams is cut off within a second, without a store read for every piece", async () => {
  let clock = 1_700_000_000_000, reads = 0, gone = false;
  const schedules = { get: async (who, id) => { reads += 1; return gone ? null : { id, suspendedAt: null }; } };
  const body = { async *[Symbol.asyncIterator]() {
    for (let index = 0; index < 60; index += 1) { clock += 100; if (index === 20) gone = true; yield Buffer.from(`data: ${index}\n\n`); }
  } };
  const egress = new SandboxEgressService({ sourceAccess: { feishu: SAAS_FEISHU, current: () => ({ who: WHO, grant: { token: Buffer.from("x"), controller: new AbortController() } }) },
    schedules, sessions: { issueForSandboxRun: () => ({ token: "model-turn-token" }) }, controlPlaneOrigin: "http://127.0.0.1:9999", now: () => clock,
    fetchImpl: async () => ({ ok: true, status: 200, redirected: false, body, headers: new Map([["content-type", "text/event-stream"]]) }) });
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const res = Object.assign(response(), { pieces: 0 });
  res.write = () => { res.pieces += 1; return true; };
  await egress.handle(Object.assign(request({ "x-mydoubao-run": token, "content-type": "application/json" }, { method: "POST", url: "/v1/responses" }),
    { [Symbol.asyncIterator]: async function* () { yield Buffer.from("{}"); } }), res);
  assert.equal(res.destroyed, true, "the answer is cut off, not finished");
  assert.ok(res.pieces >= 20 && res.pieces <= 31, `stopped within a second of the deletion (after ${res.pieces} pieces)`);
  // Three around the call itself, then one a second of streaming: six, where
  // asking once a piece would have been over thirty.
  assert.ok(reads <= 6, `asked ${reads} times, not once a piece`);
});

test("a store that cannot be reached refuses the call as unavailable, never lets it through", async () => {
  const { egress } = service({ schedules: { get: async () => { throw new Error("connection terminated"); } } });
  const token = egress.open({ parentToken: "session", schedule: SCHEDULE, runId: "run-1", ttlMs: 600_000 });
  const res = response();
  await egress.handle(request({ "x-mydoubao-run": token, "x-mydoubao-feishu-path": READ }), res);
  assert.equal(res.status, 503);
  assert.match(res.body, /sandbox_egress_schedule_unavailable/);
});
