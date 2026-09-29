// Publishing, sharing and taking down a site: the loopback side, answered to a
// product session, so only the application this person is signed into can ask.
//
// The listener other people reach (site-server.js) serves; this decides what
// there is to serve. They are separate on purpose: one of them is reachable
// from outside and has no route that can change anything.
import { REASONS } from "./site-access.js";
import { APP_LIMITS } from "../apps/manifest.js";

// A version travels as base64 inside one JSON body, a third larger than its
// files. At 12 MiB the 10 MiB a version may hold could never arrive: anything
// past about 8.8 MiB was refused as 版本包太大 -- more reachable once a site
// may carry a video. Room for the full version, its manifest and its names.
const MAX_BODY_BYTES = Math.ceil(APP_LIMITS.totalBytes * 4 / 3) + 1024 * 1024;

class SiteError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class SiteService {
  #sessions; #registry; #anonymousAllowed; #origin; #notify; #audit; #allowDevelopment;
  constructor({ sessions, registry, origin, anonymousAllowed = false, notify = () => {}, audit = () => {}, allowDevelopment = false }) {
    this.#sessions = sessions; this.#registry = registry; this.#origin = origin;
    this.#anonymousAllowed = anonymousAllowed === true; this.#notify = notify; this.#audit = audit;
    this.#allowDevelopment = allowDevelopment === true;
  }

  get anonymousAllowed() { return this.#anonymousAllowed; }
  link(siteId) { return `${this.#origin}/s/${siteId}/`; }

  async handle(req, res) {
    const route = {
      "/v1/sites/list": "list", "/v1/sites/publish": "publish", "/v1/sites/share": "share",
      "/v1/sites/withdraw": "withdraw", "/v1/sites/republish": "republish", "/v1/sites/erase": "erase", "/v1/sites/data": "data",
    }[req.url];
    if (!route) return false;
    try {
      // A browser must never be able to reach these, even from a page this
      // control plane itself served.
      if (req.headers.origin) throw new SiteError(403, "browser_origin_not_allowed");
      if (req.method !== "POST") throw new SiteError(405, "method_not_allowed");
      const who = this.#who(req);
      const body = await readJson(req);
      send(res, 200, await this.#run(route, who, body));
    } catch (error) {
      req.resume();
      const status = error instanceof SiteError ? error.status : 400;
      send(res, status, { error: error.message });
    }
    return true;
  }

  async #run(route, who, body) {
    if (route === "list") {
      return { anonymousAllowed: this.#anonymousAllowed, sites: this.#registry.list({ ownerId: who.userId, tenantId: who.tenantId })
        .map((site) => ({ ...site, url: this.link(site.id) })) };
    }
    const siteId = typeof body?.siteId === "string" ? body.siteId : null;
    if (route === "publish") {
      const published = await this.#registry.publish({
        siteId, ownerId: who.userId, tenantId: who.tenantId,
        name: body?.name, manifest: body?.manifest, blobs: body?.blobs, share: body?.share,
        source: body?.source ?? null, anonymousAllowed: this.#anonymousAllowed,
      });
      // The data goes with the version: a page whose bytes are new and whose
      // numbers are the last version's is a page showing the wrong thing.
      if (body?.data) await this.#registry.putData(published.id, body.data);
      this.#audit({ event: "site-published", siteId: published.id, version: published.version, scope: published.share.scope, inherit: published.share.inherit });
      this.#notify(published.id);
      return { ...published, url: this.link(published.id) };
    }
    if (!siteId) throw new SiteError(400, "缺少网站标识");
    if (route === "share") {
      const changed = await this.#registry.setShare(siteId, body?.share, { ownerId: who.userId, anonymousAllowed: this.#anonymousAllowed });
      this.#audit({ event: "site-share-changed", siteId, scope: changed.share.scope, inherit: changed.share.inherit, members: changed.share.members.length });
      return { ...changed, url: this.link(changed.id) };
    }
    if (route === "withdraw" || route === "erase") {
      const site = this.#registry.get(siteId);
      if (site && site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以取消发布");
      const result = route === "erase"
        ? await this.#registry.erase(siteId, { ownerId: who.userId })
        : await this.#registry.withdraw(siteId, { ownerId: who.userId });
      this.#audit({ event: route === "erase" ? "site-erased" : "site-withdrawn", siteId });
      this.#notify(siteId, { gone: true });
      return result;
    }
    if (route === "republish") {
      const back = await this.#registry.republish(siteId, { ownerId: who.userId });
      this.#audit({ event: "site-republished", siteId, version: back.version });
      this.#notify(siteId);
      return { ...back, url: this.link(back.id) };
    }
    // Fresh data for a site already published: the owner refreshed the slice.
    const site = this.#registry.get(siteId);
    if (!site) throw new SiteError(404, "找不到这个网站");
    if (site.ownerId !== who.userId) throw new SiteError(403, "只有网站的所有者可以更新它的数据");
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

async function readJson(req) {
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new SiteError(413, "版本包太大");
    chunks.push(chunk);
  }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new SiteError(400, "请求不是有效的 JSON"); }
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}
