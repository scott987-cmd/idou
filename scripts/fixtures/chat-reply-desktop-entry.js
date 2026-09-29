import "../../src/adopt-legacy-env.js";
import { SaasFeishuCliProvider } from "../../src/providers/feishu/saas-cli-provider.js";
// Only the upstream write is synthetic. The confirmation is the application's
// own in-app card (main.js sends "idou:confirm"), so nothing here stubs a
// dialog: the script answers the card the person would answer.
globalThis.replyFixture = { writes: [] };
await import("./chat-desktop-entry.js");
const readOnly = SaasFeishuCliProvider.prototype.invoke;
SaasFeishuCliProvider.prototype.invoke = async function(args, options) {
  if (args[1] !== "+messages-reply") return readOnly.call(this, args, options);
  const state = globalThis.replyFixture; state.writes.push(args);
  if (state.lost) throw new Error("Synthetic lost receipt");
  return { code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: "user", data: { message_id: `om_sent${state.writes.length}`, chat_id: "oc_delivery" } }) };
};
