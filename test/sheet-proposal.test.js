import test from "node:test";
import assert from "node:assert/strict";
import { sheetEditProposal } from "../src/application/sheet-proposal.js";
import { DocumentProposalModel } from "../src/application/document-proposal-model.js";
import { contextualPrompt } from "../src/application/task-context.js";

const context = () => ({ kind: "feishu-sheet", intent: "propose-edit", range: "B2:F3", truncated: false, rows: [
  { row: 2, cells: [{ address: "B2", value: "00123" }, { address: "C2", value: 1200.5 }, { address: "D2", value: "=C2*2" }, { address: "E2", value: "complex", unsupported: true }, { address: "F2", value: null }] },
  { row: 3, cells: [{ address: "B3", value: false }] },
] });
const proposal = changes => JSON.stringify({ kind: "feishu-sheet-edit", changes });
test("sheet proposals retain addressed scalar types and remain inert bounded data", () => {
  const changes = [{ address: "B2", value: "00456" }, { address: "C2", value: 1500 }, { address: "B3", value: true }, { address: "F2", value: "<img src=x onerror=alert(1)>" }];
  assert.deepEqual(sheetEditProposal(proposal(changes), context()), { kind: "feishu-sheet-edit", changes });
  assert.match(contextualPrompt("修改", context()), /Do not use tools or write to Feishu/);
  assert.match(contextualPrompt("修改", context()), /Do not turn calculations into hardcoded values/);
});
test("sheet proposals reject outside cells, formulas, complex originals, duplicates and unsafe types", () => {
  for (const changes of [[], [{ address: "A1", value: "x" }], [{ address: "B2", value: "00123" }], [{ address: "B2", value: null }], [{ address: "B2", value: {} }], [{ address: "C2", value: 9007199254740992 }], [{ address: "B2", value: " =SUM(C2:C3)" }], [{ address: "D2", value: 1 }], [{ address: "E2", value: "x" }], [{ address: "B2", value: "x", command: "write" }], [{ address: "B2", value: "x" }, { address: "B2", value: "y" }], [{ address: "B2", value: "x".repeat(2001) }], [{ address: "B2", value: "\u0000" }]]) assert.throws(() => sheetEditProposal(proposal(changes), context()), /表格建议无效/);
  for (const value of ["not JSON", "null", "[]", JSON.stringify({ kind: "feishu-sheet-edit", changes: [], sourceUrl: "forged" }), "x".repeat(16001)]) assert.throws(() => sheetEditProposal(value, context()));
  for (const patch of [{ intent: undefined }, { kind: "feishu-document" }, { truncated: true }]) assert.throws(() => sheetEditProposal(proposal([{ address: "B2", value: "x" }]), { ...context(), ...patch }));
});
test("sheet change count is capped independently of the read range", () => {
  const cells = Array.from({ length: 21 }, (_, i) => ({ address: `B${i + 1}`, value: 1 })), changes = cells.map(cell => ({ ...cell, value: 2 }));
  const snapshot = { ...context(), rows: [{ row: 1, cells }] };
  assert.equal(sheetEditProposal(proposal(changes.slice(0, 20)), snapshot).changes.length, 20);
  assert.throws(() => sheetEditProposal(proposal(changes), snapshot));
});
test("MiniMax proposal gateway has no tools and validates output against native sheet context", async () => {
  let calls = 0, text = proposal([{ address: "B2", value: "00456" }]);
  const model = new DocumentProposalModel({ getSession: async () => ({ token: "synthetic", serverUrl: "http://127.0.0.1:1", expiresAt: Date.now() + 60000 }), fetchImpl: async (_url, init) => {
    calls++; const body = JSON.parse(init.body); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 3000);
    return Response.json({ status: "completed", model: "MiniMax-M3", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] });
  } });
  assert.equal(JSON.parse(await model.generate("prompt", undefined, context())).changes[0].value, "00456");
  text = proposal([{ address: "Z9", value: "outside" }]); await assert.rejects(model.generate("prompt", undefined, context()), /不会自动重试/); assert.equal(calls, 2);
  text = '{"kind":"feishu-text-edit","replacement":"wrong contract"}'; await assert.rejects(model.generate("prompt", undefined, context()));
});
// Same request, but GLM's budget: it reasons inside max_output_tokens.
test("GLM proposal gateway keeps the same tool-free request and native sheet validation", async () => {
  let calls = 0, answered = "GLM-5.3";
  const model = new DocumentProposalModel({ model: "GLM-5.3", getSession: async () => ({ token: "synthetic", serverUrl: "http://127.0.0.1:1", expiresAt: Date.now() + 60000 }), fetchImpl: async (_url, init) => {
    calls++; const body = JSON.parse(init.body); assert.equal(body.model, "GLM-5.3"); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false); assert.equal(body.max_output_tokens, 8192);
    return Response.json({ status: "completed", model: answered, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: proposal([{ address: "C2", value: 1500 }]) }] }] });
  } });
  assert.deepEqual(JSON.parse(await model.generate("prompt", undefined, context())).changes, [{ address: "C2", value: 1500 }]);
  answered = "MiniMax-M3"; await assert.rejects(model.generate("prompt", undefined, context()), /不会自动重试/); assert.equal(calls, 2);
});
