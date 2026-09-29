export function knowledgePublicationUi({ api, root, element, isCurrent, kind = "publication" }) {
  const receiving = kind === "reception";
  const methods = receiving ? { status: api.knowledgeReceptionStatus, start: api.startKnowledgeReception, stop: api.stopKnowledgeReception, onChange: api.onReceptionChange } :
    { status: api.knowledgePublicationStatus, start: api.startKnowledgePublication, stop: api.stopKnowledgePublication, onChange: api.onPublicationChange };
  let disposed = false, revision = 0, pending = false, latest;
  const card = element("section", undefined, "discovery-card"), note = element("p", "正在读取同步状态…"), detail = element("small"),
    controls = element("div", undefined, "chat-toolbar"), refresh = element("button", "刷新状态"), start = element("button", "检查配置并开启"), stop = element("button", receiving ? "停止自动取回" : "停止云盘同步");
  card.id = `knowledge-${kind}`; note.id = `${kind}-status`; detail.id = `${kind}-detail`; start.id = `${kind}-start`; stop.id = `${kind}-stop`;
  start.disabled = true; stop.hidden = true;
  controls.append(refresh, start, stop); card.append(element("strong", receiving ? "企业知识自动取回" : "云盘自动同步"), note, detail, controls); root.append(card);
  const active = () => !disposed && isCurrent() && card.isConnected;
  const states = { idle: "未开启", starting: "正在核对企业配置", running: "后台运行", paused: "已暂停", stopping: "正在停止", stopped: "已停止", closed: "当前账号已关闭" };
  function render(value) {
    if (!active()) return;
    latest = value;
    note.textContent = `${states[value.state] || "状态待核对"}${value.busy ? " · 处理中" : ""} · ${receiving ? `本次已取回 ${value.counts.received} 个版本 · ${value.counts.unavailable} 个版本未通过核验` : `${value.sourceCount} 个近期来源 · 本次已发布 ${value.counts.published} 个版本`}`;
    detail.textContent = value.state === "paused" ? receiving ? "企业接收配置、身份或会话需要核对。未开启自动取回；本机搜索仍需核验原文权限。" : "配置、身份、权限或发布记录需要核对。未确认的上传不会自动重传；本地整理不受影响。" :
      value.enabled ? `${receiving ? "从批准发布者发现版本，核验原文权限后取回；搜索时继续核验。失败版本本次不重复尝试，取回内容不自动重新发布。" : "自动选择本机近期阅读，核验原文后加密上传；不修改原文。"}${value.folderReference ? `企业目录：${value.folderReference}。` : ""}${value.expiresAt ? `本次授权至 ${new Date(value.expiresAt).toLocaleTimeString()}。` : ""}` :
      "仅在企业批准、登录与 CLI 身份核对后开启。服务端选择目录和额度；退出登录会停止同步。";
    start.hidden = value.enabled || value.busy; stop.hidden = !value.enabled && !value.busy; buttons();
  }
  function buttons() {
    refresh.disabled = pending; start.disabled = pending || !latest || latest.state === "closed";
    stop.disabled = pending || latest?.state === "stopping";
  }
  async function request(method, message) {
    if (pending || !active()) return;
    const ticket = ++revision; pending = true; refresh.disabled = start.disabled = stop.disabled = true;
    try { const value = await method(); if (ticket === revision) render(value); }
    catch { if (active() && ticket === revision) note.textContent = message; }
    finally { pending = false; if (active()) buttons(); }
  }
  const unsubscribe = methods.onChange(value => { revision++; render(value); });
  refresh.onclick = () => request(() => methods.status(), "同步状态不可用，请检查登录与企业配置。");
  start.onclick = () => request(() => methods.start(), "同步未开启，请检查登录与企业配置。");
  stop.onclick = () => request(() => methods.stop(), "停止结果尚未确认，请刷新状态。");
  void refresh.onclick();
  return { dispose() { disposed = true; revision++; unsubscribe(); } };
}
