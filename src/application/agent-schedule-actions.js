import { declined } from "./agent-confirmation.js";
import { scheduleSpec } from "../control-plane/schedule-spec.js";

// Scheduled tasks from a conversation (G5), the way the reference products let
// their assistant create, list and change them. By default every change is the
// person's click; from a task on 完全访问 it is the task's permission instead
// (permissions.js), since 2026-09-28.
//
// By default a draft does not create anything. It opens the same 添加定时任务
// dialog the person would have opened, filled in with what the Agent proposed;
// the task exists only if they press 确定 there, after reading it, and the
// resources it suggested are only pre-selected -- removable. Pausing, resuming
// and running one now ask on the in-app card; deleting asks on the red one, the
// same card the 定时任务 page uses. Under full access the draft is created as the
// dialog would have created it, and the rest happen without their cards. Either
// way the server resolves and checks every resource, and listing reads the
// person's own tasks and asks nothing.
//
// What reaches the dialog is checked here first, so a malformed draft is told
// to the Agent while it can still fix it, instead of surfacing as a dialog that
// cannot be submitted. The server checks everything again when it is.
const ID = /^[0-9a-f-]{36}$/i;
const KINDS = Object.freeze({ document: "文档", sheet: "电子表格", base: "多维表格", chat: "会话" });
const FIELDS = Object.freeze(["title", "prompt", "schedule", "mode", "startDate", "endDate", "resources", "memory", "deliveries"]);
// Where each result is also written (schedule-deliveries.js on the server): a
// document appended to, a chat sent to. Proposed like the resources; the person
// keeps or removes them in the dialog, and the server proves each one again.
const DELIVERY_KINDS = Object.freeze({ document: "文档", chat: "会话" });
const MAX_DELIVERIES = 3;
const DRAFT_CANCELLED = "用户没有创建这个定时任务（关掉了对话框），没有创建任何东西。";
const DRAFT_TIMEOUT = "草稿等了 9 分钟没有回应，对话框已关闭，没有创建任务。不要自己重新发起：告诉用户草稿已超时，等用户明确说准备好了再发起。";
const DRAFT_WITHDRAWN = "草稿在用户回应之前已作废（发起的请求已经结束或窗口已关闭），没有创建任务。";
const DRAFT_BUSY = "用户正开着另一个对话框，草稿没有打开，没有创建任务。告诉用户草稿已准备好，等他关掉那个对话框、说可以了再发起。";

const text = (value, max, what) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`草稿缺少${what}`);
  if (value.length > max) throw new Error(`${what}不能超过 ${max} 个字`);
  return value.trim();
};
const label = (value) => (typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 120) : "");

function resource(row) {
  if (!row || typeof row !== "object" || !KINDS[row.kind]) throw new Error("资源的 kind 只能是 document、sheet、base 或 chat");
  if (row.kind === "chat") {
    if (typeof row.id !== "string" || !/^oc_[A-Za-z0-9_-]{1,128}$/.test(row.id)) throw new Error("会话要给 oc_ 开头的 chat_id（id 字段）");
    return { kind: "chat", id: row.id, label: label(row.label) || row.id };
  }
  let url;
  try { url = new URL(row.reference); } catch { throw new Error(`${KINDS[row.kind]}要在 reference 字段给完整的 https 链接`); }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2048) throw new Error(`${KINDS[row.kind]}的链接无效`);
  return { kind: row.kind, reference: url.href, label: label(row.label) || url.href };
}

function delivery(row) {
  if (!row || typeof row !== "object" || !DELIVERY_KINDS[row.kind]) throw new Error("deliveries 的 kind 只能是 document（追加到文档）或 chat（发到会话）");
  return resource(row);
}

// The draft file, as the Agent wrote it. `schedule` is the rule in the shape
// the server stores, plus 每个工作日 as "workday" and a one-off moment as an
// ISO time; a rule with no zone is in this machine's own.
export function parseScheduleDraft(source, { timeZone }) {
  let value;
  try { value = JSON.parse(source); } catch { throw new Error("草稿文件不是合法的 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("草稿必须是一个 JSON 对象");
  const unknown = Object.keys(value).filter((key) => !FIELDS.includes(key));
  if (unknown.length) throw new Error(`草稿里有不认识的字段：${unknown.join("、")}（可用：${FIELDS.join("、")}）`);
  const title = text(value.title, 60, "名称（title）");
  const prompt = text(value.prompt, 4000, "提示词（prompt）");
  const mode = value.mode ?? "cowork";
  if (!["cowork", "coding"].includes(mode)) throw new Error("mode 只能是 cowork（工作任务）或 coding（编程任务）");
  if (!value.schedule || typeof value.schedule !== "object" || Array.isArray(value.schedule)) throw new Error("草稿缺少执行规则（schedule）");
  const rule = { timeZone, ...value.schedule };
  if (rule.frequency === "workday") Object.assign(rule, { frequency: "weekly", weekdays: [1, 2, 3, 4, 5] });
  if (rule.frequency === "once" && typeof rule.at === "string") rule.at = Date.parse(rule.at);
  // The server's own reading of a rule, so what the Agent hears back is the
  // same sentence a person would see in the dialog.
  const spec = scheduleSpec(rule);
  // 有效期: calendar days, as the dialog's date fields take them.
  const day = (name) => {
    const said = value[name] ?? null;
    if (said !== null && (typeof said !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(said) || !Number.isFinite(Date.parse(`${said}T00:00:00`)))) {
      throw new Error(`${name} 要写成 YYYY-MM-DD，或者不写表示始终生效`);
    }
    return said;
  };
  const startDate = day("startDate"), endDate = day("endDate");
  if (startDate && endDate && startDate > endDate) throw new Error("startDate 要早于 endDate");
  const resources = value.resources ?? [];
  if (!Array.isArray(resources) || resources.length > 32) throw new Error("resources 是一个数组，最多 32 个资源");
  if (value.memory !== undefined && typeof value.memory !== "boolean") throw new Error("memory 只能是 true 或 false");
  const deliveries = value.deliveries ?? [];
  if (!Array.isArray(deliveries) || deliveries.length > MAX_DELIVERIES) throw new Error(`deliveries 是一个数组，最多 ${MAX_DELIVERIES} 个去处`);
  return Object.freeze({ title, prompt, mode, schedule: { ...spec }, startDate, endDate, resources: resources.map(resource), deliveries: deliveries.map(delivery),
    // On unless the Agent says otherwise: the default the dialog has.
    memory: value.memory !== false });
}

// What the 添加定时任务 dialog sends for a draft left as it was proposed
// (schedules.js collect()): the rule as the server reads it, the resources as
// the picker holds them, and the dates from the start and the end of the day.
export function draftDefinition(draft) {
  const definition = { title: draft.title, prompt: draft.prompt, mode: draft.mode, schedule: { ...draft.schedule }, memory: draft.memory,
    resources: draft.resources.map((row) => row.kind === "chat" ? { kind: "chat", id: row.id, label: row.label } : { kind: row.kind, reference: row.reference, label: row.label }),
    endAt: draft.endDate ? Date.parse(`${draft.endDate}T23:59:59`) : null };
  if (draft.startDate) definition.startAt = Date.parse(`${draft.startDate}T00:00:00`);
  // Only when there are any, as the dialog sends them.
  if (draft.deliveries?.length) definition.deliveries = draft.deliveries.map((row) => row.kind === "chat" ? { kind: "chat", id: row.id, label: row.label } : { kind: "document", reference: row.reference, label: row.label });
  return definition;
}

// A task as the Agent may see it: the person's own, never a credential.
function summary(row) {
  return { id: row.id, title: row.title, rule: row.schedule, state: row.state === "paused" ? "已暂停" : "运行中",
    suspended: row.suspended === true, nextAt: row.state === "active" && Number.isSafeInteger(row.nextAt) ? new Date(row.nextAt).toISOString() : null,
    startAt: Number.isSafeInteger(row.startAt) ? new Date(row.startAt).toISOString() : null,
    endAt: Number.isSafeInteger(row.endAt) ? new Date(row.endAt).toISOString() : null, memory: row.memory === true,
    resources: (row.access?.resources ?? []).map((item) => ({ kind: item.kind, label: item.label ?? null })),
    deliveries: (row.deliveries ?? []).map((item) => ({ kind: item.kind, label: item.label ?? null })),
    modelCalls: row.access?.limits?.modelCalls ?? null, prompt: row.prompt };
}

// `changed` is told after each change the Agent made, so a 定时任务 page on
// screen shows it at once rather than on its next visit.
// Listing only reads; every other operation asks the person (agent-reads.js).
export const SCHEDULE_READS = Object.freeze(["schedule-list"]);

// `unattended(taskId)`: whether the task asking has full access -- the
// person's standing authorization, in place of the card.
export function agentScheduleActions({ getSchedules, confirm, confirmRemoval, openDraft, unattended, changed = () => {}, timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone }) {
  for (const [name, value] of [["getSchedules", getSchedules], ["confirm", confirm], ["confirmRemoval", confirmRemoval], ["openDraft", openDraft], ["unattended", unattended]]) {
    if (typeof value !== "function") throw new Error(`Invalid agent schedule action wiring: ${name}`);
  }
  const schedules = () => {
    const client = getSchedules();
    if (!client) throw new Error("定时任务还不可用：请先登录");
    return client;
  };
  // Found in the person's own list, so an id from anywhere else is simply not there.
  const find = async (id) => {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("--id 要用 schedule-list 返回的任务 id");
    const row = ((await schedules().list())?.schedules ?? []).find((item) => item.id === id);
    if (!row) throw new Error("找不到这个定时任务：先用 schedule-list 看看有哪些");
    return row;
  };
  const allowed = (taskId) => { try { return unattended(taskId) === true; } catch { return false; } };
  return {
    "schedule-draft": async (params, taskId) => {
      const draft = parseScheduleDraft(params.draft, { timeZone: timeZone() });
      if (allowed(taskId)) {
        const created = (await schedules().create(draftDefinition(draft)))?.schedule; changed();
        if (!created?.id) throw new Error("服务端没有返回新建的定时任务");
        // What the server stored, not what was asked: one from before
        // deliveries existed keeps none, and the Agent must not say otherwise.
        return { created: true, schedule: { id: created.id, title: created.title, rule: created.schedule,
          nextAt: Number.isSafeInteger(created.nextAt) ? new Date(created.nextAt).toISOString() : null,
          deliveries: (created.deliveries ?? []).map((item) => ({ kind: item.kind, label: item.label ?? null })) } };
      }
      const outcome = await openDraft(draft);
      if (outcome?.created) return { created: true, schedule: outcome.schedule };
      if (outcome?.reason === "timeout") throw new Error(DRAFT_TIMEOUT);
      if (outcome?.reason === "withdrawn") throw new Error(DRAFT_WITHDRAWN);
      if (outcome?.reason === "busy") throw new Error(DRAFT_BUSY);
      throw new Error(DRAFT_CANCELLED);
    },
    "schedule-list": async () => ({ schedules: ((await schedules().list())?.schedules ?? []).map(summary) }),
    "schedule-pause": async (params, taskId) => {
      const row = await find(params.id);
      const choice = allowed(taskId) ? { response: 1 } : await confirm({ type: "info", title: "暂停定时任务？", message: `暂停「${row.title}」`,
        detail: "暂停后不再按时执行，之后可以随时恢复。", buttons: ["取消", "暂停"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) throw declined(choice, "用户取消了暂停，任务照旧运行。");
      const paused = summary((await schedules().setState(row.id, "paused")).schedule); changed();
      return { paused: true, schedule: paused };
    },
    "schedule-resume": async (params, taskId) => {
      const row = await find(params.id);
      const choice = allowed(taskId) ? { response: 1 } : await confirm({ type: "info", title: "恢复定时任务？", message: `恢复「${row.title}」（${row.schedule}）`,
        detail: "恢复后按规则继续执行，从下一个到点的时间开始，错过的不补跑。", buttons: ["取消", "恢复"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) throw declined(choice, "用户取消了恢复，任务仍然暂停。");
      const resumed = summary((await schedules().setState(row.id, "active")).schedule); changed();
      return { resumed: true, schedule: resumed };
    },
    // A deletion is still authorised in code, never by convention: the red card's
    // own answer, or the task's full access checked here.
    "schedule-delete": async (params, taskId) => {
      const row = await find(params.id);
      const choice = allowed(taskId) ? { response: 1 } : await confirmRemoval([row.id]);
      if (choice.response !== 1) throw declined(choice, "用户取消了这次删除，没有删除任何东西。");
      const deleted = (await schedules().remove(row.id))?.removed === true; changed();
      return { deleted, title: row.title };
    },
    "schedule-run-now": async (params, taskId) => {
      const row = await find(params.id);
      const choice = allowed(taskId) ? { response: 1 } : await confirm({ type: "warning", title: "立即运行定时任务？", message: `现在运行一次「${row.title}」`,
        detail: `会按这个任务的授权读取飞书资源并调用模型（计费），结果保存到云盘并通知你${row.deliveries?.length ? `，也写到任务指定的 ${row.deliveries.length} 个地方` : ""}。不改变下次执行时间。`,
        buttons: ["取消", "立即运行"], defaultId: 0, cancelId: 0 });
      if (choice.response !== 1) throw declined(choice, "用户取消了这次运行。");
      const started = await schedules().runNow(row.id); changed();
      return { started: true, runId: started?.run?.runId ?? null, title: row.title };
    },
  };
}
