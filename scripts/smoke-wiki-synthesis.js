// @requires live: 真实付费模型调用
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadChatModelConfig } from "../src/control-plane/server-config.js";
import { SessionRegistry } from "../src/control-plane/sessions.js";
import { createModelGateway } from "../src/control-plane/model-gateway.js";
import { LocalWiki } from "../src/knowledge/local-wiki.js";
import { GatewayWikiSynthesizer } from "../src/knowledge/synthesis.js";
import { fixtureCipher } from "./fixtures/wiki-cipher.js";
import { MessageDiscovery } from "../src/knowledge/message-discovery.js";

const discoveryMode = process.argv.slice(2).join(" ") === "--live --discovery";
if (!discoveryMode && process.argv.slice(2).join(" ") !== "--live") throw new Error("Pass --live [--discovery] for one paid request to the server's configured chat model (MiniMax or GLM) using synthetic source data");
const chat = await loadChatModelConfig();
const document = { providerId: "synthetic", resourceId: "synthetic-project", sourceUrl: "https://test.feishu.cn/docx/SyntheticProject123", sourceRevision: "1", contentHash: "synthetic-v1", title: "青岚采购门户（合成测试）",
  text: "项目：青岚采购门户（合成测试，无企业资料）。\n试运行日期：2026年9月18日。\n负责人：陈宁（虚构角色）。\n范围：只面向采购组开放，暂不接入外部供应商。\n验收：必须完成登录、权限隔离和采购单查询三项验证。",
  partial: false, warnings: [], identity: { principal: "synthetic-user", tenantKey: "synthetic-tenant", verifiedAt: Date.now() } };
const sessions = new SessionRegistry(), issued = sessions.issue({ tenantId: "synthetic-tenant", userId: "synthetic-user", deviceId: "local-wiki-smoke" });
let requests = 0, usage;
const server = createModelGateway({ apiKey: chat.apiKey, provider: chat.provider, upstreamOrigin: chat.upstreamOrigin, model: chat.model,
  upstreamModel: chat.upstreamModel, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs, sessions, fetchImpl: async (url, options) => {
  requests++; assert.equal(requests, 1, "No automatic paid retry allowed");
  const response = await fetch(url, options);
  if (response.ok) { const body = await response.clone().json(); usage = body.usage?.total_tokens; }
  return response;
} });
const directory = await mkdtemp(path.join(os.tmpdir(), "idou-wiki-live-"));
let wiki, discovery;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const session = { token: issued.token, expiresAt: issued.expiresAt, serverUrl: `http://127.0.0.1:${server.address().port}` };
  const provider = { documentIdentity: async () => document.identity, readDocument: async () => structuredClone(document), chatReader: {
    read: async () => ({ identity: document.identity, next: null, messages: [{ id: "om_synthetic", deleted: false, documents: [document.sourceUrl], replies: [], threadPartial: false }] }),
    resolveDocument: async () => document.sourceUrl,
  } };
  wiki = new LocalWiki({ filename: path.join(directory, "wiki.enc"), cipher: fixtureCipher(), provider,
    synthesizer: new GatewayWikiSynthesizer({ getSession: async () => session, model: chat.model }) });
  await wiki.enableSynthesis();
  if (discoveryMode) {
    discovery = new MessageDiscovery({ provider, wiki, reader: { captureSelection: () => ({ chat: { id: "oc_synthetic", name: "合成会话" }, identity: document.identity, current() {} }) }, timers: { set: () => null, clear() {} } });
    await discovery.add("synthetic-selection", async () => true); await discovery.tick();
    assert.equal(discovery.status().last?.retained, 1);
  } else await wiki.observe(document);
  const result = await wiki.search("采购"), synthesis = result.hits[0]?.synthesis;
  assert.ok(synthesis?.facts.length >= 2, wiki.status().message);
  assert.equal(synthesis.coverage.includedChunks, synthesis.coverage.totalChunks);
  assert.equal(synthesis.model, chat.model, "the saved synthesis names the model that produced it");
  assert.equal(requests, 1);
  for (const fact of synthesis.facts) for (const citation of fact.evidence) assert.equal(document.text.slice(citation.start, citation.end), citation.quote);
  if (discoveryMode) await discovery.tick(); else await wiki.observe(document);
  assert.equal(requests, 1, "Repeated read must not rebill");
  console.log(JSON.stringify({ passed: true, source: "synthetic project only; NOT live Feishu or OS Keychain", model: synthesis.model, providerRequests: requests, totalTokens: usage,
    facts: synthesis.facts, repeatedReadDeduplicated: true, backgroundDiscovery: discoveryMode, feishuWrites: 0 }));
} finally {
  await discovery?.close(); await wiki?.close(); sessions.revoke(issued.token); server.close(); server.closeAllConnections();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
