import { createHash } from "node:crypto";

const OPAQUE = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER = /^[a-z][a-z0-9-]{1,39}$/;
const KINDS = new Set(["chat", "document", "sheet", "base"]);
// The bounds a stored grant is checked against. `modelCalls` is the most any
// grant may carry, not what a new one is given (MODEL_CALLS_GRANTED): the bound
// is raised one release before creation starts giving more, because a build
// that has not seen the higher number reads a newer grant as corrupt and wipes
// it when it opens the store -- the same rollback trap as a new schedule rule.
export const SCHEDULE_CAPABILITY_LIMITS = Object.freeze({ resources: 32, feishuCalls: 100, modelCalls: 80 });
// What a new grant is given: a round or two for each resource it may read, and
// room for the model to find its way. Eight, for every grant, was set with the
// first per-resource grants, before any real run on Codex 0.155: a one-document
// run has since used six and once ran out, and a grant may hold 32 resources,
// each needing at least a round of its own. 0.1.0-20260918.32 learned to read
// grants up to the bound before this one started giving them.
const MODEL_CALLS = Object.freeze({ base: 10, perResource: 2 });
export const modelCallsFor = (resources) => Math.min(MODEL_CALLS.base + MODEL_CALLS.perResource * resources, SCHEDULE_CAPABILITY_LIMITS.modelCalls);

const digest = value => createHash("sha256").update(value).digest("hex");
const canonical = value => JSON.stringify(value, (_key, item) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
});
const label = value => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 120);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

function resourceKey(resource) {
  return [resource.kind, resource.id, resource.subId ?? ""].join("\n");
}

function parseResource(feishu, input) {
  if (!input || typeof input !== "object" || !KINDS.has(input.kind)) throw new Error("定时任务资源类型无效");
  if (input.kind === "chat") {
    if (!feishu.ids.chat(input.id)) throw new Error("请输入有效的飞书会话 ID");
    return { kind: "chat", id: input.id, label: label(input.label) || input.id };
  }
  const reference = String(input.reference ?? "");
  if (input.kind === "document") {
    const parsed = feishu.references.document(reference);
    // A Wiki shortcut may resolve to a different underlying document token.
    // Until that mapping is verified at creation, accepting it would either
    // over-authorize or make the first real run fail unpredictably.
    if (parsed.kind !== "docx" || parsed.partial) throw new Error("定时任务目前只支持完整的 docx 文档链接，不支持 Wiki 快捷方式或段落锚点");
    return { kind: "document", id: parsed.token, reference: parsed.url, label: label(input.label) || "飞书文档" };
  }
  if (input.kind === "sheet") {
    const parsed = feishu.references.sheet(reference);
    return { kind: "sheet", id: parsed.token, ...(parsed.sheetId ? { subId: parsed.sheetId } : {}), reference: parsed.url,
      label: label(input.label) || "飞书电子表格" };
  }
  const parsed = feishu.references.base(reference);
  // The Base parser also reads a Wiki node's address, because the reader opens
  // both. An authorization may not: a node can be re-pointed, so what is stored
  // has to be the Base the control plane itself resolved it to.
  if (parsed.kind && parsed.kind !== "base") throw new Error("Wiki 链接要由服务端解析成底层资源后才能授权");
  return { kind: "base", id: parsed.appToken, ...(parsed.tableId ? { subId: parsed.tableId } : {}), reference: parsed.url,
    label: label(input.label) || "飞书多维表格" };
}

export function makeScheduleCapability({ feishu, who, resources = [], validUntil = null, revision = 1 }) {
  if (!feishu?.id || !who?.tenantId || !who?.userId) throw new Error("定时任务资源授权缺少已核验的企业身份");
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("定时任务资源授权版本无效");
  if (!Array.isArray(resources) || resources.length > SCHEDULE_CAPABILITY_LIMITS.resources) {
    throw new Error(`一个定时任务最多选择 ${SCHEDULE_CAPABILITY_LIMITS.resources} 个资源`);
  }
  const parsed = resources.map(row => parseResource(feishu, row));
  const unique = [...new Map(parsed.map(row => [resourceKey(row), row])).values()]
    .sort((a, b) => resourceKey(a).localeCompare(resourceKey(b)));
  const capability = {
    schemaVersion: 1,
    providerId: feishu.id,
    tenantId: who.tenantId,
    ownerId: who.userId,
    resources: unique,
    tools: ["feishu.read", "model.respond"],
    limits: { feishuCalls: SCHEDULE_CAPABILITY_LIMITS.feishuCalls, modelCalls: modelCallsFor(unique.length) },
    validUntil: validUntil === null ? null : Number(validUntil),
  };
  return Object.freeze({ capability, digest: digest(canonical(capability)), revision });
}

// The same grant with a different end date, as the next revision. Rebuilt from
// the stored manifest and never re-parsed from its links: a spreadsheet's link
// does not carry its worksheet, so parsing the links again would quietly widen a
// one-sheet grant to the whole workbook.
export function renewScheduleCapability(binding, { validUntil = null } = {}) {
  if (!binding?.capability || !Number.isSafeInteger(binding.revision) || binding.revision < 1) throw new Error("定时任务资源授权无效");
  const capability = structuredClone(binding.capability);
  capability.validUntil = validUntil === null ? null : Number(validUntil);
  return Object.freeze({ capability, digest: digest(canonical(capability)), revision: binding.revision + 1 });
}

// Direct store users (tests and deployments without a Feishu provider) get a
// real, digest-bound capability too, but one that authorizes no Feishu resource.
// Missing configuration must narrow authority, never recreate the old global
// read allowance.
export function makeDenyAllScheduleCapability(who, validUntil = null) {
  const capability = {
    schemaVersion: 1, providerId: "unconfigured", tenantId: who.tenantId, ownerId: who.userId,
    resources: [], tools: ["model.respond"],
    limits: { feishuCalls: 0, modelCalls: modelCallsFor(0) },
    validUntil: validUntil === null ? null : Number(validUntil),
  };
  return Object.freeze({ capability, digest: digest(canonical(capability)), revision: 1 });
}

export function validateScheduleCapability(binding, who) {
  if (!binding || typeof binding !== "object" || !binding.capability || !Number.isSafeInteger(binding.revision) || binding.revision < 1 ||
      typeof binding.digest !== "string" || !/^[a-f0-9]{64}$/.test(binding.digest)) throw new Error("定时任务资源授权无效");
  const value = binding.capability;
  const expectedTools = value.providerId === "unconfigured" ? ["model.respond"] : ["feishu.read", "model.respond"];
  const resourcesValid = Array.isArray(value.resources) && value.resources.length <= SCHEDULE_CAPABILITY_LIMITS.resources &&
    value.resources.every(row => {
      const keys = row?.kind === "chat" ? ["kind", "id", "label"] :
        row?.kind === "document" ? ["kind", "id", "reference", "label"] :
        row?.subId === undefined ? ["kind", "id", "reference", "label"] : ["kind", "id", "subId", "reference", "label"];
      if (!exact(row, keys) || !KINDS.has(row.kind) || !OPAQUE.test(row.id) || row.subId !== undefined && !OPAQUE.test(row.subId) ||
          typeof row.label !== "string" || !row.label || row.label.length > 120) return false;
      if (row.reference !== undefined) {
        let url; try { url = new URL(row.reference); } catch { return false; }
        if (url.protocol !== "https:" || url.username || url.password) return false;
      }
      return true;
    });
  if (!exact(value, ["schemaVersion", "providerId", "tenantId", "ownerId", "resources", "tools", "limits", "validUntil"]) ||
      value.schemaVersion !== 1 || value.tenantId !== who.tenantId || value.ownerId !== who.userId || !PROVIDER.test(value.providerId) ||
      !resourcesValid || JSON.stringify(value.tools) !== JSON.stringify(expectedTools) ||
      !exact(value.limits, ["feishuCalls", "modelCalls"]) || !Number.isSafeInteger(value.limits.feishuCalls) ||
      value.limits.feishuCalls < 0 || value.limits.feishuCalls > SCHEDULE_CAPABILITY_LIMITS.feishuCalls ||
      !Number.isSafeInteger(value.limits.modelCalls) || value.limits.modelCalls < 1 || value.limits.modelCalls > SCHEDULE_CAPABILITY_LIMITS.modelCalls ||
      value.validUntil !== null && !Number.isSafeInteger(value.validUntil)) {
    throw new Error("定时任务资源授权无效");
  }
  if (new Set(value.resources.map(resourceKey)).size !== value.resources.length) throw new Error("定时任务资源授权无效");
  if (digest(canonical(value)) !== binding.digest) throw new Error("定时任务资源授权摘要不匹配");
  return binding;
}

export function scheduleCapabilityView(binding) {
  if (!binding) return { configured: false, resources: [], limits: null, validUntil: null };
  return { configured: true, revision: binding.revision,
    resources: binding.capability.resources.map(({ kind, id, subId, reference, label }) => ({ kind, id, ...(subId ? { subId } : {}), ...(reference ? { reference } : {}), label })),
    limits: { ...binding.capability.limits }, validUntil: binding.capability.validUntil };
}

function bodyJson(body) {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > 4 * 1024 * 1024) return null;
  try { const value = JSON.parse(body.toString("utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { return null; }
}

function has(resources, kind, id, subId = undefined) {
  return resources.some(row => row.kind === kind && row.id === id && (row.subId === undefined || row.subId === subId));
}

function queriesWithin(url, allowed) {
  for (const [name, value] of url.searchParams) if (!allowed.has(name) || !value) return false;
  return true;
}

// Query parameters the pinned CLI was recorded sending, held to the only values
// it sends and to one occurrence each. A name alone is not a shape:
// `with_sender_name=true` was recorded, `with_sender_name=<anything>` was not.
// Recordings: test/fixtures/schedule-cli-read-shapes.json.
function queryValuesAre(url, rules) {
  for (const [name, pattern] of Object.entries(rules)) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1 || values.some(value => !pattern.test(value))) return false;
  }
  return true;
}
const PAGE_NUMBER = /^\d{1,9}$/;
const FLAG = /^(?:true|false)$/;

// One policy for both the direct helper and the bundled CLI proxy. It examines
// the normalized OpenAPI request, not the prompt or the CLI command name.
export function scheduleFeishuRequestAllowed(capability, method, rawPath, body = null) {
  if (!capability || !Array.isArray(capability.resources) || typeof rawPath !== "string") return false;
  let url; try { url = new URL(rawPath, "https://policy.invalid"); } catch { return false; }
  if (url.origin !== "https://policy.invalid" || url.hash) return false;
  const path = url.pathname, resources = capability.resources;
  if (method === "GET" && path === "/open-apis/authen/v1/user_info" && !url.search) return true;

  let match = /^\/open-apis\/docx\/v1\/documents\/([A-Za-z0-9_-]{1,128})(?:\/(?:raw_content|blocks))?$/.exec(path);
  if (method === "GET" && match) return queriesWithin(url, new Set(["page_size", "page_token", "document_revision_id"])) && has(resources, "document", match[1]);

  match = /^\/open-apis\/docs_ai\/v1\/documents\/([A-Za-z0-9_-]{1,128})\/fetch$/.exec(path);
  if (method === "POST" && match) return queriesWithin(url, new Set()) && (Buffer.isBuffer(body) && body.length === 0 || bodyJson(body) !== null) && has(resources, "document", match[1]);

  match = /^\/open-apis\/im\/v1\/messages$/.exec(path);
  if (method === "GET" && match) {
    // The last three are what the pinned CLI's `im +chat-messages-list` sends on
    // every read. They change how messages come back, never which chat is read;
    // without them every chat a task was granted read nothing.
    if (!queriesWithin(url, new Set(["container_id_type", "container_id", "page_size", "page_token", "start_time", "end_time", "sort_type",
          "card_msg_content_type", "only_thread_root_messages", "with_sender_name"])) ||
        !queryValuesAre(url, { card_msg_content_type: /^raw_card_content$/, only_thread_root_messages: FLAG, with_sender_name: FLAG }) ||
        url.searchParams.get("container_id_type") !== "chat" || url.searchParams.getAll("container_id_type").length !== 1 ||
        url.searchParams.getAll("container_id").length !== 1) return false;
    return has(resources, "chat", url.searchParams.get("container_id"));
  }

  match = /^\/open-apis\/sheets\/v3\/spreadsheets\/([A-Za-z0-9_-]{1,128})(?:\/sheets)?$/.exec(path);
  if (method === "GET" && match) return queriesWithin(url, new Set(["page_size", "page_token"])) && has(resources, "sheet", match[1]);

  // A Base's list of tables is that Base's own metadata, so a grant for the whole
  // Base may read it -- without it the agent cannot find a single table to read.
  // A grant for one table may not: the list names every table beside it.
  match = /^\/open-apis\/base\/v3\/bases\/([A-Za-z0-9_-]{1,128})\/tables$/.exec(path);
  if (method === "GET" && match) {
    return queriesWithin(url, new Set(["limit", "offset"])) && queryValuesAre(url, { limit: PAGE_NUMBER, offset: PAGE_NUMBER }) &&
      resources.some(row => row.kind === "base" && row.id === match[1] && row.subId === undefined);
  }

  match = /^\/open-apis\/(bitable\/v1\/apps|base\/v3\/bases)\/([A-Za-z0-9_-]{1,128})(?:\/tables\/([A-Za-z0-9_-]{1,128})(?:\/.*)?)?$/.exec(path);
  if (method === "GET" && match) {
    // base/v3 is what the pinned CLI speaks, and it pages with limit/offset;
    // bitable/v1 was never recorded doing that, so it does not get them.
    const paged = match[1] === "base/v3/bases" ? ["limit", "offset"] : [];
    return queriesWithin(url, new Set(["page_size", "page_token", "view_id", ...paged])) &&
      queryValuesAre(url, { limit: PAGE_NUMBER, offset: PAGE_NUMBER }) && has(resources, "base", match[2], match[3]);
  }

  match = /^\/open-apis\/sheet_ai\/v2\/spreadsheets\/([A-Za-z0-9_-]{1,128})\/tools\/invoke_read$/.exec(path);
  if (method === "POST" && match) {
    const value = bodyJson(body); let input = null;
    try { input = value && typeof value.input === "string" ? JSON.parse(value.input) : null; } catch { return false; }
    return input?.excel_id === match[1] && has(resources, "sheet", match[1], input.sheet_id);
  }

  match = /^\/open-apis\/base\/v3\/bases\/([A-Za-z0-9_-]{1,128})\/tables\/([A-Za-z0-9_-]{1,128})\/records\/batch_get$/.exec(path);
  if (method === "POST" && match) return bodyJson(body) !== null && has(resources, "base", match[1], match[2]);
  return false;
}
