export function feishuChatUi({ api, root, element, isCurrent, openDocument }) {
  let epoch = 0, disposed = false, timer, nextChats = null, nextMessages = null, selected = null;
  const intro = element("p", "读取当前 CLI 用户可见的单聊和群聊。消息仅临时展示，不自动上传到模型或知识库；文档打开后沿用工作任务的来源核验与本机 Wiki 整理。"),
    toolbar = element("div", undefined, "chat-toolbar"), refresh = element("button", "读取会话"), moreChats = element("button", "更多会话"),
    notice = element("p", "点击读取会话开始。回复需单独确认；不下载附件、不主动标记已读。", "chat-notice"),
    layout = element("div", undefined, "feishu-chat-layout"), list = element("nav", undefined, "chat-list"), panel = element("section", undefined, "chat-panel"),
    heading = element("h2", "选择一个会话"), controls = element("div", undefined, "chat-toolbar"), reload = element("button", "刷新消息"), older = element("button", "更早一页"), watch = element("button", "自动整理此会话文档"),
    body = element("div", undefined, "chat-messages");
  refresh.id = "chat-refresh"; moreChats.id = "chat-more"; notice.id = "chat-notice"; list.id = "chat-list"; body.id = "chat-messages";
  reload.id = "chat-reload"; older.id = "chat-older"; moreChats.hidden = true; controls.hidden = true;
  watch.id = "chat-watch-knowledge";
  list.setAttribute("aria-label", "飞书会话"); notice.setAttribute("role", "status");
  toolbar.append(refresh, moreChats); controls.append(reload, older, watch); panel.append(heading, controls, body); layout.append(list, panel); root.append(intro, toolbar, notice, layout);
  const composer = element("section", undefined, "chat-reply-composer"), target = element("p"), input = element("textarea"),
    threadLabel = element("label", "在话题内回复 "), thread = element("input"), send = element("button", "核对并发送回复"), cancel = element("button", "取消回复"), replyStatus = element("p", undefined, "chat-notice");
  let replyHandle = null;
  composer.id = "chat-reply-composer"; composer.hidden = true; target.className = "chat-reply-target"; input.id = "chat-reply-text"; input.maxLength = 2000; input.rows = 3;
  input.setAttribute("aria-label", "回复内容"); input.placeholder = "输入纯文本回复（最多 2000 字）";
  thread.type = "checkbox"; thread.id = "chat-reply-thread"; send.id = "chat-reply-send"; cancel.id = "chat-reply-cancel";
  threadLabel.append(thread); composer.append(target, input, threadLabel, send, cancel, replyStatus); panel.append(composer);
  function clearReply() { composer.hidden = true; input.value = ""; replyHandle = null; thread.checked = false; replyStatus.textContent = ""; }
  cancel.onclick = clearReply;
  input.oninput = () => { replyStatus.textContent = "草稿已修改，尚未发送。"; };
  send.onclick = () => run(async attempt => {
    input.disabled = true; thread.disabled = true;
    try {
      const result = await api.replyChatMessage(replyHandle, input.value, thread.checked); if (!alive(attempt)) return;
      if (result.state === "canceled") { replyStatus.textContent = "已取消，未发送。可以继续修改。"; return; }
      clearReply(); notice.textContent = result.message + (result.messageId ? ` 回执：${result.messageId}` : "");
    } finally { input.disabled = false; thread.disabled = false; }
  });
  const alive = attempt => !disposed && isCurrent() && attempt === epoch;
  function clear() { clearTimeout(timer); clearReply(); list.replaceChildren(); body.replaceChildren(); controls.hidden = true; moreChats.hidden = true; heading.textContent = "选择一个会话"; selected = null; nextChats = null; nextMessages = null; }
  function expiry(at) {
    clearTimeout(timer); timer = setTimeout(() => { if (!disposed && isCurrent()) { epoch++; clear(); notice.textContent = "临时阅读已到期，请重新读取会话。"; refresh.disabled = false; void api.closeChatReader().catch(() => {}); } }, Math.max(0, at - Date.now()));
  }
  function disabled(value) { for (const button of [...toolbar.querySelectorAll("button"), ...layout.querySelectorAll("button")]) button.disabled = value; }
  async function run(fn) {
    const attempt = ++epoch; disabled(true);
    try { await fn(attempt); }
    catch (error) {
      if (alive(attempt)) { clear(); notice.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ""); await api.closeChatReader().catch(() => {}); }
    } finally { if (alive(attempt)) disabled(false); }
  }
  const mode = chat => ({ p2p: "单聊", group: "群聊", topic: "话题群" }[chat.mode] || "会话");
  async function read(chat, next, attempt) {
    clearReply(); body.replaceChildren(); notice.textContent = "正在重新核验身份并读取消息…";
    const result = await api.readChat(chat.handle, next); if (!alive(attempt)) return;
    selected = chat; nextMessages = result.next; heading.textContent = chat.name; controls.hidden = false; older.hidden = !nextMessages;
    for (const button of list.children) button.setAttribute("aria-current", button.dataset.handle === chat.handle ? "true" : "false");
    notice.textContent = `本页 ${result.messages.length} 条主消息 · 新消息在上方 · 临时快照，刷新后核验。可回复文本消息；附件、卡片不执行。`;
    if (!result.messages.length) body.append(element("p", "当前页没有可见消息。", "empty"));
    function message(row, reply = false) {
      const item = element("article", undefined, reply ? "feishu-message thread-reply" : "feishu-message");
      item.append(element("strong", row.sender), element("small", `${row.senderId} · ${row.createdAt}${row.edited ? " · 已编辑" : ""} · ${row.type}`), element("div", row.text, "feishu-message-text"));
      if (row.replyHandle) {
        const replyButton = element("button", "回复", "chat-reply-button"); replyButton.dataset.messageId = row.id;
        replyButton.onclick = () => {
          clearReply(); replyHandle = row.replyHandle; composer.hidden = false;
          target.textContent = `回复 ${row.sender} · ${row.id}：${row.text.slice(0, 240)}${row.text.length > 240 ? "…" : ""}`;
          replyStatus.textContent = "群聊回复对会话成员可见；发送前还需核对原生确认框。";
          input.focus(); composer.scrollIntoView({ block: "nearest" });
        }; item.append(replyButton);
      }
      for (const link of row.documents) {
        const button = element("button", "在工作任务中打开文档 →", "chat-document");
        button.append(element("small", link.url));
        button.onclick = () => run(async attempt => {
          notice.textContent = "正在重新读取来源消息，随后核验文档权限…";
          const source = await api.resolveChatDocument(link.handle); if (!alive(attempt)) return;
          await openDocument(source.url);
        }); item.append(button);
      }
      if (row.replies.length) {
        const replies = element("details"); replies.append(element("summary", `查看已读取的 ${row.replies.length} 条话题回复`));
        for (const child of row.replies) replies.append(message(child, true)); item.append(replies);
      }
      if (row.threadPartial) item.append(element("small", "话题回复未完整获取；不能将当前内容视为完整讨论。", "chat-notice"));
      return item;
    }
    body.append(...result.messages.map(row => message(row))); body.scrollTop = 0; expiry(result.expiresAt);
  }
  async function load(next, attempt) {
    if (!next) clear(); notice.textContent = "正在读取当前用户的会话列表…";
    const result = await api.listChats(next); if (!alive(attempt)) return;
    nextChats = result.next; moreChats.hidden = !nextChats; refresh.textContent = "刷新会话";
    for (const chat of result.chats) {
      const button = element("button", chat.name, "chat-choice"); button.dataset.handle = chat.handle;
      button.append(element("small", `${mode(chat)} · ${chat.external === true ? "外部会话" : chat.external === false ? "内部会话" : "外部属性未知"}`), element("small", chat.id));
      button.onclick = () => run(attempt => read(chat, null, attempt)); list.append(button);
    }
    notice.textContent = `已读取 ${list.children.length} 个会话${result.limited ? " · 达到本次 500 个会话上限" : nextChats ? " · 还有更多" : ""}。选择会话后读取消息；页面离开或五分钟到期后清除。`;
    expiry(result.expiresAt);
  }
  refresh.onclick = () => run(attempt => load(null, attempt)); moreChats.onclick = () => run(attempt => load(nextChats, attempt));
  reload.onclick = () => run(attempt => read(selected, null, attempt)); older.onclick = () => run(attempt => read(selected, nextMessages, attempt));
  watch.onclick = () => run(async attempt => {
    const result = await api.watchKnowledgeChat(selected?.handle); if (!alive(attempt)) return;
    notice.textContent = result ? "此会话已加入自动整理范围；在企业知识库中查看进度或停止。" : "已取消，没有新增自动整理范围。";
  });
  return { dispose() { disposed = true; epoch++; clear(); } };
}
