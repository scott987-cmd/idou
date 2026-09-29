// Synthetic transport data only. No production module imports this fixture.
export const chatDocumentUrl = "https://test.feishu.cn/docx/SyntheticChatDocument123";
export function chatFixture() {
  return { user: "ou_reader", tenant: "synthetic-tenant", calls: [], chats: [
    { chat_id: "oc_delivery", name: "产品交付讨论（合成数据）", chat_mode: "group", external: false, chat_status: "normal" },
    { chat_id: "oc_direct", name: "陈宁", chat_mode: "p2p", external: false, chat_status: "normal" },
  ], rows: [
    { message_id: "om_plan", msg_type: "post", create_time: "2026-09-09 10:20", deleted: false, updated: true, sender: { name: "陈宁", id: "ou_chen" }, content: `请核对这份交付计划：\n${chatDocumentUrl}\n确认后在工作任务中整理行动项。`, thread_id: "omt_plan", thread_has_more: true,
      thread_replies: [{ message_id: "om_reply", msg_type: "text", create_time: "2026-09-09 10:21", deleted: false, sender: { name: "林舒", id: "ou_lin" }, content: "先确认文档中的验收范围，图片和视频由创作工作区处理。" }] },
    { message_id: "om_script", msg_type: "interactive", create_time: "2026-09-09 10:15", deleted: false, sender: { id: "ou_bot" }, content: '<script>window.__chatPwned=true</script>\n卡片仅作文本展示，不执行按钮。 https://evil.test/docx/SyntheticChatDocument123' },
    { message_id: "om_recalled", msg_type: "text", create_time: "2026-09-09 10:10", deleted: true, sender: { name: "陈宁", id: "ou_chen" }, content: `RECALLED_SECRET ${chatDocumentUrl}` },
    { message_id: "om_image", msg_type: "image", create_time: "2026-09-09 10:00", deleted: false, sender: { name: "林舒", id: "ou_lin" }, content: "![Image](img_synthetic_only)" },
  ] };
}
export async function chatResponse(state, args) {
  state.calls.push(args);
  const value = flag => args[args.indexOf(flag) + 1];
  const ok = data => ({ code: 0, stderr: "", stdout: JSON.stringify({ ok: true, identity: state.envelopeIdentity || "user", data }) });
  if (args[0] === "auth") return { code: 0, stdout: JSON.stringify({ verified: true, identities: { user: { openId: state.user, tenantKey: state.tenant, tokenStatus: "valid" } } }), stderr: "" };
  if (state.denied) return { code: 1, stdout: "", stderr: "SECRET_DETAIL denied" };
  let data;
  if (args[1] === "+chat-list") data = args.includes("--page-token") ? { chats: [{ chat_id: "oc_external", name: "外部交流", chat_mode: "group", external: true, chat_status: "normal" }], has_more: false } : { chats: state.chats, has_more: true, page_token: "chats:next" };
  else if (args[1] === "+chat-messages-list") data = args.includes("--page-token") ? { messages: [{ ...state.rows[3], message_id: "om_older", content: "较早的讨论内容" }], has_more: false } : { chat_id: value("--chat-id"), messages: state.rows, has_more: true, page_token: "messages:next" };
  else if (args[1] === "+messages-mget") data = { messages: state.mgetRows ?? state.rows.flatMap(row => [row, ...(row.thread_replies || [])]).filter(row => row.message_id === value("--message-ids")) };
  else throw new Error(`Unexpected fixture operation: ${args[0]} ${args[1]}`);
  // Freeze response before the optional gate to model stale in-flight responses.
  const result = ok(state.override ?? data); if (state.afterRead) await state.afterRead(args);
  return result;
}
