// Feishu's OpenAPI as this product speaks it: the paths, never the host.
//
// Which origin a path is sent to belongs to the deployment
// (provider-definition.js). The control plane used to write
// `https://open.feishu.cn` in front of these in seven different files, so a
// deployment anywhere else meant editing all seven; now a definition that
// speaks this protocol supplies the origin once and every caller asks it.
export const OPENAPI_PROTOCOL = "feishu-openapi-v1";

export const OPENAPI_PATHS = Object.freeze({
  // Served on the accounts origin, not the API one.
  authorize: "/open-apis/authen/v1/authorize",
  token: "/open-apis/authen/v2/oauth/token",
  userInfo: "/open-apis/authen/v1/user_info",
  tenantToken: "/open-apis/auth/v3/tenant_access_token/internal",
  // One message to one person, whether the application or the person sends it.
  message: "/open-apis/im/v1/messages?receive_id_type=open_id",
});

// How this protocol names a person and a chat. A deployment that speaks it may
// narrow these (provider-definition.js) but never widen them: the message and
// read contracts address people and chats in exactly these shapes.
export const OPENAPI_IDS = Object.freeze({
  user: /^ou_[A-Za-z0-9_-]{1,128}$/,
  chat: /^oc_[A-Za-z0-9_-]{1,128}$/,
});

// Whether a person may view one resource, asked as that person. The type has to
// match the token's own kind, so each resource kind this product stores has
// exactly one spelling here -- asking with the wrong type answers about a
// resource nobody named. Measured from the pinned CLI's own schema
// (`drive permission.members auth`), whose `type` admits doc, sheet, file,
// wiki, bitable, docx, mindnote, minutes and slides.
export const VIEW_PERMISSION_TYPES = Object.freeze({ document: "docx", sheet: "sheet", base: "bitable" });
export function viewPermissionPath(kind, resourceId) { return permissionPath(kind, resourceId, "view"); }
// The same probe for another action: `edit` for a document a scheduled task is
// to write its result into (schedule-deliveries.js).
export function permissionPath(kind, resourceId, action) {
  const type = VIEW_PERMISSION_TYPES[kind];
  if (!type) throw new Error(`没有为 ${kind} 定义权限探针`);
  if (!["view", "edit"].includes(action)) throw new Error(`没有为 ${action} 定义权限探针`);
  return `/open-apis/drive/v1/permissions/${resourceId}/members/auth?type=${type}&action=${action}`;
}
export const docxViewPermissionPath = (resourceId) => viewPermissionPath("document", resourceId);

// Resolve a Wiki node to the concrete resource it represents before a durable
// authorization is stored. A node token is a navigation identity: it can be
// re-pointed, and the same node may carry a document today and a spreadsheet
// tomorrow. Scheduled work is bound to the underlying resource identity
// instead, and only to the kinds this product can actually read.
export const wikiNodePath = (nodeToken) => `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`;
export const WIKI_OBJECT_KINDS = Object.freeze({ docx: "document", sheet: "sheet", bitable: "base" });

// The two answers that mean "this caller may not ask", as opposed to "what you
// asked about is not there for you": the application never applied for a scope
// (99991672), or the person's login does not carry it (99991679). Only these
// are an administrator's and a re-login's to fix. 99991672 was measured with
// HTTP 400, as was 131005, a Wiki node that is not there, which is not one of
// them; 99991679 was measured live (document-errors.js) without its status
// being recorded. Either way the body's code decides, not the status. Anything
// else is about the resource.
export const scopeRefused = (code) => code === 99991672 || code === 99991679;

// A refusal of our own -- the desktop sidecar's, the control plane's CLI proxy,
// the sandbox's CLI route -- is read by the Feishu SDK inside the CLI, which
// parses any failure as Feishu's own envelope: an integer `code`, a `msg`, and
// `error` only ever an object. `{"error": "<reason>"}` and plain text both
// failed that parse, and the CLI printed "SDK returned an invalid JSON
// response" where the reason belonged -- the one line that would tell a model
// to stop was the one it never saw. `code` is the HTTP status, a number no
// Feishu verdict uses.
export const feishuCliRefusal = (status, reason) => ({ code: status, msg: String(reason ?? "") });

// A path this protocol could be asked for: rooted under /open-apis/, no
// whitespace, no backslash and nothing a URL parser would rewrite. Returned
// unchanged or refused -- a path that could be read two ways is never
// normalised into one of them.
export function openApiPath(value) {
  if (typeof value !== "string" || value.length > 8192 || !value.startsWith("/open-apis/") || /[\\\x00-\x20]/.test(value)) return null;
  const parsed = new URL(value, "https://path.invalid");
  if (parsed.origin !== "https://path.invalid" || `${parsed.pathname}${parsed.search}` !== value || parsed.hash) return null;
  return value;
}

// A raw read as the pinned lark-cli takes it. Since 1.0.96 its `api` command
// refuses a query string in the path ("path must not contain a query string or
// fragment") and sends the same parameters given as --params instead. Three
// reads wrote their query into the path and failed from the 9-18 upgrade on
// (measured 2026-09-22): the Drive folder listing, the Base reader and the
// group lookup before a group delivery. The Wiki reader already split it by
// hand, and goes through here now as well.
export function cliApiGet(endpoint) {
  if (!openApiPath(endpoint)) throw new Error("飞书读取路径无效");
  const url = new URL(endpoint, "https://path.invalid");
  return url.search ? ["api", "GET", url.pathname, "--params", JSON.stringify(Object.fromEntries(url.searchParams))] : ["api", "GET", url.pathname];
}
