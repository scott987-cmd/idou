import "../../src/adopt-legacy-env.js";
import { MessageDiscovery } from "../../src/knowledge/message-discovery.js";
import { GatewayWikiSynthesizer } from "../../src/knowledge/synthesis.js";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
// The scope confirmation is the application's own in-app card now, so this
// fixture stubs no dialog: the script answers the card by its button label.
globalThis.discoveryFixture = { models: 0, schedules: [], version: 1 };
const schedule = MessageDiscovery.prototype.schedule;
MessageDiscovery.prototype.schedule = function(delay) {
  globalThis.discoveryFixture.worker = this;
  globalThis.discoveryFixture.schedules.push(delay ?? 120_000);
  // Exercise the actual native timer callback with a faster test-only interval.
  return schedule.call(this, delay === 0 ? 0 : 400);
};
// The binding names the model the desktop learned for this synthesizer, as the real one does.
GatewayWikiSynthesizer.prototype.binding = async function() { return { serverUrl: "http://127.0.0.1:12345", sessionHash: "synthetic", expiresAt: Date.now() + 600_000, model: this.model }; };
GatewayWikiSynthesizer.prototype.generate = async page => {
  globalThis.discoveryFixture.models++;
  return { facts: [{ text: "本阶段验收仅面向采购组。", evidence: [{ chunkId: page.chunks[0].id, quote: "验收只面向采购组。" }] }] };
};
await import("./chat-desktop-entry.js");
const invoke = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  if (args[0] !== "docs") return invoke.call(this, args, options);
  globalThis.chatFixture.calls.push(args);
  if (args[1] !== "+fetch") throw new Error("Only synthetic read operations are allowed");
  const f = globalThis.discoveryFixture;
  if (f.holdDocument) {
    f.held = true;
    await new Promise((resolve, reject) => { options.signal.addEventListener("abort", () => { f.aborted = true; reject(new Error("synthetic read canceled")); }, { once: true }); });
  }
  const token = new URL(args[args.indexOf("--doc") + 1]).pathname.split("/").at(-1);
  // 两篇必须是不同的文档，不能只换标题：正文一样的两份会被近似副本判定归成一组，
  // 回答里只留一份代表，这个冒烟要看到的是发现了两篇。
  const first = token === "SyntheticChatDocument123";
  return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data: { document: { document_id: token, revision_id: f.version,
    content: `<title>${first ? "采购交付计划" : "新增验收清单"}（合成数据）</title>${first
      ? "<p>验收只面向采购组。</p><p>交付节奏按周推进，每周五同步进度与风险。</p>"
      : "<p>本清单登记采购组提出的待验收事项。</p><p>每一项写明提出人、期望完成日期与验收标准，缺一项不进入排期。</p><p>登记后由值班同事在两个工作日内回执。</p>"}<p>自动发现版本 ${f.version}。</p>` } } }) };
};
