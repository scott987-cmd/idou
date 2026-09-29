import test from "node:test";
import assert from "node:assert/strict";
import { knowledgePublicationUi } from "../src/desktop/renderer/knowledge-publication.js";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const status = (state, published = 0) => ({ state, enabled: state === "running", busy: false, sourceCount: 1, counts: { published } });
function fixture(api, kind = "publication") {
  const elements = [], state = { disposed: 0, current: true };
  const element = (tag, textContent = "") => { const value = { tag, textContent, isConnected: true, append() {} }; elements.push(value); return value; };
  const ui = knowledgePublicationUi({ api: { ...api, [kind === "reception" ? "onReceptionChange" : "onPublicationChange"]: listener => { state.event = listener; return () => state.disposed++; } }, root: element("root"), element, isCurrent: () => state.current, kind });
  return { ui, state, get: id => elements.find(value => value.id === id) };
}
test("publication view ignores old snapshot after a newer native event and keeps closed controls disabled", async () => {
  const old = deferred(), f = fixture({ knowledgePublicationStatus: () => old.promise });
  f.state.event(status("running", 2)); old.resolve(status("idle")); await flush();
  assert.match(f.get("publication-status").textContent, /已发布 2/); assert.equal(f.get("publication-stop").hidden, false);
  f.state.event(status("closed")); assert.equal(f.get("publication-start").disabled, true); f.ui.dispose();
});
test("publication stop waits for native completion and stale responses cannot replace stopping state", async () => {
  const stopped = deferred(); let calls = 0;
  const f = fixture({ knowledgePublicationStatus: async () => status("running"), stopKnowledgePublication: () => { calls++; return stopped.promise; } }); await flush();
  const pending = f.get("publication-stop").onclick(); assert.equal(f.get("publication-stop").disabled, true);
  await f.get("publication-stop").onclick(); assert.equal(calls, 1);
  f.state.event(status("stopping")); stopped.resolve(status("running")); await pending;
  assert.match(f.get("publication-status").textContent, /正在停止/); assert.equal(f.get("publication-stop").disabled, true);
  f.state.event(status("stopped")); assert.equal(f.get("publication-stop").hidden, true); f.ui.dispose();
});
test("leaving publication view unsubscribes and ignores late responses without stopping native work", async () => {
  const old = deferred(), f = fixture({ knowledgePublicationStatus: () => old.promise });
  const before = f.get("publication-status").textContent; f.ui.dispose(); old.resolve(status("running")); await flush();
  f.state.event(status("running")); assert.equal(f.get("publication-status").textContent, before); assert.equal(f.state.disposed, 1);
});

test("reception controls use only native reception methods and render its distinct counts and permissions", async () => {
  const events = [], snapshot = state => ({ state, enabled: state === "running", busy: false, counts: { received: 3, unavailable: 1 } });
  const f = fixture({ knowledgeReceptionStatus: async () => snapshot("paused"),
    startKnowledgeReception: async () => { events.push("start"); return snapshot("running"); },
    stopKnowledgeReception: async () => { events.push("stop"); return snapshot("stopped"); } }, "reception");
  await flush(); assert.match(f.get("reception-detail").textContent, /企业接收配置/);
  await f.get("reception-start").onclick(); assert.match(f.get("reception-status").textContent, /已取回 3 个版本 · 1 个版本未通过核验/);
  assert.match(f.get("reception-detail").textContent, /取回内容不自动重新发布/);
  await f.get("reception-stop").onclick(); assert.deepEqual(events, ["start", "stop"]); assert.match(f.get("reception-status").textContent, /已停止/);
  f.ui.dispose(); assert.equal(f.state.disposed, 1);
});
