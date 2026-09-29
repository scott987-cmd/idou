// Test-only native process/model boundaries. Production never imports this file.
// The Agent here is a stand-in that answers every turn with the same Markdown
// reply, and the operating system's URL handler only records what it was asked
// to open, so a click in the smoke test proves where a link would go.
import "../../src/adopt-legacy-env.js";
import { safeStorage, shell } from "electron";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskService } from "../../src/application/task-service.js";
import { DocumentService } from "../../src/application/document-service.js";
import { fixtureCipher } from "./wiki-cipher.js";
import { agentTool } from "../../src/application/knowledge-commands.js";
const cipher = fixtureCipher(Buffer.alloc(32, 41));
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
const state = globalThis.replyMarkdownFixture = { turns: [], steers: [], opened: [], documents: [], answers: [], ready: false, release: null, rejectSteer: false, stopRequests: 0 };
const stop = TaskService.prototype.stop;
TaskService.prototype.stop = function(id) { state.stopRequests += 1; return stop.call(this, id); };
// Before answering, the stand-in searches the knowledge copy again and asks to
// run that search outside its sandbox, as MiniMax-M3 does now and then.
export const KNOWLEDGE_READ = `/bin/zsh -c 'node ${JSON.stringify(agentTool())} kb-search --query "住宿费上限"'`;
// 点开一张来源卡片，应该正是去读那一篇飞书原文：这里只记下要读谁。
const open = DocumentService.prototype.open;
DocumentService.prototype.open = async function(taskId, reference, options) {
  state.documents.push(String(reference));
  return open.call(this, taskId, reference, options);
};
shell.openExternal = async (url) => { state.opened.push(url); };
export const REPLY = [
  "### 1) 今天（2026-09-11）的日程", "",
  "**命令：**", "", "```bash", "lark-cli calendar +agenda --start 2026-09-11 --end 2026-09-11 --as user", "```", "",
  "返回 `data: []`，**今天日历是空的**。", "",
  "### 一句话总览", "",
  "| 问题 | 结论 |", "|---|---|", "| 今天的日程 | 空的，整天空闲 |", "| 明天 14:00–18:00 忙不忙 | 不忙，全空可约 |", "| 未完成的飞书任务 | 没有，零待办 |", "",
  "- 周报文档：[本周周报](https://example.feishu.cn/docx/SyntheticDoc123)", "- [ ] 核对日程", "- [x] 核对任务", "",
  "住宿费上限见 https://test.feishu.cn/docx/DocCurrent（2026 版）。", "",
  "原文：[员工手册全文](https://test.feishu.cn/docx/DocCurrenr)", "",
  "> 引用里的 <script>window.__replyPwned = 1</script> 只是文字。", "",
  "![季度图表](https://example.com/q3.png)",
].join("\n");
// 提问时带上的知识：两篇，回答只引用了其中一篇——界面要能把这件事说清楚。
export const SOURCES = [
  { id: "aaaaaaaaaaaa", title: "员工手册（2026 版）", sourceUrl: "https://test.feishu.cn/docx/DocCurrent", revision: "3",
    section: "## 二、差旅", docDate: "2026-01-01", standing: "current", excerpt: "住宿费报销上限每晚 500 元。" },
  { id: "bbbbbbbbbbbb", title: "住宿费管理细则（2024 版）", sourceUrl: "https://test.feishu.cn/docx/DocOld", revision: "1",
    section: "## 住宿", docDate: "2024-01-01", standing: "superseded", supersededBy: { id: "aaaaaaaaaaaa", title: "员工手册（2026 版）", docDate: "2026-01-01" },
    excerpt: "住宿费报销上限每晚 400 元。" },
];
const init = TaskService.prototype.init;
TaskService.prototype.init = async function() {
  await init.call(this);
  // 不碰真实知识库：这个冒烟要验的是「回答下面的来源卡片」，不是检索。
  this.knowledgeResolver = async () => ({ evidence: SOURCES.map((source) => ({ ...source })), unavailable: 1 });
  this.runtimeFactory = async (task) => {
    const client = new EventEmitter(); client.start = client.stop = async () => {};
    client.respond = (id, result) => { state.answers.push({ id, result }); };
    client.respondError = (id, code) => { state.answers.push({ id, error: code }); };
    client.request = async (method, params) => {
      if (method === "initialize") return {};
      if (["thread/start", "thread/resume"].includes(method)) return { thread: { id: "reply-markdown-thread" } };
      if (method === "turn/start") {
        state.turns.push(params.input[0].text);
        const turnNumber = state.turns.length;
        const gate = Promise.withResolvers(); state.release = gate.resolve; state.ready = true;
        void gate.promise.then(async () => {
          client.emit("notification", { method: "turn/plan/updated", params: { threadId: "reply-markdown-thread", turnId: "fixture-turn",
            explanation: "先核对企业资料，再整理结果", plan: [{ step: "核对企业资料", status: "completed" }, { step: "整理结论", status: "inProgress" }] } });
          // Deliberately reused across tasks: renderer expansion state must be
          // scoped by task, and TaskService must not treat it as globally unique.
          const failed = { type: "commandExecution", id: "failed-read-fixture", command: "/bin/zsh -lc 'cat unavailable-policy.md'",
            commandActions: [{ type: "read", path: "unavailable-policy.md", name: "unavailable-policy.md" }] };
          client.emit("notification", { method: "item/completed", params: { threadId: "reply-markdown-thread", item: { ...failed, status: "failed", exitCode: 2, aggregatedOutput: "permission denied" } } });
          const step = { type: "commandExecution", id: "kb-fixture", command: KNOWLEDGE_READ };
          client.emit("notification", { method: "item/started", params: { threadId: "reply-markdown-thread", item: { ...step, status: "inProgress" } } });
          client.emit("serverRequest", { id: 9000 + state.turns.length, method: "item/commandExecution/requestApproval",
            params: { threadId: "reply-markdown-thread", turnId: "fixture-turn", itemId: step.id, command: KNOWLEDGE_READ, reason: "需要在沙箱外运行知识库检索", startedAtMs: Date.now() } });
          client.emit("notification", { method: "item/completed", params: { threadId: "reply-markdown-thread", item: { ...step, status: "completed", exitCode: 0, aggregatedOutput: "{\"ok\":true,\"result\":{\"query\":\"住宿费上限\",\"excerpts\":[]}}" } } });
          const output = path.join(task.cwd, `第${turnNumber}轮差旅总结.md`);
          await writeFile(output, `# 第 ${turnNumber} 轮差旅总结\n\n这是隔离测试成果。\n`);
          client.emit("notification", { method: "item/completed", params: { threadId: "reply-markdown-thread", item: { type: "fileChange", id: "file-fixture", status: "completed",
            changes: [{ path: output, kind: { type: "add" }, diff: `# 第 ${turnNumber} 轮差旅总结` }] } } });
          client.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: "reply-markdown-thread", tokenUsage: { last: { totalTokens: 112_000 }, modelContextWindow: 212_000 } } });
          const split = Math.floor(REPLY.length / 2);
          client.emit("notification", { method: "turn/completed", params: { threadId: "reply-markdown-thread", turn: { id: "fixture-turn", status: "completed", items: [
            { type: "agentMessage", id: `answer-${turnNumber}-a`, text: REPLY.slice(0, split) },
            { type: "agentMessage", id: `answer-${turnNumber}-b`, text: REPLY.slice(split) },
          ] } } });
        });
        return { turn: { id: "fixture-turn" } };
      }
      if (method === "turn/steer") {
        if (state.rejectSteer) { state.rejectSteer = false; throw new Error("turn already completed"); }
        state.steers.push(params.input[0].text); return {};
      }
      throw new Error("Unexpected fixture model method");
    };
    return { client, params: {} };
  };
};
await import("../../src/desktop/main.js");
