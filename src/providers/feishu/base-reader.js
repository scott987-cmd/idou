// Reading a Feishu Base (多维表格) the way the knowledge copy needs it: one
// table, bounded, with the field names it is keyed by, and a revision to check
// it against.
//
// The pinned CLI has no typed `bitable` resource command under the login bridge,
// so this goes through the read-only API passthrough the sidecar already
// permits for GETs — the same route drive-files.js uses. Scopes base:app:read,
// base:table:read and base:record:read are already held.
//
// What it deliberately does not do: no view filters, no formula evaluation, no
// attachment fetching. A Base cell can hold a person, a link, an attachment or
// a formula result; each is projected to the text a reader would see and marked
// when it cannot be.
import { createHash } from "node:crypto";
import { successfulUserPayload } from "./document-errors.js";
import { cliApiGet } from "./openapi.js";
import { hostWithin, SAAS_RESOURCE_HOSTS } from "./saas-deployment.js";

const APPS = "/open-apis/bitable/v1/apps";
const token = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// One bounded read of one table. A Base with more rows keeps its first page and
// says so; it is never presented as the whole table.
// Records are read page by page (the API returns at most 500 at a time), up to
// 2,000 records or 450,000 characters of projection, whichever binds first: an
// evidence page may not exceed half a million characters.
export const BASE_COVERAGE = Object.freeze({ maxRecords: 2000, maxFields: 30, maxValue: 200, maxChars: 450_000 });
const RECORD_PAGE = 500;
const MAX_PAGES = 20;

export function baseReference(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\\\x00-\x20]/u.test(value)) throw new Error("请输入完整的飞书多维表格链接。");
  let url; try { url = new URL(value); } catch { throw new Error("请输入完整的飞书多维表格链接。"); }
  const match = /^\/(base|wiki)\/([A-Za-z0-9_-]{8,128})\/?$/u.exec(url.pathname);
  const table = url.searchParams.get("table");
  if (!match || url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !hostWithin(url.hostname, SAAS_RESOURCE_HOSTS) ||
      url.searchParams.getAll("table").length > 1 || (table !== null && !token(table))) throw new Error("当前多维表格阅读器支持 SaaS HTTPS base 链接。");
  const canonical = new URL(url.href);
  canonical.search = table ? `?table=${table}` : "";
  // Which path named it: a Wiki node is navigation, not the Base itself, so a
  // caller that stores an authorization must resolve it before trusting it.
  return { appToken: match[2], tableId: table, url: canonical.href, kind: match[1] };
}

// Every Base cell type reduced to what a person reads in the grid. Anything this
// cannot render faithfully says so rather than arriving as silent JSON.
export function baseCellText(value, { maxValue = BASE_COVERAGE.maxValue } = {}) {
  const flatten = (item) => {
    if (item === null || item === undefined) return "";
    if (typeof item === "string") return item;
    if (typeof item === "number") return Number.isFinite(item) ? String(item) : "";
    if (typeof item === "boolean") return item ? "TRUE" : "FALSE";
    if (Array.isArray(item)) return item.map(flatten).filter(Boolean).join("、");
    if (typeof item === "object") {
      // Person, link, document reference, attachment, formula result: each
      // carries the label a reader sees under a different key.
      for (const key of ["text", "name", "en_name", "link", "file_name", "value"]) {
        if (item[key] !== undefined && item[key] !== null) return flatten(item[key]);
      }
      return "（未展开内容）";
    }
    return "";
  };
  const text = flatten(value).replace(/\s+/gu, " ").replaceAll("|", "｜").trim();
  return text.length > maxValue ? `${text.slice(0, maxValue)}…` : text;
}

export class SaasBaseReader {
  constructor(provider) { this.provider = provider; }
  // `reference` is a Base link; `tableId` overrides the one in the link.
  async read(reference, { tableId, coverage = BASE_COVERAGE, signal } = {}) {
    const parsed = baseReference(reference);
    if (tableId !== undefined && !token(tableId)) throw new Error("多维表格数据表标识无效。");
    const identity = await this.provider.documentIdentity({ signal });
    if (!identity.tenantKey || !identity.principal) throw new Error("多维表格读取需要已核验的企业用户身份。");
    const get = async (path) => {
      signal?.throwIfAborted();
      const result = await this.provider.invoke([...cliApiGet(path), "--as", "user", "--format", "json"], { signal, timeoutMs: 30_000, maxOutputBytes: 1_048_576 });
      signal?.throwIfAborted();
      return successfulUserPayload(result).data;
    };
    const app = await get(`${APPS}/${parsed.appToken}`);
    const name = app?.app?.name;
    if (typeof name !== "string" || !name || name.length > 300) throw new Error("多维表格响应缺少可靠的名称或版本。");
    const tables = await get(`${APPS}/${parsed.appToken}/tables?page_size=100`);
    if (!Array.isArray(tables?.items) || !tables.items.length) throw new Error("多维表格里没有可读取的数据表。");
    const wanted = tableId ?? parsed.tableId;
    const table = wanted ? tables.items.find((item) => item.table_id === wanted) : tables.items[0];
    if (!table || !token(table.table_id) || typeof table.name !== "string" || !table.name) throw new Error("未找到这张数据表。");
    const fields = await get(`${APPS}/${parsed.appToken}/tables/${table.table_id}/fields?page_size=100`);
    if (!Array.isArray(fields?.items)) throw new Error("多维表格字段响应无效。");
    const names = fields.items.map((item) => item.field_name).filter((item) => typeof item === "string" && item).slice(0, coverage.maxFields);
    if (!names.length) throw new Error("这张数据表没有可读取的字段。");
    // A table of more than one page used to be stored as its first page, with
    // nothing but a flag to say so; the rows after it could not be asked about.
    const records = [];
    let pageToken = null, more = false, chars = 0, pages = 0, full = false;
    do {
      const size = Math.min(RECORD_PAGE, coverage.maxRecords - records.length);
      const page = await get(`${APPS}/${parsed.appToken}/tables/${table.table_id}/records?page_size=${size}${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ""}`);
      if (!Array.isArray(page?.items) || typeof page.has_more !== "boolean") throw new Error("多维表格记录响应无效。");
      pages += 1;
      for (const item of page.items) {
        if (records.length >= coverage.maxRecords) { full = true; break; }
        const values = names.map((field) => baseCellText(item.fields?.[field], { maxValue: coverage.maxValue }));
        const cost = 4 + values.reduce((total, value) => total + value.length + 3, 0);
        if (coverage.maxChars && chars + cost > coverage.maxChars) { full = true; break; }
        chars += cost;
        records.push({ id: typeof item.record_id === "string" ? item.record_id : "", values });
      }
      more = page.has_more === true;
      pageToken = more ? page.page_token : null;
      if (more && (typeof pageToken !== "string" || !pageToken || pageToken.length > 512)) throw new Error("多维表格分页响应无效。");
    } while (more && !full && records.length < coverage.maxRecords && pages < MAX_PAGES);
    const current = await this.provider.documentIdentity({ signal });
    if (current.principal !== identity.principal || current.tenantKey !== identity.tenantKey) throw new Error("读取期间飞书身份已变化，请重新读取。");
    const snapshot = { kind: "feishu-base", providerId: this.provider.id, appToken: parsed.appToken, tableId: table.table_id,
      resourceId: `${parsed.appToken}:${table.table_id}`, sourceUrl: `${parsed.url.split("?")[0]}?table=${table.table_id}`,
      title: `飞书多维表格 · ${name} · ${table.name}`, fields: names, records,
      truncated: more || full || fields.items.length > names.length,
      tables: tables.items.map((item) => ({ id: item.table_id, name: item.name })).slice(0, 100) };
    // A Base has no revision number of its own, so the projection's own digest
    // is the version: any change to the rows this copy holds changes it.
    return { ...snapshot, sourceRevision: hash(snapshot).slice(0, 16), contentHash: hash(snapshot), identity: current };
  }
}
