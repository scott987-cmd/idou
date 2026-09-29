import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { ChatReader } from "../src/application/chat-reader.js";
import { MessageDiscovery, DISCOVERY_LIMITS } from "../src/knowledge/message-discovery.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { fixtureCipher } from "../scripts/fixtures/wiki-cipher.js";
import { storedPages, storedBytes } from "../scripts/fixtures/wiki-store.js";
import { chatFixture, chatResponse, chatDocumentUrl } from "../scripts/fixtures/chat-data.js";
import { STUB_CLI } from "./helpers/stub-cli.js";

async function setup(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "discovery-test-"));
  const state = { ...chatFixture(), now: Date.now(), docReads: 0, version: 1, models: 0, timers: [] };
  const provider = new SaasFeishuCliProvider({ binary: STUB_CLI }, async (binary, args, options) => {
    assert.equal(binary, STUB_CLI); options.signal?.throwIfAborted();
    if (state.before) await state.before(args, options);
    if (args[0] !== "docs") return chatResponse(state, args);
    state.calls.push(args); state.docReads++;
    assert.equal(args[1], "+fetch"); assert.equal(args.includes("--yes"), false);
    if (state.docGate) await state.docGate(options);
    if (state.documentDenied) return { code: 1, stdout: "", stderr: '{"error":{"type":"authorization"}}' };
    return { code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data: { document: {
      document_id: new URL(args[args.indexOf("--doc") + 1]).pathname.split("/").at(-1), revision_id: state.version,
      content: `<title>自动发现合成来源</title><p>文档版本 ${state.version}。验收只面向采购组。</p>${state.partial ? '<fragment mode="range"><p>片段</p></fragment>' : ""}` } } }) };
  });
  const cipher = fixtureCipher(), filename = path.join(directory, "wiki.enc");
  const wiki = new LocalWiki({ filename, provider, cipher, synthesizer: {
    binding: async () => ({ serverUrl: "https://synthetic.test", sessionHash: "synthetic", expiresAt: Date.now() + 3600_000 }),
    generate: async (page, options) => {
      state.models++; if (state.modelGate) await state.modelGate(options);
      return { facts: [{ text: "验收面向采购组。", evidence: [{ chunkId: page.chunks[0].id, quote: "验收只面向采购组。" }] }] };
    } }, now: () => state.now });
  const businessAccess = () => { if (state.blocked) throw new Error("unlinked identity"); };
  const reader = new ChatReader({ provider: provider.chatReader, businessAccess, now: () => state.now });
  const discovery = new MessageDiscovery({ provider, wiki, reader, businessAccess, now: () => state.now, timers: {
    set(fn, delay) { const timer = { fn, delay }; state.timers.push(timer); return timer; }, clear(timer) { if (timer) timer.canceled = true; },
  } });
  const select = async (index = 0) => { const list = await reader.list(); await reader.read(list.chats[index].handle); return list.chats[index].handle; };
  const start = async () => discovery.add(await select(), async () => true);
  const scheduled = async () => { const timer = state.timers.findLast(timer => !timer.canceled); assert.ok(timer); state.now += timer.delay; timer.canceled = true; timer.fn(); await discovery.pending; };
  t.after(async () => { await discovery.close(); reader.close(); await wiki.close(); await rm(directory, { recursive: true, force: true }); });
  return { state, provider, wiki, cipher, filename, reader, discovery, select, start, scheduled };
}

test("confirmed chat scope automatically discovers, refreshes and encrypts source-only Wiki without a task or document click", async t => {
  const f = await setup(t); await f.start(); assert.equal(f.state.docReads, 0);
  f.reader.close(); await f.scheduled();
  assert.equal(f.discovery.status().enabled, true); assert.equal(f.discovery.status().last.retained, 1);
  const first = await f.wiki.search("版本 1"); assert.equal(first.hits.length, 1); assert.equal(first.hits[0].sourceUrl, chatDocumentUrl);
  assert.equal((await f.wiki.search("请核对这份交付计划")).hits.length, 0); assert.equal(f.state.models, 0);
  // 明文不能出现在副本目录下的任何一个文件里；聊天正文本来就不入库。
  assert.equal((await storedBytes(f.filename)).includes(Buffer.from("采购")), false);
  assert.doesNotMatch(JSON.stringify(await storedPages(f.cipher, f.filename)), /ou_chen|RECALLED_SECRET|请核对这份交付计划/);
  f.state.version = 2; await f.scheduled();
  assert.equal((await storedPages(f.cipher, f.filename))[0].revision, "2");
  const calls = f.state.calls.filter(args => args.includes("--start")); assert.ok(calls.length >= 2);
  for (const args of calls) assert.equal(Date.parse(args[args.indexOf("--end") + 1]) - Date.parse(args[args.indexOf("--start") + 1]), DISCOVERY_LIMITS.lookbackMs);
  const mget = f.state.calls.filter(args => args[1] === "+messages-mget"); assert.equal(mget.length, 4, "each cycle revalidates message both before and after document read");
});
test("canceled, forged and confirmation-time changed selections never enable background reads", async t => {
  const f = await setup(t), handle = await f.select();
  assert.equal(await f.discovery.add(handle, async () => false), null);
  await assert.rejects(f.discovery.add("oc_delivery", async () => true), /请先读取/);
  await assert.rejects(f.discovery.add(handle, async () => { f.reader.close(); return true; }), /会话已失效/);
  assert.equal(f.discovery.status().enabled, false); assert.equal(f.state.docReads, 0); assert.equal(f.state.timers.length, 0);
});
test("revoked or edited message after document fetch cannot enqueue that source", async t => {
  for (const kind of ["recalled", "linkRemoved"]) {
    const f = await setup(t); await f.start(); f.state.docGate = async () => { if (kind === "recalled") f.state.rows[0].deleted = true; else f.state.rows[0].content = "removed"; };
    await f.scheduled(); assert.equal(f.discovery.status().last.retained, 0); assert.equal(f.state.docReads, 1);
    await assert.rejects(readFile(f.filename), { code: "ENOENT" });
  }
});
test("identity changes and unreadable chat stop scheduling; individual document denial is skipped", async t => {
  const f = await setup(t); await f.start(); f.state.user = "ou_other"; await f.scheduled();
  assert.equal(f.discovery.status().enabled, false); assert.equal(f.state.docReads, 0); assert.equal(f.discovery.status().nextAt, null);
  const g = await setup(t); await g.start(); g.state.denied = true; await g.scheduled(); assert.equal(g.discovery.status().enabled, false);
  const h = await setup(t); await h.start(); h.state.documentDenied = true; await h.scheduled();
  assert.equal(h.discovery.status().enabled, true); assert.equal(h.discovery.status().last.skipped, 1); assert.equal(h.discovery.status().last.retained, 0);
});
test("source reads changing identity cannot be stored under the new or old owner", async t => {
  const f = await setup(t); await f.start(); f.state.docGate = async () => { f.state.user = "ou_changed_during_doc"; };
  await f.scheduled(); assert.equal(f.discovery.status().enabled, false); await assert.rejects(readFile(f.filename), { code: "ENOENT" });
});
test("stop aborts an in-flight read, waits for it, discards late results and invalidates pending admission", async t => {
  const f = await setup(t); await f.start(); const gate = Promise.withResolvers(), started = Promise.withResolvers();
  let captured;
  f.state.docGate = async options => { captured = options.signal; started.resolve(); await gate.promise; };
  const run = f.scheduled(); await started.promise; let stopped = false;
  const stopping = f.discovery.stop().then(() => { stopped = true; });
  assert.equal(captured.aborted, true); assert.equal(stopped, false); gate.resolve(); await run; await stopping;
  assert.equal(f.discovery.status().enabled, false); assert.equal(f.discovery.status().busy, false); await assert.rejects(readFile(f.filename), { code: "ENOENT" });
  const handle = await f.select(); await assert.rejects(f.discovery.add(handle, async () => { await f.discovery.stop(); return true; }), /状态已变化/);
});
test("automatic model synthesis is opt-in and repeated background scans do not rebill a retained revision", async t => {
  const f = await setup(t); await f.wiki.enableSynthesis(); await f.start(); await f.scheduled();
  assert.equal(f.state.models, 1); assert.equal((await f.wiki.search("采购")).hits[0].synthesis.state, "complete");
  await f.scheduled(); assert.equal(f.state.models, 1);
});
test("stopping discovery aborts its active synthesis without clearing the separate synthesis setting", async t => {
  const f = await setup(t), started = Promise.withResolvers(); await f.wiki.enableSynthesis(); await f.start();
  f.state.modelGate = ({ signal }) => new Promise((resolve, reject) => { started.resolve(); signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true }); });
  const running = f.scheduled(); await started.promise; await f.discovery.stop(); await running;
  const page = (await storedPages(f.cipher, f.filename))[0];
  assert.equal(page.synthesis.state, "failed"); assert.equal(f.wiki.status().synthesis.enabled, true);
});
test("anchored/partial sources are never expanded to whole documents or persisted as complete", async t => {
  const f = await setup(t); f.state.rows[0].content = `${chatDocumentUrl}#share-anchor`; await f.start(); await f.scheduled(); assert.equal(f.state.docReads, 0);
  const g = await setup(t); g.state.partial = true; await g.start(); await g.scheduled();
  assert.equal(g.discovery.status().last.retained, 0); await assert.rejects(readFile(g.filename), { code: "ENOENT" });
});
test("bounded batches rotate documents instead of starving all but the first five", async t => {
  const f = await setup(t); f.state.rows[0].content = Array.from({ length: 7 }, (_, i) => `https://test.feishu.cn/docx/SyntheticExtra${i}`).join("\n");
  await f.start(); await f.scheduled(); assert.equal(f.discovery.status().last.attempted, 5); assert.equal(f.discovery.status().last.limited, true);
  await f.scheduled(); assert.equal((await storedPages(f.cipher, f.filename)).length, 7);
});
test("expired permission, missing encryption and unlinked application cannot start or continue", async t => {
  const f = await setup(t); f.state.blocked = true; await assert.rejects(f.discovery.add("any", async () => true), /unlinked/);
  f.state.blocked = false; const handle = await f.select(); f.wiki.cipher.available = () => false;
  await assert.rejects(f.discovery.add(handle, async () => true), /安全加密不可用/);
  f.wiki.cipher.available = () => true; await f.discovery.add(handle, async () => true); f.state.now += DISCOVERY_LIMITS.lifetimeMs;
  const calls = f.state.calls.length; await f.scheduled(); assert.equal(f.state.calls.length, calls); assert.equal(f.discovery.status().enabled, false);
});
test("single-flight background ticks do not dispatch a second scan while the first is held", async t => {
  const f = await setup(t); await f.start(); const gate = Promise.withResolvers(), started = Promise.withResolvers();
  f.state.docGate = async () => { started.resolve(); await gate.promise; };
  const first = f.discovery.tick(); await started.promise; const second = f.discovery.tick(); assert.equal(first, second);
  gate.resolve(); await first; assert.equal(f.state.docReads, 1);
});
test("hard lifetime timer cancels work and adding chats does not extend the original lease", async t => {
  const f = await setup(t); await f.start(); const expiresAt = f.discovery.status().expiresAt;
  const lease = f.state.timers.find(timer => timer.delay === DISCOVERY_LIMITS.lifetimeMs);
  f.state.now += 1000; await f.discovery.add(await f.select(1), async () => true);
  assert.equal(f.discovery.status().expiresAt, expiresAt); assert.equal(f.discovery.status().chats.length, 2);
  lease.fn(); await f.discovery.pending; assert.equal(f.discovery.status().enabled, false);
  assert.equal(f.state.timers.filter(timer => !timer.canceled).length, 0);
});
test("maximum chat scope is enforced and malformed provider time ranges are rejected before dispatch", async t => {
  const f = await setup(t);
  f.state.chats = Array.from({ length: 6 }, (_, index) => ({ chat_id: `oc_scope${index}`, name: `范围 ${index}`, chat_mode: "group", external: false, chat_status: "normal" }));
  for (let i = 0; i < 5; i++) await f.discovery.add(await f.select(i), async () => true);
  await assert.rejects(f.discovery.add(await f.select(5), async () => true), /最多自动整理 5/);
  assert.equal(f.discovery.status().chats.length, 5);
  const count = f.state.calls.length;
  await assert.rejects(f.provider.chatReader.read("oc_scope0", null, {}, { start: "--yes", end: "invalid" }));
  assert.equal(f.state.calls.length, count);
});
test("an observation canceled while waiting in the Wiki queue writes no canceled source", async t => {
  const f = await setup(t), gate = Promise.withResolvers(); f.wiki.queue = gate.promise;
  const doc = await f.provider.readDocument(chatDocumentUrl), controller = new AbortController();
  const observing = f.wiki.observe(doc, { signal: controller.signal }); controller.abort(); gate.resolve();
  assert.equal(await observing, false); await assert.rejects(readFile(f.filename), { code: "ENOENT" });
});
