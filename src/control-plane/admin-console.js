// What an administrator sees. Read-only, on purpose.
//
// A console that can change policy, whose numbers are wrong, changes the wrong
// thing. So the first one only shows: what this deployment is configured to do,
// which models exist and whether they answer, what has been published, and the
// last few things that happened. Once those have been read against reality for
// a while, the parts that write get added -- docs/server-administration.md, R3
// and R4.
//
// It holds nothing of its own. Every number here is read from whatever already
// owns it at the moment somebody asks, so there is no second copy of the truth
// to drift.
//
// **It never shows what anybody said.** No prompt, no answer, no cell of
// anybody's table. That is kept true by this file having no way to reach them,
// not by a page choosing not to render them.
export const AUDIT_KEPT = 200;

// The last few things that happened, for the console to show. In memory and
// bounded: a restart clears it, which the page says. Durable audit is the
// operator's own log collection -- every event here is also a JSON line on
// stderr, which is what survives.
export function auditTail({ kept = AUDIT_KEPT } = {}) {
  const held = [];
  return {
    record(event) {
      held.push({ at: Date.now(), ...event });
      if (held.length > kept) held.splice(0, held.length - kept);
    },
    recent(limit = 50) { return held.slice(-Math.max(1, Math.min(limit, kept))).reverse(); },
    get size() { return held.length; },
  };
}

const escape = (value) => String(value).replace(/[&<>"]/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

// Everything the console knows, as data. The page is a rendering of this, and
// so is /admin/state.json -- one shape, so what somebody reads and what they
// could script against cannot disagree.
export function adminState({ deployment = {}, models = [], health = null, sites = [], directory = null, audit = null, visibility = null, usage = null } = {}) {
  return {
    deployment: {
      // What this deployment lets happen, in the words the settings use.
      sitesOrigin: deployment.sitesOrigin ?? null,
      anonymous: deployment.anonymous === true,
      allowlist: deployment.allowlist ?? null,
      unattended: deployment.unattended === true,
      sandboxMode: deployment.sandboxMode ?? null,
    },
    models: models.map((model) => ({
      id: model.id,
      provider: model.provider ?? null,
      // Whether it can answer right now, as model-health.js has been finding
      // out from real requests -- not a ping this page invented.
      usable: health ? health.usable(model.id) : null,
      isDefault: model.isDefault === true,
    })),
    sites: sites.map((site) => ({
      id: site.id, name: site.name, scope: site.share?.scope ?? null,
      inherit: site.share?.inherit === true, offline: site.offline === true,
      sourced: site.sourced === true, bytes: site.bytes ?? null, createdAt: site.createdAt ?? null,
    })),
    administrators: directory,
    // The policy as written. The ids are in it: this page is for the person who
    // wrote the file and can read it anyway, and a rule you cannot see the
    // target of is a rule you cannot check.
    visibility: visibility?.enabled
      ? { enabled: true, defaultVisible: visibility.defaultVisible,
        rules: visibility.rules.map((rule) => ({ kind: rule.kind, id: rule.id, models: [...rule.models] })) }
      : { enabled: false },
    // Counts, and only counts. There is no column in the ledger for a prompt
    // or an answer, which is why this cannot show one.
    usage: usage ? { days: usage.days ?? 30, people: usage.people ?? [], models: usage.models ?? [], enforcing: false } : null,
    audit: audit ?? [],
    // Named here so the page never has to claim more than it has.
    notYet: ["按额度降级（下一版）", "改动任何设置"],
  };
}

const row = (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
// The same words the sharing panel uses. A console that says "tenant" where the
// product says 组织内获得链接的人可阅读 makes somebody translate between two
// vocabularies for one thing.
const SCOPE_WORDS = Object.freeze({ invited: "仅邀请的人可访问", tenant: "组织内获得链接的人可阅读", anyone: "互联网上获得链接的人可阅读" });
const yes = (value) => value === true ? "是" : value === false ? "否" : "—";
const number = (value) => Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";

export function adminPage(state, { who = null } = {}) {
  const models = state.models.length
    ? state.models.map((model) => row([escape(model.id) + (model.isDefault ? ' <em>默认</em>' : ""),
      escape(model.provider ?? "—"), model.usable === null ? "—" : model.usable ? "能答" : '<b class="bad">答不了</b>'])).join("")
    : row(["—", "—", "没有配置任何模型"]);
  const sites = state.sites.length
    ? state.sites.map((site) => row([escape(site.name), site.offline ? "已下线" : escape(site.inherit ? "跟随表格权限" : SCOPE_WORDS[site.scope] ?? site.scope ?? "—"),
      yes(site.sourced), site.bytes === null ? "—" : `${Math.max(1, Math.round(site.bytes / 1024))} KB`])).join("")
    : row(["—", "—", "—", "还没有发布过网站"]);
  const audit = state.audit.length
    ? state.audit.map((event) => row([new Date(event.at).toLocaleString("zh-CN", { hour12: false }),
      escape(event.event ?? "—"), escape(Object.entries(event).filter(([key]) => !["at", "event"].includes(key))
        .map(([key, value]) => `${key}=${value}`).join(" ").slice(0, 160))])).join("")
    : row(["—", "—", "重启之后还没有事件"]);
  const directory = state.administrators;
  const WHO = { user: "某个人", chat: "某个群", everyone: "所有人" };
  const visibility = state.visibility?.enabled
    ? state.visibility.rules.map((rule) => row([escape(WHO[rule.kind] ?? rule.kind) + (rule.id ? ` <em>${escape(rule.id)}</em>` : ""),
      escape(rule.models.join("、"))])).join("")
    : row(["所有人", "全部模型（没有配置策略）"]);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>服务端管理</title>
<style>
:root{color-scheme:light dark;--bg:#f4f6f6;--paper:#fff;--ink:#16201f;--muted:#62736f;--line:#dfe6e4;--accent:#0f766e;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0e1413;--paper:#161e1d;--ink:#e9efed;--muted:#8fa4a0;--line:#26302e;--accent:#5eead4;--bad:#fca5a5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:1040px;margin:0 auto;padding:40px 20px 72px}
h1{margin:0 0 4px;font-size:clamp(22px,4vw,30px);font-weight:600;letter-spacing:-.02em}
.who{margin:0 0 28px;font-size:13px;color:var(--muted)}
h2{margin:32px 0 10px;font-size:15px;font-weight:600}
section{background:var(--paper);border:1px solid var(--line);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:9px 14px;border-top:1px solid var(--line);vertical-align:top}
tr:first-child td{border-top:0}
thead td{color:var(--muted);font-size:11px;letter-spacing:.06em;background:var(--bg)}
em{font-style:normal;font-size:11px;color:var(--accent)}
b.bad{color:var(--bad);font-weight:600}
.note{margin:10px 0 0;font-size:12px;color:var(--muted)}
.audit td:last-child{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted);word-break:break-all}
</style></head><body><main>
<h1>服务端管理</h1>
<p class="who">${who ? escape(who) + " · " : ""}只读。这一版不改任何设置。</p>

<h2>这个部署允许什么</h2>
<section><table>
${row(["网站地址", escape(state.deployment.sitesOrigin ?? "未开启")])}
${row(["免登录访问", state.deployment.anonymous ? '<b class="bad">开着</b>（任何拿到链接的人都能打开）' : "关着"])}
${row(["网段白名单", state.deployment.allowlist?.length ? escape(state.deployment.allowlist.join("、")) : '<b class="bad">没有限制</b>'])}
${row(["无人值守定时任务", yes(state.deployment.unattended)])}
${row(["沙箱模式", escape(state.deployment.sandboxMode ?? "—")])}
</table></section>
${state.deployment.anonymous && !state.deployment.allowlist?.length
  ? '<p class="note">免登录开着、又没有网段白名单：任何能连到这个端口的人都能打开免登录的网站。设 IDOU_SITES_ALLOW 收一收。</p>' : ""}

<h2>模型</h2>
<section><table><thead>${row(["模型", "来源", "现在能不能答"])}</thead>${models}</table></section>
<p class="note">「能不能答」来自真实请求的结果（model-health），不是这个页面去 ping 出来的。</p>

<h2>用量</h2>
${state.usage ? `<section><table><thead>${row(["谁", "请求数", "token", "用了几个模型", "最近一次"])}</thead>${
  state.usage.people.length
    ? state.usage.people.map((person) => row([escape(person.userId), number(person.requests), number(person.tokens),
      String(person.models), person.lastAt ? new Date(person.lastAt).toLocaleString("zh-CN", { hour12: false }) : "—"])).join("")
    : row(["—", "—", "—", "—", `最近 ${state.usage.days} 天还没有人用过`])}</table></section>
<section><table><thead>${row(["模型", "请求数", "token", "多少人用"])}</thead>${
  state.usage.models.length
    ? state.usage.models.map((model) => row([escape(model.model), number(model.requests), number(model.tokens), String(model.people)])).join("")
    : row(["—", "—", "—", "—"])}</table></section>
<p class="note">最近 ${state.usage.days} 天，按 token 从多到少。按 UTC 分天。
<b>这一版只记不拦</b>：额度还没有任何拦截或降级，先让这些数字被看见、被核对，下一版才照着它们动作。
账本里只有计数——没有提示词、没有回答、没有工具参数那几列，所以这个页面也拿不到。</p>`
  : '<section><table>' + row(["—", "没有开启用量记账（IDOU_MODEL_USAGE_FILE）"]) + '</table></section>'}

<h2>模型可见性</h2>
<section><table><thead>${row(["谁", "看得见哪些"])}</thead>${visibility}</table></section>
<p class="note">${state.visibility?.enabled
  ? `越具体的规则越优先：某个人 &gt; 某个群 &gt; 所有人，命中一条就不再往下看，不会合并。没有规则命中的人${
    state.visibility.defaultVisible === "all" ? "看得见全部模型" : "看不见任何模型，会落回服务端默认那一个"}。`
  : "没有配置 IDOU_MODEL_POLICY_FILE，所有人看得见全部模型。"}
这条策略同时管「能选哪些」和「能不能用」——网关按人拒绝，只过滤列表是挡不住的。</p>

<h2>已发布的网站</h2>
<section><table><thead>${row(["名字", "谁能打开", "接了表格", "大小"])}</thead>${sites}</table></section>

<h2>管理员</h2>
<section><table>
${row(["管理员群", escape(directory?.chatId ?? "未设置")])}
${row(["群里的人数", directory?.counts?.chat === null ? '<b class="bad">读不到</b>' : String(directory?.counts?.chat ?? 0)])}
${row(["配置文件里写死的", String(directory?.counts?.configured ?? 0)])}
</table></section>
${directory?.unreadable ? `<p class="note">读不到管理员群：${escape(String(directory.unreadable).replace(/[。.]\s*$/, ""))}。应用机器人必须是那个群的成员。</p>` : ""}

<h2>最近发生了什么</h2>
<section class="audit"><table><thead>${row(["时间", "事件", "细节"])}</thead>${audit}</table></section>
<p class="note">最近 ${AUDIT_KEPT} 条，存在内存里，重启就没了。要长期留存，收集服务端 stderr 上的 JSON 行。
这里不显示任何人问了什么、模型答了什么——那些数据不在这个页面能拿到的地方。</p>

<h2>还没有的</h2>
<section><table>${state.notYet.map((item) => row([escape(item)])).join("")}</table></section>
</main></body></html>`;
}
