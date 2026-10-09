// 企业技能 (docs/enterprise-skill-governance.md): what is on the shelf and how
// much it is used, what waits for an administrator -- read file by file against
// what is up before it is let through -- who may publish, whether a version
// waits at all; and each skill's own page: its files, what its tools allow,
// every version that went up and going back to one, who sees it, what was done.
import { api } from "./api.js";
import { h, pageHead, panel, table, personCell, pill, dateTime, ago, fmt, section, stat, empty, confirm, toast, kv, sparkline, clear } from "./ui.js";
import { departmentPicker } from "./pages-org.js";
import { personPicker } from "./pages-policy.js";
import { auditTimeline } from "./pages-data.js";

const STATE = { pending: ["等待审核", "warn"], approved: ["已通过", "ok"], rejected: ["没通过", "bad"], superseded: ["被新提交替代", ""] };
const SOURCE = { publish: "直接上线", approve: "审核通过", rollback: "回到这个版本", earlier: "版本记录开始前就在线上" };
const LEVEL = { files: ["本机文件", "warn"], connector: ["连接器", "warn"], declared: ["只是声明", ""] };
const who = (person) => person?.name || person?.userId || "—";

export async function skillsPage(view, ctx) {
  const [data, submissions] = await Promise.all([api.get("skills"), api.get("skills/submissions", { state: "pending" }).catch(() => ({ submissions: [] }))]);
  if (ctx.stale()) return;
  const manage = ctx.can("content.manage");
  view.append(pageHead("企业技能", data.governed
    ? "技能上架人做的技能，经过审核后发给企业里的人。在这里审核、回到旧版本、决定谁能看见、管理谁能上架。i豆 在打开技能中心和每次任务开始一轮时读取目录，下架或改范围后从那时起生效。"
    : "发布给这个企业所有人的技能。发现有问题的技能可以在这里下架。"));
  if (!data.available) { view.append(panel(empty("这个部署没有开启企业技能", "需要在服务器上配置技能货架和签名密钥（见 docs/server-deployment.md）。"))); return; }
  const people = data.skills.reduce((sum, skill) => sum + (skill.usage?.people ?? 0), 0);
  view.append(h("div", { class: "grid cols-4" },
    stat({ label: "已上架", value: fmt(data.skills.length), unit: "个技能", sub: ["每个企业最多 100 个"] }),
    stat({ label: "等待审核", value: fmt(data.pending ?? 0), unit: "个版本", sub: [data.settings ? (data.settings.reviewRequired ? "上架前需要管理员审核" : "审核关着：上架即上线") : "这个部署不审核"] }),
    stat({ label: "近 30 天用过", value: fmt(people), unit: "人次", sub: ["新版 i豆（.271 起）用技能新建任务时计一次"] }),
    stat({ label: "限定部门的技能", value: fmt(data.skills.filter((skill) => skill.visibility?.length).length), unit: "个", sub: ["其余对全员可见"] })));

  if (data.governed) {
    view.append(section("等待审核", submissions.submissions.length ? `${submissions.submissions.length} 个` : "", panel(table({ columns: [
      { label: "技能", cell: (row) => h("span", {}, h("b", { text: row.title || row.skillId }), h("span", { class: "sub mono", text: row.skillId })) },
      { label: "版本", cell: (row) => h("span", { class: "mono", text: row.version }) },
      { label: "提交人", cell: (row) => personCell(row.submittedBy) },
      { label: "提交时间", cell: (row) => dateTime(row.at) },
      { label: "所需工具", cell: (row) => row.requiredTools.length ? row.requiredTools.join("、") : "无" },
      { label: "", cell: (row) => h("span", { class: "control-line" },
        // Approving goes through reading it: 审核 opens every file and the difference, with 通过并上线 at the bottom.
        h("button", { class: "button small ghost", type: "button", text: manage ? "审核" : "查看", onclick: () => reviewSubmission(ctx, row.id, manage) }),
        manage ? h("button", { class: "button small ghost danger", type: "button", text: "不通过", onclick: () => rejectSubmission(ctx, row) }) : null) },
    ], rows: submissions.submissions, emptyText: "没有等待审核的版本" }))));
  }

  view.append(section("已上架", `${data.skills.length} 个`, panel(table({ columns: [
    { label: "技能", cell: (skill) => h("a", { href: `#/skills/${encodeURIComponent(skill.id)}` }, h("b", { text: skill.title || skill.id }), h("span", { class: "sub mono", text: skill.id })) },
    { label: "版本", cell: (skill) => h("span", { class: "mono", text: skill.version }) },
    { label: "上线", cell: (skill) => skill.published ? h("span", {}, ago(skill.published.at), h("span", { class: "sub", text: `${who(skill.published.by)}${skill.published.approvedBy ? ` · ${who(skill.published.approvedBy)} 审核` : ""}` })) : h("span", { class: "muted", text: "这个功能上线前上架的" }) },
    { label: "谁能看见", cell: (skill) => skill.visibility?.length ? pill(`${skill.visibility.length} 个部门`, "accent") : "全员" },
    { label: "近 30 天", num: true, cell: (skill) => skill.usage ? `${fmt(skill.usage.people)} 人 · ${fmt(skill.usage.uses)} 次` : "—" },
    { label: "所需工具", num: true, cell: (skill) => fmt(skill.requiredTools.length) },
    ...(manage ? [{ label: "", cell: (skill) => h("button", { class: "button small ghost danger", type: "button", text: "下架", onclick: (event) => { event.stopPropagation(); void withdrawSkill(ctx, skill); } }) }] : []),
  ], rows: data.skills, onRow: (skill) => ctx.navigate(`skills/${encodeURIComponent(skill.id)}`), emptyText: "还没有上架企业技能。技能上架人在 i豆 的技能中心里，从本机技能的「更多 → 上架到企业」提交。" }))));

  if (data.withdrawn?.length) view.append(section("已下架", "保留了版本，可以从技能页重新上线", panel(table({ columns: [
    { label: "技能", cell: (skill) => h("a", { href: `#/skills/${encodeURIComponent(skill.id)}` }, h("b", { text: skill.title || skill.id }), h("span", { class: "sub mono", text: skill.id })) },
    { label: "最后的版本", cell: (skill) => h("span", { class: "mono", text: skill.version }) },
    { label: "那个版本上线于", cell: (skill) => skill.source === "earlier" ? "版本记录开始前" : dateTime(skill.at) },
  ], rows: data.withdrawn, onRow: (skill) => ctx.navigate(`skills/${encodeURIComponent(skill.id)}`) }))));

  if (data.governed) {
    view.append(h("div", { class: "section split" }, await publishersSection(ctx, manage), settingsSection(ctx, data, manage)));
    const decided = await api.get("skills/submissions", { state: "all" }).catch(() => ({ submissions: [] }));
    if (ctx.stale()) return;
    const recent = decided.submissions.filter((row) => row.state !== "pending").slice(0, 20);
    if (recent.length) view.append(section("最近的审核", "", panel(table({ columns: [
      { label: "技能", cell: (row) => h("span", {}, row.title || row.skillId, h("span", { class: "sub mono", text: row.version })) },
      { label: "结果", cell: (row) => pill(...(STATE[row.state] ?? [row.state, ""])) },
      { label: "提交人", cell: (row) => who(row.submittedBy) },
      { label: "审核", cell: (row) => row.decision ? `${who(row.decision.by)} · ${dateTime(row.decision.at)}` : "—" },
      { label: "原因", cell: (row) => h("span", { class: "clamp", text: row.decision?.reason || "—" }) },
    ], rows: recent }))));
  }
}

async function publishersSection(ctx, manage) {
  const { publishers } = await api.get("skills/publishers");
  const box = h("div", { class: "panel-body" });
  box.append(table({ columns: [
    { label: "上架人", cell: (row) => personCell({ userId: row.userId, name: row.name }) },
    { label: "来自", cell: (row) => row.source === "configured" ? pill("服务器配置", "") : pill("后台添加", "accent") },
    ...(manage ? [{ label: "", cell: (row) => row.source === "console" ? h("button", { class: "button small ghost danger", type: "button", text: "移出", onclick: async () => {
      const ok = await confirm({ title: `把 ${row.name || row.userId} 移出上架人名单？`, message: "之后这个人不能再从 i豆 提交或下架企业技能；已经上架的技能不受影响。", danger: true, confirmText: "移出" });
      if (!ok) return;
      try { await api.remove(`skills/publishers/${encodeURIComponent(row.userId)}`); toast("已移出"); ctx.navigate("skills", {}, { replace: true }); } catch (error) { toast(error.message, "bad"); }
    } }) : h("span", { class: "muted", text: "在服务器上改" }) }] : []),
  ], rows: publishers, emptyText: "还没有上架人" }));
  if (manage) box.append(h("div", { class: "field" }, h("label", { text: "加一位上架人" }), personPicker(async (person) => {
    try { await api.post("skills/publishers", { userId: person.userId }); toast(`已加上 ${person.name || person.userId}`); ctx.navigate("skills", {}, { replace: true }); }
    catch (error) { toast(error.message, "bad"); }
  }, "搜索成员：姓名或 open_id")));
  return section("谁能上架", "能从 i豆 提交和下架企业技能的人", panel(box));
}

function settingsSection(ctx, data, manage) {
  const on = data.settings?.reviewRequired !== false;
  const toggle = h("input", { type: "checkbox", checked: on, disabled: !manage, onchange: async () => {
    const turningOff = !toggle.checked;
    if (turningOff && !await confirm({ title: "关掉上架前审核？", message: "关掉后，上架人提交的版本立刻对能看见它的人生效，不经过任何管理员。每次上线仍然记版本和审计。", danger: true, confirmText: "关掉审核" })) { toggle.checked = true; return; }
    try { await api.put("skills/settings", { reviewRequired: toggle.checked }); toast(toggle.checked ? "已打开上架前审核" : "已关掉上架前审核"); ctx.navigate("skills", {}, { replace: true }); }
    catch (error) { toggle.checked = !toggle.checked; toast(error.message, "bad"); }
  } });
  return section("上架规则", "", panel(h("div", { class: "panel-body" },
    h("label", { class: "check-label" }, toggle, "上架前需要管理员审核"),
    h("p", { class: "muted", text: "打开时，上架人提交的版本先进「等待审核」；管理员看过全部文件和与线上版本的差别后通过，才会上线。提交人不能审核自己的版本（只有一位管理员时除外）。" }))));
}

// One submission: everything in it, what it changes from what is up, and the decision.
async function reviewSubmission(ctx, id, manage) {
  let data;
  try { data = await api.get(`skills/submissions/${id}`); } catch (error) { toast(error.message, "bad"); return; }
  const { submission, skill, changes, tools, live } = data;
  const changed = changes.files.length ? table({ columns: [
    { label: "文件", cell: (file) => h("span", { class: "mono", text: file.path }) },
    { label: "变化", cell: (file) => ({ added: pill("新增", "ok"), removed: pill("删除", "bad"), changed: pill("修改", "warn") })[file.change] },
    { label: "行", num: true, cell: (file) => file.change === "changed" ? `+${file.added} −${file.removed}` : `${file.lines} 行` },
  ], rows: changes.files }) : h("p", { class: "muted", text: "文件没有变化" });
  const diffs = changes.files.filter((file) => file.change === "changed" && (file.hunks?.length || file.tooLong)).map((file) => h("details", { class: "file-diff", open: true },
    h("summary", { text: `${file.path} 改了什么` }),
    // What was left out is said: a long change must not hide its end.
    file.tooLong ? h("p", { class: "callout warn", text: "这个文件超过 2000 行，没有逐行比较：请在下面的全部文件里读全文。" }) : null,
    file.hunks?.length ? h("pre", { class: "code-view" }, file.hunks.map((hunk) => h("span", { class: `diff-line ${hunk.kind === "+" ? "add" : "remove"}`, text: `${hunk.kind} ${hunk.line}\n` }))) : null,
    file.cut ? h("p", { class: "callout warn", text: `只显示了前 400 行改动，还有 ${file.cut} 行没有显示：请在下面的全部文件里读全文。` }) : null));
  const extra = h("div", { class: "grid" },
    h("p", { class: "muted", text: `${skill.title} · ${skill.id} · 版本 ${skill.version} · ${who(submission.submittedBy)} 提交于 ${dateTime(submission.at)}` }),
    h("p", { text: live ? `线上是 ${live.version}。${changes.fields.length ? `改了：${changes.fields.map((field) => ({ title: "名称", description: "说明", publisher: "发布方", version: "版本" })[field] ?? field).join("、")}。` : ""}` : "这是第一次上架。" }),
    toolsList(tools, changes.tools),
    changed, ...diffs,
    h("div", { class: "field" }, h("label", { text: "全部文件（只当文字显示，不会执行）" }), filesView(skill.files, !live)),
    data.selfReview ? h("p", { class: "callout warn", text: "这是你自己提交的版本：请另一位管理员审核。" }) : null);
  if (!manage || submission.state !== "pending" || data.selfReview) { await confirm({ title: `${skill.title} ${skill.version}`, message: "", extra, confirmText: "关闭", wide: true, cancel: false }); return; }
  // Who will see it from the moment it is up: kept as set, or chosen here --
  // a new skill can start with a few departments.
  const chosen = (data.visibility?.departments ?? []).map((department) => ({ ...department }));
  extra.append(h("div", { class: "field" }, h("label", { text: "上线后谁能看见" }), departmentChooser(chosen, true),
    h("span", { class: "help", text: "不选部门就是全员。没有同步到组织架构的人只能看到全员可见的技能。" })));
  // Reading it is how it is approved: the decision is the dialog's own button.
  const approved = await confirm({ title: `审核「${skill.title}」${skill.version}`, message: "通过后这个版本立刻上线，替换线上的版本；能看见它的人下次读取目录时就拿到它。不通过请关掉这里，在列表里点「不通过」并写下原因。",
    extra, confirmText: "通过并上线", wide: true });
  if (!approved) return;
  // The visibility goes with the approval only when it was changed here, with
  // what it was: the server refuses if somebody changed it meanwhile.
  const was = (data.visibility?.departments ?? []).map((department) => department.id);
  const now = chosen.map((department) => department.id);
  const differs = [...was].sort().join("\n") !== [...now].sort().join("\n");
  try { await api.post(`skills/submissions/${id}/approve`, differs ? { departments: now, visibilityWas: was } : {}); toast("已通过，已上线"); ctx.navigate("skills", {}, { replace: true }); }
  catch (error) { toast(error.message, "bad"); }
}

// Departments as removable chips, and a picker to add one. `chosen` is changed in place.
function departmentChooser(chosen, manage) {
  const list = h("div", { class: "chips" });
  const draw = () => clear(list).append(...(chosen.length ? chosen.map((department) => h("span", { class: `chip${department.gone ? " gone" : ""}`, title: department.gone ? "飞书通讯录里已经没有这个部门，没有人在它下面" : "" },
    department.gone ? `${department.id}（已不在通讯录里）` : department.name,
    manage ? h("button", { class: "chip-x", type: "button", "aria-label": `去掉${department.name ?? department.id}`, text: "×", onclick: () => { chosen.splice(chosen.indexOf(department), 1); draw(); } }) : null))
    : [h("span", { class: "muted", text: "全员可见" })]));
  draw();
  return h("div", { class: "grid" }, list, manage ? departmentPicker((department) => { if (!chosen.some((item) => item.id === department.id)) chosen.push({ id: department.id, name: department.name }); draw(); }, { clearOnPick: true }) : null);
}

async function rejectSubmission(ctx, row) {
  const answer = await confirm({ title: `不通过「${row.title || row.skillId}」${row.version}？`, message: "线上不变；提交人在 i豆 的技能中心看到原因。", danger: true, confirmText: "不通过",
    reason: { label: "原因", placeholder: "例如：会把客户名单发到群里", required: true, help: "提交人会看到它，也写进审计日志。" } });
  if (!answer) return;
  try { await api.post(`skills/submissions/${row.id}/reject`, { reason: answer.reason }); toast("已驳回"); ctx.navigate("skills", {}, { replace: true }); } catch (error) { toast(error.message, "bad"); }
}

function toolsList(tools, changes = null) {
  if (!tools.length) return h("p", { class: "muted", text: "不需要任何工具：只是给模型的说明。" });
  return h("div", { class: "tool-list" }, tools.map((tool) => h("div", { class: "tool-row" },
    pill(...(LEVEL[tool.level] ?? [tool.level, ""])), h("span", { class: "mono", text: tool.tool }), changes?.added?.includes(tool.tool) ? pill("新增", "warn") : null,
    h("span", { class: "muted", text: tool.meaning }))));
}
// The first file open, unless what changed is already shown above it.
function filesView(files, openFirst = true) {
  return h("div", { class: "files-view" }, files.map((file, index) => h("details", { class: "file", open: openFirst && index === 0 },
    h("summary", {}, h("span", { class: "mono", text: file.path }), h("span", { class: "muted", text: ` · ${file.text.split("\n").length} 行` })),
    h("pre", { class: "code-view", text: file.text }))));
}

async function withdrawSkill(ctx, skill) {
  const answer = await confirm({ title: `下架「${skill.title || skill.id}」？`, danger: true, confirmText: "下架",
    message: "每台电脑下一次打开技能中心、或用它的任务开始下一轮时，就拿不到它了。版本历史还在，可以从技能详情里重新上线。",
    reason: { label: "原因", placeholder: "例如：会把客户资料发到外部", help: "写进审计日志。" } });
  if (!answer) return;
  try { await api.post(`skills/${encodeURIComponent(skill.id)}/withdraw`, { reason: answer.reason }); toast("已下架"); ctx.navigate("skills", {}, { replace: true }); }
  catch (error) { toast(error.message, "bad"); }
}

// ---------------------------------------------------------------- one skill
export async function skillPage(view, ctx) {
  const data = await api.get(`skills/${encodeURIComponent(ctx.id)}`);
  if (ctx.stale()) return;
  const { skill } = data, manage = ctx.can("content.manage"), up = data.live !== false;
  view.append(pageHead(skill.title || skill.id, up ? `${skill.id} · 版本 ${skill.version} · ${skill.publisher}`
    : `${skill.id} · 已下架；下面是最后上线的版本 ${skill.version}，可以在版本历史里重新上线`, [
    h("a", { class: "button ghost", href: "#/skills", text: "返回企业技能" }),
    ...(manage && up ? [h("button", { class: "button danger", type: "button", text: "下架", onclick: () => withdrawSkill(ctx, skill) })] : [])]));
  view.append(h("div", { class: "grid cols-4" },
    stat({ label: "近 30 天", value: fmt(data.usage?.people ?? 0), unit: "人", sub: [`${fmt(data.usage?.uses ?? 0)} 次`], spark: data.usage?.daily?.length ? sparkline(data.usage.daily.map((point) => point.uses)) : null }),
    stat({ label: "谁能看见", value: data.visibility.departments.length ? fmt(data.visibility.departments.length) : "全员", unit: data.visibility.departments.length ? "个部门" : "", sub: [data.visibility.departments.map((department) => department.name ?? `${department.id}（已不在通讯录里）`).join("、") || "企业里所有人"] }),
    stat({ label: "保留的版本", value: fmt(data.versions.length), unit: "个", sub: ["每个技能保留最近 5 个"] }),
    stat({ label: "所需工具", value: fmt(skill.requiredTools.length), unit: "项", sub: [skill.requiredTools.length ? "见下" : "只是说明"] })));
  view.append(h("div", { class: "section split" },
    section("说明", "", panel(h("div", { class: "panel-body" }, h("p", { text: skill.description }), kv([
      ["摘要", h("span", { class: "mono", text: skill.digest.slice(0, 16) })],
      ["兼容的 Codex", skill.runtimeVersions.codex.join("、") || "不限"],
      ["兼容的飞书命令行", skill.runtimeVersions.feishu.join("、") || "不限"]])))),
    section("所需工具", "声明不等于授权：每次用到仍要本人确认", panel(h("div", { class: "panel-body" }, toolsList(data.tools))))));
  view.append(visibilitySection(ctx, data, manage));
  view.append(section("文件", `${skill.files.length} 个，只当文字显示`, panel(h("div", { class: "panel-body" }, filesView(skill.files)))));
  view.append(section("版本历史", "上线过的版本，最近 5 个", panel(table({ columns: [
    { label: "版本", cell: (version) => h("span", {}, h("span", { class: "mono", text: version.version }), version.live ? pill("线上", "ok", true) : null) },
    // A version kept from before versions were recorded: when it went up is not known.
    { label: "上线", cell: (version) => version.source === "earlier" ? h("span", { class: "muted", text: "版本记录开始前" }) : dateTime(version.at) },
    { label: "怎么上的", cell: (version) => SOURCE[version.source] ?? version.source },
    { label: "上架人", cell: (version) => who(version.publishedBy) },
    { label: "审核", cell: (version) => version.approvedBy ? who(version.approvedBy) : "—" },
    ...(manage ? [{ label: "", cell: (version) => version.live ? null : h("button", { class: "button small ghost", type: "button", text: up ? "回到这个版本" : "重新上线这个版本", onclick: () => rollback(ctx, skill, version, up) }) }] : []),
  ], rows: data.versions, emptyText: "这个技能是在版本记录上线前上架的；下次上线起记录。" }))));
  view.append(section("记录", "对这个技能做过的事，最近 30 条", panel(h("div", { class: "panel-body" }, auditTimeline(data.trail)))));
}

function visibilitySection(ctx, data, manage) {
  const chosen = data.visibility.departments.map((department) => ({ ...department }));
  const save = h("button", { class: "button primary small", type: "button", text: "保存可见范围", onclick: async () => {
    try { await api.put(`skills/${encodeURIComponent(data.skill.id)}/visibility`, { departments: chosen.map((department) => department.id) }); toast(chosen.length ? `只对 ${chosen.length} 个部门可见` : "对全员可见"); ctx.navigate(`skills/${encodeURIComponent(data.skill.id)}`, {}, { replace: true }); }
    catch (error) { toast(error.message, "bad"); }
  } });
  return section("谁能看见", "指定部门时，只有这些部门和它们的下级部门的人能看见和使用", panel(h("div", { class: "panel-body grid" }, departmentChooser(chosen, manage),
    manage ? h("div", { class: "control-line" }, save, h("span", { class: "muted", text: "不选任何部门就是全员。没有同步到组织架构的人只能看到全员可见的技能。" })) : null)));
}

async function rollback(ctx, skill, version, up = true) {
  const ok = await confirm(up
    ? { title: `回到 ${version.version}？`, message: `线上的 ${skill.version} 换成 ${version.version}。已经在用 ${skill.version} 的任务下一轮会停下，要新建任务才能用 ${version.version}。`, confirmText: "回到这个版本" }
    : { title: `重新上线 ${version.version}？`, message: "能看见它的人下次打开技能中心时又能用它。可见范围是下架前的设置，可以先在上面改。", confirmText: "重新上线" });
  if (!ok) return;
  try { await api.post(`skills/${encodeURIComponent(skill.id)}/rollback`, { digest: version.digest }); toast(`已回到 ${version.version}`); ctx.navigate(`skills/${encodeURIComponent(skill.id)}`, {}, { replace: true }); }
  catch (error) { toast(error.message, "bad"); }
}
