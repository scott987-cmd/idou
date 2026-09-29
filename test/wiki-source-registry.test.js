import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { WikiCoordinator, WikiCoordinatorService } from "../src/control-plane/wiki-coordinator.js";
import { WikiSourceRegistryService } from "../src/control-plane/wiki-source-registry.js";
import { WikiCoordinatorClient } from "../src/knowledge/coordinator-client.js";
import { WikiSourceRegistryClient } from "../src/knowledge/source-registry-client.js";
import { DriveBudget, drivePolicies } from "../src/control-plane/drive-budget.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { sourceDeclaration } from "../src/knowledge/source-declaration.js";
import { sourceAccessInput } from "../src/knowledge/source-access-contract.js";
import { bundleDigest, bundleSourceSetHash, sealWikiBundle } from "../src/knowledge/bundle.js";
import { wikiHash } from "../src/knowledge/manifest.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const record = i => ({ tenantId: "tenant", providerId: "saas-cli", resourceId: `SyntheticDoc${i}`, sourceUrl: `https://test.feishu.cn/docx/SyntheticDoc${i}`,
  revision: "1", contentHash: wikiHash(`source-${i}`), title: "Synthetic title", text: `Synthetic text ${i}` });
const metadata = records => records.map(({ tenantId, providerId, resourceId, revision, contentHash, text }) => ({ tenantId, providerId, resourceId, revision, contentHash, textSha256: bundleDigest(Buffer.from(text)) }));
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-source-registry-")), state = { now: Date.now(), checked: [] }, connections = [];
  const sessions = new SessionRegistry({ now: () => state.now });
  const policy = { authProvider: "feishu", tenantId: "tenant", appId: "cli_test", providerId: "saas-cli", driveTenantKey: "tenant", folderToken: "SyntheticFolder123", maxBytes: 1048576 };
  const budget = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(directory, "budget.sqlite"), policies: [policy] });
  const make = () => { const value = new WikiCoordinator({ databaseFile: path.join(directory, "wiki.sqlite"), tenants: [{ authProvider: "feishu", tenantId: "tenant", appId: "cli_test", members: ["alice", "bob"] }], budget, now: () => state.now }); connections.push(value); return value; };
  const coordinator = make();
  const sourceAccess = { feishu: SAAS_FEISHU, check: async (token, input) => {
    const who = sessions.verify(token); state.checked.push({ user: who.userId, sources: structuredClone(input.sources) });
    if (state.onCheck) await state.onCheck(); if (state.denied) throw new Error("SECRET denied");
    return { authorized: true, pointInTime: true, sourceSetHash: sourceAccessInput(input).sourceSetHash,
      identity: { appId: who.appId, tenantId: who.tenantId, userId: who.userId, deviceId: who.deviceId } };
  } };
  const registry = new WikiSourceRegistryService({ sessions, coordinator, sourceAccess }), service = new WikiCoordinatorService({ sessions, coordinator });
  const server = createServer(async (req, res) => { if (!await registry.handle(req, res) && !await service.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const issue = (userId = "alice", patch = {}) => sessions.issue({ ...policy, userId, deviceId: `device-${userId}`, deviceProof: "ed25519-login", ...patch });
  const parent = issue(), who = sessions.verify(parent.token), getSession = async () => ({ ...parent, serverUrl: origin });
  const client = new WikiCoordinatorClient({ getSession, now: () => state.now }), native = new WikiSourceRegistryClient({ getSession, now: () => state.now });
  const shardKey = wikiHash("source-shard");
  const claim = async (generation = 0) => client.acquire({ shardKey, requestId: randomUUID(), expectedGeneration: generation });
  const input = (lease, records = [record(1)]) => ({ shardKey, leaseId: lease.id, fence: lease.fence, sources: metadata(records) });
  const manifest = (lease, records = [record(1)]) => {
    const sealed = sealWikiBundle(records, { shardKey, generation: lease.expectedGeneration + 1, fence: lease.fence, nodeId: lease.nodeId, keyId: wikiHash("key"), providerId: "saas-cli", driveTenantKey: "tenant", folderToken: policy.folderToken }, randomBytes(32));
    const id = randomUUID(), policyDigest = budget.snapshot(who).policyDigest;
    budget.reserve(who, { id, policyDigest, providerId: policy.providerId, driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken, bytes: sealed.bytes.length, sha256: sealed.metadata.ciphertextSha256 });
    budget.change(who, { id, policyDigest }, true); budget.change(who, { id, fileToken: "SyntheticFile123" }, false);
    const m = sealed.metadata;
    return { format: m.format, providerId: m.providerId, driveTenantKey: m.driveTenantKey, folderToken: m.folderToken, fileToken: "SyntheticFile123", reservationId: id,
      ciphertextSha256: m.ciphertextSha256, bytes: m.bytes, keyId: m.keyId, sourceSetHash: m.sourceSetHash, sourceCount: m.sourceCount };
  };
  const publish = (lease, value) => client.publish({ shardKey, leaseId: lease.id, fence: lease.fence, expectedGeneration: lease.expectedGeneration, manifest: value });
  const post = (action, body, token = parent.token, headers = {}) => fetch(`${origin}/v1/wiki/sources/${action}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); for (const db of connections) db.close(); budget.close(); await rm(directory, { recursive: true, force: true }); });
  return { state, sessions, coordinator, make, client, native, who, parent, budget, policy, sourceAccess, shardKey, claim, input, manifest, publish, post, issue, origin };
}

test("declaration digest independently matches the actual bundle source set and rejects text/URL/duplicates", () => {
  const records = [record(2), record(1)];
  assert.equal(sourceDeclaration(metadata(records)).sourceSetHash, bundleSourceSetHash(records));
  assert.deepEqual(sourceDeclaration(metadata(records)), sourceDeclaration(metadata(records.reverse())));
  for (const values of [[], [...metadata(records), metadata(records)[0]], [{ ...metadata(records)[0], text: "SECRET" }], [{ ...metadata(records)[0], sourceUrl: "https://example.com" }], [{ ...metadata(records)[0], contentHash: "text-not-hash" }]]) assert.throws(() => sourceDeclaration(values));
});

test("immutable registration survives another database connection and checks the stored set as a different recipient", async t => {
  const f = await fixture(t), lease = await f.claim(), records = [record(1), record(2)], input = f.input(lease, records);
  const receipt = await f.native.register(input); assert.equal(receipt.contentVerified, false);
  assert.deepEqual(await f.native.register({ ...input, sources: input.sources.toReversed() }), receipt);
  assert.deepEqual(f.make().registerSources(f.who, input), receipt);
  await assert.rejects(f.native.register(f.input(lease, [record(3)])));
  const published = await f.publish(lease, f.manifest(lease, records));
  const bob = f.issue("bob"), recipient = new WikiSourceRegistryClient({ getSession: async () => ({ ...bob, serverUrl: f.origin }) });
  const result = await recipient.checkPublished(f.shardKey);
  assert.equal(result.manifestHash, published.manifestHash); assert.equal(result.provenance, "publisher-declared"); assert.equal(result.contentVerified, false);
  assert.deepEqual(new Set(f.state.checked.at(-1).sources.map(row => row.resourceId)), new Set(records.map(row => row.resourceId)));
  assert.equal(f.state.checked.at(-1).user, "bob");
  const dbRows = JSON.stringify(f.coordinator.db.prepare("SELECT * FROM wiki_source_declarations").all());
  assert.doesNotMatch(dbRows, /Synthetic text|Synthetic title|https:|SECRET/);
  const forged = await f.post("check", { shardKey: f.shardKey, sources: metadata([record(3)]) }, bob.token); assert.equal(forged.status, 403);
});

test("a manifest cannot commit a different source set or count after registration", async t => {
  for (const kind of ["hash", "count"]) {
    const f = await fixture(t), lease = await f.claim(); await f.native.register(f.input(lease)); const manifest = f.manifest(lease);
    if (kind === "hash") manifest.sourceSetHash = wikiHash("other-source"); else manifest.sourceCount++;
    await assert.rejects(f.publish(lease, manifest)); assert.equal((await f.client.head(f.shardKey)).publication, null);
  }
});

test("registration is atomic across denied batches, logout and lease expiration during source checks", async t => {
  for (const kind of ["second-batch", "logout", "expired", "policy"]) {
    const f = await fixture(t), lease = await f.claim();
    f.state.onCheck = async () => {
      if (kind === "second-batch" && f.state.checked.length === 2) f.state.denied = true;
      if (kind === "logout") f.sessions.revoke(f.parent.token);
      if (kind === "expired") f.state.now += 120001;
      if (kind === "policy") f.budget.policies = drivePolicies([{ ...f.policy, folderToken: "NewFolder123" }], SAAS_FEISHU);
    };
    await assert.rejects(f.native.register(f.input(lease, Array.from({ length: 21 }, (_, i) => record(i)))));
    assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_source_declarations").get().n, 0);
  }
});

test("foreign node, child token, foreign tenant, wrong source tenant and browser cannot register", async t => {
  const f = await fixture(t), lease = await f.claim(), input = f.input(lease);
  for (const token of [f.issue("bob").token, f.sessions.issueForWiki(f.parent.token).token, f.issue("alice", { tenantId: "foreign" }).token]) assert.equal((await f.post("register", input, token)).status, 403);
  assert.equal((await f.post("register", { ...input, sources: input.sources.map(row => ({ ...row, tenantId: "foreign" })) })).status, 403);
  assert.equal((await f.post("register", input, f.parent.token, { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.post("register", { ...input, text: "SECRET" })).status, 403);
  assert.equal(f.state.checked.length, 0);
});

test("current permission denial or head withdrawal during a recipient check cannot return old success", async t => {
  for (const kind of ["denied", "withdrawn", "policy"]) {
    const f = await fixture(t), lease = await f.claim(); await f.native.register(f.input(lease)); await f.publish(lease, f.manifest(lease));
    assert.equal((await f.native.checkPublished(f.shardKey)).declaredSourcesReadable, true);
    if (kind === "denied") f.state.denied = true;
    else if (kind === "policy") f.budget.policies = drivePolicies([{ ...f.policy, folderToken: "NewFolder123" }], SAAS_FEISHU);
    else f.state.onCheck = async () => { const next = await f.claim(1); await f.publish(next, null); };
    await assert.rejects(f.native.checkPublished(f.shardKey));
  }
});

test("schema-one migration preserves legacy publications without inventing source declarations", async t => {
  const f = await fixture(t), lease = await f.claim(), published = await f.publish(lease, f.manifest(lease));
  f.coordinator.db.exec("DROP TABLE wiki_source_declarations; PRAGMA user_version=1;");
  const migrated = f.make(); assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 2);
  assert.deepEqual(migrated.head(f.who, { shardKey: f.shardKey }).publication, published);
  assert.throws(() => migrated.publishedSources(f.who, f.shardKey), /declaration_missing/);
  assert.equal(migrated.db.prepare("SELECT COUNT(*) AS n FROM wiki_source_declarations").get().n, 0);
});

test("native client rejects substituted declarations, false verified claims and account changes", async t => {
  const f = await fixture(t), lease = await f.claim();
  for (const patch of [{ contentVerified: true }, { sourceSetHash: wikiHash("other") }, { generation: 0 }, { leaseId: randomUUID() }]) {
    const native = new WikiSourceRegistryClient({ getSession: async () => ({ ...f.parent, serverUrl: f.origin }), fetchImpl: async (...args) => Response.json({ ...await (await fetch(...args)).json(), ...patch }) });
    await assert.rejects(native.register(f.input(lease)));
  }
  let current = { ...f.parent, serverUrl: f.origin };
  const native = new WikiSourceRegistryClient({ getSession: async () => current, fetchImpl: async (...args) => { const result = await fetch(...args); current = { ...current, token: "x".repeat(43) }; return result; } });
  await assert.rejects(native.register(f.input(lease)));
});
