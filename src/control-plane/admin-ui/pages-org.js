// 组织架构: what Feishu's address book says -- departments, who has left -- and,
// until the application may read it, exactly what to turn on.
import { api } from "./api.js";
import { h, append, clear, pageHead, panel, table, pill, dateTime, ago, fmt, section, toast, empty, kv, personCell, statusPill, searchInput, confirm } from "./ui.js";

const STATES = { never: ["还没有同步过", ""], running: ["正在同步", "info"], ok: ["正常", "ok"], missing_scopes: ["缺少通讯录权限", "warn"], missing_range: ["通讯录范围不够", "warn"],
  feishu_refused: ["飞书拒绝了", "bad"], too_large: ["组织太大", "bad"], failed: ["同步失败", "bad"] };
// What the application may read of the address book, in words.
const rangeText = (range) => !range ? null : range.all ? "全部成员" : `${fmt(range.departments)} 个部门、${fmt(range.users)} 个人（不是全部成员）`;

export async function orgPage(view, ctx) {
  const data = await api.get("org");
  if (ctx.stale()) return;
  if (!data.available) {
    view.append(pageHead("组织架构", "这个部署没有配置飞书应用，读不了通讯录。"));
    return;
  }
  const { status } = data;
  const [label, tone] = STATES[status.state] ?? [status.state, ""];
  view.append(pageHead("组织架构", "从飞书通讯录读来的部门，和每个用过 i豆 的人所在的部门。每天同步一次；飞书显示已离职的人会自动停用，列在下面等你做离职清理。",
    ctx.can("people.manage") && data.canSync ? [h("button", { class: "button primary", type: "button", text: status.state === "running" ? "正在同步…" : "立即同步", disabled: status.state === "running",
      onclick: () => syncNow(ctx) })] : []));

  view.append(panel(h("div", { class: "panel-body" }, kv([
    ["状态", h("span", {}, pill(label, tone), status.detail?.message && status.state !== "ok" ? h("span", { class: "sub", text: status.detail.message }) : null)],
    ["上次完成", status.finishedAt ? `${ago(status.finishedAt)}（${dateTime(status.finishedAt)}）` : "—"],
    status.detail?.range ? ["通讯录权限范围", rangeText(status.detail.range)] : null,
    ["部门", `${fmt(status.departments)} 个`],
    data.scoped ? ["你管理的部门", `待清理 ${fmt(status.pending)} 人`] : ["核对过的人", `${fmt(status.people)} 人，其中飞书显示已离职 ${fmt(status.departed)} 人（待清理 ${fmt(status.pending)} 人）`],
    status.state === "ok" && status.detail?.unknown ? ["不在通讯录权限范围里", `${fmt(status.detail.unknown)} 人（没有核对；不会因此停用）`] : null,
  ]))));

  const partial = status.state === "ok" && status.detail?.range && !status.detail.range.all;
  if (["missing_scopes", "missing_range", "never"].includes(status.state) || status.detail?.missingField || partial) view.append(scopesHelp(data, status));

  // The tree, unfolded a level at a time.
  const tree = h("div", { class: "tree" });
  const rows = (departments, depth) => departments.map((department) => {
    const children = h("div", { class: "tree-children" });
    let open = false;
    const toggle = department.children ? h("button", { class: "tree-toggle", type: "button", "aria-expanded": "false", text: "▸", onclick: async () => {
      open = !open; toggle.setAttribute("aria-expanded", String(open)); toggle.textContent = open ? "▾" : "▸";
      if (!open) { clear(children); return; }
      try { const page = await api.get("org/departments", { parent: department.id }); clear(children).append(...rows(page.departments, depth + 1)); }
      catch (error) { toast(error.message, "bad"); }
    } }) : h("span", { class: "tree-toggle placeholder" });
    return h("div", { class: "tree-node" },
      h("div", { class: "tree-row", style: { "padding-left": `${12 + depth * 20}px` } }, toggle, h("b", { text: department.name }),
        h("span", { class: "muted", text: `${fmt(department.memberCount)} 人` }), h("span", { class: "spacer" }),
        !ctx.me.scope || ctx.me.scope.some((mine) => department.path.startsWith(mine.path))
          ? h("a", { class: "button small ghost", href: `#/people?department=${encodeURIComponent(department.id)}`, text: "看成员" }) : null),
      children);
  });
  tree.append(...(data.top.length ? rows(data.top, 0) : [empty(status.state === "ok" ? "通讯录里没有部门" : "还没有部门：开通权限并同步之后会出现在这里")]));
  view.append(section("部门", data.top.length ? `${data.top.length} 个一级部门` : "", panel(tree)));

  view.append(waitingList(data, ctx));
  if (data.cleaned.length) view.append(section("最近清理", "", panel(table({ columns: [
    { label: "成员", cell: (row) => personCell({ userId: row.userId, name: row.name }) },
    { label: "飞书显示离职", cell: (row) => dateTime(row.departedAt) },
    { label: "清理时间", cell: (row) => dateTime(row.cleanedAt) },
  ], rows: data.cleaned, onRow: (row) => { window.location.hash = `#/people/${encodeURIComponent(row.userId)}`; } }))));
  view.append(h("p", { class: "note", text: "离职的判断以飞书为准；不在通讯录权限范围里的人不会被当成离职。被自动停用的人，你在成员页恢复之后，同步不会再次停用他。离职清理要你确认后才执行。" }));
}

// 待清理: who Feishu says has left and whose data is still here, earliest
// first. Ticked ones are cleaned up together, up to data.bulk at a time.
function waitingList(data, ctx) {
  const { status } = data;
  const manage = ctx.can("offboard") && data.canOffboard;
  const selected = new Set();
  const bar = h("div", { class: "bulkbar hidden" });
  const boxes = [];
  const drawBar = () => {
    clear(bar).classList.toggle("hidden", selected.size === 0);
    for (const box of boxes) box.closest("tr")?.classList.toggle("selected", box.checked);
    if (!selected.size) return;
    const over = selected.size > data.bulk;
    append(bar, [h("b", { text: `已选 ${selected.size} 人` }),
      over ? h("span", { class: "muted", text: `一次最多 ${data.bulk} 人` }) : null,
      h("button", { class: "button small danger solid", type: "button", text: "离职清理", disabled: over, onclick: () => offboardMany(ctx, [...selected]) }),
      h("button", { class: "button small ghost", type: "button", text: "取消选择", onclick: () => { selected.clear(); for (const box of boxes) box.checked = false; all.checked = false; drawBar(); } })]);
  };
  const all = h("input", { type: "checkbox", "aria-label": "全选", onchange: () => {
    for (const box of boxes) { box.checked = all.checked; if (all.checked) selected.add(box.value); else selected.delete(box.value); }
    drawBar();
  } });
  const hint = status.pending
    ? `${fmt(status.pending)} 人已自动停用，数据还在${status.pending > data.pending.length ? `；先显示最早的 ${data.pending.length} 人，处理完会显示后面的` : ""}`
    : "";
  return section("待清理", hint, panel(manage ? bar : null, table({ columns: [
    { label: "成员", cell: (row) => personCell({ userId: row.userId, name: row.name }) },
    { label: "飞书显示离职", cell: (row) => h("span", {}, dateTime(row.departedAt), h("span", { class: "sub", text: ago(row.departedAt) })) },
    { label: "在 i豆 的状态", cell: (row) => h("span", { title: row.access.reason ? `原因：${row.access.reason}` : "" }, statusPill(row.access)) },
    { label: "", cell: (row) => h("a", { class: "button small ghost", href: `#/people/${encodeURIComponent(row.userId)}`, text: "查看" }) },
  ], rows: data.pending, emptyText: status.departed ? "都清理完了" : "没有",
  selectable: manage && data.pending.length ? { all, box: (row) => {
    const box = h("input", { type: "checkbox", value: row.userId, "aria-label": `选择 ${row.name || row.userId}`,
      onchange: () => { if (box.checked) selected.add(row.userId); else selected.delete(row.userId); drawBar(); } });
    boxes.push(box);
    return box;
  } } : null })));
}

// What goes, summed over everybody ticked, then confirmed by typing how many.
async function offboardMany(ctx, userIds) {
  let preview;
  try { preview = await api.get("people/offboard", { ids: userIds.join(",") }); } catch (error) { toast(error.message, "bad"); return; }
  if (!preview.people.length) { toast("选中的人里没有可以清理的（不能清理自己或配置文件里的超级管理员）", "bad"); return; }
  const { totals } = preview;
  const line = (label, value) => h("li", {}, h("b", { text: `${label}：` }), value);
  const names = preview.people.map((person) => person.name || person.userId);
  const extra = h("div", { class: "grid" },
    h("p", { class: "muted", text: `${names.slice(0, 8).join("、")}${names.length > 8 ? ` 等 ${names.length} 人` : ""}。先停用，让他们在所有设备上退出；然后一个一个清理：` }),
    h("ul", { class: "plain-list" },
      line("删除", `定时任务 ${fmt(totals.schedules)} 个和运行记录 ${fmt(totals.runs)} 条；无人值守授权 ${fmt(totals.credentials)} 份；选用的模型 ${fmt(totals.models)} 个；云盘额度记录 ${fmt(totals.reservations)} 条`),
      line("下线、文件保留", totals.sites ? `${fmt(totals.sites)} 个网站——链接会立刻失效` : "没有在线的网站"),
      line("保留", "用量计数和审计记录，成员列表里的名字"),
      line("不在这里处理", "他们在飞书里的账号、云盘和群，按飞书的离职流程处理")),
    preview.skipped.length ? h("p", { class: "muted", text: `跳过 ${preview.skipped.length} 人：自己或配置文件里的超级管理员。` }) : null);
  const answer = await confirm({ title: `离职清理 ${preview.people.length} 人`, danger: true, confirmText: "清理", typed: preview.confirm, extra, wide: true,
    message: "这一步删除的数据不能恢复。" });
  if (!answer) return;
  try {
    const result = await api.post("people/offboard", { userIds: preview.people.map((person) => person.userId), confirm: preview.confirm });
    if (result.failed.length) toast(`清理了 ${result.done} 人；${result.failed.length} 人没有成功（${result.failed[0].name || result.failed[0].userId}：${result.failed[0].message}），他们还在列表里，可以再试`, "bad");
    else toast(`已清理 ${result.done} 人`);
  } catch (error) { toast(error.message, "bad"); }
  ctx.navigate("org", {}, { replace: true });
}

function scopesHelp(data, status) {
  const missing = status.detail?.missingField ? [status.detail.missingField] : [];
  const range = status.detail?.range;
  const lead = status.detail?.missingField ? `同步成功了，但飞书没有返回人员所在的部门：应用还缺 ${status.detail.missingField}。`
    : status.state === "missing_range" ? "权限开通了，但应用的「通讯录权限范围」不包含要读的部门：飞书拒绝了（40004）。"
    : range && !range.all ? `应用的「通讯录权限范围」现在只有 ${rangeText(range)}，只同步了这些；范围外的人不会被核对，也不会因此停用。要管理全部成员，把范围改成全部成员。`
    : "按部门管理、自动发现离职，需要应用能读飞书通讯录。在飞书开放平台打开 i豆 用的那个应用：";
  return section(status.state === "missing_scopes" || status.state === "never" || missing.length ? "开通通讯录权限" : "扩大通讯录权限范围", "需要飞书开放平台的应用管理员来做", panel(h("div", { class: "panel-body grid" },
    h("p", { class: "muted", text: lead }),
    h("ol", { class: "plain-list" },
      h("li", {}, "「权限管理」里开通以下应用身份权限：", h("ul", { class: "plain-list" }, data.scopes.map((scope) =>
        h("li", {}, h("span", { class: "mono", text: scope.scope }), `（${scope.name}）`, missing.includes(scope.scope) ? pill("缺这一项", "warn") : null)))),
      // Where Feishu's developer console keeps it since its redesign (its own
      // docs, contact-v3/scope/scope_authority, 2026-10-05): not a section of
      // its own any more, but a column of the API permission list -- the
      // person could not find it from the old wording.
      h("li", {}, "还在「开发配置 → 权限管理」：API 权限列表里，上面任意一项通讯录权限那一行有一列「可访问的数据范围」，点它右边的「配置」，选「全部成员」（或你要管理的部门）。"),
      h("li", {}, "「版本管理与发布」里创建一个新版本并申请发布：通讯录范围改了要企业管理员审核通过才生效。"),
      h("li", {}, "回到这里点「立即同步」。")))));
}

async function syncNow(ctx) {
  try { await api.post("org/sync"); toast("已开始同步：人多的话要几分钟"); }
  catch (error) { toast(error.message, "bad"); return; }
  for (let tries = 0; tries < 120; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (ctx.stale()) return;
    const data = await api.get("org").catch(() => null);
    if (data?.status?.state && data.status.state !== "running") { ctx.navigate("org", {}, { replace: true }); return; }
  }
}

// A department, by name: one for the policy editor (its name stays in the
// box), or one after another for a role's scope (`clearOnPick`).
export function departmentPicker(onPick, { clearOnPick = false } = {}) {
  const results = h("div", { class: "pick-results" });
  const input = searchInput("", async (text) => {
    clear(results);
    if (!text) return;
    const found = await api.get("org/search", { q: text });
    if (!found.departments.length) results.append(h("div", { class: "muted", text: "没有找到这个部门" }));
    for (const department of found.departments) {
      results.append(h("button", { class: "pick", type: "button", onclick: () => { clear(results); input.value = clearOnPick ? "" : department.name; onPick(department); } },
        h("span", { class: "names" }, h("b", { text: department.name }), h("span", { class: "muted", text: department.trail.join(" / ") }))));
    }
  }, "搜索部门");
  return h("div", { class: "picker" }, input, results);
}
