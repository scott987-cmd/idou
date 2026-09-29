import test from "node:test";
import assert from "node:assert/strict";
import { answerInTerminal } from "../src/application/chat.js";

// With default-mode questions on, the terminal chat receives the Agent's
// request_user_input too. It asks on the terminal, never asks for a secret, and
// with no terminal to ask on sends every question back unanswered instead of
// leaving the Agent waiting for input that cannot come.
test("the terminal chat asks the Agent's questions, never a secret, and never waits without a terminal", async () => {
  const questions = [
    { id: "db", header: "数据库", question: "用哪个数据库？", isOther: true, options: [{ label: "SQLite", description: "单文件" }, { label: "Postgres" }] },
    { id: "name", header: "名称", question: "服务叫什么？", options: [] },
    { id: "token", header: "令牌", question: "粘贴 API key", isSecret: true, options: [] },
    { id: "size", header: "规模", question: "多大？", isOther: false, options: [{ label: "小" }, { label: "大" }] },
    { header: "缺 id", question: "不会被问到" },
  ];
  const prompts = [], replies = ["2", "账单服务", "我自己写"];
  const result = await answerInTerminal(questions, async (prompt) => { prompts.push(prompt); return replies.shift(); });
  assert.deepEqual(result, { answers: { db: { answers: ["Postgres"] }, name: { answers: ["账单服务"] }, token: { answers: [] }, size: { answers: [] } } });
  assert.equal(prompts.length, 3, "a secret is never asked for, and a question without an id is skipped");
  assert.match(prompts[0], /1\. SQLite - 单文件/);
  assert.match(prompts[0], /Choose a number or type your own answer \(Enter to skip\)/);
  assert.match(prompts[1], /Type your answer \(Enter to skip\)/);
  // Only the listed choices count where the question does not take free text.
  assert.match(prompts[2], /Choose a number \(Enter to skip\)/);
  assert.deepEqual(await answerInTerminal(questions, null), { answers: { db: { answers: [] }, name: { answers: [] }, token: { answers: [] }, size: { answers: [] } } });
});
