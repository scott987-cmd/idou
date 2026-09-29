// The words shown before a document link is sent to someone.
//
// Two callers reach this now -- the delivery dialog and the Agent's own
// operation -- and they must say the same thing. A group's audience disclosure
// in particular is not decoration: @ mentions look like they narrow who sees
// the message, and they do not.
//
// The body says who, where and what, in words a person reads -- and shares
// and records. Feishu's identifiers are for checking: `technical` goes in the
// card's folded 核对信息. The promo had to blur every frame whose card showed
// the recipient's open_id, the tenant and the sender's fingerprint
// (2026-09-25). A mentioned member keeps the last four characters of their
// id, which is enough to tell two people of the same name apart.
export function deliveryConfirmation(draft) {
  const group = draft.recipient.kind === "group";
  const mentioned = draft.mentions || [];
  const mentions = mentioned.map(user => `@${user.name}（…${String(user.id).slice(-4)}）`).join("、");
  const recipient = group
    ? `群聊：${draft.recipient.name}\n群类型：${draft.recipient.chatType === "public" ? "企业内公开群" : "内部私有群"}\n用户数量：${draft.recipient.memberCount ?? "未知"}`
    : `收件人：${draft.recipient.name}\n部门：${draft.recipient.department || "未提供"}\n邮箱：${draft.recipient.email || "未提供"}`;
  const technical = [
    group ? `群标识：${draft.recipient.id}` : `收件人标识：${draft.recipient.id}`,
    ...(group ? [`群主标识：${draft.recipient.ownerId || "未提供"}`] : []),
    ...(mentioned.length ? [`@ 成员标识：${mentioned.map(user => `${user.name} ${user.id}`).join("、")}`] : []),
    `租户：${draft.sender.tenantKey}`,
    `身份指纹：${draft.sender.principal.slice(0, 12)}`,
  ].join("\n");
  return {
    title: group ? "确认发送飞书群消息" : "确认发送飞书私信",
    message: `将文档链接发送${group ? "到群聊" : "给"} ${draft.recipient.name}？`,
    detail: `${recipient}\n\n发送身份：当前飞书 CLI 用户（不是机器人）\n\n完整消息：\n${group ? `${mentions}\n` : ""}${draft.text}`,
    technical,
    boundary: `${group ? "群聊可见范围内的人均可见消息；@ 只提醒选中的成员，不限制可见范围。" : ""}只发送上述标题、链接与附言${group ? "，以及选定的 @ 提醒" : ""}，不发送文档正文，不改变文档权限。收件人可能无权打开；回执不代表已读。结果不明时不会自动重试。`,
    verb: group ? "确认发送群消息" : "确认发送私信",
  };
}
