import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ScheduleClient, ScheduleHttpError } from "../src/application/schedule-client.js";

const SESSION = { token: "T".repeat(43), serverUrl: "http://127.0.0.1:3041" };

function client({ reply, session = SESSION } = {}) {
  const sent = [];
  const made = new ScheduleClient({ session: async () => session,
    fetchImpl: async (url, options) => {
      sent.push({ url, options, body: JSON.parse(options.body) });
      const answer = typeof reply === "function" ? reply(sent.length) : reply ?? { status: 200, json: { ok: true } };
      if (answer.throws) throw new Error("boom");
      const text = answer.text ?? JSON.stringify(answer.json ?? {});
      return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200,
        headers: new Map([["content-type", answer.contentType ?? "application/json"]]),
        body: answer.noBody ? null : Readable.toWeb(Readable.from([Buffer.from(text)])) };
    } });
  return { client: made, sent };
}

test("each operation is one POST to its own route, with the session's bearer", async () => {
  const { client: made, sent } = client({ reply: { json: { schedules: [] } } });
  await made.list();
  await made.create({ title: "每天汇总" });
  await made.updateResources("abc", [{ kind: "chat", id: "oc_fixture" }], 1);
  await made.setState("abc", "paused");
  await made.remove("abc");
  await made.runs();
  assert.deepEqual(sent.map((call) => call.url.replace(SESSION.serverUrl, "")),
    ["/v1/schedules", "/v1/schedules/create", "/v1/schedules/resources", "/v1/schedules/state", "/v1/schedules/delete", "/v1/schedules/runs"]);
  assert.ok(sent.every((call) => call.options.method === "POST"));
  assert.ok(sent.every((call) => call.options.headers.authorization === `Bearer ${SESSION.token}`));
  assert.deepEqual(sent[2].body, { id: "abc", resources: [{ kind: "chat", id: "oc_fixture" }], expectedRevision: 1 });
  assert.deepEqual(sent[3].body, { id: "abc", state: "paused" });
});

test("a refusal is passed through in the words the server used", async () => {
  // The service answers in the person's own language; turning that into an HTTP
  // status would leave them with a number to go and look up.
  const { client: made } = client({ reply: { status: 400, json: { error: "定时任务需要一个名称" } } });
  await assert.rejects(() => made.create({}), (error) =>
    error instanceof ScheduleHttpError && error.status === 400 && error.message === "定时任务需要一个名称");
});

test("a server without scheduled tasks says what to turn on, not just 404", async () => {
  const { client: made } = client({ reply: { status: 404, contentType: "text/html", text: "<html>" } });
  await assert.rejects(() => made.list(), /IDOU_SCHEDULED_TASKS=1/);
});

test("a broken connection is an unknown outcome, never a silent retry", async () => {
  // A create that timed out may well have been recorded. Retrying would give the
  // person two schedules where they asked for one.
  const { client: made, sent } = client({ reply: { throws: true } });
  await assert.rejects(() => made.create({ title: "每天汇总" }), /结果未知[\s\S]*刷新列表确认/);
  assert.equal(sent.length, 1, "it was attempted exactly once");
});

test("a response that is not JSON, or is far too large, is refused rather than parsed", async () => {
  const notJson = client({ reply: { contentType: "text/plain", text: "ok" } });
  await assert.rejects(() => notJson.client.list(), /异常响应/);

  const huge = client({ reply: { text: "x".repeat(300 * 1024) } });
  await assert.rejects(() => huge.client.list(), /超限/);

  const garbled = client({ reply: { text: "not json" } });
  await assert.rejects(() => garbled.client.list(), /响应无效/);
});

test("without a connection it says to sign in rather than calling nothing", async () => {
  const { client: made, sent } = client({ session: null });
  await assert.rejects(() => made.list(), /先登录/);
  assert.equal(sent.length, 0);
});

test("authorizing and revoking are their own routes, carrying no token in the body", async () => {
  const { client: made, sent } = client({ reply: { json: { authorized: true } } });
  await made.authorize();
  await made.revoke();
  await made.consent();
  assert.deepEqual(sent.map((call) => call.url.replace(SESSION.serverUrl, "")),
    ["/v1/schedules/authorize", "/v1/schedules/revoke", "/v1/schedules/consent"]);
  // The identity is the bearer already presented; a token in a body is a token
  // in a log.
  assert.ok(sent.every((call) => !JSON.stringify(call.body).includes(SESSION.token)));
});

test("a run record is set aside, deleted and filtered through routes of its own", async () => {
  const { client: made, sent } = client({ reply: { json: { runs: [] } } });
  await made.runs(undefined, undefined, "shelved");
  await made.runs();
  await made.shelveRun("r1", true);
  await made.deleteRun("r1");
  assert.deepEqual(sent.map((call) => [call.url.replace(SESSION.serverUrl, ""), call.body]), [
    ["/v1/schedules/runs", { filter: "shelved" }],
    ["/v1/schedules/runs", {}],
    ["/v1/schedules/runs/shelve", { runId: "r1", shelved: true }],
    ["/v1/schedules/runs/delete", { runId: "r1" }],
  ]);
});

// A desktop newer than its server: scheduled tasks are on, the route is just
// not there yet. "Turn scheduled tasks on" would send someone to the wrong fix.
test("a server older than these routes is named as older, not as turned off", async () => {
  const { client: made } = client({ reply: { status: 404, contentType: "text/html", text: "<html>" } });
  for (const attempt of [() => made.shelveRun("r1", true), () => made.deleteRun("r1")]) {
    await assert.rejects(attempt, (error) => /服务端版本较旧/.test(error.message) && !/IDOU_SCHEDULED_TASKS/.test(error.message));
  }
});

// After the server restarted (every deploy), it knows no session: it answers 401
// session_expired_or_invalid before doing anything. The client signs back in
// through `recover` and sends the same request once more, so the person's click
// is not lost; the raw code is never what they read.
test("a request refused for a session the server no longer knows signs back in and is sent once more", async () => {
  const OLD = { token: "O".repeat(43), serverUrl: "http://127.0.0.1:3041" }, NEW = { ...OLD, token: "N".repeat(43) };
  const unknown = { status: 401, json: { error: "session_expired_or_invalid" } };
  const setupRecovering = (reply, recover) => {
    let current = OLD; const sent = [], asked = [];
    const made = new ScheduleClient({ session: async () => current,
      recover: recover === null ? null : async (token) => { asked.push(token); const ok = await recover(); if (ok) current = NEW; return ok; },
      fetchImpl: async (url, options) => {
        sent.push(options.headers.authorization);
        const answer = reply(sent.length);
        return { ok: answer.status < 400, status: answer.status, headers: new Map([["content-type", "application/json"]]),
          body: Readable.toWeb(Readable.from([Buffer.from(JSON.stringify(answer.json))])) };
      } });
    return { made, sent, asked };
  };

  const recovered = setupRecovering((n) => (n === 1 ? unknown : { status: 200, json: { runId: "r1", started: true } }), async () => true);
  assert.deepEqual(await recovered.made.runNow("abc"), { runId: "r1", started: true });
  assert.deepEqual(recovered.asked, [OLD.token], "recover is told which token was refused");
  assert.deepEqual(recovered.sent, [`Bearer ${OLD.token}`, `Bearer ${NEW.token}`], "sent once more, with the new session");

  for (const [what, reply, recover, sends] of [
    ["the sign-in did not come back", () => unknown, async () => false, 1],
    ["no way to sign back in", () => unknown, null, 1],
    ["still refused after signing in", () => unknown, async () => true, 2],
  ]) {
    const f = setupRecovering(reply, recover);
    await assert.rejects(f.made.runNow("abc"), (error) => {
      assert.ok(error instanceof ScheduleHttpError, what);
      assert.equal(error.status, 401, what);
      assert.match(error.message, /登录已失效.*重新登录/, what);
      assert.doesNotMatch(error.message, /session_expired_or_invalid/, what);
      return true;
    });
    assert.equal(f.sent.length, sends, `${what}: never more than one more try`);
  }

  // Any other refusal is the service's own words, and nothing is sent twice.
  const other = setupRecovering(() => ({ status: 403, json: { error: "verified_login_required" } }), async () => true);
  await assert.rejects(other.made.runNow("abc"), /verified_login_required/);
  assert.deepEqual([other.sent.length, other.asked.length], [1, 0]);
});
