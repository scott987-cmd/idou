// Test-only native process/model boundaries. Production never imports this file.
import "../../src/adopt-legacy-env.js";
import { safeStorage } from "electron";
import { EventEmitter } from "node:events";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { TaskService } from "../../src/application/task-service.js";
import { DocumentProposalModel } from "../../src/application/document-proposal-model.js";
import { fixtureCipher } from "./wiki-cipher.js";
import { sheetDataFixture } from "./sheet-data.js";
const cipher = fixtureCipher(Buffer.alloc(32, 32));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
const fixture = sheetDataFixture(); globalThis.sheetFixture = fixture.state; fixture.state.turns = [];
fixture.state.proposals = [];
const invoke = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = function(args, options) {
  if (!this.sheetFixtureRunner) {
    const original = this.runner; this.runner = (binary, argv, opts) => argv[0] === "skills" || argv[0] === "--version" ? original(binary, argv, opts) : fixture.run(binary, argv, opts);
    this.sheetFixtureRunner = true;
  }
  return invoke.call(this, args, options);
};
const init = TaskService.prototype.init;
TaskService.prototype.init = async function() {
  await init.call(this);
  const proposalModel = new DocumentProposalModel({ getSession: async () => ({ token: "synthetic-sheet-session", serverUrl: "http://127.0.0.1:1", expiresAt: Date.now() + 60000 }), fetchImpl: async (_url, init) => {
    fixture.state.proposals.push(JSON.parse(init.body));
    if (fixture.state.changeDuringProposal) fixture.state.revision++;
    return Response.json({ status: "completed", model: "MiniMax-M3", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ kind: "feishu-sheet-edit", changes: [{ address: "B2", value: "00456" }, { address: "C2", value: 1500 }] }) }] }] });
  } });
  this.proposalGenerator = (prompt, signal, context) => proposalModel.generate(prompt, signal, context);
  this.runtimeFactory = async () => {
    const client = new EventEmitter(); client.start = client.stop = async () => {};
    client.request = async (method, params) => {
      if (["thread/start", "thread/resume"].includes(method)) return { thread: { id: "sheet-fixture-thread" } };
      if (method === "turn/start") {
        fixture.state.turns.push(params.input[0].text);
        client.emit("notification", { method: "turn/completed", params: { threadId: "sheet-fixture-thread", turn: { id: "fixture-turn", status: "completed", items: [{ type: "agentMessage", id: `answer-${fixture.state.turns.length}`, text: "B2 保留编号 00123；C2 是金额 1200.5。仅分析当前范围，未修改飞书。" }] } } });
        return { turn: { id: "fixture-turn" } };
      }
      throw new Error("Unexpected fixture model method");
    };
    return { client, params: {} };
  };
};
await import("../../src/desktop/main.js");
