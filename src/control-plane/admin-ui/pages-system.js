// 概览, 管理员与角色, 服务状态, 文档网站.
import { api } from "./api.js";
import { h, clear, pageHead, panel, table, personCell, pill, ago, dateTime, tokens, fmt, section, stat, bars, shortDay, sparkline, empty, kv,
  confirm, toast, avatar, searchInput, segmented } from "./ui.js";
import { auditTimeline } from "./pages-data.js";
import { departmentPicker } from "./pages-org.js";

const LEVELS = { ok: ["正常", "ok"], warning: ["告警", "warn"], critical: ["严重", "bad"] };
const levelPill = (level) => pill(...(LEVELS[level] ?? [level ?? "未知", ""]));
const ORDER = { critical: 0, warning: 1, ok: 2 };

// ---------------------------------------------------------------- overview
export async function overviewPage(view, ctx) {
  const data = await api.get("overview");
  if (ctx.stale()) return;
  const { people, usage, checks, models } = data;
  if (data.scoped) {
    const where = ctx.me.scope.length ? ctx.me.scope.map((d) => d.name).join("、") : "（原来的部门已不在通讯录里）";
    view.append(pageHead("概览", `${ctx.me.user.name || ctx.me.user.userId}，你好。这里是你管理的部门：${where}。`));
    view.append(h("div", { class: "grid cols-2" },
      stat({ label: "成员", value: fmt(people.total), unit: "人", sub: [`今天在线 ${fmt(people.activeDay)}`, `7 天 ${fmt(people.activeWeek)}`, `30 天新增 ${fmt(people.newMonth)}`] }),
      stat({ label: "已停用", value: fmt(people.disabled), unit: "人", sub: [h("a", { href: "#/people?status=disabled", text: "查看名单" })] })));
    view.append(section("最近的管理操作", "你管理的人", panel(auditTimeline(data.recent, { showActor: true }), h("div", { class: "table-foot" }, h("a", { href: "#/audit?category=admin&days=30", text: "全部管理操作 →" })))));
    return;
  }
  const series = usage?.byDay ?? [];
  const today = series.at(-1), yesterday = series.at(-2);
  const bad = (checks?.checks ?? []).filter((check) => check.level !== "ok").sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  view.append(pageHead("概览", `${ctx.me.user.name || ctx.me.user.userId}，你好。这里是这个租户在 i豆 上的情况。`));
  view.append(h("div", { class: "grid cols-4" },
    stat({ label: "成员", value: fmt(people.total), unit: "人", sub: [`今天在线 ${fmt(people.activeDay)}`, `7 天 ${fmt(people.activeWeek)}`, `30 天新增 ${fmt(people.newMonth)}`] }),
    stat({ label: "已停用", value: fmt(people.disabled), unit: "人", sub: [h("a", { href: "#/people?status=disabled", text: "查看名单" })] }),
    stat({ label: "今天 token", value: tokens(today?.tokens ?? 0), sub: [yesterday ? `昨天 ${tokens(yesterday.tokens)}` : "", today ? `${fmt(today.people)} 人用过` : ""],
      spark: series.length ? sparkline(series.map((day) => day.tokens)) : null }),
    stat({ label: "服务状态", value: levelPill(checks?.level ?? "ok"), sub: [checks ? `${checks.checks.length} 项自检，${bad.length ? `${bad.length} 项需要处理` : "全部正常"}` : "还没有自检结果"] })));
  view.append(h("div", { class: "section split" },
    section("最近 14 天每天用过的人", usage ? "" : "没有开启用量记账", panel(h("div", { class: "panel-body" },
      series.some((day) => day.people) ? bars(series, { value: (day) => day.people, label: (day) => shortDay(day.day), format: fmt, height: 170 }) : empty("最近 14 天没有用量")))),
    section("需要处理", "", panel(bad.length
      ? h("div", {}, bad.slice(0, 5).map((check) => h("div", { class: "check-row" }, h("span", { class: `dot ${check.level}` }), h("div", {}, h("b", { text: check.label }), h("p", { text: check.summary })))))
      : empty("一切正常", "服务端每 5 分钟自检一次")))));
  view.append(h("div", { class: "section split" },
    section("最近的管理操作", "", panel(auditTimeline(data.recent, { showActor: true }), h("div", { class: "table-foot" }, h("a", { href: "#/audit?category=admin&days=30", text: "全部管理操作 →" })))),
    section("模型", "", panel(table({ columns: [
      { label: "模型", cell: (model) => h("span", {}, model.id, model.isDefault ? pill("默认", "accent", true) : null) },
      { label: "现在能不能答", cell: (model) => model.usable === null ? "—" : model.usable ? pill("能答", "ok") : pill("答不了", "bad") },
    ], rows: models ?? [], emptyText: "没有配置模型" })))));
}

// ---------------------------------------------------------------- admins
const ROLE_TEXT = {
  owner: "全部权限，包括授予和收回角色、修改策略。",
  admin: "管理成员（下线、停用、离职清理）、修改策略、管理内容、导出记录。授予时可以限定部门：只管这些部门和下级部门里的人。",
  auditor: "查看全部页面，导出审计和用量；不能修改任何东西。授予时可以限定部门：只看这些部门里的人。",
};
export async function adminsPage(view, ctx) {
  const data = await api.get("admins");
  if (ctx.stale()) return;
  const manage = ctx.can("roles.manage");
  view.append(pageHead("管理员与角色", "三种角色。配置文件里的超级管理员是逃生口，在后台改不了；管理员群里的人自动是管理员；其余由超级管理员在这里授予。",
    manage ? [h("button", { class: "button primary", type: "button", text: "授予角色", onclick: () => grantDialog(ctx, data.roles, data.departments) })] : []));
  view.append(section("角色能做什么", "", panel(table({ columns: [
    { label: "角色", cell: (row) => pill(row.name, row.role === "owner" ? "accent" : "", true) },
    { label: "能做什么", cell: (row) => ROLE_TEXT[row.role] },
  ], rows: data.roles }))));
  view.append(section("后台授予的角色", `${data.granted.length} 人`, panel(table({ columns: [
    { label: "成员", cell: (row) => personCell({ userId: row.userId, name: row.name }) },
    { label: "角色", cell: (row) => pill(row.roleName, row.role === "owner" ? "accent" : "", true) },
    { label: "管理范围", cell: (row) => row.scope ? h("span", {}, row.scope.map((d, index) => [index ? "；" : "", d.name ?? h("span", { class: "faint", text: `${d.id}（已不在通讯录里）` })])) : "整个组织" },
    { label: "授予人", cell: (row) => row.grantedBy?.name || row.grantedBy?.userId || "—" },
    { label: "时间", cell: (row) => dateTime(row.grantedAt) },
    { label: "备注", cell: (row) => row.note || "—" },
    ...(manage ? [{ label: "", cell: (row) => row.userId === ctx.me.user.userId ? h("span", { class: "faint", text: "自己" })
      : h("button", { class: "button small ghost danger", type: "button", text: "收回", onclick: () => revoke(ctx, row) }) }] : []),
  ], rows: data.granted, emptyText: "还没有在后台授予过角色" }))));
  view.append(h("div", { class: "section grid cols-2" },
    section("超级管理员（配置文件）", "IDOU_ADMIN_USERS", panel(data.configured.length
      ? h("ul", { class: "timeline" }, data.configured.map((person) => h("li", {}, h("time", { text: "配置文件" }), personCell(person), h("span", { class: "faint", text: "改要编辑部署配置并重启" }))))
      : empty("没有设置"))),
    section("管理员群", "IDOU_ADMIN_CHAT", panel(h("div", { class: "panel-body" }, data.chat ? kv([
      ["群", h("span", { class: "mono", text: data.chat.chatId })],
      ["群里的人", data.chat.unreadable ? pill("读不到", "bad") : `${fmt(data.chat.members)} 人`],
      data.chat.unreadable ? ["原因", data.chat.unreadable] : null,
    ]) : h("p", { class: "muted", text: "没有设置管理员群。设了以后，群里的人自动成为管理员，在飞书里加人、移人一分钟内生效。" }))))));
}
async function grantDialog(ctx, roles, departments) {
  let picked = null;
  const results = h("div", { class: "search-results", style: { position: "static", "box-shadow": "none", border: "1px solid var(--line)" } }, h("div", { class: "empty", text: "输入姓名搜索" }));
  const choice = h("div", { class: "muted", text: "还没有选人" });
  const roleSelect = h("select", { class: "select" }, roles.map((role) => h("option", { value: role.role, text: role.name, selected: role.role === "auditor" })));
  const note = h("input", { class: "input", maxlength: 200, placeholder: "例如：安全部，负责季度审计" });
  // Over whom: the whole organisation, or some departments and those under them.
  const scope = new Map();
  const chips = h("div", { class: "chips" });
  const drawChips = () => {
    clear(chips);
    if (!scope.size) chips.append(h("span", { class: "muted", text: "整个组织" }));
    for (const [id, department] of scope) chips.append(h("span", { class: "tag" }, department.trail.join(" / "),
      h("button", { class: "copy", type: "button", text: "✕", "aria-label": `去掉 ${department.name}`, onclick: () => { scope.delete(id); drawChips(); } })));
  };
  drawChips();
  const scopeField = departments ? h("div", { class: "field" }, h("label", { text: "管理范围" }), chips,
    departmentPicker((department) => { if (scope.size < 20) scope.set(department.id, department); drawChips(); }, { clearOnPick: true }),
    h("span", { class: "help", text: "不选部门就是整个组织。选了部门，他只能看到、管理这些部门和下级部门里的人；超级管理员总是整个组织。" })) : null;
  const search = searchInput("", async (text) => {
    clear(results);
    if (!text) { results.append(h("div", { class: "empty", text: "输入姓名搜索" })); return; }
    const page = await api.get("people", { q: text, limit: 6 });
    if (!page.people.length) results.append(h("div", { class: "empty", text: "没有找到。这个人需要先登录过一次 i豆。" }));
    for (const person of page.people) {
      results.append(h("a", { href: "#", onclick: (event) => { event.preventDefault(); picked = person; clear(choice).append(personCell(person, { link: false })); } },
        avatar(person.name, person.userId), h("span", { class: "names" }, h("b", { text: person.name || person.userId }), h("span", { class: "muted mono", text: person.userId }))));
    }
  }, "搜索成员");
  const answer = await confirm({ title: "授予角色", confirmText: "授予",
    extra: h("div", { class: "grid" }, h("div", { class: "field" }, h("label", { text: "成员" }), search, results, choice),
      h("div", { class: "field" }, h("label", { text: "角色" }), roleSelect), scopeField, h("div", { class: "field" }, h("label", { text: "备注" }), note)) });
  if (!answer) return;
  if (!picked) { toast("没有选人", "bad"); return; }
  try {
    if (roleSelect.value === "owner" && scope.size) { toast("超级管理员管理整个组织，不能限定部门", "bad"); return; }
    await api.post("admins", { userId: picked.userId, role: roleSelect.value, note: note.value.trim(), scope: [...scope.keys()] });
    toast(`已授予 ${picked.name || picked.userId}`);
    ctx.navigate("admins", {}, { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}
async function revoke(ctx, row) {
  const answer = await confirm({ title: `收回 ${row.name || row.userId} 的${row.roleName}角色？`, danger: true, confirmText: "收回",
    message: "一分钟内生效。如果他在管理员群里，他仍然是管理员。", typed: row.name || row.userId });
  if (!answer) return;
  try {
    await api.remove(`admins/${encodeURIComponent(row.userId)}`);
    toast("已收回");
    ctx.navigate("admins", {}, { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}

// ---------------------------------------------------------------- system
// docs/service-status.md: is the service well, where not, since when, and does
// it need another machine. Every process, not only the one answering.
const ROLE_NAMES = { coordinator: "协调副本", api: "模型副本", worker: "执行节点" };
const CONDITION = { online: ["在线", "ok"], stale: ["可能卡住", "warn"], gone: ["掉线", "bad"], stopped: ["已停止", ""] };
const REFUSAL_NAMES = { perMinute: "超过每分钟次数", server: "服务器同时在答的已满", person: "个人同时在答的已满", quota: "当天额度用完" };
// A latency cell's upper bound; -1 past the last one (process-status.js OVER).
const seconds = (ms) => (ms === null || ms === undefined ? "—" : ms < 0 ? "1 分钟以上" : `${ms / 1000} 秒内`);
const share = (part, whole) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "—");
const megabytes = (bytes) => (Number.isFinite(bytes) ? `${fmt(Math.round(bytes / 1048576))} MB` : "—");
const span = (ms) => { const minutes = Math.max(1, Math.round(ms / 60_000)); return minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.round(minutes / 6) / 10} 小时` : `${Math.round(minutes / 144) / 10} 天`; };

export async function systemPage(view, ctx) {
  const data = await api.get("system");
  if (ctx.stale()) return;
  const status = data.status && !data.status.error ? data.status : null;
  const checks = [...(data.checks?.checks ?? [])].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  const bad = checks.filter((check) => check.level !== "ok");
  const testButton = data.alerts?.bot && ctx.can("policy.manage")
    ? [h("button", { class: "button", type: "button", text: "发送测试告警", onclick: () => testAlert() })] : [];
  view.append(pageHead("服务状态", `服务端每 5 分钟自检一次，每个进程每 20 秒报一次心跳${data.release ? `；当前版本 ${data.release}` : ""}。这一页只读：部署设置在服务器的配置文件里改。`, testButton));
  if (data.status?.error) view.append(h("p", { class: "callout warn", text: `读不到各进程的状态（${data.status.error}）：下面只有这个进程自己知道的。` }));

  const online = status ? status.processes.filter((process) => process.condition === "online") : [];
  const stuck = status ? status.processes.filter((process) => process.condition === "stale") : [];
  const hour = status ? status.traffic.lastHour : null;
  view.append(h("div", { class: "grid cols-4" },
    stat({ label: "总体", value: levelPill(data.checks?.level ?? "ok"), sub: [data.checks ? `${checks.length} 项自检，${bad.length ? `${bad.length} 项需要处理` : "全部正常"}` : "还没有自检结果"] }),
    stat({ label: "进程", value: status ? `${fmt(online.length)} / ${fmt(status.processes.length)}` : "—", unit: "在线",
      sub: [status ? [stuck.length ? `${stuck.length} 个可能卡住` : null, status.mixed ? `版本不一致：${status.releases.join("、")}` : null,
        status.restarted.length ? `近一天意外退出后重启 ${status.restarted.length} 次` : null].filter(Boolean).join("；") || "版本一致"
        : data.status?.error ? "读不到各进程的状态" : "这个服务端还不报心跳"] }),
    stat({ label: "近 1 小时模型请求", value: hour ? fmt(hour.requests) : "—", unit: "次", sub: [hour ? `出错 ${share(hour.errors, hour.requests)}${hour.limited ? `，因次数或容量被拒 ${fmt(hour.limited)}` : ""}` : ""] }),
    stat({ label: "正在答的模型请求", value: status ? `${fmt(status.capacity.model.active)} / ${fmt(status.capacity.model.limit)}` : "—",
      sub: [status ? `${fmt(status.capacity.model.people)} 人在等回答${status.capacity.runs.limit ? `；定时任务 ${status.capacity.runs.active} / ${status.capacity.runs.limit}` : ""}${status.capacity.queued ? `，排队 ${status.capacity.queued}` : ""}` : ""] })));
  if (status?.advice.length) view.append(section("建议", "", panel(h("div", {}, status.advice.map((item) => h("div", { class: "check-row" }, h("span", { class: "dot warning" }), h("div", {}, h("p", { class: "lead", text: item.text }))))))));

  // Self-checks, each with its last day.
  const strips = new Map((status?.health.strips ?? []).map((strip) => [strip.name, strip]));
  view.append(section("自检", data.checks ? `最近一次：${ago(Math.max(0, ...checks.map((check) => check.at ?? 0)))}；色条是最近 24 小时，每格半小时` : "还没有自检结果", panel(checks.length
    ? h("div", {}, checks.map((check) => h("div", { class: "check-row" }, h("span", { class: `dot ${check.level}` }),
      h("div", {}, h("div", { class: "check-head" }, h("b", { text: check.label }), levelPill(check.level), strips.has(check.name) ? strip(strips.get(check.name), status.health) : null),
        h("p", { text: check.summary })))))
    : empty("启动后第一次自检还没有做完"))));

  if (status) {
    view.append(section("故障时间线", "近 7 天，某项变成告警或严重到恢复", panel(table({ columns: [
      { label: "开始", cell: (row) => dateTime(row.from) },
      { label: "项目", cell: (row) => row.label },
      { label: "最严重", cell: (row) => levelPill(row.level) },
      { label: "持续", cell: (row) => row.to ? span(row.to - row.from) : h("span", {}, pill("还没恢复", "bad"), h("span", { class: "sub", text: `已 ${span(status.at - row.from)}` })) },
      { label: "说明", cell: (row) => h("span", { class: "clamp", title: row.summary, text: row.summary }) },
    ], rows: status.health.incidents, emptyText: "近 7 天没有故障" }))));

    view.append(section("进程", `${online.length} 个在线${stuck.length ? `，${stuck.length} 个可能卡住` : ""}${status.workers?.reporting === 0 ? "；执行节点没有上报心跳" : ""}`, panel(table({ columns: [
      { label: "进程", cell: (row) => h("span", {}, h("b", { text: row.name }), h("span", { class: "sub", text: `${ROLE_NAMES[row.role] ?? row.role} · ${row.host} · 进程号 ${row.pid}` })) },
      { label: "状态", cell: (row) => h("span", {}, pill(...CONDITION[row.condition]), h("span", { class: "sub", text: `${row.condition === "stopped" ? "停于" : "心跳"} ${ago(row.beatAt, status.at)}` })) },
      { label: "版本", cell: (row) => h("span", { class: `mono${status.mixed && row.release !== data.release ? " warn-text" : ""}`, text: row.release.replace(/^0\.1\.0-/, "") }) },
      { label: "启动", cell: (row) => ago(row.startedAt, status.at) },
      { label: "负载", cell: (row) => load(row.state) },
      { label: "内存", num: true, cell: (row) => megabytes(row.state.rss) },
      { label: "事件循环", num: true, cell: (row) => Number.isFinite(row.state.loopP99Ms) ? `${fmt(Math.round(row.state.loopP99Ms))} ms` : "—" },
    ], rows: status.processes, emptyText: "还没有进程报心跳" }),
    status.workers?.reporting === 0 ? h("div", { class: "table-foot muted", text: `执行节点没有上报心跳${status.workers.error ? `（${status.workers.error}）` : ""}：在服务器上执行一次 deploy/server/worker-role.sql 授权（可以重复执行）；执行节点照常工作。` }) : null)));

    view.append(section("模型", "近 1 小时和近 24 小时；「开始响应」是从收到请求到上游模型开始返回", panel(table({ columns: [
      { label: "模型", cell: (row) => h("span", {}, row.model, (data.models ?? []).find((model) => model.id === row.model)?.isDefault ? pill("默认", "accent", true) : null) },
      { label: "现在", cell: (row) => usable(row.model, data, status) },
      { label: "1 小时请求", num: true, cell: (row) => fmt(row.hour.requests) },
      { label: "出错", num: true, cell: (row) => share(row.hour.errors, row.hour.requests) },
      { label: "开始响应 p95", num: true, cell: (row) => seconds(row.hour.p95) },
      { label: "24 小时请求", num: true, cell: (row) => fmt(row.day.requests) },
      { label: "出错", num: true, cell: (row) => h("span", { title: `上游出错 ${row.day.upstream} 次，被限流 ${row.day.limited} 次，用户停止 ${row.day.cancelled} 次` }, share(row.day.errors, row.day.requests)) },
      { label: "开始响应 中位 / p95", num: true, cell: (row) => `${seconds(row.day.p50)} / ${seconds(row.day.p95)}` },
    ], rows: modelRows(data, status), emptyText: "近 24 小时没有模型请求" }))));

    const refused = Object.entries(status.traffic.refused).filter(([, count]) => count);
    view.append(h("div", { class: "section split" },
      section("近 24 小时每小时的模型请求", "", panel(h("div", { class: "panel-body" }, status.traffic.hours.some((cell) => cell.requests)
        ? bars(status.traffic.hours, { value: (cell) => cell.requests, label: (cell) => `${new Date(cell.at).getHours()}时`, format: fmt, height: 170 })
        : empty("近 24 小时没有模型请求")))),
      section("被拒的请求", "近 24 小时，按原因", panel(h("div", { class: "panel-body" }, refused.length
        ? kv(refused.map(([reason, count]) => [REFUSAL_NAMES[reason] ?? reason, `${fmt(count)} 次`]))
        : h("p", { class: "muted", text: "近 24 小时没有因为次数、容量或额度被拒的请求。" }))))));

    view.append(h("div", { class: "section split" }, backupSection(status.backup), alertsSection(data.alerts, status.alerts)));
  }

  view.append(section("这个部署允许什么", "", panel(h("div", { class: "panel-body" }, kv([
    ["文档网站", data.deployment.sitesOrigin ?? "未开启"],
    ["免登录访问网站", data.deployment.anonymous ? pill("开着", "warn") : "关着"],
    ["网段白名单", data.deployment.allowlist?.length ? data.deployment.allowlist.join("、") : "没有限制"],
    ["无人值守定时任务", data.deployment.unattended ? "开着" : "关着"],
    ["定时任务沙箱", data.deployment.sandboxMode ?? "—"],
    ["谁能用哪些模型", h("a", { href: "#/policy", text: "在「模型、额度与功能」里看和改 →" })],
  ])))));

  async function testAlert() {
    const ok = await confirm({ title: "发送测试告警？", message: `机器人给你自己（不给别人）私聊一条测试消息，确认机器人和它的权限都通。真正的告警${data.alerts?.enabled ? `发给${data.alerts.users ? "配置里的超级管理员" : ""}${data.alerts.users && data.alerts.chat ? "和" : ""}${data.alerts.chat ? "管理员群的成员" : ""}` : "现在没有开启"}。每分钟最多一次，会写进审计日志。`, confirmText: "发送" });
    if (!ok) return;
    try { await api.post("system/alerts/test"); toast("已发出，去飞书看看有没有收到"); ctx.navigate("system", {}, { replace: true }); }
    catch (error) { toast(error.message, "bad"); }
  }
}

// One check's last day: 48 half hours at their worst; empty where it did not run.
function strip(row, health) {
  return h("span", { class: "strip", role: "img", "aria-label": `${row.label}最近 24 小时` }, row.cells.map((level, index) => h("i", { class: level ?? "none",
    title: `${dateTime(health.stripStart + index * health.cellMs).slice(5)} ${level ? LEVELS[level][0] : "没有检查"}` })));
}
function load(state) {
  const parts = [];
  if (state.model?.limit) parts.push(`模型 ${state.model.active}/${state.model.limit}`);
  if (state.runs?.limit) parts.push(`运行 ${state.runs.active}/${state.runs.limit}`);
  if (state.cli?.limit) parts.push(`飞书命令 ${state.cli.active}/${state.cli.limit}`);
  if (Number.isFinite(state.sessions)) parts.push(`会话 ${fmt(state.sessions)}`);
  return parts.length ? parts.join(" · ") : "—";
}
// Every configured model, with what was asked of it -- one nobody asked is still listed.
function modelRows(data, status) {
  const zero = { requests: 0, errors: 0, upstream: 0, limited: 0, cancelled: 0, p50: null, p95: null };
  const seen = new Map(status.traffic.models.map((row) => [row.model, row]));
  for (const model of data.models ?? []) if (!seen.has(model.id)) seen.set(model.id, { model: model.id, hour: zero, day: zero });
  return [...seen.values()];
}
function usable(model, data, status) {
  const passed = status.unavailable.filter((entry) => entry.model === model);
  if (passed.length) return h("span", { title: passed.map((entry) => `${entry.process}：${entry.reasonText ?? entry.reason}${entry.retryAt ? `，${dateTime(entry.retryAt).slice(5)} 再试` : ""}`).join("\n") },
    pill("答不了", "bad"), h("span", { class: "sub", text: [...new Set(passed.map((entry) => entry.process))].join("、") }));
  const known = (data.models ?? []).find((entry) => entry.id === model);
  return known?.usable === false ? pill("答不了", "bad") : pill("能答", "ok");
}
function backupSection(backup) {
  if (!backup?.configured) return section("备份", "", panel(h("div", { class: "panel-body muted", text: "没有设置 IDOU_BACKUP_DIR：服务端不检查备份。设成备份的 --to 目录后，这里显示最近一次备份，自检里多一项「备份」。" })));
  if (backup.error) return section("备份", "", panel(h("div", { class: "panel-body" }, h("p", { class: "callout warn", text: backup.errorCode === "EACCES"
    ? "读不到备份记录：服务端的账号没有权限读 IDOU_BACKUP_DIR 下的 status.json，看它的属主和权限（手动用别的账号跑过备份时常见）。"
    : `读不到备份记录（${backup.error}）。下一次备份成功后会重写这个文件。` }))));
  const last = backup.last, success = backup.lastSuccess;
  return section("备份", "bin/backup.js 每次写下的记录", panel(h("div", { class: "panel-body" }, last ? kv([
    ["最近一次", h("span", {}, dateTime(Date.parse(last.endedAt)), " ", last.ok ? pill("成功", "ok") : pill("失败", "bad"))],
    last.ok ? null : ["原因", last.error ?? "—"],
    ["最近一次成功", success ? `${dateTime(Date.parse(success.endedAt))}（${ago(Date.parse(success.endedAt))}）` : "还没有成功过"],
    success ? ["大小", `${fmt(success.files)} 个文件，${megabytes(success.bytes)}`] : null,
    success ? ["加密副本", success.sealed ? (success.shipped ? "做了，已送出" : "做了，留在本机") : "没有做（没有 --seal）"] : null,
  ]) : h("p", { class: "muted", text: "备份目录里还没有记录：备份还没跑过，或者服务器上的备份程序是不写记录的旧版。" }))));
}
function alertsSection(config, alerts) {
  const who = config?.enabled ? [config.users ? `${config.users} 位超级管理员` : null, config.chat ? "管理员群的成员" : null].filter(Boolean).join("和") : null;
  return section("告警", config?.enabled ? `发给 ${who}` : "没有开启", panel(
    config?.enabled ? null : h("div", { class: "panel-body muted", text: "设 IDOU_ADMIN_ALERTS=1 后，自检变坏、每天仍未修好、恢复时，机器人私聊每位管理员。没开时自检照常，结论只在这一页和监控端口上。" }),
    table({ columns: [
      { label: "时间", cell: (row) => dateTime(row.at) },
      { label: "级别", cell: (row) => row.test ? pill("测试", "") : levelPill(row.level) },
      { label: "内容", cell: (row) => h("span", { class: "clamp", title: row.text, text: row.text }) },
      { label: "送到", num: true, cell: (row) => row.recipients && row.reached === row.recipients ? `${row.reached} 人` : h("span", { class: "bad-text", text: `${row.reached} / ${row.recipients}` }) },
    ], rows: alerts, emptyText: "还没有发过告警" })));
}

// ---------------------------------------------------------------- sites
const SCOPES = { invited: "仅邀请的人", tenant: "组织内获得链接的人", anyone: "互联网上获得链接的人" };
export async function sitesPage(view, ctx) {
  const params = { q: ctx.params.q ?? "", state: ctx.params.state ?? "", audience: ctx.params.audience ?? "", owner: ctx.params.owner ?? "" };
  const data = await api.get("sites", params);
  if (ctx.stale()) return;
  const manage = ctx.can("content.manage");
  const change = (next) => ctx.navigate("sites", { ...params, ...next });
  view.append(pageHead("文档网站", "这个租户发布的网站：谁发布的、对谁开放、现在的状态。发现不该公开的内容，可以下线它——链接立刻失效，文件保留，发布人不能自己恢复，要由管理员恢复。"));
  view.append(panel(h("div", { class: "filters" }, searchInput(params.q, (text) => change({ q: text }), "按网站名字搜索"),
    segmented([["", "全部"], ["online", "在线"], ["anyone", "公开"], ["review", "待审核"], ["held", "管理员下线"], ["offline", "发布人下线"]], params.state, (state) => change({ state }), "状态"),
    params.owner ? h("span", { class: "tag" }, `发布人：${data.sites[0]?.owner || params.owner}`, h("button", { class: "copy", type: "button", text: "✕", "aria-label": "不按发布人", onclick: () => change({ owner: "" }) })) : null,
    h("span", { class: "spacer" }), h("span", { class: "muted", text: `共 ${fmt(data.total ?? 0)} 个${data.total > data.sites.length ? `，显示前 ${data.sites.length} 个` : ""}` })),
  table({ columns: [
    { label: "网站", cell: (site) => h("span", {}, site.name, h("span", { class: "sub mono", text: site.id.slice(0, 8) })) },
    { label: "发布人", cell: (site) => h("span", {}, personCell({ userId: site.ownerId, name: site.owner }),
      params.owner ? null : h("a", { class: "sub", href: `#/sites?owner=${encodeURIComponent(site.ownerId)}`, text: "他的全部网站" })) },
    { label: "谁能打开", cell: (site) => site.inherit ? "跟随表格权限" : SCOPES[site.scope] ?? site.scope ?? "—" },
    { label: "状态", cell: (site) => site.held ? h("span", { title: `${site.held.by?.name || "管理员"} 于 ${dateTime(site.held.at)} 下线：${site.held.reason}` }, pill("管理员下线", "bad"), h("span", { class: "sub", text: site.held.reason }))
      : site.review ? h("span", { title: site.review.reason }, pill(site.review.state === "pending" ? "等待审核" : "审核没通过", site.review.state === "pending" ? "warn" : "bad"),
        h("a", { class: "sub", href: "#/site-safety", text: "去审核" }))
      : site.offline ? pill("发布人下线", "") : site.scope === "anyone" ? pill("公开", "warn") : pill("在线", "ok") },
    { label: "近 7 天访问", num: true, cell: (site) => site.visits7d ? h("span", { title: `其中不用登录 ${site.visits7d.anonymous} 次，被拒 ${site.visits7d.refused} 次` }, fmt(site.visits7d.visits)) : "—" },
    { label: "接了表格", cell: (site) => site.sourced ? "是" : "否" },
    { label: "大小", num: true, cell: (site) => site.bytes === null ? "—" : `${fmt(Math.max(1, Math.round(site.bytes / 1024)))} KB` },
    { label: "发布时间", cell: (site) => dateTime(site.publishedAt ?? site.createdAt) },
    ...(manage ? [{ label: "", cell: (site) => site.held
      ? h("button", { class: "button small ghost", type: "button", text: "恢复", onclick: () => releaseSite(ctx, site) })
      : h("button", { class: "button small ghost danger", type: "button", text: "下线", onclick: () => holdSite(ctx, site) }) }] : []),
  ], rows: data.sites, emptyText: !data.enabled ? "这个部署没有开启文档网站" : params.q || params.state || params.owner ? "没有符合条件的网站" : "还没有发布过网站" })));
}
async function holdSite(ctx, site) {
  const answer = await confirm({ title: `下线「${site.name}」？`, danger: true, confirmText: "下线",
    message: `链接立刻失效，正在看的人也会断开。文件保留；${site.owner || "发布人"}不能自己恢复，也不能改共享范围、发新版本或删除它，要由管理员恢复。`,
    reason: { label: "原因", required: true, placeholder: "例如：包含客户的联系方式", help: "发布人在 i豆 里想重新发布、改共享范围或删除它时，会看到这个原因；它也会写进审计日志。" } });
  if (!answer) return;
  try { await api.post(`sites/${site.id}/hold`, { reason: answer.reason }); toast("已下线"); ctx.navigate("sites", ctx.params, { replace: true }); }
  catch (error) { toast(error.message, "bad"); }
}
async function releaseSite(ctx, site) {
  const answer = await confirm({ title: `恢复「${site.name}」？`, confirmText: "恢复",
    message: "回到下线前的状态：下线前在线的，重新在线；发布人自己下线过的，仍然下线。发布人可以重新管理它。" });
  if (!answer) return;
  try { const result = await api.post(`sites/${site.id}/release`); toast(result.offline ? "已恢复：发布人之前自己下线了它，仍然下线" : "已恢复，链接重新可用"); ctx.navigate("sites", ctx.params, { replace: true }); }
  catch (error) { toast(error.message, "bad"); }
}
