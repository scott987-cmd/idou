export function appReviewUi({ api, element, action }) {
  const modal = document.querySelector("#app-review"), content = document.querySelector("#app-review-content"), notice = document.querySelector("#app-review-notice");
  const footer = document.querySelector("#app-review-footer");
  let epoch = 0;
  const current = value => modal.open && epoch === value;
  const readError = (error, revision) => { if (current(revision)) notice.textContent = `本次读取未完成：${error.message.replace(/^Error invoking remote method '[^']+': Error: /, "")}`; throw error; };
  const load = async (cursor = null) => {
    const revision = ++epoch; content.replaceChildren(); footer.replaceChildren(); notice.textContent = "正在读取当前账号的待审清单…";
    const result = await api.listAppReviews(cursor).catch(error => readError(error, revision)); if (!current(revision)) return;
    notice.textContent = result.candidates.length ? "选择版本查看完整文件清单。列表不包含你自己的应用。" : "当前页没有待审版本。仅企业配置的审核人可访问。";
    for (const row of result.candidates) {
      const button = element("button", undefined, "app-review-choice");
      button.append(element("strong", row.title), element("small", `版本 ${row.digest.slice(0, 16)} · ${new Date(row.createdAt).toLocaleString("zh-CN")}`));
      button.onclick = () => action(() => read(row.appId, row.digest)); content.append(button);
    }
    if (result.nextCursor) { const more = element("button", "下一页"); more.id = "app-review-next"; more.onclick = () => action(() => load(result.nextCursor)); content.append(more); }
  };
  const read = async (id, digest) => {
    const revision = ++epoch; content.replaceChildren(); footer.replaceChildren(); notice.textContent = "正在重新核验审核权限与版本…";
    const row = await api.readAppReview(id, digest).catch(error => readError(error, revision)); if (!current(revision)) return;
    notice.textContent = row.state === "withdrawn" ? "版本已撤回，不能提交审核结论。" : row.review ? "已有不可覆盖的审核结论。清单通过不代表允许部署。" : "清单核对后填写说明；提交前还需在应用内确认。";
    content.append(element("h3", row.title), element("small", `应用 ${row.appId}`), element("code", row.digest), element("p", `声明：静态应用 · 禁止网络 · 入口 ${row.manifest.entry} · ${row.manifest.files.length} 个文件`));
    const files = element("div", undefined, "app-review-files");
    for (const file of row.manifest.files) { const item = element("div"); item.append(element("strong", file.path), element("span", `${file.bytes} 字节`), element("code", file.sha256)); files.append(item); }
    content.append(files);
    if (row.review) content.append(element("p", `${row.review.decision === "approved" ? "清单通过" : "退回修改"} · ${new Date(row.review.reviewedAt).toLocaleString("zh-CN")}`), element("pre", row.review.note));
    const refresh = element("button", "重新读取此版本"); refresh.id = "refresh-app-review-version"; refresh.onclick = () => action(() => read(id, digest));
    if (!row.review && row.state === "submitted") {
      const label = element("label", "审核说明（必填，最多 1000 字）"), note = element("textarea"); note.id = "app-review-note"; note.maxLength = 1000; note.rows = 3; label.append(note); content.append(label);
      const actions = element("div", undefined, "app-review-actions");
      for (const [decision, title] of [["approved", "清单通过…"], ["rejected", "退回修改…"]]) {
        const button = element("button", title); button.id = `app-review-${decision}`;
        button.onclick = () => action(async () => {
          if (!note.value.trim()) { notice.textContent = "请先填写审核说明。"; return; }
          const buttons = [...actions.querySelectorAll("button")]; buttons.forEach(node => { node.disabled = true; });
          try {
            const result = await api.decideAppReview(row.handle, decision, note.value);
            if (!current(revision)) return;
            if (!result) { buttons.forEach(node => { node.disabled = false; }); notice.textContent = "已取消，未提交审核结论。"; return; }
            await read(id, digest);
          } catch (error) {
            if (current(revision)) notice.textContent = "未确认本次提交结果，请重新读取此版本核查；不会自动重试。";
            throw error;
          }
        }); actions.append(button);
      }
      footer.append(actions);
    }
    footer.append(refresh);
  };
  const close = () => { epoch++; modal.close(); content.replaceChildren(); footer.replaceChildren(); notice.textContent = ""; void api.closeAppReview().catch(() => {}); };
  document.querySelector("#close-app-review").onclick = close;
  document.querySelector("#refresh-app-reviews").onclick = () => action(() => load());
  modal.addEventListener("cancel", event => { event.preventDefault(); close(); });
  return { close, async open() { modal.showModal(); await load(); } };
}
