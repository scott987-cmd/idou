// The administration console's own listener (docs/admin-console.md §2, §10).
//
// Its own origin and its own cookie, never the published sites' -- a published
// page is script its author wrote, and from the console's origin it could read
// the console with an administrator's cookie (security review of 2026-09-27).
// What it serves:
//
//   /admin, /admin/…      the page: a static shell, the same for everybody
//   /admin/assets/…       its script and styles, from this build only
//   /admin/api/…          JSON, for a signed-in administrator
//   /_auth/callback       Feishu's answer to the sign-in
//   /_auth/logout         signing out of the console
//
// Every API request is decided afresh -- who is this, are they still an
// administrator, may their role do this -- and every request that changes
// something must come from this origin, carry the token the page was given
// for this sign-in, and be JSON. The listener itself knows nothing of people,
// policies or audit: those are the routes' (admin-api.js).
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { roleRefusal } from "./admin-roles.js";

export const ADMIN_SERVER_LIMITS = Object.freeze({
  // An administrator's sign-in. Shorter than a visitor's: this one can change things.
  sessionMs: 8 * 60 * 60 * 1000,
  loginFlows: 200,
  loginFlowMs: 10 * 60 * 1000,
  bodyBytes: 256 * 1024,
  // Per administrator: enough for any page, too little to be a scraper.
  perSecond: 20,
  burst: 60,
});

const COOKIE = "idou_admin";
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), "admin-ui");
const TYPES = Object.freeze({ ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".html": "text/html; charset=utf-8" });
const b64 = (value) => Buffer.from(value).toString("base64url");
const unb64 = (value) => Buffer.from(String(value), "base64url");

// Everything the page loads is its own; it connects nowhere else.
const POLICY = Object.freeze({
  "content-security-policy": ["default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
});

// The console's cookie key, made from the deployment's site key so there is one
// secret to keep -- under a label of its own, so neither listener takes the
// other's cookie. Version 2 carries the administrator's name and a sign-in id
// the CSRF token is derived from.
export const adminCookieKey = (siteKey) => createHmac("sha256", siteKey).update("idou admin console cookie v2").digest();

const sign = (key, value) => createHmac("sha256", key).update(value).digest("base64url");
function seal(key, visitor, expiresAt) {
  const body = b64(JSON.stringify({ u: visitor.userId, t: visitor.tenantId, n: visitor.name ?? "", e: expiresAt, s: visitor.signInId }));
  return `${body}.${sign(key, body)}`;
}
function open(key, cookie, now) {
  if (typeof cookie !== "string" || cookie.length > 4096) return null;
  const [body, mac] = cookie.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(key, body)), given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value = JSON.parse(unb64(body).toString("utf8"));
    if (!value?.u || !value?.t || !value?.s || !(value.e > now)) return null;
    return { userId: String(value.u), tenantId: String(value.t), name: String(value.n ?? "").slice(0, 64), signInId: String(value.s), expiresAt: value.e };
  } catch { return null; }
}
export const csrfToken = (key, signInId) => sign(key, `csrf\n${signInId}`);

const cookies = (header) => Object.fromEntries(String(header ?? "").split(";").map((part) => {
  const at = part.indexOf("=");
  return at < 0 ? [part.trim(), ""] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
}).filter(([name]) => name));
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

// The page, its script and styles: read once, served with a digest so a new
// release is picked up and an unchanged one costs a 304.
export async function loadAdminAssets(directory = ASSETS) {
  const files = new Map();
  for (const name of await readdir(directory)) {
    const type = TYPES[path.extname(name)];
    if (!type || !/^[a-z0-9-]+\.[a-z]+$/.test(name)) continue;
    const bytes = await readFile(path.join(directory, name));
    files.set(name, { bytes, type, etag: `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 22)}"` });
  }
  if (!files.has("index.html")) throw new Error("管理台的页面文件缺失");
  return files;
}

export function createAdminServer({ origin, cookieKey: siteKey, oauth = null, allowlist = null, roles, api, assets,
  audit = () => {}, now = Date.now, log = () => {} } = {}) {
  if (!siteKey || siteKey.length < 32) throw new Error("管理台需要一把 cookie 签名密钥");
  if (!roles || !api || !assets) throw new Error("管理台需要角色、接口和页面");
  const key = adminCookieKey(siteKey);
  const secure = origin.startsWith("https://") ? " Secure;" : "";
  const flows = new Map();
  const buckets = new Map();

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...POLICY, "cache-control": "no-store", ...headers });
    res.end(body);
  };
  const json = (res, status, value) => send(res, status, JSON.stringify(value), { "content-type": "application/json; charset=utf-8" });
  const page = (res, status, title, message, link = null) => send(res, status, `<!doctype html><html lang="zh-CN"><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>`
    + `<link rel="stylesheet" href="/admin/assets/app.css"><body class="notice"><main class="notice-card"><h1>${escape(title)}</h1><p>${escape(message)}</p>`
    + `${link ? `<p><a class="button" href="${escape(link.href)}">${escape(link.text)}</a></p>` : ""}</main></body></html>`, { "content-type": "text/html; charset=utf-8" });

  // A token bucket per administrator: generous for a person, tight for a loop.
  const allowed = (userId) => {
    const at = now(), held = buckets.get(userId) ?? { tokens: ADMIN_SERVER_LIMITS.burst, at };
    held.tokens = Math.min(ADMIN_SERVER_LIMITS.burst, held.tokens + ((at - held.at) / 1000) * ADMIN_SERVER_LIMITS.perSecond);
    held.at = at;
    if (buckets.size > 5000) buckets.clear();
    buckets.set(userId, held);
    if (held.tokens < 1) return false;
    held.tokens -= 1;
    return true;
  };

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > ADMIN_SERVER_LIMITS.bodyBytes) throw Object.assign(new Error("请求太大"), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("请求不是合法的 JSON"), { status: 400 }); }
  }

  function startLogin(res, to) {
    if (!oauth) { page(res, 401, "请先登录", "这个部署没有配置飞书登录，管理台无法登录。"); return; }
    if (flows.size >= ADMIN_SERVER_LIMITS.loginFlows) for (const [id, flow] of flows) if (flow.until <= now()) flows.delete(id);
    if (flows.size >= ADMIN_SERVER_LIMITS.loginFlows) { page(res, 503, "登录太频繁", "同时进行的登录太多，请稍后再试。"); return; }
    const state = randomUUID(), verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    flows.set(state, { verifier, until: now() + ADMIN_SERVER_LIMITS.loginFlowMs, to });
    // Identity only: the console reads this server, never the person's Feishu.
    send(res, 302, "", { location: oauth.authorizationUrl({ redirectUri: `${origin}/_auth/callback`, state, challenge, scopes: [] }) });
  }

  async function finishLogin(url, req, res) {
    const state = url.searchParams.get("state"), code = url.searchParams.get("code");
    const flow = state ? flows.get(state) : null;
    flows.delete(state);
    if (!flow || flow.until <= now() || !code) { page(res, 400, "登录已过期", "这次登录已经过期，请重新打开管理后台。", { href: "/admin", text: "重新登录" }); return; }
    let identity = null;
    try { identity = await oauth.probeIdentity({ code, verifier: flow.verifier, redirectUri: `${origin}/_auth/callback`, scopes: [] }); } catch { identity = null; }
    if (!identity?.userId || !identity?.tenantId) { page(res, 403, "登录没有完成", "飞书没有确认你的身份，请再试一次。", { href: "/admin", text: "重新登录" }); return; }
    const verdict = await roles.decide(identity);
    audit({ category: "admin", action: "admin.sign-in", outcome: verdict.role ? "ok" : "refused", tenant: identity.tenantId, source: "admin-console",
      actor: { kind: verdict.role ? "admin" : "person", id: identity.userId, name: identity.name ?? "" }, target: {},
      detail: verdict.role ? { role: verdict.role, via: verdict.source } : { reason: verdict.reason }, address: req.socket?.remoteAddress ?? "" });
    if (!verdict.role) { page(res, 403, "没有管理权限", roleRefusal(verdict.reason)); return; }
    const visitor = { userId: identity.userId, tenantId: identity.tenantId, name: identity.name ?? "", signInId: randomUUID() };
    send(res, 302, "", { location: flow.to,
      "set-cookie": `${COOKIE}=${seal(key, visitor, now() + ADMIN_SERVER_LIMITS.sessionMs)}; Path=/;${secure} HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SERVER_LIMITS.sessionMs / 1000)}` });
  }

  function asset(res, name, req) {
    const file = assets.get(name);
    if (!file) { send(res, 404, "", { "content-type": "text/plain" }); return; }
    if (req.headers["if-none-match"] === file.etag) { send(res, 304, "", { etag: file.etag, "cache-control": "no-cache" }); return; }
    send(res, 200, req.method === "HEAD" ? "" : file.bytes, { "content-type": file.type, etag: file.etag, "cache-control": "no-cache" });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://admin.invalid");
    const reading = req.method === "GET" || req.method === "HEAD";
    if (url.pathname === "/_auth/callback" && reading) return finishLogin(url, req, res);
    if (url.pathname === "/_auth/logout") {
      send(res, 302, "", { location: "/admin/signed-out", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` });
      return;
    }
    if (url.pathname === "/") { send(res, 302, "", { location: "/admin" }); return; }
    if (url.pathname === "/admin/signed-out") { page(res, 200, "已退出", "你已退出 i豆 管理后台。", { href: "/admin", text: "重新登录" }); return; }
    const assetName = /^\/admin\/assets\/([a-z0-9-]+\.[a-z]+)$/.exec(url.pathname);
    if (assetName && reading) return asset(res, assetName[1], req);

    const visitor = open(key, cookies(req.headers.cookie)[COOKIE], now());
    if (url.pathname.startsWith("/admin/api/")) {
      if (!visitor) { json(res, 401, { error: "signed_out", message: "登录已过期，请刷新页面重新登录。" }); return; }
      const verdict = await roles.decide(visitor);
      if (!verdict.role) { json(res, 403, { error: "not_admin", message: roleRefusal(verdict.reason) }); return; }
      if (!allowed(visitor.userId)) { json(res, 429, { error: "too_many_requests", message: "操作太频繁，请稍后再试。" }); return; }
      if (!reading) {
        // Only from this page: the browser says where a request came from, and
        // only this page was given the token for this sign-in.
        const token = String(req.headers["x-idou-csrf"] ?? "");
        const expected = csrfToken(key, visitor.signInId);
        if (req.headers.origin !== origin || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
          json(res, 403, { error: "forbidden_origin", message: "这个请求不是从管理后台页面发出的。" }); return;
        }
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) { json(res, 415, { error: "json_required", message: "只接受 JSON。" }); return; }
      }
      let body = {};
      try { if (!reading) body = await readBody(req); }
      catch (error) { json(res, error.status ?? 400, { error: "bad_request", message: error.message }); return; }
      const admin = { userId: visitor.userId, tenantId: visitor.tenantId, name: visitor.name, role: verdict.role, source: verdict.source, scope: verdict.scope ?? null,
        csrf: csrfToken(key, visitor.signInId), address: String(req.socket?.remoteAddress ?? "").slice(0, 64) };
      return api.handle({ method: req.method, path: url.pathname, query: url.searchParams, body, admin, req, res, json: (status, value) => json(res, status, value), send });
    }
    if (/^\/admin(?:\/.*)?$/.test(url.pathname) && reading) {
      if (!visitor) return startLogin(res, "/admin");
      const verdict = await roles.decide(visitor);
      if (!verdict.role) { page(res, 403, "没有管理权限", roleRefusal(verdict.reason), { href: "/_auth/logout", text: "换个账号登录" }); return; }
      return asset(res, "index.html", req);
    }
    page(res, 404, "没有这个页面", "这里只有 i豆 管理后台。", { href: "/admin", text: "打开管理后台" });
  }

  const server = createServer((req, res) => {
    // Before anything: an address that may not connect learns nothing, not
    // even that there is a sign-in here. The socket's own address only.
    if (allowlist && !allowlist.allows(req.socket?.remoteAddress)) { page(res, 403, "无法访问", "这个部署只允许指定网段访问管理后台。"); return; }
    handle(req, res).catch((error) => {
      log({ component: "admin-console", event: "admin-error", message: String(error?.message ?? error).slice(0, 200) });
      if (!res.headersSent) json(res, 500, { error: "internal", message: "管理后台出错了，请稍后再试。" });
      else res.end();
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  return server;
}
