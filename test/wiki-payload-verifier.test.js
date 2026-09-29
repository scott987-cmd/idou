import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WikiPayloadVerifier } from "../src/control-plane/wiki-payload-verifier.js";
import { WikiCoordinator } from "../src/control-plane/wiki-coordinator.js";
import { DriveBudget, drivePolicies } from "../src/control-plane/drive-budget.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { sealWikiBundle, bundleDigest } from "../src/knowledge/bundle.js";
import { wikiHash } from "../src/knowledge/manifest.js";
import { evidencePage } from "../src/knowledge/local-wiki.js";
import { SYNTHESIS_RECIPE, WIKI_MODEL } from "../src/knowledge/synthesis.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { WIKI_BUNDLE_SCOPES } from "../src/providers/feishu/wiki-bundle-reader.js";
import { loadFeishuLoginConfig } from "../src/control-plane/server-config.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

const record = i => ({ tenantId: "tenant", providerId: "saas-cli", resourceId: `SyntheticSource${i}`, revision: "1", contentHash: wikiHash(`xml-${i}`),
  sourceUrl: `https://test.feishu.cn/docx/SyntheticSource${i}`, title: `Synthetic original ${i}`, text: `PRIVATE SYNTHETIC ORIGINAL ${i}` });
async function fixture(t, { forged = false, synthesis = false, drive = false, enabled = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-payload-")), state = { reads: [], downloads: 0, keys: 0, now: Date.now() };
  const sessions = new SessionRegistry({ now: () => state.now });
  const policy = { authProvider: "feishu", tenantId: "tenant", appId: "cli_test", providerId: "saas-cli", driveTenantKey: "tenant", folderToken: "SyntheticFolder123", maxBytes: 1048576 };
  const budget = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(directory, "budget.sqlite"), policies: [policy] });
  const coordinator = new WikiCoordinator({ databaseFile: path.join(directory, "wiki.sqlite"), tenants: [{ authProvider: "feishu", tenantId: "tenant", appId: "cli_test", members: ["alice", "bob"] }], budget, now: () => state.now });
  const parent = sessions.issue({ ...policy, userId: "alice", deviceId: "device-alice", deviceProof: "ed25519-login" }), alice = sessions.verify(parent.token);
  const bob = sessions.issue({ ...policy, userId: "bob", deviceId: "device-bob", deviceProof: "ed25519-login" });
  const shardKey = wikiHash("shard"), key = randomBytes(32), records = [record(1), record(2)];
  const lease = coordinator.acquire(alice, { shardKey, requestId: randomUUID(), expectedGeneration: 0 });
  coordinator.registerSources(alice, { shardKey, leaseId: lease.id, fence: lease.fence, sources: records.map(({ text, title, sourceUrl, ...row }) => ({ ...row, textSha256: bundleDigest(Buffer.from(text)) })) });
  const binding = { shardKey, generation: 1, fence: lease.fence, nodeId: lease.nodeId, keyId: wikiHash("test-key"), providerId: policy.providerId, driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken };
  const portable = structuredClone(records);
  if (synthesis) {
    const page = evidencePage({ ...records[0], sourceRevision: records[0].revision, partial: false, identity: { principal: "alice", tenantKey: "tenant", verifiedAt: state.now } }, state.now);
    // `synthesis` may name the model that produced it; `true` is the MiniMax default.
    portable[0].synthesis = { recipe: SYNTHESIS_RECIPE, model: typeof synthesis === "string" ? synthesis : WIKI_MODEL, facts: [{ text: "UNSUPPORTED PUBLISHER CLAIM", evidence: [{ chunkId: page.chunks[0].id, quote: records[0].text }] }] };
  }
  const sealed = sealWikiBundle(portable, binding, key);
  if (forged) {
    // A malicious publisher knows its key: create a VALID GCM envelope whose
    // header lies about a hidden third record, with a matching outer hash.
    const offset = 12 + sealed.bytes.readUInt32BE(8), aad = sealed.bytes.subarray(0, offset), iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ version: 1, records: [...records, record(3)] }))), cipher.final()]);
    sealed.bytes = Buffer.concat([aad, iv, cipher.getAuthTag(), ciphertext]);
  }
  const reservationId = randomUUID(), policyDigest = budget.snapshot(alice).policyDigest, sha256 = bundleDigest(sealed.bytes);
  budget.reserve(alice, { id: reservationId, policyDigest, providerId: policy.providerId, driveTenantKey: policy.driveTenantKey, folderToken: policy.folderToken, bytes: sealed.bytes.length, sha256 });
  budget.change(alice, { id: reservationId, policyDigest }, true); budget.change(alice, { id: reservationId, fileToken: "SyntheticFile123" }, false);
  const m = sealed.metadata, manifest = { format: m.format, providerId: m.providerId, driveTenantKey: m.driveTenantKey, folderToken: m.folderToken,
    fileToken: "SyntheticFile123", reservationId, keyId: m.keyId, ciphertextSha256: sha256, bytes: sealed.bytes.length, sourceCount: m.sourceCount, sourceSetHash: m.sourceSetHash };
  const publication = coordinator.publish(alice, { shardKey, leaseId: lease.id, fence: lease.fence, expectedGeneration: 0, manifest });
  const originals = new Map(records.map(row => [row.resourceId, { ...row, sourceRevision: row.revision, partial: false }]));
  const verifier = new WikiPayloadVerifier({ sessions, coordinator,
    readBundle: async input => { state.downloads++; assert.equal(input.publication.manifest.fileToken, "SyntheticFile123"); if (state.onBundle) await state.onBundle(); return sealed.bytes; },
    withKey: async (input, use) => { state.keys++; assert.equal(input.publication.manifest.keyId, binding.keyId); await use(key); if (state.afterKey) await state.afterKey(); },
    readSource: async ({ subject, source, signal }) => {
      assert.equal(subject.userId, "bob"); assert.equal("sourceUrl" in source, false); assert.equal("text" in source, false);
      state.reads.push(source.resourceId); if (state.onSource) await state.onSource(source, signal);
      return { subject: { ...subject, ...(state.subjectPatch || {}) }, document: structuredClone(originals.get(source.resourceId)) };
    },
  });
  let authority;
  if (drive) {
    state.http = []; state.listCalls = 0;
    const fetchImpl = async (url, options) => {
      state.http.push(url); assert.equal(new URL(url).origin, "https://open.feishu.cn");
      assert.equal(options.method, "GET"); assert.equal(options.redirect, "error"); assert.equal(options.headers.authorization, "Bearer PRIVATE-OAUTH");
      if (url.endsWith("/user_info")) return Response.json({ code: 0, data: { open_id: state.otherUser ? "alice" : "bob", tenant_key: "tenant" } });
      if (url.endsWith("/download")) {
        state.downloads++; assert.equal(url, "https://open.feishu.cn/open-apis/drive/v1/files/SyntheticFile123/download");
        assert.equal(options.headers["accept-encoding"], "identity");
        if (state.download) return state.download(options.signal);
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(Uint8Array.from(sealed.bytes.subarray(0, 17)));
          controller.enqueue(Uint8Array.from(sealed.bytes.subarray(17))); controller.close();
        } }), { headers: { "content-type": "application/octet-stream", "content-length": String(sealed.bytes.length) } });
      }
      state.listCalls++;
      assert.equal(new URL(url).searchParams.get("folder_token"), policy.folderToken);
      assert.equal(new URL(url).searchParams.get("page_size"), "200");
      if (state.list) return state.list(new URL(url));
      return Response.json({ code: 0, data: { has_more: false, files: [{ token: "SyntheticFile123", name: `mydoubao-${reservationId}.wiki.bundle`, type: "file", parent_token: policy.folderToken, ...(state.filePatch || {}) }] } });
    };
    authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: policy.appId, originalOrigins: { tenant: "https://test.feishu.cn" }, bundleReadsEnabled: enabled, fetchImpl, now: () => state.now });
    const identity = { appId: policy.appId, tenantId: "tenant", userId: "bob", expiresAt: state.now + 3600000 };
    authority.remember(identity, "PRIVATE-OAUTH"); authority.bind(identity, bob);
    verifier.readBundle = async ({ shardKey, signal }) => {
      const bytes = await authority.readPublishedBundle(bob.token, shardKey, { coordinator, signal });
      state.loaded = bytes; return bytes;
    };
    t.after(() => authority.close());
  }
  const verify = options => verifier.verify(bob.token, shardKey, options);
  t.after(async () => { coordinator.close(); budget.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); });
  return { directory, state, sessions, budget, coordinator, policy, alice, bob, shardKey, records, key, sealed, publication, originals, verifier, verify, authority };
}

test("server payload verifier authenticates real bytes and independently reads all registered originals without persisting content", async t => {
  const f = await fixture(t), before = Buffer.from(f.sealed.bytes), key = Buffer.from(f.key), result = await f.verify();
  assert.equal(result.payloadMatchesDeclaration, true); assert.equal(result.originalsMatched, true);
  assert.equal(result.sourceCount, 2); assert.equal(result.manifestHash, f.publication.manifestHash);
  assert.equal(result.keyReleaseAuthorized, false); assert.equal(result.synthesisProvenance, "absent");
  assert.deepEqual(new Set(f.state.reads), new Set(f.records.map(row => row.resourceId)));
  assert.deepEqual(f.key, key); assert.deepEqual(f.sealed.bytes, before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SyntheticSource|Synthetic original|https:|device-bob/);
  for (const filename of ["wiki.sqlite", "wiki.sqlite-wal", "budget.sqlite", "budget.sqlite-wal"]) {
    const bytes = await readFile(path.join(f.directory, filename)); assert.equal(bytes.includes(Buffer.from(f.records[0].text)), false);
  }
});

test("valid publisher-encrypted hidden records fail despite a matching registered header and ciphertext hash", async t => {
  const f = await fixture(t, { forged: true });
  await assert.rejects(f.verify(), /wiki_payload_or_originals_not_verified/);
  assert.equal(f.state.reads.length, 0); assert.equal(f.state.keys, 1);
});

test("matching originals and real quotes never certify free-form synthesis or authorize key release", async t => {
  const f = await fixture(t, { synthesis: true }), result = await f.verify();
  assert.equal(result.originalsMatched, true); assert.equal(result.synthesisProvenance, "publisher-declared");
  assert.equal(result.keyReleaseAuthorized, false); assert.equal(JSON.stringify(result).includes("UNSUPPORTED PUBLISHER CLAIM"), false);
  assert.equal(result.subjectHash, wikiHash(["feishu", "cli_test", "tenant", "bob", "device-bob"]));
});

test("a GLM-made synthesis verifies exactly like a MiniMax one: declared, never certified", async t => {
  const glm = await (await fixture(t, { synthesis: "GLM-5.3" })).verify(), minimax = await (await fixture(t, { synthesis: true })).verify();
  for (const result of [glm, minimax]) { assert.equal(result.originalsMatched, true); assert.equal(result.synthesisProvenance, "publisher-declared"); assert.equal(result.keyReleaseAuthorized, false); }
  // The model is part of the cited content, so the two packages are distinct content.
  assert.notEqual(glm.contentDigest, minimax.contentDigest);
});

test("changed originals, denied reads and source identity substitutions never produce a successful verification", async t => {
  for (const kind of ["text", "title", "sourceUrl", "contentHash", "sourceRevision", "resourceId", "providerId", "tenantId", "partial", "denied", "subject"]) {
    const f = await fixture(t);
    if (kind === "denied") f.state.onSource = () => { throw new Error("PRIVATE read denied"); };
    else if (kind === "subject") f.state.subjectPatch = { userId: "alice" };
    else f.originals.get(f.records[1].resourceId)[kind] = kind === "partial" ? true : "changed";
    await assert.rejects(f.verify(), error => error.message === "wiki_payload_or_originals_not_verified");
    assert.equal(f.verifier.active, false);
  }
});

test("logout, expiry, cancellation, policy and publication changes across awaits discard verification", async t => {
  for (const kind of ["logout", "expiry", "abort", "policy", "head", "after-key"]) {
    const f = await fixture(t), controller = new AbortController();
    const change = () => {
      if (kind === "logout" || kind === "after-key") f.sessions.revoke(f.bob.token);
      if (kind === "expiry") f.state.now += 3600000;
      if (kind === "abort") controller.abort();
      if (kind === "policy") f.budget.policies = drivePolicies([{ ...f.policy, folderToken: "OtherFolder123" }], SAAS_FEISHU);
      if (kind === "head") {
        const lease = f.coordinator.acquire(f.alice, { shardKey: f.shardKey, requestId: randomUUID(), expectedGeneration: 1 });
        f.coordinator.publish(f.alice, { shardKey: f.shardKey, leaseId: lease.id, fence: lease.fence, expectedGeneration: 1, manifest: null });
      }
    };
    if (kind === "after-key") f.state.afterKey = change; else f.state.onSource = change;
    await assert.rejects(f.verify({ signal: controller.signal })); assert.equal(f.verifier.active, false);
  }
});

test("invalid sessions, child tokens and missing declarations fail before content readers", async t => {
  const f = await fixture(t);
  for (const token of ["invalid", f.sessions.issueForWiki(f.bob.token).token]) await assert.rejects(f.verifier.verify(token, f.shardKey));
  await assert.rejects(f.verifier.verify(f.bob.token, wikiHash("unknown")));
  f.coordinator.db.prepare("DELETE FROM wiki_source_declarations").run(); // Disposable synthetic legacy fixture only.
  await assert.rejects(f.verify()); assert.equal(f.state.downloads, 0); assert.equal(f.state.keys, 0);
});

test("verifier is single-flight and releases its slot after cancelled original reads", async t => {
  const f = await fixture(t), controller = new AbortController(); let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  f.state.onSource = async (_, signal) => { enter(); await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); };
  const pending = f.verify({ signal: controller.signal }); await entered;
  await assert.rejects(f.verify(), /busy/); controller.abort(); await assert.rejects(pending);
  f.state.onSource = null; assert.equal((await f.verify()).sourceCount, 2);
});

test("corrupt downloaded artifacts and unavailable key custody cannot be verified", async t => {
  for (const kind of ["bytes", "key", "missing", "nonbuffer"]) {
    const f = await fixture(t);
    if (kind === "bytes") f.sealed.bytes[f.sealed.bytes.length - 1] ^= 1;
    if (kind === "key") f.verifier.withKey = async (_, use) => use(randomBytes(32));
    if (kind === "missing") f.verifier.withKey = async () => {};
    if (kind === "nonbuffer") f.verifier.readBundle = async () => "PRIVATE invalid artifact";
    await assert.rejects(f.verify()); assert.equal(f.state.reads.length, 0);
  }
  assert.throws(() => new WikiPayloadVerifier({}), /required/);
});

test("server-owned OAuth Drive download feeds real bundle verification with exact registered folder and bytes", async t => {
  const f = await fixture(t, { drive: true });
  const result = await f.verify();
  assert.equal(result.originalsMatched, true); assert.equal(result.keyReleaseAuthorized, false);
  assert.equal(f.state.downloads, 1); assert.equal(f.state.listCalls, 2); assert.deepEqual(f.state.loaded, f.sealed.bytes);
  assert.equal(f.authority.active, 0);
  for (const filename of ["wiki.sqlite", "wiki.sqlite-wal", "budget.sqlite", "budget.sqlite-wal"]) {
    const bytes = await readFile(path.join(f.directory, filename));
    assert.equal(bytes.includes(f.sealed.bytes.subarray(-50)), false); assert.equal(bytes.includes(Buffer.from("PRIVATE-OAUTH")), false);
  }
});

test("server Drive reads are opt-in with only explicit read scopes and no client credential import", async t => {
  const f = await fixture(t, { drive: true, enabled: false }); await assert.rejects(f.verify()); assert.equal(f.state.http.length, 0);
  const enabled = await fixture(t, { drive: true });
  assert.ok(WIKI_BUNDLE_SCOPES.every(scope => enabled.authority.requiredScopes.includes(scope)));
  assert.ok(WIKI_BUNDLE_SCOPES.every(scope => !f.authority.requiredScopes.includes(scope)));
  const oauth = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_test", appSecret: "PRIVATE-app", sourceAccess: enabled.authority });
  const url = new URL(oauth.authorizationUrl({ redirectUri: "https://control.example/callback", state: "s", challenge: "c" }));
  assert.deepEqual(url.searchParams.get("scope").split(" "), [...enabled.authority.requiredScopes]);
  const env = { IDOU_PUBLIC_URL: "https://control.example", FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "PRIVATE-app", FEISHU_ALLOWED_TENANTS: "tenant", FEISHU_SOURCE_ACCESS_ENABLED: "1" };
  assert.equal(loadFeishuLoginConfig(env).bundleReadsEnabled, false);
  assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_WIKI_BUNDLE_READS_ENABLED: "1" }));
  const configured = { ...env, FEISHU_WIKI_ORIGINAL_ORIGINS: '{"tenant":"https://test.feishu.cn"}', FEISHU_WIKI_BUNDLE_READS_ENABLED: "1" };
  assert.equal(loadFeishuLoginConfig(configured).bundleReadsEnabled, true);
  assert.throws(() => loadFeishuLoginConfig({ ...configured, FEISHU_WIKI_BUNDLE_READS_ENABLED: "true" }));
});

test("download never adopts same-name files, shortcuts, renamed or foreign-folder artifacts", async t => {
  for (const patch of [{ token: "OtherFile" }, { type: "shortcut" }, { parent_token: "OtherFolder" }, { name: "renamed" }, { shortcut_info: { target_token: "SyntheticFile123" } }]) {
    const f = await fixture(t, { drive: true }); f.state.filePatch = patch;
    await assert.rejects(f.verify()); assert.equal(f.state.downloads, 0); assert.equal(f.state.keys, 0);
  }
  const f = await fixture(t, { drive: true }); f.state.otherUser = true;
  await assert.rejects(f.verify()); assert.equal(f.state.listCalls, 0);
});

test("bounded folder pagination follows opaque cursors and fails missing, repeated or excessive continuations", async t => {
  for (const kind of ["valid", "missing", "cycle", "limit"]) {
    const f = await fixture(t, { drive: true });
    f.state.list = url => {
      if (kind === "valid" && url.searchParams.get("page_token") === "opaque +/&cursor") return Response.json({ code: 0, data: { has_more: false, files: [{ token: "SyntheticFile123", name: `mydoubao-${f.publication.manifest.reservationId}.wiki.bundle`, type: "file", parent_token: f.policy.folderToken }] } });
      return Response.json({ code: 0, data: { has_more: true, files: [], next_page_token: kind === "missing" ? undefined : kind === "limit" ? String(f.state.listCalls) : "opaque +/&cursor" } });
    };
    if (kind === "valid") { assert.equal((await f.verify()).sourceCount, 2); assert.equal(f.state.listCalls, 4); }
    else { await assert.rejects(f.verify()); assert.ok(f.state.listCalls <= 10); assert.equal(f.state.downloads, 0); }
  }
});

test("binary stream rejects hash, size, encoding, partial and redirect errors before key access and cancels bodies", async t => {
  for (const kind of ["hash", "short", "long", "length", "encoding", "range", "redirect", "denied", "stream-error"]) {
    const f = await fixture(t, { drive: true }); let cancelled = false;
    f.state.download = () => {
      const bytes = Buffer.from(f.sealed.bytes); if (kind === "hash") bytes[bytes.length - 1] ^= 1;
      const body = new ReadableStream({ start(controller) {
        if (kind === "stream-error") { controller.error(new Error("PRIVATE upstream")); return; }
        controller.enqueue(kind === "short" ? bytes.subarray(1) : kind === "long" ? Buffer.concat([bytes, Buffer.from([0])]) : bytes);
        if (["short", "hash"].includes(kind)) controller.close();
      }, cancel() { cancelled = true; } });
      const headers = kind === "length" ? { "content-length": String(bytes.length + 1) } : kind === "encoding" ? { "content-encoding": "gzip" } : kind === "range" ? { "content-range": "bytes 0-1/2" } : {};
      return new Response(body, { status: kind === "redirect" ? 302 : kind === "denied" ? 403 : 200, headers });
    };
    await assert.rejects(f.verify(), error => error.message === "wiki_payload_or_originals_not_verified");
    if (!["hash", "short", "stream-error"].includes(kind)) assert.equal(cancelled, true);
    assert.equal(f.state.keys, 0); assert.equal(f.state.downloads, 1); assert.equal(f.authority.active, 0);
  }
});

test("download checks current publication and policy after streams and catches a file moved during retrieval", async t => {
  for (const kind of ["move", "policy", "head", "logout"]) {
    const f = await fixture(t, { drive: true });
    f.state.download = () => {
      if (kind === "move") f.state.filePatch = { parent_token: "OtherFolder" };
      if (kind === "policy") f.budget.policies = drivePolicies([{ ...f.policy, folderToken: "OtherFolder" }], SAAS_FEISHU);
      if (kind === "logout") f.sessions.revoke(f.bob.token);
      if (kind === "head") {
        const lease = f.coordinator.acquire(f.alice, { shardKey: f.shardKey, requestId: randomUUID(), expectedGeneration: 1 });
        f.coordinator.publish(f.alice, { shardKey: f.shardKey, leaseId: lease.id, fence: lease.fence, expectedGeneration: 1, manifest: null });
      }
      return new Response(f.sealed.bytes);
    };
    await assert.rejects(f.verify()); assert.equal(f.state.keys, 0); assert.equal(f.authority.active, 0);
  }
});

test("logout actively cancels stalled binary streams and releases the server read slot", async t => {
  const f = await fixture(t, { drive: true }); let entered, cancelled = false;
  const ready = new Promise(resolve => { entered = resolve; });
  f.state.download = () => new Response(new ReadableStream({ pull() { entered(); }, cancel() { cancelled = true; } }));
  const pending = f.verify(); await ready;
  await assert.rejects(f.authority.readPublishedBundle(f.bob.token, f.shardKey, { coordinator: f.coordinator }), /busy/);
  f.sessions.revoke(f.bob.token); await assert.rejects(pending);
  assert.equal(cancelled, true); assert.equal(f.state.keys, 0); assert.equal(f.authority.active, 0);
});

test("download rate slots are shared across attempts and failures are not automatically retried", async t => {
  const f = await fixture(t, { drive: true }); f.state.download = () => new Response("denied", { status: 403 });
  for (let i = 0; i < 6; i++) await assert.rejects(f.verify());
  assert.equal(f.state.downloads, 5); assert.equal(f.state.keys, 0);
  f.state.now += 1001; await assert.rejects(f.verify()); assert.equal(f.state.downloads, 6);
});
