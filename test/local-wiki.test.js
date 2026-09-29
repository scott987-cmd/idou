import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalWiki, confirmedSynthesizer, evidencePage } from "../src/knowledge/local-wiki.js";
import { DocumentService } from "../src/application/document-service.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { storedPages, storedBytes } from "../scripts/fixtures/wiki-store.js";
import { once } from "node:events";
import { GatewayWikiSynthesizer, sessionBinding } from "../src/knowledge/synthesis.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";

function source(changes = {}) {
  return { providerId: "fixture", resourceId: "Document123", sourceUrl: "https://test.feishu.cn/docx/Document123", sourceRevision: "1", contentHash: "hash-v1", title: "项目安排", text: "客户目标\n下周交付采购报告。", partial: false, warnings: [], identity: { principal: "alice", tenantKey: "tenant-a", verifiedAt: 1000 }, ...changes };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wiki-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let document = source(), identity = document.identity, clock = 2000, failure = false;
  const calls = [], cipher = fixtureCipher(), filename = path.join(directory, "wiki.enc");
  const provider = { documentIdentity: async () => identity, readDocument: async (url) => { calls.push(url); if (failure) throw new Error("Revoked SECRET DETAIL"); return structuredClone(document); } };
  const create = () => new LocalWiki({ filename, provider, cipher, now: () => clock, ...options });
  return { wiki: create(), create, filename, cipher, provider, calls, doc: () => document,
    change: (patch) => { document = { ...document, ...patch }; }, login: (patch) => { identity = { ...identity, ...patch }; },
    deny: () => { failure = true; }, allow: () => { failure = false; }, clock: (value) => { clock = value; } };
}

test("accepted document reads automatically build encrypted, restartable evidence with exact citations", async (t) => {
  const f = await fixture(t), documents = new DocumentService({ provider: f.provider, getTask: () => {} });
  documents.on("read", (document) => { void f.wiki.observe(document); });
  await documents.open("task", f.doc().sourceUrl); await f.wiki.queue;
  // 正文不能以明文出现在副本目录下的任何一个文件里，清单和分页文件都算。
  assert.equal((await storedBytes(f.filename)).includes(Buffer.from("采购报告")), false);
  assert.equal((await stat(f.filename)).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(`${f.filename}.d`, (await readdir(`${f.filename}.d`))[0]))).mode & 0o777, 0o600);
  const stored = await storedPages(f.cipher, f.filename);
  assert.equal(stored.length, 1); assert.equal(stored[0].tenantId, "tenant-a");
  assert.deepEqual(stored[0].aclEvidence, { kind: "successful-user-source-read", subject: "alice", checkedAt: 1000 });
  assert.equal(stored[0].chunks.map((chunk) => chunk.text).join(""), f.doc().text);
  await f.wiki.close();
  const restored = f.create(), result = await restored.search("采购");
  assert.equal(result.hits.length, 1); assert.match(result.hits[0].excerpt, /采购报告/);
  assert.equal(result.hits[0].sourceUrl, f.doc().sourceUrl); assert.equal(result.hits[0].format, "source-excerpts-v2");
  assert.equal(f.calls.length, 2, "cached page must trigger a new authoritative read");
});

test("chunk boundaries reconstruct Unicode and have revision-dependent IDs", () => {
  const text = "中😀".repeat(1700), a = evidencePage(source({ text }), 2000), b = evidencePage(source({ text, contentHash: "changed" }), 2000);
  assert.equal(a.chunks.map((chunk) => chunk.text).join(""), text);
  for (const chunk of a.chunks) { assert.equal(text.slice(chunk.start, chunk.end), chunk.text); assert.ok(chunk.text.isWellFormed()); assert.ok(chunk.text.length <= 1600); }
  assert.notEqual(a.chunks[0].id, b.chunks[0].id);
});

test("文档嵌入的电子表格和多维表格作为链接留在页面上，重启后仍在", async (t) => {
  const page = evidencePage(source({ text: "明细见下表。\n[电子表格：重点客户台账]\n",
    resources: [{ kind: "sheet", label: "电子表格：重点客户台账", token: "ShtToken1234", sheetId: "s1" },
      { kind: "bitable", label: "多维表格：商机", token: "BasToken1234", tableId: "tblSynthetic001" },
      { kind: "img", label: "图片", token: "imgToken12345" }] }), 2000);
  assert.deepEqual(page.embeds, [
    { kind: "电子表格", title: "电子表格：重点客户台账", sourceUrl: "https://test.feishu.cn/sheets/ShtToken1234?sheet=s1" },
    { kind: "多维表格", title: "多维表格：商机", sourceUrl: "https://test.feishu.cn/base/BasToken1234?table=tblSynthetic001" },
  ], "图片之类不是可再读的来源，不留链接");

  // The stored text keeps only the placeholder, so the links have to travel
  // with the page across a restart.
  const f = await fixture(t);
  // A different body is a different content hash: that is what a real read
  // reports, and the store's caches are keyed by it.
  f.change({ text: "明细见下表。\n[电子表格：重点客户台账]\n", contentHash: "hash-embeds", resources: [{ kind: "sheet", label: "电子表格：重点客户台账", token: "ShtToken1234", sheetId: "s1" }] });
  await f.wiki.observe(f.doc()); await f.wiki.close();
  const hits = (await f.create().search("明细")).hits;
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].embeds, [{ kind: "电子表格", title: "电子表格：重点客户台账", sourceUrl: "https://test.feishu.cn/sheets/ShtToken1234?sheet=s1" }]);
});

test("same-resource reads deduplicate, while tenants and principals never share cached results", async (t) => {
  const f = await fixture(t); await Promise.all([f.wiki.observe(f.doc()), f.wiki.observe(f.doc())]);
  assert.equal((await storedPages(f.cipher, f.filename)).length, 1);
  for (const identity of [{ principal: "bob" }, { principal: "alice", tenantKey: "tenant-b" }]) {
    f.login(identity); assert.deepEqual((await f.wiki.search("采购")).hits, []);
  }
  assert.equal(f.calls.length, 0);
});

test("a source that cannot be re-read answers nothing, and the third failure in a row removes it", async (t) => {
  const f = await fixture(t); await f.wiki.observe(f.doc()); f.deny();
  const first = await f.wiki.search("采购");
  // No cached text, no provider error text, and nothing for the model to use.
  assert.deepEqual(first.hits, []); assert.equal(first.unavailable, 1); assert.doesNotMatch(JSON.stringify(first), /SECRET|采购报告/);
  // A network blip used to cost the person the document silently. It is kept,
  // marked, and excluded until it can be verified again.
  const kept = (await storedPages(f.cipher, f.filename));
  assert.equal(kept.length, 1); assert.equal(kept[0].staleCount, 1);
  assert.deepEqual((await f.wiki.search("采购")).hits, [], "标记为待核验的副本不参与回答");
  assert.equal((await storedPages(f.cipher, f.filename))[0].staleCount, 2);
  assert.deepEqual((await f.wiki.search("采购")).hits, []);
  assert.equal((await storedPages(f.cipher, f.filename)).length, 0, "第三次仍然读不到就不再保留");
});

test("没有变化的搜索什么都不重写；改了一篇，就只重写那一篇", async (t) => {
  const f = await fixture(t);
  await f.wiki.observe(f.doc());
  // 另外两篇只是陪衬：它们的字节不该因为别人变了而被重写一遍。
  for (const id of ["other-1", "other-2"]) await f.wiki.observe(source({ resourceId: id, sourceUrl: `https://test.feishu.cn/docx/${id}`, contentHash: `hash-${id}`, text: `${id} 的正文。` }));
  await f.wiki.queue;
  const before = await readdir(`${f.filename}.d`);
  const sizes = new Map(await Promise.all(before.map(async (name) => [name, (await stat(path.join(`${f.filename}.d`, name))).mtimeMs])));
  let writes = 0;
  const encrypt = f.cipher.encrypt;
  // 词表侧车也用同一把钥匙加密，但它是派生缓存，不算副本的写：它的负载是 gzip 的
  // base64，开头固定是 H4sI。
  f.cipher.encrypt = (value) => { if (!String(value).startsWith("H4sI")) writes += 1; return encrypt(value); };
  // Eight documents re-read and unchanged: the only thing that moved is when
  // they were last used, and that does not justify re-encrypting the store.
  await f.wiki.search("采购");
  await f.wiki.search("采购");
  assert.equal(writes, 0, "没有内容变化就不该重写");
  f.change({ text: "采购报告已取消。", sourceRevision: "2", contentHash: "hash-v2" });
  await f.wiki.search("采购");
  assert.equal(writes, 2, "改一篇只重写这一篇加一份清单，不是整份副本");
  const after = await readdir(`${f.filename}.d`);
  assert.deepEqual(after.sort(), before.sort(), "页文件按文档命名，改版本不会多出一个文件");
  const untouched = [];
  for (const name of after) if (sizes.get(name) === (await stat(path.join(`${f.filename}.d`, name))).mtimeMs) untouched.push(name);
  assert.equal(untouched.length, 2, "没被改的两篇一个字节都不该动");
  const saved = await storedPages(f.cipher, f.filename);
  assert.equal(saved.find((page) => page.sourceUrl === f.doc().sourceUrl).revision, "2", "改过的那一篇存的是新版本");
});

test("清单说得出库里有什么，移除只动本机副本", async (t) => {
  const f = await fixture(t);
  await f.wiki.observe(f.doc());
  const listed = await f.wiki.inventory();
  assert.equal(listed.sources.length, 1);
  const [source] = listed.sources;
  assert.equal(source.title, "项目安排");
  assert.equal(source.kind, "feishu-document");
  assert.equal(source.sourceUrl, f.doc().sourceUrl);
  assert.equal(source.stale, 0);
  assert.ok(source.chars > 0);
  assert.equal(listed.maxDocuments, 1000);
  // A listing is not an answer: it makes no provider call and carries no text.
  assert.equal(f.calls.length, 0, "清单不该产生任何飞书调用");
  assert.doesNotMatch(JSON.stringify(listed), /采购报告/, "清单不返回正文");

  assert.equal((await f.wiki.forget(source.id)).removed.title, "项目安排");
  assert.deepEqual((await f.wiki.inventory()).sources, []);
  assert.equal((await storedPages(f.cipher, f.filename)).length, 0);
  await assert.rejects(f.wiki.forget(source.id), /不在当前账号/);
  await assert.rejects(f.wiki.forget("nope"), /编号无效/);
  // Removing is local: reading the document again rebuilds the copy.
  await f.wiki.observe(f.doc());
  assert.equal((await f.wiki.inventory()).sources.length, 1);
});

test("别的账号的副本既看不到也删不掉", async (t) => {
  const f = await fixture(t);
  await f.wiki.observe(f.doc());
  const [mine] = (await f.wiki.inventory()).sources;
  f.login({ principal: "bob" });
  assert.deepEqual((await f.wiki.inventory()).sources, []);
  await assert.rejects(f.wiki.forget(mine.id), /不在当前账号/);
});

test("一直在用的副本不会因为最初阅读时间过期被清掉，没人再用的照样过期", async (t) => {
  const f = await fixture(t, { retentionMs: 10_000 });
  await f.wiki.observe(f.doc());
  // Well past the retention window since the person read it, but it answered a
  // question a moment ago: retention counts from that.
  f.clock(2000 + 9_000);
  assert.equal((await f.wiki.search("采购")).hits.length, 1);
  f.clock(2000 + 9_000 + 9_000);
  assert.equal((await f.wiki.search("采购")).hits.length, 1, "还在用的来源不该被清掉");
  // Nothing touches it for longer than the window and it goes.
  f.clock(2000 + 9_000 + 9_000 + 20_000);
  assert.deepEqual((await f.wiki.search("采购")).hits, []);
  assert.equal((await storedPages(f.cipher, f.filename)).length, 0);
});

test("verification recovers: a source that reads again is usable and stops being marked", async (t) => {
  const f = await fixture(t); await f.wiki.observe(f.doc()); f.deny();
  await f.wiki.search("采购");
  assert.equal((await storedPages(f.cipher, f.filename))[0].staleCount, 1);
  f.allow();
  const result = await f.wiki.search("采购");
  assert.equal(result.hits.length, 1); assert.equal(result.unavailable, 0);
  assert.equal((await storedPages(f.cipher, f.filename))[0].staleCount, undefined);
});

test("fresh versions replace stale text and wiki redirects do not inherit the old resource", async (t) => {
  const f = await fixture(t); await f.wiki.observe(f.doc());
  f.change({ text: "采购报告已取消。", sourceRevision: "2", contentHash: "hash-v2" });
  const result = await f.wiki.search("采购"); assert.equal(result.hits[0].revision, "2"); assert.equal(result.hits[0].excerpt, "采购报告已取消。");
  f.change({ resourceId: "SecretOtherDocument" });
  assert.deepEqual((await f.wiki.search("采购")).hits, []);
});

test("missing tenant, anchored excerpts and unavailable encryption do not persist", async (t) => {
  const f = await fixture(t);
  for (const document of [source({ identity: { principal: "alice", tenantKey: null, verifiedAt: 1000 } }), source({ partial: true }), source({ sourceUrl: `${source().sourceUrl}#share-selection` })]) assert.equal(await f.wiki.observe(document), false);
  f.cipher.available = () => false; assert.equal(await f.wiki.observe(f.doc()), false);
  await assert.rejects(stat(f.filename), { code: "ENOENT" });
  await assert.rejects(f.wiki.search(""), /安全加密不可用/);
});

test("login changes during source verification reject the whole response", async (t) => {
  const f = await fixture(t); await f.wiki.observe(f.doc());
  f.provider.readDocument = async () => { f.login({ principal: "bob" }); return f.doc(); };
  await assert.rejects(f.wiki.search("采购"), /身份已变化/);
});

test("corrupt encrypted storage fails closed and is never overwritten by new observations", async (t) => {
  const f = await fixture(t); await f.wiki.observe(f.doc()); await f.wiki.close();
  const corrupt = Buffer.from("corrupt encrypted snapshot"); await writeFile(f.filename, corrupt);
  const restored = f.create(); assert.equal(await restored.observe(f.doc()), false);
  await assert.rejects(restored.search(""), /无法安全读取/);
  assert.deepEqual(await readFile(f.filename), corrupt);
});

test("local byte/count/retention ceilings prune only derived pages", async (t) => {
  const f = await fixture(t, { maxDocuments: 2, maxBytes: 3500, retentionMs: 5000 });
  for (let i = 0; i < 4; i++) { f.clock(2000 + i); await f.wiki.observe(source({ resourceId: `document-${i}`, text: "证据".repeat(120) })); }
  assert.ok((await stat(f.filename)).size <= 3500);
  const stored = await storedPages(f.cipher, f.filename);
  assert.ok(stored.length <= 2); assert.equal(stored[0].resourceId, "document-3");
  f.clock(9000); assert.deepEqual((await f.wiki.search("")).hits, []); assert.equal(f.calls.length, 0);
  assert.equal((await storedPages(f.cipher, f.filename)).length, 0);
});

test("late older observations cannot overwrite a fresher source", async (t) => {
  const f = await fixture(t);
  await f.wiki.observe(source({ sourceRevision: "2", identity: { ...f.doc().identity, verifiedAt: 3000 } }));
  assert.equal(await f.wiki.observe(f.doc()), false);
  assert.equal((await storedPages(f.cipher, f.filename))[0].revision, "2");
});

test("shutdown drains accepted observations but refuses late reads and queries", async (t) => {
  const f = await fixture(t), observing = f.wiki.observe(f.doc()), closing = f.wiki.close();
  assert.equal(await f.wiki.observe(source({ resourceId: "late" })), false);
  await assert.rejects(f.wiki.search(""), /已关闭/);
  await closing; assert.equal(await observing, true); assert.equal(f.wiki.pages, null);
  assert.equal((await storedPages(f.cipher, f.filename)).length, 1);
});

test("automatic publication candidates preserve local-read provenance across search/restart without treating it as permission", async t => {
  const f = await fixture(t); await f.wiki.observe(f.doc());
  const before = f.calls.length, selected = await f.wiki.publicationCandidates();
  assert.deepEqual(selected.sourceIds, [f.wiki.pages[0].id]); assert.equal(selected.permissionsChecked, false);
  assert.equal(f.calls.length, before); assert.equal(JSON.stringify(selected).includes(f.doc().text), false);
  await f.wiki.search("采购"); await f.wiki.close(); const restored = f.create();
  assert.deepEqual((await restored.publicationCandidates()).sourceIds, selected.sourceIds);
  f.deny(); await assert.rejects(restored.exportEvidence(selected.sourceIds));
  await restored.search("采购"); assert.deepEqual((await restored.publicationCandidates()).sourceIds, []);
});

test("automatic candidates exclude legacy provenance, stale readings and other identities", async t => {
  const f = await fixture(t, { retentionMs: 5000 }); await f.wiki.observe(f.doc());
  const original = structuredClone(f.wiki.pages);
  delete f.wiki.pages[0].localReadAt; await f.wiki.save(f.wiki.pages); await f.wiki.close();
  const restored = f.create(); assert.deepEqual((await restored.publicationCandidates()).sourceIds, []);
  await restored.observe(f.doc()); assert.equal((await restored.publicationCandidates()).sourceIds.length, 1);
  f.login({ principal: "bob" }); assert.deepEqual((await restored.publicationCandidates()).sourceIds, []);
  await assert.rejects(restored.publicationCandidates({ expectedIdentity: f.doc().identity }));
  f.login({ principal: "alice" }); f.clock(8000); assert.deepEqual((await restored.publicationCandidates()).sourceIds, []);
  // Import/refresh time cannot make an old local read recent again.
  await restored.save(original.map(page => ({ ...page, observedAt: 8000 }))); assert.deepEqual((await restored.publicationCandidates()).sourceIds, []);
});

test("candidate selection rejects cancellation, account races and closed nodes without returning stale IDs", async t => {
  const f = await fixture(t); await f.wiki.observe(f.doc()); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.wiki.publicationCandidates({ signal: controller.signal }));
  let calls = 0; f.provider.documentIdentity = async () => ({ ...f.doc().identity, principal: ++calls === 1 ? "alice" : "bob" });
  await assert.rejects(f.wiki.publicationCandidates()); await f.wiki.close(); await assert.rejects(f.wiki.publicationCandidates());
});

test("a model_not_allowed refusal gives its reservation and call back, since nothing was billed; any other failure stays failed", async (t) => {
  // The product's own gateway on loopback, enforcing GLM-5.3, asked for MiniMax-M3: it refuses before its upstream.
  const sessions = new SessionRegistry(), issued = sessions.issue({ tenantId: "tenant-a", userId: "alice", deviceId: "device" });
  let upstream = 0;
  const server = createModelGateway({ sessions, apiKey: "synthetic-key-fixture", provider: "litellm", upstreamOrigin: "http://127.0.0.1:4000", model: "GLM-5.3", upstreamModel: "volc-coding",
    fetchImpl: async () => { upstream++; throw new Error("no upstream call"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.close(); server.closeAllConnections(); });
  const session = { token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` };
  const f = await fixture(t, { synthesizer: new GatewayWikiSynthesizer({ getSession: async () => session, model: "MiniMax-M3" }) });
  const stored = async () => (await storedPages(f.cipher, f.filename))[0];
  await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc());
  assert.equal(upstream, 0);
  assert.equal((await stored()).synthesis, undefined, "released, not failed");
  assert.equal(f.wiki.status().synthesis.enabled, false); assert.equal(f.wiki.status().synthesis.remaining, 6, "the refused call is not counted");
  assert.match(f.wiki.status().message, /不一致，请重新连接/); assert.match(f.wiki.status().message, /不计费/);
  // Under the model the server enforces, the same revision is summarised after all.
  let calls = 0;
  f.wiki.synthesizer = { binding: async () => sessionBinding(session, "GLM-5.3"),
    generate: async (page) => { calls++; return { facts: [{ text: "下周交付采购报告。", evidence: [{ chunkId: page.chunks[0].id, quote: "下周交付采购报告。" }] }] }; } };
  await f.wiki.enableSynthesis(); await f.wiki.observe(f.doc());
  assert.equal(calls, 1); assert.equal((await stored()).synthesis.state, "complete"); assert.equal((await stored()).synthesis.model, "GLM-5.3");
  // Any other failure may have been billed: it stays failed, counted, and is not tried again.
  f.change({ sourceRevision: "2", contentHash: "hash-v2" });
  f.wiki.synthesizer.generate = async () => { calls++; throw new Error("ambiguous provider completion"); };
  await f.wiki.observe(f.doc()); assert.equal(calls, 2);
  assert.equal((await stored()).synthesis.state, "failed"); assert.equal(f.wiki.status().synthesis.remaining, 4);
  await f.wiki.observe(f.doc()); assert.equal(calls, 2); assert.equal(f.wiki.status().synthesis.enabled, true);
});

test("synthesis is agreed to only under the model the server confirmed and the consent named, and nothing is named without one", async (t) => {
  for (const [known, pattern] of [[{ unreachable: true }, /尚未确认/], [{ unknown: "GLM-6" }, /GLM-6 本版本不支持，请更新应用/]]) {
    let created = 0;
    const f = await fixture(t, { synthesizer: confirmedSynthesizer({ current: async () => known }, () => { created++; return assert.fail("no client without a confirmed model"); }) });
    await assert.rejects(f.wiki.enableSynthesis(), error => pattern.test(error.message) && /正文不会发送给模型/.test(error.message) && !/MiniMax|重新连接/.test(error.message));
    assert.equal(created, 0); assert.equal(f.wiki.status().synthesis.enabled, false);
  }
  // A consent that named another model than the server's is not this one: the
  // server moved between the page's last look and the click.
  const session = { token: "a".repeat(43), expiresAt: Date.now() + 60_000, serverUrl: "http://127.0.0.1:9" };
  const f = await fixture(t, { synthesizer: confirmedSynthesizer({ current: async () => ({ model: "GLM-5.3" }) }, model => ({ binding: async () => sessionBinding(session, model), generate: () => assert.fail("no call") })) });
  await assert.rejects(f.wiki.enableSynthesis({ model: "MiniMax-M3" }), /服务端所用模型已变化/); assert.equal(f.wiki.status().synthesis.enabled, false);
  assert.equal((await f.wiki.enableSynthesis({ model: "GLM-5.3" })).synthesis.model, "GLM-5.3");
});

test("the call is made for the model agreed to, whatever /healthz says between the reservation and the call", async (t) => {
  // The server is confirmed twice (consent, then the check before the
  // reservation) and then goes quiet, as after a refusal elsewhere had it asked
  // again. The agreed call still goes out and completes, where asking again for
  // the call would have failed the page for good with nothing sent.
  const session = { token: "a".repeat(43), expiresAt: Date.now() + 60_000, serverUrl: "http://127.0.0.1:9" };
  const answers = (...values) => ({ current: async () => values.length > 1 ? values.shift() : values[0] });
  const made = [], stub = model => ({ binding: async () => sessionBinding(session, model),
    generate: async (page) => { made.push(model); return { facts: [{ text: "下周交付采购报告。", evidence: [{ chunkId: page.chunks[0].id, quote: "下周交付采购报告。" }] }] }; } });
  const quiet = await fixture(t, { synthesizer: confirmedSynthesizer(answers({ model: "MiniMax-M3" }, { model: "MiniMax-M3" }, { unreachable: true }), stub) });
  await quiet.wiki.enableSynthesis(); await quiet.wiki.observe(quiet.doc());
  const page = (await storedPages(quiet.cipher, quiet.filename))[0];
  assert.deepEqual(made, ["MiniMax-M3"]); assert.equal(page.synthesis.state, "complete"); assert.equal(page.synthesis.model, "MiniMax-M3");
  // The server moved to GLM-5.3 in that gap: the product gateway refuses the
  // agreed MiniMax-M3 before its upstream, and the reservation is given back.
  const sessions = new SessionRegistry(), issued = sessions.issue({ tenantId: "tenant-a", userId: "alice", deviceId: "device" });
  let upstream = 0;
  const server = createModelGateway({ sessions, apiKey: "synthetic-key-fixture", provider: "litellm", upstreamOrigin: "http://127.0.0.1:4000", model: "GLM-5.3", upstreamModel: "volc-coding",
    fetchImpl: async () => { upstream++; throw new Error("no upstream call"); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.close(); server.closeAllConnections(); });
  const live = { token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` }, asked = [];
  const moved = await fixture(t, { synthesizer: confirmedSynthesizer(answers({ model: "MiniMax-M3" }, { model: "MiniMax-M3" }, { model: "GLM-5.3" }),
    model => { asked.push(model); return new GatewayWikiSynthesizer({ getSession: async () => live, model }); }) });
  await moved.wiki.enableSynthesis(); await moved.wiki.observe(moved.doc());
  assert.deepEqual(asked, ["MiniMax-M3", "MiniMax-M3", "MiniMax-M3"]); assert.equal(upstream, 0);
  assert.equal((await storedPages(moved.cipher, moved.filename))[0].synthesis, undefined, "released, not failed");
  assert.equal(moved.wiki.status().synthesis.remaining, 6); assert.equal(moved.wiki.status().synthesis.enabled, false);
});
