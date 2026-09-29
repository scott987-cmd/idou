// The Feishu client that runs *inside* a scheduled task's sandbox.
//
// The bundled lark-cli cannot be used here, and that is settled by its design
// rather than by preference: it talks to a sidecar at `http://127.0.0.1:<port>`
// — inside a container that address is the container itself — and it
// authenticates with an HMAC key (`LARKSUITE_CLI_PROXY_KEY`) that signs
// arbitrary requests. Putting that key in the sandbox would hand it the ability
// to forge any call for as long as the key lives, which is the one thing the
// sandbox exists to prevent. So the sandbox gets this instead: no key, no
// credential, and a run token that dies with the run.
//
// The wire format is deliberately the same one the sidecar uses toward the
// control plane (`x-mydoubao-feishu-path`), so there is one protocol to reason
// about rather than two.
import "./legacy-env.js";
const EGRESS = process.env.IDOU_EGRESS;
const RUN = process.env.IDOU_RUN;
const ROUTE = "/v1/sandbox/egress";
const MAX_BYTES = 4 * 1024 * 1024;

export class FeishuReadError extends Error {
  constructor(status, code, path) {
    super(`飞书读取失败（${status} ${code}）：${path}`);
    this.status = status; this.code = code; this.path = path;
  }
}

function requirements() {
  if (!EGRESS || !RUN) throw new Error("沙箱缺少出口地址或运行令牌，无法访问飞书");
  // Loopback here would mean this container, and the job contract already
  // refuses it when the job is built. Checked again at the point of use,
  // because a value that arrives wrong should fail where it is used.
  if (/^https?:\/\/(localhost|127\.|\[?::1)/i.test(EGRESS)) throw new Error("出口地址不能是回环地址");
}

// One read. Returns Feishu's parsed JSON body, or throws with the status and
// Feishu's own error code so a task can say what actually went wrong rather
// than reporting a bare failure.
export async function read(path, { signal, timeoutMs = 30_000 } = {}) {
  requirements();
  if (typeof path !== "string" || !path.startsWith("/open-apis/")) throw new Error(`不是有效的飞书接口路径：${path}`);
  const response = await fetch(`${EGRESS}${ROUTE}`, {
    method: "GET", redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    headers: { "x-mydoubao-run": RUN, "x-mydoubao-feishu-path": path, accept: "application/json" },
  });
  // An empty body is a real answer here -- a 204, a proxy that hung up
  // mid-response, an upstream that returned nothing -- and reading `.length` off
  // it threw a bare TypeError that named neither the path nor the cause. For an
  // unattended task that lands in the run record as an unreadable type error and
  // sends whoever reads it looking in entirely the wrong place.
  const text = await response.text();
  if (typeof text !== "string" || text.length === 0) throw new FeishuReadError(response.status, "empty_response", path);
  if (text.length > MAX_BYTES) throw new FeishuReadError(response.status, "response_too_large", path);
  let body; try { body = JSON.parse(text); } catch { throw new FeishuReadError(response.status, "invalid_json", path); }
  // The proxy's own refusals and Feishu's are different failures and must not
  // be reported as the same thing: one means the sandbox asked for something it
  // may not have, the other means Feishu said no.
  if (!response.ok) throw new FeishuReadError(response.status, body?.error ?? body?.code ?? "unknown", path);
  if (body?.code !== undefined && body.code !== 0) throw new FeishuReadError(response.status, `feishu_${body.code}`, path);
  return body.data ?? body;
}

// Follows Feishu's `page_token` cursor. Bounded by default: a scheduled task
// that walks an unbounded list would spend its whole budget on one call and
// there is nobody watching to stop it.
export async function readAll(path, { key = "items", maxPages = 10, signal } = {}) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const data = await read(cursor ? `${path}${separator}page_token=${encodeURIComponent(cursor)}` : path, { signal });
    items.push(...(Array.isArray(data?.[key]) ? data[key] : []));
    if (!data?.has_more || !data?.page_token) return { items, complete: true };
    cursor = data.page_token;
  }
  // Says so rather than quietly returning a partial list as if it were whole.
  return { items, complete: false };
}

export const whoAmI = (options) => read("/open-apis/authen/v1/user_info", options);
export const chats = (options) => readAll("/open-apis/im/v1/chats?page_size=50", options);
export const messages = (chatId, { pageSize = 50, ...options } = {}) =>
  readAll(`/open-apis/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(chatId)}&page_size=${pageSize}`, options);
export const documentText = (documentId, options) =>
  read(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`, options);
