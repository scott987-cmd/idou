import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { LONGEST_SIDE_CALL_MS } from "../providers/codex/chat-models.js";

// How long the desktop waits for an answer about a published site. Most come
// at once. The ones the server checks first -- a site or a new version, a new
// audience, bringing one back, new data (docs/site-content-safety.md) -- can
// wait on the deployment's chat model reading the page, which may take up to
// its model's side-call allowance; and the server goes on to publish whether or
// not anybody is still waiting. Given up on sooner, a site can go up while the
// person who published it is told it failed, and publishes it a second time.
export const SITE_REQUEST_MS = 60_000;
export const SITE_CHECKED_REQUEST_MS = LONGEST_SIDE_CALL_MS + 60_000;
export const CHECKED_SITE_ROUTES = Object.freeze(new Set(["/v1/sites/publish", "/v1/sites/share", "/v1/sites/republish", "/v1/sites/data", "/v1/sites/rollback"]));
export const siteRequestTimeout = (route) => CHECKED_SITE_ROUTES.has(route) ? SITE_CHECKED_REQUEST_MS : SITE_REQUEST_MS;

// Why a site request came back with no answer, in words a person can act on:
// the fetch's own errors are English and say nothing of what to do. A request
// that may have reached the server -- it timed out, or the connection broke
// off, or what came back could not be read -- may still be carried out there,
// so each route says what to look for next. One that cannot have been carried
// out says so: it never got there (refused, no such host, a certificate that
// fails), or it was turned away to somewhere else.
const NEVER_ARRIVED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]);
const CERTIFICATE = /^(?:CERT_|ERR_TLS_|ERR_SSL_)|SELF_SIGNED|UNABLE_TO_(?:VERIFY|GET_ISSUER)/;
const MAY_STILL_HAPPEN = Object.freeze({
  "/v1/sites/publish": "它可能稍后就会生效：过一会儿刷新网站列表看看；再点发布会更新同一个网站，不会多出一个。",
  "/v1/sites/share": "新的分享范围可能稍后生效：过一会儿刷新网站列表看看，再决定要不要重新设置。",
  "/v1/sites/republish": "网站可能稍后重新上线：过一会儿刷新网站列表看看。",
  "/v1/sites/data": "这次的数据可能稍后更新到线上；下次刷新时会再推送一次。",
  "/v1/sites/rollback": "可能稍后回到那一版：过一会儿打开「历史版本」看看哪一版在线上。",
  "/v1/sites/withdraw": "可能已经取消发布：过一会儿刷新网站列表看看。",
  "/v1/sites/erase": "可能已经删掉了：过一会儿刷新网站列表看看。",
});
// 更新线上: a new version of a site already up; the list cannot show which version is.
const UPDATE_MAY_STILL_HAPPEN = "新版本可能稍后就会上线：打开链接看看；再点「更新线上」会更新同一个网站，不会多出一个。";
export function siteRequestFailure(error, route, { quitting = false, updating = false } = {}) {
  if (quitting) return "i豆 正在退出，这次没有等到服务端的答复。";
  const code = String(error?.cause?.code ?? error?.code ?? "");
  if (CERTIFICATE.test(code) || NEVER_ARRIVED.has(code) && /CERT/.test(code)) return "服务端的证书没有通过校验，这次请求没有发出去。请检查网络或代理设置后再试。";
  if (/redirect/i.test(String(error?.cause?.message ?? ""))) return "答复被转到了别的地址，这次请求没有执行。请检查网络或代理设置后再试。";
  const timedOut = error?.name === "TimeoutError";
  const unreadable = error instanceof SyntaxError;
  const next = route === "/v1/sites/publish" && updating ? UPDATE_MAY_STILL_HAPPEN : MAY_STILL_HAPPEN[route];
  if (next && !NEVER_ARRIVED.has(code)) {
    const what = timedOut ? (CHECKED_SITE_ROUTES.has(route) ? `服务端还在检查，等了 ${Math.round(SITE_CHECKED_REQUEST_MS / 60_000)} 分钟仍没有答复。` : "服务端没有及时答复。")
      : unreadable ? "收到的答复看不懂（可能被网络或代理改动了）。" : "和服务端的连接在答复前断开了。";
    return `${what}${next}`;
  }
  if (unreadable) return "收到的答复看不懂（可能被网络或代理改动了），请稍后再试。";
  return timedOut ? "服务端没有及时答复，请稍后再试。" : "连不上服务端，请检查网络后再试。";
}

// A body this big or bigger goes compressed, to a server that said it takes
// that (site-service.js `compressed-requests`).
export const COMPRESS_REQUESTS_FROM = 64 * 1024;
// What a server that does not say keeps of one site's data: 8 MB, about 5,000
// rows of a dozen fields, which every server kept until docs/sites-phase1.md §1.7.
export const OLD_SERVER_DATA_BYTES = 8 * 1024 * 1024;
const megabytes = (bytes) => {
  const value = bytes / 1024 / 1024;
  return `${Number.isInteger(value) ? value : value < 10 ? value.toFixed(1) : Math.round(value)} MB`;
};
const dataSize = (data) => Buffer.byteLength(JSON.stringify({ schema: data?.schema ?? null, snapshot: data?.snapshot ?? null }));
// `old`: the server did not say what it keeps, so it is one from before it
// kept more, and upgrading it is something to do about it.
export const tooMuchData = (limit, size = null, { old = false } = {}) => limit
  ? `这份表格数据${size ? `有 ${megabytes(size)}，` : ""}超过了服务端能存的 ${megabytes(limit)}：请在「文档网站」里减少行数或字段`
    + `${old ? "，或请管理员把服务端升级到能存更多数据的版本" : ""}。`
  : "这份表格数据超过了服务端能存的上限：请在「文档网站」里减少行数或字段，或请管理员升级服务端。";
const gzipped = promisify(gzip);

// A request body as it goes to the server. A table's data past what the server
// keeps is said in words before it is sent -- an older server answered it as
// 版本包太大. And it is compressed only for a server that said it takes that:
// a table's data is text that comes down to a twentieth, and a server that did
// not say would refuse it as not JSON. `features` null: the server has not
// answered yet, so nothing is assumed of it either way.
export async function siteRequestBody(route, body, { features = null, limits = null } = {}) {
  const json = Buffer.from(JSON.stringify(body));
  if (Array.isArray(features)) {
    const said = Number.isSafeInteger(limits?.dataBytes) && limits.dataBytes > 0;
    const limit = said ? limits.dataBytes : OLD_SERVER_DATA_BYTES;
    const data = route === "/v1/sites/data" ? body : body?.data;
    // The whole body first: only one that big can hold data that big.
    if (data && json.length > limit) {
      const size = dataSize(data);
      if (size > limit) throw new Error(tooMuchData(limit, size, { old: !said }));
    }
    if (features.includes("compressed-requests") && json.length >= COMPRESS_REQUESTS_FROM) return { body: await gzipped(json), encoding: "gzip" };
  }
  return { body: json, encoding: null };
}
