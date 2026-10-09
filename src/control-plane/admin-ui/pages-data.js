// 用量 and 审计日志: counts, and who did what. Neither ever shows what anybody said.
import { api } from "./api.js";
import { h, clear, pageHead, panel, table, pager, personCell, pill, ago, dateTime, tokens, fmt, section, segmented, select, stat, bars, shortDay,
  empty, icon, toast, kv } from "./ui.js";

export const CATEGORIES = { admin: "管理", auth: "登录", feishu: "飞书", schedule: "定时任务", site: "网站", skill: "企业技能", media: "图片视频", policy: "策略", system: "系统" };
const ACTIONS = {
  "admin.sign-in": "登录管理后台",
  "admin.person.disable": "停用账号",
  "admin.person.enable": "恢复账号",
  "admin.person.sign-out": "让他在所有设备上退出",
  "admin.person.offboard": "离职清理",
  "admin.role.grant": "授予管理角色",
  "admin.role.revoke": "收回管理角色",
  "admin.audit.export": "导出审计日志",
  "admin.usage.export": "导出用量",
  "admin.policy.create": "新建策略规则",
  "admin.policy.update": "修改策略规则",
  "admin.policy.delete": "删除策略规则",
  "admin.org.sync": "立即同步组织架构",
  "admin.site.hold": "下线网站（管理员）",
  "admin.alerts.test": "发送测试告警",
  "admin.site.release": "恢复网站（管理员）",
  "admin.unattended.revoke": "撤销无人值守授权（管理员）",
  "admin.skill.withdraw": "下架企业技能",
  "admin.skill.approve": "通过企业技能审核",
  "admin.skill.reject": "驳回企业技能",
  "admin.skill.rollback": "企业技能回到旧版本",
  "admin.skill.visibility": "修改企业技能的可见范围",
  "admin.skill.publishers": "修改企业技能上架人",
  "admin.skill.settings": "修改企业技能上架规则",
  "skill.submit": "提交企业技能审核",
  "skill.publish": "上架企业技能",
  "skill.unpublish": "下架企业技能（上架人）",
  "system.org-sync": "同步组织架构",
  "auth.sign-in": "登录",
  "auth.resume": "自动恢复登录",
  "auth.sign-out": "退出登录",
  "feishu.write": "写入飞书",
  "feishu.delete": "删除飞书内容",
  "feishu.send": "发送飞书消息",
  "feishu.upload": "上传到云盘",
  "schedule.create": "新建定时任务",
  "schedule.update": "修改定时任务",
  "schedule.delete": "删除定时任务",
  "schedule.run": "定时任务运行",
  "schedule.run-now": "立即运行定时任务",
  "schedule.state": "暂停或恢复定时任务",
  "schedule.consent.revoke": "撤销定时任务授权",
  "schedule.unattended.grant": "授权无人值守运行",
  "schedule.unattended.revoke": "撤销无人值守运行",
  "site.publish": "发布网站",
  "site.withdraw": "取消发布网站",
  "site.share": "修改网站分享范围",
  "site.erase": "删除网站",
  "site.republish": "重新发布网站",
  "site.rollback": "网站回到旧版本",
  "site.address": "修改网站地址名",
  "site.refused": "发布被内容安全拦截",
  "site.review": "网站送管理员审核",
  "admin.site.approve": "审核通过网站",
  "admin.site.reject": "审核驳回网站",
  "admin.site-rules.update": "修改内容安全规则",
  "admin.site-rules.rescan": "全部网站重新检查",
  "media.image": "生成图片",
  "media.video": "生成视频",
  "media.speech": "生成语音",
};
export const actionLabel = (action) => ACTIONS[action] ?? action;
const OUTCOMES = { ok: ["成功", "ok"], refused: ["被拒绝", "warn"], failed: ["失败", "bad"] };
const REASONS = { account_disabled: "账号已停用", signed_out: "已被管理员下线", "not-in-chat": "不在管理员群", "not-listed": "不是管理员" };
const outcomePill = (outcome) => pill(...(OUTCOMES[outcome] ?? [outcome, ""]));
// The short fields an event carries, in the console's words.
const DETAIL = { role: "角色", via: "身份来源", reason: "原因", sessions: "结束的登录", bulk: "同一批处理人数", from: "从", to: "到", kind: "种类",
  days: "天数", category: "类别", device: "设备", note: "备注", status: "飞书返回的状态", result: "结果", undelivered: "没送到的", until: "有效到",
  model: "模型", scope: "分享范围", version: "版本", state: "改成" };
const VALUES = { owner: "超级管理员", admin: "管理员", auditor: "审计员", configured: "配置文件", chat: "管理员群", granted: "后台授予", ...REASONS };
const detailValue = (value) => VALUES[value] ?? String(value);

// A short list of events for a person's page.
export function auditTimeline(rows, { showActor = true } = {}) {
  if (!rows?.length) return empty("没有记录");
  return h("ul", { class: "timeline" }, rows.map((row) => h("li", {},
    h("time", { text: dateTime(row.at).slice(5) }),
    h("span", {}, showActor && row.actor.name ? h("b", { text: `${row.actor.name} ` }) : null, actionLabel(row.action),
      row.detail?.reason ? h("span", { class: "muted", text: `（${REASONS[row.detail.reason] ?? row.detail.reason}）` }) : null),
    row.outcome === "ok" ? h("span", { class: "faint", text: CATEGORIES[row.category] ?? row.category }) : outcomePill(row.outcome))));
}

// ---------------------------------------------------------------- usage
export async function usagePage(view, ctx) {
  const days = [7, 30, 90].includes(Number(ctx.params.days)) ? Number(ctx.params.days) : 30;
  const data = await api.get("usage", { days });
  if (ctx.stale()) return;
  const today = data.byDay.at(-1), yesterday = data.byDay.at(-2);
  const avgPeople = Math.round(data.byDay.slice(0, -1).reduce((sum, day) => sum + day.people, 0) / Math.max(1, data.byDay.length - 1));
  view.append(pageHead("用量", `${data.from} 到 ${data.to}（按 UTC 分天）。只有计数：请求数和 token，没有任何提示词或回答。`, [
    segmented([[7, "7 天"], [30, "30 天"], [90, "90 天"]], days, (value) => ctx.navigate("usage", { days: value }), "时间范围"),
    ctx.can("audit.export") ? h("a", { class: "button", href: api.href("usage/export", { days }), download: "" }, icon("download"), "导出 CSV") : null,
  ].filter(Boolean)));
  view.append(h("div", { class: "grid cols-4" },
    stat({ label: `${days} 天 token`, value: tokens(data.totals.tokens), sub: [`请求 ${fmt(data.totals.requests)} 次`] }),
    stat({ label: "今天 token", value: tokens(today?.tokens ?? 0), sub: [yesterday ? `昨天 ${tokens(yesterday.tokens)}` : ""] }),
    stat({ label: "今天用过的人", value: fmt(today?.people ?? 0), unit: "人", sub: [`前 ${data.byDay.length - 1} 天日均 ${fmt(avgPeople)} 人`] }),
    stat({ label: "模型", value: fmt(data.byModel.length), unit: "个", sub: data.byModel.slice(0, 2).map((model) => `${model.model} ${tokens(model.tokens)}`) })));
  view.append(section("每天的 token", "最后一根是今天，还在增长", panel(h("div", { class: "panel-body" },
    data.byDay.some((day) => day.tokens) ? bars(data.byDay, { value: (day) => day.tokens, label: (day) => shortDay(day.day), format: tokens }) : empty("这段时间没有用量")))));
  // Twenty at first: the page is for seeing who stands out, and the export
  // has everybody.
  const ranking = h("div");
  const drawRanking = (shown) => {
    clear(ranking).append(table({ columns: [
      { label: "#", cell: (row) => String(data.people.indexOf(row) + 1), width: "36px" },
      { label: "成员", cell: (row) => personCell({ userId: row.userId, name: row.name }) },
      { label: "token", num: true, cell: (row) => tokens(row.tokens) },
      { label: "请求", num: true, cell: (row) => fmt(row.requests) },
      { label: "最近一次", cell: (row) => ago(row.lastAt) },
    ], rows: data.people.slice(0, shown), onRow: (row) => { window.location.hash = `#/people/${encodeURIComponent(row.userId)}`; }, emptyText: "这段时间没有人用过" }),
    data.people.length > shown ? h("div", { class: "table-foot" }, h("span", { text: `还有 ${data.people.length - shown} 位` }),
      h("button", { class: "button small", type: "button", text: `显示前 ${data.people.length} 位`, onclick: () => drawRanking(data.people.length) })) : null);
  };
  drawRanking(20);
  view.append(h("div", { class: "section split" },
    section("用得最多的人", `前 ${data.people.length} 位`, panel(ranking)),
    section("按模型", "", panel(table({ columns: [
      { label: "模型", cell: (row) => row.model },
      { label: "token", num: true, cell: (row) => tokens(row.tokens) },
      { label: "请求", num: true, cell: (row) => fmt(row.requests) },
      { label: "日均人数", num: true, cell: (row) => fmt(Math.round(row.dailyPeople)) },
      { label: "被降级", num: true, cell: (row) => fmt(row.downgraded) },
    ], rows: data.byModel, emptyText: "没有用量" })))));
  view.append(h("p", { class: "note", text: "「被降级」是请求的模型答不了、换成另一个模型回答的次数。导出包含这段时间里每一个用过的人。" }));
}

// ---------------------------------------------------------------- audit
const PRESETS = [["1", "24 小时"], ["7", "7 天"], ["30", "30 天"], ["90", "90 天"]];
const auditPositions = new Map();

export async function auditPage(view, ctx) {
  const params = { days: ctx.params.days ?? "7", category: ctx.params.category ?? "", outcome: ctx.params.outcome ?? "", actor: ctx.params.actor ?? "", target: ctx.params.target ?? "" };
  const key = JSON.stringify(params);
  const stack = auditPositions.get(key) ?? [];
  auditPositions.clear(); auditPositions.set(key, stack);
  const now = Date.now(), days = Number(params.days) || 7;
  const filter = { from: now - days * 86_400_000, to: now + 60_000, category: params.category, outcome: params.outcome, actor: params.actor, target: params.target };
  const page = await api.get("audit", { ...filter, cursor: stack.length ? stack.at(-1).next : null, limit: 50 });
  if (ctx.stale()) return;
  const change = (next) => ctx.navigate("audit", { ...params, ...next });
  const exportDays = Math.min(days, 31);
  view.append(pageHead("审计日志", "谁、在什么时候、对什么、做了什么、结果如何。只记动作和对象，不记任何内容。管理员删不掉这里的记录。", [
    ctx.can("audit.export") ? h("a", { class: "button", href: api.href("audit/export", { ...filter, from: now - exportDays * 86_400_000 }), download: "",
      title: days > 31 ? "一次最多导出 31 天，会导出最近 31 天" : "" }, icon("download"), days > 31 ? "导出最近 31 天" : "导出 CSV") : null,
  ].filter(Boolean)));
  const actorNote = params.actor || params.target ? h("span", { class: "tag" }, params.actor ? `操作人 ${params.actor}` : `对象 ${params.target}`,
    h("button", { class: "copy", type: "button", text: "✕", "aria-label": "清除", onclick: () => change({ actor: "", target: "" }) })) : null;
  const rows = page.rows;
  const open = new Set();
  const body = h("div");
  const draw = () => {
    clear(body).append(table({ columns: [
      { label: "时间", cell: (row) => h("span", { class: "nowrap" }, dateTime(row.at), h("span", { class: "sub", text: ago(row.at) })) },
      { label: "类别", cell: (row) => pill(CATEGORIES[row.category] ?? row.category, row.category === "admin" ? "accent" : "", true) },
      { label: "动作", cell: (row) => h("span", {}, actionLabel(row.action), row.detail?.reason ? h("span", { class: "sub", text: REASONS[row.detail.reason] ?? `原因：${row.detail.reason}` }) : null) },
      { label: "操作人", cell: (row) => row.actor.id ? h("a", { href: `#/audit?${new URLSearchParams({ ...params, actor: row.actor.id })}`, title: "只看这个人", onclick: (event) => event.stopPropagation() },
        h("span", { class: "person" }, h("span", { class: "names" }, h("b", { text: row.actor.name || row.actor.id }), h("span", { text: { admin: "管理员", person: "成员", agent: "定时任务代他执行", system: "系统", visitor: "访客" }[row.actor.kind] ?? row.actor.kind })))) : h("span", { class: "muted", text: "系统" }) },
      { label: "对象", cell: (row) => row.target.id || row.target.name ? h("span", {}, row.target.name || row.target.id, row.target.name && row.target.id ? h("span", { class: "sub mono", text: row.target.id }) : null) : "—" },
      { label: "结果", cell: (row) => outcomePill(row.outcome) },
    ], rows, onRow: (row) => { if (open.has(row.id)) open.delete(row.id); else open.add(row.id); draw(); }, emptyText: "这段时间没有符合条件的记录" }));
    for (const id of open) {
      const row = rows.find((candidate) => candidate.id === id);
      const tr = body.querySelectorAll("tbody tr")[rows.indexOf(row)];
      tr?.after(h("tr", { class: "detail-row" }, h("td", { colspan: 6 }, kv([
        ["动作代码", h("span", { class: "mono", text: row.action })],
        ["来源", row.source || "—"], ["地址", row.address || "—"],
        ["操作人 open_id", row.actor.id ? h("span", { class: "mono", text: row.actor.id }) : "—"],
        ...Object.entries(row.detail ?? {}).map(([name, value]) => [DETAIL[name] ?? name, detailValue(value)]),
      ]))));
    }
  };
  draw();
  view.append(panel(
    h("div", { class: "filters" },
      segmented(PRESETS, String(days), (value) => change({ days: value }), "时间范围"),
      select([["", "全部类别"], ...Object.entries(CATEGORIES)], params.category, (category) => change({ category }), "类别"),
      select([["", "全部结果"], ["ok", "成功"], ["refused", "被拒绝"], ["failed", "失败"]], params.outcome, (outcome) => change({ outcome }), "结果"),
      actorNote),
    body,
    pager({ stack, next: page.next, shown: rows.length, onMove: (step) => {
      if (step > 0) stack.push({ next: page.next }); else stack.pop();
      ctx.navigate("audit", params, { replace: true });
    } })));
  view.append(h("p", { class: "note", text: "点一行看细节。点操作人只看这个人的记录。保留期由部署配置决定（默认 180 天）；每一条同时写在服务端日志里，运维的日志收集是第二份。" }));
}
export { toast };
