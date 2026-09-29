import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppCatalog, AppCatalogService } from "../src/control-plane/app-catalog.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { AppCandidates } from "../src/application/app-candidates.js";
import { AppReviews } from "../src/application/app-reviews.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const grants = [{ authProvider: "feishu", appId: "cli_fixture", tenantId: "tenant_fixture", publishers: ["alice"], reviewers: ["reviewer", "second", "third", "fourth", "alice"] }];
const source = "<!doctype html><h1>Source bytes must not reach the control plane</h1>";
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "idou-app-review-"))), workspace = path.join(root, "workspace"); await mkdir(workspace);
  await writeFile(path.join(workspace, "index.html"), source);
  const databaseFile = path.join(root, "catalog.sqlite"), options = { databaseFile, tenants: grants, feishu: SAAS_FEISHU };
  let catalog = new AppCatalog(options); const sessions = new SessionRegistry();
  const issue = (userId, extra = {}) => sessions.issue({ authProvider: "feishu", appId: "cli_fixture", tenantId: "tenant_fixture", userId, deviceId: "fixture", deviceProof: "ed25519-login", ...extra });
  const alice = issue("alice"), reviewer = issue("reviewer"), second = issue("second"), state = { current: reviewer, decisions: 0, requests: [], intercept: null };
  const service = new AppCatalogService({ catalog, sessions });
  const server = createModelGateway({ sessions, apiKey: "synthetic-model-secret", authHandler: (req, res) => service.handle(req, res), fetchImpl: () => assert.fail("No model call") });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const serverUrl = `http://127.0.0.1:${server.address().port}`;
  const task = { id: randomUUID(), cwd: workspace, title: "季度看板（合成测试）", mode: "coding", status: "idle" };
  const owner = new AppCandidates({ directory: path.join(root, "packages"), getTask: () => task, getSession: async () => ({ ...alice, serverUrl }) });
  const candidate = await owner.submit(await owner.prepare(task.id, "index.html"));
  const client = new AppCandidates({ getTask: () => assert.fail("Review must not require a local task"), getSession: async () => ({ ...state.current, serverUrl }), fetchImpl: async (url, init) => {
    state.requests.push({ url, body: init.body }); if (url.endsWith("/review")) state.decisions++;
    const response = await fetch(url, init); return state.intercept ? state.intercept(url, response) : response;
  } });
  const reviews = new AppReviews({ candidates: client });
  const post = (route, token, body, headers = {}) => fetch(`${serverUrl}${route}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  t.after(async () => { reviews.close(); server.close(); server.closeAllConnections(); catalog.close(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, options, sessions, alice, reviewer, second, state, task, owner, candidate, reviews, client, post, issue, catalog: () => catalog,
    restart: () => { catalog.close(); catalog = new AppCatalog(options); service.catalog = catalog; } };
}
const open = f => f.reviews.read(f.task.id, f.candidate.digest);
const input = f => ({ appId: f.task.id, digest: f.candidate.digest, decision: "approved", note: "清单结构符合要求；仍需源码与运行验证。" });

test("reviewer reads the exact manifest, confirms a durable immutable result and owner sees it without deployment", async t => {
  const f = await fixture(t), list = await f.reviews.list(); assert.equal(list.candidates[0].appId, f.task.id);
  const row = await open(f); assert.equal(row.manifest.files[0].path, "index.html"); assert.equal(row.review, null);
  assert.doesNotMatch(JSON.stringify(row), /archive|fileToken|folder|token|Source bytes/);
  const draft = await f.reviews.prepare(row.handle, "approved", input(f).note);
  assert.equal(f.state.decisions, 0);
  const result = await f.reviews.decide(draft); assert.equal(result.review.decision, "approved"); assert.equal(result.deployed, false);
  assert.equal((await f.owner.list(f.task.id))[0].review.id, result.review.id);
  assert.deepEqual((await f.reviews.list()).candidates, []);
  await assert.rejects(f.reviews.decide(draft), /已使用/); assert.equal(f.state.decisions, 1);
  f.restart(); assert.equal((await f.owner.list(f.task.id))[0].review.id, result.review.id);
  await writeFile(path.join(f.workspace, "index.html"), source + "<p>new version</p>");
  const next = await f.owner.submit(await f.owner.prepare(f.task.id, "index.html")); assert.equal(next.review, null); assert.notEqual(next.digest, result.digest);
  assert.equal((await f.reviews.list()).candidates.length, 1);
  await f.owner.withdraw(f.task.id, result.digest);
  const withdrawn = (await f.owner.list(f.task.id)).find(row => row.digest === result.digest); assert.equal(withdrawn.state, "withdrawn"); assert.equal(withdrawn.review.id, result.review.id); assert.equal(withdrawn.deployed, false);
  const stored = f.catalog().db.prepare("SELECT * FROM application_reviews").all(); assert.doesNotMatch(JSON.stringify(stored), /Source bytes|synthetic-model-secret/);
  assert.doesNotMatch(JSON.stringify(f.state.requests), /Source bytes/);
});

test("review routes enforce separate audience, current tenant/app/role, no self review and no publisher escalation", async t => {
  const f = await fixture(t), body = { appId: f.task.id, digest: f.candidate.digest };
  const lease = f.sessions.issueForAppReview(f.reviewer.token), ownerLease = f.sessions.issueForApps(f.alice.token);
  for (const token of [f.reviewer.token, ownerLease.token, f.sessions.issueForMedia(f.reviewer.token, "image").token]) assert.equal((await f.post("/v1/apps/review-get", token, body)).status, 403);
  assert.equal((await f.post("/v1/apps/withdraw", lease.token, body)).status, 403);
  assert.equal((await f.post("/v1/responses", lease.token, { model: "MiniMax-M3", input: "no" })).status, 403);
  assert.equal((await f.post("/v1/apps/review-get", lease.token, body, { origin: "https://other.example" })).status, 403);
  const self = f.sessions.issueForAppReview(f.alice.token); assert.equal((await f.post("/v1/apps/review-get", self.token, body)).status, 404);
  assert.equal((await f.post("/v1/apps/review", self.token, input(f))).status, 404);
  for (const extra of [{ tenantId: "other" }, { appId: "cli_other" }, { userId: "unapproved" }]) {
    const other = f.issue("reviewer", extra), token = f.sessions.issueForAppReview(other.token);
    assert.equal((await f.post("/v1/apps/review-get", token.token, body)).status, 403);
  }
  f.catalog().tenants[0].reviewers = [];
  assert.equal((await f.post("/v1/apps/review", lease.token, input(f))).status, 403);
  f.catalog().tenants[0].reviewers = ["reviewer"]; f.sessions.revoke(f.reviewer.token);
  assert.equal((await f.post("/v1/apps/review-get", lease.token, body)).status, 401);
  assert.equal(f.catalog().db.prepare("SELECT count(*) n FROM application_reviews").get().n, 0);
});

test("withdrawal, account switching, expired snapshots and closed pages prevent confirmed dispatch", async t => {
  for (const reason of ["withdraw", "account", "expiry", "closed", "role"]) {
    const f = await fixture(t), row = await open(f), draft = await f.reviews.prepare(row.handle, "rejected", "需要完善说明");
    if (reason === "withdraw") await f.owner.withdraw(f.task.id, f.candidate.digest);
    if (reason === "account") f.state.current = f.second;
    if (reason === "expiry") f.reviews.now = () => row.expiresAt + 1;
    if (reason === "closed") f.reviews.close();
    if (reason === "role") f.catalog().tenants[0].reviewers = [];
    await assert.rejects(f.reviews.decide(draft)); assert.equal(f.state.decisions, 0, reason);
    assert.equal(f.catalog().db.prepare("SELECT count(*) n FROM application_reviews").get().n, 0);
  }
});

test("a closed page while acquiring the final scoped lease cannot submit a late decision", async t => {
  const f = await fixture(t), row = await open(f), draft = await f.reviews.prepare(row.handle, "approved", "清单说明"), seen = Promise.withResolvers(), gate = Promise.withResolvers();
  let leases = 0;
  f.state.intercept = async (url, response) => { if (url.endsWith("/auth/app-review-token") && ++leases === 2) { seen.resolve(); await gate.promise; } return response; };
  const deciding = f.reviews.decide(draft); await seen.promise; f.reviews.close(); gate.resolve();
  await assert.rejects(deciding, /关闭/); assert.equal(f.state.decisions, 0);
});

test("lost receipt is recovered by read without resubmission; decision conflicts cannot overwrite the first result", async t => {
  const f = await fixture(t), row = await open(f), draft = await f.reviews.prepare(row.handle, "rejected", "修改入口文件说明");
  f.state.intercept = async (url, response) => { if (url.endsWith("/review")) { await response.body.cancel(); throw new Error("lost receipt"); } return response; };
  await assert.rejects(f.reviews.decide(draft), /lost receipt/); await assert.rejects(f.reviews.decide(draft), /已使用/);
  f.state.intercept = null; const recovered = await open(f); assert.equal(recovered.review.decision, "rejected"); assert.equal(f.state.decisions, 1);
  await assert.rejects(f.reviews.prepare(recovered.handle, "approved", "overwrite"), /已审核/);
  const lease = f.sessions.issueForAppReview(f.reviewer.token), original = { ...input(f), decision: "rejected", note: "修改入口文件说明" };
  assert.equal((await f.post("/v1/apps/review", lease.token, original)).status, 200);
  assert.equal((await f.post("/v1/apps/review", lease.token, input(f))).status, 409);
  const second = f.sessions.issueForAppReview(f.second.token); assert.equal((await f.post("/v1/apps/review", second.token, original)).status, 409);
  assert.equal(f.catalog().db.prepare("SELECT count(*) n FROM application_reviews").get().n, 1);
});

test("four independent reviewer processes compete for one immutable database decision", async t => {
  const f = await fixture(t), moduleUrl = new URL("../src/control-plane/app-catalog.js", import.meta.url).href, saasUrl = new URL("../src/providers/feishu/saas-definition.js", import.meta.url).href;
  const script = `import {AppCatalog} from ${JSON.stringify(moduleUrl)}; import {SAAS_FEISHU} from ${JSON.stringify(saasUrl)}; const [config,who,input]=process.argv.slice(1).map(JSON.parse); const c=new AppCatalog({ ...config, feishu: SAAS_FEISHU }); try {c.review(who,input); console.log('won');} catch(e){console.log(e.status === 409 ? 'conflict' : 'unexpected');} finally {c.close();}`;
  const results = await Promise.all(["reviewer", "second", "third", "fourth"].map(userId => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, JSON.stringify({ ...f.options, feishu: undefined }), JSON.stringify({ ...f.reviewer, token: undefined, userId }), JSON.stringify(input(f))])));
  assert.equal(results.filter(row => row.stdout.trim() === "won").length, 1); assert.equal(results.filter(row => row.stdout.trim() === "conflict").length, 3);
});

test("bounded keyset pagination omits own and reviewed entries, rejects bad cursors and resets no old schema data", async t => {
  const f = await fixture(t), manifest = (await open(f)).manifest;
  for (let i = 0; i < 12; i++) f.catalog().submit(f.alice, { appId: randomUUID(), title: `candidate ${i}`, manifest });
  const first = await f.reviews.list(), second = await f.reviews.list(first.nextCursor);
  assert.equal(first.candidates.length, 10); assert.equal(second.candidates.length, 3); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.candidates, ...second.candidates].map(row => row.appId)).size, 13);
  await assert.rejects(f.reviews.list("invalid"));
  f.catalog().db.exec("DROP TABLE application_reviews; PRAGMA user_version=2;"); f.restart();
  assert.equal(f.catalog().db.prepare("PRAGMA user_version").get().user_version, 3); assert.equal((await f.reviews.list()).candidates.length, 10);
  assert.equal((await f.owner.list(f.task.id))[0].digest, f.candidate.digest);
});

test("native manifest hash validation rejects substituted content and protocol rejects content or scope claims", async t => {
  const f = await fixture(t);
  f.state.intercept = async (url, response) => { if (!url.endsWith("review-get")) return response; const row = await response.json(); row.manifest.files[0].bytes++; return Response.json(row); };
  await assert.rejects(open(f), /哈希/); assert.equal(f.reviews.entry, null);
  const lease = f.sessions.issueForAppReview(f.reviewer.token);
  for (const patch of [{ source }, { execute: true }, { decision: "deployed" }, { note: "" }, { note: "\u0000" }, { note: "x".repeat(1001) }]) assert.equal((await f.post("/v1/apps/review", lease.token, { ...input(f), ...patch })).status, 400);
  for (const reviewers of [["*"], ["reviewer", "reviewer"], "reviewer", [null]]) assert.throws(() => new AppCatalog({ feishu: SAAS_FEISHU, databaseFile: ":memory:", tenants: [{ ...grants[0], reviewers }] }));
  assert.equal(f.state.decisions, 0);
});
