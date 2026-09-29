import test from "node:test";
import assert from "node:assert/strict";
import { WikiCloudWork } from "../src/knowledge/cloud-work.js";
import { DesktopAuth } from "../src/application/desktop-auth.js";
import { runWikiRenewalCheckpoint } from "../src/knowledge/renewal-checkpoint.js";

async function fixture(t) {
  const lane = new WikiCloudWork(), trace = [], start = Date.now(), state = { now: start };
  const session = { status: "authenticated", serverUrl: "https://enterprise.example", token: "a".repeat(43), expiresAt: start + 900000,
    identity: { provider: "feishu", appId: "cli_fixture", tenantId: "tenant", userId: "user", deviceProof: "ed25519-login", deviceId: "device" },
    renewal: { renewAfter: start + 780000, notAfter: start + 3600000 } };
  const client = { begin: async () => ({ launchUrl: "https://enterprise.example" }), complete: async () => session, cancel: async () => {},
    request: async (_origin, route) => { trace.push(route); return { identity: session.identity, expiresAt: session.expiresAt, renewal: session.renewal }; },
    renew: async () => { trace.push("rotate"); return { ...session, token: "b".repeat(43), expiresAt: state.now + 900000, renewal: { ...session.renewal, renewAfter: state.now + 780000 } }; } };
  const auth = new DesktopAuth({ serverUrl: session.serverUrl, client, now: () => state.now, openBrowser: async () => {}, activate: async () => {}, deactivate: async () => {},
    leaseFactory: async () => ({ filename: "/synthetic/lease", replace: async () => trace.push("replace"), close: async () => trace.push("close") }),
    withRenewal: operation => lane.run(async () => { const result = await operation(); trace.push("refresh-scopes"); return result; }) });
  await auth.begin(); await auth.poll(); await auth.confirm(); state.now = session.renewal.renewAfter;
  t.after(() => auth.close()); return { lane, auth, trace, state, session };
}

test("native rotation waits behind current cloud work and refreshes scopes before the next work item", async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const first = f.lane.run(async () => { f.trace.push("upload-start"); entered.resolve(); await gate.promise; f.trace.push("upload-receipt"); });
  await entered.promise; const renewed = f.auth.renew();
  const next = f.lane.run(async () => { f.trace.push("next-cycle"); assert.equal(f.auth.active.session.token, "b".repeat(43)); });
  assert.equal(f.trace.includes("rotate"), false); gate.resolve(); await Promise.all([first, renewed, next]);
  assert.deepEqual(f.trace.slice(-6), ["upload-start", "upload-receipt", "rotate", "replace", "refresh-scopes", "next-cycle"]);
});

test("expiry while waiting for cloud work cannot rotate or refresh an expired login", async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const first = f.lane.run(async () => { entered.resolve(); await gate.promise; }); await entered.promise;
  const renewal = assert.rejects(f.auth.renew()); f.state.now = f.session.expiresAt;
  gate.resolve(); await first; await renewal;
  assert.equal(f.trace.includes("rotate"), false); assert.equal(f.trace.includes("replace"), false); assert.equal(f.trace.includes("refresh-scopes"), false);
  assert.equal(f.auth.status().connected, false);
});

test("shutdown while queued cannot revive credentials once the previous cloud operation drains", async t => {
  const f = await fixture(t), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const first = f.lane.run(async () => { entered.resolve(); await gate.promise; }); await entered.promise;
  const renewal = assert.rejects(f.auth.renew()), closing = f.auth.close();
  gate.resolve(); await Promise.all([first, renewal, closing]);
  assert.equal(f.auth.active, null); assert.equal(f.trace.includes("rotate"), false); assert.equal(f.trace.includes("refresh-scopes"), false);
});

test("renewal uses cloud-then-Wiki lock order and cannot deadlock a publisher selecting local reads", { timeout: 1000 }, async () => {
  const cloud = new WikiCloudWork(), local = new WikiCloudWork(), entered = Promise.withResolvers(), proceed = Promise.withResolvers(), trace = [];
  const publication = { refreshSession: async () => trace.push("publication-refresh") }, reception = { refreshSession: async () => trace.push("reception-refresh") };
  const wiki = { withSynthesisCheckpoint: operation => local.run(operation) };
  const publishing = cloud.run(async () => { trace.push("publisher-cloud"); entered.resolve(); await proceed.promise;
    await local.run(async () => trace.push("publisher-local")); trace.push("publisher-done"); });
  await entered.promise;
  const renewal = runWikiRenewalCheckpoint({ cloudWork: cloud, wiki, publication, reception, isCurrent: () => trace.push("current") }, async () => trace.push("rotate"));
  proceed.resolve(); await Promise.all([publishing, renewal]);
  assert.deepEqual(trace, ["publisher-cloud", "publisher-local", "publisher-done", "current", "rotate", "publication-refresh", "reception-refresh"]);
});
