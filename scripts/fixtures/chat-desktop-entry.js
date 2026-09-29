import "../../src/adopt-legacy-env.js";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { safeStorage } from "electron";
import { createHash } from "node:crypto";
import { fixtureCipher } from "./wiki-cipher.js";
import { chatFixture, chatResponse } from "./chat-data.js";
const cipher = fixtureCipher(createHash("sha256").update("synthetic-chat-reader-key").digest());
safeStorage.isEncryptionAvailable = cipher.available; safeStorage.encryptString = cipher.encrypt; safeStorage.decryptString = cipher.decrypt;
const original = SaasFeishuCliProvider.prototype.invoke;
globalThis.chatFixture = chatFixture();
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  if (args[0] === "skills" || args[0] === "--version") return original.call(this, args, options);
  if (args[0] !== "docs") return chatResponse(globalThis.chatFixture, args);
  globalThis.chatFixture.calls.push(args);
  if (args[1] !== "+fetch") throw new Error("No document writes allowed in this fixture");
  if (globalThis.chatFixture.documentDenied) return { code: 1, stdout: "", stderr: '{"ok":false,"error":{"type":"authorization"}}' };
  // 任何别的链接都当成同一份文档的另一个副本：一份内容在库里存了两遍，
  // 是这个产品最常见的情形，清单要能把它标出来。
  const asked = args.find((value) => typeof value === "string" && value.includes("/docx/"));
  const token = asked ? asked.split("/").at(-1) : "SyntheticChatDocument123";
  const body = "<p>第一阶段：核对文档阅读与消息来源。</p><p>第二阶段：在工作任务中讨论和生成行动项。</p>";
  return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data: { document: {
    document_id: token, revision_id: 1,
    content: `<title>交付计划${token === "SyntheticChatDocument123" ? "" : "（转存）"}（合成数据）</title>${body}` } } }) };
};
await import("../../src/desktop/main.js");
