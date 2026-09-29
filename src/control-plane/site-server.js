// The listener other people reach: published sites, and nothing else.
//
// Every other route this control plane serves is loopback-only and answers a
// product session. This one is different by necessity -- a site nobody else can
// open is not a site -- so it is a separate listener, off unless an operator
// turns it on, bound to an address they choose, and it serves exactly three
// kinds of thing:
//
//   /s/<id>/…        the bytes of that site's current version, by manifest
//   /s/<id>/_data    the snapshot its page reads
//   /s/<id>/_events  a nudge when that snapshot changes
//   /demo/…          the templates themselves, with invented data in them
//
// And, from a listener of its own (role "admin"), /admin…: what this
// deployment is set to do, for its administrators. Not beside the sites: a
// published page is script its author wrote, and served from the console's
// origin it could read the console with an administrator's cookie the moment
// one opened it (security review of 2026-09-27). Its own origin, its own
// cookie under its own key; neither listener serves the other's routes.
//
// plus the sign-in it needs to know who is asking. It has no route that reads a
// table, runs a task, or touches anything else in this process: what it can
// serve is what somebody published, and who may see it is decided by
// site-access.js on every single request -- not at sign-in, not cached beyond a
// few seconds, because a permission taken away in Feishu has to take effect.
//
// The page itself runs in the visitor's browser under a policy that lets it
// fetch nothing from anywhere else. Cell contents are rendered as text by the
// runtime (table-contract.js); the containment that matters here is that a page
// which somehow did run something cannot send anything out.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REASONS, decideSiteAccess, refusalText } from "./site-access.js";
import { byteRange } from "../apps/byte-range.js";
import { SPELLINGS, WRITTEN } from "../product-names.js";

export const SITE_SERVER_LIMITS = Object.freeze({
  // A visitor's sign-in, not a product session: it says who they are, nothing more.
  sessionMs: 12 * 60 * 60 * 1000,
  // How long an answer from Feishu about this visitor and this table is reused.
  // Short on purpose: revoking in Feishu has to take effect, and a dashboard
  // open on a wall must not re-ask on every poll either.
  accessCacheMs: 30_000,
  accessCacheEntries: 5_000,
  streamsPerSite: 200,
  streamsTotal: 2_000,
  loginFlows: 500,
  loginFlowMs: 10 * 60 * 1000,
  // Visitors whose Feishu credential is held, for asking Feishu about them.
  credentials: 2_000,
});

const SITE_PATH = /^\/s\/([0-9a-f-]{36})(?:\/(.*))?$/;
// The demo gallery: what this can make, for somebody who has not got the
// application. Templates and invented rows, so it holds nothing of anybody's --
// but it is still behind the same sign-in as a tenant-wide site, because on a
// private deployment "anyone" means anyone in the organisation, and an
// unauthenticated route is a decision an operator makes (IDOU_SITES_ANONYMOUS),
// not one this file makes for them.
const DEMO_PATH = /^\/demo(?:\/([a-z]+)-([a-z]+))?(?:\/(.*))?$/;
// The console. Read-only in this release; see admin-console.js.
const ADMIN_PATH = /^\/admin(?:\/(state\.json))?$/;
// The visitor's sign-in, named with the product's name (product-names.js). One
// set before the rename, under the old spelling, is still read; signing out
// clears both.
const COOKIE = `${WRITTEN}_site`;
const visitorCookie = (header) => { const jar = cookies(header); return SPELLINGS.map((name) => jar[`${name}_site`]).find((value) => value !== undefined); };
const signedOut = SPELLINGS.map((name) => `${name}_site=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
// The console's sign-in: another name, and a key of its own made from the
// sites' one, so neither listener takes the other's cookie -- cookies do not
// tell ports apart, and a page could set one by name.
const ADMIN_COOKIE = "idou_admin";
const adminKey = (key) => createHmac("sha256", key).update("idou admin console cookie v1").digest();
const b64 = (value) => Buffer.from(value).toString("base64url");
const unb64 = (value) => Buffer.from(String(value), "base64url");

// The headers every response carries. A published page may load only what was
// published with it and may talk only to its own origin.
const POLICY = Object.freeze({
  "content-security-policy": [
    "default-src 'self'",
    // Pages here are written by the tenant's own people and published on
    // purpose; inline script is how most of them are written. What is locked
    // down is where anything can go, not how it was spelled.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
});

// With the shared database (docs/scaling-plan.md §2.5) there is one key for
// every coordinator, so a visitor signed in through one is still signed in
// through whichever serves them next. The first coordinator to start there
// brings the key it already had on disk, so the move signs nobody out.
export async function siteCookieKey(root, { state = null } = {}) {
  if (!state) return diskCookieKey(root);
  const held = await state.get("site-cookie", "key");
  if (held) return unb64(held.value.key);
  let key;
  try { key = unb64((await readFile(path.join(root, "cookie.key"), "utf8")).trim()); }
  catch (error) { if (error?.code !== "ENOENT") throw error; key = randomBytes(32); }
  // Two starting at once: whichever wrote first, both use.
  await state.create("site-cookie", "key", { key: b64(key) });
  return unb64((await state.get("site-cookie", "key")).value.key);
}

async function diskCookieKey(root) {
  const file = path.join(root, "cookie.key");
  try { return unb64((await readFile(file, "utf8")).trim()); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const key = randomBytes(32);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // `wx`: two processes starting at once must not each write a key, or every
    // visitor signed in under the loser's key is signed out without a word.
    try { await writeFile(file, b64(key), { mode: 0o600, flag: "wx" }); return key; }
    catch { return unb64((await readFile(file, "utf8")).trim()); }
  }
}

const sign = (key, value) => createHmac("sha256", key).update(value).digest("base64url");
function sealVisitor(key, visitor, expiresAt, handle = null) {
  const body = b64(JSON.stringify({ u: visitor.userId, t: visitor.tenantId, e: expiresAt, ...(handle ? { k: handle } : {}) }));
  return `${body}.${sign(key, body)}`;
}
function openVisitor(key, cookie, now) {
  if (typeof cookie !== "string" || cookie.length > 4096) return null;
  const [body, mac] = cookie.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(key, body)), given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const value = JSON.parse(unb64(body).toString("utf8"));
    if (!value?.u || !value?.t || !(value.e > now)) return null;
    return { userId: String(value.u), tenantId: String(value.t), handle: typeof value.k === "string" ? value.k : null };
  } catch { return null; }
}

const cookies = (header) => Object.fromEntries(String(header ?? "").split(";").map((part) => {
  const at = part.indexOf("=");
  return at < 0 ? [part.trim(), ""] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
}).filter(([name]) => name));

// A returnTo that can only ever be a path on this site: an open redirect on a
// sign-in is how a link that looks like ours sends somebody somewhere else.
function safeReturn(value) {
  const text = String(value ?? "");
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\") || text.length > 512) return "/";
  return text;
}

export function createSiteServer({ registry, oauth = null, origin, cookieKey: siteKey, anonymousAllowed = false,
  readsSource = null, memberships = null, demos = null, allowlist = null, console: adminConsole = null,
  role = "sites", audit = () => {}, now = Date.now } = {}) {
  if (!["sites", "admin"].includes(role)) throw new Error("站点服务只有 sites 和 admin 两种");
  if (!registry && role === "sites") throw new Error("站点服务需要已发布网站的登记");
  if (!siteKey || siteKey.length < 32) throw new Error("站点服务需要一把 cookie 签名密钥");
  if (role === "admin" && !adminConsole) throw new Error("管理台的监听要有管理台");
  if (role === "sites" && adminConsole) throw new Error("管理台要有自己的监听，不能和发布的网站同源");
  const cookieKey = role === "admin" ? adminKey(siteKey) : siteKey;
  const readCookie = role === "admin" ? (header) => cookies(header)[ADMIN_COOKIE] : visitorCookie;
  const cookieName = role === "admin" ? ADMIN_COOKIE : COOKIE;
  const signOut = role === "admin" ? [`${ADMIN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`] : signedOut;
  const flows = new Map();
  const streams = new Map();
  const decisions = new Map();
  // A visitor's own Feishu credential, kept here and nowhere else, so that
  // "may this person read that table" can be asked of Feishu as them rather
  // than guessed from a list this process keeps. Held in memory only: a
  // restart signs everybody out of the question, not out of the site.
  const credentials = new Map();
  let open = 0;

  const keep = (handle, credential) => {
    for (const [id, held] of credentials) if (held.expiresAt <= now()) credentials.delete(id);
    if (credentials.size >= SITE_SERVER_LIMITS.credentials) credentials.clear();
    credentials.set(handle, credential);
  };
  const credentialFor = (visitor) => {
    const held = visitor?.handle ? credentials.get(visitor.handle) : null;
    if (!held) return null;
    if (held.expiresAt <= now() || held.userId !== visitor.userId) { credentials.delete(visitor.handle); return null; }
    return held;
  };

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...POLICY, "cache-control": "no-store", ...headers });
    res.end(body);
  };
  const page = (res, status, message) => send(res, status, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>无法打开</title><style>body{margin:0;min-height:100vh;display:grid;place-content:center;gap:12px;text-align:center;padding:24px;`
    + `font:15px/1.7 system-ui,-apple-system,"PingFang SC",sans-serif;color:#1b1b1b;background:#f6f6f7}`
    + `@media(prefers-color-scheme:dark){body{color:#ededed;background:#121214}}p{margin:0;max-width:34em}</style>`
    + `<p>${escape(message)}</p>`, { "content-type": "text/html; charset=utf-8" });

  const remember = (key, allowed) => {
    if (decisions.size >= SITE_SERVER_LIMITS.accessCacheEntries) decisions.clear();
    decisions.set(key, { allowed, until: now() + SITE_SERVER_LIMITS.accessCacheMs });
  };

  // Asked of Feishu, as this visitor, about this site's table -- and reused for
  // a few seconds so that a page polling its data does not become a poll of
  // somebody else's Feishu.
  const sourceReader = (site, visitor) => async () => {
    if (typeof readsSource !== "function") return false;
    const key = `${site.id}:${visitor.userId}`;
    const cached = decisions.get(key);
    if (cached && cached.until > now()) return cached.allowed;
    let allowed = false;
    try { allowed = await readsSource({ site, visitor, credential: credentialFor(visitor) }) === true; }
    catch { allowed = false; }
    remember(key, allowed);
    return allowed;
  };

  async function decide(site, visitor) {
    const whole = visitor && typeof memberships === "function"
      ? { ...visitor, ...(await memberships(visitor).catch(() => ({}))) }
      : visitor;
    return decideSiteAccess({ ownerId: site.ownerId, tenantId: site.tenantId, share: site.share, sourced: Boolean(site.source) },
      whole, { anonymousAllowed, readsSource: sourceReader(site, whole ?? {}) });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://sites.invalid");
    if (req.method !== "GET" && req.method !== "HEAD") { send(res, 405, "", { allow: "GET, HEAD" }); return; }

    if (url.pathname === "/_auth/callback") return finishLogin(url, res);
    if (url.pathname === "/_auth/logout") {
      const going = openVisitor(cookieKey, readCookie(req.headers.cookie), now());
      if (going?.handle) credentials.delete(going.handle);
      send(res, 302, "", { location: safeReturn(url.searchParams.get("to")), "set-cookie": signOut });
      return;
    }
    const admin = ADMIN_PATH.exec(url.pathname);
    if (role === "admin") {
      if (admin) return serveAdmin(url, req, res, admin[1] === "state.json");
      if (url.pathname === "/") { send(res, 302, "", { location: "/admin" }); return; }
      page(res, 404, "这里只有管理台。"); return;
    }
    if (admin) { page(res, 404, "管理台不在这个地址。"); return; }
    const demo = DEMO_PATH.exec(url.pathname);
    if (demo) return serveDemo(url, req, res, demo);
    const matched = SITE_PATH.exec(url.pathname);
    if (!matched) { page(res, 404, "这个地址上没有网站。"); return; }
    const [, siteId, rest = ""] = matched;
    const site = registry.get(siteId);
    // A site that is not here, one taken offline, and one somebody may not see
    // answer the same way: whether a link exists is itself something to know.
    if (!site || site.offline) { page(res, 404, "这个网站不存在，或者已经被取消发布。"); return; }

    const visitor = openVisitor(cookieKey, visitorCookie(req.headers.cookie), now());
    const verdict = await decide(site, visitor);
    audit({ event: "site-access", siteId, allowed: verdict.allowed, reason: verdict.reason, anonymous: verdict.anonymous === true });
    if (!verdict.allowed) {
      if (verdict.reason === REASONS.noSession && oauth) return startLogin(url, res, siteId);
      page(res, verdict.reason === REASONS.noSession ? 401 : 403, refusalText(verdict.reason));
      return;
    }

    if (rest === "_data") {
      const data = await registry.data(siteId);
      send(res, 200, JSON.stringify(data ?? { schema: null, snapshot: null }), { "content-type": "application/json; charset=utf-8" });
      return;
    }
    if (rest === "_events") return stream(req, res, siteId);

    const file = await registry.file(siteId, rest).catch((error) => { audit({ event: "site-file-refused", siteId, message: error.message }); return null; });
    if (!file) { page(res, 404, "这个网站里没有这个文件。"); return; }
    const headers = { "content-type": file.contentType, etag: `"${file.version}"`, "accept-ranges": "bytes" };
    // A video is asked for in pieces (byte-range.js).
    const range = byteRange(req.headers.range, file.bytes.length);
    if (range === "unsatisfiable") { send(res, 416, "", { ...headers, "content-range": `bytes */${file.bytes.length}` }); return; }
    if (range) {
      const part = file.bytes.subarray(range.start, range.end + 1);
      send(res, 206, req.method === "HEAD" ? "" : part, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${file.bytes.length}`, "content-length": String(part.length) });
      return;
    }
    send(res, 200, req.method === "HEAD" ? "" : file.bytes, { ...headers, "content-length": String(file.bytes.length) });
  }

  // The console. Signed in like anyone here, and then asked again, on every
  // single request, whether this person is still an administrator -- the cookie
  // says who they are and nothing more. Being removed in Feishu has to take
  // effect without waiting for a cookie to expire.
  async function serveAdmin(url, req, res, asJson) {
    const visitor = openVisitor(cookieKey, readCookie(req.headers.cookie), now());
    if (!visitor) {
      // Identity only. The console reads this server, never the visitor's
      // Feishu, so asking them to grant anything would be asking for nothing.
      if (oauth) return startLogin(url, res, null, { scopes: [] });
      page(res, 401, "请先登录。");
      return;
    }
    const verdict = await adminConsole.decide(visitor);
    audit({ event: "admin-access", allowed: verdict.admin === true, reason: verdict.reason });
    if (!verdict.admin) { page(res, 403, adminConsole.refusal(verdict)); return; }
    const state = await adminConsole.state(visitor);
    if (asJson) { send(res, 200, req.method === "HEAD" ? "" : JSON.stringify(state), { "content-type": "application/json; charset=utf-8" }); return; }
    send(res, 200, req.method === "HEAD" ? "" : adminConsole.page(state, visitor), { "content-type": "text/html; charset=utf-8" });
  }

  // The gallery, and one demo. Nothing here belongs to anybody: the pages are
  // the templates this build ships and the rows are invented (site-sample.js).
  // It is still behind the same sign-in as a tenant-wide site -- an
  // unauthenticated route is the operator's decision, not this file's -- and it
  // never touches the registry, so a demo cannot be confused for a real site.
  async function serveDemo(url, req, res, [, scenario, style, rest = ""]) {
    if (!demos) { page(res, 404, "这个部署没有开启样例。"); return; }
    const visitor = openVisitor(cookieKey, visitorCookie(req.headers.cookie), now());
    if (!visitor && !anonymousAllowed) {
      // Identity and nothing else. A demo never asks Feishu anything about the
      // visitor, so asking them to grant this app their calendar and their
      // messages in order to look at an invented table would be both useless
      // and alarming.
      if (oauth) return startLogin(url, res, null, { scopes: [] });
      page(res, 401, refusalText(REASONS.noSession));
      return;
    }
    audit({ event: "site-demo", demo: scenario ? `${scenario}-${style}` : "index", anonymous: !visitor });
    if (!scenario) { send(res, 200, req.method === "HEAD" ? "" : await demos.index(), { "content-type": "text/html; charset=utf-8" }); return; }
    const file = await demos.file(scenario, style, rest).catch(() => null);
    if (!file) { page(res, 404, "没有这个样例。"); return; }
    send(res, 200, req.method === "HEAD" ? "" : file.bytes, { "content-type": file.contentType, "content-length": String(file.bytes.length) });
  }

  function startLogin(url, res, siteId, { scopes = undefined } = {}) {
    if (flows.size >= SITE_SERVER_LIMITS.loginFlows) for (const [id, flow] of flows) if (flow.until <= now()) flows.delete(id);
    const state = randomUUID(), verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    flows.set(state, { verifier, until: now() + SITE_SERVER_LIMITS.loginFlowMs, to: `${url.pathname}${url.search}`, siteId, scopes });
    const authorize = oauth.authorizationUrl({ redirectUri: `${origin}/_auth/callback`, state, challenge, ...(scopes ? { scopes } : {}) });
    send(res, 302, "", { location: authorize });
  }

  async function finishLogin(url, res) {
    const state = url.searchParams.get("state"), code = url.searchParams.get("code");
    const flow = state ? flows.get(state) : null;
    flows.delete(state);
    if (!flow || flow.until <= now() || !code) { page(res, 400, "这次登录已经过期，请重新打开链接。"); return; }
    let identity = null, credential = null;
    try {
      // A deployment that lets sites follow their table redeems the visitor's
      // own credential; one that does not only ever learns who they are.
      // A demo's login was asked for with no scopes at all, so it has no
      // credential to keep either: it only ever needed to know who this is.
      const redeemed = typeof oauth.redeemVisitor === "function" && !flow.scopes
        ? await oauth.redeemVisitor({ code, verifier: flow.verifier, redirectUri: `${origin}/_auth/callback` })
        : { identity: await oauth.probeIdentity({ code, verifier: flow.verifier, redirectUri: `${origin}/_auth/callback`,
          ...(flow.scopes ? { scopes: flow.scopes } : {}) }) };
      identity = redeemed?.identity ?? redeemed;
      credential = redeemed?.token ? { token: redeemed.token, expiresAt: redeemed.expiresAt ?? now() + SITE_SERVER_LIMITS.sessionMs } : null;
    } catch { identity = null; }
    if (!identity?.userId || !identity?.tenantId) { audit({ event: "site-login-failed", siteId: flow.siteId }); page(res, 403, "登录没有完成，请再试一次。"); return; }
    audit({ event: "site-login", siteId: flow.siteId, credentialHeld: Boolean(credential) });
    let handle = null;
    if (credential) { handle = randomUUID(); keep(handle, { ...credential, userId: identity.userId }); }
    const cookie = sealVisitor(cookieKey, identity, now() + SITE_SERVER_LIMITS.sessionMs, handle);
    const secure = origin.startsWith("https://") ? " Secure;" : "";
    send(res, 302, "", { location: safeReturn(flow.to),
      "set-cookie": `${cookieName}=${cookie}; Path=/;${secure} HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SITE_SERVER_LIMITS.sessionMs / 1000)}` });
  }

  function stream(req, res, siteId) {
    const here = streams.get(siteId) ?? new Set();
    if (open >= SITE_SERVER_LIMITS.streamsTotal || here.size >= SITE_SERVER_LIMITS.streamsPerSite) { send(res, 503, "too many listeners"); return; }
    res.writeHead(200, { ...POLICY, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(": open\n\n");
    here.add(res); streams.set(siteId, here); open += 1;
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
    keepAlive.unref?.();
    const close = () => { clearInterval(keepAlive); if (here.delete(res)) open -= 1; if (!here.size) streams.delete(siteId); };
    req.on("close", close); res.on("close", close);
  }

  const server = createServer((req, res) => {
    // Before the routes, before the cookie, before Feishu: an address that may
    // not connect does not learn what the page looks like, whether a site id
    // exists, or that there is a sign-in here at all.
    //
    // The socket's own address, never X-Forwarded-For -- a forwarded header is
    // a string the client writes, so trusting it is the same as having no list.
    if (allowlist && !allowlist.allows(req.socket?.remoteAddress)) {
      audit({ event: "site-address-refused", address: String(req.socket?.remoteAddress ?? "").slice(0, 64) });
      // Said out loud, not dropped: a silent drop sends an operator looking for
      // a network fault that is not there.
      page(res, 403, "这个部署只允许指定网段访问。");
      return;
    }
    handle(req, res).catch((error) => {
      audit({ event: "site-error", message: String(error?.message ?? error).slice(0, 200) });
      if (!res.headersSent) page(res, 500, "这个网站暂时打不开。");
      else res.end();
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  // Told by whoever refreshed the data, so every page already open redraws.
  server.notifySite = (siteId) => {
    for (const res of streams.get(siteId) ?? []) { try { res.write("event: changed\ndata: {}\n\n"); } catch { /* it will close itself */ } }
  };
  server.forgetSite = (siteId) => {
    for (const res of streams.get(siteId) ?? []) { try { res.end(); } catch { /* already gone */ } }
    streams.delete(siteId);
    for (const key of decisions.keys()) if (key.startsWith(`${siteId}:`)) decisions.delete(key);
  };
  server.handleRequest = handle;
  return server;
}

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
