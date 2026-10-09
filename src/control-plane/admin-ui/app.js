// The console's frame: who is signed in, the navigation, the search, and which
// page is showing. Pages live in their own modules; each is given the element
// to draw into and what the address asked for.
import { api, setCsrf } from "./api.js";
import { h, clear, icon, avatar, errorBanner, loading, pill } from "./ui.js";
import { overviewPage, adminsPage, systemPage, sitesPage } from "./pages-system.js";
import { peoplePage, personPage } from "./pages-people.js";
import { usagePage, auditPage } from "./pages-data.js";
import { policyPage } from "./pages-policy.js";
import { orgPage } from "./pages-org.js";
import { tasksPage, siteSafetyPage } from "./pages-content.js";
import { skillsPage, skillPage } from "./pages-skills.js";

const NAV = [
  { group: null, items: [{ path: "overview", label: "概览", icon: "overview" }] },
  { group: "成员与权限", items: [{ path: "people", label: "成员", icon: "people" }, { path: "org", label: "组织架构", icon: "tree", needs: "org" }, { path: "admins", label: "管理员与角色", icon: "shield" }] },
  { group: "策略", items: [{ path: "policy", label: "模型、额度与功能", icon: "sliders", needs: "policy" }] },
  { group: "数据", items: [{ path: "usage", label: "用量", icon: "chart", needs: "usage" }, { path: "audit", label: "审计日志", icon: "list" }] },
  { group: "内容", items: [{ path: "sites", label: "文档网站", icon: "globe", needs: "sites" }, { path: "site-safety", label: "内容安全", icon: "scan", needs: "siteSafety" },
    { path: "tasks", label: "定时任务", icon: "clock", needs: "tasks" },
    { path: "skills", label: "企业技能", icon: "puzzle", needs: "skills" }] },
  { group: "系统", items: [{ path: "system", label: "服务状态", icon: "pulse", needs: "system" }] },
];
const PAGES = { overview: overviewPage, people: peoplePage, person: personPage, org: orgPage, admins: adminsPage, policy: policyPage, usage: usagePage, audit: auditPage, sites: sitesPage,
  tasks: tasksPage, skills: skillsPage, skill: skillPage, "site-safety": siteSafetyPage, system: systemPage };
const TITLES = { overview: "概览", people: "成员", person: "成员详情", org: "组织架构", admins: "管理员与角色", policy: "策略", usage: "用量", audit: "审计日志", sites: "文档网站",
  tasks: "定时任务", skills: "企业技能", skill: "技能详情", "site-safety": "内容安全", system: "服务状态" };

let me = null;
let rendering = 0;

// "#/people/ou_x?status=disabled" → { page: "person", id: "ou_x", params }
export function route(hash = window.location.hash) {
  const [path, search = ""] = hash.replace(/^#\/?/, "").split("?");
  const [first, second] = path.split("/").map((part) => decodeURIComponent(part || ""));
  const params = Object.fromEntries(new URLSearchParams(search));
  if (first === "people" && second) return { page: "person", id: second, params };
  if (first === "skills" && second) return { page: "skill", id: second, params };
  return { page: PAGES[first] ? first : "overview", id: null, params };
}
export function navigate(page, params = {}, { replace = false } = {}) {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== "")).toString();
  const hash = `#/${page}${search ? `?${search}` : ""}`;
  if (replace) window.history.replaceState(null, "", hash); else window.location.hash = hash;
  if (replace) void render();
}
const can = (permission) => Boolean(me?.permissions?.includes(permission));

function drawNav(current) {
  const nav = clear(document.getElementById("nav"));
  for (const { group, items } of NAV) {
    const shown = items.filter((item) => !item.needs || me.features[item.needs]);
    if (!shown.length) continue;
    const box = h("div", { class: "nav-group" }, group ? h("div", { class: "nav-label", text: group }) : null);
    for (const item of shown) {
      const active = current === item.path || (current === "person" && item.path === "people") || (current === "skill" && item.path === "skills");
      box.append(h("a", { class: `nav-item${active ? " active" : ""}`, href: `#/${item.path}`, "aria-current": active ? "page" : null,
        onclick: () => document.getElementById("shell").classList.remove("nav-open") }, icon(item.icon), h("span", { text: item.label })));
    }
    nav.append(box);
  }
}

function drawWhoami() {
  const host = clear(document.getElementById("whoami"));
  // Limited to some departments: which, in a word or two, the whole list on hover.
  const scope = me.scope ? (me.scope.length ? `${me.scope[0].name}${me.scope.length > 1 ? ` 等 ${me.scope.length} 个部门` : ""}` : "没有部门") : "";
  host.append(h("div", { class: "who", title: me.scope ? `管理范围：${me.scope.map((d) => d.trail.join(" / ")).join("；") || "没有部门（原来的部门已不在通讯录里）"}` : "" },
    h("b", { text: me.user.name || me.user.userId }), h("span", { text: scope ? `${me.roleName} · ${scope}` : me.roleName })),
    avatar(me.user.name, me.user.userId),
    h("a", { class: "button ghost small", href: "/_auth/logout", title: "退出管理后台" }, icon("out"), "退出"));
  const release = document.getElementById("release");
  release.textContent = me.release ? `服务端版本 ${me.release}` : "";
}

// Anybody, by name or open_id, from any page.
function drawSearch() {
  const host = clear(document.getElementById("search"));
  const input = h("input", { type: "search", placeholder: "搜索成员：姓名或 open_id", "aria-label": "搜索成员", autocomplete: "off" });
  const results = h("div", { class: "search-results hidden", role: "listbox" });
  let timer = null, last = "";
  const close = () => results.classList.add("hidden");
  const run = async (text) => {
    if (!text) { close(); return; }
    last = text;
    try {
      const page = await api.get("people", { q: text, limit: 8, sort: "active" });
      if (text !== last) return;
      clear(results);
      if (!page.people.length) results.append(h("div", { class: "empty", text: "没有找到" }));
      for (const person of page.people) {
        results.append(h("a", { href: `#/people/${encodeURIComponent(person.userId)}`, role: "option", onclick: () => { input.value = ""; close(); } },
          avatar(person.name, person.userId), h("span", { class: "names" }, h("b", { text: person.name || person.userId }), h("span", { class: "muted mono", text: person.userId })),
          person.access?.disabled ? pill("已停用", "bad") : null));
      }
      results.classList.remove("hidden");
    } catch { close(); }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => run(input.value.trim()), 250); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { input.value = ""; close(); }
    if (event.key === "Enter") { const first = results.querySelector("a"); if (first) { first.click(); window.location.hash = first.getAttribute("href"); } }
  });
  document.addEventListener("click", (event) => { if (!host.contains(event.target)) close(); });
  host.append(icon("search", "glass"), input, results);
}

export function setCrumbs(...parts) {
  const host = clear(document.getElementById("crumbs"));
  parts.forEach((part, index) => {
    if (index) host.append(h("span", { text: "/", class: "faint" }));
    host.append(part.href ? h("a", { href: part.href, text: part.text }) : h("b", { text: part.text }));
  });
  document.title = `${parts.at(-1)?.text ?? "管理后台"} · i豆 管理后台`;
}

async function render() {
  const ticket = ++rendering;
  const where = route();
  drawNav(where.page);
  setCrumbs({ text: TITLES[where.page] });
  const content = clear(document.getElementById("content"));
  content.append(loading());
  try {
    const view = h("div");
    await PAGES[where.page](view, { ...where, me, can, navigate, setCrumbs, stale: () => ticket !== rendering });
    if (ticket !== rendering) return;
    clear(content).append(view);
    content.focus({ preventScroll: true });
  } catch (error) {
    if (ticket !== rendering) return;
    clear(content).append(errorBanner(error));
  }
}

async function start() {
  try {
    me = await api.get("me");
  } catch (error) {
    clear(document.getElementById("content")).append(errorBanner(error));
    return;
  }
  setCsrf(me.csrf);
  drawWhoami();
  drawSearch();
  document.getElementById("menu").addEventListener("click", () => document.getElementById("shell").classList.toggle("nav-open"));
  window.addEventListener("hashchange", () => void render());
  if (!window.location.hash) window.history.replaceState(null, "", "#/overview");
  await render();
}

void start();
