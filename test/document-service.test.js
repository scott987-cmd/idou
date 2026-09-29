import test from "node:test";
import assert from "node:assert/strict";
import { DocumentService } from "../src/application/document-service.js";
import { contextualPrompt } from "../src/application/task-context.js";

const makeDocument = () => ({ kind: "feishu-document", providerId: "saas-cli", resourceId: "doc-1", sourceUrl: "https://test.feishu.cn/docx/DocumentToken123", sourceRevision: "3", contentHash: "hash", title: "测试文档", text: "第一行\n第二行", partial: false, warnings: [], identity: { principal: "account-a", tenantKey: "tenant-1", verifiedAt: 123 } });
function setup() {
  let document = makeDocument(), clock = 0, failure = null, reads = 0;
  const service = new DocumentService({ provider: { readDocument: async () => { reads++; if (failure) throw failure; return structuredClone(document); } }, getTask: (id) => { if (!['task-1', 'task-2'].includes(id)) throw new Error("Unknown task"); }, now: () => clock });
  return { service, reads: () => reads, update: (changes) => { document = { ...document, ...changes }; }, expire: () => { clock = 600001; }, deny: () => { failure = new Error("没有访问权限"); } };
}

test("document references are task-bound, reauthorized and reconstructed from source", async () => {
  const { service, reads } = setup();
  const opened = await service.open("task-1", "link"); assert.equal(opened.identity, undefined);
  await assert.rejects(service.prepareContext("task-2", { handle: opened.handle }), /失效/);
  const context = await service.prepareContext("task-1", { handle: opened.handle, selection: { start: 4, end: 7 }, text: "forged" });
  assert.equal(context.text, "第二行"); assert.equal(context.selection.startLine, 2); assert.equal(context.partial, true);
  assert.equal(context.tenantKey, "tenant-1"); assert.equal(reads(), 2);
  const prompt = contextualPrompt("解释这一段", context); assert.match(prompt, /第二行/); assert.doesNotMatch(prompt, /forged/); assert.match(prompt, /do not write/);
});

test("revision, content, wiki target and identity changes invalidate instead of sending old text", async () => {
  for (const update of [{ sourceRevision: "4" }, { contentHash: "changed" }, { resourceId: "different-target" }, { identity: { principal: "account-b" } }]) {
    const fixture = setup(), { service } = fixture; const events = []; service.on("invalidated", (event) => events.push(event));
    const opened = await service.open("task-1", "link"); fixture.update(update);
    await assert.rejects(service.prepareContext("task-1", { handle: opened.handle }), /已变化/);
    assert.equal(service.opened.size, 0); assert.equal(events.at(-1).handle, opened.handle);
  }
});

test("permission failure and expiry discard visible snapshot; no cached authorization fallback", async () => {
  for (const action of ["deny", "expire"]) {
    const fixture = setup(); const doc = await fixture.service.open("task-1", "link"); fixture[action]();
    await assert.rejects(fixture.service.prepareContext("task-1", { handle: doc.handle }));
    assert.equal(fixture.service.opened.size, 0);
  }
});

test("closing during a pending read prevents stale document resurrection", async () => {
  const pending = Promise.withResolvers(); const service = new DocumentService({ provider: { readDocument: () => pending.promise }, getTask: () => {} });
  const opening = service.open("task-1", "link"); service.close("task-1"); pending.resolve(makeDocument());
  await assert.rejects(opening, /已切换/); assert.equal(service.opened.size, 0);
});

test("long documents require explicit bounded selection instead of silent truncation", async () => {
  const fixture = setup(); fixture.update({ text: "x".repeat(24001) });
  const doc = await fixture.service.open("task-1", "link");
  await assert.rejects(fixture.service.prepareContext("task-1", { handle: doc.handle }), /文档较长/);
  await assert.rejects(fixture.service.prepareContext("task-1", { handle: doc.handle, selection: { start: 0, end: 9000 } }), /8000/);
});
test("edit intent requires a complete source and a bounded inline selection", async () => {
  const f = setup(), doc = await f.service.open("task-1", "link");
  await assert.rejects(f.service.prepareContext("task-1", { handle: doc.handle, intent: "propose-edit" }), /选择不跨行/);
  await assert.rejects(f.service.prepareContext("task-1", { handle: doc.handle, intent: "propose-edit", selection: { start: 0, end: 7 } }), /选择不跨行/);
  const context = await f.service.prepareContext("task-1", { handle: doc.handle, intent: "propose-edit", selection: { start: 0, end: 3 } }); assert.equal(context.intent, "propose-edit");
  f.update({ partial: true }); const partial = await f.service.open("task-1", "link#anchor");
  await assert.rejects(f.service.prepareContext("task-1", { handle: partial.handle, intent: "propose-edit", selection: { start: 0, end: 3 } }), /完整文档/);
});
