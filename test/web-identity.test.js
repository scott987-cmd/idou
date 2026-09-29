import assert from "node:assert/strict";
import test from "node:test";
import { REMEMBERED_VERDICT_MS, WEB_IDENTITY, WebIdentityCheck, rememberedVerdict, verdictRecord } from "../src/application/web-identity.js";

const PREFIX = "http://127.0.0.1:3041/auth/feishu/launch?flow=";
const FLOW = "f".repeat(43);

// A control plane that answers `statuses` in order (the last one repeats), a
// browser view that records what was done to it, and a clock that moves only
// when the check waits.
function harness({ statuses = [{ status: "verified", checkedAt: 5 }], begun = null, beginError = null, statusError = null } = {}) {
  let clock = 1_000;
  const calls = { begin: 0, status: 0, opened: [], revealed: 0, closed: 0 };
  const replies = [...statuses];
  const check = new WebIdentityCheck({
    launchPrefix: PREFIX,
    now: () => clock,
    wait: async (ms) => { clock += ms; },
    begin: async () => {
      calls.begin += 1;
      if (beginError) throw beginError;
      return begun ?? { flowId: FLOW, launchUrl: `${PREFIX}${FLOW}`, expiresAt: clock + 180_000 };
    },
    status: async (flowId) => {
      calls.status += 1;
      assert.equal(flowId, FLOW);
      if (statusError) throw statusError;
      return replies.length > 1 ? replies.shift() : replies[0];
    },
    open: async (url) => {
      calls.opened.push(url);
      return { reveal: () => { calls.revealed += 1; }, close: () => { calls.closed += 1; } };
    },
  });
  return { check, calls, advance: (ms) => { clock += ms; } };
}

test("a browser Feishu lets straight through is verified without anyone being asked", async () => {
  const { check, calls } = harness({ statuses: [{ status: "pending", launched: true }, { status: "verified", checkedAt: 42 }] });
  assert.equal(check.snapshot().state, WEB_IDENTITY.UNVERIFIED);
  const result = await check.check();
  assert.deepEqual(result, { state: WEB_IDENTITY.VERIFIED, reason: null, cause: null, checkedAt: 42, needsAttention: false });
  assert.deepEqual(calls.opened, [`${PREFIX}${FLOW}`]);
  assert.equal(calls.revealed, 0);
  assert.equal(calls.closed, 1, "the probe's browser is closed when it is done");
});

test("a browser signed in as someone else is a conflict", async () => {
  const { check, calls } = harness({ statuses: [{ status: "conflict", checkedAt: 7 }] });
  assert.equal((await check.check()).state, WEB_IDENTITY.CONFLICT);
  assert.equal(calls.closed, 1);
});

// Feishu showing a page means a person is needed: a consent screen, or a
// sign-in because the pages are signed out. The check shows it and waits; it
// never acts on the page itself.
test("a page that needs a person is shown to them, once, and the check waits for them", async () => {
  const pending = { status: "pending", launched: true };
  const { check, calls } = harness({ statuses: [pending, pending, pending, pending, pending, pending, { status: "verified", checkedAt: 9 }] });
  const seen = [];
  check.onChange = (value) => seen.push(value);
  const result = await check.check();
  assert.equal(calls.revealed, 1);
  assert.ok(seen.some((value) => value.state === WEB_IDENTITY.CHECKING && value.needsAttention), "the person is told to look");
  assert.equal(result.state, WEB_IDENTITY.VERIFIED);
  assert.equal(result.needsAttention, false);
  assert.equal(calls.closed, 1);
});

test("a check nobody finishes ends unverified, and says why", async () => {
  const { check, calls } = harness({ statuses: [{ status: "pending", launched: true }] });
  const result = await check.check();
  assert.equal(result.state, WEB_IDENTITY.UNVERIFIED);
  assert.equal(result.reason, "核对超时");
  assert.equal(calls.closed, 1);
});

test("a declined page and a failed exchange are unverified, not conflicts", async () => {
  for (const [status, reason] of [["declined", "飞书页面上的授权没有完成"], ["probe_failed", "飞书没有完成这次核对"], ["something-new", "核对没有完成"]]) {
    const { check } = harness({ statuses: [{ status }] });
    const result = await check.check();
    assert.equal(result.state, WEB_IDENTITY.UNVERIFIED, status);
    assert.equal(result.reason, reason, status);
    assert.equal(result.cause, status === "something-new" ? "failed" : status, "and says which, for the caller that decides what next");
  }
});

// The pages signing in again, or the application signing out, while a probe is
// out: its answer describes a state that no longer exists.
test("an answer that arrives after a reset is ignored", async () => {
  const { check, calls } = harness();
  const original = check.status;
  check.status = async (flowId) => { check.reset("reset"); return original(flowId); };
  const result = await check.check();
  assert.equal(result.state, WEB_IDENTITY.UNVERIFIED);
  assert.equal(result.reason, "网页登录状态变了，需要重新核对");
  assert.equal(calls.closed, 1, "and its browser is still closed");
});

test("two callers share one probe", async () => {
  const { check, calls } = harness();
  const [first, second] = await Promise.all([check.check(), check.check()]);
  assert.deepEqual(first, second);
  assert.equal(calls.begin, 1);
  await check.check();
  assert.equal(calls.begin, 2, "a later call starts a new one");
});

// The probe's browser carries the person's Feishu session, so it opens exactly
// the control plane's launch URL for the flow just created, and nothing else.
test("anything but the control plane's own launch URL is never opened", async () => {
  for (const begun of [
    { flowId: FLOW, launchUrl: `https://evil.example/auth/feishu/launch?flow=${FLOW}`, expiresAt: 2_000_000 },
    { flowId: FLOW, launchUrl: `${PREFIX}${"g".repeat(43)}`, expiresAt: 2_000_000 },
    { flowId: "short", launchUrl: `${PREFIX}short`, expiresAt: 2_000_000 },
  ]) {
    const { check, calls } = harness({ begun });
    const result = await check.check();
    assert.equal(result.state, WEB_IDENTITY.UNVERIFIED);
    assert.deepEqual(calls.opened, []);
  }
  assert.throws(() => new WebIdentityCheck({ begin() {}, status() {}, open() {}, launchPrefix: "http://127.0.0.1:3041/elsewhere?flow=" }), /入口地址不合法/);
});

test("a server without the check, or a probe the server has forgotten, is reported as such", async () => {
  const off = harness({ beginError: new Error("飞书授权已失效或未获准（HTTP 403：web_identity_unavailable）") });
  const result = await off.check.check();
  assert.equal(result.reason, "服务端没有开启网页账号核对");
  assert.deepEqual(off.calls.opened, []);
  const forgotten = harness({ statusError: new Error("飞书授权已失效或未获准（HTTP 404：web_identity_unknown）") });
  assert.equal((await forgotten.check.check()).reason, "核对超时");
  assert.equal(forgotten.calls.closed, 1);
});

// Pages that are not signed in to Feishu at all have nothing to verify. The
// desktop holds the check at this state instead of probing, because a probe
// only lays Feishu's own sign-in page over the one the person should scan.
test("signed-out pages are held unverified with their own reason, and nothing is opened", () => {
  const { check, calls } = harness();
  check.reset("signed_out");
  assert.deepEqual({ state: check.snapshot().state, cause: check.snapshot().cause, reason: check.snapshot().reason },
    { state: WEB_IDENTITY.UNVERIFIED, cause: "signed_out", reason: "左侧的飞书还没有登录" });
  assert.deepEqual([calls.begin, calls.opened.length], [0, 0], "holding is not probing");
});

// Feishu shows the person its page on every probe, so a verdict that did not
// outlive the process put that page in front of them after every restart
// (2026-09-24). A kept verdict is bound to the pages' session digest.
test("a kept verdict is used again only for the very session it was reached with, and only for a week", () => {
  const session = "a".repeat(64), other = "b".repeat(64), now = 10 * REMEMBERED_VERDICT_MS;
  const kept = verdictRecord(session, now - 60_000);
  assert.equal(rememberedVerdict(kept, { session, now }), now - 60_000, "the same session, a minute later");
  assert.equal(rememberedVerdict(kept, { session: other, now }), null, "someone signed in to the pages since");
  assert.equal(rememberedVerdict(kept, { session: null, now }), null, "the pages signed out");
  assert.equal(rememberedVerdict(verdictRecord(session, now - REMEMBERED_VERDICT_MS - 1), { session, now }), null, "more than a week old");
  assert.equal(rememberedVerdict(verdictRecord(session, now + 1), { session, now }), null, "from the future (a clock set back)");
  for (const broken of [null, {}, { ...kept, version: 2 }, { ...kept, state: WEB_IDENTITY.CONFLICT }, { ...kept, session: "short" }, { ...kept, checkedAt: "yesterday" }]) {
    assert.equal(rememberedVerdict(broken, { session, now }), null, JSON.stringify(broken));
  }
});

test("a kept verdict is taken only while nothing has been concluded and no probe is running", async () => {
  const seen = [];
  const { check } = harness({ statuses: [{ status: "pending" }] });
  check.onChange = (value) => seen.push(value.state);
  assert.equal(check.restore(123), true);
  assert.deepEqual(check.snapshot(), { state: WEB_IDENTITY.VERIFIED, reason: null, cause: null, checkedAt: 123, needsAttention: false });
  assert.deepEqual(seen, [WEB_IDENTITY.VERIFIED], "the application hears it like any verdict (and writes it down again)");
  assert.equal(check.restore(456), false, "not over a verdict already reached");
  check.reset();
  const running = harness({ statuses: [{ status: "pending" }] });
  running.check.wait = () => new Promise(() => {});
  void running.check.check();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(running.check.busy, true);
  assert.equal(running.check.restore(789), false, "not while a probe is out");
  const conflict = harness({ statuses: [{ status: "conflict", checkedAt: 9 }] });
  await conflict.check.check();
  assert.equal(conflict.check.restore(789), false, "never over a conflict");
  assert.equal(conflict.check.snapshot().state, WEB_IDENTITY.CONFLICT);
});
