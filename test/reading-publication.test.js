import test from "node:test";
import assert from "node:assert/strict";
import { WikiReadingPublication } from "../src/knowledge/reading-publication.js";
import { wikiHash } from "../src/knowledge/manifest.js";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function fixture(t) {
  let clock = 1000, sequence = 0;
  const timers = new Map(), history = [], state = { ids: [], principal: "alice", grants: [], releases: 0, plans: 0, allowed: true, generation: 0 };
  const target = { shardKey: wikiHash("shard"), folderReference: "https://test.feishu.cn/drive/folder/Synthetic123" };
  const wiki = { publicationCandidates: async () => ({ identity: { principal: state.principal, tenantKey: "tenant" }, sourceIds: [...state.ids], selectionKind: "retained-local-reads", permissionsChecked: false }) };
  const publisher = { plan: async () => { state.plans++; return { state: "ready", generation: state.generation }; },
    publish: async input => { state.input = input; return { state: "published", generation: ++state.generation, id: input.id }; } };
  const authorizeScope = async scope => { state.grants.push(structuredClone(scope)); return { scopeDigest: wikiHash(scope), expiresAt: clock + 10000,
    assertCurrent: async () => { if (!state.allowed) throw new Error("revoked"); }, release: async () => { state.releases++; } }; };
  const worker = new WikiReadingPublication({ wiki, publisher, authorizeScope, businessAccess: () => { if (!state.allowed) throw new Error("unlinked"); }, now: () => clock,
    timers: { set: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); history.push({ callback, delay }); return id; }, clear: id => timers.delete(id) } });
  t.after(() => worker.close());
  return { state, worker, wiki, publisher, target, timers, history, time: value => { clock = value; } };
}

test("reading worker waits empty, reauthorizes changed ID sets and never silently expands a frozen publication", async t => {
  const f = fixture(t); await f.worker.start(f.target); await f.worker.tick();
  assert.equal(f.worker.status().last.outcome, "waiting-for-sources"); assert.equal(f.state.grants.length, 0);
  f.state.ids = [wikiHash("first")]; await f.worker.tick(); assert.equal(f.state.grants.length, 1);
  f.state.ids.push(wikiHash("second")); await f.worker.tick(); assert.equal(f.state.grants.length, 2); assert.equal(f.state.releases, 1);
  assert.equal(f.state.grants[0].sourceIds.length, 1); assert.equal(f.state.grants[1].sourceIds.length, 2);
  assert.equal(f.worker.status().counts.published, 2);
  f.state.ids = []; await f.worker.tick(); assert.equal(f.state.releases, 2); assert.equal(f.state.generation, 2);
  assert.equal(f.worker.status().last.outcome, "waiting-for-sources");
});

test("reading worker rejects a changed identity or business gate and does not automatically restart", async t => {
  for (const kind of ["account", "business", "permission-claim"]) {
    const f = fixture(t); f.state.ids = [wikiHash("first")]; await f.worker.start(f.target); await f.worker.tick();
    if (kind === "account") f.state.principal = "bob";
    if (kind === "business") f.state.allowed = false;
    if (kind === "permission-claim") { const original = f.wiki.publicationCandidates; f.wiki.publicationCandidates = async () => ({ ...await original(), permissionsChecked: true }); }
    await f.worker.tick(); assert.equal(f.worker.status().state, "paused"); assert.equal(f.state.grants.length, 1); assert.equal(f.state.releases, 1);
    await f.worker.tick(); assert.equal(f.state.generation, 1);
  }
});

test("stop drains an abort-ignoring selection and no late result can obtain a new scope", async t => {
  const f = fixture(t), held = deferred(), entered = deferred(); await f.worker.start(f.target);
  const original = f.wiki.publicationCandidates;
  f.wiki.publicationCandidates = async () => { entered.resolve(); await held.promise; return original(); };
  f.state.ids = [wikiHash("late")]; const first = f.worker.tick(), second = f.worker.tick(); assert.equal(first, second); await entered.promise;
  let stopped = false; const stopping = f.worker.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); await assert.rejects(f.worker.start(f.target));
  held.resolve(); await stopping; await first; assert.equal(f.state.grants.length, 0); assert.equal(f.timers.size, 0);
});

test("reading worker expires without renewing scopes and stale expiry cannot stop a restarted run", async t => {
  const f = fixture(t); f.state.ids = [wikiHash("first")]; await f.worker.start(f.target); await f.worker.tick();
  const old = f.history.at(-1).callback; await f.worker.stop(); await f.worker.start(f.target); old();
  assert.equal(f.worker.status().state, "running"); await f.worker.tick();
  f.time(f.worker.status().expiresAt); await f.worker.tick(); assert.equal(f.worker.status().state, "paused");
  assert.equal(f.state.grants.length, 2); assert.equal(f.state.generation, 2); assert.equal(f.timers.size, 0);
});

test("reading worker preserves ambiguous publication as paused, not an automatic source-refresh retry", async t => {
  const f = fixture(t); f.state.ids = [wikiHash("first")]; f.publisher.plan = async () => ({ state: "review-required", generation: 0 });
  await f.worker.start(f.target); await f.worker.tick(); assert.equal(f.worker.status().state, "paused"); assert.equal(f.worker.status().reason, "review-required");
  f.state.ids.push(wikiHash("new")); await f.worker.tick(); assert.equal(f.state.grants.length, 1); assert.equal(f.state.generation, 0);
});

test("reading worker stop aborts and drains the inner publisher without scheduling another cycle", { timeout: 2000 }, async t => {
  const f = fixture(t), entered = deferred(); f.state.ids = [wikiHash("first")];
  f.publisher.publish = async (_, { signal }) => { entered.resolve(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); signal.throwIfAborted(); };
  await f.worker.start(f.target); const pending = f.worker.tick(); await entered.promise;
  await f.worker.stop(); await pending;
  assert.equal(f.worker.status().state, "stopped"); assert.equal(f.worker.status().busy, false); assert.equal(f.state.releases, 1);
  assert.equal(f.state.generation, 0); assert.equal(f.timers.size, 0);
});
