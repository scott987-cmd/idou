import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { SaasFeishuCliProvider } from "../src/providers/feishu/saas-cli-provider.js";
import { inlineReplacement } from "../src/providers/feishu/document-edits.js";
import { DocumentService } from "../src/application/document-service.js";
import { DocumentEdits, editProposal } from "../src/application/document-edit.js";

const url = "https://test.feishu.cn/docx/SyntheticDocument123", pattern = "原来的计划", replacement = "新的计划 & <说明>";
async function fixture() {
  const state = { xml: '<title>合成文档</title><p><b>原来的计划</b>，不改其他文字。</p><img token="keep"/>', revision: 1, writes: 0, calls: [], saved: [], user: "alice" };
  const provider = new SaasFeishuCliProvider();
  provider.invoke = async (args, options) => {
    state.calls.push(args);
    if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.user, tenantKey: "tenant", tokenStatus: "valid" } } }) };
    if (state.denied) return { code: 1, stderr: JSON.stringify({ error: { type: "authorization" } }) };
    const ok = data => ({ code: 0, stdout: JSON.stringify({ ok: true, identity: "user", data }) });
    if (args[1] === "+fetch") return ok({ document: { document_id: "SyntheticDocument123", revision_id: state.revision, content: args.includes("full") && state.alteredFull ? state.xml.replace("<p>", '<p align="right">') : state.xml } });
    assert.deepEqual(args, ["docs", "+update", "--doc", "SyntheticDocument123", "--command", "str_replace", "--pattern", pattern, "--content", "@replacement.xml", "--revision-id", "1", "--doc-format", "xml", "--as", "user", "--format", "json"]);
    assert.equal(state.saved.at(-1).messages[1].documentEdit.state, "dispatching"); state.writes++; state.directory = options.cwd;
    const content = await readFile(path.join(options.cwd, "replacement.xml"), "utf8"); assert.equal(content, "新的计划 &amp; &lt;说明&gt;");
    state.xml = state.xml.replace(pattern, content); state.revision++;
    if (state.lost) throw new Error("synthetic lost acknowledgment with protected data");
    if (state.extraChange) state.xml += "<p>并发修改</p>";
    const receipt = { result: state.partial ? "partial_success" : "success", updated_blocks_count: 1, warnings: [], document: { revision_id: state.revision } };
    return ok(state.receipt ? state.receipt(receipt) : receipt);
  };
  const task = { id: "task", status: "completed", messages: [] }, getTask = id => { assert.equal(id, task.id); return task; };
  const documents = new DocumentService({ provider, getTask }), opened = await documents.open(task.id, url);
  const start = opened.text.indexOf(pattern), context = await documents.prepareContext(task.id, { handle: opened.handle, selection: { start, end: start + pattern.length }, intent: "propose-edit" });
  task.messages = [{ role: "user", text: "修改计划", context }, { id: "answer", role: "assistant", text: JSON.stringify({ kind: "feishu-text-edit", replacement }) }];
  const edits = new DocumentEdits({ documents, getTask, provider: provider.documentEdits, businessAccess: () => { if (state.blocked) throw new Error("identity unlinked"); }, saveTask: async task => { if (state.saveFailed) throw new Error("task disk failure"); state.saved.push(structuredClone(task)); } });
  return { state, provider, documents, edits, task, prepare: () => edits.prepare(task.id, "answer") };
}
test("reviewed inline edit writes once at the captured revision and verifies fresh content without replacing other resources", async () => {
  const f = await fixture(), draft = await f.prepare(); assert.equal(f.state.writes, 0); assert.equal(draft.pattern, pattern); assert.equal(draft.replacement, replacement);
  const result = await f.edits.apply(draft); assert.equal(result.verified, true); assert.equal(result.revision, "2"); assert.equal(f.state.writes, 1);
  assert.match(f.state.xml, /<b>新的计划 &amp; &lt;说明&gt;<\/b>，不改其他文字/); assert.match(f.state.xml, /<img token="keep"\/>/);
  assert.equal(f.documents.opened.size, 0); assert.equal(f.edits.active.size, 0); await assert.rejects(access(f.state.directory), { code: "ENOENT" });
  assert.equal(f.state.saved.at(-1).messages[1].documentEdit.state, "verified");
  await assert.rejects(f.edits.apply(draft), /已使用/); assert.equal(f.state.writes, 1);
});
// The pinned lark-cli returns {result, warnings, document:{revision_id, url}} and
// no changed-block count. Requiring that count made every real write report an
// unconfirmed result, so a receipt without it must succeed on its read-back.
test("the pinned CLI receipt shape is accepted, and a wrong count or a foreign document is not", async () => {
  const real = await fixture(), realDraft = await real.prepare();
  real.state.receipt = receipt => ({ result: receipt.result, warnings: receipt.warnings, document: { revision_id: receipt.document.revision_id, url } });
  const result = await real.edits.apply(realDraft);
  assert.equal(result.verified, true); assert.equal(result.revision, "2"); assert.equal(real.state.writes, 1);

  for (const receipt of [
    value => ({ ...value, updated_blocks_count: 2 }),
    value => ({ ...value, document: { ...value.document, url: "https://test.feishu.cn/docx/AnotherDocument999" } }),
    value => ({ ...value, document: { ...value.document, url: "not a link" } }),
  ]) {
    const f = await fixture(), draft = await f.prepare(); f.state.receipt = receipt;
    await assert.rejects(f.edits.apply(draft), /可能已修改或部分修改/);
    assert.equal(f.state.writes, 1); assert.equal(f.documents.opened.size, 0);
  }
});
test("cancellation, invalid message, forged confirmation and changed reader never dispatch a write", async () => {
  const f = await fixture(), draft = await f.prepare(); assert.equal(f.state.writes, 0);
  await assert.rejects(f.edits.apply({ ...draft }), /失效/); await assert.rejects(f.edits.prepare("task", "untrusted-renderer-answer"));
  f.documents.close("task"); await assert.rejects(f.edits.apply(draft), /失效/); assert.equal(f.state.writes, 0);
});
test("revision, identity, full structure, authorization and task activity changes deny a previously prepared write", async () => {
  for (const change of [f => f.state.revision++, f => { f.state.user = "bob"; }, f => { f.state.alteredFull = true; }, f => { f.state.denied = true; }, f => { f.state.blocked = true; }, f => { f.task.status = "running"; }]) {
    const f = await fixture(), draft = await f.prepare(); change(f); await assert.rejects(f.edits.apply(draft)); assert.equal(f.state.writes, 0);
  }
});
test("lost acknowledgment, partial success and concurrent post-write changes stay unknown, invalidate the reader and never retry", async () => {
  for (const mode of ["lost", "partial", "extraChange"]) {
    const f = await fixture(), draft = await f.prepare(); f.state[mode] = true;
    await assert.rejects(f.edits.apply(draft), /可能已修改或部分修改/); assert.equal(f.state.writes, 1); assert.equal(f.documents.opened.size, 0);
    await assert.rejects(f.edits.apply(draft)); assert.equal(f.state.writes, 1); await assert.rejects(access(f.state.directory), { code: "ENOENT" });
    const restored = f.state.saved.at(-1); assert.equal(restored.messages[1].documentEdit.state, "unknown");
    const restarted = new DocumentEdits({ documents: f.documents, getTask: () => restored, provider: f.provider.documentEdits });
    await assert.rejects(restarted.prepare("task", "answer"), /已有写入记录/);
  }
});
test("proposal parser and XML matcher reject ambiguous, cross-structure, resource and executable substitutions", () => {
  assert.equal(editProposal('{"kind":"feishu-text-edit","replacement":""}'), "");
  for (const value of ['{"kind":"feishu-text-edit","replacement":"x","url":"forged"}', '{"kind":"feishu-text-edit","replacement":"x\\ny"}', "not JSON"]) assert.throws(() => editProposal(value));
  for (const xml of ['<p>old old</p>', '<p>o<b>ld</b></p>', '<p><cite type="user">old</cite></p>', '<script>old</script>', '<title>old</title>', '<!DOCTYPE p><p>old</p>']) assert.throws(() => inlineReplacement(xml, "old", "new"));
  assert.equal(inlineReplacement('<p><b>old</b></p>', "old", '<cite user-id="fake">'), '&lt;cite user-id="fake"&gt;');
  assert.throws(() => inlineReplacement('<p>old</p>', "old", "old"));
});
test("parallel confirmations for the same task cannot dispatch twice", async () => {
  const f = await fixture(), first = await f.prepare(), second = await f.prepare(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const apply = f.provider.documentEdits.apply.bind(f.provider.documentEdits);
  f.provider.documentEdits.apply = async (...args) => { entered.resolve(); await release.promise; return apply(...args); };
  const running = f.edits.apply(first); await entered.promise;
  await assert.rejects(f.edits.apply(second), /正在执行/); release.resolve(); await running; assert.equal(f.state.writes, 1); assert.equal(f.edits.active.size, 0);
});
test("failure to persist a write intent prevents any external mutation", async () => {
  const f = await fixture(), draft = await f.prepare(); f.state.saveFailed = true;
  await assert.rejects(f.edits.apply(draft), /task disk failure/); assert.equal(f.state.writes, 0); assert.equal(f.documents.opened.size, 0);
  await assert.rejects(f.prepare(), /已有写入记录/);
});
