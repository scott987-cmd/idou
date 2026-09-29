import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, webcrypto } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { sealWikiBundle, openWikiBundle, portablePage, bundleDigest } from "../src/knowledge/bundle.js";
import { WikiBundleReceiver } from "../src/knowledge/bundle-receiver.js";
import { wikiHash, wikiManifest } from "../src/knowledge/manifest.js";
import { SYNTHESIS_RECIPE, WIKI_MODEL, synthesisKey, validateFacts, synthesisInput } from "../src/knowledge/synthesis.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { storedPages, storedBytes } from "../scripts/fixtures/wiki-store.js";
import { sameFileName } from "../src/product-names.js";

// Each source is its own document, not a copy of the others: the store now
// notices near-identical documents and sends one of them for the group, so a
// fixture whose "two sources" were the same words would be testing that instead.
const document = (id = "SourceDocument123") => ({ providerId: "saas-cli", resourceId: id, sourceRevision: "7", contentHash: `provider-content-hash-${id}`, sourceUrl: `https://test.feishu.cn/docx/${id}`,
  title: `采购验收说明 ${id}`, text: `采购验收仅面向采购组。\n下周二交付测试报告。\n本说明适用于 ${id} 批次，联系人 ${id.slice(-6)}，验收地点在 ${id.slice(0, 6)} 仓库，验收项目包括外观、数量与随附文件。`, partial: false, warnings: [] });
// `models[i]` is the chat model that produced page i's synthesis (default MiniMax).
async function setup(t, count = 1, models = []) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-bundle-")), docs = Array.from({ length: count }, (_, i) => document(`SourceDocument${i}123`)), nodes = [];
  const make = (principal, filename = `${principal}.enc`, cipher = fixtureCipher()) => {
    const state = { principal, tenantKey: "tenant", reads: [], denied: false, models: 0 }, identity = () => ({ principal: state.principal, tenantKey: state.tenantKey, verifiedAt: Date.now() });
    const provider = { documentIdentity: async () => identity(), readDocument: async url => {
      state.reads.push(url); if (state.beforeRead) await state.beforeRead(url);
      if (state.denied) throw new Error("SECRET permission detail");
      const value = docs.find(doc => doc.sourceUrl === url); if (!value) throw new Error("not found");
      return { ...structuredClone(value), identity: identity() };
    } };
    const wiki = new LocalWiki({ filename: path.join(directory, filename), cipher, provider }); nodes.push(wiki);
    return { wiki, provider, state, identity, cipher, filename: wiki.filename };
  };
  const alice = make("alice"), bob = make("bob");
  for (const doc of docs) await alice.wiki.observe({ ...doc, identity: alice.identity() });
  const exportResult = await alice.wiki.exportEvidence(alice.wiki.pages.map(page => page.id));
  // Synthetic cited synthesis, no model service used. This is fixture data only.
  const pages = exportResult.pages.map((page, i) => ({ ...page, synthesis: { key: synthesisKey(page), recipe: SYNTHESIS_RECIPE, model: models[i] ?? WIKI_MODEL, state: "complete",
    facts: validateFacts({ facts: [{ text: "验收范围是采购组。", evidence: [{ chunkId: page.chunks[0].id, quote: "仅面向采购组" }] }] }, page), coverage: synthesisInput(page).coverage } }));
  const binding = { shardKey: wikiHash("shard"), generation: 1, fence: 3, nodeId: wikiHash("alice-node"), keyId: wikiHash("authorized-key-reference"), providerId: "saas-cli", driveTenantKey: "tenant", folderToken: "Folder123" };
  const key = randomBytes(32), sealed = sealWikiBundle(pages.map(portablePage), binding, key);
  const manifest = wikiManifest({ format: sealed.metadata.format, providerId: binding.providerId, driveTenantKey: binding.driveTenantKey, folderToken: binding.folderToken,
    fileToken: "FileToken123", reservationId: randomUUID(), keyId: binding.keyId, ciphertextSha256: sealed.metadata.ciphertextSha256, bytes: sealed.bytes.length, sourceCount: count, sourceSetHash: sealed.metadata.sourceSetHash });
  const publication = { state: "published", clientReported: true, generation: binding.generation, fence: binding.fence, nodeId: binding.nodeId, manifest, manifestHash: wikiHash(manifest) };
  const state = { publication, bytes: sealed.bytes, downloads: 0, releases: 0, revokedKey: false };
  const coordinator = { head: async () => ({ publication: structuredClone(state.publication) }) };
  const folder = { token: binding.folderToken, url: "https://test.feishu.cn/drive/folder/Folder123", title: "知识包", providerId: "saas-cli", identity: bob.identity() };
  const drive = { resolveFolder: async () => structuredClone(folder), unchanged: async expected => {
    if (expected.principal !== bob.state.principal || expected.tenantKey !== bob.state.tenantKey) throw new Error("changed");
  }, download: async input => { state.downloads++; assert.equal(input.maxBytes, manifest.bytes); assert.equal(input.fileToken, manifest.fileToken); assert.ok(sameFileName(input.name, `mydoubao-${manifest.reservationId}.wiki.bundle`), input.name); if (state.onDownload) await state.onDownload(); return state.bytes; } };
  const keyAuthority = { acquire: async ({ publication: requested, identity }) => {
    assert.equal(requested.manifest.keyId, binding.keyId); assert.equal(identity.principal, "bob");
    if (state.deniedKey) throw new Error("SECRET key detail");
    return { key, assertCurrent: async () => { if (state.revokedKey) throw new Error("SECRET revoked"); }, release: async () => { state.releases++; } };
  } };
  const receiver = new WikiBundleReceiver({ coordinator, drive, wiki: bob.wiki, keyAuthority });
  t.after(async () => { for (const node of nodes) await node.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); });
  return { make, alice, bob, docs, pages, binding, key, sealed, manifest, publication, state, receiver, coordinator, drive, keyAuthority, folder };
}

test("portable encrypted package round-trips through independent WebCrypto authentication without exposed sources", async t => {
  const f = await setup(t), { bytes } = f.sealed;
  assert.equal(bytes.includes(Buffer.from("采购")), false); assert.equal(bytes.includes(Buffer.from("SourceDocument")), false); assert.equal(bytes.includes(f.key), false);
  const offset = 12 + bytes.readUInt32BE(8), key = await webcrypto.subtle.importKey("raw", f.key, "AES-GCM", false, ["decrypt"]);
  const plaintext = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(offset, offset + 12), additionalData: bytes.subarray(0, offset), tagLength: 128 }, key,
    Buffer.concat([bytes.subarray(offset + 28), bytes.subarray(offset + 12, offset + 28)]));
  assert.equal(JSON.parse(Buffer.from(plaintext)).records[0].text, f.docs[0].text);
  const records = openWikiBundle(bytes, { shardKey: f.binding.shardKey, publication: f.publication, key: f.key });
  assert.equal(records[0].text, f.docs[0].text); assert.doesNotMatch(JSON.stringify(records), /aclEvidence|principal|owner/);
  const next = sealWikiBundle(f.pages.map(portablePage), f.binding, f.key); assert.notDeepEqual(next.bytes, bytes); assert.equal(next.metadata.sourceSetHash, f.sealed.metadata.sourceSetHash);
});

test("another user imports only freshly authorized sources and preserves cited synthesis through encrypted restart", async t => {
  const f = await setup(t, 2), before = Buffer.from(f.key);
  assert.deepEqual(await f.receiver.receive(f.binding.shardKey, f.folder.url), { retained: 2, requested: 2 });
  assert.equal(f.state.downloads, 1); assert.equal(f.state.releases, 1); assert.deepEqual(f.key, before, "receiver must not mutate authority-owned key");
  const saved = { pages: await storedPages(f.bob.cipher, f.bob.filename) };
  assert.ok(saved.pages.every(page => page.principal === "bob" && page.aclEvidence.subject === "bob"));
  const result = await f.bob.wiki.search("采购"); assert.equal(result.hits.length, 2);
  assert.equal(result.hits[0].synthesis.origin.ciphertextSha256, f.manifest.ciphertextSha256);
  assert.equal(result.hits[0].synthesis.facts[0].evidence[0].quote, "仅面向采购组");
  assert.equal((await readFile(f.bob.filename)).includes(Buffer.from("采购")), false);
  await f.bob.wiki.close(); const restored = f.make("bob", "bob.enc", f.bob.cipher);
  assert.equal((await restored.wiki.search("采购")).hits[0].synthesis.origin.kind, "wiki-bundle");
  restored.state.denied = true; assert.equal((await restored.wiki.search("采购")).hits.length, 0);
});

test("tampered ciphertext, tag, header and substituted publication fail even with a recomputed outer hash", async t => {
  const f = await setup(t);
  for (const index of [0, 8, 15, 12 + f.sealed.bytes.readUInt32BE(8) + 12, f.sealed.bytes.length - 1]) {
    const bytes = Buffer.from(f.sealed.bytes); bytes[index] ^= 1;
    const manifest = { ...f.manifest, ciphertextSha256: bundleDigest(bytes) }, publication = { ...f.publication, manifest, manifestHash: wikiHash(manifest) };
    assert.throws(() => openWikiBundle(bytes, { shardKey: f.binding.shardKey, publication, key: f.key }), /校验失败/);
  }
  for (const patch of [{ generation: 2 }, { fence: 4 }, { nodeId: wikiHash("other") }, { state: "tombstone" }]) assert.throws(() => openWikiBundle(f.sealed.bytes, { shardKey: f.binding.shardKey, publication: { ...f.publication, ...patch }, key: f.key }));
  assert.throws(() => openWikiBundle(f.sealed.bytes, { shardKey: wikiHash("wrong shard"), publication: f.publication, key: f.key }));
  assert.throws(() => openWikiBundle(f.sealed.bytes, { shardKey: f.binding.shardKey, publication: f.publication, key: randomBytes(32) }));
});

test("bundle bounds, duplicate sources, cross-tenant records and invalid citations are rejected", async t => {
  const f = await setup(t), record = portablePage(f.pages[0]);
  for (const values of [[], Array(201).fill(record), [record, record], [{ ...record, tenantId: "other" }], [{ ...record, text: "x".repeat(500001) }], [{ ...record, extra: "SECRET" }], [{ ...record, synthesis: { ...record.synthesis, facts: [{ text: "invented", evidence: [{ chunkId: "bad", quote: "not original" }] }] } }]]) {
    assert.throws(() => sealWikiBundle(values, f.binding, f.key), /校验失败/);
  }
  assert.throws(() => openWikiBundle(Buffer.alloc(10485761), { shardKey: f.binding.shardKey, publication: f.publication, key: f.key }));
});

test("source denial or version/content/identity change imports none of a multi-source package", async t => {
  for (const kind of ["denied", "version", "text", "redirect", "identity", "partial"]) {
    const f = await setup(t, 2);
    f.bob.state.beforeRead = url => {
      if (url !== f.docs[1].sourceUrl) return;
      if (kind === "denied") f.bob.state.denied = true;
      if (kind === "version") f.docs[1].sourceRevision = "8";
      if (kind === "text") f.docs[1].text = "changed with same upstream hash";
      if (kind === "redirect") f.docs[1].resourceId = "wrong resource";
      if (kind === "identity") f.bob.state.principal = "mallory";
      if (kind === "partial") f.docs[1].partial = true;
    };
    await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url), /取回失败/);
    await assert.rejects(readFile(f.bob.filename), { code: "ENOENT" }); assert.equal(f.state.releases, 1);
  }
});

test("missing/denied key authority never downloads; revoked grant or withdrawn generation never imports", async t => {
  for (const kind of ["missing", "denied", "revoked", "withdrawn", "corrupt"]) {
    const f = await setup(t);
    if (kind === "missing") f.receiver.keyAuthority = null;
    if (kind === "denied") f.state.deniedKey = true;
    if (kind === "revoked") f.state.onDownload = () => { f.state.revokedKey = true; };
    if (kind === "withdrawn") f.state.onDownload = () => { f.state.publication = { ...f.publication, state: "tombstone", manifest: null }; };
    if (kind === "corrupt") f.state.bytes = Buffer.from("not the package");
    await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url));
    assert.equal(f.state.downloads, ["missing", "denied"].includes(kind) ? 0 : 1);
    await assert.rejects(readFile(f.bob.filename), { code: "ENOENT" }); assert.equal(f.receiver.active, false);
  }
});

test("authorization is rechecked after local encryption and before import rename", async t => {
  const f = await setup(t), encrypt = f.bob.cipher.encrypt;
  f.bob.cipher.encrypt = text => { f.state.revokedKey = true; return encrypt(text); };
  await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url), /取回失败/);
  await assert.rejects(readFile(f.bob.filename), { code: "ENOENT" });
});

test("logout during the final coordinator read prevents the local commit", async t => {
  const f = await setup(t), encrypt = f.bob.cipher.encrypt, head = f.coordinator.head;
  let allowed = true, revokeOnHead = false;
  f.receiver.businessAccess = () => { if (!allowed) throw new Error("SECRET expired session"); };
  f.bob.cipher.encrypt = text => { revokeOnHead = true; return encrypt(text); };
  f.coordinator.head = async (...args) => { const result = await head(...args); if (revokeOnHead) allowed = false; return result; };
  await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url), /取回失败/);
  await assert.rejects(readFile(f.bob.filename), { code: "ENOENT" });
  assert.equal(f.state.releases, 1);
});

test("receiver is single-flight and release failure cannot expose secrets or replay a committed import", async t => {
  const f = await setup(t), acquire = f.keyAuthority.acquire;
  f.keyAuthority.acquire = async input => ({ ...await acquire(input), release: async () => { f.state.releases++; throw new Error("SECRET release failure"); } });
  let releaseDownload, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.state.onDownload = () => { entered(); return new Promise(resolve => { releaseDownload = resolve; }); };
  const receiving = f.receiver.receive(f.binding.shardKey, f.folder.url);
  await started;
  await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url), /已有知识包/);
  releaseDownload(); assert.deepEqual(await receiving, { retained: 1, requested: 1 });
  assert.equal(f.state.downloads, 1); assert.equal(f.state.releases, 1); assert.equal(f.receiver.active, false);
  assert.equal((await f.bob.wiki.search("采购")).hits.length, 1);
});

test("abort or close during source read prevents import and releases the granted key", async t => {
  for (const kind of ["abort", "close"]) {
    const f = await setup(t), controller = new AbortController();
    f.bob.state.beforeRead = () => { if (kind === "abort") controller.abort(); else void f.bob.wiki.close(); };
    await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url, { signal: controller.signal }), /取回失败/);
    await assert.rejects(readFile(f.bob.filename), { code: "ENOENT" }); assert.equal(f.state.releases, 1);
  }
});

test("export refreshes changed sources, denies revoked sources and ignores foreign/expired source IDs", async t => {
  const f = await setup(t), ids = f.alice.wiki.pages.map(page => page.id);
  f.docs[0].sourceRevision = "8"; f.docs[0].text = "new canonical text";
  const result = await f.alice.wiki.exportEvidence(ids); assert.equal(result.pages[0].revision, "8"); assert.equal(result.pages[0].chunks[0].text, "new canonical text");
  await assert.rejects(f.alice.wiki.exportEvidence([wikiHash("unknown")]));
  f.alice.state.principal = "other"; await assert.rejects(f.alice.wiki.exportEvidence(ids));
  f.alice.state.principal = "alice"; f.alice.state.denied = true; await assert.rejects(f.alice.wiki.exportEvidence(ids));
  f.alice.state.denied = false; f.alice.wiki.now = () => Date.now() + f.alice.wiki.retentionMs + 1;
  await assert.rejects(f.alice.wiki.exportEvidence(ids), /已失效/);
});

test("import refuses unavailable encryption and preserves an unreadable existing cache", async t => {
  for (const kind of ["unavailable", "corrupt"]) {
    const f = await setup(t), original = Buffer.from("synthetic-unreadable-cache");
    if (kind === "unavailable") f.bob.cipher.available = () => false;
    else await writeFile(f.bob.filename, original, { mode: 0o600 });
    await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url), /取回失败/);
    if (kind === "corrupt") assert.deepEqual(await readFile(f.bob.filename), original);
    else await assert.rejects(readFile(f.bob.filename), { code: "ENOENT" });
    assert.equal(f.bob.state.reads.length, 0); assert.equal(f.state.releases, 1);
  }
});

function registeredReceipt(f) {
  return { shardKey: f.binding.shardKey, generation: f.publication.generation, manifestHash: f.publication.manifestHash,
    sourceSetHash: f.manifest.sourceSetHash, sourceCount: f.manifest.sourceCount,
    declaredSourcesReadable: true, pointInTime: true, provenance: "publisher-declared", contentVerified: false };
}

test("receiver rejects denied or mismatched registry evidence before requesting a key or downloading", async t => {
  for (const patch of [null, { shardKey: wikiHash("foreign") }, { generation: 2 }, { manifestHash: wikiHash("foreign") },
    { sourceSetHash: wikiHash("foreign") }, { sourceCount: 2 }, { declaredSourcesReadable: false }, { pointInTime: false },
    { provenance: "verified" }, { contentVerified: true }]) {
    const f = await setup(t); let keys = 0;
    f.receiver.sourceRegistry = { checkPublished: async () => {
      if (patch === null) throw new Error("SECRET denied sources");
      return { ...registeredReceipt(f), ...patch };
    } };
    f.keyAuthority.acquire = async () => { keys++; throw new Error("unexpected key request"); };
    await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url), /取回失败/);
    assert.equal(keys, 0); assert.equal(f.state.downloads, 0);
    await assert.rejects(readFile(f.bob.filename), { code: "ENOENT" });
  }
});

test("receiver rechecks cancellation, identity, session and head after awaiting the registry", async t => {
  for (const kind of ["abort", "identity", "session", "head"]) {
    const f = await setup(t), controller = new AbortController(); let keys = 0, allowed = true;
    f.receiver.businessAccess = () => { if (!allowed) throw new Error("SECRET logged out"); };
    f.receiver.sourceRegistry = { checkPublished: async (shardKey, { signal }) => {
      assert.equal(shardKey, f.binding.shardKey); assert.equal(signal, controller.signal);
      if (kind === "abort") controller.abort();
      if (kind === "identity") f.bob.state.principal = "mallory";
      if (kind === "session") allowed = false;
      if (kind === "head") f.state.publication = { ...f.publication, state: "tombstone", manifest: null };
      return registeredReceipt(f);
    } };
    f.keyAuthority.acquire = async () => { keys++; throw new Error("unexpected key request"); };
    await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url, { signal: controller.signal }));
    assert.equal(keys, 0); assert.equal(f.state.downloads, 0);
  }
});

test("registry agreement does not replace authenticated decryption or current original-source reads", async t => {
  for (const kind of ["valid", "corrupt", "changed-source"]) {
    const f = await setup(t, 2); let checks = 0;
    f.receiver.sourceRegistry = { checkPublished: async () => { checks++; return registeredReceipt(f); } };
    if (kind === "corrupt") f.state.bytes = Buffer.from("invalid ciphertext");
    if (kind === "changed-source") f.docs[1].text = "changed after publication";
    if (kind === "valid") {
      assert.deepEqual(await f.receiver.receive(f.binding.shardKey, f.folder.url), { retained: 2, requested: 2 });
      assert.equal((await f.bob.wiki.search("采购")).hits.length, 2);
    } else {
      await assert.rejects(f.receiver.receive(f.binding.shardKey, f.folder.url));
      await assert.rejects(readFile(f.bob.filename), { code: "ENOENT" });
    }
    assert.equal(checks, 1); assert.equal(f.state.downloads, 1); assert.equal(f.state.releases, 1);
  }
});

test("a package keeps each record's own model: GLM and MiniMax syntheses travel and import side by side", async t => {
  const f = await setup(t, 2, ["GLM-5.3", "MiniMax-M3"]);
  const records = openWikiBundle(f.sealed.bytes, { shardKey: f.binding.shardKey, publication: f.publication, key: f.key });
  const published = f.pages.map(page => [page.resourceId, page.synthesis.model]).sort();
  assert.deepEqual(published.map(row => row[1]).sort(), ["GLM-5.3", "MiniMax-M3"]);
  assert.deepEqual(records.map(record => [record.resourceId, record.synthesis.model]).sort(), published);
  // The recipient has no model of its own here: importing names nobody's model but the publisher's.
  assert.deepEqual(await f.receiver.receive(f.binding.shardKey, f.folder.url), { retained: 2, requested: 2 });
  const hits = (await f.bob.wiki.search("采购")).hits;
  assert.ok(hits.every(hit => hit.synthesis.state === "complete" && hit.synthesis.origin.kind === "wiki-bundle"));
  assert.deepEqual(hits.map(hit => hit.synthesis.model).sort(), ["GLM-5.3", "MiniMax-M3"]);
  const saved = { pages: await storedPages(f.bob.cipher, f.bob.filename) };
  assert.deepEqual(saved.pages.map(page => [page.resourceId, page.synthesis.model]).sort(), published);
  // Re-exporting an imported GLM synthesis keeps GLM, it is not relabelled.
  assert.equal(portablePage(saved.pages.find(page => page.synthesis.model === "GLM-5.3")).synthesis.model, "GLM-5.3");
});

test("a synthesis naming a model the product does not ship, or none, rejects the whole package", async t => {
  const f = await setup(t, 1, ["GLM-5.3"]), record = portablePage(f.pages[0]);
  assert.equal(record.synthesis.model, "GLM-5.3");
  for (const model of ["gpt-5", "volc-coding", "", null, undefined, "__proto__"]) {
    assert.throws(() => sealWikiBundle([{ ...record, synthesis: { ...record.synthesis, model } }], f.binding, f.key), /校验失败/, String(model));
  }
});
