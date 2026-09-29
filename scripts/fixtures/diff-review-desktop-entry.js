// Test-only coding review fixture: two historical turns, today's working tree,
// and a no-tools runtime that records the one message the person sends.
import "../../src/adopt-legacy-env.js";
import { safeStorage } from "electron";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskService } from "../../src/application/task-service.js";
import { fixtureCipher } from "./wiki-cipher.js";

const cipher = fixtureCipher(Buffer.alloc(32, 52));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
const root = process.env.IDOU_DIFF_REVIEW_WORKSPACE;
if (!root || !path.isAbsolute(root)) throw new Error("IDOU_DIFF_REVIEW_WORKSPACE is required");
await mkdir(root, { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" } });
git("init", "-q"); await writeFile(path.join(root, "a.js"), "old\n"); git("add", "."); git("commit", "-qm", "base"); await writeFile(path.join(root, "a.js"), "manual later\n");

const first = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+first\n";
const second = "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-first\n+second\n";
const state = globalThis.diffReviewFixture = { inputs: [], taskId: null, change: async () => writeFile(path.join(root, "a.js"), "changed after feedback\n") };
const init = TaskService.prototype.init;
TaskService.prototype.init = async function() {
  await init.call(this);
  const made = await this.create({ mode: "coding", cwd: root, permission: "standard" }), task = this.get(made.id), now = Date.now();
  Object.assign(task, { title: "差异审阅验收", stage: "executing", planningKind: null, planningAfterSeq: 0, permission: "standard", executionPermission: "standard",
    status: "completed", codexThreadId: "diff-review-thread", seq: 6, startedAt: now - 8_000, updatedAt: now });
  task.messages = [
    { id: "turn-one", role: "user", text: "第一轮修改", seq: 1, createdAt: now - 8_000, turn: { startedAt: now - 8_000, finishedAt: now - 7_000, status: "completed", codexTurnId: "codex-one", diff: { files: 1, added: 1, removed: 1 }, diffText: first } },
    { id: "answer-one", role: "assistant", text: "第一轮完成。", seq: 3, createdAt: now - 7_000 },
    { id: "turn-two", role: "user", text: "第二轮修改", seq: 4, createdAt: now - 6_000, turn: { startedAt: now - 6_000, finishedAt: now - 5_000, status: "completed", codexTurnId: "codex-two", diff: { files: 1, added: 1, removed: 1 }, diffText: second } },
    { id: "answer-two", role: "assistant", text: "第二轮完成。", seq: 6, createdAt: now - 5_000 },
  ];
  task.activity = [
    { id: "patch-one", type: "fileChange", status: "completed", seq: 2, changes: [{ path: "a.js", kind: "update", diff: "@@ -1 +1 @@\n-old\n+first" }] },
    { id: "patch-two", type: "fileChange", status: "completed", seq: 5, changes: [{ path: "a.js", kind: "update", diff: "@@ -1 +1 @@\n-first\n+second" }] },
  ];
  await this.store.save(task); state.taskId = task.id;
  this.runtimeFactory = async () => {
    const client = new EventEmitter(); client.start = client.stop = async () => {};
    client.respond = () => {}; client.respondError = () => {};
    client.request = async (method, params) => {
      if (method === "initialize") return {};
      if (method === "thread/resume" || method === "thread/start") return { thread: { id: "diff-review-thread" } };
      if (method === "turn/start") {
        state.inputs.push(params.input[0].text);
        queueMicrotask(() => client.emit("notification", { method: "turn/completed", params: { threadId: "diff-review-thread", turn: { id: `sent-${state.inputs.length}`, status: "completed", items: [{ type: "agentMessage", id: `sent-answer-${state.inputs.length}`, text: "意见已收到。" }] } } }));
        return { turn: { id: `sent-${state.inputs.length}` } };
      }
      throw new Error(`Unexpected fixture method ${method}`);
    };
    return { client, params: {} };
  };
};
await import("../../src/desktop/main.js");
