import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WikiPublicationScheduler, PUBLICATION_SCHEDULE_LIMITS } from "../src/knowledge/publication-scheduler.js";
import { wikiHash } from "../src/knowledge/manifest.js";

const scope = () => ({ shardKey: wikiHash("shard"), sourceIds: [wikiHash("source")], folderReference: "https://test.feishu.cn/drive/folder/SyntheticFolder123" });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  let time = 1000, sequence = 0;
  const timers = new Map(), history = [], state = { plans: 0, uploads: 0, releases: 0, revoked: false, plan: { state: "ready", generation: 0 } };
  const grant = input => ({ scopeDigest: wikiHash(input), expiresAt: time + 1000,
    assertCurrent: async () => { if (state.revoked) throw new Error("SECRET revoked"); }, release: async () => { state.releases++; } });
  const publisher = {
    plan: async input => { state.plans++; state.input = input; return state.plan; },
    publish: async input => { state.uploads++; state.published = input; return { state: "published", generation: 1, id: input.id }; },
  };
  const scheduler = new WikiPublicationScheduler({ publisher, authorizeScope: async input => grant(input), now: () => time, intervalMs: 10,
    timers: { set: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, at: time + delay }); history.push({ callback, delay }); return id; }, clear: id => timers.delete(id) } });
  const fire = async delay => {
    time += delay;
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
    await scheduler.current?.pending;
  };
  return { scheduler, publisher, state, timers, history, grant, fire, advance: delay => { time += delay; } };
}

test("timer publishes once then repeatedly plans unchanged without upload; scope and status are copies", async () => {
  const f = fixture(), input = scope();
  await f.scheduler.start(input); input.sourceIds.push(wikiHash("outside"));
  await f.fire(0);
  assert.equal(f.state.uploads, 1); assert.deepEqual(f.state.input, scope());
  assert.equal(f.state.published.confirmed, true);
  f.state.plan = { state: "unchanged", generation: 1, operationId: f.state.published.id };
  await f.fire(10); await f.fire(10);
  assert.deepEqual(f.scheduler.status().counts, { cycles: 3, published: 1, unchanged: 2 });
  assert.equal(f.state.uploads, 1);
  assert.equal(f.scheduler.status().last.remoteBytesVerified, false);
  const status = f.scheduler.status(); status.counts.published = 999; status.last.outcome = "wrong";
  assert.equal(f.scheduler.status().counts.published, 1); assert.equal(f.scheduler.status().last.outcome, "unchanged");
  await f.scheduler.stop(); assert.equal(f.timers.size, 0); assert.equal(f.state.releases, 1);
  await f.fire(10000); assert.equal(f.state.plans, 3);
});

test("old expiry callback cannot stop a newly authorized run", async () => {
  const f = fixture(); await f.scheduler.start(scope());
  const oldExpiry = f.history.find(timer => timer.delay === 1000).callback;
  await f.scheduler.stop(); await f.scheduler.start(scope());
  oldExpiry(); await Promise.resolve();
  assert.equal(f.scheduler.status().state, "running");
  await f.scheduler.close();
});

test("invalid scope or missing/mismatched/expired grants cannot start any work", async () => {
  assert.throws(() => new WikiPublicationScheduler({ publisher: {} }));
  for (const mutation of [input => ({ ...input, sourceIds: [] }), input => ({ ...input, confirmed: true }), input => ({ ...input, sourceIds: [input.sourceIds[0], input.sourceIds[0]] })]) {
    const f = fixture(); await assert.rejects(f.scheduler.start(mutation(scope()))); assert.equal(f.state.plans, 0);
  }
  for (const patch of [{ scopeDigest: wikiHash("other") }, { expiresAt: 1000 }, { expiresAt: 1001 + PUBLICATION_SCHEDULE_LIMITS.lifetimeMs }, { assertCurrent: null }]) {
    const f = fixture(); f.scheduler.authorizeScope = async input => ({ ...f.grant(input), ...patch });
    await assert.rejects(f.scheduler.start(scope())); assert.equal(f.state.plans, 0); assert.equal(f.timers.size, 0); assert.equal(f.state.releases, 1);
  }
});

test("stop during authorization waits for the late grant and releases it exactly once", async () => {
  const f = fixture(), entered = deferred(), held = deferred();
  f.scheduler.authorizeScope = async input => { entered.resolve(); await held.promise; return f.grant(input); };
  const starting = f.scheduler.start(scope()); const rejected = assert.rejects(starting); await entered.promise;
  let stopped = false; const stopping = f.scheduler.stop().then(() => { stopped = true; });
  await assert.rejects(f.scheduler.start(scope())); assert.equal(stopped, false);
  held.resolve(); await rejected; await stopping;
  assert.equal(f.scheduler.status().state, "stopped"); assert.equal(f.state.releases, 1); assert.equal(f.state.plans, 0); assert.equal(f.timers.size, 0);
});

test("stop during plan drains it, blocks overlap and never publishes or requeues", async () => {
  const f = fixture(), entered = deferred(), held = deferred(); let signal;
  f.publisher.plan = async (_, options) => { f.state.plans++; signal = options.signal; entered.resolve(); await held.promise; return f.state.plan; };
  await f.scheduler.start(scope()); const working = f.scheduler.tick(); await entered.promise;
  const duplicate = f.scheduler.tick(); assert.equal(working, duplicate);
  const stopping = f.scheduler.stop(); assert.equal(signal.aborted, true);
  await assert.rejects(f.scheduler.start(scope())); held.resolve(); await stopping;
  assert.equal(f.state.plans, 1); assert.equal(f.state.uploads, 0); assert.equal(f.timers.size, 0); assert.equal(f.state.releases, 1);
});

test("scope revocation after plan pauses without upload and does not leak upstream errors", async () => {
  const f = fixture(); f.publisher.plan = async () => { f.state.revoked = true; return f.state.plan; };
  await f.scheduler.start(scope()); await f.fire(0);
  assert.equal(f.scheduler.status().state, "paused"); assert.equal(f.scheduler.status().reason, "operation-failed");
  assert.equal(f.state.uploads, 0); assert.equal(f.state.releases, 1); assert.equal(f.timers.size, 0);
  assert.equal(JSON.stringify(f.scheduler.status()).includes("SECRET"), false);
});

test("expiration aborts a pending plan and releases only after it drains", async () => {
  const f = fixture(), entered = deferred(), held = deferred(); let signal;
  f.publisher.plan = async (_, options) => { signal = options.signal; entered.resolve(); await held.promise; return f.state.plan; };
  await f.scheduler.start(scope()); const work = f.scheduler.tick(); await entered.promise;
  const expiring = f.fire(1000); assert.equal(signal.aborted, true); assert.equal(f.state.releases, 0);
  held.resolve(); await work; await expiring; await f.scheduler.stop();
  assert.equal(f.scheduler.status().reason, "expired"); assert.equal(f.state.uploads, 0); assert.equal(f.state.releases, 1); assert.equal(f.timers.size, 0);
});

test("unknown/remote heads and malformed results pause instead of retrying", async () => {
  for (const plan of [{ state: "review-required", generation: 0, operationId: randomUUID() }, { state: "remote-head", generation: 1 },
    { state: "unchanged", generation: 1, operationId: "SECRET" }, { state: "unknown", generation: 0 }]) {
    const f = fixture(); f.state.plan = plan; await f.scheduler.start(scope());
    const status = await f.scheduler.tick(); assert.equal(status.busy, false);
    assert.equal(f.scheduler.status().state, "paused"); assert.equal(f.state.uploads, 0); assert.equal(f.timers.size, 0);
    assert.equal(JSON.stringify(f.scheduler.status()).includes("SECRET"), false);
  }
});

test("authorization is rechecked inside publisher work, and close prevents restart", async () => {
  const f = fixture();
  f.publisher.publish = async (_, options) => { f.state.revoked = true; await options.assertCurrent(); f.state.uploads++; };
  await f.scheduler.start(scope()); await f.fire(0);
  assert.equal(f.state.uploads, 0); assert.equal(f.scheduler.status().state, "paused");
  await f.scheduler.close(); await assert.rejects(f.scheduler.start(scope()));
  assert.equal(f.scheduler.status().state, "closed"); assert.equal(fixture().scheduler.status().state, "idle");
});
