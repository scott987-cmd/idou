import test from "node:test";
import { personOf } from "../src/control-plane/limits.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, stat, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WikiBundlePublisher } from "../src/knowledge/bundle-publisher.js";
import { WikiPublicationScheduler } from "../src/knowledge/publication-scheduler.js";
import { WikiBundleReceiver } from "../src/knowledge/bundle-receiver.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { WikiCoordinatorClient } from "../src/knowledge/coordinator-client.js";
import { WikiCoordinator, WikiCoordinatorService } from "../src/control-plane/wiki-coordinator.js";
import { DriveBudget, DriveBudgetService, drivePolicies } from "../src/control-plane/drive-budget.js";
import { DriveBudgetClient } from "../src/application/drive-budget-client.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { SaasDriveFiles } from "../src/providers/feishu/drive-files.js";
import { wikiHash } from "../src/knowledge/manifest.js";
import { bundleDigest } from "../src/knowledge/bundle.js";
import { SYNTHESIS_RECIPE, WIKI_MODEL, synthesisKey, validateFacts } from "../src/knowledge/synthesis.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { FeishuSourceAccess } from "../src/control-plane/feishu-source-access.js";
import { WikiSourceRegistryService } from "../src/control-plane/wiki-source-registry.js";
import { WikiSourceRegistryClient } from "../src/knowledge/source-registry-client.js";
import { WikiKeyVault } from "../src/control-plane/wiki-key-vault.js";
import { WikiKeyCustody } from "../src/control-plane/wiki-key-custody.js";
import { WikiPublisherKeyService } from "../src/control-plane/wiki-key-service.js";
import { WikiPublisherKeyClient } from "../src/knowledge/publisher-key-client.js";
import { WikiRecipientKeyClient } from "../src/knowledge/recipient-key-client.js";
import { WikiPublicationScopeClient } from "../src/knowledge/publication-scope-client.js";
import { WikiReadingPublication } from "../src/knowledge/reading-publication.js";
import { DocumentService } from "../src/application/document-service.js";
import { DesktopWikiPublication } from "../src/knowledge/desktop-publication.js";
import { DesktopWikiReception } from "../src/knowledge/desktop-reception.js";
import { WikiDiscoveryClient } from "../src/knowledge/discovery-client.js";
import { WikiCloudWork } from "../src/knowledge/cloud-work.js";
import { SAAS_FEISHU } from "../src/providers/feishu/saas-definition.js";

async function fixture(t, { renewalMs = 30000, registeredSources = false, custody = false, networkKeys = false, recipientKeys = false, automaticKeys = false, automaticReceiving = false, publishers = ["alice"], sourceLifetimeMs = 0 } = {}) {
  if (automaticReceiving) recipientKeys = true;
  if (automaticKeys) recipientKeys = true;
  if (recipientKeys) networkKeys = true;
  if (networkKeys) custody = true;
  if (custody) registeredSources = true;
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "wiki-publish-"))), cipher = fixtureCipher(), nodes = [];
  const policy = { authProvider: "feishu", tenantId: "tenant", appId: "cli_test", providerId: "saas-cli", driveTenantKey: "cli-tenant", folderToken: "SyntheticFolder123", maxBytes: 1048576 };
  if (registeredSources) policy.driveTenantKey = "tenant";
  const sessions = new SessionRegistry(), identity = { ...policy, userId: "alice", deviceId: "device1", deviceProof: "ed25519-login", cliIdentityChecks: automaticKeys || automaticReceiving };
  const parent = sessions.issue(identity), who = sessions.verify(parent.token);
  const ledger = new DriveBudget({ feishu: SAAS_FEISHU, databaseFile: path.join(directory, "budget.sqlite"), policies: [policy] });
  const coordinator = new WikiCoordinator({ databaseFile: path.join(directory, "coordinator.sqlite"), tenants: [{ authProvider: "feishu", tenantId: "tenant", appId: "cli_test", members: ["alice", "bob"] }], budget: ledger });
  const service = new WikiCoordinatorService({ sessions, coordinator }), budgets = new DriveBudgetService({ sessions, ledger });
  let registryService, publisherKeyService;
  const server = createServer(async (req, res) => { if (!await service.handle(req, res) && !await budgets.handle(req, res) && !(registryService && await registryService.handle(req, res)) && !(publisherKeyService && await publisherKeyService.handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const state = { principal: wikiHash("alice"), downloads: 0, serverDownloads: 0, originalReads: [], sources: new Map(), trustedNodes: [], uploads: 0, calls: [], requests: [], releases: 0, keyRevoked: false, allowed: true, renews: 0, artifacts: new Map() };
  const session = { ...parent, serverUrl: `http://127.0.0.1:${server.address().port}` };
  const sourceAccess = registeredSources ? new FeishuSourceAccess({ feishu: SAAS_FEISHU, sessions, appId: "cli_test", identityChecksEnabled: automaticKeys || automaticReceiving, originalOrigins: custody ? { tenant: "https://test.feishu.cn" } : {}, bundleReadsEnabled: custody, fetchImpl: async (url, options) => {
    if (url.endsWith("/user_info")) return Response.json({ code: 0, data: { tenant_key: "tenant", open_id: options.headers.authorization.slice("Bearer Synthetic-".length) } });
    if (custody && url.includes("/drive/v1/files")) {
      if (url.endsWith("/download")) {
        state.serverDownloads++;
        if (state.serverDownloadDenied) return new Response("denied", { status: 403 });
        const token = new URL(url).pathname.split("/").at(-2), item = state.artifacts.get(token);
        return new Response(state.serverCorrupt ? Buffer.alloc(item.bytes.length) : item.bytes);
      }
      return Response.json({ code: 0, data: { has_more: false, files: [...state.artifacts].map(([token, item]) => ({ token, name: item.name, type: "file", parent_token: policy.folderToken })) } });
    }
    if (custody && url.includes("/docx/v1/documents")) {
      if (state.serverSourceDenied) return Response.json({ code: 1770032 });
      const document = state.sources.get(new URL(url).pathname.split("/")[5]);
      if (url.includes("/raw_content")) { state.originalReads.push(Date.now()); await state.onOriginalRead?.(); }
      return Response.json({ code: 0, data: url.includes("/raw_content") ? { content: document.text } : { document: { document_id: document.resourceId, revision_id: Number(document.sourceRevision), title: document.title } } });
    }
    state.permissionChecks = (state.permissionChecks || 0) + 1;
    return Response.json({ code: 0, data: { auth_result: !state.serverSourceDenied } });
  } }) : null;
  const bindSourceAccess = issued => { const identity = { tenantId: "tenant", userId: issued.userId, appId: "cli_test", expiresAt: issued.expiresAt + sourceLifetimeMs }; sourceAccess.remember(identity, `Synthetic-${issued.userId}`); sourceAccess.bind(identity, issued); };
  if (sourceAccess) { bindSourceAccess(parent); registryService = new WikiSourceRegistryService({ sessions, coordinator, sourceAccess }); }
  const client = new WikiCoordinatorClient({ getSession: async () => session, fetchImpl: async (url, options) => {
    state.requests.push({ route: new URL(url).pathname, body: JSON.parse(options.body) });
    const response = await fetch(url, options);
    if (url.endsWith("/renew")) { state.renews++; if (state.onRenew) await state.onRenew(); }
    if (state.dropRoute && url.endsWith(state.dropRoute)) { await response.body.cancel(); throw new Error("SECRET lost response"); }
    return response;
  } });
  const budget = new DriveBudgetClient({ unchanged: session => client.unchanged(session), request: (...args) => client.post(...args) });
  const cliIdentity = () => ({ principal: state.principal, tenantKey: policy.driveTenantKey, verifiedAt: Date.now() });
  const source = { providerId: "saas-cli", resourceId: "SyntheticSource123", sourceRevision: "1", contentHash: "upstream-hash", sourceUrl: "https://test.feishu.cn/docx/SyntheticSource123", title: "采购验收（合成）", text: "采购验收只面向采购组。", partial: false };
  if (registeredSources) source.contentHash = wikiHash("synthetic-upstream-hash");
  if (custody) source.contentHash = wikiHash(["feishu-docx-plain-v1", source.resourceId, source.sourceRevision, source.title, source.text]);
  state.sources.set(source.resourceId, source);
  const sourceProvider = { documentIdentity: async () => cliIdentity(), readDocument: async reference => { if (state.sourceDenied) throw new Error("SECRET source denied"); return { ...(state.sources.get(reference.split("/").at(-1)) || source), identity: cliIdentity() }; } };
  const wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), provider: sourceProvider, cipher }); nodes.push(wiki);
  await wiki.observe({ ...source, identity: cliIdentity() });
  const folderUrl = `https://test.feishu.cn/drive/folder/${policy.folderToken}`, fileToken = "SyntheticFile123";
  const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }), stderr: "" });
  const provider = { id: "saas-cli", documentIdentity: sourceProvider.documentIdentity, invoke: async (args, options) => {
    state.calls.push(args); assert.equal(args[args.indexOf("--as") + 1], "user");
    if (args[1] === "+inspect") return ok({ input_url: folderUrl, token: policy.folderToken, type: "folder", title: "知识包（合成）", url: folderUrl });
    if (args[1] === "+upload") {
      state.uploads++; const name = args[args.indexOf("--name") + 1], bytes = await readFile(path.join(options.cwd, name));
      const row = (await publisher.journal.load()).find(item => name === `idou-${item.id}.wiki.bundle`); assert.equal(row.state, "dispatching");
      const reservation = ledger.db.prepare("SELECT state FROM drive_reservations WHERE id=?").get(row.id); assert.equal(reservation.state, "dispatched");
      assert.match(name, /^idou-[a-f0-9-]+\.wiki\.bundle$/); assert.equal(args.includes("--file-token"), false); assert.equal(args.includes("--yes"), false);
      const uploadedToken = state.uploads === 1 ? fileToken : `SyntheticFile${state.uploads}123`;
      state.artifacts.set(uploadedToken, { name, bytes: Buffer.from(bytes) }); if (state.onUpload) await state.onUpload();
      if (state.lostUpload) throw new Error("SECRET upload receipt lost");
      return ok({ file_token: uploadedToken });
    }
    if (args[1] === "+download") {
      state.downloads++; if (state.deniedDownload) throw new Error("denied download");
      const bytes = state.artifacts.get(args[args.indexOf("--file-token") + 1]).bytes;
      await writeFile(path.join(options.cwd, "payload.bin"), state.corruptDownload ? Buffer.alloc(bytes.length) : bytes);
      if (state.onDownload) await state.onDownload(); return ok({});
    }
    assert.deepEqual(args.slice(0, 2), ["api", "GET"]);
    // The listing's query goes as --params: the pinned CLI refuses one in the path.
    assert.deepEqual([args[2], args[3], typeof JSON.parse(args[4]).folder_token], ["/open-apis/drive/v1/files", "--params", "string"]);
    if (state.deniedList) throw new Error("denied listing");
    return ok({ files: [...state.artifacts.entries()].map(([token, item]) => ({ token, name: item.name, type: "file", parent_token: policy.folderToken, url: `https://test.feishu.cn/file/${token}` })), has_more: false });
  } };
  const drive = new SaasDriveFiles(provider), secret = randomBytes(32);
  const current = async () => { if (state.keyRevoked) throw new Error("SECRET revoked key"); };
  let keyAuthority = {
    preparePublication: async value => {
      state.keyRequest = value; assert.equal(JSON.stringify(value).includes(source.text), false);
      return { key: secret, keyId: wikiHash("key-ref"), assertCurrent: current, bind: async metadata => { state.keyBinding = metadata; }, release: async () => { state.releases++; } };
    },
    resumePublication: async ({ manifest }) => { assert.equal(manifest.ciphertextSha256, state.keyBinding.ciphertextSha256); await current(); return { assertCurrent: current, release: async () => { state.releases++; } }; },
  };
  let keyCustody, keyVault, keyClient; const wrappingKey = custody ? randomBytes(32) : null;
  const reopenCustody = async () => {
    publisherKeyService?.close(); keyCustody?.close(); keyVault?.close();
    keyVault = await WikiKeyVault.open({ databaseFile: path.join(directory, "keys.sqlite"), wrappingKey });
    keyCustody = new WikiKeyCustody({ sessions, coordinator, vault: keyVault, sourceAccess, authorizeProcessing: () => !state.processingDenied });
    if (networkKeys) publisherKeyService = new WikiPublisherKeyService({ sessions, custody: keyCustody });
    if (recipientKeys) {
      publisherKeyService.close();
      const rootFile = path.join(directory, "recipient-root.key"), configFile = path.join(directory, "recipient-config.json");
      await writeFile(rootFile, wrappingKey, { mode: 0o600 });
      await writeFile(configFile, JSON.stringify({ schemaVersion: 1, databaseFile: path.join(directory, "keys.sqlite"), wrappingKeyFile: rootFile,
        tenants: [{ appId: "cli_test", tenantId: "tenant", publishers, recipients: ["bob"], processingApproved: true, trustedSynthesisPublisherNodes: state.trustedNodes, automaticPublishingApproved: automaticKeys, automaticReceivingApproved: automaticReceiving }] }));
      publisherKeyService = await WikiPublisherKeyService.fromConfig(configFile, { sessions, coordinator, sourceAccess }); keyCustody = publisherKeyService.custody;
    }
    return { keyCustody, keyVault };
  };
  if (custody) {
    await reopenCustody();
    if (networkKeys) keyClient = new WikiPublisherKeyClient({ feishu: SAAS_FEISHU, getSession: async () => session, fetchImpl: client.fetch, businessAccess: () => { if (!state.allowed) throw new Error("not connected"); } });
    keyAuthority = {
      preparePublication: async input => {
        const grant = networkKeys ? await keyClient.preparePublication(input) : await keyCustody.preparePublication(session.token, input); state.lastGrant = grant;
        const release = grant.release; grant.release = async () => { state.releases++; await release(); }; return grant;
      },
      resumePublication: input => networkKeys ? keyClient.resumePublication(input) : keyCustody.resumePublication(session.token, input),
    };
  }
  const make = () => new WikiBundlePublisher({ coordinator: client, budget, drive, wiki, keyAuthority,
    sourceRegistry: registeredSources ? new WikiSourceRegistryClient({ getSession: async () => session, fetchImpl: client.fetch }) : undefined,
    filename: path.join(directory, "publishing.enc"), cipher, renewalMs,
    businessAccess: () => { if (!state.allowed) throw new Error("SECRET session unavailable"); } });
  const publisher = make(), input = { id: randomUUID(), shardKey: wikiHash("synthetic-shard"), sourceIds: wiki.pages.map(row => row.id), folderReference: folderUrl, confirmed: true };
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); keyClient?.close(); publisherKeyService?.close(); keyCustody?.close(); keyVault?.close(); wrappingKey?.fill(0); sourceAccess?.close(); for (const node of nodes) await node.close(); coordinator.close(); ledger.close(); secret.fill(0); await rm(directory, { recursive: true, force: true }); });
  return { publisher, make, input, state, ledger, coordinator, client, budget, sessions, session, who, policy, drive, wiki, source, sourceProvider, keyAuthority, secret, directory, cipher, nodes, bindSourceAccess, keyCustody, keyVault, reopenCustody, sourceAccess, keyClient, publisherKeyService };
}

async function recipient(t, f, { identityChecks = false } = {}) {
  const session = { ...f.sessions.issue({ ...f.policy, userId: "bob", deviceId: "device-bob", deviceProof: "ed25519-login", cliIdentityChecks: identityChecks }), serverUrl: f.session.serverUrl };
  f.bindSourceAccess(session); f.state.principal = wikiHash("bob");
  const getSession = async () => session, businessAccess = () => { if (!f.state.allowed) throw new Error("not connected"); };
  const keys = new WikiRecipientKeyClient({ getSession, fetchImpl: f.client.fetch, businessAccess }); t.after(() => keys.close());
  const cipher = fixtureCipher(), filename = path.join(f.directory, "recipient.enc");
  const wiki = new LocalWiki({ filename, provider: f.sourceProvider, cipher }); f.nodes.push(wiki);
  const coordinator = new WikiCoordinatorClient({ getSession });
  const receiver = new WikiBundleReceiver({ coordinator, drive: f.drive, wiki, keyAuthority: keys, businessAccess,
    sourceRegistry: new WikiSourceRegistryClient({ getSession }) });
  const publication = (await coordinator.head(f.input.shardKey)).publication;
  const input = { shardKey: f.input.shardKey, publication, identity: await f.sourceProvider.documentIdentity() };
  const request = (action, body, token = session.token, headers = {}) => fetch(`${session.serverUrl}/v1/wiki/keys/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { session, keys, wiki, receiver, input, request, filename, cipher };
}

test("recipient HTTP custody independently verifies a package and imports encrypted evidence for a second user after restart", async t => {
  const f = await fixture(t, { recipientKeys: true }); await f.publisher.publish(f.input); await f.reopenCustody();
  const r = await recipient(t, f), downloads = f.state.downloads;
  assert.deepEqual(await r.receiver.receive(f.input.shardKey, f.input.folderReference), { retained: 1, requested: 1 });
  assert.equal(f.state.downloads, downloads + 1); assert.equal(f.state.serverDownloads, 1); assert.equal(f.state.originalReads.length, 1);
  assert.equal((await r.wiki.search("采购")).hits[0].sourceUrl, f.source.sourceUrl);
  const disk = await readFile(r.filename); assert.equal(disk.includes(Buffer.from(f.source.text)), false); assert.equal(disk.includes(Buffer.from(r.session.token)), false);
  await r.wiki.close(); const restored = new LocalWiki({ filename: r.filename, provider: f.sourceProvider, cipher: r.cipher }); f.nodes.push(restored);
  assert.equal((await restored.search("采购")).hits[0].sourceUrl, f.source.sourceUrl);
  f.state.sourceDenied = true; assert.equal((await restored.search("采购")).hits.length, 0);
  const calls = f.state.requests.filter(row => row.route.endsWith("/keys/acquire"));
  assert.deepEqual(calls.map(row => row.body), [{ shardKey: f.input.shardKey }]);
  assert.equal(JSON.stringify(f.state.requests).includes(f.source.text), false);
});

test("recipient HTTP key delivery denies unreadable or corrupt sources, unapproved recipients and native permission loss", async t => {
  for (const kind of ["source", "corrupt", "drive", "recipient", "native-source"]) {
    const f = await fixture(t, { recipientKeys: true }); await f.publisher.publish(f.input); const r = await recipient(t, f), before = f.state.downloads;
    if (kind === "source") f.state.serverSourceDenied = true;
    if (kind === "corrupt") f.state.serverCorrupt = true;
    if (kind === "drive") f.state.serverDownloadDenied = true;
    if (kind === "recipient") Object.assign(r.session, f.session);
    if (kind === "native-source") f.state.onDownload = () => { f.state.sourceDenied = true; };
    await assert.rejects(r.receiver.receive(f.input.shardKey, f.input.folderReference));
    await r.wiki.load();
    assert.equal(r.wiki.pages.length, 0); assert.equal(f.state.downloads, before + (kind === "native-source" ? 1 : 0));
  }
});

test("recipient synthesis needs explicit configured publisher-node trust even when every quoted original matches", async t => {
  const f = await fixture(t, { recipientKeys: true }), page = f.wiki.pages[0];
  page.synthesis = { state: "complete", recipe: SYNTHESIS_RECIPE, model: WIKI_MODEL, key: synthesisKey(page),
    facts: validateFacts({ facts: [{ text: "验收面向全体人员。", evidence: [{ chunkId: page.chunks[0].id, quote: "只面向采购组" }] }] }, page) };
  await f.wiki.save(f.wiki.pages); await f.publisher.publish(f.input); const r = await recipient(t, f), before = f.state.downloads;
  const response = await r.request("acquire", { shardKey: f.input.shardKey });
  assert.equal(response.status, 403); assert.equal("keyBase64" in await response.json(), false);
  assert.equal(f.state.serverDownloads, 1); assert.equal(f.state.originalReads.length, 1); assert.equal(f.state.downloads, before);
  f.state.trustedNodes = [r.input.publication.nodeId]; await f.reopenCustody();
  const grant = await r.keys.acquire(r.input); assert.equal(grant.synthesisProvenance, "publisher-declared"); await grant.release();
  assert.deepEqual(grant.key, Buffer.alloc(32));
  assert.deepEqual(await r.receiver.receive(f.input.shardKey, f.input.folderReference), { retained: 1, requested: 1 });
  // Trust is an administrator decision, not proof that the claim follows from its quote.
  assert.equal(r.wiki.pages[0].synthesis.facts[0].text, "验收面向全体人员。");
});

test("a GLM-made synthesis reaches a trusted recipient still labelled with the model that made it", async t => {
  const f = await fixture(t, { recipientKeys: true }), page = f.wiki.pages[0];
  page.synthesis = { state: "complete", recipe: SYNTHESIS_RECIPE, model: "GLM-5.3", key: synthesisKey(page),
    facts: validateFacts({ facts: [{ text: "验收范围限定为采购组。", evidence: [{ chunkId: page.chunks[0].id, quote: "只面向采购组" }] }] }, page) };
  await f.wiki.save(f.wiki.pages); await f.publisher.publish(f.input); const r = await recipient(t, f);
  f.state.trustedNodes = [r.input.publication.nodeId]; await f.reopenCustody();
  assert.deepEqual(await r.receiver.receive(f.input.shardKey, f.input.folderReference), { retained: 1, requested: 1 });
  const received = r.wiki.pages[0].synthesis;
  assert.equal(received.model, "GLM-5.3"); assert.equal(received.state, "complete"); assert.equal(received.origin.kind, "wiki-bundle");
});

test("recipient grants are parent-bound, non-replayable as permission checks, and current returns no key", async t => {
  const f = await fixture(t, { recipientKeys: true }); await f.publisher.publish(f.input); const r = await recipient(t, f);
  const first = await (await r.request("acquire", { shardKey: f.input.shardKey })).json(); assert.equal(typeof first.keyBase64, "string");
  const other = f.sessions.issue({ ...f.policy, userId: "bob", deviceId: "other-bob", deviceProof: "ed25519-login" }); f.bindSourceAccess(other);
  for (const action of ["current", "release", "bind"]) assert.equal((await r.request(action, { grantId: first.grantId }, other.token)).status, 403);
  assert.equal((await r.request("acquire", { shardKey: f.input.shardKey }, f.sessions.issueForWiki(r.session.token).token)).status, 403);
  assert.equal((await r.request("acquire", { shardKey: f.input.shardKey }, r.session.token, { origin: "https://browser.example" })).status, 403);
  assert.equal((await r.request("acquire", { shardKey: f.input.shardKey, deliveryPolicyAuthorized: true })).status, 403);
  const current = await (await r.request("current", { grantId: first.grantId })).json(); assert.equal("keyBase64" in current, false);
  const second = await (await r.request("acquire", { shardKey: f.input.shardKey })).json(); assert.notEqual(second.grantId, first.grantId);
  assert.equal(f.state.serverDownloads, 2); assert.equal(f.state.originalReads.length, 2);
  assert.equal((await r.request("current", { grantId: first.grantId })).status, 403);
  f.state.serverSourceDenied = true;
  assert.equal((await r.request("acquire", { shardKey: f.input.shardKey })).status, 403);
  assert.equal((await r.request("current", { grantId: second.grantId })).status, 403);
});

test("recipient native adapter rejects substituted receipts before download", async t => {
  for (const field of ["sessionBinding", "purpose", "publicationHash", "manifestHash", "nodeId", "generation", "sourceSetHash", "sourceCount", "driveTenantKey", "deliveryPolicyAuthorized", "synthesisProvenance", "expiresAt", "keyBase64", "unexpectedSecret"]) {
    const f = await fixture(t, { recipientKeys: true }); await f.publisher.publish(f.input); const r = await recipient(t, f), before = f.state.downloads;
    r.keys.transport.fetch = async (url, options) => {
      const response = await f.client.fetch(url, options); if (!url.endsWith("/acquire") || response.status !== 200) return response;
      const value = await response.json(); value[field] = "substituted"; return Response.json(value);
    };
    await assert.rejects(r.receiver.receive(f.input.shardKey, f.input.folderReference)); await r.wiki.load(); assert.equal(f.state.downloads, before); assert.equal(r.wiki.pages.length, 0);
  }
});

test("recipient native grants clear owned keys on policy, session, abort, expiry, vault revocation or close", async t => {
  for (const kind of ["policy", "session", "abort", "expiry", "vault", "close", "logout"]) {
    const f = await fixture(t, { recipientKeys: true }); await f.publisher.publish(f.input); const r = await recipient(t, f), controller = new AbortController();
    const grant = await r.keys.acquire({ ...r.input, signal: controller.signal }); assert.notDeepEqual(grant.key, Buffer.alloc(32));
    if (kind === "policy") f.keyCustody.authorizeDelivery = () => false;
    if (kind === "session") r.session.token = f.session.token;
    if (kind === "abort") controller.abort();
    if (kind === "expiry") r.keys.transport.now = () => grant.expiresAt;
    if (kind === "vault") f.keyVault.revoke(r.input.publication.manifest.keyId);
    if (kind === "close") r.keys.close();
    if (kind === "logout") f.sessions.revoke(r.session.token);
    await assert.rejects(grant.assertCurrent()); assert.deepEqual(grant.key, Buffer.alloc(32)); await grant.release();
  }
});

test("recipient verifies more than two originals by bounded pacing before requests, without retries", async t => {
  const f = await fixture(t, { recipientKeys: true });
  for (let index = 2; index <= 3; index++) {
    const resourceId = `SyntheticSource${index}123`, source = { ...f.source, resourceId, sourceUrl: `https://test.feishu.cn/docx/${resourceId}`, title: `采购 ${index}` };
    source.contentHash = wikiHash(["feishu-docx-plain-v1", resourceId, source.sourceRevision, source.title, source.text]); f.state.sources.set(resourceId, source);
    await f.wiki.observe({ ...source, identity: await f.sourceProvider.documentIdentity() });
  }
  f.input.sourceIds = f.wiki.pages.map(page => page.id); await f.publisher.publish(f.input); const r = await recipient(t, f);
  assert.deepEqual(await r.receiver.receive(f.input.shardKey, f.input.folderReference), { retained: 3, requested: 3 });
  assert.equal(f.state.originalReads.length, 3); assert.ok(f.state.originalReads[2] - f.state.originalReads[0] >= 950);
  assert.equal(f.state.requests.filter(row => row.route.endsWith("/keys/acquire")).length, 1);
});

test("recipient HTTP acquisition rejects logout, membership loss and changed head during original verification", async t => {
  for (const kind of ["logout", "membership", "head"]) {
    const f = await fixture(t, { recipientKeys: true }); await f.publisher.publish(f.input); const r = await recipient(t, f), before = f.state.downloads;
    f.state.onOriginalRead = async () => {
      if (kind === "logout") f.sessions.revoke(r.session.token);
      if (kind === "membership") f.coordinator.tenants[0].members = ["alice"];
      if (kind === "head") {
        const lease = f.coordinator.acquire(f.who, { shardKey: f.input.shardKey, requestId: randomUUID(), expectedGeneration: 1 });
        f.coordinator.publish(f.who, { shardKey: f.input.shardKey, leaseId: lease.id, fence: lease.fence, manifest: null });
      }
    };
    const response = await r.request("acquire", { shardKey: f.input.shardKey });
    assert.equal(response.status, 403); assert.equal("keyBase64" in await response.json(), false); assert.equal(f.state.downloads, before);
    assert.equal(f.state.originalReads.length, 1);
  }
});

test("recipient cancellation interrupts rate-slot waiting without issuing or retrying an original read", async t => {
  const f = await fixture(t, { recipientKeys: true }); await f.publisher.publish(f.input); const r = await recipient(t, f), controller = new AbortController();
  let entered, stopped; const ready = new Promise(resolve => { entered = resolve; }), done = new Promise(resolve => { stopped = resolve; });
  const original = f.sourceAccess.readOriginal.bind(f.sourceAccess);
  f.sourceAccess.readOriginal = async (...args) => {
    // Every reader's slots for this second already taken.
    for (const userId of ["alice", "bob"]) f.sourceAccess.rates.originals.hit(personOf({ tenantId: "tenant", userId }), 2);
    const pending = original(...args); entered(); try { return await pending; } finally { stopped(); }
  };
  const pending = r.keys.acquire({ ...r.input, signal: controller.signal }); await ready; controller.abort();
  await assert.rejects(pending); await done;
  assert.equal(f.state.originalReads.length, 0); assert.equal(f.sourceAccess.active, 0);
  assert.equal(f.state.requests.filter(row => row.route.endsWith("/keys/acquire")).length, 1);
});

test("recipient configuration refuses malformed principals, untrusted node identifiers and missing bundle-read capability", async t => {
  const f = await fixture(t, { networkKeys: true }), rootFile = path.join(f.directory, "receiver-config-root.key"), configFile = path.join(f.directory, "receiver-config.json");
  await writeFile(rootFile, randomBytes(32), { mode: 0o600 });
  const config = { schemaVersion: 1, databaseFile: path.join(f.directory, "receiver-config.sqlite"), wrappingKeyFile: rootFile,
    tenants: [{ appId: "cli_test", tenantId: "tenant", publishers: [], recipients: ["bob"], trustedSynthesisPublisherNodes: [], processingApproved: true }] };
  const dependencies = { sessions: f.sessions, coordinator: f.coordinator, sourceAccess: f.sourceAccess };
  for (const patch of [{ recipients: ["bob", "bob"] }, { recipients: ["not an open_id"] }, { recipients: "bob" }, { trustedSynthesisPublisherNodes: ["alice"] }, { trustedSynthesisPublisherNodes: [wikiHash("node"), wikiHash("node")] }]) {
    await writeFile(configFile, JSON.stringify({ ...config, tenants: [{ ...config.tenants[0], ...patch }] }));
    await assert.rejects(WikiPublisherKeyService.fromConfig(configFile, dependencies));
  }
  await writeFile(configFile, JSON.stringify(config)); f.sourceAccess.bundleReadsEnabled = false;
  await assert.rejects(WikiPublisherKeyService.fromConfig(configFile, dependencies)); f.sourceAccess.bundleReadsEnabled = true;
  const service = await WikiPublisherKeyService.fromConfig(configFile, dependencies); service.close();
});

test("native publisher uses HTTP key custody through upload and another user's server verification", async t => {
  const f = await fixture(t, { networkKeys: true });
  assert.equal((await f.publisher.publish(f.input)).state, "published");
  assert.equal(f.state.uploads, 1); assert.deepEqual(f.state.lastGrant.key, Buffer.alloc(32));
  const calls = f.state.requests.filter(row => row.route.includes("/keys/"));
  assert.ok(calls.some(row => row.route.endsWith("/prepare"))); assert.ok(calls.some(row => row.route.endsWith("/bind"))); assert.ok(calls.some(row => row.route.endsWith("/release")));
  assert.deepEqual(Object.keys(calls.find(row => row.route.endsWith("/prepare")).body).sort(), ["fence", "leaseId", "shardKey"]);
  assert.equal(JSON.stringify(calls).includes(f.source.text), false);
  const bob = f.sessions.issue({ ...f.policy, userId: "bob", deviceId: "device-bob", deviceProof: "ed25519-login" }); f.bindSourceAccess(bob);
  const { keyCustody } = await f.reopenCustody(); assert.equal((await keyCustody.verifyPublication(bob.token, f.input.shardKey)).originalsMatched, true);
});

test("HTTP publisher recovery never repeats an upload or reissues the bound encryption key", async t => {
  const f = await fixture(t, { networkKeys: true }); f.state.dropRoute = "/report";
  await assert.rejects(f.publisher.publish(f.input)); f.state.dropRoute = null;
  await f.reopenCustody(); const before = f.state.requests.length;
  assert.equal((await f.make().recover(f.input.id)).state, "published"); assert.equal(f.state.uploads, 1);
  assert.equal(f.state.requests.slice(before).some(row => row.route.endsWith("/keys/prepare")), false);
  assert.equal(f.state.requests.slice(before).some(row => row.route.endsWith("/keys/resume")), true);
});

test("lost key preparation or binding responses never cause an automatic key retry or upload", async t => {
  for (const route of ["/keys/prepare", "/keys/bind"]) {
    const f = await fixture(t, { networkKeys: true }); f.state.dropRoute = route;
    await assert.rejects(f.publisher.publish(f.input)); assert.equal(f.state.uploads, 0);
    assert.equal(f.state.requests.filter(row => row.route.endsWith(route)).length, 1);
    if (f.state.lastGrant) assert.deepEqual(f.state.lastGrant.key, Buffer.alloc(32));
  }
});

async function declaredKeyRequest(f) {
  const lease = f.coordinator.acquire(f.who, { shardKey: f.input.shardKey, requestId: f.input.id, expectedGeneration: 0 });
  const sources = [{ tenantId: "tenant", providerId: "saas-cli", resourceId: f.source.resourceId, revision: f.source.sourceRevision, contentHash: f.source.contentHash, textSha256: bundleDigest(Buffer.from(f.source.text)) }];
  const body = { shardKey: f.input.shardKey, leaseId: lease.id, fence: lease.fence };
  f.coordinator.registerSources(f.who, { ...body, sources });
  const input = { shardKey: f.input.shardKey, lease, sources, identity: { principal: f.state.principal, tenantKey: "tenant" } };
  const request = (action, data = body, token = f.session.token, headers = {}) => fetch(`${f.session.serverUrl}/v1/wiki/keys/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(data),
  });
  return { lease, sources, body, input, request };
}

test("HTTP grants are session-bound, idempotent only before binding, and never expose keys through current or resume", async t => {
  const f = await fixture(t, { networkKeys: true }), r = await declaredKeyRequest(f);
  const first = await (await r.request("prepare")).json(), repeat = await (await r.request("prepare")).json();
  assert.equal(first.grantId, repeat.grantId); assert.equal(first.keyBase64, repeat.keyBase64); assert.equal(first.expiresAt, repeat.expiresAt);
  const other = f.sessions.issue({ ...f.policy, userId: "alice", deviceId: "other-device", deviceProof: "ed25519-login" }); f.bindSourceAccess(other);
  for (const action of ["current", "release", "bind"]) assert.equal((await r.request(action, { grantId: first.grantId }, other.token)).status, 403);
  assert.equal((await r.request("prepare", r.body, f.sessions.issueForWiki(f.session.token).token)).status, 403);
  assert.equal((await r.request("prepare", r.body, f.session.token, { origin: "https://browser.example" })).status, 403);
  assert.equal((await r.request("prepare", { ...r.body, keyBase64: "client-key" })).status, 403);
  const current = await (await r.request("current", { grantId: first.grantId })).json(); assert.equal("keyBase64" in current, false);
  const metadata = { format: "wiki-aes256gcm-v1", providerId: "saas-cli", driveTenantKey: "tenant", folderToken: f.policy.folderToken, reservationId: f.input.id,
    ciphertextSha256: wikiHash("synthetic-package"), bytes: 1000, keyId: first.keyId, sourceSetHash: first.sourceSetHash, sourceCount: first.sourceCount };
  assert.equal((await r.request("bind", { grantId: first.grantId, metadata })).status, 200);
  assert.equal((await r.request("bind", { grantId: first.grantId, metadata })).status, 200);
  assert.equal((await r.request("prepare")).status, 403);
  assert.equal((await r.request("release", { grantId: first.grantId })).status, 200);
  const resumed = await (await r.request("resume", { ...r.body, manifest: { ...metadata, fileToken: "File123" } })).json();
  assert.equal(resumed.mode, "resume"); assert.equal("keyBase64" in resumed, false); assert.equal(resumed.keyId, first.keyId);
  assert.equal((await r.request("acquire", { shardKey: r.body.shardKey })).status, 403);
  f.sessions.revoke(f.session.token); assert.equal((await r.request("current", { grantId: resumed.grantId })).status, 403);
});

test("native key client rejects substituted receipts before encryption or upload", async t => {
  for (const field of ["sessionBinding", "nodeId", "sourceSetHash", "sourceCount", "fence", "driveTenantKey", "expiresAt", "keyBase64", "unexpectedSecret"]) {
    const f = await fixture(t, { networkKeys: true }), realFetch = f.keyClient.transport.fetch;
    f.keyClient.transport.fetch = async (url, options) => {
      const response = await realFetch(url, options); if (!url.endsWith("/keys/prepare")) return response;
      const value = await response.json();
      value[field] = field === "expiresAt" ? Date.now() + 120000 : ["sourceCount", "fence"].includes(field) ? value[field] + 1 : "substituted";
      return Response.json(value);
    };
    await assert.rejects(f.publisher.publish(f.input)); assert.equal(f.state.uploads, 0); assert.equal(f.state.lastGrant, undefined);
  }
});

test("native publisher grant buffers clear when policy, local account, cancellation or expiry invalidates an operation", async t => {
  for (const kind of ["policy", "account", "abort", "expiry", "close"]) {
    const f = await fixture(t, { networkKeys: true }), r = await declaredKeyRequest(f), controller = new AbortController();
    const grant = await f.keyClient.preparePublication({ ...r.input, signal: controller.signal }); assert.notDeepEqual(grant.key, Buffer.alloc(32));
    if (kind === "policy") f.state.processingDenied = true;
    if (kind === "account") f.session.token = f.sessions.issue({ ...f.policy, userId: "bob", deviceId: "other", deviceProof: "ed25519-login" }).token;
    if (kind === "abort") controller.abort();
    if (kind === "expiry") f.keyClient.transport.now = () => grant.expiresAt;
    if (kind === "close") f.keyClient.close();
    await assert.rejects(grant.assertCurrent()); assert.deepEqual(grant.key, Buffer.alloc(32)); await grant.release();
  }
});

test("cancelled HTTP preparation aborts source checks before a key grant can be returned", async t => {
  const f = await fixture(t, { networkKeys: true }), r = await declaredKeyRequest(f), controller = new AbortController();
  let enter, stopped; const ready = new Promise(resolve => { enter = resolve; }), cancelled = new Promise(resolve => { stopped = resolve; });
  f.sourceAccess.check = async (_, __, { signal }) => {
    enter(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); stopped(); signal.throwIfAborted();
  };
  const pending = f.keyClient.preparePublication({ ...r.input, signal: controller.signal }); await ready; controller.abort();
  await assert.rejects(pending); await cancelled; assert.equal(f.state.uploads, 0);
});

test("publisher key startup requires explicit tenant processing approval and a private server root file", async t => {
  const f = await fixture(t, { networkKeys: true }), r = await declaredKeyRequest(f);
  const rootFile = path.join(f.directory, "configured-root.key"), configFile = path.join(f.directory, "key-config.json");
  await writeFile(rootFile, randomBytes(32), { mode: 0o600 });
  const config = { schemaVersion: 1, databaseFile: path.join(f.directory, "configured-keys.sqlite"), wrappingKeyFile: rootFile,
    tenants: [{ appId: "cli_test", tenantId: "tenant", publishers: ["alice"], processingApproved: true }] };
  const dependencies = { sessions: f.sessions, coordinator: f.coordinator, sourceAccess: f.sourceAccess };
  await writeFile(configFile, JSON.stringify(config)); const service = await WikiPublisherKeyService.fromConfig(configFile, dependencies);
  assert.doesNotThrow(() => service.custody.subject(f.session.token, r.body.shardKey, "publish"));
  assert.throws(() => service.custody.subject(f.session.token, r.body.shardKey, "verify")); service.close();
  for (const patch of [{ processingApproved: false }, { publishers: [] }, { tenantId: "other" }, { appId: "cli_other" }, { automaticPublishingApproved: "true" }]) {
    await writeFile(configFile, JSON.stringify({ ...config, tenants: [{ ...config.tenants[0], ...patch }] }));
    await assert.rejects(WikiPublisherKeyService.fromConfig(configFile, dependencies), /explicit publisher/);
  }
  await writeFile(configFile, JSON.stringify({ ...config, wrappingKeyFile: path.join(f.directory, "missing-root") }));
  await assert.rejects(WikiPublisherKeyService.fromConfig(configFile, dependencies));
});

test("server key custody prepares and binds a real publisher package, then verifies it for a second user after restart", async t => {
  const f = await fixture(t, { custody: true });
  const result = await f.publisher.publish(f.input); assert.equal(result.state, "published");
  assert.deepEqual(f.state.lastGrant.key, Buffer.alloc(32)); assert.equal(f.state.releases, 1);
  const publication = (await f.client.head(f.input.shardKey)).publication;
  assert.equal(publication.manifest.keyId, f.state.lastGrant.keyId);
  const bob = f.sessions.issue({ ...f.policy, userId: "bob", deviceId: "second-device", deviceProof: "ed25519-login" }); f.bindSourceAccess(bob);
  const { keyCustody } = await f.reopenCustody();
  const verified = await keyCustody.verifyPublication(bob.token, f.input.shardKey);
  assert.equal(verified.originalsMatched, true); assert.equal(verified.payloadMatchesDeclaration, true); assert.equal(verified.keyReleaseAuthorized, false);
  assert.equal(verified.subjectHash, wikiHash(["feishu", "cli_test", "tenant", "bob", "second-device"]));
  assert.doesNotMatch(JSON.stringify(verified), /采购|SyntheticSource|Bearer|key":/);
  const encoded = [...f.state.artifacts.values()][0].bytes;
  for (const name of ["keys.sqlite", "keys.sqlite-wal"]) {
    const bytes = await readFile(path.join(f.directory, name)); assert.equal(bytes.includes(Buffer.from(f.source.text)), false); assert.equal(bytes.includes(encoded.subarray(-50)), false);
  }
});

test("server custody resumes a recorded upload without reissuing a plaintext publisher key or uploading again", async t => {
  const f = await fixture(t, { custody: true }); f.state.dropRoute = "/report";
  await assert.rejects(f.publisher.publish(f.input));
  const journal = (await f.publisher.journal.load())[0]; assert.equal(journal.state, "recorded");
  f.state.dropRoute = null; await f.reopenCustody();
  const restored = f.make(); restored.keyAuthority.preparePublication = () => assert.fail("must not reissue encryption key");
  assert.equal((await restored.recover(f.input.id)).state, "published"); assert.equal(f.state.uploads, 1);
  assert.deepEqual(f.state.lastGrant.key, Buffer.alloc(32));
});

test("processing policy, source denial and revoked package keys prevent trusted verification", async t => {
  for (const kind of ["processing-before", "processing-after", "source", "corrupt", "revoked"]) {
    const f = await fixture(t, { custody: true });
    if (kind === "processing-before") {
      f.state.processingDenied = true; await assert.rejects(f.publisher.publish(f.input)); assert.equal(f.state.uploads, 0); assert.equal(f.state.lastGrant, undefined); continue;
    }
    await f.publisher.publish(f.input);
    if (kind === "processing-after") f.state.processingDenied = true;
    if (kind === "source") f.state.serverSourceDenied = true;
    if (kind === "corrupt") f.state.serverCorrupt = true;
    if (kind === "revoked") f.keyVault.revoke(f.state.lastGrant.keyId);
    await assert.rejects(f.keyCustody.verifyPublication(f.session.token, f.input.shardKey));
  }
});

test("custody requires the publisher's current registered lease and clears grants on logout, expiry, cancellation and policy change", async t => {
  for (const kind of ["missing", "other-user", "sources", "logout", "expiry", "abort", "policy", "close", "source-denied"]) {
    const f = await fixture(t, { custody: true }), controller = new AbortController();
    const lease = f.coordinator.acquire(f.who, { shardKey: f.input.shardKey, requestId: f.input.id, expectedGeneration: 0 });
    const sources = [{ tenantId: "tenant", providerId: "saas-cli", resourceId: f.source.resourceId, revision: f.source.sourceRevision, contentHash: f.source.contentHash, textSha256: bundleDigest(Buffer.from(f.source.text)) }];
    if (kind !== "missing") f.coordinator.registerSources(f.who, { shardKey: f.input.shardKey, leaseId: lease.id, fence: lease.fence, sources });
    const input = { shardKey: f.input.shardKey, lease, sources, signal: controller.signal };
    let token = f.session.token;
    if (kind === "other-user") { const other = f.sessions.issue({ ...f.policy, userId: "bob", deviceId: "other-device", deviceProof: "ed25519-login" }); f.bindSourceAccess(other); token = other.token; }
    if (kind === "sources") input.sources = [{ ...sources[0], contentHash: wikiHash("substitute") }];
    if (kind === "source-denied") f.state.serverSourceDenied = true;
    if (["missing", "other-user", "sources", "source-denied"].includes(kind)) { await assert.rejects(f.keyCustody.preparePublication(token, input)); continue; }
    const baseline = f.sessions.listenerCount("revoked"), grant = await f.keyCustody.preparePublication(token, input);
    assert.equal(f.sessions.listenerCount("revoked"), baseline + 1); assert.notDeepEqual(grant.key, Buffer.alloc(32));
    if (kind === "logout") f.sessions.revoke(token);
    if (kind === "expiry") f.keyCustody.now = () => grant.expiresAt;
    if (kind === "abort") controller.abort();
    if (kind === "policy") f.state.processingDenied = true;
    if (kind === "close") f.keyCustody.close();
    await assert.rejects(grant.assertCurrent()); assert.deepEqual(grant.key, Buffer.alloc(32)); assert.equal(f.sessions.listenerCount("revoked"), baseline);
  }
});

test("publisher seals, budgets, uploads, byte-verifies and publishes through real HTTP/SQLite; a second node imports", async t => {
  const f = await fixture(t), result = await f.publisher.publish(f.input);
  assert.equal(result.state, "published"); assert.equal(f.state.uploads, 1); assert.equal(f.state.downloads, 1);
  const publication = (await f.client.head(f.input.shardKey)).publication;
  const bytes = [...f.state.artifacts.values()][0].bytes;
  assert.equal(publication.manifest.ciphertextSha256, bundleDigest(bytes)); assert.equal(f.ledger.snapshot(f.who).chargedBytes, bytes.length);
  assert.equal(bytes.includes(Buffer.from(f.source.text)), false);
  const journalBytes = await readFile(f.publisher.journal.filename);
  assert.equal(journalBytes.includes(Buffer.from("cli-tenant")), false);
  const decoded = f.cipher.decrypt(journalBytes); assert.equal(decoded.includes(f.source.text), false); assert.equal(decoded.includes(f.session.token), false); assert.equal(decoded.includes(f.secret.toString("base64")), false);
  assert.equal((await stat(f.publisher.journal.filename)).mode & 0o777, 0o600);
  assert.ok(f.state.requests.every(item => !JSON.stringify(item.body).includes(f.source.text)));
  await assert.rejects(f.make().publish(f.input)); assert.equal(f.state.uploads, 1);
  assert.equal((await f.make().recover(f.input.id)).historicalReceipt, true); assert.equal(f.state.uploads, 1);
  f.state.principal = wikiHash("bob");
  const bob = new LocalWiki({ filename: path.join(f.directory, "bob.enc"), provider: f.sourceProvider, cipher: fixtureCipher() }); f.nodes.push(bob);
  const bobSession = { ...f.sessions.issue({ ...f.who, userId: "bob", deviceId: "device2" }), serverUrl: f.session.serverUrl };
  const bobClient = new WikiCoordinatorClient({ getSession: async () => bobSession });
  assert.notEqual((await bobClient.status()).nodeId, publication.nodeId);
  const receiver = new WikiBundleReceiver({ coordinator: bobClient, drive: f.drive, wiki: bob, keyAuthority: { acquire: async ({ identity }) => {
    assert.equal(identity.principal, wikiHash("bob")); return { key: f.secret, assertCurrent: async () => {}, release: async () => {} };
  } } });
  assert.deepEqual(await receiver.receive(f.input.shardKey, f.input.folderReference), { retained: 1, requested: 1 });
  assert.equal((await bob.search("采购")).hits[0].sourceUrl, f.source.sourceUrl);
});

test("missing consent/key authority, failed journal and insufficient budget never upload", async t => {
  for (const kind of ["consent", "key", "journal", "budget", "source"]) {
    const f = await fixture(t);
    if (kind === "consent") f.input.confirmed = false;
    if (kind === "key") f.publisher.keyAuthority = null;
    if (kind === "journal") f.publisher.journal.save = async () => { throw new Error("disk full"); };
    if (kind === "budget") f.ledger.policies = drivePolicies([{ ...f.policy, maxBytes: 1 }], SAAS_FEISHU);
    if (kind === "source") f.state.sourceDenied = true;
    await assert.rejects(f.publisher.publish(f.input), /未自动重传/); assert.equal(f.state.uploads, 0); assert.equal(f.ledger.snapshot(f.who).chargedBytes, 0);
    assert.equal((await f.client.head(f.input.shardKey)).publication, null);
  }
});

test("lost budget dispatch or upload receipt cannot redispatch after publisher restart", async t => {
  for (const kind of ["permit", "upload"]) {
    const f = await fixture(t);
    if (kind === "permit") f.state.dropRoute = "/dispatch"; else f.state.lostUpload = true;
    await assert.rejects(f.publisher.publish(f.input)); f.state.dropRoute = null; f.state.lostUpload = false;
    await assert.rejects(f.make().recover(f.input.id)); await assert.rejects(f.make().publish(f.input));
    assert.equal(f.state.uploads, kind === "permit" ? 0 : 1);
    assert.equal(f.ledger.db.prepare("SELECT state FROM drive_reservations").get().state, "dispatched");
  }
});

test("CLI identity changed by a completed dispatch callback prevents the CLI upload", async t => {
  const f = await fixture(t), upload = f.drive.upload.bind(f.drive);
  // Model a caller's last awaited callback completing as the CLI account changes.
  f.drive.upload = args => upload({ ...args, onDispatched: async () => { await args.onDispatched(); f.state.principal = wikiHash("other-cli-user"); } });
  await assert.rejects(f.publisher.publish(f.input)); assert.equal(f.state.uploads, 0);
  assert.equal(f.ledger.db.prepare("SELECT state FROM drive_reservations").get().state, "dispatched");
});

test("recorded upload recovers report/publication by reads without another upload or key generation", async t => {
  for (const kind of ["list", "download", "report", "publish"]) {
    const f = await fixture(t);
    if (kind === "list") f.state.deniedList = true;
    if (kind === "download") f.state.deniedDownload = true;
    if (["report", "publish"].includes(kind)) f.state.dropRoute = `/${kind}`;
    await assert.rejects(f.publisher.publish(f.input));
    f.state.deniedList = f.state.deniedDownload = false; f.state.dropRoute = null;
    const restored = f.make(); restored.keyAuthority.preparePublication = () => assert.fail("must not regenerate");
    assert.equal((await restored.recover(f.input.id)).state, "published"); assert.equal(f.state.uploads, 1);
    assert.equal((await f.client.head(f.input.shardKey)).publication.generation, 1);
  }
});

test("changed source, revoked key, wrong bytes, logout or cancelled upload cannot publish", async t => {
  for (const kind of ["source", "key", "bytes", "logout", "abort", "policy"]) {
    const f = await fixture(t), controller = new AbortController();
    f.state.onUpload = () => {
      if (kind === "source") f.source.text = "changed but upstream hash unchanged";
      if (kind === "key") f.state.keyRevoked = true;
      if (kind === "bytes") f.state.corruptDownload = true;
      if (kind === "logout") f.state.allowed = false;
      if (kind === "abort") controller.abort();
      if (kind === "policy") f.ledger.policies = drivePolicies([{ ...f.policy, maxBytes: 1048575 }], SAAS_FEISHU);
    };
    await assert.rejects(f.publisher.publish(f.input, { signal: controller.signal }));
    assert.equal((await f.client.head(f.input.shardKey)).publication, null); assert.equal(f.state.uploads, 1);
    assert.equal((await f.publisher.journal.load())[0].fileToken, "SyntheticFile123", "retain acknowledged token despite later failure");
    assert.equal(f.state.releases, 1);
  }
});

test("lease keeper renews while upload is held; failure stops publishing and drains after exit", async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t, { renewalMs: 10 }); let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.state.onUpload = () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const operation = f.publisher.publish(f.input), outcome = operation.then(value => ({ value }), error => ({ error }));
    await started; const before = f.state.renews;
    await new Promise(resolve => { f.state.onRenew = () => { if (f.state.renews > before) { if (fail) f.state.keyRevoked = true; resolve(); } }; });
    release(); const result = await outcome;
    assert.equal(Boolean(result.error), fail); assert.ok(f.state.renews > before);
    const count = f.state.renews; await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(f.state.renews, count);
    assert.equal((await f.client.head(f.input.shardKey)).publication?.state ?? null, fail ? null : "published");
  }
});

test("same native journal refuses concurrent publication and foreign identity cannot recover", async t => {
  const f = await fixture(t); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.state.onUpload = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const operation = f.publisher.publish(f.input); await started;
  await assert.rejects(f.make().publish({ ...f.input, id: randomUUID() }), /已有知识发布/);
  release(); await operation;
  f.state.principal = wikiHash("other"); await assert.rejects(f.make().recover(f.input.id)); assert.equal(f.state.uploads, 1);
});

test("expired lease cannot be revived to publish an already uploaded artifact", async t => {
  const f = await fixture(t); f.state.deniedDownload = true;
  await assert.rejects(f.publisher.publish(f.input)); f.state.deniedDownload = false;
  f.coordinator.db.prepare("UPDATE wiki_leases SET expires_at=0").run();
  await assert.rejects(f.make().recover(f.input.id)); assert.equal(f.state.uploads, 1);
  assert.equal((await f.client.head(f.input.shardKey)).publication, null);
});

test("corrupt private journal stays unchanged and does not admit a new upload", async t => {
  const f = await fixture(t), bytes = Buffer.from("synthetic corrupted journal");
  await writeFile(f.publisher.journal.filename, bytes, { mode: 0o600 });
  await assert.rejects(f.publisher.publish(f.input)); assert.deepEqual(await readFile(f.publisher.journal.filename), bytes); assert.equal(f.state.uploads, 0);
});

test("journal save failures preserve conservative dispatch state and recover a lost final receipt", async t => {
  for (const phase of ["prepared", "dispatching", "recorded", "published"]) {
    const f = await fixture(t), save = f.publisher.journal.save.bind(f.publisher.journal);
    f.publisher.journal.save = entries => { if (entries[0].state === phase) throw new Error("synthetic disk failure"); return save(entries); };
    await assert.rejects(f.publisher.publish(f.input));
    assert.equal(f.state.uploads, ["recorded", "published"].includes(phase) ? 1 : 0);
    const restored = f.make();
    if (phase === "published") assert.equal((await restored.recover(f.input.id)).historicalReceipt, true);
    else await assert.rejects(restored.recover(f.input.id));
    await assert.rejects(restored.publish(f.input));
  }
});

test("recovering an old publication receipt cannot resurrect a tombstoned head", async t => {
  const f = await fixture(t); await f.publisher.publish(f.input);
  const lease = await f.client.acquire({ shardKey: f.input.shardKey, requestId: randomUUID(), expectedGeneration: 1 });
  await f.client.publish({ shardKey: f.input.shardKey, leaseId: lease.id, fence: lease.fence, expectedGeneration: 1, manifest: null });
  const result = await f.make().recover(f.input.id); assert.equal(result.generation, 1); assert.equal(result.historicalReceipt, true);
  assert.equal((await f.client.head(f.input.shardKey)).publication.state, "tombstone"); assert.equal(f.state.uploads, 1);
});

test("slow source export is covered by lease renewal before any key is requested", async t => {
  const f = await fixture(t, { renewalMs: 10 }), exportEvidence = f.wiki.exportEvidence.bind(f.wiki);
  let release, entered, held = false;
  const started = new Promise(resolve => { entered = resolve; });
  f.wiki.exportEvidence = async (...args) => {
    if (!held && f.state.renews > 0) { held = true; entered(); await new Promise(resolve => { release = resolve; }); }
    return exportEvidence(...args);
  };
  const operation = f.publisher.publish(f.input); await started;
  assert.equal(f.state.keyRequest, undefined); const before = f.state.renews;
  await new Promise(resolve => { f.state.onRenew = () => { if (f.state.renews > before) resolve(); }; });
  release(); assert.equal((await operation).state, "published"); assert.equal(f.state.uploads, 1);
  assert.ok(f.state.keyRequest.lease.expiresAt > Date.now());
});

const planningInput = input => ({ shardKey: input.shardKey, sourceIds: input.sourceIds, folderReference: input.folderReference });
const newOperation = f => ({ ...f.input, id: randomUUID() });

test("planning a new shard is read-only and never requires or generates a key", async t => {
  const f = await fixture(t); f.publisher.keyAuthority = null;
  assert.deepEqual(await f.publisher.plan(planningInput(f.input)), { state: "ready", generation: 0 });
  assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 0);
  assert.equal(f.ledger.snapshot(f.who).chargedBytes, 0); assert.equal(f.state.uploads, 0); assert.equal(f.state.keyRequest, undefined);
  await assert.rejects(readFile(f.publisher.journal.filename), { code: "ENOENT" });
  assert.ok(f.state.requests.every(request => ["/auth/wiki-token", "/v1/wiki/status", "/v1/wiki/head"].includes(request.route)));
});

test("unchanged content skips new operation IDs after restart without another lease, upload or budget charge", async t => {
  const f = await fixture(t); await f.publisher.publish(f.input);
  const charge = f.ledger.snapshot(f.who).chargedBytes, journal = await readFile(f.publisher.journal.filename), before = f.state.requests.length;
  const restored = f.make(), result = await restored.publish(newOperation(f));
  assert.equal(f.state.uploads, 1); assert.equal(result.state, "unchanged"); assert.equal(result.operationId, f.input.id);
  assert.equal(result.remoteBytesVerified, false); assert.equal(f.ledger.snapshot(f.who).chargedBytes, charge);
  assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 1);
  assert.deepEqual(await readFile(f.publisher.journal.filename), journal);
  assert.ok(f.state.requests.slice(before).every(request => ["/auth/wiki-token", "/v1/wiki/status", "/v1/wiki/head"].includes(request.route)));
  restored.keyAuthority = null; f.state.artifacts.clear();
  assert.equal((await restored.publish(newOperation(f))).state, "unchanged", "metadata equality is not a claim of remote-file availability");
  assert.equal(f.state.downloads, 1, "preflight must not claim a fresh byte check");
});

test("source text, title and synthesis-only changes each create a new frozen version", async t => {
  const f = await fixture(t); await f.publisher.publish(f.input);
  f.source.text += "\n周五提交。";
  assert.equal((await f.publisher.plan(planningInput(f.input))).state, "ready");
  await f.publisher.publish(newOperation(f)); assert.equal(f.state.uploads, 2);
  f.source.title = "新版采购验收标题";
  assert.equal((await f.publisher.plan(planningInput(f.input))).state, "ready");
  await f.publisher.publish(newOperation(f)); assert.equal(f.state.uploads, 3);
  // Refresh the local source, then persist a synthetic model result without a model call.
  await f.wiki.observe({ ...f.source, identity: await f.sourceProvider.documentIdentity() });
  const page = f.wiki.pages[0]; page.synthesis = { state: "complete", recipe: SYNTHESIS_RECIPE, model: WIKI_MODEL, key: synthesisKey(page),
    facts: validateFacts({ facts: [{ text: "验收范围限定为采购组。", evidence: [{ chunkId: page.chunks[0].id, quote: "只面向采购组" }] }] }, page) };
  await f.wiki.save(f.wiki.pages);
  assert.equal((await f.publisher.plan(planningInput(f.input))).state, "ready");
  const result = await f.publisher.publish(newOperation(f)); assert.equal(result.generation, 4); assert.equal(f.state.uploads, 4);
  assert.equal(f.state.artifacts.size, 4, "never overwrite prior files");
  const entries = await f.publisher.journal.load(); assert.equal(new Set(entries.map(row => row.contentDigest)).size, 4);
  assert.equal(f.ledger.snapshot(f.who).chargedBytes, [...f.state.artifacts.values()].reduce((sum, item) => sum + item.bytes.length, 0));
  assert.equal((await f.publisher.publish(newOperation(f))).state, "unchanged"); assert.equal(f.state.uploads, 4);
});

test("an unresolved upload blocks automatic replacement even under a different operation ID", async t => {
  const f = await fixture(t); f.state.lostUpload = true; await assert.rejects(f.publisher.publish(f.input));
  f.state.lostUpload = false; const before = await readFile(f.publisher.journal.filename);
  const result = await f.make().plan(planningInput(f.input));
  assert.equal(result.state, "review-required"); assert.equal(result.reason, "unresolved-operation"); assert.equal(result.operationId, f.input.id);
  await assert.rejects(f.make().publish(newOperation(f))); assert.equal(f.state.uploads, 1);
  assert.deepEqual(await readFile(f.publisher.journal.filename), before);
});

test("withdrawn, missing and unproven remote heads cannot be replaced by automatic new IDs", async t => {
  for (const kind of ["withdrawn", "missing", "remote"]) {
    const f = await fixture(t); await f.publisher.publish(f.input); const candidate = f.make();
    if (kind === "withdrawn") {
      const lease = await f.client.acquire({ shardKey: f.input.shardKey, requestId: randomUUID(), expectedGeneration: 1 });
      await f.client.publish({ shardKey: f.input.shardKey, leaseId: lease.id, fence: lease.fence, expectedGeneration: 1, manifest: null });
    } else if (kind === "missing") f.coordinator.db.prepare("DELETE FROM wiki_heads").run();
    else candidate.journal.filename = path.join(f.directory, "no-local-publication-history.enc");
    const decision = await candidate.plan(planningInput(f.input));
    assert.equal(decision.reason, { withdrawn: "withdrawn-head", missing: "missing-previous-head", remote: "no-local-version-proof" }[kind]);
    await assert.rejects(candidate.publish(newOperation(f))); assert.equal(f.state.uploads, 1);
  }
});

test("legacy journal loads without inventing a content digest; read-only planning does not migrate it", async t => {
  const f = await fixture(t); await f.publisher.publish(f.input);
  const entries = await f.publisher.journal.load(); delete entries[0].contentDigest;
  const old = f.cipher.encrypt(JSON.stringify({ version: 1, entries })); await writeFile(f.publisher.journal.filename, old, { mode: 0o600 });
  const restored = f.make(); assert.equal((await restored.plan(planningInput(f.input))).reason, "legacy-version-proof");
  assert.deepEqual(await readFile(restored.journal.filename), old);
  await assert.rejects(restored.publish(newOperation(f))); assert.equal(f.state.uploads, 1);
  await restored.recover(f.input.id);
  const migrated = JSON.parse(f.cipher.decrypt(await readFile(restored.journal.filename)));
  assert.equal(migrated.version, 2); assert.equal(migrated.entries[0].contentDigest, undefined);
  assert.equal((await restored.plan(planningInput(f.input))).reason, "legacy-version-proof");
});

test("denied source or a head change during planning cannot return cached unchanged status", async t => {
  const f = await fixture(t); await f.publisher.publish(f.input); const before = await readFile(f.publisher.journal.filename);
  f.state.sourceDenied = true; await assert.rejects(f.publisher.plan(planningInput(f.input)), /检查未完成/);
  f.state.sourceDenied = false; const exportEvidence = f.wiki.exportEvidence.bind(f.wiki);
  f.wiki.exportEvidence = async (...args) => {
    const value = await exportEvidence(...args), lease = await f.client.acquire({ shardKey: f.input.shardKey, requestId: randomUUID(), expectedGeneration: 1 });
    await f.client.publish({ shardKey: f.input.shardKey, leaseId: lease.id, fence: lease.fence, expectedGeneration: 1, manifest: null }); return value;
  };
  await assert.rejects(f.publisher.plan(planningInput(f.input)), /检查未完成/);
  assert.deepEqual(await readFile(f.publisher.journal.filename), before); assert.equal(f.state.uploads, 1);
});

test("planning rejects a folder outside the current server policy without a new journal or lease", async t => {
  const f = await fixture(t); f.ledger.policies = drivePolicies([{ ...f.policy, folderToken: "OtherFolder123" }], SAAS_FEISHU);
  await assert.rejects(f.publisher.plan(planningInput(f.input)), /检查未完成/);
  await assert.rejects(f.publisher.publish(f.input));
  assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 0); assert.equal(f.state.uploads, 0);
  await assert.rejects(readFile(f.publisher.journal.filename), { code: "ENOENT" });
});

function desktopPublication(f, options = {}) {
  return new DesktopWikiPublication({ feishu: SAAS_FEISHU, wiki: f.wiki, drive: f.drive, filename: path.join(f.directory, "publishing.enc"),
    getSession: async () => f.session, fetchImpl: f.client.fetch, configureSource: origin => { assert.equal(origin, "https://test.feishu.cn"); f.state.configuredOrigin = origin; },
    businessAccess: () => { if (!f.state.allowed) throw new Error("not current"); }, timers: { set: () => ({ unref() {} }), clear() {} }, ...options });
}

async function receptionFixture(t, options = {}) {
  const f = await fixture(t, { automaticReceiving: true, ...options }); f.input.shardKey = wikiHash(["wiki-user-local-reads-v1", "cli_test", "tenant", "alice"]);
  await f.publisher.publish(f.input); const recipientState = await recipient(t, f, { identityChecks: true });
  const desktop = new DesktopWikiReception({ feishu: SAAS_FEISHU, wiki: recipientState.wiki, drive: f.drive, getSession: async () => recipientState.session, fetchImpl: f.client.fetch,
    configureSource: origin => { assert.equal(origin, "https://test.feishu.cn"); }, businessAccess: () => { if (!f.state.allowed) throw new Error("not current"); }, timers: { set: () => ({ unref() {} }), clear() {} } });
  return { f, r: recipientState, desktop };
}

test("desktop discovers approved publisher versions, imports searchable evidence and never republishes imported-only sources", async t => {
  const { f, r, desktop } = await receptionFixture(t);
  try {
    assert.equal((await desktop.start()).enabled, true); await desktop.tick(); assert.equal(desktop.status().counts.received, 1);
    assert.equal((await r.wiki.search("采购")).hits.length, 1); assert.deepEqual((await r.wiki.publicationCandidates()).sourceIds, []);
    const downloads = f.state.downloads, serverDownloads = f.state.serverDownloads;
    await desktop.tick(); assert.equal(f.state.downloads, downloads); assert.equal(f.state.serverDownloads, serverDownloads); assert.equal(desktop.status().counts.skipped, 1);
    assert.equal(f.state.uploads, 1); assert.doesNotMatch(JSON.stringify(desktop.status()), /SyntheticSource123|keyBase64|grantId|采购/);
    f.state.sourceDenied = true; assert.equal((await r.wiki.search("采购")).hits.length, 0);
  } finally { await desktop.close(); }
});

test("discovery is default-off, requires recipient and identity policy, and never grants source access", async t => {
  for (const kind of ["default", "publisher-only", "identity", "source-denied"]) {
    const { f, r, desktop } = await receptionFixture(t, kind === "default" ? { automaticReceiving: false, recipientKeys: true } : {});
    try {
      if (kind === "publisher-only") desktop.discovery.transport.getSession = async () => f.session;
      if (kind === "identity") f.sourceAccess.identityChecksEnabled = false;
      if (kind === "source-denied") {
        f.state.serverSourceDenied = true;
        const page = await desktop.discovery.page(); assert.equal(page.permissionsChecked, false); assert.equal(page.targets.length, 1);
        const before = f.state.downloads; await desktop.start(); await desktop.tick(); assert.equal(desktop.status().counts.unavailable, 1);
        assert.equal(f.state.downloads, before); await r.wiki.load(); assert.equal(r.wiki.pages.length, 0);
        f.state.serverSourceDenied = false; await desktop.tick(); assert.equal(f.state.downloads, before, "same failed version cannot silently retry");
      } else { assert.equal((await desktop.start()).state, "paused", kind); assert.equal(r.wiki.pages, null); }
    } finally { await desktop.close(); }
  }
});

test("discovery pages over publisher metadata without source titles and rejects body or response substitution", async t => {
  const { f, desktop } = await receptionFixture(t, { publishers: ["alice", ...Array.from({ length: 11 }, (_, i) => `author${i}`)] });
  try {
    let after = null, count = 0, found = 0;
    do { const page = await desktop.discovery.page(after); found += page.targets.length; count++; assert.doesNotMatch(JSON.stringify(page), /采购|SyntheticSource123|SyntheticFile123/); after = page.nextAfter; } while (after !== null && count < 10);
    assert.equal(count, 3); assert.equal(found, 1); assert.equal(after, null);
    const session = await desktop.discovery.transport.session();
    const response = await fetch(`${session.serverUrl}/v1/wiki/keys/discover`, { method: "POST", headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify({ after: null, publishers: ["alice"] }) }); assert.notEqual(response.status, 200);
    const forged = new WikiDiscoveryClient({ feishu: SAAS_FEISHU, getSession: async () => session, businessAccess() {}, fetchImpl: async (url, options) => {
      const value = await (await fetch(url, options)).json(); value.sessionBinding = wikiHash("other-session"); return Response.json(value);
    } }); await assert.rejects(forged.page(), /不可用/);
  } finally { await desktop.close(); }
});

test("automatic receiving policy revoked during download prevents importing a late package", async t => {
  const { f, r, desktop } = await receptionFixture(t);
  try {
    f.state.onDownload = async () => { f.keyCustody.discoveryPublishers = () => null; };
    await desktop.start(); await desktop.tick(); assert.equal(desktop.status().counts.received, 0); assert.equal(desktop.status().counts.unavailable, 1);
    await r.wiki.load(); assert.equal(r.wiki.pages.length, 0); assert.equal(f.state.uploads, 1);
  } finally { await desktop.close(); }
});

test("stopping queued reception does not wait for or execute another account background operation", async t => {
  const { f, desktop } = await receptionFixture(t); const queue = new WikiCloudWork(); desktop.cloudWork = queue;
  let release; const barrier = new Promise(resolve => { release = resolve; }); const occupied = queue.run(() => barrier);
  try {
    await desktop.start(); const before = f.state.downloads; const tick = desktop.tick(); await new Promise(resolve => setImmediate(resolve));
    await desktop.stop(); await tick; assert.equal(desktop.status().state, "stopped"); assert.equal(f.state.downloads, before);
  } finally { release(); await occupied; await desktop.close(); }
});

test("reception stop drains an in-flight download, rejects restart during stop, and discards late bytes", async t => {
  const { f, r, desktop } = await receptionFixture(t);
  let entered, release; const downloading = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.state.onDownload = async () => { entered(); await gate; };
  try {
    await desktop.start(); const work = desktop.tick(); await downloading;
    const stopped = desktop.stop(); assert.equal(desktop.status().state, "stopping"); assert.equal(desktop.status().busy, true);
    await assert.rejects(desktop.start(), /正在关闭/); release(); await stopped; await work;
    await r.wiki.load(); assert.equal(r.wiki.pages.length, 0); assert.equal(desktop.status().counts.received, 0); assert.equal(desktop.status().busy, false);
    f.state.onDownload = undefined; await desktop.start(); await desktop.tick(); assert.equal(desktop.status().counts.received, 1);
    assert.equal((await r.wiki.search("采购")).hits.length, 1);
  } finally { release(); await desktop.close(); }
});

test("reception expiration or catalog change pauses before download and close forbids restart", async t => {
  for (const kind of ["expiry", "catalog"]) {
    const { f, r, desktop } = await receptionFixture(t);
    try {
      await desktop.start(); const before = f.state.downloads;
      if (kind === "expiry") desktop.now = () => r.session.expiresAt;
      else f.keyCustody.discoveryPublishers = () => ["alice", "new-author"];
      await desktop.tick(); assert.equal(desktop.status().state, "paused"); assert.equal(f.state.downloads, before); assert.equal(desktop.status().counts.received, 0);
      await desktop.close(); await assert.rejects(desktop.start(), /正在关闭/); assert.equal(desktop.status().state, "closed");
    } finally { await desktop.close(); }
  }
});

test("desktop selects server target and publishes actual encrypted bytes without renderer-selected IDs", async t => {
  const f = await fixture(t, { automaticKeys: true }), desktop = desktopPublication(f);
  try {
    assert.equal((await desktop.start()).enabled, true);
    await desktop.worker.tick();
    const status = desktop.status(); assert.equal(status.counts.published, 1); assert.equal(f.state.uploads, 1);
    const shardKey = wikiHash(["wiki-user-local-reads-v1", "cli_test", "tenant", "alice"]);
    const publication = (await f.client.head(shardKey)).publication;
    assert.equal(publication.manifest.sourceCount, 1);
    const bytes = f.state.artifacts.get(publication.manifest.fileToken).bytes;
    assert.equal(bundleDigest(bytes), publication.manifest.ciphertextSha256);
    assert.equal(bytes.includes(Buffer.from(f.source.text)), false); assert.ok(f.state.downloads > 0);
    assert.deepEqual(f.state.requests.find(row => row.route.endsWith("/scopes/target")).body, {});
    assert.equal(f.state.configuredOrigin, "https://test.feishu.cn");
    assert.doesNotMatch(JSON.stringify(status), /keyBase64|grantId|SyntheticSource123/);
    await desktop.stop(); await desktop.worker.tick(); assert.equal(f.state.uploads, 1); assert.equal(desktop.status().state, "stopped");
    f.input.shardKey = shardKey; const receiver = await recipient(t, f);
    assert.deepEqual(await receiver.receiver.receive(shardKey, f.input.folderReference), { retained: 1, requested: 1 });
    assert.ok(f.state.serverDownloads > 0); assert.equal((await receiver.wiki.search("采购")).hits.length, 1);
  } finally { await desktop.close(); }
});

test("desktop target requires both identity capability and explicit automatic processing policy", async t => {
  for (const kind of ["identity", "server-identity", "automatic", "publisher"]) {
    const f = await fixture(t, { automaticKeys: true }), desktop = desktopPublication(f);
    if (kind === "identity") Object.assign(f.session, f.sessions.issue({ ...f.policy, userId: "alice", deviceId: "device2", deviceProof: "ed25519-login" }));
    if (kind === "server-identity") f.sourceAccess.identityChecksEnabled = false;
    if (kind === "automatic") f.keyCustody.authorizeAutomatic = () => false;
    if (kind === "publisher") f.keyCustody.authorizeProcessing = () => false;
    try { assert.equal((await desktop.start()).state, "paused", kind); assert.equal(f.state.uploads, 0); assert.equal(f.state.configuredOrigin, undefined); }
    finally { await desktop.close(); }
  }
});

test("target is session-bound, stable across same-user login, and rejects caller destination overrides", async t => {
  const f = await fixture(t, { automaticKeys: true }), { scopes } = networkScheduled(t, f);
  const first = await scopes.target();
  const request = body => fetch(`${f.session.serverUrl}/v1/wiki/scopes/target`, { method: "POST", headers: { authorization: `Bearer ${f.session.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.notEqual((await request({ folderReference: f.input.folderReference })).status, 200);
  const issued = f.sessions.issue({ ...f.policy, userId: "alice", deviceId: "other-device", deviceProof: "ed25519-login", cliIdentityChecks: true }); f.bindSourceAccess(issued);
  Object.assign(f.session, issued); assert.equal((await scopes.target()).shardKey, first.shardKey);
  const forged = new WikiPublicationScopeClient({ feishu: SAAS_FEISHU, getSession: async () => f.session, businessAccess() {}, fetchImpl: async (url, options) => {
    const value = await (await fetch(url, options)).json(); value.sessionBinding = wikiHash("wrong-session"); return Response.json(value);
  } });
  try { await assert.rejects(forged.target(), /未获授权/); } finally { forged.close(); }
  assert.equal(f.state.uploads, 0);
});

test("desktop stop while target is pending prevents late configuration and publication", async t => {
  const f = await fixture(t, { automaticKeys: true }); let entered, release;
  const ready = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  const desktop = desktopPublication(f, { fetchImpl: async (url, options) => { const response = await f.client.fetch(url, options); entered(); await barrier; return response; } });
  try {
    const start = desktop.start(); await ready; const stop = desktop.stop(); release(); await Promise.all([start, stop]);
    assert.equal(desktop.status().state, "stopped"); assert.equal(f.state.configuredOrigin, undefined); assert.equal(f.state.uploads, 0);
  } finally { release(); await desktop.close(); }
});

test("desktop owns parent expiry even with no local sources", async t => {
  const f = await fixture(t, { automaticKeys: true }), callbacks = [];
  await f.wiki.save([]);
  const desktop = desktopPublication(f, { timers: { set: (fn, delay) => { const handle = { fn, delay, unref() {} }; callbacks.push(handle); return handle; }, clear: handle => { if (handle) handle.cleared = true; } } });
  try {
    await desktop.start(); await desktop.worker.tick();
    assert.equal(desktop.status().last.outcome, "waiting-for-sources");
    const expiry = callbacks.find(row => !row.cleared && row.delay > 120000 && row.delay < 900001); assert.ok(expiry);
    expiry.fn(); await desktop.stop("session-expired");
    assert.equal(desktop.status().enabled, false); assert.equal(desktop.status().reason, "session-expired"); assert.equal(f.state.uploads, 0);
  } finally { await desktop.close(); }
});

test("desktop lost upload stays paused across stop and restart without another upload", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t, { automaticKeys: true }), desktop = desktopPublication(f); f.state.lostUpload = true;
  try {
    await desktop.start(); await desktop.worker.tick(); assert.equal(desktop.status().state, "paused"); assert.equal(f.state.uploads, 1);
    await desktop.stop(); t.mock.timers.tick(120000); f.state.lostUpload = false;
    await desktop.start(); await desktop.worker.tick(); assert.equal(desktop.status().state, "paused"); assert.equal(f.state.uploads, 1);
  } finally { await desktop.close(); }
});

function rotateWikiSession(f, session = f.session) {
  const issued = f.sessions.rotate(session.token, 900000);
  f.sourceAccess.transfer(session.token, issued); Object.assign(session, issued); return issued;
}

test("renewed desktop publisher obtains a fresh scope and publishes a changed original after predecessor expiry", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t, { automaticKeys: true, sourceLifetimeMs: 3600000 }), callbacks = [];
  const desktop = desktopPublication(f, { timers: { set: (fn, delay) => { const row = { fn, delay, unref() {} }; callbacks.push(row); return row; }, clear: row => { if (row) row.cleared = true; } } });
  try {
    await desktop.start(); await desktop.worker.tick(); const firstExpiry = desktop.status().expiresAt;
    const oldExpiry = callbacks.filter(row => !row.cleared && row.delay > 120000);
    assert.equal(f.state.uploads, 1); t.mock.timers.tick(780000); rotateWikiSession(f);
    await desktop.refreshSession(); assert.equal(desktop.status().enabled, true); assert.ok(desktop.status().expiresAt > firstExpiry);
    for (const row of oldExpiry) row.fn(); await Promise.resolve(); assert.equal(desktop.status().enabled, true, "Stale expiry callbacks cannot stop renewed work");
    t.mock.timers.tick(121000); assert.equal(f.sessions.verify(f.session.token).id, f.session.id);
    await desktop.worker.tick(); assert.equal(desktop.status().last.outcome, "unchanged"); assert.equal(f.state.uploads, 1);
    const changed = { ...f.source, sourceRevision: "2", text: "采购验收第二版，续期后仍按原文核验。" };
    changed.contentHash = wikiHash(["feishu-docx-plain-v1", changed.resourceId, changed.sourceRevision, changed.title, changed.text]);
    f.state.sources.set(changed.resourceId, changed); await f.wiki.observe({ ...changed, identity: await f.sourceProvider.documentIdentity() });
    await desktop.worker.tick(); assert.equal(desktop.status().counts.published, 2); assert.equal(f.state.uploads, 2); assert.equal(desktop.status().last.generation, 2);
    assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/acquire")).length, 2);
    assert.doesNotMatch(JSON.stringify(desktop.status()), new RegExp(f.session.token));
  } finally { await desktop.close(); }
});

test("renewal checkpoint keeps stopped and ambiguous publishers stopped without retrying any upload", async t => {
  for (const kind of ["stopped", "unknown"]) {
    const f = await fixture(t, { automaticKeys: true, sourceLifetimeMs: 3600000 }), desktop = desktopPublication(f);
    try {
      if (kind === "unknown") f.state.lostUpload = true;
      await desktop.start(); await desktop.worker.tick(); if (kind === "stopped") await desktop.stop();
      const before = desktop.status(), uploads = f.state.uploads, requests = f.state.requests.length;
      rotateWikiSession(f); await desktop.refreshSession(); await desktop.worker.tick();
      assert.equal(desktop.status().state, before.state); assert.equal(f.state.uploads, uploads); assert.equal(f.state.requests.length, requests);
    } finally { await desktop.close(); }
  }
});

test("renewal checkpoint refuses a changed target or revoked automatic policy before any further publication", async t => {
  for (const kind of ["folder", "policy"]) {
    const f = await fixture(t, { automaticKeys: true, sourceLifetimeMs: 3600000 }), desktop = desktopPublication(f);
    try {
      await desktop.start(); await desktop.worker.tick(); rotateWikiSession(f);
      if (kind === "folder") f.ledger.policies = drivePolicies([{ ...f.policy, folderToken: "ChangedFolder123" }], SAAS_FEISHU);
      else f.keyCustody.authorizeAutomatic = () => false;
      await desktop.refreshSession(); await desktop.worker.tick();
      assert.equal(desktop.status().enabled, false); assert.equal(desktop.status().reason, "renewal-policy-unavailable"); assert.equal(f.state.uploads, 1);
    } finally { await desktop.close(); }
  }
});

test("renewed empty publisher remains waiting for reads without retaining its predecessor deadline", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t, { automaticKeys: true, sourceLifetimeMs: 3600000 }), desktop = desktopPublication(f);
  try {
    await f.wiki.save([]); await desktop.start(); await desktop.worker.tick(); const previousExpiry = desktop.status().expiresAt;
    t.mock.timers.tick(780000); rotateWikiSession(f); await desktop.refreshSession();
    t.mock.timers.tick(121000); await desktop.worker.tick();
    assert.equal(desktop.status().enabled, true); assert.equal(desktop.status().last.outcome, "waiting-for-sources");
    assert.ok(desktop.status().expiresAt > previousExpiry); assert.equal(f.state.uploads, 0);
  } finally { await desktop.close(); }
});

test("renewed recipient preserves accepted and failed versions instead of downloading them again", async t => {
  for (const kind of ["received", "failed"]) {
    const { f, r, desktop } = await receptionFixture(t, { sourceLifetimeMs: 3600000 });
    try {
      if (kind === "failed") f.state.serverSourceDenied = true;
      await desktop.start(); await desktop.tick(); const before = desktop.status().counts;
      assert.equal(before[kind === "failed" ? "unavailable" : "received"], 1);
      const downloads = f.state.downloads, checked = f.state.serverDownloads; rotateWikiSession(f, r.session);
      f.state.serverSourceDenied = false; await desktop.refreshSession(); await desktop.tick();
      assert.equal(desktop.status().enabled, true); assert.equal(desktop.status().counts.skipped, before.skipped + 1);
      assert.equal(f.state.downloads, downloads); assert.equal(f.state.serverDownloads, checked);
      if (kind === "received") assert.equal((await r.wiki.search("采购")).hits.length, 1);
    } finally { await desktop.close(); }
  }
});

test("recipient renewal refuses changed catalog and cannot restart a stopped receiver", async t => {
  const { f, r, desktop } = await receptionFixture(t, { sourceLifetimeMs: 3600000 });
  try {
    await desktop.start(); rotateWikiSession(f, r.session); f.keyCustody.discoveryPublishers = () => ["alice", "extra"];
    await desktop.refreshSession(); await desktop.tick(); assert.equal(desktop.status().reason, "renewal-policy-unavailable");
    assert.equal(desktop.status().enabled, false); assert.equal(desktop.status().counts.received, 0);
    const requests = f.state.requests.length; await desktop.refreshSession(); assert.equal(f.state.requests.length, requests);
  } finally { await desktop.close(); }
});

test("recipient keeps current source authorization after predecessor expiry and ignores its stale expiry callback", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { f, r, desktop } = await receptionFixture(t, { sourceLifetimeMs: 3600000 }), callbacks = [];
  desktop.timers = { set: (fn, delay) => { const row = { fn, delay, unref() {} }; callbacks.push(row); return row; }, clear: row => { if (row) row.cleared = true; } };
  try {
    await desktop.start(); await desktop.tick(); const expiry = callbacks.find(row => !row.cleared && row.delay > 120000), before = desktop.status().expiresAt;
    assert.ok(expiry); t.mock.timers.tick(780000); rotateWikiSession(f, r.session); await desktop.refreshSession();
    expiry.fn(); await Promise.resolve(); assert.equal(desktop.status().enabled, true);
    t.mock.timers.tick(121000); await desktop.tick(); assert.equal(desktop.status().enabled, true);
    assert.ok(desktop.status().expiresAt > before); assert.equal(desktop.status().counts.received, 1);
    assert.equal((await r.wiki.search("采购")).hits.length, 1);
    await desktop.stop(); const requests = f.state.requests.length; await desktop.refreshSession();
    assert.equal(desktop.status().state, "stopped"); assert.equal(f.state.requests.length, requests);
  } finally { await desktop.close(); }
});

test("candidate recheck rejects a changed policy digest even if target and catalog metadata match", async t => {
  const { desktop } = await receptionFixture(t);
  try {
    const page = await desktop.discovery.page(), target = page.targets[0]; assert.ok(target);
    desktop.discovery.page = async () => ({ ...page, policyDigest: wikiHash("different-policy") });
    await assert.rejects(desktop.discovery.assertCandidate(page, target), /策略已变化/);
  } finally { await desktop.close(); }
});

function scheduled(f) {
  const state = { revoked: false, releases: 0 };
  const scheduler = new WikiPublicationScheduler({ publisher: f.publisher, intervalMs: 15, authorizeScope: async input => ({
    scopeDigest: wikiHash(input), expiresAt: Date.now() + 60000,
    assertCurrent: async () => { if (state.revoked) throw new Error("SECRET scope revoked"); }, release: async () => { state.releases++; },
  }) });
  return { scheduler, state };
}
function networkScheduled(t, f) {
  const scopes = new WikiPublicationScopeClient({ feishu: SAAS_FEISHU, getSession: async () => f.session, fetchImpl: f.client.fetch,
    businessAccess: () => { if (!f.state.allowed) throw new Error("unlinked"); } });
  const scheduler = new WikiPublicationScheduler({ publisher: f.publisher, authorizeScope: (scope, options) => scopes.authorize(scope, options),
    timers: { set: () => ({ unref() {} }), clear() {} } });
  t.after(async () => { await scheduler.close(); scopes.close(); });
  return { scheduler, scopes };
}

function readingPublisher(t, f) {
  const { scopes } = networkScheduled(t, f);
  const worker = new WikiReadingPublication({ wiki: f.wiki, publisher: f.publisher, authorizeScope: (scope, options) => scopes.authorize(scope, options),
    businessAccess: () => { if (!f.state.allowed) throw new Error("unlinked"); }, timers: { set: () => ({ unref() {} }), clear() {} } });
  t.after(() => worker.close());
  const documents = new DocumentService({ provider: f.sourceProvider, getTask: () => {} });
  documents.on("read", document => { void f.wiki.observe(document); });
  const target = { shardKey: f.input.shardKey, folderReference: f.input.folderReference };
  const read = async source => { await documents.open("synthetic-task", source.sourceUrl); await f.wiki.queue; };
  const secondSource = () => {
    const source = { ...f.source, resourceId: "SecondReading123", sourceUrl: "https://test.feishu.cn/docx/SecondReading123", title: "后续阅读", text: "采购验收第二份记录。" };
    source.contentHash = wikiHash(["feishu-docx-plain-v1", source.resourceId, source.sourceRevision, source.title, source.text]); f.state.sources.set(source.resourceId, source); return source;
  };
  return { worker, read, secondSource, target };
}

test("actual document-read events drive encrypted publication and reauthorized source expansion without hand-picked IDs", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t, { automaticKeys: true }), r = readingPublisher(t, f); await f.wiki.save([]);
  await r.worker.start(r.target); await r.worker.tick(); assert.equal(r.worker.status().last.outcome, "waiting-for-sources");
  assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/acquire")).length, 0);
  await r.read(f.source); t.mock.timers.tick(120000); await r.worker.tick(); assert.equal(f.state.uploads, 1);
  await r.read(r.secondSource()); t.mock.timers.tick(120000); await r.worker.tick(); assert.equal(f.state.uploads, 2);
  const publication = (await f.client.head(f.input.shardKey)).publication; assert.equal(publication.generation, 2); assert.equal(publication.manifest.sourceCount, 2);
  const scopes = f.state.requests.filter(row => row.route.endsWith("/scopes/acquire"));
  assert.deepEqual(scopes.map(row => row.body.sourceIds.length), [1, 2]); assert.equal(r.worker.status().counts.published, 2);
  const charged = f.ledger.snapshot(f.who).chargedBytes;
  t.mock.timers.tick(120000); await r.worker.tick(); assert.equal(f.state.uploads, 2); assert.equal(f.ledger.snapshot(f.who).chargedBytes, charged);
  await r.worker.stop(); assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/release")).length, 2);
});

test("read accepted during upload joins only the next freshly authorized publication", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t, { automaticKeys: true }), r = readingPublisher(t, f);
  f.state.onUpload = async () => { if (f.state.uploads === 1) await r.read(r.secondSource()); };
  await r.worker.start(r.target); await r.worker.tick(); assert.equal((await f.client.head(f.input.shardKey)).publication.manifest.sourceCount, 1);
  t.mock.timers.tick(120000); await r.worker.tick(); assert.equal((await f.client.head(f.input.shardKey)).publication.manifest.sourceCount, 2);
  assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/acquire")).length, 2);
});

test("import-only evidence does not become a local reading or automatically re-export after restart", async t => {
  const f = await fixture(t, { recipientKeys: true }); await f.publisher.publish(f.input); const r = await recipient(t, f);
  await r.receiver.receive(f.input.shardKey, f.input.folderReference);
  assert.equal((await r.wiki.search("采购")).hits.length, 1); assert.deepEqual((await r.wiki.publicationCandidates()).sourceIds, []);
  await r.wiki.close(); const restored = new LocalWiki({ filename: r.filename, provider: f.sourceProvider, cipher: r.cipher }); f.nodes.push(restored);
  assert.deepEqual((await restored.publicationCandidates()).sourceIds, []);
  await restored.observe({ ...f.source, identity: await f.sourceProvider.documentIdentity() });
  assert.equal((await restored.publicationCandidates()).sourceIds.length, 1);
});

test("reading publication stops on original denial or account change without reusing old scope", async t => {
  for (const kind of ["source", "account", "expired-reading"]) {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await fixture(t, { automaticKeys: true }), r = readingPublisher(t, f); await r.worker.start(r.target); await r.worker.tick();
    if (kind === "source") f.state.sourceDenied = true;
    if (kind === "account") f.state.principal = wikiHash("bob");
    if (kind === "expired-reading") f.wiki.retentionMs = 1000;
    t.mock.timers.tick(120000); await r.worker.tick();
    assert.equal(f.state.uploads, 1); assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/acquire")).length, 1);
    if (kind === "expired-reading") assert.equal(r.worker.status().last.outcome, "waiting-for-sources");
    else { assert.equal(r.worker.status().state, "paused"); await r.worker.tick(); assert.equal(f.state.uploads, 1); }
    assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/release")).length, 1);
    await r.worker.close(); t.mock.timers.reset();
  }
});

test("service-backed automatic scope publishes real changed versions and leaves unchanged content uncharged", async t => {
  // Exercise the production two-minute cadence without a wall-clock sleep;
  // rapid manual ticks legitimately exhaust the shared per-minute quota.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t, { automaticKeys: true }), { scheduler } = networkScheduled(t, f);
  await scheduler.start(planningInput(f.input)); await scheduler.tick();
  assert.equal(scheduler.status().counts.published, 1);
  t.mock.timers.tick(120000);
  await scheduler.tick(); assert.equal(scheduler.status().counts.unchanged, 1); assert.equal(f.state.uploads, 1);
  f.source.text += "第二版复核记录。";
  f.source.contentHash = wikiHash(["feishu-docx-plain-v1", f.source.resourceId, f.source.sourceRevision, f.source.title, f.source.text]);
  t.mock.timers.tick(120000);
  await scheduler.tick(); assert.equal(scheduler.status().counts.published, 2, JSON.stringify({ status: scheduler.status(), routes: f.state.requests.reduce((counts, row) => ({ ...counts, [row.route]: (counts[row.route] || 0) + 1 }), {}) })); await scheduler.stop();
  assert.equal(f.state.uploads, 2); assert.equal((await f.client.head(f.input.shardKey)).publication.generation, 2);
  assert.equal(f.ledger.snapshot(f.who).chargedBytes, [...f.state.artifacts.values()].reduce((sum, item) => sum + item.bytes.length, 0));
  assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/acquire")).length, 1);
  assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/release")).length, 1);
  assert.equal(JSON.stringify(f.state.requests).includes(f.source.text), false);
});

test("automatic scope is default-off and cannot override target, account, source shape or native business gate", async t => {
  for (const kind of ["default", "folder", "origin", "duplicate", "empty", "account", "native"]) {
    const f = await fixture(t, kind === "default" ? { recipientKeys: true } : { automaticKeys: true }), { scheduler } = networkScheduled(t, f);
    const scope = planningInput(f.input);
    if (kind === "folder") scope.folderReference = "https://test.feishu.cn/drive/folder/Other123";
    if (kind === "origin") scope.folderReference = "https://other.feishu.cn/drive/folder/SyntheticFolder123";
    if (kind === "duplicate") scope.sourceIds.push(scope.sourceIds[0]);
    if (kind === "empty") scope.sourceIds = [];
    if (kind === "account") Object.assign(f.session, f.sessions.issue({ ...f.policy, userId: "bob", deviceId: "b", deviceProof: "ed25519-login" }));
    if (kind === "native") f.state.allowed = false;
    await assert.rejects(scheduler.start(scope)); assert.equal(f.state.uploads, 0);
    assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 0);
  }
});

test("service-backed scope revocation inside upload preserves receipt but prevents publication and automatic retry", async t => {
  const f = await fixture(t, { automaticKeys: true }), { scheduler } = networkScheduled(t, f);
  f.state.onUpload = () => { f.keyCustody.authorizeAutomatic = () => false; };
  await scheduler.start(planningInput(f.input)); await scheduler.tick();
  assert.equal(scheduler.status().state, "paused"); assert.equal(scheduler.status().reason, "operation-failed");
  assert.equal(f.state.uploads, 1); assert.equal((await f.client.head(f.input.shardKey)).publication, null);
  const [row] = await f.publisher.journal.load(); assert.equal(row.state, "recorded"); assert.equal(row.fileToken, "SyntheticFile123");
  assert.ok(f.ledger.snapshot(f.who).chargedBytes > 0);
  f.keyCustody.authorizeAutomatic = () => true; await scheduler.start(planningInput(f.input)); await scheduler.tick();
  assert.equal(scheduler.status().reason, "review-required"); assert.equal(f.state.uploads, 1);
});

test("automatic scope HTTP handles require parent and namespace ownership, with no keys or implicit renewal", async t => {
  const f = await fixture(t, { automaticKeys: true });
  const request = (action, body, token = f.session.token, namespace = "scopes") => fetch(`${f.session.serverUrl}/v1/wiki/${namespace}/${action}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const scope = planningInput(f.input); scope.sourceIds = Array.from({ length: 200 }, (_, n) => wikiHash(n));
  const response = await request("acquire", scope); assert.equal(response.status, 200); const grant = await response.json();
  assert.equal("keyBase64" in grant, false); assert.equal("sourceIds" in grant, false); assert.ok(grant.expiresAt <= f.session.expiresAt);
  assert.equal((await request("acquire", scope)).status, 403);
  const other = f.sessions.issue({ ...f.policy, userId: "alice", deviceId: "other", deviceProof: "ed25519-login" });
  for (const action of ["current", "release"]) {
    assert.equal((await request(action, { grantId: grant.grantId }, other.token)).status, 403);
    assert.equal((await request(action, { grantId: grant.grantId }, f.session.token, "keys")).status, 403);
  }
  assert.equal((await request("acquire", scope, f.sessions.issueForWiki(f.session.token).token)).status, 403);
  assert.deepEqual(await (await request("current", { grantId: grant.grantId })).json(), grant);
  assert.equal((await request("release", { grantId: grant.grantId })).status, 200);
  assert.equal((await request("current", { grantId: grant.grantId })).status, 403);
});

test("automatic scope client rejects altered receipts and clears on session, expiry, abort, policy or close", async t => {
  for (const kind of ["receipt", "session", "expiry", "abort", "policy", "close", "logout", "current-receipt"]) {
    const f = await fixture(t, { automaticKeys: true }), { scopes } = networkScheduled(t, f), controller = new AbortController();
    if (kind === "receipt") {
      scopes.transport.fetch = async (url, options) => { const res = await f.client.fetch(url, options); const value = await res.json(); return Response.json({ ...value, scopeDigest: wikiHash("substitute") }); };
      await assert.rejects(scopes.authorize(planningInput(f.input))); continue;
    }
    const grant = await scopes.authorize(planningInput(f.input), { signal: controller.signal });
    if (kind === "session") f.session.token = f.sessions.issue({ ...f.policy, userId: "alice", deviceId: "other", deviceProof: "ed25519-login" }).token;
    if (kind === "expiry") scopes.transport.now = () => grant.expiresAt;
    if (kind === "abort") controller.abort();
    if (kind === "policy") f.ledger.policies = drivePolicies([{ ...f.policy, maxBytes: 999999 }], SAAS_FEISHU);
    if (kind === "close") scopes.close();
    if (kind === "logout") f.sessions.revoke(f.session.token);
    if (kind === "current-receipt") scopes.transport.fetch = async (url, options) => { const res = await f.client.fetch(url, options); return Response.json({ ...await res.json(), nodeId: wikiHash("substitute") }); };
    await assert.rejects(grant.assertCurrent()); await grant.release(); assert.equal(f.state.uploads, 0);
  }
});

test("lost automatic scope response is not retried and creates no publication or upload", async t => {
  const f = await fixture(t, { automaticKeys: true }), { scheduler } = networkScheduled(t, f); f.state.dropRoute = "/scopes/acquire";
  await assert.rejects(scheduler.start(planningInput(f.input))); assert.equal(f.state.uploads, 0);
  assert.equal(f.state.requests.filter(row => row.route.endsWith("/scopes/acquire")).length, 1);
  assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 0);
});

test("automatic scope approval is not source permission and cannot unlock publisher keys for denied originals", async t => {
  const f = await fixture(t, { automaticKeys: true }), { scheduler } = networkScheduled(t, f);
  f.state.serverSourceDenied = true;
  await scheduler.start(planningInput(f.input)); assert.equal(scheduler.status().enabled, true);
  await scheduler.tick(); assert.equal(scheduler.status().state, "paused"); assert.equal(f.state.uploads, 0);
  assert.equal(f.state.requests.filter(row => row.route.endsWith("/keys/prepare")).length, 0);
  assert.equal((await f.client.head(f.input.shardKey)).publication, null);
});

function waitForSchedule(scheduler, predicate) {
  if (predicate(scheduler.status())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = error => { clearTimeout(timer); scheduler.off("changed", onChange); error ? reject(error) : resolve(); };
    const onChange = status => { if (predicate(status)) done(); else if (["paused", "closed", "stopped"].includes(status.state)) done(new Error(`Unexpected scheduler state: ${status.state}/${status.reason}`)); };
    const timer = setTimeout(() => done(new Error("Scheduler condition timed out")), 10000);
    scheduler.on("changed", onChange);
  });
}

test("automatic publisher creates two real versions for changed content and charges no unchanged cycles", async t => {
  const f = await fixture(t), { scheduler, state } = scheduled(f);
  try {
    await scheduler.start(planningInput(f.input));
    await waitForSchedule(scheduler, value => value.counts.unchanged >= 2);
    assert.equal(f.state.uploads, 1);
    f.source.text = "采购验收只面向采购组。第二版新增复核记录。";
    await waitForSchedule(scheduler, value => value.counts.published === 2 && value.counts.unchanged >= 3);
    await scheduler.stop();
    assert.equal(f.state.uploads, 2); assert.equal(f.state.artifacts.size, 2);
    const total = [...f.state.artifacts.values()].reduce((sum, item) => sum + item.bytes.length, 0);
    assert.equal(f.ledger.snapshot(f.who).chargedBytes, total);
    assert.equal((await f.client.head(f.input.shardKey)).publication.generation, 2);
    assert.equal((await f.publisher.journal.load()).filter(row => row.state === "published").length, 2);
    assert.equal(state.releases, 1); assert.equal(scheduler.status().busy, false);
    assert.equal(scheduler.status().nextAt, null);
  } finally { await scheduler.close(); }
});

test("automatic scope revocation during upload retains its receipt but cannot publish or automatically retry", async t => {
  const f = await fixture(t), { scheduler, state } = scheduled(f);
  f.state.onUpload = async () => { state.revoked = true; };
  try {
    await scheduler.start(planningInput(f.input));
    await waitForSchedule(scheduler, value => value.state === "paused" && !value.busy);
    assert.equal(scheduler.status().reason, "operation-failed"); assert.equal(f.state.keyRevoked, false);
    assert.equal(f.state.uploads, 1); assert.equal((await f.client.head(f.input.shardKey)).publication, null);
    const [row] = await f.publisher.journal.load(); assert.equal(row.state, "recorded"); assert.equal(row.fileToken, "SyntheticFile123");
    assert.ok(f.ledger.snapshot(f.who).chargedBytes > 0);
    state.revoked = false; await scheduler.start(planningInput(f.input));
    await waitForSchedule(scheduler, value => value.state === "paused" && !value.busy);
    assert.equal(scheduler.status().reason, "review-required"); assert.equal(scheduler.status().last.operationId, row.id);
    assert.equal(f.state.uploads, 1); assert.equal(state.releases, 2);
  } finally { await scheduler.close(); }
});

test("stopping during durable intent save prevents a lease without discarding the intent", async t => {
  const f = await fixture(t), { scheduler } = scheduled(f), save = f.publisher.journal.save.bind(f.publisher.journal);
  f.publisher.journal.save = async rows => { await save(rows); if (rows.at(-1).state === "created") void scheduler.stop(); };
  try {
    await scheduler.start(planningInput(f.input));
    await waitForSchedule(scheduler, value => value.state === "stopped" && !value.busy);
    assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 0);
    assert.equal(f.state.uploads, 0); assert.equal(f.ledger.snapshot(f.who).chargedBytes, 0);
    const [row] = await f.publisher.journal.load(); assert.equal(row.state, "created"); assert.equal(row.lease, null);
  } finally { await scheduler.close(); }
});

test("stopping during source preflight cancels the read without a journal, lease or upload", async t => {
  const f = await fixture(t), { scheduler, state } = scheduled(f);
  let entered; const reading = new Promise(resolve => { entered = resolve; });
  f.wiki.exportEvidence = async (_, { signal }) => {
    signal.throwIfAborted(); entered();
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  try {
    await scheduler.start(planningInput(f.input));
    const work = scheduler.tick(); await reading; await scheduler.stop(); await work;
    assert.equal(f.state.uploads, 0); assert.equal(state.releases, 1);
    assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_leases").get().n, 0);
    await assert.rejects(readFile(f.publisher.journal.filename), { code: "ENOENT" });
  } finally { await scheduler.close(); }
});

test("publisher registers the actual sealed source set and another OAuth identity checks only that immutable list", async t => {
  const f = await fixture(t, { registeredSources: true }); await f.publisher.publish(f.input);
  const rows = f.coordinator.db.prepare("SELECT * FROM wiki_source_declarations").all(); assert.equal(rows.length, 1);
  const head = (await f.client.head(f.input.shardKey)).publication;
  assert.equal(rows[0].source_hash, head.manifest.sourceSetHash);
  assert.equal(JSON.stringify(rows).includes(f.source.text), false); assert.equal(JSON.stringify(rows).includes(f.source.title), false);
  assert.ok(f.state.requests.every(row => !JSON.stringify(row.body).includes(f.source.text)));
  const bob = f.sessions.issue({ ...f.who, userId: "bob", deviceId: "device2" }); f.bindSourceAccess(bob);
  const recipient = new WikiSourceRegistryClient({ getSession: async () => ({ ...bob, serverUrl: f.session.serverUrl }) });
  const checked = await recipient.checkPublished(f.input.shardKey);
  assert.equal(checked.declaredSourcesReadable, true); assert.equal(checked.contentVerified, false); assert.equal(checked.manifestHash, head.manifestHash);
  const before = f.state.permissionChecks; f.state.serverSourceDenied = true;
  await assert.rejects(recipient.checkPublished(f.input.shardKey)); assert.equal(f.state.permissionChecks, before + 1);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.downloads, 1);
});

test("server source denial prevents key preparation and upload even when native source reads succeed", async t => {
  const f = await fixture(t, { registeredSources: true }); f.state.serverSourceDenied = true;
  await assert.rejects(f.publisher.publish(f.input));
  assert.equal(f.state.keyRequest, undefined); assert.equal(f.state.uploads, 0); assert.equal(f.ledger.snapshot(f.who).chargedBytes, 0);
  assert.equal(f.coordinator.db.prepare("SELECT COUNT(*) AS n FROM wiki_source_declarations").get().n, 0);
});

test("registered publication reaches a second recipient only after current server checks and actual source import", async t => {
  const f = await fixture(t, { registeredSources: true }); await f.publisher.publish(f.input);
  f.state.principal = wikiHash("bob");
  const bob = new LocalWiki({ filename: path.join(f.directory, "bob.enc"), provider: f.sourceProvider, cipher: fixtureCipher() }); f.nodes.push(bob);
  const issued = f.sessions.issue({ ...f.who, userId: "bob", deviceId: "device2" }); f.bindSourceAccess(issued);
  const getSession = async () => ({ ...issued, serverUrl: f.session.serverUrl });
  let keys = 0, released = 0;
  const receiver = new WikiBundleReceiver({ coordinator: new WikiCoordinatorClient({ getSession }), drive: f.drive, wiki: bob,
    sourceRegistry: new WikiSourceRegistryClient({ getSession }), keyAuthority: { acquire: async ({ identity }) => {
      keys++; assert.equal(identity.principal, wikiHash("bob"));
      return { key: f.secret, assertCurrent: async () => {}, release: async () => { released++; } };
    } } }); // Synthetic key authority is NOT production key-release proof.
  f.state.serverSourceDenied = true;
  await assert.rejects(receiver.receive(f.input.shardKey, f.input.folderReference));
  assert.equal(keys, 0); assert.equal(f.state.downloads, 1);
  await assert.rejects(readFile(bob.filename), { code: "ENOENT" });
  f.state.serverSourceDenied = false;
  assert.deepEqual(await receiver.receive(f.input.shardKey, f.input.folderReference), { retained: 1, requested: 1 });
  const hits = (await bob.search("采购")).hits;
  assert.equal(hits.length, 1); assert.equal(hits[0].sourceUrl, f.source.sourceUrl);
  assert.equal((await readFile(bob.filename)).includes(Buffer.from(f.source.text)), false);
  assert.equal(keys, 1); assert.equal(released, 1); assert.equal(f.state.downloads, 2);
  const before = f.state.permissionChecks; f.state.serverSourceDenied = true;
  await assert.rejects(receiver.receive(f.input.shardKey, f.input.folderReference));
  assert.equal(f.state.permissionChecks, before + 1); assert.equal(keys, 1); assert.equal(f.state.downloads, 2);
});
