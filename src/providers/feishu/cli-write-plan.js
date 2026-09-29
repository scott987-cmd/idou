// What the Agent is allowed to ask the Feishu CLI to write, and how the
// application learns what a command would actually do before allowing it.
//
// The CLI already knows how to build every request. Rather than reimplement its
// bodies here -- which is how a product drifts out of sync with the binary it
// ships -- the application asks the CLI itself with `--dry-run`, which prints
// the exact method, path and body and performs no network call. Measured
// against the pinned binary across docs, sheets and Base: the declared request
// is byte-for-byte the request that is later sent.
//
// The grant is then bound to that declared request, so approval covers one
// method, one path and one body and nothing else.
//
// Calendar and task commands, recorded the same way, differ in exactly two
// predictable places, both normalised when the plan is built: a dry run shows
// the calendar as the unresolved placeholder `%3Cprimary%3E` where the real
// request uses Feishu's `primary` alias, and it lists query parameters
// separately (`params`) where the real request carries them in the path. The
// bodies are byte-for-byte identical. A binary that stops behaving this way
// fails closed: its request no longer matches its grant.

// Deterministic form used on both sides of the digest, so key order in the
// CLI's own serialisation can never change what was approved.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

// The write surface the Agent may reach. Each entry is one exact path shape and
// the methods allowed on it. Everything absent is refused before a grant is
// requested, so widening this list is the only way to widen the Agent's power.
//
// Some of it is destructive: it removes something, clears it, or replaces a
// whole thing with something else (a row, a record, an event, a task, a block,
// a whole document's content, a sheet's history). What counts is decided here,
// once, by the request itself -- method, path and body -- and the same answer is
// used by the application, which asks the person with a deletion card, and by
// the control plane, which will only let a destructive request through under a
// deletion grant (`cli.delete`). A family marks it with `destructive`: `true`
// when every request it covers destroys something, or a function of the body
// when only some do.
//
// Still absent: permission and sharing changes, owner transfer, security
// labels, wiki moves, chat or message writes, and deleting Drive files or wiki
// nodes (those delete asynchronously and then poll, which a single-use grant
// cannot cover).
const TOKEN = "[A-Za-z0-9_-]{1,128}";
const CALENDAR = "(?:primary|[A-Za-z0-9._@-]{1,200})", EVENT = "[A-Za-z0-9_-]{1,200}";
const GUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const calendarName = path => path.split("/")[5] === "primary" ? "我的日历" : `日历 ${decodeURIComponent(path.split("/")[5])}`;
const when = seconds => { const value = Number(seconds); return Number.isFinite(value) ? new Date(value * 1000).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "未知时间"; };
// What the person reads first on the confirmation. The exact body is shown
// underneath it; this line is what makes it recognisable.
function describeEvent(body) {
  return `日程「${String(body?.summary ?? "（无标题）").slice(0, 100)}」 · ${when(body?.start_time?.timestamp)} – ${when(body?.end_time?.timestamp)} · 只建在这个日历上，不邀请任何人`;
}
function describeTask(body) {
  const members = Array.isArray(body?.members) ? body.members.length : 0;
  return `任务「${String(body?.summary ?? "（无标题）").slice(0, 100)}」${body?.due?.timestamp ? ` · 截止 ${when(Number(body.due.timestamp) / 1000)}` : ""}${members ? ` · 会指派给 ${members} 人，他们会收到通知` : ""}`;
}
// Sheets reach every operation through one endpoint, so what an operation does
// is in its body: the tool, and for the object and structure tools the
// operation they are asked to perform. A batch is destructive if any step is.
// A body that cannot be read is treated as destructive rather than waved
// through as an ordinary write.
const SHEET_DESTRUCTIVE_TOOL = /(^|_)(delete|clear|remove|revert)(_|$)/;
const SHEET_DESTRUCTIVE_OPERATION = new Set(["delete", "clear", "remove"]);
function sheetStepDestructive(tool, input, depth = 0) {
  if (typeof tool !== "string" || SHEET_DESTRUCTIVE_TOOL.test(tool)) return true;
  if (!input || typeof input !== "object") return false;
  if (SHEET_DESTRUCTIVE_OPERATION.has(input.operation)) return true;
  if (Array.isArray(input.operations)) return depth >= 3 || input.operations.some(step => sheetStepDestructive(step?.tool_name, step?.input, depth + 1));
  return false;
}
function sheetDestructive(body) {
  let input;
  try { input = typeof body?.input === "string" ? JSON.parse(body.input) : body?.input; } catch { return true; }
  return sheetStepDestructive(body?.tool_name, input);
}
const DOCUMENT_DESTRUCTIVE = new Set(["block_delete", "overwrite"]);
const RECORD = /^rec[A-Za-z0-9]{1,64}$/;
function describeTaskUpdate(body) {
  const fields = Array.isArray(body?.update_fields) ? body.update_fields : [], task = body?.task ?? {};
  const parts = fields.map(field => field === "completed_at" ? (task.completed_at && task.completed_at !== "0" ? "标记为已完成" : "改回未完成")
    : field === "summary" ? `标题改为「${String(task.summary ?? "").slice(0, 100)}」` : field === "due" ? `截止时间改为 ${when(Number(task.due?.timestamp) / 1000)}` : `修改 ${field}`);
  return parts.join("，") || "更新任务";
}
export const CLI_WRITE_FAMILIES = Object.freeze([
  Object.freeze({ id: "document.create", methods: ["POST"], summary: "新建飞书文档",
    pattern: new RegExp(`^/open-apis/docs_ai/v1/documents$`), resource: () => "新文档" }),
  // Block-level document edits only. A whole-document `str_replace` has its own
  // route, which additionally requires the pattern to match uniquely and reads
  // the result back to prove the change was the confirmed one; routing it
  // through the general path would silently drop both guarantees.
  Object.freeze({ id: "document.update", methods: ["PUT"], summary: "按块修改飞书文档",
    pattern: new RegExp(`^/open-apis/docs_ai/v1/documents/${TOKEN}$`),
    resource: path => `文档 ${path.split("/").pop()}`,
    // Deleting blocks, or replacing the whole document's content.
    destructive: body => DOCUMENT_DESTRUCTIVE.has(body?.command),
    destructiveSummary: body => body?.command === "overwrite" ? "覆盖整篇飞书文档" : "删除飞书文档里的内容",
    consequence: body => body?.command === "overwrite" ? "整篇文档的现有内容会被替换掉。飞书文档的历史版本里还能找回旧内容。" : "选中的块会从文档里删除。飞书文档的历史版本里还能找回。",
    refuse: body => body?.command === "str_replace" ? "整篇查找替换请改用 doc-replace，它会校验原文唯一匹配并写后读回核验" : null }),
  Object.freeze({ id: "sheet.write", methods: ["POST"], summary: "写入电子表格",
    pattern: new RegExp(`^/open-apis/sheet_ai/v2/spreadsheets/${TOKEN}/tools/invoke_write$`),
    resource: path => `电子表格 ${path.split("/")[5]}`,
    destructive: sheetDestructive, destructiveSummary: "删除或清空电子表格内容",
    consequence: () => "这是删除或清空类的表格操作，执行后不能在这里撤销。飞书表格的历史版本里可能还能找回。" }),
  Object.freeze({ id: "base.records", methods: ["POST"], summary: "新增或更新多维表格记录",
    pattern: new RegExp(`^/open-apis/base/v3/bases/${TOKEN}/tables/${TOKEN}/records/batch_(create|update)$`),
    resource: path => { const parts = path.split("/"); return `多维表格 ${parts[5]} · 数据表 ${parts[7]}`; } }),
  Object.freeze({ id: "base.records.delete", methods: ["POST"], summary: "删除多维表格记录", destructive: true,
    pattern: new RegExp(`^/open-apis/base/v3/bases/${TOKEN}/tables/${TOKEN}/records/batch_delete$`),
    resource: path => { const parts = path.split("/"); return `多维表格 ${parts[5]} · 数据表 ${parts[7]}`; },
    describe: body => `删除 ${body.record_id_list.length} 条记录：${body.record_id_list.slice(0, 20).join("、")}${body.record_id_list.length > 20 ? " …" : ""}`,
    consequence: () => "记录删除后无法在这里恢复。",
    // Exactly the shape the pinned CLI sends: a bounded list of record ids.
    refuse: body => {
      const ids = body?.record_id_list;
      const ok = body && Object.keys(body).length === 1 && Array.isArray(ids) && ids.length >= 1 && ids.length <= 500 &&
        new Set(ids).size === ids.length && ids.every(id => typeof id === "string" && RECORD.test(id));
      return ok ? null : "删除记录的请求只能是一组记录 ID（最多 500 条）";
    } }),
  // 日程 and 任务. Only what touches the person's own calendar and tasks and
  // can be read straight back: an event on their calendar with nobody invited,
  // a reply to an invitation they received, a task, and changes to a task
  // including marking it done. Inviting attendees and editing an existing event
  // are absent: in the application's strict CLI mode the only commands for them
  // send two requests, and one confirmation cannot stand for both.
  Object.freeze({ id: "calendar.event.create", methods: ["POST"], summary: "在日历里新建日程",
    pattern: new RegExp(`^/open-apis/calendar/v4/calendars/${CALENDAR}/events$`),
    resource: path => calendarName(path), describe: describeEvent }),
  Object.freeze({ id: "calendar.event.reply", methods: ["POST"], summary: "回复日程邀请",
    pattern: new RegExp(`^/open-apis/calendar/v4/calendars/${CALENDAR}/events/${EVENT}/reply$`),
    resource: path => `${calendarName(path)} · 日程 ${path.split("/")[7]}`,
    describe: body => `回复：${({ accept: "接受", decline: "拒绝", tentative: "待定" })[body?.rsvp_status] ?? String(body?.rsvp_status ?? "")}` }),
  Object.freeze({ id: "task.create", methods: ["POST"], summary: "新建任务", query: { user_id_type: ["open_id"] },
    pattern: /^\/open-apis\/task\/v2\/tasks$/, resource: () => "我的任务", describe: describeTask }),
  Object.freeze({ id: "task.update", methods: ["PATCH"], summary: "更新任务", query: { user_id_type: ["open_id"] },
    pattern: new RegExp(`^/open-apis/task/v2/tasks/${GUID}$`), resource: path => `任务 ${path.split("?")[0].split("/").pop()}`, describe: describeTaskUpdate }),
  // Deleting an event or a task. The CLI has no shortcut for either, so these
  // are reached only through the application's own fixed commands (see
  // deletionArgv below), never through an `api` call the Agent writes.
  Object.freeze({ id: "calendar.event.delete", methods: ["DELETE"], summary: "删除日程", destructive: true, query: { need_notification: ["true", "false"] },
    pattern: new RegExp(`^/open-apis/calendar/v4/calendars/${CALENDAR}/events/${EVENT}$`),
    resource: path => `${calendarName(path)} · 日程 ${path.split("?")[0].split("/")[7]}`,
    consequence: () => "日程会从日历上删除。如果还邀请了别人，他们会收到取消通知。" }),
  Object.freeze({ id: "task.delete", methods: ["DELETE"], summary: "删除任务", destructive: true,
    pattern: new RegExp(`^/open-apis/task/v2/tasks/${GUID}$`), resource: path => `任务 ${path.split("?")[0].split("/").pop()}`,
    consequence: () => "任务会被删除，负责人和关注人都将看不到它。" }),
]);

// Whether one request destroys something. The single rule both sides apply.
export function isDestructiveRequest(method, path, body) {
  const family = cliWriteFamily(method, path);
  if (!family) return false;
  return typeof family.destructive === "function" ? Boolean(family.destructive(body ?? null)) : family.destructive === true;
}
// A family every one of whose requests is destructive can never be approved
// as an ordinary write, whatever its body turns out to be.
export const alwaysDestructive = family => family?.destructive === true;

// The application's own commands for the two deletions the CLI has no shortcut
// for. The Agent supplies an id; the method, the path and every flag are fixed
// here. `api` is otherwise refused outright (validateCliWriteArgv).
const EVENT_ID = new RegExp(`^${EVENT}$`), TASK_ID = new RegExp(`^${GUID}$`);
export function deletionArgv(kind, id) {
  if (kind === "event") {
    if (typeof id !== "string" || !EVENT_ID.test(id)) throw new Error("日程 ID 无效");
    return Object.freeze(["api", "DELETE", `/open-apis/calendar/v4/calendars/primary/events/${id}`, "--params", JSON.stringify({ need_notification: "true" })]);
  }
  if (kind === "task") {
    if (typeof id !== "string" || !TASK_ID.test(id)) throw new Error("任务 ID 无效（应为 GUID）");
    return Object.freeze(["api", "DELETE", `/open-apis/task/v2/tasks/${id}`]);
  }
  throw new Error("不支持的删除类型");
}
export function isDeletionArgv(argv) {
  if (!Array.isArray(argv) || argv[0] !== "api" || argv[1] !== "DELETE") return false;
  const path = String(argv[2] ?? ""), event = /^\/open-apis\/calendar\/v4\/calendars\/primary\/events\/([^/]+)$/.exec(path), task = /^\/open-apis\/task\/v2\/tasks\/([^/]+)$/.exec(path);
  try { return JSON.stringify(argv) === JSON.stringify(event ? deletionArgv("event", event[1]) : task ? deletionArgv("task", task[1]) : null); } catch { return false; }
}

// The CLI's own risk level for a shortcut, read from its local help text. It
// labels deletions and clears `high-risk-write` and refuses to run them without
// `--yes`; the application adds that flag itself, and only after the person
// has answered a deletion card.
export function cliRiskFromHelp(text) {
  const match = /^Risk: (read|write|high-risk-write)\s*$/m.exec(String(text ?? ""));
  return match ? match[1] : null;
}

// The pathname must match a family, and every query parameter must be one the
// family declares, with a value it allows.
export function cliWriteFamily(method, path) {
  if (typeof path !== "string" || path.includes("#")) return null;
  const [pathname, search = ""] = path.split("?");
  const family = CLI_WRITE_FAMILIES.find(item => item.methods.includes(method) && item.pattern.test(pathname));
  if (!family) return null;
  for (const [name, value] of new URLSearchParams(search)) if (!family.query?.[name]?.includes(value)) return null;
  return family;
}
// The same request written two ways -- parameters in a different order -- is
// the same request. Used to compare a live request with the one approved.
export function canonicalCliPath(path) {
  const [pathname, search = ""] = String(path).split("?");
  const params = [...new URLSearchParams(search)].sort(([a, x], [b, y]) => a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0);
  return params.length ? `${pathname}?${new URLSearchParams(params)}` : pathname;
}

// Argument shapes the application refuses to run at all, independent of what
// the command would turn out to request. These are about who the command acts
// as and which machinery it uses, which `--dry-run` cannot reveal.
const DOMAINS = Object.freeze(["docs", "sheets", "base", "wiki", "drive", "calendar", "task"]);
// Commands that would fan out into several requests, answered with the
// single-request form that does the same thing, so the Agent is not left with a
// bare refusal.
const FAN_OUT = Object.freeze({
  "task +complete": "标记完成请改用：task +update --task-id <任务 ID> --data '{\"completed_at\":\"<当前毫秒时间戳>\"}'，它只发一个请求，一次确认就能覆盖。",
});
const BANNED = Object.freeze({
  "--profile": "CLI 配置档由应用决定",
  "--as": "身份由应用决定，始终是当前登录用户",
  "--yes": "高风险确认不能由 Agent 代答",
  "--dry-run": "预演由应用自己执行",
  "--format": "输出格式由应用决定",
});

export function validateCliWriteArgv(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.length > 64 || argv.some(item => typeof item !== "string" || item.length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item))) {
    throw new Error("飞书 CLI 命令格式无效");
  }
  if (!DOMAINS.includes(argv[0])) throw new Error(`只允许这些飞书 CLI 领域：${DOMAINS.join("、")}`);
  // A shortcut is a named operation with a known request shape. `api` would let
  // any endpoint be addressed directly, which is exactly what the family list
  // above exists to prevent.
  if (!/^\+[a-z][a-z0-9-]{0,48}$/.test(argv[1] ?? "")) throw new Error("只允许 lark-cli 的 + 快捷命令，例如 sheets +cells-set；不允许 api 直连端点");
  const fanOut = FAN_OUT[`${argv[0]} ${argv[1]}`];
  if (fanOut) throw new Error(fanOut);
  if (argv[0] === "calendar" && argv[1] === "+create" && argv.some(item => item.split("=")[0] === "--attendee-ids")) {
    throw new Error("邀请参会人还没有接入：请不带 --attendee-ids 先把日程建在用户自己的日历上，并告诉用户需要在飞书里邀请哪些人。");
  }
  for (const item of argv.slice(2)) {
    const name = item.split("=")[0];
    if (BANNED[name]) throw new Error(`命令里不能带 ${name}：${BANNED[name]}`);
  }
  return Object.freeze([...argv]);
}

// The CLI's own account of what one command would send. Anything other than a
// single write request is refused: a command that fans out into several calls
// cannot be described by one grant, and the person would be approving less than
// would happen.
export function parseCliWritePlan(stdout) {
  let payload;
  try { payload = JSON.parse(stdout); } catch { throw new Error("飞书 CLI 预演输出无法解析"); }
  if (payload?.ok !== true || payload.dry_run !== true) {
    const message = payload?.error?.message;
    throw new Error(message ? `飞书 CLI 拒绝了这条命令：${String(message).slice(0, 200)}` : "飞书 CLI 预演未成功");
  }
  const requests = payload.data?.api;
  if (!Array.isArray(requests) || requests.length !== 1) throw new Error("这条命令会发出多个请求，一次确认无法覆盖；请拆成更小的命令");
  const [request] = requests;
  const method = request?.method, url = request?.url, params = request?.params;
  if (typeof method !== "string" || typeof url !== "string" || !url.startsWith("/open-apis/") || url.includes("#") || url.includes("?")) throw new Error("飞书 CLI 预演没有给出可识别的请求");
  if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params) || Object.values(params).some(value => !["string", "number", "boolean"].includes(typeof value)))) throw new Error("飞书 CLI 预演的查询参数无法识别");
  // The two recorded differences between a dry run and the request actually
  // sent; see the note at the top of this file.
  const entries = Object.entries(params ?? {}).map(([name, value]) => [name, String(value)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const path = `${url.replaceAll("%3Cprimary%3E", "primary")}${entries.length ? `?${new URLSearchParams(entries)}` : ""}`;
  const family = cliWriteFamily(method, path);
  if (!family) throw new Error(`这条命令要写的地方不在允许范围内（${method} ${path.split("?")[0]}）。当前允许：${CLI_WRITE_FAMILIES.map(item => item.summary).join("、")}。`);
  const body = request.body === undefined ? null : request.body;
  if (body !== null && (typeof body !== "object" || Array.isArray(body))) throw new Error("飞书 CLI 预演的请求体不是对象");
  if (method === "DELETE" && body !== null) throw new Error("删除请求不应带请求体");
  const refusal = family.refuse?.(body);
  if (refusal) throw new Error(refusal);
  return { method, path, body, family, destructive: isDestructiveRequest(method, path, body) };
}
