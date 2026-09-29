export function appRuntimeUi({ api, element, action }) {
  const modal = document.querySelector("#app-runtime"), content = document.querySelector("#app-runtime-content"), footer = document.querySelector("#app-runtime-footer"), notice = document.querySelector("#app-runtime-notice");
  let epoch = 0;
  const current = revision => modal.open && revision === epoch;
  const failed = (error, revision) => { if (current(revision)) notice.textContent = `本次读取未完成：${error.message.replace(/^Error invoking remote method '[^']+': Error: /, "")}`; throw error; };
  const load = async (cursor = null) => {
    const revision = ++epoch; content.replaceChildren(); footer.replaceChildren(); notice.textContent = "正在核验运行操作员权限…";
    const result = await api.listAppRuntimes(cursor).catch(error => failed(error, revision)); if (!current(revision)) return;
    notice.textContent = result.candidates.length ? "选择已通过清单审核、已记录归档且未撤回的版本。" : "当前页没有可验收版本；不会自动申请许可。";
    for (const row of result.candidates) {
      const button = element("button", undefined, "app-runtime-choice"); button.append(element("strong", row.title), element("small", `版本 ${row.digest.slice(0, 16)} · ${new Date(row.createdAt).toLocaleString("zh-CN")}`));
      button.onclick = () => action(() => read(row.appId, row.digest)); content.append(button);
    }
    if (result.nextCursor) { const next = element("button", "下一页"); next.onclick = () => action(() => load(result.nextCursor)); content.append(next); }
  };
  const read = async (id, digest) => {
    const revision = ++epoch; content.replaceChildren(); footer.replaceChildren(); notice.textContent = "正在重新核对版本和目标节点…";
    const row = await api.readAppRuntime(id, digest).catch(error => failed(error, revision)); if (!current(revision)) return;
    const binding = row.binding;
    notice.textContent = "尚未签发许可。下一步选择导出目录，并在原生窗口中确认。";
    content.append(element("h3", row.title), element("small", `应用 ${binding.appId}`), element("code", binding.digest), element("p", `节点 ${binding.nodeId} · 包大小 ${binding.bytes} 字节`), element("code", `镜像 ${binding.imageId}`), element("code", `包摘要 ${binding.sha256}`));
    const files = element("div", undefined, "app-review-files");
    for (const file of row.manifest.files) { const line = element("div"); line.append(element("strong", file.path), element("span", `${file.bytes} 字节`), element("code", file.sha256)); files.append(line); }
    content.append(files, element("p", "有效期最长 5 分钟。仅交给受信任节点；签发会撤销本次登录会话的旧运行许可，可能停止此前验收。许可不包含源码或模型密钥。"));
    const refresh = element("button", "重新读取此版本"), button = element("button", "签发并导出许可…"); button.id = "export-app-runtime"; refresh.id = "refresh-app-runtime-version";
    refresh.onclick = () => action(() => read(id, digest));
    button.onclick = () => action(async () => {
      button.disabled = true;
      try {
        const result = await api.exportAppRuntime(row.handle); if (!current(revision)) return;
        if (!result) { button.disabled = false; notice.textContent = "已取消，未签发运行许可。"; return; }
        notice.textContent = `许可已导出，有效至 ${new Date(result.expiresAt).toLocaleTimeString("zh-CN")}；节点尚未启动，应用未部署。`;
        const delivered = element("section", undefined, "runtime-export-result");
        delivered.append(element("p", "私有许可文件（仅交给受信任运行节点）"), element("code", result.filename));
        content.prepend(delivered); content.scrollTop = 0; button.remove();
      } catch (error) {
        if (current(revision)) notice.textContent = "未确认本次导出结果，请重新读取后核查；旧许可可能已撤销，不会自动重新签发。";
        throw error;
      }
    }); footer.append(button, refresh);
  };
  const close = () => { epoch++; modal.close(); content.replaceChildren(); footer.replaceChildren(); notice.textContent = ""; void api.closeAppRuntime().catch(() => {}); };
  document.querySelector("#close-app-runtime").onclick = close; document.querySelector("#refresh-app-runtimes").onclick = () => action(() => load());
  modal.addEventListener("cancel", event => { event.preventDefault(); close(); });
  return { close, async open() { modal.showModal(); await load(); } };
}
