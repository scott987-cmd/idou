// Test-only U08 fixture: real task folders and renderer/main IPC, with the OS
// file handlers intercepted so the smoke never launches another application.
import "../../src/adopt-legacy-env.js";
import { safeStorage, shell } from "electron";
import { EventEmitter } from "node:events";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskService } from "../../src/application/task-service.js";
import { fixtureCipher } from "./wiki-cipher.js";

const cipher = fixtureCipher(Buffer.alloc(32, 53));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
const root = process.env.IDOU_FILE_PREVIEW_WORKSPACE;
if (!root || !path.isAbsolute(root)) throw new Error("IDOU_FILE_PREVIEW_WORKSPACE is required");
const one = path.join(root, "one"), two = path.join(root, "two"); await mkdir(one, { recursive: true }); await mkdir(two, { recursive: true });
await writeFile(path.join(one, "notes.txt"), "第一行\n第二行\n第三行\n");
await writeFile(path.join(one, "picture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==", "base64"));
await writeFile(path.join(one, "report.docx"), Buffer.from("fixture office\0"));
await writeFile(path.join(one, "report.docx.读取版.md"), "<!-- 由 report.docx 自动转换，供 Agent 阅读；请以原文件为准 -->\n\n报告文字版\n");
await writeFile(path.join(one, "index.html"), "<!doctype html><title>首页成果</title><h1>首页</h1><a href='next.html'>下一页</a>");
await writeFile(path.join(one, "next.html"), "<!doctype html><title>第二页成果</title><h1>第二页</h1><a href='index.html'>返回</a>");
await writeFile(path.join(two, "other.html"), "<!doctype html><title>另一个任务</title><h1>OTHER_TASK</h1>");

const state = globalThis.filePreviewFixture = { opened: [], revealed: [], inputs: [], oneTask: null, twoTask: null, removeNotes: () => unlink(path.join(one, "notes.txt")) };
shell.openPath = async value => { state.opened.push(value); return ""; };
shell.showItemInFolder = value => { state.revealed.push(value); };
const init = TaskService.prototype.init;
TaskService.prototype.init = async function() {
  await init.call(this);
  const first = await this.create({ mode: "coding", cwd: one, permission: "standard" });
  const second = await this.create({ mode: "coding", cwd: two, permission: "standard" });
  for (const [task, title] of [[this.get(first.id), "文件与预览验收"], [this.get(second.id), "另一个编程任务"]]) {
    Object.assign(task, { title, stage: "executing", planningKind: null, planningAfterSeq: 0, permission: "standard", executionPermission: "standard", status: "completed", codexThreadId: `${task.id}-thread` });
    task.messages = [{ id: `${task.id}-question`, role: "user", text: "检查这个任务的成果", seq: 1, createdAt: Date.now() - 1000, turn: { startedAt: Date.now() - 1000, finishedAt: Date.now(), status: "completed" } },
      { id: `${task.id}-answer`, role: "assistant", text: "成果已准备好。", seq: 2, createdAt: Date.now() }]; task.seq = 2;
    await this.store.save(task);
  }
  state.oneTask = first.id; state.twoTask = second.id;
  state.refresh = () => this.changed();
  this.runtimeFactory = async task => {
    const client = new EventEmitter(); client.start = client.stop = async () => {}; client.respond = () => {}; client.respondError = () => {};
    client.request = async (method, params) => {
      if (method === "initialize") return {};
      if (method === "thread/resume" || method === "thread/start") return { thread: { id: `${task.id}-thread` } };
      if (method === "turn/start") {
        state.inputs.push({ taskId: task.id, text: params.input[0].text });
        queueMicrotask(() => client.emit("notification", { method: "turn/completed", params: { threadId: `${task.id}-thread`, turn: { id: `turn-${state.inputs.length}`, status: "completed", items: [{ type: "agentMessage", id: `answer-${state.inputs.length}`, text: "页面意见已收到。" }] } } }));
        return { turn: { id: `turn-${state.inputs.length}` } };
      }
      throw new Error(`Unexpected fixture method ${method}`);
    };
    return { client, params: {} };
  };
};
await import("../../src/desktop/main.js");
