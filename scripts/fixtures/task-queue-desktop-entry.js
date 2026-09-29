// Isolated next-turn queue fixture. It runs the production main process,
// renderer, IPC, TaskService and durable queue, but never starts Codex or calls
// a model/Feishu service.
import "../../src/adopt-legacy-env.js";
import { safeStorage } from "electron";
import { EventEmitter } from "node:events";
import { TaskService } from "../../src/application/task-service.js";
import { fixtureCipher } from "./wiki-cipher.js";

const cipher = fixtureCipher(Buffer.alloc(32, 67));
safeStorage.isEncryptionAvailable = cipher.available;
safeStorage.encryptString = cipher.encrypt;
safeStorage.decryptString = cipher.decrypt;

const state = globalThis.taskQueueFixture = { turns: [], interrupted: [] };
const init = TaskService.prototype.init;
TaskService.prototype.init = async function() {
  await init.call(this);
  this.runtimeFactory = async (task) => {
    const client = new EventEmitter();
    client.start = client.stop = async () => {};
    client.respond = client.respondError = () => {};
    client.request = async (method, params) => {
      if (method === "initialize") return {};
      if (["thread/start", "thread/resume"].includes(method)) return { thread: { id: `queue-thread-${task.id}` } };
      if (method === "turn/interrupt") { state.interrupted.push(params.turnId); return {}; }
      if (method === "turn/start") {
        const id = `queue-turn-${state.turns.length + 1}`, text = params.input?.[0]?.text ?? "";
        state.turns.push({ id, text });
        if (state.turns.length > 1) setTimeout(() => client.emit("notification", { method: "turn/completed", params: {
          threadId: `queue-thread-${task.id}`, turn: { id, status: "completed", items: [{ type: "agentMessage", id: `answer-${id}`, text: `已执行：${text}` }] },
        } }), 120);
        return { turn: { id } };
      }
      throw new Error(`Unexpected fixture method ${method}`);
    };
    return { client, params: {} };
  };
};

await import("../../src/desktop/main.js");
