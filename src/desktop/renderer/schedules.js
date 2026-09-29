// 定时任务: work that happens without anybody watching.
//
// Laid out after the two products the people using this already work in, 豆包工作
// and WorkBuddy, which put it in the sidebar as a first-class item rather than
// behind a setting, and arrived at the same skeleton:
//
//   - two tabs, 定时任务 and 运行记录 -- the history is a view of its own,
//     across every schedule, not something buried inside one of them
//   - a toolbar: a state filter on the left, 添加定时任务 on the right
//   - a row says the whole thing in one line: name, the rule in words
//     ("每天 09:00"), when it next runs, and its state
//   - creating is one dialog: name, prompt, frequency, validity
//
// One thing here that neither of them needs: an authorization banner. Those
// products run their schedules on their own servers with their own identity;
// this one acts as the person, and only while their login is live. When it is
// not, the honest thing is to say so at the top rather than let a list of
// schedules imply work is happening.
import { RESOURCE_KIND_NAMES, SCHEDULE_TEMPLATES, templateSchedule } from "./schedule-templates.js";

const WEEKDAYS = Object.freeze([["1", "一"], ["2", "二"], ["3", "三"], ["4", "四"], ["5", "五"], ["6", "六"], ["0", "日"]]);
// The reference toolbar's list. 每个工作日 is 每周 on Monday to Friday, a
// shortcut here and not a rule of its own on the server.
const FREQUENCIES = Object.freeze([["daily", "每天"], ["workday", "每个工作日"], ["weekly", "每周"], ["biweekly", "双周"],
  ["monthly", "每月"], ["yearly", "每年"], ["interval", "按间隔"], ["once", "单次"]]);
const WORKDAYS = Object.freeze([1, 2, 3, 4, 5]);
// Which of the choices above each server rule makes possible. The server says
// which rules it will create (`rules` with the list); one from before it said so
// creates exactly these four.
const RULE_CHOICES = Object.freeze({ once: ["once"], daily: ["daily"], weekly: ["workday", "weekly"], biweekly: ["biweekly"],
  monthly: ["monthly"], yearly: ["yearly"], interval: ["interval"] });
const BASE_RULES = Object.freeze(["once", "daily", "weekly", "monthly"]);
// What a task may read, and where its results may be written besides its owner
// (schedule-deliveries.js on the server): a document appended to, a chat sent to.
const RESOURCE_KINDS = Object.freeze({ document: "文档", sheet: "电子表格", base: "多维表格", chat: "会话" });
const DELIVERY_KINDS = Object.freeze({ document: "文档", chat: "会话" });

const pad = (value) => String(value).padStart(2, "0");
const when = (instant) => {
  if (!Number.isFinite(instant)) return "—";
  const date = new Date(instant), now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameDay ? `今天 ${clock}` : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
};
// How far off a moment is, the way WorkBuddy's rows say it: 即将, N 分钟后,
// N 小时后, N 天后. The exact time stays one hover away.
export function relativeTime(at, now = Date.now()) {
  const diff = at - now;
  if (diff <= 0) return "即将";
  const minutes = Math.floor(diff / 60_000), hours = Math.floor(diff / 3_600_000), days = Math.floor(hours / 24);
  if (days > 0) return `${days}天后`;
  if (hours > 0) return `${hours}小时后`;
  return `${Math.max(1, minutes)}分钟后`;
}

// What a task row says on its right (G13): a run going, paused, waiting on an
// authorization, past its end, or when it runs next.
export function scheduleStatus(item, now = Date.now()) {
  if (item.lastRun && item.lastRun.finishedAt === null) return { text: "运行中", tone: "running" };
  if (item.state === "paused") return { text: "已暂停", tone: "quiet" };
  if (item.suspended) return { text: "等待重新授权", tone: "attention" };
  if (Number.isSafeInteger(item.endAt) && item.endAt <= now) return { text: "已过期，不再执行", tone: "quiet" };
  if (Number.isSafeInteger(item.nextAt)) return { text: `${relativeTime(item.nextAt, now)}执行`, tone: "next" };
  return { text: "暂无后续执行", tone: "quiet" };
}

// What a run is called in the history (G16), in WorkBuddy's words: 测试运行
// is our 立即运行, and 补跑 a run that started well after its time.
export function runLabel(run) {
  if (!Number.isSafeInteger(run.finishedAt)) return { text: "运行中", tone: "running" };
  if (run.outcome === "skipped") return { text: "已跳过", tone: "failed" };
  const done = run.outcome === "completed";
  if (run.kind === "manual") return done ? { text: "测试运行完成", tone: "completed" } : { text: "失败", tone: "failed" };
  if (run.kind === "catch-up") return done ? { text: "补跑完成", tone: "completed" } : { text: "补跑失败", tone: "failed" };
  return done ? { text: "成功", tone: "completed" } : { text: "失败", tone: "failed" };
}

// The day a run belongs to in 运行记录 (G15): 今天, 昨天, or 月/日.
export function dateGroup(at, now = new Date()) {
  const day = new Date(at), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  if (that === today.getTime()) return "今天";
  if (that === today.getTime() - 86_400_000) return "昨天";
  return `${day.getMonth() + 1}/${day.getDate()}`;
}
// What a resource is called on the page: the name it was picked by. A chat
// typed in by its ID has none -- the ID stood in as its label, and Feishu's
// oc_… means nothing to a person and does not belong on a screen they share or
// record -- so it reads as unnamed, with the ID's last four characters to tell
// two apart. The whole ID goes on hover (the element's title).
const FEISHU_ID = /^(?:ou|on|oc|cli)_/i;
export function resourceName(resource) {
  const label = String(resource?.label ?? "").trim();
  if (resource?.kind !== "chat") return label || resource?.reference || "（没有名称）";
  const id = String(resource.id ?? "");
  if (label && label !== id && !FEISHU_ID.test(label)) return label;
  return id ? `（没有名称 · …${id.slice(-4)}）` : "（没有名称）";
}
// WorkBuddy's filter for 运行记录. 失败 takes skipped runs too: a run that never
// happened because its authorization lapsed wants attention as much as one that
// broke. The narrowing is done on the server, before the list is cut to 50.
const RUN_FILTERS = Object.freeze([["", "全部"], ["completed", "成功"], ["failed", "失败"], ["running", "运行中"], ["shelved", "已归档"]]);

let listening = false, currentNote = null;
// The dialog showing an Agent's draft, if one is open, so a draft the Agent
// withdrew (its request ended, or nine minutes passed) closes with it.
let draftDialog = null, listeningDrafts = false;
// Which groups of the task list are folded, kept across redraws (G14).
const collapsedGroups = new Set();
// 运行记录 as WorkBuddy pages it (G18): the newest 10, 展开更多 adds 10 at a
// time, 收起 goes back to 10. Read 100 at a time, up to the server's 200.
const RUNS_SHOWN = 10, RUNS_STEP = 10, RUNS_PAGE = 100, RUNS_MOST = 200;
// Which date groups of a run list are folded (G19), by list and label.
const collapsedDates = new Set();
// The page on screen, reloaded when an Agent changed a task from a conversation.
let reloadCurrent = null, listeningChanges = false;
// What a task page's 结果还写到 picker has found -- the kind, the results, a
// search still under way -- by task and revision. The page is drawn again when
// a load finishes, and the picker with it: opening a task and pressing 搜索
// while its runs were still loading put the answer into a picker that was
// already gone, and the one on screen looked as if nothing had been pressed
// (measured on the installed app, 2026-09-28). Kept here, the answer lands in
// whichever picker is on screen when it arrives.
const pickerStates = new Map();

export function schedulesUi({ api, root, element, action, readableError, tab = null, draft = null }) {
  if (!listeningDrafts && api.onScheduleDraftWithdrawn) {
    listeningDrafts = true;
    api.onScheduleDraftWithdrawn((value) => { if (draftDialog?.id === value?.id) draftDialog.dialog.close(); });
  }
  const state = { tab: tab === "runs" ? "runs" : "schedules", view: "list", filter: "", runFilter: "", search: "", selecting: false, selected: new Set(),
    schedules: [], runs: [], runsShown: RUNS_SHOWN, runsAsked: RUNS_PAGE, rules: BASE_RULES, consent: null, loading: false, detailId: null, detailRuns: [], detailFilter: "",
    // Where this server can write a task's results besides its owner ({ max,
    // kinds }), or null for one that cannot: then no such choice is shown.
    deliveries: null };

  // Searching is done here rather than on the server: the list is capped at 50
  // per tenant, so a round trip per keystroke would cost more than it saves.
  const matches = (rows) => {
    const needle = state.search.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) => `${row.title} ${row.prompt ?? ""} ${row.schedule ?? ""}`.toLowerCase().includes(needle));
  };

  // A button whose work is still under way cannot be pressed again: 立即运行
  // pressed twice is two paid runs and two reports. (On 2026-09-25 the server
  // received two run-now requests eleven seconds apart for one press; what sent
  // the second is not known, but a second press while the first is out is the
  // one way this page itself could have done it.)
  const button = (text, className, onclick) => {
    const node = element("button", text, className);
    node.type = "button";
    node.onclick = (event) => {
      if (node.dataset.busy) return undefined;
      const result = onclick(event);
      if (result && typeof result.then === "function") {
        node.dataset.busy = "1"; node.disabled = true;
        Promise.resolve(result).finally(() => { delete node.dataset.busy; node.disabled = false; });
      }
      return result;
    };
    return node;
  };

  async function load() {
    state.loading = true; draw();
    try {
      // Consent is read every time rather than remembered: it lapses with the
      // login, and a stale "authorized" would be the one lie that matters here.
      const [consent, unattended, listed] = await Promise.all([api.scheduleConsent(),
        api.scheduleUnattended().catch(() => ({ available: false })), api.listSchedules(state.filter || undefined)]);
      state.consent = consent;
      state.unattended = unattended;
      state.schedules = listed.schedules ?? [];
      state.rules = Array.isArray(listed.rules) ? listed.rules : BASE_RULES;
      const writable = Array.isArray(listed.deliveries?.kinds) ? listed.deliveries.kinds.filter((kind) => DELIVERY_KINDS[kind]) : [];
      state.deliveries = Number.isSafeInteger(listed.deliveries?.max) && listed.deliveries.max > 0 && writable.length ? { max: listed.deliveries.max, kinds: writable } : null;
      if (state.tab === "runs") state.runs = (await api.scheduleRuns(undefined, state.runsAsked, state.runFilter || undefined)).runs ?? [];
      // A detail page whose task has gone (deleted elsewhere) falls back to the list.
      if (state.view === "detail" && !state.schedules.some((row) => row.id === state.detailId)) { state.view = "list"; state.detailId = null; }
      if (state.view === "detail") state.detailRuns = (await api.scheduleRuns(state.detailId, undefined, state.detailFilter || undefined)).runs ?? [];
    } finally { state.loading = false; draw(); }
  }

  const day = (at) => (Number.isSafeInteger(at) ? new Date(at).toLocaleDateString("zh-CN") : "");

  // Two different bargains, so two different sentences. The session-scoped one
  // really does end when the application closes -- said as a blanket claim it
  // became false the moment unattended runs existed, and it was the one line a
  // person would rely on.
  function banner() {
    const unattended = state.unattended;
    if (unattended?.authorized) {
      const box = element("div", undefined, "schedule-banner");
      const used = unattended.lastUsedAt ? `　上次使用：${day(unattended.lastUsedAt)}` : "";
      box.append(element("span", `无人值守运行已开启，有效期到 ${day(unattended.expiresAt)}。${used}`, "schedule-banner-text"));
      box.append(button("撤销", "ghost", () => action(async () => {
        await api.revokeUnattendedSchedules();
        await load();
        note("已撤销。定时任务之后只在你登录时执行。");
      }, readableError)));
      return box;
    }
    if (!state.consent || state.consent.authorized) {
      // Authorized for this login, but nothing beyond it: a daily task still
      // will not run tonight, and only this line says so.
      if (state.consent?.authorized && unattended?.available && !unattended.authorized) {
        const box = element("div", undefined, "schedule-banner");
        box.append(element("span", unattended.state === "needs_reauthorization"
          ? `无人值守授权已失效${unattended.reason ? `（${unattended.reason}）` : ""}，需要重新授权。`
          : "已在本次登录内授权。要让任务在你退出应用后仍然执行，需要另外授权。", "schedule-banner-text"));
        box.append(button("允许无人值守运行", "primary", () => action(allowUnattended, readableError)));
        return box;
      }
      return null;
    }
    const box = element("div", undefined, "schedule-banner");
    box.append(element("span", "定时任务需要你授权后才会执行。", "schedule-banner-text"));
    const buttons = element("div", undefined, "schedule-banner-actions");
    // Secondary only when there is something to be secondary to. On a server
    // without unattended runs this is the one action in the banner, and drawn
    // ghost it reads as a line of text rather than the thing to press.
    const offersMore = Boolean(state.unattended?.available);
    buttons.append(button("本次登录内授权", offersMore ? "ghost" : "primary", () => action(async () => {
      const result = await api.authorizeSchedules();
      await load();
      note(result?.resumed ? `已授权，${result.resumed} 个任务恢复运行。只在这次登录有效期内，关闭应用即失效。`
        : "已授权。只在这次登录有效期内，关闭应用即失效。");
    }, readableError)));
    if (offersMore) buttons.append(button("允许无人值守运行", "primary", () => action(allowUnattended, readableError)));
    box.append(buttons);
    return box;
  }

  function note(text) {
    const line = root.querySelector(".schedule-note");
    if (line) line.textContent = text;
  }

  // The server gets its own Feishu authorization for this, which usually passes
  // straight through and sometimes needs the person in their browser; either
  // way the answer takes a moment, and the page says what it is waiting for.
  async function allowUnattended() {
    note("正在为定时任务向飞书申请单独的授权……");
    const result = await api.authorizeUnattendedSchedules();
    await load();
    note(result?.resumed ? `已开启，${result.resumed} 个任务恢复运行。` : "已开启无人值守运行。");
  }
  // The page is rebuilt on every render; the one listener speaks to the latest.
  currentNote = note;
  if (!listening && api.onScheduleAuthorization) {
    listening = true;
    api.onScheduleAuthorization((value) => {
      if (value?.handedOver) currentNote?.("飞书需要你确认：已在浏览器里打开授权页，请在那里完成，这里会自动继续。");
    });
  }

  function toolbar() {
    const bar = element("div", undefined, "schedule-toolbar");
    const tabs = element("div", undefined, "schedule-tabs");
    for (const [key, label] of [["schedules", "定时任务"], ["runs", "运行记录"]]) {
      const tab = button(label, state.tab === key ? "schedule-tab current" : "schedule-tab", () => action(async () => { state.tab = key; firstPage(); await load(); }, readableError));
      tab.setAttribute("aria-current", state.tab === key ? "page" : "false");
      tabs.append(tab);
    }
    bar.append(tabs);

    const search = element("input", undefined, "schedule-search");
    search.type = "search";
    search.placeholder = state.tab === "runs" ? "搜索运行记录" : "搜索定时任务";
    search.value = state.search;
    // Redrawn in place rather than through load(): re-fetching on every
    // keystroke would throw away what was typed while the request was out.
    search.oninput = () => { state.search = search.value; state.runsShown = RUNS_SHOWN; drawList(); };
    bar.append(search);

    if (state.tab === "runs") {
      const filter = element("select", undefined, "schedule-filter schedule-run-filter");
      for (const [value, label] of RUN_FILTERS) {
        const option = element("option", label); option.value = value;
        if (state.runFilter === value) option.selected = true;
        filter.append(option);
      }
      filter.onchange = () => action(async () => { state.runFilter = filter.value; firstPage(); await load(); }, readableError);
      bar.append(filter);
    }
    // 刷新, as the reference toolbar has it (G20): the list, the runs and the
    // banner read again now, rather than on the next visit.
    const refresh = button("↻", "ghost schedule-refresh", () => action(load, readableError));
    refresh.title = "刷新"; refresh.setAttribute("aria-label", "刷新");
    bar.append(refresh);

    // The task list is grouped into 运行中 / 当前 / 已暂停 (G14) rather than
    // filtered by state, the way the reference product lays it out.
    if (state.tab === "schedules") {
      bar.append(button(state.selecting ? "退出批量" : "批量管理", state.selecting ? "ghost current" : "ghost", () => {
        state.selecting = !state.selecting; state.selected.clear(); draw();
      }));
      bar.append(button("从模板添加", "ghost schedule-from-template", () => { state.view = "templates"; state.selecting = false; draw(); }));
      bar.append(button("＋ 添加定时任务", "primary schedule-add", () => openDialog()));
    }
    return bar;
  }

  // Shown only in 批量管理: everything that applies to the whole selection, and
  // a count, so nothing here acts on more than the person can see it will.
  function selectionBar(rows) {
    const bar = element("div", undefined, "schedule-selection");
    const all = element("label", undefined, "schedule-weekday");
    const box = element("input"); box.type = "checkbox";
    box.checked = rows.length > 0 && rows.every((row) => state.selected.has(row.id));
    box.onchange = () => { if (box.checked) rows.forEach((row) => state.selected.add(row.id)); else state.selected.clear(); draw(); };
    all.append(box, element("span", "全选"));
    bar.append(all, element("span", `已选 ${state.selected.size} 项`, "schedule-when"));

    const chosen = () => rows.filter((row) => state.selected.has(row.id));
    const bulk = async (label, apply) => action(async () => {
      const picked = chosen();
      if (!picked.length) return;
      for (const item of picked) await apply(item);
      state.selected.clear(); state.selecting = false;
      await load();
      note(`${label} ${picked.length} 个定时任务。`);
    }, readableError);

    bar.append(button("暂停", "ghost", () => bulk("已暂停", (item) => api.setScheduleState(item.id, "paused"))));
    bar.append(button("恢复", "ghost", () => bulk("已恢复", (item) => api.setScheduleState(item.id, "active"))));
    // One card for the whole selection, asked by the main process and naming
    // what it holds: a bulk delete takes every one of their run histories with
    // it. Cancelled, it answers null and nothing has changed.
    bar.append(button("删除", "ghost danger", () => action(async () => {
      const picked = chosen();
      if (!picked.length) return;
      const result = await api.removeSchedules(picked.map((item) => item.id));
      if (!result) return;
      state.selected.clear(); state.selecting = false;
      await load();
      note(`已删除 ${result.removed} 个定时任务。`);
    }, readableError)));
    return bar;
  }

  // Runs one now, outside the rule: the same identity, sandbox, archive and
  // notification as a due run, and the next scheduled time does not move. A
  // refusal comes back as an error, said once, and is not written into the
  // history. The list is read again either way: a refusal can be the moment an
  // unattended credential turned out to be finished, and the banner says so.
  const runNow = (item) => action(async () => {
    try { await api.runScheduleNow(item.id); }
    catch (failure) { await load().catch(() => {}); throw failure; }
    await load();
    // A run now is a run: where the task writes its results, this one writes too.
    const places = item.deliveries?.length ? `，也会写到任务指定的 ${item.deliveries.length} 个地方` : "";
    note(`「${item.title}」已开始运行，结果稍后出现在运行记录里${places}。这次运行不改变下次执行时间。`);
  }, readableError);
  const cannotRunNow = (item) => Boolean(item.promptExpired || item.resourceGrantRequired || item.suspended
    || (Number.isSafeInteger(item.endAt) && item.endAt <= Date.now()));
  const togglePaused = (item) => action(async () => {
    await api.setScheduleState(item.id, item.state === "paused" ? "active" : "paused");
    await load();
  }, readableError);
  // Deleting takes the history with it, so it is asked first, on the main
  // process's card -- the run record is often the only place a person can see
  // what a task has been doing.
  const removeTask = (item) => action(async () => {
    if (!(await api.removeSchedule(item.id))) return;
    if (state.detailId === item.id) { state.view = "list"; state.detailId = null; }
    await load();
    note("定时任务已删除");
  }, readableError);
  const openDetail = (item) => action(async () => {
    state.view = "detail"; state.detailId = item.id; state.detailFilter = ""; state.selecting = false;
    await load();
  }, readableError);

  // What needs the person, said on the row itself: nothing else would show it.
  function warnings(item) {
    const lines = [];
    // Not "登录失效": a suspension has several causes, and the true one is
    // written into the skipped run this schedule's history already holds.
    if (item.suspended) lines.push(["已挂起，需要重新授权", "schedule-suspended"]);
    if (item.promptExpired) lines.push(["提示词已过停用保留期，请在详情里补上", "schedule-suspended"]);
    if (item.resourceGrantRequired) lines.push(["旧任务没有资源授权，需重新创建", "schedule-suspended"]);
    // A rule from a newer build than this one: never run here, and not
    // editable here either.
    if (item.ruleSupported === false) lines.push(["这个版本不会按时执行这个规则，请更新应用", "schedule-suspended"]);
    else if (!state.rules.includes(item.spec?.frequency)) lines.push(["这个版本不能修改这个执行规则，请更新应用", "schedule-when"]);
    return lines.map(([text, tone]) => element("span", text, tone));
  }

  // A task row, the way WorkBuddy draws one (G13): the name and the rule on
  // the left, its state on the right -- when it runs next, as 3小时后执行, or
  // 运行中, 已暂停 -- and on hover ▶ 立即运行 and 更多 (暂停/恢复, 修改资源, 删除).
  // The whole row opens the task.
  function scheduleRow(item) {
    const row = element("div", undefined, "schedule-row schedule-task-row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `打开「${item.title}」`);
    if (state.selecting) {
      const pick = element("input", undefined, "schedule-pick");
      pick.type = "checkbox"; pick.setAttribute("aria-label", `选择「${item.title}」`);
      pick.checked = state.selected.has(item.id);
      pick.onchange = () => { if (pick.checked) state.selected.add(item.id); else state.selected.delete(item.id); draw(); };
      row.append(pick);
    }
    const left = element("div", undefined, "schedule-row-main");
    left.append(element("strong", item.title, "schedule-title"), element("span", item.schedule, "schedule-when"), ...warnings(item));
    row.append(left);

    const right = element("div", undefined, "schedule-row-right");
    const status = scheduleStatus(item);
    const said = element("span", status.text, `schedule-status ${status.tone}`);
    if (Number.isSafeInteger(item.nextAt) && status.tone === "next") said.title = `下次 ${when(item.nextAt)}`;
    right.append(said);
    // In 批量管理 the per-row actions step aside: two ways to act on one row at
    // the same time is how someone pauses one thing and deletes another.
    if (!state.selecting) {
      const actions = element("div", undefined, "schedule-row-actions");
      const play = button("立即运行", "ghost schedule-run-now", (event) => { event.stopPropagation(); return runNow(item); });
      play.disabled = cannotRunNow(item);
      const more = element("details", undefined, "schedule-more");
      const summary = element("summary", "更多");
      summary.onclick = (event) => event.stopPropagation();
      const menu = element("div", undefined, "schedule-menu");
      const pick = (label, className, handler, disabled = false) => {
        const entry = button(label, className, (event) => { event.stopPropagation(); more.open = false; return handler(); });
        entry.disabled = disabled;
        menu.append(entry);
      };
      pick(item.state === "paused" ? "恢复" : "暂停", "ghost", () => togglePaused(item), Boolean(item.promptExpired || item.resourceGrantRequired));
      pick("修改资源", "ghost", () => openResourceDialog(item), Boolean(item.resourceGrantRequired));
      pick("删除", "ghost danger", () => removeTask(item));
      more.append(summary, menu);
      actions.append(play, more);
      right.append(actions);
    }
    row.append(right);
    row.onclick = (event) => {
      if (event.target.closest("button, input, summary, details")) return;
      if (state.selecting) { const box = row.querySelector(".schedule-pick"); box.checked = !box.checked; box.onchange(); return; }
      openDetail(item);
    };
    row.onkeydown = (event) => { if (event.key === "Enter" && event.target === row && !state.selecting) openDetail(item); };
    return row;
  }

  function runRow(item) {
    const row = element("div", undefined, "schedule-row");
    const left = element("div", undefined, "schedule-row-main");
    // A deleted task's runs stay (G11), under the name the task had; only
    // with no name at all is it 已删除的定时任务, as WorkBuddy falls back to.
    left.append(element("strong", item.title ?? "已删除的定时任务", "schedule-title"));
    if (item.taskDeleted) left.append(element("span", "任务已删除", "schedule-when schedule-task-deleted"));
    left.append(element("span", when(item.startedAt), "schedule-when"));
    const label = runLabel(item);
    left.append(element("span", label.text, `schedule-outcome ${label.tone}`));
    row.append(left);
    // A finished run can be set aside or deleted, one at a time, as in
    // WorkBuddy. Both are asked on the in-app card by the main process, which
    // answers null when the person cancels. A run still going has neither.
    if (Number.isSafeInteger(item.finishedAt)) {
      const controls = element("div", undefined, "schedule-row-actions");
      if (item.shelvedAt) {
        controls.append(button("取消归档", "ghost", () => action(async () => {
          await api.shelveScheduleRun(item.id, false);
          await load();
          note("已取消归档，这条记录回到了运行记录。");
        }, readableError)));
      } else {
        controls.append(button("归档", "ghost", () => action(async () => {
          if (!await api.shelveScheduleRun(item.id, true)) return;
          await load();
          note("已归档");
        }, readableError)));
      }
      controls.append(button("删除", "ghost danger", () => action(async () => {
        if (!await api.deleteScheduleRun(item.id)) return;
        await load();
        note("已删除这条运行记录。");
      }, readableError)));
      row.append(controls);
    }
    // The detail is what the task itself said. It is the whole point of the
    // history: a run that failed every morning should say why, here.
    if (item.detail) row.append(element("p", item.detail, "schedule-detail"));
    if (item.artifact?.state === "verified" && item.artifact.url) {
      const open = element("a", "打开飞书云盘报告", "schedule-detail");
      open.href = item.artifact.url; open.rel = "noreferrer noopener"; open.dataset.externalLink = item.artifact.url;
      row.append(open);
    } else if (item.artifact?.state === "unknown") {
      row.append(element("p", "云盘上传结果不确定，系统没有自动重传；请到你的云空间（我的空间）核查。", "schedule-detail schedule-detail-gone"));
    }
    // A verified receipt that no longer names a file: the task rotated it out
    // (each keeps its latest three), or the file was deleted, renamed or edited
    // in Drive. Either way the report was saved; it is just not kept here.
    else if (item.artifact?.state === "verified") {
      row.append(element("p", "这份报告已不再保留：每个任务只留最近 3 份，或它已在云盘里被删除、改名或改动。", "schedule-detail schedule-detail-gone"));
    }
    // Cleared after its retention window rather than kept on the server for
    // good. Said out loud, because an old run rendering as a blank line reads as
    // a task that produced nothing -- and the result is not gone, it is in
    // 工作任务 where it was mirrored on the person's own machine.
    else if (item.outcome === "completed") {
      row.append(element("p", "这次运行没有可核验的云盘报告。", "schedule-detail schedule-detail-gone"));
    }
    return row;
  }

  // Runs under a day heading, newest first (G15).
  // Under 今天 / 昨天 / 月/日 (G15), each heading folding what is under it (G19).
  // `where` keeps 运行记录's folds apart from a task page's.
  function datedRuns(rows, where, redraw) {
    const nodes = [];
    let heading = null;
    for (const item of rows) {
      const label = dateGroup(item.startedAt), key = `${where}\n${label}`;
      if (label !== heading) {
        heading = label;
        const folded = collapsedDates.has(key);
        const head = button(`${label} ${folded ? "▸" : "▾"}`, "schedule-date-group", () => {
          if (collapsedDates.has(key)) collapsedDates.delete(key); else collapsedDates.add(key);
          redraw();
        });
        head.setAttribute("aria-expanded", String(!folded));
        nodes.push(head);
      }
      if (!collapsedDates.has(key)) nodes.push(runRow(item));
    }
    return nodes;
  }

  function firstPage() { state.runsShown = RUNS_SHOWN; state.runsAsked = RUNS_PAGE; }

  // One task, the way WorkBuddy opens it (G12): back to 定时任务 and its name at
  // the top, with 立即运行 / 删除 / 取消 / 保存; its form on the left; its own
  // 运行历史 on the right, with the same filters as 运行记录.
  function drawDetail(kept = null) {
    const item = state.schedules.find((row) => row.id === state.detailId);
    if (!item) { state.view = "list"; state.detailId = null; draw(); return; }
    const leave = () => { state.view = "list"; state.detailId = null; draw(); };
    const page = element("section", undefined, "schedule-detail-page");
    const header = element("header", undefined, "schedule-detail-header");
    const crumbs = element("div", undefined, "schedule-detail-crumbs");
    crumbs.append(button("‹ 定时任务", "ghost schedule-detail-back", leave), element("strong", item.title, "schedule-detail-title"));
    const restoring = Boolean(kept && kept.id === item.id && kept.revision === String(item.updatedAt ?? ""));
    const fields = scheduleForm({ existing: item, keptDeliveries: restoring ? kept.deliveries : null });
    const error = element("p", "", "schedule-error");
    const actions = element("div", undefined, "schedule-detail-actions");
    const play = button("立即运行", "ghost schedule-run-now", () => runNow(item));
    play.disabled = cannotRunNow(item);
    const save = button("保存", "primary", () => action(async () => {
      error.textContent = "";
      const definition = fields.collect();
      try { await api.updateSchedule(item.id, definition, item.updatedAt); }
      catch (failure) { error.textContent = readableError(failure); return; }
      await load();
      note(`「${definition.title}」已保存。`);
    }, readableError));
    save.disabled = !state.rules.includes(item.spec?.frequency) || Boolean(item.resourceGrantRequired);
    actions.append(play, button("删除", "ghost danger", () => removeTask(item)), button("取消", "ghost", leave), save);
    header.append(crumbs, actions);

    const body = element("div", undefined, "schedule-detail-body");
    const form = element("div", undefined, "schedule-detail-form");
    form.append(...warnings(item), ...fields.nodes);
    page.dataset.id = item.id; page.dataset.revision = String(item.updatedAt ?? "");
    page.keptDeliveries = fields.deliveryValues;
    const edited = () => { page.dataset.dirty = "1"; };
    form.addEventListener("input", edited); form.addEventListener("change", edited);
    if (kept && kept.id === page.dataset.id && kept.revision === page.dataset.revision) {
      const controls = [...form.querySelectorAll("input, textarea, select")];
      if (controls.length === kept.values.length && controls.every((node, index) => node.tagName === kept.values[index].tag && node.type === kept.values[index].type)) {
        controls.forEach((node, index) => { node.value = kept.values[index].value; node.checked = kept.values[index].checked; });
        edited();
      }
    }
    // What it may read, and on what terms: a grant of its own, changed only
    // through 修改资源, which issues the next revision.
    const grant = element("div", undefined, "schedule-detail-grant");
    if (item.access?.configured) {
      grant.append(element("span", `授权 v${item.access.revision ?? 1} · 可访问 ${item.access.resources?.length ?? 0} 个指定飞书资源 · 模型最多 ${item.access.limits?.modelCalls ?? 0} 次${item.memory ? " · 参考上次结果" : ""}`, "schedule-when"));
      const list = element("ul", undefined, "schedule-detail-resources");
      // Named as the person picked it (resourceName); the id stays on hover.
      for (const resource of item.access.resources ?? []) {
        const row = element("li", `${RESOURCE_KIND_NAMES[resource.kind] ?? resource.kind} · ${resourceName(resource)}`);
        row.title = resource.kind === "chat" ? resource.id : resource.reference ?? resource.id;
        list.append(row);
      }
      grant.append(list);
    }
    const change = button("修改资源", "ghost", () => openResourceDialog(item));
    change.disabled = Boolean(item.resourceGrantRequired);
    grant.append(change, element("p", "可访问的飞书资源在这里单独修改，授权会换到下一个版本；改了有效期，授权也会随之换版。", "schedule-when"));
    form.append(labelled("可访问的飞书资源", grant), error);

    const history = element("aside", undefined, "schedule-detail-history");
    const head = element("div", undefined, "schedule-detail-history-head");
    head.append(element("strong", `运行历史 (${state.detailRuns.length})`));
    const filter = element("select", undefined, "schedule-filter schedule-detail-filter");
    for (const [value, label] of RUN_FILTERS) {
      const option = element("option", label); option.value = value;
      if (state.detailFilter === value) option.selected = true;
      filter.append(option);
    }
    filter.onchange = () => action(async () => { state.detailFilter = filter.value; await load(); }, readableError);
    head.append(filter);
    history.append(head);
    if (!state.detailRuns.length) history.append(element("p", state.detailFilter ? "没有匹配的记录。" : "还没有运行记录。", "schedule-empty"));
    else history.append(...datedRuns(state.detailRuns, "detail", draw));
    body.append(form, history);
    page.append(header, body);
    root.append(page);
  }

  // Only the list, so typing in the search box does not rebuild the box being
  // typed into and lose the caret.
  function drawList() {
    const list = root.querySelector(".schedule-list");
    if (!list) return;
    list.replaceChildren();
    if (state.loading) { list.append(element("p", "读取中…", "schedule-empty")); return; }

    if (state.tab === "runs") {
      const rows = matches(state.runs);
      if (!rows.length) {
        list.append(element("p", state.search || (state.runFilter && state.runFilter !== "shelved") ? "没有匹配的记录。"
          : state.runFilter === "shelved" ? "暂无归档记录。" : "还没有运行记录。任务到点执行后会出现在这里。", "schedule-empty"));
      } else {
        list.append(...datedRuns(rows.slice(0, state.runsShown), "runs", drawList));
        // More kept than shown, or more on the server than kept.
        const more = rows.length > state.runsShown || (!state.search && state.runs.length >= state.runsAsked && state.runsAsked < RUNS_MOST);
        const paging = element("div", undefined, "schedule-runs-paging");
        if (more) paging.append(button("展开更多", "ghost schedule-runs-more", () => action(async () => {
          state.runsShown += RUNS_STEP;
          if (state.runsShown > state.runs.length && state.runs.length >= state.runsAsked && state.runsAsked < RUNS_MOST) {
            state.runsAsked = RUNS_MOST;
            state.runs = (await api.scheduleRuns(undefined, state.runsAsked, state.runFilter || undefined)).runs ?? [];
          }
          drawList();
        }, readableError)));
        if (state.runsShown > RUNS_SHOWN) paging.append(button("收起", "ghost schedule-runs-less", () => { state.runsShown = RUNS_SHOWN; drawList(); }));
        if (paging.childElementCount) list.append(paging);
      }
      return;
    }
    if (state.view === "templates") {
      const head = element("div", undefined, "schedule-templates-head");
      head.append(element("strong", "定时任务模板"), button("返回列表", "ghost", () => { state.view = "list"; draw(); }));
      list.append(head, templateGrid());
      return;
    }
    const rows = matches(state.schedules);
    if (state.selecting) list.append(selectionBar(rows));
    if (!rows.length) {
      const fresh = !state.search;
      list.append(element("p", state.search ? "没有符合的定时任务。" : "还没有定时任务。添加一个，让它按时替你做事。", "schedule-empty"));
      // Under an empty list, the way the reference product puts its 定时任务模版.
      if (fresh) list.append(element("strong", "定时任务模板", "schedule-templates-title"), templateGrid());
      return;
    }
    // 运行中 / 当前 / 已暂停, as the reference product groups them (G14): a task
    // with a run going is under 运行中 whatever its state, and each group folds.
    const going = (row) => Boolean(row.lastRun && row.lastRun.finishedAt === null);
    for (const [key, label, members] of [["running", "运行中", rows.filter(going)],
      ["current", "当前", rows.filter((row) => !going(row) && row.state === "active")],
      ["paused", "已暂停", rows.filter((row) => !going(row) && row.state === "paused")]]) {
      if (!members.length) continue;
      const folded = collapsedGroups.has(key);
      const heading = button(`${folded ? "▸" : "▾"} ${label} ${members.length}`, "schedule-group-head", () => {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
        drawList();
      });
      heading.dataset.group = key;
      heading.setAttribute("aria-expanded", String(!folded));
      list.append(heading);
      if (!folded) for (const item of members) list.append(scheduleRow(item));
    }
  }

  // One card per template: what it does, when, and what it will need to read.
  function templateGrid() {
    const grid = element("div", undefined, "schedule-templates");
    for (const template of SCHEDULE_TEMPLATES) {
      const card = element("article", undefined, "schedule-template");
      card.dataset.template = template.id;
      card.append(element("strong", template.title), element("p", template.description),
        element("small", `${templateSchedule(template)} · 需要选择${RESOURCE_KIND_NAMES[template.resourceKind]}`),
        button("添加", "ghost schedule-template-use", () => openDialog(null, template)));
      grid.append(card);
    }
    return grid;
  }

  // Unsaved edits on a task's page survive a redraw of that page. Every load()
  // redraws -- after 立即运行, a run filter, a background refresh -- and the
  // form was rebuilt from what the server held: a name or words half changed
  // were silently lost (found by the UI rules, 2026-09-25). Taken while the old
  // page is still there, put back only on the same task at the same revision:
  // once saved, or changed elsewhere, the server's version is the one shown.
  const FORM_CONTROLS = ".schedule-detail-form input, .schedule-detail-form textarea, .schedule-detail-form select";
  function keptDetailEdits() {
    const page = root.querySelector(".schedule-detail-page");
    if (!page?.dataset.dirty) return null;
    return { id: page.dataset.id, revision: page.dataset.revision, deliveries: page.keptDeliveries?.() ?? null,
      values: [...page.querySelectorAll(FORM_CONTROLS)].map((node) => ({ tag: node.tagName, type: node.type, value: node.value, checked: node.checked })) };
  }
  function draw() {
    const kept = keptDetailEdits();
    // Only the task page on screen, at the revision shown, keeps what its picker found.
    const shown = state.view === "detail" ? state.schedules.find((row) => row.id === state.detailId) : null;
    for (const key of pickerStates.keys()) if (!shown || key !== `delivery:${shown.id}:${shown.updatedAt}`) pickerStates.delete(key);
    root.replaceChildren();
    const head = banner();
    if (head) root.append(head);
    if (state.view === "detail") {
      root.append(element("small", "", "schedule-note"));
      drawDetail(kept);
      return;
    }
    root.append(toolbar());
    root.append(element("small", "", "schedule-note"));
    root.append(element("div", undefined, "schedule-list"));
    drawList();
  }

  // One picker implementation serves both creation and later authorization
  // replacement. Initial rows come only from the server's canonical manifest;
  // search, recent items and pasted links remain suggestions until the server
  // resolves and signs the next revision.
  //
  // The same picker chooses where a task's results go (`deliveries`): fewer
  // kinds, fewer places, and only this tenant's own chats -- a report is
  // excerpts of the person's documents, and an external group is outside the
  // company.
  function resourcePicker(initial = [], { kinds = RESOURCE_KINDS, max = 32, heading = "已选资源", noun = "资源",
    empty = "未选择飞书资源；任务仍可执行纯模型或编程工作。", internalChatsOnly = false, className = "", keep = null } = {}) {
    const resourceKinds = kinds;
    const selectedResources = new Map();
    // Everything a search leaves behind, shared by every drawing of this picker
    // when `keep` names it (pickerStates); otherwise this drawing's own.
    const live = (keep && pickerStates.get(keep)) || { kind: null, rows: [], nextPage: null, chatNext: null, status: null, recent: [], seq: 0, draw: null, say: null };
    if (keep) pickerStates.set(keep, live);
    const picker = element("section", undefined, `schedule-resource-picker${className ? ` ${className}` : ""}`);
    const kind = element("select", undefined, "schedule-resource-kind");
    for (const [value, text] of Object.entries(resourceKinds)) { const option = element("option", text); option.value = value; kind.append(option); }
    if (live.kind && resourceKinds[live.kind]) kind.value = live.kind;
    const query = element("input", undefined, "schedule-resource-query"); query.type = "search"; query.maxLength = 30; query.placeholder = "按标题搜索飞书文档";
    const find = button("搜索", "ghost schedule-resource-search");
    const recent = button("最近使用", "ghost schedule-resource-recent");
    const searchLine = element("div", undefined, "schedule-resource-searchline"); searchLine.append(kind, query, find, recent);
    const status = element("small", "可从最近使用、飞书搜索或链接添加。", "schedule-resource-status"); status.setAttribute("role", "status");
    const results = element("div", undefined, "schedule-resource-results"); results.setAttribute("role", "listbox");
    const more = button("更多", "ghost schedule-resource-more"); more.hidden = true;
    const manual = element("input", undefined, "schedule-resource-manual"); manual.maxLength = 2048; manual.placeholder = "也可以粘贴完整链接";
    const addManual = button("添加", "ghost schedule-resource-add");
    const manualLine = element("div", undefined, "schedule-resource-manual-line"); manualLine.append(manual, addManual);
    const chosen = element("div", undefined, "schedule-resource-selected");
    picker.append(searchLine, status, results, more, manualLine, chosen);

    const resourceKey = row => `${row.kind}\n${row.kind === "chat" ? row.id : row.reference}`;
    // Said to the form around it, so a page that keeps unsaved edits knows
    // this changed too: choosing is a click, not typing.
    const changed = () => picker.dispatchEvent(new Event("change", { bubbles: true }));
    function drawChosen() {
      chosen.replaceChildren(element("strong", `${heading}（${selectedResources.size}/${max}）`));
      if (!selectedResources.size) { chosen.append(element("span", empty, "schedule-resource-empty")); return; }
      for (const row of selectedResources.values()) {
        const item = element("div", undefined, "schedule-resource-chip");
        const text = element("span", `${resourceKinds[row.kind]} · ${resourceName(row)}`);
        text.title = row.kind === "chat" ? row.id : row.reference;
        item.append(text, button("移除", "ghost", () => { selectedResources.delete(resourceKey(row)); drawChosen(); changed(); }));
        chosen.append(item);
      }
    }
    function addResource(row, quiet = false) {
      if (!row || !resourceKinds[row.kind] || (row.kind === "chat" ? !row.id : !row.reference)) throw new Error(`${noun}类型无效`);
      if (selectedResources.size >= max && !selectedResources.has(resourceKey(row))) throw new Error(`一个任务最多选择 ${max} 个${noun}`);
      selectedResources.set(resourceKey(row), row); drawChosen();
      if (!quiet) changed();
    }
    // What the picker says goes to whichever drawing of it is on screen.
    const say = (text) => { live.status = text; status.textContent = text; };
    function drawResults(message = null) {
      results.replaceChildren();
      for (const row of live.rows) {
        const choice = button("", "schedule-resource-result", () => { addResource(row); say(`已添加「${resourceName(row)}」。`); });
        choice.setAttribute("role", "option");
        choice.append(element("strong", resourceName(row)));
        // Two chats of one name told apart by the ID's end, not the whole ID.
        if (row.kind === "chat") choice.title = row.id;
        const detail = row.kind === "chat" ? `ID …${String(row.id).slice(-4)}` : [row.owner, row.editedAt, row.reference].filter(Boolean).join(" · ");
        if (detail) choice.append(element("small", detail));
        results.append(choice);
      }
      more.hidden = !(live.kind === "chat" ? live.chatNext : live.nextPage);
      say(message ?? (live.rows.length ? `显示 ${live.rows.length} 项，点击即可加入。` : "没有可添加的结果。可以粘贴完整链接。"));
    }
    // The newest drawing answers for the picker; the latest request wins.
    live.draw = drawResults; live.say = say;
    const begin = (text) => { live.seq += 1; live.say(text); return live.seq; };
    const loadSearch = async (page = null) => {
      const text = query.value.trim(); if (!text) throw new Error("请输入要搜索的标题关键词");
      const asked = live.kind, turn = begin(page ? "继续搜索…" : "正在搜索飞书…");
      const response = await api.searchScheduleResources(text, asked, page);
      if (turn !== live.seq) return;
      const rows = (response.documents ?? []).map(row => ({ kind: asked, reference: row.url, label: row.title, owner: row.owner, editedAt: row.editedAt }));
      live.rows = page ? [...live.rows, ...rows] : rows; live.nextPage = response.next ?? null; live.chatNext = null;
      live.draw(response.excluded ? `显示 ${live.rows.length} 项；另有 ${response.excluded} 项无法在这里打开，已略过。` : null);
    };
    const loadChats = async (page = null) => {
      const turn = begin(page ? "继续读取会话…" : "正在读取当前账号最近会话…");
      const response = await api.listScheduleChats(page);
      if (turn !== live.seq) return;
      const listed = response.chats ?? [];
      const rows = listed.filter(row => !internalChatsOnly || row.external !== true).map(row => ({ kind: "chat", id: row.id, label: row.name }));
      live.rows = page ? [...live.rows, ...rows] : rows; live.chatNext = response.next ?? null; live.nextPage = null;
      const external = listed.length - rows.length;
      live.draw(response.limited ? "已达到本次 500 个会话上限。" : external > 0 ? `显示 ${live.rows.length} 项；${external} 个外部群不能作为去处，已略过。` : null);
    };
    const showRecent = async () => {
      const asked = live.kind, turn = begin("正在读取本机近期已核验资源…");
      if (!live.recent.length) live.recent.push(...((await api.scheduleResourceRecents()).resources ?? []));
      if (turn !== live.seq) return;
      live.rows = live.recent.filter(row => row.kind === asked); live.nextPage = null; live.chatNext = null;
      live.draw(live.rows.length ? null : "本机近期没有这种资源；可以搜索或粘贴链接。");
    };
    const failed = (failure) => live.say(readableError(failure));
    find.onclick = () => action(() => live.kind === "chat" ? loadChats(null) : loadSearch(null), failed);
    recent.onclick = () => action(() => live.kind === "chat" ? loadChats(null) : showRecent(), failed);
    more.onclick = () => action(() => live.kind === "chat" ? loadChats(live.chatNext) : loadSearch(live.nextPage), failed);
    query.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); find.click(); } };
    // How the controls read for a kind; a change of kind by the person also
    // puts away what the other kind found.
    const showKind = () => {
      const chat = kind.value === "chat";
      query.hidden = chat; find.textContent = chat ? "读取会话" : "搜索"; recent.textContent = chat ? "刷新会话" : "最近使用";
      manual.placeholder = chat ? "也可以输入会话 ID，例如 oc_xxx" : `也可以粘贴完整${resourceKinds[kind.value]}链接`;
    };
    kind.onchange = () => {
      live.kind = kind.value; live.seq += 1; live.rows = []; live.nextPage = null; live.chatNext = null; results.replaceChildren(); more.hidden = true;
      showKind();
      say(kind.value === "chat" ? "读取当前账号可见的最近会话，点击加入。" : "可从最近使用、飞书搜索或链接添加。");
    };
    addManual.onclick = () => action(() => {
      const value = manual.value.trim(); if (!value) throw new Error(kind.value === "chat" ? "请输入会话 ID" : "请粘贴完整链接");
      addResource(live.kind === "chat" ? { kind: "chat", id: value, label: value } : { kind: live.kind, reference: value, label: value });
      manual.value = ""; say("已添加；服务端会重新解析并核验权限。");
    }, failed);
    for (const row of initial) addResource(row.kind === "chat" ? { kind: row.kind, id: row.id, label: row.label }
      : { kind: row.kind, reference: row.reference, label: row.label }, true);
    drawChosen();
    // A picker drawn again shows what it had found, and says what it last
    // said. A new one opens on the first kind offered: a server that writes
    // only to chats shows chats.
    if (live.kind) {
      showKind();
      if (live.rows.length) drawResults(live.status);
      else if (live.status) status.textContent = live.status;
    } else {
      live.kind = kind.value;
      if (kind.value !== "document") kind.onchange();
    }
    return { node: picker, values: () => [...selectedResources.values()] };
  }

  function openResourceDialog(item) {
    const dialog = element("dialog", undefined, "schedule-dialog schedule-resource-dialog");
    const form = element("form"); form.method = "dialog";
    form.append(element("h3", `修改「${item.title}」的资源`));
    const resources = resourcePicker(item.access?.resources ?? []);
    form.append(element("p", "保存会生成新的资源授权版本，并立即终止仍持有旧授权的运行。任务名称、提示词、执行时间和历史记录不变。", "schedule-when"),
      labelled("可访问的飞书资源", resources.node));
    const error = element("p", "", "schedule-error");
    const actions = element("div", undefined, "schedule-dialog-actions");
    actions.append(button("取消", "ghost", () => dialog.close()), button("保存新授权", "primary", () => action(async () => {
      error.textContent = "";
      try { await api.updateScheduleResources(item.id, resources.values(), item.access.revision); }
      catch (failure) { error.textContent = readableError(failure); return; }
      dialog.close(); await load(); note("资源授权已换版；旧授权和旧运行令牌已失效。");
    }, readableError)));
    form.append(error, actions); dialog.append(form); root.append(dialog);
    dialog.addEventListener("close", () => { void api.closeScheduleResources?.().catch(() => {}); dialog.remove(); }, { once: true });
    dialog.showModal();
  }

  // The fields a task is made of -- name, words, rule, validity, kind, memory,
  // and for a new one what it may read -- shared by the 添加 dialog and the
  // detail page (G12), so the two cannot drift apart. `collect()` reads them
  // back as a definition, throwing in the person's words when it cannot.
  function scheduleForm({ existing = null, template = null, draft = null, keptDeliveries = null } = {}) {
    const nodes = [];
    const title = element("input"); title.placeholder = "输入任务名称"; title.maxLength = 60; title.required = true;
    const prompt = element("textarea"); prompt.placeholder = "每次要做什么，例如：把昨天的群消息汇总成三条要点。"; prompt.rows = 4; prompt.maxLength = 4000; prompt.required = true;
    if (existing) { title.value = existing.title ?? ""; prompt.value = existing.prompt ?? ""; }
    else if (template) { title.value = template.title; prompt.value = template.prompt; }
    else if (draft) { title.value = draft.draft.title; prompt.value = draft.draft.prompt; }
    nodes.push(labelled("名称", title), labelled("提示词", prompt));

    const frequency = element("select", undefined, "schedule-frequency");
    const offered = new Set(state.rules.flatMap((rule) => RULE_CHOICES[rule] ?? []));
    for (const [value, label] of FREQUENCIES.filter(([value]) => offered.has(value))) {
      const option = element("option", label); option.value = value; frequency.append(option);
    }
    const clock = element("input"); clock.type = "time"; clock.value = "09:00"; clock.step = 60;
    const once = element("input"); once.type = "datetime-local"; once.hidden = true;
    const days = element("div", undefined, "schedule-weekdays"); days.hidden = true;
    const checks = new Map();
    let daysTouched = false;
    for (const [value, label] of WEEKDAYS) {
      const box = element("label", undefined, "schedule-weekday");
      const input = element("input"); input.type = "checkbox"; input.value = value;
      if (value === "1") input.checked = true;
      input.onchange = () => { daysTouched = true; };
      checks.set(value, input);
      box.append(input, element("span", label));
      days.append(box);
    }
    const setDays = (list) => { for (const [value, input] of checks) input.checked = list.includes(Number(value)); };
    const month = element("select", undefined, "schedule-month"); month.hidden = true;
    for (let number = 1; number <= 12; number += 1) { const option = element("option", `${number} 月`); option.value = String(number); month.append(option); }
    const dayOfMonth = element("input"); dayOfMonth.type = "number"; dayOfMonth.min = 1; dayOfMonth.max = 31; dayOfMonth.value = 1; dayOfMonth.hidden = true;
    // 按间隔: from the time above, to an optional time the same day, every N hours.
    const until = element("input"); until.type = "time"; until.step = 60;
    const everyHours = element("input"); everyHours.type = "number"; everyHours.min = 1; everyHours.max = 23; everyHours.value = 2;
    const interval = element("span", undefined, "schedule-interval"); interval.hidden = true;
    interval.append(element("span", "到"), until, element("span", "每"), everyHours, element("span", "小时"));
    const intervalHint = element("p", "每次执行都会调用一次模型，间隔越短费用越高。结束时刻留空表示到当天结束；第二天从开始时刻重新算。", "schedule-when");
    intervalHint.hidden = true;

    const timing = element("div", undefined, "schedule-timing");
    timing.append(frequency, month, dayOfMonth, clock, interval, once);
    // The whole field is hidden, label included. Hiding only the checkboxes left
    // a bare 星期 heading with nothing under it, which reads as something that
    // failed to load rather than something that does not apply.
    const weekdayField = labelled("星期", days);
    weekdayField.hidden = true;
    frequency.onchange = () => {
      const value = frequency.value;
      clock.hidden = value === "once";
      once.hidden = value !== "once";
      const picksDays = ["weekly", "biweekly", "interval"].includes(value);
      days.hidden = !picksDays;
      weekdayField.hidden = !picksDays;
      // An interval is mostly a working-hours thing; start it there unless the
      // person has already chosen days.
      if (value === "interval" && !daysTouched) setDays(WORKDAYS);
      month.hidden = value !== "yearly";
      dayOfMonth.hidden = !["monthly", "yearly"].includes(value);
      interval.hidden = value !== "interval";
      intervalHint.hidden = value !== "interval";
    };
    nodes.push(labelled("执行频率", timing), intervalHint, weekdayField);
    // A template's rule comes in the same shape as a stored one, so it is shown
    // the same way; 每个工作日 it names directly.
    const spec = existing?.spec ?? (template ? { ...template.schedule, weekdays: template.schedule.frequency === "workday" ? WORKDAYS : template.schedule.weekdays } : null)
      ?? draft?.draft.schedule ?? null;
    if (spec?.frequency) {
      const workday = spec.frequency === "workday" || spec.frequency === "weekly" && spec.weekdays?.join(",") === WORKDAYS.join(",");
      frequency.value = workday ? "workday" : spec.frequency;
      if (spec.time) clock.value = spec.time;
      if (spec.frequency === "once" && Number.isSafeInteger(spec.at)) {
        const at = new Date(spec.at), two = (n) => String(n).padStart(2, "0");
        once.value = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
      }
      if (Array.isArray(spec.weekdays)) { setDays(spec.weekdays); daysTouched = true; }
      if (Number.isSafeInteger(spec.dayOfMonth)) dayOfMonth.value = spec.dayOfMonth;
      if (Number.isSafeInteger(spec.month)) month.value = String(spec.month);
      if (spec.frequency === "interval") { everyHours.value = spec.everyHours; until.value = spec.until ?? ""; }
      frequency.onchange();
    }

    // 有效期, as WorkBuddy has it (G17): 开始日期 and 结束日期, either or both
    // left empty. Neither can be before today, nor the end before the start --
    // except a date the task already has, which is shown as it is.
    const localDay = (at) => { const day = new Date(at), two = (n) => String(n).padStart(2, "0"); return `${day.getFullYear()}-${two(day.getMonth() + 1)}-${two(day.getDate())}`; };
    const today = localDay(Date.now());
    const startAt = element("input"); startAt.type = "date"; startAt.className = "schedule-start-date";
    const endAt = element("input"); endAt.type = "date"; endAt.className = "schedule-end-date";
    if (draft?.draft.startDate) startAt.value = draft.draft.startDate;
    if (draft?.draft.endDate) endAt.value = draft.draft.endDate;
    if (Number.isSafeInteger(existing?.startAt)) startAt.value = localDay(existing.startAt);
    if (Number.isSafeInteger(existing?.endAt)) endAt.value = localDay(existing.endAt);
    const earliest = (kept) => (kept && kept < today ? kept : today);
    const bound = () => {
      startAt.min = earliest(existing && Number.isSafeInteger(existing.startAt) ? localDay(existing.startAt) : "");
      const from = startAt.value && startAt.value > today ? startAt.value : today;
      endAt.min = existing && Number.isSafeInteger(existing.endAt) && localDay(existing.endAt) < from ? localDay(existing.endAt) : from;
    };
    startAt.onchange = bound; bound();
    const validity = element("div", undefined, "schedule-validity");
    validity.append(element("span", "开始日期"), startAt, element("span", "结束日期"), endAt);
    nodes.push(labelled("有效期", validity), element("p", "可选，留空表示始终生效。", "schedule-when"));

    const mode = element("select");
    for (const [value, label] of [["cowork", "工作任务"], ["coding", "编程任务"]]) { const option = element("option", label); option.value = value; mode.append(option); }
    if (existing?.mode ?? draft?.draft.mode) mode.value = existing?.mode ?? draft.draft.mode;
    nodes.push(labelled("任务类型", mode));

    // 参考上一次的结果 (G4). On for a new task, as decided; an edit shows what
    // the task has, and a task from before this has it off until someone turns
    // it on -- nothing an existing task does changes without a person's say.
    const memoryLine = element("label", undefined, "schedule-memory");
    const memoryBox = element("input"); memoryBox.type = "checkbox";
    memoryBox.checked = existing ? existing.memory === true : draft ? draft.draft.memory !== false : true;
    memoryLine.append(memoryBox, element("span", "参考上一次的结果，避免重复"));
    nodes.push(memoryLine, element("p", "运行前读回这个任务上一次保存到云盘的报告（截取前 6000 字），提醒这次不要重复。第一次运行没有可参考的；每次会多用一点模型额度。", "schedule-when"));

    // Search and recent rows are conveniences, never authority. The server
    // resolves Wiki nodes and rechecks document access before it stores the
    // capability. What is selected here is still shown in full and removable.
    // An existing task's resources are 修改资源's to change, with their own
    // grant revision; the detail page shows them beside this form.
    const resources = existing ? null : resourcePicker(draft?.draft.resources ?? []);
    if (resources) {
      nodes.push(element("p", "资源权限在创建或修改时单独授予。任务只能读取这里选中的资源；提示词无法扩大范围。Wiki 链接会在服务端解析成底层的文档、电子表格或多维表格，并当场核验你的读取权限。", "schedule-when"));
      // A template knows what kind of thing it reads, never which one: that is
      // still chosen here, by the person, like any other task's.
      if (template) {
        nodes.push(element("p", `这个模板要读${RESOURCE_KIND_NAMES[template.resourceKind]}：请在下面选一个具体的。`, "schedule-when schedule-template-hint"));
        const kind = resources.node.querySelector(".schedule-resource-kind");
        kind.value = template.resourceKind; kind.onchange?.();
      }
      nodes.push(labelled("可访问的飞书资源", resources.node));
    }

    // Where the results go besides their owner (schedule-deliveries.js), on a
    // new task and an edit alike, where this server can write them. Chosen here,
    // by the person, and nowhere else: a task cannot add a place for itself.
    const deliveryKinds = Object.fromEntries((state.deliveries?.kinds ?? []).map((kind) => [kind, DELIVERY_KINDS[kind]]));
    // A kind this server no longer writes to is not shown, rather than stopping
    // the form from opening; it goes only if the person saves a change here.
    const writable = (rows) => (Array.isArray(rows) ? rows.filter((row) => deliveryKinds[row?.kind]) : []);
    const deliveries = state.deliveries ? resourcePicker(writable(keptDeliveries ?? existing?.deliveries ?? draft?.draft.deliveries), {
      kinds: deliveryKinds, max: state.deliveries.max, heading: "已选去处", noun: "去处",
      empty: "不写到别处：结果只保存到你的云空间，并发给你本人。", internalChatsOnly: true, className: "schedule-delivery-picker",
      keep: existing ? `delivery:${existing.id}:${existing.updatedAt}` : null }) : null;
    const placeKey = (row) => `${row.kind}\n${row.kind === "chat" ? row.id : row.reference}`;
    const placedBefore = new Set(writable(existing?.deliveries).map(placeKey));
    if (deliveries) {
      nodes.push(labelled("结果还写到", deliveries.node), element("p", `可选，最多 ${state.deliveries.max} 个。每次运行结束后，系统以你的身份把结果追加到选中文档的末尾、发到选中的会话，不再逐次确认；任务自己不能增改去处。文档要有编辑权限，外部群不能选。`, "schedule-when schedule-delivery-hint"));
    }

    const collect = () => {
      // An edit keeps the zone the task was made in; a person travelling should
      // not move their 09:00 without being asked.
      const chosen = frequency.value, picked = () => [...checks.entries()].filter(([, input]) => input.checked).map(([value]) => Number(value));
      const schedule = { frequency: chosen === "workday" ? "weekly" : chosen, timeZone: existing?.spec?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
      if (chosen === "once") {
        const parsed = Date.parse(once.value);
        if (!Number.isFinite(parsed)) throw new Error("请选择一个执行时间");
        schedule.at = parsed;
      } else {
        schedule.time = clock.value;
        if (chosen === "workday") schedule.weekdays = [...WORKDAYS];
        if (["weekly", "biweekly", "interval"].includes(chosen)) schedule.weekdays = picked();
        // An edit keeps the week a 双周 rule counts from; a new one counts from now.
        if (chosen === "biweekly" && existing?.spec?.frequency === "biweekly") schedule.anchorWeek = existing.spec.anchorWeek;
        if (chosen === "monthly" || chosen === "yearly") schedule.dayOfMonth = Number(dayOfMonth.value);
        if (chosen === "yearly") schedule.month = Number(month.value);
        if (chosen === "interval") { schedule.everyHours = Number(everyHours.value); schedule.until = until.value || null; }
      }
      const definition = { title: title.value.trim(), prompt: prompt.value.trim(), mode: mode.value, schedule, memory: memoryBox.checked };
      if (resources) definition.resources = resources.values();
      // Sent for a new task, and for an edit only when it changed: every save
      // would otherwise ask Feishu again whether each document is still editable,
      // and a lapsed one would stop a change to the name.
      if (deliveries) {
        const places = deliveries.values();
        if (!existing || places.length !== placedBefore.size || places.some((row) => !placedBefore.has(placeKey(row)))) {
          definition.deliveries = places.map((row) => (row.kind === "chat" ? { kind: "chat", id: row.id, label: row.label } : { kind: "document", reference: row.reference, label: row.label }));
        }
      }
      definition.endAt = endAt.value ? Date.parse(`${endAt.value}T23:59:59`) : null;
      // From the start of that day, where this computer is. Sent only when set,
      // or when an edit takes one away, so a server from before .37 is not
      // asked for something it cannot do.
      if (startAt.value || Number.isSafeInteger(existing?.startAt)) definition.startAt = startAt.value ? Date.parse(`${startAt.value}T00:00:00`) : null;
      if (startAt.value && endAt.value && startAt.value > endAt.value) throw new Error("开始日期要早于结束日期");
      return definition;
    };
    return { nodes, title, collect, deliveryValues: deliveries ? () => deliveries.values() : null };
  }

  // Creating a task, from 添加, a template, or an Agent's draft. An existing
  // task is edited on its detail page instead (G12).
  //
  // `draft` is an Agent's proposal (G5): the same dialog, filled in, with its
  // suggested resources pre-selected and removable. The task exists only if
  // the person presses 确定; closing it any other way tells the Agent no.
  function openDialog(existing = null, template = null, draft = null) {
    const dialog = element("dialog", undefined, "schedule-dialog");
    const form = element("form");
    form.method = "dialog";
    form.append(element("h3", existing ? "编辑定时任务" : draft ? "添加定时任务（助手起草）" : "添加定时任务"));
    if (draft) form.append(element("p", "这是对话里的助手起草的：看过、改好之后点「确定」才会创建。建议的资源和去处已经预选，可以移除；服务端会重新解析并核验你的读取和编辑权限。", "schedule-when schedule-draft-hint"));
    const fields = scheduleForm({ existing, template, draft });
    form.append(...fields.nodes);

    const error = element("p", "", "schedule-error");
    const actions = element("div", undefined, "schedule-dialog-actions");
    actions.append(button("取消", "ghost", () => dialog.close()));
    const submit = button("确定", "primary", () => action(async () => {
      error.textContent = "";
      const definition = fields.collect();
      try {
        if (existing) await api.updateSchedule(existing.id, definition, existing.updatedAt);
        else {
          const created = await api.createSchedule(definition);
          if (draft) { settled = true; void api.settleScheduleDraft(draft.id, { createdId: created?.schedule?.id ?? null }).catch(() => {}); }
        }
      } catch (failure) { error.textContent = readableError(failure); return; }
      dialog.close();
      await load();
      if (existing) note(`「${definition.title}」已保存。`);
    }, readableError));
    actions.append(submit);
    form.append(error, actions);
    dialog.append(form);
    root.append(dialog);
    let settled = false;
    if (draft) draftDialog = { id: draft.id, dialog };
    dialog.addEventListener("close", () => {
      void api.closeScheduleResources?.().catch(() => {});
      if (draft) {
        if (draftDialog?.dialog === dialog) draftDialog = null;
        if (!settled) void api.settleScheduleDraft(draft.id, { cancelled: true }).catch(() => {});
      }
      dialog.remove();
    }, { once: true });
    dialog.showModal();
    fields.title.focus();
  }

  function labelled(text, control) {
    const wrap = element("label", undefined, "schedule-field");
    wrap.append(element("span", text), control);
    return wrap;
  }

  reloadCurrent = () => { if (root.isConnected) void action(() => load(), readableError); };
  if (!listeningChanges && api.onSchedulesChanged) { listeningChanges = true; api.onSchedulesChanged(() => reloadCurrent?.()); }
  return { render: () => action(async () => { await load(); if (draft) openDialog(null, null, draft); }, readableError), state };
}
