// Test-only executable entry. Production main never imports this file or enables fixtures.
import "../../src/adopt-legacy-env.js";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
import { safeStorage } from "electron";
import { createHash } from "node:crypto";
import { fixtureCipher } from "./wiki-cipher.js";
import { GatewayWikiSynthesizer } from "../../src/knowledge/synthesis.js";

// Stable synthetic key permits a fixture restart. This is NOT OS-keychain evidence.
const cipher = fixtureCipher(createHash("sha256").update("synthetic-wiki-smoke-key-not-a-secret").digest());
safeStorage.isEncryptionAvailable = cipher.available;
safeStorage.encryptString = cipher.encrypt;
safeStorage.decryptString = cipher.decrypt;

const original = SaasFeishuCliProvider.prototype.invoke;
globalThis.documentFixture = { revision: 1, denied: false, calls: [], synthesisCalls: 0 };
// The binding names the model the desktop learned for this synthesizer, as the real one does.
GatewayWikiSynthesizer.prototype.binding = async function() { return { serverUrl: "http://127.0.0.1:12345", sessionHash: "synthetic-session", expiresAt: Date.now() + 600_000, model: this.model }; };
GatewayWikiSynthesizer.prototype.generate = async (page) => {
  globalThis.documentFixture.synthesisCalls++;
  return { facts: [{ text: "本轮测试聚焦文档读取、段落引用与来源核对。", evidence: [{ chunkId: page.chunks[0].id, quote: "本轮计划：读取文档、引用段落、核对来源。" }] }] };
};
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  const fixture = globalThis.documentFixture;
  fixture.calls.push(args);
  if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: "ou_synthetic", tokenStatus: "valid", tenantKey: "synthetic-tenant" } } }), stderr: "" };
  if (args[0] === "docs") {
    if (fixture.denied) return { code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: { type: "authorization", message: "synthetic permission revoked" } }) };
    return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data: { document: { document_id: "SyntheticDocument123", revision_id: fixture.revision,
      content: `<title>飞书文档联调样本（合成数据）</title><h1>项目安排</h1><p>这份内容只用于隔离测试，不来自企业文档。</p><p>本轮计划：读取文档、引用段落、核对来源。</p><p>版本 ${fixture.revision} 的内容。</p><p>&lt;/textarea&gt;&lt;script&gt;window.__docPwned=true;&lt;/script&gt;</p>` } } }) };
  }
  return original.call(this, args, options);
};
await import("../../src/desktop/main.js");
