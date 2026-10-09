// Publishing, sharing and taking down a site: the loopback side, answered to a
// product session, so only the application this person is signed into can ask.
//
// The listener other people reach (site-server.js) serves; this decides what
// there is to serve. They are separate on purpose: one of them is reachable
// from outside and has no route that can change anything.
import { randomUUID } from "node:crypto";
import { REASONS, parseShare } from "./site-access.js";
import { APP_LIMITS, appManifest } from "../apps/manifest.js";
import { audienceOf } from "./site-safety.js";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { SITE_LIMITS, stampOf, SiteConflict, SiteRefused } from "./site-registry.js";

// A version travels as base64 inside one JSON body, a third larger than its
// files. At 12 MiB the 10 MiB a version may hold could never arrive: anything
// past about 8.8 MiB was refused as 版本包太大 -- more reachable once a site
// may carry a video. Room for the full version, its manifest and its names.
const MAX_BODY_BYTES = Math.ceil(APP_LIMITS.totalBytes * 4 / 3) + 1024 * 1024;
// A publish carries the table's data too, and a refresh only that: up to 32 MB
// of it since docs/sites-phase1.md §1.7. Every other route stays as it was.
// Counted as it arrives and again once inflated, so a small compressed body
// cannot become a large one here.
const BODY_BYTES = Object.freeze({ publish: MAX_BODY_BYTES + SITE_LIMITS.dataBytes, data: SITE_LIMITS.dataBytes + 1024 * 1024 });
const inflate = promisify(gunzip);

class SiteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class SiteService {
  #sessions; #registry; #anonymousAllowed; #origin; #notify; #audit; #allowDevelopment; #policy; #safety; #access; #departments; #groups; #features; #visitors;
  // `policy` (policy.js): whether the administrators let this person publish,
  // and open a site to anyone with the link.
  // `safety` (site-safety.js): what is checked before anything is shown --
  // every version, every change of audience, every new set of data.
  // `access` (access-list.js): asked again when a change that waited on a
  // check is written -- a person offboarded meanwhile publishes nothing.
  // `departments` (org-directory.js): the departments of the organisation, to
  // pick from when sharing with one. `groups` (model-visibility.js
  // chatMembership): a group's members, as the application's bot reads them --
  // a group it cannot read is a group nobody can be let in through.
  constructor({ sessions, registry, origin, anonymousAllowed = false, notify = () => {}, audit = () => {}, allowDevelopment = false, policy = null, safety = null, access = null,
    departments = null, groups = null, visitors = null }) {
    this.#sessions = sessions; this.#registry = registry; this.#origin = origin;
    this.#anonymousAllowed = anonymousAllowed === true; this.#notify = notify; this.#audit = audit; this.#policy = policy;
    this.#allowDevelopment = allowDevelopment === true; this.#safety = safety; this.#access = access;
    this.#departments = departments; this.#groups = groups; this.#visitors = visitors;
    // What this server can do beyond publishing, for a desktop to offer only
    // that: a newer desktop on an older server offered sharing with groups the
    // server never let anybody in through (review of phase 0, 2026-10-03).
    // `compressed-requests`: a body may come gzipped (a table's data is text
    // that comes down to a twentieth) -- an older server refuses one as not JSON.
    this.#features = Object.freeze(["versions", "addresses", "compressed-requests", ...(visitors ? ["stats"] : []), ...(groups ? ["groups"] : []), ...(departments ? ["departments"] : [])]);
  }

  // Every group a site is shared with has to be one the bot can read, or the
  // people in it would never get in -- said before anything is written.
  // Read only once the share is well formed -- ids that are ids, at most 200 --
  // so a request cannot make the bot try, and the server remember, anything
  // else (review of phase 0, 2026-10-03).
  async #groupsReadable(share) {
    let parsed;
    try { parsed = parseShare(share, { anonymousAllowed: true }); } catch (error) { throw new SiteError(400, error.message); }
    const chats = parsed.members.filter((member) => member.type === "chat");
    if (!chats.length) return;
    if (!this.#groups) throw new SiteError(400, "这个部署读不了飞书群的成员，不能按群邀请；可以按人邀请。");
    for (const chat of chats) {
      try { await this.#groups.members(String(chat.id)); }
      catch { throw new SiteError(400, `i豆 的应用机器人不在群「${chat.name || "这个群"}」里，读不到群成员：先把机器人拉进群，才能按群邀请。`); }
    }
  }

  // Still allowed to put something up, asked when it is written.
  #allowed(who) { return () => !this.#access?.isDisabled(who.tenantId, who.userId); }

  // One check, and what it means for this request: refused outright (422,
  // with the reason the person reads), waiting for an administrator
  // ({ checkId, reason }, for the registry to write with the site), or
  // nothing in the way (null).
  async #checked(who, { site, audience, files = [], data = null, trigger, version = "", dataDigest = "" }) {
    if (!this.#safety) return null;
    const check = await this.#safety.assess({ tenantId: who.tenantId, site, audience, files, data, trigger, version, dataDigest,
      approved: site.id ? this.#registry.get(site.id)?.review?.approved ?? null : null });
    if (check.outcome === "block") {
      this.#audit({ event: "site-refused", siteId: site.id, trigger, outcome: "block" }, { who, name: site.name ?? "" });
      throw new SiteError(422, check.reason);
    }
    if (check.outcome !== "review") return null;
    this.#audit({ event: "site-review", siteId: site.id, trigger, outcome: "review" }, { who, name: site.name ?? "" });
    return { checkId: check.id, reason: check.reason };
  }

  get anonymousAllowed() { return this.#anonymousAllowed; }
  // A site's link: by its address name when it has one (docs/sites-phase1.md
  // §1.6), by its id otherwise. Either leads to the same place.
  link(site) {
    const named = typeof site === "object" && site?.address ? encodeURIComponent(site.address) : null;
    return `${this.#origin}/s/${named ?? (typeof site === "object" ? site.id : site)}/`;
  }

  async handle(req, res) {
    const route = {
      "/v1/sites/list": "list", "/v1/sites/publish": "publish", "/v1/sites/share": "share",
      "/v1/sites/withdraw": "withdraw", "/v1/sites/republish": "republish", "/v1/sites/erase": "erase", "/v1/sites/data": "data",
      "/v1/sites/departments": "departments", "/v1/sites/versions": "versions", "/v1/sites/rollback": "rollback", "/v1/sites/files": "files",
      "/v1/sites/address": "address", "/v1/sites/stats": "stats",
    }[req.url];
    if (!route) return false;
    try {
      // A browser must never be able to reach these, even from a page this
      // control plane itself served.
      if (req.headers.origin) throw new SiteError(403, "browser_origin_not_allowed");
      if (req.method !== "POST") throw new SiteError(405, "method_not_allowed");
      const who = this.#who(req);
      const body = await readJson(req, route);
      send(res, 200, await this.#run(route, who, body));
    } catch (error) {
      req.resume();
      const status = error instanceof SiteError ? error.status : error instanceof SiteConflict ? 409 : error instanceof SiteRefused ? 403 : 400;
      send(res, status, { error: error.message });
    }
    return true;
  }

  async #permitted(who, feature) {
    if (this.#policy && !(await this.#policy.permits(who, feature))) {
      throw new SiteError(403, feature === "sitesAnonymous" ? "管理员没有给你开放「互联网上获得链接的人可阅读」。" : "管理员没有给你开放发布文档网站。");
    }
  }

  async #run(route, who, body) {
    if (route === "list") {
      // `limits`: how much table data one site may hold here, for the desktop to
      // say before it sends more than that.
      return { anonymousAllowed: this.#anonymousAllowed, features: this.#features, limits: { dataBytes: SITE_LIMITS.dataBytes },
        sites: this.#registry.list({ ownerId: who.userId, tenantId: who.tenantId })
        .map((site) => ({ ...site, url: this.link(site) })) };
    }
    // Departments to share with, from the organisation the console keeps
    // (docs/sites-phase0.md §0.4); empty until the address book is synced.
    if (route === "departments") {
      if (!this.#departments) return { departments: [], available: false };
      const found = await this.#departments.search(who.tenantId, String(body?.query ?? "").slice(0, 64), 12);
      return { available: true, departments: found.map((department) => ({ id: department.id, name: department.name, trail: department.trail ?? [], members: department.memberCount ?? null })) };
    }
    const siteId = typeof body?.siteId === "string" ? body.siteId : null;
    if (route === "publish") {
      await this.#permitted(who, "sitesPublish");
      if (body?.share?.scope === "anyone") await this.#permitted(who, "sitesAnonymous");
      const existing = siteId ? this.#registry.get(siteId) : null;
      if (existing && existing.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以发布新版本");
      if (existing?.held) throw new SiteError(400, `管理员下线了这个网站${existing.held.reason ? `（${existing.held.reason}）` : ""}，要恢复请联系管理员。`);
      await this.#groupsReadable(body?.share);
      // The id before the check, so that the check names the site it is about;
      // and the site as it is, so that what is written is what was checked.
      const id = siteId ?? randomUUID();
      const expect = stampOf(existing);
      const review = this.#safety ? await this.#checked(who, { site: { id, name: body?.name ?? existing?.name ?? "", ownerId: who.userId }, audience: audienceOf(body?.share),
        files: filesOf(body?.blobs), data: body?.data ?? null, trigger: existing ? "update" : "publish", version: versionOf(body?.manifest), dataDigest: body?.data?.snapshot?.digest ?? "" }) : null;
      const published = await this.#registry.publish({
        siteId: id, ownerId: who.userId, tenantId: who.tenantId,
        name: body?.name, manifest: body?.manifest, blobs: body?.blobs, share: body?.share,
        source: body?.source ?? null, anonymousAllowed: this.#anonymousAllowed, review, expect, allowed: this.#allowed(who),
      });
      // The data goes with the version: a page whose bytes are new and whose
      // numbers are the last version's is a page showing the wrong thing.
      if (body?.data) await this.#registry.putData(published.id, body.data);
      this.#audit({ event: "site-published", siteId: published.id, version: published.version, scope: published.share.scope, inherit: published.share.inherit }, { who, name: published.name });
      this.#notify(published.id);
      return { ...published, url: this.link(published) };
    }
    if (!siteId) throw new SiteError(400, "缺少网站标识");
    if (route === "share") {
      const site = this.#registry.get(siteId);
      if (!site) throw new SiteError(400, "找不到这个网站：它可能已经被删掉了。");
      if (site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以改它的设置");
      if (body?.share?.scope === "anyone") await this.#permitted(who, "sitesAnonymous");
      await this.#groupsReadable(body?.share);
      const expect = stampOf(site);
      // Checked again when who may read it changes -- the new audience may be
      // one it passes for, or one it does not. The same audience saved again,
      // or a collaborator added, is not checked and changes no review: a fresh
      // reading then (the model answering where it did not) had ended a wait,
      // or an administrator's 不通过 (fifth review before .270).
      let review;
      if (this.#safety && site && site.ownerId === who.userId && !site.held && audienceOf(body?.share) !== audienceOf(site.share)) {
        const { files, data, version } = await this.#registry.contents(siteId);
        review = await this.#checked(who, { site, audience: audienceOf(body?.share), files, data, trigger: "share", version, dataDigest: data?.snapshot?.digest ?? "" });
      }
      const changed = await this.#registry.setShare(siteId, body?.share, { ownerId: who.userId, anonymousAllowed: this.#anonymousAllowed, review, expect, allowed: this.#allowed(who) });
      this.#audit({ event: "site-share-changed", siteId, scope: changed.share.scope, inherit: changed.share.inherit, members: changed.share.members.length }, { who, name: changed.name });
      return { ...changed, url: this.link(changed) };
    }
    if (route === "withdraw" || route === "erase") {
      const site = this.#registry.get(siteId);
      if (site && site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以取消发布");
      const result = route === "erase"
        ? await this.#registry.erase(siteId, { ownerId: who.userId })
        : await this.#registry.withdraw(siteId, { ownerId: who.userId });
      this.#audit({ event: route === "erase" ? "site-erased" : "site-withdrawn", siteId }, { who, name: site?.name ?? "" });
      this.#notify(siteId, { gone: true });
      return result;
    }
    // Who opened it, for its owner (docs/sites-phase1.md §1.5): the last 30
    // days, people as numbers, departments too small to hide anybody together.
    if (route === "stats") {
      const site = this.#registry.get(siteId);
      if (!site) throw new SiteError(400, "找不到这个网站：它可能已经被删掉了。");
      if (site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以看它的访问统计");
      if (!this.#visitors) throw new SiteError(400, "这个服务端没有开启访问统计。");
      return this.#visitors.stats(site.tenantId, siteId);
    }
    // A name for the site's address (docs/sites-phase1.md §1.6): who may open it
    // does not change, only how its link reads.
    if (route === "address") {
      const site = this.#registry.get(siteId);
      if (!site) throw new SiteError(400, "找不到这个网站：它可能已经被删掉了。");
      if (site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以给它起地址名");
      const named = await this.#registry.setAddress(siteId, { ownerId: who.userId, address: body?.address === null ? null : String(body?.address ?? "") });
      this.#audit({ event: "site-address-changed", siteId, address: named.address ?? "" }, { who, name: named.name });
      return { ...named, url: this.link(named) };
    }
    // The versions a site keeps, and one of them to look at
    // (docs/sites-phase0.md §0.6): only ever its owner's.
    if (route === "versions" || route === "files") {
      const site = this.#registry.get(siteId);
      if (!site) throw new SiteError(400, "找不到这个网站：它可能已经被删掉了。");
      if (site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以看它的历史版本");
      if (route === "versions") return { versions: await this.#registry.versions(siteId) };
      const { manifest, files, data, version } = await this.#registry.contents(siteId, typeof body?.version === "string" ? body.version : null);
      return { version, manifest, blobs: files.map((file) => ({ path: file.path, base64: file.bytes.toString("base64") })),
        data: site.source && data ? { schema: data.schema ?? null, snapshot: data.snapshot ?? null } : null };
    }
    // Back to a kept version: publishing that version again, so checked again
    // under today's rules for who may read it now, and allowed only to someone
    // who may publish.
    if (route === "rollback") {
      await this.#permitted(who, "sitesPublish");
      const site = this.#registry.get(siteId);
      if (!site) throw new SiteError(400, "找不到这个网站：它可能已经被删掉了。");
      if (site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以回到旧版本");
      if (site.held) throw new SiteError(400, `管理员下线了这个网站${site.held.reason ? `（${site.held.reason}）` : ""}，要恢复请联系管理员。`);
      if (site.share.scope === "anyone") await this.#permitted(who, "sitesAnonymous");
      const version = typeof body?.version === "string" ? body.version : "";
      // Nothing to go back to is said before anything is checked: a check would
      // be recorded, and might send the site to an administrator, for nothing.
      if (version === site.version) throw new SiteError(400, "这已经是线上的版本");
      if (!site.history?.includes(version)) throw new SiteError(400, "这个网站没有保留这一版：只保留最近 3 个版本");
      const expect = stampOf(site);
      let review = null;
      if (this.#safety) {
        const { files, data } = await this.#registry.contents(siteId, version);
        review = await this.#checked(who, { site, audience: audienceOf(site.share), files, data, trigger: "rollback", version, dataDigest: data?.snapshot?.digest ?? "" });
      }
      const back = await this.#registry.revert(siteId, { ownerId: who.userId, version, review, expect, allowed: this.#allowed(who) });
      this.#audit({ event: "site-rolled-back", siteId, version: back.version }, { who, name: back.name });
      this.#notify(siteId);
      return { ...back, url: this.link(back) };
    }
    if (route === "republish") {
      // The same version back up is checked again under today's rules, and put
      // up only by someone who may publish -- to the internet, if it is open to it.
      const site = this.#registry.get(siteId);
      if (site && site.ownerId === who.userId) {
        await this.#permitted(who, "sitesPublish");
        if (site.share.scope === "anyone") await this.#permitted(who, "sitesAnonymous");
      }
      const expect = stampOf(site);
      let review = null;
      if (this.#safety && site && site.ownerId === who.userId && !site.held && !site.review?.state) {
        const { files, data, version } = await this.#registry.contents(siteId);
        review = await this.#checked(who, { site, audience: audienceOf(site.share), files, data, trigger: "republish", version, dataDigest: data?.snapshot?.digest ?? "" });
      }
      const back = await this.#registry.republish(siteId, { ownerId: who.userId, review, expect, allowed: this.#allowed(who) });
      this.#audit({ event: "site-republished", siteId, version: back.version }, { who, name: back.name });
      this.#notify(siteId);
      return { ...back, url: this.link(back) };
    }
    // Fresh data for a site already published: the owner refreshed the slice.
    const site = this.#registry.get(siteId);
    // 400 like the other routes: a 404 here reads, to the desktop, as a server
    // that has no sites at all (fifth review before .270).
    if (!site) throw new SiteError(400, "找不到这个网站：它可能已经被删掉了。");
    if (site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以更新它的数据");
    // New data is checked before it is shown; the same data again is not new.
    // Data that would have to wait is not written -- the page keeps showing
    // what it showed -- and the person is told why.
    if (this.#safety && (body?.snapshot?.digest ?? null) !== await this.#registry.dataDigest(siteId)) {
      const review = await this.#checked(who, { site, audience: audienceOf(site.share), data: { schema: body?.schema ?? null, snapshot: body?.snapshot ?? null },
        trigger: "data", version: site.version, dataDigest: body?.snapshot?.digest ?? "" });
      if (review) throw new SiteError(422, review.reason);
    }
    const written = await this.#registry.putData(siteId, { schema: body?.schema ?? null, snapshot: body?.snapshot ?? null });
    this.#audit({ event: "site-data-updated", siteId, digest: written.digest, changed: written.changed });
    // Only a real change wakes the open pages. A clock that re-reads the table
    // writes the same numbers most of the time.
    if (written.changed) this.#notify(siteId);
    return written;
  }

  #who(req) {
    const header = req.headers.authorization;
    const session = this.#sessions.verify(typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "");
    if (!session) throw new SiteError(401, "session_expired_or_invalid");
    // The desktop's own session, and no credential derived from it. Publishing,
    // sharing and erasing are shown to the person as cards by the desktop; a
    // turn credential -- which the coding agent can read -- or any other child
    // reaching here would do them with no card at all.
    if (session.parentKey || session.audience !== "codex-model-gateway") throw new SiteError(403, "desktop_session_required");
    // Publishing names an owner that other people's access is decided against,
    // so it has to be a real Feishu identity. A development session has one in
    // shape only, and a site published under it would be shared with a tenant
    // that does not exist.
    if (session.authProvider !== "feishu" && !this.#allowDevelopment) throw new SiteError(403, "发布网站需要飞书登录");
    if (typeof session.userId !== "string" || !session.userId || typeof session.tenantId !== "string" || !session.tenantId) {
      throw new SiteError(403, "这次登录没有可用的飞书身份");
    }
    return { userId: session.userId, tenantId: session.tenantId };
  }
}

export { REASONS as SITE_REASONS };

// A version's files as the check reads them; what is not a well-formed list is
// left for the registry to refuse, with its own words.
function filesOf(blobs) {
  if (!Array.isArray(blobs)) return [];
  return blobs.filter((blob) => typeof blob?.path === "string" && typeof blob?.base64 === "string").slice(0, 128)
    .map((blob) => ({ path: blob.path, bytes: Buffer.from(blob.base64, "base64") }));
}
function versionOf(manifest) { try { return appManifest(manifest).digest; } catch { return ""; } }

async function readJson(req, route) {
  const limit = BODY_BYTES[route] ?? MAX_BODY_BYTES;
  const tooBig = () => new SiteError(413, route === "data" ? "这份表格数据超过了服务端能存的上限" : "版本包太大");
  const encoding = String(req.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") throw new SiteError(415, "不支持这种压缩方式");
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw tooBig();
    chunks.push(chunk);
  }
  if (!total) return {};
  let bytes = Buffer.concat(chunks);
  if (encoding === "gzip") {
    try { bytes = await inflate(bytes, { maxOutputLength: limit }); }
    catch (error) { throw error?.code === "ERR_BUFFER_TOO_LARGE" ? tooBig() : new SiteError(400, "请求的压缩内容无效"); }
  }
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new SiteError(400, "请求不是有效的 JSON"); }
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}
