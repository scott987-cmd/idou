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
// Each of the /s/ routes is reached through a capability (docs/sites-phase0.md
// §0.2): a visitor let in at /s/<id>/… is sent to /s/<id>/~<capability>/…,
// and everything the page then loads is under that path. The page itself runs
// sandboxed -- an origin of its own that is nobody's -- so it cannot read
// another site's page, window or answers; and since a sandboxed page's
// requests carry no cookie, what it loads is let in by the capability, which
// only that site's own address holds.
//
// The administration console is not here (admin-server.js): a published page
// is script its author wrote, and served from the console's origin it could
// read the console with an administrator's cookie the moment one opened it
// (security review of 2026-09-27). Its own origin, its own cookie under its own
// key; this listener answers /admin with a 404.
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
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { gunzip, gzip as gzipped } from "node:zlib";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REASONS, decideSiteAccess, refusalText } from "./site-access.js";
import { byteRange } from "../apps/byte-range.js";
import { visitSource } from "./site-visitors.js";
import { TABLE_RUNTIME } from "../application/table-contract.js";
import { SPELLINGS, WRITTEN } from "../product-names.js";

export const SITE_SERVER_LIMITS = Object.freeze({
  // A visitor's sign-in, not a product session: it says who they are, nothing more.
  sessionMs: 12 * 60 * 60 * 1000,
  // How long an answer from Feishu about this visitor and this table is reused.
  // Short on purpose: revoking in Feishu has to take effect, and a dashboard
  // open on a wall must not re-ask on every poll either.
  accessCacheMs: 30_000,
  // No answer from Feishu (a timeout, a refusal it gave no reason for): asked
  // again after this, not by every file of the same page.
  unavailableCacheMs: 8_000,
  accessCacheEntries: 5_000,
  streamsPerSite: 200,
  streamsTotal: 2_000,
  loginFlows: 500,
  loginFlowMs: 10 * 60 * 1000,
  // Visitors whose Feishu credential is held, for asking Feishu about them.
  credentials: 2_000,
});

const SITE_PATH = /^\/s\/([0-9a-f-]{36})(?:\/(.*))?$/;
// A site by its address name (docs/sites-phase1.md §1.6), percent-encoded as browsers send it.
const ADDRESS_PATH = /^\/s\/([^/~]+)(?:\/(.*))?$/;
const decoded = (value) => { try { return decodeURIComponent(value); } catch { return ""; } };
// The data file a table site's page loads (table-contract.js CONTRACT_FILES).
const LIVE_DATA_FILE = "data/table-data.js";
// The demo gallery: what this can make, for somebody who has not got the
// application. Templates and invented rows, so it holds nothing of anybody's --
// but it is still behind the same sign-in as a tenant-wide site, because on a
// private deployment "anyone" means anyone in the organisation, and an
// unauthenticated route is a decision an operator makes (IDOU_SITES_ANONYMOUS),
// not one this file makes for them.
const DEMO_PATH = /^\/demo(?:\/([a-z]+)-([a-z]+))?(?:\/(.*))?$/;
// The console's paths, refused here: it has a listener of its own.
const ADMIN_PATH = /^\/admin(?:\/.*)?$/;
// The visitor's sign-in, named with the product's name (product-names.js). One
// set before the rename, under the old spelling, is still read; signing out
// clears both.
const COOKIE = `${WRITTEN}_site`;
const visitorCookie = (header) => { const jar = cookies(header); return SPELLINGS.map((name) => jar[`${name}_site`]).find((value) => value !== undefined); };
const signedOut = SPELLINGS.map((name) => `${name}_site=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
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
// A published page, as a document: sandboxed, so it is an origin of its own --
// not this server's -- and reads nothing of any other site or window. What it
// may still do is what pages do: run its script, open a link in a new tab,
// show a dialog, offer a download.
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
// What a sandboxed page loads comes from an origin that is not its own (it has
// none), so these are let through to it: the capability in the path is what
// decides, not where the request came from.
// And everything served under a capability is sandboxed, not only HTML: an SVG
// is a document too, and opened on its own -- or by a page's window.open,
// which escapes the sandbox as popups may -- it ran as this server with the
// visitor's sign-in and read another site outright (review of phase 0,
// 2026-10-03). For a script, an image or data the policy does nothing.
const UNDER_CAPABILITY = Object.freeze({ "cross-origin-resource-policy": "cross-origin", "content-security-policy": `${POLICY["content-security-policy"]}; ${SANDBOX}` });
// Credentials allowed too: the table runtime every published site carries
// listens with `withCredentials` (table-contract.js), and a site already out
// there keeps its copy. No cookie reaches a sandboxed page's requests anyway;
// the capability is what lets them in.
const FOR_SANDBOX = Object.freeze({ ...UNDER_CAPABILITY, "access-control-allow-origin": "null", "access-control-allow-credentials": "true" });
// A capability lasts as long as the sign-in it was made from, at most this.
const CAPABILITY_MS = 12 * 60 * 60 * 1000;
// ...and ends on one of these boundaries, so that the same visitor opening the
// same site again is given the same one: a page's every address has the
// capability in it, and a new one each time was a new address each time -- the
// browser's cache never answered, and a table site of 20,000 rows sent its
// 737 KB again on every visit (measured on a real Base, 2026-10-06).
const CAPABILITY_STEP = 6 * 60 * 60 * 1000;
export const capabilityUntil = (now, signedInUntil = Infinity) =>
  Math.min(Math.floor((now + CAPABILITY_MS) / CAPABILITY_STEP) * CAPABILITY_STEP, signedInUntil);
const CAPABILITY_PATH = /^~([A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{20,128})(?:\/(.*))?$/;
// Whether this is somebody opening a page, rather than a page fetching
// something. What a sandboxed page fetches carries no cookie and goes by the
// capability alone -- but only when the browser says that is what it is
// (Fetch Metadata). A request that says nothing -- curl, a chat's link preview
// fetching a pasted address -- is somebody opening the page, and needs the
// sign-in the capability was made for: before this, an address copied out of
// a visitor's address bar served their pages and data to anyone for twelve
// hours that way (review of phase 0, 2026-10-03).
// A table site's data as its page loads it: the stored JSON, as it is, inside a
// wrapper that names where to ask again and where to listen from the address
// the script itself was loaded from. The same bytes for every visitor, so they
// are wrapped and compressed once per change -- not parsed and written out
// again for each one: thousands of rows were 4 MB, uncompressed, rebuilt per
// request and never cached (found 2026-10-04, a 5000-row site).
const LIVE_PREFIX = Buffer.from("(function (d) { var s = (typeof document !== \"undefined\" && document.currentScript && document.currentScript.src) || \"\";"
  + " var b = s.lastIndexOf(\"/data/\") >= 0 ? s.slice(0, s.lastIndexOf(\"/data/\") + 1) : \"\";"
  + " var schema = {}, key; for (key in d.schema || {}) schema[key] = d.schema[key];"
  + " schema.endpoint = b + \"_data\"; schema.stream = b + \"_events\"; d.schema = schema;"
  + " globalThis.__IDOU_TABLE__ = globalThis.__MYDOUBAO_TABLE__ = d; })(");
const LIVE_SUFFIX = Buffer.from(");\n");
// And the runtime that reads it: this build's, not the copy frozen into the
// version, so a table site published before a fix to it gets the fix -- the
// runtime is the product's code, never the author's, and keeps its API.
const LIVE_RUNTIME_FILE = "data/table.js";
const RUNTIME = Buffer.from(TABLE_RUNTIME);
const RUNTIME_TAG = `r-${createHash("sha1").update(RUNTIME).digest("base64url")}`;
// What is worth compressing: text, above a size where it pays.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript)|image\/svg\+xml)/;
const COMPRESS_FROM = 1024;
const compress = promisify(gzipped);
const inflate = promisify(gunzip);
// Past this a body is kept compressed only. 20,000 rows of a table are 18 MB
// plain and under one compressed: held both ways, three such sites filled the
// whole cache. The rare client that takes no gzip has them inflated for it.
const PLAIN_KEPT = 1024 * 1024;
const packBody = async (body, compressible = true) => {
  const gz = compressible && body.length >= COMPRESS_FROM ? await compress(body) : null;
  if (!gz || gz.length >= body.length) return { body, gz: null, length: body.length };
  return { body: body.length > PLAIN_KEPT ? null : body, gz, length: body.length };
};
// No answer from Feishu, said as such (503), never as a refusal.
const UNANSWERED = new Set([REASONS.sourceUnavailable, REASONS.membersUnavailable]);
const SUBRESOURCES = new Set(["script", "style", "image", "font", "audio", "video", "track", "empty", "manifest", "worker"]);
const isNavigation = (req) => req.headers["sec-fetch-mode"] === "navigate" || !SUBRESOURCES.has(String(req.headers["sec-fetch-dest"] ?? ""));

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
function sealVisitor(key, visitor, expiresAt, handle = null, issuedAt = Date.now()) {
  const body = b64(JSON.stringify({ u: visitor.userId, t: visitor.tenantId, e: expiresAt, i: issuedAt, ...(handle ? { k: handle } : {}) }));
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
    return { userId: String(value.u), tenantId: String(value.t), handle: typeof value.k === "string" ? value.k : null, expiresAt: Number(value.e),
      issuedAt: Number.isFinite(value.i) ? value.i : 0 };
  } catch { return null; }
}

// A capability: this site, this visitor (or nobody, for a site open to the
// internet), until when. Signed under a key of its own, so a cookie can never
// pass for one or the other way round.
// Sealed as well as signed: it sits in the page's own address, where the
// page's script reads it, and a signed body showed every site the open_id,
// tenant and credential handle of whoever opened it (review of phase 0,
// 2026-10-03). Bound to its site as it is sealed.
const sealingKey = (key) => createHmac("sha256", key).update("capability seal").digest();
// The nonce is drawn from what is sealed, under a key of its own: the same
// visitor, site and end seal to the same capability (see CAPABILITY_STEP), and
// two different ones share a nonce with the odds of a 96-bit collision.
const nonceKey = (key) => createHmac("sha256", key).update("capability nonce").digest();
function sealCapability(key, siteId, visitor, expiresAt) {
  const sealedValue = JSON.stringify({ s: siteId, u: visitor?.userId ?? "", t: visitor?.tenantId ?? "", k: visitor?.handle ?? null, i: visitor?.issuedAt ?? 0, e: expiresAt });
  const iv = createHmac("sha256", nonceKey(key)).update(`${siteId}\n${sealedValue}`).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(key), iv);
  cipher.setAAD(Buffer.from(`capability\n${siteId}`));
  const sealed = Buffer.concat([cipher.update(sealedValue), cipher.final()]);
  const body = b64(Buffer.concat([iv, sealed, cipher.getAuthTag()]));
  return `${body}.${sign(key, `capability\n${body}`)}`;
}
function openCapability(key, capability, siteId, now) {
  const [body, mac] = String(capability).split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(key, `capability\n${body}`)), given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const raw = unb64(body);
    if (raw.length < 12 + 16 + 2) return null;
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(key), raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`capability\n${siteId}`));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const value = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8"));
    if (value?.s !== siteId || !(value.e > now)) return null;
    return value.u ? { userId: String(value.u), tenantId: String(value.t), handle: typeof value.k === "string" ? value.k : null, expiresAt: Number(value.e), issuedAt: Number(value.i) || 0 }
      : { anonymous: true, expiresAt: Number(value.e) };
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

// Credentials held in this process: bounded, and dropped as they run out.
function memoryCredentials(now) {
  const held = new Map();
  return {
    async get(handle) { return held.get(handle) ?? null; },
    async put(handle, credential) {
      for (const [id, value] of held) if (value.expiresAt <= now()) held.delete(id);
      if (held.size >= SITE_SERVER_LIMITS.credentials) held.clear();
      held.set(handle, credential);
    },
    async delete(handle) { held.delete(handle); },
  };
}

export function createSiteServer({ registry, oauth = null, origin, cookieKey: siteKey, anonymousAllowed = false,
  readsSource = null, memberships = null, demos = null, allowlist = null, console: adminConsole = null, onView = null,
  // Where visitors' Feishu credentials are held: { get, put, delete } by
  // handle, sealed and shared between replicas where there is a shared
  // database (bin/server.js); in this process otherwise.
  credentialStore = null,
  access = null, audit = () => {}, now = Date.now } = {}) {
  if (!registry) throw new Error("站点服务需要已发布网站的登记");
  if (!siteKey || siteKey.length < 32) throw new Error("站点服务需要一把 cookie 签名密钥");
  if (adminConsole) throw new Error("管理台要有自己的监听，不能和发布的网站同源");
  const cookieKey = siteKey;
  const capabilityKey = createHmac("sha256", siteKey).update("idou site capability").digest();
  const readCookie = visitorCookie;
  const cookieName = COOKIE;
  const signOut = signedOut;
  const flows = new Map();
  const streams = new Map();
  const decisions = new Map();
  // A visitor's own Feishu credential, kept so that "may this person read
  // that table" can be asked of Feishu as them rather than guessed from a list
  // this process keeps. Without one -- never held, run out, lost to a restart
  // of a process that held it in memory -- the visitor is asked to sign in
  // again (docs/sites-phase0.md §0.3), not told they have no permission.
  const credentials = credentialStore ?? memoryCredentials(now);
  const canHoldCredentials = typeof oauth?.redeemVisitor === "function";
  let open = 0;

  const keep = (handle, credential) => credentials.put(handle, credential).catch(() => {});
  const credentialFor = async (visitor) => {
    if (!visitor?.handle) return null;
    const held = await credentials.get(visitor.handle).catch(() => null);
    if (!held) return null;
    if (held.expiresAt <= now() || held.userId !== visitor.userId) { await credentials.delete(visitor.handle).catch(() => {}); return null; }
    return held;
  };

  // Compressed bodies, by what they are made of: a site's data at one moment,
  // or one file of one version. Bounded; the oldest go first.
  const packed = new Map();
  let packedBytes = 0;
  const PACKED_MAX = 96 * 1024 * 1024;
  const pack = (key, build) => {
    const held = packed.get(key);
    if (held) { packed.delete(key); packed.set(key, held); return held.ready; }
    const entry = { size: 0, ready: build().then((value) => { entry.size = (value.gz?.length ?? 0) + (value.body?.length ?? 0); packedBytes += entry.size;
      for (const [old, other] of packed) { if (packedBytes <= PACKED_MAX || old === key) break; packed.delete(old); packedBytes -= other.size; }
      return value; }) };
    entry.ready.catch(() => packed.delete(key));
    packed.set(key, entry);
    return entry.ready;
  };
  const accepts = (req, coding) => String(req.headers["accept-encoding"] ?? "").split(",").some((part) => part.trim().split(";")[0] === coding);
  // A body with its tag: 304 when the browser has it, compressed when it can take it.
  const deliver = async (req, res, { body, gz, length, tag }, headers) => {
    const etag = `"${tag}"`;
    const common = { ...headers, etag, vary: "accept-encoding", "cache-control": "private, no-cache" };
    if (String(req.headers["if-none-match"] ?? "").split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag)) { send(res, 304, "", common); return; }
    const zipped = Boolean(gz) && accepts(req, "gzip");
    const size = zipped ? gz.length : length;
    const sent = req.method === "HEAD" ? "" : zipped ? gz : body ?? await inflate(gz);
    send(res, 200, sent, { ...common, ...(zipped ? { "content-encoding": "gzip" } : {}), "content-length": String(size) });
  };
  // A site's data, compressed once per write and found again by that write's
  // stamp: a visitor's request asks the registry when the data was written,
  // not for the data. `wrap` makes the body served from what is stored; null
  // when there is nothing to serve from it.
  const packedData = async (kind, siteId, wrap) => {
    const stamp = await registry.dataStamp(siteId);
    if (stamp === null) return null;
    const ready = await pack(`${kind}\n${siteId}\n${stamp}`, async () => {
      const raw = await registry.dataBytes(siteId);
      const body = raw ? wrap(raw) : null;
      if (!body) return { body: null, gz: null, length: 0, tag: "" };
      return { ...await packBody(body), tag: `${kind[0]}-${createHash("sha1").update(raw).digest("base64url")}` };
    });
    return ready.length ? ready : null;
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

  const remember = (key, allowed, ms = SITE_SERVER_LIMITS.accessCacheMs) => {
    if (decisions.size >= SITE_SERVER_LIMITS.accessCacheEntries) decisions.clear();
    decisions.set(key, { allowed, until: now() + ms });
  };

  // Asked of Feishu, as this visitor, about this site's table -- and reused for
  // a few seconds so that a page polling its data does not become a poll of
  // somebody else's Feishu.
  const sourceReader = (site, visitor) => async () => {
    if (typeof readsSource !== "function") return false;
    const key = `${site.id}:${visitor.userId}`;
    const cached = decisions.get(key);
    if (cached && cached.until > now()) return cached.allowed;
    const credential = await credentialFor(visitor);
    if (!credential && canHoldCredentials) {
      // Asked to sign in again -- unless they just did and still came back
      // with none, which a second sign-in would not change.
      const justSignedIn = visitor.issuedAt && now() - visitor.issuedAt < 60_000;
      return justSignedIn ? "unavailable" : "relogin";
    }
    let answer;
    try { answer = await readsSource({ site, visitor, credential }); } catch { answer = "unavailable"; }
    if (answer === "relogin") {
      await credentials.delete(visitor.handle).catch(() => {});
      // Refused a credential just made: another sign-in makes another just
      // like it, and the browser went round Feishu until it gave up on too
      // many redirects (review of phase 0, 2026-10-03).
      if (visitor.issuedAt && now() - visitor.issuedAt < 60_000) answer = "unavailable";
    }
    if (answer === true || answer === false) remember(key, answer);
    // No answer is not a no: asked again soon -- but not by every file the page
    // loads, each waiting out Feishu's timeout (review of phase 0).
    else if (answer !== "relogin") remember(key, "unavailable", SITE_SERVER_LIMITS.unavailableCacheMs);
    return answer === true || answer === false || answer === "relogin" ? answer : "unavailable";
  };

  // Which groups and departments a visitor is in, asked of Feishu once and
  // reused as briefly as an access answer: a page and everything it loads is
  // one question, not one per file.
  // `chats`: the groups this site was shared with -- only those are asked about.
  const groupsHeld = new Map();
  const membershipsOf = async (visitor, chats, departments) => {
    const key = `${visitor.tenantId}:${visitor.userId}:${departments ? "d" : ""}:${[...chats].sort().join(",")}`;
    const held = groupsHeld.get(key);
    if (held && held.until > now()) return held.value;
    const value = await memberships(visitor, chats, { departments }).catch(() => null);
    // Only what was read is reused; a read that failed is asked again next time.
    if (value && value.unknown !== true) {
      if (groupsHeld.size >= SITE_SERVER_LIMITS.accessCacheEntries) groupsHeld.clear();
      groupsHeld.set(key, { value, until: now() + SITE_SERVER_LIMITS.accessCacheMs });
    }
    return { chats: value?.chats ?? [], departments: value?.departments ?? [], membershipUnknown: !value || value.unknown === true };
  };

  async function decide(site, visitor) {
    // A person an administrator disabled is turned away from every site,
    // whatever it was shared with: disabled means not using this deployment.
    if (visitor && access?.isDisabled(visitor.tenantId, visitor.userId)) return { allowed: false, reason: REASONS.disabled };
    const named = site.share.members ?? [];
    const asks = named.some((member) => member.type !== "user");
    const whole = visitor && asks && typeof memberships === "function"
      ? { ...visitor, ...(await membershipsOf(visitor, named.filter((member) => member.type === "chat").map((member) => member.id), named.some((member) => member.type === "department"))) } : visitor;
    return decideSiteAccess({ ownerId: site.ownerId, tenantId: site.tenantId, share: site.share, sourced: Boolean(site.source) },
      whole, { anonymousAllowed, readsSource: sourceReader(site, whole ?? {}) });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://sites.invalid");
    if (req.method !== "GET" && req.method !== "HEAD") { send(res, 405, "", { allow: "GET, HEAD" }); return; }

    if (url.pathname === "/_auth/callback") return finishLogin(url, res);
    if (url.pathname === "/_auth/logout") {
      const going = openVisitor(cookieKey, readCookie(req.headers.cookie), now());
      if (going?.handle) await credentials.delete(going.handle).catch(() => {});
      send(res, 302, "", { location: safeReturn(url.searchParams.get("to")), "set-cookie": signOut });
      return;
    }
    if (ADMIN_PATH.test(url.pathname)) { page(res, 404, "管理台不在这个地址。"); return; }
    const demo = DEMO_PATH.exec(url.pathname);
    if (demo) return serveDemo(url, req, res, demo);
    const matched = SITE_PATH.exec(url.pathname);
    if (!matched) {
      // An address name leads on to the site's id, where signing in and the
      // capability go as they always do; a name it had leads there too.
      const named = ADDRESS_PATH.exec(url.pathname);
      const target = named ? registry.byAddress(decoded(named[1])) : null;
      if (target && !target.offline) { send(res, 302, "", { location: `/s/${target.id}/${named[2] ?? ""}${url.search}` }); return; }
      // No such name and a site taken down read the same: whether a name is in use is itself something to know.
      page(res, 404, "这个网站不存在，或者已经被取消发布。");
      return;
    }
    const [, siteId, rest = ""] = matched;
    const site = registry.get(siteId);
    // A site that is not here, one taken offline, and one somebody may not see
    // answer the same way: whether a link exists is itself something to know.
    if (!site || site.offline) { page(res, 404, "这个网站不存在，或者已经被取消发布。"); return; }

    const navigation = isNavigation(req);
    const signedIn = openVisitor(cookieKey, visitorCookie(req.headers.cookie), now());
    const held = CAPABILITY_PATH.exec(rest);
    const clean = (inner) => `/s/${siteId}/${inner}${url.search}`;
    if (!held) {
      // The way in: the sign-in decides, as it always has, and a visitor let in
      // is sent on under a capability for this site.
      const verdict = await decide(site, signedIn);
      // Counted here only when turned away; let in, the page is counted when
      // it is served, under the capability -- counted here as well, every
      // opening was two (review of phase 1, 2026-10-04).
      audit({ event: "site-access", siteId, allowed: verdict.allowed, reason: verdict.reason, anonymous: verdict.anonymous === true, ...(verdict.allowed ? {} : { counted: "refused" }) });
      if (!verdict.allowed) {
        if ((verdict.reason === REASONS.noSession || verdict.reason === REASONS.signInAgain) && oauth) return startLogin(url, res, siteId);
        page(res, verdict.reason === REASONS.noSession || verdict.reason === REASONS.signInAgain ? 401 : UNANSWERED.has(verdict.reason) ? 503 : 403, refusalText(verdict.reason));
        return;
      }
      const until = capabilityUntil(now(), signedIn?.expiresAt ?? Infinity);
      const capability = sealCapability(capabilityKey, siteId, verdict.anonymous ? null : signedIn, until);
      send(res, 302, "", { location: `/s/${siteId}/~${capability}/${rest}${url.search}` });
      return;
    }
    const [, capability, inner = ""] = held;
    const holder = openCapability(capabilityKey, capability, siteId, now());
    // Opened as a page, the capability has to be this browser's own: one copied
    // out of somebody's address bar sends whoever opens it the normal way in.
    const own = holder && (holder.anonymous || (signedIn && signedIn.userId === holder.userId && signedIn.tenantId === holder.tenantId));
    if (!holder || (navigation && !own)) {
      if (navigation) { send(res, 302, "", { location: clean(inner) }); return; }
      page(res, 401, refusalText(REASONS.noSession));
      return;
    }
    const visitor = holder.anonymous ? null : holder;
    const verdict = await decide(site, visitor);
    if (navigation || !verdict.allowed) audit({ event: "site-access", siteId, allowed: verdict.allowed, reason: verdict.reason, anonymous: verdict.anonymous === true, ...(navigation && verdict.allowed ? { counted: "visit" } : {}) });
    // A page opened, for its publisher's numbers (site-visitors.js): who only
    // as the server's digest of them, and where it was opened from.
    if (navigation && verdict.allowed && typeof onView === "function") {
      void Promise.resolve().then(() => onView({ site, visitor: visitor ? { tenantId: visitor.tenantId, userId: visitor.userId } : null,
        source: visitSource({ userAgent: req.headers["user-agent"], from: url.searchParams.get("from") ?? "" }) })).catch(() => {});
    }
    if (!verdict.allowed) {
      // Shared differently since, or the person was disabled: a page goes back
      // through the way in, which says why; what it fetches is simply refused.
      if (navigation) { send(res, 302, "", { location: clean(inner) }); return; }
      page(res, verdict.reason === REASONS.signInAgain ? 401 : UNANSWERED.has(verdict.reason) ? 503 : 403, refusalText(verdict.reason));
      return;
    }

    if (inner === "_data") {
      const ready = await packedData("data", siteId, (raw) => raw);
      if (!ready) { send(res, 200, JSON.stringify({ schema: null, snapshot: null }), { ...FOR_SANDBOX, "content-type": "application/json; charset=utf-8" }); return; }
      await deliver(req, res, ready, { ...FOR_SANDBOX, "content-type": "application/json; charset=utf-8" });
      return;
    }
    if (inner === "_events") return stream(req, res, siteId);
    // A site built on a table: its data file is the latest the server holds,
    // told where to ask again and where to listen (docs/sites-phase0.md §0.1)
    // -- not the snapshot frozen into the version when it was published.
    if (inner === LIVE_DATA_FILE && site.source) {
      // Looked into once per write: data with no snapshot leaves the version's
      // own file. Under both names, as contractFiles writes it: a page written
      // before the rename may read __MYDOUBAO_TABLE__ itself.
      const ready = await packedData("live", siteId, (raw) => JSON.parse(raw.toString("utf8"))?.snapshot ? Buffer.concat([LIVE_PREFIX, raw, LIVE_SUFFIX]) : null);
      if (ready) { await deliver(req, res, ready, { ...UNDER_CAPABILITY, "content-type": "text/javascript; charset=utf-8" }); return; }
    }

    if (inner === LIVE_RUNTIME_FILE && site.source) {
      const ready = await pack(`runtime\n${RUNTIME_TAG}`, async () => ({ ...await packBody(RUNTIME), tag: RUNTIME_TAG }));
      await deliver(req, res, ready, { ...UNDER_CAPABILITY, "content-type": "text/javascript; charset=utf-8" });
      return;
    }
    const file = await registry.file(siteId, inner).catch((error) => { audit({ event: "site-file-refused", siteId, message: error.message }); return null; });
    if (!file) { page(res, 404, "这个网站里没有这个文件。"); return; }
    const headers = { "content-type": file.contentType, etag: `"${file.version}"`, "accept-ranges": "bytes", ...UNDER_CAPABILITY };
    // A whole file, not a piece of one: its version is its tag, and text is sent compressed.
    if (!req.headers.range) {
      const ready = await pack(`file\n${siteId}\n${file.version}\n${file.path}`, async () => ({ ...await packBody(file.bytes, COMPRESSIBLE.test(file.contentType)),
        tag: `${file.version.slice(0, 16)}-${createHash("sha1").update(file.path).digest("base64url").slice(0, 10)}` }));
      await deliver(req, res, ready, { "content-type": file.contentType, "accept-ranges": "bytes", ...UNDER_CAPABILITY });
      return;
    }
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
    if (credential) { handle = randomUUID(); await keep(handle, { ...credential, userId: identity.userId }); }
    const cookie = sealVisitor(cookieKey, identity, now() + SITE_SERVER_LIMITS.sessionMs, handle, now());
    const secure = origin.startsWith("https://") ? " Secure;" : "";
    send(res, 302, "", { location: safeReturn(flow.to),
      "set-cookie": `${cookieName}=${cookie}; Path=/;${secure} HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SITE_SERVER_LIMITS.sessionMs / 1000)}` });
  }

  function stream(req, res, siteId) {
    const here = streams.get(siteId) ?? new Set();
    if (open >= SITE_SERVER_LIMITS.streamsTotal || here.size >= SITE_SERVER_LIMITS.streamsPerSite) { send(res, 503, "too many listeners"); return; }
    res.writeHead(200, { ...POLICY, ...FOR_SANDBOX, "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
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
