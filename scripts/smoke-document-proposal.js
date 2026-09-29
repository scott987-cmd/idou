// @requires live: 真实付费模型调用
import assert from "node:assert/strict";
import { once } from "node:events";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { DocumentProposalModel } from "../src/application/document-proposal-model.js";
import { contextualPrompt } from "../src/application/task-context.js";

if (process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live for one paid request to the server's configured chat model (MiniMax or GLM) using synthetic text only");
const chat = await loadChatModelConfig();
const sessions = new SessionRegistry(), parent = sessions.issue({ tenantId: "synthetic", userId: "synthetic-user", deviceId: "document-proposal-smoke" });
let requests = 0, totalTokens;
const server = createModelGateway({ sessions, apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, fetchImpl: async (url, options) => {
  assert.equal(++requests, 1, "No paid retry allowed");
  const body = JSON.parse(options.body); assert.deepEqual(body.tools, []); assert.equal(body.tool_choice, "none"); assert.equal(body.store, false);
  const response = await fetch(url, options);
  if (response.ok) totalTokens = (await response.clone().json()).usage?.total_tokens;
  return response;
} });
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const session = { token: parent.token, expiresAt: parent.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` };
  const model = new DocumentProposalModel({ getSession: async () => session, model: chat.model });
  const context = { kind: "feishu-document", intent: "propose-edit", title: "合成修改测试，无企业资料", sourceUrl: "https://test.feishu.cn/docx/SyntheticOnly123", sourceRevision: "1", partial: true, warnings: [], text: "下周交付初稿", selection: { start: 0, end: 6, text: "下周交付初稿" } };
  const answer = await model.generate(contextualPrompt("将选中文字准确替换为“周五交付评审稿”，不作其他改动。", context));
  assert.equal(JSON.parse(answer).replacement, "周五交付评审稿"); assert.equal(requests, 1);
  console.log(JSON.stringify({ passed: true, model: chat.model, providerRequests: requests, totalTokens, source: "synthetic inline text only", toolExecution: false, liveFeishuReads: 0, liveFeishuWrites: 0 }));
} finally { sessions.revoke(parent.token); server.close(); server.closeAllConnections(); }
