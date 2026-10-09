// 策略: who may use which models, how much a day, which features -- and, for
// any one person, what they actually get and which rule decided it.
import { api } from "./api.js";
import { h, clear, pageHead, panel, table, pill, dateTime, fmt, tokens, section, confirm, toast, empty, kv, personCell, avatar, searchInput } from "./ui.js";
import { departmentPicker } from "./pages-org.js";

const LEVELS = [["user", "某个人", "最优先"], ["chat", "某个群", "其次"], ["department", "某个部门", "再次"], ["everyone", "所有人", "兜底"]];
const LEVEL_NAME = Object.fromEntries(LEVELS.map(([kind, name]) => [kind, name]));

export async function policyPage(view, ctx) {
  const data = await api.get("policies");
  if (ctx.stale()) return;
  const manage = ctx.can("policy.manage");
  const offered = Object.fromEntries(data.features.map((feature) => [feature.key, feature]));
  view.append(pageHead("策略", data.scoped
    ? "你可以为你管理的部门和其中的人设置能用的模型、每天的额度和功能开关。对所有人、对群的规则由管理整个组织的管理员设置，这里只列出会影响到你的人的那些。"
    : "按所有人、群、某个人设置能用的模型、每天的额度和功能开关。越具体的规则越优先；同一层有几条都适用时，取最严的。部署本身没开的功能，规则开不了。",
    manage ? [h("button", { class: "button primary", type: "button", text: "新建规则", onclick: () => editRule(ctx, data, null) })] : []));

  // Try it on somebody.
  const result = h("div");
  view.append(section("试一试", "选一个人，看他实际得到什么、由哪条规则决定", panel(h("div", { class: "panel-body grid" },
    personPicker(async (person) => {
      clear(result).append(h("div", { class: "loading-page" }, h("span", { class: "spinner" }), "正在计算…"));
      try { clear(result).append(explain(await api.get("policies/effective", { user: person.userId }), data, offered)); }
      catch (error) { clear(result).append(h("div", { class: "error-banner", text: error.message })); }
    }), result))));

  for (const [kind, name, rank] of LEVELS) {
    const rules = data.rules.filter((rule) => rule.target.kind === kind);
    if (!rules.length && kind === "department") continue;
    view.append(section(`对${name}的规则`, `${rank}${rules.length ? ` · ${rules.length} 条` : ""}`, panel(rules.length ? table({ columns: [
      { label: "对象", cell: (rule) => target(rule) },
      { label: "设置", cell: (rule) => h("span", {}, rule.summary || "（什么都没设）") },
      { label: "备注", cell: (rule) => rule.note || "—" },
      { label: "最后修改", cell: (rule) => rule.source === "file" ? pill("配置文件", "", true) : h("span", {}, dateTime(rule.updated?.at), h("span", { class: "sub", text: rule.updated?.name || rule.updated?.userId || "" })) },
      ...(manage ? [{ label: "", cell: (rule) => !rule.editable ? h("span", { class: "faint", text: rule.source === "file" ? "只读" : "不在你的范围" }) : h("span", { class: "nowrap" },
        h("button", { class: "button small ghost", type: "button", text: "修改", onclick: () => editRule(ctx, data, rule) }),
        h("button", { class: "button small ghost danger", type: "button", text: "删除", onclick: () => removeRule(ctx, rule) })) }] : []),
    ], rows: rules }) : empty(kind === "everyone" ? "没有对所有人的规则：所有人能用全部模型、不限额度、功能都开着（在部署允许的范围内）" : `没有对${name}的规则`))));
  }
  view.append(h("p", { class: "note", text: "「完全访问」由桌面端执行：服务端看不出一次写入是人点了确认卡片，还是完全访问自动放行的。服务端能硬性限制的是写入本身——关掉对应的飞书写入，无论哪种方式都写不进去。" }));
}

function target(rule) {
  if (rule.target.kind === "everyone") return h("b", { text: "所有人" });
  if (rule.target.kind === "user") return personCell({ userId: rule.target.id, name: rule.targetName });
  if (rule.target.kind === "department") return h("span", {}, h("b", { text: rule.targetName || "部门" }), h("span", { class: "sub mono", text: rule.target.id }));
  return h("span", {}, h("b", { text: LEVEL_NAME[rule.target.kind] }), h("span", { class: "sub mono", text: rule.target.id }));
}

function explain(answer, data, offered) {
  const { effective, person } = answer;
  const ruleName = (ids) => (ids ?? []).map((id) => {
    const rule = data.rules.find((candidate) => candidate.id === id);
    return rule ? `${LEVEL_NAME[rule.target.kind]}${rule.target.kind === "everyone" ? "" : `（${rule.targetName || rule.target.id}）`}` : id;
  }).join("、");
  const because = (field) => effective.sources[field] ? h("span", { class: "sub", text: `由 ${ruleName(effective.sources[field])} 决定` }) : h("span", { class: "sub", text: "没有规则，按默认" });
  return h("div", { class: "grid cols-2" },
    h("div", {}, person ? personCell(person) : null, kv([
      ["能用的模型", h("span", {}, effective.models.allowed ? effective.models.allowed.join("、") : `全部（${data.models.join("、")}）`, because("models"))],
      ["默认模型", h("span", {}, effective.models.default ?? "—", because("defaultModel"))],
      ["每天额度", h("span", {}, effective.quota.dailyTokens ? `${tokens(effective.quota.dailyTokens)} token，超额${effective.quota.downgradeTo ? `换用 ${effective.quota.downgradeTo}` : "后拒绝"}` : "不限", because("dailyTokens"))],
      ["同时进行", h("span", {}, effective.quota.concurrency ? `${effective.quota.concurrency} 个请求` : "按服务端的上限", because("concurrency"))],
    ])),
    table({ columns: [
      { label: "功能", cell: (row) => row.name },
      { label: "结果", cell: (row) => !offered[row.key]?.offered ? pill("部署没开", "", true) : effective.features[row.key] ? pill("开", "ok") : pill("关", "bad") },
      { label: "依据", cell: (row) => !offered[row.key]?.offered ? "部署配置" : effective.sources[row.key] ? ruleName(effective.sources[row.key]) : "默认开" },
    ], rows: data.features }));
}

// A person, by name, from the directory.
export function personPicker(onPick, placeholder = "搜索成员：姓名或 open_id") {
  const results = h("div", { class: "pick-results" });
  const input = searchInput("", async (text) => {
    clear(results);
    if (!text) return;
    const page = await api.get("people", { q: text, limit: 6 });
    if (!page.people.length) results.append(h("div", { class: "muted", text: "没有找到。这个人需要先登录过一次 i豆。" }));
    for (const person of page.people) {
      results.append(h("button", { class: "pick", type: "button", onclick: () => { clear(results); input.value = person.name || person.userId; onPick(person); } },
        avatar(person.name, person.userId), h("span", { class: "names" }, h("b", { text: person.name || person.userId }), h("span", { class: "muted mono", text: person.userId }))));
    }
  }, placeholder);
  return h("div", { class: "picker" }, input, results);
}

async function editRule(ctx, data, rule) {
  const editing = Boolean(rule);
  const settings = rule?.settings ?? {};
  let picked = rule?.target.kind === "user" ? { userId: rule.target.id, name: rule.targetName } : null;
  // Who it is for.
  // Limited to some departments: rules for those departments and the people in them only.
  const kinds = LEVELS.filter(([kind]) => (kind !== "department" || data.departments) && (!data.scoped || ["user", "department"].includes(kind)));
  const kindSelect = h("select", { class: "select", disabled: editing }, kinds.map(([kind, name]) => h("option", { value: kind, text: name, selected: (rule?.target.kind ?? (data.scoped ? "department" : "everyone")) === kind })));
  let pickedDepartment = rule?.target.kind === "department" ? { id: rule.target.id, name: rule.targetName || rule.target.id } : null;
  const chosenDepartment = h("div", { class: "muted", text: pickedDepartment ? pickedDepartment.name : "还没有选部门" });
  const departmentChooser = editing ? null : departmentPicker((department) => { pickedDepartment = department; chosenDepartment.textContent = department.trail.join(" / "); });
  const chatInput = h("input", { class: "input", placeholder: "oc_ 开头的群 id", value: rule?.target.kind === "chat" ? rule.target.id : "", disabled: editing });
  const chosen = h("div", { class: "muted" }, picked ? personCell(picked, { link: false }) : "还没有选人");
  const picker = editing ? null : personPicker((person) => { picked = person; clear(chosen).append(personCell(person, { link: false })); });
  const targetBox = h("div", { class: "field" });
  const drawTarget = () => {
    clear(targetBox).append(h("label", { text: "对谁" }), kindSelect);
    if (kindSelect.value === "chat") targetBox.append(chatInput, h("span", { class: "help", text: "群里的人都适用。应用机器人要在这个群里才读得到成员；大群最多读前 5000 人。" }));
    if (kindSelect.value === "user") targetBox.append(picker ?? h("span"), chosen);
    if (kindSelect.value === "department") targetBox.append(departmentChooser ?? h("span"), chosenDepartment, h("span", { class: "help", text: "这个部门和它下面所有部门的人都适用；离得近的部门的规则优先。" }));
  };
  kindSelect.addEventListener("change", drawTarget);
  drawTarget();
  // Models.
  const modelBoxes = data.models.map((model) => h("label", { class: "check-label" }, h("input", { type: "checkbox", value: model, checked: settings.models?.allowed ? settings.models.allowed.includes(model) : false }), model));
  const defaultSelect = h("select", { class: "select" }, h("option", { value: "", text: "不指定" }), data.models.map((model) => h("option", { value: model, text: model, selected: settings.models?.default === model })));
  // Quota.
  const dailyInput = h("input", { class: "input", type: "number", min: 1, step: 1, placeholder: "不限", value: settings.quota?.dailyTokens ?? "" });
  const downgradeSelect = h("select", { class: "select" }, h("option", { value: "", text: "超额后拒绝" }), data.models.map((model) => h("option", { value: model, text: `换用 ${model}`, selected: settings.quota?.downgradeTo === model })));
  const concurrencyInput = h("input", { class: "input", type: "number", min: 1, max: 64, step: 1, placeholder: "按服务端上限", value: settings.quota?.concurrency ?? "" });
  // Features: not said here, on, off.
  const featureRows = data.features.map((feature) => {
    const current = settings.features?.[feature.key];
    const select = h("select", { class: "select", disabled: !feature.offered, dataset: { key: feature.key } },
      h("option", { value: "", text: "不在这条规则里设置", selected: current === undefined }), h("option", { value: "on", text: "开", selected: current === true }), h("option", { value: "off", text: "关", selected: current === false }));
    return h("div", { class: "feature-row" }, h("span", {}, feature.name, !feature.offered ? h("span", { class: "sub", text: "部署没有开启" }) : feature.clientEnforced ? h("span", { class: "sub", text: "由桌面端执行" }) : null), select);
  });
  const note = h("input", { class: "input", maxlength: 200, placeholder: "例如：财务部的额度", value: rule?.note ?? "" });
  const extra = h("div", { class: "grid policy-editor" },
    targetBox,
    h("div", { class: "field" }, h("label", { text: "能用的模型" }), h("div", { class: "check-group" }, modelBoxes), h("span", { class: "help", text: "都不勾 = 这条规则不管模型。" })),
    h("div", { class: "field" }, h("label", { text: "默认模型" }), defaultSelect),
    h("div", { class: "grid cols-3" },
      h("div", { class: "field" }, h("label", { text: "每天 token 额度" }), dailyInput, h("span", { class: "help", text: "例如 2000000 = 200 万" })),
      h("div", { class: "field" }, h("label", { text: "超额后" }), downgradeSelect),
      h("div", { class: "field" }, h("label", { text: "同时进行的请求" }), concurrencyInput)),
    h("div", { class: "field" }, h("label", { text: "功能开关" }), h("div", { class: "feature-grid" }, featureRows)),
    h("div", { class: "field" }, h("label", { text: "备注" }), note));
  const answer = await confirm({ title: editing ? "修改规则" : "新建规则", confirmText: editing ? "保存" : "新建", extra, wide: true });
  if (!answer) return;
  const allowed = modelBoxes.map((label) => label.querySelector("input")).filter((box) => box.checked).map((box) => box.value);
  const body = {
    settings: {
      models: allowed.length || defaultSelect.value ? { ...(allowed.length ? { allowed } : {}), ...(defaultSelect.value ? { default: defaultSelect.value } : {}) } : null,
      quota: dailyInput.value || concurrencyInput.value ? { dailyTokens: dailyInput.value ? Number(dailyInput.value) : null,
        downgradeTo: dailyInput.value && downgradeSelect.value ? downgradeSelect.value : null, concurrency: concurrencyInput.value ? Number(concurrencyInput.value) : null } : null,
      features: Object.fromEntries(featureRows.map((row) => row.querySelector("select")).filter((select) => select.value).map((select) => [select.dataset.key, select.value === "on"])),
    },
    note: note.value.trim(),
  };
  try {
    if (editing) await api.put(`policies/${rule.id}`, body);
    else {
      const kind = kindSelect.value;
      if (kind === "user" && !picked) { toast("没有选人", "bad"); return; }
      if (kind === "department" && !pickedDepartment) { toast("没有选部门", "bad"); return; }
      await api.post("policies", { ...body, target: { kind, id: kind === "user" ? picked.userId : kind === "chat" ? chatInput.value.trim() : kind === "department" ? pickedDepartment.id : "" } });
    }
    toast(editing ? "已保存，几秒内所有服务进程生效" : "已新建，几秒内所有服务进程生效");
    ctx.navigate("policy", {}, { replace: true });
  } catch (error) { toast(error.message, "bad"); }
}

async function removeRule(ctx, rule) {
  const answer = await confirm({ title: "删除这条规则？", danger: true, confirmText: "删除",
    message: `对${LEVEL_NAME[rule.target.kind]}${rule.targetName ? `「${rule.targetName}」` : ""}的规则：${rule.summary}。删除后由更宽泛的规则决定。` });
  if (!answer) return;
  try { await api.remove(`policies/${rule.id}`); toast("已删除"); ctx.navigate("policy", {}, { replace: true }); }
  catch (error) { toast(error.message, "bad"); }
}
export { fmt };
