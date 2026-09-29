import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runtimeControlFixture } from "../scripts/fixtures/runtime-control-plane.js";
import { createAuthorizedStaticApp } from "../src/apps/authorized-runtime.js";
import { runtimePolicy } from "../src/apps/runtime-grant.js";
async function fixture(t) { const f = await runtimeControlFixture(); t.after(() => f.close()); return f; }
const body = f => ({ claimId: randomUUID(), nodeId: f.nodeId, imageId: f.imageId });
const nodeConfig = f => ({ serverUrl: f.serverUrl, nodeId: f.nodeId, runtime: { dockerPath: "/usr/bin/docker", endpoint: "unix:///run/docker.sock", imageId: f.imageId } });
function stub() {
  let starts = 0, closes = 0, options; const done = Promise.withResolvers();
  return { get starts() { return starts; }, get closes() { return closes; }, get options() { return options; },
    createApp: async input => { starts++; options = input; await input.authorize(); return { closed: done.promise, close: async () => { closes++; done.resolve(); } }; } };
}
test("runtime authorization is separate from author/reviewer/model scopes and requires approved archived exact version", async t => {
  const f = await fixture(t);
  assert.equal((await f.post("/auth/app-runtime-token", f.operator.token, f.selector)).status, 409);
  f.ready();
  for (const token of [f.author.token, f.reviewer.token, f.sessions.issueForApps(f.author.token).token, f.sessions.issueForAppReview(f.reviewer.token).token]) assert.equal((await f.post("/auth/app-runtime-token", token, f.selector)).status, 403);
  const grant = await f.grant(); assert.equal(grant.audience, "app-runtime"); assert.equal(grant.deployed, false); assert.equal(grant.binding.sha256, f.pkg.sha256);
  assert.doesNotMatch(JSON.stringify(grant), /fileToken|folder|source|synthetic-unused-key/);
  assert.equal((await f.post("/v1/responses", grant.token, { model: "MiniMax-M3", input: "denied" })).status, 403);
  assert.equal((await f.post("/v1/apps/list", grant.token, { appId: f.id })).status, 403);
});
test("runtime grants reject wrong identity domain, origin, selectors and unconfigured operators", async t => {
  const f = await fixture(t); f.ready();
  for (const extra of [{ tenantId: "other" }, { appId: "cli_other" }, { userId: "reviewer" }]) assert.equal((await f.post("/auth/app-runtime-token", f.issue("operator", extra).token, f.selector)).status, 403);
  assert.equal((await f.post("/auth/app-runtime-token", f.operator.token, f.selector, { origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await f.post("/auth/app-runtime-token", f.operator.token, { ...f.selector, digest: "f".repeat(64) })).status, 404);
  assert.equal((await f.post("/auth/app-runtime-token", f.operator.token, { ...f.selector, imageId: f.imageId })).status, 400);
  f.catalog.tenants[0].runtime = null; assert.equal((await f.post("/auth/app-runtime-token", f.operator.token, f.selector)).status, 403);
  assert.equal(runtimePolicy(undefined), null); assert.throws(() => runtimePolicy({ operators: ["operator"], nodeId: "node", imageId: "node:latest" }));
});
test("single claim excludes concurrent starts; checks require same claim and node", async t => {
  const f = await fixture(t); f.ready(); const grant = await f.grant(), request = body(f);
  assert.equal((await f.post("/v1/apps/runtime-check", grant.token, request)).status, 409);
  assert.equal((await f.post("/v1/apps/runtime-claim", grant.token, { ...request, nodeId: "other" })).status, 403);
  const results = await Promise.all(Array.from({ length: 4 }, () => f.post("/v1/apps/runtime-claim", grant.token, request)));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409, 409]);
  assert.equal((await f.post("/v1/apps/runtime-check", grant.token, request)).status, 200);
  assert.equal((await f.post("/v1/apps/runtime-check", grant.token, { ...request, claimId: randomUUID() })).status, 409);
  assert.equal((await f.post("/v1/apps/runtime-stop", grant.token, request)).status, 200);
  assert.equal(f.sessions.verify(grant.token), null); assert.equal(f.service.claims.size, 0);
});
test("runtime checks enforce withdrawal, current role/node policy, parent revocation and lease expiry", async t => {
  for (const reason of ["withdraw", "role", "image", "parent", "expiry"]) {
    const f = await fixture(t); f.ready(); const grant = await f.grant(), request = body(f);
    assert.equal((await f.post("/v1/apps/runtime-claim", grant.token, request)).status, 200);
    if (reason === "withdraw") f.catalog.withdraw(f.author, f.selector);
    if (reason === "role") f.catalog.tenants[0].runtime.operators = [];
    if (reason === "image") f.catalog.tenants[0].runtime.imageId = `sha256:${"b".repeat(64)}`;
    if (reason === "parent") f.sessions.revoke(f.operator.token);
    if (reason === "expiry") f.sessions.now = () => grant.expiresAt + 1;
    assert.notEqual((await f.post("/v1/apps/runtime-check", grant.token, request)).status, 200, reason);
  }
});
test("renewing a runtime grant revokes old runtime without affecting reviewer leases", async t => {
  const f = await fixture(t); f.ready(); const first = await f.grant(), request = body(f);
  await f.post("/v1/apps/runtime-claim", first.token, request);
  const review = f.sessions.issueForAppReview(f.reviewer.token); const second = await f.grant();
  assert.notEqual(first.token, second.token); assert.equal(f.sessions.verify(first.token), null); assert.equal(f.service.claims.size, 0); assert.ok(f.sessions.verify(review.token));
});
test("node validates package and image before Docker; stops its claimed lease on explicit close", async t => {
  const f = await fixture(t); f.ready(); const grant = await f.grant(), runner = stub(), config = nodeConfig(f);
  await assert.rejects(createAuthorizedStaticApp({ config, grant, bytes: Buffer.from("wrong"), createApp: runner.createApp })); assert.equal(runner.starts, 0);
  await assert.rejects(createAuthorizedStaticApp({ config: { ...config, nodeId: "other" }, grant, bytes: f.pkg.bytes, createApp: runner.createApp })); assert.equal(runner.starts, 0);
  const app = await createAuthorizedStaticApp({ config, grant, bytes: f.pkg.bytes, createApp: runner.createApp });
  assert.equal(runner.starts, 1); assert.equal(runner.options.digest, f.pkg.digest); assert.equal(app.deployed, false);
  await app.close(); assert.equal(runner.closes, 1); assert.equal(f.sessions.verify(grant.token), null);
});
test("lost claim receipt never starts Docker or retries claiming", async t => {
  const f = await fixture(t); f.ready(); const grant = await f.grant(), runner = stub(); let claims = 0;
  const fetchImpl = async (url, init) => { const response = await fetch(url, init); if (url.endsWith("runtime-claim")) { claims++; await response.body.cancel(); throw new Error("lost response"); } return response; };
  await assert.rejects(createAuthorizedStaticApp({ config: nodeConfig(f), grant, bytes: f.pkg.bytes, createApp: runner.createApp, fetchImpl }), /lost response/);
  assert.equal(claims, 1); assert.equal(runner.starts, 0); assert.equal(f.sessions.verify(grant.token), null);
});
test("withdrawal during startup prevents readiness; idle revocation closes running node", { timeout: 10000 }, async t => {
  const f = await fixture(t); f.ready(); let grant = await f.grant(); const first = stub();
  await assert.rejects(createAuthorizedStaticApp({ config: nodeConfig(f), grant, bytes: f.pkg.bytes, createApp: async input => { const app = await first.createApp(input); f.sessions.revoke(f.operator.token); return app; } })); assert.equal(first.closes, 1);
  // Separate active operator session; no reuse of revoked credentials.
  f.operator = f.issue("operator"); const response = await f.post("/auth/app-runtime-token", f.operator.token, f.selector); grant = await response.json(); const runner = stub();
  const app = await createAuthorizedStaticApp({ config: nodeConfig(f), grant, bytes: f.pkg.bytes, createApp: runner.createApp });
  f.catalog.withdraw(f.author, f.selector); await app.closed; assert.equal(runner.closes, 1); await app.close();
});
test("node rejects changed authorization receipts before starting Docker and never follows redirects", async t => {
  const f = await fixture(t); f.ready(); const grant = await f.grant(), runner = stub(); let requests = 0;
  const fetchImpl = async (url, init) => {
    requests++; assert.equal(init.redirect, "error"); assert.ok(url.startsWith(f.serverUrl + "/"));
    const response = await fetch(url, init);
    if (!url.endsWith("runtime-claim")) return response;
    const receipt = await response.json(); receipt.binding.sha256 = "e".repeat(64);
    return Response.json(receipt);
  };
  await assert.rejects(createAuthorizedStaticApp({ config: nodeConfig(f), grant, bytes: f.pkg.bytes, fetchImpl, createApp: runner.createApp }), /changed/);
  assert.equal(runner.starts, 0); assert.equal(requests, 2); assert.equal(f.sessions.verify(grant.token), null);
});
test("runtime HTTP rejects oversized and encoded bodies, and model leases cannot claim", async t => {
  const f = await fixture(t); f.ready(); const grant = await f.grant();
  assert.equal((await f.post("/v1/apps/runtime-claim", f.operator.token, body(f))).status, 403);
  assert.equal((await f.post("/v1/apps/runtime-claim", grant.token, body(f), { "content-encoding": "gzip" })).status, 415);
  assert.equal((await f.post("/v1/apps/runtime-claim", grant.token, { ...body(f), padding: "x".repeat(5000) })).status, 413);
  const res = await f.post("/v1/apps/runtime-claim", grant.token, body(f)); assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
});
