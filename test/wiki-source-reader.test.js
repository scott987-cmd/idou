import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { SaasWikiSourceReader } from "../src/providers/feishu/wiki-source-reader.js";
import { readWikiDocx, wikiDocumentOrigin, WIKI_SOURCE_SCOPE } from "../src/providers/feishu/wiki-source-format.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { FeishuOAuthProvider } from "../src/control-plane/feishu-oauth-provider.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SOURCE_ACCESS_SCOPE } from "../src/knowledge/source-access-contract.js";
import { loadFeishuLoginConfig } from "../src/control-plane/server-config.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { portablePage, sealWikiBundle, bundleDigest } from "../src/knowledge/bundle.js";
import { sourceDeclaration } from "../src/knowledge/source-declaration.js";
import { WikiPayloadVerifier } from "../src/control-plane/wiki-payload-verifier.js";
import { wikiHash, wikiManifest } from "../src/knowledge/manifest.js";
import { synthesisKey, SYNTHESIS_RECIPE, WIKI_MODEL, validateFacts } from "../src/knowledge/synthesis.js";
import { WIKI_BUNDLE_SCOPES } from "../src/providers/feishu/wiki-bundle-reader.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

const origin = "https://test.feishu.cn", resourceId = "SyntheticDocument12345678901";
const metadata = record => Object.fromEntries(["tenantId", "providerId", "resourceId", "revision", "contentHash", "textSha256"].map(field => [field, field === "textSha256" ? bundleDigest(Buffer.from(record.text)) : record[field]]));
async function fixture(t, { originals = true, bundles = false } = {}) {
  const state = { now: Date.now(), cliUser: "alice", user: "bob", tenant: "tenant", revision: 7, title: "采购说明", text: "采购说明\n保留  空格与末尾换行。\n", cli: [], http: [], scope: `${SOURCE_ACCESS_SCOPE} ${WIKI_SOURCE_SCOPE}` };
  if (bundles) state.scope += ` ${WIKI_BUNDLE_SCOPES.join(" ")}`;
  const data = endpoint => {
    if (state.denied) throw new Error("PRIVATE denied");
    if (endpoint.includes("raw_content")) { if (state.onRaw) state.onRaw(); return { content: state.text }; }
    return { document: { document_id: resourceId, revision_id: state.revision, title: state.title } };
  };
  const provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, async (binary, args) => {
    assert.ok(path.isAbsolute(binary)); state.cli.push(args);
    if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.cliUser, tenantKey: "tenant", tokenStatus: "valid" } } }) };
    assert.equal(args[args.indexOf("--as") + 1], "user");
    const payload = args[0] === "docs" ? { document: { document_id: resourceId, revision_id: state.revision, content: `<title>${state.title}</title><p>XML 阅读投影</p>` } } : data(args[2]);
    if (args[0] === "api") { assert.equal(args[1], "GET"); if (args[2].endsWith("/raw_content")) assert.deepEqual(JSON.parse(args[args.indexOf("--params") + 1]), { lang: "0" }); }
    return { code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data: payload }), stderr: "" };
  });
  const sessions = new SessionRegistry({ now: () => state.now });
  const fetchImpl = async (url, options) => {
    state.http.push({ url, ...options });
    if (url.includes("/open-apis/authen/v2/oauth/token")) return Response.json({ code: 0, token_type: "Bearer", access_token: "PRIVATE-user", expires_in: 3600, scope: state.scope });
    assert.equal(options.headers.authorization, "Bearer PRIVATE-user"); assert.equal(options.redirect, "error");
    if (url.endsWith("/user_info")) return Response.json({ code: 0, data: { open_id: state.user, tenant_key: state.tenant } });
    if (url.includes("/drive/v1/files")) {
      const { manifest, bytes } = state.bundle;
      if (url.endsWith("/download")) { assert.ok(url.endsWith(`/${manifest.fileToken}/download`)); return new Response(bytes); }
      assert.equal(new URL(url).searchParams.get("folder_token"), manifest.folderToken);
      return Response.json({ code: 0, data: { has_more: false, files: [{ token: manifest.fileToken, type: "file", name: `mydoubao-${manifest.reservationId}.wiki.bundle`, parent_token: manifest.folderToken }] } });
    }
    if (state.response) return state.response();
    assert.equal(new URL(url).origin, "https://open.feishu.cn");
    return Response.json({ code: 0, data: data(url) });
  };
  const authority = new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_test", originalOrigins: originals ? { tenant: origin } : {}, bundleReadsEnabled: bundles, fetchImpl, now: () => state.now });
  const oauth = new FeishuOAuthProvider({ feishu: SAAS_FEISHU, appId: "cli_test", appSecret: "PRIVATE-app", sourceAccess: authority, fetchImpl });
  const exchange = () => oauth.exchangeCode({ code: "SyntheticCode", verifier: "verifier", redirectUri: "https://control.example/callback" });
  const identity = await exchange(), parent = sessions.issue({ authProvider: "feishu", ...identity, deviceId: "device-bob", deviceProof: "ed25519-login" }); authority.bind(identity, parent);
  t.after(() => authority.close());
  const native = new SaasWikiSourceReader(provider, { origin });
  const read = () => native.readDocument(`${origin}/docx/${resourceId}`);
  return { state, data, provider, sessions, authority, oauth, parent, native, read, exchange };
}

test("CLI and server OAuth readers use identical versioned source bytes while the editor retains XML", async t => {
  const f = await fixture(t), doc = await f.read(), legacy = await f.provider.readDocument(doc.sourceUrl);
  const source = metadata({ ...doc, tenantId: "tenant", revision: doc.sourceRevision });
  const server = await f.authority.readOriginal(f.parent.token, source);
  for (const field of ["text", "title", "contentHash", "sourceUrl", "sourceRevision", "providerId", "resourceId"]) assert.equal(doc[field], server.document[field]);
  assert.equal(doc.text, f.state.text); assert.notEqual(doc.contentHash, legacy.contentHash); assert.match(legacy.text, /XML/);
  assert.equal(server.subject.userId, "bob"); assert.ok(doc.warnings.length);
  assert.equal(f.state.http.filter(call => call.url.includes("/documents/")).length, 3);
  assert.ok(f.state.http.some(call => call.url.endsWith("/raw_content?lang=0")));
});

test("canonical source format preserves text and rejects changed metadata or invalid bounded inputs", async () => {
  for (const value of ["http://test.feishu.cn", "https://test.feishu.cn/", "https://evil.test", "https://test.feishu.cn:443", "https://test.feishu.cn?x=1"]) assert.throws(() => wikiDocumentOrigin(value));
  for (const kind of ["revision", "title", "id", "empty", "large", "zero"]) {
    let calls = 0;
    await assert.rejects(readWikiDocx({ resourceId, origin, assertCurrent: () => {}, get: async endpoint => {
      calls++; if (endpoint.includes("raw_content")) return { content: kind === "empty" ? " " : kind === "large" ? "x".repeat(500001) : "text" };
      return { document: { document_id: kind === "id" ? "other" : resourceId, revision_id: kind === "zero" ? 0 : calls === 3 && kind === "revision" ? 2 : 1, title: calls === 3 && kind === "title" ? "changed" : "title" } };
    } }));
  }
});

test("canonical native reads reject account switches, foreign origins, partial reads and remapped Wiki nodes", async t => {
  const f = await fixture(t);
  for (const ref of [`${origin}/docx/${resourceId}#anchor`, `https://other.feishu.cn/docx/${resourceId}`]) await assert.rejects(f.native.readDocument(ref));
  assert.equal(f.state.cli.length, 0);
  const observed = await f.provider.readDocument(`${origin}/wiki/SyntheticWiki123`);
  assert.equal((await f.native.normalizeObservedDocument(observed)).sourceUrl, `${origin}/docx/${resourceId}`);
  await assert.rejects(f.native.normalizeObservedDocument({ ...observed, resourceId: "different" }));
  f.state.onRaw = () => { f.state.cliUser = "other"; }; await assert.rejects(f.read());
});

test("original reads require explicit tenant origins and narrowed OAuth content scope", async t => {
  const f = await fixture(t), doc = await f.read(), source = metadata({ ...doc, tenantId: "tenant", revision: doc.sourceRevision });
  assert.equal(new URL(f.oauth.authorizationUrl({ redirectUri: "https://control.example/callback", state: "s", challenge: "c" })).searchParams.get("scope"), `${SOURCE_ACCESS_SCOPE} ${WIKI_SOURCE_SCOPE}`);
  assert.equal(JSON.parse(f.state.http[0].body).scope, `${SOURCE_ACCESS_SCOPE} ${WIKI_SOURCE_SCOPE}`);
  f.state.scope = SOURCE_ACCESS_SCOPE; await assert.rejects(f.exchange());
  const disabled = await fixture(t, { originals: false }), before = disabled.state.http.length;
  await assert.rejects(disabled.authority.readOriginal(disabled.parent.token, source)); assert.equal(disabled.state.http.length, before);
  await assert.rejects(f.authority.readOriginal(f.parent.token, { ...source, tenantId: "other" }));
  const env = { IDOU_PUBLIC_URL: "https://control.example", FEISHU_APP_ID: "cli_test", FEISHU_APP_SECRET: "PRIVATE-app", FEISHU_ALLOWED_TENANTS: "tenant", FEISHU_SOURCE_ACCESS_ENABLED: "1" };
  assert.deepEqual(loadFeishuLoginConfig({ ...env, FEISHU_WIKI_ORIGINAL_ORIGINS: JSON.stringify({ tenant: origin }) }).originalOrigins, { tenant: origin });
  for (const value of ["[]", "{}", "PRIVATE-invalid", JSON.stringify({ other: origin }), JSON.stringify({ tenant: "https://evil.test" })]) assert.throws(() => loadFeishuLoginConfig({ ...env, FEISHU_WIKI_ORIGINAL_ORIGINS: value }), error => !error.message.includes("PRIVATE"));
});

test("server original reader rejects revoked sessions, partial failures, changed versions and oversized responses", async t => {
  for (const kind of ["logout", "version", "identity", "denied", "large"]) {
    const f = await fixture(t), doc = await f.read(), source = metadata({ ...doc, tenantId: "tenant", revision: doc.sourceRevision });
    if (kind === "logout") f.state.onRaw = () => f.sessions.revoke(f.parent.token);
    if (kind === "version") f.state.onRaw = () => { f.state.revision++; };
    if (kind === "identity") f.state.user = "other";
    if (kind === "denied") f.state.response = () => Response.json({ code: 1770032 });
    if (kind === "large") f.state.response = () => Response.json({ code: 0, data: { content: "x".repeat(2097152) } });
    await assert.rejects(f.authority.readOriginal(f.parent.token, source)); assert.equal(f.authority.active, 0);
  }
});

test("automatic canonical observation exports a real bundle verifiable through server Drive and original readers", async t => {
  const f = await fixture(t, { bundles: true }), directory = await mkdtemp(path.join(os.tmpdir(), "wiki-canonical-")), cipher = fixtureCipher();
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider: f.native, cipher });
  t.after(async () => { await wiki.close(); await rm(directory, { recursive: true, force: true }); });
  const observed = await f.provider.readDocument(`${origin}/wiki/SyntheticWiki123`);
  assert.equal(await wiki.observe(observed), true);
  assert.equal((await readFile(wiki.filename)).includes(Buffer.from(f.state.text)), false);
  const records = (await wiki.exportEvidence(wiki.pages.map(page => page.id))).pages.map(portablePage);
  assert.equal(records[0].text, f.state.text); assert.equal(records[0].sourceUrl, `${origin}/docx/${resourceId}`);
  const key = randomBytes(32), shardKey = wikiHash("canonical-shard"), binding = { shardKey, generation: 1, fence: 1, nodeId: wikiHash("node"), keyId: wikiHash("key"), providerId: "saas-cli", driveTenantKey: "tenant", folderToken: "Folder123" };
  t.after(() => key.fill(0));
  const sealed = sealWikiBundle(records, binding, key), m = sealed.metadata;
  const manifest = wikiManifest({ format: m.format, providerId: m.providerId, driveTenantKey: m.driveTenantKey, folderToken: m.folderToken, keyId: m.keyId,
    sourceCount: m.sourceCount, sourceSetHash: m.sourceSetHash, bytes: m.bytes, ciphertextSha256: m.ciphertextSha256, reservationId: randomUUID(), fileToken: "File123" });
  const publication = { state: "published", clientReported: true, generation: 1, fence: 1, nodeId: binding.nodeId, manifest, manifestHash: wikiHash(manifest) };
  const declaration = { publication, ...sourceDeclaration(records.map(metadata)) };
  f.state.bundle = { manifest, bytes: sealed.bytes };
  const coordinator = { publishedSources: () => structuredClone(declaration) };
  const verifier = new WikiPayloadVerifier({ sessions: f.sessions, coordinator,
    readBundle: ({ shardKey, signal }) => f.authority.readPublishedBundle(f.parent.token, shardKey, { coordinator, signal }),
    withKey: async (_, use) => use(key), readSource: ({ source, signal }) => f.authority.readOriginal(f.parent.token, source, { signal }) });
  assert.equal((await verifier.verify(f.parent.token, shardKey)).originalsMatched, true);
  f.state.now += 1001; f.state.text += "后续修改";
  await assert.rejects(verifier.verify(f.parent.token, shardKey));
});

test("encrypted legacy XML observations refresh to canonical text without carrying obsolete citations", async t => {
  const f = await fixture(t), directory = await mkdtemp(path.join(os.tmpdir(), "wiki-format-migration-")), cipher = fixtureCipher(), filename = path.join(directory, "wiki.enc");
  const old = new LocalWiki({ filename, cipher, provider: f.provider });
  const observed = await f.provider.readDocument(`${origin}/wiki/SyntheticWiki123`); await old.observe(observed);
  const page = old.pages[0]; page.synthesis = { key: synthesisKey(page), recipe: SYNTHESIS_RECIPE, model: WIKI_MODEL, state: "complete",
    facts: validateFacts({ facts: [{ text: "旧 XML 归纳", evidence: [{ chunkId: page.chunks[0].id, quote: "XML 阅读投影" }] }] }, page) };
  await old.save([page]); const previousChunk = page.chunks[0].id; await old.close();
  const current = new LocalWiki({ filename, cipher, provider: f.native });
  t.after(async () => { await current.close(); await rm(directory, { recursive: true, force: true }); });
  const result = await current.search("采购"); assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].sourceUrl, `${origin}/docx/${resourceId}`); assert.equal(result.hits[0].synthesis, undefined);
  assert.notEqual(result.hits[0].chunkId, previousChunk); assert.equal(current.pages[0].chunks.map(row => row.text).join(""), f.state.text);
  assert.equal(current.synthesisCalls, 0); assert.equal((await readFile(filename)).includes(Buffer.from(f.state.text)), false);
});

test("cancelled canonical observation and partial original observations cannot persist full text", async t => {
  const f = await fixture(t), directory = await mkdtemp(path.join(os.tmpdir(), "wiki-source-cancel-")), filename = path.join(directory, "wiki.enc");
  const wiki = new LocalWiki({ filename, provider: f.native, cipher: fixtureCipher() });
  t.after(async () => { await wiki.close(); await rm(directory, { recursive: true, force: true }); });
  const observed = await f.provider.readDocument(`${origin}/docx/${resourceId}`);
  assert.equal(await wiki.observe({ ...observed, partial: true }), false);
  const controller = new AbortController(); f.state.onRaw = () => controller.abort();
  assert.equal(await wiki.observe(observed, { signal: controller.signal }), false);
  await assert.rejects(readFile(filename), { code: "ENOENT" });
});
