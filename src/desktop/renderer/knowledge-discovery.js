export function knowledgeDiscoveryUi({ api, root, element, isCurrent, onStatus = () => {} }) {
  let disposed = false, stopping = false;
  const card = element("section", undefined, "discovery-card"), title = element("strong", "消息文档自动整理"),
    note = element("p", "正在读取整理状态…"), scope = element("small"), controls = element("div", undefined, "chat-toolbar"),
    refresh = element("button", "刷新状态"), stop = element("button", "停止自动整理");
  card.id = "knowledge-discovery"; note.id = "discovery-status"; scope.id = "discovery-scope"; stop.id = "discovery-stop"; stop.hidden = true;
  controls.append(refresh, stop); card.append(title, note, scope, controls); root.append(card);
  const active = () => !disposed && isCurrent() && card.isConnected;
  function render(value) {
    if (!active()) return;
    onStatus(value);
    note.textContent = `${value.busy ? "正在处理 · " : value.enabled ? "后台运行 · " : "未运行 · "}${value.message}`;
    scope.textContent = value.enabled ? `范围：${value.chats.map(chat => chat.name).join("、")} · 最近 24 小时 · 最多 ${value.limits.documentsPerCycle} 篇/轮${value.nextAt ? ` · 下次 ${new Date(value.nextAt).toLocaleTimeString()}` : ""}` : "在飞书消息中选择会话，开启一次后自动发现文档；无需逐篇打开。";
    stop.hidden = !value.enabled && !value.busy; stop.disabled = stopping;
  }
  async function load() {
    refresh.disabled = true;
    try { render(await api.discoveryStatus()); }
    catch { if (active()) note.textContent = "自动整理状态不可用；请核对当前飞书身份与应用连接。"; }
    finally { if (active()) refresh.disabled = false; }
  }
  const unsubscribe = api.onDiscoveryChange(render);
  refresh.onclick = load;
  stop.onclick = async () => {
    stopping = true; stop.disabled = true;
    try { render(await api.stopKnowledgeDiscovery()); }
    catch { if (active()) note.textContent = "停止结果尚未确认，请刷新状态。"; }
    finally { stopping = false; if (active()) stop.disabled = false; }
  };
  void load();
  return { dispose() { disposed = true; unsubscribe(); } };
}
