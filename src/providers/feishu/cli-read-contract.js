// Semantic reads that are not plain GETs. Each one is an exact path, a closed
// set of query parameters and a closed body shape, declared here so the control
// plane's read policy stays a short list of named operations rather than a
// method or prefix allowance. Nothing here can carry a mutation: these paths are
// read endpoints, they take no write grant, and the proxy still refuses every
// method and path it does not name.
//
// Every shape below was recorded from the pinned lark-cli 1.0.78 with --dry-run.

export const DOCUMENT_SEARCH_PATH = "/open-apis/search/v2/doc_wiki/search";
export const CONTACT_SEARCH_PATH = "/open-apis/contact/v3/users/search";
export const CHAT_SEARCH_PATH = "/open-apis/im/v2/chats/search";

// Named by Feishu itself when a search is refused, and by the console as
// 搜索云文档. Nothing else this product does needs it.
export const DOCUMENT_SEARCH_SCOPE = "search:docs:read";
// The server's own limit on a document `query`, counted by Unicode code point;
// above it the request comes back as 99992402 field validation failed.
export const DOCUMENT_SEARCH_MAX_QUERY = 30;
export const DOCUMENT_SEARCH_MAX_PAGE_SIZE = 20;

const MAX_BODY_BYTES = 4096;
const MAX_PAGE_SIZE = 100;
const DOC_TYPES = Object.freeze(["DOC", "DOCX", "SHEET", "BITABLE", "MINDNOTE", "SLIDES", "WIKI", "FILE"]);
const DOC_SORTS = Object.freeze(["DEFAULT", "EDIT_TIME", "EDIT_TIME_ASC", "OPEN_TIME", "CREATE_TIME"]);
const CHAT_SEARCH_TYPES = Object.freeze(["private", "public_joined", "public_unjoined"]);
export const DOCUMENT_SEARCH_TYPES = DOC_TYPES;
export const DOCUMENT_SEARCH_SORTS = DOC_SORTS;

const USER_ID = /^ou_[A-Za-z0-9_-]{1,128}$/;
const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keysWithin = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const refuse = () => { throw new Error("这个飞书读取请求的形状不被允许"); };
function text(value, limit) {
  if (typeof value !== "string" || [...value].length > limit || /[\x00-\x1f\x7f]/.test(value)) refuse();
}
function enumerated(value, allowed, max) {
  if (!Array.isArray(value) || !value.length || value.length > max || new Set(value).size !== value.length ||
      value.some(entry => !allowed.includes(entry))) refuse();
}
function pageToken(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x20\x7f]/.test(value)) refuse();
}

function documentSearchBody(value) {
  if (!keysWithin(value, ["query", "page_size", "page_token", "doc_filter", "wiki_filter"])) refuse();
  text(value.query, DOCUMENT_SEARCH_MAX_QUERY);
  if (!Number.isSafeInteger(value.page_size) || value.page_size < 1 || value.page_size > DOCUMENT_SEARCH_MAX_PAGE_SIZE) refuse();
  if (value.page_token !== undefined) pageToken(value.page_token);
  for (const key of ["doc_filter", "wiki_filter"]) {
    const filter = value[key];
    if (filter === undefined) continue;
    if (!plain(filter) || !keysWithin(filter, ["doc_types", "sort_type"])) refuse();
    if (filter.doc_types !== undefined) enumerated(filter.doc_types, DOC_TYPES, DOC_TYPES.length);
    if (filter.sort_type !== undefined && !DOC_SORTS.includes(filter.sort_type)) refuse();
  }
}

// Recipient lookup before a direct message: either a name/email query or the
// exact ids being confirmed. External contacts are always excluded, so the
// product cannot be steered into resolving people outside the tenant.
function contactSearchBody(value) {
  if (!keysWithin(value, ["query", "filter", "page_token"])) refuse();
  if (value.query !== undefined) text(value.query, 50);
  if (value.page_token !== undefined) pageToken(value.page_token);
  const filter = value.filter;
  if (!plain(filter) || !keysWithin(filter, ["user_ids", "exclude_outer_contact"]) || filter.exclude_outer_contact !== true) refuse();
  if (filter.user_ids !== undefined) {
    if (!Array.isArray(filter.user_ids) || !filter.user_ids.length || filter.user_ids.length > 50 ||
        new Set(filter.user_ids).size !== filter.user_ids.length || filter.user_ids.some(id => !USER_ID.test(id))) refuse();
  }
  if (value.query === undefined && filter.user_ids === undefined) refuse();
}

// Group lookup before a group message. Only chats the caller can already see.
function chatSearchBody(value) {
  if (!keysWithin(value, ["query", "filter", "page_token"])) refuse();
  text(value.query, 64);
  if (value.page_token !== undefined) pageToken(value.page_token);
  const filter = value.filter;
  if (!plain(filter) || !keysWithin(filter, ["search_types", "disable_search_by_user"])) refuse();
  if (filter.search_types !== undefined) enumerated(filter.search_types, CHAT_SEARCH_TYPES, CHAT_SEARCH_TYPES.length);
  if (filter.disable_search_by_user !== undefined && typeof filter.disable_search_by_user !== "boolean") refuse();
}

// 日程与任务. Feishu serves these three reads as POSTs; each shape below was
// recorded from the real request the pinned CLI sends (through the app's own
// sidecar, answered by a recorder), not from its dry run, which omits them.
export const FREEBUSY_PATH = "/open-apis/calendar/v4/freebusy/list";
export const SUGGESTION_PATH = "/open-apis/calendar/v4/freebusy/suggestion";
export const TASK_SEARCH_PATH = "/open-apis/task/v2/tasks/search";
export const TASKLIST_SEARCH_PATH = "/open-apis/task/v2/tasklists/search";
// Reading a spreadsheet is a POST: the pinned CLI asks the sheet_ai read tool
// rather than a REST resource. Without this entry the bridge could not read a
// spreadsheet at all — the app's own 飞书表格 view and the knowledge copy both
// came back with Feishu's error mangled by the SDK. `invoke_read` is the read
// half of that endpoint; `invoke_write` stays a write and is unaffected.
const SHEET_READ = /^\/open-apis\/sheet_ai\/v2\/spreadsheets\/[A-Za-z0-9_-]{1,128}\/tools\/invoke_read$/;
const SHEET_READ_TOOLS = Object.freeze(["get_workbook_structure", "get_cell_ranges"]);
const A1_RANGE = /^[A-Z]{1,3}[1-9]\d{0,4}(?::[A-Z]{1,3}[1-9]\d{0,4})?$/;
const SHEET_ID = /^[A-Za-z0-9_-]{1,128}$/;
// The tool's arguments travel as a JSON string, so the shape is checked after
// parsing it: a closed key set, the workbook it names, and bounded ranges.
function sheetReadBody(value) {
  if (!keysWithin(value, ["tool_name", "input"])) refuse();
  if (!SHEET_READ_TOOLS.includes(value.tool_name)) refuse();
  if (typeof value.input !== "string" || value.input.length > 4096) refuse();
  let input; try { input = JSON.parse(value.input); } catch { refuse(); }
  if (!plain(input) || !keysWithin(input, ["excel_id", "sheet_id", "ranges", "include_styles", "max_chars", "cell_limit", "value_render_option", "skip_hidden"])) refuse();
  if (typeof input.excel_id !== "string" || !SHEET_ID.test(input.excel_id)) refuse();
  if (input.sheet_id !== undefined && (typeof input.sheet_id !== "string" || !SHEET_ID.test(input.sheet_id))) refuse();
  if (input.ranges !== undefined) {
    if (!Array.isArray(input.ranges) || !input.ranges.length || input.ranges.length > 8) refuse();
    for (const range of input.ranges) if (typeof range !== "string" || !A1_RANGE.test(range)) refuse();
  }
  for (const key of ["include_styles", "skip_hidden"]) if (input[key] !== undefined && typeof input[key] !== "boolean") refuse();
  for (const key of ["max_chars", "cell_limit"]) if (input[key] !== undefined && !(Number.isInteger(input[key]) && input[key] > 0 && input[key] <= 1_000_000_000)) refuse();
  if (input.value_render_option !== undefined && (typeof input.value_render_option !== "string" || !/^[a-z_]{1,32}$/.test(input.value_render_option))) refuse();
}

const EVENT_SEARCH = /^\/open-apis\/calendar\/v4\/calendars\/(?:primary|[A-Za-z0-9._@-]{1,200})\/events\/search_event$/;
const ROOM_ID = /^omm_[A-Za-z0-9_-]{1,128}$/, CHAT_ID = /^oc_[A-Za-z0-9_-]{1,128}$/;
const time = value => { if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) refuse(); };
const ids = (value, pattern, max = 20) => {
  if (!Array.isArray(value) || !value.length || value.length > max || new Set(value).size !== value.length || value.some(id => typeof id !== "string" || !pattern.test(id))) refuse();
};
const timeRange = value => {
  if (!plain(value) || !keysWithin(value, ["start_time", "end_time"])) refuse();
  if (value.start_time !== undefined) time(value.start_time);
  if (value.end_time !== undefined) time(value.end_time);
};
// Whether one person, or a room, is busy in a time window. Reading someone
// else's free/busy is what scheduling with them needs, and it reveals only
// busy/free, not the events themselves.
function freebusyBody(value) {
  if (!keysWithin(value, ["time_min", "time_max", "user_id", "room_id", "need_rsvp_status", "include_external_calendar", "only_busy"])) refuse();
  time(value.time_min); time(value.time_max);
  if ((value.user_id === undefined) === (value.room_id === undefined)) refuse();
  if (value.user_id !== undefined && !USER_ID.test(value.user_id)) refuse();
  if (value.room_id !== undefined && !ROOM_ID.test(value.room_id)) refuse();
  for (const flag of ["need_rsvp_status", "include_external_calendar", "only_busy"]) if (value[flag] !== undefined && typeof value[flag] !== "boolean") refuse();
}
// The field names below are the ones the pinned CLI sends, recorded from its
// real requests; a name it does not send is not accepted.
function eventSearchBody(value) {
  if (!keysWithin(value, ["query", "filter"])) refuse();
  text(value.query, 50);
  if (value.filter === undefined) return;
  const filter = value.filter;
  if (!plain(filter) || !keysWithin(filter, ["time_range", "attendee_user_ids", "attendee_chat_ids", "meeting_room_ids"])) refuse();
  if (filter.time_range !== undefined) timeRange(filter.time_range);
  if (filter.attendee_user_ids !== undefined) ids(filter.attendee_user_ids, USER_ID);
  if (filter.attendee_chat_ids !== undefined) ids(filter.attendee_chat_ids, CHAT_ID);
  if (filter.meeting_room_ids !== undefined) ids(filter.meeting_room_ids, ROOM_ID);
}
// Free time shared by the people named, inside a window. Like free/busy it
// answers with open slots, not with anyone's events.
function suggestionBody(value) {
  if (!keysWithin(value, ["search_start_time", "search_end_time", "timezone", "duration_minutes", "event_rrule", "attendee_user_ids", "attendee_chat_ids", "excluded_event_times"])) refuse();
  time(value.search_start_time); time(value.search_end_time);
  if (value.timezone !== undefined && (typeof value.timezone !== "string" || !/^[A-Za-z][A-Za-z0-9_+\/-]{0,63}$/.test(value.timezone))) refuse();
  if (value.duration_minutes !== undefined && !(Number.isInteger(value.duration_minutes) && value.duration_minutes >= 1 && value.duration_minutes <= 1440)) refuse();
  if (value.event_rrule !== undefined && (typeof value.event_rrule !== "string" || !/^[A-Z0-9=;,:+-]{1,200}$/.test(value.event_rrule))) refuse();
  if (value.attendee_user_ids !== undefined) ids(value.attendee_user_ids, USER_ID, 50);
  if (value.attendee_chat_ids !== undefined) ids(value.attendee_chat_ids, CHAT_ID);
  if (value.excluded_event_times !== undefined) {
    const slots = value.excluded_event_times;
    if (!Array.isArray(slots) || !slots.length || slots.length > 20) refuse();
    for (const slot of slots) {
      if (!plain(slot) || !keysWithin(slot, ["event_start_time", "event_end_time"])) refuse();
      time(slot.event_start_time); time(slot.event_end_time);
    }
  }
}
function taskSearchBody(value) {
  if (!keysWithin(value, ["query", "filter"])) refuse();
  text(value.query, 100);
  if (value.filter === undefined) return;
  const filter = value.filter;
  if (!plain(filter) || !keysWithin(filter, ["is_completed", "assignee_ids", "creator_ids", "follower_ids", "due_time"])) refuse();
  if (filter.is_completed !== undefined && typeof filter.is_completed !== "boolean") refuse();
  for (const key of ["assignee_ids", "creator_ids", "follower_ids"]) if (filter[key] !== undefined) ids(filter[key], USER_ID);
  if (filter.due_time !== undefined) timeRange(filter.due_time);
}
function tasklistSearchBody(value) {
  if (!keysWithin(value, ["query", "filter"])) refuse();
  text(value.query, 100);
  if (value.filter === undefined) return;
  const filter = value.filter;
  if (!plain(filter) || !keysWithin(filter, ["user_id", "create_time"])) refuse();
  if (filter.user_id !== undefined) ids(filter.user_id, USER_ID);
  if (filter.create_time !== undefined) timeRange(filter.create_time);
}

// Base records by id. The pinned CLI's `base +record-get` sends this POST with the
// record ids and an optional field projection; the answer is those records'
// cells and nothing else. Reviewed Base edits read the records they change
// through it, before the write and after.
const BASE_RECORD_GET = /^\/open-apis\/base\/v3\/bases\/[A-Za-z0-9_-]{1,128}\/tables\/tbl[A-Za-z0-9]{1,64}\/records\/batch_get$/;
const BASE_RECORD_ID = /^rec[A-Za-z0-9]{1,64}$/;
function baseRecordGetBody(value) {
  if (!keysWithin(value, ["record_id_list", "select_fields"])) refuse();
  ids(value.record_id_list, BASE_RECORD_ID, 100);
  if (value.select_fields !== undefined) {
    const fields = value.select_fields;
    if (!Array.isArray(fields) || !fields.length || fields.length > 50 || new Set(fields).size !== fields.length) refuse();
    for (const field of fields) text(field, 100);
  }
}

const READS = Object.freeze([
  Object.freeze({ path: DOCUMENT_SEARCH_PATH, query: [], body: documentSearchBody }),
  Object.freeze({ path: CONTACT_SEARCH_PATH, query: ["page_size"], body: contactSearchBody }),
  Object.freeze({ path: CHAT_SEARCH_PATH, query: ["page_size"], body: chatSearchBody }),
  Object.freeze({ path: FREEBUSY_PATH, query: [], body: freebusyBody }),
  Object.freeze({ path: SUGGESTION_PATH, query: [], body: suggestionBody }),
  Object.freeze({ pattern: EVENT_SEARCH, query: ["page_size", "page_token"], body: eventSearchBody }),
  Object.freeze({ path: TASK_SEARCH_PATH, query: ["page_size", "page_token"], body: taskSearchBody }),
  Object.freeze({ path: TASKLIST_SEARCH_PATH, query: ["page_size", "page_token"], body: tasklistSearchBody }),
  Object.freeze({ pattern: SHEET_READ, query: [], body: sheetReadBody }),
  Object.freeze({ pattern: BASE_RECORD_GET, query: [], body: baseRecordGetBody }),
]);

// Returns the named read this request is, or null. The pathname must match
// exactly and every query parameter must be one this operation declares.
export function feishuCliSemanticRead(method, path) {
  if (method !== "POST" || typeof path !== "string") return null;
  const [pathname, search = ""] = path.split("?");
  const read = READS.find(entry => entry.path === pathname || entry.pattern?.test(pathname));
  if (!read) return null;
  if (search) {
    if (search.includes("#")) return null;
    const params = new URLSearchParams(search);
    for (const [name, value] of params) {
      if (!read.query.includes(name)) return null;
      if (name === "page_size" && !(/^\d{1,3}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_PAGE_SIZE)) return null;
      if (name === "page_token" && !/^[A-Za-z0-9_=-]{1,512}$/.test(value)) return null;
    }
  }
  return read;
}

// Throws unless the body is exactly the operation this path names. An unknown
// field, an over-long query or an unknown enumeration is refused here rather
// than forwarded to Feishu.
export function validateFeishuCliSemanticRead(read, body) {
  if (!read || !Buffer.isBuffer(body) || !body.length || body.length > MAX_BODY_BYTES) refuse();
  let value;
  try { value = JSON.parse(body.toString("utf8")); } catch { refuse(); }
  if (!plain(value)) refuse();
  read.body(value);
  return value;
}

// Kept for the document picker, which needs the same limits the server enforces.
export function isFeishuCliDocumentSearch(method, path) {
  return feishuCliSemanticRead(method, path)?.path === DOCUMENT_SEARCH_PATH;
}
