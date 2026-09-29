// Isolated confirmation fixture: real TaskService/main/renderer behavior with a
// deterministic upstream that asks before it runs. It never accepts a write or
// reaches Feishu/model services.
import "../../src/adopt-legacy-env.js";
import { safeStorage } from "electron";
import { EventEmitter } from "node:events";
import { TaskService } from "../../src/application/task-service.js";
import { fixtureCipher } from "./wiki-cipher.js";

const cipher = fixtureCipher(Buffer.alloc(32, 57));
safeStorage.isEncryptionAvailable = cipher.available;
safeStorage.encryptString = cipher.encrypt;
safeStorage.decryptString = cipher.decrypt;

const COMMAND = `/bin/zsh -c 'node "/Applications/i豆.app/Contents/Resources/agent.js" doc-create --content-file "/tmp/report.md"'`;
const state = globalThis.confirmationFixture = { requests: [], responses: [], records: new Map(), service: null };
const init = TaskService.prototype.init;
TaskService.prototype.init = async function() {
  await init.call(this); state.service = this;
  state.repaint = () => this.changed();
  state.showStep = (taskId) => {
    const record = [...state.records.values()].findLast((row) => row.taskId === taskId && !row.finished);
    if (!record || record.stepShown) return false;
    record.stepShown = true;
    record.client.emit("notification", { method: "item/started", params: { threadId: record.threadId,
      item: { type: "commandExecution", id: record.itemId, status: "inProgress", command: COMMAND } } });
    return true;
  };
  this.runtimeFactory = async (task) => {
    const client = new EventEmitter(); client.start = async () => {};
    client.stop = async () => { for (const record of state.records.values()) if (record.client === client) record.finished = true; };
    client.respondError = () => {};
    client.respond = (requestId, result) => {
      state.responses.push({ requestId, result });
      const record = state.records.get(requestId);
      if (!record || record.finished) return;
      record.finished = true;
      if (result?.decision === "decline") {
        client.emit("notification", { method: "item/completed", params: { threadId: record.threadId,
          item: { type: "commandExecution", id: record.itemId, status: "declined", command: COMMAND } } });
        client.emit("notification", { method: "turn/completed", params: { threadId: record.threadId,
          turn: { id: record.turnId, status: "completed", items: [{ type: "agentMessage", id: `answer-${requestId}`, text: "已按你的选择取消，没有执行写入。" }] } } });
      }
    };
    client.request = async (method, params) => {
      if (method === "initialize") return {};
      if (["thread/start", "thread/resume"].includes(method)) return { thread: { id: `thread-${task.id}` } };
      if (method === "turn/start") {
        const requestId = 8000 + state.requests.length, itemId = "write-report", turnId = `turn-${requestId}`, threadId = `thread-${task.id}`;
        const text = params.input?.[0]?.text ?? "", record = { requestId, taskId: task.id, client, itemId, turnId, threadId, withdrawn: text.includes("后端撤销"), stepShown: false, finished: false };
        state.requests.push({ requestId, taskId: task.id, text }); state.records.set(requestId, record);
        setTimeout(() => {
          client.emit("serverRequest", { id: requestId, method: "item/commandExecution/requestApproval", params: {
            threadId, turnId, itemId, command: COMMAND, cwd: task.cwd, reason: "需要创建飞书文档", startedAtMs: Date.now(),
          } });
          if (!record.withdrawn) return;
          state.showStep(task.id);
          setTimeout(() => {
            client.emit("notification", { method: "serverRequest/resolved", params: { threadId, requestId } });
            record.finished = true;
            client.emit("notification", { method: "turn/completed", params: { threadId,
              turn: { id: turnId, status: "completed", items: [{ type: "agentMessage", id: `answer-${requestId}`, text: "发起方撤销了这次操作，没有执行写入。" }] } } });
          }, 350);
        }, 300);
        return { turn: { id: turnId } };
      }
      throw new Error(`Unexpected fixture method ${method}`);
    };
    return { client, params: {} };
  };
};

await import("../../src/desktop/main.js");
