// 定时任务 and 内容安全: what people left running on the server, and what
// is published on the document sites. Counts and states, never what a task
// says.
import { api } from "./api.js";
import { h, pageHead, panel, table, pager, personCell, pill, dateTime, ago, fmt, section, stat, empty, confirm, toast } from "./ui.js";
import { taskControl, revokeUnattended } from "./pages-people.js";

const positions = new Map();   // the page positions passed, for "上一页"
const CREDENTIAL = { active: ["有效", "ok"], needs_reauthorization: ["要重新授权", "warn"] };

export async function tasksPage(view, ctx) {
  const stack = positions.get("tasks") ?? [];
  positions.set("tasks", stack);
  const data = await api.get("tasks", { cursor: stack.at(-1)?.next ?? null, limit: 50 });
  if (ctx.stale()) return;
  if (!data.available) {
    view.append(pageHead("定时任务", "这个部署没有开启定时任务。"));
    return;
  }
  view.append(pageHead("定时任务", `谁有定时任务、各在什么状态、最近一天跑得怎么样${data.scoped ? "（你管理的部门里的人）" : ""}。这里看不到任务的标题和提示词。`));
  if (data.totals) {
    const { totals } = data;
    view.append(h("div", { class: "grid cols-4" },
      stat({ label: "定时任务", value: fmt(totals.total), unit: "个", sub: [`${fmt(totals.owners)} 人有任务`] }),
      stat({ label: "在运行", value: fmt(totals.active), unit: "个", sub: ["到点就会跑"] }),
      stat({ label: "暂停", value: fmt(totals.paused), unit: "个", sub: ["本人暂停，或已经结束"] }),
      stat({ label: "挂起", value: fmt(totals.suspended), unit: "个", sub: ["没有可用的登录或授权，或被管理员停止"] })));
  }
  const manage = ctx.can("policy.manage"), revoke = ctx.can("people.manage");
  view.append(section("按人", data.scoped ? "只列出你管理的部门里的人" : "", panel(
    table({ columns: [
      { label: "成员", cell: (row) => personCell({ userId: row.userId, name: row.name }) },
      { label: "任务", cell: (row) => h("span", {}, `${fmt(row.total)} 个`, h("span", { class: "sub", text: [row.active ? `运行 ${row.active}` : "", row.paused ? `暂停 ${row.paused}` : "", row.suspended ? `挂起 ${row.suspended}` : ""].filter(Boolean).join(" · ") })) },
      { label: "下次运行", cell: (row) => row.nextAt ? h("span", {}, dateTime(row.nextAt), h("span", { class: "sub", text: ago(row.nextAt) })) : "—" },
      { label: "最近 24 小时", cell: (row) => {
        const { completed, failed, skipped } = row.runs;
        if (!completed && !failed && !skipped) return h("span", { class: "faint", text: "没有运行" });
        return h("span", { class: "control-line" }, completed ? pill(`完成 ${completed}`, "ok") : null, failed ? pill(`失败 ${failed}`, "bad") : null, skipped ? pill(`跳过 ${skipped}`, "warn") : null);
      } },
      { label: "无人值守授权", cell: (row) => row.unattended ? pill(...(CREDENTIAL[row.unattended.state] ?? [row.unattended.state, ""])) : h("span", { class: "faint", text: "没有" }) },
      { label: "", cell: (row) => h("span", { class: "control-line" },
        row.stopped ? pill("管理员已停止", "bad") : null,
        manage ? h("button", { class: `button small ghost${row.stopped ? "" : " danger"}`, type: "button", text: row.stopped ? "允许" : "停止", onclick: () => taskControl(ctx, row, row.stopped ? "allow" : "stop") }) : null,
        revoke && row.unattended ? h("button", { class: "button small ghost danger", type: "button", text: "撤销授权", onclick: () => revokeUnattended(ctx, row) }) : null) },
    ], rows: data.owners, emptyText: data.scoped ? "你管理的部门里没有人有定时任务" : "还没有人建过定时任务",
      onRow: (row) => { window.location.hash = `#/people/${encodeURIComponent(row.userId)}`; } }),
    pager({ stack, next: data.next, shown: data.owners.length, onMove: (step) => {
      if (step > 0) stack.push({ next: data.next }); else stack.pop();
      ctx.navigate("tasks", {}, { replace: true });
    } }))));
  view.append(h("p", { class: "note", text: "「停止」是在他的策略规则里把「定时任务」关掉：每次运行前都会检查，他也不能新建；任务和记录不删除。「撤销授权」删掉他留给服务端的长期飞书凭据，之后只有他登录着 i豆 时任务才能运行。" }));
}

// ---------------------------------------------------------------- 内容安全
// What every published site was checked for, what waits for an administrator,
// and the rules (docs/site-content-safety.md). Values are never shown: a
// finding is where it is and a masked sample; an excerpt has them masked too.
const OUTCOME = { pass: ["通过", "ok"], record: ["已记录", ""], review: ["送审", "warn"], block: ["拦截", "bad"] };
const AUDIENCE = { public: "公开", internal: "组织内" };
const outcomePill = (outcome) => pill(...(OUTCOME[outcome] ?? [outcome, ""]));

export async function siteSafetyPage(view, ctx) {
  const data = await api.get("site-safety");
  if (ctx.stale()) return;
  if (!data.available) { view.append(pageHead("内容安全", "这个部署没有开启文档网站。")); return; }
  const manage = ctx.can("content.manage");
  view.append(pageHead("内容安全", "文档网站每次发布、改分享范围、刷新数据之前，服务端都先检查：密钥、身份证号、银行卡号、手机号、邮箱和你们定的敏感词；公开网站的文字还由 AI 读一遍。按下面的规则拦截、送审或记录。",
    manage && data.editable ? [h("button", { class: "button", type: "button", text: "全部重新检查", onclick: () => rescan(ctx) })] : []));
  const counted = (outcome) => data.recent.filter((check) => check.outcome === outcome).length;
  view.append(h("div", { class: "grid cols-4" },
    stat({ label: "等待审核", value: fmt(data.waiting.length), unit: "个网站", sub: ["审核前链接打不开"] }),
    stat({ label: "没通过", value: fmt(data.rejected.length), unit: "个网站", sub: ["发布人改好后重新发布会再查"] }),
    stat({ label: "最近 20 次检查", value: fmt(counted("block") + counted("review")), unit: "次有问题", sub: [`拦截 ${counted("block")}`, `送审 ${counted("review")}`] }),
    // A model that keeps not answering shows here first: each of those waits for a person.
    stat({ label: "AI 审核公开网站", value: data.rules.ai && data.aiAvailable ? "开" : "关", sub: [!data.aiAvailable ? "这个服务端没有可用的模型" : !data.rules.ai ? "规则里关掉了"
      : data.recent.some((check) => check.ai?.failed) ? `最近的检查里 ${data.recent.filter((check) => check.ai?.failed).length} 次模型没读完` : "用部署配置的对话模型"] })));

  const waitingRows = (rows, rejected) => table({ columns: [
    { label: "网站", cell: (row) => h("span", {}, h("b", { text: row.site.name }), h("span", { class: "sub", text: AUDIENCE[row.site.scope === "anyone" ? "public" : "internal"] })) },
    { label: "发布人", cell: (row) => personCell({ userId: row.site.ownerId, name: row.site.owner }) },
    { label: rejected ? "没通过的原因" : "原因", cell: (row) => h("span", { class: "clamp", text: rejected ? row.site.review?.reason || "—" : row.check?.reason || row.site.review?.reason || "—" }) },
    { label: "时间", cell: (row) => dateTime(row.site.review?.at) },
    { label: "", cell: (row) => row.check ? h("span", { class: "control-line" },
      h("button", { class: "button small ghost", type: "button", text: "查看", onclick: () => showCheck(ctx, row.check.id) }),
      manage && !rejected ? h("button", { class: "button small ghost", type: "button", text: "通过", onclick: () => approve(ctx, row.check) }) : null,
      manage && !rejected ? h("button", { class: "button small ghost danger", type: "button", text: "不通过", onclick: () => reject(ctx, row.check) }) : null) : null },
  ], rows, emptyText: rejected ? "没有" : "没有等待审核的网站" });
  view.append(section("等待审核", data.waiting.length ? `${data.waiting.length} 个` : "", panel(waitingRows(data.waiting, false))));
  if (data.rejected.length) view.append(section("没通过", `${data.rejected.length} 个`, panel(waitingRows(data.rejected, true))));
  view.append(rulesSection(ctx, data, manage && data.editable));

  const recent = table({ columns: checkColumns(ctx), rows: data.recent, emptyText: "还没有检查过", onRow: (check) => showCheck(ctx, check.id) });
  const more = data.next ? h("button", { class: "button small", type: "button", text: "更多", onclick: async () => {
    const page = await api.get("site-safety/checks", { cursor: more.dataset.next, limit: 50 });
    const extra = table({ columns: checkColumns(ctx), rows: page.checks, onRow: (check) => showCheck(ctx, check.id) });
    more.before(...extra.querySelectorAll("tbody tr"));
    if (page.next) more.dataset.next = page.next; else more.remove();
  } }) : null;
  if (more) more.dataset.next = data.next;
  view.append(section("最近的检查", "每次发布、改分享范围、数据有变化时一条", panel(recent, more ? h("div", { class: "table-foot" }, more) : null)));
}

function checkColumns() {
  return [
    { label: "时间", cell: (check) => dateTime(check.at) },
    { label: "网站", cell: (check) => check.siteName || check.siteId.slice(0, 8) },
    { label: "发生在", cell: (check) => ({ publish: "发布", update: "更新版本", share: "改分享范围", republish: "重新发布", data: "数据刷新", rescan: "补查", rollback: "回到旧版本" }[check.trigger] ?? check.trigger) },
    { label: "对谁", cell: (check) => AUDIENCE[check.audience] ?? check.audience },
    { label: "结果", cell: (check) => h("span", { class: "control-line" }, outcomePill(check.outcome), check.decision ? pill(check.decision.decision === "approved" ? "已通过" : "已驳回", check.decision.decision === "approved" ? "ok" : "bad") : null) },
    { label: "发现", cell: (check) => h("span", { class: "clamp", text: findingsText(check) || "—" }) },
  ];
}
const NAMES = { secret: "密钥或凭据", idcard: "身份证号", bankcard: "银行卡号", phone: "手机号", email: "邮箱地址", keyword: "敏感词" };
function findingsText(check) {
  const counts = Object.entries(check.counts ?? {}).filter(([, n]) => n > 0).map(([category, n]) => `${NAMES[category] ?? category} ${n}`);
  if (check.ai && check.ai.verdict !== "pass") counts.push(check.ai.failed ? "AI 没读完" : `AI：${check.ai.reason || check.ai.verdict}`);
  return counts.join("、");
}

async function showCheck(ctx, id) {
  let answer;
  try { answer = await api.get(`site-safety/checks/${id}`); } catch (error) { toast(error.message, "bad"); return; }
  const { check, site } = answer;
  const waiting = site?.review?.state === "pending" && check.outcome === "review" && !check.decision;
  const manage = ctx.can("content.manage");
  const extra = h("div", { class: "grid" },
    h("p", { class: "muted", text: `${site ? `「${site.name}」· ${site.owner || site.ownerId}` : "网站已经不在了"} · ${AUDIENCE[check.audience]} · ${dateTime(check.at)}` }),
    check.reason ? h("p", { text: check.reason }) : null,
    check.findings.length ? table({ columns: [
      { label: "类别", cell: (finding) => NAMES[finding.category] ?? finding.category },
      { label: "位置", cell: (finding) => finding.where },
      { label: "样本（打码）", cell: (finding) => h("span", { class: "mono", text: finding.sample }) },
      { label: "处理", cell: (finding) => ({ block: "拦截", review: "送审", record: "记录", approved: "已放行过" }[finding.action] ?? finding.action) },
    ], rows: check.findings }) : null,
    check.ai ? h("p", {}, h("b", { text: "AI 审核：" }), `${check.ai.failed ? "没有完成" : { pass: "没有问题", review: "需要人来判断", block: "不适合公开" }[check.ai.verdict] ?? check.ai.verdict}${check.ai.reason ? `——${check.ai.reason}` : ""}`) : null,
    check.excerpt ? h("div", { class: "field" }, h("label", { text: "页面文字摘录（敏感信息已打码）" }), h("div", { class: "excerpt", text: check.excerpt })) : null,
    check.decision ? h("p", { class: "muted", text: `${check.decision.by?.name || "管理员"} 于 ${dateTime(check.decision.at)} ${check.decision.decision === "approved" ? "通过" : `驳回${check.decision.reason ? `：${check.decision.reason}` : ""}`}` }) : null);
  const choice = await confirm({ title: "检查详情", wide: true, extra, confirmText: waiting && manage ? "通过" : "关闭" });
  if (choice && waiting && manage) await approve(ctx, check, { confirmed: true });
}

async function approve(ctx, check, { confirmed = false } = {}) {
  if (!confirmed) {
    const answer = await confirm({ title: "审核通过？", confirmText: "通过",
      message: "网站会上线（发布人自己下线过的除外）。这次发现的这些内容以后再出现不会再送审；AI 读过的这些文字也一样。被拦截的类别不受影响。" });
    if (!answer) return;
  }
  try { const result = await api.post(`site-safety/checks/${check.id}/approve`); toast(result.online ? "已通过，网站已上线" : "已通过"); ctx.navigate("site-safety", {}, { replace: true }); }
  catch (error) { toast(error.message, "bad"); }
}
async function reject(ctx, check) {
  const answer = await confirm({ title: "不通过？", danger: true, confirmText: "不通过", message: "网站保持下线。发布人会在 i豆 里看到原因，改好后发布新版本会重新检查。",
    reason: { label: "原因", required: true, placeholder: "例如：页面里有客户的手机号，公开前请删除", help: "发布人会看到它，也会写进审计日志。" } });
  if (!answer) return;
  try { await api.post(`site-safety/checks/${check.id}/reject`, { reason: answer.reason }); toast("已驳回"); ctx.navigate("site-safety", {}, { replace: true }); }
  catch (error) { toast(error.message, "bad"); }
}
async function rescan(ctx) {
  const answer = await confirm({ title: "全部网站重新检查？", confirmText: "开始检查",
    message: "按现在的规则把这个租户的每个网站再查一遍；公开网站会再让 AI 读一遍（文字没变的不重复读）。查出问题的网站会转为等待审核，审核前打不开。网站多的话要几分钟。" });
  if (!answer) return;
  try { await api.post("site-safety/rescan"); toast("已开始，几分钟后刷新这一页看结果"); } catch (error) { toast(error.message, "bad"); }
}

function rulesSection(ctx, data, editable) {
  const rules = data.rules;
  const choices = {};
  const select = (category, audience) => {
    const node = h("select", { class: "select", disabled: !editable || (category === "secret" && audience === "public") },
      ["block", "review", "record"].map((action) => h("option", { value: action, text: data.actionNames[action], selected: rules.actions[category][audience] === action })));
    choices[`${category}.${audience}`] = node;
    return node;
  };
  const keywords = h("textarea", { class: "input", rows: 4, disabled: !editable, placeholder: "每行一个，例如：机密\n内部资料", spellcheck: "false" });
  keywords.value = rules.keywords.join("\n");
  const ai = h("input", { type: "checkbox", checked: rules.ai, disabled: !editable || !data.aiAvailable });
  const all = h("input", { type: "checkbox", checked: rules.reviewAllPublic, disabled: !editable });
  const body = h("div", { class: "panel-body grid" },
    table({ columns: [
      { label: "发现", cell: ([category]) => data.categories[category] },
      { label: "公开网站（互联网上获得链接的人）", cell: ([category]) => select(category, "public") },
      { label: "组织内（组织成员、邀请的人）", cell: ([category]) => select(category, "internal") },
    ], rows: Object.entries(data.categories) }),
    h("div", { class: "field" }, h("label", { text: "敏感词" }), keywords, h("span", { class: "help", text: "页面或数据里出现这些词，按上表「敏感词」那一行处理；不区分大小写，最多 200 个。" })),
    h("label", { class: "check-label" }, ai, "公开网站的文字由 AI 再读一遍（违法违规、色情、赌博诈骗、广告引流、泄露隐私……）"),
    h("label", { class: "check-label" }, all, "所有公开网站都要管理员审核后才上线（每个新版本审一次）"),
    editable ? h("div", {}, h("button", { class: "button primary", type: "button", text: "保存规则", onclick: async () => {
      const actions = {};
      for (const [key, node] of Object.entries(choices)) { const [category, audience] = key.split("."); (actions[category] ??= {})[audience] = node.value; }
      try {
        await api.put("site-safety/rules", { actions, keywords: keywords.value.split(/\n+/).map((word) => word.trim()).filter(Boolean), ai: ai.checked, reviewAllPublic: all.checked });
        toast("已保存：之后的发布按新规则检查；已上线的网站要「全部重新检查」才按新规则再查");
        ctx.navigate("site-safety", {}, { replace: true });
      } catch (error) { toast(error.message, "bad"); }
    } })) : h("p", { class: "muted", text: "只有管理整个组织的管理员能改规则。" }),
    rules.updated ? h("p", { class: "muted", text: `${rules.updated.by?.name || "管理员"} 于 ${dateTime(rules.updated.at)} 修改` }) : h("p", { class: "muted", text: "现在是默认规则。" }));
  return section("规则", "密钥或凭据在公开网站里一律拦截", panel(body));
}
