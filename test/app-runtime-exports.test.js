import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, mkdir } from "node:fs/promises";
import path from "node:path";
import { AppCandidates } from "../src/application/app-candidates.js";
import { AppRuntimeExports } from "../src/application/app-runtime-exports.js";
import { runtimeRequest } from "../src/apps/runtime-http.js";
import { runtimeControlFixture } from "../scripts/fixtures/runtime-control-plane.js";
async function fixture(t) {
  const f = await runtimeControlFixture(); f.ready(); const state = { session: f.operator, issues: 0 };
  const candidates = new AppCandidates({ getTask: () => assert.fail("Operators need no local coding task"), getSession: async () => ({ ...state.session, serverUrl: f.serverUrl }) });
  const controller = new AppRuntimeExports({ candidates, request: async (...args) => { if (args[2] === "/auth/app-runtime-token") state.issues++; return runtimeRequest(...args); } });
  t.after(async () => { controller.close(); await f.close(); });
  return { ...f, state, candidates, controller };
}
async function draft(f) { const row = await f.controller.read(f.id, f.pkg.digest); return f.controller.prepare(row.handle); }
test("operator browsing returns version metadata without granting runtime or revealing source/archive locators", async t => {
  const f = await fixture(t); const list = await f.controller.list(); assert.equal(list.candidates.length, 1);
  const row = await f.controller.read(f.id, f.pkg.digest); assert.equal(row.binding.nodeId, f.nodeId); assert.equal(row.manifest.entry, "index.html");
  assert.doesNotMatch(JSON.stringify(row), /token|fileToken|folder|<html|<script/); assert.equal(f.state.issues, 0);
  const browse = f.sessions.issueForAppRuntimeOperator(f.operator.token);
  assert.equal((await f.post("/auth/app-runtime-token", browse.token, f.selector)).status, 403);
  assert.equal((await f.post("/v1/apps/runtime-list", f.operator.token, {})).status, 403);
  assert.equal((await f.post("/v1/responses", browse.token, {})).status, 403);
  f.state.session = f.author; await assert.rejects(f.controller.list(), /403/);
});
test("export produces usable private grant, not a renderer credential or source copy; draft is consumed", async t => {
  const f = await fixture(t), d = await draft(f), result = await f.controller.export(d, f.root);
  assert.equal(result.deployed, false); assert.equal((await stat(path.dirname(result.filename))).mode & 0o077, 0); assert.equal((await stat(result.filename)).mode & 0o077, 0);
  const grant = JSON.parse(await readFile(result.filename)); assert.equal(f.sessions.verify(grant.token).audience, "app-runtime");
  assert.equal(grant.binding.digest, f.pkg.digest); assert.equal(result.expiresAt, grant.expiresAt);
  assert.ok(!JSON.stringify(result).includes(grant.token)); assert.ok(!JSON.stringify(grant).includes(f.operator.token)); assert.doesNotMatch(JSON.stringify(grant), /<script|fileToken/);
  assert.deepEqual(await readdir(path.dirname(result.filename)), ["runtime-grant.json"]);
  await assert.rejects(f.controller.export(d, f.root), /已使用/); assert.equal(f.state.issues, 1);
});
test("withdrawal, page close, session change and stale confirmation prevent issuance", async t => {
  for (const reason of ["withdraw", "closed", "account", "expiry", "policy"]) {
    const f = await fixture(t), d = await draft(f);
    if (reason === "withdraw") f.catalog.withdraw(f.author, f.selector);
    if (reason === "closed") f.controller.close();
    if (reason === "account") f.state.session = f.issue("operator");
    if (reason === "expiry") f.controller.now = () => Date.now() + 400000;
    if (reason === "policy") f.catalog.tenants[0].runtime.nodeId = "changed-node";
    await assert.rejects(f.controller.export(d, f.root)); assert.equal(f.state.issues, 0, reason);
  }
});
test("server compares the confirmed target atomically before issuing or revoking the prior grant", async t => {
  const f = await fixture(t), previous = await f.grant(), d = await draft(f);
  f.controller.request = async (...args) => {
    if (args[2] === "/auth/app-runtime-token") f.catalog.tenants[0].runtime.nodeId = "changed-after-check";
    return runtimeRequest(...args);
  };
  let failure; try { await f.controller.export(d, f.root); } catch (error) { failure = error; }
  assert.ok(f.sessions.verify(previous.token), "Changed target must not revoke the previously authorized runtime");
  assert.match(failure?.message ?? "", /409/);
  assert.equal((await readdir(f.root)).some(name => name.startsWith("idou-runtime-")), false);
});
test("late successful issuance after page close revokes only the new child and removes its private directory", async t => {
  const f = await fixture(t), d = await draft(f); let minted;
  f.controller.request = async (...args) => { const result = await runtimeRequest(...args); if (args[2] === "/auth/app-runtime-token") { minted = result; f.controller.close(); } return result; };
  await assert.rejects(f.controller.export(d, f.root), /失效/);
  assert.equal(f.sessions.verify(minted.token), null); assert.ok(f.sessions.verify(f.operator.token));
  assert.equal((await readdir(f.root)).some(name => name.startsWith("idou-runtime-")), false);
});
test("lost issuance receipt is not retried; no usable file is returned and old confirmation cannot replay", async t => {
  const f = await fixture(t), d = await draft(f); let issues = 0;
  f.controller.request = async (...args) => { const result = await runtimeRequest(...args); if (args[2] === "/auth/app-runtime-token") { issues++; throw new Error("lost receipt"); } return result; };
  await assert.rejects(f.controller.export(d, f.root), /lost receipt/); await assert.rejects(f.controller.export(d, f.root), /已使用/);
  assert.equal(issues, 1); assert.equal((await readdir(f.root)).some(name => name.startsWith("idou-runtime-")), false);
});
test("multiple confirmations from the same snapshot cannot concurrently mint two grants", async t => {
  const f = await fixture(t), row = await f.controller.read(f.id, f.pkg.digest);
  const a = await f.controller.prepare(row.handle), b = await f.controller.prepare(row.handle);
  const results = await Promise.allSettled([f.controller.export(a, f.root), f.controller.export(b, f.root)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(f.state.issues, 1);
});
test("failure saving a minted grant revokes that child and removes only its temporary export directory", async t => {
  const f = await fixture(t), d = await draft(f); let minted;
  f.controller.request = async (...args) => {
    const result = await runtimeRequest(...args);
    if (args[2] === "/auth/app-runtime-token") {
      minted = result; const [name] = (await readdir(f.root)).filter(name => name.startsWith("idou-runtime-"));
      await mkdir(path.join(f.root, name, "runtime-grant.json"));
    }
    return result;
  };
  await assert.rejects(f.controller.export(d, f.root)); assert.equal(f.sessions.verify(minted.token), null); assert.ok(f.sessions.verify(f.operator.token));
  assert.equal((await readdir(f.root)).some(name => name.startsWith("idou-runtime-")), false);
});
test("operator browse leases do not revoke a running grant and can revoke neither parent nor runtime", async t => {
  const f = await fixture(t), runtime = await f.grant();
  await f.controller.list(); await f.controller.read(f.id, f.pkg.digest); assert.ok(f.sessions.verify(runtime.token));
  const browse = f.sessions.issueForAppRuntimeOperator(f.operator.token);
  assert.equal((await f.post("/v1/apps/runtime-revoke", browse.token, {})).status, 403);
  assert.equal((await f.post("/v1/apps/runtime-revoke", f.operator.token, {})).status, 403);
  assert.equal((await f.post("/v1/apps/runtime-revoke", runtime.token, {})).status, 200);
  assert.equal(f.sessions.verify(runtime.token), null); assert.ok(f.sessions.verify(f.operator.token));
});
