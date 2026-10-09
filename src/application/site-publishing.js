// What publishing a site says before anything goes out, for both ways there
// are to it: 文档网站's 发布 and 更新线上, and the Agent's site-publish from a
// conversation (docs/sites-phase1.md §1.1). One card, so the two never tell a
// person different things about the same act.
export const SCOPE_WORDS = Object.freeze({ invited: "仅邀请的人可访问", tenant: "组织内获得链接的人可阅读", anyone: "互联网上获得链接的人可阅读" });

// `share`: who will be able to open it -- as chosen, or, `updating`, as it is
// on the server. `sliced`: the site shows a slice of a table. `task`: the title
// of the task whose Agent asked, when it was not the person's own click.
export function sitePublishCard({ name, files, bytes, share, updating = false, sliced = false, task = null }) {
  const scopeWord = SCOPE_WORDS[share?.scope] ?? SCOPE_WORDS.invited;
  const members = Array.isArray(share?.members) ? share.members.length : 0;
  return { type: "warning", title: updating ? "确认更新线上版本" : "确认发布这个网站",
    message: `「${name}」· ${files} 个文件 · ${Math.max(1, Math.round(bytes / 1024))} KB`,
    detail: `${task ? `任务「${task}」里的智能体要${updating ? "更新" : "发布"}这个网站。\n` : ""}`
      + `谁能打开：${scopeWord}${members ? `，另加 ${members} 位协作者` : ""}${updating ? "（不变）" : ""}\n`
      + `${share?.inherit === true && sliced ? "访问权限跟随这张表格：在飞书里能读这张表的人就能打开，在飞书里移除就立刻打不开。\n" : ""}`
      + `${sliced ? "页面上会显示你选定的那些字段的数据；发布出去就等于把这份数据交给能打开它的人。\n" : ""}`
      + `${share?.scope === "anyone" ? "公开的网站会先经过服务端的内容安全检查：有手机号、身份证号、密钥之类的内容，会送管理员审核或不予发布。\n" : ""}`
      + `${updating ? "\n这会把线上的页面换成当前目录里的文件。已经打开着的人刷新之后看到新的；之前的版本留在「历史版本」里，可以回去。"
        : "\n发布的是当前目录里的静态文件，发出去之后不会因为你改了本机文件而变——要更新就再发布一次。已经发出去的内容不会因为以后收回权限而消失。"}`,
    buttons: ["取消", updating ? "更新" : "发布"], defaultId: 0, cancelId: 0 };
}

// Whether a new sharing lets in anybody the old one did not: a wider scope, a
// collaborator not there before, or following the table where it did not.
// Only that asks first (review of phase 0, 2026-10-03: changing who may open a
// site, groups and the internet included, raised no card at all); letting
// fewer people in is like taking it down, and is not held up.
const RANK = Object.freeze({ invited: 0, tenant: 1, anyone: 2 });
export function widensShare(before, after) {
  if ((RANK[after?.scope] ?? 0) > (RANK[before?.scope] ?? 0)) return true;
  if (after?.inherit === true && before?.inherit !== true) return true;
  const had = new Set((before?.members ?? []).map((member) => `${member.type}:${member.id}`));
  return (after?.members ?? []).some((member) => !had.has(`${member.type}:${member.id}`));
}
const KIND_WORDS = Object.freeze({ user: "人", chat: "群", department: "部门" });
export function siteShareCard({ name, before, after, sliced = false }) {
  const words = (share) => share?.inherit === true && sliced ? "跟随表格权限" : SCOPE_WORDS[share?.scope] ?? SCOPE_WORDS.invited;
  const had = new Set((before?.members ?? []).map((member) => `${member.type}:${member.id}`));
  const added = (after?.members ?? []).filter((member) => !had.has(`${member.type}:${member.id}`));
  return { type: "warning", title: "确认让更多人打开这个网站", message: `「${name}」· ${words(after)}`,
    detail: `谁能打开：${words(before)} → ${words(after)}\n`
      + `${added.length ? `新加的协作者：${added.slice(0, 8).map((member) => `${member.name || KIND_WORDS[member.type] || "协作者"}（${KIND_WORDS[member.type] || "协作者"}）`).join("、")}${added.length > 8 ? ` 等 ${added.length} 个` : ""}\n` : ""}`
      + `${after?.inherit === true && sliced && before?.inherit !== true ? "在飞书里能读这张表的人都能打开，在飞书里移除就立刻打不开。\n" : ""}`
      + `${after?.scope === "anyone" ? "公开的网站会先经过服务端的内容安全检查：有手机号、身份证号、密钥之类的内容，会送管理员审核或不予公开。\n" : ""}`
      + "\n页面和数据不变，只是能打开的人变多了。之后收回范围，已经打开看过的人看到的内容收不回来。",
    buttons: ["取消", "保存"], defaultId: 0, cancelId: 0 };
}
