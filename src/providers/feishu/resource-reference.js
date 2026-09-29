import { hostWithin, SAAS_RESOURCE_HOSTS } from "./saas-deployment.js";

// Which Feishu resource a link points at.
//
// The document reader has its own stricter parser: it accepts only the kinds it
// can actually project into text. This one exists for the embedded view, where
// the person may navigate to a spreadsheet or a Base and the Agent needs to be
// told which resource is on screen. It recognises the kind and the token and
// nothing else -- no query string, no fragment, no path beyond the resource.
const KINDS = Object.freeze({ docx: "文档", wiki: "知识库页面", sheets: "电子表格", base: "多维表格" });
export const FEISHU_RESOURCE_LABELS = KINDS;

export function parseFeishuResourceReference(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\\\x00-\x20]/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password) return null;
  if (!hostWithin(url.hostname, SAAS_RESOURCE_HOSTS)) return null;
  const match = url.pathname.match(/^\/(docx|wiki|sheets|base)\/([A-Za-z0-9_-]{8,128})\/?$/);
  if (!match) return null;
  const [, kind, token] = match;
  url.search = ""; url.hash = "";
  return { kind, token, url: url.href, label: KINDS[kind] };
}

// A link that names a Wiki node. The node is navigation: it carries whichever
// document, spreadsheet or Base the space put behind it today, and that can
// change. Everything durable resolves it first (feishu-source-access.js), as
// the person, and stores what it resolved to -- never this token.
//
// `hint` is the one thing the link itself still gets to say about what is
// behind the node: which worksheet or table the person was looking at when they
// copied it. A node address alone names a whole workbook or Base, so dropping
// the hint would authorize more than the link did. It is a claim, not evidence:
// the resolver keeps it only when the resolved kind agrees with it, and the
// deployment's own link builder re-reads it before it is stored.
export function parseWikiNodeReference(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\\\x00-\x20]/.test(value)) throw new Error("请输入完整的飞书知识库链接");
  let url;
  try { url = new URL(value); } catch { throw new Error("请输入完整的飞书知识库链接"); }
  const match = url.pathname.match(/^\/wiki\/([A-Za-z0-9_-]{8,128})\/?$/);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !match ||
      !hostWithin(url.hostname, SAAS_RESOURCE_HOSTS)) throw new Error("这不是一个飞书知识库节点链接");
  const hint = subResource(url);
  url.search = ""; url.hash = "";
  return { token: match[1], url: url.href, hint };
}

// How this deployment spells "the worksheet" and "the table" in a link. Both at
// once is not a link this product builds or reads, and a malformed one is
// refused rather than quietly widened to the whole resource.
const SUB_RESOURCES = Object.freeze({ sheet: "sheet", table: "base" });
function subResource(url) {
  let found = null;
  for (const [param, kind] of Object.entries(SUB_RESOURCES)) {
    const values = url.searchParams.getAll(param);
    if (!values.length) continue;
    if (found || values.length > 1) throw new Error("这个知识库链接同时指向了多个子资源");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(values[0])) throw new Error("这个知识库链接里的子资源标识无效");
    found = { kind, subId: values[0] };
  }
  return found;
}
