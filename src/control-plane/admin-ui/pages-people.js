// 成员: everybody who has used i豆 here, and one person in full.
import { api } from "./api.js";
import { h, clear, pageHead, panel, table, pager, personCell, statusPill, pill, ago, dateTime, tokens, fmt, confirm, toast, errorBanner,
  segmented, select, searchInput, section, kv, avatar, copyButton, bars, shortDay, empty, icon } from "./ui.js";
import { actionLabel, auditTimeline } from "./pages-data.js";

const positions = new Map();   // filter → the page positions passed, for "上一页"

export async function peoplePage(view, ctx) {
  const params = { q: ctx.params.q ?? "", status: ctx.params.status ?? "all", active: ctx.params.active ?? "", sort: ctx.params.sort ?? "active", department: ctx.params.department ?? "" };
  const key = JSON.stringify(params);
  const stack = positions.get(key) ?? [];
  positions.clear(); positions.set(key, stack);
  const cursor = stack.length ? stack.at(-1).next : null;
  const page = await api.get("people", { ...params, cursor, limit: 50 });
  if (ctx.stale()) return;
  const manage = ctx.can("people.manage");
  const change = (next) => ctx.navigate("people", { ...params, ...next });
  const selected = new Set();

  view.append(pageHead("成员", "用过 i豆 的人，按最近在线排列。停用后，他在所有设备上立刻退出，并且不能再登录，直到恢复。",
    manage ? [h("button", { class: "button", type: "button", text: "批量处理", onclick: () => bulkDialog(ctx) })] : []));

  const bulkbar = h("div", { class: "bulkbar hidden" });
  const drawBulk = () => {
    clear(bulkbar).classList.toggle("hidden", selected.size === 0);
    if (!selected.size) return;
    const ids = [...selected];
    bulkbar.append(h("b", { text: `已选 ${selected.size} 人` }),
      h("button", { class: "button small", type: "button", text: "下线", onclick: () => bulk(ctx, "sign-out", ids) }),
      h("button", { class: "button small danger", type: "button", text: "停用", onclick: () => bulk(ctx, "disable", ids) }),
      h("button", { class: "button small", type: "button", text: "恢复", onclick: () => bulk(ctx, "enable", ids) }),
      h("span", { class: "spacer" }),
      h("button", { class: "button small ghost", type: "button", text: "取消选择", onclick: () => { selected.clear(); for (const box of view.querySelectorAll("td.check input")) box.checked = false; allBox.checked = false; drawBulk(); markRows(); } }));
  };
  const markRows = () => { for (const row of view.querySelectorAll("tbody tr")) row.classList.toggle("selected", row.querySelector("td.check input")?.checked === true); };
  const allBox = h("input", { type: "checkbox", "aria-label": "全选本页", onchange: () => {
    for (const box of view.querySelectorAll("td.check input")) { box.checked = allBox.checked; if (allBox.checked) selected.add(box.value); else selected.delete(box.value); }
    drawBulk(); markRows();
  } });

  const columns = [
    { label: "成员", cell: (person) => personCell(person) },
    { label: "状态", cell: (person) => h("span", { title: person.access.disabled && person.access.reason ? `原因：${person.access.reason}` : "" }, statusPill(person.access)) },
    { label: "最近在线", cell: (person) => h("span", {}, ago(person.lastSeenAt), h("span", { class: "sub", text: dateTime(person.lastSeenAt) })) },
    { label: "首次使用", cell: (person) => dateTime(person.firstSeenAt).slice(0, 10) },
    { label: "近 30 天 token", num: true, cell: (person) => tokens(person.usage30d.tokens) },
    { label: "桌面版本", cell: (person) => person.client ? h("span", { class: "mono muted", text: person.client.replace(/^0\.1\.0-/, "") }) : "—" },
  ];
  if (manage) columns.push({ label: "", cell: (person) => person.userId === ctx.me.user.userId ? h("span", { class: "faint", text: "自己" }) : h("span", { class: "nowrap" },
    h("button", { class: "button small ghost", type: "button", text: "下线", onclick: () => signOut(ctx, person) }),
    person.access.disabled
      ? h("button", { class: "button small ghost", type: "button", text: "恢复", onclick: () => enable(ctx, person) })
      : h("button", { class: "button small ghost danger", type: "button", text: "停用", onclick: () => disable(ctx, person) })) });

  view.append(panel(
    h("div", { class: "filters" },
      searchInput(params.q, (q) => change({ q }), "按姓名或 open_id 搜索"),
      segmented([["all", "全部"], ["enabled", "正常"], ["disabled", "已停用"]], params.status, (status) => change({ status }), "状态"),
      select([["", "任何时间在线"], ["1d", "今天在线"], ["7d", "7 天内在线"], ["30d", "30 天内在线"], ["inactive30d", "30 天没有在线"]], params.active, (active) => change({ active }), "在线时间"),
      page.scoped && !page.department ? h("span", { class: "tag", title: ctx.me.scope.map((d) => d.trail.join(" / ")).join("；") }, "范围：你管理的部门") : null,
      page.department ? h("span", { class: "tag" }, `部门：${page.department.name}（含下级）`,
        h("button", { class: "copy", type: "button", text: "✕", "aria-label": "不按部门", onclick: () => change({ department: "" }) })) : null,
      h("span", { class: "spacer" }),
      select([["active", "按最近在线"], ["name", "按姓名"], ["first", "按首次使用"]], params.sort, (sort) => change({ sort }), "排序")),
    bulkbar,
    table({ columns, rows: page.people, onRow: (person) => { window.location.hash = `#/people/${encodeURIComponent(person.userId)}`; },
      emptyText: params.q || params.status !== "all" || params.active ? "没有符合条件的成员" : "还没有人用过 i豆",
      selectable: manage ? { all: allBox, box: (person) => h("input", { type: "checkbox", value: person.userId, "aria-label": `选择 ${person.name}`,
        onchange: (event) => { if (event.target.checked) selected.add(person.userId); else selected.delete(person.userId); drawBulk(); markRows(); } }) } : null }),
    pager({ stack, next: page.next, total: stack.length ? null : page.total, shown: page.people.length, onMove: (step) => {
      if (step > 0) stack.push({ next: page.next }); else stack.pop();
      ctx.navigate("people", params, { replace: true });
    } })));
  view.append(h("p", { class: "note", text: "「最近在线」是桌面端最近一次登录或续期的时间（打开着 i豆 时约每 13 分钟一次）。名字是飞书在他登录时给的。" }));
}

async function signOut(ctx, person) {
  const answer = await confirm({ title: `让 ${person.name || person.userId} 在所有设备上退出？`,
    message: "他的每台电脑都会立刻退出，需要重新扫码登录；设备上保存的登录凭据也一并作废。正在生成的回答最多再持续几分钟。账号不受影响。", confirmText: "全部退出" });
  if (!answer) return;
  try {
    const result = await api.post(`people/${encodeURIComponent(person.userId)}/sign-out`);
    toast(result.sessions ? `已让他在 ${result.sessions} 个登录上退出` : "已退出（他当前没有在线的设备）");
    ctx.navigate(...currentRoute(), { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}
async function disable(ctx, person) {
  const answer = await confirm({ title: `停用 ${person.name || person.userId}？`, danger: true, confirmText: "停用",
    message: "停用后他会在所有设备上立刻退出，不能再登录 i豆、不能打开文档网站，他的定时任务会暂停。数据不会删除，随时可以恢复。",
    reason: { label: "原因", placeholder: "例如：离职、账号异常、安全调查", help: "原因会写进审计日志，并显示在他的成员详情里。" } });
  if (!answer) return;
  try {
    await api.post(`people/${encodeURIComponent(person.userId)}/disable`, { reason: answer.reason });
    toast("已停用");
    ctx.navigate(...currentRoute(), { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}
async function enable(ctx, person) {
  const answer = await confirm({ title: `恢复 ${person.name || person.userId}？`, confirmText: "恢复",
    message: "恢复后他可以重新登录 i豆。停用前的登录不会自动恢复，需要他自己重新登录；暂停的定时任务也要他自己重新开启。" });
  if (!answer) return;
  try {
    await api.post(`people/${encodeURIComponent(person.userId)}/enable`);
    toast("已恢复");
    ctx.navigate(...currentRoute(), { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}
async function bulk(ctx, action, userIds) {
  const words = { "sign-out": ["下线", "这些人的每台电脑都会立刻退出，需要重新登录。"], disable: ["停用", "这些人会立刻退出，不能再登录，定时任务暂停。数据不会删除。"], enable: ["恢复", "这些人可以重新登录。"] }[action];
  const answer = await confirm({ title: `${words[0]} ${userIds.length} 人？`, message: words[1], danger: action === "disable", confirmText: words[0],
    reason: action === "disable" ? { label: "原因", placeholder: "例如：本月离职名单" } : null });
  if (!answer) return;
  try {
    const result = await api.post("people/bulk", { action, userIds, reason: answer.reason });
    toast(`${words[0]}：${result.changed} 人有变化${result.skipped?.length ? `，跳过 ${result.skipped.length} 人（自己或配置文件里的超级管理员）` : ""}`);
    ctx.navigate(...currentRoute(), { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}
// An HR list, pasted: one open_id per line.
async function bulkDialog(ctx) {
  const area = h("textarea", { class: "input", rows: 8, placeholder: "ou_xxxxxxxx\nou_yyyyyyyy", spellcheck: "false" });
  const actionSelect = h("select", { class: "select" }, h("option", { value: "disable", text: "停用" }), h("option", { value: "sign-out", text: "下线" }), h("option", { value: "enable", text: "恢复" }));
  const answer = await confirm({ title: "批量处理", confirmText: "下一步",
    message: "粘贴 open_id，每行一个，最多 1000 个。没有用过 i豆 的人也可以先停用，他以后无法登录。",
    extra: h("div", { class: "grid" }, h("div", { class: "field" }, h("label", { text: "操作" }), actionSelect), h("div", { class: "field" }, h("label", { text: "open_id" }), area)) });
  if (!answer) return;
  const ids = [...new Set(area.value.split(/[\s,，;；]+/).map((id) => id.trim()).filter(Boolean))];
  const invalid = ids.filter((id) => !/^ou_[A-Za-z0-9_-]{1,128}$/.test(id));
  if (!ids.length) { toast("没有填 open_id", "bad"); return; }
  if (invalid.length) { toast(`这些不是 open_id：${invalid.slice(0, 3).join("、")}${invalid.length > 3 ? " 等" : ""}`, "bad"); return; }
  if (ids.length > 1000) { toast("一次最多 1000 个", "bad"); return; }
  await bulk(ctx, actionSelect.value, ids);
}
function currentRoute() {
  const [path, search = ""] = window.location.hash.replace(/^#\/?/, "").split("?");
  return [path || "people", Object.fromEntries(new URLSearchParams(search))];
}

// ---------------------------------------------------------------- one person
export async function personPage(view, ctx) {
  const detail = await api.get(`people/${encodeURIComponent(ctx.id)}`);
  if (ctx.stale()) return;
  const { person, access, usage, devices, inventory } = detail;
  const manage = ctx.can("people.manage");
  const name = person.name || "（还没有登录过）";
  ctx.setCrumbs({ text: "成员", href: "#/people" }, { text: person.name || person.userId });

  const self = person.userId === ctx.me.user.userId;
  const actions = manage && !self ? [
    h("button", { class: "button", type: "button", onclick: () => signOut(ctx, person) }, icon("out"), "下线所有设备"),
    access.disabled ? h("button", { class: "button primary", type: "button", text: "恢复账号", onclick: () => enable(ctx, person) })
      : h("button", { class: "button danger", type: "button", text: "停用账号", onclick: () => disable(ctx, person) }),
    ctx.can("offboard") && ctx.me.features.offboard ? h("button", { class: "button danger solid", type: "button", text: "离职清理", onclick: () => offboard(ctx, person) }) : null,
  ].filter(Boolean) : [];
  view.append(panel(h("div", { class: "profile-head" }, avatar(person.name, person.userId, true),
    h("div", {}, h("h1", {}, name, statusPill(access), detail.adminRole ? pill(detail.adminRole.roleName, "accent") : null),
      h("div", { class: "ids" }, h("span", { class: "mono", text: person.userId }), copyButton(person.userId), " · 租户 ", h("span", { class: "mono", text: person.tenantId }))),
    h("div", { class: "page-actions" }, actions))));

  if (access.disabled) {
    view.append(h("div", { class: "section" }, h("div", { class: "status-banner bad" }, h("b", { text: "已停用" }),
      h("span", { text: `${dateTime(access.changedAt)} 由 ${access.changedBy?.name || access.changedBy?.userId || "管理员"} 停用${access.reason ? `。原因：${access.reason}` : "。"}` }))));
  } else if (access.signedOutAt) {
    view.append(h("div", { class: "section" }, h("div", { class: "info-banner", text: `${dateTime(access.signedOutAt)} 管理员让他在所有设备上退出过；那之前的登录都已作废。` })));
  }
  if (!detail.known) view.append(h("div", { class: "section" }, h("div", { class: "info-banner", text: "这个人还没有登录过 i豆，所以没有名字和用量。可以先停用，他以后就无法登录。" })));

  view.append(h("div", { class: "section split" },
    h("div", {},
      section("用量（近 30 天）", usage ? `合计 ${tokens(usage.byDay.reduce((sum, day) => sum + day.tokens, 0))} token` : "",
        panel(h("div", { class: "panel-body" }, usage && usage.byDay.some((day) => day.tokens)
          ? bars(usage.byDay, { value: (day) => day.tokens, label: (day) => shortDay(day.day), format: tokens, height: 170 })
          : empty("近 30 天没有用量")),
        usage?.byModel.length ? table({ columns: [
          { label: "模型", cell: (row) => row.model },
          { label: "请求", num: true, cell: (row) => fmt(row.requests) },
          { label: "token", num: true, cell: (row) => tokens(row.tokens) },
          { label: "被降级", num: true, cell: (row) => fmt(row.downgraded) },
          { label: "最近一次", cell: (row) => ago(row.lastAt) },
        ], rows: usage.byModel }) : null)),
      section("最近的活动", "他自己做的事：登录、写入飞书、定时任务……只有动作，没有内容", panel(auditTimeline(detail.activity, { showActor: false })))),
    h("div", {},
      section("基本信息", "", panel(h("div", { class: "panel-body" }, kv([
        ["首次使用", dateTime(person.firstSeenAt)],
        ["最近在线", person.lastSeenAt ? `${ago(person.lastSeenAt)}（${dateTime(person.lastSeenAt)}）` : "—"],
        ["登录次数", fmt(person.signIns)],
        ["桌面版本", person.client || "—"],
        ["管理角色", detail.adminRole ? `${detail.adminRole.roleName}（${{ configured: "配置文件", chat: "管理员群", granted: "后台授予" }[detail.adminRole.source] ?? detail.adminRole.source}）` : "无"],
        detail.organisation ? ["所在部门", detail.organisation.departments.length
          ? h("span", {}, detail.organisation.departments.map((department, index) => [index ? h("br") : null, h("a", { href: `#/people?department=${encodeURIComponent(department.id)}`, text: department.path.join(" / ") })]))
          : "—"] : null,
        detail.organisation ? ["飞书在职状态", detail.organisation.employment === "resigned"
          ? h("span", {}, pill("飞书显示已离职", "bad"), h("span", { class: "sub", text: `发现于 ${dateTime(detail.organisation.departedAt)}` }))
          : h("span", {}, "在职", h("span", { class: "sub", text: `核对于 ${dateTime(detail.organisation.checkedAt)}` }))] : null,
      ])))),
      section("在线的设备", devices ? `${devices.length} 台` : "", panel(devices?.length
        ? h("ul", { class: "timeline" }, devices.map((device) => h("li", {}, h("time", { text: device.signedInAt ? dateTime(device.signedInAt) : "—" }),
          h("span", {}, "设备 ", h("span", { class: "mono", text: device.device })), h("span", { class: "muted", text: `会话到 ${dateTime(device.expiresAt).slice(11)}` }))))
        : empty("当前没有在线的设备"))),
      inventoryPanel(inventory, ctx, person, detail),
      section("管理员对他的操作", "", panel(auditTimeline(detail.adminActions, { showActor: true }))))));
}

// Somebody leaves: what goes, what goes offline, what stays -- read from the
// server first, then confirmed by typing their name.
async function offboard(ctx, person) {
  let preview;
  try { preview = await api.get(`people/${encodeURIComponent(person.userId)}/offboard`); } catch (error) { toast(error.message, "bad"); return; }
  const inventory = preview.inventory ?? {};
  // Those offboarding takes down: up, waiting for review, or held (person-data.js goesOffline).
  const live = (inventory.sites ?? []).filter((site) => site.withdrawn ?? !site.offline);
  const reservations = Array.isArray(inventory.reservations) ? inventory.reservations.length : Number(inventory.reservations ?? 0);
  const line = (label, value) => h("li", {}, h("b", { text: `${label}：` }), value);
  const extra = h("div", { class: "grid" },
    h("div", {}, h("p", { class: "muted", text: "先停用他，并让他在所有设备上退出；正在运行的定时任务会被停下。然后：" })),
    h("ul", { class: "plain-list" },
      line("删除", `定时任务 ${fmt(inventory.tasks?.schedules ?? 0)} 个和运行记录 ${fmt(inventory.tasks?.runs ?? 0)} 条；`
        + `${inventory.credential ? "无人值守授权；" : ""}${inventory.model ? "选用的模型；" : ""}云盘额度记录 ${fmt(reservations)} 条`),
      line("下线、文件保留", live.length ? `${live.length} 个网站（${live.map((site) => site.name).join("、")}）——同事可能还在用，链接会立刻失效，要不要删由你之后决定` : "没有在线的网站"),
      line("保留", "用量计数和审计记录（企业的账目），成员列表里的名字"),
      line("不在这里处理", "他在飞书里的账号、云盘和群，按飞书的离职流程处理")));
  const answer = await confirm({ title: `离职清理：${person.name || person.userId}`, danger: true, confirmText: "清理", typed: preview.confirm, extra,
    message: "这一步删除的数据不能恢复。" });
  if (!answer) return;
  try {
    const result = await api.post(`people/${encodeURIComponent(person.userId)}/offboard`, { confirm: preview.confirm });
    toast(`已清理：定时任务 ${result.done.tasks} 个、运行记录 ${result.done.runs} 条，下线网站 ${result.done.sitesOffline} 个`);
    ctx.navigate(...currentRoute(), { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}

function inventoryPanel(inventory, ctx, person, detail) {
  if (!inventory) return null;
  if (inventory.error) return section("他在服务端的数据", "", errorBanner(new Error(inventory.error)));
  const credential = inventory.credential;
  const stopControl = detail.tasksStopped === null || !ctx.can("policy.manage") ? null : detail.tasksStopped
    ? h("span", {}, pill("管理员已停止", "bad"), h("button", { class: "button small ghost", type: "button", text: "允许", onclick: () => taskControl(ctx, person, "allow") }))
    : inventory.tasks?.schedules ? h("button", { class: "button small ghost danger", type: "button", text: "停止他的定时任务", onclick: () => taskControl(ctx, person, "stop") }) : null;
  const revokeControl = credential && ctx.can("people.manage")
    ? h("button", { class: "button small ghost danger", type: "button", text: "撤销", onclick: () => revokeUnattended(ctx, person) }) : null;
  return section("他在服务端的数据", "离职清理时会处理这些", panel(h("div", { class: "panel-body" }, kv([
    ["定时任务", h("span", { class: "control-line" }, inventory.tasks ? `${fmt(inventory.tasks.schedules)} 个，运行记录 ${fmt(inventory.tasks.runs)} 条` : "未开启定时任务", stopControl)],
    ["无人值守授权", h("span", { class: "control-line" }, credential ? `${{ active: "有效", needs_reauthorization: "需要重新授权" }[credential.state] ?? credential.state}${credential.expiresAt ? `，到 ${dateTime(credential.expiresAt).slice(0, 10)}` : ""}` : "没有", revokeControl)],
    ["选用的模型", inventory.model || "跟随默认"],
    ["发布的网站", inventory.sites?.length ? h("span", {}, inventory.sites.map((site, index) => [index ? "、" : "", site.name, site.offline ? "（已下线）" : ""])) : "没有"],
    ["云盘额度记录", inventory.reservations === null ? "—" : `${fmt(Array.isArray(inventory.reservations) ? inventory.reservations.length : inventory.reservations)} 条`],
  ]))));
}
// Stopping somebody's tasks is their policy's 定时任务 switch; allowing them
// again clears it.
export async function taskControl(ctx, person, action) {
  const who = person.name || person.userId;
  const answer = await confirm(action === "stop"
    ? { title: `停止 ${who} 的定时任务？`, danger: true, confirmText: "停止",
      message: "他的每个定时任务到点都不再运行（已经在跑的这一次会跑完），他也不能新建。任务本身和运行记录不删除。做法是在他的策略规则里把「定时任务」关掉，在「策略」页能看到；随时可以恢复。" }
    : { title: `允许 ${who} 的定时任务？`, confirmText: "允许", message: "从他的策略规则里去掉「定时任务：关」。被暂停的任务要他在 i豆 里重新授权后才会继续。" });
  if (!answer) return;
  try {
    await api.post(`people/${encodeURIComponent(person.userId)}/tasks/${action}`);
    toast(action === "stop" ? "已停止" : "已允许");
    ctx.navigate(...currentRoute(), { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}
// The long-lived credential a person left with the server for their tasks.
export async function revokeUnattended(ctx, person) {
  const answer = await confirm({ title: `撤销 ${person.name || person.userId} 的无人值守授权？`, danger: true, confirmText: "撤销",
    message: "服务端删掉他留下的长期飞书凭据，正在用它跑的任务立刻停止；之后他的定时任务只在他登录着 i豆 时才能运行，直到他重新授权。飞书那边给应用的授权不受影响，要撤销得由他在飞书「设置 - 应用授权」里做。" });
  if (!answer) return;
  try {
    const result = await api.post(`people/${encodeURIComponent(person.userId)}/unattended/revoke`);
    toast(result.changed ? "已撤销" : "他已经没有无人值守授权了");
    ctx.navigate(...currentRoute(), { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}
export { actionLabel };
